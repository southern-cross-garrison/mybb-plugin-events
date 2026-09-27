import fs from 'fs';
import path from 'path';
import { test, expect } from '../helpers/fixtures';
import { execute, query, T } from '../helpers/db';
import { runPhp } from '../helpers/container';
import { FORUM_DIR } from '../helpers/config';

/**
 * Schema upgrades are one file each in inc/plugins/events/upgrades/, run oldest first and
 * recorded so that each runs once. Activation runs them on an installed board, and a
 * fresh install runs them on top of the frozen baseline schema, so both reach the
 * current schema by the same steps.
 *
 * The upgrades here are written into the deployed forum for the test and removed after;
 * each one logs its name to a scratch table, which is what shows whether and in what
 * order it ran.
 */

const UPGRADES_DIR = path.join(FORUM_DIR, 'inc/plugins/events/upgrades');
const NAMES = ['9990_e2e_first', '9991_e2e_second'];
const LOG = T('e2e_upgrade_log');

function writeUpgrade(name: string): void {
  fs.writeFileSync(
    path.join(UPGRADES_DIR, `${name}.php`),
    `<?php
return function($db) {
    $db->write_query("CREATE TABLE IF NOT EXISTS ${LOG} (name varchar(64) NOT NULL)");
    $db->write_query("INSERT INTO ${LOG} (name) VALUES ('${name}')");
};
`,
  );
}

async function upgrade(): Promise<void> {
  await runPhp(`
require_once MYBB_ROOT.'inc/plugins/events/inc/events_install.php';
events_upgrade_database();
`);
}

async function ran(): Promise<string[]> {
  return (await query(`SELECT name FROM ${LOG}`)).map((row: any) => row.name);
}

async function recorded(): Promise<string[]> {
  const rows = await query(
    `SELECT name FROM ${T('event_plugin_schema_upgrades')} WHERE name IN (?, ?) ORDER BY name`,
    NAMES,
  );
  return rows.map((row: any) => row.name);
}

test.describe('schema upgrades', () => {
  test.beforeEach(async () => {
    await execute(`CREATE TABLE IF NOT EXISTS ${LOG} (name varchar(64) NOT NULL)`);
  });

  test.afterEach(async () => {
    for (const name of NAMES) {
      fs.rmSync(path.join(UPGRADES_DIR, `${name}.php`), { force: true });
    }
    await execute(`DELETE FROM ${T('event_plugin_schema_upgrades')} WHERE name IN (?, ?)`, NAMES);
    await execute(`DROP TABLE IF EXISTS ${LOG}`);
  });

  test('runs each new upgrade once, oldest first', async () => {
    // Written newest first, so the order they run in comes from their names.
    writeUpgrade(NAMES[1]);
    writeUpgrade(NAMES[0]);

    await upgrade();
    expect(await ran()).toEqual(NAMES);
    expect(await recorded()).toEqual(NAMES);

    await upgrade();
    expect(await ran()).toEqual(NAMES);
  });

  test('runs only the upgrades a board has not had', async () => {
    writeUpgrade(NAMES[0]);
    await upgrade();

    writeUpgrade(NAMES[1]);
    await upgrade();

    expect(await ran()).toEqual(NAMES);
  });

  test('a fresh install runs every upgrade on top of the baseline', async () => {
    NAMES.forEach(writeUpgrade);

    // The whole install, not just the tables: what is under test is that installing
    // takes the same path to the current schema that activating does. Everything else it
    // does is also done by every activation, so running it on an installed board is safe.
    await runPhp(`
require_once MYBB_ROOT.'inc/plugins/events.php';
events_install();
`);

    expect(await ran()).toEqual(NAMES);
    expect(await recorded()).toEqual(NAMES);
  });
});
