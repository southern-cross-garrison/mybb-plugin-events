import { test, expect } from '../helpers/fixtures';
import { loginAs, logout } from '../helpers/auth';
import { lockReasonOnEventPage, signUpThroughWizard } from '../helpers/rsvp';
import { setClock, relativeToTestNow, readContainerClock } from '../helpers/clock';
import { createEvent, createRsvp, countRsvps, fixtures, execute, T } from '../helpers/db';

const TK = fixtures().costumeOptions[0];

/**
 * These tests move the container's clock rather than the data, so the plugin's own
 * time comparisons are what is under test.
 */
test.describe('signup locking as the clock moves', () => {
  test('an event with a signup cutoff locks the moment the cutoff passes', async ({ page }) => {
    const cutoff = relativeToTestNow({ days: 3 });
    const eventId = await createEvent({
      title: 'Cutoff Troop',
      start: relativeToTestNow({ days: 5 }),
      end: relativeToTestNow({ days: 5, hours: 6 }),
      signupCutoff: cutoff,
    });

    await loginAs(page, 'trooper1');

    // Before the cutoff: open.
    expect(await lockReasonOnEventPage(page, eventId)).toBeNull();
    await expect(page.locator('#event_signup')).toBeVisible();

    // One minute before the cutoff: still open.
    await setClock(relativeToTestNow({ days: 3, minutes: -5 }));
    expect(await lockReasonOnEventPage(page, eventId)).toBeNull();

    // Just after the cutoff: locked.
    await setClock(relativeToTestNow({ days: 3, minutes: 5 }));
    expect(await lockReasonOnEventPage(page, eventId)).toBe('cutoff_passed');
    await expect(page.locator('#event_signup')).toHaveCount(0);

    // And the signup page itself refuses, not just the button that links to it.
    await page.goto(`/rsvp.php?id=${eventId}`);
    await expect(page.locator('body')).toContainText('Signups for this event have closed');
    expect(await countRsvps(eventId)).toBe(0);
  });

  test('an event with no cutoff stays open until it ends', async ({ page }) => {
    const eventId = await createEvent({
      title: 'No Cutoff Troop',
      start: relativeToTestNow({ days: 2 }),
      end: relativeToTestNow({ days: 2, hours: 8 }),
      signupCutoff: null,
    });

    await loginAs(page, 'trooper1');
    expect(await lockReasonOnEventPage(page, eventId)).toBeNull();

    // Once it has started but before it finishes, signups are deliberately still open so
    // somebody who turns up on the day can be recorded.
    await setClock(relativeToTestNow({ days: 2, hours: 1 }));
    expect(await lockReasonOnEventPage(page, eventId)).toBeNull();

    await setClock(relativeToTestNow({ days: 2, hours: 8, minutes: 1 }));
    expect(await lockReasonOnEventPage(page, eventId)).toBe('event_ended');

    await page.goto(`/rsvp.php?id=${eventId}`);
    await expect(page.locator('body')).toContainText('This event has finished');
  });

  test('a late signup can still be recorded while the event is running', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Late Signup Troop',
      start: relativeToTestNow({ days: 1 }),
      end: relativeToTestNow({ days: 1, hours: 8 }),
      signupCutoff: null,
    });

    // Halfway through the event.
    await setClock(relativeToTestNow({ days: 1, hours: 4 }));

    await loginAs(page, 'trooper1');
    await signUpThroughWizard(page, eventId, { costumes: [TK] });

    expect(await countRsvps(eventId)).toBe(1);
  });

  test('a cutoff closes signups before the event has even started', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Early Cutoff Troop',
      start: relativeToTestNow({ days: 10 }),
      end: relativeToTestNow({ days: 10, hours: 4 }),
      signupCutoff: relativeToTestNow({ days: 1 }),
    });

    await loginAs(page, 'trooper1');

    // Past the cutoff but well before the event starts.
    await setClock(relativeToTestNow({ days: 2 }));
    expect(await lockReasonOnEventPage(page, eventId)).toBe('cutoff_passed');
  });

  test('a signup made before the cutoff survives the cutoff passing', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Locked In Troop',
      start: relativeToTestNow({ days: 5 }),
      end: relativeToTestNow({ days: 5, hours: 6 }),
      signupCutoff: relativeToTestNow({ days: 3 }),
    });

    await loginAs(page, 'trooper1');
    await signUpThroughWizard(page, eventId, { costumes: [TK] });
    expect(await countRsvps(eventId)).toBe(1);

    await setClock(relativeToTestNow({ days: 4 }));
    await page.goto(`/event.php?id=${eventId}`);

    await expect(page.locator('#event_signup_status_trooper')).toContainText('Trooping');
    expect(await countRsvps(eventId)).toBe(1);
  });

  test('travelling the clock forward day by day flips the event from open to closed', async ({ page }) => {
    // The cutoff sits at midday so that stepping a whole day at a time never lands on
    // the boundary itself.
    const eventId = await createEvent({
      title: 'Countdown Troop',
      start: relativeToTestNow({ days: 4 }),
      end: relativeToTestNow({ days: 4, hours: 6 }),
      signupCutoff: relativeToTestNow({ days: 2, hours: 12 }),
    });

    await loginAs(page, 'trooper1');

    const observed: Array<string | null> = [];
    for (let day = 0; day < 5; day++) {
      await setClock(relativeToTestNow({ days: day }));
      observed.push(await lockReasonOnEventPage(page, eventId));
    }

    expect(observed).toEqual([null, null, null, 'cutoff_passed', 'cutoff_passed']);
  });

  test('a pending event is invisible to members and opens once it goes live', async ({ page }) => {
    const eventId = await createEvent({ title: 'Secret Troop', status: 'pending' });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php');
    await expect(page.locator(`tr.event_row[data-event-id="${eventId}"]`)).toHaveCount(0);

    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('body')).toContainText(/not have permission|no permission/i);

    // The coordinator can see it while it is pending.
    await loginAs(page, 'gec');
    await page.goto('/events.php');
    await expect(page.locator(`tr.event_row[data-event-id="${eventId}"]`)).toHaveCount(1);

    await execute(`UPDATE ${T('event_plugin_events')} SET status = 'live' WHERE id = ?`, [eventId]);

    await loginAs(page, 'trooper1');
    expect(await lockReasonOnEventPage(page, eventId)).toBeNull();
  });

  test('an archived event is visible but closed', async ({ page }) => {
    const eventId = await createEvent({
      title: 'Archived Troop',
      status: 'archived',
      start: relativeToTestNow({ days: 3 }),
      end: relativeToTestNow({ days: 3, hours: 4 }),
    });

    await loginAs(page, 'trooper1');
    expect(await lockReasonOnEventPage(page, eventId)).toBe('not_live');

    await page.goto(`/rsvp.php?id=${eventId}`);
    await expect(page.locator('body')).toContainText('This event is not open for signups');
  });

  test('an excluded member can see the event but cannot sign up', async ({ page }) => {
    const eventId = await createEvent({ title: 'Exclusive Troop', excluded: ['excluded'] });

    await loginAs(page, 'excluded');
    expect(await lockReasonOnEventPage(page, eventId)).toBe('excluded');
    await expect(page).toHaveTitle(/^Exclusive Troop - /);

    await page.goto(`/rsvp.php?id=${eventId}`);
    await expect(page.locator('body')).toContainText('You have been excluded');
    expect(await countRsvps(eventId)).toBe(0);

    // A member who is not excluded is unaffected.
    await loginAs(page, 'trooper1');
    expect(await lockReasonOnEventPage(page, eventId)).toBeNull();
  });

  test('guests are sent to log in rather than shown the signup form', async ({ page }) => {
    const eventId = await createEvent({ title: 'Guest Troop' });

    await logout(page);
    await page.goto(`/rsvp.php?id=${eventId}`);
    await expect(page.locator('body')).toContainText(/not (logged in|have permission)|Please login/i);
    expect(await countRsvps(eventId)).toBe(0);
  });

  test('the events list shows the same lock state as the event page', async ({ page }) => {
    const open = await createEvent({ title: 'Open Listing Troop', start: relativeToTestNow({ days: 6 }) });
    const closed = await createEvent({
      title: 'Closed Listing Troop',
      start: relativeToTestNow({ days: 6 }),
      signupCutoff: relativeToTestNow({ days: -1 }),
    });

    await loginAs(page, 'trooper1');
    await page.goto('/events.php');

    await expect(page.locator(`tr[data-event-id="${open}"] .event_signup_link`)).toBeVisible();
    await expect(page.locator(`tr[data-event-id="${closed}"] .event_locked`)).toHaveAttribute(
      'data-lock-reason',
      'cutoff_passed',
    );
  });

  test('the container clock is what the plugin reads, not the host clock', async () => {
    await setClock('2027-06-15 12:00:00');

    const observed = Date.parse(`${(await readContainerClock()).replace(' ', 'T')}Z`);
    const target = Date.parse('2027-06-15T12:00:00Z');
    expect(Math.abs(observed - target)).toBeLessThan(10_000);
  });
});
