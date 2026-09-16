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

    await page.goto(`/event.php?id=${eventId}&action=rsvps`);
    await expect(page.locator('#rsvp_list')).toHaveCount(0);

    await page.goto(`/event.php?id=${eventId}&action=attendance`);
    await expect(page.locator('#attendance_sheet')).toHaveCount(0);
    await expect(page.locator('body')).toContainText(/not have permission|no permission/i);
  });

  test('let the assigned coordinator review RSVPs without Admin CP access', async ({ page }) => {
    const eventId = await createEvent({ title: 'Coordinated Troop', coordinator: 'gec' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK, TB] });
    await createRsvp(eventId, 'trooper2', { costumes: [TD] });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#gec_controls')).toBeVisible();

    await page.locator('#gec_view_rsvps').click();

    await expect(page.locator('tr.rsvp_row')).toHaveCount(2);
    const trooper1Row = page.locator('tr.rsvp_row').filter({ hasText: 'trooper1' });
    await expect(trooper1Row.locator('.rsvp_tkid')).toHaveText('TK-20001');
    await expect(trooper1Row.locator('.rsvp_costumes')).toContainText(TK);
    await expect(trooper1Row.locator('.rsvp_costumes')).toContainText(TB);
  });

  test('filter the RSVP list by costume', async ({ page }) => {
    const eventId = await createEvent({ title: 'Filtered Troop' });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });
    await createRsvp(eventId, 'trooper2', { costumes: [TD] });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}&action=rsvps`);
    await expect(page.locator('tr.rsvp_row')).toHaveCount(2);

    await page.locator('#filter_costume').fill('Sandtrooper');
    await page.locator('#rsvp_filter_form input[value="Filter"]').click();

    await expect(page.locator('tr.rsvp_row')).toHaveCount(1);
    await expect(page.locator('tr.rsvp_row')).toContainText('trooper2');

    await page.locator('#rsvp_filter_reset').click();
    await expect(page.locator('tr.rsvp_row')).toHaveCount(2);
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
    await page.goto(`/event.php?id=${eventId}&action=rsvps`);
    await expect(page.locator('tr.rsvp_row')).toHaveCount(2);

    await page.locator('#filter_day').selectOption(String(sunday));
    await page.locator('#rsvp_filter_form input[value="Filter"]').click();

    await expect(page.locator('tr.rsvp_row')).toHaveCount(1);
    await expect(page.locator('tr.rsvp_row')).toContainText('trooper2');
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

    const row = page.locator('tr.attendee_row').filter({ hasText: 'trooper1' });
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

    await expect(page.locator('tr.attendee_row .attendee_mobile')).toHaveText('0411 111 111');
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
