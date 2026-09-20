import { test, expect } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import { signUpThroughWizard } from '../helpers/rsvp';
import {
  createEvent,
  createRsvp,
  getEventDays,
  countRsvps,
  getRsvpCostumes,
  getRsvpDayIds,
  getSignupRoles,
  getUserField,
  setUserField,
  fixtures,
} from '../helpers/db';

const [TK, TD, TB] = [0, 1, 2].map((index) => fixtures().costumeOptions[index]);

test.describe('signup wizard', () => {
  test('a fully provisioned member signs up as a trooper', async ({ page }) => {
    const eventId = await createEvent({ title: 'Single Day Troop' });

    await loginAs(page, 'trooper1');
    await signUpThroughWizard(page, eventId, { costumes: [TK] });

    expect(await getSignupRoles(eventId, 'trooper1')).toEqual(['trooper']);
    expect(await getRsvpCostumes(eventId, 'trooper1')).toEqual([TK]);
  });

  test('opens on the attendance step, defaulted to trooping', async ({ page }) => {
    const eventId = await createEvent({ title: 'Default Troop' });

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'attendance');
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-signup-mode', 'create');
    await expect(page.locator('#signup_role_trooper')).toBeChecked();
    await expect(page.locator('#signup_role_wrangler')).not.toBeChecked();
  });

  test('carries every selected costume through to the confirmation and the database', async ({ page }) => {
    const eventId = await createEvent({ title: 'Multi Costume Troop' });

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
    await page.locator(`input.costume_checkbox[value="${TK}"]`).check();
    await page.locator(`input.costume_checkbox[value="${TB}"]`).check();
    await page.locator('#rsvp_submit').click();

    // The confirmation step must still know about both costumes.
    await expect(page.locator('#confirm_costumes')).toContainText(TK);
    await expect(page.locator('#confirm_costumes')).toContainText(TB);
    await expect(page.locator('#confirm_roles')).toHaveText('Trooper');

    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success_message')).toBeVisible();

    expect((await getRsvpCostumes(eventId, 'trooper1')).sort()).toEqual([TK, TB].sort());
  });

  test('requires at least one costume', async ({ page }) => {
    const eventId = await createEvent({ title: 'No Costume Troop' });

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_errors')).toContainText('Please select at least one costume');
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
    expect(await countRsvps(eventId)).toBe(0);
  });

  test('asks a member with no profile details for every prerequisite and saves them', async ({ page }) => {
    const eventId = await createEvent({ title: 'Prerequisite Troop' });

    await loginAs(page, 'newbie');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

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

    // Saving the prerequisites drops that step out of the sequence; the costumes step
    // must not be skipped along with it.
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');

    expect(await getUserField('newbie', 'tk_id')).toBe('TK-99999');
    expect(await getUserField('newbie', 'mobile')).toBe('0400 999 999');
    expect(await getUserField('newbie', 'emergency_contact')).toBe('Next Of Kin 0400 888 888');
  });

  test('gives each prerequisite a label, a styled control and a hint tied to it', async ({ page }) => {
    const eventId = await createEvent({ title: 'Labelled Prerequisite Troop' });

    await loginAs(page, 'newbie');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');

    // The hint is the input's accessible description, not loose text beside it.
    await expect(page.locator('#prereq_tk_id')).toHaveClass(/events_input/);
    await expect(page.locator('#prereq_tk_id')).toHaveAttribute('aria-describedby', 'hint_tk_id');
    await expect(page.locator('#hint_tk_id')).toHaveText('Your 501st legion ID, e.g. TK-12345.');
    await expect(page.locator('label[for="prereq_tk_id"]')).toHaveClass(/events_label/);
    await expect(page.locator('label[for="prereq_tk_id"]')).toContainText('Legion ID');

    // The asterisk is decoration - the required attribute is what states the rule.
    await expect(page.locator('#prereq_tk_id')).toHaveAttribute('required', 'required');
    await expect(page.locator('label[for="prereq_tk_id"] .events_required')).toHaveAttribute('aria-hidden', 'true');
  });

  test('re-prompts when a prerequisite is left blank', async ({ page }) => {
    const eventId = await createEvent({ title: 'Blank Prerequisite Troop' });

    await loginAs(page, 'newbie');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');

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

    await page.goto(`/rsvp.php?id=${openEvent}`);
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');

    await page.goto(`/rsvp.php?id=${wwccEvent}`);
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');
    await expect(page.locator('#prereq_wwcc')).toBeVisible();
    await expect(page.locator('#prereq_tk_id')).toHaveCount(0);

    await page.locator('#prereq_wwcc').fill('WWCC-54321');
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
    expect(await getUserField('nowwcc', 'wwcc')).toBe('WWCC-54321');
  });

  test('defaults a multi-day signup to trooping every day', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Full Weekend Troop',
      start: '2026-10-17 09:00:00',
      end: '2026-10-18 17:00:00',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const dayIds = (await getEventDays(eventId)).map((day: any) => Number(day.id));

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);

    for (const dayId of dayIds) {
      await expect(page.locator(`#day_${dayId}_trooper`)).toBeChecked();
    }

    await signUpThroughWizard(page, eventId, { costumes: [TK] });

    expect(await getSignupRoles(eventId, 'trooper1')).toEqual(['trooper']);
    expect(await getRsvpDayIds(eventId, 'trooper1')).toEqual(dayIds);
  });

  test('a member can drop a day they cannot make', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Weekend Troop',
      start: '2026-10-17 09:00:00',
      end: '2026-10-18 17:00:00',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const days = await getEventDays(eventId);
    const [saturday, sunday] = days.map((day: any) => Number(day.id));

    await loginAs(page, 'trooper1');
    await signUpThroughWizard(page, eventId, { costumes: [TK], dayRoles: { [sunday]: 'none' } });

    expect(await getRsvpDayIds(eventId, 'trooper1')).toEqual([saturday]);
    expect(await getRsvpCostumes(eventId, 'trooper1')).toEqual([TK]);
  });

  test('a half-day session can be dropped on its own', async ({ page }) => {
    // Two sessions on the same date is how a morning-only signup is expressed.
    const eventId = await createEvent({
      title: 'Split Day Troop',
      start: '2026-10-17 09:00:00',
      end: '2026-10-17 17:00:00',
      days: [
        { date: '2026-10-17', start: '09:00:00', end: '12:00:00' },
        { date: '2026-10-17', start: '13:00:00', end: '17:00:00' },
      ],
    });
    const [morning, afternoon] = (await getEventDays(eventId)).map((day: any) => Number(day.id));

    await loginAs(page, 'trooper1');
    await signUpThroughWizard(page, eventId, { costumes: [TK], dayRoles: { [afternoon]: 'none' } });

    expect(await getRsvpDayIds(eventId, 'trooper1')).toEqual([morning]);
  });

  test('requires at least one day on a multi-day event', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Day Validation Troop',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const dayIds = (await getEventDays(eventId)).map((day: any) => Number(day.id));

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);

    for (const dayId of dayIds) {
      await page.locator(`#day_${dayId}_none`).check();
    }
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_errors')).toContainText('Please choose at least one day');
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'attendance');
    expect(await countRsvps(eventId)).toBe(0);
  });

  test('tells a member with no costumes on file to update their profile or wrangle instead', async ({ page }) => {
    const eventId = await createEvent({ title: 'Costumeless Troop' });
    await setUserField('trooper2', 'costume', '');

    await loginAs(page, 'trooper2');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_no_costumes')).toContainText('No costumes are listed on your profile');
    await expect(page.locator('#rsvp_wrangle_instead')).toBeVisible();
    expect(await countRsvps(eventId)).toBe(0);
  });

  test('the wrangle-instead way out lands on the attendance step with wrangling chosen', async ({ page }) => {
    const eventId = await createEvent({ title: 'Costumeless Wrangle Out' });
    await setUserField('trooper2', 'costume', '');

    await loginAs(page, 'trooper2');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();
    await page.locator('#rsvp_wrangle_instead').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'attendance');
    await expect(page.locator('#signup_role_wrangler')).toBeChecked();
  });

  test('splits a multiselect costume field into individual costumes', async ({ page }) => {
    // MyBB stores multiselect profile fields newline separated.
    await setUserField('trooper2', 'costume', `${TK}\n${TD}`);
    const eventId = await createEvent({ title: 'Costume Parsing Troop' });

    await loginAs(page, 'trooper2');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('input.costume_checkbox')).toHaveCount(2);
    await expect(page.locator(`input.costume_checkbox[value="${TK}"]`)).toBeVisible();
    await expect(page.locator(`input.costume_checkbox[value="${TD}"]`)).toBeVisible();
  });

  test('an explicit role link overrides what is already on the signup', async ({ page }) => {
    const eventId = await createEvent({ title: 'Override Troop' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}&role=wrangler`);

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-signup-mode', 'update');
    await expect(page.locator('#signup_role_wrangler')).toBeChecked();
  });

  test('a second signup edits the first rather than adding one', async ({ page }) => {
    const eventId = await createEvent({ title: 'Edit Troop' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-signup-mode', 'update');
    await expect(page.locator('#signup_role_trooper')).toBeChecked();

    await page.locator('#rsvp_submit').click();
    // The costumes already on the signup come back ticked.
    await expect(page.locator(`input.costume_checkbox[value="${TK}"]`)).toBeChecked();
    await page.locator(`input.costume_checkbox[value="${TB}"]`).check();
    await page.locator('#rsvp_submit').click();
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_success_message')).toContainText('has been updated');
    expect(await countRsvps(eventId)).toBe(1);
    expect((await getRsvpCostumes(eventId, 'trooper1')).sort()).toEqual([TK, TB].sort());
  });
});
