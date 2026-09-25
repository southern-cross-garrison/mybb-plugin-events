import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { gotoEventsAdmin, loginAs, loginToAdminCp, logout } from '../helpers/auth';
import { createEvent, createRsvp, fixtures, getSetting, getThreadFirstPost } from '../helpers/db';
import { runPhp } from '../helpers/container';
import { relativeToTestNow } from '../helpers/clock';
import { withSettings } from '../helpers/settings';

/**
 * title-escaping.spec.ts covers the one field everybody thinks of. These are the three
 * free-text values that travel just as far and get thought about less:
 *
 * - a region is typed into the Admin CP settings page, and from there is an <option> on
 *   every event form, a filter on the listing, a cell in the Admin CP list, a line on the
 *   event card and the printed sheet, and a key in the announcement-forum map;
 * - an address is typed by a coordinator and goes out as a Google Maps link, so it has to
 *   survive being both an attribute (URL-encoded) and a link's text (HTML-escaped);
 * - a costume comes off a member's profile field, which on a board with a free-text
 *   costume field is whatever the member typed, and is shown to the coordinator.
 *
 * Each carries a value that would do damage in any of the ways a page gets escaping
 * wrong: markup, both kinds of quote (an attribute break-out), an ampersand (which is
 * what shows up as "&amp;amp;" when a value is escaped twice) and a script. It must come
 * out as exactly the text that went in - not merely harmless. The last commit before
 * these tests fixed a double escape, and "no script ran" passes against a page that shows
 * "&lt;b&gt;" to its reader.
 *
 * The payload carries no comma and no equals sign on purpose: a region cannot contain
 * either (they are the separators of the region list and the Region=fid forum map, and
 * events_admin_region_name_error() refuses them), and a costume cannot contain a comma
 * (events_parse_costumes() splits on it). A script that sets its flag without an `=` is
 * the price of one payload that is legal in all three.
 *
 * The User CP page the plugin adds (usercp.php?action=events_calendar) shows none of the
 * three - it is the feed link and its controls - so it is not visited here. health.spec.ts
 * renders it.
 */

const HOSTILE = `<b>x</b> "q" 'a' & <script>window.__pwned++</script>`;
// A prefix apiece, so a failure says which field it was. REGION stays inside the
// varchar(64) the region column is.
const REGION = `Rgn ${HOSTILE}`;
const ADDRESS = `1 Main St ${HOSTILE}`;
const COSTUME = `TK ${HOSTILE}`;

const FORUMS = fixtures().forums;

/**
 * The value went in and nothing it carried came out as markup.
 *
 * `window.__pwned++` turns an undefined flag into NaN, so any run of it shows. The bold
 * and script checks are for markup that got into the DOM without running - an injected
 * <script> after the page has loaded never runs, and would pass the first check alone.
 * The Admin CP settings page legitimately carries the region list inside a script as a
 * JSON string, which is why a script is only counted when the payload *is* its body.
 *
 * The entity check is the double-escape one: a correctly escaped page decodes every
 * entity once, so its text never contains one. Scripts and styles are dropped first,
 * since their source is not text anybody reads.
 */
async function expectInert(page: Page, where: string): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned), `${where}: the payload's script ran`).toBeUndefined();

  const found = await page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('script, style, noscript').forEach((node) => node.remove());
    const text = clone.textContent ?? '';
    return {
      bold: [...document.querySelectorAll('b')].filter((node) => node.textContent === 'x').length,
      script: [...document.querySelectorAll('script')].filter((node) => (node.textContent ?? '').trim() === 'window.__pwned++').length,
      entities: [...new Set(text.match(/&(?:amp|lt|gt|quot|#0*39|#x0*27);/g) ?? [])],
    };
  });

  expect(found.bold, `${where}: an injected <b> made it into the page`).toBe(0);
  expect(found.script, `${where}: an injected <script> made it into the page`).toBe(0);
  expect(found.entities, `${where}: an entity is showing as text, which is a value escaped twice`).toEqual([]);
}

/**
 * The address's map link: its text is the address exactly, and its href is the Maps
 * search for it, URL-encoded so nothing in it can close the attribute or add one.
 *
 * `attributes` is the full set the anchor may carry - an attribute break-out shows up as
 * one more. The plugin's own link and MyBB's [url] in the generated post write different
 * ones, so each caller says which it expects.
 */
async function expectMapLink(link: Locator, attributes: string[]): Promise<void> {
  await expect(link).toHaveText(ADDRESS);

  const href = (await link.getAttribute('href')) ?? '';
  expect(href, 'the map link should be URL-encoded').not.toMatch(/[<>"' ]/);
  const url = new URL(href);
  expect(`${url.origin}${url.pathname}`).toBe('https://www.google.com/maps/search/');
  expect(url.searchParams.get('query')).toBe(ADDRESS);

  expect(await link.evaluate((node) => node.getAttributeNames().sort())).toEqual([...attributes].sort());
}

const PLUGIN_LINK_ATTRIBUTES = ['class', 'href', 'target', 'rel'];

/** Announce an event the way saving it live does, and return its thread id. */
async function announce(eventId: number): Promise<number> {
  // The language file a front-end page loads in global.php and runPhp() does not; posting
  // writes subscription notices from it.
  const output = await runPhp(`
$lang->load('messages');
require_once MYBB_ROOT.'inc/plugins/events/inc/events_thread.php';
echo events_sync_event_thread(${eventId});
`);

  const threadId = Number(output.trim());
  expect(threadId, output).toBeGreaterThan(0);

  return threadId;
}

/** Every element matching `selector` whose attribute `name` is exactly `value`. */
async function countWithAttribute(page: Page, selector: string, name: string, value: string): Promise<number> {
  return page.locator(selector).evaluateAll(
    (nodes, [attribute, expected]) => nodes.filter((node) => node.getAttribute(attribute) === expected).length,
    [name, value],
  );
}

test.describe('region, address and costume values', () => {
  let restoreSettings: (() => Promise<void>) | null = null;

  /**
   * The region list is a setting, so a hostile region has to be put on it - and given a
   * forum in the Region=fid map, which is keyed by the name, or the announcement would
   * fall back to the default forum and the map's own handling of the name would go
   * untested. Restored after every test, pass or fail: regions.spec.ts asserts the list
   * is the default.
   */
  test.beforeEach(async () => {
    const regions = await getSetting('events_regions');
    const forums = await getSetting('events_event_forums');
    restoreSettings = await withSettings({
      events_regions: `${regions},${REGION}`,
      events_event_forums: [forums, `${REGION}=${FORUMS.events_hunter}`].filter(Boolean).join(','),
    });
  });

  test.afterEach(async () => {
    await restoreSettings?.();
    restoreSettings = null;
  });

  test('are shown as typed on the events listing, its region filter and the calendar', async ({ page }) => {
    const hostileId = await createEvent({ title: 'Hostile Values Troop', region: REGION, address: ADDRESS });
    const otherId = await createEvent({ title: 'Sydney Values Troop', region: 'Sydney' });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php');

    const row = page.locator(`tr.event_row[data-event-id="${hostileId}"]`);
    await expect(row.locator('.event_region')).toHaveText(REGION);
    await expectMapLink(row.locator('.event_address a'), PLUGIN_LINK_ATTRIBUTES);

    // The filter's option carries the name as both its value and its label, and picking
    // it has to filter on the name as typed - an option whose value was escaped once too
    // often would submit "&lt;b&gt;..." and match nothing.
    expect(await countWithAttribute(page, '#events_region_filter option', 'value', REGION)).toBe(1);
    await expectInert(page, 'events.php');

    await page.locator('#events_region_filter').selectOption({ label: REGION });
    await page.waitForURL(/region=/);
    await expect(page.locator('#events_region_filter')).toHaveValue(REGION);
    await expect(page.locator(`tr.event_row[data-event-id="${hostileId}"]`)).toHaveCount(1);
    await expect(page.locator(`tr.event_row[data-event-id="${otherId}"]`)).toHaveCount(0);
    // The filter rides across to the calendar in a hidden field, and onto the printed
    // header as a line of text.
    expect(await countWithAttribute(page, '.events_view_form input[name="region"]', 'value', REGION)).toBe(1);
    await expect(page.locator('.events_print_meta')).toContainText(REGION);
    await expectInert(page, 'events.php, filtered to the region');

    await page.locator('#events_view_calendar').click();
    await page.waitForURL(/view=calendar/);
    await expect(page.locator('#events_region_filter')).toHaveValue(REGION);
    const cell = page.locator(`td:has(a.calendar_event[data-event-id="${hostileId}"])`);
    await expectMapLink(cell.locator('.calendar_event_address'), PLUGIN_LINK_ATTRIBUTES);
    await expect(page.locator('.events_print_meta')).toContainText(REGION);

    // Previous and Next are plain links that spell the filter out in their query string.
    const pager = page.locator('a[href*="view=calendar"][href*="region="]').first();
    const pagerHref = (await pager.getAttribute('href')) ?? '';
    expect(new URL(pagerHref, page.url()).searchParams.get('region')).toBe(REGION);
    await expectInert(page, 'events.php?view=calendar, filtered to the region');
  });

  test('are shown as typed on the event card in the announcement thread, and in the post guests read', async ({ page }) => {
    const eventId = await createEvent({ title: 'Hostile Card Troop', region: REGION, address: ADDRESS });
    await createRsvp(eventId, 'trooper1', { costumes: [COSTUME] });
    const threadId = await announce(eventId);
    const firstPost = await getThreadFirstPost(threadId);

    // Announced into the forum the map gives the hostile name, not the fallback.
    const thread = await runPhp(`echo (int)get_thread(${threadId})['fid'];`);
    expect(Number(thread)).toBe(FORUMS.events_hunter);

    await loginAs(page, 'gec');
    await page.goto(`/showthread.php?tid=${threadId}`);
    await expect(page.locator('#event_page')).toHaveCount(1);
    await expect(page.locator('#event_region')).toHaveText(REGION);
    await expectMapLink(page.locator('#event_address a'), PLUGIN_LINK_ATTRIBUTES);
    await expect(page.locator('#rsvp_rows .rsvp_costumes')).toHaveText(COSTUME);
    await expect(page.locator('.events_print_meta')).toContainText(REGION);
    await expect(page.locator('.events_print_meta')).toContainText(ADDRESS);
    await expectInert(page, 'the event card');

    // Filtering the signup list by the costume: the box gives back what was typed, and
    // the filter still finds the signup that holds it.
    await page.goto(`/showthread.php?tid=${threadId}&filter_costume=${encodeURIComponent(COSTUME)}`);
    await expect(page.locator('#filter_costume')).toHaveValue(COSTUME);
    await expect(page.locator('#rsvp_rows .rsvp_row')).toHaveCount(1);
    await expectInert(page, 'the event card, filtered by the costume');

    // A guest gets the generated BBCode post instead of the card. The region links to the
    // listing filtered to it, and the address to the map - both through MyBB's [url].
    await logout(page);
    await page.goto(`/showthread.php?tid=${threadId}`);
    const post = page.locator(`#pid_${firstPost.pid}`);
    const regionLink = post.locator('a', { hasText: REGION });
    await expect(regionLink).toHaveCount(1);
    await expect(regionLink).toHaveText(REGION);
    expect(new URL((await regionLink.getAttribute('href')) ?? '').searchParams.get('region')).toBe(REGION);
    const mapLink = post.locator('a[href*="google.com/maps"]');
    await expect(mapLink).toHaveCount(1);
    await expectMapLink(mapLink, await mapLink.evaluate((node) => node.getAttributeNames()));
    await expectInert(page, 'the announcement post, as a guest');
  });

  test('are shown as typed on the attendance sheet, the troop report and the front-end event form', async ({ page }) => {
    const upcoming = await createEvent({ title: 'Hostile Sheet Troop', region: REGION, address: ADDRESS });
    await createRsvp(upcoming, 'trooper1', { costumes: [COSTUME] });

    const finished = await createEvent({
      title: 'Hostile Report Troop',
      region: REGION,
      address: ADDRESS,
      start: relativeToTestNow({ days: -2 }),
      end: relativeToTestNow({ days: -1 }),
      signupCutoff: relativeToTestNow({ days: -3 }),
    });
    await createRsvp(finished, 'trooper1', { costumes: [COSTUME] });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${upcoming}&action=attendance`);
    await expect(page.locator('td.attendee_costumes')).toHaveText(COSTUME);
    await expect(page.locator('.events_print_meta')).toContainText(REGION);
    await expect(page.locator('.events_print_meta')).toContainText(ADDRESS);
    await expectInert(page, 'the attendance sheet');

    await page.goto(`/manage_event.php?id=${upcoming}`);
    await expect(page.locator('#event_form_region')).toHaveValue(REGION);
    await expect(page.locator('#event_form_region option:checked')).toHaveText(REGION);
    await expect(page.locator('#event_form_address')).toHaveValue(ADDRESS);
    await expectInert(page, 'manage_event.php');

    // The draft is BBCode in a textarea, so the value has to come back out of the box as
    // typed: escaped once for the HTML, and not a second time.
    await loginAs(page, 'trooper1');
    await page.goto(`/troop_report.php?id=${finished}`);
    const draft = await page.locator('#troop_report_content').inputValue();
    expect(draft).toContain(`[b]Region:[/b] ${REGION}`);
    expect(draft).toContain(COSTUME);
    await expectInert(page, 'troop_report.php');
  });

  test('are shown as typed in the Admin CP', async ({ page }) => {
    const eventId = await createEvent({ title: 'Hostile Admin Troop', region: REGION, address: ADDRESS });
    await createRsvp(eventId, 'trooper1', { costumes: [COSTUME] });

    await loginToAdminCp(page);

    await gotoEventsAdmin(page);
    const row = page.locator(`tr:has(a[href$="event.php?id=${eventId}"])`);
    await expect(row.locator('td', { hasText: REGION })).toHaveText(REGION);
    await expectInert(page, 'the Admin CP events list');

    await gotoEventsAdmin(page, `&action=edit&id=${eventId}`);
    await expect(page.locator('#region')).toHaveValue(REGION);
    await expect(page.locator('#region option:checked')).toHaveText(REGION);
    await expect(page.locator('#address')).toHaveValue(ADDRESS);
    await expectInert(page, 'the Admin CP event form');

    await gotoEventsAdmin(page, `&action=rsvps&event_id=${eventId}`);
    await expect(page.locator('td', { hasText: COSTUME }).first()).toHaveText(COSTUME);
    await expectInert(page, 'the Admin CP RSVP list');

    // The settings page's region list: the rename box, the forum the map gives it (on the
    // same row, under the same index), and the X that deletes it.
    await gotoEventsAdmin(page, '&action=settings');
    expect(await countWithAttribute(page, 'input[name^="region_original["]', 'value', REGION)).toBe(1);
    expect(await page.locator('input[name^="region_name["]').evaluateAll((nodes, expected) => nodes.filter((node) => (node as HTMLInputElement).value === expected).length, REGION)).toBe(1);
    const rowIndex = await page
      .locator('input[name^="region_original["]')
      .evaluateAll((nodes, expected) => {
        const node = nodes.find((n) => (n as HTMLInputElement).value === expected);
        return node?.getAttribute('name')?.match(/\[(\d+)\]/)?.[1];
      }, REGION);
    await expect(
      page.locator(`select[name="event_forums[${rowIndex}]"]`),
      "the region's forum select should sit on its row and show the forum the map gives it",
    ).toHaveValue(String(FORUMS.events_hunter));
    expect(await countWithAttribute(page, 'a.events_region_delete', 'data-region', REGION)).toBe(1);
    expect(await countWithAttribute(page, 'a.events_region_delete', 'aria-label', `Delete ${REGION}`)).toBe(1);
    await expectInert(page, 'the Admin CP settings page');

    // The X opens the confirmation dialog, which writes the name in with textContent.
    const deleteLink = page.locator('a.events_region_delete');
    const index = await deleteLink.evaluateAll((nodes, expected) => nodes.findIndex((node) => node.getAttribute('data-region') === expected), REGION);
    const hostileDelete = deleteLink.nth(index);
    const deleteHref = (await hostileDelete.getAttribute('href')) ?? '';
    await hostileDelete.click();
    await expect(page.locator('#events_region_modal_title')).toHaveText(`Delete ${REGION}`);
    await expect(page.locator('#events_region_modal_message')).toContainText(`"${REGION}"`);
    await expectInert(page, 'the region delete dialog');
    await page.locator('#events_region_modal .events_modal_cancel').click();

    // And the page the X links to without a script: the name has to arrive through the
    // query string intact to be found at all, and it is then a heading, a sentence and a
    // hidden field.
    await page.goto(new URL(deleteHref, page.url()).toString());
    await expect(page.locator('body')).toContainText(`Delete ${REGION}`);
    await expect(page.locator('body')).toContainText(`Deleting "${REGION}" cannot be undone.`);
    expect(await countWithAttribute(page, 'input[type="hidden"][name="region"]', 'value', REGION)).toBe(1);
    await expectInert(page, 'the region delete confirmation page');
  });
});
