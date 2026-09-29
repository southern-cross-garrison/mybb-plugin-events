import { Page } from '@playwright/test';
import { test, expect, expectMyBBError } from '../helpers/fixtures';
import { loginAs, loginToAdminCp, gotoEventsAdmin } from '../helpers/auth';
import { runScheduledTask } from '../helpers/container';
import { relativeToTestNow } from '../helpers/clock';
import {
  createEvent,
  createRsvp,
  countPrivateMessages,
  getEvent,
  getEventDays,
  getRsvpCostumes,
  getRsvpStatus,
  getSignupRoles,
  getUserField,
  query,
  T,
} from '../helpers/db';

/**
 * A social event is a plain signup sheet: one list of attendees, with a cap and a waitlist
 * if the coordinator sets one, and none of what a troop asks of the people on it - no
 * costume, no Legion ID, no mobile or emergency contact - and no troop report afterwards,
 * so nobody is credited with trooping it.
 */

/** Walk a social event's wizard to its confirmation and confirm. */
async function attend(page: Page, eventId: number, prerequisites: Record<string, string> = {}) {
  await page.goto(`/rsvp.php?id=${eventId}`);
  await page.locator('#signup_role_attendee').check();
  await page.locator('#rsvp_submit').click();

  if ((await page.locator('#rsvp_page[data-rsvp-step="prerequisites"]').count()) > 0) {
    for (const [field, value] of Object.entries(prerequisites)) {
      await page.locator(`#prereq_${field}`).fill(value);
    }
    await page.locator('#rsvp_submit').click();
  }

  await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
  await page.locator('#rsvp_submit').click();
  await expect(page.locator('#rsvp_success_message')).toBeVisible();
}

async function fillDateTime(page: Page, id: string, value: string) {
  const [date, time] = value.split(' ');
  await page.locator(`#${id}`).fill(date ?? '');
  await page.locator(`#${id}_time`).fill(time ? time.slice(0, 5) : '');
}

test.describe('signing up to a social event', () => {
  test('asks only for a name to call them by, and nothing about trooping', async ({ page }) => {
    const eventId = await createEvent({ title: 'Garrison Barbecue', eventType: 'social' });

    // newbie has a costume on file and nothing else: no name, no numbers, no Legion ID.
    await loginAs(page, 'newbie');
    await page.goto(`/rsvp.php?id=${eventId}`);

    await expect(page.locator('#signup_role_label')).toHaveText('Are you attending?');
    await expect(page.locator('input[name="signup_role"]')).toHaveCount(1);
    await expect(page.locator('#signup_role_trooper')).toHaveCount(0);
    await expect(page.locator('#signup_role_wrangler')).toHaveCount(0);

    await page.locator('#signup_role_attendee').check();
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');
    await expect(page.locator('#prereq_preferred_name')).toBeVisible();
    await expect(page.locator('#prereq_mobile')).toHaveCount(0);
    await expect(page.locator('#prereq_emergency_contact')).toHaveCount(0);
    await expect(page.locator('#prereq_tk_id')).toHaveCount(0);
    await expect(page.locator('#prereq_costume')).toHaveCount(0);

    await page.locator('#prereq_preferred_name').fill('Newt');
    await page.locator('#rsvp_submit').click();

    // Straight to the confirmation: there is no costume to be in.
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
    await expect(page.locator('#confirm_roles')).toHaveCount(0);
    await expect(page.locator('#confirm_costumes')).toHaveCount(0);
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success_message')).toContainText('signed up to attend');

    expect(await getSignupRoles(eventId, 'newbie')).toEqual(['attendee']);
    expect(await getRsvpCostumes(eventId, 'newbie', 'attendee')).toEqual([]);
    expect(await getUserField('newbie', 'preferred_name')).toBe('Newt');
    expect(await getUserField('newbie', 'mobile')).toBe('');
  });

  test('a troop role cannot be posted to a social event', async ({ page }) => {
    const eventId = await createEvent({ title: 'Trivia Night', eventType: 'social' });

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);

    // A hand-made POST naming a troop role, straight at the confirm step.
    await page.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>('#rsvp_form')!;
      form.querySelector<HTMLInputElement>('input[name="step"]')!.value = 'confirm';
      const role = document.createElement('input');
      role.type = 'hidden';
      role.name = 'signup_role';
      role.value = 'trooper';
      form.querySelectorAll('input[name="signup_role"]').forEach((radio) => radio.remove());
      form.appendChild(role);
      form.submit();
    });
    await page.waitForLoadState();

    // Read as the event's one role, which is all a social event can hold.
    expect(await getSignupRoles(eventId, 'trooper1')).toEqual(['attendee']);
    expect(await getRsvpCostumes(eventId, 'trooper1', 'attendee')).toEqual([]);
  });

  test('offers per-day attendance on an event of several days', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Weekend Camp Out',
      eventType: 'social',
      start: '2026-10-24 09:00:00',
      end: '2026-10-25 17:00:00',
      days: [{ date: '2026-10-24' }, { date: '2026-10-25' }],
    });
    const [saturday, sunday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));

    await loginAs(page, 'wrangler');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await expect(page.locator('label[for="signup_per_day"]')).toHaveText('I am not coming every day');
    await page.locator('#signup_per_day').check();
    await expect(page.locator(`#day_${saturday}_trooper`)).toHaveCount(0);
    await page.locator(`#day_${sunday}_none`).check();
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
    await expect(page.locator('#confirm_days_attendee')).toContainText('24');
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success_message')).toBeVisible();

    const days = await query(
      `SELECT d.event_day_id FROM ${T('event_plugin_rsvp_days')} d
         INNER JOIN ${T('event_plugin_rsvps')} r ON r.id = d.rsvp_id
        WHERE r.event_id = ? AND r.role = 'attendee'`,
      [eventId],
    );
    expect(days.map((row: any) => Number(row.event_day_id))).toEqual([saturday]);
  });
});

test.describe('a social event with a cap', () => {
  test('waitlists once full, and gives a freed place to whoever is waiting', async ({ page }) => {
    const eventId = await createEvent({ title: 'Movie Night', eventType: 'social', coordinator: 'gec', maxAttendees: 1 });
    await createRsvp(eventId, 'trooper1', { role: 'attendee', at: relativeToTestNow({ days: -1 }) });

    await loginAs(page, 'trooper2');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_signup')).toHaveText('Join Waitlist');
    await expect(page.locator('#event_capacity')).toHaveText('1 attendee');

    await page.goto(`/rsvp.php?id=${eventId}`);
    await expect(page.locator('label:has(#signup_role_attendee)')).toContainText('full - join the waitlist');
    await page.locator('#signup_role_attendee').check();
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_submit')).toHaveValue('Join the Waitlist');
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success')).toHaveAttribute('data-signup-mode', 'waitlist');
    expect(await getRsvpStatus(eventId, 'trooper2', 'attendee')).toBe('waitlisted');

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#signup_role_none').check();
    await page.locator('#rsvp_submit').click();
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success')).toHaveAttribute('data-signup-mode', 'withdraw');

    expect(await getRsvpStatus(eventId, 'trooper2', 'attendee')).toBe('attending');
    expect(await countPrivateMessages('trooper2', 'You have a place: Movie Night')).toBe(1);
  });
});

test.describe('the social event page', () => {
  test('counts attendees and says what kind of event it is', async ({ page }) => {
    const eventId = await createEvent({ title: 'Pub Quiz', eventType: 'social' });
    await createRsvp(eventId, 'trooper1', { role: 'attendee' });
    await createRsvp(eventId, 'wrangler', { role: 'attendee' });

    await loginAs(page, 'trooper2');
    await page.goto(`/event.php?id=${eventId}`);

    await expect(page.locator('#event_page')).toHaveAttribute('data-event-type', 'social');
    await expect(page.locator('#event_type')).toHaveText('Social');
    await expect(page.locator('#event_attendee_count')).toHaveText('2');
    await expect(page.locator('#event_signup_counts')).toContainText('Attendees');
    await expect(page.locator('#event_rsvp_count')).toHaveCount(0);
    await expect(page.locator('#event_wrangler_count')).toHaveCount(0);

    // Nobody is in costume, and a Legion ID on somebody's profile says nothing here.
    await expect(page.locator('#filter_costume')).toHaveCount(0);
    await expect(page.locator('#rsvp_rows .rsvp_tkid')).toHaveCount(0);
    await expect(page.locator('#rsvp_rows .rsvp_role').first()).toHaveText('Attendee');

    await page.goto('/events.php');
    const row = page.locator(`.event_row[data-event-id="${eventId}"]`);
    await expect(row.locator('.event_type_social')).toHaveText('Social');
    await expect(row.locator('.event_count_attendee')).toHaveAttribute('title', 'Attendees');
    await expect(row.locator('.event_count_trooper')).toHaveCount(0);
  });

  test('the attendance sheet leaves out Legion IDs and costumes but keeps contact details', async ({ page }) => {
    const eventId = await createEvent({ title: 'Committee Lunch', eventType: 'social', coordinator: 'gec' });
    await createRsvp(eventId, 'trooper1', { role: 'attendee' });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}&action=attendance`);

    await expect(page.locator('#attendance_table')).toHaveClass(/is_social/);
    await expect(page.locator('#attendance_table th.attendee_tkid')).toHaveCount(0);
    await expect(page.locator('#attendance_table th.attendee_costumes')).toHaveCount(0);

    const row = page.locator('#attendance_table tbody.attendee_group').first();
    await expect(row.locator('.attendee_role')).toHaveText('Attendee');
    await expect(row.locator('.attendee_mobile')).toHaveText('0400 000 002');
    await expect(row.locator('.attendee_emergency')).toHaveText('Kin Trooper 0400 111 002');
  });
});

test.describe('no troop report for a social event', () => {
  test('is complete once over, offers no report and refuses one', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Awards Night',
      eventType: 'social',
      start: relativeToTestNow({ days: -2 }),
      end: relativeToTestNow({ days: -2, hours: 4 }),
    });
    await createRsvp(eventId, 'trooper1', { role: 'attendee' });

    await loginAs(page, 'trooper1');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_status')).toHaveText('Complete');
    await expect(page.locator('#event_troop_report')).toHaveCount(0);

    await page.goto(`/troop_report.php?id=${eventId}`);
    await expectMyBBError(page, 'Social events do not have troop reports.');

    await page.goto('/events.php');
    await expect(page.locator(`.event_row[data-event-id="${eventId}"] .event_status`)).toHaveText('Complete');
  });

  test('sends no troop report reminder', async () => {
    const eventId = await createEvent({
      title: 'Christmas Party',
      eventType: 'social',
      start: relativeToTestNow({ days: -3 }),
      end: relativeToTestNow({ days: -2 }),
    });
    await createRsvp(eventId, 'trooper1', { role: 'attendee' });

    await runScheduledTask('events_reminders');

    expect(await countPrivateMessages('trooper1', 'Troop Report Needed:%')).toBe(0);
  });
});

test.describe('creating a social event', () => {
  test('from the front end, with a cap for attendees and none for the troop roles', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    // Only the chosen type's maximums are on show.
    await expect(page.locator('#event_form_max_troopers')).toBeVisible();
    await expect(page.locator('#event_form_max_attendees')).toBeHidden();
    await page.locator('#event_form_max_troopers').fill('8');

    await page.locator('#event_form_title').fill('Family Picnic');
    await page.locator('#event_form_event_type').selectOption('social');
    await expect(page.locator('#event_form_max_troopers')).toBeHidden();
    await expect(page.locator('#event_form_max_attendees')).toBeVisible();
    await page.locator('#event_form_max_attendees').fill('30');
    await page.locator('#event_form_status').selectOption('live');
    await fillDateTime(page, 'event_form_start_date', relativeToTestNow({ days: 10 }));
    await fillDateTime(page, 'event_form_end_date', relativeToTestNow({ days: 10, hours: 4 }));
    await page.locator('#manage_event_submit').click();
    await expect(page.locator('#event_page')).toBeVisible();

    const [created] = await query(`SELECT * FROM ${T('event_plugin_events')} WHERE title = 'Family Picnic'`);
    expect((created as any).event_type).toBe('social');
    expect(Number((created as any).max_attendees)).toBe(30);
    // Typed in before the type was changed, and hidden since: not a maximum of anything.
    expect(Number((created as any).max_troopers)).toBe(0);
  });

  test('from the Admin CP', async ({ page }) => {
    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=add');

    await page.locator('#title').fill('Admin Social');
    await page.locator('#event_type').selectOption('social');
    await expect(page.locator('#max_troopers')).toBeHidden();
    await expect(page.locator('#max_wranglers')).toBeHidden();
    await page.locator('#max_attendees').fill('12');
    await fillDateTime(page, 'start_date', relativeToTestNow({ days: 14 }));
    await fillDateTime(page, 'end_date', relativeToTestNow({ days: 14, hours: 3 }));
    await page.locator('input[type="submit"][value="Create Event"]').click();
    await expect(page.locator('#flash_message')).toContainText('Event created successfully');

    const [created] = await query(`SELECT * FROM ${T('event_plugin_events')} WHERE title = 'Admin Social'`);
    expect((created as any).event_type).toBe('social');
    expect(Number((created as any).max_attendees)).toBe(12);
  });

  test('the type cannot be changed once somebody has signed up', async ({ page }) => {
    const eventId = await createEvent({ title: 'Locked In Troop', coordinator: 'gec' });
    await createRsvp(eventId, 'trooper1');

    await loginAs(page, 'gec');
    await page.goto(`/manage_event.php?id=${eventId}`);
    await page.locator('#event_form_event_type').selectOption('social');
    await page.locator('#manage_event_submit').click();

    await expect(page.locator('#manage_event_page')).toContainText('The event type cannot be changed once members have signed up.');
    expect((await getEvent(eventId)).event_type).toBe('troop');
  });
});
