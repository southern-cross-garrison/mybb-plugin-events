import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../helpers/fixtures';
import { loginAs, logout, loginToAdminCp, gotoEventsAdmin } from '../helpers/auth';
import { query, T, getSetting, fixtures } from '../helpers/db';
import { runPhp } from '../helpers/container';
import { REPO_ROOT } from '../helpers/config';

test.describe('plugin installation', () => {
  test('ships every template it renders into the master template set', async () => {
    const rows = await query(`SELECT title FROM ${T('templates')} WHERE title LIKE 'events\\_%' AND sid = -2`);
    const titles = rows.map((row: any) => row.title).sort();

    expect(titles).toEqual([
      'events_attendance',
      'events_calendar',
      'events_calendar_feed',
      'events_event',
      'events_event_card',
      'events_event_form',
      'events_list',
      'events_postbit',
      'events_remove_signup',
      'events_rsvp_form',
      'events_rsvp_list',
      'events_rsvp_success',
      'events_troop_report',
      'events_usercp_calendar_feed',
      'events_usercp_troops',
    ]);
  });

  test('ships its stylesheet as an inheritable theme stylesheet, scoped to its own pages', async ({ page }) => {
    // Installed on the master theme (tid 1) so every theme inherits it and can override it
    // by editing its own copy - the same way the board's other plugin stylesheets work.
    const [sheet] = await query(
      `SELECT tid, attachedto FROM ${T('themestylesheets')} WHERE name = 'events.css'`,
    );
    expect(sheet?.tid).toBe(1);
    expect(sheet?.attachedto).toBe('events.php|event.php|manage_event.php|rsvp.php|troop_report.php|calendar_feed.php|usercp.php|showthread.php');

    // A stylesheet missing from a theme's display order is silently never output, so
    // assert on the rendered page rather than just the row.
    await loginAs(page, 'trooper1');
    await page.goto('/events.php');
    await expect(page.locator('link[href*="events.css"]')).toHaveCount(1);

    await page.goto('/index.php');
    await expect(page.locator('link[href*="events.css"]')).toHaveCount(0);
  });

  test("re-activation brings a theme's own copy of events.css up to the page list, keeping its CSS", async ({ page }) => {
    // A theme that customises an inherited stylesheet gets its own themestylesheets row -
    // same name, the theme's tid, and its *own* attachedto - and MyBB serves that copy in
    // place of the master's. Activation rewrites the master row, so without also touching
    // the copies, a page added to EVENTS_STYLESHEET_ATTACHEDTO would render unstyled on
    // exactly the themes that bothered to skin the plugin. Built on the board's default
    // (the garrison theme), since that is the theme the rendered-page check runs against.
    const [master] = await query(
      `SELECT attachedto FROM ${T('themestylesheets')} WHERE name = 'events.css' AND tid = 1`,
    );
    const attachedto = String(master.attachedto);
    const [theme] = await query(`SELECT tid, stylesheets, properties FROM ${T('themes')} WHERE def = 1`);
    const tid = Number(theme.tid);
    expect(tid).not.toBe(1);

    // Only restore-exactly is safe if a copy is already there; this board ships none, so
    // the test owns the row it makes and refuses to run over somebody else's.
    const existing = await query(
      `SELECT sid FROM ${T('themestylesheets')} WHERE name = 'events.css' AND tid = ?`, [tid],
    );
    expect(existing, 'the default theme already has its own events.css').toHaveLength(0);

    // The stale list is the current one minus a page, as if the copy was made before that
    // page existed. calendar_feed.php renders for any member, so it can be fetched below.
    const stale = attachedto.split('|').filter((script) => script !== 'calendar_feed.php').join('|');
    expect(stale).not.toBe(attachedto);
    // No quotes or dollars, so it can be embedded in the PHP below as-is.
    const themeCss = `/* e2e theme copy of events.css */\n.events_page_wrap { outline: 1px solid #123456; }\n`;

    const settingsBefore = await query(
      `SELECT name, value FROM ${T('settings')} WHERE name LIKE 'events\\_%' ORDER BY name`,
    );

    try {
      // Written the way the Admin CP stylesheet editor writes one: the row, its flat cache
      // file, then the theme's stylesheet list, which is what global.php actually reads.
      await runPhp(`
require_once MYBB_ROOT.'admin/inc/functions_themes.php';
$css = ${JSON.stringify(themeCss)};
$db->insert_query('themestylesheets', array(
  'name' => 'events.css',
  'tid' => ${tid},
  'attachedto' => $db->escape_string(${JSON.stringify(stale)}),
  'stylesheet' => $db->escape_string($css),
  'cachefile' => 'events.css',
  'lastmodified' => TIME_NOW,
));
cache_stylesheet(${tid}, 'events.css', $css);
update_theme_stylesheet_list(${tid}, false, true);
`);

      // Precondition: the copy really is what the theme serves, and it really is stale.
      // Without these the assertions after activation could pass against the master's row.
      await loginAs(page, 'trooper1');
      await page.goto('/events.php');
      await expect(page.locator(`link[href*="theme${tid}/events.css"]`)).toHaveCount(1);
      await page.goto('/calendar_feed.php');
      await expect(page.locator('link[href*="events.css"]')).toHaveCount(0);

      // Activation exactly as scripts/provision.php runs it: the plugin file at global
      // scope (it registers hooks there), then events_activate().
      await runPhp(`
require_once MYBB_ROOT.'inc/plugins/events.php';
events_activate();
`);

      const [copy] = await query(
        `SELECT attachedto, stylesheet FROM ${T('themestylesheets')} WHERE name = 'events.css' AND tid = ?`, [tid],
      );
      expect(copy, "activation removed the theme's copy").toBeTruthy();
      expect(copy.attachedto).toBe(attachedto);
      // The page list is the plugin's to own; the CSS is the theme's. Overwriting it would
      // throw away the very customisation that made the theme keep a copy.
      expect(copy.stylesheet).toBe(themeCss);

      // And the page itself: the list only matters once it reaches the theme's built
      // stylesheet list, which is a separate column that has to be rebuilt.
      await page.goto('/calendar_feed.php');
      const link = page.locator('link[href*="events.css"]');
      await expect(link).toHaveCount(1);
      const href = await link.getAttribute('href');
      const served = await page.request.get(new URL(href!, page.url()).toString());
      expect(await served.text()).toContain('e2e theme copy of events.css');

      // Activation also re-syncs templates and tops up settings, as it does on every
      // provision. That must leave every setting the board has already chosen alone.
      const settingsAfter = await query(
        `SELECT name, value FROM ${T('settings')} WHERE name LIKE 'events\\_%' ORDER BY name`,
      );
      expect(settingsAfter).toEqual(settingsBefore);
    } finally {
      // A stray stylesheet row, cache file or stylesheet list would restyle every later
      // test on this shared board, so put all three back: drop the copy and its cache
      // files, rebuild the theme's list from what is left, then restore the theme row's
      // two built columns byte-for-byte from before the test.
      await runPhp(`
require_once MYBB_ROOT.'admin/inc/functions_themes.php';
$db->delete_query('themestylesheets', "name = 'events.css' AND tid = ${tid}");
@unlink(MYBB_ROOT.'cache/themes/theme${tid}/events.css');
@unlink(MYBB_ROOT.'cache/themes/theme${tid}/events.min.css');
update_theme_stylesheet_list(${tid}, false, true);
`);
      await query(`UPDATE ${T('themes')} SET stylesheets = ?, properties = ? WHERE tid = ?`, [
        theme.stylesheets,
        theme.properties,
        tid,
      ]);
    }
  });

  test('carries the signup role column and a role-aware unique key', async () => {
    // The schema migration runs from events_activate(), so a stale snapshot is the one
    // thing that silently breaks every wrangler test. Assert it directly.
    const columns = await query(`SHOW COLUMNS FROM ${T('event_plugin_rsvps')} LIKE 'role'`);
    expect(columns).toHaveLength(1);
    // attendee is a social event's one role (upgrade 0002).
    expect(String((columns[0] as any).Type)).toBe("enum('trooper','wrangler','attendee')");
    expect(String((columns[0] as any).Default)).toBe('trooper');

    const type = await query(`SHOW COLUMNS FROM ${T('event_plugin_events')} WHERE Field IN ('event_type', 'max_attendees')`);
    expect(type.map((row: any) => [row.Field, String(row.Type), String(row.Default)])).toEqual([
      ['event_type', "enum('troop','social')", 'troop'],
      ['max_attendees', 'int(10) unsigned', '0'],
    ]);

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
    expect(tables).toHaveLength(12);
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
    expect(await getSetting('events_legion_id_field')).toBe(String(f.profileFields.legion_id));
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
  test('exposes Events, RSVPs, Reports and Settings', async ({ page }) => {
    await loginToAdminCp(page);
    await gotoEventsAdmin(page);

    await expect(page.locator('body')).toContainText('Event Management');
    await expect(page.locator('#events_add_button')).toBeVisible();
    await expect(page.locator('a[href*="module=events&action=rsvps"]').first()).toBeVisible();
    await expect(page.locator('a[href*="module=events&action=reports"]').first()).toBeVisible();
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

  test('ships the licence and NOTICE, and credits and licenses the plugin on the Support tab', async ({ page }) => {
    // The release zip is plugin/, so the root copies GitHub reads never reach a board.
    // The packaged ones are what Apache 2.0 requires a redistributed copy to carry.
    for (const file of ['LICENSE', 'NOTICE']) {
      expect(
        fs.readFileSync(path.join(REPO_ROOT, 'plugin/inc/plugins/events', file), 'utf8'),
        `plugin/inc/plugins/events/${file} differs from the root ${file}`,
      ).toBe(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    }

    await loginToAdminCp(page);
    await gotoEventsAdmin(page);
    await page.locator('.nav_tabs a[href*="action=support"], #submenu a[href*="action=support"]').first().click();
    await page.waitForLoadState('domcontentloaded');

    const support = page.locator('.events_support');
    await expect(support.locator('a[href="https://www.501st.com/member/33151/"]')).toHaveText('Kevin Brown (TK-33151)');
    await expect(support.locator('a[href="https://www.501scg.org/"]')).toHaveText('Southern Cross Garrison');
    await expect(support.locator('a[href="https://events-guide.501scg.org/"]')).toBeVisible();
    await expect(
      support.locator('a[href="https://github.com/southern-cross-garrison/mybb-plugin-events/issues"]'),
    ).toBeVisible();
    // Rendered, not shown as typed.
    await expect(support).not.toContainText('[b]');

    // The tab says in MyCode what NOTICE says in plain text; the copyright line is the
    // part that changes, so it is the one held to the file.
    const copyright = fs.readFileSync(path.join(REPO_ROOT, 'NOTICE'), 'utf8')
      .split('\n').find((line) => line.startsWith('Copyright'));
    expect(copyright).toBeTruthy();
    const licence = page.locator('.events_licence');
    await expect(licence).toContainText(copyright!);
    await expect(licence.locator('a[href="http://www.apache.org/licenses/LICENSE-2.0"]')).toHaveText('Apache License, Version 2.0');
  });
});
