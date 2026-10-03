import { test, expect, Page } from '../helpers/fixtures';
import { loginToAdminCp, gotoEventsAdmin, loginAs } from '../helpers/auth';
import { runPhp } from '../helpers/container';
import {
	createEvent,
	getEvent,
	getSetting,
	getThread,
	getThreadFirstPost,
	query,
	T,
	fixtures,
} from '../helpers/db';

/**
 * The region list is the board's, not the plugin's: it is edited in Admin CP -> Event
 * Management -> Settings alongside the forums each region announces into.
 *
 * The three operations are three different shapes, and these tests follow that split.
 * Renaming is a text box saved with the rest of the settings. Adding and deleting are
 * actions of their own, confirmed in a dialog and applied on the spot.
 *
 * Deleting is what makes any of this more than a text field. An event stores its region
 * as text, so a region that disappears takes its events out of the region filter and
 * makes them unsavable on the event form - which is why the dialog has a second step
 * that asks where those events go, and why nothing happens until it has an answer.
 *
 * Every test here restores the list through the Admin CP rather than through the
 * database: MyBB reads its settings from the generated inc/settings.php, so a row put
 * back with SQL would leave the cache - and therefore every later test - on the edited
 * list.
 */

const DEFAULT_REGIONS = 'Sydney,Hunter,Canberra,Other';
const DEFAULT_REGION_FORUMS = () => `Hunter=${fixtures().forums.events_hunter}`;

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

async function gotoSettings(page: Page): Promise<void> {
	await loginToAdminCp(page);
	await gotoEventsAdmin(page, '&action=settings');
}

/** The index a region's row is rendered under, which is what its name box is keyed by. */
async function rowIndex(page: Page, region: string): Promise<number> {
	const field = page.locator(`input[type="hidden"][name^="region_original"][value="${region}"]`);
	const name = await field.getAttribute('name');
	const index = name?.match(/\[(\d+)\]/)?.[1];

	expect(index, `no region row for ${region}`).toBeDefined();
	return Number(index);
}

async function renameRegion(page: Page, region: string, to: string): Promise<void> {
	await page.locator(`#region_name_${await rowIndex(page, region)}`).fill(to);
}

async function save(page: Page): Promise<void> {
	await page.locator('input[type="submit"][value="Save Settings"]').click();
}

const modal = (page: Page) => page.locator('#events_region_modal');
const modalSubmit = (page: Page) => page.locator('#events_region_modal_submit');

/**
 * Delete a region through the dialog, answering its second step when it asks.
 *
 * The second step only appears for a region that has events, so `moveTo` is what the
 * caller expects to be asked for - passing it for a region with none would be a test
 * that silently stopped exercising the step it was written for.
 */
async function deleteRegion(page: Page, region: string, moveTo?: string): Promise<void> {
	await page.locator(`.events_region_delete[data-region="${region}"]`).click();
	await expect(modal(page)).toBeVisible();
	await modalSubmit(page).click();

	if (moveTo !== undefined) {
		await expect(page.locator('#events_region_modal_move')).toBeVisible();
		await page.locator('#events_region_modal_move_to').selectOption(moveTo);
		await modalSubmit(page).click();
	}
}

async function addRegion(page: Page, name: string): Promise<void> {
	await page.locator('#events_region_add').click();
	await expect(modal(page)).toBeVisible();
	await page.locator('#events_region_modal_name').fill(name);
	await modalSubmit(page).click();
}

/**
 * Put the list back the way the suite's baseline has it, through the Admin CP.
 *
 * Written as a teardown that re-derives the current list rather than as the inverse of
 * whatever the test did, so a test that fails halfway still leaves the board usable for
 * the ones after it. Renames go first, so the names the deletions and additions then
 * work with are the baseline's.
 *
 * It goes straight to the confirmation pages rather than through the dialog, so that it
 * works for the scriptless tests too - and so a teardown never fails for a reason the
 * tests themselves are there to catch.
 */
async function restoreRegions(page: Page): Promise<void> {
	await restoreRegionList(page);

	// Deleting a region takes its announcement forum with it, and nothing above puts that
	// back: a region re-added under the same name starts with no forum.
	if ((await getSetting('events_event_forums')) !== DEFAULT_REGION_FORUMS()) {
		await gotoSettings(page);
		const hunter = await rowIndex(page, 'Hunter');
		for (const select of await page.locator('select[id^="region_forum_"]').all()) {
			await select.selectOption(
				(await select.getAttribute('id')) === `region_forum_${hunter}`
					? String(fixtures().forums.events_hunter)
					: '-1'
			);
		}
		await save(page);
		expect(await getSetting('events_event_forums')).toBe(DEFAULT_REGION_FORUMS());
	}
}

async function restoreRegionList(page: Page): Promise<void> {
	const wanted = DEFAULT_REGIONS.split(',');
	let current = (await getSetting('events_regions')).split(',');

	if (current.join(',') === DEFAULT_REGIONS) {
		return;
	}

	await gotoSettings(page);

	let renamed = false;
	for (let i = 0; i < Math.min(current.length, wanted.length); i++) {
		if (current[i] !== wanted[i]) {
			await page.locator(`#region_name_${i}`).fill(wanted[i]);
			renamed = true;
		}
	}

	if (renamed) {
		await save(page);
		current = (await getSetting('events_regions')).split(',');
	}

	for (const extra of current.slice(wanted.length)) {
		await gotoEventsAdmin(
			page,
			`&action=settings&region_action=delete&region=${encodeURIComponent(extra)}`
		);

		const destination = page.locator('select[name="region_move_to"]');
		const hasEvents = (await destination.count()) > 0;
		if (hasEvents) {
			await destination.selectOption(wanted[0]);
		}

		await page
			.locator(
				`input[type="submit"][value="${hasEvents ? 'Move Them and Delete' : 'Delete Region'}"]`
			)
			.click();
	}

	for (const missing of wanted.slice(current.length)) {
		await gotoEventsAdmin(page, '&action=settings&region_action=add');
		await page.locator('input[name="region_add_name"]').fill(missing);
		await page.locator('input[type="submit"][value="Add Region"]').click();
	}

	expect(await getSetting('events_regions')).toBe(DEFAULT_REGIONS);
}

test.describe('configurable regions', () => {
	test.afterEach(async ({ page }) => {
		await restoreRegions(page);
	});

	test('adds a region, and the event form and the listing filter both offer it', async ({
		page,
	}) => {
		await gotoSettings(page);
		await addRegion(page, 'Illawarra');

		await expect(page.locator('#flash_message')).toContainText('"Illawarra" added');
		expect(await getSetting('events_regions')).toBe(`${DEFAULT_REGIONS},Illawarra`);

		// The page comes back on the settings form with the new region on it, which is the
		// point of applying the addition on the spot rather than folding it into a save.
		await expect(page.locator('input[name="region_name[4]"]')).toHaveValue('Illawarra');

		// And a region only earns its keep if an event can actually be filed under it, so
		// this goes all the way through the front-end form rather than stopping at the row.
		await loginAs(page, 'gec');
		await page.goto('/manage_event.php?action=add');
		await expect(page.locator('#event_form_region option', { hasText: 'Illawarra' })).toHaveCount(
			1
		);

		await page.goto('/events.php');
		await expect(
			page.locator('#events_region_filter option', { hasText: 'Illawarra' })
		).toHaveCount(1);
	});

	test('will not add a name it could not store, or one the board already has', async ({ page }) => {
		await gotoSettings(page);

		// Both the region list and the region => forum map are flat comma separated
		// settings, so a name carrying either separator would corrupt the entries after it.
		await addRegion(page, 'South, West');
		await expect(page.locator('.error')).toContainText('cannot contain a comma or an equals sign');
		expect(await getSetting('events_regions')).toBe(DEFAULT_REGIONS);

		await gotoSettings(page);
		await addRegion(page, 'sydney');
		await expect(page.locator('.error')).toContainText('already a region');
		expect(await getSetting('events_regions')).toBe(DEFAULT_REGIONS);
	});

	test('keeps regions whose names differ only by an accent apart', async ({ page }) => {
		await gotoSettings(page);
		await addRegion(page, 'Cafe');
		await expect(page.locator('#flash_message')).toContainText('"Cafe" added');
		await addRegion(page, 'Café');
		await expect(page.locator('#flash_message')).toContainText('"Café" added');
		expect(await getSetting('events_regions')).toBe(`${DEFAULT_REGIONS},Cafe,Café`);

		const plain = await createEvent({ title: 'Plain Cafe Troop', region: 'Cafe' });
		const accented = await createEvent({
			title: 'Accented Cafe Troop',
			region: 'Café',
		});

		// The region column compared under general_ci, which treats these as one value:
		// renaming one dragged the other's events along with it.
		await gotoSettings(page);
		await renameRegion(page, 'Cafe', 'Coffee');
		await save(page);
		await expect(page.locator('.error')).toHaveCount(0);
		expect((await getEvent(plain)).region).toBe('Coffee');
		expect((await getEvent(accented)).region).toBe('Café');

		// And deleting one found no events of its own, so skipped the step that asks where
		// they go and left them filed under a region that was gone.
		await gotoSettings(page);
		await page.locator('.events_region_delete[data-region="Café"]').click();
		await expect(page.locator('#events_region_modal_message')).toContainText(
			'1 event is associated with this region'
		);
		await modalSubmit(page).click();
		await expect(page.locator('#events_region_modal_move')).toBeVisible();
		await page.locator('#events_region_modal_move_to').selectOption('Sydney');
		await modalSubmit(page).click();

		await expect(page.locator('#flash_message')).toContainText('1 event was moved to "Sydney"');
		expect((await getEvent(accented)).region).toBe('Sydney');
		expect((await getEvent(plain)).region).toBe('Coffee');
	});

	test('renames a region to an accented spelling of its own name', async ({ page }) => {
		const eventId = await createEvent({
			title: 'Accented Region Troop',
			region: 'Canberra',
		});

		await gotoSettings(page);
		await renameRegion(page, 'Canberra', 'Cánberra');
		await save(page);

		await expect(page.locator('.error')).toHaveCount(0);
		expect(await getSetting('events_regions')).toBe('Sydney,Hunter,Cánberra,Other');
		expect((await getEvent(eventId)).region).toBe('Cánberra');
	});

	test('renames a region and its events follow it', async ({ page }) => {
		const eventId = await createEvent({
			title: 'Renamed Region Troop',
			region: 'Canberra',
		});

		await gotoSettings(page);
		await renameRegion(page, 'Canberra', 'ACT');
		await save(page);

		expect(await getSetting('events_regions')).toBe('Sydney,Hunter,ACT,Other');

		// The whole reason renaming is its own operation rather than a deletion and an
		// addition: the event keeps its place in the list instead of being orphaned.
		expect((await getEvent(eventId)).region).toBe('ACT');

		await loginAs(page, 'trooper1');
		await page.goto('/events.php?region=ACT');
		await expect(page.locator('.event_region').first()).toHaveText('ACT');
	});

	test("a rename takes the region's announcement forum with it", async ({ page }) => {
		const f = fixtures();

		await gotoSettings(page);
		await renameRegion(page, 'Hunter', 'Newcastle');
		await save(page);

		// The forum dropdowns are keyed by region name, so without remapping the rename
		// would silently unroute the region it just renamed.
		expect(await getSetting('events_event_forums')).toBe(`Newcastle=${f.forums.events_hunter}`);
	});

	test('keeps the forum of a region whose name has square brackets in it', async ({ page }) => {
		const f = fixtures();

		// PHP reads a field called event_forums[North]Coast] as event_forums[North], so a
		// dropdown named after its region handed a bracketed region's forum to a name the
		// board does not have. Both halves: a forum chosen for such a region, and one that
		// a region already had surviving an ordinary save after it gained the bracket.
		await gotoSettings(page);
		await addRegion(page, 'North]Coast');
		await expect(page.locator('#flash_message')).toContainText('"North]Coast" added');

		await page
			.locator(`#region_forum_${await rowIndex(page, 'North]Coast')}`)
			.selectOption(String(f.forums.events));
		await save(page);
		expect(await getSetting('events_event_forums')).toBe(
			`${DEFAULT_REGION_FORUMS()},North]Coast=${f.forums.events}`
		);

		await renameRegion(page, 'Hunter', '[Hunter] Valley');
		await save(page);
		await save(page);
		expect(await getSetting('events_event_forums')).toBe(
			`[Hunter] Valley=${f.forums.events_hunter},North]Coast=${f.forums.events}`
		);

		// And the dropdowns come back showing what was saved.
		await expect(
			page.locator(`#region_forum_${await rowIndex(page, '[Hunter] Valley')}`)
		).toHaveValue(String(f.forums.events_hunter));
		await expect(page.locator(`#region_forum_${await rowIndex(page, 'North]Coast')}`)).toHaveValue(
			String(f.forums.events)
		);
	});

	test('a rename rewrites the announcements of the events it moves', async ({ page }) => {
		const eventId = await createEvent({
			title: 'Renamed Announcement Troop',
			region: 'Hunter',
			status: 'live',
		});
		const threadId = await announce(eventId);

		await gotoSettings(page);
		await renameRegion(page, 'Hunter', 'Newcastle');
		await save(page);
		await expect(page.locator('#flash_message')).toContainText(
			'1 event was moved to a renamed region'
		);

		// The post names the region and links to its listing; left alone it sends readers
		// to a filter for a region that no longer exists.
		const post = await getThreadFirstPost(threadId);
		expect(post.message).toContain('events.php?region=Newcastle]Newcastle[/url]');
		expect(post.message).not.toContain('region=Hunter');

		// The region kept its forum across the rename, so the thread stays put.
		expect(Number((await getThread(threadId)).fid)).toBe(fixtures().forums.events_hunter);
	});

	test("deleting a region takes its events' announcements to the region they moved to", async ({
		page,
	}) => {
		const f = fixtures();
		const eventId = await createEvent({
			title: 'Rehomed Announcement Troop',
			region: 'Hunter',
			status: 'live',
		});
		const threadId = await announce(eventId);
		expect(Number((await getThread(threadId)).fid)).toBe(f.forums.events_hunter);

		await gotoSettings(page);
		await deleteRegion(page, 'Hunter', 'Sydney');
		await expect(page.locator('#flash_message')).toContainText('1 event was moved to "Sydney"');

		// Hunter's forum left the region map with it, so the thread is sitting in a forum the
		// plugin no longer announces into - which is exactly what a thread a moderator filed
		// by hand looks like. It has to be let out of there regardless, or no later save of
		// the event could ever move it either.
		expect(Number((await getThread(threadId)).fid)).toBe(f.forums.events);

		const post = await getThreadFirstPost(threadId);
		expect(post.message).toContain('events.php?region=Sydney]Sydney[/url]');
		expect(post.message).not.toContain('region=Hunter');
	});

	test('deletes a region with no events straight from the are-you-sure step', async ({ page }) => {
		await gotoSettings(page);

		const x = page.locator('.events_region_delete[data-region="Other"]');
		await expect(x).toHaveAttribute('data-events', '0');
		await x.click();

		await expect(page.locator('#events_region_modal_message')).toContainText(
			'No events are associated with this region.'
		);

		// No second step for a region with nothing to rehome: confirming is the deletion.
		await expect(page.locator('#events_region_modal_move')).toBeHidden();
		await modalSubmit(page).click();

		await expect(page.locator('#flash_message')).toContainText('"Other" deleted');
		expect(await getSetting('events_regions')).toBe('Sydney,Hunter,Canberra');
	});

	test("asks where a region's events go before deleting it, and moves them there", async ({
		page,
	}) => {
		const moved = await createEvent({
			title: 'Rehomed Troop',
			region: 'Canberra',
		});
		const untouched = await createEvent({
			title: 'Stayed Put Troop',
			region: 'Hunter',
		});

		await gotoSettings(page);
		await page.locator('.events_region_delete[data-region="Canberra"]').click();
		await expect(page.locator('#events_region_modal_message')).toContainText(
			'1 event is associated with this region'
		);

		// Confirming the first step is not the deletion: the event has nowhere to go yet.
		await modalSubmit(page).click();
		await expect(page.locator('#events_region_modal_move')).toBeVisible();
		expect(await getSetting('events_regions')).toBe(DEFAULT_REGIONS);

		// The region on its way out is not offered as somewhere to put its own events.
		await expect(page.locator('#events_region_modal_move_to option')).toHaveText([
			'Sydney',
			'Hunter',
			'Other',
		]);

		await page.locator('#events_region_modal_move_to').selectOption('Sydney');
		await modalSubmit(page).click();

		await expect(page.locator('#flash_message')).toContainText('1 event was moved to "Sydney"');
		expect(await getSetting('events_regions')).toBe('Sydney,Hunter,Other');

		expect((await getEvent(moved)).region).toBe('Sydney');
		expect((await getEvent(untouched)).region).toBe('Hunter');

		await loginAs(page, 'trooper1');
		await page.goto('/events.php?region=Sydney');
		await expect(page.locator('.event_link', { hasText: 'Rehomed Troop' })).toHaveCount(1);
	});

	test('backing out of the dialog changes nothing', async ({ page }) => {
		const eventId = await createEvent({
			title: 'Reprieved Troop',
			region: 'Canberra',
		});

		await gotoSettings(page);
		await page.locator('.events_region_delete[data-region="Canberra"]').click();
		await page.locator('.events_modal_cancel').click();

		await expect(modal(page)).toBeHidden();
		expect(await getSetting('events_regions')).toBe(DEFAULT_REGIONS);
		expect((await getEvent(eventId)).region).toBe('Canberra');
	});

	test('will not leave the board with no regions at all', async ({ page }) => {
		await gotoSettings(page);

		for (const region of ['Other', 'Canberra', 'Hunter']) {
			await deleteRegion(page, region);
		}

		expect(await getSetting('events_regions')).toBe('Sydney');

		await deleteRegion(page, 'Sydney');
		await expect(page.locator('.error')).toContainText('at least one region');
		expect(await getSetting('events_regions')).toBe('Sydney');
	});

	test('keeps the rest of the settings form when a region name is rejected', async ({ page }) => {
		const f = fixtures();

		await gotoSettings(page);
		await page.locator('select[name="troop_report_forum"]').selectOption(String(f.forums.general));
		await renameRegion(page, 'Canberra', 'Bad=Name');
		await save(page);

		await expect(page.locator('.error')).toContainText('cannot contain a comma or an equals sign');

		// The settings are untouched, and the form still shows the change that was about to
		// be saved alongside the bad one - otherwise one bad region name silently discards
		// everything else the admin did on the page.
		expect(await getSetting('events_regions')).toBe(DEFAULT_REGIONS);
		expect(await getSetting('events_troop_report_forum')).toBe(String(f.forums.troop_reports));
		await expect(page.locator('select[name="troop_report_forum"]')).toHaveValue(
			String(f.forums.general)
		);
	});

	test('refuses a save from a page opened before somebody else changed the regions', async ({
		page,
	}) => {
		// The page that will save, opened first...
		await gotoSettings(page);

		// ...and a second tab, same admin, that adds a region while the first sits open.
		const other = await page.context().newPage();
		await gotoEventsAdmin(other, '&action=settings');
		await addRegion(other, 'Illawarra');
		await expect(other.locator('#flash_message')).toContainText('"Illawarra" added');
		await other.close();

		// The stale page never saw Illawarra, so saving it used to write the list without
		// it - leaving anything filed under Illawarra under a region the board did not have.
		await renameRegion(page, 'Canberra', 'ACT');
		await save(page);

		await expect(page.locator('#flash_message')).toContainText(
			'This data was altered by someone else between when you loaded it and when you saved.'
		);
		expect(await getSetting('events_regions')).toBe(`${DEFAULT_REGIONS},Illawarra`);

		// It comes back on a fresh form, so reapplying the rename is saved over the list as
		// it now stands rather than over the one the refused save was based on.
		await expect(page.locator('input[name="region_name[4]"]')).toHaveValue('Illawarra');
		await renameRegion(page, 'Canberra', 'ACT');
		await save(page);

		await expect(page.locator('#flash_message')).toContainText('Settings updated successfully.');
		expect(await getSetting('events_regions')).toBe('Sydney,Hunter,ACT,Other,Illawarra');
	});

	test('a form sent back with an error still refuses to overwrite a change made meanwhile', async ({
		page,
	}) => {
		const f = fixtures();

		await gotoSettings(page);
		await renameRegion(page, 'Canberra', 'Bad=Name');
		await save(page);
		await expect(page.locator('.error')).toContainText('cannot contain a comma or an equals sign');

		// The re-rendered form still shows the values the first page loaded, so it has to
		// keep that page's token: a fresh one would let the corrected save undo this.
		const other = await page.context().newPage();
		await gotoEventsAdmin(other, '&action=settings');
		await other.locator('select[name="troop_report_forum"]').selectOption(String(f.forums.general));
		await save(other);
		await expect(other.locator('#flash_message')).toContainText('Settings updated successfully.');
		await other.close();

		await renameRegion(page, 'Canberra', 'ACT');
		await save(page);

		await expect(page.locator('#flash_message')).toContainText('altered by someone else');
		expect(await getSetting('events_regions')).toBe(DEFAULT_REGIONS);
		expect(await getSetting('events_troop_report_forum')).toBe(String(f.forums.general));

		// Put the troop report forum back; restoreRegions() only looks after the list.
		await page
			.locator('select[name="troop_report_forum"]')
			.selectOption(String(f.forums.troop_reports));
		await save(page);
		expect(await getSetting('events_troop_report_forum')).toBe(String(f.forums.troop_reports));
	});

	test('stores an event under a region the board added itself', async ({ page }) => {
		await gotoSettings(page);
		await addRegion(page, 'Illawarra');

		// The column shipped as an enum of the four regions the plugin came with, which
		// would have coerced this to '' or rejected the insert outright.
		const eventId = await createEvent({
			title: 'Illawarra Troop',
			region: 'Illawarra',
		});
		expect((await getEvent(eventId)).region).toBe('Illawarra');

		const [column] = await query(`SHOW COLUMNS FROM ${T('event_plugin_events')} LIKE 'region'`);
		expect(String((column as any).Type)).toBe('varchar(64)');
	});

	test('compares region names exactly, the way the region list in PHP does', async () => {
		// Every other text column is general_ci, which folds case and accents. The region
		// list is a list of exact strings, and a column that disagreed with it about which
		// names are the same one refiled and counted events under the wrong region.
		const [column] = await query(
			`SHOW FULL COLUMNS FROM ${T('event_plugin_events')} LIKE 'region'`
		);
		expect(String((column as any).Collation)).toBe('utf8mb4_bin');
	});

	test('the Admin CP event form offers and saves a region whose name needs escaping', async ({
		page,
	}) => {
		// A quote cut the option's value short, so the form posted a region that is not on
		// the list and refused its own event; the markup would have run as script.
		const region = 'The "Shire" <script>alert(1)</script>';
		const dialogs: string[] = [];
		page.on('dialog', (dialog) => {
			dialogs.push(dialog.message());
			void dialog.dismiss();
		});

		await gotoSettings(page);
		await addRegion(page, region);
		await expect(page.locator('#flash_message')).toContainText('added');
		expect(await getSetting('events_regions')).toBe(`${DEFAULT_REGIONS},${region}`);

		const eventId = await createEvent({ title: 'Shire Troop', region });
		await gotoEventsAdmin(page, `&action=edit&id=${eventId}`);

		await expect(page.locator('#region')).toHaveValue(region);
		await expect(page.locator('#region option', { hasText: region })).toHaveCount(1);

		await page.locator('input[type="submit"][value="Update Event"]').click();
		await expect(page.locator('#flash_message')).toContainText('Event updated successfully');
		expect((await getEvent(eventId)).region).toBe(region);
		expect(dialogs).toEqual([]);
	});
});

/**
 * The dialog is an enhancement over a pair of ordinary links, and this is the half that
 * would rot unnoticed. Without the fallback, turning JavaScript off leaves an admin
 * unable to delete a region at all - or, worse, able to reach a deletion that never
 * asked where the events went.
 */
test.describe('configurable regions without JavaScript', () => {
	test.use({ javaScriptEnabled: false });

	test.afterEach(async ({ page }) => {
		await restoreRegions(page);
	});

	test('deletes a region from a confirmation page, rehoming its events', async ({ page }) => {
		const eventId = await createEvent({
			title: 'Scriptless Troop',
			region: 'Canberra',
		});

		await gotoSettings(page);
		await page.locator('.events_region_delete[data-region="Canberra"]').click();

		await expect(page.locator('body')).toContainText('1 event is associated with this region');
		await page.locator('select[name="region_move_to"]').selectOption('Hunter');
		await page.locator('input[type="submit"][value="Move Them and Delete"]').click();

		await expect(page.locator('#flash_message')).toContainText('"Canberra" deleted');
		expect(await getSetting('events_regions')).toBe('Sydney,Hunter,Other');
		expect((await getEvent(eventId)).region).toBe('Hunter');
	});

	test('adds a region from a page of its own', async ({ page }) => {
		await gotoSettings(page);
		await page.locator('#events_region_add').click();

		await page.locator('input[name="region_add_name"]').fill('Illawarra');
		await page.locator('input[type="submit"][value="Add Region"]').click();

		await expect(page.locator('#flash_message')).toContainText('"Illawarra" added');
		expect(await getSetting('events_regions')).toBe(`${DEFAULT_REGIONS},Illawarra`);
	});
});
