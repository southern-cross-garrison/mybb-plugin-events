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

const read = (): LockContents | null => {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')) as LockContents;
  } catch {
    return null;
  }
};

/**
 * Refuse to start while another run of this suite is in flight.
 *
 * The suite is `workers: 1` because it drives one shared MyBB instance and one shared
 * faked clock, but that only serialises tests *within* a run. Nothing stopped two runs
 * from overlapping - a second terminal, an IDE test runner, a second agent session - and
 * the collision is silent and vicious: each run's global setup restores the database from
 * the snapshot and wipes `.devenv/auth` out from under the other, so tests fail with
 * `No cached login for <user>` or with assertions on rows the other run has just
 * truncated. The failures land on whichever tests happened to be running, so the suite
 * looks flaky and no single test looks broken.
 */
export function acquireSuiteLock(): void {
  fs.mkdirSync(DEVENV_DIR, { recursive: true });

  const held = read();
  if (held && held.pid !== process.pid && isAlive(held.pid)) {
    throw new Error(
      `Another run of this suite is already in flight (pid ${held.pid}, started ${held.startedAt}).\n` +
        'The suite drives one shared MyBB instance, so runs cannot overlap: both restore the\n' +
        'database and re-capture logins, and each wipes the other out mid-test.\n' +
        `Wait for it to finish, or - if it is gone - delete ${LOCK_FILE}.`,
    );
  }

  const contents: LockContents = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
  };
  fs.writeFileSync(LOCK_FILE, JSON.stringify(contents, null, 2));
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
 * Only the top-level process checks. Workers re-read the config, and by then the lock is
 * held by their own run.
 */
export function assertNoRunInFlight(): void {
  if (process.env.TEST_WORKER_INDEX !== undefined) {
    return;
  }

  const held = read();
  if (held && held.pid !== process.pid && isAlive(held.pid)) {
    throw new Error(
      `Another run of this suite is already in flight (pid ${held.pid}, started ${held.startedAt}).\n` +
        'The suite drives one shared MyBB instance, so runs cannot overlap: both restore the\n' +
        'database and re-capture logins, and each wipes the other out mid-test.\n' +
        `Wait for it to finish, or - if it is gone - delete ${LOCK_FILE}.`,
    );
  }
}
