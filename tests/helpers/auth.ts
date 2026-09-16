import fs from 'node:fs';
import path from 'node:path';
import { Page, request } from '@playwright/test';
import { ADMIN, AUTH_DIR, BASE_URL, FIXTURE_PASSWORD } from './config';

/**
 * Logins are performed once per user in global setup and replayed as cookies, so
 * individual tests can switch identity without paying for a form round-trip.
 */

export type FixtureUser = 'admin' | 'gec' | 'trooper1' | 'trooper2' | 'newbie' | 'nowwcc' | 'excluded';

export const ALL_USERS: FixtureUser[] = ['admin', 'gec', 'trooper1', 'trooper2', 'newbie', 'nowwcc', 'excluded'];

const statePath = (username: string) => path.join(AUTH_DIR, `${username}.json`);

function passwordFor(username: string): string {
  return username === ADMIN.username ? ADMIN.password : FIXTURE_PASSWORD;
}

/**
 * Log a user in over HTTP and cache the resulting cookies.
 *
 * MyBB guards do_login with a post key that is only present on a freshly rendered login
 * page, so the key is scraped before posting.
 */
export async function captureLoginState(username: string): Promise<void> {
  const context = await request.newContext({ baseURL: BASE_URL });

  const loginPage = await context.get('/member.php?action=login');
  const html = await loginPage.text();
  const postKey = html.match(/name="my_post_key"\s+type="hidden"\s+value="([a-f0-9]+)"/)?.[1]
    ?? html.match(/name="my_post_key"[^>]*value="([a-f0-9]+)"/)?.[1];

  if (!postKey) {
    throw new Error(`Could not find my_post_key on the login page for ${username}`);
  }

  const response = await context.post('/member.php', {
    form: {
      action: 'do_login',
      my_post_key: postKey,
      username,
      password: passwordFor(username),
      remember: 'yes',
      submit: 'Login',
    },
  });

  const body = await response.text();
  if (body.includes('You have entered an invalid username/password combination')) {
    throw new Error(`Login failed for ${username} - check scripts/provision.php fixtures`);
  }

  const state = await context.storageState();
  if (!state.cookies.some((cookie) => cookie.name === 'mybbuser')) {
    throw new Error(`Login for ${username} did not produce a mybbuser cookie`);
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(statePath(username), JSON.stringify(state, null, 2));
  await context.dispose();
}

/** Swap the browser context over to a fixture user. */
export async function loginAs(page: Page, username: FixtureUser): Promise<void> {
  const file = statePath(username);
  if (!fs.existsSync(file)) {
    throw new Error(`No cached login for ${username}; global setup did not run`);
  }

  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as { cookies: Parameters<Page['context']>[0] };
  await page.context().clearCookies();
  await page.context().addCookies((state as any).cookies);
}

/** Browse as a guest. */
export async function logout(page: Page): Promise<void> {
  await page.context().clearCookies();
}

/**
 * Authenticate against the Admin CP, which keeps its own session separate from the
 * front end. Safe to call when already authenticated.
 */
export async function loginToAdminCp(page: Page, username: FixtureUser = 'admin'): Promise<void> {
  await loginAs(page, username);
  await page.goto('/admin/index.php');

  const usernameField = page.locator('form input[name="username"]');
  if (await usernameField.count()) {
    await usernameField.fill(username);
    await page.locator('form input[name="password"]').fill(passwordFor(username));
    await page.locator('form input[type="submit"]').click();
    await page.waitForLoadState('domcontentloaded');
  }
}

/** Open an Admin CP page belonging to the Events module. */
export async function gotoEventsAdmin(page: Page, query = ''): Promise<void> {
  await page.goto(`/admin/index.php?module=events${query}`);
}
