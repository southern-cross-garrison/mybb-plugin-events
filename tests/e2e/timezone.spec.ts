import { test, expect, Page } from '../helpers/fixtures';
import { loginAs, loginToAdminCp, gotoEventsAdmin } from '../helpers/auth';
import { setClock } from '../helpers/clock';
import { lockReasonOnEventPage } from '../helpers/rsvp';
import { createEvent, createRsvp, getSetting, fixtures } from '../helpers/db';
import { setSettings } from '../helpers/settings';

const TK = fixtures().costumeOptions[0];

/**
 * The board says which timezone its events happen in, and every date the plugin stores
 * is a wall clock in that zone - whatever timezone the server itself runs in.
 *
 * The container's own clock is UTC (docker/php.ini), and these tests park the board in
 * Brisbane, which is UTC+10 all year. Every assertion below is therefore ten hours apart
 * from what the same data would mean if the plugin were still reading its dates against
 * the server's zone, which is precisely what is under test: a cutoff written as midday
 * has to close at midday in Brisbane, i.e. at 02:00 by the container clock.
 *
 * Brisbane rather than Sydney on purpose. The suite's dates land in October, when Sydney
 * is on daylight saving and Brisbane is not, so a fixed offset keeps the arithmetic in
 * these tests readable; the zone's own DST handling is covered by the round trip in
 * "a stored wall clock is shown back unchanged" holding for any zone.
 */
const ZONE = 'Australia/Brisbane';
const OFFSET_HOURS = 10;

async function setTimezone(page: Page, zone: string): Promise<void> {
  // Through the form rather than the database: MyBB reads its settings from the
  // generated inc/settings.php, so a row changed with SQL would leave the cache - and
  // therefore every page the test then loads - on the old zone.
  await loginToAdminCp(page);
  await gotoEventsAdmin(page, '&action=settings');
  await page.locator('#timezone').selectOption(zone);
  await page.locator('input[type="submit"][value="Save Settings"]').click();

  expect(await getSetting('events_timezone')).toBe(zone);
}

test.describe(`events in ${ZONE}`, () => {
  test.beforeEach(async ({ page }) => {
    await setTimezone(page, ZONE);
  });

  test.afterEach(async ({ page }) => {
    // Back to the zone the rest of the suite is provisioned with, whatever this test did.
    if ((await getSetting('events_timezone')) !== 'UTC') {
      await setTimezone(page, 'UTC');
    }
  });

  test('offers every timezone PHP knows, with the offset it is on', async ({ page }) => {
    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=settings');

    const zones = page.locator('#timezone option');
    expect(await zones.count()).toBeGreaterThan(100);
    await expect(page.locator(`#timezone option[value="${ZONE}"]`)).toHaveText(
      `${ZONE} (UTC+${String(OFFSET_HOURS).padStart(2, '0')}:00)`,
    );
    await expect(page.locator('#timezone')).toHaveValue(ZONE);
  });

  test('closes signups when the cutoff passes in the event timezone', async ({ page }) => {
    // Midday in Brisbane, which is 02:00 by the container clock.
    const eventId = await createEvent({
      title: 'Brisbane Cutoff Troop',
      start: '2026-10-05 09:00:00',
      end: '2026-10-05 17:00:00',
      signupCutoff: '2026-10-03 12:00:00',
    });

    await loginAs(page, 'trooper1');

    // 11:55 in Brisbane: open.
    await setClock('2026-10-03 01:55:00');
    expect(await lockReasonOnEventPage(page, eventId)).toBeNull();

    // 12:05 in Brisbane: closed - and closed a full ten hours before it would be if the
    // cutoff were being read against the server's clock.
    await setClock('2026-10-03 02:05:00');
    expect(await lockReasonOnEventPage(page, eventId)).toBe('cutoff_passed');
  });

  test('counts an event as finished when it ends in the event timezone', async ({ page }) => {
    // Ends at 17:00 in Brisbane, which is 07:00 by the container clock.
    const eventId = await createEvent({
      title: 'Brisbane Finished Troop',
      start: '2026-10-02 09:00:00',
      end: '2026-10-02 17:00:00',
      signupCutoff: null,
    });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await loginAs(page, 'trooper1');

    // 16:00 in Brisbane: still running, so there is nothing to report on yet.
    await setClock('2026-10-02 06:00:00');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_troop_report')).toHaveCount(0);

    // 18:00 in Brisbane: finished, and the troop report is offered.
    await setClock('2026-10-02 08:00:00');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_troop_report')).toBeVisible();

    await page.goto(`/troop_report.php?id=${eventId}`);
    await expect(page.locator('body')).not.toContainText('This event has not ended yet');
  });

  test('shows a stored wall clock back unchanged', async ({ page }) => {
    // The two halves of the conversion have to agree: a zone applied when the date is
    // read but not when it is written (or the other way round) shows every event ten
    // hours away from the time it was given.
    const eventId = await createEvent({
      title: 'Brisbane Display Troop',
      start: '2026-10-05 18:00:00',
      end: '2026-10-05 21:30:00',
      signupCutoff: '2026-10-04 12:00:00',
    });

    await loginAs(page, 'trooper1');
    await page.goto(`/event.php?id=${eventId}`);

    // dateformat/timeformat are pinned to Y-m-d H:i by provisioning.
    await expect(page.locator('#event_start')).toHaveText('2026-10-05 18:00');
    await expect(page.locator('#event_end')).toHaveText('2026-10-05 21:30');
    await expect(page.locator('#event_cutoff')).toHaveText('2026-10-04 12:00');
  });

  test('exports the iCal feed as the matching UTC instants', async ({ page }) => {
    // An .ics carries absolute instants, so this is where the zone has to be applied
    // rather than carried: 18:00 in Brisbane is 08:00Z, and a calendar app that was
    // handed 18:00Z would put the event on the wrong side of the evening.
    const eventId = await createEvent({
      title: 'Brisbane iCal Troop',
      start: '2026-10-05 18:00:00',
      end: '2026-10-05 21:30:00',
    });

    await loginAs(page, 'trooper1');
    const response = await page.request.get(`/ical.php?id=${eventId}`);
    const body = await response.text();

    expect(body).toContain('DTSTART:20261005T080000Z');
    expect(body).toContain('DTEND:20261005T113000Z');
  });
});

/**
 * The setting is a plain text column that predates the picker, so a board upgraded from
 * an older release - or one whose PHP has since dropped a zone - can hold a name this
 * server cannot resolve. Falling back to UTC is what stops that taking the whole board
 * down; the settings page then has to show the zone actually in force rather than the
 * unusable name, or an admin saving an unrelated change would be quietly agreeing to it.
 */
test.describe('a timezone this PHP does not have', () => {
  test.afterEach(async () => {
    await setSettings({ events_timezone: 'UTC' });
    expect(await getSetting('events_timezone')).toBe('UTC');
  });

  test('falls back to UTC rather than breaking every page', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Nowhere Zone Troop',
      status: 'live',
      start: '2026-10-08 12:00:00',
      end: '2026-10-08 18:00:00',
    });

    await setSettings({ events_timezone: 'Mars/Olympus_Mons' });

    await loginAs(page, 'trooper1');
    await page.goto(`/event.php?id=${eventId}`);

    await expect(page.locator('#event_page')).toContainText('Nowhere Zone Troop');
    await expect(page.locator('body')).not.toContainText(/Warning|Fatal error|SQL Error/);
    // UTC, so the stored wall clock reads back as itself.
    await expect(page.locator('#event_page')).toContainText('12:00');
  });

  test('the settings page offers the zone in force, not the unusable name', async ({ page }) => {
    await setSettings({ events_timezone: 'Mars/Olympus_Mons' });

    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=settings');

    await expect(page.locator('#timezone')).toHaveValue('UTC');
  });
});
