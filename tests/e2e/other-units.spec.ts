import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, loginToAdminCp, gotoEventsAdmin } from '../helpers/auth';
import { createEvent, getEvent, getThreadFirstPost, query, T } from '../helpers/db';
import { runPhp } from '../helpers/container';
import { relativeToTestNow } from '../helpers/clock';
import { signUpThroughWizard } from '../helpers/rsvp';
import { clearRegionUnits, setRegionUnits } from '../helpers/units';

/**
 * Events cross-posted from another garrison: a region the settings hand to another unit
 * files events that members sign up to as usual, but every one of them says this is not
 * the real signup sheet and links to the one that is.
 *
 * The settings page that hands a region over is covered in regions.spec.ts, beside the
 * renames and deletions it has to keep in step with. Here the unit is a precondition.
 */

const UNIT = 'Star Garrison';
const SHEET = 'https://star.example/forum/showthread.php?tid=12&pid=40';

/** Announce an event the way saving it live does, and return its thread id. */
async function announce(eventId: number): Promise<number> {
	const output = await runPhp(`
require_once MYBB_ROOT.'inc/plugins/events/inc/events_thread.php';
echo events_sync_event_thread(${eventId});
`);
	return Number(output.trim());
}

async function box(page: Page, selector: string) {
	const found = await page.locator(selector).boundingBox();
	expect(found, `${selector} has no box`).not.toBeNull();
	return found!;
}

async function fillFrontEndForm(page: Page, region: string, signupSheet?: string): Promise<void> {
	await page.locator('#event_form_title').fill('Border Troop');
	await page.locator('#event_form_status').selectOption('live');
	await page.locator('#event_form_region').selectOption(region);
	const [date, time] = relativeToTestNow({ days: 14 }).split(' ');
	const [endDate, endTime] = relativeToTestNow({ days: 14, hours: 4 }).split(' ');
	await page.locator('#event_form_start_date').fill(date);
	await page.locator('#event_form_start_date_time').fill(time.slice(0, 5));
	await page.locator('#event_form_end_date').fill(endDate);
	await page.locator('#event_form_end_date_time').fill(endTime.slice(0, 5));
	if (signupSheet !== undefined) {
		await page.locator('#event_form_signup_url').fill(signupSheet);
	}
}

test.describe('events run by another unit', () => {
	test.beforeEach(async () => {
		await setRegionUnits({ Hunter: { unit: UNIT, logo: 'png' } });
	});

	test.afterEach(async () => {
		await clearRegionUnits();
	});

	test('the card says whose event it is, links their signup sheet and carries their logo', async ({
		page,
	}) => {
		const eventId = await createEvent({
			title: 'Border Show',
			region: 'Hunter',
			externalSignupUrl: SHEET,
		});
		await loginAs(page, 'trooper1');
		await page.goto(`/event.php?id=${eventId}`);

		const notice = page.locator('#event_unit_notice');
		await expect(notice).toContainText(`This event is run by ${UNIT}`);
		await expect(notice.locator('a.events_unit_signup_link')).toHaveAttribute('href', SHEET);

		// The logo is served, not just referenced.
		const logo = page.locator('#event_unit_logo');
		await expect(logo).toHaveAttribute('alt', UNIT);
		await expect
			.poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth))
			.toBeGreaterThan(0);

		// Top right, under the turnout tab.
		const tab = await box(page, '#event_signup_counts');
		const placed = await box(page, '#event_unit_logo');
		expect(placed.y).toBeGreaterThanOrEqual(tab.y + tab.height);
		expect(Math.abs(placed.x + placed.width - (tab.x + tab.width))).toBeLessThan(24);

		// On a phone the tab sits over the details instead, and the logo still clears it.
		await page.setViewportSize({ width: 400, height: 800 });
		const narrowTab = await box(page, '#event_signup_counts');
		const narrowLogo = await box(page, '#event_unit_logo');
		expect(narrowLogo.y).toBeGreaterThanOrEqual(narrowTab.y + narrowTab.height);
		expect(narrowLogo.x + narrowLogo.width).toBeLessThanOrEqual(400);
	});

	test("the garrison's own events say nothing of the sort", async ({ page }) => {
		const eventId = await createEvent({ title: 'Home Show', region: 'Sydney' });
		await loginAs(page, 'trooper1');
		await page.goto(`/event.php?id=${eventId}`);

		await expect(page.locator('#event_page')).toBeVisible();
		await expect(page.locator('#event_unit_notice')).toHaveCount(0);
		await expect(page.locator('#event_unit_logo')).toHaveCount(0);
	});

	test('an event from before the region changed hands still warns, without a link', async ({
		page,
	}) => {
		const eventId = await createEvent({ title: 'Older Show', region: 'Hunter' });
		await loginAs(page, 'trooper1');
		await page.goto(`/event.php?id=${eventId}`);

		await expect(page.locator('#event_unit_notice')).toContainText(
			`This event is run by ${UNIT}. Signing up here doesn't sign you up with them.`
		);
		await expect(page.locator('#event_unit_notice a')).toHaveCount(0);
	});

	test('confirming a signup says it again, and the signup still goes through', async ({ page }) => {
		const eventId = await createEvent({
			title: 'Border Show',
			region: 'Hunter',
			externalSignupUrl: SHEET,
		});
		await loginAs(page, 'trooper1');

		await signUpThroughWizard(page, eventId, {
			role: 'wrangler',
			beforeConfirm: async (confirm) => {
				const notice = confirm.locator('#rsvp_unit_notice');
				await expect(notice).toContainText(UNIT);
				await expect(notice.locator('a')).toHaveAttribute('href', SHEET);
				// A new tab, so following it does not throw away the signup in progress.
				await expect(notice.locator('a')).toHaveAttribute('target', '_blank');
			},
		});

		const signups = await query(
			`SELECT status FROM ${T('event_plugin_rsvps')} WHERE event_id = ?`,
			[eventId]
		);
		expect(signups).toHaveLength(1);
	});

	test('the announcement guests and Tapatalk read carries the warning too', async () => {
		const eventId = await createEvent({
			title: 'Border Show',
			region: 'Hunter',
			externalSignupUrl: SHEET,
		});
		const threadId = await announce(eventId);
		expect(threadId).toBeGreaterThan(0);

		const post = await getThreadFirstPost(threadId);
		expect(post.message).toContain(
			`[b]This event is run by ${UNIT}. Signing up here doesn't sign you up with them: [url=${SHEET}]sign up on their signup sheet[/url] too.[/b]`
		);
		expect(post.message).toContain(`[b]Run by:[/b] ${UNIT}`);
	});

	test('the front-end form asks for the signup sheet only for their regions, and requires it', async ({
		page,
	}) => {
		await loginAs(page, 'gec');
		await page.goto('/manage_event.php?action=add');

		const field = page.locator('#field_event_form_signup_url');
		await page.locator('#event_form_region').selectOption('Sydney');
		await expect(field).toBeHidden();
		await page.locator('#event_form_region').selectOption('Hunter');
		await expect(field).toBeVisible();

		await fillFrontEndForm(page, 'Hunter');
		await page.locator('#manage_event_submit').click();
		await expect(page.locator('.error')).toContainText(
			`Add the link to ${UNIT}'s signup sheet for this event.`
		);

		await page.locator('#event_form_signup_url').fill('ftp://star.example/sheet');
		await page.locator('#manage_event_submit').click();
		await expect(page.locator('.error')).toContainText(
			'must be a web address starting with http:// or https://'
		);

		await page.locator('#event_form_signup_url').fill(SHEET);
		await page.locator('#manage_event_submit').click();
		await expect(page.locator('#event_unit_notice a')).toHaveAttribute('href', SHEET);

		const eventId = Number(await page.locator('#event_page').getAttribute('data-event-id'));
		expect((await getEvent(eventId)).external_signup_url).toBe(SHEET);

		// Moved to one of the garrison's own regions, the link goes: nothing would show it,
		// and it would come back the day that region was handed to another unit.
		await page.goto(`/manage_event.php?id=${eventId}`);
		await page.locator('#event_form_region').selectOption('Sydney');
		await page.locator('#manage_event_submit').click();
		await expect(page.locator('#event_page')).toBeVisible();
		expect((await getEvent(eventId)).external_signup_url).toBe('');

		// And the edit says what it changed. Polled: the save redirects through MyBB's own
		// redirect page.
		await expect
			.poll(async () => {
				const log = await query(
					`SELECT data FROM ${T('adminlog')} WHERE module = 'events' AND action = 'edit_frontend'`
				);
				return log.map((row: any) => String(row.data)).join();
			})
			.toContain('Signup Sheet');
	});

	test('the Admin CP form requires it as well', async ({ page }) => {
		await loginToAdminCp(page);
		await gotoEventsAdmin(page, '&action=add');

		const row = page.locator('#row_external_signup_url');
		await page.locator('select[name="region"]').selectOption('Sydney');
		await expect(row).toBeHidden();
		await page.locator('select[name="region"]').selectOption('Hunter');
		await expect(row).toBeVisible();

		await page.locator('input[name="title"]').fill('Admin Border Troop');
		const [date, time] = relativeToTestNow({ days: 14 }).split(' ');
		const [endDate, endTime] = relativeToTestNow({ days: 14, hours: 4 }).split(' ');
		await page.locator('input[name="start_date"]').fill(date);
		await page.locator('input[name="start_date_time"]').fill(time.slice(0, 5));
		await page.locator('input[name="end_date"]').fill(endDate);
		await page.locator('input[name="end_date_time"]').fill(endTime.slice(0, 5));

		await page.locator('input[type="submit"][value="Create Event"]').click();
		await expect(page.locator('.error')).toContainText(
			`Add the link to ${UNIT}'s signup sheet for this event.`
		);

		await page.locator('#external_signup_url').fill(SHEET);
		await page.locator('input[type="submit"][value="Create Event"]').click();
		await expect(page.locator('#flash_message')).toContainText('Event created successfully');

		const rows = await query(
			`SELECT external_signup_url FROM ${T('event_plugin_events')} WHERE title = ?`,
			['Admin Border Troop']
		);
		expect(rows[0].external_signup_url).toBe(SHEET);
	});
});

test.describe('events run by another unit, without JavaScript', () => {
	test.use({ javaScriptEnabled: false });

	test.beforeEach(async () => {
		await setRegionUnits({ Hunter: { unit: UNIT } });
	});

	test.afterEach(async () => {
		await clearRegionUnits();
	});

	test('the signup sheet box is always there, and ignored for a home region', async ({ page }) => {
		await loginAs(page, 'gec');
		await page.goto('/manage_event.php?action=add');

		await expect(page.locator('#field_event_form_signup_url')).toBeVisible();
		await fillFrontEndForm(page, 'Sydney', SHEET);
		await page.locator('#manage_event_submit').click();

		await expect(page.locator('#event_page')).toBeVisible();
		const eventId = Number(await page.locator('#event_page').getAttribute('data-event-id'));
		expect((await getEvent(eventId)).external_signup_url).toBe('');
	});
});
