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
   * Event day id => how that day is being attended. Days left out keep the form's
   * default, which is trooping every day.
   */
  dayRoles?: Record<number, SignupRole | 'none'>;
  /** For an event with no configured days; defaults to trooping. */
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

  for (const [dayId, role] of Object.entries(options.dayRoles ?? {})) {
    await page.locator(`#day_${dayId}_${role}`).check();
  }
  if (options.role) {
    await page.locator(`#signup_role_${options.role}`).check();
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
