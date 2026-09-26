import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, loginToAdminCp, gotoEventsAdmin, followAdminActionLink } from '../helpers/auth';
import { createEvent, query, T, uid } from '../helpers/db';
import { relativeToTestNow } from '../helpers/clock';

/**
 * Every change to an event lands in MyBB's Administrator Log, whichever form made it -
 * coordinators edit from manage_event.php without ever reaching the Admin CP, and those
 * edits are the ones an administrator most needs to be able to see.
 */

interface LogRow {
  uid: number;
  module: string;
  action: string;
  data: string[];
}

/** In action order: two entries written in the same second have nothing else to sort by. */
async function eventLog(): Promise<LogRow[]> {
  const rows = await query(`SELECT uid, module, action, data FROM ${T('adminlog')} WHERE module = 'events' ORDER BY action`);
  // MyBB's my_serialize() is PHP serialize() limited to arrays and scalars; its string
  // values are the only thing the tests read back.
  return rows.map((row: any) => ({
    uid: Number(row.uid),
    module: row.module,
    action: row.action,
    data: [...String(row.data).matchAll(/s:\d+:"(.*?)";/g)].map((match) => match[1]),
  }));
}

/** The board's administrator is created by the installer, not by the fixtures. */
async function adminUid(): Promise<number> {
  return Number((await query(`SELECT uid FROM ${T('users')} WHERE username = 'admin'`))[0].uid);
}

async function openAdminLog(page: Page) {
  await page.goto('/admin/index.php?module=tools-adminlog&filter_module=events');
}

test.describe('administrator log', () => {
  test('records an event created and edited in the Admin CP, naming what changed', async ({ page }) => {
    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=add');

    await page.locator('input[name="title"]').fill('Logged Show');
    await page.locator('select[name="status"]').selectOption('pending');
    const start = relativeToTestNow({ days: 14 }).split(' ');
    const end = relativeToTestNow({ days: 14, hours: 4 }).split(' ');
    await page.locator('input[name="start_date"]').fill(start[0]);
    await page.locator('input[name="start_date_time"]').fill(start[1].slice(0, 5));
    await page.locator('input[name="end_date"]').fill(end[0]);
    await page.locator('input[name="end_date_time"]').fill(end[1].slice(0, 5));
    await page.locator('input[type="submit"][value="Create Event"]').click();
    await expect(page.locator('#flash_message')).toContainText('Event created successfully');

    const eventId = Number((await query(`SELECT id FROM ${T('event_plugin_events')} WHERE title = 'Logged Show'`))[0].id);

    // A title carrying markup, because the log prints it inside markup of its own.
    await gotoEventsAdmin(page, `&action=edit&id=${eventId}`);
    await page.locator('input[name="title"]').fill('Tom & <b>Jerry</b> Show');
    await page.locator('input[name="address"]').fill('1 Show Road');
    await page.locator('input[type="submit"][value="Update Event"]').click();
    await expect(page.locator('#flash_message')).toContainText('Event updated successfully');

    const admin = await adminUid();
    expect(await eventLog()).toEqual([
      { uid: admin, module: 'events', action: 'add', data: [String(eventId), 'Logged Show'] },
      { uid: admin, module: 'events', action: 'edit', data: [String(eventId), 'Tom & <b>Jerry</b> Show', 'Title, Address'] },
    ]);

    await openAdminLog(page);
    const log = page.locator('#content table').first();
    await expect(log).toContainText(`Created event #${eventId} (Logged Show)`);
    await expect(log).toContainText(`Edited event #${eventId} (Tom & <b>Jerry</b> Show) - changed Title, Address`);
    await expect(log.locator('b')).toHaveCount(0);
    await expect(log.locator(`a[href="index.php?module=events&action=edit&id=${eventId}"]`).first()).toBeVisible();
  });

  test("records a coordinator's edit from the front end", async ({ page }) => {
    const eventId = await createEvent({ title: 'Coordinated Log Troop', status: 'pending', coordinator: 'gec' });

    await loginAs(page, 'gec');
    await page.goto(`/manage_event.php?id=${eventId}`);
    await page.locator('#event_form_address').fill('2 Troop Street');
    await page.locator('#manage_event_submit').click();

    // Polled rather than read once: the save redirects through MyBB's own redirect page.
    await expect.poll(async () => (await eventLog()).length).toBe(1);
    expect(await eventLog()).toEqual([
      { uid: uid('gec'), module: 'events', action: 'edit_frontend', data: [String(eventId), 'Coordinated Log Troop', 'Address'] },
    ]);

    await loginToAdminCp(page);
    await openAdminLog(page);
    await expect(page.locator('#content table').first())
      .toContainText(`Edited event #${eventId} (Coordinated Log Troop) from the front end - changed Address`);
  });

  test('records a status change and a delete from the Admin CP links', async ({ page }) => {
    const eventId = await createEvent({ title: 'Short Lived Troop', status: 'pending', coordinator: 'gec' });

    await loginToAdminCp(page);
    await followAdminActionLink(page, `action=status&id=${eventId}&status=archived`);
    await followAdminActionLink(page, `action=delete&id=${eventId}`);

    const admin = await adminUid();
    expect(await eventLog()).toEqual([
      { uid: admin, module: 'events', action: 'delete', data: [String(eventId), 'Short Lived Troop'] },
      { uid: admin, module: 'events', action: 'status', data: [String(eventId), 'Short Lived Troop', 'archived'] },
    ]);

    await openAdminLog(page);
    const log = page.locator('#content table').first();
    await expect(log).toContainText(`Set event #${eventId} (Short Lived Troop) to archived`);
    await expect(log).toContainText(`Deleted event #${eventId} (Short Lived Troop)`);
  });

  test('a forged status link is not logged', async ({ page }) => {
    const eventId = await createEvent({ title: 'Forged Link Troop', status: 'pending', coordinator: 'gec' });

    await loginToAdminCp(page);
    await followAdminActionLink(page, `action=status&id=${eventId}&status=live`, { withKey: false });

    expect(await eventLog()).toEqual([]);
  });
});
