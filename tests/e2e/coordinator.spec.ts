import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, loginToAdminCp, gotoEventsAdmin } from '../helpers/auth';
import { createEvent, createRsvp, getEventDays, fixtures, setUserField } from '../helpers/db';

const [TK, TD, TB] = [0, 1, 2].map((index) => fixtures().costumeOptions[index]);

test.describe('coordinator controls on the event page', () => {
  test('are hidden from ordinary members', async ({ page }) => {
    const eventId = await createEvent({ title: 'Members Troop' });

    await loginAs(page, 'trooper1');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#gec_controls')).toHaveCount(0);

    await page.goto(`/event.php?id=${eventId}&action=attendance`);
    await expect(page.locator('#attendance_sheet')).toHaveCount(0);
    await expect(page.locator('body')).toContainText(/not have permission|no permission/i);
  });

  test('the point of contact gets the attendance sheet and nothing else', async ({ page }) => {
    const eventId = await createEvent({ title: 'Contact Point Troop', coordinator: 'gec', pointOfContact: 'trooper1' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await loginAs(page, 'trooper1');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#gec_edit')).toHaveCount(0);
    await page.locator('#gec_attendance').click();
    await expect(page.locator('#attendance_sheet')).toBeVisible();

    await page.goto(`/manage_event.php?id=${eventId}`);
    await expect(page.locator('body')).toContainText(/not have permission|no permission/i);
  });

  test('the signup list is open to everyone who can see the event, with no click', async ({ page }) => {
    const eventId = await createEvent({ title: 'Open List Troop', coordinator: 'gec' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });
    await createRsvp(eventId, 'trooper2', { costumes: [TD] });

    // trooper2 is neither the coordinator nor an admin - just somebody who can see it.
    await loginAs(page, 'trooper2');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#gec_controls')).toHaveCount(0);

    // Who is going is part of the event, not somewhere else to go and look.
    await expect(page.locator('#rsvp_list')).toBeVisible();
    await expect(page.locator('li.rsvp_row')).toHaveCount(2);
    await expect(page.locator('li.rsvp_row')).toContainText(['trooper1', 'trooper2']);
  });

  test('the signup list carries no contact details, which stay on the attendance sheet', async ({ page }) => {
    const eventId = await createEvent({ title: 'Contact Details Troop' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await loginAs(page, 'trooper2');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#rsvp_list')).toBeVisible();

    // Opening the list up to the board is only safe while it stays the roster it looks
    // like. Mobile and emergency contact belong to the coordinator's attendance sheet.
    await expect(page.locator('#rsvp_list')).not.toContainText(/mobile|emergency/i);
    await expect(page.locator('#rsvp_list .attendee_mobile, #rsvp_list .attendee_emergency')).toHaveCount(0);
  });

  test('a pending event is not listed to somebody who cannot see the event', async ({ page }) => {
    const eventId = await createEvent({ title: 'Pending Troop', status: 'pending' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await loginAs(page, 'trooper2');
    await page.goto(`/event.php?id=${eventId}`);

    await expect(page.locator('#rsvp_list')).toHaveCount(0);
    await expect(page.locator('body')).toContainText(/not have permission|no permission/i);
  });

  test('let the assigned coordinator review RSVPs without Admin CP access', async ({ page }) => {
    const eventId = await createEvent({ title: 'Coordinated Troop', coordinator: 'gec' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK, TB] });
    await createRsvp(eventId, 'trooper2', { costumes: [TD] });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#gec_controls')).toBeVisible();
    // On the card's own action bar, not a block of their own under it.
    await expect(page.locator('#event_actions #gec_controls')).toBeVisible();

    await expect(page.locator('li.rsvp_row')).toHaveCount(2);
    const trooper1Row = page.locator('li.rsvp_row').filter({ hasText: 'trooper1' });
    await expect(trooper1Row.locator('.rsvp_tkid')).toHaveText('TK-20001');
    await expect(trooper1Row.locator('.rsvp_costumes')).toContainText(TK);
    await expect(trooper1Row.locator('.rsvp_costumes')).toContainText(TB);
  });

  test('filter the RSVP list by costume', async ({ page }) => {
    const eventId = await createEvent({ title: 'Filtered Troop' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });
    await createRsvp(eventId, 'trooper2', { costumes: [TD] });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('li.rsvp_row')).toHaveCount(2);

    // The filters live behind the funnel beside the heading, so an unfiltered list is
    // just a list.
    await expect(page.locator('#rsvp_filter_form')).not.toBeVisible();
    await page.locator('#rsvp_filter_toggle').click();

    await page.locator('#filter_costume').fill('Sandtrooper');
    await page.locator('#rsvp_filter_form input[value="Filter"]').click();

    await expect(page.locator('li.rsvp_row')).toHaveCount(1);
    await expect(page.locator('li.rsvp_row')).toContainText('trooper2');

    // A filter that is doing something comes back open, so the short list explains
    // itself and the way to undo it is in reach.
    await expect(page.locator('#rsvp_filter_form')).toBeVisible();

    await page.locator('#rsvp_filter_reset').click();
    await expect(page.locator('li.rsvp_row')).toHaveCount(2);
    await expect(page.locator('#rsvp_filter_form')).not.toBeVisible();
  });

  test('filter the RSVP list by day', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Two Day Troop',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const days = await getEventDays(eventId);
    const [saturday, sunday] = days.map((day: any) => Number(day.id));

    await createRsvp(eventId, 'trooper1', { costumes: [TK], dayIds: [saturday] });
    await createRsvp(eventId, 'trooper2', { costumes: [TD], dayIds: [saturday, sunday] });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('li.rsvp_row')).toHaveCount(2);

    await page.locator('#rsvp_filter_toggle').click();
    await page.locator('#filter_day').selectOption(String(sunday));
    await page.locator('#rsvp_filter_form input[value="Filter"]').click();

    await expect(page.locator('li.rsvp_row')).toHaveCount(1);
    await expect(page.locator('li.rsvp_row')).toContainText('trooper2');
  });
});

test.describe('attendance sheet days', () => {
  /** Friday, Saturday and Sunday of one event. */
  async function weekend() {
    const eventId = await createEvent({
      title: 'Weekend Attendance Troop',
      start: '2026-10-16 09:00:00',
      end: '2026-10-18 17:00:00',
      days: [{ date: '2026-10-16' }, { date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const [friday, saturday, sunday] = (await getEventDays(eventId)).map((day: any) => Number(day.id));
    return { eventId, friday, saturday, sunday };
  }

  const daysFor = (page: Page, username: string) =>
    page.locator('tr.attendee_row').filter({ hasText: username }).locator('.attendee_days');

  test('names one day, lists several, and collapses the whole event to All Days', async ({ page }) => {
    const { eventId, friday, saturday, sunday } = await weekend();
    await createRsvp(eventId, 'trooper1', { dayIds: [saturday] });
    await createRsvp(eventId, 'trooper2', { dayIds: [saturday, sunday] });
    await createRsvp(eventId, 'nowwcc', { dayIds: [friday, saturday, sunday] });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}&action=attendance`);

    await expect(daysFor(page, 'trooper1')).toHaveText('Saturday');
    // More than one answer is a bullet list.
    await expect(daysFor(page, 'trooper2').locator('li')).toHaveText(['Saturday', 'Sunday']);
    await expect(daysFor(page, 'nowwcc')).toHaveText('All Days');
  });

  test('says which hat a mixed signup is wearing on each day, on one row', async ({ page }) => {
    const { eventId, saturday, sunday } = await weekend();
    await createRsvp(eventId, 'trooper1', { dayIds: [saturday] });
    await createRsvp(eventId, 'trooper1', { role: 'wrangler', dayIds: [sunday] });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}&action=attendance`);

    // One person, one line, one box to tick - not one row per role.
    await expect(page.locator('tr.attendee_row')).toHaveCount(1);
    await expect(page.locator('tr.attendee_row .attendee_role')).toHaveText('Trooper / Wrangler');
    await expect(daysFor(page, 'trooper1').locator('li')).toHaveText([
      'Saturday (Trooping)',
      'Sunday (Wrangling)',
    ]);
  });

  test('labels the point of contact by that rather than by their signup role', async ({ page }) => {
    const eventId = await createEvent({ title: 'Contact Sheet Troop', pointOfContact: 'trooper1' });
    await createRsvp(eventId, 'trooper1');
    await createRsvp(eventId, 'trooper1', { role: 'wrangler' });
    await createRsvp(eventId, 'trooper2');

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}&action=attendance`);

    // Replaces the role outright, mixed signup or not; everybody else keeps theirs.
    const role = (username: string) =>
      page.locator(`tr.attendee_row:has(.attendee_username:text-is("${username}")) .attendee_role`);
    await expect(role('trooper1')).toHaveText('Point of Contact');
    await expect(role('trooper2')).toHaveText('Trooper');
  });

  test('lists everybody\'s WWCC on an event that requires one, and only then', async ({ page }) => {
    const required = await createEvent({ title: 'WWCC Sheet Troop', requiresWwcc: true });
    await createRsvp(required, 'trooper1');
    await createRsvp(required, 'trooper2', { role: 'wrangler' });
    const plain = await createEvent({ title: 'No WWCC Sheet Troop' });
    await createRsvp(plain, 'trooper1');

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${required}&action=attendance`);

    await expect(page.locator('.attendance_identity_head th.attendee_wwcc')).toHaveText('WWCC');
    const wwcc = (username: string) =>
      page.locator(`tr.attendee_row:has(.attendee_username:text-is("${username}")) .attendee_wwcc`);
    // Asked of a wrangler as well, so a wrangler's row carries one too.
    await expect(wwcc('trooper1')).toHaveText('WWCC-2001');
    await expect(wwcc('trooper2')).toHaveText('WWCC-2002');

    // The contact row is laid over the identity row's columns, so the extra column has to
    // be absorbed there or the two halves stop lining up.
    const grid = await page.locator('#attendance_table thead').evaluate((head) => {
      const spans = (selector: string) =>
        Array.from(head.querySelectorAll<HTMLTableCellElement>(selector)).reduce((sum, cell) => sum + cell.colSpan, 0);
      return { identity: spans('.attendance_identity_head th:not([rowspan])'), contact: spans('.attendance_contact_head th') };
    });
    expect(grid.contact).toBe(grid.identity);

    await page.goto(`/event.php?id=${plain}&action=attendance`);
    await expect(page.locator('#attendance_table .attendee_wwcc')).toHaveCount(0);
  });

  test('answers the day filter with that day, not the rest of the signup', async ({ page }) => {
    const { eventId, saturday, sunday } = await weekend();
    await createRsvp(eventId, 'trooper1', { dayIds: [saturday, sunday] });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}&action=attendance&filter_day=${sunday}`);

    await expect(daysFor(page, 'trooper1')).toHaveText('Sunday');
  });

  test('has no Days column at all on an event with no configured days', async ({ page }) => {
    const eventId = await createEvent({ title: 'Dayless Attendance Troop' });
    await createRsvp(eventId, 'trooper1', {});

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}&action=attendance`);

    await expect(page.locator('#attendance_table .attendee_days')).toHaveCount(0);
    // Six columns of identity plus the three the contact row lays over them.
    await expect(page.locator('#attendance_table thead .attendance_identity_head th')).toHaveCount(6);
    await expect(page.locator('#attendance_table thead .attendance_contact_head th')).toHaveCount(3);
    // The Legion ID column is named for the Legion, not for one costume's prefix.
    await expect(page.locator('#attendance_table thead th.attendee_tkid')).toHaveText('Legion ID');
  });
});

test.describe('attendance sheet', () => {
  test('lists attendees with the contact details a coordinator needs on the day', async ({ page }) => {
    const eventId = await createEvent({ title: 'Attendance Troop' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK, TB] });
    await createRsvp(eventId, 'trooper2', { costumes: [TD] });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}`);
    await page.locator('#gec_attendance').click();

    await expect(page.locator('#attendance_event_title')).toHaveText('Attendance Troop');
    await expect(page.locator('tr.attendee_row')).toHaveCount(2);

    // A person is two rows - who they are, then how to reach them - so the lookup is the
    // <tbody> that holds the pair, not either row on its own.
    const row = page.locator('tbody.attendee_group').filter({ hasText: 'trooper1' });
    await expect(row.locator('.attendee_preferred_name')).toHaveText('Ash');
    await expect(row.locator('.attendee_tkid')).toHaveText('TK-20001');
    await expect(row.locator('.attendee_mobile')).toHaveText('0400 000 002');
    await expect(row.locator('.attendee_emergency')).toHaveText('Kin Trooper 0400 111 002');
    await expect(row.locator('.attendee_costumes')).toContainText(TK);
  });

  test('says so when nobody has signed up', async ({ page }) => {
    const eventId = await createEvent({ title: 'Empty Troop' });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}&action=attendance`);
    await expect(page.locator('#attendance_empty')).toContainText('No attendees yet');
  });

  test('can be narrowed to a single day of a multi-day event', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Day Sheet Troop',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const days = await getEventDays(eventId);
    const [saturday, sunday] = days.map((day: any) => Number(day.id));

    await createRsvp(eventId, 'trooper1', { costumes: [TK], dayIds: [saturday] });
    await createRsvp(eventId, 'trooper2', { costumes: [TD], dayIds: [sunday] });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}&action=attendance`);
    await expect(page.locator('tr.attendee_row')).toHaveCount(2);

    await page.locator('#attendance_filter_day').selectOption(String(sunday));
    await page.locator('#attendance_day_form input[value="Show"]').click();

    await expect(page.locator('tr.attendee_row')).toHaveCount(1);
    await expect(page.locator('tr.attendee_row')).toContainText('trooper2');
    await expect(page.locator('#attendance_day')).toContainText('18 Oct 2026');
  });

  test('reflects a profile change made after the RSVP', async ({ page }) => {
    const eventId = await createEvent({ title: 'Updated Details Troop' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await setUserField('trooper1', 'mobile', '0411 111 111');

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}&action=attendance`);

    await expect(page.locator('tr.attendee_row_contact .attendee_mobile')).toHaveText('0411 111 111');
  });
});

test.describe('admin RSVP review', () => {
  test('shows the attendees for a chosen event', async ({ page }) => {
    const eventId = await createEvent({ title: 'Admin Review Troop' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await loginToAdminCp(page);
    await gotoEventsAdmin(page, `&action=rsvps&event_id=${eventId}`);

    await expect(page.locator('#content')).toContainText('Admin Review Troop');
    await expect(page.locator('#content')).toContainText('trooper1');
    await expect(page.locator('#content')).toContainText('TK-20001');
  });
});
