import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, loginToAdminCp, gotoEventsAdmin } from '../helpers/auth';
import {
	createEvent,
	createRsvp,
	createThreadWithPost,
	countRsvps,
	getRsvpCostumes,
	getSetting,
	fixtures,
} from '../helpers/db';
import { withSettings } from '../helpers/settings';

/**
 * A board taking preapproved costumes can point at a post setting out how a member gets
 * one. Anybody signing up in a preapproved costume is shown that post on the costumes
 * step and has to tick that they followed it - every time, since nothing about the
 * agreement is stored.
 */

const [TK] = [0].map((index) => fixtures().costumeOptions[index]);
const PREAPPROVED = 'Clone Trooper Phase 2';
const REQUIREMENTS = '[b]Email the GML[/b] with photos of the costume.';

async function postRequirements(): Promise<{ tid: number; pid: number }> {
	return createThreadWithPost('Preapproval Steps', fixtures().forums.general, 'gec', REQUIREMENTS);
}

async function openCostumesStep(page: Page, eventId: number): Promise<void> {
	await loginAs(page, 'trooper1');
	await page.goto(`/rsvp.php?id=${eventId}`);
	await page.locator('#rsvp_submit').click();
	await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
}

test.describe('preapproval requirements', () => {
	let restoreSettings: () => Promise<void>;

	test.beforeEach(async () => {
		const { pid } = await postRequirements();
		restoreSettings = await withSettings({
			events_preapproval_enabled: '1',
			events_preapproval_post: String(pid),
		});
	});

	test.afterEach(async () => {
		await restoreSettings();
	});

	test('shows the post and will not go on until the member agrees to it', async ({ page }) => {
		const eventId = await createEvent({ title: 'Preapproval Terms Troop' });
		await openCostumesStep(page, eventId);

		await expect(page.locator('#costume_preapproval_requirements')).toBeHidden();
		await page.locator('#costume_preapproval_text').fill(PREAPPROVED);
		await expect(page.locator('#costume_preapproval_requirements')).toBeVisible();
		// Rendered as the post would be, BBCode and all.
		await expect(page.locator('#costume_preapproval_terms')).toContainText(
			'Email the GML with photos of the costume.'
		);
		await expect(page.locator('#costume_preapproval_terms')).not.toContainText('[b]');
		await expect(page.locator('#costume_preapproval_terms')).toContainText('Preapproval Steps');

		await page.locator('#rsvp_submit').click();
		await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
		await expect(page.locator('#rsvp_errors')).toContainText(
			'Please confirm you have followed the preapproval steps'
		);
		// What was typed survives the round trip; the agreement is asked for again.
		await expect(page.locator('#costume_preapproval_text')).toHaveValue(PREAPPROVED);
		await expect(page.locator('#costume_preapproval_agree')).not.toBeChecked();

		await page.locator('#costume_preapproval_agree').check();
		await page.locator('#rsvp_submit').click();
		await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
		await page.locator('#rsvp_submit').click();
		await expect(page.locator('#rsvp_success_message')).toBeVisible();

		expect(await getRsvpCostumes(eventId, 'trooper1')).toEqual([`Preapproval: ${PREAPPROVED}`]);
	});

	test('asks nothing of a member trooping only in a costume on file', async ({ page }) => {
		const eventId = await createEvent({ title: 'No Preapproval Used Troop' });
		await openCostumesStep(page, eventId);

		await page.locator(`input.costume_checkbox[value="${TK}"]`).check();
		await page.locator('#rsvp_submit').click();
		await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
		await page.locator('#rsvp_submit').click();
		await expect(page.locator('#rsvp_success_message')).toBeVisible();
	});

	test('asks again when a preapproved signup is edited', async ({ page }) => {
		const eventId = await createEvent({ title: 'Edit Preapproval Terms Troop' });
		await createRsvp(eventId, 'trooper1', { costumes: [`Preapproval: ${PREAPPROVED}`] });
		await openCostumesStep(page, eventId);

		await expect(page.locator('#costume_preapproval_requirements')).toBeVisible();
		await expect(page.locator('#costume_preapproval_agree')).not.toBeChecked();
		await page.locator('#rsvp_submit').click();
		await expect(page.locator('#rsvp_errors')).toContainText(
			'Please confirm you have followed the preapproval steps'
		);
	});

	test('refuses a confirm posted without the agreement', async ({ page }) => {
		const eventId = await createEvent({ title: 'Forged Preapproval Troop' });
		await openCostumesStep(page, eventId);

		await page.locator('#costume_preapproval_text').fill(PREAPPROVED);
		await page.locator('#costume_preapproval_agree').check();
		await page.locator('#rsvp_submit').click();
		await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');

		await page
			.locator('#rsvp_form input[name="costume_preapproval_agree"]')
			.evaluate((input) => input.remove());
		await page.locator('#rsvp_submit').click();

		await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
		await expect(page.locator('#rsvp_errors')).toContainText(
			'Please confirm you have followed the preapproval steps'
		);
		expect(await countRsvps(eventId)).toBe(0);
	});

	test('is not asked for when the board names no post', async ({ page }) => {
		await restoreSettings();
		restoreSettings = await withSettings({
			events_preapproval_enabled: '1',
			events_preapproval_post: '',
		});
		const eventId = await createEvent({ title: 'No Terms Preapproval Troop' });
		await openCostumesStep(page, eventId);

		await expect(page.locator('#costume_preapproval_requirements')).toHaveCount(0);
		await page.locator('#costume_preapproval_text').fill(PREAPPROVED);
		await page.locator('#rsvp_submit').click();
		await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
	});

	test.describe('with the script off', () => {
		test.use({ javaScriptEnabled: false });

		test('the post is always shown and the agreement still required', async ({ page }) => {
			const eventId = await createEvent({ title: 'Scriptless Preapproval Terms Troop' });
			await openCostumesStep(page, eventId);

			await expect(page.locator('#costume_preapproval_requirements')).toBeVisible();
			await page.locator('#costume_preapproval').check();
			await page.locator('#costume_preapproval_text').fill(PREAPPROVED);
			await page.locator('#rsvp_submit').click();
			await expect(page.locator('#rsvp_errors')).toContainText(
				'Please confirm you have followed the preapproval steps'
			);

			await page.locator('#costume_preapproval_agree').check();
			await page.locator('#rsvp_submit').click();
			await page.locator('#rsvp_submit').click();
			await expect(page.locator('#rsvp_success_message')).toBeVisible();
		});
	});
});

test.describe('preapproval requirements setting', () => {
	let restore: (() => Promise<void>) | undefined;

	test.afterEach(async () => {
		await restore?.();
		restore = undefined;
	});

	async function gotoSettings(page: Page): Promise<void> {
		await loginToAdminCp(page);
		await gotoEventsAdmin(page, '&action=settings');
	}

	test('appears with preapprovals turned on and takes a link to the post', async ({ page }) => {
		restore = await withSettings({
			events_preapproval_enabled: '0',
			events_preapproval_post: await getSetting('events_preapproval_post'),
		});
		const { tid, pid } = await postRequirements();

		await gotoSettings(page);
		await expect(page.locator('#row_preapproval_post')).toBeHidden();
		await page.locator('#preapproval_enabled_yes').check();
		await expect(page.locator('#row_preapproval_post')).toBeVisible();

		await page
			.locator('#preapproval_post')
			.fill(`http://localhost/showthread.php?tid=${tid}&pid=${pid}#pid${pid}`);
		await page.locator('input[type="submit"][value="Save Settings"]').click();
		await expect(page.locator('#flash_message')).toContainText('Settings updated successfully');
		expect(await getSetting('events_preapproval_post')).toBe(String(pid));
		await expect(page.locator('#preapproval_post')).toHaveValue(
			new RegExp(`pid=${pid}#pid${pid}$`)
		);

		await page.locator('#preapproval_post').fill('');
		await page.locator('input[type="submit"][value="Save Settings"]').click();
		await expect(page.locator('#flash_message')).toContainText('Settings updated successfully');
		expect(await getSetting('events_preapproval_post')).toBe('');
	});

	test('refuses something that is not a post on the board', async ({ page }) => {
		restore = await withSettings({
			events_preapproval_enabled: '1',
			events_preapproval_post: await getSetting('events_preapproval_post'),
		});

		await gotoSettings(page);
		await page.locator('#preapproval_post').fill('https://example.com/rules');
		await page.locator('input[type="submit"][value="Save Settings"]').click();
		await expect(page.locator('.error')).toContainText(
			'Preapproval Requirements must be a link to a post'
		);
		await expect(page.locator('#preapproval_post')).toHaveValue('https://example.com/rules');
	});
});
