import { Page, expect } from '@playwright/test';

export type SignupRole = 'trooper' | 'wrangler';

/**
 * Wait for a submitted step to land before the step probes below read the page.
 *
 * Those probes use count() and all(), neither of which auto-waits, so without this they
 * race the form POST and enumerate the page being navigated away from: the costumes step
 * is read as absent, its boxes are never ticked, and the wizard rejects the signup for
 * having no costume. Whether the race is lost comes down to how long the page takes to
 * load, so it hides completely on a light theme and is deterministic on a heavy one.
 */
async function settleOnStep(page: Page, ...steps: string[]): Promise<void> {
  await expect(page.locator('#rsvp_page')).toHaveAttribute(
    'data-rsvp-step',
    new RegExp(`^(${steps.join('|')})$`),
  );
}

export interface SignupOptions {
  prerequisites?: Record<string, string>;
  costumes?: string[];
  /**
   * Event day id => how that day is being attended. Days left out hold whatever the
   * leading answer put them on, which is trooping the whole event unless `role` says
   * otherwise.
   */
  dayRoles?: Record<number, SignupRole | 'none'>;
  /** The leading answer, covering every day not overridden above; defaults to trooping. */
  role?: SignupRole;
}

/**
 * Drive the signup wizard end to end.
 *
 * The wizard is attendance -> prerequisites -> costumes -> confirm, and each step carries
 * the accumulated selections forward as hidden inputs. Only attendance and confirm are
 * always shown: prerequisites appears when the profile is incomplete, and costumes only
 * when at least one day is being trooped.
 */
export async function signUpThroughWizard(
  page: Page,
  eventId: number,
  options: SignupOptions = {},
): Promise<void> {
  await page.goto(`/rsvp.php?id=${eventId}`);
  await settleOnStep(page, 'attendance');

  if (options.role) {
    await page.locator(`#signup_role_${options.role}`).check();
  }
  // The per-day grid is closed until the checkbox opens it, and the wizard only reads it
  // when that box is ticked - a closed grid means the leading answer above covers every
  // day. Tick it before reaching for a day, not after: the days are display: none until
  // then, so check() would wait for a control that never becomes actionable. The leading
  // answer is set first for the same reason it is on the page: it sets every day, so the
  // overrides below have to come after it.
  const dayRoles = Object.entries(options.dayRoles ?? {});
  if (dayRoles.length > 0) {
    await page.locator('#signup_per_day').check();
    for (const [dayId, role] of dayRoles) {
      await page.locator(`#day_${dayId}_${role}`).check();
    }
  }
  await page.locator('#rsvp_submit').click();
  await settleOnStep(page, 'prerequisites', 'costumes', 'confirm');

  if ((await page.locator('#rsvp_page[data-rsvp-step="prerequisites"]').count()) > 0) {
    for (const [field, value] of Object.entries(options.prerequisites ?? {})) {
      await page.locator(`#prereq_${field}`).fill(value);
    }
    await page.locator('#rsvp_submit').click();
    await settleOnStep(page, 'costumes', 'confirm');
  }

  if ((await page.locator('#rsvp_page[data-rsvp-step="costumes"]').count()) > 0) {
    for (const costume of options.costumes ?? []) {
      await page.locator(`input.costume_checkbox[value="${costume}"]`).check();
    }
    await page.locator('#rsvp_submit').click();
    await settleOnStep(page, 'confirm');
  }

  await page.locator('#rsvp_submit').click();
  await expect(page.locator('#rsvp_success_message')).toBeVisible();
}

/** The lock reason the event page is advertising, or null when signups are open. */
export async function lockReasonOnEventPage(page: Page, eventId: number): Promise<string | null> {
  await page.goto(`/event.php?id=${eventId}`);
  const locked = page.locator('#event_signup_locked');
  if ((await locked.count()) === 0) {
    return null;
  }
  return locked.getAttribute('data-lock-reason');
}
