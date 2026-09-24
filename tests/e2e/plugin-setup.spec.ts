import { test, expect } from '../helpers/fixtures';
import { loginAs, logout, loginToAdminCp, gotoEventsAdmin } from '../helpers/auth';
import { query, T, getSetting, fixtures } from '../helpers/db';

test.describe('plugin installation', () => {
  test('ships every template it renders into the master template set', async () => {
    const rows = await query(`SELECT title FROM ${T('templates')} WHERE title LIKE 'events\\_%' AND sid = -2`);
    const titles = rows.map((row: any) => row.title).sort();

    expect(titles).toEqual([
      'events_attendance',
      'events_calendar',
      'events_event',
      'events_event_card',
      'events_event_form',
      'events_list',
      'events_postbit',
      'events_rsvp_form',
      'events_rsvp_list',
      'events_rsvp_success',
      'events_troop_report',
    ]);
  });

  test('ships its stylesheet as an inheritable theme stylesheet, scoped to its own pages', async ({ page }) => {
    // Installed on the master theme (tid 1) so every theme inherits it and can override it
    // by editing its own copy - the same way the board's other plugin stylesheets work.
    const [sheet] = await query(
      `SELECT tid, attachedto FROM ${T('themestylesheets')} WHERE name = 'events.css'`,
    );
    expect(sheet?.tid).toBe(1);
    expect(sheet?.attachedto).toBe('events.php|event.php|manage_event.php|rsvp.php|troop_report.php|showthread.php');

    // A stylesheet missing from a theme's display order is silently never output, so
    // assert on the rendered page rather than just the row.
    await loginAs(page, 'trooper1');
    await page.goto('/events.php');
    await expect(page.locator('link[href*="events.css"]')).toHaveCount(1);

    await page.goto('/index.php');
    await expect(page.locator('link[href*="events.css"]')).toHaveCount(0);
  });

  test('carries the signup role column and a role-aware unique key', async () => {
    // The schema migration runs from events_activate(), so a stale snapshot is the one
    // thing that silently breaks every wrangler test. Assert it directly.
    const columns = await query(`SHOW COLUMNS FROM ${T('event_plugin_rsvps')} LIKE 'role'`);
    expect(columns).toHaveLength(1);
    expect(String((columns[0] as any).Type)).toBe("enum('trooper','wrangler')");
    expect(String((columns[0] as any).Default)).toBe('trooper');

    const index = await query(`SHOW INDEX FROM ${T('event_plugin_rsvps')} WHERE Key_name = 'event_user_role'`);
    expect(index.map((row: any) => row.Column_name)).toEqual(['event_id', 'user_id', 'role']);
    expect(Number((index[0] as any).Non_unique)).toBe(0);

    // The old one-signup-per-member key must be gone, or nobody can hold both roles.
    const legacy = await query(`SHOW INDEX FROM ${T('event_plugin_rsvps')} WHERE Key_name = 'event_user'`);
    expect(legacy).toHaveLength(0);
  });

  test('stores every text column as utf8mb4, so emoji survive', async () => {
    // Checked per column rather than per table: a table's default charset only governs
    // columns added later, and CONVERT TO is what rewrites the ones already there.
    const tables = await query(
      `SELECT table_name AS name, table_collation AS collation FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name LIKE '${T('event\\_plugin\\_%')}'`,
    );
    expect(tables).toHaveLength(8);
    for (const table of tables as any[]) {
      expect(table.collation, table.name).toMatch(/^utf8mb4_/);
    }

    const columns = await query(
      `SELECT table_name AS tbl, column_name AS col, character_set_name AS charset
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name LIKE '${T('event\\_plugin\\_%')}'
          AND character_set_name IS NOT NULL`,
    );
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns as any[]) {
      expect(column.charset, `${column.tbl}.${column.col}`).toBe('utf8mb4');
    }
  });

  test('registers the reminder task against a task file that actually exists', async () => {
    const rows = await query(`SELECT file, enabled FROM ${T('tasks')} WHERE file = 'events_reminders'`);
    expect(rows).toHaveLength(1);
    expect(Number((rows[0] as any).enabled)).toBe(1);
  });

  test('maps its settings to the provisioned profile fields, groups and forum', async () => {
    const f = fixtures();

    expect(await getSetting('events_costume_field')).toBe(String(f.profileFields.costume));
    expect(await getSetting('events_tk_id_field')).toBe(String(f.profileFields.tk_id));
    expect(await getSetting('events_event_coordinator_groups')).toBe(String(f.groups.gec));
    expect(await getSetting('events_troop_report_forum')).toBe(String(f.forums.troop_reports));

    // Event announcements are routed per region, with a board-wide fallback. A region
    // missing from the map is announced in the default forum, not silently unannounced.
    expect(await getSetting('events_event_forum')).toBe(String(f.forums.events));
    expect(await getSetting('events_event_forums')).toBe(`Hunter=${f.forums.events_hunter}`);
  });

  test('replaces the board Calendar link with an Events one', async ({ page }) => {
    await loginAs(page, 'trooper1');
    await page.goto('/index.php');

    const link = page.locator('#nav_events');
    await expect(link).toHaveText('Events');
    await expect(page.locator('a[href*="calendar.php"]')).toHaveCount(0);

    // A theme carries its menu icons inside the anchor, and the item is built by
    // rewriting Calendar's - which threw that markup away and left Events as the one
    // bare label in the row. Asserted as parity with a neighbour in the same menu rather
    // than as a named glyph, so a theme whose menu has no icons is not failed for it.
    const menu = link.locator('xpath=ancestor::ul[1]');
    const icons = (selector: string) => menu.locator(`${selector} i, ${selector} svg`).count();
    expect(await icons('#nav_events')).toBe(await icons('a[href*="memberlist.php"]'));

    await link.click();
    await expect(page).toHaveTitle(/^Events - /);
  });

  test('offers the Events link only to users who can open the page', async ({ page }) => {
    await logout(page);
    await page.goto('/index.php');

    // A guest gets neither: the events page would only turn them away, and the board
    // calendar the link replaced is gone for everybody.
    await expect(page.locator('#nav_events')).toHaveCount(0);
    await expect(page.locator('a[href*="calendar.php"]')).toHaveCount(0);
  });

  test('keeps the events pages behind a login', async ({ page }) => {
    await logout(page);
    await page.goto('/events.php');
    await expect(page.locator('body')).toContainText(/not (logged in|have permission)|Please login/i);
  });
});

test.describe('admin module', () => {
  test('exposes Events, RSVPs and Settings', async ({ page }) => {
    await loginToAdminCp(page);
    await gotoEventsAdmin(page);

    await expect(page.locator('body')).toContainText('Event Management');
    await expect(page.locator('#events_add_button')).toBeVisible();
    await expect(page.locator('a[href*="module=events&action=rsvps"]').first()).toBeVisible();
    await expect(page.locator('a[href*="module=events&action=settings"]').first()).toBeVisible();
  });

  test('settings page round-trips a change', async ({ page }) => {
    const f = fixtures();

    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=settings');

    await expect(page.locator('select[name="costume_field"]')).toHaveValue(String(f.profileFields.costume));

    await page.locator('select[name="troop_report_forum"]').selectOption(String(f.forums.general));
    await page.locator('input[type="submit"][value="Save Settings"]').click();
    await expect(page.locator('#flash_message')).toContainText('Settings updated successfully');
    expect(await getSetting('events_troop_report_forum')).toBe(String(f.forums.general));

    // Put it back so later tests still post troop reports to the right forum.
    await page.locator('select[name="troop_report_forum"]').selectOption(String(f.forums.troop_reports));
    await page.locator('input[type="submit"][value="Save Settings"]').click();
    expect(await getSetting('events_troop_report_forum')).toBe(String(f.forums.troop_reports));

    // The per-region map is one setting written from one dropdown per region, so saving
    // the form at all is what could silently drop a region's forum.
    expect(await getSetting('events_event_forum')).toBe(String(f.forums.events));
    expect(await getSetting('events_event_forums')).toBe(`Hunter=${f.forums.events_hunter}`);
  });
});
