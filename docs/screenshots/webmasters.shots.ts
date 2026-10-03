/**
 * Screenshots for the webmasters' guide (docs/src/content/docs/webmasters/).
 *
 *   pnpm screenshots webmasters   # from docs/
 */
import { test, expect } from '../../tests/helpers/fixtures';
import { gotoEventsAdmin, loginToAdminCp } from '../../tests/helpers/auth';
import { runPhp } from '../../tests/helpers/container';
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
      const row = page.locator('tr', { hasText: 'Event Management' }).first();
      const install = row.getByRole('link', { name: 'Install & Activate' });
      await expect(install).toBeVisible();
      await ring(install);
      await shot(page.locator('table.general').first(), 'webmasters/plugins-activate');
    } finally {
      await restoreInstalled();
    }
  });

  test('settings page', async ({ page }) => {
    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=settings');
    await shot(page.locator('#content'), 'webmasters/settings-page');
  });
});
