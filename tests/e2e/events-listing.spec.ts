import { test, expect } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import { createEvent, createRsvp, fixtures } from '../helpers/db';
import { relativeToTestNow, setClock } from '../helpers/clock';

const TK = fixtures().costumeOptions[0];

test.describe('events listing', () => {
  test('lists live events with their region, start and RSVP count', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Listed Troop',
      region: 'Canberra',
      start: '2026-10-20 10:00:00',
      end: '2026-10-20 16:00:00',
    });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });
    await createRsvp(eventId, 'trooper2', { costumes: [TK] });

    await loginAs(page, 'gec');
    await page.goto('/events.php');

    const row = page.locator(`tr.event_row[data-event-id="${eventId}"]`);
    await expect(row.locator('.event_region')).toHaveText('Canberra');
    await expect(row.locator('.event_start')).toHaveText('Oct 20 - 10AM');
    await expect(row.locator('.event_rsvp_count')).toHaveText('2');
    await expect(row.locator('.event_status')).toHaveText('live');
  });

  test('says so when there is nothing on', async ({ page }) => {
    await loginAs(page, 'trooper1');
    await page.goto('/events.php');
    await expect(page.locator('#events_empty')).toContainText('There are no events to show');
  });

  test('filters by region', async ({ page }) => {
    const sydney = await createEvent({ title: 'Sydney Troop', region: 'Sydney' });
    const hunter = await createEvent({ title: 'Hunter Troop', region: 'Hunter' });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php');
    await expect(page.locator('tr.event_row')).toHaveCount(2);

    await page.locator('#events_region_filter').selectOption('Hunter');
    await page.locator('input[value="Filter"]').click();

    await expect(page.locator(`tr[data-event-id="${hunter}"]`)).toBeVisible();
    await expect(page.locator(`tr[data-event-id="${sydney}"]`)).toHaveCount(0);
    await expect(page.locator('#events_region_filter')).toHaveValue('Hunter');
  });

  test('marks the events the viewer is signed up to', async ({ page }) => {
    const attending = await createEvent({ title: 'Attending Troop' });
    const notAttending = await createEvent({ title: 'Other Troop' });
    await createRsvp(attending, 'trooper1', { costumes: [TK] });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php');

    await expect(page.locator(`tr[data-event-id="${attending}"] .event_trooping`)).toHaveText('Trooping');
    await expect(page.locator(`tr[data-event-id="${notAttending}"] .event_signup_link`)).toBeVisible();
  });

  test('shows pending events to coordinators only', async ({ page }) => {
    const pending = await createEvent({ title: 'Pending Troop', status: 'pending' });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php');
    await expect(page.locator(`tr[data-event-id="${pending}"]`)).toHaveCount(0);

    await loginAs(page, 'gec');
    await page.goto('/events.php');
    await expect(page.locator(`tr[data-event-id="${pending}"] .event_status`)).toHaveText('pending');
  });

  test('an address is a map link on both views, and absent when the event has none', async ({ page }) => {
    const withAddress = await createEvent({
      title: 'Address Troop',
      address: '1 Showground Rd, Sydney Olympic Park NSW 2127',
      start: '2026-10-20 10:00:00',
      end: '2026-10-20 16:00:00',
    });
    const without = await createEvent({ title: 'Addressless Troop' });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php');

    const link = page.locator(`tr[data-event-id="${withAddress}"] .event_address_link`);
    await expect(link).toHaveText('1 Showground Rd, Sydney Olympic Park NSW 2127');
    // A search rather than a pin: the address is typed, so there is nothing to point at.
    await expect(link).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=1%20Showground%20Rd%2C%20Sydney%20Olympic%20Park%20NSW%202127',
    );
    // The map opens beside the board rather than over it - a member reading the listing
    // has not finished with it.
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(page.locator(`tr[data-event-id="${without}"] .event_address_link`)).toHaveCount(0);

    await page.goto('/events.php?view=calendar');
    const cell = page.locator('td[data-date="2026-10-20"]');
    await expect(cell.locator('.calendar_event_address')).toHaveText(
      '1 Showground Rd, Sydney Olympic Park NSW 2127',
    );
    await expect(cell.locator('.calendar_event_address')).toHaveAttribute('target', '_blank');
  });

  test('the calendar view places events on their dates and spans multi-day events', async ({ page }) => {
    const single = await createEvent({
      title: 'Calendar Troop',
      start: '2026-10-20 10:00:00',
      end: '2026-10-20 16:00:00',
    });
    const spanning = await createEvent({
      title: 'Long Troop',
      start: '2026-10-24 10:00:00',
      end: '2026-10-26 16:00:00',
    });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php?view=calendar');

    await expect(page.locator('td[data-date="2026-10-20"] .calendar_event')).toHaveText('Calendar Troop');
    for (const date of ['2026-10-24', '2026-10-25', '2026-10-26']) {
      await expect(page.locator(`td[data-date="${date}"] .calendar_event[data-event-id="${spanning}"]`)).toBeVisible();
    }
    await expect(page.locator(`td[data-date="2026-10-27"] .calendar_event[data-event-id="${spanning}"]`)).toHaveCount(0);
    expect(single).toBeGreaterThan(0);
  });

  test('the calendar highlights events the viewer has RSVPed to and can be paged', async ({ page }) => {
    const eventId = await createEvent({
      title: 'November Troop',
      start: '2026-11-07 10:00:00',
      end: '2026-11-07 16:00:00',
    });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php?view=calendar');

    // October by default: the November event is not on this page.
    await expect(page.locator(`.calendar_event[data-event-id="${eventId}"]`)).toHaveCount(0);

    await page.locator('#events_calendar_next').click();
    await expect(page.locator(`.calendar_event[data-event-id="${eventId}"]`)).toHaveClass(/rsvped/);
  });

  test('the calendar opens on the month the clock is in', async ({ page }) => {
    await setClock('2027-02-10 09:00:00');
    const eventId = await createEvent({
      title: 'February Troop',
      start: '2027-02-14 10:00:00',
      end: '2027-02-14 16:00:00',
    });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php?view=calendar');

    await expect(page.locator(`td[data-date="2027-02-14"] .calendar_event[data-event-id="${eventId}"]`)).toBeVisible();
  });

  test('the toolbar offers the view you are not looking at, and carries the filter across', async ({ page }) => {
    await createEvent({ title: 'Hunter Troop', region: 'Hunter' });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php?region=Hunter');

    await expect(page.locator('#events_view_calendar')).toHaveValue('Calendar');
    await expect(page.locator('#events_view_list')).toHaveCount(0);

    await page.locator('#events_view_calendar').click();

    await expect(page.locator('#events_calendar')).toBeVisible();
    await expect(page.locator('#events_region_filter')).toHaveValue('Hunter');
    await expect(page.locator('#events_view_list')).toHaveValue('List');
    await expect(page.locator('#events_view_calendar')).toHaveCount(0);

    await page.locator('#events_view_list').click();

    await expect(page.locator('#events_calendar')).toHaveCount(0);
    await expect(page.locator('#events_region_filter')).toHaveValue('Hunter');
  });

  test('opens in the view the member last used, per account', async ({ page }) => {
    await loginAs(page, 'trooper1');
    await page.goto('/events.php');
    await page.locator('#events_view_calendar').click();
    await expect(page.locator('#events_calendar')).toBeVisible();

    // A bare events.php - the navigation link, a bookmark - comes back to the calendar.
    await page.goto('/events.php');
    await expect(page.locator('#events_calendar')).toBeVisible();

    // Another member's preference is their own.
    await loginAs(page, 'trooper2');
    await page.goto('/events.php');
    await expect(page.locator('#events_calendar')).toHaveCount(0);

    await loginAs(page, 'trooper1');
    await page.goto('/events.php');
    await page.locator('#events_view_list').click();
    await page.goto('/events.php');
    await expect(page.locator('#events_calendar')).toHaveCount(0);
    await expect(page.locator('#events_view_calendar')).toBeVisible();
  });

  test('links from the list through to the event page', async ({ page }) => {
    const eventId = await createEvent({ title: 'Clickable Troop', start: relativeToTestNow({ days: 9 }) });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php');
    await page.locator(`tr[data-event-id="${eventId}"] .event_link`).click();

    await expect(page).toHaveTitle(/^Clickable Troop - /);
    await expect(page.locator('#event_page')).toHaveAttribute('data-event-id', String(eventId));
  });
});
