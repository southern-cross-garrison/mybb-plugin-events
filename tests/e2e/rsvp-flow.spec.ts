import { test, expect } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import { rsvpThroughWizard } from '../helpers/rsvp';
import {
  createEvent,
  createRsvp,
  getEventDays,
  countRsvps,
  getRsvpCostumes,
  getRsvpDayIds,
  getUserField,
  setUserField,
  fixtures,
} from '../helpers/db';

const [TK, TD, TB] = [0, 1, 2].map((index) => fixtures().costumeOptions[index]);

test.describe('RSVP wizard', () => {
  test('a fully provisioned member RSVPs in two steps', async ({ page }) => {
    const eventId = await createEvent({ title: 'Single Day Troop' });

    await loginAs(page, 'trooper1');
    await rsvpThroughWizard(page, eventId, { costumes: [TK] });

    expect(await countRsvps(eventId)).toBe(1);
    expect(await getRsvpCostumes(eventId, 'trooper1')).toEqual([TK]);
  });

  test('carries every selected costume through to the confirmation and the database', async ({ page }) => {
    const eventId = await createEvent({ title: 'Multi Costume Troop' });

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);

    await page.locator(`input.costume_checkbox[value="${TK}"]`).check();
    await page.locator(`input.costume_checkbox[value="${TB}"]`).check();
    await page.locator('#rsvp_submit').click();

    // The confirmation step must still know about both costumes.
    await expect(page.locator('#confirm_costumes')).toContainText(TK);
    await expect(page.locator('#confirm_costumes')).toContainText(TB);

    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success_message')).toBeVisible();

    expect((await getRsvpCostumes(eventId, 'trooper1')).sort()).toEqual([TK, TB].sort());
  });

  test('requires at least one costume', async ({ page }) => {
    const eventId = await createEvent({ title: 'No Costume Troop' });

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_errors')).toContainText('Please select at least one costume');
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
    expect(await countRsvps(eventId)).toBe(0);
  });

  test('asks a member with no profile details for every prerequisite and saves them', async ({ page }) => {
    const eventId = await createEvent({ title: 'Prerequisite Troop' });

    await loginAs(page, 'newbie');
    await page.goto(`/rsvp.php?id=${eventId}`);

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');
    await expect(page.locator('#prereq_tk_id')).toBeVisible();
    await expect(page.locator('#prereq_mobile')).toBeVisible();
    await expect(page.locator('#prereq_emergency_contact')).toBeVisible();
    // The event does not require a WWCC, so it must not be asked for.
    await expect(page.locator('#prereq_wwcc')).toHaveCount(0);

    await page.locator('#prereq_tk_id').fill('TK-99999');
    await page.locator('#prereq_mobile').fill('0400 999 999');
    await page.locator('#prereq_emergency_contact').fill('Next Of Kin 0400 888 888');
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');

    expect(await getUserField('newbie', 'tk_id')).toBe('TK-99999');
    expect(await getUserField('newbie', 'mobile')).toBe('0400 999 999');
    expect(await getUserField('newbie', 'emergency_contact')).toBe('Next Of Kin 0400 888 888');
  });

  test('re-prompts when a prerequisite is left blank', async ({ page }) => {
    const eventId = await createEvent({ title: 'Blank Prerequisite Troop' });

    await loginAs(page, 'newbie');
    await page.goto(`/rsvp.php?id=${eventId}`);

    await page.locator('#prereq_tk_id').fill('TK-12345');
    // Leave mobile and emergency contact empty. The browser would block the submit on
    // the required attributes, so drop them: the server must do its own validation.
    await page.locator('#rsvp_form').evaluate((form: HTMLFormElement) => {
      form.querySelectorAll('[required]').forEach((field) => field.removeAttribute('required'));
    });
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_errors')).toContainText('Please complete every required field');
    await expect(page.locator('#prereq_mobile')).toBeVisible();
    expect(await countRsvps(eventId)).toBe(0);
  });

  test('only asks for a WWCC when the event requires one', async ({ page }) => {
    const wwccEvent = await createEvent({ title: 'WWCC Troop', requiresWwcc: true });
    const openEvent = await createEvent({ title: 'Open Troop' });

    await loginAs(page, 'nowwcc');

    await page.goto(`/event.php?id=${openEvent}`);
    await page.goto(`/rsvp.php?id=${openEvent}`);
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');

    await page.goto(`/rsvp.php?id=${wwccEvent}`);
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');
    await expect(page.locator('#prereq_wwcc')).toBeVisible();
    await expect(page.locator('#prereq_tk_id')).toHaveCount(0);

    await page.locator('#prereq_wwcc').fill('WWCC-54321');
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
    expect(await getUserField('nowwcc', 'wwcc')).toBe('WWCC-54321');
  });

  test('multi-day events collect the days and persist them', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Weekend Troop',
      start: '2026-10-17 09:00:00',
      end: '2026-10-18 17:00:00',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const days = await getEventDays(eventId);
    const saturday = Number(days[0].id);

    await loginAs(page, 'trooper1');
    await rsvpThroughWizard(page, eventId, { costumes: [TK], dayIds: [saturday] });

    expect(await getRsvpDayIds(eventId, 'trooper1')).toEqual([saturday]);
    expect(await getRsvpCostumes(eventId, 'trooper1')).toEqual([TK]);
  });

  test('defaults a multi-day RSVP to every day', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Full Weekend Troop',
      start: '2026-10-17 09:00:00',
      end: '2026-10-18 17:00:00',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const dayIds = (await getEventDays(eventId)).map((day: any) => Number(day.id));

    await loginAs(page, 'trooper1');
    await rsvpThroughWizard(page, eventId, { costumes: [TK] });

    expect(await getRsvpDayIds(eventId, 'trooper1')).toEqual(dayIds);
  });

  test('requires at least one day on a multi-day event', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Day Validation Troop',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator(`input.costume_checkbox[value="${TK}"]`).check();
    await page.locator('#rsvp_submit').click();

    // all() does not auto-wait, so the days step has to have landed before it is read -
    // otherwise this enumerates the costumes page and unchecks nothing.
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'days');
    for (const checkbox of await page.locator('input.day_checkbox').all()) {
      await checkbox.uncheck();
    }
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_errors')).toContainText('Please select at least one day');
    expect(await countRsvps(eventId)).toBe(0);
  });

  test('refuses a second RSVP from the same member', async ({ page }) => {
    const eventId = await createEvent({ title: 'Duplicate Troop' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await loginAs(page, 'trooper1');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_rsvp_status')).toContainText('You have RSVPed');
    await expect(page.locator('#event_rsvp')).toHaveCount(0);

    await page.goto(`/rsvp.php?id=${eventId}`);
    await expect(page.locator('body')).toContainText('You have already RSVPed to this event');
    expect(await countRsvps(eventId)).toBe(1);
  });

  test('tells a member with no costumes on file to update their profile', async ({ page }) => {
    const eventId = await createEvent({ title: 'Costumeless Troop' });
    await setUserField('trooper2', 'costume', '');

    await loginAs(page, 'trooper2');
    await page.goto(`/rsvp.php?id=${eventId}`);

    await expect(page.locator('#rsvp_no_costumes')).toContainText('No costumes are listed on your profile');
    expect(await countRsvps(eventId)).toBe(0);
  });

  test('splits a multiselect costume field into individual costumes', async ({ page }) => {
    // MyBB stores multiselect profile fields newline separated.
    await setUserField('trooper2', 'costume', `${TK}\n${TD}`);
    const eventId = await createEvent({ title: 'Costume Parsing Troop' });

    await loginAs(page, 'trooper2');
    await page.goto(`/rsvp.php?id=${eventId}`);

    await expect(page.locator('input.costume_checkbox')).toHaveCount(2);
    await expect(page.locator(`input.costume_checkbox[value="${TK}"]`)).toBeVisible();
    await expect(page.locator(`input.costume_checkbox[value="${TD}"]`)).toBeVisible();
  });
});
