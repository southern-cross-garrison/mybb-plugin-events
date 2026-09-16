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
      'events_list',
      'events_rsvp_form',
      'events_rsvp_list',
      'events_rsvp_success',
      'events_troop_report',
    ]);
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
  });

  test('adds an Events link to the board navigation', async ({ page }) => {
    await loginAs(page, 'trooper1');
    await page.goto('/index.php');

    const link = page.locator('#nav_events');
    await expect(link).toHaveText('Events');
    await link.click();
    await expect(page).toHaveTitle(/^Events - /);
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
  });
});
