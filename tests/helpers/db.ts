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
  groups: { gec: number; scg: number; legion: number };
  forums: { general: number; troop_reports: number };
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
  region?: 'Sydney' | 'Hunter' | 'Canberra' | 'Other';
  /** MySQL datetime, or an offset from TEST_NOW. */
  start?: string | { days?: number; hours?: number };
  end?: string | { days?: number; hours?: number };
  signupCutoff?: string | { days?: number; hours?: number } | null;
  requiresWwcc?: boolean;
  coordinator?: string;
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
       (title, description, status, region, start_date, end_date, signup_cutoff,
        requires_wwcc, gec_user_id, created_by, thread_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.title,
      input.description ?? `${input.title} description`,
      input.status ?? 'live',
      input.region ?? 'Sydney',
      start,
      end,
      cutoff,
      input.requiresWwcc ? 1 : 0,
      uid(input.coordinator ?? 'gec'),
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
export async function createRsvp(
  eventId: number,
  username: string,
  options: { costumes?: string[]; dayIds?: number[]; at?: string } = {},
): Promise<number> {
  const result = await execute(
    `INSERT INTO ${T('event_plugin_rsvps')} (event_id, user_id, rsvp_date, status) VALUES (?, ?, ?, 'attending')`,
    [eventId, uid(username), options.at ?? relativeToTestNow({})],
  );

  const rsvpId = result.insertId;

  for (const costume of options.costumes ?? [fixtures().costumeOptions[0]]) {
    await execute(`INSERT INTO ${T('event_plugin_rsvp_costumes')} (rsvp_id, costume) VALUES (?, ?)`, [rsvpId, costume]);
  }

  for (const dayId of options.dayIds ?? []) {
    await execute(`INSERT INTO ${T('event_plugin_rsvp_days')} (rsvp_id, event_day_id) VALUES (?, ?)`, [rsvpId, dayId]);
  }

  return rsvpId;
}

export async function countRsvps(eventId: number): Promise<number> {
  const row = await queryOne<RowDataPacket>(
    `SELECT COUNT(*) AS total FROM ${T('event_plugin_rsvps')} WHERE event_id = ? AND status = 'attending'`,
    [eventId],
  );
  return Number(row?.total ?? 0);
}

export async function getRsvpCostumes(eventId: number, username: string): Promise<string[]> {
  const rows = await query<RowDataPacket>(
    `SELECT c.costume
       FROM ${T('event_plugin_rsvp_costumes')} c
       INNER JOIN ${T('event_plugin_rsvps')} r ON c.rsvp_id = r.id
      WHERE r.event_id = ? AND r.user_id = ?
      ORDER BY c.costume ASC`,
    [eventId, uid(username)],
  );
  return rows.map((row) => String(row.costume));
}

export async function getRsvpDayIds(eventId: number, username: string): Promise<number[]> {
  const rows = await query<RowDataPacket>(
    `SELECT d.event_day_id
       FROM ${T('event_plugin_rsvp_days')} d
       INNER JOIN ${T('event_plugin_rsvps')} r ON d.rsvp_id = r.id
      WHERE r.event_id = ? AND r.user_id = ?
      ORDER BY d.event_day_id ASC`,
    [eventId, uid(username)],
  );
  return rows.map((row) => Number(row.event_day_id));
}

export async function getTroopReport(eventId: number): Promise<RowDataPacket | null> {
  return queryOne<RowDataPacket>(`SELECT * FROM ${T('event_plugin_troop_reports')} WHERE event_id = ?`, [eventId]);
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
