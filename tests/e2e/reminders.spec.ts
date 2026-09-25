import { test, expect } from '../helpers/fixtures';
import { advanceClock, relativeToTestNow, setClock } from '../helpers/clock';
import { runPhp, runScheduledTask } from '../helpers/container';
import {
  createEvent,
  createRsvp,
  countRsvps,
  query,
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

  test('leaves wranglers alone: they cannot write the report', async () => {
    const eventId = await createEvent({
      title: 'Wrangled Overdue Troop',
      start: relativeToTestNow({ days: -3 }),
      end: relativeToTestNow({ days: -2 }),
    });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });
    await createRsvp(eventId, 'wrangler', { role: 'wrangler' });

    await runScheduledTask('events_reminders');

    expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(1);
    expect(await countPrivateMessages('wrangler', SUBJECT)).toBe(0);
  });

  test('PMs a member who both trooped and wrangled exactly once', async () => {
    const eventId = await createEvent({
      title: 'Dual Role Overdue Troop',
      start: relativeToTestNow({ days: -3 }),
      end: relativeToTestNow({ days: -2 }),
    });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });
    await createRsvp(eventId, 'trooper1', { role: 'wrangler' });

    await runScheduledTask('events_reminders');

    expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(1);
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

  // The task runs on the first page view after midnight, so its hour drifts from run to
  // run. Against an exact seven-day cutoff, a run on day 7 that came a few minutes
  // earlier in the day than day 0's fell short of the week, and every reminder after
  // the first went out on day 8.
  test('reminds again on day seven even when that run is earlier in the day', async () => {
    const eventId = await createEvent({
      title: 'Weekly Troop',
      start: relativeToTestNow({ days: -3 }),
      end: relativeToTestNow({ days: -2 }),
    });
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    await runScheduledTask('events_reminders');
    expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(1);

    // Late on day six is more than six days on, but still not a week of days.
    await setClock(relativeToTestNow({ days: 6, hours: 14 }));
    await runScheduledTask('events_reminders');
    expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(1);

    await setClock(relativeToTestNow({ days: 7, minutes: -10 }));
    await runScheduledTask('events_reminders');
    expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(2);

    // And the week after counts from day seven, not from day eight.
    await setClock(relativeToTestNow({ days: 14, minutes: -20 }));
    await runScheduledTask('events_reminders');
    expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(3);
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

  // The reminder is one PM to every attendee, and MyBB refuses the whole PM if any one
  // recipient does not exist - so a single deleted member used to silence it for the
  // rest of the event, every night, with nothing but a skipped event to show for it.
  test.describe('deleted members', () => {
    /** Register a member through MyBB's own datahandler; returns the uid. */
    async function registerMember(username: string): Promise<number> {
      const output = await runPhp(`
require_once MYBB_ROOT.'inc/datahandlers/user.php';
$handler = new UserDataHandler('insert');
$handler->set_data(array(
  'username' => '${username}',
  'password' => 'Passw0rd!Passw0rd',
  'password2' => 'Passw0rd!Passw0rd',
  'email' => '${username}@example.invalid',
  'email2' => '${username}@example.invalid',
  'usergroup' => 2,
  'regip' => '127.0.0.1',
));
if(!$handler->validate_user()) { echo 'INVALID:'.implode(',', array_keys($handler->get_errors())); exit; }
$user = $handler->insert_user();
echo 'UID:'.$user['uid'];
`);
      const match = output.match(/UID:(\d+)/);
      expect(match, output).not.toBeNull();
      return Number(match![1]);
    }

    /** A signup by uid: createRsvp() only knows the fixture members. */
    async function insertSignup(eventId: number, userId: number, role: 'trooper' | 'wrangler' = 'trooper'): Promise<number> {
      const result = await execute(
        `INSERT INTO ${T('event_plugin_rsvps')} (event_id, user_id, role, rsvp_date, status) VALUES (?, ?, ?, ?, 'attending')`,
        [eventId, userId, role, relativeToTestNow({ days: -4 })],
      );
      if (role === 'trooper') {
        await execute(`INSERT INTO ${T('event_plugin_rsvp_costumes')} (rsvp_id, costume) VALUES (?, ?)`, [result.insertId, TK]);
      }
      return result.insertId;
    }

    /** Delete members the way the Admin CP and the pruning task do. */
    async function deleteMembers(uids: number[]): Promise<void> {
      await runPhp(`
require_once MYBB_ROOT.'inc/datahandlers/user.php';
$handler = new UserDataHandler('delete');
$handler->delete_user(array(${uids.join(',')}));
`);
    }

    test('a signup whose member no longer exists does not stop the reminder', async () => {
      const eventId = await createEvent({
        title: 'Orphaned Overdue Troop',
        start: relativeToTestNow({ days: -3 }),
        end: relativeToTestNow({ days: -2 }),
      });
      await createRsvp(eventId, 'trooper1', { costumes: [TK] });

      // Left behind by a deletion the plugin was not there to see - before this fix, or
      // straight from the database.
      const [{ uid: ghost }] = await query<any>(`SELECT MAX(uid) + 1000 AS uid FROM ${T('users')}`);
      await insertSignup(eventId, ghost);

      const output = await runScheduledTask('events_reminders');

      expect(output).toContain('Event reminder PMs sent for 1 event(s)');
      expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(1);
      expect((await getTroopReport(eventId))?.last_reminder_sent).toBeTruthy();
    });

    test('deleting a member withdraws their signups, and the reminder still goes out', async () => {
      const username = `e2e_deleted_${Date.now()}`;
      const ghost = await registerMember(username);

      const eventId = await createEvent({
        title: 'Deleted Member Troop',
        start: relativeToTestNow({ days: -3 }),
        end: relativeToTestNow({ days: -2 }),
      });
      await createRsvp(eventId, 'trooper1', { costumes: [TK] });
      await insertSignup(eventId, ghost);
      await insertSignup(eventId, ghost, 'wrangler');
      expect(await countRsvps(eventId)).toBe(3);

      await deleteMembers([ghost]);

      // The counts now agree with the attendee list, which never showed them.
      expect(await countRsvps(eventId)).toBe(1);
      const leftovers = await query<any>(
        `SELECT COUNT(*) AS n FROM ${T('event_plugin_rsvp_costumes')} c
         LEFT JOIN ${T('event_plugin_rsvps')} r ON r.id = c.rsvp_id WHERE r.id IS NULL`,
      );
      expect(Number(leftovers[0].n)).toBe(0);

      await runScheduledTask('events_reminders');
      expect(await countPrivateMessages('trooper1', SUBJECT)).toBe(1);
    });

    test('activation clears signups that earlier deletions left behind', async () => {
      const eventId = await createEvent({ title: 'Upgrade Orphan Troop' });
      await createRsvp(eventId, 'trooper1', { costumes: [TK] });

      const [{ uid: ghost }] = await query<any>(`SELECT MAX(uid) + 1000 AS uid FROM ${T('users')}`);
      const rsvpId = await insertSignup(eventId, ghost);
      expect(await countRsvps(eventId)).toBe(2);

      await runPhp(`
require_once MYBB_ROOT.'inc/plugins/events/inc/events_install.php';
events_upgrade_database();
`);

      expect(await countRsvps(eventId)).toBe(1);
      const costumes = await query<any>(`SELECT COUNT(*) AS n FROM ${T('event_plugin_rsvp_costumes')} WHERE rsvp_id = ?`, [rsvpId]);
      expect(Number(costumes[0].n)).toBe(0);
    });
  });
});
