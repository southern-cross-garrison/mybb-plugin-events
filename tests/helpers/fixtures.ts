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
      await resetToTestNow();
      await alignUserActivityToClock(await readContainerClock());
      await use();
    },
    { auto: true },
  ],
});

test.afterAll(async () => {
  await resetClock();
});

export { expect };

/** Assert the page is MyBB's "no permission" / error page carrying a given message. */
export async function expectMyBBError(page: Page, message: string | RegExp): Promise<void> {
  await expect(page.locator('#content, .error, body')).toContainText(message);
}
