import { test, expect } from '../helpers/fixtures';
import { loginToAdminCp, gotoEventsAdmin, loginAs } from '../helpers/auth';
import { query, T, getEvent, getEventDays, uid, createEvent, createRsvp } from '../helpers/db';
import { relativeToTestNow } from '../helpers/clock';

async function fillEventForm(
  page: any,
  values: {
    title: string;
    description?: string;
    status?: string;
    region?: string;
    start: string;
    end: string;
    cutoff?: string;
    requiresWwcc?: boolean;
    exclusions?: string;
    days?: Array<{ date: string; start?: string; end?: string }>;
  },
) {
  await page.locator('input[name="title"]').fill(values.title);
  await page.locator('textarea[name="description"]').fill(values.description ?? `${values.title} details`);
  await page.locator('select[name="status"]').selectOption(values.status ?? 'live');
  await page.locator('select[name="region"]').selectOption(values.region ?? 'Sydney');
  await page.locator('input[name="start_date"]').fill(values.start);
  await page.locator('input[name="end_date"]').fill(values.end);
  await page.locator('input[name="signup_cutoff"]').fill(values.cutoff ?? '');

  if (values.requiresWwcc) {
    await page.locator('input[name="requires_wwcc"]').check();
  }

  if (values.exclusions !== undefined) {
    await page.locator('input[name="exclusions"]').fill(values.exclusions);
  }

  (values.days ?? []).forEach(() => {});
  for (const [index, day] of (values.days ?? []).entries()) {
    await page.locator(`input[name="event_days[${index}][date]"]`).fill(day.date);
    await page.locator(`input[name="event_days[${index}][start_time]"]`).fill(day.start ?? '09:00:00');
    await page.locator(`input[name="event_days[${index}][end_time]"]`).fill(day.end ?? '17:00:00');
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
    });

    await page.locator('input[type="submit"][value="Create Event"]').click();
    await expect(page.locator('#flash_message')).toContainText('Event created successfully');
    await expect(page.locator('#content')).toContainText('Dandenong Show');

    const rows = await query(`SELECT * FROM ${T('event_plugin_events')} WHERE title = 'Dandenong Show'`);
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).region).toBe('Hunter');
    expect((rows[0] as any).status).toBe('live');
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
    await expect(page.locator('#content')).toContainText('The end date cannot be before the start date');

    const rows = await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Backwards Event'`);
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

    await gotoEventsAdmin(page, `&action=edit&id=${event.id}`);
    await expect(page.locator('input[name="event_days[0][date]"]')).toHaveValue('2026-10-17');
    await expect(page.locator('input[name="event_days[1][date]"]')).toHaveValue('2026-10-18');
  });

  test('saves excluded members by username', async ({ page }) => {
    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=add');

    await fillEventForm(page, {
      title: 'Restricted Troop',
      start: relativeToTestNow({ days: 10 }),
      end: relativeToTestNow({ days: 10, hours: 4 }),
      exclusions: 'excluded, newbie',
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
    await gotoEventsAdmin(page, `&action=edit&id=${event.id}`);
    await expect(page.locator('input[name="exclusions"]')).toHaveValue(/excluded/);
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
