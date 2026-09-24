import { test, expect } from '../helpers/fixtures';
import { loginToAdminCp, gotoEventsAdmin, loginAs } from '../helpers/auth';
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
  getSignupRoles,
  countPrivateMessages,
} from '../helpers/db';
import { relativeToTestNow } from '../helpers/clock';
import { addTags, excludedValue, tag } from '../helpers/tag-field';
import { descriptionValue, expectEditorAttached, fillDescription } from '../helpers/editor';

/**
 * A date and its time are two controls now that the date box carries a calendar picker, so
 * a 'YYYY-MM-DD HH:MM:SS' fixture is split across the pair. The time input takes whole
 * minutes, which is all it shows or posts.
 */
async function fillDateTime(page: any, name: string, value: string) {
  const [date, time] = value.split(' ');
  await page.locator(`input[name="${name}"]`).fill(date ?? '');
  await page.locator(`input[name="${name}_time"]`).fill(time ? time.slice(0, 5) : '');
}

async function fillEventForm(
  page: any,
  values: {
    title: string;
    description?: string;
    status?: string;
    region?: string;
    address?: string;
    start: string;
    end: string;
    cutoff?: string;
    requiresWwcc?: boolean;
    exclusions?: string[];
    days?: Array<{ date: string; start?: string; end?: string }>;
  },
) {
  await page.locator('input[name="title"]').fill(values.title);
  await fillDescription(page, 'description', values.description ?? `${values.title} details`);
  await page.locator('select[name="status"]').selectOption(values.status ?? 'live');
  await page.locator('select[name="region"]').selectOption(values.region ?? 'Sydney');

  if (values.address !== undefined) {
    await page.locator('input[name="address"]').fill(values.address);
  }

  await fillDateTime(page, 'start_date', values.start);
  await fillDateTime(page, 'end_date', values.end);
  await fillDateTime(page, 'signup_cutoff', values.cutoff ?? '');

  if (values.requiresWwcc) {
    await page.locator('input[name="requires_wwcc"]').check();
  }

  if (values.exclusions !== undefined) {
    await addTags(page, '#exclusions', values.exclusions);
  }

  // The day rows follow the start and end dates rather than being typed, so a day is
  // addressed by its date and only its hours are filled in.
  for (const day of values.days ?? []) {
    const row = page.locator(`[data-events-day-date="${day.date}"]`);
    await row.locator('input[type="time"]').nth(0).fill((day.start ?? '09:00:00').slice(0, 5));
    await row.locator('input[type="time"]').nth(1).fill((day.end ?? '17:00:00').slice(0, 5));
  }
}

/** MyBB renders the per-row Actions column as a popup menu that has to be opened first. */
async function openRowActions(page: any, eventId: number) {
  await page.locator(`#event_${eventId}`).click();
  await expect(page.locator(`#event_${eventId}_popup`)).toBeVisible();
}

test.describe('admin event management', () => {
  test('creates an event and shows it in the list', async ({ page }) => {
    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=add');

    await fillEventForm(page, {
      title: 'Dandenong Show',
      start: relativeToTestNow({ days: 14 }),
      end: relativeToTestNow({ days: 14, hours: 6 }),
      region: 'Hunter',
      address: '12 Lonsdale St, Dandenong VIC 3175',
    });

    await page.locator('input[type="submit"][value="Create Event"]').click();
    await expect(page.locator('#flash_message')).toContainText('Event created successfully');
    await expect(page.locator('#content')).toContainText('Dandenong Show');

    const rows = await query(`SELECT * FROM ${T('event_plugin_events')} WHERE title = 'Dandenong Show'`);
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).region).toBe('Hunter');
    expect((rows[0] as any).status).toBe('live');
    // The two forms write the same row, so the Admin CP has to be posting the address
    // under the same name manage_event.php does.
    expect((rows[0] as any).address).toBe('12 Lonsdale St, Dandenong VIC 3175');
  });

  test('the coordinator dropdown is drawn from the configured groups, alphabetically', async ({ page }) => {
    // The Admin CP form and manage_event.php share events_coordinator_choices(), so the
    // list an admin picks from is the same one a coordinator gets - members of the Event
    // Coordinator User Groups, plus whoever is filling the form in. trooper1 is left out
    // of the group on purpose; admin is in no coordinator group and is only here because
    // they are the one creating the event.
    const gecGroup = fixtures().groups.gec;
    const restore = [
      await setAdditionalGroups('trooper2', [gecGroup]),
      await setAdditionalGroups('trooper1', []),
    ];

    try {
      await loginToAdminCp(page);
      await gotoEventsAdmin(page, '&action=add');

      await expect(page.locator('#gec_user_id option')).toHaveText(['admin', 'gec', 'trooper2']);
    } finally {
      for (const undo of restore) await undo();
    }
  });

  test('rejects an end date before the start date', async ({ page }) => {
    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=add');

    await fillEventForm(page, {
      title: 'Backwards Event',
      start: relativeToTestNow({ days: 14 }),
      end: relativeToTestNow({ days: 13 }),
    });

    await page.locator('input[type="submit"][value="Create Event"]').click();
    await expect(page.locator('#content')).toContainText('The end must be later than the start.');

    const rows = await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Backwards Event'`);
    expect(rows).toHaveLength(0);
  });

  test('the start and end dates need their times', async ({ page }) => {
    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=add');

    await expect(page.locator('input[name="start_date_time"]')).toHaveAttribute('required', 'required');
    await expect(page.locator('input[name="end_date_time"]')).toHaveAttribute('required', 'required');

    // Past the browser's check, the server's is the one that holds.
    await page.locator('input[name="end_date_time"]').evaluate((input: HTMLInputElement) => {
      input.form!.noValidate = true;
    });
    const day = relativeToTestNow({ days: 14 }).slice(0, 10);
    await fillEventForm(page, { title: 'Timeless Event', start: day, end: day });

    await page.locator('input[type="submit"][value="Create Event"]').click();
    await expect(page.locator('#content')).toContainText('A start date needs a time as well as a date.');
    await expect(page.locator('#content')).toContainText('An end date needs a time as well as a date.');

    const rows = await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Timeless Event'`);
    expect(rows).toHaveLength(0);
  });

  test('saves multi-day events and keeps the days on edit', async ({ page }) => {
    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=add');

    await fillEventForm(page, {
      title: 'Weekend Troop',
      start: '2026-10-17 09:00:00',
      end: '2026-10-18 17:00:00',
      days: [
        { date: '2026-10-17', start: '09:00:00', end: '17:00:00' },
        { date: '2026-10-18', start: '10:00:00', end: '16:00:00' },
      ],
    });

    await page.locator('input[type="submit"][value="Create Event"]').click();
    await expect(page.locator('#flash_message')).toContainText('Event created successfully');

    const event = (await query(`SELECT * FROM ${T('event_plugin_events')} WHERE title = 'Weekend Troop'`))[0] as any;
    const days = await getEventDays(event.id);
    expect(days.map((day: any) => String(day.date))).toEqual(['2026-10-17', '2026-10-18']);

    expect(days.map((day: any) => String(day.start_time))).toEqual(['09:00:00', '10:00:00']);

    await gotoEventsAdmin(page, `&action=edit&id=${event.id}`);
    await expect(page.locator('[data-events-day-date]')).toHaveCount(2);
    await expect(page.locator('[data-events-day-date="2026-10-17"] input[type="time"]').first()).toHaveValue('09:00');
    await expect(page.locator('[data-events-day-date="2026-10-18"] input[type="time"]').first()).toHaveValue('10:00');
  });

  test('warns before removing a day members hold, then cancels their signups and PMs them', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Admin Trimmed Troop',
      coordinator: 'gec',
      start: '2026-10-17 09:00:00',
      end: '2026-10-18 17:00:00',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const [saturday, sunday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));
    await createRsvp(eventId, 'trooper1', { dayIds: [saturday] });
    await createRsvp(eventId, 'trooper2', { dayIds: [sunday] });

    await loginToAdminCp(page);
    await gotoEventsAdmin(page, `&action=edit&id=${eventId}`);
    await fillDateTime(page, 'end_date', '2026-10-17 17:00:00');
    await page.locator('input[type="submit"][value="Update Event"]').click();

    await expect(page.locator('#event_day_change_members li')).toHaveText(['trooper2']);
    expect(await getEventDays(eventId)).toHaveLength(2);

    await page.locator('#event_day_change_confirm').click();
    await expect(page.locator('#flash_message')).toContainText('1 signup was cancelled');

    // Down to one day, which the plugin keeps as no day rows at all. Saturday is still
    // on, so trooper1 keeps their signup: with no day rows it is for the one day there is.
    expect(await getEventDays(eventId)).toHaveLength(0);
    expect(await getSignupRoles(eventId, 'trooper1')).toEqual(['trooper']);
    expect(await getSignupRoles(eventId, 'trooper2')).toEqual([]);
    expect(await countPrivateMessages('trooper2', 'Event changed: Admin Trimmed Troop')).toBe(1);
    expect(await countPrivateMessages('trooper1', 'Event changed:%')).toBe(0);
  });

  test('sets the point of contact from the event\'s signups', async ({ page }) => {
    const eventId = await createEvent({ title: 'Admin Contact Troop', coordinator: 'gec' });
    await createRsvp(eventId, 'trooper1');

    await loginToAdminCp(page);
    await gotoEventsAdmin(page, `&action=edit&id=${eventId}`);

    // The same list as the front-end form: nobody, the admin filling it in, and the
    // event's signups - not the coordinator, who is not signed up.
    const select = page.locator('select[name="poc_user_id"]');
    await expect(select.locator('option')).toHaveText(['None', 'admin', 'trooper1']);

    await select.selectOption({ label: 'trooper1' });
    await page.locator('input[type="submit"][value="Update Event"]').click();
    await expect(page.locator('#flash_message')).toContainText('Event updated successfully');

    expect(Number((await getEvent(eventId)).poc_user_id)).toBe(uid('trooper1'));
  });

  test('saves excluded members by username', async ({ page }) => {
    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=add');

    await fillEventForm(page, {
      title: 'Restricted Troop',
      start: relativeToTestNow({ days: 10 }),
      end: relativeToTestNow({ days: 10, hours: 4 }),
      exclusions: ['excluded', 'newbie'],
    });

    await page.locator('input[type="submit"][value="Create Event"]').click();
    await expect(page.locator('#flash_message')).toContainText('Event created successfully');

    const event = (await query(`SELECT * FROM ${T('event_plugin_events')} WHERE title = 'Restricted Troop'`))[0] as any;
    const rows = await query(
      `SELECT user_id FROM ${T('event_plugin_event_exclusions')} WHERE event_id = ? ORDER BY user_id`,
      [event.id],
    );

    expect(rows.map((row: any) => Number(row.user_id)).sort()).toEqual([uid('newbie'), uid('excluded')].sort());

    // And the exclusion survives a round-trip through the edit form.
    // And the exclusions come back as lozenges, over a field still posting the same list.
    await gotoEventsAdmin(page, `&action=edit&id=${event.id}`);
    await expect(tag(page, 'excluded')).toBeVisible();
    await expect(tag(page, 'newbie')).toBeVisible();
    await expect(excludedValue(page)).toHaveValue(/excluded/);
  });

  test('publishes a pending event with the Make Live action', async ({ page }) => {
    const eventId = await createEvent({ title: 'Pending Parade', status: 'pending' });

    await loginToAdminCp(page);
    await gotoEventsAdmin(page);

    await openRowActions(page, eventId);
    await page.locator(`a[href*="action=status"][href*="id=${eventId}"][href*="status=live"]`).first().click();
    await expect(page.locator('#flash_message')).toContainText('Event is now live');

    expect((await getEvent(eventId)).status).toBe('live');
  });

  test('archives a live event with the Archive action', async ({ page }) => {
    const eventId = await createEvent({ title: 'Finished Parade', status: 'live' });

    await loginToAdminCp(page);
    await gotoEventsAdmin(page);

    await openRowActions(page, eventId);
    await page.locator(`a[href*="action=status"][href*="id=${eventId}"][href*="status=archived"]`).first().click();
    await expect(page.locator('#flash_message')).toContainText('Event is now archived');

    expect((await getEvent(eventId)).status).toBe('archived');
  });

  test('deleting an event removes its RSVPs and days', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Doomed Troop',
      days: [{ date: '2026-10-08' }],
    });
    const days = await getEventDays(eventId);
    await createRsvp(eventId, 'trooper1', { dayIds: [Number(days[0].id)] });

    await loginToAdminCp(page);
    page.on('dialog', (dialog) => dialog.accept());
    await gotoEventsAdmin(page);
    await openRowActions(page, eventId);
    await page.locator(`a[href*="action=delete"][href*="id=${eventId}"]`).first().click();
    await expect(page.locator('#flash_message')).toContainText('Event deleted successfully');

    for (const table of [
      'event_plugin_events',
      'event_plugin_event_days',
      'event_plugin_rsvps',
      'event_plugin_event_exclusions',
    ]) {
      const column = table === 'event_plugin_events' ? 'id' : 'event_id';
      const rows = await query(`SELECT * FROM ${T(table)} WHERE ${column} = ?`, [eventId]);
      expect(rows, `${table} should be empty after delete`).toHaveLength(0);
    }

    const orphanCostumes = await query(`SELECT * FROM ${T('event_plugin_rsvp_costumes')}`);
    expect(orphanCostumes, 'RSVP costumes should not be orphaned').toHaveLength(0);
  });

  test('the event list breaks signups down into troopers and wranglers', async ({ page }) => {
    const eventId = await createEvent({ title: 'Admin Breakdown Troop' });
    await createRsvp(eventId, 'trooper1', {});
    await createRsvp(eventId, 'wrangler', { role: 'wrangler' });

    await loginToAdminCp(page);
    await gotoEventsAdmin(page);

    await expect(page.locator('table')).toContainText('Troopers');
    await expect(page.locator('table')).toContainText('Wranglers');

    const row = page.locator('tr', { hasText: 'Admin Breakdown Troop' }).first();
    const cells = await row.locator('td').allInnerTexts();
    // Troopers then wranglers, immediately after the start date.
    expect(cells).toContain('1');
  });

  test('the description box is the board\'s BBCode editor here too', async ({ page }) => {
    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=add');

    // The Admin CP loads no theme and none of MyBB's posting pages, so the editor's
    // stylesheet and scripts have to be put in the head by the plugin - which is easy to
    // half-do and leaves an ordinary textarea behind with no error anywhere.
    await expectEditorAttached(page, 'description');
    await expect(page.locator('.sceditor-toolbar')).toBeVisible();
  });

  test('gives the description editor the width of the form, not MyBB\'s 400px textarea', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=add');
    await expectEditorAttached(page, 'description');

    // sceditor builds the editor at whatever size the textarea it binds to has resolved
    // to, and the Admin CP's own stylesheet sets every textarea to a flat 400px. Left
    // alone that is the whole editor: at 400px the toolbar wraps onto three rows and
    // takes all but 7px of the height with it, so the box that holds the announcement
    // text is unusable rather than merely small. Asserted as a share of the form it sits
    // in rather than in pixels, because the point is that it follows the page.
    const size = await page.evaluate(() => {
      const container = document.querySelector('.sceditor-container') as HTMLElement;
      const cell = container.closest('td') as HTMLElement;
      const editing = container.querySelector('iframe, textarea:not([style*="display: none"])') as HTMLElement;
      return {
        widthShare: container.getBoundingClientRect().width / cell.getBoundingClientRect().width,
        editingHeight: editing.getBoundingClientRect().height,
      };
    });

    expect(size.widthShare).toBeGreaterThan(0.9);
    // Room to write a description in, not a sliver under a wrapped toolbar.
    expect(size.editingHeight).toBeGreaterThan(150);
  });

  test('Preview renders the description without creating the event', async ({ page }) => {
    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=add');

    await fillEventForm(page, {
      title: 'Admin Previewed Troop',
      description: '[b]Under review[/b]',
      start: relativeToTestNow({ days: 14 }),
      end: relativeToTestNow({ days: 14, hours: 6 }),
    });
    await page.locator('#events_preview_button').click();

    await expect(page.locator('#event_description_preview_body .mycode_b')).toHaveText('Under review');

    expect(await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Admin Previewed Troop'`)).toHaveLength(0);
    await expect(page.locator('.error')).toHaveCount(0);

    // Back on the form as it was typed, the same way the front-end form comes back.
    await expect(page.locator('input[name="title"]')).toHaveValue('Admin Previewed Troop');
    expect(await descriptionValue(page, 'description')).toBe('[b]Under review[/b]');
  });

  test('the list narrows to one status when asked', async ({ page }) => {
    const liveId = await createEvent({ title: 'Filtered Live Troop', status: 'live' });
    const pendingId = await createEvent({ title: 'Filtered Pending Troop', status: 'pending' });
    const archivedId = await createEvent({ title: 'Filtered Archived Troop', status: 'archived' });

    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&status=pending');

    await expect(page.locator('body')).toContainText('Filtered Pending Troop');
    await expect(page.locator('body')).not.toContainText('Filtered Live Troop');
    await expect(page.locator('body')).not.toContainText('Filtered Archived Troop');

    // A status that is not a status is ignored rather than filtering everything out.
    await gotoEventsAdmin(page, '&status=nonsense');
    for (const title of ['Filtered Live Troop', 'Filtered Pending Troop', 'Filtered Archived Troop']) {
      await expect(page.locator('body')).toContainText(title);
    }

    expect([liveId, pendingId, archivedId].every((id) => id > 0)).toBe(true);
  });

  test('the list pages rather than growing without end', async ({ page }) => {
    // Twenty to a page. Twenty-two events means the last two are on page two and nowhere
    // else - a listing that quietly stopped paging would show the first twenty forever.
    const titles: string[] = [];
    for (let i = 0; i < 22; i++) {
      // Ordered by start_date DESC, so the earliest dates land on the last page.
      titles.push(`Paged Troop ${String(i).padStart(2, '0')}`);
      await createEvent({
        title: titles[i],
        status: 'live',
        start: relativeToTestNow({ days: 40 - i }),
        end: relativeToTestNow({ days: 40 - i, hours: 4 }),
      });
    }

    await loginToAdminCp(page);
    await gotoEventsAdmin(page);

    await expect(page.locator('body')).toContainText('Paged Troop 00');
    await expect(page.locator('body')).not.toContainText('Paged Troop 21');

    await gotoEventsAdmin(page, '&page=2');
    await expect(page.locator('body')).toContainText('Paged Troop 21');
    await expect(page.locator('body')).toContainText('Paged Troop 20');
    await expect(page.locator('body')).not.toContainText('Paged Troop 00');
  });

  test('a coordinator without admin rights cannot reach the Admin CP', async ({ page }) => {
    // Coordinators are deliberately kept out of the Admin CP: they manage their events
    // from the front-end event page instead (see coordinator.spec.ts).
    await loginAs(page, 'gec');
    await page.goto('/admin/index.php');

    // The Admin CP answers with its own login form rather than the events module.
    await expect(page.locator('form input[name="username"]')).toBeVisible();
    await expect(page.locator('#events_add_button')).toHaveCount(0);
  });
});
