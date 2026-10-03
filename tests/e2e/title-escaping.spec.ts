import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { gotoEventsAdmin, loginAs, loginToAdminCp } from '../helpers/auth';
import { createEvent, createRsvp, fixtures } from '../helpers/db';
import { relativeToTestNow } from '../helpers/clock';

/**
 * An event's title is typed by a coordinator and shown to everybody, Admin CP included,
 * and MyBB escapes neither a breadcrumb nor a select box's options. So every page that
 * names the event has to escape the title itself - miss one and a coordinator's title
 * runs script in an administrator's session. An innocent "<3" is enough to break a page
 * that forgets, which is why the title carries both.
 */

const TITLE = 'Kids <3 Troopers <script>window.pwned = 1;</script>';
const [TK] = [fixtures().costumeOptions[0]];

async function expectTitleShownNotRun(page: Page): Promise<void> {
	await expect(page.locator('body')).toContainText('Kids <3 Troopers');
	expect(
		await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)
	).toBeUndefined();
	expect(await page.content()).not.toContain('<script>window.pwned');
}

test.describe('event titles', () => {
	test('are escaped on every front-end page that names the event', async ({ page }) => {
		const upcoming = await createEvent({ title: TITLE });
		const finished = await createEvent({
			title: TITLE,
			start: relativeToTestNow({ days: -2 }),
			end: relativeToTestNow({ days: -1 }),
			signupCutoff: relativeToTestNow({ days: -3 }),
		});
		await createRsvp(finished, 'trooper1', { costumes: [TK] });

		await loginAs(page, 'trooper1');
		for (const path of [
			`/event.php?id=${upcoming}`,
			`/rsvp.php?id=${upcoming}`,
			`/troop_report.php?id=${finished}`,
		]) {
			await page.goto(path);
			await expectTitleShownNotRun(page);
		}

		await loginAs(page, 'gec');
		await page.goto(`/manage_event.php?id=${upcoming}`);
		await expectTitleShownNotRun(page);
	});

	test('are escaped in the Admin CP RSVP event picker', async ({ page }) => {
		const eventId = await createEvent({ title: TITLE });

		await loginToAdminCp(page);
		await gotoEventsAdmin(page, `&action=rsvps&event_id=${eventId}`);

		await expect(page.locator(`#event_id option[value="${eventId}"]`)).toContainText(
			'Kids <3 Troopers <script>'
		);
		expect(
			await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)
		).toBeUndefined();
	});
});
