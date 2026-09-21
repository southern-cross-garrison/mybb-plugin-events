import { runPhp } from './container';
import { getSetting } from './db';

/**
 * Change plugin settings the way the Admin CP does.
 *
 * MyBB serves $mybb->settings from the generated inc/settings.php rather than from the
 * settings table, so a row written with plain SQL is invisible to every page until
 * something calls rebuild_settings(). That is the whole reason this goes through PHP in
 * the container instead of through tests/helpers/db.ts.
 *
 * Driving the Admin CP form would be the other way, and regions.spec.ts does exactly
 * that - but only because the form itself is what those tests are about. Everywhere
 * else the setting is a precondition, not the subject, and a test that had to fill in
 * every control on the settings page to blank one forum would break every time a
 * control was added to it.
 */
export async function setSettings(values: Record<string, string>): Promise<void> {
  const assignments = Object.entries(values)
    .map(
      ([name, value]) =>
        `$db->update_query('settings', array('value' => $db->escape_string('${value.replace(/'/g, "\\'")}')), "name = '${name}'");`,
    )
    .join('\n');

  await runPhp(`
${assignments}
rebuild_settings();
`);
}

/**
 * Read a setting, change it, and hand back the call that puts it as it was.
 *
 * Used as a per-test teardown so a spec that fails halfway still leaves the board on the
 * baseline's settings for the tests after it.
 */
export async function withSettings(values: Record<string, string>): Promise<() => Promise<void>> {
  const previous: Record<string, string> = {};
  for (const name of Object.keys(values)) {
    previous[name] = await getSetting(name);
  }

  await setSettings(values);

  return async () => {
    await setSettings(previous);
  };
}
