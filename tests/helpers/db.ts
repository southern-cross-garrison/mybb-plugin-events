import fs from 'node:fs';
import path from 'node:path';
import mysql, { Connection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { DB, FORUM_DIR, TABLE_PREFIX } from './config';
import { relativeToTestNow } from './clock';

let connection: Connection | null = null;

export async function db(): Promise<Connection> {
  if (!connection) {
    connection = await mysql.createConnection({ ...DB, multipleStatements: true, dateStrings: true });
  }
  return connection;
}

export async function closeDb(): Promise<void> {
  if (connection) {
    await connection.end();
    connection = null;
  }
}

export async function query<T extends RowDataPacket>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await (await db()).execute<T[]>(sql, params);
  return rows;
}

export async function queryOne<T extends RowDataPacket>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function execute(sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [result] = await (await db()).execute<ResultSetHeader>(sql, params);
  return result;
}

export const T = (name: string) => `${TABLE_PREFIX}${name}`;

// ---------------------------------------------------------------------------
// Fixtures written by scripts/provision.php
// ---------------------------------------------------------------------------

export interface Fixtures {
  password: string;
  profileFields: Record<string, number>;
  costumeOptions: string[];
  groups: { gec: number; garrison: number; legion: number };
  forums: { general: number; troop_reports: number; events: number; events_hunter: number };
  users: Record<string, number>;
}

let fixturesCache: Fixtures | null = null;

export function fixtures(): Fixtures {
  if (!fixturesCache) {
    const file = path.join(FORUM_DIR, 'events-fixtures.json');
    if (!fs.existsSync(file)) {
      throw new Error(`Fixture map not found at ${file}. Run scripts/bootstrap.sh first.`);
    }
    fixturesCache = JSON.parse(fs.readFileSync(file, 'utf8')) as Fixtures;
  }
  return fixturesCache;
}

export const uid = (username: string): number => {
  const id = fixtures().users[username];
  if (!id) {
    throw new Error(`Unknown fixture user "${username}"`);
  }
  return id;
};

// ---------------------------------------------------------------------------
// Plugin state
// ---------------------------------------------------------------------------

const PLUGIN_TABLES = [
  'event_plugin_rsvp_costumes',
  'event_plugin_rsvp_days',
  'event_plugin_rsvps',
  'event_plugin_event_days',
  'event_plugin_event_exclusions',
  'event_plugin_troop_reports',
  'event_plugin_events',
  'event_plugin_user_prefs',
  'event_plugin_feed_tokens',
];

const USERFIELDS_BACKUP = `${TABLE_PREFIX}userfields_e2e_backup`;

/**
 * Take a copy of the provisioned custom profile fields.
 *
 * Several tests write to them (the RSVP prerequisites step saves to the user's profile),
 * so they have to be restored between tests or fixtures leak from one test to the next.
 */
export async function snapshotUserFields(): Promise<void> {
  const conn = await db();
  await conn.query(`DROP TABLE IF EXISTS ${USERFIELDS_BACKUP}`);
  await conn.query(`CREATE TABLE ${USERFIELDS_BACKUP} AS SELECT * FROM ${T('userfields')}`);
}

/**
 * The board's forum content: every table that holds a thread or post, or a count or cache
 * derived from them.
 *
 * Tests post real threads - announcements, troop reports, ordinary threads the exclusion
 * tests hide - and those used to outlive the test that posted them. Every test starts the
 * clock at the same instant, so a run's threads all carry timestamps within seconds of
 * each other, and where a new one sorted in a forum listing came down to how long the
 * tests before it took. By the exclusion tests the events forum held over fifty, and the
 * thread a test had just posted could be on page 2 - failing "it is listed" and quietly
 * passing "it is not". Restored to the snapshot before every test, a listing holds the
 * handful of threads the snapshot has plus whatever this test posts.
 *
 * `forums` carries each forum's cached thread and post counts and its "last post", so it
 * comes back with the threads. Deleting rows does not rewind a MyISAM AUTO_INCREMENT, so
 * a new thread never reuses an id an earlier test's thread had - nothing left holding an
 * old tid (a read-marker cookie, a search result) can come to point at a new one.
 */
const BOARD_CONTENT_TABLES = [
  'threads',
  'posts',
  'forums',
  'threadsread',
  'forumsread',
  'threadsubscriptions',
  'threadratings',
  'threadviews',
  'polls',
  'pollvotes',
  'attachments',
  'moderatorlog',
  'reportedcontent',
  'delayedmoderation',
  'searchlog',
];

/**
 * The datacache rows built from threads and posts. Only these: the rest of the cache
 * holds board configuration, and `tasks` in particular holds each task's next run -
 * rewinding that would set the reminder task off in the middle of an unrelated test.
 */
const BOARD_CONTENT_CACHES = ['stats', 'statistics', 'most_replied_threads', 'most_viewed_threads'];

const backupOf = (table: string) => `${TABLE_PREFIX}${table}_e2e_backup`;
const USER_COUNTS_BACKUP = backupOf('user_post_counts');
const CACHE_BACKUP = backupOf('datacache');

/** Take a copy of the snapshot's forum content, for restoreBoardContent(). */
export async function snapshotBoardContent(): Promise<void> {
  const conn = await db();
  for (const table of BOARD_CONTENT_TABLES) {
    await conn.query(`DROP TABLE IF EXISTS ${backupOf(table)}`);
    await conn.query(`CREATE TABLE ${backupOf(table)} AS SELECT * FROM ${T(table)}`);
  }

  // Posting bumps the author's counts on their users row, which cannot be restored
  // whole: logging in writes to it too.
  await conn.query(`DROP TABLE IF EXISTS ${USER_COUNTS_BACKUP}`);
  await conn.query(`CREATE TABLE ${USER_COUNTS_BACKUP} AS SELECT uid, postnum, threadnum FROM ${T('users')}`);

  await conn.query(`DROP TABLE IF EXISTS ${CACHE_BACKUP}`);
  await conn.query(`CREATE TABLE ${CACHE_BACKUP} AS SELECT * FROM ${T('datacache')} WHERE title IN (?)`, [
    BOARD_CONTENT_CACHES,
  ]);
}

/** Put the forum content back the way snapshotBoardContent() found it. */
export async function restoreBoardContent(): Promise<void> {
  const conn = await db();
  for (const table of BOARD_CONTENT_TABLES) {
    await conn.query(`DELETE FROM ${T(table)}`);
    await conn.query(`INSERT INTO ${T(table)} SELECT * FROM ${backupOf(table)}`);
  }

  await conn.query(
    `UPDATE ${T('users')} u INNER JOIN ${USER_COUNTS_BACKUP} b ON b.uid = u.uid
        SET u.postnum = b.postnum, u.threadnum = b.threadnum`,
  );

  await conn.query(`DELETE FROM ${T('datacache')} WHERE title IN (?)`, [BOARD_CONTENT_CACHES]);
  await conn.query(`INSERT INTO ${T('datacache')} SELECT * FROM ${CACHE_BACKUP}`);
}

/** Clear everything the plugin owns so each test starts from an empty slate. */
export async function resetPluginData(): Promise<void> {
  const conn = await db();
  for (const table of PLUGIN_TABLES) {
    await conn.query(`TRUNCATE TABLE ${T(table)}`);
  }

  // Task logs are read back by the reminder tests and are not written in timestamp
  // order once the clock starts moving.
  await conn.query(`TRUNCATE TABLE ${T('tasklog')}`);

  const [backups] = await conn.query<any[]>(`SHOW TABLES LIKE '${USERFIELDS_BACKUP}'`);
  if (backups.length) {
    await conn.query(`DELETE FROM ${T('userfields')}`);
    await conn.query(`INSERT INTO ${T('userfields')} SELECT * FROM ${USERFIELDS_BACKUP}`);
  }
}

export interface EventInput {
  title: string;
  description?: string;
  status?: 'pending' | 'live' | 'archived';
  // A plain string rather than a union of the four the plugin ships with: the region
  // list is editable from the Admin CP, so a test is free to invent one.
  region?: string;
  /** Where the event happens; rendered as a Google Maps link wherever it is shown. */
  address?: string;
  /** MySQL datetime, or an offset from TEST_NOW. */
  start?: string | { days?: number; hours?: number };
  end?: string | { days?: number; hours?: number };
  signupCutoff?: string | { days?: number; hours?: number } | null;
  requiresWwcc?: boolean;
  coordinator?: string;
  /** Username of the event's point of contact; nobody when omitted. */
  pointOfContact?: string;
  threadId?: number | null;
  /** Dates (YYYY-MM-DD) for a multi-day event. */
  days?: Array<{ date: string; start?: string; end?: string }>;
  excluded?: string[];
}

const toDateTime = (
  value: string | { days?: number; hours?: number } | null | undefined,
  fallback: { days?: number; hours?: number },
): string => {
  if (typeof value === 'string') return value;
  return relativeToTestNow(value ?? fallback);
};

/**
 * Insert an event (and its days/exclusions) directly, for tests that need a specific
 * scenario rather than to exercise the Admin CP.
 */
export async function createEvent(input: EventInput): Promise<number> {
  const start = toDateTime(input.start, { days: 7 });
  const end = toDateTime(input.end, { days: 7, hours: 8 });
  const cutoff = input.signupCutoff === null ? null : input.signupCutoff === undefined ? null : toDateTime(input.signupCutoff, {});
  const now = relativeToTestNow({});

  const result = await execute(
    `INSERT INTO ${T('event_plugin_events')}
       (title, description, status, region, address, start_date, end_date, signup_cutoff,
        requires_wwcc, gec_user_id, poc_user_id, created_by, thread_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.title,
      input.description ?? `${input.title} description`,
      input.status ?? 'live',
      input.region ?? 'Sydney',
      input.address ?? '',
      start,
      end,
      cutoff,
      input.requiresWwcc ? 1 : 0,
      uid(input.coordinator ?? 'gec'),
      input.pointOfContact ? uid(input.pointOfContact) : 0,
      uid('gec'),
      input.threadId ?? null,
      now,
      now,
    ],
  );

  const eventId = result.insertId;

  for (const day of input.days ?? []) {
    await execute(
      `INSERT INTO ${T('event_plugin_event_days')} (event_id, date, start_time, end_time) VALUES (?, ?, ?, ?)`,
      [eventId, day.date, day.start ?? '09:00:00', day.end ?? '17:00:00'],
    );
  }

  for (const username of input.excluded ?? []) {
    await execute(
      `INSERT INTO ${T('event_plugin_event_exclusions')} (event_id, user_id) VALUES (?, ?)`,
      [eventId, uid(username)],
    );
  }

  return eventId;
}

export async function getEvent(eventId: number): Promise<RowDataPacket> {
  const row = await queryOne<RowDataPacket>(`SELECT * FROM ${T('event_plugin_events')} WHERE id = ?`, [eventId]);
  if (!row) throw new Error(`Event ${eventId} not found`);
  return row;
}

export async function getEventDays(eventId: number): Promise<RowDataPacket[]> {
  return query<RowDataPacket>(`SELECT * FROM ${T('event_plugin_event_days')} WHERE event_id = ? ORDER BY date ASC`, [
    eventId,
  ]);
}

/** Record an RSVP without walking the wizard, for tests that only need the end state. */
export type SignupRole = 'trooper' | 'wrangler';

export async function createRsvp(
  eventId: number,
  username: string,
  options: { costumes?: string[]; dayIds?: number[]; at?: string; role?: SignupRole } = {},
): Promise<number> {
  const role: SignupRole = options.role ?? 'trooper';

  const result = await execute(
    `INSERT INTO ${T('event_plugin_rsvps')} (event_id, user_id, role, rsvp_date, status) VALUES (?, ?, ?, ?, 'attending')`,
    [eventId, uid(username), role, options.at ?? relativeToTestNow({})],
  );

  const rsvpId = result.insertId;

  // Wranglers are never costumed, so they get no costume rows even by default.
  const costumes = role === 'wrangler' ? [] : options.costumes ?? [fixtures().costumeOptions[0]];
  for (const costume of costumes) {
    await execute(`INSERT INTO ${T('event_plugin_rsvp_costumes')} (rsvp_id, costume) VALUES (?, ?)`, [rsvpId, costume]);
  }

  for (const dayId of options.dayIds ?? []) {
    await execute(`INSERT INTO ${T('event_plugin_rsvp_days')} (rsvp_id, event_day_id) VALUES (?, ?)`, [rsvpId, dayId]);
  }

  return rsvpId;
}

/** Counts every role unless one is named. */
export async function countRsvps(eventId: number, role?: SignupRole): Promise<number> {
  const row = await queryOne<RowDataPacket>(
    `SELECT COUNT(*) AS total FROM ${T('event_plugin_rsvps')} WHERE event_id = ? AND status = 'attending'` +
      (role ? ' AND role = ?' : ''),
    role ? [eventId, role] : [eventId],
  );
  return Number(row?.total ?? 0);
}

/** The roles a member holds for an event, in insertion order. */
export async function getSignupRoles(eventId: number, username: string): Promise<string[]> {
  const rows = await query<RowDataPacket>(
    `SELECT role FROM ${T('event_plugin_rsvps')} WHERE event_id = ? AND user_id = ? ORDER BY id ASC`,
    [eventId, uid(username)],
  );
  return rows.map((row) => String(row.role));
}

export async function getRsvpCostumes(
  eventId: number,
  username: string,
  role: SignupRole = 'trooper',
): Promise<string[]> {
  const rows = await query<RowDataPacket>(
    `SELECT c.costume
       FROM ${T('event_plugin_rsvp_costumes')} c
       INNER JOIN ${T('event_plugin_rsvps')} r ON c.rsvp_id = r.id
      WHERE r.event_id = ? AND r.user_id = ? AND r.role = ?
      ORDER BY c.costume ASC`,
    [eventId, uid(username), role],
  );
  return rows.map((row) => String(row.costume));
}

export async function getRsvpDayIds(
  eventId: number,
  username: string,
  role: SignupRole = 'trooper',
): Promise<number[]> {
  const rows = await query<RowDataPacket>(
    `SELECT d.event_day_id
       FROM ${T('event_plugin_rsvp_days')} d
       INNER JOIN ${T('event_plugin_rsvps')} r ON d.rsvp_id = r.id
      WHERE r.event_id = ? AND r.user_id = ? AND r.role = ?
      ORDER BY d.event_day_id ASC`,
    [eventId, uid(username), role],
  );
  return rows.map((row) => Number(row.event_day_id));
}

export async function getTroopReport(eventId: number): Promise<RowDataPacket | null> {
  return queryOne<RowDataPacket>(`SELECT * FROM ${T('event_plugin_troop_reports')} WHERE event_id = ?`, [eventId]);
}

/**
 * Put a troop report row on an event without walking the form.
 *
 * `posted: false` is the row events_send_reminders() leaves behind for an event with no
 * report at all, purely to record when it last nagged - the row exists and the report
 * does not, which is the case anything reading "has this event been written up?" has to
 * get right.
 */
export async function createTroopReport(
  eventId: number,
  options: { posted?: boolean; author?: string; threadId?: number } = {},
): Promise<void> {
  const now = relativeToTestNow({});
  await execute(
    `INSERT INTO ${T('event_plugin_troop_reports')} (event_id, thread_id, created_by, created_at, posted_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      eventId,
      options.threadId ?? null,
      uid(options.author ?? 'trooper1'),
      now,
      options.posted === false ? null : now,
    ],
  );
}

// ---------------------------------------------------------------------------
// Board state used by the tests
// ---------------------------------------------------------------------------

export async function setUserField(username: string, field: string, value: string): Promise<void> {
  const fid = fixtures().profileFields[field];
  if (!fid) throw new Error(`Unknown profile field "${field}"`);

  const userId = uid(username);
  const existing = await queryOne<RowDataPacket>(`SELECT ufid FROM ${T('userfields')} WHERE ufid = ?`, [userId]);

  if (existing) {
    await execute(`UPDATE ${T('userfields')} SET fid${fid} = ? WHERE ufid = ?`, [value, userId]);
  } else {
    await execute(`INSERT INTO ${T('userfields')} (ufid, fid${fid}) VALUES (?, ?)`, [userId, value]);
  }
}

/**
 * Put a user in a set of additional usergroups, and hand back a function that restores
 * the groups they had before.
 *
 * Group membership is provisioned board state rather than plugin data, so it survives
 * resetPluginData() between tests - a test that moves somebody has to move them back.
 */
export async function setAdditionalGroups(username: string, gids: number[]): Promise<() => Promise<void>> {
  const userId = uid(username);
  const before = await queryOne<RowDataPacket>(`SELECT additionalgroups FROM ${T('users')} WHERE uid = ?`, [userId]);
  const original = String(before?.additionalgroups ?? '');

  await execute(`UPDATE ${T('users')} SET additionalgroups = ? WHERE uid = ?`, [gids.join(','), userId]);

  return async () => {
    await execute(`UPDATE ${T('users')} SET additionalgroups = ? WHERE uid = ?`, [original, userId]);
  };
}

export async function getUserField(username: string, field: string): Promise<string> {
  const fid = fixtures().profileFields[field];
  const row = await queryOne<RowDataPacket>(`SELECT fid${fid} AS value FROM ${T('userfields')} WHERE ufid = ?`, [
    uid(username),
  ]);
  return String(row?.value ?? '');
}

export async function countPrivateMessages(username: string, subjectLike: string): Promise<number> {
  const row = await queryOne<RowDataPacket>(
    `SELECT COUNT(*) AS total FROM ${T('privatemessages')} WHERE uid = ? AND folder = 1 AND subject LIKE ?`,
    [uid(username), subjectLike],
  );
  return Number(row?.total ?? 0);
}

/** The PMs in a member's inbox whose subject matches, oldest first. */
export async function getPrivateMessages(username: string, subjectLike: string): Promise<RowDataPacket[]> {
  return query<RowDataPacket>(
    `SELECT subject, message, fromid FROM ${T('privatemessages')} WHERE uid = ? AND folder = 1 AND subject LIKE ? ORDER BY pmid ASC`,
    [uid(username), subjectLike],
  );
}

export async function deletePrivateMessages(): Promise<void> {
  await execute(`DELETE FROM ${T('privatemessages')}`, []);
}

export async function findThreadBySubject(subject: string): Promise<RowDataPacket | null> {
  return queryOne<RowDataPacket>(`SELECT * FROM ${T('threads')} WHERE subject = ? ORDER BY tid DESC LIMIT 1`, [subject]);
}

export async function createThread(subject: string, forumId: number, authorUsername: string): Promise<number> {
  const result = await execute(
    `INSERT INTO ${T('threads')} (fid, subject, prefix, icon, uid, username, dateline, lastpost, lastposter,
                                 lastposteruid, views, replies, closed, sticky, numratings, totalratings, notes, visible)
     VALUES (?, ?, 0, 0, ?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP(), ?, ?, 0, 0, '', 0, 0, 0, '', 1)`,
    [forumId, subject, uid(authorUsername), authorUsername, authorUsername, uid(authorUsername)],
  );
  return result.insertId;
}

export async function getThread(threadId: number): Promise<RowDataPacket> {
  const row = await queryOne<RowDataPacket>(`SELECT * FROM ${T('threads')} WHERE tid = ?`, [threadId]);
  if (!row) throw new Error(`Thread ${threadId} not found`);
  return row;
}

/** The body of a thread's opening post - what the plugin writes when it announces an event. */
export async function getThreadFirstPost(threadId: number): Promise<RowDataPacket> {
  const row = await queryOne<RowDataPacket>(
    `SELECT p.* FROM ${T('posts')} p
     INNER JOIN ${T('threads')} t ON t.firstpost = p.pid
     WHERE t.tid = ?`,
    [threadId],
  );
  if (!row) throw new Error(`Thread ${threadId} has no first post`);
  return row;
}

/**
 * The newest thread id on the board.
 *
 * Threads outlive a test - resetPluginData() only truncates what the plugin owns - so
 * "nothing was posted" is asserted as "no thread appeared after this point" rather than
 * by counting subjects, which a leftover from an earlier run would answer wrongly.
 */
export async function maxThreadId(): Promise<number> {
  const row = await queryOne<RowDataPacket>(`SELECT COALESCE(MAX(tid), 0) AS tid FROM ${T('threads')}`);
  return Number(row?.tid ?? 0);
}

export async function countPostsInThread(threadId: number): Promise<number> {
  const row = await queryOne<RowDataPacket>(`SELECT COUNT(*) AS total FROM ${T('posts')} WHERE tid = ?`, [threadId]);
  return Number(row?.total ?? 0);
}

/**
 * Point MyBB's per-user activity timestamps at the container's current (faked) time.
 *
 * MyBB's shutdown handler adds `now - lastactive` to users.timeonline, which is an
 * UNSIGNED column. Rewinding the clock between tests makes that difference negative and
 * MySQL rejects the update, so the timestamps are realigned each time the clock moves.
 */
export async function alignUserActivityToClock(containerNow: string): Promise<void> {
  const epoch = Math.floor(Date.parse(`${containerNow.replace(' ', 'T')}Z`) / 1000);

  await execute(`UPDATE ${T('users')} SET lastactive = ?, lastvisit = ?, timeonline = 0`, [epoch, epoch]);
  await execute(`UPDATE ${T('sessions')} SET time = ?`, [epoch]);
}

export async function getSetting(name: string): Promise<string> {
  const row = await queryOne<RowDataPacket>(`SELECT value FROM ${T('settings')} WHERE name = ?`, [name]);
  return String(row?.value ?? '');
}
