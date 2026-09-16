import { test, expect } from '../helpers/fixtures';
import { loginAs, logout } from '../helpers/auth';
import { createEvent, createRsvp, fixtures } from '../helpers/db';

const TK = fixtures().costumeOptions[0];

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
    expect(body).toContain('SUMMARY:Calendar Export Troop');
    expect(body).toContain('LOCATION:Hunter');
    expect(body).toContain('DTSTART:20261020T100000Z');
    expect(body).toContain('DTEND:20261020T160000Z');
    expect(body).toContain(`URL:http://localhost:8080/event.php?id=${eventId}`);
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
    expect(body).toContain(String.raw`DESCRIPTION:Line one\nLine two`);
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
