import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { ALL_USERS, captureLoginState } from './helpers/auth';
import { BASE_URL, DEVENV_DIR, FORUM_DIR, REPO_ROOT } from './helpers/config';
import { resetClock, readContainerClock } from './helpers/clock';
import { snapshotUserFields, snapshotBoardContent, closeDb } from './helpers/db';
import { acquireSuiteLock } from './helpers/suite-lock';
import { installLegionApiStub } from './helpers/legion-api';

const run = promisify(execFile);

export default async function globalSetup(): Promise<void> {
	// Before anything is restored or wiped, so a second run bounces off rather than
	// trampling the one already going.
	acquireSuiteLock();

	await assertEnvironmentIsUp();

	// Start every run from the provisioned snapshot so leftovers from a previous run
	// (or a hand-driven poke at the dev forum) cannot influence results.
	await run('./scripts/db-restore.sh', [], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });

	await resetClock();

	// Provisioning points the plugin at this rather than at the real 501st API.
	installLegionApiStub();

	// Profile fields are mutated by the RSVP prerequisites tests; keep a pristine copy.
	await snapshotUserFields();
	// And the forums, which every test that posts a thread adds to.
	await snapshotBoardContent();
	await closeDb();

	fs.rmSync(path.join(DEVENV_DIR, 'auth'), { recursive: true, force: true });
	for (const user of ALL_USERS) {
		await captureLoginState(user);
	}
}

async function assertEnvironmentIsUp(): Promise<void> {
	const hint = 'Run ./scripts/bootstrap.sh first (see README).';

	if (!fs.existsSync(path.join(FORUM_DIR, 'events-fixtures.json'))) {
		throw new Error(`Fixture map missing from ${FORUM_DIR}. ${hint}`);
	}

	if (!fs.existsSync(path.join(DEVENV_DIR, 'snapshot.sql'))) {
		throw new Error(`Database snapshot missing from ${DEVENV_DIR}. ${hint}`);
	}

	try {
		const response = await fetch(`${BASE_URL}/index.php`);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
	} catch (error) {
		throw new Error(`Could not reach ${BASE_URL} (${(error as Error).message}). ${hint}`);
	}

	// The clock probe is what every timing test depends on; fail loudly and early if the
	// faketime plumbing is not in place.
	await readContainerClock();
}
