import { Page } from '@playwright/test';
import { test, expect, expectMyBBError } from '../helpers/fixtures';
import { loginAs, logout, loginToAdminCp, followAdminActionLink } from '../helpers/auth';
import { relativeToTestNow } from '../helpers/clock';
import { createEvent, createRsvp, fixtures, getEvent, query, T, uid } from '../helpers/db';

/**
 * The gates every plugin page opens with, tested as gates rather than as a side effect of
 * the flows that pass through them.
 *
 * Three kinds of caller are covered: one asking for an event that is not there, one who
 * is not logged in, and one posting to a page they were never served. Each page checks
 * for all three in its own preamble - there is no shared front controller - so a page
 * added without one of them is a page that fails in a way no other test would notice.
 */

const TK = fixtures().costumeOptions[0];

/** An id that is not, and cannot become, an event. */
const MISSING = 999999;

/** Every page that takes an event id. */
const EVENT_PAGES = [
  'event.php',
  'event.php?action=attendance&',
  'rsvp.php',
  'ical.php',
  'manage_event.php',
  'troop_report.php',
];

const url = (page: string, id: number | string) =>
  page.includes('?') ? `/${page}id=${id}` : `/${page}?id=${id}`;

test.describe('an event id that is not an event', () => {
  test('every page that takes one says so rather than rendering half a page', async ({ page }) => {
    await loginAs(page, 'gec');

    for (const target of EVENT_PAGES) {
      await page.goto(url(target, MISSING));

      // MyBB's error page, carrying the plugin's own sentence - not a PHP warning, not a
      // blank event page with an empty title where the event should be.
      await expect(page.locator('body'), `${target} with a missing id`).toContainText('Event not found.');
      await expect(page.locator('body'), `${target} leaked a warning`).not.toContainText(
        /Warning|Notice|Fatal error|SQL Error/,
      );
    }
  });

  test('an id that is not a number is treated as no event at all', async ({ page }) => {
    await loginAs(page, 'gec');

    // MyBB::INPUT_INT casts, so these all arrive as 0. The point is that they arrive as
    // something the page can answer rather than reaching a query as written.
    for (const id of ['abc', '0', "1' OR '1'='1", '-1']) {
      await page.goto(url('event.php', encodeURIComponent(id)));
      await expect(page.locator('body'), `event.php?id=${id}`).toContainText('Event not found.');
    }
  });

  test('manage_event.php with no id at all is the create form, not an error', async ({ page }) => {
    // The one page where a missing id means something: it is how a coordinator creates an
    // event, so it must not be swept up by the not-found check above.
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    await expect(page.locator('#event_form_title')).toHaveValue('');
    await expect(page.locator('#manage_event_submit')).toHaveValue('Create Event');
  });
});

test.describe('pages behind a login', () => {
  test('every plugin page turns a guest away', async ({ page }) => {
    const eventId = await createEvent({ title: 'Members Only Troop', status: 'live' });

    await logout(page);

    for (const target of [...EVENT_PAGES.map((p) => url(p, eventId)), '/events.php', '/manage_event.php']) {
      await page.goto(target);

      await expect(page.locator('body'), `${target} as a guest`).toContainText(
        /not (logged in|have permission)|Please login|must be logged in/i,
      );
      // And it turns them away without first telling them what they are being kept out
      // of: the title is the one thing an error page must not carry.
      await expect(page.locator('body'), `${target} leaked the title`).not.toContainText('Members Only Troop');
    }
  });

  test('the iCal feed answers a guest as a page, not as a download', async ({ page }) => {
    const eventId = await createEvent({ title: 'Feedless Troop', status: 'live' });

    await logout(page);
    const response = await page.request.get(`/ical.php?id=${eventId}`);
    const body = await response.text();

    expect(body).not.toContain('BEGIN:VCALENDAR');
    expect(body).not.toContain('Feedless Troop');
  });
});

test.describe('posts that were never served a form', () => {
  /** POST to a plugin page with a deliberately wrong authorisation code. */
  async function postWithBadKey(page: Page, path: string, form: Record<string, string>): Promise<string> {
    const response = await page.request.post(path, {
      form: { ...form, my_post_key: 'not-the-post-key' },
    });

    return response.text();
  }

  test('the signup wizard refuses one', async ({ page }) => {
    const eventId = await createEvent({ title: 'Forged Signup Troop', status: 'live' });
    await loginAs(page, 'trooper1');

    const body = await postWithBadKey(page, '/rsvp.php', {
      id: String(eventId),
      step: 'confirm',
      signup_role: 'wrangler',
    });

    expect(body).toContain('Authorization code mismatch');
    expect(await query(`SELECT id FROM ${T('event_plugin_rsvps')} WHERE event_id = ?`, [eventId])).toHaveLength(0);
  });

  test('the event form refuses one', async ({ page }) => {
    await loginAs(page, 'gec');

    const body = await postWithBadKey(page, '/manage_event.php', {
      title: 'Forged Troop',
      status: 'live',
      region: 'Sydney',
      start_date: '2026-11-05',
      start_date_time: '09:00',
      end_date: '2026-11-05',
      end_date_time: '17:00',
      gec_user_id: String(uid('gec')),
    });

    expect(body).toContain('Authorization code mismatch');
    expect(await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Forged Troop'`)).toHaveLength(0);
  });

  test('the troop report form refuses one', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Forged Report Troop',
      start: relativeToTestNow({ days: -3 }),
      end: relativeToTestNow({ days: -2 }),
      signupCutoff: relativeToTestNow({ days: -4 }),
    });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await loginAs(page, 'trooper1');
    const body = await postWithBadKey(page, '/troop_report.php', {
      id: String(eventId),
      action: 'post',
      report_content: 'Forged report.',
    });

    expect(body).toContain('Authorization code mismatch');
    expect(await query(`SELECT id FROM ${T('event_plugin_troop_reports')} WHERE event_id = ?`, [eventId]))
      .toHaveLength(0);
  });

  /**
   * The Admin CP's own half of this is worth spelling out, because it is the one place
   * the check is easy to write and have do nothing.
   *
   * verify_post_check() *errors* on the front end but merely *returns false* inside the
   * Admin CP, so calling it bare there checks nothing: both of these actions ran
   * unguarded until these tests were written. Delete and status are GET links, which is
   * exactly the shape an administrator can be sent and click.
   *
   * followAdminActionLink() sends the request as a same-origin one, so what it exercises
   * is the plugin's check rather than MyBB's Sec-Fetch-Site rule - which would turn away
   * a typed URL whatever key it carried, and make either of these pass on code that
   * checks nothing at all.
   */
  test('the Admin CP delete link refuses one', async ({ page }) => {
    const eventId = await createEvent({ title: 'Undeletable Troop', status: 'live' });

    await loginToAdminCp(page);
    await followAdminActionLink(page, `action=delete&id=${eventId}`, { withKey: false });

    expect(
      await query(`SELECT id FROM ${T('event_plugin_events')} WHERE id = ?`, [eventId]),
      'the event was deleted by a link with no post key',
    ).toHaveLength(1);

    // The control: with the key, the same request goes through - so the assertion above
    // is not passing because the link was wrong.
    await followAdminActionLink(page, `action=delete&id=${eventId}`);
    expect(await query(`SELECT id FROM ${T('event_plugin_events')} WHERE id = ?`, [eventId])).toHaveLength(0);
  });

  test('the Admin CP status link refuses one', async ({ page }) => {
    const eventId = await createEvent({ title: 'Unpublishable Troop', status: 'pending' });

    await loginToAdminCp(page);
    await followAdminActionLink(page, `action=status&id=${eventId}&status=live`, { withKey: false });

    expect(
      (await getEvent(eventId)).status,
      'the event was published by a link with no post key',
    ).toBe('pending');

    await followAdminActionLink(page, `action=status&id=${eventId}&status=live`);
    expect((await getEvent(eventId)).status).toBe('live');
  });
});

test.describe('input the listing was not offered', () => {
  test('a region filter naming no region shows everything rather than nothing', async ({ page }) => {
    const eventId = await createEvent({ title: 'Unfiltered Troop', status: 'live', region: 'Sydney' });

    await loginAs(page, 'trooper1');
    await page.goto("/events.php?view=list&region=Nowhere' OR '1'='1");

    await expect(page.locator(`[data-event-id="${eventId}"]`)).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/SQL Error|Warning|Fatal error/);
  });

  test('a view that is not a view falls back to the remembered one', async ({ page }) => {
    await createEvent({ title: 'Viewable Troop', status: 'live' });

    await loginAs(page, 'trooper1');

    // Establish a preference, then ask for a view that does not exist.
    await page.goto('/events.php?view=calendar');
    await expect(page.locator('#events_calendar')).toBeVisible();

    await page.goto('/events.php?view=nonsense');
    await expect(page.locator('#events_calendar'), 'a junk view overwrote the preference').toBeVisible();
  });
});
