import { test, expect } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import { createEvent, createRsvp, execute, getEventDays, query, queryOne, T, uid } from '../helpers/db';
import type { APIRequestContext, Page } from '@playwright/test';

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
  const url = await page.locator('#calendar_feed_url').inputValue();
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

test.describe('calendar subscription feed', () => {
  test('carries every event the member signed up for, and nothing else', async ({ page, request }) => {
    const going = await createEvent({ title: 'Feed Going Troop', start: '2026-10-20 10:00:00', end: '2026-10-20 16:00:00' });
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
    expect(body).toContain('SUMMARY:Feed Going Troop');
    expect(body).toContain('SUMMARY:Feed Wrangle Troop');
    expect(body).toContain("DESCRIPTION:You're wrangling at this event.");
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
        form: { action, my_post_key },
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

  test('records when a calendar last fetched it', async ({ page, request }) => {
    await loginAs(page, 'trooper1');
    const url = await makeFeedLink(page);

    await page.goto('/calendar_feed.php');
    await expect(page.locator('#calendar_feed_last_used')).toHaveText('not yet');

    await fetchFeed(request, url);
    await page.goto('/calendar_feed.php');
    await expect(page.locator('#calendar_feed_last_used')).not.toHaveText('not yet');
  });

  test('is reachable from the events toolbar', async ({ page }) => {
    await loginAs(page, 'trooper1');
    await page.goto('/events.php');
    await page.locator('#events_calendar_feed').click();
    await expect(page).toHaveURL(/calendar_feed\.php$/);
    await expect(page.locator('#calendar_feed_create')).toBeVisible();
  });
});
