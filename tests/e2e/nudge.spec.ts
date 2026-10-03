import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { gotoEventsAdmin, loginToAdminCp } from '../helpers/auth';
import { runPhp } from '../helpers/container';
import { relativeToTestNow } from '../helpers/clock';
import {
	createEvent,
	createRsvp,
	execute,
	getPrivateMessages,
	queryOne,
	T,
	uid,
} from '../helpers/db';

/**
 * Nudge: each member on the Reports tab's People view has a link that drafts a message
 * encouraging them back out trooping, which the admin edits and then sends as a PM or
 * copies. Sending respects the member's own PM settings, and the dialog says when it
 * cannot - see events_pm_block_reason().
 */

const SUBJECT = 'Come trooping with us';

async function postDraftedReport(eventId: number): Promise<void> {
	const output = await runPhp(`
require_once MYBB_ROOT.'inc/plugins/events/inc/events_troop_report.php';
$event = events_get_event(${eventId});
$tid = events_post_troop_report($event, get_user(${uid('trooper1')}), events_troop_report_draft($event), $error);
echo $tid ? 'POSTED' : 'FAILED: '.$error;
`);
	expect(output).toContain('POSTED');
}

/** Change a member's PM settings, returning what puts them back. */
async function setPmSettings(
	username: string,
	values: { receivepms?: number; ignorelist?: string }
): Promise<() => Promise<void>> {
	const before = await queryOne<any>(
		`SELECT receivepms, ignorelist FROM ${T('users')} WHERE uid = ?`,
		[uid(username)]
	);
	const next = { receivepms: before.receivepms, ignorelist: before.ignorelist, ...values };
	await execute(`UPDATE ${T('users')} SET receivepms = ?, ignorelist = ? WHERE uid = ?`, [
		next.receivepms,
		next.ignorelist,
		uid(username),
	]);
	return async () => {
		await execute(`UPDATE ${T('users')} SET receivepms = ?, ignorelist = ? WHERE uid = ?`, [
			before.receivepms,
			before.ignorelist,
			uid(username),
		]);
	};
}

/** The board's administrator, who is not in the fixture map. */
async function adminUid(): Promise<number> {
	const row = await queryOne<any>(`SELECT uid FROM ${T('users')} WHERE username = 'admin'`);
	return Number(row.uid);
}

const nudgeLink = (page: Page, username: string) => page.locator(`#events_nudge_${uid(username)}`);

test.describe('nudge', () => {
	test.beforeEach(async () => {
		const past = await createEvent({
			title: 'Nudge Past Parade',
			start: relativeToTestNow({ days: -31 }),
			end: relativeToTestNow({ days: -30 }),
			signupCutoff: relativeToTestNow({ days: -32 }),
		});
		await createRsvp(past, 'trooper1');
		await createRsvp(past, 'trooper2');
		await postDraftedReport(past);

		await createEvent({
			title: 'Nudge Upcoming Fete',
			start: relativeToTestNow({ days: 10 }),
			end: relativeToTestNow({ days: 10, hours: 4 }),
		});
		const signedUp = await createEvent({
			title: 'Nudge Signed Up Gala',
			start: relativeToTestNow({ days: 12 }),
			end: relativeToTestNow({ days: 12, hours: 4 }),
		});
		await createRsvp(signedUp, 'trooper2');
		await createEvent({
			title: 'Nudge Hidden Muster',
			start: relativeToTestNow({ days: 14 }),
			end: relativeToTestNow({ days: 14, hours: 4 }),
			excluded: ['trooper2'],
		});
	});

	test('drafts a message, and sends it as edited', async ({ page }) => {
		await loginToAdminCp(page);
		await gotoEventsAdmin(page, '&action=reports&view=people&region=Sydney');

		await expect(nudgeLink(page, 'trooper2')).toHaveText('Nudge…');
		await nudgeLink(page, 'trooper2').click();

		const modal = page.locator('#events_nudge_modal');
		await expect(modal).toBeVisible();
		await expect(page.locator('#events_nudge_title')).toHaveText('Nudge trooper2');
		await expect(page.locator('#events_nudge_blocked')).toBeHidden();
		await expect(page.locator('#events_nudge_subject')).toHaveValue(SUBJECT);

		const draft = await page.locator('#events_nudge_message').inputValue();
		expect(draft).toContain('Hi trooper2,');
		expect(draft).toContain('Your last troop with us was Nudge Past Parade');
		expect(draft).toContain('Nudge Upcoming Fete');
		// Already signed up to one, and excluded from the other.
		expect(draft).not.toContain('Nudge Signed Up Gala');
		expect(draft).not.toContain('Nudge Hidden Muster');

		const edited = `${draft}\n\nP.S. Bring the TD.`;
		await page.locator('#events_nudge_message').fill(edited);
		await page.locator('#events_nudge_send').click();

		await expect(page.locator('#flash_message')).toContainText('Private message sent to trooper2.');
		expect(page.url()).toContain('region=Sydney');

		const pms = await getPrivateMessages('trooper2', SUBJECT);
		expect(pms).toHaveLength(1);
		expect(pms[0].message).toBe(edited);
		expect(Number(pms[0].fromid)).toBe(await adminUid());
	});

	test('says why a member who has turned PMs off cannot be sent one, and refuses it anyway', async ({
		page,
	}) => {
		const restore = await setPmSettings('trooper2', { receivepms: 0 });
		try {
			await loginToAdminCp(page);
			await gotoEventsAdmin(page, '&action=reports&view=people');
			await nudgeLink(page, 'trooper2').click();

			await expect(page.locator('#events_nudge_blocked')).toHaveText(
				'trooper2 has turned off private messages.'
			);
			await expect(page.locator('#events_nudge_send')).toBeDisabled();
			await expect(page.locator('#events_nudge_subject')).toBeHidden();
			await expect(page.locator('#events_nudge_copy')).toBeEnabled();

			// A member who can still be messaged is not caught by the last one's state.
			await page.locator('#events_nudge_modal input[value="Cancel"]').click();
			await nudgeLink(page, 'trooper1').click();
			await expect(page.locator('#events_nudge_blocked')).toBeHidden();
			await expect(page.locator('#events_nudge_send')).toBeEnabled();
			await page.locator('#events_nudge_modal input[value="Cancel"]').click();

			// The button is only disabled in the browser; the server asks again.
			await nudgeLink(page, 'trooper2').click();
			await page.evaluate(() => {
				(document.getElementById('events_nudge_send') as HTMLButtonElement).disabled = false;
				(document.getElementById('events_nudge_form') as HTMLFormElement).submit();
			});
			await page.waitForLoadState('domcontentloaded');
			await expect(page.locator('.error')).toContainText(
				'trooper2 has turned off private messages.'
			);
			expect(await getPrivateMessages('trooper2', SUBJECT)).toHaveLength(0);
		} finally {
			await restore();
		}
	});

	test('Copy puts the message, as edited, on the clipboard', async ({ page, context }) => {
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await loginToAdminCp(page);
		await gotoEventsAdmin(page, '&action=reports&view=people');
		await nudgeLink(page, 'trooper2').click();

		await page.locator('#events_nudge_message').fill('See you at the next troop!');
		await page.locator('#events_nudge_copy').click();

		await expect(page.locator('#events_nudge_copy')).toHaveValue('Copied');
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
			'See you at the next troop!'
		);
		expect(await getPrivateMessages('trooper2', SUBJECT)).toHaveLength(0);
	});

	test('every PM setting MyBB honours is one the nudge honours, admin or not', async () => {
		const output = await runPhp(`
require_once MYBB_ROOT.'inc/plugins/events/admin/events_admin_nudge.php';
$from = ${await adminUid()};
$base = get_user(${uid('trooper2')});
$base['receivepms'] = 1;
$base['ignorelist'] = '';
$base['buddylist'] = '';
$base['receivefrombuddy'] = 0;
$cases = array(
    'open'       => $base,
    'off'        => array_merge($base, array('receivepms' => 0)),
    'ignoring'   => array_merge($base, array('ignorelist' => '99,'.$from)),
    'buddy_only' => array_merge($base, array('receivefrombuddy' => 1, 'buddylist' => '99')),
    'buddy'      => array_merge($base, array('receivefrombuddy' => 1, 'buddylist' => '99,'.$from)),
);
$mybb->settings['enablepms'] = 1;
$mybb->settings['allowbuddyonly'] = 1;
foreach($cases as $name => $user) { echo $name, '=', events_pm_block_reason($user, $from), "\\n"; }
$mybb->settings['enablepms'] = 0;
echo 'board=', events_pm_block_reason($base, $from), "\\n";
`);
		expect(output).toContain('open=\n');
		expect(output).toContain('off=trooper2 has turned off private messages.');
		expect(output).toContain('ignoring=trooper2 has you on their ignore list.');
		expect(output).toContain(
			'buddy_only=trooper2 only accepts private messages from their buddies.'
		);
		expect(output).toContain('buddy=\n');
		expect(output).toContain('board=Private messaging is turned off on this board.');
	});

	test.describe('with the script off', () => {
		test.use({ javaScriptEnabled: false });

		test('the link is a page that drafts and sends the same message', async ({ page }) => {
			await loginToAdminCp(page);
			await gotoEventsAdmin(page, '&action=reports&view=people&region=Sydney');
			await nudgeLink(page, 'trooper2').click();
			await page.waitForLoadState('domcontentloaded');

			await expect(page.locator('#nudge_subject')).toHaveValue(SUBJECT);
			await expect(page.locator('#nudge_message')).toHaveValue(
				/Hi trooper2,[\s\S]*Nudge Upcoming Fete/
			);

			await page.locator('#nudge_message').fill('Troop with us this month?');
			await page.locator('#nudge_send').click();
			await page.waitForLoadState('domcontentloaded');

			await expect(page.locator('#flash_message')).toContainText(
				'Private message sent to trooper2.'
			);
			expect(page.url()).toContain('region=Sydney');
			const pms = await getPrivateMessages('trooper2', SUBJECT);
			expect(pms.map((pm) => pm.message)).toEqual(['Troop with us this month?']);
		});

		test('says why a PM cannot be sent, and offers no way to send one', async ({ page }) => {
			const restore = await setPmSettings('trooper2', { receivepms: 0 });
			try {
				await loginToAdminCp(page);
				await gotoEventsAdmin(page, '&action=reports&view=people');
				await nudgeLink(page, 'trooper2').click();
				await page.waitForLoadState('domcontentloaded');

				await expect(page.locator('#events_nudge_page_blocked')).toHaveText(
					'trooper2 has turned off private messages.'
				);
				await expect(page.locator('#nudge_send')).toHaveCount(0);
				await expect(page.locator('#nudge_message')).toHaveValue(/Hi trooper2,/);
			} finally {
				await restore();
			}
		});
	});
});
