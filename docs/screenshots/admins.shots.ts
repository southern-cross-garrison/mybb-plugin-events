/**
 * Screenshots for the administrators' guide (docs/src/content/docs/admins/).
 *
 *   pnpm screenshots admins   # from docs/
 */
import { test } from '../../tests/helpers/fixtures';
import { gotoEventsAdmin, loginAs, loginToAdminCp } from '../../tests/helpers/auth';
import { createEvent, createRsvp, fixtures } from '../../tests/helpers/db';
import { relativeToTestNow } from '../../tests/helpers/clock';
import { shot } from './annotate';

const [TK, TD] = [0, 1].map((index) => fixtures().costumeOptions[index]);

test.describe('admins', () => {
  test('events list', async ({ page }) => {
    await createEvent({ title: 'Royal North Shore Hospital Visit', start: { days: 5 }, end: { days: 5, hours: 4 } });
    await createEvent({ title: 'Newcastle Comic Con', region: 'Hunter', start: { days: 16 }, end: { days: 17, hours: 8 } });
    await createEvent({ title: 'Garrison Christmas Dinner', eventType: 'social', status: 'pending', start: { days: 23 }, end: { days: 23, hours: 4 } });

    await loginToAdminCp(page);
    await gotoEventsAdmin(page);
    await shot(page.locator('#content'), 'admins/events-list');
  });

  test('reports', async ({ page }) => {
    // Two posted troop reports, so the People view has something to rank.
    for (const [title, daysAgo] of [['Westfield Parramatta Charity Troop', 30], ['Newcastle Comic Con', 60]] as const) {
      const id = await createEvent({
        title,
        start: relativeToTestNow({ days: -daysAgo }),
        end: relativeToTestNow({ days: -daysAgo, hours: 6 }),
      });
      await createRsvp(id, 'trooper1', { costumes: [TK] });
      await createRsvp(id, 'trooper2', { costumes: [TD] });
      await createRsvp(id, 'wrangler', { role: 'wrangler' });
      await loginAs(page, 'trooper1');
      await page.goto(`/troop_report.php?id=${id}`);
      await page.locator('#troop_report_submit').click();
      await page.waitForURL(/showthread\.php/);
    }

    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=reports&view=people');
    await shot(page.locator('#content'), 'admins/reports-people');
  });
});
