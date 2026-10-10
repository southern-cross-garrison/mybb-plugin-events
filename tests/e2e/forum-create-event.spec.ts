import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import { execute, fixtures, queryOne, T, uid } from '../helpers/db';
import { withSettings } from '../helpers/settings';

/**
 * In a forum events are announced in, a coordinator's Post Thread button becomes a Create
 * Event split button, with Post Thread moved onto its dropdown. The button is rebuilt from
 * the theme's own, so it is checked on the garrison's theme and on MyBB's Default, and the
 * dropdown arrow is a plain link to Post Thread underneath, so it is checked with the
 * script off as well.
 */

const FORUMS = fixtures().forums;

const splitButton = (page: Page) => page.locator('.events_forum_split').first();
const createButton = (page: Page) => splitButton(page).locator('.events_forum_split_main');
const toggle = (page: Page) => splitButton(page).locator('.events_forum_split_toggle');
const menu = (page: Page) => splitButton(page).locator('.events_forum_split_menu');

/**
 * The halves read as one control: flush against each other, with square corners where they
 * meet. The garrison's theme rounds every .btn with !important, which is what this catches.
 */
async function expectJoined(page: Page) {
	const main = (await createButton(page).boundingBox())!;
	const arrow = (await toggle(page).boundingBox())!;
	expect(Math.abs(arrow.x - (main.x + main.width))).toBeLessThanOrEqual(1);
	await expect(createButton(page)).toHaveCSS('border-top-right-radius', '0px');
	await expect(createButton(page)).toHaveCSS('border-bottom-right-radius', '0px');
	await expect(toggle(page)).toHaveCSS('border-top-left-radius', '0px');
	await expect(toggle(page)).toHaveCSS('border-bottom-left-radius', '0px');
}

/** Run a test as the coordinator with a different theme, putting their own back afterwards. */
async function withTheme(tid: number, run: () => Promise<void>) {
	const { style } = (await queryOne(`SELECT style FROM ${T('users')} WHERE uid = ?`, [uid('gec')]))!;
	await execute(`UPDATE ${T('users')} SET style = ? WHERE uid = ?`, [tid, uid('gec')]);
	try {
		await run();
	} finally {
		await execute(`UPDATE ${T('users')} SET style = ? WHERE uid = ?`, [style, uid('gec')]);
	}
}

test.describe('Create Event button in event forums', () => {
	test("opens the event form on the forum's own region", async ({ page }) => {
		await loginAs(page, 'gec');
		await page.goto(`/forumdisplay.php?fid=${FORUMS.events_hunter}`);

		await expect(createButton(page)).toHaveText(/^\s*Create Event\s*$/);
		await expect(createButton(page)).toHaveAttribute('href', 'manage_event.php?region=Hunter');
		// The theme's own button, so it keeps the theme's look and icon.
		await expect(createButton(page)).toHaveClass(/\bbtn\b/);
		await expect(createButton(page).locator('i.fa-pencil')).toHaveCount(1);
		await expectJoined(page);
		await expect(page.locator('a[href^="newthread.php"]:not(.events_forum_split_toggle):visible')).toHaveCount(0);

		await createButton(page).click();
		await expect(page).toHaveURL(/manage_event\.php\?region=Hunter$/);
		await expect(page.locator('#event_form_region')).toHaveValue('Hunter');
	});

	test('keeps Post Thread on the dropdown', async ({ page }) => {
		await loginAs(page, 'gec');
		await page.goto(`/forumdisplay.php?fid=${FORUMS.events_hunter}`);

		await expect(menu(page)).toBeHidden();
		await toggle(page).click();
		await expect(page).toHaveURL(new RegExp(`forumdisplay\\.php\\?fid=${FORUMS.events_hunter}$`));
		await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
		const postThread = menu(page).getByRole('link', { name: 'Post Thread' });
		await expect(postThread).toBeVisible();

		// Anywhere else closes it, and so does Escape.
		await page.locator('body').click({ position: { x: 5, y: 5 } });
		await expect(menu(page)).toBeHidden();
		await toggle(page).click();
		await page.keyboard.press('Escape');
		await expect(menu(page)).toBeHidden();
		await expect(toggle(page)).toBeFocused();

		await toggle(page).click();
		await postThread.click();
		await expect(page).toHaveURL(new RegExp(`newthread\\.php\\?fid=${FORUMS.events_hunter}$`));
	});

	test('leaves the region to the form in a forum several regions share', async ({ page }) => {
		// Sydney, Canberra and Other all fall back to the default events forum.
		await loginAs(page, 'gec');
		await page.goto(`/forumdisplay.php?fid=${FORUMS.events}`);

		await expect(createButton(page)).toHaveAttribute('href', 'manage_event.php');
	});

	test('appears in the events forum of a board with no regions', async ({ page }) => {
		const restore = await withSettings({ events_regions: '', events_event_forums: '' });
		try {
			await loginAs(page, 'gec');
			await page.goto(`/forumdisplay.php?fid=${FORUMS.events}`);
			await expect(createButton(page)).toHaveAttribute('href', 'manage_event.php');

			await page.goto(`/forumdisplay.php?fid=${FORUMS.events_hunter}`);
			await expect(page.locator('.events_forum_split')).toHaveCount(0);
		} finally {
			await restore();
		}
	});

	test('leaves Post Thread alone everywhere else', async ({ page }) => {
		await loginAs(page, 'gec');

		// Events are not created into the archive, only moved there.
		for (const fid of [FORUMS.general, FORUMS.events_archive]) {
			await page.goto(`/forumdisplay.php?fid=${fid}`);
			await expect(page.locator(`a[href="newthread.php?fid=${fid}"]`).first()).toBeVisible();
			await expect(page.locator('.events_forum_split')).toHaveCount(0);
		}
	});

	test('is not offered to members who cannot create events', async ({ page }) => {
		await loginAs(page, 'trooper1');
		await page.goto(`/forumdisplay.php?fid=${FORUMS.events_hunter}`);

		await expect(page.locator(`a[href="newthread.php?fid=${FORUMS.events_hunter}"]`).first()).toBeVisible();
		await expect(page.locator('.events_forum_split')).toHaveCount(0);
	});

	test("works on MyBB's Default theme", async ({ page }) => {
		// Default draws the button as a.button with a sprite, and prints it above and below
		// the thread list.
		await withTheme(2, async () => {
			await loginAs(page, 'gec');
			await page.goto(`/forumdisplay.php?fid=${FORUMS.events_hunter}`);

			await expect(createButton(page)).toHaveClass(/\bbutton\b/);
			await expect(createButton(page)).toHaveText(/^\s*Create Event\s*$/);

			await expectJoined(page);

			const copies = page.locator('.events_forum_split');
			const last = copies.last();
			await last.locator('.events_forum_split_toggle').click();
			await expect(last.locator('.events_forum_split_menu')).toBeVisible();
			await expect(copies.first().locator('.events_forum_split_menu')).toBeHidden();
		});
	});
});

test.describe('Create Event button without JavaScript', () => {
	test.use({ javaScriptEnabled: false });

	test('its arrow goes straight to Post Thread', async ({ page }) => {
		await loginAs(page, 'gec');
		await page.goto(`/forumdisplay.php?fid=${FORUMS.events_hunter}`);

		await expect(createButton(page)).toHaveAttribute('href', 'manage_event.php?region=Hunter');
		await toggle(page).click();
		await expect(page).toHaveURL(new RegExp(`newthread\\.php\\?fid=${FORUMS.events_hunter}$`));
	});
});
