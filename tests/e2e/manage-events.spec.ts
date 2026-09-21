import { Page } from '@playwright/test';
import { test, expect, expectMyBBError } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import {
  query,
  T,
  getEvent,
  getEventDays,
  uid,
  createEvent,
  createRsvp,
  fixtures,
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
    const eventId = Number(new URL(page.url()).searchParams.get('id'));
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
    await expect(page.locator('#event_status')).toHaveText('pending');

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
      await expect(options).toHaveText(['gec', 'newbie', 'trooper2']);
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
      await expect(options).toHaveText(['gec', 'trooper2']);
      await expect(page.locator('#event_form_gec_user_id')).toHaveValue(String(uid('trooper2')));

      await page.goto('/manage_event.php');
      await expect(page.locator('#event_form_gec_user_id option')).toHaveText(['gec']);
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

    await expect(page.locator('#event_status')).toHaveText('live');

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

    await expect(page.locator('#manage_event_errors')).toContainText('The end date cannot be before the start date');

    // A failed submit re-renders from what was posted, so nothing has to be retyped.
    await expect(page.locator('#event_form_title')).toHaveValue('Backwards Troop');
    await expect(page.locator('#event_form_region')).toHaveValue('Hunter');
    await expect(page.locator('#event_form_status')).toHaveValue('live');

    expect(await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Backwards Troop'`)).toHaveLength(0);
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
