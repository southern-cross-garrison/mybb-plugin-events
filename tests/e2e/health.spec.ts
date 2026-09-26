import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { clearErrorLogs, readErrorLogs } from '../helpers/error-log';
import { followAdminActionLink, gotoEventsAdmin, loginAs, loginToAdminCp } from '../helpers/auth';
import { createEvent, createRsvp, getEventDays, fixtures } from '../helpers/db';
import { relativeToTestNow } from '../helpers/clock';

const TK = fixtures().costumeOptions[0];

/** The lines of either log that come from the plugin. */
async function pluginLogLines(): Promise<string> {
  return (await readErrorLogs())
    .split('\n')
    .filter((line) => /events|event_plugin|rsvp|troop/i.test(line))
    .join('\n');
}

/** Open a page and insist it came back as a page rather than an error. */
async function expectRenders(page: Page, url: string): Promise<void> {
  const response = await page.goto(url);
  expect(response?.status(), `${url} should not error`).toBeLessThan(400);
  await expect(page.locator('body'), `${url} should not show a MyBB SQL error`).not.toContainText('MyBB SQL Error');
}

/**
 * Broad sweeps that would otherwise only be noticed as a subtly wrong-looking page:
 * PHP notices and SQL errors are logged rather than shown, so they are checked directly.
 */
test.describe('runtime health', () => {
  test('every plugin page renders without a PHP warning or SQL error', async ({ page }) => {
    await clearErrorLogs();

    const eventId = await createEvent({
      title: 'Health Check Troop',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const dayIds = (await getEventDays(eventId)).map((day: any) => Number(day.id));
    await createRsvp(eventId, 'trooper1', { costumes: [TK], dayIds });

    await loginAs(page, 'gec');
    for (const url of [
      '/events.php',
      '/events.php?view=calendar',
      '/events.php?region=Sydney',
      `/event.php?id=${eventId}`,
      `/event.php?id=${eventId}&action=attendance`,
      `/rsvp.php?id=${eventId}`,
      '/manage_event.php',
      `/manage_event.php?id=${eventId}`,
    ]) {
      await expectRenders(page, url);
    }

    // ical.php is a file download, so it is fetched rather than navigated to.
    const ical = await page.request.get(`/ical.php?id=${eventId}`);
    expect(ical.status()).toBe(200);
    expect(await ical.text()).not.toContain('MyBB SQL Error');

    const relevant = await pluginLogLines();
    expect(relevant, `PHP or MyBB logged errors from the plugin:\n${relevant}`).toBe('');
  });

  /**
   * The sweep above only ever covered the pages a member browses to, so a notice in the
   * Admin CP module, the troop report form or the calendar subscription would have gone
   * straight past it. Those are the pages least often opened by hand - an administrator
   * visits the region confirmation pages once a year - which is exactly why a warning on
   * one of them would sit unnoticed.
   *
   * The Admin CP actions are enumerated from events_admin.php's dispatcher and the region
   * actions from events_admin_region_action(). `status` and `delete` change data, so they
   * are followed on an event of their own, the way clicking them does
   * (followAdminActionLink), and land on the list they redirect to.
   */
  test('the Admin CP, the troop report and the calendar subscription render without a PHP warning or SQL error', async ({ page }) => {
    await clearErrorLogs();

    const upcoming = await createEvent({
      title: 'Health Check Admin Troop',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const dayIds = (await getEventDays(upcoming)).map((day: any) => Number(day.id));
    await createRsvp(upcoming, 'trooper1', { costumes: [TK], dayIds });

    // A troop report is only offered for an event that is over and that the member went to.
    const finished = await createEvent({
      title: 'Health Check Finished Troop',
      start: relativeToTestNow({ days: -2 }),
      end: relativeToTestNow({ days: -1 }),
      signupCutoff: relativeToTestNow({ days: -3 }),
    });
    await createRsvp(finished, 'trooper1', { costumes: [TK] });
    await createRsvp(finished, 'wrangler', { role: 'wrangler' });

    const pending = await createEvent({ title: 'Health Check Pending Troop', status: 'pending' });
    const doomed = await createEvent({ title: 'Health Check Doomed Troop', status: 'pending' });

    await loginAs(page, 'trooper1');
    await expectRenders(page, `/troop_report.php?id=${finished}`);
    await expect(page.locator('#troop_report_content')).toHaveCount(1);

    await expectRenders(page, '/usercp.php?action=events_calendar');
    await expectRenders(page, '/calendar_feed.php');

    // A real token, made the way a member makes one, so the feed renders its entries
    // rather than stopping at the token check.
    await page.locator('#calendar_feed_create, #calendar_feed_reset').click();
    const feedUrl = (await page.locator('#calendar_feed_url').textContent())!.trim();
    expect(feedUrl).toMatch(/\/ical_feed\.php\?token=[A-Za-z0-9_-]{86}$/);
    const feed = await page.request.get(feedUrl);
    expect(feed.status()).toBe(200);
    const feedBody = await feed.text();
    expect(feedBody).toContain('BEGIN:VCALENDAR');
    expect(feedBody).toContain('Health Check Admin Troop');
    expect(feedBody).not.toContain('MyBB SQL Error');

    // The page with a link already made is a different render from the one without.
    await expectRenders(page, '/calendar_feed.php');
    await expectRenders(page, '/usercp.php?action=events_calendar');

    // Last, because loginAs() clears the Admin CP session along with everything else.
    await loginToAdminCp(page);
    for (const query of [
      '',
      '&status=pending',
      '&status=live',
      '&status=archived',
      '&action=add',
      `&action=edit&id=${upcoming}`,
      `&action=edit&id=${finished}`,
      '&action=rsvps',
      `&action=rsvps&event_id=${upcoming}`,
      `&action=rsvps&event_id=${finished}`,
      '&action=settings',
      '&action=settings&region_action=add',
      // One region with events behind it (the confirmation asks where they go) and one
      // with none (it does not).
      '&action=settings&region_action=delete&region=Sydney',
      '&action=settings&region_action=delete&region=Canberra',
    ]) {
      await gotoEventsAdmin(page, query);
      const url = `/admin/index.php?module=events${query}`;
      expect(page.url(), `${url} should not bounce to the Admin CP login`).toContain('module=events');
      await expect(page.locator('body'), `${url} should not show a MyBB SQL error`).not.toContainText('MyBB SQL Error');
      await expect(page.locator('#content, body').first(), `${url} should render the module`).toContainText('Event');
    }

    for (const query of [`action=status&id=${pending}&status=live`, `action=status&id=${upcoming}&status=archived`, `action=delete&id=${doomed}`]) {
      const body = await followAdminActionLink(page, query);
      expect(body, `${query} should not show a MyBB SQL error`).not.toContain('MyBB SQL Error');
      expect(body, `${query} should not be refused`).not.toContain('authorization code mismatch');
    }

    const relevant = await pluginLogLines();
    expect(relevant, `PHP or MyBB logged errors from the plugin:\n${relevant}`).toBe('');
  });
});
