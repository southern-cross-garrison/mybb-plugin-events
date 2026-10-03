import { defineConfig, devices } from '@playwright/test';
import { assertNoRunInFlight } from './tests/helpers/suite-lock';

/**
 * Takes the user guide's screenshots (docs/screenshots/*.shots.ts) against the dev forum.
 *
 * Shares the e2e suite's global setup, so every run starts from the provisioned snapshot
 * with the fixture logins and the faked clock - the pictures only ever show demo data,
 * and the dates in them don't drift between runs. Like the suite, it cannot run while a
 * suite run is in flight.
 *
 *   npm run docs:screenshots
 */
assertNoRunInFlight();

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';

export default defineConfig({
  testDir: './docs/screenshots',
  testMatch: '**/*.shots.ts',
  globalSetup: './tests/global-setup.ts',
  globalTeardown: './tests/global-teardown.ts',
  outputDir: './.devenv/docs-screenshot-results',

  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 7_000 },
  reporter: [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    reducedMotion: 'reduce',
    // A laptop-sized window, at 2x so the images stay sharp on phones and retina screens.
    // Starlight resizes them for the page, so the files' size isn't what members download.
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 } }],
});
