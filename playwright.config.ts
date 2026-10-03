import { defineConfig, devices } from '@playwright/test';
import { assertNoRunInFlight } from './tests/helpers/suite-lock';

// Bail out before Playwright empties outputDir, which would take the trace files of a
// run already in flight with it. The lock itself is claimed in global setup.
assertNoRunInFlight();

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/global-setup.ts',
  globalTeardown: './tests/global-teardown.ts',
  outputDir: './.devenv/test-results',

  // The suite drives one shared MyBB instance and one shared (faked) clock, so tests
  // must not run concurrently.
  fullyParallel: false,
  workers: 1,

  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },

  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: '.devenv/playwright-report', open: 'never' }], ['github']]
    : [['list'], ['html', { outputFolder: '.devenv/playwright-report', open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 10_000,
    // The garrison theme's Bootstrap turns on `scroll-behavior: smooth` unless reduced
    // motion is asked for, which animates the scroll Playwright does before a click: the
    // target is still off screen when it is checked, and the click can stall until it
    // times out. Seen on the no-script removal page, whose submit sits at the fold.
    reducedMotion: 'reduce',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
