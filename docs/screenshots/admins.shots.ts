/**
 * Screenshots for the administrators' guide (docs/src/content/docs/admins/).
 *
 *   pnpm screenshots admins   # from docs/
 */
import { test, expect } from '../../tests/helpers/fixtures';
import { followAdminActionLink, gotoEventsAdmin, loginAs, loginToAdminCp } from '../../tests/helpers/auth';
import { createEvent, createRsvp, createThreadWithPost, fixtures, getEventDays } from '../../tests/helpers/db';
import { withSettings } from '../../tests/helpers/settings';
import { relativeToTestNow } from '../../tests/helpers/clock';
import { ring, shot } from './annotate';
import { createAnnouncedEvent } from './events';

const [TK, TD] = [0, 1].map((index) => fixtures().costumeOptions[index]);

test.describe('admins', () => {
  test('events list', async ({ page }) => {
    await createEvent({ title: 'Royal North Shore Hospital Visit', start: { days: 5 }, end: { days: 5, hours: 4 } });
    await createEvent({ title: 'Newcastle Comic Con', region: 'Hunter', start: { days: 16 }, end: { days: 17, hours: 8 } });
    await createEvent({ title: 'Garrison Christmas Dinner', eventType: 'social', status: 'pending', start: { days: 23 }, end: { days: 23, hours: 4 } });

    await loginToAdminCp(page);
    await gotoEventsAdmin(page);
    await shot(page.locator('#content'), 'admins/events-list');

    // Where Event Management is: its item in the Admin CP's top menu, and the tabs it opens.
    await ring(page.locator('#menu a[href="index.php?module=events"]'), page.locator('.nav_tabs'));
    await shot(page.locator('body'), 'admins/event-management', { minWidth: 900 });
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

  test('RSVPs', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Supanova Sydney',
      start: '2026-10-10 09:00:00',
      end: '2026-10-11 17:00:00',
      days: [{ date: '2026-10-10' }, { date: '2026-10-11' }],
      maxTroopers: 2,
    });
    const [saturday, sunday] = await getEventDays(eventId);
    await createRsvp(eventId, 'trooper1', { costumes: [TK], dayIds: [saturday.id, sunday.id] });
    await createRsvp(eventId, 'trooper2', { costumes: [TD], dayIds: [saturday.id, sunday.id] });
    await createRsvp(eventId, 'wrangler', { role: 'wrangler', dayIds: [sunday.id] });
    await createRsvp(eventId, 'nowwcc', { costumes: [TK], dayIds: [saturday.id], status: 'waitlisted' });

    await loginToAdminCp(page);

    // Actions > View RSVPs on the events list.
    await gotoEventsAdmin(page);
    await page.locator(`#event_${eventId}`).click();
    const popup = page.locator(`#event_${eventId}_popup`);
    await expect(popup).toBeVisible();
    await ring(popup.getByRole('link', { name: 'View RSVPs' }));
    await shot(page.locator('#content'), 'admins/rsvps-action', { include: [page.locator(`#event_${eventId}`)] });

    // The filters, with the event chosen.
    await gotoEventsAdmin(page, `&action=rsvps&event_id=${eventId}`);
    const filters = page.locator('#event_id').locator('xpath=ancestor::table[1]');
    await ring(filters);
    await shot(page.locator('#content'), 'admins/rsvps-filters', { minHeight: 320 });

    // The lists themselves: signups, then the waitlist.
    await shot(page.locator('#content'), 'admins/rsvps-list');
  });

  test('settings: coordinators, costumes, checks and regions', async ({ page }) => {
    // An event filed under Canberra, so deleting that region asks where its events go.
    await createEvent({ title: 'Canberra Hospital Visit', region: 'Canberra', start: { days: 5 }, end: { days: 5, hours: 4 } });

    await loginToAdminCp(page);
    await gotoEventsAdmin(page, '&action=settings');
    const content = page.locator('#content');
    const row = (control: string) => page.locator(control).locator('xpath=ancestor::tr[1]');

    await ring(row('#event_coordinator_groups'));
    await shot(content, 'admins/settings-coordinator-groups');

    await ring(row('#legion_api_url'));
    await shot(content, 'admins/settings-legion-api');

    // Preapproval Requirements only shows once Preapproved Costumes is on. Ticked here for
    // the picture; nothing is saved.
    await page.locator('#preapproval_enabled_yes').check();
    await ring(page.locator('#row_preapproval_enabled'), page.locator('#row_preapproval_post'));
    await shot(content, 'admins/settings-preapproval');

    await ring(page.locator('#row_wwcc_enabled'), page.locator('#row_wwcc_name'));
    await shot(content, 'admins/settings-wwcc');

    // Regions: the rows with their forums, and Add Region.
    await ring(page.locator('#region_name_0').locator('xpath=ancestor::tr[1]'), page.locator('#events_region_add'));
    await shot(content, 'admins/regions');

    // Deleting a region that has events asks where they should go.
    const canberra = page.locator('.events_region_delete[aria-label="Delete Canberra"]');
    await canberra.click();
    await expect(page.locator('#events_region_modal')).toBeVisible();
    await shot(page.locator('#events_region_modal'), 'admins/regions-delete');
  });

  test('admin log', async ({ page }) => {
    const edited = await createAnnouncedEvent({ title: 'Royal North Shore Hospital Visit', start: { days: 5 }, end: { days: 5, hours: 4 } });
    const archived = await createAnnouncedEvent({ title: 'Westfield Parramatta Charity Troop', start: { days: 9 }, end: { days: 9, hours: 6 } });

    // A coordinator's edit from the forum, and a status change from the Admin CP.
    await loginAs(page, 'gec');
    await page.goto(`/manage_event.php?id=${edited}`);
    await page.locator('#event_form_address').fill('Reserve Rd, St Leonards NSW');
    await page.locator('#manage_event_submit').click();
    await page.waitForURL(/event\.php|showthread\.php/);

    await loginToAdminCp(page);
    await followAdminActionLink(page, `action=status&id=${archived}&status=archived`);

    await page.goto('/admin/index.php?module=tools-adminlog&filter_module=events');
    await shot(page.locator('#content'), 'admins/admin-log');
  });

  test('preapproval requirements as members see them', async ({ page }) => {
    const { pid } = await createThreadWithPost(
      'How to get a costume preapproved',
      fixtures().forums.general,
      'gec',
      'Before trooping in a costume that is not on your Legion record yet:\n[list]\n[*]Email the GML with photos of the costume.\n[*]Wait for their reply confirming it for this event.\n[/list]',
    );
    const restore = await withSettings({ events_preapproval_enabled: '1', events_preapproval_post: String(pid) });

    try {
      const eventId = await createEvent({ title: 'Royal North Shore Hospital Visit', start: { days: 5 }, end: { days: 5, hours: 4 } });
      await loginAs(page, 'trooper1');
      await page.goto(`/rsvp.php?id=${eventId}`);
      await page.locator('#rsvp_submit').click();
      await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
      await page.locator('#costume_preapproval_text').fill('Shoretrooper');
      await expect(page.locator('#costume_preapproval_requirements')).toBeVisible();
      await ring(page.locator('#costume_preapproval_requirements'));
      await shot(page.locator('#rsvp_page'), 'admins/preapproval-requirements', { minHeight: 360 });
    } finally {
      await restore();
    }
  });
});
