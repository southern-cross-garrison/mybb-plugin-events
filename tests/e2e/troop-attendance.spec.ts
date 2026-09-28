import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { followAdminActionLink, gotoEventsAdmin, loginAs, loginToAdminCp, logout } from '../helpers/auth';
import { runPhp } from '../helpers/container';
import { relativeToTestNow } from '../helpers/clock';
import { expectEditorAttached, fillDescription } from '../helpers/editor';
import { submitFormAtOnce } from '../helpers/double-submit';
import { withSettings } from '../helpers/settings';
import {
  createEvent,
  createRsvp,
  getEventDays,
  execute,
  fixtures,
  getThreadFirstPost,
  getTroopReport,
  query,
  queryOne,
  T,
  uid,
} from '../helpers/db';

/**
 * Troop attendance: a member signed up to an event and named in its posted troop report
 * is counted, in the role they signed up for, and the Admin CP's Reports tab and the
 * User CP's My Troops page are drawn from those rows.
 *
 * A trooper is named by username *and* Legion number, a wrangler (or a trooper with no
 * ID recorded) by username alone - see events_attendance_matches().
 */

const [TK, TD, TB] = [0, 1, 2].map((index) => fixtures().costumeOptions[index]);

/** An event that finished `daysAgo` days ago. */
async function finishedEvent(title: string, options: { daysAgo?: number; region?: string } = {}): Promise<number> {
  const daysAgo = options.daysAgo ?? 1;
  return createEvent({
    title,
    region: options.region,
    start: relativeToTestNow({ days: -daysAgo - 1 }),
    end: relativeToTestNow({ days: -daysAgo }),
    signupCutoff: relativeToTestNow({ days: -daysAgo - 2 }),
  });
}

/** Who the event's attendance counts, as "username:role", sorted. */
async function attendance(eventId: number): Promise<string[]> {
  const rows = await query<any>(
    `SELECT COALESCE(u.username, CONCAT('#', a.user_id)) AS who, a.role
       FROM ${T('event_plugin_attendance')} a
       LEFT JOIN ${T('users')} u ON u.uid = a.user_id
      WHERE a.event_id = ?`,
    [eventId],
  );
  return rows.map((row) => `${row.who}:${row.role}`).sort();
}

async function attendanceCostumes(eventId: number, username: string): Promise<string[]> {
  const rows = await query<any>(
    `SELECT c.costume FROM ${T('event_plugin_attendance_costumes')} c
       INNER JOIN ${T('event_plugin_attendance')} a ON a.id = c.attendance_id
      WHERE a.event_id = ? AND a.user_id = ?`,
    [eventId, uid(username)],
  );
  return rows.map((row) => row.costume).sort();
}

/** Post the report through the form, as trooper1, replacing the draft when given content. */
async function postReport(page: Page, eventId: number, content?: string): Promise<void> {
  await loginAs(page, 'trooper1');
  await page.goto(`/troop_report.php?id=${eventId}`);
  if (content !== undefined) {
    await fillDescription(page, 'troop_report_content', content);
  }
  await page.locator('#troop_report_submit').click();
  await page.waitForLoadState('domcontentloaded');
  expect((await getTroopReport(eventId))?.posted_at).toBeTruthy();
}

/**
 * Post the drafted report from the command line, by the path the form takes. Much
 * quicker than the form for the tests that only need attendance to exist.
 */
async function postDraftedReport(eventId: number, author = 'trooper1'): Promise<void> {
  const output = await runPhp(`
require_once MYBB_ROOT.'inc/plugins/events/inc/events_troop_report.php';
$event = events_get_event(${eventId});
$tid = events_post_troop_report($event, get_user(${uid(author)}), events_troop_report_draft($event), $error);
echo $tid ? 'POSTED' : 'FAILED: '.$error;
`);
  expect(output).toContain('POSTED');
}

async function reportPostId(eventId: number): Promise<number> {
  const report = await getTroopReport(eventId);
  return Number((await getThreadFirstPost(Number(report!.thread_id))).pid);
}

/** Edit a post through MyBB's post datahandler, which is what fires the recount. */
async function updatePost(pid: number, message: string): Promise<void> {
  const output = await runPhp(`
require_once MYBB_ROOT.'inc/datahandlers/post.php';
$post = get_post(${pid});
$handler = new PostDataHandler('update');
$handler->action = 'post';
$handler->set_data(array('pid' => ${pid}, 'message' => ${JSON.stringify(message)}, 'edit_uid' => (int)$post['uid'], 'uid' => (int)$post['uid'], 'username' => $post['username']));
if(!$handler->validate_post()) { echo 'INVALID: '.implode(',', $handler->get_friendly_errors()); exit; }
$handler->update_post();
echo 'UPDATED';
`);
  expect(output).toContain('UPDATED');
}

test.describe('troop attendance', () => {
  test('posting the drafted report counts every trooper and wrangler it lists', async ({ page }) => {
    const eventId = await finishedEvent('Drafted Attendance Troop');
    await createRsvp(eventId, 'trooper1', { costumes: [TK, TB] });
    await createRsvp(eventId, 'trooper2', { costumes: [TD] });
    await createRsvp(eventId, 'wrangler', { role: 'wrangler' });

    await postReport(page, eventId);

    expect(await attendance(eventId)).toEqual(['trooper1:trooper', 'trooper2:trooper', 'wrangler:wrangler']);
    expect(await attendanceCostumes(eventId, 'trooper1')).toEqual([TK, TB].sort());
    expect(await attendanceCostumes(eventId, 'trooper2')).toEqual([TD]);
  });

  test('a trooper needs their username and Legion number, a member with no number just the username', async ({ page }) => {
    const eventId = await finishedEvent('Matching Rules Troop');
    await createRsvp(eventId, 'trooper1');
    await createRsvp(eventId, 'trooper2');
    await createRsvp(eventId, 'gec');
    await createRsvp(eventId, 'newbie');
    await createRsvp(eventId, 'excluded', { status: 'waitlisted' });

    await postReport(
      page,
      eventId,
      [
        // Named, but not numbered.
        'Ash - trooper1',
        // Numbered, but not named: a postcode is not a trooper.
        'We met at the Parramatta 20002 depot.',
        // The username in the wrong case is somebody else's name, not gec's.
        'Jan - Gec - TK-10001',
        // No Legion ID on file, so the name is enough - through BBCode too.
        '[b]newbie[/b] carried the banner',
        // Off the waitlist on the day.
        'Eli - excluded - TK20005',
      ].join('\n'),
    );

    expect(await attendance(eventId)).toEqual(['excluded:trooper', 'newbie:trooper']);
  });

  test('editing the report recounts it, from the edit page and from quick edit', async ({ page }) => {
    const eventId = await finishedEvent('Edited Attendance Troop');
    await createRsvp(eventId, 'trooper1');
    await createRsvp(eventId, 'trooper2');

    await postReport(page, eventId);
    expect(await attendance(eventId)).toEqual(['trooper1:trooper', 'trooper2:trooper']);

    const pid = await reportPostId(eventId);

    // Bex didn't make it after all.
    await page.goto(`/editpost.php?pid=${pid}`);
    await fillDescription(page, 'message', 'Ash - trooper1 - TK-20001\nA quiet one.');
    await page.getByRole('button', { name: 'Update Post' }).click();
    await page.waitForLoadState('domcontentloaded');
    await expect.poll(() => attendance(eventId)).toEqual(['trooper1:trooper']);

    // Quick edit posts to xmlhttp.php from the thread, which is where the fetch runs.
    await page.goto(`/showthread.php?pid=${pid}`);
    const status = await page.evaluate(async (postId) => {
      const body = new URLSearchParams({
        my_post_key: (window as any).my_post_key,
        value: 'Ash - trooper1 - TK-20001\nBex - trooper2 - TK-20002',
      });
      const response = await fetch(`xmlhttp.php?action=edit_post&do=update_post&pid=${postId}`, { method: 'POST', body });
      return response.status;
    }, pid);
    expect(status).toBe(200);
    expect(await attendance(eventId)).toEqual(['trooper1:trooper', 'trooper2:trooper']);
  });

  test('editing a reply in the report thread counts nothing', async ({ page }) => {
    const eventId = await finishedEvent('Reply Edit Troop');
    await createRsvp(eventId, 'trooper1');
    await createRsvp(eventId, 'trooper2');

    await postReport(page, eventId, 'Ash - trooper1 - TK-20001');
    expect(await attendance(eventId)).toEqual(['trooper1:trooper']);

    // Change the report underneath the recount, so a recount is visible when it happens.
    const pid = await reportPostId(eventId);
    await execute(`UPDATE ${T('posts')} SET message = ? WHERE pid = ?`, [
      'Ash - trooper1 - TK-20001\nBex - trooper2 - TK-20002',
      pid,
    ]);

    const report = await getTroopReport(eventId);
    const output = await runPhp(`
require_once MYBB_ROOT.'inc/datahandlers/post.php';
$handler = new PostDataHandler('insert');
$handler->action = 'post';
$handler->admin_override = true;
$handler->set_data(array('tid' => ${Number(report!.thread_id)}, 'message' => 'Great photos!', 'uid' => ${uid('trooper2')}, 'username' => 'trooper2', 'ipaddress' => '127.0.0.1', 'savedraft' => 0, 'options' => array()));
$handler->validate_post();
$post = $handler->insert_post();
echo 'PID:'.$post['pid'];
`);
    const replyPid = Number(output.match(/PID:(\d+)/)![1]);

    await updatePost(replyPid, 'Great photos, Bex - trooper2 - TK-20002!');
    expect(await attendance(eventId)).toEqual(['trooper1:trooper']);

    // And the report's own first post does recount.
    await updatePost(pid, 'Ash - trooper1 - TK-20001\nBex - trooper2 - TK-20002');
    expect(await attendance(eventId)).toEqual(['trooper1:trooper', 'trooper2:trooper']);
  });

  test('deleting the event takes its attendance with it', async ({ page }) => {
    const eventId = await finishedEvent('Deleted Attendance Troop');
    await createRsvp(eventId, 'trooper1');
    await postDraftedReport(eventId);
    expect(await attendance(eventId)).toEqual(['trooper1:trooper']);

    await loginToAdminCp(page);
    await followAdminActionLink(page, `action=delete&id=${eventId}`);

    expect(await attendance(eventId)).toEqual([]);
    const orphans = await queryOne<any>(
      `SELECT COUNT(*) AS n FROM ${T('event_plugin_attendance_costumes')} c
        LEFT JOIN ${T('event_plugin_attendance')} a ON a.id = c.attendance_id WHERE a.id IS NULL`,
    );
    expect(Number(orphans!.n)).toBe(0);
  });

  test.describe('a deleted member', () => {
    let throwaway = 0;

    test.afterEach(async () => {
      if (!throwaway) return;
      await runPhp(`
require_once MYBB_ROOT.'inc/datahandlers/user.php';
if(get_user(${throwaway})) { $handler = new UserDataHandler('delete'); $handler->delete_user(array(${throwaway})); }
`);
      throwaway = 0;
    });

    test('keeps their troops, reported as a deleted user, through a later edit', async ({ page }) => {
      const username = `gone_${Date.now().toString(36)}`;
      const output = await runPhp(`
require_once MYBB_ROOT.'inc/datahandlers/user.php';
$handler = new UserDataHandler('insert');
$handler->set_data(array('username' => '${username}', 'password' => 'Passw0rd!Passw0rd', 'password2' => 'Passw0rd!Passw0rd',
  'email' => '${username}@example.invalid', 'email2' => '${username}@example.invalid', 'usergroup' => 2, 'regip' => '127.0.0.1'));
if(!$handler->validate_user()) { echo 'INVALID'; exit; }
$user = $handler->insert_user();
echo 'UID:'.$user['uid'];
`);
      throwaway = Number(output.match(/UID:(\d+)/)![1]);

      const eventId = await finishedEvent('Departed Member Troop');
      await createRsvp(eventId, 'trooper1');
      await execute(
        `INSERT INTO ${T('event_plugin_rsvps')} (event_id, user_id, role, rsvp_date, status) VALUES (?, ?, 'wrangler', ?, 'attending')`,
        [eventId, throwaway, relativeToTestNow({ days: -5 })],
      );
      await postDraftedReport(eventId);
      expect(await attendance(eventId)).toEqual(['trooper1:trooper', `${username}:wrangler`].sort());

      await runPhp(`
require_once MYBB_ROOT.'inc/datahandlers/user.php';
$handler = new UserDataHandler('delete');
$handler->delete_user(array(${throwaway}));
`);
      expect(await attendance(eventId)).toEqual([`#${throwaway}:wrangler`, 'trooper1:trooper']);

      // Their signup went with them, so a recount has nothing to rebuild their row from -
      // and must not throw it away.
      await updatePost(await reportPostId(eventId), 'Ash - trooper1 - TK-20001');
      expect(await attendance(eventId)).toEqual([`#${throwaway}:wrangler`, 'trooper1:trooper']);

      await loginToAdminCp(page);
      await gotoEventsAdmin(page, '&action=reports&view=people');
      await expect(page.locator('.events_report_member', { hasText: '[deleted user]' })).toHaveCount(1);
      await gotoEventsAdmin(page, '&action=reports&view=events');
      await expect(page.locator('.events_report_row', { hasText: 'Departed Member Troop' }).locator('.events_report_count')).toHaveText('2');
    });
  });

  test.describe('reports', () => {
    /**
     * Three events, most recent last:
     *   Sydney, 40 days ago: trooper1 (TK), trooper2 (TD), gec (TK), wrangler
     *   Hunter, 20 days ago: trooper1 (TB), gec (TK)
     *   Sydney, 5 days ago:  trooper1 (TK)
     */
    let events: { first: number; second: number; third: number };

    test.beforeEach(async () => {
      const first = await finishedEvent('Report Sydney Parade', { daysAgo: 40, region: 'Sydney' });
      await createRsvp(first, 'trooper1', { costumes: [TK] });
      await createRsvp(first, 'trooper2', { costumes: [TD] });
      await createRsvp(first, 'gec', { costumes: [TK] });
      await createRsvp(first, 'wrangler', { role: 'wrangler' });

      const second = await finishedEvent('Report Hunter Fete', { daysAgo: 20, region: 'Hunter' });
      await createRsvp(second, 'trooper1', { costumes: [TB] });
      await createRsvp(second, 'gec', { costumes: [TK] });

      const third = await finishedEvent('Report Sydney Hospital', { daysAgo: 5, region: 'Sydney' });
      await createRsvp(third, 'trooper1', { costumes: [TK] });

      for (const eventId of [first, second, third]) {
        await postDraftedReport(eventId);
      }
      events = { first, second, third };
    });

    /** The first column of each row of the view's table. */
    async function column(page: Page): Promise<string[]> {
      return (await page.locator('.events_report_row .events_report_member').allTextContents()).map((text) => text.trim());
    }

    async function counts(page: Page): Promise<string[]> {
      return (await page.locator('.events_report_row .events_report_count').allTextContents()).map((text) => text.trim());
    }

    test('rank people, events, regions and costumes, most and least first', async ({ page }) => {
      await loginToAdminCp(page);

      await gotoEventsAdmin(page, '&action=reports');
      await expect(page.locator('#events_stat_troops .events_stat_value')).toHaveText('7');
      await expect(page.locator('#events_stat_events .events_stat_value')).toHaveText('3');
      await expect(page.locator('#events_stat_members .events_stat_value')).toHaveText('4');
      await expect(page.locator('#events_stat_costumes .events_stat_value')).toHaveText('3');
      await expect(page.locator('#events_chart_by_month')).toBeVisible();

      expect((await column(page)).slice(0, 2)).toEqual(['trooper1', 'gec']);
      expect(await counts(page)).toEqual(['3', '2', '1', '1']);
      await expect(page.locator('#events_chart_ranking .events_chart_bar_row')).toHaveCount(4);

      await gotoEventsAdmin(page, '&action=reports&view=people&order=least');
      expect(await counts(page)).toEqual(['1', '1', '2', '3']);

      await gotoEventsAdmin(page, '&action=reports&view=events');
      expect(await column(page)).toEqual(['Report Sydney Parade', 'Report Hunter Fete', 'Report Sydney Hospital']);
      expect(await counts(page)).toEqual(['4', '2', '1']);

      await gotoEventsAdmin(page, '&action=reports&view=events&order=least');
      expect(await column(page)).toEqual(['Report Sydney Hospital', 'Report Hunter Fete', 'Report Sydney Parade']);

      await gotoEventsAdmin(page, '&action=reports&view=regions');
      expect(await column(page)).toEqual(['Sydney', 'Hunter']);
      expect(await counts(page)).toEqual(['5', '2']);

      await gotoEventsAdmin(page, '&action=reports&view=costumes');
      expect((await column(page))[0]).toBe(TK);
      expect(await counts(page)).toEqual(['4', '1', '1']);
    });

    test('filter by region, role and date', async ({ page }) => {
      await loginToAdminCp(page);

      await gotoEventsAdmin(page, '&action=reports&view=people&region=Hunter');
      expect((await column(page)).sort()).toEqual(['gec', 'trooper1']);
      expect(await counts(page)).toEqual(['1', '1']);

      await gotoEventsAdmin(page, '&action=reports&view=people&role=wrangler');
      expect(await column(page)).toEqual(['wrangler']);

      // Through the form, the way an administrator narrows it down. It starts folded away.
      await gotoEventsAdmin(page, '&action=reports');
      await expect(page.locator('#report_view')).toBeHidden();
      await page.locator('#events_report_filters > summary').click();
      await page.locator('#report_view').selectOption('events');
      await page.locator('#report_from').fill(relativeToTestNow({ days: -10 }).slice(0, 10));
      await page.keyboard.press('Escape');
      await page.locator('input[type="submit"][value="Show Report"]').click();
      await page.waitForLoadState('domcontentloaded');
      expect(await column(page)).toEqual(['Report Sydney Hospital']);
      await expect(page.locator('#events_stat_troops .events_stat_value')).toHaveText('1');
      // Back folded, saying what it now shows.
      await expect(page.locator('#events_report_filters')).not.toHaveAttribute('open', /.*/);
      await expect(page.locator('#events_report_filter_summary')).toHaveText(
        `Events, most first · From ${relativeToTestNow({ days: -10 }).slice(0, 10)} · All regions · Any role`,
      );

      await gotoEventsAdmin(page, '&action=reports&from=1999-01-01&to=1999-12-31');
      await expect(page.locator('#events_reports_empty')).toBeVisible();
    });

    test('the folded filter panel says what the report is set to', async ({ page }) => {
      await loginToAdminCp(page);

      await gotoEventsAdmin(page, '&action=reports');
      await expect(page.locator('#events_report_filters')).not.toHaveAttribute('open', /.*/);
      await expect(page.locator('#events_report_filter_summary')).toHaveText('People, most first · All dates · All regions · Any role');

      await gotoEventsAdmin(page, '&action=reports&view=costumes&order=least&from=2026-01-01&to=2026-06-30&region=Hunter&role=wrangler');
      await expect(page.locator('#events_report_filter_summary')).toHaveText(
        'Costumes, least first · 2026-01-01 to 2026-06-30 · Hunter · Wranglers',
      );
      await gotoEventsAdmin(page, '&action=reports&to=2026-06-30');
      await expect(page.locator('#events_report_filter_summary')).toHaveText('People, most first · Up to 2026-06-30 · All regions · Any role');

      // Nothing it does not recognise is applied, and the summary says so rather than
      // echoing it back.
      await gotoEventsAdmin(page, '&action=reports&view=bogus&order=sideways&from=2026-13-45&to=yesterday&region=Nowhere&role=admin');
      await expect(page.locator('#events_report_filter_summary')).toHaveText('People, most first · All dates · All regions · Any role');
      await expect(page.locator('#events_stat_troops .events_stat_value')).toHaveText('7');
    });

    test('My Troops shows a member their own figures and nobody else\'s', async ({ page }) => {
      await loginAs(page, 'trooper1');
      await page.goto('/usercp.php');
      await page.locator('#usercp_nav_events_troops').click();
      await expect(page).toHaveURL(/usercp\.php\?action=events_troops$/);

      await expect(page.locator('#events_stat_troops .events_stat_value')).toHaveText('3');
      await expect(page.locator('#events_troops_last')).toHaveText('Report Sydney Hospital');
      await expect(page.locator('#events_troops_top_costume')).toHaveText(TK);
      // Nobody has trooped more than trooper1.
      await expect(page.locator('#events_stat_percentile .events_stat_value')).toHaveText('100%');
      await expect(page.locator('#events_troops_history tbody tr')).toHaveCount(3);
      await expect(page.locator('#events_chart_my_months .events_chart_column')).toHaveCount(12);
      await expect(page.locator('#events_chart_my_costumes .events_chart_bar_row')).toHaveCount(2);

      // There is no member to ask for: a uid on the URL changes nothing.
      await page.goto(`/usercp.php?action=events_troops&uid=${uid('gec')}`);
      await expect(page.locator('#events_stat_troops .events_stat_value')).toHaveText('3');

      // gec trooped twice; everybody else in the population but trooper1 trooped less.
      const population = await queryOne<any>(
        `SELECT COUNT(*) AS n FROM ${T('users')} u
          WHERE u.uid IN (SELECT user_id FROM ${T('event_plugin_attendance')})
             OR u.usergroup = ? OR CONCAT(',', u.additionalgroups, ',') LIKE ?`,
        [fixtures().groups.garrison, `%,${fixtures().groups.garrison},%`],
      );
      const others = Number(population!.n) - 1;
      await loginAs(page, 'gec');
      await page.goto('/usercp.php?action=events_troops');
      await expect(page.locator('#events_stat_troops .events_stat_value')).toHaveText('2');
      await expect(page.locator('#events_stat_percentile .events_stat_value')).toHaveText(
        `${Math.round(((others - 1) / others) * 100)}%`,
      );

      await loginAs(page, 'newbie');
      await page.goto('/usercp.php?action=events_troops');
      await expect(page.locator('#events_troops_none')).toBeVisible();

      await logout(page);
      await page.goto('/usercp.php?action=events_troops');
      await expect(page.locator('#events_troops_page')).toHaveCount(0);
    });
  });

  test('a member who trooped and wrangled the same event is one troop, in both roles', async ({ page }) => {
    const eventId = await finishedEvent('Both Roles Troop');
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });
    await createRsvp(eventId, 'trooper1', { role: 'wrangler' });
    await postDraftedReport(eventId);

    expect(await attendance(eventId)).toEqual(['trooper1:trooper', 'trooper1:wrangler']);

    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=reports');
    await expect(page.locator('#events_stat_troops .events_stat_value')).toHaveText('1');
    await expect(page.locator('#events_stat_members .events_stat_value')).toHaveText('1');
    const row = page.locator('.events_report_row', { hasText: 'trooper1' });
    await expect(row.locator('td')).toHaveText(['trooper1', '1', '1', '1', TK, /Both Roles Troop/]);

    await gotoEventsAdmin(page, '&action=reports&view=events');
    await expect(page.locator('.events_report_row .events_report_count')).toHaveText(['1']);
    await gotoEventsAdmin(page, '&action=reports&view=regions');
    await expect(page.locator('.events_report_row .events_report_count')).toHaveText(['1']);

    await loginAs(page, 'trooper1');
    await page.goto('/usercp.php?action=events_troops');
    await expect(page.locator('#events_stat_troops .events_stat_value')).toHaveText('1');
    await expect(page.locator('#events_stat_trooper .events_stat_value')).toHaveText('1');
    await expect(page.locator('#events_stat_wrangler .events_stat_value')).toHaveText('1');
  });

  test('a multi-day event is one troop per member, whatever days they held or waited on', async ({ page }) => {
    const first = relativeToTestNow({ days: -3 }).slice(0, 10);
    const second = relativeToTestNow({ days: -2 }).slice(0, 10);
    const eventId = await createEvent({
      title: 'Weekend Convention Troop',
      start: `${first} 09:00:00`,
      end: `${second} 17:00:00`,
      signupCutoff: relativeToTestNow({ days: -5 }),
      days: [{ date: first }, { date: second }],
    });
    const [day1, day2] = (await getEventDays(eventId)).map((day: any) => Number(day.id));

    await createRsvp(eventId, 'trooper1', { costumes: [TK], dayIds: [day1, day2] });
    // Attending Saturday, still waiting on Sunday: the signup comes back from both the
    // attending list and the waitlist, and must still be counted once.
    const rsvpId = await createRsvp(eventId, 'trooper2', { costumes: [TD], dayIds: [day1] });
    await execute(
      `INSERT INTO ${T('event_plugin_rsvp_days')} (rsvp_id, event_day_id, status, claimed_at) VALUES (?, ?, 'waitlisted', ?)`,
      [rsvpId, day2, relativeToTestNow({ days: -6 })],
    );

    await postReport(page, eventId);

    expect(await attendance(eventId)).toEqual(['trooper1:trooper', 'trooper2:trooper']);
    expect(await attendanceCostumes(eventId, 'trooper2')).toEqual([TD]);
  });

  test('a double-clicked report is counted once', async ({ page }) => {
    const eventId = await finishedEvent('Double Click Attendance Troop');
    await createRsvp(eventId, 'trooper1');
    await createRsvp(eventId, 'trooper2');

    await loginAs(page, 'trooper1');
    await page.goto(`/troop_report.php?id=${eventId}`);
    await expectEditorAttached(page, 'troop_report_content');
    const bodies = await submitFormAtOnce(page, '#troop_report_form', {
      overrides: { report_content: 'Ash - trooper1 - TK-20001\nBex - trooper2 - TK-20002' },
    });
    for (const body of bodies) {
      expect(body).not.toMatch(/SQL Error|Fatal error/);
    }

    expect(await attendance(eventId)).toEqual(['trooper1:trooper', 'trooper2:trooper']);
    expect(await attendanceCostumes(eventId, 'trooper1')).toEqual([TK]);
  });

  test('a recount takes the costumes the signup lists now', async () => {
    const eventId = await finishedEvent('Costume Change Troop');
    const rsvpId = await createRsvp(eventId, 'trooper1', { costumes: [TK] });
    await postDraftedReport(eventId);
    expect(await attendanceCostumes(eventId, 'trooper1')).toEqual([TK]);

    // The coordinator corrects the signup: it was the biker scout, not the stormtrooper.
    await execute(`UPDATE ${T('event_plugin_rsvp_costumes')} SET costume = ? WHERE rsvp_id = ?`, [TB, rsvpId]);
    await updatePost(await reportPostId(eventId), 'Ash - trooper1 - TK-20001');

    expect(await attendanceCostumes(eventId, 'trooper1')).toEqual([TB]);
  });

  test('matching holds at the edges of a username and a number', async () => {
    const cases: Array<[string, { username: string; role: string; tk_id: string }, boolean]> = [
      // The number alone, no prefix at all.
      ['trooper1 20001', { username: 'trooper1', role: 'trooper', tk_id: 'TK-20001' }, true],
      // A longer username is not this one, and neither is one run on with an underscore.
      ['trooper10 - TK-20001', { username: 'trooper1', role: 'trooper', tk_id: 'TK-20001' }, false],
      ['trooper1_old - TK-20001', { username: 'trooper1', role: 'trooper', tk_id: 'TK-20001' }, false],
      // Part of a number is not the number, either way round.
      ['trooper1 - TK-200011', { username: 'trooper1', role: 'trooper', tk_id: 'TK-20001' }, false],
      ['trooper1 - TK-2000', { username: 'trooper1', role: 'trooper', tk_id: 'TK-20001' }, false],
      // Leading zeros are the same number.
      ['rex - TK-0042', { username: 'rex', role: 'trooper', tk_id: '42' }, true],
      ['rex - TK-42', { username: 'rex', role: 'trooper', tk_id: 'TK-0042' }, true],
      // A username is text, not a pattern.
      ['a-b.c here', { username: 'a-b.c', role: 'trooper', tk_id: '' }, true],
      ['a-bxc here', { username: 'a-b.c', role: 'trooper', tk_id: '' }, false],
      // Letters beyond ASCII still bound a word.
      ['Zoë - TK-7', { username: 'Zoë', role: 'trooper', tk_id: '7' }, true],
      ['Zoëy - TK-7', { username: 'Zoë', role: 'trooper', tk_id: '7' }, false],
      // A wrangler needs no number, even with one on file.
      ['Dev - wrangler', { username: 'wrangler', role: 'wrangler', tk_id: 'TK-99' }, true],
      ['[b]Wranglers:[/b]', { username: 'wrangler', role: 'wrangler', tk_id: '' }, false],
    ];

    const output = await runPhp(`
require_once MYBB_ROOT.'inc/plugins/events/inc/events_attendance.php';
foreach(json_decode(${JSON.stringify(JSON.stringify(cases))}, true) as $case) {
    echo (events_attendance_matches(events_attendance_text($case[0]), $case[1]) ? 'Y' : 'N');
}
`);
    expect(output).toBe(cases.map((c) => (c[2] ? 'Y' : 'N')).join(''));
  });

  test('the percentile has nobody to compare with when nobody else is counted', async ({ page }) => {
    const eventId = await finishedEvent('Lone Trooper Troop');
    await createRsvp(eventId, 'trooper1');
    await postDraftedReport(eventId);
    // A member who has since been deleted is nobody's peer.
    await execute(
      `INSERT INTO ${T('event_plugin_attendance')} (event_id, user_id, role, recorded_at) VALUES (?, 999999, 'trooper', ?)`,
      [eventId, relativeToTestNow({})],
    );

    const restore = await withSettings({ events_garrison_members_group: '' });
    try {
      await loginAs(page, 'trooper1');
      await page.goto('/usercp.php?action=events_troops');
      await expect(page.locator('#events_stat_troops .events_stat_value')).toHaveText('1');
      await expect(page.locator('#events_stat_percentile .events_stat_value')).toHaveText('-');
    } finally {
      await restore();
    }
  });

  test('paging a report keeps its filters', async ({ page }) => {
    // Straight into the tables: 21 Hunter events is more than a page, and one in Sydney is
    // what a lost filter would let back in.
    for (let i = 0; i < 22; i++) {
      const eventId = await finishedEvent(`Paged Troop ${String(i).padStart(2, '0')}`, {
        daysAgo: 30 + i,
        region: i === 21 ? 'Sydney' : 'Hunter',
      });
      await execute(
        `INSERT INTO ${T('event_plugin_attendance')} (event_id, user_id, role, recorded_at) VALUES (?, ?, 'trooper', ?)`,
        [eventId, uid('trooper1'), relativeToTestNow({})],
      );
    }

    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=reports&view=events&region=Hunter&order=least');
    await expect(page.locator('.events_report_row')).toHaveCount(20);

    await page.locator('.pagination a', { hasText: '2' }).first().click();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('.events_report_row')).toHaveCount(1);
    await expect(page.locator('.events_report_row')).not.toContainText('Paged Troop 21');
    await expect(page.locator('#events_report_filter_summary')).toHaveText('Events, least first · All dates · Hunter · Any role');
  });

  test('My Troops is in the User CP nav on MyBB\'s Default theme too', async ({ page }) => {
    const { style } = (await queryOne<any>(`SELECT style FROM ${T('users')} WHERE uid = ?`, [uid('trooper1')]))!;
    await execute(`UPDATE ${T('users')} SET style = 2 WHERE uid = ?`, [uid('trooper1')]);
    try {
      await loginAs(page, 'trooper1');
      await page.goto('/usercp.php');
      await expect(page.locator('#usercp_nav_events_troops')).toHaveText('My Troops');
      await expect(page.locator('tr:has(> td > #usercp_nav_events_troops)')).toHaveCount(1);
      await page.locator('#usercp_nav_events_troops').click();
      await expect(page.locator('#events_troops_none')).toBeVisible();
    } finally {
      await execute(`UPDATE ${T('users')} SET style = ? WHERE uid = ?`, [style, uid('trooper1')]);
    }
  });
});
