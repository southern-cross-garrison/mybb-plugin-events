import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import {
	createEvent,
	createRsvp,
	execute,
	getPrivateMessages,
	getRsvpStatus,
	countRsvps,
	query,
	queryOne,
	T,
	uid,
} from '../helpers/db';

/**
 * A coordinator removing somebody's signup from the card's signup list: the X opens a
 * dialog with a drafted message, sent as a PM, copied, or left unsent - any of which
 * removes the signup - or cancelled, which leaves it. See events_remove_signup.php.
 */

const SUBJECT = 'Removed from: Removal Parade';

const removeLink = (page: Page, username: string) =>
	page.locator(`#rsvp_list a.rsvp_remove[data-uid="${uid(username)}"]`).first();

/** Change a member's receivepms, returning what puts it back. */
async function setReceivePms(username: string, value: number): Promise<() => Promise<void>> {
	const before = await queryOne<any>(`SELECT receivepms FROM ${T('users')} WHERE uid = ?`, [
		uid(username),
	]);
	await execute(`UPDATE ${T('users')} SET receivepms = ? WHERE uid = ?`, [value, uid(username)]);
	return async () => {
		await execute(`UPDATE ${T('users')} SET receivepms = ? WHERE uid = ?`, [
			before.receivepms,
			uid(username),
		]);
	};
}

async function removalLog(): Promise<string[][]> {
	const rows = await query(
		`SELECT data FROM ${T('adminlog')} WHERE module = 'events' AND action = 'remove_signup'`
	);
	return rows.map((row: any) =>
		[...String(row.data).matchAll(/s:\d+:"(.*?)";/g)].map((match) => match[1])
	);
}

/**
 * Post a removal and wait for MyBB's redirect() to land back on the event. The page is
 * on the event already, so the POST is what says the submit happened at all.
 */
async function submitRemoval(
	page: Page,
	eventId: number,
	submit: () => Promise<unknown>
): Promise<void> {
	const posted = page.waitForResponse(
		(response) =>
			response.request().method() === 'POST' && response.url().includes('action=remove_signup')
	);
	await submit();
	await posted;
	await page.waitForURL(
		(url) => url.pathname.endsWith('/event.php') && url.search === `?id=${eventId}`
	);
	await expect(page.locator('#rsvp_list')).toBeVisible();
}

test.describe('removing a signup', () => {
	let eventId: number;

	test.beforeEach(async () => {
		eventId = await createEvent({ title: 'Removal Parade', coordinator: 'gec', maxTroopers: 2 });
		await createRsvp(eventId, 'trooper1');
		await createRsvp(eventId, 'wrangler', { role: 'wrangler' });
		await createRsvp(eventId, 'trooper2', { status: 'attending' });
		await createRsvp(eventId, 'newbie', { status: 'waitlisted' });
	});

	test('is offered to the coordinator on every row, and to nobody else', async ({ page }) => {
		await loginAs(page, 'trooper1');
		await page.goto(`/event.php?id=${eventId}`);
		await expect(page.locator('li.rsvp_row')).toHaveCount(3);
		await expect(page.locator('a.rsvp_remove')).toHaveCount(0);
		await expect(page.locator('#events_remove_modal')).toHaveCount(0);

		await page.goto(`/event.php?id=${eventId}&action=remove_signup&uid=${uid('trooper2')}`);
		await expect(page.locator('body')).toContainText(/not have permission|no permission/i);

		await loginAs(page, 'gec');
		await page.goto(`/event.php?id=${eventId}`);
		await expect(page.locator('li.rsvp_row a.rsvp_remove')).toHaveCount(3);
		await expect(page.locator('li.waitlist_row a.rsvp_remove')).toHaveCount(1);
	});

	test('sends the PM as edited, and removes the signup', async ({ page }) => {
		await loginAs(page, 'gec');
		await page.goto(`/event.php?id=${eventId}`);
		await removeLink(page, 'trooper2').click();

		await expect(page.locator('#events_remove_modal')).toBeVisible();
		await expect(page.locator('#events_remove_title')).toHaveText('Remove trooper2');
		await expect(page.locator('#events_remove_blocked')).toBeHidden();
		await expect(page.locator('#events_remove_subject')).toHaveValue(SUBJECT);
		await expect(page.locator('#events_remove_copy_main')).toBeHidden();

		const draft = await page.locator('#events_remove_message').inputValue();
		expect(draft).toContain('Hi trooper2,');
		expect(draft).toContain('Removal Parade');
		expect(draft.trim().endsWith('gec')).toBe(true);

		// The cursor is left where the reason goes.
		await page.keyboard.type('We need troopers in white armour for this one.');
		const edited = await page.locator('#events_remove_message').inputValue();
		expect(edited).toMatch(
			/Removal Parade on .*\.\n\nWe need troopers in white armour for this one\.\n\ngec$/
		);

		await submitRemoval(page, eventId, () => page.locator('#events_remove_send').click());

		await expect(page.locator('li.rsvp_row .rsvp_username')).not.toContainText(['trooper2']);
		expect(await countRsvps(eventId)).toBe(3);
		const pms = await getPrivateMessages('trooper2', SUBJECT);
		expect(pms).toHaveLength(1);
		expect(pms[0].message).toBe(edited);
		expect(Number(pms[0].fromid)).toBe(uid('gec'));

		// The place it freed goes to the waitlist, whose member hears it from the coordinator.
		expect(await getRsvpStatus(eventId, 'newbie')).toBe('attending');
		const promoted = await getPrivateMessages('newbie', 'You have a place%');
		expect(promoted).toHaveLength(1);
		expect(Number(promoted[0].fromid)).toBe(uid('gec'));

		expect(await removalLog()).toEqual([
			[String(eventId), 'Removal Parade', 'trooper2', 'sent a PM'],
		]);
	});

	test('Cancel, the X and Escape all leave the signup where it is', async ({ page }) => {
		await loginAs(page, 'gec');
		await page.goto(`/event.php?id=${eventId}`);

		for (const dismiss of [
			() => page.locator('#events_remove_cancel').click(),
			() => page.locator('#events_remove_close').click(),
			() => page.keyboard.press('Escape'),
		]) {
			await removeLink(page, 'trooper2').click();
			await expect(page.locator('#events_remove_modal')).toBeVisible();
			await dismiss();
			await expect(page.locator('#events_remove_modal')).toBeHidden();
		}

		await page.reload();
		await expect(page.locator('li.rsvp_row .rsvp_username')).toContainText(['trooper2']);
		expect(await getRsvpStatus(eventId, 'trooper2')).toBe('attending');
		expect(await getPrivateMessages('trooper2', SUBJECT)).toHaveLength(0);
	});

	test('removes without notifying from the menu', async ({ page }) => {
		await loginAs(page, 'gec');
		await page.goto(`/event.php?id=${eventId}`);
		await removeLink(page, 'wrangler').click();

		await page.locator('#events_remove_menu summary').click();
		await expect(page.locator('#events_remove_copy')).toBeVisible();
		await submitRemoval(page, eventId, () => page.locator('#events_remove_silent').click());

		expect(await getRsvpStatus(eventId, 'wrangler', 'wrangler')).toBeNull();
		expect(await getPrivateMessages('wrangler', SUBJECT)).toHaveLength(0);
		expect(await removalLog()).toEqual([
			[String(eventId), 'Removal Parade', 'wrangler', 'without notifying them'],
		]);
	});

	test('takes a waitlisted member off the waitlist', async ({ page }) => {
		await loginAs(page, 'gec');
		await page.goto(`/event.php?id=${eventId}`);
		await page.locator(`li.waitlist_row a.rsvp_remove[data-uid="${uid('newbie')}"]`).click();
		await page.locator('#events_remove_menu summary').click();
		await submitRemoval(page, eventId, () => page.locator('#events_remove_silent').click());

		await expect(page.locator('#waitlist_list')).toHaveCount(0);
		expect(await getRsvpStatus(eventId, 'newbie')).toBeNull();
	});

	test('offers no PM to a member who has turned them off, and copies the text instead', async ({
		page,
		context,
	}) => {
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		const restore = await setReceivePms('trooper2', 0);
		try {
			await loginAs(page, 'gec');
			await page.goto(`/event.php?id=${eventId}`);
			await removeLink(page, 'trooper2').click();

			await expect(page.locator('#events_remove_blocked')).toHaveText(
				'trooper2 has turned off private messages.'
			);
			await expect(page.locator('#events_remove_send')).toBeHidden();
			await expect(page.locator('#events_remove_subject')).toBeHidden();
			await expect(page.locator('#events_remove_copy_main')).toBeVisible();
			await page.locator('#events_remove_menu summary').click();
			await expect(page.locator('#events_remove_copy')).toBeHidden();
			await expect(page.locator('#events_remove_silent')).toBeVisible();
			// The first Escape shuts the menu, the second the dialog.
			await page.keyboard.press('Escape');
			await page.keyboard.press('Escape');

			// A member who can be messaged is not caught by the last one's state.
			await removeLink(page, 'trooper1').click();
			await expect(page.locator('#events_remove_send')).toBeVisible();
			await expect(page.locator('#events_remove_copy_main')).toBeHidden();
			await page.locator('#events_remove_cancel').click();

			await removeLink(page, 'trooper2').click();
			await page.locator('#events_remove_message').fill('Sorry - this one is full of TKs already.');
			await submitRemoval(page, eventId, () => page.locator('#events_remove_copy_main').click());

			expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
				'Sorry - this one is full of TKs already.'
			);
			expect(await getRsvpStatus(eventId, 'trooper2')).toBeNull();
			expect(await getPrivateMessages('trooper2', SUBJECT)).toHaveLength(0);
			expect(await removalLog()).toEqual([
				[String(eventId), 'Removal Parade', 'trooper2', 'copied a message to send'],
			]);
		} finally {
			await restore();
		}
	});

	test('refuses a PM the member has turned off, and removes nothing', async ({ page }) => {
		await loginAs(page, 'gec');
		await page.goto(`/event.php?id=${eventId}`);
		await removeLink(page, 'trooper2').click();

		// Turned off after the page was drawn: the server asks again.
		const restore = await setReceivePms('trooper2', 0);
		try {
			await page.locator('#events_remove_send').click();
			await page.waitForLoadState('domcontentloaded');

			await expect(page.locator('#remove_signup_page')).toContainText(
				'trooper2 has turned off private messages.'
			);
			await expect(page.locator('#remove_signup_send')).toHaveCount(0);
			expect(await getRsvpStatus(eventId, 'trooper2')).toBe('attending');
			expect(await getPrivateMessages('trooper2', SUBJECT)).toHaveLength(0);
			expect(await removalLog()).toEqual([]);
		} finally {
			await restore();
		}
	});

	test.describe('with the script off', () => {
		test.use({ javaScriptEnabled: false });

		test('the X is a page that sends the same PM and removes the signup', async ({ page }) => {
			await loginAs(page, 'gec');
			await page.goto(`/event.php?id=${eventId}`);
			await removeLink(page, 'trooper2').click();
			await page.waitForLoadState('domcontentloaded');

			await expect(page.locator('#remove_signup_subject')).toHaveValue(SUBJECT);
			await expect(page.locator('#remove_signup_message')).toHaveValue(
				/Hi trooper2,[\s\S]*Removal Parade/
			);

			await page.locator('#remove_signup_message').fill('See you at the next one.');
			await submitRemoval(page, eventId, () => page.locator('#remove_signup_send').click());

			expect(await getRsvpStatus(eventId, 'trooper2')).toBeNull();
			const pms = await getPrivateMessages('trooper2', SUBJECT);
			expect(pms.map((pm) => pm.message)).toEqual(['See you at the next one.']);
		});

		test('Cancel goes back with the signup kept, and a member without PMs is only offered removal', async ({
			page,
		}) => {
			await loginAs(page, 'gec');
			await page.goto(`/event.php?id=${eventId}&action=remove_signup&uid=${uid('trooper2')}`);
			await page.locator('#remove_signup_cancel').click();
			await page.waitForLoadState('domcontentloaded');
			expect(await getRsvpStatus(eventId, 'trooper2')).toBe('attending');

			const restore = await setReceivePms('trooper2', 0);
			try {
				await page.goto(`/event.php?id=${eventId}&action=remove_signup&uid=${uid('trooper2')}`);
				await expect(page.locator('#remove_signup_blocked')).toHaveText(
					'trooper2 has turned off private messages.'
				);
				await expect(page.locator('#remove_signup_send')).toHaveCount(0);
				await submitRemoval(page, eventId, () => page.locator('#remove_signup_silent').click());
				expect(await getRsvpStatus(eventId, 'trooper2')).toBeNull();
			} finally {
				await restore();
			}
		});
	});
});
