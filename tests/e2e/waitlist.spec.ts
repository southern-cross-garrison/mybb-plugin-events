import { test, expect } from '../helpers/fixtures';
import { loginAs, loginToAdminCp, gotoEventsAdmin } from '../helpers/auth';
import { signUpThroughWizard } from '../helpers/rsvp';
import { relativeToTestNow } from '../helpers/clock';
import { runPhp } from '../helpers/container';
import { submitFormAtOnce } from '../helpers/double-submit';
import { addTags } from '../helpers/tag-field';
import {
  createEvent,
  createRsvp,
  countPrivateMessages,
  execute,
  getClaimStatuses,
  getEventDays,
  getPrivateMessages,
  getRsvpStatus,
  getSignupRoles,
  query,
  T,
  uid,
} from '../helpers/db';
import type { Browser, Page } from '@playwright/test';
import type { FixtureUser } from '../helpers/auth';

/**
 * Maximum troopers and wranglers, and the waitlist behind them.
 *
 * Every queue here is built with distinct signup times, because the order people signed
 * up in is the order places are given out in - and it is deliberately not the order of
 * their names, so a list that had quietly been sorted alphabetically would fail.
 */

const WEEKEND = {
  start: '2026-10-24 09:00:00',
  end: '2026-10-25 17:00:00',
  days: [{ date: '2026-10-24' }, { date: '2026-10-25' }],
};

/** Walk the wizard as far as its confirm step, trooping the whole event. */
async function openConfirmStep(page: Page, eventId: number) {
  await page.goto(`/rsvp.php?id=${eventId}`);
  await page.locator('#signup_role_trooper').check();
  await page.locator('#rsvp_submit').click();
  await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
}

/** Withdraw the logged-in member's signup the way they would. */
async function withdrawThroughWizard(page: Page, eventId: number) {
  await page.goto(`/rsvp.php?id=${eventId}`);
  await page.locator('#signup_role_none').check();
  await page.locator('#rsvp_submit').click();
  await expect(page.locator('#rsvp_submit')).toHaveValue('Withdraw Signup');
  await page.locator('#rsvp_submit').click();
  await expect(page.locator('#rsvp_success')).toHaveAttribute('data-signup-mode', 'withdraw');
}

async function saveEventForm(page: Page, eventId: number, maxTroopers: string) {
  await page.goto(`/manage_event.php?id=${eventId}`);
  await page.locator('#event_form_max_troopers').fill(maxTroopers);
  await page.locator('#manage_event_submit').click();
}

/** A date and its time are two controls on the event form. */
async function fillDateTime(page: Page, id: string, value: string) {
  const [date, time] = value.split(' ');
  await page.locator(`#${id}`).fill(date);
  await page.locator(`#${id}_time`).fill(time.slice(0, 5));
}

/** A page of its own - its own cookies - signed in as one member. */
async function pageFor(browser: Browser, username: FixtureUser): Promise<Page> {
  const page = await browser.newPage();
  await loginAs(page, username);
  return page;
}

/** Register a throwaway member through MyBB's own datahandler; returns the uid. */
async function registerMember(username: string): Promise<number> {
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
  'regip' => '127.0.0.1',
));
if(!$handler->validate_user()) { echo 'INVALID:'.implode(',', array_keys($handler->get_errors())); exit; }
$user = $handler->insert_user();
echo 'UID:'.$user['uid'];
`);
  const match = output.match(/UID:(\d+)/);
  expect(match, output).not.toBeNull();
  return Number(match![1]);
}

test.describe('signing up to a full event', () => {
  test('says at every step that it is joining the waitlist, not signing up to troop', async ({ page }) => {
    const eventId = await createEvent({ title: 'Full Troop', maxTroopers: 1, maxWranglers: 1 });
    await createRsvp(eventId, 'trooper1', { at: relativeToTestNow({ days: -2 }) });
    await createRsvp(eventId, 'wrangler', { role: 'wrangler', at: relativeToTestNow({ days: -2 }) });

    await loginAs(page, 'trooper2');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_capacity')).toHaveText('1 trooper, 1 wrangler');
    await expect(page.locator('#event_signup')).toHaveText('Join the Waitlist');
    await expect(page.locator('#event_signup')).toHaveAttribute('data-waitlist', '1');

    await page.goto(`/rsvp.php?id=${eventId}`);
    await expect(page.locator('label:has(#signup_role_trooper)')).toContainText('full - join the waitlist');

    await openConfirmStep(page, eventId);
    await expect(page.locator('#rsvp_submit')).toHaveValue('Join the Waitlist');
    await expect(page.locator('#confirm_waitlist li')).toContainText(['number 1 on the waitlist']);

    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success')).toHaveAttribute('data-signup-mode', 'waitlist');
    await expect(page.locator('#rsvp_success_message')).toContainText('on the waitlist');
    // A place in the queue is not on anybody's calendar yet.
    await expect(page.locator('#rsvp_ical')).toHaveCount(0);

    expect(await getRsvpStatus(eventId, 'trooper2')).toBe('waitlisted');
    expect(await getRsvpStatus(eventId, 'trooper1')).toBe('attending');

    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_signup_waitlist_trooper')).toHaveText('Waitlisted: Trooping (#1)');
    await expect(page.locator('#event_signup_status_trooper')).toHaveCount(0);
    await expect(page.locator('#event_ical')).toHaveCount(0);
    await expect(page.locator('#rsvp_rows li.rsvp_row')).toHaveCount(2);
    await expect(page.locator('#waitlist_rows li.waitlist_row .rsvp_username')).toHaveText(['trooper2']);

    // The listing does not offer a Sign Up button for a signup the member already holds.
    await page.goto('/events.php');
    await expect(page.locator(`tr.event_row[data-event-id="${eventId}"] .event_waitlisted`)).toHaveText('Waitlisted');
  });

  test('only one role being full still offers a place in the other', async ({ page }) => {
    const eventId = await createEvent({ title: 'Trooper Full Troop', maxTroopers: 1 });
    await createRsvp(eventId, 'trooper1');

    await loginAs(page, 'wrangler');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_signup')).toHaveText('Sign Up to Attend');
    await expect(page.locator('#event_signup_full_note')).toContainText('Trooper places are full');

    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#signup_role_wrangler').check();
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_submit')).toHaveValue('Confirm Signup');
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success')).toHaveAttribute('data-signup-mode', 'create');
    expect(await getRsvpStatus(eventId, 'wrangler', 'wrangler')).toBe('attending');
  });

  test('a member still has to meet the prerequisites to join the waitlist', async ({ page }) => {
    const eventId = await createEvent({ title: 'Full Prereq Troop', maxTroopers: 1 });
    await createRsvp(eventId, 'trooper1');

    await loginAs(page, 'newbie');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#signup_role_trooper').check();
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');
    await expect(page.locator('#prereq_tk_id')).toBeVisible();

    await signUpThroughWizard(page, eventId, {
      prerequisites: {
        tk_id: 'TK-99001',
        preferred_name: 'Newt',
        mobile: '0400 999 111',
        emergency_contact: 'Next Of Kin 0400 999 222',
      },
    });
    await expect(page.locator('#rsvp_success')).toHaveAttribute('data-signup-mode', 'waitlist');
    expect(await getRsvpStatus(eventId, 'newbie')).toBe('waitlisted');
  });

  // Four members sit on the confirm step of an event with one place, and all four submit
  // at the same instant - the requests are fired from each page together and awaited
  // together, so they overlap at the server rather than queueing behind one another in
  // the browser. Several rounds, because a race that only loses some of the time proves
  // nothing by passing once.
  test('members contesting the last place: exactly one gets it, and the rest queue in turn', async ({ browser }) => {
    const contenders: FixtureUser[] = ['trooper2', 'nowwcc', 'excluded', 'gec'];
    const pages = await Promise.all(contenders.map((username) => pageFor(browser, username)));

    try {
      for (let round = 1; round <= 3; round++) {
        const eventId = await createEvent({ title: `Last Place Troop ${round}`, maxTroopers: 1 });
        await Promise.all(pages.map((page) => openConfirmStep(page, eventId)));

        const bodies = await Promise.all(pages.map((page) => submitFormAtOnce(page, '#rsvp_form', { times: 1 })));
        for (const [body] of bodies) {
          expect(body).toContain('rsvp_success_message');
        }

        const statuses = await Promise.all(contenders.map((username) => getRsvpStatus(eventId, username)));
        expect(statuses.filter((status) => status === 'attending'), `round ${round}`).toHaveLength(1);
        expect(statuses.filter((status) => status === 'waitlisted'), `round ${round}`).toHaveLength(3);

        // Each of the three waiting got a place in the queue of their own.
        const pills = [];
        for (const [index, username] of contenders.entries()) {
          if (statuses[index] !== 'waitlisted') continue;
          await pages[index].goto(`/event.php?id=${eventId}`);
          pills.push(await pages[index].locator('#event_signup_waitlist_trooper').innerText());
        }
        expect(pills.sort(), `round ${round}`).toEqual([
          'Waitlisted: Trooping (#1)',
          'Waitlisted: Trooping (#2)',
          'Waitlisted: Trooping (#3)',
        ]);
      }
    } finally {
      await Promise.all(pages.map((page) => page.close()));
    }
  });

  test('a double-clicked Confirm on the last place is one signup, not a place and a waitlist entry', async ({ page }) => {
    const eventId = await createEvent({ title: 'Double Click Last Place Troop', maxTroopers: 1 });

    await loginAs(page, 'trooper2');
    await openConfirmStep(page, eventId);
    await submitFormAtOnce(page, '#rsvp_form', { times: 3 });

    const rows = await query(`SELECT status FROM ${T('event_plugin_rsvps')} WHERE event_id = ? AND user_id = ?`, [
      eventId,
      uid('trooper2'),
    ]);
    expect(rows.map((row: any) => row.status)).toEqual(['attending']);
  });

  test('the place goes to whoever got there first, even if the confirm step said there was room', async ({ page, browser }) => {
    const eventId = await createEvent({ title: 'Beaten To It Troop', maxTroopers: 1 });

    await loginAs(page, 'trooper2');
    await openConfirmStep(page, eventId);
    await expect(page.locator('#rsvp_submit')).toHaveValue('Confirm Signup');

    const rival = await pageFor(browser, 'nowwcc');
    try {
      await openConfirmStep(rival, eventId);
      await rival.locator('#rsvp_submit').click();
      await expect(rival.locator('#rsvp_success')).toHaveAttribute('data-signup-mode', 'create');
    } finally {
      await rival.close();
    }

    // The success page reports what the save did, not what the confirm step predicted.
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success')).toHaveAttribute('data-signup-mode', 'waitlist');
    await expect(page.locator('#rsvp_summary_waitlist li')).toContainText(['number 1 on the waitlist']);
    expect(await getRsvpStatus(eventId, 'trooper2')).toBe('waitlisted');
  });
});

test.describe('the waitlist', () => {
  test('is listed in signup order on the event and the attendance sheet, apart from the attendees', async ({ page }) => {
    const eventId = await createEvent({ title: 'Queue Order Troop', coordinator: 'gec', maxTroopers: 1 });
    await createRsvp(eventId, 'trooper1', { at: relativeToTestNow({ days: -4 }) });
    // Signup order is nowwcc, trooper2, excluded; by name it would be the reverse-ish
    // excluded, nowwcc, trooper2.
    await createRsvp(eventId, 'nowwcc', { status: 'waitlisted', at: relativeToTestNow({ days: -3 }) });
    await createRsvp(eventId, 'trooper2', { status: 'waitlisted', at: relativeToTestNow({ days: -2 }) });
    await createRsvp(eventId, 'excluded', { status: 'waitlisted', at: relativeToTestNow({ days: -1 }) });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#rsvp_rows li.rsvp_row .rsvp_username')).toHaveText(['trooper1']);
    await expect(page.locator('#waitlist_rows li.waitlist_row .rsvp_username')).toHaveText(['nowwcc', 'trooper2', 'excluded']);

    await page.goto(`/event.php?id=${eventId}&action=attendance`);
    await expect(page.locator('#attendance_table tbody.attendee_group')).toHaveCount(1);
    await expect(page.locator('#attendance_table td.attendee_username')).toHaveText(['trooper1']);

    const waitlist = page.locator('.attendance_waitlist_table');
    await expect(page.locator('.attendance_waitlist_heading')).toHaveText('Waitlist');
    await expect(waitlist.locator('td.attendee_username')).toHaveText(['nowwcc', 'trooper2', 'excluded']);
    await expect(waitlist.locator('td.attendee_num')).toHaveText(['W1', 'W2', 'W3']);
    await expect(waitlist.locator('td.attendee_role').first()).toHaveText('Trooper - waitlisted');
    // The point of contact calls people in off this list, so it carries their numbers.
    await expect(waitlist.locator('td.attendee_mobile').first()).toHaveText('0400 000 004');
    await expect(page.locator('.events_print_meta')).toContainText('1 attendee + 3 waitlisted');
  });

  test('gives a dropout\'s place to the first person waiting for that role, and tells them', async ({ page }) => {
    const eventId = await createEvent({ title: 'Dropout Troop', coordinator: 'gec', maxTroopers: 1, maxWranglers: 1 });
    await createRsvp(eventId, 'trooper1', { at: relativeToTestNow({ days: -3 }) });
    await createRsvp(eventId, 'nowwcc', { status: 'waitlisted', at: relativeToTestNow({ days: -2 }) });
    await createRsvp(eventId, 'trooper2', { status: 'waitlisted', at: relativeToTestNow({ days: -1 }) });
    await createRsvp(eventId, 'wrangler', { role: 'wrangler', at: relativeToTestNow({ days: -3 }) });
    await createRsvp(eventId, 'excluded', { role: 'wrangler', status: 'waitlisted', at: relativeToTestNow({ days: -1 }) });

    await loginAs(page, 'trooper1');
    await withdrawThroughWizard(page, eventId);

    expect(await getRsvpStatus(eventId, 'nowwcc')).toBe('attending');
    expect(await getRsvpStatus(eventId, 'trooper2')).toBe('waitlisted');
    // A trooper's place is not a wrangler's, however long they have been waiting.
    expect(await getRsvpStatus(eventId, 'excluded', 'wrangler')).toBe('waitlisted');

    const [pm] = await getPrivateMessages('nowwcc', 'You have a place: Dropout Troop');
    expect(pm).toBeTruthy();
    // From the coordinator, not from the member who pulled out.
    expect(Number(pm.fromid)).toBe(uid('gec'));
    expect(await countPrivateMessages('trooper2', 'You have a place:%')).toBe(0);
    expect(await countPrivateMessages('trooper1', 'You have a place:%')).toBe(0);
  });

  test('is a queue per day on an event of several days', async ({ page }) => {
    const eventId = await createEvent({ title: 'Weekend Queue Troop', coordinator: 'gec', maxTroopers: 1, ...WEEKEND });
    const [saturday, sunday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));
    await createRsvp(eventId, 'trooper1', { dayIds: [saturday], at: relativeToTestNow({ days: -2 }) });

    await loginAs(page, 'trooper2');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await expect(page.locator('label:has(#signup_role_trooper)')).toContainText('full on some days');
    await expect(page.locator(`label:has(#day_${saturday}_trooper)`)).toContainText('full - waitlist');
    await expect(page.locator(`label:has(#day_${sunday}_trooper)`)).not.toContainText('full');

    await openConfirmStep(page, eventId);
    await expect(page.locator('#rsvp_submit')).toHaveValue('Confirm and Join the Waitlist');
    await expect(page.locator('#confirm_waitlist li')).toHaveCount(1);
    await expect(page.locator('#confirm_waitlist li')).toHaveAttribute('data-day-id', String(saturday));
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success')).toHaveAttribute('data-signup-mode', 'create');

    expect(await getClaimStatuses(eventId, 'trooper2')).toEqual({ [saturday]: 'waitlisted', [sunday]: 'attending' });
    // Going on one of the days is going.
    expect(await getRsvpStatus(eventId, 'trooper2')).toBe('attending');

    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_signup_status_trooper')).toContainText('25 Oct');
    await expect(page.locator('#event_signup_waitlist_trooper')).toContainText('24 Oct #1');

    await loginAs(page, 'trooper1');
    await withdrawThroughWizard(page, eventId);
    expect(await getClaimStatuses(eventId, 'trooper2')).toEqual({ [saturday]: 'attending', [sunday]: 'attending' });

    const [pm] = await getPrivateMessages('trooper2', 'You have a place: Weekend Queue Troop');
    expect(String(pm.message)).toContain('Sat 24 Oct 2026');
    expect(String(pm.message)).not.toContain('Sun 25 Oct 2026');
  });

  test('leaves waitlisted days off the calendar file', async ({ page }) => {
    const eventId = await createEvent({ title: 'Calendar Queue Troop', maxTroopers: 1, ...WEEKEND });
    const [saturday, sunday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));
    const rsvpId = await createRsvp(eventId, 'trooper2', { dayIds: [saturday, sunday] });
    await createRsvp(eventId, 'trooper1', { dayIds: [saturday], at: relativeToTestNow({ days: -1 }) });
    const { execute, T } = await import('../helpers/db');
    await execute(`UPDATE ${T('event_plugin_rsvp_days')} SET status = 'waitlisted' WHERE rsvp_id = ? AND event_day_id = ?`, [
      rsvpId,
      saturday,
    ]);

    await loginAs(page, 'trooper2');
    const body = (await (await page.request.get(`/ical.php?id=${eventId}`)).text()).replace(/\r\n[ \t]/g, '');
    const starts = [...body.matchAll(/^DTSTART:(\d{8})/gm)].map((match) => match[1]);
    expect(starts).toEqual(['20261025']);
  });
});

test.describe('changing an event\'s maximum', () => {
  test('raising it gives that many more places out, in signup order', async ({ page }) => {
    const eventId = await createEvent({ title: 'Raised Troop', coordinator: 'gec', maxTroopers: 1 });
    await createRsvp(eventId, 'trooper1', { at: relativeToTestNow({ days: -4 }) });
    await createRsvp(eventId, 'trooper2', { status: 'waitlisted', at: relativeToTestNow({ days: -3 }) });
    await createRsvp(eventId, 'nowwcc', { status: 'waitlisted', at: relativeToTestNow({ days: -2 }) });
    await createRsvp(eventId, 'excluded', { status: 'waitlisted', at: relativeToTestNow({ days: -1 }) });

    await loginAs(page, 'gec');
    await saveEventForm(page, eventId, '3');
    await expect(page.locator('body')).toContainText('2 members were given a place off the waitlist');

    expect(await getRsvpStatus(eventId, 'trooper2')).toBe('attending');
    expect(await getRsvpStatus(eventId, 'nowwcc')).toBe('attending');
    expect(await getRsvpStatus(eventId, 'excluded')).toBe('waitlisted');
    const [pm] = await getPrivateMessages('trooper2', 'You have a place: Raised Troop');
    // From the coordinator who raised it, so a reply reaches somebody who can answer.
    expect(Number(pm.fromid)).toBe(uid('gec'));
    expect(String(pm.message)).toContain('moved off the waitlist');
    expect(String(pm.message)).toContain('Trooping');
    expect(await countPrivateMessages('nowwcc', 'You have a place: Raised Troop')).toBe(1);
    expect(await countPrivateMessages('gec', 'You have a place:%')).toBe(0);
    expect(await countPrivateMessages('excluded', 'You have a place:%')).toBe(0);
  });

  test('lowering it warns first, then moves the most recent signups to the front of the waitlist', async ({ page }) => {
    const eventId = await createEvent({ title: 'Lowered Troop', coordinator: 'gec', maxTroopers: 3 });
    await createRsvp(eventId, 'trooper1', { at: relativeToTestNow({ days: -4 }) });
    await createRsvp(eventId, 'trooper2', { at: relativeToTestNow({ days: -3 }) });
    await createRsvp(eventId, 'nowwcc', { at: relativeToTestNow({ days: -2 }) });
    await createRsvp(eventId, 'excluded', { status: 'waitlisted', at: relativeToTestNow({ days: -1 }) });

    await loginAs(page, 'gec');
    await saveEventForm(page, eventId, '1');

    await expect(page.locator('#event_cap_change_members li')).toHaveText(['nowwcc (Trooping)', 'trooper2 (Trooping)']);
    expect(await getRsvpStatus(eventId, 'trooper2')).toBe('attending');

    await page.locator('#event_day_change_confirm').click();
    await expect(page.locator('body')).toContainText('2 members were moved to the waitlist');

    expect(await getRsvpStatus(eventId, 'trooper1')).toBe('attending');
    expect(await getRsvpStatus(eventId, 'trooper2')).toBe('waitlisted');
    expect(await getRsvpStatus(eventId, 'nowwcc')).toBe('waitlisted');

    // They signed up before anybody who was already waiting, so they wait in front of them.
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#waitlist_rows li.waitlist_row .rsvp_username')).toHaveText(['trooper2', 'nowwcc', 'excluded']);

    const [pm] = await getPrivateMessages('trooper2', 'Moved to the waitlist: Lowered Troop');
    expect(Number(pm.fromid)).toBe(uid('gec'));
    expect(String(pm.message)).toContain('has been reduced');
    expect(String(pm.message)).toContain('given a place back automatically');
    expect(String(pm.message)).toContain('/event.php?id=' + eventId);
    expect(await countPrivateMessages('nowwcc', 'Moved to the waitlist: Lowered Troop')).toBe(1);
    expect(await countPrivateMessages('trooper1', 'Moved to the waitlist:%')).toBe(0);
    // Already waiting before the change, so nothing about their signup moved.
    expect(await countPrivateMessages('excluded', 'Moved to the waitlist:%')).toBe(0);
  });

  test('lowering it from the Admin CP asks the same question', async ({ page }) => {
    const eventId = await createEvent({ title: 'Admin Lowered Troop', coordinator: 'gec', maxTroopers: 2 });
    await createRsvp(eventId, 'trooper1', { at: relativeToTestNow({ days: -2 }) });
    await createRsvp(eventId, 'trooper2', { at: relativeToTestNow({ days: -1 }) });

    await loginToAdminCp(page);
    await gotoEventsAdmin(page, `&action=edit&id=${eventId}`);
    await page.locator('#max_troopers').fill('1');
    await page.locator('input[type="submit"][value="Update Event"]').click();

    await expect(page.locator('#event_cap_change_members li')).toHaveText(['trooper2 (Trooping)']);
    await page.locator('#event_day_change_confirm').click();
    await expect(page.locator('#flash_message')).toContainText('1 member was moved to the waitlist');
    expect(await getRsvpStatus(eventId, 'trooper2')).toBe('waitlisted');
    const [pm] = await getPrivateMessages('trooper2', 'Moved to the waitlist: Admin Lowered Troop');
    expect(Number(pm.fromid)).toBe(uid('admin'));
  });

  for (const bad of ['ten', '-1', '2.5', '10000']) {
    test(`refuses a maximum of "${bad}"`, async ({ page }) => {
      const eventId = await createEvent({ title: 'Bad Maximum Troop', coordinator: 'gec', maxTroopers: 4 });

      await loginAs(page, 'gec');
      await saveEventForm(page, eventId, bad);
      await expect(page.locator('body')).toContainText('maximum number of troopers must be a whole number from 0 to 9999');
      await page.goto(`/event.php?id=${eventId}`);
      await expect(page.locator('#event_capacity')).toHaveText('4 troopers');
    });
  }

  test('emptying it takes the limit off and gives everybody waiting a place', async ({ page }) => {
    const eventId = await createEvent({ title: 'Unlimited Troop', coordinator: 'gec', maxTroopers: 1 });
    await createRsvp(eventId, 'trooper1', { at: relativeToTestNow({ days: -3 }) });
    await createRsvp(eventId, 'trooper2', { status: 'waitlisted', at: relativeToTestNow({ days: -2 }) });

    await loginAs(page, 'gec');
    await saveEventForm(page, eventId, '');
    expect(await getRsvpStatus(eventId, 'trooper2')).toBe('attending');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_capacity')).toHaveCount(0);
    await expect(page.locator('#waitlist_list')).toHaveCount(0);
  });

  test('leaves a finished event\'s lists as they were', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Finished Capped Troop',
      coordinator: 'gec',
      start: relativeToTestNow({ days: -2 }),
      end: relativeToTestNow({ days: -2, hours: 6 }),
      maxTroopers: 2,
    });
    await createRsvp(eventId, 'trooper1', { at: relativeToTestNow({ days: -5 }) });
    await createRsvp(eventId, 'trooper2', { at: relativeToTestNow({ days: -4 }) });

    await loginAs(page, 'gec');
    await saveEventForm(page, eventId, '1');
    await expect(page.locator('#event_cap_change_members')).toHaveCount(0);

    expect(await getRsvpStatus(eventId, 'trooper2')).toBe('attending');
    expect(await countPrivateMessages('trooper2', 'Moved to the waitlist:%')).toBe(0);
  });
});

test.describe('dropping out, every way it happens', () => {
  test('excluding a member who holds a place gives it to the next person waiting', async ({ page }) => {
    const eventId = await createEvent({ title: 'Excluded Place Troop', coordinator: 'gec', maxTroopers: 1 });
    await createRsvp(eventId, 'excluded', { at: relativeToTestNow({ days: -3 }) });
    await createRsvp(eventId, 'trooper2', { status: 'waitlisted', at: relativeToTestNow({ days: -2 }) });

    await loginAs(page, 'gec');
    await page.goto(`/manage_event.php?id=${eventId}`);
    await addTags(page, '#event_form_exclusions', ['excluded']);
    await page.locator('#manage_event_submit').click();
    await expect(page.locator('body')).toContainText('1 member was given a place off the waitlist');

    expect(await getSignupRoles(eventId, 'excluded')).toEqual([]);
    expect(await getRsvpStatus(eventId, 'trooper2')).toBe('attending');
    const [pm] = await getPrivateMessages('trooper2', 'You have a place: Excluded Place Troop');
    expect(Number(pm.fromid)).toBe(uid('gec'));
    // The event is hidden from an excluded member, so nothing about it is sent to them.
    expect(await countPrivateMessages('excluded', '%Excluded Place Troop%')).toBe(0);
  });

  test('removing a day cancels the waitlisted signups on it too, and tells them', async ({ page }) => {
    const eventId = await createEvent({ title: 'Removed Day Queue Troop', coordinator: 'gec', maxTroopers: 1, ...WEEKEND });
    const [saturday, sunday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));
    await createRsvp(eventId, 'nowwcc', { dayIds: [saturday], at: relativeToTestNow({ days: -4 }) });
    await createRsvp(eventId, 'trooper2', { dayIds: [saturday], status: 'waitlisted', at: relativeToTestNow({ days: -3 }) });
    await createRsvp(eventId, 'trooper1', { dayIds: [sunday], at: relativeToTestNow({ days: -2 }) });

    await loginAs(page, 'gec');
    await page.goto(`/manage_event.php?id=${eventId}`);
    await fillDateTime(page, 'event_form_start_date', '2026-10-25 09:00:00');
    await page.locator('#manage_event_submit').click();

    await expect(page.locator('#event_day_change_members li')).toHaveText(['nowwcc', 'trooper2']);
    await page.locator('#event_day_change_confirm').click();
    await expect(page.locator('body')).toContainText('2 signups were cancelled');

    expect(await getSignupRoles(eventId, 'trooper2')).toEqual([]);
    expect(await countPrivateMessages('trooper2', 'Event changed: Removed Day Queue Troop')).toBe(1);
    expect(await getRsvpStatus(eventId, 'trooper1')).toBe('attending');
  });

  test('deleting a member who holds a place gives it to the next person waiting', async () => {
    const eventId = await createEvent({ title: 'Deleted Place Troop', coordinator: 'gec', maxTroopers: 1 });
    const ghost = await registerMember(`e2e_waitlist_${Date.now()}`);
    await execute(
      `INSERT INTO ${T('event_plugin_rsvps')} (event_id, user_id, role, rsvp_date, status) VALUES (?, ?, 'trooper', ?, 'attending')`,
      [eventId, ghost, relativeToTestNow({ days: -3 })],
    );
    await createRsvp(eventId, 'trooper2', { status: 'waitlisted', at: relativeToTestNow({ days: -2 }) });

    await runPhp(`
require_once MYBB_ROOT.'inc/datahandlers/user.php';
$handler = new UserDataHandler('delete');
$handler->delete_user(array(${ghost}));
`);

    expect(await getRsvpStatus(eventId, 'trooper2')).toBe('attending');
    const [pm] = await getPrivateMessages('trooper2', 'You have a place: Deleted Place Troop');
    expect(Number(pm.fromid)).toBe(uid('gec'));
  });

  test('somebody waiting who pulls out moves the people behind them up, and gives nobody a place', async ({ page }) => {
    const eventId = await createEvent({ title: 'Queue Leaver Troop', maxTroopers: 1 });
    await createRsvp(eventId, 'trooper1', { at: relativeToTestNow({ days: -4 }) });
    await createRsvp(eventId, 'trooper2', { status: 'waitlisted', at: relativeToTestNow({ days: -3 }) });
    await createRsvp(eventId, 'nowwcc', { status: 'waitlisted', at: relativeToTestNow({ days: -2 }) });

    await loginAs(page, 'trooper2');
    await withdrawThroughWizard(page, eventId);

    expect(await getRsvpStatus(eventId, 'trooper1')).toBe('attending');
    expect(await getRsvpStatus(eventId, 'nowwcc')).toBe('waitlisted');
    expect(await countPrivateMessages('nowwcc', 'You have a place:%')).toBe(0);

    await loginAs(page, 'nowwcc');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_signup_waitlist_trooper')).toHaveText('Waitlisted: Trooping (#1)');
  });
});

test.describe('keeping a place in the queue', () => {
  test('saving a signup again does not send a member to the back of the waitlist', async ({ page }) => {
    const eventId = await createEvent({ title: 'Resaved Queue Troop', maxTroopers: 1 });
    await createRsvp(eventId, 'trooper1', { at: relativeToTestNow({ days: -4 }) });
    await createRsvp(eventId, 'nowwcc', { status: 'waitlisted', at: relativeToTestNow({ days: -3 }) });
    await createRsvp(eventId, 'trooper2', { status: 'waitlisted', at: relativeToTestNow({ days: -2 }) });

    await loginAs(page, 'nowwcc');
    await openConfirmStep(page, eventId);
    // Nothing new is being asked for, so this is not joining anything.
    await expect(page.locator('#rsvp_submit')).toHaveValue('Save Changes');
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success')).toHaveAttribute('data-signup-mode', 'update');

    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_signup_waitlist_trooper')).toHaveText('Waitlisted: Trooping (#1)');

    await loginAs(page, 'trooper1');
    await withdrawThroughWizard(page, eventId);
    expect(await getRsvpStatus(eventId, 'nowwcc')).toBe('attending');
    expect(await getRsvpStatus(eventId, 'trooper2')).toBe('waitlisted');
  });

  test('a day added to a signup joins the back of that day\'s queue, and the days held keep their places', async ({ page }) => {
    const eventId = await createEvent({ title: 'Added Day Queue Troop', maxTroopers: 1, ...WEEKEND });
    const [saturday, sunday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));
    await createRsvp(eventId, 'trooper1', { dayIds: [saturday, sunday], at: relativeToTestNow({ days: -4 }) });
    await createRsvp(eventId, 'nowwcc', { dayIds: [saturday], status: 'waitlisted', at: relativeToTestNow({ days: -3 }) });
    await createRsvp(eventId, 'trooper2', { dayIds: [sunday], status: 'waitlisted', at: relativeToTestNow({ days: -2 }) });

    await loginAs(page, 'nowwcc');
    await page.goto(`/rsvp.php?id=${eventId}`);
    // A signup that differs day to day opens the grid; closing it makes the leading
    // answer cover the whole event.
    await page.locator('#signup_per_day').uncheck();
    await page.locator('#signup_role_trooper').check();
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_submit')).toHaveValue('Save and Join the Waitlist');
    await page.locator('#rsvp_submit').click();

    expect(await getClaimStatuses(eventId, 'nowwcc')).toEqual({ [saturday]: 'waitlisted', [sunday]: 'waitlisted' });
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_signup_waitlist_trooper')).toHaveText('Waitlisted: Trooping (24 Oct #1, 25 Oct #2)');
  });

  test('switching to a role that is full joins its waitlist, and frees the place in the old one', async ({ page }) => {
    const eventId = await createEvent({ title: 'Role Switch Troop', coordinator: 'gec', maxTroopers: 1, maxWranglers: 1 });
    await createRsvp(eventId, 'wrangler', { role: 'wrangler', at: relativeToTestNow({ days: -4 }) });
    await createRsvp(eventId, 'trooper2', { at: relativeToTestNow({ days: -3 }) });
    await createRsvp(eventId, 'nowwcc', { status: 'waitlisted', at: relativeToTestNow({ days: -2 }) });

    await loginAs(page, 'trooper2');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await expect(page.locator('label:has(#signup_role_wrangler)')).toContainText('full - join the waitlist');
    await page.locator('#signup_role_wrangler').check();
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_submit')).toHaveValue('Save and Join the Waitlist');
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_summary_waitlist')).toBeVisible();

    expect(await getSignupRoles(eventId, 'trooper2')).toEqual(['wrangler']);
    expect(await getRsvpStatus(eventId, 'trooper2', 'wrangler')).toBe('waitlisted');
    expect(await getRsvpStatus(eventId, 'nowwcc')).toBe('attending');
    const [pm] = await getPrivateMessages('nowwcc', 'You have a place: Role Switch Troop');
    expect(Number(pm.fromid)).toBe(uid('gec'));
  });

  test('a single-day event that gains days puts every signup in each day\'s queue where it already stood', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Grown Weekend Troop',
      coordinator: 'gec',
      start: '2026-10-24 09:00:00',
      end: '2026-10-24 17:00:00',
      maxTroopers: 1,
    });
    await createRsvp(eventId, 'trooper1', { at: relativeToTestNow({ days: -3 }) });
    await createRsvp(eventId, 'trooper2', { status: 'waitlisted', at: relativeToTestNow({ days: -2 }) });

    await loginAs(page, 'gec');
    await page.goto(`/manage_event.php?id=${eventId}`);
    await fillDateTime(page, 'event_form_end_date', '2026-10-25 17:00:00');
    await expect(page.locator('[data-events-day-date="2026-10-25"]')).toBeVisible();
    await page.locator('#manage_event_submit').click();
    await expect(page.locator('#event_days li.event_day')).toHaveCount(2);

    const [saturday, sunday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));
    expect(await getClaimStatuses(eventId, 'trooper1')).toEqual({ [saturday]: 'attending', [sunday]: 'attending' });
    expect(await getClaimStatuses(eventId, 'trooper2')).toEqual({ [saturday]: 'waitlisted', [sunday]: 'waitlisted' });
    expect(await countPrivateMessages('trooper2', '%Grown Weekend Troop%')).toBe(0);
  });
});

test.describe('the warning before a maximum is lowered', () => {
  test('is asked again when the queue changes before it is confirmed', async ({ page, browser }) => {
    const eventId = await createEvent({ title: 'Moving Queue Troop', coordinator: 'gec', maxTroopers: 3 });
    await createRsvp(eventId, 'trooper1', { at: relativeToTestNow({ days: -3 }) });
    await createRsvp(eventId, 'trooper2', { at: relativeToTestNow({ days: -2 }) });

    await loginAs(page, 'gec');
    await saveEventForm(page, eventId, '1');
    await expect(page.locator('#event_cap_change_members li')).toHaveText(['trooper2 (Trooping)']);

    // Somebody takes the third place while the coordinator is reading the warning.
    const late = await pageFor(browser, 'nowwcc');
    try {
      await openConfirmStep(late, eventId);
      await late.locator('#rsvp_submit').click();
      await expect(late.locator('#rsvp_success')).toHaveAttribute('data-signup-mode', 'create');
    } finally {
      await late.close();
    }

    // Confirming what was on the screen is not agreeing to move somebody who was not.
    await page.locator('#event_day_change_confirm').click();
    await expect(page.locator('#event_cap_change_members li')).toHaveText(['nowwcc (Trooping)', 'trooper2 (Trooping)']);
    expect(await getRsvpStatus(eventId, 'trooper2')).toBe('attending');

    await page.locator('#event_day_change_confirm').click();
    await expect(page.locator('body')).toContainText('2 members were moved to the waitlist');
    expect(await getRsvpStatus(eventId, 'nowwcc')).toBe('waitlisted');
  });

  test('covers a removed day and a lowered maximum in one question', async ({ page }) => {
    const eventId = await createEvent({ title: 'Both Changes Troop', coordinator: 'gec', maxTroopers: 2, ...WEEKEND });
    const [saturday, sunday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));
    await createRsvp(eventId, 'nowwcc', { dayIds: [saturday], at: relativeToTestNow({ days: -4 }) });
    await createRsvp(eventId, 'trooper1', { dayIds: [sunday], at: relativeToTestNow({ days: -3 }) });
    await createRsvp(eventId, 'trooper2', { dayIds: [sunday], at: relativeToTestNow({ days: -2 }) });

    await loginAs(page, 'gec');
    await page.goto(`/manage_event.php?id=${eventId}`);
    await fillDateTime(page, 'event_form_start_date', '2026-10-25 09:00:00');
    await page.locator('#event_form_max_troopers').fill('1');
    await page.locator('#manage_event_submit').click();

    await expect(page.locator('#event_day_change_members li')).toHaveText(['nowwcc']);
    await expect(page.locator('#event_cap_change_members li')).toHaveCount(1);
    await expect(page.locator('#event_cap_change_members li')).toContainText('trooper2');
    await expect(page.locator('#event_day_change_confirm')).toHaveText('Save and cancel 1 signup and move 1 to the waitlist');

    await page.locator('#event_day_change_confirm').click();
    expect(await getSignupRoles(eventId, 'nowwcc')).toEqual([]);
    expect(await getRsvpStatus(eventId, 'trooper1')).toBe('attending');
    expect(await getRsvpStatus(eventId, 'trooper2')).toBe('waitlisted');
    expect(await countPrivateMessages('nowwcc', 'Event changed:%')).toBe(1);
    expect(await countPrivateMessages('trooper2', 'Moved to the waitlist:%')).toBe(1);
  });
});

test.describe('where the waitlist is shown', () => {
  test('the attendance sheet has a queue per day, and the day filter narrows it to one', async ({ page }) => {
    const eventId = await createEvent({ title: 'Sheet Queue Troop', coordinator: 'gec', maxTroopers: 1, ...WEEKEND });
    const [saturday, sunday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));
    await createRsvp(eventId, 'trooper1', { dayIds: [saturday, sunday], at: relativeToTestNow({ days: -4 }) });
    await createRsvp(eventId, 'trooper2', { dayIds: [saturday, sunday], status: 'waitlisted', at: relativeToTestNow({ days: -3 }) });
    await createRsvp(eventId, 'nowwcc', { dayIds: [saturday], status: 'waitlisted', at: relativeToTestNow({ days: -2 }) });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}&action=attendance`);

    const queues = page.locator('.attendance_waitlist');
    await expect(queues).toHaveCount(2);
    await expect(queues.nth(0).locator('.attendance_waitlist_heading')).toContainText('Waitlist - Sat 24 Oct 2026');
    await expect(queues.nth(0).locator('td.attendee_username')).toHaveText(['trooper2', 'nowwcc']);
    await expect(queues.nth(1).locator('.attendance_waitlist_heading')).toContainText('Waitlist - Sun 25 Oct 2026');
    await expect(queues.nth(1).locator('td.attendee_username')).toHaveText(['trooper2']);
    await expect(page.locator('#attendance_table td.attendee_username')).toHaveText(['trooper1']);

    await page.goto(`/event.php?id=${eventId}&action=attendance&filter_day=${sunday}`);
    await expect(queues).toHaveCount(1);
    await expect(queues.locator('td.attendee_username')).toHaveText(['trooper2']);

    // On paper it is still there, still headed, and still apart from the attendees.
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('.attendance_waitlist_heading')).toBeVisible();
    await expect(page.locator('.attendance_waitlist_table td.attendee_role')).toHaveText('Trooper - waitlisted');
  });

  test('the Admin CP RSVP review lists the waitlist in its own table, in signup order', async ({ page }) => {
    const eventId = await createEvent({ title: 'Admin Queue Troop', maxTroopers: 1 });
    await createRsvp(eventId, 'trooper1', { at: relativeToTestNow({ days: -4 }) });
    await createRsvp(eventId, 'trooper2', { status: 'waitlisted', at: relativeToTestNow({ days: -3 }) });
    await createRsvp(eventId, 'excluded', { status: 'waitlisted', at: relativeToTestNow({ days: -2 }) });

    await loginToAdminCp(page);
    await gotoEventsAdmin(page, `&action=rsvps&event_id=${eventId}`);
    await expect(page.locator('tr.events_admin_waitlist_row td:first-child')).toHaveText(['trooper2', 'excluded']);
    await expect(page.locator('body')).toContainText('Waitlist (2)');
    await expect(page.locator('body')).toContainText('RSVPs for: Admin Queue Troop (1)');
  });

  test('the announcement post gives the maximums', async () => {
    const eventId = await createEvent({ title: 'Announced Capped Troop', maxTroopers: 10, maxWranglers: 2, ...WEEKEND });
    const post = await runPhp(`
require_once MYBB_ROOT.'inc/plugins/events/inc/events_thread.php';
echo events_event_post_content(events_get_event(${eventId}));
`);
    expect(post).toContain('[b]Places:[/b] 10 troopers, 2 wranglers each day');
  });

  test('the calendar subscription leaves out an event the member is only waiting for', async ({ page, request }) => {
    const waiting = await createEvent({ title: 'Feed Waiting Troop', maxTroopers: 1 });
    await createRsvp(waiting, 'trooper1', { at: relativeToTestNow({ days: -3 }) });
    await createRsvp(waiting, 'trooper2', { status: 'waitlisted', at: relativeToTestNow({ days: -2 }) });
    const going = await createEvent({ title: 'Feed Attending Troop' });
    await createRsvp(going, 'trooper2');

    await loginAs(page, 'trooper2');
    await page.goto('/calendar_feed.php');
    await page.locator('#calendar_feed_create, #calendar_feed_reset').click();
    const url = await page.locator('#calendar_feed_url').inputValue();

    const body = (await (await request.get(url)).text()).replace(/\r\n[ \t]/g, '');
    expect(body).toContain('Feed Attending Troop');
    expect(body).not.toContain('Feed Waiting Troop');
  });
});
