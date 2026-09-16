import { test, expect } from '../helpers/fixtures';
import { advanceClock, relativeToTestNow, setClock } from '../helpers/clock';
import { runScheduledTask } from '../helpers/container';
import {
  createEvent,
  createRsvp,
  createThread,
  countPrivateMessages,
  getTroopReport,
  execute,
  T,
  fixtures,
} from '../helpers/db';

const TK = fixtures().costumeOptions[0];
const SUBJECT = 'Troop Report Needed:%';

/**
 * The reminder task is the plugin's only scheduled job. These tests run it through
 * MyBB's real task runner, with the clock moved to make events overdue.
 */
test.describe('troop report reminders', () => {
  test('PMs every attendee of a finished event with no troop report', async () => {
    const eventId = await createEvent({
      title: 'Overdue Troop',
      start: relativeToTestNow({ days: -3 }),
      end: relativeToTestNow({ days: -2 }),
    });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });
    await createRsvp(eventId, 'trooper2', { costumes: [TK] });

    const output = await runScheduledTask('events_reminders');

    // The task must still be enabled: MyBB disables tasks whose file is missing.
    expect(output).toContain('ENABLED:1');
    expect(output).toContain('Event reminder PMs sent for 1 event(s)');

    expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(1);
    expect(await countPrivateMessages('trooper2', SUBJECT)).toBe(1);

    const report = await getTroopReport(eventId);
    expect(report?.last_reminder_sent).toBeTruthy();
  });

  test('does not remind about events that have not finished yet', async () => {
    const eventId = await createEvent({
      title: 'Upcoming Troop',
      start: relativeToTestNow({ days: 3 }),
      end: relativeToTestNow({ days: 3, hours: 6 }),
    });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await runScheduledTask('events_reminders');

    expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(0);
  });

  test('does not remind again within a week, but does after one', async () => {
    const eventId = await createEvent({
      title: 'Repeat Troop',
      start: relativeToTestNow({ days: -3 }),
      end: relativeToTestNow({ days: -2 }),
    });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await runScheduledTask('events_reminders');
    expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(1);

    // Same day, and six days later: still just the one reminder.
    await runScheduledTask('events_reminders');
    expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(1);

    await advanceClock({ days: 6 });
    await runScheduledTask('events_reminders');
    expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(1);

    // Past the seven day mark: a second reminder goes out.
    await advanceClock({ days: 2 });
    await runScheduledTask('events_reminders');
    expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(2);
  });

  test('stops reminding once the troop report has been posted', async () => {
    const eventId = await createEvent({
      title: 'Reported Troop',
      start: relativeToTestNow({ days: -3 }),
      end: relativeToTestNow({ days: -2 }),
    });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    const threadId = await createThread('Troop Report: Reported Troop', fixtures().forums.troop_reports, 'trooper1');
    await execute(
      `INSERT INTO ${T('event_plugin_troop_reports')} (event_id, thread_id, created_by, created_at, posted_at)
       VALUES (?, ?, ?, ?, ?)`,
      [eventId, threadId, fixtures().users.trooper1, relativeToTestNow({ days: -1 }), relativeToTestNow({ days: -1 })],
    );

    await advanceClock({ days: 30 });
    await runScheduledTask('events_reminders');

    expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(0);
  });

  test('does not remind about archived events', async () => {
    const eventId = await createEvent({
      title: 'Archived Overdue Troop',
      status: 'archived',
      start: relativeToTestNow({ days: -3 }),
      end: relativeToTestNow({ days: -2 }),
    });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await runScheduledTask('events_reminders');

    expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(0);
  });

  test('does nothing for a finished event nobody signed up to', async () => {
    await createEvent({
      title: 'Lonely Troop',
      start: relativeToTestNow({ days: -3 }),
      end: relativeToTestNow({ days: -2 }),
    });

    const output = await runScheduledTask('events_reminders');
    expect(output).toContain('Event reminder PMs sent for 0 event(s)');
  });

  test('an event that finishes while the clock advances becomes overdue', async () => {
    const eventId = await createEvent({
      title: 'Soon Finished Troop',
      start: relativeToTestNow({ days: 1 }),
      end: relativeToTestNow({ days: 1, hours: 6 }),
    });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await runScheduledTask('events_reminders');
    expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(0);

    await setClock(relativeToTestNow({ days: 2 }));
    await runScheduledTask('events_reminders');
    expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(1);
  });
});
