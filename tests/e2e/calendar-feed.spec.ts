import { test, expect } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import { signUpThroughWizard } from '../helpers/rsvp';
import { createEvent, createRsvp, execute, fixtures, getEventDays, query, queryOne, T, uid } from '../helpers/db';
import type { APIRequestContext, Page } from '@playwright/test';
import { runPhp } from '../helpers/container';

/**
 * The calendar subscription: a member makes a private link on calendar_feed.php, and
 * their calendar app fetches ical_feed.php with it - from its own servers, with none of
 * the member's cookies. Every fetch here therefore goes through the `request` fixture,
 * which shares no cookies with the signed-in page, so a feed that only worked because
 * the member happened to be logged in would fail.
 */

const WEEKEND = {
  start: '2026-10-17 09:00:00',
  end: '2026-10-18 17:00:00',
  days: [
    { date: '2026-10-17', start: '09:00:00', end: '17:00:00' },
    { date: '2026-10-18', start: '10:00:00', end: '16:00:00' },
  ],
};

/** Make a link as the signed-in member and read it off the page, as they would copy it. */
async function makeFeedLink(page: Page): Promise<string> {
  await page.goto('/calendar_feed.php');
  await page.locator('#calendar_feed_create, #calendar_feed_reset').click();
  const url = (await page.locator('#calendar_feed_url').textContent())!.trim();
  expect(url).toMatch(/\/ical_feed\.php\?token=[A-Za-z0-9_-]{86}$/);
  return url;
}

/** Fetch a feed URL the way a calendar server would: no session. Long lines unfolded. */
async function fetchFeed(request: APIRequestContext, url: string) {
  const response = await request.get(url);
  const body = (await response.text()).replace(/\r\n[ \t]/g, '');
  return { status: response.status(), body, headers: response.headers() };
}

const starts = (body: string) => body.match(/^DTSTART:.*$/gm) ?? [];

interface FeedEntry {
  uid: string;
  start: string;
  end: string;
  summary: string;
  /** Unescaped, as the calendar app shows it. */
  description: string;
}

/** Every VEVENT in an (unfolded) feed, in order, with its text values unescaped. */
function entries(body: string): FeedEntry[] {
  const unescape = (value: string) => value.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
  return body
    .split('BEGIN:VEVENT')
    .slice(1)
    .map((block) => {
      const field = (name: string) => block.match(new RegExp(`^${name}:(.*)$`, 'm'))?.[1]?.trim() ?? '';
      return {
        uid: field('UID'),
        start: field('DTSTART'),
        end: field('DTEND'),
        summary: unescape(field('SUMMARY')),
        description: unescape(field('DESCRIPTION')),
      };
    });
}

test.describe('calendar subscription feed', () => {
  test('follows a member\'s signups as they make and change them', async ({ page, request }) => {
    // The whole journey through the real pages: the link is made in the User CP, and every
    // signup change goes through the signup wizard, so what the feed says is what a member
    // doing this by hand would see their calendar pick up.
    const TK = fixtures().costumeOptions[0];
    const weekend = await createEvent({ title: 'Journey Weekend Troop', ...WEEKEND });
    const [saturday] = (await getEventDays(weekend)).map((day) => Number(day.id));
    const oneDay = await createEvent({
      title: 'Journey Wrangle',
      start: '2026-10-25 10:00:00',
      end: '2026-10-25 15:00:00',
    });

    await loginAs(page, 'trooper1');
    await page.goto('/usercp.php?action=events_calendar');
    await page.locator('#calendar_feed_create').click();
    const url = (await page.locator('#calendar_feed_url').textContent())!.trim();
    const feed = async () => entries((await fetchFeed(request, url)).body);

    // Nothing signed up for yet, so nothing in it - but it is a working, empty calendar.
    const empty = await fetchFeed(request, url);
    expect(empty.status).toBe(200);
    expect(empty.body).toContain('BEGIN:VCALENDAR');
    expect(entries(empty.body)).toEqual([]);

    const saturdayEntry: FeedEntry = {
      uid: `event-${weekend}@localhost`,
      start: '20261017T090000Z',
      end: '20261017T170000Z',
      summary: 'Trooping: Journey Weekend Troop',
      description: `You're trooping (${TK}) this day.\n\nJourney Weekend Troop description`,
    };
    const sundayEntry: FeedEntry = {
      uid: `event-${weekend}-20261018@localhost`,
      start: '20261018T100000Z',
      end: '20261018T160000Z',
      summary: 'Trooping: Journey Weekend Troop',
      description: `You're trooping (${TK}) this day.\n\nJourney Weekend Troop description`,
    };
    const wrangleEntry: FeedEntry = {
      uid: `event-${oneDay}@localhost`,
      start: '20261025T100000Z',
      end: '20261025T150000Z',
      summary: 'Wrangling: Journey Wrangle',
      description: "You're wrangling at this event.\n\nJourney Wrangle description",
    };

    // Both days of the weekend.
    await signUpThroughWizard(page, weekend, { costumes: [TK] });
    expect(await feed()).toEqual([saturdayEntry, sundayEntry]);

    // A second event, in the other role.
    await signUpThroughWizard(page, oneDay, { role: 'wrangler' });
    expect(await feed()).toEqual([saturdayEntry, sundayEntry, wrangleEntry]);

    // Down to Sunday only. Saturday leaves the feed; Sunday keeps its UID, so the app
    // updates the entry it has rather than adding a second one.
    await signUpThroughWizard(page, weekend, { costumes: [TK], dayRoles: { [saturday]: 'none' } });
    expect(await feed()).toEqual([sundayEntry, wrangleEntry]);

    // Withdrawing from the one-day event takes it out altogether.
    await page.goto(`/rsvp.php?id=${oneDay}`);
    await page.locator('#signup_role_none').check();
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#confirm_withdraw')).toBeVisible();
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success')).toHaveAttribute('data-signup-mode', 'withdraw');
    expect(await feed()).toEqual([sundayEntry]);
  });

  test('carries every event the member signed up for, and nothing else', async ({ page, request }) => {
    const going = await createEvent({
      title: 'Feed Going Troop',
      address: '1 Showground Rd, Sydney Olympic Park NSW 2127',
      start: '2026-10-20 10:00:00',
      end: '2026-10-20 16:00:00',
    });
    const wrangling = await createEvent({ title: 'Feed Wrangle Troop', start: '2026-10-22 10:00:00', end: '2026-10-22 16:00:00' });
    await createEvent({ title: 'Feed Not Going Troop', start: '2026-10-24 10:00:00', end: '2026-10-24 16:00:00' });
    await createRsvp(going, 'trooper1');
    await createRsvp(wrangling, 'trooper1', { role: 'wrangler' });
    // Somebody else's signup is theirs.
    const theirs = await createEvent({ title: 'Feed Someone Else Troop' });
    await createRsvp(theirs, 'trooper2');

    await loginAs(page, 'trooper1');
    const { status, body, headers } = await fetchFeed(request, await makeFeedLink(page));

    expect(status).toBe(200);
    expect(headers['content-type']).toContain('text/calendar');
    expect(headers['cache-control']).toContain('no-store');
    // Each entry's title leads with the role, so the calendar grid says what the day is.
    expect(body).toContain('SUMMARY:Trooping: Feed Going Troop');
    expect(body).toContain('SUMMARY:Wrangling: Feed Wrangle Troop');
    expect(body).toContain("DESCRIPTION:You're wrangling at this event.");
    // The same map link the one-event download carries.
    expect(body).toContain(
      'Map: https://www.google.com/maps/search/?api=1&query=1%20Showground%20Rd%2C%20Sydney%20Olympic%20Park%20NSW%202127',
    );
    expect(body).not.toContain('Feed Not Going Troop');
    expect(body).not.toContain('Feed Someone Else Troop');
    // The same UIDs the one-event download uses, so the two describe one thing.
    expect(body).toContain(`UID:event-${going}@`);
  });

  test('drops a day the member stops coming to, on the next fetch', async ({ page, request }) => {
    // The whole point of subscribing: the app mirrors the feed, so a day that leaves it
    // leaves the member's calendar. A downloaded file cannot take anything away.
    const eventId = await createEvent({ title: 'Feed Weekend Troop', ...WEEKEND });
    const [saturday, sunday] = (await getEventDays(eventId)).map((day) => Number(day.id));
    const rsvpId = await createRsvp(eventId, 'trooper1', { dayIds: [saturday, sunday] });

    await loginAs(page, 'trooper1');
    const url = await makeFeedLink(page);
    expect(starts((await fetchFeed(request, url)).body)).toEqual(['DTSTART:20261017T090000Z', 'DTSTART:20261018T100000Z']);

    await execute(`DELETE FROM ${T('event_plugin_rsvp_days')} WHERE rsvp_id = ? AND event_day_id = ?`, [rsvpId, saturday]);
    const { body } = await fetchFeed(request, url);
    expect(starts(body)).toEqual(['DTSTART:20261018T100000Z']);
    expect(body).toContain(`UID:event-${eventId}-20261018@`);

    // And withdrawing altogether empties it.
    await execute(`DELETE FROM ${T('event_plugin_rsvp_days')} WHERE rsvp_id = ?`, [rsvpId]);
    await execute(`DELETE FROM ${T('event_plugin_rsvps')} WHERE id = ?`, [rsvpId]);
    expect(starts((await fetchFeed(request, url)).body)).toEqual([]);
  });

  test('drops an event the member is excluded from after subscribing', async ({ page, request }) => {
    const eventId = await createEvent({ title: 'Feed Exclusion Troop' });
    await createRsvp(eventId, 'trooper1');

    await loginAs(page, 'trooper1');
    const url = await makeFeedLink(page);
    expect((await fetchFeed(request, url)).body).toContain('Feed Exclusion Troop');

    await execute(`INSERT INTO ${T('event_plugin_event_exclusions')} (event_id, user_id) VALUES (?, ?)`, [
      eventId,
      uid('trooper1'),
    ]);
    expect((await fetchFeed(request, url)).body).not.toContain('Feed Exclusion Troop');
  });

  test('stores only a hash of the token, never the token', async ({ page }) => {
    await loginAs(page, 'trooper1');
    const token = new URL(await makeFeedLink(page)).searchParams.get('token')!;

    const rows = await query(`SELECT * FROM ${T('event_plugin_feed_tokens')}`);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    const { createHash } = await import('crypto');
    expect(rows[0].token_hash).toBe(createHash('sha256').update(token).digest('hex'));
  });

  test('shows the link only once', async ({ page }) => {
    await loginAs(page, 'trooper1');
    const url = await makeFeedLink(page);

    await page.goto('/calendar_feed.php');
    await expect(page.locator('#calendar_feed_status')).toBeVisible();
    await expect(page.locator('#calendar_feed_url')).toHaveCount(0);
    expect(await page.content()).not.toContain(new URL(url).searchParams.get('token')!);
  });

  test('leads with the subscribe button and keeps the URL behind its menu', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await loginAs(page, 'trooper1');
    await page.goto('/calendar_feed.php');
    await page.locator('#calendar_feed_create').click();

    const subscribe = page.locator('#calendar_feed_subscribe');
    await expect(subscribe).toBeVisible();
    expect(await subscribe.getAttribute('href')).toMatch(/^webcal:\/\/.*\/ical_feed\.php\?token=[A-Za-z0-9_-]{86}$/);
    await expect(page.locator('#calendar_feed_url')).toBeHidden();

    await page.locator('#calendar_feed_menu_toggle').click();
    await page.locator('#calendar_feed_show_url').click();
    await expect(page.locator('#calendar_feed_show_url')).toBeHidden();
    await expect(page.locator('#calendar_feed_url')).toBeVisible();

    const url = (await page.locator('#calendar_feed_url').textContent())!.trim();
    await page.locator('#calendar_feed_copy_button').click();
    await expect(page.locator('#calendar_feed_copy_button')).toHaveText('✓ Copied');
    await expect(page.locator('#calendar_feed_copy_button')).toHaveClass(/events_feed_copied/);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    expect(url.replace(/^https?:/, 'webcal:')).toBe(await subscribe.getAttribute('href'));
  });

  test.describe('with scripts off', () => {
    test.use({ javaScriptEnabled: false });

    test('the menu still shows the URL', async ({ page }) => {
      await loginAs(page, 'trooper1');
      await page.goto('/calendar_feed.php');
      await page.locator('#calendar_feed_create').click();

      await page.locator('#calendar_feed_menu_toggle').click();
      await page.locator('#calendar_feed_show_url').click();
      await expect(page.locator('#calendar_feed_url')).toBeVisible();
      // Copying needs a script; without one the URL is text to select.
      await expect(page.locator('#calendar_feed_copy_button')).toBeHidden();
    });
  });

  test('refuses every bad token with the same answer', async ({ page, request }) => {
    await loginAs(page, 'trooper1');
    const url = await makeFeedLink(page);
    const token = new URL(url).searchParams.get('token')!;

    // One character off, the wrong length, missing, and not a token at all.
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    const probes = [
      `/ical_feed.php?token=${flipped}`,
      `/ical_feed.php?token=${token.slice(0, -1)}`,
      `/ical_feed.php?token=${token}x`,
      '/ical_feed.php',
      `/ical_feed.php?token=${encodeURIComponent("' OR '1'='1")}`,
    ];

    const answers = [];
    for (const probe of probes) {
      const { status, body } = await fetchFeed(request, probe);
      answers.push({ status, body });
    }
    expect(answers).toEqual(probes.map(() => ({ status: 404, body: 'Not found.' })));
  });

  test('a reset kills the old link, and turning it off kills the new one', async ({ page, request }) => {
    const eventId = await createEvent({ title: 'Feed Reset Troop' });
    await createRsvp(eventId, 'trooper1');

    await loginAs(page, 'trooper1');
    const first = await makeFeedLink(page);

    page.once('dialog', (dialog) => dialog.accept());
    const second = await makeFeedLink(page);
    expect(second).not.toBe(first);

    expect((await fetchFeed(request, first)).status).toBe(404);
    expect((await fetchFeed(request, second)).status).toBe(200);

    await page.goto('/calendar_feed.php');
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#calendar_feed_revoke').click();
    await expect(page.locator('#calendar_feed_create')).toBeVisible();

    expect((await fetchFeed(request, second)).status).toBe(404);
  });

  test('will not change the link without the form\'s post key', async ({ page }) => {
    await loginAs(page, 'trooper1');
    await makeFeedLink(page);
    await page.goto('/calendar_feed.php');
    const key = await page.locator('#calendar_feed_revoke').locator('xpath=..').locator('input[name="my_post_key"]').inputValue();
    const hash = async () => (await queryOne(`SELECT token_hash FROM ${T('event_plugin_feed_tokens')}`))?.token_hash;
    const before = await hash();

    // Sent as a same-origin submit would be: verify_post_check() refuses anything else
    // outright, so without the header this would pass whether the key was checked or not.
    const post = (action: string, my_post_key: string) =>
      page.request.post('/calendar_feed.php', {
        form: { feed_action: action, my_post_key },
        headers: { 'Sec-Fetch-Site': 'same-origin' },
      });

    // A forged cross-site POST carries the member's cookie but not their post key.
    await post('create', 'forged');
    await post('revoke', 'forged');
    expect(await hash()).toBe(before);

    // The same request with the real key does go through, so the refusal above was the key.
    await post('create', key);
    expect(await hash()).not.toBe(before);
  });

  test('answers nothing for a banned member', async ({ page, request }) => {
    const eventId = await createEvent({ title: 'Feed Banned Troop' });
    await createRsvp(eventId, 'trooper1');

    await loginAs(page, 'trooper1');
    const url = await makeFeedLink(page);

    const { usergroup } = (await queryOne(`SELECT usergroup FROM ${T('users')} WHERE uid = ?`, [uid('trooper1')]))!;
    // 7 is MyBB's own Banned group.
    await execute(`UPDATE ${T('users')} SET usergroup = 7 WHERE uid = ?`, [uid('trooper1')]);
    try {
      expect((await fetchFeed(request, url)).status).toBe(404);
    } finally {
      await execute(`UPDATE ${T('users')} SET usergroup = ? WHERE uid = ?`, [usergroup, uid('trooper1')]);
    }

    expect((await fetchFeed(request, url)).status).toBe(200);
  });

  test('answers nothing for a member whose groups cannot view the board', async ({ page, request }) => {
    const eventId = await createEvent({ title: 'Feed Inactive Troop' });
    await createRsvp(eventId, 'trooper1');

    await loginAs(page, 'trooper1');
    const url = await makeFeedLink(page);

    const before = (await queryOne(`SELECT usergroup, additionalgroups FROM ${T('users')} WHERE uid = ?`, [
      uid('trooper1'),
    ]))!;
    // An "Inactive"-style group: not banned, just not allowed to view the board. The
    // usergroups cache is what permissions are read from, so it is rebuilt both ways.
    const gid = Number(
      await runPhp(`
$db->insert_query('usergroups', array('title' => 'E2E Inactive', 'description' => '', 'namestyle' => '{username}', 'usertitle' => '', 'image' => '', 'disporder' => 0, 'canview' => 0));
echo $db->insert_id();
$cache->update_usergroups();
`),
    );
    try {
      await execute(`UPDATE ${T('users')} SET usergroup = ?, additionalgroups = '' WHERE uid = ?`, [gid, uid('trooper1')]);
      expect((await fetchFeed(request, url)).status).toBe(404);

      // Any one of their groups granting it is enough, as it is for a page view.
      await execute(`UPDATE ${T('users')} SET additionalgroups = '2' WHERE uid = ?`, [uid('trooper1')]);
      expect((await fetchFeed(request, url)).status).toBe(200);
    } finally {
      await execute(`UPDATE ${T('users')} SET usergroup = ?, additionalgroups = ? WHERE uid = ?`, [
        before.usergroup,
        before.additionalgroups,
        uid('trooper1'),
      ]);
      await runPhp(`
$db->delete_query('usergroups', 'gid = ${gid}');
$cache->update_usergroups();
`);
    }

    expect((await fetchFeed(request, url)).status).toBe(200);
  });

  test('records when a calendar last fetched it', async ({ page, request }) => {
    await loginAs(page, 'trooper1');
    const url = await makeFeedLink(page);

    await page.goto('/calendar_feed.php');
    await expect(page.locator('#calendar_feed_last_used')).toHaveText('not yet');

    await fetchFeed(request, url);
    await page.goto('/calendar_feed.php');
    await expect(page.locator('#calendar_feed_last_used')).not.toHaveText('not yet');
  });

  test.describe('in the User CP', () => {
    /** The page sits beside the theme's nav column, not under it or instead of it. */
    async function expectBesideNav(page: Page) {
      const nav = await page.locator('#usercp_nav_events_calendar').boundingBox();
      const content = await page.locator('#calendar_feed_page').boundingBox();
      expect(nav && content).toBeTruthy();
      expect(content!.x).toBeGreaterThanOrEqual(nav!.x + nav!.width);
    }

    /** Run a test as trooper1 with a different theme, putting their own back afterwards. */
    async function withTheme(tid: number, run: () => Promise<void>) {
      const { style } = (await queryOne(`SELECT style FROM ${T('users')} WHERE uid = ?`, [uid('trooper1')]))!;
      await execute(`UPDATE ${T('users')} SET style = ? WHERE uid = ?`, [tid, uid('trooper1')]);
      try {
        await run();
      } finally {
        await execute(`UPDATE ${T('users')} SET style = ? WHERE uid = ?`, [style, uid('trooper1')]);
      }
    }

    test('is in the nav, styled like the items around it', async ({ page }) => {
      await loginAs(page, 'trooper1');
      await page.goto('/usercp.php');

      const item = page.locator('#usercp_nav_events_calendar');
      const neighbour = page.locator('a[href="usercp.php?action=forumsubscriptions"]');
      await expect(item).toHaveText('Calendar Subscription');
      await expect(item).toHaveAttribute('class', (await neighbour.getAttribute('class'))!);
      // The garrison's items each carry a Font Awesome glyph; this one gets a calendar.
      await expect(item.locator('i')).toHaveClass(/fa-calendar-days/);
    });

    test('makes a working link without leaving the User CP', async ({ page, request }) => {
      const eventId = await createEvent({ title: 'Feed From User CP Troop' });
      await createRsvp(eventId, 'trooper1');

      await loginAs(page, 'trooper1');
      await page.goto('/usercp.php');
      await page.locator('#usercp_nav_events_calendar').click();
      await expect(page).toHaveURL(/usercp\.php\?action=events_calendar$/);
      await expectBesideNav(page);

      await page.locator('#calendar_feed_create').click();
      await expect(page).toHaveURL(/usercp\.php$/);
      const url = (await page.locator('#calendar_feed_url').textContent())!.trim();
      await expectBesideNav(page);
      expect((await fetchFeed(request, url)).body).toContain('Feed From User CP Troop');

      // The two pages manage the same link.
      await page.goto('/calendar_feed.php');
      await expect(page.locator('#calendar_feed_status')).toBeVisible();

      await page.goto('/usercp.php?action=events_calendar');
      page.once('dialog', (dialog) => dialog.accept());
      await page.locator('#calendar_feed_revoke').click();
      await expect(page.locator('#calendar_feed_create')).toBeVisible();
      await expect(page).toHaveURL(/usercp\.php\?action=events_calendar$/);
      expect((await fetchFeed(request, url)).status).toBe(404);
    });

    test('fits MyBB\'s own table layout too', async ({ page }) => {
      // The Default theme keeps MyBB's markup: nav items are table rows, and the page is
      // the cell beside the nav's. Nothing in the plugin names either theme's markup.
      await withTheme(2, async () => {
        await loginAs(page, 'trooper1');
        await page.goto('/usercp.php');

        const item = page.locator('#usercp_nav_events_calendar');
        await expect(item).toHaveText('Calendar Subscription');
        await expect(page.locator('tr:has(> td > #usercp_nav_events_calendar)')).toHaveCount(1);

        await item.click();
        await expect(page.locator('#calendar_feed_create')).toBeVisible();
        await expectBesideNav(page);
      });
    });
  });
});
