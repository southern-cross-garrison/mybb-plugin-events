import { test, expect, Page } from '../helpers/fixtures';
import { loginAs, loginToAdminCp, gotoEventsAdmin } from '../helpers/auth';
import { setClock } from '../helpers/clock';
import { lockReasonOnEventPage } from '../helpers/rsvp';
import {
	countPrivateMessages,
	createEvent,
	createRsvp,
	getEventDays,
	getSetting,
	fixtures,
	query,
	T,
} from '../helpers/db';
import { setSettings, withSettings } from '../helpers/settings';
import { runScheduledTask } from '../helpers/container';
import { fillDescription } from '../helpers/editor';

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
			`${ZONE} (UTC+${String(OFFSET_HOURS).padStart(2, '0')}:00)`
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

		// timeformat is pinned to H:i (and dateformat to Y-m-d) by provisioning.
		await expect(page.locator('#event_start')).toHaveText('Monday, Oct 5 at 18:00');
		await expect(page.locator('#event_end')).toHaveText('Monday, Oct 5 at 21:30');
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
 * A day's hours are a clock time on that day, not an instant. They used to be read with
 * strtotime(), which put them on *today's* date in the event zone - so an event saved on
 * the morning Sydney springs forward had its 02:30 start silently moved to 03:30, since
 * 02:30 does not exist that day. The event itself is weeks later, when it does.
 */
test.describe('day hours saved on a daylight-saving change', () => {
	test.afterEach(async () => {
		await setSettings({ events_timezone: 'UTC' });
	});

	test('keeps the time that was typed', async ({ page }) => {
		await setSettings({ events_timezone: 'Australia/Sydney' });
		// 09:00 on 4 October in Sydney, the day its clocks went from 02:00 to 03:00.
		await setClock('2026-10-03 22:00:00');

		await loginAs(page, 'gec');
		await page.goto('/manage_event.php');
		await page.locator('#event_form_title').fill('Early Start Troop');
		await page.locator('#event_form_status').selectOption('live');
		await page.locator('#event_form_start_date').fill('2026-10-24');
		await page.locator('#event_form_start_date_time').fill('02:30');
		await page.locator('#event_form_end_date').fill('2026-10-25');
		await page.locator('#event_form_end_date_time').fill('17:00');

		const row = page.locator('[data-events-day-date="2026-10-24"] input[type="time"]');
		await row.nth(0).fill('02:30');
		await row.nth(1).fill('06:00');
		await page.locator('#manage_event_submit').click();
		await expect(page.locator('#event_page')).toContainText('Early Start Troop');

		const [event] = (await query(
			`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Early Start Troop'`
		)) as any[];
		const days = await getEventDays(event.id);
		expect(days[0].start_time).toBe('02:30:00');
		expect(days[0].end_time).toBe('06:00:00');

		// And shown back as stored, which went through the same conversion.
		await page.goto(`/manage_event.php?id=${event.id}`);
		await expect(row.nth(0)).toHaveValue('02:30');
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

/*
 * ---------------------------------------------------------------------------------------
 * Across a daylight-saving change.
 *
 * Every expected instant below was worked out independently of the plugin, with
 * Intl.DateTimeFormat over the IANA database (node, timeZone: 'Australia/Sydney'):
 *
 *   2026-10-03T15:59:00Z -> 04/10/2026 01:59 GMT+10   (the last minute of AEST)
 *   2026-10-03T16:00:00Z -> 04/10/2026 03:00 GMT+11   (02:00 local never happens)
 *
 * So Sydney springs forward at 02:00 on Sunday 4 October 2026: the Saturday is on +10
 * and every day from the Sunday on is on +11, and the Sunday is 23 hours long. That is
 * the day a loop stepping 86400 seconds gets wrong - from a Saturday wall clock after
 * 23:00 it jumps straight to Monday, and in April, when the day is 25 hours, it repeats
 * one - and it is where anything reading a stored wall clock with a fixed offset, or with
 * the offset of "now" rather than of the date itself, is an hour out on one side.
 * ---------------------------------------------------------------------------------------
 */
const SYDNEY = 'Australia/Sydney';

/** The three days of the long weekend, as the day grid and the event page should name them. */
const DST_WEEKEND = [
	{ date: '2026-10-03', label: 'Sat 3 Oct 2026' },
	{ date: '2026-10-04', label: 'Sun 4 Oct 2026' },
	{ date: '2026-10-05', label: 'Mon 5 Oct 2026' },
];

/**
 * 09:00 and 17:00 on each of those days as UTC instants. Sat is +10, Sun and Mon +11 -
 * so the start moves from 23:00Z the day before to 22:00Z the day before, an hour
 * earlier by the UTC clock for the same 09:00 on the wall.
 */
const DST_WEEKEND_UTC = [
	{ start: '20261002T230000Z', end: '20261003T070000Z' },
	{ start: '20261003T220000Z', end: '20261004T060000Z' },
	{ start: '20261004T220000Z', end: '20261005T060000Z' },
];

/** A 'YYYY-MM-DD HH:MM:SS' fixture split across a date box and its time box. */
async function fillDateTimePair(
	page: Page,
	dateSelector: string,
	timeSelector: string,
	value: string
) {
	const [date, time] = value.split(' ');
	await page.locator(dateSelector).fill(date);
	await page.locator(timeSelector).fill(time.slice(0, 5));
}

/** Every VEVENT's DTSTART/DTEND pair, from a folded or unfolded body. */
function veventTimes(body: string): Array<{ start: string; end: string }> {
	const unfolded = body.replace(/\r\n[ \t]/g, '');
	return unfolded
		.split('BEGIN:VEVENT')
		.slice(1)
		.map((block) => ({
			start: block.match(/^DTSTART[^:\r\n]*:(.*)$/m)?.[1]?.trim() ?? '',
			end: block.match(/^DTEND[^:\r\n]*:(.*)$/m)?.[1]?.trim() ?? '',
		}));
}

test.describe(`an event across the ${SYDNEY} daylight-saving change`, () => {
	// The browser is parked in Sydney too. The day grid's script holds its dates as UTC
	// midnights precisely so that it does not care what zone the browser is in; with the
	// browser in the zone that has the change, a script that had slipped back into local
	// Date arithmetic would repeat or drop the Sunday here rather than on somebody's
	// coordinator's laptop.
	test.use({ timezoneId: SYDNEY });

	let restoreTimezone: (() => Promise<void>) | undefined;

	test.beforeEach(async () => {
		restoreTimezone = await withSettings({ events_timezone: SYDNEY });
	});

	test.afterEach(async () => {
		await restoreTimezone?.();
		restoreTimezone = undefined;
	});

	test('the front-end form offers exactly the three days, and saves and shows them', async ({
		page,
	}) => {
		await loginAs(page, 'gec');
		await page.goto('/manage_event.php');
		await page.locator('#event_form_title').fill('Spring Forward Weekend');
		await page.locator('#event_form_status').selectOption('live');
		await fillDateTimePair(
			page,
			'#event_form_start_date',
			'#event_form_start_date_time',
			'2026-10-03 09:00:00'
		);
		await fillDateTimePair(
			page,
			'#event_form_end_date',
			'#event_form_end_date_time',
			'2026-10-05 17:00:00'
		);

		// The grid the script draws: one row per date, in order, none repeated or skipped.
		const rows = page.locator('#event_form_days [data-events-day-date]');
		await expect(rows).toHaveCount(3);
		expect(
			await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-events-day-date')))
		).toEqual(DST_WEEKEND.map((day) => day.date));
		await expect(rows.locator('.events_day_date')).toHaveText(DST_WEEKEND.map((day) => day.label));

		for (const day of DST_WEEKEND) {
			const times = page.locator(`[data-events-day-date="${day.date}"] input[type="time"]`);
			await times.nth(0).fill('09:00');
			await times.nth(1).fill('17:00');
		}
		await page.locator('#manage_event_submit').click();

		// The event page names each day with the hours it was given - 09:00 to 17:00 on the
		// wall, on both sides of the change, not 08:00 or 10:00 on one of them.
		await expect(page.locator('#event_days li.event_day')).toHaveText(
			DST_WEEKEND.map((day) => `${day.label} (09:00 - 17:00)`)
		);

		const [event] = (await query(
			`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Spring Forward Weekend'`
		)) as any[];
		const days = await getEventDays(event.id);
		expect(days.map((day: any) => [String(day.date), day.start_time, day.end_time])).toEqual(
			DST_WEEKEND.map((day) => [day.date, '09:00:00', '17:00:00'])
		);

		// Re-opened, the grid comes from PHP (events_event_day_span()) rather than the script,
		// and it has to agree with it.
		await page.goto(`/manage_event.php?id=${event.id}`);
		await expect(rows).toHaveCount(3);
		expect(
			await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-events-day-date')))
		).toEqual(DST_WEEKEND.map((day) => day.date));
		await expect(page.locator('#event_form_day_2_start')).toHaveValue('09:00');

		// Each day's entry is 09:00-17:00 in Sydney under the offset in force *that* day.
		const body = await (await page.request.get(`/ical.php?id=${event.id}`)).text();
		expect(veventTimes(body)).toEqual(DST_WEEKEND_UTC);

		// And the month calendar puts the event on each of the three dates and no others.
		await page.goto('/events.php?view=calendar&month=2026-10');
		for (const date of ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']) {
			const expected = DST_WEEKEND.some((day) => day.date === date) ? 1 : 0;
			await expect(
				page.locator(`td[data-date="${date}"] .calendar_event[data-event-id="${event.id}"]`),
				`calendar cell ${date}`
			).toHaveCount(expected);
		}
	});

	test('the Admin CP form offers and saves the same three days', async ({ page }) => {
		await loginToAdminCp(page);
		await gotoEventsAdmin(page, '&action=add');

		await page.locator('input[name="title"]').fill('Admin Spring Forward Weekend');
		await fillDescription(page, 'description', 'Across the change.');
		await page.locator('select[name="status"]').selectOption('live');
		await fillDateTimePair(
			page,
			'input[name="start_date"]',
			'input[name="start_date_time"]',
			'2026-10-03 09:00:00'
		);
		await fillDateTimePair(
			page,
			'input[name="end_date"]',
			'input[name="end_date_time"]',
			'2026-10-05 17:00:00'
		);

		const rows = page.locator('[data-events-day-grid] [data-events-day-date]');
		await expect(rows).toHaveCount(3);
		expect(
			await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-events-day-date')))
		).toEqual(DST_WEEKEND.map((day) => day.date));

		for (const day of DST_WEEKEND) {
			const times = page.locator(`[data-events-day-date="${day.date}"] input[type="time"]`);
			await times.nth(0).fill('09:00');
			await times.nth(1).fill('17:00');
		}
		await page.locator('input[type="submit"][value="Create Event"]').click();
		await expect(page.locator('#flash_message')).toContainText('Event created successfully');

		const [event] = (await query(
			`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Admin Spring Forward Weekend'`
		)) as any[];
		const days = await getEventDays(event.id);
		expect(days.map((day: any) => [String(day.date), day.start_time, day.end_time])).toEqual(
			DST_WEEKEND.map((day) => [day.date, '09:00:00', '17:00:00'])
		);
	});

	test('exports an overnight day that runs through the change as seven hours, not eight', async ({
		page,
	}) => {
		// A day stores only its times, and one that ends at or before it starts ends on the
		// next date (events_ical_vevents() steps it '+1 day' on the wall clock). Saturday
		// 20:00 to Sunday 04:00 in Sydney crosses 02:00 -> 03:00, so it is seven real hours:
		//   Sat 20:00 AEST (+10) = 2026-10-03 10:00Z
		//   Sun 04:00 AEDT (+11) = 2026-10-03 17:00Z
		// Adding 86400 seconds to "Sat 04:00" instead would land on Sun 05:00 AEDT = 18:00Z.
		// The Sunday night does not cross anything: 20:00 AEDT = 09:00Z, 04:00 AEDT = 17:00Z.
		const eventId = await createEvent({
			title: 'Overnight Spring Forward',
			start: '2026-10-03 20:00:00',
			end: '2026-10-05 04:00:00',
			days: [
				{ date: '2026-10-03', start: '20:00:00', end: '04:00:00' },
				{ date: '2026-10-04', start: '20:00:00', end: '04:00:00' },
			],
		});

		await loginAs(page, 'trooper1');
		const body = await (await page.request.get(`/ical.php?id=${eventId}`)).text();
		expect(veventTimes(body)).toEqual([
			{ start: '20261003T100000Z', end: '20261003T170000Z' },
			{ start: '20261004T090000Z', end: '20261004T170000Z' },
		]);
	});

	test('closes signups at a cutoff under the offset in force on its own day', async ({ page }) => {
		// The clock starts on 1 October, on AEST. The cutoff is midday on the Sunday, after
		// the change, so it is 12:00 AEDT = 01:00Z - an hour earlier than the same wall clock
		// would be on the Saturday. Code applying the offset of "now" (or a fixed +10) would
		// close at 02:00Z.
		const eventId = await createEvent({
			title: 'Spring Forward Cutoff',
			start: '2026-10-05 09:00:00',
			end: '2026-10-05 17:00:00',
			signupCutoff: '2026-10-04 12:00:00',
		});

		await loginAs(page, 'trooper1');
		await page.goto(`/event.php?id=${eventId}`);
		await expect(page.locator('#event_cutoff')).toHaveText('2026-10-04 12:00');

		await setClock('2026-10-04 00:55:00'); // 11:55 AEDT
		expect(await lockReasonOnEventPage(page, eventId)).toBeNull();

		await setClock('2026-10-04 01:05:00'); // 12:05 AEDT
		expect(await lockReasonOnEventPage(page, eventId)).toBe('cutoff_passed');
	});
});

test.describe(`the day grid without JavaScript, across the ${SYDNEY} change`, () => {
	// With the script off, the grid is only ever what PHP drew, so this is the server-side
	// day generation on its own: the Preview button posts the typed dates and the form
	// comes back with the grid events_event_day_span() made from them.
	test.use({ javaScriptEnabled: false, timezoneId: SYDNEY });

	let restoreTimezone: (() => Promise<void>) | undefined;

	test.beforeEach(async () => {
		restoreTimezone = await withSettings({ events_timezone: SYDNEY });
	});

	test.afterEach(async () => {
		await restoreTimezone?.();
		restoreTimezone = undefined;
	});

	test('draws, and saves, exactly the three days', async ({ page }) => {
		await loginAs(page, 'gec');
		await page.goto('/manage_event.php');
		await page.locator('#event_form_title').fill('Scriptless Spring Forward');
		await page.locator('#event_form_status').selectOption('live');
		await page.locator('#event_form_description').fill('Across the change, with no script.');
		await fillDateTimePair(
			page,
			'#event_form_start_date',
			'#event_form_start_date_time',
			'2026-10-03 09:00:00'
		);
		await fillDateTimePair(
			page,
			'#event_form_end_date',
			'#event_form_end_date_time',
			'2026-10-05 17:00:00'
		);
		// Forced, here and on the save below: with scripts off, Playwright never sees the
		// front-end form's buttons as "stable" on this theme and gives up on an ordinary
		// click. They are visible and enabled; force only skips that wait, and it is still a
		// real click on the real submit, posting what the browser would.
		await page.locator('#manage_event_preview').click({ force: true });

		const rows = page.locator('#event_form_days [data-events-day-date]');
		await expect(rows).toHaveCount(3);
		expect(
			await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-events-day-date')))
		).toEqual(DST_WEEKEND.map((day) => day.date));
		await expect(rows.locator('.events_day_date')).toHaveText(DST_WEEKEND.map((day) => day.label));

		for (const day of DST_WEEKEND) {
			const times = page.locator(`[data-events-day-date="${day.date}"] input[type="time"]`);
			await times.nth(0).fill('09:00');
			await times.nth(1).fill('17:00');
		}
		await page.locator('#manage_event_submit').click({ force: true });
		await expect(page.locator('#event_days li.event_day')).toHaveText(
			DST_WEEKEND.map((day) => `${day.label} (09:00 - 17:00)`)
		);

		const [event] = (await query(
			`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Scriptless Spring Forward'`
		)) as any[];
		const days = await getEventDays(event.id);
		expect(days.map((day: any) => String(day.date))).toEqual(DST_WEEKEND.map((day) => day.date));
	});
});

/**
 * The subscription feed, fetched by a calendar server with no session, in a zone that is
 * not UTC. It has no zone of its own to fall back on - it is a guest page - so the event
 * zone has to be applied here as much as in ical.php, and the result has to be absolute
 * instants (Z) or carry a TZID; a bare local time would be read as floating and land
 * wherever the subscriber happens to be.
 */
test.describe(`the calendar subscription feed in ${SYDNEY}`, () => {
	let restoreTimezone: (() => Promise<void>) | undefined;

	test.beforeEach(async () => {
		restoreTimezone = await withSettings({ events_timezone: SYDNEY });
	});

	test.afterEach(async () => {
		await restoreTimezone?.();
		restoreTimezone = undefined;
	});

	test('carries every entry as the right UTC instant, either side of the change', async ({
		page,
		request,
	}) => {
		const weekend = await createEvent({
			title: 'Feed Spring Forward Weekend',
			start: '2026-10-03 09:00:00',
			end: '2026-10-05 17:00:00',
			days: DST_WEEKEND.map((day) => ({ date: day.date, start: '09:00:00', end: '17:00:00' })),
		});
		// A single-day event after the change, which has no day rows and is exported from
		// the event's own start and end: 18:00-21:30 AEDT (+11) = 07:00Z-10:30Z.
		const single = await createEvent({
			title: 'Feed Single Day After Change',
			start: '2026-10-10 18:00:00',
			end: '2026-10-10 21:30:00',
		});
		const dayIds = (await getEventDays(weekend)).map((day) => Number(day.id));
		await createRsvp(weekend, 'trooper1', { costumes: [TK], dayIds });
		await createRsvp(single, 'trooper1', { costumes: [TK] });

		await loginAs(page, 'trooper1');
		await page.goto('/calendar_feed.php');
		await page.locator('#calendar_feed_create, #calendar_feed_reset').click();
		const url = (await page.locator('#calendar_feed_url').textContent())!.trim();
		expect(url).toMatch(/\/ical_feed\.php\?token=/);

		// No cookies: the `request` fixture shares nothing with the signed-in page.
		const response = await request.get(url);
		expect(response.status()).toBe(200);
		const body = await response.text();

		expect(veventTimes(body)).toEqual([
			...DST_WEEKEND_UTC,
			{ start: '20261010T070000Z', end: '20261010T103000Z' },
		]);

		// Every date-time property is an absolute UTC instant. A TZID would also be valid,
		// but then the feed would have to ship a VTIMEZONE too - and it does neither, so a
		// time without the Z would be floating.
		const unfolded = body.replace(/\r\n[ \t]/g, '');
		const dateTimes = unfolded.match(/^(DTSTART|DTEND|DTSTAMP)[^\r\n]*$/gm) ?? [];
		expect(dateTimes.length).toBe(3 * 4);
		for (const line of dateTimes) {
			expect(line).toMatch(/^(DTSTART|DTEND|DTSTAMP):\d{8}T\d{6}Z$/);
		}
	});
});

/**
 * The troop-report reminder decides two things by wall clock in the event zone
 * (events_send_reminders(), events_hooks.php):
 *
 *   - due at all:  e.end_date < events_date('Y-m-d H:i:s')   (both wall clocks in the zone)
 *   - due again:   last_reminder_sent < (today in the zone - 6 days) 00:00:00
 *
 * The task runs from the CLI here and from a page view on a real board, both on a server
 * that is UTC. Anything in there that fell back to date() or NOW() would compare a
 * Sydney wall clock to a UTC one and be a whole offset out - so these park the board as
 * far from UTC as zones go, on both sides of it, and step the clock across the boundary.
 *
 * Offsets, from Intl.DateTimeFormat:
 *   Pacific/Auckland on 10-17 Oct 2026 is NZDT, +13 (NZ sprang forward on 27 Sep 2026:
 *     2026-09-26T13:59Z = 01:59 +12, 2026-09-26T14:00Z = 03:00 +13).
 *   Pacific/Honolulu is -10 all year (no DST).
 */
test.describe('the troop-report reminder in a zone far from UTC', () => {
	const SUBJECT = 'Troop Report Needed:%';

	let restoreTimezone: (() => Promise<void>) | undefined;

	test.afterEach(async () => {
		await restoreTimezone?.();
		restoreTimezone = undefined;
	});

	test('fires once the event has ended in Auckland, though its end time has not come round in UTC', async () => {
		restoreTimezone = await withSettings({ events_timezone: 'Pacific/Auckland' });

		// 17:00 NZDT on 10 October is 04:00Z. From 04:00Z the event is over; but the UTC
		// wall clock then reads 04:xx on the 10th, well short of "17:00" - so a comparison
		// made in UTC would hold the reminder back until 17:00Z, thirteen hours late.
		const eventId = await createEvent({
			title: 'Auckland Finished Troop',
			start: '2026-10-10 09:00:00',
			end: '2026-10-10 17:00:00',
		});
		await createRsvp(eventId, 'trooper1', { costumes: [TK] });

		await setClock('2026-10-10 03:50:00'); // 16:50 NZDT: still running
		await runScheduledTask('events_reminders');
		expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(0);

		await setClock('2026-10-10 04:10:00'); // 17:10 NZDT: finished
		await runScheduledTask('events_reminders');
		expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(1);

		// Stamped with the wall clock in the zone, like every other date the plugin stores.
		const [report] = (await query(
			`SELECT last_reminder_sent FROM ${T('event_plugin_troop_reports')} WHERE event_id = ?`,
			[eventId]
		)) as any[];
		expect(String(report.last_reminder_sent)).toMatch(/^2026-10-10 17:1\d:\d\d$/);
	});

	test('holds off while the event is still on in Honolulu, though UTC has passed its end time', async () => {
		restoreTimezone = await withSettings({ events_timezone: 'Pacific/Honolulu' });

		// 17:00 HST (-10) on 10 October is 03:00Z on the 11th. At 20:00Z on the 10th the UTC
		// wall clock already reads past "2026-10-10 17:00", but it is only 10:00 in Honolulu
		// and the event has not even started its afternoon.
		const eventId = await createEvent({
			title: 'Honolulu Running Troop',
			start: '2026-10-10 09:00:00',
			end: '2026-10-10 17:00:00',
		});
		await createRsvp(eventId, 'trooper1', { costumes: [TK] });

		await setClock('2026-10-10 20:00:00'); // 10:00 HST on the 10th
		await runScheduledTask('events_reminders');
		expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(0);

		await setClock('2026-10-11 02:50:00'); // 16:50 HST
		await runScheduledTask('events_reminders');
		expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(0);

		await setClock('2026-10-11 03:10:00'); // 17:10 HST: finished
		await runScheduledTask('events_reminders');
		expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(1);
	});

	test('counts the week to the next reminder in Auckland calendar days', async () => {
		restoreTimezone = await withSettings({ events_timezone: 'Pacific/Auckland' });

		const eventId = await createEvent({
			title: 'Auckland Weekly Troop',
			start: '2026-10-10 09:00:00',
			end: '2026-10-10 17:00:00',
		});
		await createRsvp(eventId, 'trooper1', { costumes: [TK] });

		// First reminder at 18:00 NZDT on Saturday 10 October (05:00Z).
		await setClock('2026-10-10 05:00:00');
		await runScheduledTask('events_reminders');
		expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(1);

		// The next is due on the seventh calendar day after, in Auckland: Saturday 17 October
		// from 00:00 NZDT, which is 2026-10-16 11:00Z. At 23:50 NZDT on the 16th (10:50Z) it
		// is still the sixth day.
		await setClock('2026-10-16 10:50:00');
		await runScheduledTask('events_reminders');
		expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(1);

		// 00:10 NZDT on the 17th (11:10Z). By the UTC calendar it is still the 16th, so a
		// count taken in UTC would wait another thirteen hours.
		await setClock('2026-10-16 11:10:00');
		await runScheduledTask('events_reminders');
		expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(2);
	});
});
