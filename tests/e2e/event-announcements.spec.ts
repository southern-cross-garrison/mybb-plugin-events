import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, logout } from '../helpers/auth';
import {
	getEvent,
	getThread,
	getThreadFirstPost,
	maxThreadId,
	findThreadBySubject,
	fixtures,
	uid,
	query,
	T,
} from '../helpers/db';
import { relativeToTestNow } from '../helpers/clock';
import { fillDescription } from '../helpers/editor';

/**
 * An event is announced in the forums by the plugin, not by whoever created it: the post
 * is generated from the event row, and regenerated whenever the event is saved. Which
 * forum it lands in is the region's, because a garrison running several regions does not
 * want every region's events in one place.
 *
 * What matters here is that the announcement exists, says what the event currently says,
 * and stays a single thread across edits - the failure mode being a board that collects
 * one stale thread per save.
 */

interface EventFormValues {
	title?: string;
	description?: string;
	status?: string;
	region?: string;
	address?: string;
	start?: string;
	end?: string;
	requiresWwcc?: boolean;
}

/**
 * A date and its time are two controls now that the date box carries a calendar picker, so
 * a 'YYYY-MM-DD HH:MM:SS' fixture is split across the pair. The time input takes whole
 * minutes, which is all it shows or posts.
 */
async function fillDateTime(page: Page, id: string, value: string) {
	const [date, time] = value.split(' ');
	await page.locator(`#${id}`).fill(date ?? '');
	await page.locator(`#${id}_time`).fill(time ? time.slice(0, 5) : '');
}

async function fillEventForm(page: Page, values: EventFormValues) {
	if (values.title !== undefined) await page.locator('#event_form_title').fill(values.title);
	if (values.description !== undefined)
		await fillDescription(page, 'event_form_description', values.description);
	if (values.status !== undefined)
		await page.locator('#event_form_status').selectOption(values.status);
	if (values.region !== undefined)
		await page.locator('#event_form_region').selectOption(values.region);
	if (values.address !== undefined) await page.locator('#event_form_address').fill(values.address);
	if (values.start !== undefined) await fillDateTime(page, 'event_form_start_date', values.start);
	if (values.end !== undefined) await fillDateTime(page, 'event_form_end_date', values.end);
	if (values.requiresWwcc) await page.locator('#event_form_requires_wwcc').check();
}

/** Create an event through the front-end form and return its id. */
async function createEventViaForm(page: Page, values: EventFormValues): Promise<number> {
	await page.goto('/manage_event.php');
	await fillEventForm(page, {
		start: relativeToTestNow({ days: 14 }),
		end: relativeToTestNow({ days: 14, hours: 8 }),
		...values,
	});
	await page.locator('#manage_event_submit').click();
	await expect(page.locator('#event_page')).toBeVisible();

	// Read off the card rather than the URL: a live event lands in its announcement thread,
	// whose address names the thread and not the event.
	return Number(await page.locator('#event_page').getAttribute('data-event-id'));
}

/**
 * Open the announcement post the way it is read by everybody who is not shown the event
 * card in its place: guests, and clients such as Tapatalk that read posts rather than
 * pages. A member who can see the event gets the card instead - see event-threads.spec.ts.
 */
async function viewAnnouncementPost(page: Page, threadId: number) {
	await logout(page);
	await page.goto(`/showthread.php?tid=${threadId}`);
}

test.describe('event announcement threads', () => {
	test("a new live event is announced in its region's forum", async ({ page }) => {
		await loginAs(page, 'gec');

		const eventId = await createEventViaForm(page, {
			title: 'Hunter Hospital Visit',
			description: 'Bring white armour.',
			status: 'live',
			region: 'Hunter',
			address: '1 Showground Rd, Sydney Olympic Park NSW 2127',
			requiresWwcc: true,
		});

		const threadId = Number((await getEvent(eventId)).thread_id);
		expect(threadId).toBeGreaterThan(0);

		const thread = await getThread(threadId);
		expect(Number(thread.fid)).toBe(fixtures().forums.events_hunter);
		expect(thread.subject).toBe('Hunter Hospital Visit');
		// The coordinator owns the event, so the announcement is posted as them rather than
		// as whichever admin happened to save it.
		expect(Number(thread.uid)).toBe(uid('gec'));

		// The post is built from the event, so everything a member needs to decide whether to
		// go has to be in it - including the way back to the event page.
		const post = await getThreadFirstPost(threadId);
		expect(post.message).toContain('Hunter');
		expect(post.message).toContain('Bring white armour.');
		expect(post.message).toContain('WWCC');
		expect(post.message).toContain(`event.php?id=${eventId}`);

		// And it has to read as a post, not as raw markup.
		await viewAnnouncementPost(page, threadId);
		await expect(page.locator('.post_body').first()).toContainText('Bring white armour.');
		await expect(
			page.locator(`.post_body a[href*="event.php?id=${eventId}"]`).first()
		).toBeVisible();
		// The region is the reader's way to the rest of that region's schedule, so it is a
		// link to the listing filtered to it rather than bare text.
		await expect(page.locator('.post_body a[href*="events.php?region=Hunter"]').first()).toHaveText(
			'Hunter'
		);
		// Where the event is is the question the thread is most often read to answer, so the
		// address is a map link rather than a line of text to copy out.
		await expect(
			page.locator('.post_body a[href^="https://www.google.com/maps/search/"]').first()
		).toHaveText('1 Showground Rd, Sydney Olympic Park NSW 2127');
	});

	test('a region with no forum of its own falls back to the default forum', async ({ page }) => {
		await loginAs(page, 'gec');

		const eventId = await createEventViaForm(page, {
			title: 'Canberra Parade',
			status: 'live',
			region: 'Canberra',
		});

		const thread = await getThread(Number((await getEvent(eventId)).thread_id));
		expect(Number(thread.fid)).toBe(fixtures().forums.events);
	});

	test('a pending event is not announced until it goes live', async ({ page }) => {
		await loginAs(page, 'gec');

		const threadsBefore = await maxThreadId();

		// Pending events are coordinator-only, so announcing one would point members at a
		// page they cannot open.
		const eventId = await createEventViaForm(page, {
			title: 'Quiet Planning Troop',
			status: 'pending',
			region: 'Sydney',
		});

		expect((await getEvent(eventId)).thread_id).toBeNull();
		expect(await maxThreadId()).toBe(threadsBefore);

		await page.goto(`/manage_event.php?id=${eventId}`);
		await fillEventForm(page, { status: 'live' });
		await page.locator('#manage_event_submit').click();
		await expect(page.locator('#event_page')).toBeVisible();

		const threadId = Number((await getEvent(eventId)).thread_id);
		expect(threadId).toBeGreaterThan(0);
		expect(Number((await getThread(threadId)).fid)).toBe(fixtures().forums.events);
	});

	test('editing an event rewrites its announcement rather than posting another', async ({
		page,
	}) => {
		await loginAs(page, 'gec');

		const eventId = await createEventViaForm(page, {
			title: 'Rewritten Troop',
			description: 'Original plan.',
			status: 'live',
			region: 'Sydney',
		});

		const threadId = Number((await getEvent(eventId)).thread_id);
		const threadsBefore = await maxThreadId();

		await page.goto(`/manage_event.php?id=${eventId}`);
		await fillEventForm(page, {
			title: 'Rewritten Troop (new date)',
			description: 'Revised plan.',
		});
		await page.locator('#manage_event_submit').click();
		await expect(page.locator('#event_page')).toBeVisible();

		// Same thread, new contents - a second thread would leave the old one advertising an
		// event that no longer exists in that shape.
		expect(Number((await getEvent(eventId)).thread_id)).toBe(threadId);
		expect(await maxThreadId()).toBe(threadsBefore);

		const thread = await getThread(threadId);
		expect(thread.subject).toBe('Rewritten Troop (new date)');

		const post = await getThreadFirstPost(threadId);
		expect(post.message).toContain('Revised plan.');
		expect(post.message).not.toContain('Original plan.');
	});

	test("correcting the region moves the announcement to that region's forum", async ({ page }) => {
		await loginAs(page, 'gec');

		const eventId = await createEventViaForm(page, {
			title: 'Misfiled Troop',
			status: 'live',
			region: 'Sydney',
		});

		const threadId = Number((await getEvent(eventId)).thread_id);
		expect(Number((await getThread(threadId)).fid)).toBe(fixtures().forums.events);

		await page.goto(`/manage_event.php?id=${eventId}`);
		await fillEventForm(page, { region: 'Hunter' });
		await page.locator('#manage_event_submit').click();
		await expect(page.locator('#event_page')).toBeVisible();

		expect(Number((await getEvent(eventId)).thread_id)).toBe(threadId);
		expect(Number((await getThread(threadId)).fid)).toBe(fixtures().forums.events_hunter);

		// Moved outright, not redirected: a redirect stub left in the old forum carries the
		// event's title and is not the event's thread, so nothing would hide it from members
		// excluded from the event.
		const stubs = await query(`SELECT tid FROM ${T('threads')} WHERE closed = ?`, [
			`moved|${threadId}`,
		]);
		expect(stubs).toHaveLength(0);
	});

	test('says so on the thread when an event is taken off the schedule', async ({ page }) => {
		await loginAs(page, 'gec');

		const eventId = await createEventViaForm(page, {
			title: 'Cancelled Troop',
			status: 'live',
			region: 'Sydney',
		});
		const threadId = Number((await getEvent(eventId)).thread_id);

		await page.goto(`/manage_event.php?id=${eventId}`);
		await fillEventForm(page, { status: 'pending' });
		await page.locator('#manage_event_submit').click();
		await expect(page.locator('#event_page')).toBeVisible();

		// The thread outlives the event going back to pending, so it has to stop reading as
		// an open call for troopers.
		await viewAnnouncementPost(page, threadId);
		await expect(page.locator('.post_body').first()).toContainText('not open for signups');
	});

	test('carries the description BBCode into the posted thread as written', async ({ page }) => {
		await loginAs(page, 'gec');

		// The description is written in the board's editor and rendered as BBCode on the
		// event page, so the announcement has to parse it too - a description that reads one
		// way on the event page and another in the thread is the failure this guards.
		const eventId = await createEventViaForm(page, {
			title: 'Formatted Announcement Troop',
			description: '[b]Meet at the gate[/b] by [url=http://example.test]the map[/url].',
			status: 'live',
			region: 'Sydney',
		});

		const threadId = Number((await getEvent(eventId)).thread_id);

		await viewAnnouncementPost(page, threadId);
		// The post's own labels are bold too, so the description's is picked out by what it
		// says rather than by being the only one.
		const post = page.locator('.post_body').first();
		await expect(post.locator('.mycode_b', { hasText: 'Meet at the gate' })).toHaveCount(1);
		await expect(post.locator('a[href="http://example.test"]')).toHaveText('the map');
		await expect(post).not.toContainText('[b]');
	});

	test('still neutralises BBCode in the values the plugin interpolates', async ({ page }) => {
		await loginAs(page, 'gec');

		// The description is the one field a coordinator writes markup in on purpose.
		// Everything else the post is built from is data, and an address carrying "[url=...]"
		// would otherwise rewrite the line it sits on.
		const eventId = await createEventViaForm(page, {
			title: 'Injected Address Troop',
			address: '[url=http://evil.test]1 Nowhere St[/url]',
			status: 'live',
			region: 'Sydney',
		});

		const threadId = Number((await getEvent(eventId)).thread_id);

		await viewAnnouncementPost(page, threadId);
		// The address is still a link - to the map, with the whole string as its label. What
		// must not exist is a link the address itself wrote, so this asks for one pointing
		// at evil.test rather than for one merely mentioning it: the map URL carries the
		// address percent-encoded in its query, evil.test and all.
		const post = page.locator('.post_body').first();
		await expect(post).toContainText('[url=http://evil.test]1 Nowhere St[/url]');
		await expect(post.locator('a[href^="http://evil.test"]')).toHaveCount(0);
	});

	test('opening the event goes to its announcement thread', async ({ page }) => {
		await loginAs(page, 'gec');

		const eventId = await createEventViaForm(page, {
			title: 'Linked Announcement Troop',
			status: 'live',
			region: 'Sydney',
		});

		const thread = await findThreadBySubject('Linked Announcement Troop');
		expect(thread).not.toBeNull();

		await page.goto(`/event.php?id=${eventId}`);
		await expect(page).toHaveURL(new RegExp(`showthread\\.php\\?tid=${thread!.tid}$`));
		await expect(page.locator('#event_page')).toHaveAttribute('data-event-id', String(eventId));
	});

	// The announcement only does its job if a member browsing the forum can open it. The
	// theme links thread subjects with {$thread['smartlink']} rather than MyBB's own
	// threadlink, so this is really a check that the plugin supplying that variable is
	// installed and active: without it the subject renders as <a href=""> and the whole
	// forum listing is dead, silently and without an error anywhere.
	test('the announcement is reachable from its forum listing', async ({ page }) => {
		await loginAs(page, 'gec');

		await createEventViaForm(page, {
			title: 'Browsable Announcement Troop',
			status: 'live',
			region: 'Sydney',
		});

		const thread = await findThreadBySubject('Browsable Announcement Troop');
		expect(thread).not.toBeNull();

		await page.goto(`/forumdisplay.php?fid=${fixtures().forums.events}`);
		await page.locator(`#tid_${thread!.tid}`).click();

		await expect(page).toHaveURL(new RegExp(`showthread\\.php\\?tid=${thread!.tid}\\b`));
		await expect(page).toHaveTitle(/Browsable Announcement Troop/);
	});
});
