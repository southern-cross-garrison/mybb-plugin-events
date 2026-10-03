import { test, expect } from '../helpers/fixtures';
import { loginAs, logout } from '../helpers/auth';
import { runPhp } from '../helpers/container';
import {
	createEvent,
	createRsvp,
	fixtures,
	getSetting,
	getThreadFirstPost,
	uid,
} from '../helpers/db';
import { fillDescription } from '../helpers/editor';
import { advanceClock } from '../helpers/clock';

/**
 * An event *is* its announcement thread. Opening the thread shows the event card where
 * the first post would be, the discussion carries on underneath it as ordinary replies,
 * and every way of getting to the event - the listing, the calendar, event.php itself,
 * the thread's own subject in its forum - lands at the top of that thread.
 *
 * The generated first post is still written and still says everything. It is what a
 * guest, and anything reading posts rather than pages (Tapatalk), is shown instead of the
 * card, so it is asserted on here as much as the card is.
 */

const FORUMS = fixtures().forums;

/** Threads outlive a test, so each attempt's subjects are its own. */
const unique = (base: string) => `${base} ${Math.random().toString(36).slice(2, 8)}`;

/** Announce an event the way saving it live does, and return its thread id. */
async function announce(eventId: number): Promise<number> {
	const output = await runPhp(`
require_once MYBB_ROOT.'inc/plugins/events/inc/events_thread.php';
echo events_sync_event_thread(${eventId});
`);

	const threadId = Number(output.trim());
	expect(threadId).toBeGreaterThan(0);

	return threadId;
}

/**
 * Post replies to a thread, the way MyBB's own reply form writes them.
 *
 * Each reply names its author, because MyBB folds a member's reply into their previous
 * one when nobody has posted in between (postmergemins) - ten replies from one member
 * would be one post.
 */
async function reply(threadId: number, replies: Array<[string, string]>): Promise<void> {
	const json = JSON.stringify(replies.map(([username, message]) => [uid(username), message]))
		.replace(/\\/g, '\\\\')
		.replace(/'/g, "\\'");
	const output = await runPhp(`
require_once MYBB_ROOT.'inc/datahandlers/post.php';
$thread = get_thread(${threadId});
foreach(json_decode('${json}', true) as list($uid, $message))
{
    $user = get_user($uid);
    $handler = new PostDataHandler('insert');
    $handler->admin_override = true;
    $handler->set_data(array(
        'tid' => $thread['tid'], 'fid' => $thread['fid'], 'subject' => 'RE: ' . $thread['subject'],
        'uid' => $user['uid'], 'username' => $user['username'], 'message' => $message,
        'ipaddress' => '127.0.0.1', 'options' => array('signature' => 0, 'subscriptionmethod' => '', 'disablesmilies' => 0),
    ));
    if(!$handler->validate_post()) { echo 'INVALID: ' . implode(' ', $handler->get_friendly_errors()); exit; }
    $handler->insert_post();
}
echo 'OK';
`);
	expect(output).toBe('OK');
}

/** Start an ordinary thread - one with no event behind it - and return its id. */
async function postThread(subject: string, username: string): Promise<number> {
	const output = await runPhp(`
require_once MYBB_ROOT.'inc/datahandlers/post.php';
$user = get_user(${uid(username)});
$handler = new PostDataHandler('insert');
$handler->action = 'thread';
$handler->admin_override = true;
$handler->set_data(array(
    'fid' => ${FORUMS.events}, 'subject' => ${JSON.stringify(subject)}, 'message' => 'Just a thread.',
    'uid' => $user['uid'], 'username' => $user['username'], 'ipaddress' => '127.0.0.1',
    'options' => array('signature' => 0, 'subscriptionmethod' => '', 'disablesmilies' => 0),
));
if(!$handler->validate_thread()) { echo 'INVALID: ' . implode(' ', $handler->get_friendly_errors()); exit; }
$thread = $handler->insert_thread();
echo $thread['tid'];
`);
	const threadId = Number(output);
	expect(threadId).toBeGreaterThan(0);
	return threadId;
}

test.describe('an event is its discussion thread', () => {
	test('the thread opens on the event card in place of the announcement post', async ({ page }) => {
		const title = unique('Card Thread Troop');
		const eventId = await createEvent({
			title,
			description: 'Bring [b]white[/b] armour.',
			address: '1 Showground Rd',
		});
		await createRsvp(eventId, 'trooper1');
		const threadId = await announce(eventId);
		const firstPost = await getThreadFirstPost(threadId);

		await loginAs(page, 'trooper2');
		await page.goto(`/showthread.php?tid=${threadId}`);

		// The card is the first thing in the post list, in the first post's slot and under
		// its anchor, so a #pid link to the announcement still lands on the event.
		const card = page.locator(`#posts #post_${firstPost.pid} #event_page`);
		await expect(card).toBeVisible();
		await expect(card).toHaveAttribute('data-event-id', String(eventId));
		await expect(page.locator(`#pid${firstPost.pid}`)).toHaveCount(1);
		// The description is BBCode, rendered - not the markup it was written in.
		await expect(page.locator('#event_description')).toHaveText('Bring white armour.');
		await expect(page.locator('#event_address')).toHaveText('1 Showground Rd');
		await expect(page.locator('#rsvp_rows .rsvp_row')).toHaveCount(1);
		await expect(page.locator('#event_signup')).toHaveAttribute('href', `rsvp.php?id=${eventId}`);

		// The generated post is hidden, not shown as well: it says the same things again,
		// in BBCode, with a link back to the page the reader is already on.
		await expect(page.locator(`#pid_${firstPost.pid}`)).toHaveCount(0);
		await expect(page.locator('#posts')).not.toContainText('View this event and sign up');

		// Nothing sends a member away from the thread to discuss the event.
		await expect(page.locator('#event_thread')).toHaveCount(0);
	});

	test('guests read the announcement post itself, which is what Tapatalk shows', async ({
		page,
	}) => {
		const title = unique('Guest Thread Troop');
		const eventId = await createEvent({ title, description: 'Bring white armour.' });
		const threadId = await announce(eventId);
		const firstPost = await getThreadFirstPost(threadId);

		// The card is for members who could open the event page; the post is for everybody
		// else, and for every client that reads posts rather than pages.
		expect(firstPost.message).toContain('Bring white armour.');
		expect(firstPost.message).toContain(`event.php?id=${eventId}`);

		await logout(page);
		await page.goto(`/showthread.php?tid=${threadId}`);
		await expect(page.locator(`#pid_${firstPost.pid}`)).toContainText('Bring white armour.');
		await expect(page.locator('#event_page')).toHaveCount(0);
	});

	test('event.php hands over to the thread, filters and all', async ({ page }) => {
		const eventId = await createEvent({ title: unique('Forwarded Troop') });
		const threadId = await announce(eventId);

		await loginAs(page, 'trooper1');

		await page.goto(`/event.php?id=${eventId}`);
		await expect(page).toHaveURL(new RegExp(`/showthread\\.php\\?tid=${threadId}$`));
		await expect(page.locator('#event_page')).toBeVisible();

		await page.goto(`/event.php?id=${eventId}&filter_costume=TK`);
		await expect(page).toHaveURL(
			new RegExp(`/showthread\\.php\\?tid=${threadId}&filter_costume=TK$`)
		);
		await expect(page.locator('#filter_costume')).toHaveValue('TK');

		// The attendance sheet is a page of its own, not something to read in a thread.
		await loginAs(page, 'gec');
		await page.goto(`/event.php?id=${eventId}&action=attendance`);
		await expect(page).toHaveURL(/event\.php\?id=\d+&action=attendance/);
		await expect(page.locator('#attendance_table')).toBeVisible();
	});

	test('an event with no thread to read it in stays on event.php', async ({ page }) => {
		// Pending events are never announced, so a coordinator's draft has nowhere else to be.
		const eventId = await createEvent({ title: unique('Draft Troop'), status: 'pending' });

		await loginAs(page, 'gec');
		await page.goto(`/event.php?id=${eventId}`);
		await expect(page).toHaveURL(new RegExp(`/event\\.php\\?id=${eventId}$`));
		await expect(page.locator('#event_page')).toBeVisible();
		await expect(page.locator('#rsvp_filter_form')).toHaveAttribute('action', 'event.php');
	});

	test('the listing and the calendar link straight to the thread', async ({ page }) => {
		const announcedId = await createEvent({ title: unique('Listed Thread Troop') });
		const threadId = await announce(announcedId);
		// No announcement behind this one, so it can only link to the event page.
		const plainId = await createEvent({ title: unique('Unannounced Troop') });

		await loginAs(page, 'trooper1');

		await page.goto('/events.php?view=list');
		await expect(page.locator(`[data-event-id="${announcedId}"] a.event_link`)).toHaveAttribute(
			'href',
			`showthread.php?tid=${threadId}`
		);
		await expect(page.locator(`[data-event-id="${plainId}"] a.event_link`)).toHaveAttribute(
			'href',
			`event.php?id=${plainId}`
		);

		await page.goto('/events.php?view=calendar');
		const link = page.locator(`a.calendar_event[data-event-id="${announcedId}"]`).first();
		await expect(link).toHaveAttribute('href', `showthread.php?tid=${threadId}`);
		await link.click();
		await expect(page.locator(`#event_page[data-event-id="${announcedId}"]`)).toBeVisible();
	});

	test('the signup list filter works from inside the thread', async ({ page }) => {
		const eventId = await createEvent({ title: unique('Filtered Thread Troop') });
		await createRsvp(eventId, 'trooper1');
		await createRsvp(eventId, 'wrangler', { role: 'wrangler' });
		const threadId = await announce(eventId);

		await loginAs(page, 'trooper2');
		await page.goto(`/showthread.php?tid=${threadId}`);
		await expect(page.locator('#rsvp_rows .rsvp_row')).toHaveCount(2);

		await page.locator('#rsvp_filter_toggle').click();
		await page.locator('#filter_costume').fill(fixtures().costumeOptions[0]);
		await page.locator('#rsvp_filter_form input[type="submit"]').click();

		// Back on the same thread, not on event.php, with only the trooper left in the list.
		await expect(page).toHaveURL(new RegExp(`/showthread\\.php\\?tid=${threadId}&filter_costume=`));
		await expect(page.locator('#rsvp_rows .rsvp_row')).toHaveCount(1);
		await expect(page.locator('#rsvp_rows .rsvp_row')).toHaveAttribute(
			'data-uid',
			String(uid('trooper1'))
		);

		await page.locator('#rsvp_filter_reset').click();
		await expect(page.locator('#rsvp_rows .rsvp_row')).toHaveCount(2);
	});

	test('replies paginate like any thread, with the event on the first page only', async ({
		page,
	}) => {
		const eventId = await createEvent({ title: unique('Busy Thread Troop') });
		const threadId = await announce(eventId);
		const perPage = Number(await getSetting('postsperpage'));

		// The card takes the first post's place in the count, the way the post it stands in
		// for does, so one page's worth of replies spills exactly one onto page two.
		const replies = Array.from({ length: perPage }, (_, i): [string, string] => [
			i % 2 ? 'trooper2' : 'trooper1',
			`Reply number ${i + 1}`,
		]);
		await reply(threadId, replies);

		await loginAs(page, 'trooper2');
		await page.goto(`/showthread.php?tid=${threadId}`);
		await expect(page.locator('#event_page')).toBeVisible();
		await expect(page.locator('#posts .post_body')).toHaveCount(perPage - 1);
		await expect(page.locator('#posts')).toContainText('Reply number 1');
		await expect(page.locator('#posts')).not.toContainText(`Reply number ${perPage}`);

		await page.goto(`/showthread.php?tid=${threadId}&page=2`);
		await expect(page.locator('#event_page')).toHaveCount(0);
		await expect(page.locator('#posts .post_body')).toHaveCount(1);
		await expect(page.locator('#posts')).toContainText(`Reply number ${perPage}`);
	});

	test('members reply to the event in the thread', async ({ page }) => {
		const eventId = await createEvent({ title: unique('Chatty Thread Troop') });
		const threadId = await announce(eventId);

		await loginAs(page, 'trooper1');
		await page.goto(`/newreply.php?tid=${threadId}`);
		await fillDescription(page, 'message', 'Count me in for the Saturday.');
		await page.locator('[name="submit"]').click();

		await expect(page).toHaveURL(new RegExp(`showthread\\.php\\?tid=${threadId}`));
		await expect(page.locator('#event_page')).toBeVisible();
		await expect(page.locator('#posts .post_body').last()).toContainText(
			'Count me in for the Saturday.'
		);
	});

	// The card has no .post_body, so an event thread with no replies is the one page where
	// thread.js gets through Thread.quickEdit() on load and posts quick reply over AJAX. If
	// anything then throws after the reply lands - it did while the theme linked a jeditable
	// file that 404s - the reply is saved but the spinner never clears.
	test('quick reply posts into an event thread without leaving the page', async ({ page }) => {
		const eventId = await createEvent({ title: unique('Quick Reply Troop') });
		const threadId = await announce(eventId);

		await loginAs(page, 'trooper1');
		await page.goto(`/showthread.php?tid=${threadId}`);
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		// A full-page submit would drop this; the AJAX reply keeps it.
		await page.evaluate(() => {
			(window as any).eventsQuickReplyMarker = true;
		});

		const form = page.locator('#quick_reply_form');
		await form.locator('textarea[name="message"]').fill('Quick reply to the event.');
		await form.locator('#quick_reply_submit').click();

		await expect(page.locator('#posts .post_body').last()).toContainText(
			'Quick reply to the event.'
		);
		await expect(page.locator('#quickreply_spinner')).toBeHidden();
		await expect(form.locator('textarea[name="message"]')).toHaveValue('');
		expect(await page.evaluate(() => (window as any).eventsQuickReplyMarker)).toBe(true);
		expect(errors).toEqual([]);
	});

	test('an event thread in its forum links to the top, not to the first unread reply', async ({
		page,
	}) => {
		const eventId = await createEvent({ title: unique('Unread Thread Troop') });
		const threadId = await announce(eventId);
		const plainId = await postThread(unique('Ordinary Thread'), 'gec');

		// Read both, then have somebody else reply to both, so each has an unread post.
		await loginAs(page, 'trooper2');
		await page.goto(`/showthread.php?tid=${threadId}`);
		await page.goto(`/showthread.php?tid=${plainId}`);
		// The replies have to be newer than the reading, and the test clock stands still.
		await advanceClock({ minutes: 5 });
		await reply(threadId, [['trooper1', 'Unread on the event']]);
		await reply(plainId, [['trooper1', 'Unread on the ordinary thread']]);

		await page.goto(`/forumdisplay.php?fid=${FORUMS.events}`);

		// The control: an ordinary thread still goes to the first unread post, so this is
		// the event thread being treated differently rather than Smart Thread Link being off.
		const subjectLink = (tid: number) => page.locator('a', { has: page.locator(`#tid_${tid}`) });
		await expect(subjectLink(plainId)).toHaveAttribute('href', /action=newpost/);
		await expect(subjectLink(threadId)).toHaveAttribute('href', `showthread.php?tid=${threadId}`);

		await subjectLink(threadId).click();
		await expect(page.locator('#event_page')).toBeVisible();
	});

	test('printing an ordinary thread is untouched by the event stylesheet', async ({ page }) => {
		// The event stylesheet now reaches every thread, and its print rules hide everything
		// that is not an event - which, on a thread with no event, would be everything.
		const plainId = await postThread(unique('Printable Ordinary Thread'), 'gec');

		await loginAs(page, 'trooper1');
		await page.goto(`/showthread.php?tid=${plainId}`);
		await expect(page.locator('link[href*="events.css"]')).toHaveCount(1);

		await page.emulateMedia({ media: 'print' });
		await expect(page.locator('#posts')).toBeVisible();
		await expect(page.locator('#posts')).toContainText('Just a thread.');
	});
});
