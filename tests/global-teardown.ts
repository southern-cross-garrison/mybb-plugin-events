import { resetClock, readContainerClock } from './helpers/clock';
import { alignUserActivityToClock, closeDb } from './helpers/db';

/**
 * Hand the dev environment back in a state a human can browse.
 *
 * The suite spends its life with the container clock faked forward, and MyBB stamps
 * users.lastactive with that faked time on every page view. Dropping the clock back to
 * real time without moving those stamps leaves them in the future, and MyBB's shutdown
 * handler then adds a negative number to users.timeonline - an UNSIGNED column - so the
 * next page view dies with "BIGINT UNSIGNED value is out of range". Left alone that
 * outlasts the run: the forum is unusable in a browser until the next db-restore.sh.
 *
 * Per-file afterAll hooks are not enough on their own, because a hook declared in a
 * shared helper module registers only against the first spec file a worker loads. This
 * runs once, after everything.
 */
export default async function globalTeardown(): Promise<void> {
  try {
    await resetClock();
    await alignUserActivityToClock(await readContainerClock());
  } finally {
    await closeDb();
  }
}
