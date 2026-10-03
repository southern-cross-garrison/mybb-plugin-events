import { defineConfig, devices } from '@playwright/test';
import { assertNoRunInFlight } from '../../tests/helpers/suite-lock';

/**
 * Takes the user guide's screenshots (screenshots/*.shots.ts) against the dev forum.
 *
 * Runs on the repo root's Playwright and test helpers rather than a copy of its own: the
 * shots import the e2e suite's fixtures, and two copies of @playwright/test in one run
 * refuse to load. So the root's `npm install` is what this needs, not one in docs/.
 *
 * It lives in screenshots/ beside a package.json that says "commonjs": docs/ itself is an
 * ES module package for Astro, and the shots share CommonJS helpers (and __dirname) with
 * the suite.
 *
 * Shares the e2e suite's global setup, so every run starts from the provisioned snapshot
 * with the fixture logins and the faked clock - the pictures only ever show demo data,
 * and the dates in them don't drift between runs. Like the suite, it cannot run while a
 * suite run is in flight.
 *
 *   pnpm screenshots             # every guide
 *   pnpm screenshots members     # one guide
 */
assertNoRunInFlight();

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.shots.ts',
  globalSetup: '../../tests/global-setup.ts',
  globalTeardown: '../../tests/global-teardown.ts',
  outputDir: '../../.devenv/docs-screenshot-results',

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
