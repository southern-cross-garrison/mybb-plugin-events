import { test, expect } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import { rsvpThroughWizard, wrangleThroughWizard } from '../helpers/rsvp';
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

test.describe('wrangler signup', () => {
  test('a provisioned wrangler lands straight on the confirmation', async ({ page }) => {
    const eventId = await createEvent({ title: 'Single Day Wrangle' });

    await loginAs(page, 'wrangler');
    await page.goto(`/rsvp.php?id=${eventId}&role=wrangler`);

    // Nothing missing and no days to pick, so there is nothing left to ask.
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-role', 'wrangler');
    await expect(page.locator('input.costume_checkbox')).toHaveCount(0);
    await expect(page.locator('#confirm_role')).toHaveText('Wrangler');
    await expect(page.locator('#confirm_costumes')).toHaveCount(0);

    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success_message')).toContainText('signed up to wrangle');

    expect(await getSignupRoles(eventId, 'wrangler')).toEqual(['wrangler']);
    expect(await getRsvpCostumes(eventId, 'wrangler', 'wrangler')).toEqual([]);
  });

  test('never asks a wrangler for a TK ID', async ({ page }) => {
    const eventId = await createEvent({ title: 'No TKID Wrangle' });

    await loginAs(page, 'newbie');
    await page.goto(`/rsvp.php?id=${eventId}&role=wrangler`);

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');
    await expect(page.locator('#prereq_tk_id')).toHaveCount(0);
    await expect(page.locator('#prereq_mobile')).toBeVisible();
    await expect(page.locator('#prereq_emergency_contact')).toBeVisible();
  });

  test('collects the contact details a wrangler is missing and saves them', async ({ page }) => {
    const eventId = await createEvent({ title: 'Prereq Wrangle' });

    await loginAs(page, 'newbie');
    await wrangleThroughWizard(page, eventId, {
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
    await page.goto(`/rsvp.php?id=${eventId}&role=wrangler`);

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
    await wrangleThroughWizard(page, eventId);

    // The "add your costumes" dead end belongs to the trooper flow only.
    await expect(page.locator('#rsvp_no_costumes')).toHaveCount(0);
    expect(await countRsvps(eventId, 'wrangler')).toBe(1);
  });

  test('collects days from a wrangler on a multi-day event', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Multi Day Wrangle',
      days: [{ date: '2026-10-10' }, { date: '2026-10-11' }],
    });
    const days = await getEventDays(eventId);

    await loginAs(page, 'wrangler');
    await wrangleThroughWizard(page, eventId, { dayIds: [Number(days[1].id)] });

    expect(await getRsvpDayIds(eventId, 'wrangler', 'wrangler')).toEqual([Number(days[1].id)]);
  });

  test('cannot reach the costumes step or record a costume', async ({ page }) => {
    const eventId = await createEvent({ title: 'Forced Costume Wrangle' });

    await loginAs(page, 'wrangler');
    await page.goto(`/rsvp.php?id=${eventId}&role=wrangler`);

    // Hand-craft the POST the costumes step would have made.
    await page.evaluate(
      ({ id, costume }) => {
        const form = document.querySelector('#rsvp_form') as HTMLFormElement;
        (form.querySelector('input[name="step"]') as HTMLInputElement).value = 'costumes';
        const extra = document.createElement('input');
        extra.name = 'costumes[]';
        extra.value = costume;
        form.appendChild(extra);
        (form.querySelector('input[name="id"]') as HTMLInputElement).value = String(id);
        form.submit();
      },
      { id: eventId, costume: TK },
    );

    await expect(page.locator('#rsvp_page')).not.toHaveAttribute('data-rsvp-step', 'costumes');
    expect(await getRsvpCostumes(eventId, 'wrangler', 'wrangler')).toEqual([]);
  });

  test('refuses to record a signup while prerequisites are still missing', async ({ page }) => {
    const eventId = await createEvent({ title: 'Skip Prereq Wrangle' });

    await loginAs(page, 'newbie');
    await page.goto(`/rsvp.php?id=${eventId}&role=wrangler`);

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

test.describe('trooping and wrangling the same event', () => {
  test('a member can troop and then also wrangle', async ({ page }) => {
    const eventId = await createEvent({ title: 'Both Roles Troop' });

    await loginAs(page, 'trooper1');
    await rsvpThroughWizard(page, eventId, { costumes: [TK] });
    await wrangleThroughWizard(page, eventId);

    expect((await getSignupRoles(eventId, 'trooper1')).sort()).toEqual(['trooper', 'wrangler']);
    expect(await getRsvpCostumes(eventId, 'trooper1', 'trooper')).toEqual([TK]);
    expect(await getRsvpCostumes(eventId, 'trooper1', 'wrangler')).toEqual([]);
  });

  test('wrangling first does not block RSVPing as a trooper', async ({ page }) => {
    const eventId = await createEvent({ title: 'Wrangle First Troop' });
    await createRsvp(eventId, 'trooper1', { role: 'wrangler' });

    await loginAs(page, 'trooper1');

    // The listing must still offer the RSVP link, not just report "Attending".
    await page.goto('/events.php');
    const row = page.locator(`tr[data-event-id="${eventId}"]`);
    await expect(row.locator('.event_wrangling')).toBeVisible();
    await expect(row.locator('.event_rsvp_link')).toBeVisible();

    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_wrangle_status')).toBeVisible();
    await expect(page.locator('#event_rsvp')).toBeVisible();

    await rsvpThroughWizard(page, eventId, { costumes: [TK] });
    expect((await getSignupRoles(eventId, 'trooper1')).sort()).toEqual(['trooper', 'wrangler']);
  });

  test('refuses a second wrangler signup but still offers the RSVP link', async ({ page }) => {
    const eventId = await createEvent({ title: 'Duplicate Wrangle' });
    await createRsvp(eventId, 'wrangler', { role: 'wrangler' });

    await loginAs(page, 'wrangler');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_wrangle_status')).toBeVisible();
    await expect(page.locator('#event_wrangle')).toHaveCount(0);

    await page.goto(`/rsvp.php?id=${eventId}&role=wrangler`);
    await expect(page.locator('body')).toContainText('already signed up to wrangle');
    expect(await countRsvps(eventId, 'wrangler')).toBe(1);
  });
});

test.describe('wrangler signup locking', () => {
  test('an excluded member cannot wrangle either, and is told once', async ({ page }) => {
    const eventId = await createEvent({ title: 'Excluded Wrangle', excluded: ['excluded'] });

    await loginAs(page, 'excluded');
    await page.goto(`/event.php?id=${eventId}`);

    await expect(page.locator('#event_rsvp_locked')).toHaveAttribute('data-lock-reason', 'excluded');
    await expect(page.locator('#event_wrangle')).toHaveCount(0);
    // The exclusion message must not be rendered twice.
    await expect(page.locator('#event_wrangle_locked')).toHaveCount(0);

    await page.goto(`/rsvp.php?id=${eventId}&role=wrangler`);
    await expect(page.locator('body')).toContainText('excluded from RSVPing');
    expect(await countRsvps(eventId)).toBe(0);
  });

  test('a passed cutoff closes wrangling as well as trooping', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Cutoff Wrangle',
      start: relativeToTestNow({ days: 3 }),
      end: relativeToTestNow({ days: 3, hours: 6 }),
      signupCutoff: relativeToTestNow({ days: 1 }),
    });

    await loginAs(page, 'wrangler');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_wrangle')).toBeVisible();

    await setClock(relativeToTestNow({ days: 2 }));

    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_wrangle')).toHaveCount(0);

    await page.goto(`/rsvp.php?id=${eventId}&role=wrangler`);
    await expect(page.locator('body')).toContainText('RSVPs for this event have closed');
  });
});

test.describe('wranglers on coordinator surfaces', () => {
  test('appear in the RSVP list with a role, after the troopers', async ({ page }) => {
    const eventId = await createEvent({ title: 'Roster Wrangle' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });
    await createRsvp(eventId, 'wrangler', { role: 'wrangler' });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}&action=rsvps`);

    await expect(page.locator('tr.rsvp_row')).toHaveCount(2);
    const rows = page.locator('tr.rsvp_row');
    await expect(rows.nth(0).locator('.rsvp_role')).toHaveText('Trooper');
    await expect(rows.nth(1).locator('.rsvp_role')).toHaveText('Wrangler');
    await expect(rows.nth(1).locator('.rsvp_tkid')).toHaveText('');
    await expect(rows.nth(1).locator('.rsvp_costumes')).toHaveText('');
  });

  test('drop out of the RSVP list when it is filtered by costume', async ({ page }) => {
    const eventId = await createEvent({ title: 'Filtered Wrangle' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });
    await createRsvp(eventId, 'wrangler', { role: 'wrangler' });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}&action=rsvps&filter_costume=${encodeURIComponent(TK)}`);

    await expect(page.locator('tr.rsvp_row')).toHaveCount(1);
    await expect(page.locator('tr.rsvp_row .rsvp_username')).toHaveText('trooper1');
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

  test('a wrangler-only signup still gets the iCal download', async ({ page }) => {
    const eventId = await createEvent({ title: 'Ical Wrangle' });
    await createRsvp(eventId, 'wrangler', { role: 'wrangler' });

    await loginAs(page, 'wrangler');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_ical')).toBeVisible();
  });
});
