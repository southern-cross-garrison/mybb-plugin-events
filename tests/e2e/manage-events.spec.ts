import { Page } from '@playwright/test';
import { test, expect, expectMyBBError } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import {
  query,
  execute,
  T,
  getEvent,
  getEventDays,
  uid,
  createEvent,
  createRsvp,
  fixtures,
  getRsvpDayIds,
  getSignupRoles,
  countRsvps,
  countPrivateMessages,
  getPrivateMessages,
  setAdditionalGroups,
} from '../helpers/db';
import { relativeToTestNow } from '../helpers/clock';
import { addTags, excludedValue, removeTag, tag, tagOption } from '../helpers/tag-field';
import { descriptionValue, expectEditorAttached, fillDescription } from '../helpers/editor';

/**
 * Coordinators run events but hold no Admin CP rights, so manage_event.php is the only
 * way they can create or correct one. The Admin CP form is covered by admin-events.spec;
 * what matters here is that the front-end form is gated on the plugin's own coordinator
 * check rather than on MyBB's, and that it writes the same rows the Admin CP would.
 */

interface EventFormValues {
  title?: string;
  description?: string;
  status?: string;
  region?: string;
  address?: string;
  start?: string;
  end?: string;
  cutoff?: string;
  requiresWwcc?: boolean;
  coordinator?: string;
  exclusions?: string[];
  days?: Array<{ date: string; start?: string; end?: string }>;
}

/**
 * A date and its time are two controls now that the date box carries a calendar picker, so
 * a 'YYYY-MM-DD HH:MM:SS' fixture is split across the pair. The time input takes whole
 * minutes, which is all it shows or posts.
 */
async function fillDateTime(page: Page, id: string, value: string) {
  const [date, time] = value.split(' ');
  await page.locator(`#${id}`).fill(date ?? '');
  await page.locator(`#${id}_time`).fill(time ? time.slice(0, 5) : '');
}

async function fillEventForm(page: Page, values: EventFormValues) {
  if (values.title !== undefined) await page.locator('#event_form_title').fill(values.title);
  if (values.description !== undefined) await fillDescription(page, 'event_form_description', values.description);
  if (values.status !== undefined) await page.locator('#event_form_status').selectOption(values.status);
  if (values.region !== undefined) await page.locator('#event_form_region').selectOption(values.region);
  if (values.address !== undefined) await page.locator('#event_form_address').fill(values.address);
  if (values.start !== undefined) await fillDateTime(page, 'event_form_start_date', values.start);
  if (values.end !== undefined) await fillDateTime(page, 'event_form_end_date', values.end);
  if (values.cutoff !== undefined) await fillDateTime(page, 'event_form_signup_cutoff', values.cutoff);
  if (values.requiresWwcc) await page.locator('#event_form_requires_wwcc').check();
  if (values.coordinator !== undefined) {
    await page.locator('#event_form_gec_user_id').selectOption({ label: values.coordinator });
  }
  if (values.exclusions !== undefined) await addTags(page, '#event_form_exclusions', values.exclusions);

  // The day rows follow the start and end dates rather than being typed, so a day is
  // addressed by its date and only its hours are filled in.
  for (const day of values.days ?? []) {
    const row = page.locator(`[data-events-day-date="${day.date}"]`);
    await row.locator('input[type="time"]').nth(0).fill((day.start ?? '09:00:00').slice(0, 5));
    await row.locator('input[type="time"]').nth(1).fill((day.end ?? '17:00:00').slice(0, 5));
  }
}

/** The submit is a navigation, so the assertion that follows has to auto-wait. */
async function submitEventForm(page: Page) {
  await page.locator('#manage_event_submit').click();
}

// Waits for the POST to come back, so what is asserted next is the page it returned rather
// than the one it replaced - which has the same warning on it.
async function pressEnterToSubmit(page: Page, field: string) {
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'POST'),
    page.locator(field).press('Enter'),
  ]);
  await page.waitForLoadState();
}

test.describe('front-end event management', () => {
  test('a coordinator creates an event without the Admin CP', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/events.php');

    await page.locator('#events_create').click();
    await expect(page.locator('#manage_event_page')).toHaveAttribute('data-manage-mode', 'create');

    await fillEventForm(page, {
      title: 'Coordinator Run Troop',
      description: 'Booked by the GEC directly.',
      status: 'live',
      region: 'Hunter',
      start: relativeToTestNow({ days: 21 }),
      end: relativeToTestNow({ days: 21, hours: 6 }),
    });
    await submitEventForm(page);

    // Creating lands on the new event rather than back on the listing: the coordinator's
    // next move is almost always to look at what they just made.
    await expect(page.locator('#event_page')).toBeVisible();
    await expect(page.locator('#event_page')).toContainText('Coordinator Run Troop');

    const rows = await query(`SELECT * FROM ${T('event_plugin_events')} WHERE title = 'Coordinator Run Troop'`);
    expect(rows).toHaveLength(1);
    const created = rows[0] as any;
    expect(created.status).toBe('live');
    expect(created.region).toBe('Hunter');
    expect(Number(created.created_by)).toBe(uid('gec'));
    expect(Number(created.gec_user_id)).toBe(uid('gec'));
  });

  test('an event titled and described with emoji saves and reads back intact', async ({ page }) => {
    // Three-byte utf8 tables reject a four-byte character outright under strict mode, so
    // this was an SQL error page rather than a mangled title.
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    await fillEventForm(page, {
      title: '🎃 Halloween Troop',
      description: 'Pasted from Facebook 👻🍬',
      status: 'live',
      start: relativeToTestNow({ days: 21 }),
      end: relativeToTestNow({ days: 21, hours: 6 }),
    });
    await submitEventForm(page);

    await expect(page.locator('#event_page')).toContainText('🎃 Halloween Troop');
    const eventId = Number(await page.locator('#event_page').getAttribute('data-event-id'));
    const saved = await getEvent(eventId);
    expect(saved.title).toBe('🎃 Halloween Troop');
    expect(saved.description).toBe('Pasted from Facebook 👻🍬');
  });

  test('an address typed on the form becomes a map link on the event page', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    await fillEventForm(page, {
      title: 'Venue Troop',
      status: 'live',
      address: '1 Showground Rd, Sydney Olympic Park NSW 2127',
      start: relativeToTestNow({ days: 21 }),
      end: relativeToTestNow({ days: 21, hours: 6 }),
    });
    await submitEventForm(page);

    await expect(page.locator('#event_page')).toBeVisible();
    // Off the card rather than the URL, which names the announcement thread once the
    // event is live.
    const eventId = Number(await page.locator('#event_page').getAttribute('data-event-id'));
    expect((await getEvent(eventId)).address).toBe('1 Showground Rd, Sydney Olympic Park NSW 2127');

    const link = page.locator('#event_address a');
    await expect(link).toHaveText('1 Showground Rd, Sydney Olympic Park NSW 2127');
    await expect(link).toHaveAttribute('href', 'https://www.google.com/maps/search/?api=1&query=1%20Showground%20Rd%2C%20Sydney%20Olympic%20Park%20NSW%202127');
    // Maps opens beside the board, not over it: the member is mid-way through deciding
    // whether to sign up.
    await expect(link).toHaveAttribute('target', '_blank');

    // The field comes back filled in, so correcting a venue is an edit rather than a
    // retype - and an event with no address shows no row at all.
    await page.goto(`/manage_event.php?id=${eventId}`);
    await expect(page.locator('#event_form_address')).toHaveValue('1 Showground Rd, Sydney Olympic Park NSW 2127');

    const plain = await createEvent({ title: 'No Venue Troop' });
    await page.goto(`/event.php?id=${plain}`);
    await expect(page.locator('#event_address')).toHaveCount(0);
  });

  test('a new event defaults to pending and stays invisible to members until set live', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    // The status select is left alone, so this is the form's own default.
    await expect(page.locator('#event_form_status')).toHaveValue('pending');

    await fillEventForm(page, {
      title: 'Draft Troop',
      start: relativeToTestNow({ days: 21 }),
      end: relativeToTestNow({ days: 21, hours: 6 }),
    });
    await submitEventForm(page);
    await expect(page.locator('#event_status')).toHaveText('Pending');

    const eventId = Number((await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Draft Troop'`))[0].id);

    await loginAs(page, 'trooper1');
    await page.goto('/events.php');
    await expect(page.locator('#events_page')).not.toContainText('Draft Troop');
    await page.goto(`/event.php?id=${eventId}`);
    await expectMyBBError(page, /not have permission|no permission/i);
  });

  test('ordinary members are offered no way in, and are turned away if they try', async ({ page }) => {
    const eventId = await createEvent({ title: 'Not Yours Troop', coordinator: 'gec' });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php');
    await expect(page.locator('#events_create')).toHaveCount(0);

    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#gec_edit')).toHaveCount(0);

    await page.goto('/manage_event.php');
    await expectMyBBError(page, /not have permission|no permission/i);

    await page.goto(`/manage_event.php?id=${eventId}`);
    await expectMyBBError(page, /not have permission|no permission/i);

    await expect(await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Not Yours Troop'`)).toHaveLength(1);
  });

  test('the coordinator dropdown lists the configured groups, alphabetically', async ({ page }) => {
    // Who may coordinate is a board setting, not a hard-coded list: the dropdown is
    // whoever is in the Event Coordinator User Groups, by primary group or additional.
    // trooper1 is deliberately left out of the group to prove the filter is real.
    const gecGroup = fixtures().groups.gec;
    const restore = [
      await setAdditionalGroups('trooper2', [gecGroup]),
      await setAdditionalGroups('newbie', [gecGroup]),
      await setAdditionalGroups('trooper1', []),
    ];

    try {
      await loginAs(page, 'gec');
      await page.goto('/manage_event.php');

      const options = page.locator('#event_form_gec_user_id option');
      // Led by a blank option, which is what an event whose coordinator has been deleted
      // falls back to instead of whoever sorts first (member-deletion.spec.ts).
      await expect(options).toHaveText(['Choose a coordinator', 'gec', 'newbie', 'trooper2']);
    } finally {
      for (const undo of restore) await undo();
    }
  });

  test('the coordinator dropdown keeps an event\'s own coordinator after they leave the group', async ({ page }) => {
    const eventId = await createEvent({ title: 'Handover Troop', coordinator: 'trooper2' });

    // trooper2 ran this event and has since left the coordinator groups. Editing the
    // event is not the moment to silently reassign it to somebody else, so they stay on
    // the list - but only for their own event.
    const restore = await setAdditionalGroups('trooper2', []);

    try {
      await loginAs(page, 'gec');
      await page.goto(`/manage_event.php?id=${eventId}`);

      const options = page.locator('#event_form_gec_user_id option');
      await expect(options).toHaveText(['Choose a coordinator', 'gec', 'trooper2']);
      await expect(page.locator('#event_form_gec_user_id')).toHaveValue(String(uid('trooper2')));

      await page.goto('/manage_event.php');
      await expect(page.locator('#event_form_gec_user_id option')).toHaveText(['Choose a coordinator', 'gec']);
    } finally {
      await restore();
    }
  });

  test('a coordinator edits an event from the event page', async ({ page }) => {
    const eventId = await createEvent({ title: 'Needs A Fix Troop', status: 'pending', coordinator: 'gec' });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}`);
    await page.locator('#gec_edit').click();

    await expect(page.locator('#manage_event_page')).toHaveAttribute('data-manage-mode', 'edit');
    await expect(page.locator('#event_form_title')).toHaveValue('Needs A Fix Troop');

    await fillEventForm(page, { title: 'Fixed Up Troop', status: 'live', region: 'Canberra' });
    await submitEventForm(page);

    await expect(page.locator('#event_status')).toHaveText('Live');

    const event = await getEvent(eventId);
    expect(event.title).toBe('Fixed Up Troop');
    expect(event.status).toBe('live');
    expect(event.region).toBe('Canberra');

    // Editing must not fork the event into a second row.
    expect(await query(`SELECT id FROM ${T('event_plugin_events')}`)).toHaveLength(1);
  });

  test('saves event days, and keeps them when the event is edited again', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    await fillEventForm(page, {
      title: 'Weekend Troop',
      status: 'live',
      start: '2026-10-24 09:00:00',
      end: '2026-10-25 17:00:00',
      days: [
        { date: '2026-10-24', start: '09:00:00', end: '17:00:00' },
        { date: '2026-10-25', start: '10:00:00', end: '16:00:00' },
      ],
    });
    await submitEventForm(page);
    await expect(page.locator('#event_days li.event_day')).toHaveCount(2);

    const eventId = Number((await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Weekend Troop'`))[0].id);
    const days = await getEventDays(eventId);
    expect(days.map((day: any) => String(day.date))).toEqual(['2026-10-24', '2026-10-25']);
    expect(String(days[1].start_time)).toBe('10:00:00');

    // Re-opening draws exactly the days the event covers, with the hours already set.
    await page.goto(`/manage_event.php?id=${eventId}`);
    await expect(page.locator('#event_form_days [data-events-day-date]')).toHaveCount(2);
    await expect(page.locator('#event_form_day_1_start')).toHaveValue('10:00');

    // A third day is added by extending the event, not by finding a spare row: pushing the
    // end date out a day grows the grid, and the hours already entered stay where they are.
    await fillEventForm(page, { end: '2026-10-26 15:00:00' });
    await expect(page.locator('#event_form_days [data-events-day-date]')).toHaveCount(3);
    await expect(page.locator('#event_form_day_1_start')).toHaveValue('10:00');

    await fillEventForm(page, { days: [{ date: '2026-10-26', start: '11:00:00', end: '15:00:00' }] });
    await submitEventForm(page);
    await expect(page.locator('#event_days li.event_day')).toHaveCount(3);

    const grown = await getEventDays(eventId);
    expect(grown.map((day: any) => String(day.date))).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
  });

  test('editing an event keeps its signups on the days they were for', async ({ page }) => {
    // Signups point at day rows by id. Saving used to delete every day and insert it
    // again, which gave each one a new id and left every signup pointing at nothing.
    const eventId = await createEvent({
      title: 'Edited Weekend Troop',
      status: 'live',
      coordinator: 'gec',
      start: '2026-10-23 09:00:00',
      end: '2026-10-25 17:00:00',
      days: [
        { date: '2026-10-23', start: '09:00:00', end: '17:00:00' },
        { date: '2026-10-24', start: '09:00:00', end: '17:00:00' },
        { date: '2026-10-25', start: '09:00:00', end: '17:00:00' },
      ],
    });
    const [, saturday, sunday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));
    await createRsvp(eventId, 'trooper1', { dayIds: [saturday] });
    await createRsvp(eventId, 'trooper1', { role: 'wrangler', dayIds: [sunday] });

    // Drop the Friday, which nobody holds, and move Saturday's hours. Nobody loses a day,
    // so there is nothing to warn about and it saves straight away.
    await loginAs(page, 'gec');
    await page.goto(`/manage_event.php?id=${eventId}`);
    await fillEventForm(page, {
      start: '2026-10-24 10:00:00',
      days: [{ date: '2026-10-24', start: '10:00:00', end: '15:00:00' }],
    });
    await submitEventForm(page);
    await expect(page.locator('#event_days li.event_day')).toHaveCount(2);

    const days = await getEventDays(eventId);
    expect(days.map((day: any) => Number(day.id))).toEqual([saturday, sunday]);
    expect(String(days[0].start_time)).toBe('10:00:00');
    expect(String(days[0].end_time)).toBe('15:00:00');

    expect(await getRsvpDayIds(eventId, 'trooper1')).toEqual([saturday]);
    expect(await getRsvpDayIds(eventId, 'trooper1', 'wrangler')).toEqual([sunday]);
    expect(await countPrivateMessages('trooper1', 'Event changed:%')).toBe(0);
  });

  test('removing a day members hold warns first, then cancels their signups and PMs them', async ({ page }) => {
    // Removing a day used to drop the signups' claims on it and keep the signups, so a
    // member could be left signed up for no days at all - which the event page reads as
    // every day and the attendance sheet as none.
    const eventId = await createEvent({
      title: 'Trimmed Weekend Troop',
      status: 'live',
      coordinator: 'gec',
      start: '2026-10-23 09:00:00',
      end: '2026-10-25 17:00:00',
      days: [
        { date: '2026-10-23', start: '09:00:00', end: '17:00:00' },
        { date: '2026-10-24', start: '09:00:00', end: '17:00:00' },
        { date: '2026-10-25', start: '09:00:00', end: '17:00:00' },
      ],
    });
    const [friday, saturday, sunday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));
    await createRsvp(eventId, 'trooper1', { dayIds: [saturday, sunday] });
    // Friday and Saturday: losing Friday cancels the whole signup, Saturday included.
    await createRsvp(eventId, 'trooper2', { dayIds: [friday, saturday] });
    await createRsvp(eventId, 'trooper2', { role: 'wrangler', dayIds: [sunday] });
    await createRsvp(eventId, 'wrangler', { role: 'wrangler', dayIds: [friday] });

    await loginAs(page, 'gec');
    await page.goto(`/manage_event.php?id=${eventId}`);
    await fillEventForm(page, { start: '2026-10-24 09:00:00' });
    await submitEventForm(page);

    // The form comes back with the warning, and nothing has been touched yet.
    const warning = page.locator('#event_day_change_warning');
    await expect(warning).toContainText('Fri 23 Oct 2026');
    await expect(page.locator('#event_day_change_members li')).toHaveText(['trooper2', 'wrangler']);
    expect(await getEventDays(eventId)).toHaveLength(3);
    expect(await getSignupRoles(eventId, 'trooper2')).toEqual(['trooper', 'wrangler']);

    // Saving normally again is not agreeing to it.
    await submitEventForm(page);
    await expect(page.locator('#event_day_change_warning')).toBeVisible();
    expect(await getEventDays(eventId)).toHaveLength(3);

    // Nor is pressing Enter in a field, which submits with the form's first submit button -
    // and the confirm button sits above the form's own.
    await pressEnterToSubmit(page, '#event_form_title');
    await expect(page.locator('#event_day_change_warning')).toBeVisible();
    expect(await getEventDays(eventId)).toHaveLength(3);
    expect(await getSignupRoles(eventId, 'trooper2')).toEqual(['trooper', 'wrangler']);
    expect(await countPrivateMessages('trooper2', 'Event changed:%')).toBe(0);

    await page.locator('#event_day_change_confirm').click();
    await expect(page.locator('#event_days li.event_day')).toHaveCount(2);

    expect((await getEventDays(eventId)).map((day: any) => Number(day.id))).toEqual([saturday, sunday]);
    expect(await getSignupRoles(eventId, 'trooper2')).toEqual([]);
    expect(await getSignupRoles(eventId, 'wrangler')).toEqual([]);
    expect(await getRsvpDayIds(eventId, 'trooper1')).toEqual([saturday, sunday]);

    const [pm] = await getPrivateMessages('trooper2', 'Event changed: Trimmed Weekend Troop');
    expect(pm).toBeTruthy();
    expect(Number(pm.fromid)).toBe(uid('gec'));
    expect(String(pm.message)).toContain('Fri 23 Oct 2026');
    expect(String(pm.message)).toContain('Sat 24 Oct 2026');
    expect(String(pm.message)).toMatch(/sign up again/);
    expect(await countPrivateMessages('wrangler', 'Event changed:%')).toBe(1);
    expect(await countPrivateMessages('trooper1', 'Event changed:%')).toBe(0);

    const orphans = await query(
      `SELECT rd.event_day_id
         FROM ${T('event_plugin_rsvp_days')} rd
         LEFT JOIN ${T('event_plugin_event_days')} ed ON rd.event_day_id = ed.id
        WHERE ed.id IS NULL`,
    );
    expect(orphans).toHaveLength(0);
  });

  test('moving an event by a week cancels every signup on it', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Moved Weekend Troop',
      status: 'live',
      coordinator: 'gec',
      start: '2026-10-24 09:00:00',
      end: '2026-10-25 17:00:00',
      days: [{ date: '2026-10-24' }, { date: '2026-10-25' }],
    });
    const [saturday, sunday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));
    await createRsvp(eventId, 'trooper1', { dayIds: [saturday] });
    await createRsvp(eventId, 'trooper2', { dayIds: [saturday, sunday] });

    await loginAs(page, 'gec');
    await page.goto(`/manage_event.php?id=${eventId}`);
    await fillEventForm(page, { start: '2026-10-31 09:00:00', end: '2026-11-01 17:00:00' });
    await submitEventForm(page);

    await expect(page.locator('#event_day_change_members li')).toHaveText(['trooper1', 'trooper2']);
    await expect(page.locator('#event_day_change_confirm')).toHaveText('Save and cancel 2 signups');
    await page.locator('#event_day_change_confirm').click();
    await expect(page.locator('#event_days li.event_day')).toHaveCount(2);

    expect(await countRsvps(eventId)).toBe(0);
    const [pm] = await getPrivateMessages('trooper2', 'Event changed:%');
    expect(String(pm.message)).toContain('Sat 31 Oct 2026');
    expect(await countPrivateMessages('trooper1', 'Event changed:%')).toBe(1);
  });

  // A single-day event has no day rows, so there was nothing for the day diff to find:
  // moving one used to carry every signup over to the new date without a word.
  test('moving a single-day event to another date cancels its signups and PMs them', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Moved Single Day Troop',
      status: 'live',
      coordinator: 'gec',
      start: '2026-10-24 09:00:00',
      end: '2026-10-24 17:00:00',
    });
    await createRsvp(eventId, 'trooper1');
    await createRsvp(eventId, 'wrangler', { role: 'wrangler' });

    await loginAs(page, 'gec');
    await page.goto(`/manage_event.php?id=${eventId}`);

    // New hours on the same day are not a move, and ask nothing.
    await fillEventForm(page, { start: '2026-10-24 10:00:00', end: '2026-10-24 16:00:00' });
    await submitEventForm(page);
    await expect(page.locator('#event_day_change_confirm')).toHaveCount(0);
    await expect.poll(async () => String((await getEvent(eventId)).start_date)).toContain('10:00:00');
    expect(await countRsvps(eventId)).toBe(2);

    await page.goto(`/manage_event.php?id=${eventId}`);
    await fillEventForm(page, { start: '2026-10-31 10:00:00', end: '2026-10-31 16:00:00' });
    await submitEventForm(page);

    await expect(page.locator('#event_day_change_warning')).toContainText('Sat 24 Oct 2026 (10:00 - 16:00)');
    await expect(page.locator('#event_day_change_members li')).toHaveText(['trooper1', 'wrangler']);
    await expect(page.locator('#event_day_change_confirm')).toHaveText('Save and cancel 2 signups');
    expect(await countRsvps(eventId)).toBe(2);

    await page.locator('#event_day_change_confirm').click();
    await expect.poll(async () => countRsvps(eventId)).toBe(0);
    expect(String((await getEvent(eventId)).start_date)).toContain('2026-10-31');

    const [pm] = await getPrivateMessages('trooper1', 'Event changed: Moved Single Day Troop');
    expect(String(pm.message)).toContain('Sat 24 Oct 2026');
    expect(String(pm.message)).toContain('Sat 31 Oct 2026 (10:00 - 16:00)');
    expect(String(pm.message)).toMatch(/sign up again/);
    expect(Number(pm.fromid)).toBe(uid('gec'));
    expect(await countPrivateMessages('wrangler', 'Event changed: Moved Single Day Troop')).toBe(1);

    // A signup made after the move is for the new date, and saving again leaves it be.
    await createRsvp(eventId, 'trooper2');
    await page.goto(`/manage_event.php?id=${eventId}`);
    await submitEventForm(page);
    await expect(page.locator('#event_day_change_confirm')).toHaveCount(0);
    expect(await getSignupRoles(eventId, 'trooper2')).toEqual(['trooper']);
  });

  test('the date boxes carry a calendar, and picking from it drives the day grid', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    // MyBB ships no date picker at all - the Admin CP's jQuery UI build leaves datepicker
    // out and the board loads no jQuery UI - so the plugin vendors one. If the asset stops
    // being deployed, this is what says so.
    expect(await page.evaluate(() => typeof (window as any).jQuery?.datepicker)).toBe('object');

    await page.locator('#event_form_start_date').click();
    const calendar = page.locator('#ui-datepicker-div');
    await expect(calendar).toBeVisible();

    // The picker is appended to <body>, outside .events_page_wrap, and jQuery UI puts
    // z-index: 1 on it inline. The stylesheet overrides that; a calendar behind the board's
    // header reads as a dead control, so it is worth pinning down.
    expect(await calendar.evaluate((el) => getComputedStyle(el).zIndex)).toBe('9999');

    // Its month and year dropdowns are styled as the theme's own selects, not left as the
    // browser's default control.
    expect(await calendar.locator('.ui-datepicker-month').evaluate((el) => getComputedStyle(el).appearance)).toBe('none');

    await page.keyboard.press('Escape');

    // Typed rather than fill()'d. jQuery UI follows the field through key events, so a value
    // poked straight into the DOM leaves the picker still opening on today rather than on the
    // date the box holds - and this test then clicks the wrong month. Typing is what a
    // coordinator does anyway; the rest of the suite can keep using fill(), which only has to
    // reach the server.
    await page.locator('#event_form_start_date').pressSequentially('2026-10-17');
    await page.keyboard.press('Escape');
    await page.locator('#event_form_start_date_time').fill('09:00');

    await page.locator('#event_form_end_date').pressSequentially('2026-10-18');
    await page.keyboard.press('Escape');
    await page.locator('#event_form_end_date_time').fill('17:00');

    await expect(page.locator('#event_form_days [data-events-day-date]')).toHaveCount(2);

    // Now extend the event with the calendar rather than the keyboard. jQuery's own
    // trigger('change') runs jQuery handlers only and never reaches an addEventListener
    // binding, which is how the day grid listens - so the picker dispatches a real DOM
    // event. Without that the grid silently ignores every date that was clicked.
    await page.locator('#event_form_end_date').click();
    await expect(calendar).toBeVisible();
    await calendar.locator('a.ui-state-default').filter({ hasText: /^20$/ }).first().click();

    await expect(page.locator('#event_form_end_date')).toHaveValue('2026-10-20');
    await expect(page.locator('#event_form_days [data-events-day-date]')).toHaveCount(4);
  });

  test('the day grid follows the dates, and a single-day event has none', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    // Nothing to split up yet, and nothing to split up for a one-day event either.
    const section = page.locator('#manage_event_form [data-events-day-section]').first();
    await expect(section).toBeHidden();

    await fillEventForm(page, { start: '2026-11-07 09:00:00', end: '2026-11-07 17:00:00' });
    await expect(section).toBeHidden();

    // Three calendar days, so three rows, labelled by the day they are.
    await fillEventForm(page, { end: '2026-11-09 17:00:00' });
    await expect(section).toBeVisible();
    await expect(page.locator('#event_form_days [data-events-day-date]')).toHaveCount(3);
    await expect(page.locator('#event_form_days .events_day_date').first()).toHaveText('Sat 7 Nov 2026');

    // Pulling the end date back drops the days that are no longer part of the event.
    await fillEventForm(page, { end: '2026-11-08 17:00:00' });
    await expect(page.locator('#event_form_days [data-events-day-date]')).toHaveCount(2);

    await fillEventForm(page, { title: 'Single Day Troop', status: 'live', end: '2026-11-07 17:00:00' });
    await expect(section).toBeHidden();
    await submitEventForm(page);

    const eventId = Number((await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Single Day Troop'`))[0].id);
    expect(await getEventDays(eventId)).toHaveLength(0);
  });

  test('round-trips exclusions and the WWCC requirement', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    await fillEventForm(page, {
      title: 'Restricted Troop',
      status: 'live',
      start: relativeToTestNow({ days: 21 }),
      end: relativeToTestNow({ days: 21, hours: 6 }),
      requiresWwcc: true,
      exclusions: ['excluded'],
    });
    await submitEventForm(page);
    await expect(page.locator('#event_requires_wwcc')).toBeVisible();

    const eventId = Number((await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Restricted Troop'`))[0].id);
    const exclusions = await query(
      `SELECT user_id FROM ${T('event_plugin_event_exclusions')} WHERE event_id = ?`,
      [eventId],
    );
    expect(exclusions.map((row: any) => Number(row.user_id))).toEqual([uid('excluded')]);

    // The names come back as names, not as the ids they are stored as, and as lozenges
    // over the box that still posts them as a list.
    await page.goto(`/manage_event.php?id=${eventId}`);
    await expect(tag(page, 'excluded')).toBeVisible();
    await expect(excludedValue(page)).toHaveValue('excluded');
    await expect(page.locator('#event_form_requires_wwcc')).toBeChecked();
  });

  test('excluding a member who has signed up withdraws their signup', async ({ page }) => {
    // Once excluded they cannot see the event to withdraw it, so a signup they kept would
    // sit on the attendance sheet and in the counts with nobody able to take it off.
    const eventId = await createEvent({ title: 'Signed Then Excluded Troop' });
    await createRsvp(eventId, 'excluded', { role: 'trooper' });
    await createRsvp(eventId, 'excluded', { role: 'wrangler' });
    await createRsvp(eventId, 'trooper1');

    await loginAs(page, 'gec');
    await page.goto(`/manage_event.php?id=${eventId}`);
    await fillEventForm(page, { exclusions: ['excluded'] });
    await submitEventForm(page);
    await expect(page.locator('#event_page')).toContainText('Signed Then Excluded Troop');

    expect(await getSignupRoles(eventId, 'excluded')).toEqual([]);
    expect(await getSignupRoles(eventId, 'trooper1')).toEqual(['trooper']);

    // Withdrawing is not something they are told about: the event is hidden from them.
    expect(await countPrivateMessages('excluded', '%Signed Then Excluded Troop%')).toBe(0);
  });

  test('the excluded members field is a tag input that only takes real members', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    const entry = page.locator('#event_form_exclusions');

    // Typing searches the board's members. MyBB's own search ignores anything shorter than
    // two characters, so nothing is asked for until there is something to ask.
    await entry.fill('e');
    await expect(page.locator('.events_tag_menu')).toBeHidden();

    // 'exclu' is only one member, and the list says so rather than offering the board.
    await entry.fill('exclu');
    await expect(tagOption(page, 'excluded')).toBeVisible();
    await expect(page.locator('.events_tag_option')).toHaveCount(1);

    // Typing on filters it down to somebody else; the first match is not left behind.
    await entry.fill('newb');
    await expect(tagOption(page, 'newbie')).toBeVisible();
    await expect(tagOption(page, 'excluded')).toHaveCount(0);

    // Picking one turns it into a lozenge, empties the box and closes the list - and the
    // field that posts is the comma separated list the server has always read.
    await tagOption(page, 'newbie').click();
    await expect(tag(page, 'newbie')).toBeVisible();
    await expect(entry).toHaveValue('');
    await expect(page.locator('.events_tag_menu')).toBeHidden();
    await expect(excludedValue(page)).toHaveValue('newbie');

    // A name nobody has cannot be added, by Enter or any other way, and it is refused with
    // a reason rather than by doing nothing.
    await entry.fill('nobodyatall');
    await expect(page.locator('.events_tag_note')).toContainText('No member matches');
    await entry.press('Enter');
    await expect(page.locator('[data-events-tag]')).toHaveCount(1);
    await expect(excludedValue(page)).toHaveValue('newbie');

    // Enter on a suggestion adds it, so the whole field works from the keyboard.
    await entry.fill('exclu');
    await expect(tagOption(page, 'excluded')).toBeVisible();
    await entry.press('Enter');
    await expect(excludedValue(page)).toHaveValue('newbie, excluded');

    // And each lozenge's X takes that member back off.
    await removeTag(page, 'newbie');
    await expect(excludedValue(page)).toHaveValue('excluded');

    await fillEventForm(page, {
      title: 'Tagged Troop',
      status: 'live',
      start: relativeToTestNow({ days: 25 }),
      end: relativeToTestNow({ days: 25, hours: 4 }),
    });
    await submitEventForm(page);

    const eventId = Number((await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Tagged Troop'`))[0].id);
    const rows = await query(
      `SELECT user_id FROM ${T('event_plugin_event_exclusions')} WHERE event_id = ?`,
      [eventId],
    );
    expect(rows.map((row: any) => Number(row.user_id))).toEqual([uid('excluded')]);
  });

  test('a username of digits excludes that member, not the member with that uid', async ({ page }) => {
    // The field posts usernames, so "42" is the member called 42. Read as a uid first,
    // it excluded whoever had uid 42 instead and withdrew their signup.
    const eventId = await createEvent({ title: 'Numeric Name Troop' });
    await createRsvp(eventId, 'trooper1');

    const numericName = String(uid('trooper1'));
    await execute(`UPDATE ${T('users')} SET username = ? WHERE uid = ?`, [numericName, uid('newbie')]);
    try {
      await loginAs(page, 'gec');
      await page.goto(`/manage_event.php?id=${eventId}`);
      await page.locator('input[name="exclusions"]').evaluate((input: HTMLInputElement, name: string) => {
        input.value = name;
      }, numericName);
      await submitEventForm(page);
      await expect(page.locator('#event_page')).toContainText('Numeric Name Troop');

      const rows = await query(
        `SELECT user_id FROM ${T('event_plugin_event_exclusions')} WHERE event_id = ?`,
        [eventId],
      );
      expect(rows.map((row: any) => Number(row.user_id))).toEqual([uid('newbie')]);
      expect(await getSignupRoles(eventId, 'trooper1')).toEqual(['trooper']);
    } finally {
      await execute(`UPDATE ${T('users')} SET username = 'newbie' WHERE uid = ?`, [uid('newbie')]);
    }
  });

  test('refuses an excluded member who is nobody, with the field turned off', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    // The tag field cannot offer a member who does not exist, so this is the form posted
    // without its script - the state the server has to check for itself, since a field is
    // not a rule. Before, the name was simply dropped and the event saved without it.
    await fillEventForm(page, {
      title: 'Ghost Exclusion Troop',
      status: 'live',
      start: relativeToTestNow({ days: 26 }),
      end: relativeToTestNow({ days: 26, hours: 4 }),
    });
    await page.locator('input[name="exclusions"]').evaluate((input: HTMLInputElement) => {
      input.value = 'nobodyatall';
    });
    await submitEventForm(page);

    await expect(page.locator('#manage_event_errors')).toContainText("There is no member named 'nobodyatall'");
    expect(await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Ghost Exclusion Troop'`)).toHaveLength(0);
  });

  test('an error quoting what was posted is escaped once, not twice', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    await fillEventForm(page, {
      title: 'Escaped Error Troop',
      status: 'live',
      start: relativeToTestNow({ days: 26 }),
      end: relativeToTestNow({ days: 26, hours: 4 }),
    });
    await page.locator('input[name="exclusions"]').evaluate((input: HTMLInputElement) => {
      input.value = 'Tom & <b>Jerry</b>';
    });
    await submitEventForm(page);

    // The validator used to escape the name and the error box escaped it again, so the
    // ampersand read as "&amp;". The markup has to stay text all the same.
    const errors = page.locator('#manage_event_errors');
    await expect(errors).toContainText("There is no member named 'Tom & <b>Jerry</b>'.");
    await expect(errors.locator('b')).toHaveCount(0);
  });

  test('rejects an end date before the start date and keeps what was typed', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    await fillEventForm(page, {
      title: 'Backwards Troop',
      status: 'live',
      region: 'Hunter',
      start: '2026-10-20 09:00:00',
      end: '2026-10-19 17:00:00',
    });
    await submitEventForm(page);

    await expect(page.locator('#manage_event_errors')).toContainText('The end must be later than the start.');

    // A failed submit re-renders from what was posted, so nothing has to be retyped.
    await expect(page.locator('#event_form_title')).toHaveValue('Backwards Troop');
    await expect(page.locator('#event_form_region')).toHaveValue('Hunter');
    await expect(page.locator('#event_form_status')).toHaveValue('live');

    expect(await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Backwards Troop'`)).toHaveLength(0);
  });

  test('rejects an end that is the same moment as the start', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    await fillEventForm(page, {
      title: 'Instant Troop',
      status: 'live',
      region: 'Hunter',
      start: '2026-10-20 09:00:00',
      end: '2026-10-20 09:00:00',
    });
    await submitEventForm(page);

    await expect(page.locator('#manage_event_errors')).toContainText('The end must be later than the start.');
    expect(await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Instant Troop'`)).toHaveLength(0);
  });

  test('rejects a signup cutoff later than the end of the event', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    // A cutoff past the end used to be saved as-is, and the event page then read it as
    // signups still being open after the event was over.
    await fillEventForm(page, {
      title: 'Late Cutoff Troop',
      status: 'live',
      region: 'Hunter',
      start: '2026-10-20 09:00:00',
      end: '2026-10-20 17:00:00',
      cutoff: '2026-10-20 17:01:00',
    });
    await submitEventForm(page);

    await expect(page.locator('#manage_event_errors')).toContainText(
      'The signup cutoff cannot be later than the end of the event.',
    );
    expect(await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Late Cutoff Troop'`)).toHaveLength(0);

    // Exactly at the end is fine: it closes signups when they would have closed anyway.
    await fillEventForm(page, { cutoff: '2026-10-20 17:00:00' });
    await submitEventForm(page);

    await expect
      .poll(async () => (await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Late Cutoff Troop'`)).length)
      .toBe(1);
  });

  test('the start and end dates need their times', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    // The browser asks for it first.
    await expect(page.locator('#event_form_start_date_time')).toHaveAttribute('required', 'required');
    await expect(page.locator('#event_form_end_date_time')).toHaveAttribute('required', 'required');
    await expect(page.locator('#event_form_signup_cutoff_time')).not.toHaveAttribute('required');

    // And the server refuses them when the browser is bypassed. Left blank a time used to
    // be read as midnight, which put the end of a one-day event at the very start of its
    // day - locked for signups, "Needs Troop Report" and reminded before anybody arrived.
    await page
      .locator('#manage_event_form')
      .evaluate((form: HTMLFormElement) => {
        form.noValidate = true;
      });
    await fillEventForm(page, {
      title: 'Timeless Troop',
      status: 'live',
      region: 'Hunter',
      start: '2026-10-20',
      end: '2026-10-20',
    });
    await submitEventForm(page);

    await expect(page.locator('#manage_event_errors')).toContainText('A start date needs a time as well as a date.');
    await expect(page.locator('#manage_event_errors')).toContainText('An end date needs a time as well as a date.');

    // The re-rendered form keeps the times blank rather than filling in a midnight nobody
    // typed, which the next submit would otherwise carry straight past this check.
    await expect(page.locator('#event_form_end_date')).toHaveValue('2026-10-20');
    await expect(page.locator('#event_form_end_date_time')).toHaveValue('');
    await expect(page.locator('#event_form_start_date_time')).toHaveValue('');

    expect(await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Timeless Troop'`)).toHaveLength(0);
  });

  test('the calendar stays shut when the browser reports an empty date', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    // Only the title, so the browser stops the submit on the start date and focuses it to
    // say so. The picker opens on focus, and that one focus used to drop the calendar on
    // top of the message - which then covered the rest of the dates as well.
    await page.locator('#event_form_title').fill('Unfinished Troop');
    await page.locator('#manage_event_submit').click();

    await expect(page.locator('#ui-datepicker-div')).toBeHidden();
    const message = await page
      .locator('#event_form_start_date')
      .evaluate((input: HTMLInputElement) => input.validationMessage);
    expect(message).not.toBe('');

    // Nothing was posted, so the form is still the one that was being filled in, and the
    // calendar still opens when it is asked to.
    await expect(page.locator('#event_form_title')).toHaveValue('Unfinished Troop');
    await page.locator('#event_form_start_date').click();
    await expect(page.locator('#ui-datepicker-div')).toBeVisible();
  });

  test('names every missing field when the form is posted past the browser', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    // The required attributes are the browser's check, not the plugin's, and a forged or
    // scripted post arrives without having passed it. Turning them off is how the
    // server's own messages - the ones a member sees after any other failed submit - can
    // be read at all.
    await page
      .locator('#manage_event_form')
      .evaluate((form: HTMLFormElement) => {
        form.noValidate = true;
      });
    await submitEventForm(page);

    const errors = page.locator('#manage_event_errors');
    await expect(errors).toContainText('A title is required.');
    await expect(errors).toContainText('A start date is required.');
    await expect(errors).toContainText('An end date is required.');
  });

  test('refuses a title too long to be a post or PM subject', async ({ page }) => {
    // MyBB caps subjects at 85 characters, and "Troop Report Needed: " is the longest
    // prefix the plugin puts on a title. A longer title saved fine and then broke the
    // reminder PM, the troop report and the announcement, each somewhere nobody looked.
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');
    await expect(page.locator('#event_form_title')).toHaveAttribute('maxlength', '64');

    // maxlength is the browser's check; a forged post skips it, so lift it and post.
    await page.locator('#event_form_title').evaluate((input: HTMLInputElement) => {
      input.removeAttribute('maxlength');
    });
    await fillEventForm(page, {
      title: 'T'.repeat(65),
      description: 'A troop with a very long name.',
      status: 'live',
      region: 'Sydney',
      start: relativeToTestNow({ days: 21 }),
      end: relativeToTestNow({ days: 21, hours: 6 }),
    });
    await submitEventForm(page);
    await expect(page.locator('#manage_event_errors')).toContainText(
      'The title is too long (64 characters at most).',
    );

    await page.locator('#event_form_title').fill('T'.repeat(64));
    await submitEventForm(page);
    await expect(page.locator('#event_page')).toContainText('T'.repeat(64));
  });

  test('reports an unparseable day time as a form error rather than a SQL error', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    await fillEventForm(page, {
      title: 'Bad Hours Troop',
      status: 'live',
      // Two days, because a single-day event has no hours boxes to get wrong.
      start: '2026-10-24 09:00:00',
      end: '2026-10-25 17:00:00',
    });

    // fill() cannot type 'half past nine' into a time input - the browser rejects it before
    // the server ever sees it. The point of this test is the server's own handling, so the
    // value goes in the way a forged or scripted post would deliver it.
    await page
      .locator('[data-events-day-date="2026-10-24"] input[type="time"]')
      .first()
      .evaluate((input: HTMLInputElement) => {
        input.type = 'text';
        input.value = 'half past nine';
      });
    await submitEventForm(page);

    await expect(page.locator('#manage_event_errors')).toContainText('is not a valid time');
    await expect(page.locator('body')).not.toContainText('MyBB SQL Error');
    expect(await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Bad Hours Troop'`)).toHaveLength(0);
  });

  test('refuses a relative expression as a day time', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    await fillEventForm(page, {
      title: 'Relative Hours Troop',
      status: 'live',
      start: '2026-10-24 09:00:00',
      end: '2026-10-25 17:00:00',
    });

    // strtotime() reads "now" and "+3 hours" as times, so they used to be saved as
    // whatever the clock said when the form was submitted.
    await page
      .locator('[data-events-day-date="2026-10-24"] input[type="time"]')
      .first()
      .evaluate((input: HTMLInputElement) => {
        input.type = 'text';
        input.value = 'now';
      });
    await submitEventForm(page);

    await expect(page.locator('#manage_event_errors')).toContainText("The start time 'now' for 2026-10-24 is not a valid time");
    expect(await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Relative Hours Troop'`)).toHaveLength(0);
  });

  test('a day that ends earlier than it starts runs overnight, and must be over before the next one begins', async ({ page }) => {
    // A day stores only its hours, so a 22:00 to 01:00 night can only be written as an
    // end earlier than the start. That used to be refused outright as a day ending
    // before it starts, which made a late troop impossible to enter.
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    await fillEventForm(page, {
      title: 'Late Nights Troop',
      status: 'live',
      start: '2026-10-24 22:00:00',
      end: '2026-10-26 01:00:00',
    });

    const times = (date: string) => page.locator(`[data-events-day-date="${date}"] input[type="time"]`);

    // Saturday night runs into Sunday, which has been left to start at midnight - the two
    // rows would claim the same hours.
    await times('2026-10-24').nth(0).fill('22:00');
    await times('2026-10-24').nth(1).fill('01:00');
    await times('2026-10-25').nth(0).fill('00:00');
    await times('2026-10-25').nth(1).fill('01:00');
    await submitEventForm(page);
    await expect(page.locator('#manage_event_errors')).toContainText(
      'The hours for 2026-10-24 run past midnight into 2026-10-25, which starts at 00:00.',
    );
    expect(await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Late Nights Troop'`)).toHaveLength(0);

    // What was typed comes back, so it can be corrected rather than retyped.
    await expect(times('2026-10-24').nth(0)).toHaveValue('22:00');
    await expect(times('2026-10-24').nth(1)).toHaveValue('01:00');

    // The same time at both ends is no length at all.
    await times('2026-10-25').nth(0).fill('01:00');
    await submitEventForm(page);
    await expect(page.locator('#manage_event_errors')).toContainText('The start and end times for 2026-10-25 are the same.');

    // Two nights out, each ending after midnight, neither running into the next.
    await times('2026-10-25').nth(0).fill('22:00');
    await submitEventForm(page);
    await expect(page.locator('#manage_event_errors')).toHaveCount(0);

    const saved = await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Late Nights Troop'`);
    expect(saved).toHaveLength(1);
    const days = await getEventDays(Number(saved[0].id));
    // Two rows, not three: the event ends at 01:00 on the 26th, which is the second night
    // finishing rather than a day of its own - a whole-day row for it would start at
    // midnight, and the second night would run into it.
    expect(days.map((day) => [day.date, day.start_time, day.end_time])).toEqual([
      ['2026-10-24', '22:00:00', '01:00:00'],
      ['2026-10-25', '22:00:00', '01:00:00'],
    ]);
  });

  test('an event that runs past midnight but is shorter than a day is one night, not two days', async ({ page }) => {
    // The day grid follows the event's dates, and a Saturday 22:00 to Sunday 01:00 troop
    // touches two of them. Counted by date it became a two-day event: a whole-day row for
    // each, signed up for separately, and the event on both days of the calendar.
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    await fillEventForm(page, {
      title: 'One Late Night Troop',
      status: 'live',
      start: '2026-10-24 22:00:00',
      end: '2026-10-25 01:00:00',
    });

    // The script draws no grid for it...
    await expect(page.locator('[data-events-day-date]')).toHaveCount(0);

    // ...but a later end time takes it past a day, and the grid appears; putting the time
    // back takes it away again. The times decide it, not only the dates.
    await fillDateTime(page, 'event_form_end_date', '2026-10-25 23:00:00');
    await expect(page.locator('[data-events-day-date]')).toHaveCount(2);
    await fillDateTime(page, 'event_form_end_date', '2026-10-25 01:00:00');
    await expect(page.locator('[data-events-day-date]')).toHaveCount(0);

    await submitEventForm(page);
    await expect(page.locator('#manage_event_errors')).toHaveCount(0);

    const saved = await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'One Late Night Troop'`);
    expect(saved).toHaveLength(1);
    const eventId = Number(saved[0].id);
    expect(await getEventDays(eventId)).toHaveLength(0);

    // The server draws the same (empty) grid when the form comes back to be edited.
    await page.goto(`/manage_event.php?id=${eventId}`);
    await expect(page.locator('[data-events-day-date]')).toHaveCount(0);

    // And the calendar puts it on the night it starts, not the morning it finishes.
    await page.goto('/events.php?view=calendar&month=2026-10');
    const entry = (date: string) => page.locator(`td[data-date="${date}"] .calendar_event[data-event-id="${eventId}"]`);
    await expect(entry('2026-10-24')).toHaveCount(1);
    await expect(entry('2026-10-25')).toHaveCount(0);
  });

  test('an apostrophe in the title and description survives the round trip', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    await fillEventForm(page, {
      title: "Sydney's Children's Hospital Troop",
      description: "It's a visit; bring the 'good' armour.",
      status: 'live',
      start: relativeToTestNow({ days: 21 }),
      end: relativeToTestNow({ days: 21, hours: 6 }),
    });
    await submitEventForm(page);

    await expect(page.locator('#event_page')).toContainText("Sydney's Children's Hospital Troop");

    const rows = await query(`SELECT * FROM ${T('event_plugin_events')} WHERE region = 'Sydney'`);
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).description).toBe("It's a visit; bring the 'good' armour.");
  });

  test('the description box is the board\'s BBCode editor', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    // A description is written in the same BBCode as a post and shown the same way, so
    // it is written in the same editor - not in a bare textarea a coordinator has to
    // know the tags for.
    await expectEditorAttached(page, 'event_form_description');
    await expect(page.locator('#field_event_form_description .sceditor-toolbar')).toBeVisible();
  });

  test('BBCode typed into the description is rendered on the event page', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    await fillEventForm(page, {
      title: 'Formatted Description Troop',
      description: '[b]Full armour[/b] and a [url=http://example.test]kit list[/url].',
      status: 'live',
      start: relativeToTestNow({ days: 21 }),
      end: relativeToTestNow({ days: 21, hours: 6 }),
    });
    await submitEventForm(page);

    const description = page.locator('#event_description');
    await expect(description.locator('.mycode_b')).toHaveText('Full armour');
    await expect(description.locator('a[href="http://example.test"]')).toHaveText('kit list');
    await expect(description).not.toContainText('[b]');

    // Stored as BBCode, not as the HTML it renders to: the source is what the editor
    // reopens with and what the announcement thread is built from.
    const rows = await query(`SELECT description FROM ${T('event_plugin_events')} WHERE title = 'Formatted Description Troop'`);
    expect((rows[0] as any).description).toBe('[b]Full armour[/b] and a [url=http://example.test]kit list[/url].');
  });

  test('HTML in the description is shown rather than rendered', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    // Coordinators are trusted with BBCode exactly as every poster is, which is a long
    // way from being trusted with raw markup.
    await fillEventForm(page, {
      title: 'Raw Markup Troop',
      description: 'Careful <script>window.pwned = 1;</script> now',
      status: 'live',
      start: relativeToTestNow({ days: 21 }),
      end: relativeToTestNow({ days: 21, hours: 6 }),
    });
    await submitEventForm(page);

    await expect(page.locator('#event_description')).toContainText('<script>window.pwned = 1;</script>');
    expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
  });

  test('Preview renders the description without saving the event', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    await fillEventForm(page, {
      title: 'Previewed Troop',
      description: '[b]Under review[/b]',
      status: 'live',
      start: relativeToTestNow({ days: 21 }),
      end: relativeToTestNow({ days: 21, hours: 6 }),
    });
    await page.locator('#manage_event_preview').click();

    // Still on the form, with the rendered description above it.
    await expect(page.locator('#manage_event_page')).toBeVisible();
    await expect(page.locator('#event_description_preview_body .mycode_b')).toHaveText('Under review');

    // Preview is not a save, and nothing it does may look like one.
    expect(await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Previewed Troop'`)).toHaveLength(0);
    await expect(page.locator('#manage_event_errors')).toHaveCount(0);

    // The form comes back as it was typed, so previewing is not a detour that costs the
    // coordinator their work.
    await expect(page.locator('#event_form_title')).toHaveValue('Previewed Troop');
    await expect(page.locator('#event_form_status')).toHaveValue('live');
    expect(await descriptionValue(page, 'event_form_description')).toBe('[b]Under review[/b]');
  });

  test('Preview says so rather than showing an empty box, and reports nothing else', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/manage_event.php');

    // Previewing before the rest of the form is filled in is the normal way round:
    // telling somebody checking their formatting that they have no start date yet is an
    // answer to a question they did not ask.
    await page.locator('#manage_event_preview').click();

    await expect(page.locator('#event_description_preview_body')).toContainText('The description is empty.');
    await expect(page.locator('#manage_event_errors')).toHaveCount(0);
  });

  test('the Create button is a real button control, not a styled link', async ({ page }) => {
    await loginAs(page, 'gec');
    await page.goto('/events.php');

    // Themes style `input.button` and `button.button`, never a bare `.button` on an
    // anchor, so the only way this takes the theme's own button look is to be one of the
    // two. It used to be checked by comparing it against the Filter button beside it;
    // the filters apply as they are changed now, so on a browser running the script
    // there is no Filter button left to compare it to.
    const create = page.locator('#events_create');
    await expect(create).toHaveJSProperty('tagName', 'INPUT');
    await expect(create).toHaveClass(/\bbutton\b/);

    // The look a theme gives its buttons, rather than a browser default: something has
    // painted it, and it is not the transparent background an unstyled control has.
    const background = await create.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(background).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('action buttons keep their label legible while hovered', async ({ page }) => {
    const eventId = await createEvent({ title: 'Hoverable Troop', coordinator: 'gec' });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}`);

    // A theme's `a:hover { color }` out-specifies a lone class, so a button that only
    // states its colour in its resting rule loses the label into its own fill on hover.
    for (const [id, expected] of [['#event_signup', 'rgb(255, 255, 255)'], ['#gec_edit', 'rgb(51, 51, 51)']] as const) {
      const button = page.locator(id);
      await button.hover();
      await expect(button).toHaveCSS('color', expected);
    }
  });

  test('the point of contact is chosen from the event\'s signups or the coordinator themselves', async ({ page }) => {
    const eventId = await createEvent({ title: 'Contact Troop', coordinator: 'gec' });
    await createRsvp(eventId, 'trooper1');
    await createRsvp(eventId, 'wrangler', { role: 'wrangler' });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}`);

    // Optional, and unset: the page says nothing about it rather than naming nobody.
    await expect(page.locator('#event_page')).toBeVisible();
    await expect(page.locator('#event_poc')).toHaveCount(0);
    await expect(page.locator('#event_meta')).not.toContainText('Point of Contact');

    await page.goto(`/manage_event.php?id=${eventId}`);

    // Both roles are on the day, so both are offered. Members who have not signed up -
    // trooper2, newbie - are not, and neither is anybody else from the coordinator groups.
    const select = page.locator('#event_form_poc_user_id');
    await expect(select.locator('option')).toHaveText(['None', 'gec', 'trooper1', 'wrangler']);
    await expect(select).toHaveValue('0');

    await select.selectOption({ label: 'trooper1' });
    await submitEventForm(page);

    await expect(page.locator('#event_poc')).toHaveText('trooper1');
    await expect(page.locator('#event_poc a')).toHaveAttribute('href', new RegExp(`uid=${uid('trooper1')}`));
    expect(Number((await getEvent(eventId)).poc_user_id)).toBe(uid('trooper1'));

    // A new event has nobody signed up yet, so there is nobody to offer but the author.
    await page.goto('/manage_event.php');
    await expect(page.locator('#event_form_poc_user_id option')).toHaveText(['None', 'gec']);
  });

  test('the point of contact stays on the list after withdrawing, and clearing it removes the row', async ({ page }) => {
    // trooper1 was named and has since withdrawn their signup. An unrelated edit is not
    // the moment to quietly unname them, so they stay selectable until somebody says so.
    const eventId = await createEvent({ title: 'Withdrawn Contact Troop', coordinator: 'gec', pointOfContact: 'trooper1' });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_poc')).toHaveText('trooper1');

    await page.goto(`/manage_event.php?id=${eventId}`);
    const select = page.locator('#event_form_poc_user_id');
    await expect(select.locator('option')).toHaveText(['None', 'gec', 'trooper1']);
    await expect(select).toHaveValue(String(uid('trooper1')));

    await select.selectOption('0');
    await submitEventForm(page);

    // The form has no #event_poc either, so wait for the event page before asserting it
    // is absent - otherwise the check passes against the page being left.
    await expect(page.locator('#event_page')).toBeVisible();
    await expect(page.locator('#event_poc')).toHaveCount(0);
    expect(Number((await getEvent(eventId)).poc_user_id)).toBe(0);
  });

  test('refuses a point of contact who has not signed up to the event', async ({ page }) => {
    const eventId = await createEvent({ title: 'Forged Contact Troop', coordinator: 'gec' });

    await loginAs(page, 'gec');
    await page.goto(`/manage_event.php?id=${eventId}`);

    // The list is the rule on screen; the server has to enforce it too, because anything
    // can be posted. Add an option for somebody who is not signed up, and pick it.
    await page.locator('#event_form_poc_user_id').evaluate((select: HTMLSelectElement, id: number) => {
      select.add(new Option('trooper2', String(id)));
    }, uid('trooper2'));
    await page.locator('#event_form_poc_user_id').selectOption(String(uid('trooper2')));
    await submitEventForm(page);

    await expect(page.locator('#manage_event_errors')).toContainText('Choose a point of contact from the list');
    // And the forged uid does not earn itself a place on the list the form comes back with.
    await expect(page.locator('#event_form_poc_user_id option')).toHaveText(['None', 'gec']);
    expect(Number((await getEvent(eventId)).poc_user_id)).toBe(0);
  });

  test('an admin can edit an event they do not coordinate', async ({ page }) => {
    const eventId = await createEvent({ title: 'Someone Elses Troop', coordinator: 'gec' });

    await loginAs(page, 'admin');
    await page.goto(`/manage_event.php?id=${eventId}`);
    await fillEventForm(page, { title: 'Reassigned Troop' });
    await submitEventForm(page);

    await expect(page.locator('#event_page')).toContainText('Reassigned Troop');
    expect((await getEvent(eventId)).title).toBe('Reassigned Troop');
  });
});

/**
 * The plugin's pages are built from MyBB's own vocabulary and inherit the theme's type,
 * which is what makes them skinnable - but a theme's h3 is a page-title-sized heading,
 * and the event card is a panel. These pin the card to one scale.
 */
test.describe('event card presentation', () => {
  test('section headings sit at the same level as the card\'s own labels', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Typography Troop',
      coordinator: 'gec',
      days: [{ date: '2026-10-24' }],
    });
    await createRsvp(eventId, 'trooper1', { costumes: [fixtures().costumeOptions[0]] });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}`);

    const typeOf = (selector: string) =>
      page.locator(selector).first().evaluate((el) => {
        const style = getComputedStyle(el);
        return `${style.fontSize} ${style.fontWeight} ${style.color}`;
      });

    // "Status:", "Region:" - the level the card already names things at.
    const label = await typeOf('#event_meta strong');

    expect(await typeOf('#event_days .events_section_heading')).toBe(label);
    expect(await typeOf('#rsvp_list .events_section_heading')).toBe(label);

    // The count stays quieter than the heading it hangs off.
    await expect(page.locator('#rsvp_list_count')).toHaveCSS('font-weight', '400');
  });
});
