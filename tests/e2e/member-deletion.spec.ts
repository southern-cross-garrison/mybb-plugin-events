import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, loginToAdminCp, gotoEventsAdmin } from '../helpers/auth';
import { relativeToTestNow } from '../helpers/clock';
import { runPhp, runScheduledTask } from '../helpers/container';
import {
  countPrivateMessages,
  createEvent,
  createRsvp,
  execute,
  fixtures,
  getClaimStatuses,
  getEvent,
  getEventDays,
  getPrivateMessages,
  getRsvpStatus,
  query,
  queryOne,
  T,
  uid,
} from '../helpers/db';

/**
 * What happens to the plugin's data, and to everybody else's, when a member is deleted.
 *
 * A deleted member leaves uids behind in the plugin's tables - as a signup in somebody's
 * queue, as an event's coordinator or point of contact, as the sender of the PMs the
 * plugin sends "from the coordinator". Each of those is a place where a uid that names
 * nobody can break a page, stall a queue or refuse a PM, and none of it shows up until a
 * real member leaves the garrison.
 *
 * The members deleted here are throwaways registered by the test itself. The fixture
 * users are provisioned board state every other spec depends on, and the users table is
 * not restored between tests, so deleting one would break the rest of the run. For the
 * same reason every throwaway is removed in afterEach whether the test passed or not.
 */

const TK = fixtures().costumeOptions[0];

const WEEKEND = {
  start: '2026-10-24 09:00:00',
  end: '2026-10-25 17:00:00',
  days: [{ date: '2026-10-24' }, { date: '2026-10-25' }],
};

/** Throwaway uids registered by the running test, removed in afterEach. */
let throwaways: number[] = [];

test.afterEach(async () => {
  if (!throwaways.length) return;
  // Through the datahandler rather than a bare DELETE, so the plugin's own cleanup runs
  // for anybody a failed test left behind and no stray signup outlives the member.
  await runPhp(`
require_once MYBB_ROOT.'inc/datahandlers/user.php';
$handler = new UserDataHandler('delete');
$handler->delete_user(array(${throwaways.join(',')}));
echo "cleaned";
`);
  throwaways = [];
});

/**
 * Register a throwaway member through MyBB's own datahandler; returns the uid.
 *
 * The name carries a timestamp because a user row from an aborted run (killed before
 * afterEach) would otherwise collide with the next run's registration.
 */
async function registerMember(prefix: string, additionalGroups: number[] = []): Promise<{ uid: number; username: string }> {
  const username = `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const output = await runPhp(`
require_once MYBB_ROOT.'inc/datahandlers/user.php';
$handler = new UserDataHandler('insert');
$handler->set_data(array(
  'username' => '${username}',
  'password' => 'Passw0rd!Passw0rd',
  'password2' => 'Passw0rd!Passw0rd',
  'email' => '${username}@example.invalid',
  'email2' => '${username}@example.invalid',
  'usergroup' => 2,
  'additionalgroups' => '${additionalGroups.join(',')}',
  'regip' => '127.0.0.1',
));
if(!$handler->validate_user()) { echo 'INVALID:'.implode(',', array_keys($handler->get_errors())); exit; }
$user = $handler->insert_user();
echo 'UID:'.$user['uid'];
`);
  const match = output.match(/UID:(\d+)/);
  expect(match, output).not.toBeNull();
  const id = Number(match![1]);
  throwaways.push(id);
  return { uid: id, username };
}

/**
 * createRsvp() for a member who is not a fixture: it resolves names through the fixture
 * map, which a throwaway is not in. Same shape - one signup row, its costumes, and one
 * claim per day at the signup's own time unless a day says otherwise.
 */
async function insertRsvp(
  eventId: number,
  userId: number,
  options: {
    role?: 'trooper' | 'wrangler';
    status?: 'attending' | 'waitlisted';
    at: string;
    days?: Array<{ id: number; status: 'attending' | 'waitlisted' }>;
  },
): Promise<number> {
  const role = options.role ?? 'trooper';
  const result = await execute(
    `INSERT INTO ${T('event_plugin_rsvps')} (event_id, user_id, role, rsvp_date, status) VALUES (?, ?, ?, ?, ?)`,
    [eventId, userId, role, options.at, options.status ?? 'attending'],
  );
  if (role === 'trooper') {
    await execute(`INSERT INTO ${T('event_plugin_rsvp_costumes')} (rsvp_id, costume) VALUES (?, ?)`, [result.insertId, TK]);
  }
  for (const day of options.days ?? []) {
    await execute(
      `INSERT INTO ${T('event_plugin_rsvp_days')} (rsvp_id, event_day_id, status, claimed_at) VALUES (?, ?, ?, ?)`,
      [result.insertId, day.id, day.status, options.at],
    );
  }
  return result.insertId;
}

/** Point an event's coordinator or point of contact at somebody who is not a fixture. */
async function setEventPeople(eventId: number, people: { coordinator?: number; poc?: number }): Promise<void> {
  if (people.coordinator !== undefined) {
    await execute(`UPDATE ${T('event_plugin_events')} SET gec_user_id = ? WHERE id = ?`, [people.coordinator, eventId]);
  }
  if (people.poc !== undefined) {
    await execute(`UPDATE ${T('event_plugin_events')} SET poc_user_id = ? WHERE id = ?`, [people.poc, eventId]);
  }
}

/**
 * Delete a member the way an administrator does: Admin CP -> Users -> Delete, and Yes on
 * the confirmation. That is UserDataHandler::delete_user() under IN_ADMINCP, firing
 * datahandler_user_delete_end, which is the path a real deletion takes - and the one where
 * the plugin's cleanup runs with the Admin CP's globals rather than a front-end page's.
 */
async function deleteMemberThroughAdminCp(page: Page, userId: number): Promise<void> {
  await loginToAdminCp(page);
  await page.goto(`/admin/index.php?module=user-users&action=delete&uid=${userId}`);
  await page.locator('input.button_yes').click();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('#flash_message')).toContainText(/deleted/i);

  const row = await queryOne<any>(`SELECT uid FROM ${T('users')} WHERE uid = ?`, [userId]);
  expect(row, `uid ${userId} should be gone from the users table`).toBeNull();
  throwaways = throwaways.filter((id) => id !== userId);
}

/**
 * PHP warnings and MyBB's own error log are written, not shown, so a page can render
 * "fine" over a stream of "array offset on null" from a uid that names nobody.
 */
async function clearErrorLogs(): Promise<void> {
  await runPhp(`
@unlink('/var/www/html/cache/mybb_errors.log');
@unlink('/var/log/php_errors.log');
echo "cleared";
`);
}

/**
 * Everything logged since clearErrorLogs(). Not filtered to the plugin's own files the
 * way health.spec.ts filters: a sender who no longer exists warns from inside MyBB's
 * PMDataHandler, which is still the plugin's doing when the plugin passed that uid.
 */
async function readErrorLogs(): Promise<string> {
  const log = await runPhp(`
foreach(array('/var/www/html/cache/mybb_errors.log', '/var/log/php_errors.log') as $file)
{
    if(file_exists($file)) { echo file_get_contents($file); }
}
echo "END_OF_LOG";
`);
  return log.replace('END_OF_LOG', '').trim();
}

async function expectPageRenders(page: Page, url: string, absentNames: string[] = []): Promise<void> {
  const response = await page.goto(url);
  expect(response?.status(), `${url} should not error`).toBeLessThan(400);
  const body = page.locator('body');
  await expect(body, `${url} should not show a MyBB SQL error`).not.toContainText('MyBB SQL Error');
  await expect(body, `${url} should not show a PHP warning`).not.toContainText(/Warning:|Notice:|Fatal error/);
  for (const name of absentNames) {
    await expect(body, `${url} should not name the deleted member ${name}`).not.toContainText(name);
  }
}

async function rowsFor(table: string, userId: number): Promise<number> {
  const row = await queryOne<any>(`SELECT COUNT(*) AS total FROM ${T(table)} WHERE user_id = ?`, [userId]);
  return Number(row?.total ?? 0);
}

test.describe('deleting a member who is queued on several events', () => {
  test('takes every row of theirs, moves the queues up without costing anybody their place, and leaves the reminder working', async ({ page }) => {
    test.setTimeout(120_000);
    await clearErrorLogs();

    const doomed = await registerMember('e2e_doomed');

    // A: one place, taken. The doomed member is first in the queue behind it, trooper2
    // second. Deleting them must move trooper2 up to first - and give nobody the place,
    // since the member holding it is still coming.
    const single = await createEvent({ title: 'Deleted Queue Single', coordinator: 'gec', maxTroopers: 1 });
    await createRsvp(single, 'trooper1', { costumes: [TK], at: relativeToTestNow({ days: -5 }) });
    const singleRsvp = await insertRsvp(single, doomed.uid, { status: 'waitlisted', at: relativeToTestNow({ days: -4 }) });
    await createRsvp(single, 'trooper2', { costumes: [TK], status: 'waitlisted', at: relativeToTestNow({ days: -3 }) });

    // B: a weekend, one trooper and one wrangler a day. The doomed member holds
    // Saturday's trooper place with nowwcc waiting behind it, and waits on Sunday between
    // trooper1 (holding) and trooper2 (behind). They are also second in Saturday's
    // wrangler queue, ahead of newbie. Their going frees exactly one place - Saturday's
    // trooper place, which is nowwcc's - and moves trooper2 and newbie up a step each.
    const weekend = await createEvent({
      title: 'Deleted Queue Weekend',
      coordinator: 'gec',
      maxTroopers: 1,
      maxWranglers: 1,
      ...WEEKEND,
    });
    const [saturday, sunday] = (await getEventDays(weekend)).map((day: any) => Number(day.id));
    await createRsvp(weekend, 'trooper1', { costumes: [TK], dayIds: [sunday], at: relativeToTestNow({ days: -6 }) });
    const weekendRsvp = await insertRsvp(weekend, doomed.uid, {
      status: 'attending',
      at: relativeToTestNow({ days: -5 }),
      days: [
        { id: saturday, status: 'attending' },
        { id: sunday, status: 'waitlisted' },
      ],
    });
    await createRsvp(weekend, 'nowwcc', { costumes: [TK], dayIds: [saturday], status: 'waitlisted', at: relativeToTestNow({ days: -4 }) });
    await createRsvp(weekend, 'trooper2', { costumes: [TK], dayIds: [sunday], status: 'waitlisted', at: relativeToTestNow({ days: -3 }) });
    await createRsvp(weekend, 'wrangler', { role: 'wrangler', dayIds: [saturday], at: relativeToTestNow({ days: -6 }) });
    const wranglerRsvp = await insertRsvp(weekend, doomed.uid, {
      role: 'wrangler',
      status: 'waitlisted',
      at: relativeToTestNow({ days: -5 }),
      days: [{ id: saturday, status: 'waitlisted' }],
    });
    await createRsvp(weekend, 'newbie', { role: 'wrangler', dayIds: [saturday], status: 'waitlisted', at: relativeToTestNow({ days: -2 }) });

    // C: already over, no report yet, the doomed member among the attendees. The reminder
    // is one PM to every attendee, and MyBB refuses the whole PM over one recipient who
    // does not exist - so this is the event a stray row would silence.
    const finished = await createEvent({
      title: 'Deleted Queue Finished',
      coordinator: 'gec',
      start: relativeToTestNow({ days: -3 }),
      end: relativeToTestNow({ days: -2 }),
    });
    await createRsvp(finished, 'trooper1', { costumes: [TK] });
    const finishedRsvp = await insertRsvp(finished, doomed.uid, { at: relativeToTestNow({ days: -4 }) });
    await createRsvp(finished, 'trooper2', { costumes: [TK] });

    // And everything else the plugin keeps against a member: an exclusion, a view
    // preference, a calendar feed token.
    const hidden = await createEvent({ title: 'Deleted Queue Hidden', coordinator: 'gec' });
    await execute(`INSERT INTO ${T('event_plugin_event_exclusions')} (event_id, user_id) VALUES (?, ?)`, [hidden, doomed.uid]);
    await execute(`INSERT INTO ${T('event_plugin_user_prefs')} (user_id, events_view) VALUES (?, 'calendar')`, [doomed.uid]);
    await execute(
      `INSERT INTO ${T('event_plugin_feed_tokens')} (user_id, token_hash, created_at, last_used_at) VALUES (?, SHA2(?, 256), 0, 0)`,
      [doomed.uid, `e2e-token-${doomed.uid}`],
    );

    const doomedRsvps = [singleRsvp, weekendRsvp, wranglerRsvp, finishedRsvp];

    await deleteMemberThroughAdminCp(page, doomed.uid);

    // Nothing of theirs is left anywhere in the plugin's tables.
    for (const table of ['event_plugin_rsvps', 'event_plugin_event_exclusions', 'event_plugin_user_prefs', 'event_plugin_feed_tokens']) {
      expect(await rowsFor(table, doomed.uid), `${table} still holds rows for the deleted member`).toBe(0);
    }
    for (const table of ['event_plugin_rsvp_days', 'event_plugin_rsvp_costumes']) {
      const left = await query<any>(`SELECT rsvp_id FROM ${T(table)} WHERE rsvp_id IN (${doomedRsvps.join(',')})`);
      expect(left, `${table} still holds rows for the deleted member's signups`).toEqual([]);
    }

    // A: the place is still trooper1's, and trooper2 is now first in the queue.
    expect(await getRsvpStatus(single, 'trooper1')).toBe('attending');
    expect(await getRsvpStatus(single, 'trooper2')).toBe('waitlisted');
    expect(await countPrivateMessages('trooper2', 'You have a place: Deleted Queue Single')).toBe(0);

    // B: Saturday's trooper place went to nowwcc, the next in line for it, who was told -
    // by the coordinator, since nobody saving anything made the move.
    expect(await getClaimStatuses(weekend, 'nowwcc')).toEqual({ [saturday]: 'attending' });
    expect(await getRsvpStatus(weekend, 'nowwcc')).toBe('attending');
    const [promoted] = await getPrivateMessages('nowwcc', 'You have a place: Deleted Queue Weekend');
    expect(promoted, 'nowwcc should be PMed about the place they were given').toBeTruthy();
    expect(Number(promoted.fromid)).toBe(uid('gec'));
    // Sunday: trooper1 keeps the place, trooper2 still waits - and was not promoted on
    // the strength of a place that was never free.
    expect(await getClaimStatuses(weekend, 'trooper1')).toEqual({ [sunday]: 'attending' });
    expect(await getClaimStatuses(weekend, 'trooper2')).toEqual({ [sunday]: 'waitlisted' });
    expect(await countPrivateMessages('trooper2', 'You have a place:%')).toBe(0);
    // The wrangler queue: wrangler keeps the place, newbie waits, now first.
    expect(await getClaimStatuses(weekend, 'wrangler', 'wrangler')).toEqual({ [saturday]: 'attending' });
    expect(await getClaimStatuses(weekend, 'newbie', 'wrangler')).toEqual({ [saturday]: 'waitlisted' });

    // The pages say the same, with no ghost of the deleted member on them.
    await loginAs(page, 'gec');
    await expectPageRenders(page, `/event.php?id=${single}`, [doomed.username]);
    await expect(page.locator('#rsvp_rows li.rsvp_row .rsvp_username')).toHaveText(['trooper1']);
    await expect(page.locator('#waitlist_rows li.waitlist_row .rsvp_username')).toHaveText(['trooper2']);
    await expect(page.locator('#waitlist_count')).toHaveText('(1)');
    await expect(page.locator('#event_rsvp_count')).toHaveText('1');

    await expectPageRenders(page, `/event.php?id=${weekend}`, [doomed.username]);
    // Membership rather than order: how the signup list sorts a mixed weekend is not what
    // this test is about.
    const attending = page.locator('#rsvp_rows li.rsvp_row .rsvp_username');
    await expect(attending.filter({ hasText: /^nowwcc$/ })).toHaveCount(1);
    await expect(attending.filter({ hasText: /^trooper1$/ })).toHaveCount(1);
    await expect(page.locator('#waitlist_rows li.waitlist_row .rsvp_username')).toHaveText(['trooper2', 'newbie']);

    await expectPageRenders(page, `/event.php?id=${weekend}&action=attendance`, [doomed.username]);
    await expectPageRenders(page, `/event.php?id=${single}&action=attendance`, [doomed.username]);
    await expectPageRenders(page, '/events.php', [doomed.username]);

    // trooper2 sees their own place in the queue as first, not second.
    await loginAs(page, 'trooper2');
    await page.goto(`/event.php?id=${single}`);
    await expect(page.locator('#event_signup_waitlist_trooper')).toHaveText('Waitlisted: Trooping (#1)');

    // C: the reminder still reaches the two members who are left.
    const output = await runScheduledTask('events_reminders');
    expect(output).toContain('Event reminder PMs sent for 1 event(s)');
    expect(await countPrivateMessages('trooper1', 'Troop Report Needed: Deleted Queue Finished')).toBe(1);
    expect(await countPrivateMessages('trooper2', 'Troop Report Needed: Deleted Queue Finished')).toBe(1);

    const log = await readErrorLogs();
    expect(log, `PHP or MyBB logged errors:\n${log}`).toBe('');
  });
});

test.describe('deleting an event\'s coordinator or point of contact', () => {
  /**
   * An event run by a throwaway coordinator, with a throwaway point of contact holding
   * its one trooper place and two fixture members queued behind them.
   */
  async function coordinatedEvent(title: string) {
    const coordinator = await registerMember('e2e_coord', [fixtures().groups.gec]);
    const contact = await registerMember('e2e_poc');
    const eventId = await createEvent({ title, coordinator: 'gec', maxTroopers: 1 });
    await setEventPeople(eventId, { coordinator: coordinator.uid, poc: contact.uid });
    await insertRsvp(eventId, contact.uid, { at: relativeToTestNow({ days: -5 }) });
    await createRsvp(eventId, 'trooper1', { costumes: [TK], status: 'waitlisted', at: relativeToTestNow({ days: -4 }) });
    await createRsvp(eventId, 'trooper2', { costumes: [TK], status: 'waitlisted', at: relativeToTestNow({ days: -3 }) });
    return { eventId, coordinator, contact };
  }

  test('every page that shows the event still renders, without warnings or the old names', async ({ page }) => {
    test.setTimeout(90_000);
    const { eventId, coordinator, contact } = await coordinatedEvent('Orphaned Coordinator Troop');

    await deleteMemberThroughAdminCp(page, coordinator.uid);
    await deleteMemberThroughAdminCp(page, contact.uid);
    await clearErrorLogs();

    // The event keeps pointing at uids that name nobody - nothing rewrites those columns -
    // and that is the case every page below has to survive.
    const event = await getEvent(eventId);
    expect(Number(event.gec_user_id)).toBe(coordinator.uid);

    await loginAs(page, 'gec');
    const gone = [coordinator.username, contact.username];
    await expectPageRenders(page, `/event.php?id=${eventId}`, gone);
    // A point of contact who no longer exists is no point of contact, not a blank name.
    await expect(page.locator('#event_poc')).toHaveCount(0);
    await expectPageRenders(page, `/event.php?id=${eventId}&action=attendance`, gone);
    await expectPageRenders(page, '/events.php', gone);
    await expectPageRenders(page, '/events.php?view=calendar', gone);
    await expectPageRenders(page, `/manage_event.php?id=${eventId}`);

    const ical = await page.request.get(`/ical.php?id=${eventId}`);
    expect(ical.status()).toBe(200);
    expect(await ical.text()).not.toContain('MyBB SQL Error');

    await loginToAdminCp(page);
    await gotoEventsAdmin(page);
    await expect(page.locator('body')).toContainText('Orphaned Coordinator Troop');
    await expect(page.locator('body')).not.toContainText(/Warning:|MyBB SQL Error/);
    await gotoEventsAdmin(page, `&action=edit&id=${eventId}`);
    await expect(page.locator('#title')).toHaveValue('Orphaned Coordinator Troop');
    await gotoEventsAdmin(page, `&action=rsvps&event_id=${eventId}`);
    await expect(page.locator('body')).not.toContainText(/Warning:|MyBB SQL Error/);

    const log = await readErrorLogs();
    expect(log, `PHP or MyBB logged errors:\n${log}`).toBe('');
  });

  test('a waitlist PM that would come from the coordinator is still delivered once they are gone', async ({ page }) => {
    test.setTimeout(90_000);
    const { eventId, coordinator, contact } = await coordinatedEvent('Senderless Troop');

    await deleteMemberThroughAdminCp(page, coordinator.uid);
    await clearErrorLogs();

    // The point of contact's deletion frees the place: trooper1 is promoted, and the PM
    // saying so is sent "from the coordinator", who no longer exists.
    await deleteMemberThroughAdminCp(page, contact.uid);
    expect(await getRsvpStatus(eventId, 'trooper1')).toBe('attending');
    const [first] = await getPrivateMessages('trooper1', 'You have a place: Senderless Troop');
    expect(first, 'the promotion PM should reach trooper1 though its sender is deleted').toBeTruthy();
    // A PM cannot be from a member who does not exist; it has to come from nobody (the
    // board itself, uid 0), not carry a dangling uid.
    expect(Number(first.fromid)).toBe(0);

    // The same again from the front end: trooper1 pulls out, and trooper2 gets the place.
    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#signup_role_none').check();
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_submit')).toHaveValue('Withdraw Signup');
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success')).toHaveAttribute('data-signup-mode', 'withdraw');
    await expect(page.locator('body')).not.toContainText(/Warning:|MyBB SQL Error/);

    expect(await getRsvpStatus(eventId, 'trooper2')).toBe('attending');
    const [second] = await getPrivateMessages('trooper2', 'You have a place: Senderless Troop');
    expect(second, 'the promotion PM should reach trooper2 though its sender is deleted').toBeTruthy();
    expect(Number(second.fromid)).toBe(0);

    // And the PM reads as a PM from the board in trooper2's inbox, rather than breaking it.
    await loginAs(page, 'trooper2');
    await expectPageRenders(page, '/private.php');
    await page.locator('a', { hasText: 'You have a place: Senderless Troop' }).first().click();
    await expect(page.locator('body')).toContainText('A place has opened up');
    await expect(page.locator('body')).not.toContainText(/Warning:|MyBB SQL Error/);

    const log = await readErrorLogs();
    expect(log, `PHP or MyBB logged errors:\n${log}`).toBe('');
  });

  test('an event whose coordinator is gone can still be saved, from either form, and ends up with a real one', async ({ page }) => {
    test.setTimeout(90_000);
    const { eventId, coordinator, contact } = await coordinatedEvent('Reassigned Troop');
    await deleteMemberThroughAdminCp(page, coordinator.uid);
    await deleteMemberThroughAdminCp(page, contact.uid);
    await clearErrorLogs();

    // Front end, as a general coordinator, changing nothing but the title.
    await loginAs(page, 'gec');
    await page.goto(`/manage_event.php?id=${eventId}`);
    await page.locator('#event_form_title').fill('Reassigned Troop (front end)');
    await page.locator('#manage_event_submit').click();
    await expect(page.locator('body')).not.toContainText(/Choose an event coordinator|Choose a point of contact/);
    await expect.poll(async () => String((await getEvent(eventId)).title)).toBe('Reassigned Troop (front end)');

    // Whoever it names now has to be somebody: a coordinator nobody can be PMed as or
    // reach is the same problem again.
    const afterFront = await getEvent(eventId);
    const frontCoordinator = await queryOne<any>(`SELECT uid FROM ${T('users')} WHERE uid = ?`, [afterFront.gec_user_id]);
    expect(frontCoordinator, `saved coordinator uid ${afterFront.gec_user_id} should exist`).not.toBeNull();
    expect(Number(afterFront.poc_user_id)).not.toBe(contact.uid);

    // Put the dead coordinator back and save from the Admin CP too.
    await setEventPeople(eventId, { coordinator: coordinator.uid, poc: contact.uid });
    await loginToAdminCp(page);
    await gotoEventsAdmin(page, `&action=edit&id=${eventId}`);
    await page.locator('#title').fill('Reassigned Troop (Admin CP)');
    await page.locator('input[type="submit"][value="Update Event"]').click();
    await expect(page.locator('#flash_message')).toContainText('Event updated successfully');

    const afterAdmin = await getEvent(eventId);
    expect(String(afterAdmin.title)).toBe('Reassigned Troop (Admin CP)');
    const adminCoordinator = await queryOne<any>(`SELECT uid FROM ${T('users')} WHERE uid = ?`, [afterAdmin.gec_user_id]);
    expect(adminCoordinator, `saved coordinator uid ${afterAdmin.gec_user_id} should exist`).not.toBeNull();
    expect(Number(afterAdmin.poc_user_id)).not.toBe(contact.uid);

    const log = await readErrorLogs();
    expect(log, `PHP or MyBB logged errors:\n${log}`).toBe('');
  });
});
