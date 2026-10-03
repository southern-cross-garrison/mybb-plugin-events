/**
 * Screenshots for the webmasters' guide (docs/src/content/docs/webmasters/).
 *
 *   pnpm screenshots webmasters   # from docs/
 */
import { test, expect } from '../../tests/helpers/fixtures';
import { gotoEventsAdmin, loginAs, loginToAdminCp } from '../../tests/helpers/auth';
import { createEvent, createRsvp, fixtures, queryOne, T, uid } from '../../tests/helpers/db';
import { relativeToTestNow } from '../../tests/helpers/clock';
import type { RowDataPacket } from 'mysql2/promise';
import { runPhp, runScheduledTask } from '../../tests/helpers/container';
import { ring, shot } from './annotate';

/**
 * Make the Plugins page show Event Management as a board that has never installed it
 * would see it, without uninstalling - which would drop every table and setting the rest
 * of the run depends on.
 *
 * MyBB offers "Install & Activate" when the plugin's _is_installed() is false, and that
 * checks for the events table, so the table is renamed out of the way. The plugin also
 * comes off the active list first, so none of its hooks run against the missing table
 * while the page renders. restoreInstalled() puts both back.
 */
async function hideInstalled(): Promise<void> {
  await runPhp(`
$plugins = $cache->read('plugins');
unset($plugins['active']['events']);
$cache->update('plugins', $plugins);
$db->write_query("RENAME TABLE ".TABLE_PREFIX."event_plugin_events TO ".TABLE_PREFIX."event_plugin_events_docs");
`);
}

async function restoreInstalled(): Promise<void> {
  await runPhp(`
if($db->table_exists('event_plugin_events_docs')) {
  $db->write_query("RENAME TABLE ".TABLE_PREFIX."event_plugin_events_docs TO ".TABLE_PREFIX."event_plugin_events");
}
$plugins = $cache->read('plugins');
$plugins['active']['events'] = 'events';
$cache->update('plugins', $plugins);
`);
}

test.describe('webmasters', () => {
  test('plugins page before installing', async ({ page }) => {
    await loginToAdminCp(page);
    await hideInstalled();

    try {
      await page.goto('/admin/index.php?module=config-plugins');
      // MyBB lists active and inactive plugins in separate tables, so the link is found by
      // where it goes, and the table and row are the ones around it.
      const install = page.locator('a[href*="action=activate"][href*="plugin=events&"]');
      await expect(install).toBeVisible();
      await ring(install);
      // Keep the plugin's name in the picture, so it's clear which row the link is on.
      await shot(install.locator('xpath=ancestor::table[1]'), 'webmasters/plugins-activate', {
        include: [install.locator('xpath=ancestor::tr[1]/td[1]')],
      });
    } finally {
      await restoreInstalled();
    }
  });

  test('settings page', async ({ page }) => {
    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=settings');
    await shot(page.locator('#content'), 'webmasters/settings-page');
  });

  test('plugin controls: deactivate and uninstall', async ({ page }) => {
    await loginToAdminCp(page);
    await page.goto('/admin/index.php?module=config-plugins');
    // Event Management is in the Active Plugins table; its links are found by where they go.
    const deactivate = page.locator('a[href*="action=deactivate"][href*="plugin=events&"]:not([href*="uninstall=1"])');
    const uninstall = page.locator('a[href*="uninstall=1"][href*="plugin=events&"]');
    const table = deactivate.locator('xpath=ancestor::table[1]');
    const name = deactivate.locator('xpath=ancestor::tr[1]/td[1]');

    await ring(deactivate);
    await shot(table, 'webmasters/plugins-deactivate', { include: [name] });

    await ring(uninstall);
    await shot(table, 'webmasters/plugins-uninstall', { include: [name] });
  });

  test('custom profile fields', async ({ page }) => {
    await loginToAdminCp(page);
    await page.goto('/admin/index.php?module=config-profile_fields&action=add');
    // As set on the private fields.
    await page.locator('input[name="viewableby"][value="none"]').check();
    await ring(page.locator('#row_viewableby'), page.locator('#row_editableby'));
    await shot(page.locator('#content'), 'webmasters/profile-field-visibility');
  });

  test('settings page, a group at a time', async ({ page }) => {
    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=settings');
    const content = page.locator('#content');
    const row = (control: string) => page.locator(control).locator('xpath=ancestor::tr[1]');

    await ring(row('#timezone'));
    await shot(content, 'webmasters/settings-timezone');

    await ring(row('select[name="costume_field"]'), row('select[name="legion_id_field"]'));
    await shot(content, 'webmasters/settings-profile-fields-costumes');

    await ring(
      row('#wwcc_field'),
      row('select[name="mobile_field"]'),
      row('select[name="emergency_contact_field"]'),
      row('select[name="preferred_name_field"]'),
    );
    await shot(content, 'webmasters/settings-profile-fields-contact');

    await ring(
      row('#event_coordinator_groups'),
      row('select[name="garrison_members_group"]'),
      row('select[name="501st_members_group"]'),
    );
    await shot(content, 'webmasters/settings-groups');

    await ring(row('#troop_report_forum'), row('#event_forum'));
    await shot(content, 'webmasters/settings-forums');
  });

  test('print logo setting', async ({ page }) => {
    const group = await queryOne<RowDataPacket>(`SELECT gid FROM ${T('settinggroups')} WHERE name = 'events'`);
    await loginToAdminCp(page);
    await page.goto(`/admin/index.php?module=config-settings&action=change&gid=${group!.gid}`);
    await ring(page.locator('#setting_events_print_logo').locator('xpath=ancestor::tr[1]'));
    await shot(page.locator('#content'), 'webmasters/settings-print-logo');
  });

  test('reminder task and its message', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Westfield Parramatta Charity Troop',
      start: relativeToTestNow({ days: -3 }),
      end: relativeToTestNow({ days: -2 }),
    });
    await createRsvp(eventId, 'trooper1', { costumes: [fixtures().costumeOptions[0]] });

    await loginToAdminCp(page);
    await page.goto('/admin/index.php?module=tools-tasks');
    await ring(page.locator('tr', { hasText: 'Event Reminder PMs' }).last());
    await shot(page.locator('#content'), 'webmasters/task-manager');

    // The message a trooper gets.
    await runScheduledTask('events_reminders');
    const pm = await queryOne<RowDataPacket>(
      `SELECT pmid FROM ${T('privatemessages')} WHERE uid = ? AND subject LIKE 'Troop Report Needed%' ORDER BY pmid DESC LIMIT 1`,
      [uid('trooper1')],
    );
    await loginAs(page, 'trooper1');
    await page.goto(`/private.php?action=read&pmid=${pm!.pmid}`);
    await ring(page.getByText(/Troop Report Needed/).first());
    await shot(page.locator('body'), 'webmasters/reminder-message', { minWidth: 900, minHeight: 420 });
  });

  test('theming: the accent colour', async ({ page }) => {
    await createEvent({ title: 'Royal North Shore Hospital Visit', start: { days: 5 }, end: { days: 5, hours: 4 } });
    await createEvent({ title: 'Westfield Parramatta Charity Troop', start: { days: 9 }, end: { days: 9, hours: 6 } });
    await createEvent({ title: 'Garrison Christmas Dinner', eventType: 'social', start: { days: 23 }, end: { days: 23, hours: 4 } });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php?view=list');
    await shot(page.locator('#events_page'), 'webmasters/theming-before');

    // What a theme's stylesheet would declare.
    await page.addStyleTag({
      content: ':root { --events-accent: #b3261e; --events-accent-border: #b3261e; --events-accent-soft: rgba(179, 38, 30, 0.18); }',
    });
    await shot(page.locator('#events_page'), 'webmasters/theming-after');
  });
});
