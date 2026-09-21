import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import { createEvent, createRsvp, createTroopReport, fixtures } from '../helpers/db';
import { relativeToTestNow, setClock } from '../helpers/clock';

const TK = fixtures().costumeOptions[0];

test.describe('events listing', () => {
  test('lists live events with their region, start and RSVP count', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Listed Troop',
      region: 'Canberra',
      start: '2026-10-20 10:00:00',
      end: '2026-10-20 16:00:00',
    });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });
    await createRsvp(eventId, 'trooper2', { costumes: [TK] });

    await loginAs(page, 'gec');
    await page.goto('/events.php');

    const row = page.locator(`tr.event_row[data-event-id="${eventId}"]`);
    await expect(row.locator('.event_region')).toHaveText('Canberra');
    await expect(row.locator('.event_start')).toHaveText('Oct 20 - 10AM');
    await expect(row.locator('.event_rsvp_count')).toHaveText('2');
    await expect(row.locator('.event_status')).toHaveText('Live');
  });

  test('says so when there is nothing on', async ({ page }) => {
    await loginAs(page, 'trooper1');
    await page.goto('/events.php');
    await expect(page.locator('#events_empty')).toContainText('There are no events to show');
  });

  test('filters by region', async ({ page }) => {
    const sydney = await createEvent({ title: 'Sydney Troop', region: 'Sydney' });
    const hunter = await createEvent({ title: 'Hunter Troop', region: 'Hunter' });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php');
    await expect(page.locator('tr.event_row')).toHaveCount(2);

    // Changing the control is the whole interaction - there is no Filter button to press.
    await page.locator('#events_region_filter').selectOption('Hunter');

    await expect(page.locator(`tr[data-event-id="${hunter}"]`)).toBeVisible();
    await expect(page.locator(`tr[data-event-id="${sydney}"]`)).toHaveCount(0);
    await expect(page.locator('#events_region_filter')).toHaveValue('Hunter');
  });

  test('hides archived events until the filter asks for them', async ({ page }) => {
    // Archiving is how an event is closed out rather than how it is deleted, so the
    // record stays on the board - it just stops crowding the schedule of what is coming.
    const live = await createEvent({ title: 'Upcoming Troop' });
    const archived = await createEvent({ title: 'Finished Troop', status: 'archived' });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php');
    await expect(page.locator(`tr[data-event-id="${live}"]`)).toBeVisible();
    await expect(page.locator(`tr[data-event-id="${archived}"]`)).toHaveCount(0);
    await expect(page.locator('#events_show_archived')).not.toBeChecked();

    await page.locator('#events_show_archived').check();

    await expect(page.locator(`tr[data-event-id="${archived}"] .event_status`)).toHaveText('Archived');
    await expect(page.locator(`tr[data-event-id="${live}"]`)).toBeVisible();
    await expect(page.locator('#events_show_archived')).toBeChecked();

    // Unticking puts it back - the box is the whole of the state, so there is nothing
    // remembered to get stuck on.
    await page.locator('#events_show_archived').uncheck();
    await expect(page.locator(`tr[data-event-id="${archived}"]`)).toHaveCount(0);
  });

  test('hides archived events from coordinators and from the calendar too', async ({ page }) => {
    // The calendar runs off the same query, and a coordinator sees more statuses than a
    // member does - neither is a way round the default.
    const archived = await createEvent({
      title: 'Finished Calendar Troop',
      status: 'archived',
      start: '2026-10-20 10:00:00',
      end: '2026-10-20 16:00:00',
    });

    await loginAs(page, 'gec');
    await page.goto('/events.php');
    await expect(page.locator(`tr[data-event-id="${archived}"]`)).toHaveCount(0);

    await page.goto('/events.php?view=calendar');
    await expect(page.locator(`.calendar_event[data-event-id="${archived}"]`)).toHaveCount(0);

    await page.goto('/events.php?view=calendar&archived=1');
    await expect(page.locator(`td[data-date="2026-10-20"] .calendar_event[data-event-id="${archived}"]`)).toBeVisible();
  });

  test('an archived event is still reachable by its own URL', async ({ page }) => {
    // Hidden from the index is not hidden from the board: troop reports and old threads
    // link straight at events that are by then archived.
    const archived = await createEvent({ title: 'Linked Finished Troop', status: 'archived' });

    await loginAs(page, 'trooper1');
    await page.goto(`/event.php?id=${archived}`);
    await expect(page).toHaveTitle(/^Linked Finished Troop - /);
  });

  test('the archived filter survives the view toggle and the calendar paging', async ({ page }) => {
    const archived = await createEvent({
      title: 'November Finished Troop',
      region: 'Hunter',
      status: 'archived',
      start: '2026-11-07 10:00:00',
      end: '2026-11-07 16:00:00',
    });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php?region=Hunter&archived=1');
    await expect(page.locator('#events_show_archived')).toBeChecked();

    await page.locator('#events_view_calendar').click();
    await expect(page.locator('#events_calendar')).toBeVisible();
    await expect(page.locator('#events_region_filter')).toHaveValue('Hunter');
    await expect(page.locator('#events_show_archived')).toBeChecked();

    // Paging is anchors rather than a form, so the filters have to be on the links.
    await page.locator('#events_calendar_next').click();
    await expect(page.locator('#events_region_filter')).toHaveValue('Hunter');
    await expect(page.locator('#events_show_archived')).toBeChecked();
    await expect(page.locator(`.calendar_event[data-event-id="${archived}"]`)).toBeVisible();

    await page.locator('#events_view_list').click();
    await expect(page.locator('#events_show_archived')).toBeChecked();
    await expect(page.locator(`tr[data-event-id="${archived}"]`)).toBeVisible();
  });

  test('marks the events the viewer is signed up to', async ({ page }) => {
    const attending = await createEvent({ title: 'Attending Troop' });
    const notAttending = await createEvent({ title: 'Other Troop' });
    await createRsvp(attending, 'trooper1', { costumes: [TK] });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php');

    await expect(page.locator(`tr[data-event-id="${attending}"] .event_trooping`)).toHaveText('Trooping');
    await expect(page.locator(`tr[data-event-id="${notAttending}"] .event_signup_link`)).toBeVisible();
  });

  test('shows pending events to coordinators only', async ({ page }) => {
    const pending = await createEvent({ title: 'Pending Troop', status: 'pending' });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php');
    await expect(page.locator(`tr[data-event-id="${pending}"]`)).toHaveCount(0);

    await loginAs(page, 'gec');
    await page.goto('/events.php');
    await expect(page.locator(`tr[data-event-id="${pending}"] .event_status`)).toHaveText('Pending');
  });

  test('an address is a map link on both views, and absent when the event has none', async ({ page }) => {
    const withAddress = await createEvent({
      title: 'Address Troop',
      address: '1 Showground Rd, Sydney Olympic Park NSW 2127',
      start: '2026-10-20 10:00:00',
      end: '2026-10-20 16:00:00',
    });
    const without = await createEvent({ title: 'Addressless Troop' });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php');

    const link = page.locator(`tr[data-event-id="${withAddress}"] .event_address_link`);
    await expect(link).toHaveText('1 Showground Rd, Sydney Olympic Park NSW 2127');
    // A search rather than a pin: the address is typed, so there is nothing to point at.
    await expect(link).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=1%20Showground%20Rd%2C%20Sydney%20Olympic%20Park%20NSW%202127',
    );
    // The map opens beside the board rather than over it - a member reading the listing
    // has not finished with it.
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(page.locator(`tr[data-event-id="${without}"] .event_address_link`)).toHaveCount(0);

    await page.goto('/events.php?view=calendar');
    const cell = page.locator('td[data-date="2026-10-20"]');
    await expect(cell.locator('.calendar_event_address')).toHaveText(
      '1 Showground Rd, Sydney Olympic Park NSW 2127',
    );
    await expect(cell.locator('.calendar_event_address')).toHaveAttribute('target', '_blank');
  });

  test('the calendar view places events on their dates and spans multi-day events', async ({ page }) => {
    const single = await createEvent({
      title: 'Calendar Troop',
      start: '2026-10-20 10:00:00',
      end: '2026-10-20 16:00:00',
    });
    const spanning = await createEvent({
      title: 'Long Troop',
      start: '2026-10-24 10:00:00',
      end: '2026-10-26 16:00:00',
    });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php?view=calendar');

    await expect(page.locator('td[data-date="2026-10-20"] .calendar_event')).toHaveText('Calendar Troop');
    for (const date of ['2026-10-24', '2026-10-25', '2026-10-26']) {
      await expect(page.locator(`td[data-date="${date}"] .calendar_event[data-event-id="${spanning}"]`)).toBeVisible();
    }
    await expect(page.locator(`td[data-date="2026-10-27"] .calendar_event[data-event-id="${spanning}"]`)).toHaveCount(0);
    expect(single).toBeGreaterThan(0);
  });

  test('the calendar highlights events the viewer has RSVPed to and can be paged', async ({ page }) => {
    const eventId = await createEvent({
      title: 'November Troop',
      start: '2026-11-07 10:00:00',
      end: '2026-11-07 16:00:00',
    });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php?view=calendar');

    // October by default: the November event is not on this page.
    await expect(page.locator(`.calendar_event[data-event-id="${eventId}"]`)).toHaveCount(0);

    await page.locator('#events_calendar_next').click();
    await expect(page.locator(`.calendar_event[data-event-id="${eventId}"]`)).toHaveClass(/rsvped/);
  });

  test('the calendar opens on the month the clock is in', async ({ page }) => {
    await setClock('2027-02-10 09:00:00');
    const eventId = await createEvent({
      title: 'February Troop',
      start: '2027-02-14 10:00:00',
      end: '2027-02-14 16:00:00',
    });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php?view=calendar');

    await expect(page.locator(`td[data-date="2027-02-14"] .calendar_event[data-event-id="${eventId}"]`)).toBeVisible();
  });

  test('the toolbar offers the view you are not looking at, and carries the filter across', async ({ page }) => {
    await createEvent({ title: 'Hunter Troop', region: 'Hunter' });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php?region=Hunter');

    await expect(page.locator('#events_view_calendar')).toHaveText('Calendar');
    await expect(page.locator('#events_view_list')).toHaveCount(0);

    await page.locator('#events_view_calendar').click();

    await expect(page.locator('#events_calendar')).toBeVisible();
    await expect(page.locator('#events_region_filter')).toHaveValue('Hunter');
    await expect(page.locator('#events_view_list')).toHaveText('List');
    await expect(page.locator('#events_view_calendar')).toHaveCount(0);

    await page.locator('#events_view_list').click();

    await expect(page.locator('#events_calendar')).toHaveCount(0);
    await expect(page.locator('#events_region_filter')).toHaveValue('Hunter');
  });

  test('the view toggle sits at the right of the toolbar and carries an icon', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/events.php');

    const toggle = page.locator('#events_view_calendar');
    await expect(toggle).toHaveText('Calendar');
    await expect(page.locator('.events_toolbar #events_view_calendar')).toHaveCount(1);

    // Hard right, past everything else the toolbar is carrying.
    const toolbarBox = (await page.locator('.events_toolbar').boundingBox())!;
    const createBox = (await page.locator('#events_create').boundingBox())!;
    const toggleBox = (await toggle.boundingBox())!;
    expect(toggleBox.x).toBeGreaterThan(createBox.x + createBox.width);
    expect(toolbarBox.x + toolbarBox.width - (toggleBox.x + toggleBox.width)).toBeLessThan(4);

    // The icon is painted in the bar's own colour, so it is a mask rather than a picture
    // with a colour baked into it - and it has to actually resolve to one.
    const icon = toggle.locator('.events_view_icon');
    const mask = await icon.evaluate((el) => {
      const style = getComputedStyle(el);
      return style.maskImage || (style as unknown as Record<string, string>).webkitMaskImage;
    });
    expect(mask).toContain('svg');
    const iconBox = (await icon.boundingBox())!;
    expect(iconBox.width).toBeGreaterThan(8);

    await page.goto('/events.php?view=calendar');
    await expect(page.locator('.events_toolbar #events_view_list')).toHaveText('List');
  });

  test('the calendar names its month on the stepper rather than in a heading of its own', async ({ page }) => {
    // The board draws the page's heading from the breadcrumb; the plugin adding a second
    // bar under it said "Events" twice on the list and "Events Calendar" on the calendar.
    await loginAs(page, 'trooper1');
    await page.goto('/events.php?view=calendar');

    await expect(page.locator('.events_month_name')).toHaveText('October 2026');
    await expect(page.locator('#events_page .thead')).toHaveCount(0);
    await expect(page.locator('#events_page')).not.toContainText('Events Calendar -');

    // The arrows are glyphs, so their names have to be somewhere a screen reader reads.
    await expect(page.locator('#events_calendar_prev')).toHaveAttribute('aria-label', 'Previous month');
    await expect(page.locator('#events_calendar_next')).toHaveAttribute('aria-label', 'Next month');

    await page.locator('#events_calendar_next').click();
    await expect(page.locator('.events_month_name')).toHaveText('November 2026');
  });

  test('the filters still carry a submit button for a browser with no script', async ({ page }) => {
    // The bar applies a filter as it is changed, which takes a script; the page has to
    // work without one, so the button it replaces is still in the markup.
    await loginAs(page, 'trooper1');
    await page.goto('/events.php');

    const html = await page.content();
    expect(html).toMatch(/<noscript>[^]*?value="Filter"[^]*?<\/noscript>/);

    // And it is genuinely not in the page for anybody running the script.
    await expect(page.locator('input[value="Filter"]')).toHaveCount(0);
  });

  test('opens in the view the member last used, per account', async ({ page }) => {
    await loginAs(page, 'trooper1');
    await page.goto('/events.php');
    await page.locator('#events_view_calendar').click();
    await expect(page.locator('#events_calendar')).toBeVisible();

    // A bare events.php - the navigation link, a bookmark - comes back to the calendar.
    await page.goto('/events.php');
    await expect(page.locator('#events_calendar')).toBeVisible();

    // Another member's preference is their own.
    await loginAs(page, 'trooper2');
    await page.goto('/events.php');
    await expect(page.locator('#events_calendar')).toHaveCount(0);

    await loginAs(page, 'trooper1');
    await page.goto('/events.php');
    await page.locator('#events_view_list').click();
    await page.goto('/events.php');
    await expect(page.locator('#events_calendar')).toHaveCount(0);
    await expect(page.locator('#events_view_calendar')).toBeVisible();
  });

  test('links from the list through to the event page', async ({ page }) => {
    const eventId = await createEvent({ title: 'Clickable Troop', start: relativeToTestNow({ days: 9 }) });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php');
    await page.locator(`tr[data-event-id="${eventId}"] .event_link`).click();

    await expect(page).toHaveTitle(/^Clickable Troop - /);
    await expect(page.locator('#event_page')).toHaveAttribute('data-event-id', String(eventId));
  });

  test.describe('the status column', () => {
    /** An event that ran and finished, with the clock already past its end date. */
    const finished = (title: string, status?: 'live' | 'archived' | 'pending') =>
      createEvent({
        title,
        status,
        start: relativeToTestNow({ days: -2 }),
        end: relativeToTestNow({ days: -1 }),
        signupCutoff: relativeToTestNow({ days: -3 }),
      });

    const status = (page: Page, eventId: number) =>
      page.locator(`tr[data-event-id="${eventId}"] .event_status`);

    test('tells a finished event waiting on its troop report from one already written up', async ({ page }) => {
      const unreported = await finished('Unreported Troop');
      const reported = await finished('Reported Troop');
      await createTroopReport(reported);
      // A row with no posted_at is not a report: events_send_reminders() writes one for
      // an event that has none at all, purely to record when it last nagged about it.
      const nagged = await finished('Nagged Troop');
      await createTroopReport(nagged, { posted: false });
      // Still to come, so nobody owes a report on it yet.
      const upcoming = await createEvent({ title: 'Upcoming Troop' });
      // Archiving is how an event is closed out, so an archived one is not outstanding
      // work whatever its report says.
      const closed = await finished('Closed Troop', 'archived');
      const draft = await createEvent({ title: 'Draft Troop', status: 'pending' });

      await loginAs(page, 'gec');
      await page.goto('/events.php?archived=1');

      await expect(status(page, unreported)).toHaveText('Needs Troop Report');
      await expect(status(page, nagged)).toHaveText('Needs Troop Report');
      // Neither of the two labels the stored column cannot express is reachable by an
      // event that has not happened yet.
      await expect(status(page, reported)).toHaveText('Complete');
      await expect(status(page, upcoming)).toHaveText('Live');
      await expect(status(page, closed)).toHaveText('Archived');
      await expect(status(page, draft)).toHaveText('Pending');
    });

    test('reads the same on the event page as it does in the list', async ({ page }) => {
      const unreported = await finished('Unwritten Troop');
      const reported = await finished('Written Up Troop');
      await createTroopReport(reported);

      await loginAs(page, 'gec');
      await page.goto('/events.php');
      await expect(status(page, unreported)).toHaveText('Needs Troop Report');
      await expect(status(page, reported)).toHaveText('Complete');

      await page.goto(`/event.php?id=${unreported}`);
      await expect(page.locator('#event_status')).toHaveText('Needs Troop Report');
      // And the stored value is still there for anything matching on it.
      await expect(page.locator('#event_page')).toHaveAttribute('data-event-status', 'live');

      await page.goto(`/event.php?id=${reported}`);
      await expect(page.locator('#event_status')).toHaveText('Complete');
    });

    test('leaves the stored status on the row for anything matching on it', async ({ page }) => {
      // The column reads as a label now, so the enum value the board filters and sorts
      // by stays where it was rather than having to be parsed back out of the text.
      const unreported = await finished('Machine Readable Troop');

      await loginAs(page, 'trooper1');
      await page.goto('/events.php');

      const row = page.locator(`tr.event_row[data-event-id="${unreported}"]`);
      await expect(row).toHaveAttribute('data-event-status', 'live');
      await expect(row.locator('.event_status')).toHaveText('Needs Troop Report');
    });
  });

  test.describe('on a narrow screen', () => {
    // 390px is a phone held upright; the table gives way to cards below 992px, so this
    // covers the tablet half of that range as well.
    test.use({ viewport: { width: 390, height: 900 } });

    test('lays each event out as a card', async ({ page }) => {
      const eventId = await createEvent({
        title: 'Pocket Troop',
        address: '3 Flushcombe Rd, Blacktown NSW 2148',
      });

      await loginAs(page, 'trooper1');
      await page.goto('/events.php');

      const row = page.locator(`tr.event_row[data-event-id="${eventId}"]`);
      await expect(row).toHaveCSS('display', 'grid');
      // The headings name columns that no longer exist.
      await expect(page.locator('.events_list_head')).toBeHidden();

      // Every value the table shows is still on the card, and the address has the whole
      // width of it rather than a column a third that wide.
      await expect(row.locator('.event_link')).toHaveText('Pocket Troop');
      await expect(row.locator('.event_address')).toBeVisible();
      await expect(row.locator('.event_start')).toBeVisible();
      await expect(row.locator('.event_region')).toHaveText('Sydney');
      await expect(row.locator('.event_status')).toHaveText('Live');
      await expect(row.locator('.event_signup_link')).toBeVisible();

      // Nothing runs off the side of the screen, which is the whole point of the change.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    });

    test('folds the filters behind a Filter button so the view switch fits the row', async ({ page }) => {
      await createEvent({ title: 'Filtered Troop' });

      await loginAs(page, 'gec');
      await page.goto('/events.php');

      await expect(page.locator('.events_filter_button')).toBeVisible();
      await expect(page.locator('#events_filter_form')).toBeHidden();
      // The point of folding them away: these keep their place on the row.
      await expect(page.locator('#events_view_calendar')).toBeVisible();
      await expect(page.locator('#events_create')).toBeVisible();

      await page.locator('.events_filter_button').click();
      await expect(page.locator('#events_filter_form')).toBeVisible();
      await expect(page.locator('#events_region_filter')).toBeVisible();
      await expect(page.locator('#events_show_archived')).toBeVisible();

      // And the filters still apply from inside the panel.
      await page.locator('#events_region_filter').selectOption('Hunter');
      await expect(page.locator('#events_region_filter')).toHaveValue('Hunter');
    });

    test('opens the panel already open when the page is filtered', async ({ page }) => {
      // Otherwise a filtered listing looks like a listing that is simply missing events.
      await loginAs(page, 'trooper1');
      await page.goto('/events.php?region=Hunter');

      await expect(page.locator('#events_filter_form')).toBeVisible();
      await expect(page.locator('#events_region_filter')).toHaveValue('Hunter');
    });

    test('carries the panel onto the calendar too', async ({ page }) => {
      await loginAs(page, 'trooper1');
      await page.goto('/events.php?view=calendar');

      await expect(page.locator('#events_calendar')).toBeVisible();
      await expect(page.locator('.events_filter_button')).toBeVisible();
      await expect(page.locator('#events_filter_form')).toBeHidden();

      await page.locator('.events_filter_button').click();
      await expect(page.locator('#events_region_filter')).toBeVisible();
    });
  });

  test('stays a table with its filters on the row on a full-width screen', async ({ page }) => {
    // The default viewport is 1280 wide, which is above the 992px the cards start at.
    const eventId = await createEvent({ title: 'Desktop Troop' });

    await loginAs(page, 'gec');
    await page.goto('/events.php');

    await expect(page.locator(`tr.event_row[data-event-id="${eventId}"]`)).toHaveCSS('display', 'table-row');
    await expect(page.locator('.events_list_head')).toBeVisible();
    await expect(page.locator('#events_filter_form')).toBeVisible();
    await expect(page.locator('.events_filter_button')).toBeHidden();
  });
});
