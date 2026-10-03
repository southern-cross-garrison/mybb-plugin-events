/**
 * Screenshots for the coordinators' guide (docs/src/content/docs/coordinators/).
 *
 *   pnpm screenshots coordinators   # from docs/
 */
import { test, expect } from '../../tests/helpers/fixtures';
import { loginAs } from '../../tests/helpers/auth';
import { createRsvp, fixtures, getEventDays } from '../../tests/helpers/db';
import { relativeToTestNow } from '../../tests/helpers/clock';
import { createAnnouncedEvent } from './events';
import { ring, shot } from './annotate';

const [TK, TD] = [0, 1].map((index) => fixtures().costumeOptions[index]);

test.describe('coordinators', () => {
  test('create an event', async ({ page }) => {
    await createAnnouncedEvent({ title: 'Royal North Shore Hospital Visit', start: { days: 5 }, end: { days: 5, hours: 4 } });

    await loginAs(page, 'gec');
    await page.goto('/events.php?view=list');
    await ring(page.locator('#events_create'));
    await shot(page.locator('#events_page'), 'coordinators/create-event-button');

    await page.locator('#events_create').click();
    await page.locator('#event_form_title').fill('Supanova Sydney');
    await page.locator('#event_form_address').fill('Sydney Showground, Olympic Park NSW');
    await shot(page.locator('#manage_event_page'), 'coordinators/event-form');
  });

  test('event days, edit button, exclusions', async ({ page }) => {
    const eventId = await createAnnouncedEvent({
      title: 'Supanova Sydney',
      start: '2026-10-10 09:00:00',
      end: '2026-10-11 17:00:00',
      days: [{ date: '2026-10-10' }, { date: '2026-10-11', end: '16:00:00' }],
      excluded: ['trooper2'],
    });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}`);
    await ring(page.locator('#gec_edit'));
    await shot(page.locator('#event_page'), 'coordinators/edit-event-button');

    await page.goto(`/manage_event.php?id=${eventId}`);
    await expect(page.locator('#event_form_days')).toBeVisible();
    await ring(page.locator('#event_form_days'));
    await shot(page.locator('#manage_event_page'), 'coordinators/event-days');

    const exclusions = page.locator('#event_form_exclusions').locator('xpath=ancestor::*[contains(@class,"events_field")][1]');
    await exclusions.scrollIntoViewIfNeeded();
    await ring(exclusions);
    await shot(page.locator('#manage_event_page'), 'coordinators/excluded-members');
  });

  test('signups and the attendance sheet', async ({ page }) => {
    const eventId = await createAnnouncedEvent({ title: 'Royal North Shore Hospital Visit', start: { days: 5 }, end: { days: 5, hours: 4 }, maxTroopers: 2 });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });
    await createRsvp(eventId, 'trooper2', { costumes: [TD] });
    await createRsvp(eventId, 'wrangler', { role: 'wrangler' });
    await createRsvp(eventId, 'nowwcc', { costumes: [TK], status: 'waitlisted' });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}`);
    await page.locator('#rsvp_list .rsvp_remove[data-username="trooper2"]').click();
    await expect(page.locator('#events_remove_modal')).toBeVisible();
    await shot(page.locator('#events_remove_modal'), 'coordinators/remove-signup');
    await page.locator('#events_remove_cancel').click();

    await page.goto(`/event.php?id=${eventId}&action=attendance`);
    await shot(page.locator('.events_page_wrap'), 'coordinators/attendance-sheet');

    // As it prints: an A4-width page with print styles on, so the board's chrome is gone and
    // the printed masthead shows. A couple of people ticked off on screen first, which the
    // print keeps.
    const ticks = page.locator('input.attendee_tick');
    await ticks.nth(0).check();
    await ticks.nth(1).check();
    await page.setViewportSize({ width: 794, height: 1123 });
    await page.emulateMedia({ media: 'print' });
    await shot(page.locator('.events_page_wrap'), 'coordinators/attendance-sheet-print');
  });

  test('attendance sheet for one day', async ({ page }) => {
    const eventId = await createAnnouncedEvent({
      title: 'Supanova Sydney',
      start: '2026-10-10 09:00:00',
      end: '2026-10-11 17:00:00',
      days: [{ date: '2026-10-10' }, { date: '2026-10-11' }],
    });
    const [saturday, sunday] = await getEventDays(eventId);
    await createRsvp(eventId, 'trooper1', { costumes: [TK], dayIds: [saturday.id, sunday.id] });
    await createRsvp(eventId, 'trooper2', { costumes: [TD], dayIds: [saturday.id] });
    await createRsvp(eventId, 'nowwcc', { costumes: [TK], dayIds: [sunday.id] });
    await createRsvp(eventId, 'wrangler', { role: 'wrangler', dayIds: [sunday.id] });

    await loginAs(page, 'gec');
    await page.goto(`/event.php?id=${eventId}&action=attendance`);
    await page.locator('#attendance_filter_day').selectOption(String(sunday.id));
    await ring(page.locator('#attendance_filter_day'), page.locator('#attendance_day_form input[type="submit"]'));
    await shot(page.locator('.events_page_wrap'), 'coordinators/attendance-day-filter');

    await page.locator('#attendance_day_form input[type="submit"]').click();
    await expect(page.locator('#attendance_day')).toBeVisible();
    await shot(page.locator('.events_page_wrap'), 'coordinators/attendance-one-day');
  });

  test('coordinator dropdown and contact columns', async ({ page }) => {
    const eventId = await createAnnouncedEvent({ title: 'Royal North Shore Hospital Visit', start: { days: 5 }, end: { days: 5, hours: 4 } });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });
    await createRsvp(eventId, 'trooper2', { costumes: [TD] });

    await loginAs(page, 'gec');
    await page.goto(`/manage_event.php?id=${eventId}`);
    await ring(page.locator('#event_form_gec_user_id'));
    await shot(page.locator('#manage_event_page'), 'coordinators/coordinator-dropdown');

    // Where members' contact details appear: the Mobile and Emergency Contact columns.
    await page.goto(`/event.php?id=${eventId}&action=attendance`);
    await ring(page.locator('th.attendee_mobile'), page.locator('th.attendee_emergency'));
    await shot(page.locator('.events_page_wrap'), 'coordinators/attendance-contact-columns', { minWidth: 900 });
  });

  test('announcement thread', async ({ page }) => {
    const eventId = await createAnnouncedEvent({
      title: 'Royal North Shore Hospital Visit',
      start: { days: 5 },
      end: { days: 5, hours: 4 },
      address: 'Reserve Rd, St Leonards NSW',
    });
    await createAnnouncedEvent({ title: 'Westfield Parramatta Charity Troop', start: { days: 9 }, end: { days: 9, hours: 6 } });

    await loginAs(page, 'trooper1');
    await page.goto(`/forumdisplay.php?fid=${fixtures().forums.events}`);
    await ring(page.getByRole('link', { name: 'Royal North Shore Hospital Visit' }).first());
    await shot(page.locator('body'), 'coordinators/announcement-forum', { minWidth: 900 });

    // The thread itself: its title and buttons, with the event where the first post would be.
    await page.goto(`/event.php?id=${eventId}`);
    await ring(page.locator('#event_page'));
    await shot(page.locator('body'), 'coordinators/announcement-thread', { crop: false });
  });

  test('after the event', async ({ page }) => {
    const finished = await createAnnouncedEvent({
      title: 'Westfield Parramatta Charity Troop',
      start: relativeToTestNow({ days: -2 }),
      end: relativeToTestNow({ days: -2, hours: 6 }),
      signupCutoff: relativeToTestNow({ days: -3 }),
    });
    await createAnnouncedEvent({ title: 'Royal North Shore Hospital Visit', start: { days: 5 }, end: { days: 5, hours: 4 } });
    await createRsvp(finished, 'trooper1', { costumes: [TK] });
    await createRsvp(finished, 'trooper2', { costumes: [TD] });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php?view=list');
    await ring(page.locator(`.event_row[data-event-id="${finished}"] .event_status`));
    await shot(page.locator('#events_page'), 'coordinators/needs-troop-report');

    // The posted report, as it reads in the troop reports forum.
    await page.goto(`/troop_report.php?id=${finished}`);
    await page.locator('#troop_report_submit').click();
    await page.waitForURL(/showthread\.php/);
    await shot(page.locator('[id^="post_"]').first(), 'coordinators/troop-report-posted');
  });
});
