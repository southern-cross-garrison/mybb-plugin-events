import { expect, Page } from '@playwright/test';
import { test } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import { createEvent, createRsvp, getEventDays, fixtures } from '../helpers/db';

const TK = fixtures().costumeOptions[0];

/**
 * Elements that are still laid out but sit outside the plugin's page.
 *
 * Asserted as a query rather than by naming the theme's header and footer, because that
 * is exactly what the stylesheet refuses to do: the print rules keep .events_page_wrap
 * and the ancestors holding it in the document, and drop everything else. Whatever
 * markup a theme wraps the page in, the answer in print has to be nothing.
 */
async function chromeStillShowing(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const wrap = document.querySelector('.events_page_wrap');
    if (!wrap) {
      return ['no .events_page_wrap on the page'];
    }

    return [...document.body.querySelectorAll('*')]
      .filter((el) => !wrap.contains(el) && !el.contains(wrap))
      .filter((el) => !['SCRIPT', 'STYLE', 'LINK'].includes(el.tagName))
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ''));
  });
}

test.describe('printing a plugin page', () => {
  test('drops the board chrome and shows the compact masthead instead', async ({ page }) => {
    const eventId = await createEvent({ title: 'Printable Troop', region: 'Canberra' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}&action=attendance`);

    // On screen the board is all still there and the masthead is not.
    expect(await chromeStillShowing(page)).not.toEqual([]);
    await expect(page.locator('.events_print_header')).toBeHidden();

    await page.emulateMedia({ media: 'print' });

    expect(await chromeStillShowing(page)).toEqual([]);
    await expect(page.locator('.events_print_header')).toBeVisible();
    await expect(page.locator('.events_print_board')).toHaveText('MyBB Events Test Forum - Attendance Sheet');
    await expect(page.locator('.events_print_title')).toHaveText('Printable Troop');
    await expect(page.locator('.events_print_meta')).toHaveText(/Canberra .+ 1 attendee$/);

    // The sheet itself survives, without the controls that only work in a browser.
    await expect(page.locator('#attendance_table')).toBeVisible();
    await expect(page.locator('#attendance_print')).toBeHidden();
    await expect(page.locator('tr.attendee_row')).toHaveCount(1);
  });

  test('brands the masthead with a ribbon that will actually print', async ({ page }) => {
    const eventId = await createEvent({ title: 'Branded Troop' });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}&action=attendance`);
    await page.emulateMedia({ media: 'print' });

    const ribbon = await page.evaluate(() => {
      const el = document.querySelector('.events_print_ribbon')!;
      const style = getComputedStyle(el);
      const logo = el.querySelector('.events_print_logo');
      return {
        background: style.backgroundColor,
        // Without this a browser drops the fill and the white text with it, and the
        // ribbon prints as white on white.
        colorAdjust: style.printColorAdjust || (style as any).webkitPrintColorAdjust,
        text: getComputedStyle(el.querySelector('.events_print_board')!).color,
        // The mark is a print-only background image, so that a reader who never prints
        // never downloads it. This is the whole chain: setting -> custom property -> CSS.
        logo: logo ? getComputedStyle(logo).backgroundImage : '',
      };
    });

    expect(ribbon.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(ribbon.colorAdjust).toBe('exact');
    expect(ribbon.text).toBe('rgb(255, 255, 255)');
    // The logo comes from the Print Logo setting, falling back to the theme's own.
    expect(ribbon.logo).toContain('scg-logo.svg');
  });

  test('carries a masthead on every page the plugin renders', async ({ page }) => {
    const eventId = await createEvent({ title: 'Masthead Troop' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await loginAs(page, 'gec');
    await page.emulateMedia({ media: 'print' });

    for (const path of [
      '/events.php',
      '/events.php?view=calendar',
      `/event.php?id=${eventId}`,
      `/event.php?id=${eventId}&action=attendance`,
      `/rsvp.php?id=${eventId}`,
    ]) {
      await page.goto(path);
      await expect(page.locator('.events_print_header'), path).toBeVisible();
      expect(await chromeStillShowing(page), path).toEqual([]);
    }
  });

  test('prints the attendance ticks a coordinator made on screen', async ({ page }) => {
    const eventId = await createEvent({ title: 'Ticked Troop' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });
    await createRsvp(eventId, 'trooper2', { costumes: [TK] });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}&action=attendance`);

    // The last column is a box to tick, not a line to sign. Named on the identity row,
    // which is the one the grid is built from - the contact row below it is laid over
    // those same columns and has no last column of its own.
    await expect(page.locator('#attendance_table thead .attendance_identity_head th').last()).toHaveText('Attended');
    await expect(page.locator('tr.attendee_row .attendee_tick')).toHaveCount(2);
    await expect(page.locator('tr.attendee_row .attendee_tick').first()).not.toBeChecked();

    const ticked = page.locator('tr.attendee_row').first().locator('.attendee_tick');
    await ticked.check();

    await page.emulateMedia({ media: 'print' });

    // The print is taken from the live page, so the tick has to still be set and the box
    // has to still be drawn - and its fill has to survive a print that drops backgrounds.
    await expect(ticked).toBeChecked();
    await expect(ticked).toBeVisible();
    await expect(page.locator('tr.attendee_row').nth(1).locator('.attendee_tick')).not.toBeChecked();

    const adjust = await ticked.evaluate((el) => {
      const style = getComputedStyle(el);
      return style.printColorAdjust || (style as any).webkitPrintColorAdjust;
    });
    expect(adjust).toBe('exact');
  });

  test('repeats the attendance header across sheets and keeps rows whole', async ({ page }) => {
    const eventId = await createEvent({ title: 'Paginated Troop' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}&action=attendance`);
    await page.emulateMedia({ media: 'print' });

    const table = await page.evaluate(() => {
      const head = getComputedStyle(document.querySelector('#attendance_table thead')!);
      // An attendee is a <tbody> holding two rows, and it is the pair that must not be
      // broken: a page split between them puts somebody's phone number on the next sheet
      // with nothing on it saying whose.
      const group = getComputedStyle(document.querySelector('#attendance_table tbody.attendee_group')!);
      const row = getComputedStyle(document.querySelector('#attendance_table tbody tr')!);
      return { head: head.display, groupBreak: group.breakInside, rowBreak: row.breakInside };
    });

    expect(table.head).toBe('table-header-group');
    expect(table.groupBreak).toBe('avoid');
    expect(table.rowBreak).toBe('avoid');
  });

  test('hides the filters and signup buttons but keeps what the reader signed up for', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Filtered Print Troop',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const [saturday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));
    await createRsvp(eventId, 'trooper1', { costumes: [TK], dayIds: [saturday] });

    await loginAs(page, 'trooper1');
    await page.goto(`/event.php?id=${eventId}`);
    await page.emulateMedia({ media: 'print' });

    await expect(page.locator('#event_signup_status_trooper')).toBeVisible();
    await expect(page.locator('#event_signup_update')).toBeHidden();
    await expect(page.locator('#event_ical')).toBeHidden();

    await page.goto('/events.php');
    await expect(page.locator('.events_toolbar')).toBeHidden();
    await expect(page.locator('#events_region_filter')).toBeHidden();
    await expect(page.locator(`tr[data-event-id="${eventId}"]`)).toBeVisible();
  });
});
