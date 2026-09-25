import fs from 'node:fs';
import path from 'node:path';
import { DEVENV_DIR } from './config';

const LOCK_FILE = path.join(DEVENV_DIR, 'suite.lock');

interface LockContents {
  pid: number;
  startedAt: string;
  cwd: string;
}

const isAlive = (pid: number): boolean => {
  try {
    // Signal 0 performs the permission and existence checks without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const read = (file = LOCK_FILE): LockContents | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as LockContents;
  } catch {
    return null;
  }
};

const inFlight = (held: LockContents): Error =>
  new Error(
    `Another run of this suite is already in flight (pid ${held.pid}, started ${held.startedAt}).\n` +
      'The suite drives one shared MyBB instance, so runs cannot overlap: both restore the\n' +
      'database and re-capture logins, and each wipes the other out mid-test.\n' +
      `Wait for it to finish: while kill -0 ${held.pid} 2>/dev/null; do sleep 15; done`,
  );

/**
 * Create the lock file holding these contents, unless one already exists.
 *
 * Written whole to a file of our own and then hard-linked into place, because link() fails
 * when the name is taken - so the check and the claim are one step, and nobody ever reads a
 * lock that has been created but not yet written.
 */
function createExclusively(contents: string): boolean {
  const pending = `${LOCK_FILE}.${process.pid}.pending`;
  fs.writeFileSync(pending, contents);
  try {
    fs.linkSync(pending, LOCK_FILE);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  } finally {
    fs.rmSync(pending, { force: true });
  }
}

/**
 * Take a dead run's lock out of the way.
 *
 * Moved aside and read there rather than deleted by name: two runs can find the same dead
 * lock, and by the time the slower one deletes it the faster one may have put its own in
 * its place. If what was moved turns out to belong to a live run, it goes back.
 */
function removeDeadLock(): void {
  const aside = `${LOCK_FILE}.${process.pid}.dead`;
  try {
    fs.renameSync(LOCK_FILE, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }

  const moved = read(aside);
  if (moved && moved.pid !== process.pid && isAlive(moved.pid)) {
    try {
      fs.linkSync(aside, LOCK_FILE);
    } catch {
      // Somebody claimed the name in the meantime; theirs stands.
    }
  }
  fs.rmSync(aside, { force: true });
}

/**
 * Claim the suite for this run, or refuse to start while another run is in flight.
 *
 * The suite is `workers: 1` because it drives one shared MyBB instance and one shared
 * faked clock, but that only serialises tests *within* a run. Nothing stopped two runs
 * from overlapping - a second terminal, an IDE test runner, a second agent session - and
 * the collision is silent and vicious: each run's global setup restores the database from
 * the snapshot and wipes `.devenv/auth` out from under the other, so tests fail with
 * `No cached login for <user>` or with assertions on rows the other run has just
 * truncated. The failures land on whichever tests happened to be running, so the suite
 * looks flaky and no single test looks broken.
 *
 * The claim is atomic. It used to read the lock and then write it, and sessions queued on
 * the same pid all start the moment it exits - so two of them read "free" in the same
 * second, both wrote, and both went on to restore the database at once. A lock whose owner
 * has died is taken over.
 */
export function acquireSuiteLock(): void {
  fs.mkdirSync(DEVENV_DIR, { recursive: true });

  const lock: LockContents = { pid: process.pid, startedAt: new Date().toISOString(), cwd: process.cwd() };
  const contents = JSON.stringify(lock, null, 2);

  for (let attempt = 0; attempt < 5; attempt++) {
    if (createExclusively(contents)) {
      return;
    }

    const held = read();
    if (held?.pid === process.pid) {
      return;
    }
    if (held && isAlive(held.pid)) {
      throw inFlight(held);
    }

    removeDeadLock();
  }

  throw new Error(`Could not claim ${LOCK_FILE}: it kept reappearing, held by runs that were not alive.`);
}

/** Drop the lock, but never somebody else's. */
export function releaseSuiteLock(): void {
  const held = read();
  if (held && held.pid !== process.pid) {
    return;
  }
  fs.rmSync(LOCK_FILE, { force: true });
}

/**
 * Detect a run already in flight, without claiming the lock.
 *
 * `acquireSuiteLock()` runs from global setup, which is too late to be the only guard:
 * Playwright empties `outputDir` as it starts up, *before* global setup, so a second run
 * deletes the trace files the first one is still writing and fails it with ENOENT even
 * though the lock stopped it touching the database. This is called from
 * playwright.config.ts, which is read before any of that happens.
 *
 * Only a check, and not the claim, because the config is not only loaded to run the suite:
 * an editor's test explorer loads it to list the tests and then sits idle, and a claim made
 * there would hold the suite for as long as the editor is open. Two runs can still both
 * pass this in the same instant; the atomic claim in global setup is what stops the second
 * one before it touches anything, and at that point the first has not yet written output
 * of its own for the second to have emptied.
 *
 * Only the top-level process checks. Workers re-read the config, and by then the lock is
 * held by their own run.
 */
export function assertNoRunInFlight(): void {
  if (process.env.TEST_WORKER_INDEX !== undefined) {
    return;
  }

  const held = read();
  if (held && held.pid !== process.pid && isAlive(held.pid)) {
    throw inFlight(held);
  }
}
