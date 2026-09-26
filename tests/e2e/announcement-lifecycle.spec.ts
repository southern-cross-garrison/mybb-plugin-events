import { test, expect } from '../helpers/fixtures';
import { loginAs, loginToAdminCp, followAdminActionLink, gotoEventsAdmin } from '../helpers/auth';
import { runPhp } from '../helpers/container';
import { withSettings } from '../helpers/settings';
import { submitFormAtOnce } from '../helpers/double-submit';
import {
  createEvent,
  execute,
  fixtures,
  getEvent,
  getThread,
  getThreadFirstPost,
  query,
  T,
} from '../helpers/db';

/**
 * event-announcements.spec.ts covers the announcement a healthy event gets. This covers
 * what becomes of that thread when something goes wrong around it - no forum to post
 * into, a thread deleted out from under the event, a moderator who filed it somewhere of
 * their own choosing, an event archived or deleted after the fact.
 *
 * Every one of these is a path through events_sync_event_thread() that a coordinator
 * reaches by doing something perfectly ordinary, and every one of them fails quietly by
 * default: the event saves whatever happens to its thread, so an announcement that was
 * never posted is an event nobody hears about with nothing on screen to say so.
 */

const FORUMS = fixtures().forums;

/** A title no earlier run can have left a thread behind under. */
const announcementTitle = (base: string) => `${base} ${Math.random().toString(36).slice(2, 8)}`;

/** Announce (or re-announce) an event the way saving it live does. */
async function announce(eventId: number): Promise<{ threadId: number; error: string }> {
  const output = await runPhp(`
require_once MYBB_ROOT.'inc/plugins/events/inc/events_thread.php';
$error = null;
$tid = events_sync_event_thread(${eventId}, $error);
echo "TID:".$tid."\\nERROR:".(string)$error;
`);

  return {
    threadId: Number(output.match(/TID:(\d+)/)?.[1] ?? 0),
    error: output.match(/ERROR:([\s\S]*)$/)?.[1]?.trim() ?? '',
  };
}

test.describe('announcement threads when something goes wrong', () => {
  test('an event with nowhere to announce is still saved, and says nothing was posted', async ({ page }) => {
    // Hunter has a forum of its own, so both it and the board-wide fallback have to go
    // before there is nowhere left to post.
    const restore = await withSettings({ events_event_forum: '', events_event_forums: '' });

    try {
      await loginAs(page, 'gec');
      await page.goto('/manage_event.php');

      await page.locator('#event_form_title').fill('Unannounceable Troop');
      await page.locator('#event_form_status').selectOption('live');
      await page.locator('#event_form_region').selectOption('Hunter');
      await page.locator('#event_form_start_date').fill('2026-11-02');
      await page.locator('#event_form_start_date_time').fill('09:00');
      await page.locator('#event_form_end_date').fill('2026-11-02');
      await page.locator('#event_form_end_date_time').fill('17:00');
      await page.locator('#manage_event_submit').click();

      // The event is the thing being created, so it is saved either way - but the
      // coordinator is told, because nothing else on the page would show it.
      await expect(page.locator('body')).toContainText('No forum is configured for Hunter events');

      const [row] = await query(
        `SELECT id, thread_id FROM ${T('event_plugin_events')} WHERE title = 'Unannounceable Troop'`,
      );
      expect(row, 'the event was not saved').toBeTruthy();
      expect(row.thread_id).toBeNull();
    } finally {
      await restore();
    }
  });

  test('a deleted thread is replaced rather than leaving the event unannounced', async () => {
    const title = announcementTitle('Vanishing Troop');
    const eventId = await createEvent({ title, status: 'live', region: 'Sydney' });

    const first = await announce(eventId);
    expect(first.threadId).toBeGreaterThan(0);
    expect(Number((await getEvent(eventId)).thread_id)).toBe(first.threadId);

    // A moderator deleting the thread leaves the event pointing at nothing. Re-announcing
    // rather than giving up is also what makes deleting the thread the way to force a
    // fresh one.
    await execute(`DELETE FROM ${T('threads')} WHERE tid = ?`, [first.threadId]);

    const second = await announce(eventId);
    expect(second.error).toBe('');
    expect(second.threadId).toBeGreaterThan(0);
    expect(second.threadId).not.toBe(first.threadId);
    expect(Number((await getEvent(eventId)).thread_id)).toBe(second.threadId);
    expect((await getThread(second.threadId)).subject).toBe(title);
  });

  test('a thread a moderator filed elsewhere is left where they put it', async () => {
    const title = announcementTitle('Rehomed Troop');
    const eventId = await createEvent({ title, status: 'live', region: 'Sydney' });
    const { threadId } = await announce(eventId);

    // Sydney has no forum of its own, so it announces into the default events forum.
    expect(Number((await getThread(threadId)).fid)).toBe(FORUMS.events);

    // A moderator moves it somewhere the plugin never announces into. That is a decision,
    // not a mistake, so correcting the region afterwards must not drag the discussion
    // back out of the forum it has been living in.
    await execute(`UPDATE ${T('threads')} SET fid = ? WHERE tid = ?`, [FORUMS.general, threadId]);
    await execute(`UPDATE ${T('event_plugin_events')} SET region = 'Hunter' WHERE id = ?`, [eventId]);

    const again = await announce(eventId);
    expect(again.threadId).toBe(threadId);
    expect(Number((await getThread(threadId)).fid)).toBe(FORUMS.general);

    // The post itself still follows the event, even though the thread did not move.
    expect((await getThreadFirstPost(threadId)).message).toContain('Hunter');
  });

  test('archiving an event rewrites its thread as over, not as pulled', async ({ page }) => {
    // "This event is over" and "taken off the schedule" are two different sentences
    // reached from two branches of events_event_post_content(). Only the second was
    // covered, and an archived event reading as a cancelled one is the wrong message on
    // the thread every finished event ends up with.
    const title = announcementTitle('Closed Out Troop');
    const eventId = await createEvent({ title, status: 'live', region: 'Sydney' });
    const { threadId } = await announce(eventId);

    expect((await getThreadFirstPost(threadId)).message).not.toContain('This event is over');

    await loginToAdminCp(page);
    await followAdminActionLink(page, `action=status&id=${eventId}&status=archived`);

    expect((await getEvent(eventId)).status).toBe('archived');

    const message = (await getThreadFirstPost(threadId)).message as string;
    expect(message).toContain('This event is over and signups are closed.');
    expect(message).not.toContain('taken off the schedule');
  });

  test('deleting an event deletes its announcement thread', async ({ page }) => {
    // The thread is hidden from excluded members only through its event, so a thread
    // that outlived the event would be readable by exactly the members it was hidden
    // from, and would link them to an event that no longer exists.
    const title = announcementTitle('Deleted Troop');
    const eventId = await createEvent({ title, status: 'live', region: 'Sydney' });
    const { threadId } = await announce(eventId);
    expect(threadId).toBeGreaterThan(0);

    await loginToAdminCp(page);
    await followAdminActionLink(page, `action=delete&id=${eventId}`);

    expect(await query(`SELECT id FROM ${T('event_plugin_events')} WHERE id = ?`, [eventId])).toHaveLength(0);
    expect(await query(`SELECT tid FROM ${T('threads')} WHERE tid = ?`, [threadId])).toHaveLength(0);
    expect(await query(`SELECT pid FROM ${T('posts')} WHERE tid = ?`, [threadId])).toHaveLength(0);
  });

  test('deleting an event whose thread is already gone still deletes the event', async ({ page }) => {
    const title = announcementTitle('Threadless Troop');
    const eventId = await createEvent({ title, status: 'live', region: 'Sydney' });
    const { threadId } = await announce(eventId);

    await runPhp(`
require_once MYBB_ROOT.'inc/class_moderation.php';
(new Moderation)->delete_thread(${threadId});
`);

    await loginToAdminCp(page);
    await followAdminActionLink(page, `action=delete&id=${eventId}`);

    expect(await query(`SELECT id FROM ${T('event_plugin_events')} WHERE id = ?`, [eventId])).toHaveLength(0);
  });
});

/** Every thread on the board with this subject, oldest first. */
async function threadsTitled(title: string): Promise<number[]> {
  const rows = await query(`SELECT tid FROM ${T('threads')} WHERE subject = ? ORDER BY tid`, [title]);
  return rows.map((row: any) => Number(row.tid));
}

test.describe('announcing an event twice at once', () => {
  // Both requests used to read "no thread yet" before either had written thread_id, so
  // each posted one, and the second overwrote the first's id - leaving a thread linked to
  // no event, which the exclusion hooks therefore never hid. One lost race is enough, and
  // it only loses some of the time, so each is fired three times over.

  test('a double-clicked Make Live posts one announcement', async ({ page }) => {
    const title = announcementTitle('Double Make Live Troop');
    const eventId = await createEvent({ title, status: 'pending', region: 'Sydney' });

    await loginToAdminCp(page);
    await gotoEventsAdmin(page);

    const href = await page
      .locator(`a[href*="action=status"][href*="id=${eventId}"][href*="status=live"]`)
      .first()
      .getAttribute('href');
    expect(href).toContain('my_post_key=');

    // fetch() from the page, so each carries the session and the same-origin header a click
    // does. Each URL is made distinct because Chrome holds identical GETs back behind one
    // another for its cache, and requests that never overlap cannot race.
    await page.evaluate(async (url) => {
      await Promise.all(
        [0, 1, 2].map((n) => fetch(`${url}&attempt=${n}`, { credentials: 'same-origin', cache: 'no-store' })),
      );
    }, new URL(href!, page.url()).href);

    const threads = await threadsTitled(title);
    expect(threads).toHaveLength(1);
    expect(Number((await getEvent(eventId)).thread_id)).toBe(threads[0]);
  });

  test('a double-clicked Save posts one announcement', async ({ page }) => {
    const title = announcementTitle('Double Save Troop');
    const eventId = await createEvent({ title, status: 'pending', region: 'Sydney' });

    await loginAs(page, 'gec');
    await page.goto(`/manage_event.php?id=${eventId}`);
    await submitFormAtOnce(page, '#manage_event_form', { times: 3, overrides: { status: 'live' } });

    expect((await getEvent(eventId)).status).toBe('live');

    const threads = await threadsTitled(title);
    expect(threads).toHaveLength(1);
    expect(Number((await getEvent(eventId)).thread_id)).toBe(threads[0]);
  });
});
