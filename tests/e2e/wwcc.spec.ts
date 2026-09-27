import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, loginToAdminCp, gotoEventsAdmin } from '../helpers/auth';
import { createEvent, getEvent, getSetting, setUserField, fixtures } from '../helpers/db';
import { withSettings } from '../helpers/settings';

/**
 * Working with children checks are the board's to switch off and to name: a garrison
 * outside NSW calls the check something else ("Blue Card" in Queensland), and one with no
 * such scheme should not be asked about it on every event.
 *
 * Turning it off hides the requirement everywhere it shows, and leaves the flag on each
 * event alone so that turning it back on restores them.
 */

const [TK, TD] = [0, 1].map((index) => fixtures().costumeOptions[index]);

async function gotoSettings(page: Page): Promise<void> {
  await loginToAdminCp(page);
  await gotoEventsAdmin(page, '&action=settings');
}

async function save(page: Page): Promise<void> {
  await page.locator('input[type="submit"][value="Save Settings"]').click();
  await expect(page.locator('#flash_message')).toContainText('Settings updated successfully');
}

test.describe('working with children check settings', () => {
  let restore: (() => Promise<void>) | undefined;

  test.afterEach(async () => {
    await restore?.();
    restore = undefined;
  });

  test('hides the name and profile field while the check is off, and saves both', async ({ page }) => {
    // Captured through the helper so the teardown puts them back however the test ends.
    restore = await withSettings({
      events_wwcc_enabled: await getSetting('events_wwcc_enabled'),
      events_wwcc_name: await getSetting('events_wwcc_name'),
    });

    await gotoSettings(page);
    await expect(page.locator('#wwcc_enabled_yes')).toBeChecked();
    await expect(page.locator('#row_wwcc_name')).toBeVisible();
    await expect(page.locator('#row_wwcc_field')).toBeVisible();

    await page.locator('#wwcc_name').fill('Blue Card');
    await page.locator('#wwcc_enabled_no').check();
    await expect(page.locator('#row_wwcc_name')).toBeHidden();
    await expect(page.locator('#row_wwcc_field')).toBeHidden();
    await save(page);

    expect(await getSetting('events_wwcc_enabled')).toBe('0');
    expect(await getSetting('events_wwcc_name')).toBe('Blue Card');
    await expect(page.locator('#row_wwcc_name')).toBeHidden();

    await page.locator('#wwcc_enabled_yes').check();
    await expect(page.locator('#row_wwcc_name')).toBeVisible();
    await expect(page.locator('#wwcc_name')).toHaveValue('Blue Card');
    await save(page);
    expect(await getSetting('events_wwcc_enabled')).toBe('1');
  });

  test('a blank name falls back to the default', async ({ page }) => {
    restore = await withSettings({ events_wwcc_name: await getSetting('events_wwcc_name') });

    await gotoSettings(page);
    await page.locator('#wwcc_name').fill('  ');
    await save(page);

    expect(await getSetting('events_wwcc_name')).toBe('WWCC');
  });

  test('turned off, no form offers it and no event asks for it', async ({ page }) => {
    const eventId = await createEvent({ title: 'Unchecked Troop', requiresWwcc: true });
    restore = await withSettings({ events_wwcc_enabled: '0' });

    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=add');
    await expect(page.locator('input[name="title"]')).toBeVisible();
    await expect(page.locator('input[name="requires_wwcc"]')).toHaveCount(0);

    await loginAs(page, 'gec');
    await page.goto(`/manage_event.php?id=${eventId}`);
    await expect(page.locator('#event_form_title')).toBeVisible();
    await expect(page.locator('#event_form_requires_wwcc')).toHaveCount(0);

    // Saving without the box does not clear the flag, so turning the check back on
    // brings the requirement back.
    await Promise.all([
      page.waitForResponse((response) => response.request().method() === 'POST'),
      page.locator('#manage_event_submit').click(),
    ]);
    expect(Number((await getEvent(eventId)).requires_wwcc)).toBe(1);

    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_card')).toBeVisible();
    await expect(page.locator('#event_requires_wwcc')).toHaveCount(0);

    // nowwcc has everything but a check number, so the prerequisites step is skipped.
    await setUserField('nowwcc', 'costume', `${TK}\n${TD}`);
    await loginAs(page, 'nowwcc');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
  });

  test('names the check the way the board does', async ({ page }) => {
    const eventId = await createEvent({ title: 'Blue Card Troop', requiresWwcc: true });
    restore = await withSettings({ events_wwcc_name: 'Blue Card' });

    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=add');
    await expect(page.locator('label[for="requires_wwcc"]').first()).toContainText('Blue Card');

    await loginAs(page, 'gec');
    await page.goto(`/manage_event.php?id=${eventId}`);
    await expect(page.locator('label:has(#event_form_requires_wwcc)')).toContainText('Blue Card');

    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_requires_wwcc')).toContainText('Requires Blue Card');

    await setUserField('nowwcc', 'costume', `${TK}\n${TD}`);
    await loginAs(page, 'nowwcc');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('label[for="prereq_wwcc"]')).toContainText('Blue Card Number');
  });
});

test.describe('working with children check settings without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('leaves the name and profile field showing with the check off', async ({ page }) => {
    const restore = await withSettings({ events_wwcc_enabled: '0' });
    try {
      await gotoSettings(page);
      await expect(page.locator('#wwcc_enabled_no')).toBeChecked();
      await expect(page.locator('#row_wwcc_name')).toBeVisible();
      await expect(page.locator('#row_wwcc_field')).toBeVisible();
    } finally {
      await restore();
    }
  });
});
