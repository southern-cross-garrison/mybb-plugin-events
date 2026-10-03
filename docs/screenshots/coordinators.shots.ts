/**
 * Screenshots for the coordinators' guide (docs/src/content/docs/coordinators/).
 *
 *   pnpm screenshots coordinators   # from docs/
 */
import { test, expect } from '../../tests/helpers/fixtures';
import { loginAs } from '../../tests/helpers/auth';
import { createRsvp, fixtures } from '../../tests/helpers/db';
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
  });
});
