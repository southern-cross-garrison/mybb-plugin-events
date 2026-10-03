/**
 * Screenshots for the members' guide (docs/src/content/docs/members/).
 *
 * Runs against the dev forum with the test suite's demo data and fixture logins, so no
 * real member's details ever appear in the public guide. Each test builds the state its
 * pictures need, the same way the e2e specs do.
 *
 *   pnpm screenshots          # every guide, from docs/
 *   pnpm screenshots members  # just this file
 */
import { test, expect } from '../../tests/helpers/fixtures';
import { loginAs } from '../../tests/helpers/auth';
import {
	createRsvp,
	fixtures,
	getEventDays,
	getUserField,
	setUserField,
} from '../../tests/helpers/db';
import { createAnnouncedEvent } from './events';
import { relativeToTestNow } from '../../tests/helpers/clock';
import { withSettings } from '../../tests/helpers/settings';
import { signUpThroughWizard } from '../../tests/helpers/rsvp';
import { choice, ring, shot } from './annotate';

const [TK, TD] = [0, 1].map((index) => fixtures().costumeOptions[index]);

/** An event that finished yesterday, ready for its troop report. */
async function finishedEvent(title: string, daysAgo = 2): Promise<number> {
	return createAnnouncedEvent({
		title,
		start: relativeToTestNow({ days: -daysAgo }),
		end: relativeToTestNow({ days: -daysAgo, hours: 6 }),
		signupCutoff: relativeToTestNow({ days: -daysAgo - 1 }),
	});
}

test.describe('members: signing up', () => {
	test('sign up to troop', async ({ page }) => {
		await createAnnouncedEvent({
			title: 'Westfield Parramatta Charity Troop',
			start: { days: 9 },
			end: { days: 9, hours: 6 },
		});
		const eventId = await createAnnouncedEvent({
			title: 'Royal North Shore Hospital Visit',
			start: { days: 12 },
			end: { days: 12, hours: 6 },
		});
		await createAnnouncedEvent({
			title: 'Star Wars Day Cinema Screening',
			start: { days: 20 },
			end: { days: 20, hours: 6 },
			eventType: 'social',
		});

		await loginAs(page, 'trooper1');

		// 1. The events list, with the event to open ringed. Matched on the row rather than the
		// link's address, which is the event's thread once it has been announced.
		await page.goto('/events.php');
		await ring(page.locator(`.event_row[data-event-id="${eventId}"] a.event_link`));
		await shot(page.locator('#events_page'), 'members/events-list');

		// 2. The event page and its Sign Up button.
		await page.goto(`/event.php?id=${eventId}`);
		await ring(page.locator('#event_signup'));
		await shot(page.locator('#event_page'), 'members/event-signup-button');

		// 3. The attendance step.
		await page.locator('#event_signup').click();
		await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'attendance');
		await ring(choice(page, 'signup_role_trooper'), page.locator('#rsvp_submit'));
		await shot(page.locator('#rsvp_page'), 'members/attendance-step');

		// 5. Costumes (trooper1's profile is complete, so there is no step 4 to picture).
		await page.locator('#rsvp_submit').click();
		await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
		const costume = page.locator(`input.costume_checkbox[value="${TK}"]`);
		await costume.check();
		await ring(page.locator(`label:has(input.costume_checkbox[value="${TK}"])`).first());
		await shot(page.locator('#rsvp_page'), 'members/costumes-step');

		// 6. Confirm.
		await page.locator('#rsvp_submit').click();
		await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
		await ring(page.locator('#rsvp_submit'));
		await shot(page.locator('#rsvp_page'), 'members/confirm-step');
	});

	test('change or withdraw a signup', async ({ page }) => {
		const eventId = await createAnnouncedEvent({
			title: 'Royal North Shore Hospital Visit',
			start: { days: 12 },
			end: { days: 12, hours: 6 },
		});

		await loginAs(page, 'trooper1');
		await signUpThroughWizard(page, eventId, { costumes: [TK] });

		await page.goto(`/event.php?id=${eventId}`);
		await ring(page.locator('#event_signup_update'));
		await shot(page.locator('#event_page'), 'members/update-signup-button');

		await page.locator('#event_signup_update').click();
		await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'attendance');
		await page.locator('#signup_role_none').check();
		await ring(choice(page, 'signup_role_none'));
		await shot(page.locator('#rsvp_page'), 'members/not-attending');
	});
});

test.describe('members: finding events', () => {
	test('list, filters, calendar and social events', async ({ page }) => {
		const signedUp = await createAnnouncedEvent({
			title: 'Royal North Shore Hospital Visit',
			start: { days: 5 },
			end: { days: 5, hours: 4 },
			address: 'Reserve Rd, St Leonards NSW',
		});
		await createAnnouncedEvent({
			title: 'Westfield Parramatta Charity Troop',
			start: { days: 9 },
			end: { days: 9, hours: 6 },
		});
		await createAnnouncedEvent({
			title: 'Newcastle Comic Con',
			region: 'Hunter',
			start: { days: 16 },
			end: { days: 17, hours: 8 },
		});
		const social = await createAnnouncedEvent({
			title: 'Garrison Christmas Dinner',
			eventType: 'social',
			start: { days: 23 },
			end: { days: 23, hours: 4 },
		});
		await createRsvp(signedUp, 'trooper1', { costumes: [TK] });
		await createRsvp(signedUp, 'trooper2', { costumes: [TD] });
		await createRsvp(signedUp, 'wrangler', { role: 'wrangler' });

		await loginAs(page, 'trooper1');
		await page.goto('/events.php?view=list');
		await shot(page.locator('#events_page'), 'members/events-list-overview');

		await ring(page.locator(`.event_row[data-event-id="${social}"] .event_pill_social`));
		await shot(page.locator('#events_page'), 'members/social-event-list');

		// On a desktop-width page the filters sit in the toolbar; the Filter button that
		// folds them away only appears on a phone.
		await ring(
			page.locator('#events_region_filter'),
			page.locator('label:has(#events_show_archived)')
		);
		await shot(page.locator('#events_page'), 'members/events-filters');

		await ring(page.locator('#events_view_calendar'));
		await shot(page.locator('#events_page'), 'members/events-calendar-button');

		await page.goto('/events.php?view=calendar');
		// The home page's hero: the whole calendar, nothing ringed.
		await shot(page.locator('#events_page'), 'members/events-calendar-overview');
		await ring(page.locator('#events_view_list'));
		// Tall enough to show it's the calendar, not just the button.
		await shot(page.locator('#events_page'), 'members/events-calendar', { minHeight: 420 });
	});

	test('who is attending', async ({ page }) => {
		const eventId = await createAnnouncedEvent({
			title: 'Royal North Shore Hospital Visit',
			start: { days: 5 },
			end: { days: 5, hours: 4 },
			maxTroopers: 2,
		});
		await createRsvp(eventId, 'trooper1', { costumes: [TK] });
		await createRsvp(eventId, 'trooper2', { costumes: [TD] });
		await createRsvp(eventId, 'wrangler', { role: 'wrangler' });
		await createRsvp(eventId, 'gec', { costumes: [TK], status: 'waitlisted' });

		await loginAs(page, 'trooper1');
		await page.goto(`/event.php?id=${eventId}`);
		await shot(page.locator('#rsvp_list'), 'members/who-is-attending');
	});
});

test.describe('members: signup details', () => {
	test('per-day choices on a multi-day event', async ({ page }) => {
		const eventId = await createAnnouncedEvent({
			title: 'Supanova Sydney',
			start: '2026-10-10 09:00:00',
			end: '2026-10-11 17:00:00',
			days: [{ date: '2026-10-10' }, { date: '2026-10-11' }],
		});
		const [, sunday] = await getEventDays(eventId);

		await loginAs(page, 'trooper1');
		await page.goto(`/rsvp.php?id=${eventId}`);
		await page.locator('#signup_per_day').check();
		await page.locator(`#day_${sunday.id}_wrangler`).check();
		await ring(page.locator('#signup_days'));
		await shot(page.locator('#rsvp_page'), 'members/attendance-per-day');
	});

	test('prerequisites step', async ({ page }) => {
		const eventId = await createAnnouncedEvent({
			title: 'Royal North Shore Hospital Visit',
			start: { days: 5 },
			end: { days: 5, hours: 4 },
		});
		const saved = {
			mobile: await getUserField('trooper1', 'mobile'),
			emergency_contact: await getUserField('trooper1', 'emergency_contact'),
		};
		await setUserField('trooper1', 'mobile', '');
		await setUserField('trooper1', 'emergency_contact', '');

		try {
			await loginAs(page, 'trooper1');
			await page.goto(`/rsvp.php?id=${eventId}`);
			await page.locator('#rsvp_submit').click();
			await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');
			await page.locator('#prereq_mobile').fill('0400 123 456');
			await shot(page.locator('#rsvp_page'), 'members/prerequisites-step');
		} finally {
			await setUserField('trooper1', 'mobile', saved.mobile);
			await setUserField('trooper1', 'emergency_contact', saved.emergency_contact);
		}
	});

	test('preapproved costume', async ({ page }) => {
		const restore = await withSettings({
			events_preapproval_enabled: '1',
			events_preapproval_post: '',
		});
		try {
			const eventId = await createAnnouncedEvent({
				title: 'Royal North Shore Hospital Visit',
				start: { days: 5 },
				end: { days: 5, hours: 4 },
			});
			await loginAs(page, 'trooper1');
			await page.goto(`/rsvp.php?id=${eventId}`);
			await page.locator('#rsvp_submit').click();
			await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
			await page.locator('#costume_preapproval_text').fill('Shoretrooper');
			await ring(page.locator('#costume_preapproval_text'));
			await shot(page.locator('#rsvp_page'), 'members/preapproval');
		} finally {
			await restore();
		}
	});
});

test.describe('members: waitlists and calendars', () => {
	test('join a waitlist', async ({ page }) => {
		const eventId = await createAnnouncedEvent({
			title: 'Royal North Shore Hospital Visit',
			start: { days: 5 },
			end: { days: 5, hours: 4 },
			maxTroopers: 1,
		});
		await createRsvp(eventId, 'trooper2', { costumes: [TD] });

		await loginAs(page, 'trooper1');
		await page.goto(`/event.php?id=${eventId}`);
		await ring(page.locator('#event_signup'));
		await shot(page.locator('#event_page'), 'members/join-waitlist-button');

		await signUpThroughWizard(page, eventId, { costumes: [TK] });
		await page.goto(`/event.php?id=${eventId}`);
		await ring(page.locator('#event_signup_waitlist_trooper'));
		await shot(page.locator('#event_page'), 'members/waitlisted-status');
	});

	test('add to calendar and subscribe', async ({ page }) => {
		const eventId = await createAnnouncedEvent({
			title: 'Royal North Shore Hospital Visit',
			start: { days: 5 },
			end: { days: 5, hours: 4 },
		});
		await createRsvp(eventId, 'trooper1', { costumes: [TK] });

		await loginAs(page, 'trooper1');
		await page.goto(`/event.php?id=${eventId}`);
		await ring(page.locator('#event_ical'));
		await shot(page.locator('#event_page'), 'members/add-to-calendar');

		await page.goto('/usercp.php?action=events_calendar');
		await ring(page.locator('#calendar_feed_create'));
		await shot(page.locator('#calendar_feed_page'), 'members/calendar-feed-create');

		await page.locator('#calendar_feed_create').click();
		await ring(page.locator('#calendar_feed_subscribe'));
		await shot(page.locator('#calendar_feed_page'), 'members/calendar-feed-subscribe');
	});
});

test.describe('members: troop reports', () => {
	test('write a troop report, then My Troops', async ({ page }) => {
		// Two earlier troops already reported, so My Troops has some history to show.
		for (const [title, daysAgo] of [
			['Westfield Parramatta Charity Troop', 30],
			['Newcastle Comic Con', 60],
		] as const) {
			const id = await finishedEvent(title, daysAgo);
			await createRsvp(id, 'trooper1', { costumes: [daysAgo === 30 ? TK : TD] });
			await loginAs(page, 'trooper1');
			await page.goto(`/troop_report.php?id=${id}`);
			await page.locator('#troop_report_submit').click();
			await page.waitForURL(/showthread\.php/);
		}

		const eventId = await finishedEvent('Royal North Shore Hospital Visit');
		await createRsvp(eventId, 'trooper1', { costumes: [TK] });
		await createRsvp(eventId, 'trooper2', { costumes: [TD] });
		await createRsvp(eventId, 'wrangler', { role: 'wrangler' });

		await loginAs(page, 'trooper1');
		await page.goto(`/event.php?id=${eventId}`);
		await ring(page.locator('#event_troop_report'));
		await shot(page.locator('#event_page'), 'members/create-troop-report-button');

		await page.locator('#event_troop_report').click();
		await ring(page.locator('#troop_report_submit'));
		// The draft is the point of this one; the ring only shows where to post it.
		await shot(page.locator('#troop_report_page'), 'members/troop-report-form', { crop: false });

		await page.goto('/usercp.php?action=events_troops');
		await shot(page.locator('#events_troops_page'), 'members/my-troops');
	});
});
