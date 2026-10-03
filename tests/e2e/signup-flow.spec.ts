import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import { signUpThroughWizard } from '../helpers/rsvp';
import { submitFormAtOnce } from '../helpers/double-submit';
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
  execute,
  T,
} from '../helpers/db';

import { relativeToTestNow } from '../helpers/clock';
import { withSettings } from '../helpers/settings';

const [TK, TD, TB] = [0, 1, 2].map((index) => fixtures().costumeOptions[index]);

test.describe('signup wizard', () => {
  test('a fully provisioned member signs up as a trooper', async ({ page }) => {
    const eventId = await createEvent({ title: 'Single Day Troop' });

    await loginAs(page, 'trooper1');
    await signUpThroughWizard(page, eventId, { costumes: [TK] });

    expect(await getSignupRoles(eventId, 'trooper1')).toEqual(['trooper']);
    expect(await getRsvpCostumes(eventId, 'trooper1')).toEqual([TK]);
  });

  test('offers the event and the subscription under one Add to Calendar menu', async ({ page }) => {
    const eventId = await createEvent({ title: 'Calendar Menu Troop' });

    await loginAs(page, 'trooper1');
    await signUpThroughWizard(page, eventId, { costumes: [TK] });

    const toggle = page.locator('#rsvp_calendar_toggle');
    await expect(toggle).toHaveText('Add to Calendar');
    await expect(page.locator('#rsvp_ical')).toBeHidden();

    await toggle.click();
    await expect(page.locator('#rsvp_ical')).toHaveText('Add Event');
    await expect(page.locator('#rsvp_ical')).toHaveAttribute('href', `ical.php?id=${eventId}`);
    await expect(page.locator('#rsvp_calendar_feed')).toHaveText('Subscribe to All Events');
    await expect(page.locator('#rsvp_calendar_feed')).toHaveAttribute('href', 'calendar_feed.php');

    await page.locator('#rsvp_success_message').click();
    await expect(page.locator('#rsvp_ical')).toBeHidden();

    await toggle.click();
    await page.locator('#rsvp_calendar_feed').click();
    await expect(page).toHaveURL(/calendar_feed\.php$/);
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

  test('links the event address to Google Maps on the attendance step', async ({ page }) => {
    const eventId = await createEvent({ title: 'Mapped Troop', address: '1 Macquarie St, Sydney NSW' });
    const bareEventId = await createEvent({ title: 'Unmapped Troop' });

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);

    const link = page.locator('#rsvp_page .signup_intro_address a');
    await expect(link).toHaveText('1 Macquarie St, Sydney NSW');
    await expect(link).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=1%20Macquarie%20St%2C%20Sydney%20NSW',
    );

    await page.goto(`/rsvp.php?id=${bareEventId}`);
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'attendance');
    await expect(page.locator('#rsvp_page .signup_intro_address')).toHaveCount(0);
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
    // Two costumes, so there is a choice to make and the costumes step is not skipped.
    await setUserField('newbie', 'costume', `${TK}\n${TD}`);

    await loginAs(page, 'newbie');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');
    await expect(page.locator('#prereq_legion_id')).toBeVisible();
    await expect(page.locator('#prereq_preferred_name')).toBeVisible();
    await expect(page.locator('#prereq_mobile')).toBeVisible();
    await expect(page.locator('#prereq_emergency_contact')).toBeVisible();
    // The event does not require a WWCC, so it must not be asked for.
    await expect(page.locator('#prereq_wwcc')).toHaveCount(0);

    await page.locator('#prereq_legion_id').fill('TK-99999');
    await page.locator('#prereq_preferred_name').fill('Newt');
    await page.locator('#prereq_mobile').fill('0400 999 999');
    await page.locator('#prereq_emergency_contact').fill('Next Of Kin 0400 888 888');
    await page.locator('#rsvp_submit').click();

    // Saving the prerequisites drops that step out of the sequence; the costumes step
    // must not be skipped along with it.
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');

    expect(await getUserField('newbie', 'legion_id')).toBe('TK-99999');
    expect(await getUserField('newbie', 'preferred_name')).toBe('Newt');
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
    await expect(page.locator('#prereq_legion_id')).toHaveClass(/events_input/);
    await expect(page.locator('#prereq_legion_id')).toHaveAttribute('aria-describedby', 'hint_legion_id');
    await expect(page.locator('#hint_legion_id')).toHaveText(
      'Your 501st legion ID, e.g. if you are TK-12345 then type "12345" here.',
    );
    await expect(page.locator('label[for="prereq_legion_id"]')).toHaveClass(/events_label/);
    await expect(page.locator('label[for="prereq_legion_id"]')).toContainText('Legion ID');

    // The asterisk is decoration - the required attribute is what states the rule.
    await expect(page.locator('#prereq_legion_id')).toHaveAttribute('required', 'required');
    await expect(page.locator('label[for="prereq_legion_id"] .events_required')).toHaveAttribute('aria-hidden', 'true');
  });

  test('re-prompts when a prerequisite is left blank', async ({ page }) => {
    const eventId = await createEvent({ title: 'Blank Prerequisite Troop' });

    await loginAs(page, 'newbie');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');

    await page.locator('#prereq_legion_id').fill('TK-12345');
    // Leave the preferred name, mobile and emergency contact empty. The browser would block the submit on
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
    // Two costumes, so there is a choice to make and the costumes step is not skipped.
    await setUserField('nowwcc', 'costume', `${TK}\n${TD}`);

    await loginAs(page, 'nowwcc');

    await page.goto(`/rsvp.php?id=${openEvent}`);
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');

    await page.goto(`/rsvp.php?id=${wwccEvent}`);
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');
    await expect(page.locator('#prereq_wwcc')).toBeVisible();
    await expect(page.locator('#prereq_legion_id')).toHaveCount(0);

    await page.locator('#prereq_wwcc').fill('WWCC-54321');
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
    expect(await getUserField('nowwcc', 'wwcc')).toBe('WWCC-54321');
  });

  test('defaults a multi-day signup to trooping every day, with the grid closed', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Full Weekend Troop',
      start: '2026-10-17 09:00:00',
      end: '2026-10-18 17:00:00',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const dayIds = (await getEventDays(eventId)).map((day: any) => Number(day.id));

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);

    // The whole question, for the signup almost everybody is making: one answer, and a
    // grid that stays shut until a day genuinely differs.
    await expect(page.locator('#signup_role_trooper')).toBeChecked();
    await expect(page.locator('#signup_per_day')).not.toBeChecked();
    await expect(page.locator('#signup_days')).toBeHidden();

    for (const dayId of dayIds) {
      await expect(page.locator(`#day_${dayId}_trooper`)).toBeChecked();
    }

    await signUpThroughWizard(page, eventId, { costumes: [TK] });

    expect(await getSignupRoles(eventId, 'trooper1')).toEqual(['trooper']);
    expect(await getRsvpDayIds(eventId, 'trooper1')).toEqual(dayIds);
  });

  test('the leading answer covers every day while the grid is closed', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Wrangled Weekend',
      start: '2026-10-17 09:00:00',
      end: '2026-10-18 17:00:00',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const dayIds = (await getEventDays(eventId)).map((day: any) => Number(day.id));

    await loginAs(page, 'trooper1');
    await signUpThroughWizard(page, eventId, { role: 'wrangler' });

    expect(await getSignupRoles(eventId, 'trooper1')).toEqual(['wrangler']);
    expect(await getRsvpDayIds(eventId, 'trooper1', 'wrangler')).toEqual(dayIds);
  });

  test('the leading answer sets every day, and changing one day clears it', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Cascade Weekend',
      start: '2026-10-17 09:00:00',
      end: '2026-10-18 17:00:00',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const [saturday, sunday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);

    // Wrangling the event, except for the Sunday. The Saturday is never touched: answering
    // the question at the top is what put it on wrangling, and it stays there.
    await page.locator('#signup_role_wrangler').check();
    await page.locator('#signup_per_day').check();
    await expect(page.locator('#signup_days')).toBeVisible();
    await expect(page.locator(`#day_${saturday}_wrangler`)).toBeChecked();
    await expect(page.locator(`#day_${sunday}_wrangler`)).toBeChecked();

    await page.locator(`#day_${sunday}_trooper`).check();

    // No single answer describes the two days any more, so the question above has none.
    await expect(page.locator('#signup_role_wrangler')).not.toBeChecked();
    await expect(page.locator('#signup_role_trooper')).not.toBeChecked();

    await page.locator('#rsvp_submit').click();
    await page.locator(`input.costume_checkbox[value="${TK}"]`).check();
    await page.locator('#rsvp_submit').click();
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success_message')).toBeVisible();

    expect(await getRsvpDayIds(eventId, 'trooper1', 'wrangler')).toEqual([saturday]);
    expect(await getRsvpDayIds(eventId, 'trooper1', 'trooper')).toEqual([sunday]);
  });

  test('changing a day and closing the grid again leaves the leading answer in charge', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Reconsidered Weekend',
      start: '2026-10-17 09:00:00',
      end: '2026-10-18 17:00:00',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const dayIds = (await getEventDays(eventId)).map((day: any) => Number(day.id));

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);

    // The grid is closed with CSS, so its radios keep posting whatever they last held.
    // Closing it has to put the member back on the answer the page is showing them.
    await page.locator('#signup_per_day').check();
    await page.locator(`#day_${dayIds[1]}_none`).check();
    await page.locator('#signup_per_day').uncheck();

    await page.locator('#rsvp_submit').click();
    await page.locator(`input.costume_checkbox[value="${TK}"]`).check();
    await page.locator('#rsvp_submit').click();
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success_message')).toBeVisible();

    expect(await getRsvpDayIds(eventId, 'trooper1')).toEqual(dayIds);
  });

  test('reopening a signup that is not the same throughout opens the grid on it', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Mixed Weekend Edit',
      start: '2026-10-17 09:00:00',
      end: '2026-10-18 17:00:00',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const [saturday, sunday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));
    await createRsvp(eventId, 'trooper1', { costumes: [TK], dayIds: [saturday] });

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);

    await expect(page.locator('#signup_per_day')).toBeChecked();
    await expect(page.locator('#signup_days')).toBeVisible();
    await expect(page.locator(`#day_${saturday}_trooper`)).toBeChecked();
    await expect(page.locator(`#day_${sunday}_none`)).toBeChecked();
    // The two days do not agree, so the question above is left unanswered rather than
    // showing a chip that speaks for a day being sat out.
    await expect(page.locator('#signup_role_trooper')).not.toBeChecked();
    await expect(page.locator('#signup_role_wrangler')).not.toBeChecked();
  });

  test('putting the days back into agreement answers the question above again', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Realigned Weekend',
      start: '2026-10-17 09:00:00',
      end: '2026-10-18 17:00:00',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const [saturday, sunday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);

    await page.locator('#signup_per_day').check();
    await page.locator(`#day_${sunday}_wrangler`).check();
    await expect(page.locator('#signup_role_trooper')).not.toBeChecked();

    // Both days wrangling is wrangling the event, which is exactly what the question
    // above asks - so it comes back lit rather than staying blank.
    await page.locator(`#day_${saturday}_wrangler`).check();
    await expect(page.locator('#signup_role_wrangler')).toBeChecked();

    await page.locator('#rsvp_submit').click();
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_success_message')).toBeVisible();
    expect(await getSignupRoles(eventId, 'trooper1')).toEqual(['wrangler']);
    expect(await getRsvpDayIds(eventId, 'trooper1', 'wrangler')).toEqual([saturday, sunday]);
  });

  test('the grid offers no "same as above" to contradict the answer above', async ({ page }) => {
    const eventId = await createEvent({
      title: 'No Same Option Troop',
      start: '2026-10-17 09:00:00',
      end: '2026-10-18 17:00:00',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const dayIds = (await getEventDays(eventId)).map((day: any) => Number(day.id));

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#signup_per_day').check();

    for (const dayId of dayIds) {
      await expect(page.locator(`#day_${dayId}_same`)).toHaveCount(0);
      await expect(page.locator(`.signup_day[data-day-id="${dayId}"] input.day_role_radio`)).toHaveCount(3);
    }
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

    await page.locator('#signup_per_day').check();
    for (const dayId of dayIds) {
      await page.locator(`#day_${dayId}_none`).check();
    }
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_errors')).toContainText('Please choose at least one day');
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'attendance');
    expect(await countRsvps(eventId)).toBe(0);
  });

  test('a first signup is not offered "Not attending"', async ({ page }) => {
    const eventId = await createEvent({ title: 'No Withdraw Yet' });

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);

    await expect(page.locator('#signup_role_trooper')).toBeVisible();
    await expect(page.locator('#signup_role_none')).toHaveCount(0);
  });

  test('a member withdraws from the edit form, and every role they held goes', async ({ page }) => {
    const eventId = await createEvent({ title: 'Withdraw Troop' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });
    await createRsvp(eventId, 'trooper1', { role: 'wrangler' });

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);

    await page.locator('#signup_role_none').check();
    await page.locator('#rsvp_submit').click();

    // Straight to confirm: nobody is asked for costumes or profile details to say they
    // are not coming.
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
    await expect(page.locator('#confirm_withdraw')).toBeVisible();
    expect(await countRsvps(eventId)).toBe(2);

    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_success')).toHaveAttribute('data-signup-mode', 'withdraw');
    await expect(page.locator('#rsvp_success_message')).toContainText('no longer signed up');
    expect(await countRsvps(eventId)).toBe(0);
    expect(await getRsvpCostumes(eventId, 'trooper1')).toEqual([]);
  });

  test('sitting out every day on the edit form is a withdrawal', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Withdraw Weekend',
      start: '2026-10-17 09:00:00',
      end: '2026-10-18 17:00:00',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const dayIds = (await getEventDays(eventId)).map((day: any) => Number(day.id));
    await createRsvp(eventId, 'trooper1', { costumes: [TK], dayIds });

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);

    await page.locator('#signup_per_day').check();
    for (const dayId of dayIds) {
      await page.locator(`#day_${dayId}_none`).check();
    }
    // Every day agreeing on "not attending" is the answer above, stated one day at a time.
    await expect(page.locator('#signup_role_none')).toBeChecked();

    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_success')).toHaveAttribute('data-signup-mode', 'withdraw');
    expect(await countRsvps(eventId)).toBe(0);
  });

  test('asks a member with no costumes for them in the flow rather than sending them away', async ({ page }) => {
    const eventId = await createEvent({ title: 'Costumeless Troop' });
    await setUserField('trooper2', 'costume', '');

    await loginAs(page, 'trooper2');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    // Costumes are a trooper prerequisite, so they are asked for here. trooper2 has every
    // other prerequisite on file, so this is the only field on the step.
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');
    const costumes = page.locator('#prereq_costume');
    await expect(costumes).toBeVisible();
    // A list, so a textarea: a single-line input would keep the first costume and
    // silently drop the rest.
    expect(await costumes.evaluate((node) => node.tagName)).toBe('TEXTAREA');

    // Having none yet is a wall, so the way past is offered on the step that asks.
    await expect(page.locator('#rsvp_wrangle_instead')).toBeVisible();

    await costumes.fill(`${TK}\n${TD}`);
    await page.locator('#rsvp_submit').click();

    // Straight on to picking from the costumes just entered - no trip to the User CP, and
    // no dead end.
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
    await expect(page.locator('#rsvp_no_costumes')).toHaveCount(0);
    await expect(page.locator('#rsvp_page')).toContainText(TK);
    await expect(page.locator('#rsvp_page')).toContainText(TD);

    // Saved to the profile on the way past, like every other prerequisite. The browser
    // submits a textarea with CRLF line endings, which is not the plugin's doing.
    expect((await getUserField('trooper2', 'costume')).replace(/\r/g, '')).toBe(`${TK}\n${TD}`);
  });

  test('skips the costumes step for a member with only one costume', async ({ page }) => {
    const eventId = await createEvent({ title: 'One Costume Troop' });
    await setUserField('trooper1', 'costume', TK);

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    // Nothing to choose between, so straight to confirm with that costume already picked.
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
    await expect(page.locator('#confirm_costumes')).toHaveText(TK);

    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success_message')).toBeVisible();
    expect(await getRsvpCostumes(eventId, 'trooper1')).toEqual([TK]);
  });

  test('skips the costumes step once a member enters a single costume as a prerequisite', async ({ page }) => {
    const eventId = await createEvent({ title: 'First Costume Troop' });
    await setUserField('trooper2', 'costume', '');

    await loginAs(page, 'trooper2');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');
    await page.locator('#prereq_costume').fill(TK);
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
    await expect(page.locator('#confirm_costumes')).toHaveText(TK);

    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success_message')).toBeVisible();
    expect(await getRsvpCostumes(eventId, 'trooper2')).toEqual([TK]);
  });

  test('falls back to the wrangle-instead way out when no costume field is mapped', async ({ page }) => {
    // With no profile field behind them, costumes cannot be asked for as a prerequisite -
    // there is nowhere to save the answer - so the costumes step is reached empty and the
    // way out of that dead end is to wrangle instead. This is the one route by which a
    // board still sees that message.
    const restore = await withSettings({ events_costume_field: '0' });
    try {
      const eventId = await createEvent({ title: 'Costumeless Wrangle Out' });

      await loginAs(page, 'trooper2');
      await page.goto(`/rsvp.php?id=${eventId}`);
      await page.locator('#rsvp_submit').click();

      await expect(page.locator('#rsvp_no_costumes')).toContainText(
        'No costumes are listed on your profile',
      );
      await page.locator('#rsvp_wrangle_instead').click();

      await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'attendance');
      await expect(page.locator('#signup_role_wrangler')).toBeChecked();
      expect(await countRsvps(eventId)).toBe(0);
    } finally {
      await restore();
    }
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

  test('a costume dropped from the profile is not carried into the edited signup', async ({ page }) => {
    // The wizard pre-selects what the member already holds, intersected with what is
    // still on their profile - so a costume retired from the profile leaves the signup
    // the next time it is opened rather than being silently re-saved.
    const eventId = await createEvent({ title: 'Retired Costume Troop' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK, TD] });

    // TD retired, TB added - two left, so the costumes step is still shown.
    await setUserField('trooper1', 'costume', `${TK}\n${TB}`);

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    // Only the costumes still on file are offered, and only the one held is ticked.
    await expect(page.locator('#rsvp_page[data-rsvp-step="costumes"]')).toBeVisible();
    await expect(page.locator('input.costume_checkbox')).toHaveCount(2);
    await expect(page.locator(`input.costume_checkbox[value="${TK}"]`)).toBeChecked();
    await expect(page.locator(`input.costume_checkbox[value="${TB}"]`)).not.toBeChecked();

    await page.locator('#rsvp_submit').click();
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success_message')).toBeVisible();

    expect(await getRsvpCostumes(eventId, 'trooper1')).toEqual([TK]);
  });

  test('an event that gains days after a signup opens on every day, not on none', async ({ page }) => {
    // A signup made before the event had days holds no day rows at all. Falling back to
    // the leading answer is what stops the grid coming back with every day marked as
    // being sat out - which would read as "you are attending nothing".
    const eventId = await createEvent({ title: 'Grown Troop' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await execute(
      `INSERT INTO ${T('event_plugin_event_days')} (event_id, date, start_time, end_time) VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
      [
        eventId, relativeToTestNow({ days: 7 }).slice(0, 10), '09:00:00', '17:00:00',
        eventId, relativeToTestNow({ days: 8 }).slice(0, 10), '09:00:00', '17:00:00',
      ],
    );

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);

    // The leading answer still speaks for the whole event, so the grid stays shut and no
    // day is marked as skipped.
    await expect(page.locator('#signup_per_day')).not.toBeChecked();
    await expect(page.locator('input.day_role_radio[value="none"]:checked')).toHaveCount(0);

    // attendance -> costumes (the signup is a trooper one) -> confirm -> done.
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_page[data-rsvp-step="costumes"]')).toBeVisible();
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_page[data-rsvp-step="confirm"]')).toBeVisible();
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success_message')).toBeVisible();

    const dayIds = (await getEventDays(eventId)).map((day) => Number(day.id));
    expect(await getRsvpDayIds(eventId, 'trooper1')).toEqual(dayIds);
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

// A member cleared to troop in a costume that is not on their Legion record yet says so on
// the costumes step, when the board has preapprovals turned on. It is saved as a costume
// named "Preapproval: ..." so everything that lists costumes shows it as it is.
test.describe('preapproved costumes', () => {
  const PREAPPROVED = 'Clone Trooper Phase 2';
  let restoreSettings: () => Promise<void>;

  test.beforeEach(async () => {
    restoreSettings = await withSettings({ events_preapproval_enabled: '1' });
  });

  test.afterEach(async () => {
    await restoreSettings();
  });

  test('a member with one costume is still shown the step, with it ticked', async ({ page }) => {
    const eventId = await createEvent({ title: 'One Costume Preapproval Troop' });
    await setUserField('trooper1', 'costume', TK);

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
    await expect(page.locator(`input.costume_checkbox[value="${TK}"]`)).toBeChecked();
    await expect(page.locator('#costume_preapproval')).not.toBeChecked();
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#confirm_costumes')).toHaveText(TK);
  });

  test('is not offered when the board has it turned off', async ({ page }) => {
    await restoreSettings();
    restoreSettings = await withSettings({ events_preapproval_enabled: '0' });
    const eventId = await createEvent({ title: 'No Preapproval Troop' });

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
    await expect(page.locator('#costume_preapproval')).toHaveCount(0);
  });

  test('a member troops in a preapproved costume instead of one on file', async ({ page }) => {
    const eventId = await createEvent({ title: 'Preapproval Troop' });
    await setUserField('trooper1', 'costume', TK);

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
    await page.locator(`input.costume_checkbox[value="${TK}"]`).uncheck();
    // Typing ticks the box.
    await page.locator('#costume_preapproval_text').fill(PREAPPROVED);
    await expect(page.locator('#costume_preapproval')).toBeChecked();
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
    await expect(page.locator('#confirm_costumes')).toHaveText(`Preapproval: ${PREAPPROVED}`);
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_summary_costumes')).toContainText(`Preapproval: ${PREAPPROVED}`);

    expect(await getRsvpCostumes(eventId, 'trooper1')).toEqual([`Preapproval: ${PREAPPROVED}`]);
  });

  test('a preapproval goes alongside costumes on file', async ({ page }) => {
    const eventId = await createEvent({ title: 'Preapproval And Costume Troop' });

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    await page.locator(`input.costume_checkbox[value="${TK}"]`).check();
    await page.locator('#costume_preapproval').check();
    await page.locator('#costume_preapproval_text').fill(PREAPPROVED);
    await page.locator('#rsvp_submit').click();
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success_message')).toBeVisible();

    expect((await getRsvpCostumes(eventId, 'trooper1')).sort()).toEqual([TK, `Preapproval: ${PREAPPROVED}`].sort());
  });

  test('asks for the costume when the preapproval box is ticked with nothing typed', async ({ page }) => {
    const eventId = await createEvent({ title: 'Empty Preapproval Troop' });

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    await page.locator(`input.costume_checkbox[value="${TK}"]`).check();
    await page.locator('#costume_preapproval').check();
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
    await expect(page.locator('#rsvp_errors')).toContainText('Please enter the costume you are preapproved for');
    await expect(page.locator('#costume_preapproval')).toBeChecked();
    expect(await countRsvps(eventId)).toBe(0);
  });

  test('editing the signup brings the preapproval back', async ({ page }) => {
    const eventId = await createEvent({ title: 'Edit Preapproval Troop' });
    await createRsvp(eventId, 'trooper1', { costumes: [`Preapproval: ${PREAPPROVED}`] });

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
    await expect(page.locator('#costume_preapproval')).toBeChecked();
    await expect(page.locator('#costume_preapproval_text')).toHaveValue(PREAPPROVED);
    await expect(page.locator('input.costume_checkbox:checked')).toHaveCount(0);

    await page.locator('#rsvp_submit').click();
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success_message')).toBeVisible();
    expect(await getRsvpCostumes(eventId, 'trooper1')).toEqual([`Preapproval: ${PREAPPROVED}`]);
  });

  test.describe('with the script off', () => {
    test.use({ javaScriptEnabled: false });

    test('the box is ticked by hand', async ({ page }) => {
      const eventId = await createEvent({ title: 'Scriptless Preapproval Troop' });

      await loginAs(page, 'trooper1');
      await page.goto(`/rsvp.php?id=${eventId}`);
      await page.locator('#rsvp_submit').click();

      await page.locator('#costume_preapproval').check();
      await page.locator('#costume_preapproval_text').fill(PREAPPROVED);
      await page.locator('#rsvp_submit').click();
      await page.locator('#rsvp_submit').click();
      await expect(page.locator('#rsvp_success_message')).toBeVisible();

      expect(await getRsvpCostumes(eventId, 'trooper1')).toEqual([`Preapproval: ${PREAPPROVED}`]);
    });
  });
});

// A double-clicked Confirm is two requests racing through events_save_signup(). Both used
// to read "no signup yet", so the second insert tripped the event_user_role key and came
// back as an SQL error - or, editing a signup, both rewrote its costumes and left each
// one twice. The second is now processed as an update to the first.
test.describe('signup confirmed twice at once', () => {
  async function toConfirmStep(page: Page, eventId: number) {
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
    await page.locator(`input.costume_checkbox[value="${TK}"]`).check();
    await page.locator(`input.costume_checkbox[value="${TB}"]`).check();
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
  }

  function expectEverySignupSaved(bodies: string[]) {
    for (const body of bodies) {
      expect(body).not.toMatch(/SQL Error|Fatal error/);
      expect(body).toContain('id="rsvp_success_message"');
    }
  }

  test('a new signup is written once', async ({ page }) => {
    const eventId = await createEvent({ title: 'Double Click Troop' });

    await loginAs(page, 'trooper1');
    await toConfirmStep(page, eventId);
    expectEverySignupSaved(await submitFormAtOnce(page, '#rsvp_form', { times: 3 }));

    expect(await getSignupRoles(eventId, 'trooper1')).toEqual(['trooper']);
    expect((await getRsvpCostumes(eventId, 'trooper1')).sort()).toEqual([TK, TB].sort());
  });

  test('an edited signup keeps each costume once', async ({ page }) => {
    const eventId = await createEvent({ title: 'Double Click Edit Troop' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await loginAs(page, 'trooper1');
    await toConfirmStep(page, eventId);
    expectEverySignupSaved(await submitFormAtOnce(page, '#rsvp_form', { times: 3 }));

    expect(await countRsvps(eventId)).toBe(1);
    expect((await getRsvpCostumes(eventId, 'trooper1')).sort()).toEqual([TK, TB].sort());
  });
});
