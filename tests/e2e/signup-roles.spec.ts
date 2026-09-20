import { test, expect } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import { signUpThroughWizard } from '../helpers/rsvp';
import { relativeToTestNow, setClock } from '../helpers/clock';
import {
  createEvent,
  createRsvp,
  countRsvps,
  getEventDays,
  getRsvpCostumes,
  getRsvpDayIds,
  getSignupRoles,
  getUserField,
  fixtures,
} from '../helpers/db';

const [TK, TD] = [0, 1].map((index) => fixtures().costumeOptions[index]);

/** The prerequisites the `wrangler` fixture user already has on file. */
const WRANGLER_CONTACT = {
  mobile: '0400 000 006',
  emergency_contact: 'Kin Wrangler 0400 111 006',
};

test.describe('choosing how to attend', () => {
  test('a provisioned member who picks wrangling goes straight to the confirmation', async ({ page }) => {
    const eventId = await createEvent({ title: 'Single Day Wrangle' });

    await loginAs(page, 'wrangler');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#signup_role_wrangler').check();
    await page.locator('#rsvp_submit').click();

    // Nothing missing and nothing to be in costume for, so there is nothing left to ask.
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
    await expect(page.locator('input.costume_checkbox')).toHaveCount(0);
    await expect(page.locator('#confirm_roles')).toHaveText('Wrangler');
    await expect(page.locator('#confirm_costumes')).toHaveCount(0);

    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success_message')).toContainText('signed up to attend');

    expect(await getSignupRoles(eventId, 'wrangler')).toEqual(['wrangler']);
    expect(await getRsvpCostumes(eventId, 'wrangler', 'wrangler')).toEqual([]);
  });

  test('never asks for a TK ID when nothing is being trooped', async ({ page }) => {
    const eventId = await createEvent({ title: 'No TKID Wrangle' });

    await loginAs(page, 'newbie');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#signup_role_wrangler').check();
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');
    await expect(page.locator('#prereq_tk_id')).toHaveCount(0);
    await expect(page.locator('#prereq_mobile')).toBeVisible();
    await expect(page.locator('#prereq_emergency_contact')).toBeVisible();
  });

  test('collects the contact details a wrangler is missing and saves them', async ({ page }) => {
    const eventId = await createEvent({ title: 'Prereq Wrangle' });

    await loginAs(page, 'newbie');
    await signUpThroughWizard(page, eventId, {
      role: 'wrangler',
      prerequisites: { mobile: '0400 999 111', emergency_contact: 'Next Of Kin 0400 999 222' },
    });

    expect(await getUserField('newbie', 'mobile')).toBe('0400 999 111');
    expect(await getUserField('newbie', 'emergency_contact')).toBe('Next Of Kin 0400 999 222');
    // Still no Legion ID: wranglers are not full members.
    expect(await getUserField('newbie', 'tk_id')).toBe('');
  });

  test('still asks a wrangler for a WWCC when the event requires one', async ({ page }) => {
    const eventId = await createEvent({ title: 'WWCC Wrangle', requiresWwcc: true });

    await loginAs(page, 'wrangler');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#signup_role_wrangler').check();
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');
    await expect(page.locator('#prereq_wwcc')).toBeVisible();
    await expect(page.locator('#prereq_tk_id')).toHaveCount(0);

    await page.locator('#prereq_wwcc').fill('WWCC-9001');
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
    expect(await getUserField('wrangler', 'wwcc')).toBe('WWCC-9001');
  });

  test('signs up a wrangler who has no costumes on their profile', async ({ page }) => {
    const eventId = await createEvent({ title: 'Costumeless Wrangle' });

    await loginAs(page, 'wrangler');
    await signUpThroughWizard(page, eventId, { role: 'wrangler' });

    // The "add your costumes" dead end belongs to the trooping path only.
    await expect(page.locator('#rsvp_no_costumes')).toHaveCount(0);
    expect(await countRsvps(eventId, 'wrangler')).toBe(1);
  });

  test('records no costume for a wrangling-only signup, even if one is forced into the POST', async ({ page }) => {
    const eventId = await createEvent({ title: 'Forced Costume Wrangle' });

    await loginAs(page, 'wrangler');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#signup_role_wrangler').check();
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');

    // Hand-craft the costume the costumes step would have contributed.
    await page.evaluate((costume) => {
      const form = document.querySelector('#rsvp_form') as HTMLFormElement;
      const extra = document.createElement('input');
      extra.name = 'costumes[]';
      extra.value = costume;
      form.appendChild(extra);
      form.submit();
    }, TK);

    await expect(page.locator('#rsvp_success_message')).toBeVisible();
    expect(await getRsvpCostumes(eventId, 'wrangler', 'wrangler')).toEqual([]);
  });

  test('refuses to record a signup while prerequisites are still missing', async ({ page }) => {
    const eventId = await createEvent({ title: 'Skip Prereq Wrangle' });

    await loginAs(page, 'newbie');
    await page.goto(`/rsvp.php?id=${eventId}`);

    // Jump straight to confirm without filling anything in.
    await page.evaluate(() => {
      const form = document.querySelector('#rsvp_form') as HTMLFormElement;
      (form.querySelector('input[name="step"]') as HTMLInputElement).value = 'confirm';
      form.submit();
    });

    await expect(page.locator('#rsvp_errors')).toContainText('Please complete every required field');
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');
    expect(await countRsvps(eventId)).toBe(0);
  });
});

test.describe('mixing trooping and wrangling', () => {
  test('a member can troop one day and wrangle the next', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Mixed Weekend Troop',
      start: '2026-10-17 09:00:00',
      end: '2026-10-18 17:00:00',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const [saturday, sunday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));

    await loginAs(page, 'trooper1');
    await signUpThroughWizard(page, eventId, { costumes: [TK], dayRoles: { [sunday]: 'wrangler' } });

    expect((await getSignupRoles(eventId, 'trooper1')).sort()).toEqual(['trooper', 'wrangler']);
    expect(await getRsvpDayIds(eventId, 'trooper1', 'trooper')).toEqual([saturday]);
    expect(await getRsvpDayIds(eventId, 'trooper1', 'wrangler')).toEqual([sunday]);
    // Only the costumed half of the signup carries costumes.
    expect(await getRsvpCostumes(eventId, 'trooper1', 'trooper')).toEqual([TK]);
    expect(await getRsvpCostumes(eventId, 'trooper1', 'wrangler')).toEqual([]);
  });

  test('a mixed signup is summarised on the confirmation, day by day', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Summarised Weekend Troop',
      start: '2026-10-17 09:00:00',
      end: '2026-10-18 17:00:00',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const [, sunday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#signup_per_day').check();
    await page.locator(`#day_${sunday}_wrangler`).check();
    await page.locator('#rsvp_submit').click();
    await page.locator(`input.costume_checkbox[value="${TK}"]`).check();
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#confirm_roles')).toHaveText('Trooper, Wrangler');
    await expect(page.locator('#confirm_days_trooper')).toContainText('17 Oct 2026');
    await expect(page.locator('#confirm_days_wrangler')).toContainText('18 Oct 2026');
  });

  test('adding wrangling to an existing trooper signup keeps one row per role', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Grow Weekend Troop',
      start: '2026-10-17 09:00:00',
      end: '2026-10-18 17:00:00',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const [saturday, sunday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));
    await createRsvp(eventId, 'trooper1', { costumes: [TK], dayIds: [saturday] });

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);

    // The signup is not the same across both days, so it comes back with the grid open,
    // with the day already on it set to trooping and the one that is not set to not
    // attending.
    await expect(page.locator('#signup_per_day')).toBeChecked();
    await expect(page.locator(`#day_${saturday}_trooper`)).toBeChecked();
    await expect(page.locator(`#day_${sunday}_none`)).toBeChecked();

    await page.locator(`#day_${sunday}_wrangler`).check();
    await page.locator('#rsvp_submit').click();
    await page.locator('#rsvp_submit').click();
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_success_message')).toContainText('has been updated');
    expect((await getSignupRoles(eventId, 'trooper1')).sort()).toEqual(['trooper', 'wrangler']);
    expect(await getRsvpDayIds(eventId, 'trooper1', 'wrangler')).toEqual([sunday]);
  });

  test('switching entirely to wrangling removes the trooper row and its costumes', async ({ page }) => {
    const eventId = await createEvent({ title: 'Switch Troop' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#signup_role_wrangler').check();
    await page.locator('#rsvp_submit').click();
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_success_message')).toBeVisible();
    expect(await getSignupRoles(eventId, 'trooper1')).toEqual(['wrangler']);
    expect(await getRsvpCostumes(eventId, 'trooper1', 'trooper')).toEqual([]);
  });
});

test.describe('the event page and the listing', () => {
  test('offer one signup button, not one per role', async ({ page }) => {
    const eventId = await createEvent({ title: 'One Button Troop' });

    await loginAs(page, 'trooper1');
    await page.goto(`/event.php?id=${eventId}`);

    await expect(page.locator('#event_signup')).toHaveText('Sign Up to Attend');
    await expect(page.locator('.event_action_primary')).toHaveCount(1);
  });

  test('report a mixed signup role by role, with the days each covers', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Reported Weekend Troop',
      start: '2026-10-17 09:00:00',
      end: '2026-10-18 17:00:00',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const [saturday, sunday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));
    await createRsvp(eventId, 'trooper1', { costumes: [TK], dayIds: [saturday] });
    await createRsvp(eventId, 'trooper1', { role: 'wrangler', dayIds: [sunday] });

    await loginAs(page, 'trooper1');
    await page.goto(`/event.php?id=${eventId}`);

    await expect(page.locator('#event_signup_status_trooper')).toContainText('Trooping: 17 Oct');
    await expect(page.locator('#event_signup_status_wrangler')).toContainText('Wrangling: 18 Oct');
    await expect(page.locator('#event_signup')).toHaveCount(0);
    await expect(page.locator('#event_signup_update')).toBeVisible();

    await page.goto('/events.php');
    const row = page.locator(`tr[data-event-id="${eventId}"]`);
    await expect(row.locator('.event_trooping')).toHaveText('Trooping');
    await expect(row.locator('.event_wrangling')).toHaveText('Wrangling');
    await expect(row.locator('.event_signup_link')).toHaveCount(0);
  });

  test('a wrangling-only signup reads as wrangling, not as an unfinished signup', async ({ page }) => {
    const eventId = await createEvent({ title: 'Wrangle Only Troop' });
    await createRsvp(eventId, 'wrangler', { role: 'wrangler' });

    await loginAs(page, 'wrangler');
    await page.goto(`/event.php?id=${eventId}`);

    await expect(page.locator('#event_signup_status_wrangler')).toHaveText('✓ Wrangling');
    await expect(page.locator('#event_signup_status_trooper')).toHaveCount(0);
    // A wrangler is attending, so they get the calendar file too.
    await expect(page.locator('#event_ical')).toBeVisible();
  });

  test('withdraw the update link once signups have closed', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Closing Troop',
      start: relativeToTestNow({ days: 3 }),
      end: relativeToTestNow({ days: 3, hours: 6 }),
      signupCutoff: relativeToTestNow({ days: 1 }),
    });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await loginAs(page, 'trooper1');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_signup_update')).toBeVisible();

    await setClock(relativeToTestNow({ days: 2 }));

    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_signup_status_trooper')).toBeVisible();
    await expect(page.locator('#event_signup_update')).toHaveCount(0);

    await page.goto(`/rsvp.php?id=${eventId}`);
    await expect(page.locator('body')).toContainText('Signups for this event have closed');
  });
});

test.describe('signup locking', () => {
  test('an excluded member cannot sign up in either role, and is told once', async ({ page }) => {
    const eventId = await createEvent({ title: 'Excluded Wrangle', excluded: ['excluded'] });

    await loginAs(page, 'excluded');
    await page.goto(`/event.php?id=${eventId}`);

    await expect(page.locator('#event_signup_locked')).toHaveAttribute('data-lock-reason', 'excluded');
    await expect(page.locator('#event_signup')).toHaveCount(0);
    // There is one gate now, so the message can only be rendered once.
    await expect(page.locator('.event_action_locked')).toHaveCount(1);

    await page.goto(`/rsvp.php?id=${eventId}`);
    await expect(page.locator('body')).toContainText('excluded from signing up');
    expect(await countRsvps(eventId)).toBe(0);
  });

  test('a passed cutoff closes the whole signup', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Cutoff Wrangle',
      start: relativeToTestNow({ days: 3 }),
      end: relativeToTestNow({ days: 3, hours: 6 }),
      signupCutoff: relativeToTestNow({ days: 1 }),
    });

    await loginAs(page, 'wrangler');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_signup')).toBeVisible();

    await setClock(relativeToTestNow({ days: 2 }));

    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_signup')).toHaveCount(0);

    await page.goto(`/rsvp.php?id=${eventId}`);
    await expect(page.locator('body')).toContainText('Signups for this event have closed');
  });
});

test.describe('wranglers on coordinator surfaces', () => {
  test('appear in the RSVP list with a role, after the troopers', async ({ page }) => {
    const eventId = await createEvent({ title: 'Roster Wrangle' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });
    await createRsvp(eventId, 'wrangler', { role: 'wrangler' });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}`);

    await expect(page.locator('li.rsvp_row')).toHaveCount(2);
    const rows = page.locator('li.rsvp_row');
    await expect(rows.nth(0).locator('.rsvp_role')).toHaveText('Trooper');
    await expect(rows.nth(1).locator('.rsvp_role')).toHaveText('Wrangler');
    // A wrangler has neither, so the bullet simply leaves them out rather than carrying
    // two empty slots and the separators between them.
    await expect(rows.nth(1).locator('.rsvp_tkid')).toHaveCount(0);
    await expect(rows.nth(1).locator('.rsvp_costumes')).toHaveCount(0);
  });

  test('drop out of the RSVP list when it is filtered by costume', async ({ page }) => {
    const eventId = await createEvent({ title: 'Filtered Wrangle' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });
    await createRsvp(eventId, 'wrangler', { role: 'wrangler' });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}&filter_costume=${encodeURIComponent(TK)}`);

    await expect(page.locator('li.rsvp_row')).toHaveCount(1);
    await expect(page.locator('li.rsvp_row .rsvp_username')).toHaveText('trooper1');
  });

  test('are on the attendance sheet with contact details but no TK ID or costume', async ({ page }) => {
    const eventId = await createEvent({ title: 'Attendance Wrangle' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });
    await createRsvp(eventId, 'wrangler', { role: 'wrangler' });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}&action=attendance`);

    await expect(page.locator('tr.attendee_row')).toHaveCount(2);

    const row = page.locator('tr.attendee_row').filter({ hasText: 'wrangler' });
    await expect(row.locator('.attendee_role')).toHaveText('Wrangler');
    await expect(row.locator('.attendee_tkid')).toHaveText('');
    await expect(row.locator('.attendee_costumes')).toHaveText('');
    await expect(row.locator('.attendee_mobile')).toHaveText(WRANGLER_CONTACT.mobile);
    await expect(row.locator('.attendee_emergency')).toHaveText(WRANGLER_CONTACT.emergency_contact);
  });

  test('a member who troops one day and wrangles another is listed under both', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Mixed Roster Troop',
      start: '2026-10-17 09:00:00',
      end: '2026-10-18 17:00:00',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const [saturday, sunday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));
    await createRsvp(eventId, 'trooper1', { costumes: [TK], dayIds: [saturday] });
    await createRsvp(eventId, 'trooper1', { role: 'wrangler', dayIds: [sunday] });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}`);

    await expect(page.locator('li.rsvp_row')).toHaveCount(2);
    await expect(page.locator('li.rsvp_row').nth(0).locator('.rsvp_days')).toHaveText('17 Oct');
    await expect(page.locator('li.rsvp_row').nth(1).locator('.rsvp_days')).toHaveText('18 Oct');

    // Filtering by a day shows only the half of the signup that covers it.
    await page.goto(`/event.php?id=${eventId}&filter_day=${sunday}`);
    await expect(page.locator('li.rsvp_row')).toHaveCount(1);
    await expect(page.locator('li.rsvp_row .rsvp_role')).toHaveText('Wrangler');
  });

  test('are counted separately from troopers on the event page', async ({ page }) => {
    const eventId = await createEvent({ title: 'Counted Wrangle' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });
    await createRsvp(eventId, 'trooper2', { costumes: [TD] });
    await createRsvp(eventId, 'wrangler', { role: 'wrangler' });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}`);

    await expect(page.locator('#event_rsvp_count')).toHaveText('2');
    await expect(page.locator('#event_wrangler_count')).toHaveText('1');
  });

  test('show as a trooper/wrangler breakdown on the events listing', async ({ page }) => {
    const eventId = await createEvent({ title: 'Breakdown Troop' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });
    await createRsvp(eventId, 'trooper2', { costumes: [TD] });
    await createRsvp(eventId, 'wrangler', { role: 'wrangler' });

    await loginAs(page, 'gec');
    await page.goto('/events.php');

    const row = page.locator(`tr[data-event-id="${eventId}"]`);
    await expect(row.locator('.event_rsvp_count')).toHaveText('2');
    await expect(row.locator('.event_wrangler_count')).toHaveText('1');
    await expect(row.locator('.event_count_trooper .event_count_dot')).toBeVisible();
    await expect(row.locator('.event_count_wrangler .event_count_dot')).toBeVisible();
  });

  test('an event with only wranglers reads as 0 troopers, not an unexplained 0', async ({ page }) => {
    const eventId = await createEvent({ title: 'Wranglers Only Troop' });
    await createRsvp(eventId, 'wrangler', { role: 'wrangler' });

    await loginAs(page, 'gec');
    await page.goto('/events.php');

    const row = page.locator(`tr[data-event-id="${eventId}"]`);
    await expect(row.locator('.event_rsvp_count')).toHaveText('0');
    await expect(row.locator('.event_wrangler_count')).toHaveText('1');
    // The breakdown must not lean on colour alone.
    await expect(row.locator('.event_count_trooper')).toHaveAttribute('title', 'Troopers');
    await expect(row.locator('.event_count_wrangler')).toHaveAttribute('title', 'Wranglers');
  });
});
