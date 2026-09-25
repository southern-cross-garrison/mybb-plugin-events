import { test, expect } from '../helpers/fixtures';
import { loginAs, logout } from '../helpers/auth';
import { createEvent, createRsvp, execute, fixtures, getEventDays, T } from '../helpers/db';
import type { Page } from '@playwright/test';

const TK = fixtures().costumeOptions[0];
const SECOND_COSTUME = fixtures().costumeOptions[1];

/**
 * The feed with its long lines unfolded. RFC 5545 folds a line at 75 octets by breaking
 * it and opening the continuation with a space, so a long DESCRIPTION arrives in pieces.
 */
async function fetchCalendar(page: Page, eventId: number): Promise<string> {
  const body = await (await page.request.get(`/ical.php?id=${eventId}`)).text();
  return body.replace(/\r\n[ \t]/g, '');
}

/** Each VEVENT's SUMMARY, keyed by DTSTART. */
function summariesByStart(body: string): Record<string, string> {
  const summaries: Record<string, string> = {};
  for (const block of body.split('BEGIN:VEVENT').slice(1)) {
    const start = block.match(/^DTSTART:(.*)$/m)?.[1] ?? '';
    summaries[start] = (block.match(/^SUMMARY:(.*)$/m)?.[1] ?? '').trim();
  }
  return summaries;
}

/** The first line of each VEVENT's DESCRIPTION - the one saying what the member is doing - keyed by DTSTART. */
function signupLinesByStart(body: string): Record<string, string> {
  const lines: Record<string, string> = {};
  for (const block of body.split('BEGIN:VEVENT').slice(1)) {
    const start = block.match(/^DTSTART:(.*)$/m)?.[1] ?? '';
    const description = (block.match(/^DESCRIPTION:(.*)$/m)?.[1] ?? '').trim();
    lines[start] = description.split(String.raw`\n`)[0];
  }
  return lines;
}

const WEEKEND = {
  start: '2026-10-17 09:00:00',
  end: '2026-10-18 17:00:00',
  days: [
    { date: '2026-10-17', start: '09:00:00', end: '17:00:00' },
    { date: '2026-10-18', start: '10:00:00', end: '16:00:00' },
  ],
};

test.describe('iCal export', () => {
  test('serves a downloadable calendar for a single-day event', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Calendar Export Troop',
      description: 'Bring water.',
      region: 'Hunter',
      start: '2026-10-20 10:00:00',
      end: '2026-10-20 16:00:00',
    });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await loginAs(page, 'trooper1');
    const response = await page.request.get(`/ical.php?id=${eventId}`);

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/calendar');
    expect(response.headers()['content-disposition']).toContain(`event-${eventId}.ics`);

    const body = await response.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('END:VCALENDAR');
    expect(body).toContain('SUMMARY:Trooping: Calendar Export Troop');
    expect(body).toContain('LOCATION:Hunter');
    expect(body).toContain('DTSTART:20261020T100000Z');
    expect(body).toContain('DTEND:20261020T160000Z');
    expect(body).toContain(`URL:http://localhost:8080/event.php?id=${eventId}`);
  });

  test('exports the address as the location, and the region when there is none', async ({ page }) => {
    // LOCATION is what a calendar app's maps button reads, so the address wins where the
    // event has one. The test above covers the other half: an addressless event still
    // exports its region rather than nothing at all.
    const eventId = await createEvent({
      title: 'Located Export Troop',
      region: 'Hunter',
      address: '1 Showground Rd, Sydney Olympic Park NSW 2127',
    });

    await loginAs(page, 'trooper1');
    const body = await (await page.request.get(`/ical.php?id=${eventId}`)).text();

    // Commas are escaped, because an unescaped one would split the property value.
    expect(body).toContain(String.raw`LOCATION:1 Showground Rd\, Sydney Olympic Park NSW 2127`);
    expect(body).not.toContain('LOCATION:Hunter');
  });

  test('emits one VEVENT per configured day', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Weekend Export Troop',
      start: '2026-10-17 09:00:00',
      end: '2026-10-18 17:00:00',
      days: [
        { date: '2026-10-17', start: '09:00:00', end: '17:00:00' },
        { date: '2026-10-18', start: '10:00:00', end: '16:00:00' },
      ],
    });

    await loginAs(page, 'trooper1');
    const body = await (await page.request.get(`/ical.php?id=${eventId}`)).text();

    expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(body).toContain('DTSTART:20261017T090000Z');
    expect(body).toContain('DTSTART:20261018T100000Z');
    expect(body).toContain('DTEND:20261018T160000Z');
  });

  test('ends a day that runs to midnight or overnight on the following date', async ({ page }) => {
    // A day stores only its times; an end at or before the start is the next morning.
    const eventId = await createEvent({
      title: 'Late Night Export Troop',
      start: '2026-10-17 18:00:00',
      end: '2026-10-19 02:00:00',
      days: [
        { date: '2026-10-17', start: '18:00:00', end: '00:00:00' },
        { date: '2026-10-18', start: '20:00:00', end: '02:00:00' },
      ],
    });

    await loginAs(page, 'trooper1');
    const body = await fetchCalendar(page, eventId);

    expect(body).toContain('DTSTART:20261017T180000Z');
    expect(body).toContain('DTEND:20261018T000000Z');
    expect(body).toContain('DTSTART:20261018T200000Z');
    expect(body).toContain('DTEND:20261019T020000Z');
  });

  test('ends a single-day event that runs past midnight on the following date', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Overnight Export Troop',
      start: '2026-10-20 20:00:00',
      end: '2026-10-21 01:00:00',
    });

    await loginAs(page, 'trooper1');
    const body = await fetchCalendar(page, eventId);

    expect(body).toContain('DTSTART:20261020T200000Z');
    expect(body).toContain('DTEND:20261021T010000Z');
  });

  test('keeps each entry\'s UID when the event\'s days are recreated', async ({ page }) => {
    // A calendar app matches a re-import by UID; one that changes leaves a duplicate.
    const eventId = await createEvent({ title: 'Stable Weekend Troop', ...WEEKEND });

    await loginAs(page, 'trooper1');
    const uids = async () => (await fetchCalendar(page, eventId)).match(/^UID:.*$/gm);
    const before = await uids();
    expect(before).toEqual([
      expect.stringMatching(new RegExp(`^UID:event-${eventId}@`)),
      expect.stringMatching(new RegExp(`^UID:event-${eventId}-20261018@`)),
    ]);

    // New rows, new ids, same days.
    await execute(`DELETE FROM ${T('event_plugin_event_days')} WHERE event_id = ?`, [eventId]);
    for (const day of WEEKEND.days) {
      await execute(
        `INSERT INTO ${T('event_plugin_event_days')} (event_id, date, start_time, end_time) VALUES (?, ?, ?, ?)`,
        [eventId, day.date, day.start, day.end],
      );
    }
    expect(await uids()).toEqual(before);

    // Back to a single day: no rows at all, and the entry that is left is still the first.
    await execute(`DELETE FROM ${T('event_plugin_event_days')} WHERE event_id = ?`, [eventId]);
    expect(await uids()).toEqual([before![0]]);
  });

  test('escapes characters that would corrupt the feed', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Troop; with, punctuation',
      description: 'Line one\nLine two',
      start: '2026-10-20 10:00:00',
      end: '2026-10-20 16:00:00',
    });

    await loginAs(page, 'trooper1');
    const body = await (await page.request.get(`/ical.php?id=${eventId}`)).text();

    expect(body).toContain(String.raw`SUMMARY:Troop\; with\, punctuation`);
    expect(body).toContain(String.raw`\n\nLine one\nLine two`);
  });

  test('flattens the description\'s BBCode', async ({ page }) => {
    // DESCRIPTION is a text property: a calendar app shows whatever is in it verbatim,
    // so the markup a description is written in has to come out rather than travel.
    const eventId = await createEvent({
      title: 'Marked Up Export Troop',
      description: '[b]Full armour[/b] and a [url=http://example.test/kit]kit list[/url].',
      start: '2026-10-20 10:00:00',
      end: '2026-10-20 16:00:00',
    });

    await loginAs(page, 'trooper1');
    const body = await fetchCalendar(page, eventId);

    expect(body).toContain(String.raw`\n\nFull armour and a kit list (http://example.test/kit).`);
    expect(body).not.toContain('[b]');
  });

  test('keeps a "<" in the description that is not a tag', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Angle Bracket Export Troop',
      description: 'Kids <12 free, adults > 12 pay.',
      start: '2026-10-20 10:00:00',
      end: '2026-10-20 16:00:00',
    });

    await loginAs(page, 'trooper1');
    const body = await fetchCalendar(page, eventId);

    expect(body).toContain(String.raw`\n\nKids <12 free\, adults > 12 pay.`);
  });

  test('exports only the days the member signed up for, and says what they are doing', async ({ page }) => {
    const eventId = await createEvent({ title: 'Signed Up Weekend Troop', ...WEEKEND });
    const [, sunday] = (await getEventDays(eventId)).map((day) => Number(day.id));
    await createRsvp(eventId, 'trooper1', { costumes: [TK, SECOND_COSTUME], dayIds: [sunday] });

    await loginAs(page, 'trooper1');
    const body = await fetchCalendar(page, eventId);

    expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(body).not.toContain('DTSTART:20261017T090000Z');
    expect(body).toContain(`UID:event-${eventId}-20261018@`);
    expect(body).not.toContain(`UID:event-${eventId}@`);
    // The comma between costumes is escaped like any other in a text property.
    expect(signupLinesByStart(body)['20261018T100000Z']).toBe(
      `You're trooping (${TK}\\, ${SECOND_COSTUME}) this day.`,
    );
  });

  test('gives a day held in both roles one entry that names both', async ({ page }) => {
    const eventId = await createEvent({ title: 'Two Role Weekend Troop', ...WEEKEND });
    const [saturday, sunday] = (await getEventDays(eventId)).map((day) => Number(day.id));
    await createRsvp(eventId, 'trooper1', { costumes: [TK], dayIds: [saturday, sunday] });
    await createRsvp(eventId, 'trooper1', { role: 'wrangler', dayIds: [sunday] });

    await loginAs(page, 'trooper1');
    const body = await fetchCalendar(page, eventId);
    const lines = signupLinesByStart(body);

    expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(lines['20261017T090000Z']).toBe(`You're trooping (${TK}) this day.`);
    expect(lines['20261018T100000Z']).toBe(`You're trooping (${TK}) and wrangling this day.`);
    // The title leads with the roles held that day, not across the whole signup.
    expect(summariesByStart(body)).toEqual({
      '20261017T090000Z': 'Trooping: Two Role Weekend Troop',
      '20261018T100000Z': 'Trooping and Wrangling: Two Role Weekend Troop',
    });
  });

  test('describes a single-day signup as the whole event', async ({ page }) => {
    // A single-day event has no day rows, so its signups point at none.
    const eventId = await createEvent({
      title: 'Single Day Wrangle',
      start: '2026-10-20 10:00:00',
      end: '2026-10-20 16:00:00',
    });
    await createRsvp(eventId, 'trooper1', { role: 'wrangler' });

    await loginAs(page, 'trooper1');
    const body = await fetchCalendar(page, eventId);

    expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(body).toContain("DESCRIPTION:You're wrangling at this event.");
    expect(body).toContain('SUMMARY:Wrangling: Single Day Wrangle');
  });

  test('exports every day to a member who has not signed up, and says so', async ({ page }) => {
    const eventId = await createEvent({ title: 'Undecided Weekend Troop', ...WEEKEND });

    await loginAs(page, 'trooper1');
    const body = await fetchCalendar(page, eventId);
    expect(Object.values(signupLinesByStart(body))).toEqual([
      "You haven't signed up for this event yet.",
      "You haven't signed up for this event yet.",
    ]);
    // No role to lead with, so the title is left as it is.
    expect(Object.values(summariesByStart(body))).toEqual(['Undecided Weekend Troop', 'Undecided Weekend Troop']);
  });

  test('carries the WWCC requirement, the address and the full description', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Detailed Export Troop',
      description: 'Meet at the loading dock. '.repeat(6).trim(),
      address: '1 Showground Rd, Sydney Olympic Park NSW 2127',
      requiresWwcc: true,
      start: '2026-10-20 10:00:00',
      end: '2026-10-20 16:00:00',
    });

    await loginAs(page, 'trooper1');
    const raw = await (await page.request.get(`/ical.php?id=${eventId}`)).text();
    const body = raw.replace(/\r\n[ \t]/g, '');

    expect(body).toContain(
      "DESCRIPTION:You haven't signed up for this event yet.\\n" +
        'A Working With Children Check is required.\\n' +
        'Address: 1 Showground Rd\\, Sydney Olympic Park NSW 2127\\n' +
        'Map: https://www.google.com/maps/search/?api=1&query=1%20Showground%20Rd%2C%20Sydney%20Olympic%20Park%20NSW%202127\\n\\n' +
        'Meet at the loading dock. '.repeat(6).trim(),
    );

    // That description is well past 75 octets, so it must have arrived folded.
    for (const line of raw.split('\r\n')) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    }
  });

  test('leaves the WWCC line out when the event does not need one', async ({ page }) => {
    const eventId = await createEvent({ title: 'No Check Export Troop' });

    await loginAs(page, 'trooper1');
    const body = await fetchCalendar(page, eventId);

    expect(body).not.toContain('Working With Children');
  });

  test('links the address to a map, and leaves the link out when there is no address', async ({ page }) => {
    // The search URL does the lookup when it is opened, so no coordinates are needed.
    const located = await createEvent({ title: 'Mapped Export Troop', address: "O'Connell St & Pitt St, Sydney" });
    const unlocated = await createEvent({ title: 'Unmapped Export Troop' });

    await loginAs(page, 'trooper1');
    expect(await fetchCalendar(page, located)).toContain(
      String.raw`\nMap: https://www.google.com/maps/search/?api=1&query=O%27Connell%20St%20%26%20Pitt%20St%2C%20Sydney`,
    );
    expect(await fetchCalendar(page, unlocated)).not.toContain('Map:');
  });

  test('is not available to guests', async ({ page }) => {
    const eventId = await createEvent({ title: 'Private Export Troop' });

    await logout(page);
    const response = await page.request.get(`/ical.php?id=${eventId}`);
    expect(response.headers()['content-type']).not.toContain('text/calendar');
  });

  test('will not export a pending event to an ordinary member', async ({ page }) => {
    const eventId = await createEvent({ title: 'Pending Export Troop', status: 'pending' });

    await loginAs(page, 'trooper1');
    const response = await page.request.get(`/ical.php?id=${eventId}`);
    expect(response.headers()['content-type']).not.toContain('text/calendar');
  });
});
