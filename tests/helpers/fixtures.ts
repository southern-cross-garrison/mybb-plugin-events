import { test as base, expect, Page } from '@playwright/test';
import { resetPluginData, deletePrivateMessages, alignUserActivityToClock } from './db';
import { resetToTestNow, resetClock, readContainerClock } from './clock';

/**
 * Every test starts with no plugin data and the container clock parked at TEST_NOW, so
 * scenarios are built from absolute dates rather than the real wall clock.
 */
export const test = base.extend<{ cleanBoard: void }>({
  cleanBoard: [
    async ({}, use) => {
      await resetPluginData();
      await deletePrivateMessages();
      await moveClock(resetToTestNow);
      await use();
    },
    { auto: true },
  ],
});

test.afterAll(async () => {
  await moveClock(resetClock);
});

/**
 * Move the container clock, and bring MyBB's per-user activity timestamps with it.
 *
 * The two always travel together. MyBB's shutdown handler adds `now - lastactive` to
 * users.timeonline, which is UNSIGNED, so a clock that moves *backwards* on its own -
 * the rewind to real time at the end of a run, as much as the jump back to TEST_NOW at
 * the start of each test - leaves the timestamps in the future and makes the very next
 * page view die with "BIGINT UNSIGNED value is out of range". That outlives the suite:
 * it is the dev forum in a browser that breaks, until the next db-restore.sh.
 *
 * Reading the clock back is an HTTP round trip to _clockprobe.php, which is a bare
 * `date()` script rather than a MyBB page, so it is safe to call while the timestamps
 * are still ahead of the clock.
 */
async function moveClock(move: () => Promise<void>): Promise<void> {
  await move();
  await alignUserActivityToClock(await readContainerClock());
}

export { expect };

/** Assert the page is MyBB's "no permission" / error page carrying a given message. */
export async function expectMyBBError(page: Page, message: string | RegExp): Promise<void> {
  await expect(page.locator('#content, .error, body')).toContainText(message);
}
