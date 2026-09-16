import { Page, expect } from '@playwright/test';

/**
 * Drive the RSVP wizard end to end.
 *
 * The wizard is prerequisites -> costumes -> days (multi-day events only) -> confirm,
 * and each step carries the accumulated selections forward as hidden inputs.
 */
export async function rsvpThroughWizard(
  page: Page,
  eventId: number,
  options: {
    prerequisites?: Record<string, string>;
    costumes: string[];
    /** Event day ids to keep; omit to accept the default of every day. */
    dayIds?: number[];
  },
): Promise<void> {
  await page.goto(`/rsvp.php?id=${eventId}`);

  if ((await page.locator('#rsvp_page[data-rsvp-step="prerequisites"]').count()) > 0) {
    for (const [field, value] of Object.entries(options.prerequisites ?? {})) {
      await page.locator(`#prereq_${field}`).fill(value);
    }
    await page.locator('#rsvp_submit').click();
  }

  await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
  for (const costume of options.costumes) {
    await page.locator(`input.costume_checkbox[value="${costume}"]`).check();
  }
  await page.locator('#rsvp_submit').click();

  if ((await page.locator('#rsvp_page[data-rsvp-step="days"]').count()) > 0) {
    if (options.dayIds) {
      for (const checkbox of await page.locator('input.day_checkbox').all()) {
        const value = Number(await checkbox.getAttribute('value'));
        if (options.dayIds.includes(value)) {
          await checkbox.check();
        } else {
          await checkbox.uncheck();
        }
      }
    }
    await page.locator('#rsvp_submit').click();
  }

  await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
  await page.locator('#rsvp_submit').click();

  await expect(page.locator('#rsvp_success_message')).toBeVisible();
}

/** The lock reason the event page is advertising, or null when RSVPs are open. */
export async function lockReasonOnEventPage(page: Page, eventId: number): Promise<string | null> {
  await page.goto(`/event.php?id=${eventId}`);
  const locked = page.locator('#event_rsvp_locked');
  if ((await locked.count()) === 0) {
    return null;
  }
  return locked.getAttribute('data-lock-reason');
}

/**
 * Drive the wrangler signup, which is the same wizard with no costumes step.
 *
 * A wrangler with nothing missing on a single-day event goes straight to `confirm`, so
 * every step here is optional except the confirmation itself.
 */
export async function wrangleThroughWizard(
  page: Page,
  eventId: number,
  options: {
    prerequisites?: Record<string, string>;
    /** Event day ids to keep; omit to accept the default of every day. */
    dayIds?: number[];
  } = {},
): Promise<void> {
  await page.goto(`/rsvp.php?id=${eventId}&role=wrangler`);

  if ((await page.locator('#rsvp_page[data-rsvp-step="prerequisites"]').count()) > 0) {
    for (const [field, value] of Object.entries(options.prerequisites ?? {})) {
      await page.locator(`#prereq_${field}`).fill(value);
    }
    await page.locator('#rsvp_submit').click();
  }

  // The costumes step must never appear for a wrangler.
  await expect(page.locator('#rsvp_page[data-rsvp-step="costumes"]')).toHaveCount(0);

  if ((await page.locator('#rsvp_page[data-rsvp-step="days"]').count()) > 0) {
    if (options.dayIds) {
      for (const checkbox of await page.locator('input.day_checkbox').all()) {
        const value = Number(await checkbox.getAttribute('value'));
        if (options.dayIds.includes(value)) {
          await checkbox.check();
        } else {
          await checkbox.uncheck();
        }
      }
    }
    await page.locator('#rsvp_submit').click();
  }

  await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
  await page.locator('#rsvp_submit').click();

  await expect(page.locator('#rsvp_success_message')).toBeVisible();
}
