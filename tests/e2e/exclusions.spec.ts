import { test, expect, expectMyBBError } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import type { Page } from '@playwright/test';
import { relativeToTestNow } from '../helpers/clock';
import { runPhp } from '../helpers/container';
import { withSettings } from '../helpers/settings';
import {
  countPrivateMessages,
  createEvent,
  createRsvp,
  createThread,
  execute,
  fixtures,
  getSetting,
  getThread,
  getRsvpStatus,
  getThreadFirstPost,
  getTroopReport,
  query,
  queryOne,
  T,
  uid,
} from '../helpers/db';

/**
 * Being excluded from an event used to mean seeing the whole thing with the signup button
 * locked - the date, the address, everyone who was going, and a pill saying you had been
 * excluded. That is a worse way to be told than not being told at all, so an exclusion
 * now hides the event: it leaves the listing and the calendar, its own pages answer the
 * way any page that is not yours does, and its announcement thread is unreachable in the
 * forums.
 *
 * The troop report is deliberately left alone. It is the garrison's record of what
 * happened rather than an invitation to anything, it is posted to its own forum as its
 * own thread, and it names the event in its subject - so an excluded member does learn
 * the event happened, once it is over. That is the point of a report.
 *
 * The one member an exclusion never hides an event from is whoever has to run it: see
 * events_hidden_event_ids(), and signup-locking.spec.ts for the lock they still get.
 */

const FORUMS = fixtures().forums;
const TK = fixtures().costumeOptions[0];

/**
 * The forums are put back before every test (restoreBoardContent()), but a retry runs in
 * the same worker straight after its failed attempt - so a suffix keeps each attempt's
 * thread its own, rather than asserting "this subject appears nowhere" against the one the
 * first attempt posted.
 */
const announcementTitle = (base: string) => `${base} ${Math.random().toString(36).slice(2, 8)}`;

/**
 * Open a forum's thread listing, and insist it is all on one page.
 *
 * "Not in the listing" is only a check when the listing is all there is: a thread pushed
 * onto page 2 is not on page 1 whether it is hidden or not. restoreBoardContent() keeps
 * every forum down to a handful of threads, so a second page here means that has stopped
 * working, and the test says so rather than passing on a page that could not have shown it.
 */
async function openForumListing(page: Page, fid: number): Promise<void> {
  await page.goto(`/forumdisplay.php?fid=${fid}`);
  await expect(
    page.locator(`a[href*="forumdisplay.php?fid=${fid}&page="]`),
    'the forum listing runs to a second page, so page 1 cannot answer for it',
  ).toHaveCount(0);
}

/**
 * The language file a front-end page loads in global.php and runPhp() does not. Posting
 * writes subscription notices from it, and without it they are queued with an empty body.
 */
const LOAD_MESSAGES = `$lang->load('messages');`;

/** Announce an event the way saving it live does, and return its thread id. */
async function announce(eventId: number): Promise<number> {
  const output = await runPhp(`
${LOAD_MESSAGES}
require_once MYBB_ROOT.'inc/plugins/events/inc/events_thread.php';
echo events_sync_event_thread(${eventId});
`);

  const threadId = Number(output.trim());
  expect(threadId).toBeGreaterThan(0);

  return threadId;
}

/** Reply to a thread as a member, the way MyBB's reply form writes it, and return the pid. */
async function reply(threadId: number, username: string, message: string): Promise<number> {
  const output = await runPhp(`
${LOAD_MESSAGES}
require_once MYBB_ROOT.'inc/datahandlers/post.php';
$thread = get_thread(${threadId});
$user = get_user(${uid(username)});
$handler = new PostDataHandler('insert');
$handler->admin_override = true;
$handler->set_data(array(
    'tid' => $thread['tid'], 'fid' => $thread['fid'], 'subject' => 'RE: ' . $thread['subject'],
    'uid' => $user['uid'], 'username' => $user['username'], 'message' => ${JSON.stringify(message)},
    'ipaddress' => '127.0.0.1', 'options' => array('signature' => 0, 'subscriptionmethod' => '', 'disablesmilies' => 0),
));
if(!$handler->validate_post()) { echo 'INVALID: ' . implode(' ', $handler->get_friendly_errors()); exit; }
$post = $handler->insert_post();
echo $post['pid'];
`);

  const postId = Number(output);
  expect(postId, output).toBeGreaterThan(0);

  return postId;
}

/**
 * Post an ordinary thread as a member, first post and all, and return its tid. Unlike
 * createThread() the thread has a post, so showthread.php renders it rather than refusing
 * it as invalid.
 */
async function postThread(subject: string, forumId: number, username: string): Promise<number> {
  const output = await runPhp(`
${LOAD_MESSAGES}
require_once MYBB_ROOT.'inc/datahandlers/post.php';
$user = get_user(${uid(username)});
$handler = new PostDataHandler('insert');
$handler->action = 'thread';
$handler->admin_override = true;
$handler->set_data(array(
    'fid' => ${forumId}, 'subject' => ${JSON.stringify(subject)}, 'prefix' => 0, 'icon' => 0,
    'uid' => $user['uid'], 'username' => $user['username'], 'message' => 'An ordinary thread.',
    'ipaddress' => '127.0.0.1', 'options' => array('signature' => 0, 'subscriptionmethod' => '', 'disablesmilies' => 0),
));
if(!$handler->validate_thread()) { echo 'INVALID: ' . implode(' ', $handler->get_friendly_errors()); exit; }
$thread = $handler->insert_thread();
echo $thread['tid'];
`);

  const threadId = Number(output);
  expect(threadId, output).toBeGreaterThan(0);

  return threadId;
}

/** Put a poll on a thread, under a chosen id when one is given, and return its id. */
async function addPoll(threadId: number, question: string, pollId?: number): Promise<number> {
  if (pollId !== undefined) {
    const taken = await queryOne(`SELECT pid FROM ${T('polls')} WHERE pid = ?`, [pollId]);
    expect(taken, `poll ${pollId} already exists, so the test cannot give that id to its own`).toBeNull();
  }

  const result = await execute(
    `INSERT INTO ${T('polls')} (${pollId === undefined ? '' : 'pid, '}tid, question, dateline, options, votes, numoptions)
     VALUES (${pollId === undefined ? '' : '?, '}?, ?, UNIX_TIMESTAMP(), 'Yes||~|~||No', '0||~|~||0', 2)`,
    [...(pollId === undefined ? [] : [pollId]), threadId, question],
  );
  await execute(`UPDATE ${T('threads')} SET poll = ? WHERE tid = ?`, [result.insertId, threadId]);

  return result.insertId;
}

/** Who the mail queue holds a message for that names the subject. */
async function mailedAbout(subject: string): Promise<string[]> {
  const rows = await query(`SELECT mailto FROM ${T('mailqueue')} WHERE message LIKE ?`, [`%${subject}%`]);
  return rows.map((row) => String(row.mailto));
}

async function email(username: string): Promise<string> {
  return String((await queryOne(`SELECT email FROM ${T('users')} WHERE uid = ?`, [uid(username)]))?.email);
}

/** The post key the logged-in member's pages carry, for the endpoints that check one. */
async function postKeyFor(page: Page): Promise<string> {
  await page.goto('/index.php');
  const postKey = await page.evaluate(() => (window as unknown as { my_post_key?: string }).my_post_key);
  expect(postKey, 'the page carries no my_post_key').toMatch(/^[a-f0-9]+$/);

  return postKey as string;
}

/**
 * What MyBB's no-permission page says, for matching it in a response body as well as on a
 * page: the endpoints that answer a download or a redirect when they succeed are fetched
 * with page.request, and have no page to hand expectMyBBError().
 */
const NO_PERMISSION = /do not have permission/i;

/** Lift every exclusion on an event, for a control that reuses the member it just refused. */
async function liftExclusions(eventId: number): Promise<void> {
  await execute(`DELETE FROM ${T('event_plugin_event_exclusions')} WHERE event_id = ?`, [eventId]);
}

test.describe('per-event exclusions', () => {
  test('the event is gone from the list and the calendar', async ({ page }) => {
    const hiddenId = await createEvent({ title: 'Closed Doors Troop', excluded: ['excluded'] });
    const openId = await createEvent({ title: 'Everybody Troop' });

    await loginAs(page, 'excluded');

    await page.goto('/events.php?view=list');
    await expect(page.locator(`[data-event-id="${openId}"]`)).toBeVisible();
    await expect(page.locator(`[data-event-id="${hiddenId}"]`)).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Closed Doors Troop');

    await page.goto('/events.php?view=calendar');
    await expect(page.locator('body')).toContainText('Everybody Troop');
    await expect(page.locator('body')).not.toContainText('Closed Doors Troop');

    // Everybody else's listing is untouched.
    await loginAs(page, 'trooper1');
    await page.goto('/events.php?view=list');
    await expect(page.locator(`[data-event-id="${hiddenId}"]`)).toBeVisible();
  });

  test("the event's own pages refuse, feed included", async ({ page }) => {
    const eventId = await createEvent({ title: 'Private Troop', excluded: ['excluded'] });

    await loginAs(page, 'excluded');

    for (const url of [`/event.php?id=${eventId}`, `/rsvp.php?id=${eventId}`, `/ical.php?id=${eventId}`]) {
      await page.goto(url);
      await expectMyBBError(page, /do not have permission/i);
      await expect(page.locator('body')).not.toContainText('Private Troop');
    }

    await loginAs(page, 'trooper1');
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_page')).toContainText('Private Troop');
  });

  test('the announcement thread cannot be opened, listed or replied to', async ({ page }) => {
    const title = announcementTitle('Quiet Troop');
    const eventId = await createEvent({ title, excluded: ['excluded'] });
    const threadId = await announce(eventId);

    await loginAs(page, 'excluded');

    // Every way in: the thread, its printable copy, and the form that replies to it.
    for (const url of [
      `/showthread.php?tid=${threadId}`,
      `/printthread.php?tid=${threadId}`,
      `/newreply.php?tid=${threadId}`,
    ]) {
      await page.goto(url);
      await expect(page.locator('body')).not.toContainText(title);
    }

    // And every way to find it: the forum it was posted into, and the board index, which
    // names each forum's newest thread by subject.
    await openForumListing(page, FORUMS.events);
    await expect(page.locator('body')).not.toContainText(title);

    await page.goto('/index.php');
    await expect(page.locator('body')).not.toContainText(title);

    // Everybody else reads it as they always did.
    await loginAs(page, 'trooper1');
    await page.goto(`/showthread.php?tid=${threadId}`);
    await expect(page.locator('body')).toContainText(title);

    await openForumListing(page, FORUMS.events);
    await expect(page.locator('body')).toContainText(title);
  });

  test('a search does not turn the announcement up', async ({ page }) => {
    const title = announcementTitle('Searchable Troop');
    const eventId = await createEvent({ title, excluded: ['excluded'] });
    await announce(eventId);

    // The suffix rather than a word from the title, so a thread left behind by an earlier
    // attempt cannot answer the search this one is making.
    const keyword = title.split(' ').pop() as string;

    // MyBB throttles repeat searches per member, and a retry would otherwise be turned
    // away rather than answered.
    await execute(`TRUNCATE TABLE ${T('searchlog')}`, []);

    // A search is two requests: the POST files the hits in the search log and answers
    // with MyBB's own "redirecting" page, and the results are rendered from that log
    // afterwards. The filtering happens on the way into the log, so both halves are
    // needed to see what it did. A search that finds nothing is answered by the POST
    // itself, with no log entry to follow.
    const search = async (): Promise<string> => {
      await page.goto('/index.php');
      const postKey = await page.evaluate(() => (window as any).my_post_key);
      const filed = await page.request.post('/search.php', {
        form: {
          action: 'do_search',
          my_post_key: postKey,
          keywords: keyword,
          postthread: 1,
          showresults: 'threads',
        },
      });

      const answer = await filed.text();
      const sid = answer.match(/sid=([a-f0-9]+)/)?.[1];
      if (!sid) {
        return answer;
      }

      const results = await page.request.get(`/search.php?action=results&sid=${sid}`);

      return results.text();
    };

    // The announcement is the search's only hit, so once it is taken out the member must
    // be told nothing matched - the answer they would get if it did not exist. Checking
    // only that the title is absent passed against the SQL error the empty list used to
    // cause, which does not name the thread either.
    await loginAs(page, 'excluded');
    const hidden = await search();
    expect(hidden).not.toContain(title);
    expect(hidden).toContain('no results were returned');

    // The control: the same search does find it for everybody else, so the assertion
    // above is not passing because nothing was searched.
    await loginAs(page, 'trooper1');
    expect(await search()).toContain(title);
  });

  test("View New Posts, Today's Posts and a member's threads do not list it", async ({ page }) => {
    // These three are links rather than searches, and they do not work the way a search
    // does: they file a WHERE clause alongside the hits, and the results page re-runs the
    // clause and never reads the hits. Filtering the hits - which is what keeps the
    // search above clean - left all three listing the announcement, and View New Posts
    // is the busiest link on the board and exactly where a new announcement turns up.
    const title = announcementTitle('Newly Posted Troop');
    const eventId = await createEvent({ title, excluded: ['excluded'] });
    const threadId = await announce(eventId);

    // The results are paged by last post, and the specs before this one leave threads
    // behind with the clock moved forwards. Put this one at the top, so the control
    // below is looking at a page it could be on.
    await execute(
      `UPDATE ${T('threads')} t
         JOIN (SELECT MAX(lastpost) + 1 AS top FROM ${T('threads')}) m
          SET t.lastpost = m.top
        WHERE t.tid = ?`,
      [threadId],
    );

    const author = Number((await getThread(threadId)).uid);
    const links = [
      '/search.php?action=getnew',
      '/search.php?action=getdaily',
      `/search.php?action=finduserthreads&uid=${author}`,
    ];

    // Each link files its search and answers with MyBB's "redirecting" page, and the
    // results are rendered from the log afterwards - which is where the filtering now is.
    const listed = async (): Promise<string[]> => {
      await execute(`TRUNCATE TABLE ${T('searchlog')}`, []);
      const found: string[] = [];
      for (const link of links) {
        const filed = await page.request.get(link, { maxRedirects: 0 });
        const sid = ((filed.headers()['location'] ?? '') + (await filed.text())).match(/sid=([a-f0-9]+)/)?.[1];
        expect(sid, `${link} filed no search`).toBeTruthy();

        const results = await page.request.get(`/search.php?action=results&sid=${sid}`);
        if ((await results.text()).includes(title)) {
          found.push(link);
        }
      }
      return found;
    };

    await loginAs(page, 'excluded');
    expect(await listed()).toEqual([]);

    await loginAs(page, 'trooper1');
    expect(await listed()).toEqual(links);
  });

  test('the announcement stays out of the forum feeds', async ({ page }) => {
    const title = announcementTitle('Feed Troop');
    const eventId = await createEvent({ title, excluded: ['excluded'] });
    await announce(eventId);

    // syndication.php returns the newest 15 threads by dateline unless asked for more,
    // and caps what it will give at 50. By the time this spec runs, the specs before it
    // have announced well over fifteen events into this forum - several with the clock
    // moved forwards, so they outrank a thread announced just now. Left at the default
    // the event falls outside the window, and it is the control that fails: nobody can
    // see it, so the assertion above passes for the wrong reason.
    const feed = async (): Promise<string> => {
      const response = await page.request.get(
        `/syndication.php?fid=${FORUMS.events}&limit=50`,
      );
      return response.text();
    };

    await loginAs(page, 'excluded');
    expect(await feed()).not.toContain(title);

    await loginAs(page, 'trooper1');
    expect(await feed()).toContain(title);
  });

  test('the archive and the ajax endpoints do not leak it either', async ({ page }) => {
    // Two entry points that never load global.php's furniture, and so are hooked
    // separately from everything above: archive.php renders its own stripped-down copy
    // of a thread, and xmlhttp.php is what the quick reply and the thread preview go
    // through. A hook missed on either is a thread an excluded member can still read.
    const title = announcementTitle('Sideways Troop');
    const eventId = await createEvent({ title, excluded: ['excluded'] });
    const threadId = await announce(eventId);

    await loginAs(page, 'excluded');

    const archive = await page.request.get(`/archive/index.php?thread-${threadId}.html`);
    expect(await archive.text()).not.toContain(title);

    // The control, so the assertion is not passing because the archive answered nothing
    // to anybody.
    await loginAs(page, 'trooper1');
    expect(await (await page.request.get(`/archive/index.php?thread-${threadId}.html`)).text()).toContain(title);

    // Quick edit's get_post: the xmlhttp action that names its post with a pid, which is
    // how the hook recognises the thread behind a request. It hands a post's source only
    // to someone who may edit it, so the post has to be the member's own - a reply they
    // wrote before they were excluded - or the endpoint refuses them whatever the hook
    // does and the assertion proves nothing.
    const message = `Bringing the spare helmet ${Math.random().toString(36).slice(2, 8)}`;
    const postId = await reply(threadId, 'excluded', message);

    await loginAs(page, 'excluded');
    await page.goto('/index.php');
    const postKey = await page.evaluate(() => (window as unknown as { my_post_key?: string }).my_post_key);
    expect(postKey, 'the page carries no my_post_key').toMatch(/^[a-f0-9]+$/);
    const getPost = () =>
      page.request.get(`/xmlhttp.php?action=edit_post&do=get_post&pid=${postId}&my_post_key=${postKey}`);

    expect(await (await getPost()).text()).not.toContain(message);

    // The same member and the same request, with the exclusion lifted: the post comes back,
    // so the refusal above was the hook's.
    await execute(`DELETE FROM ${T('event_plugin_event_exclusions')} WHERE event_id = ?`, [eventId]);
    expect(await (await getPost()).text()).toContain(message);
  });

  test('a pid or aid that names something else is not read as a post', async ({ page }) => {
    // polls.php calls a poll's id pid, and announcements.php calls an announcement's id
    // aid. Read as a post and an attachment, those turn away an unrelated poll or
    // announcement whose id matches something in a hidden thread, and let a poll that
    // really is in one through.
    const title = announcementTitle('Crossed Wires Troop');
    const eventId = await createEvent({ title, excluded: ['excluded'] });
    const threadId = await announce(eventId);
    const post = await getThreadFirstPost(threadId);

    const hiddenQuestion = `Hidden poll ${Math.random().toString(36).slice(2, 8)}`;
    const hiddenPollId = await addPoll(threadId, hiddenQuestion);

    // An ordinary thread's poll that shares its id with the announcement's post.
    const otherThreadId = await createThread(announcementTitle('Costume Night'), FORUMS.general, 'trooper1');
    const otherQuestion = `Open poll ${Math.random().toString(36).slice(2, 8)}`;
    await addPoll(otherThreadId, otherQuestion, Number(post.pid));

    // An attachment in the hidden thread, and a board-wide announcement sharing its id.
    const attachment = await execute(
      `INSERT INTO ${T('attachments')} (pid, uid, filename, filetype, filesize, thumbnail, visible, dateuploaded)
       VALUES (?, ?, 'map.jpg', 'image/jpeg', 1, 'map_thumb.jpg', 1, UNIX_TIMESTAMP())`,
      [post.pid, post.uid],
    );
    const announcementSubject = `Garrison notice ${Math.random().toString(36).slice(2, 8)}`;
    await execute(
      `INSERT INTO ${T('announcements')} (aid, fid, uid, subject, message) VALUES (?, -1, ?, ?, 'Read me.')`,
      [attachment.insertId, uid('gec'), announcementSubject],
    );

    await loginAs(page, 'excluded');

    await page.goto(`/polls.php?action=showresults&pid=${hiddenPollId}`);
    await expect(page.locator('body')).not.toContainText(hiddenQuestion);
    await expectMyBBError(page, /do not have permission/i);

    await page.goto(`/polls.php?action=showresults&pid=${post.pid}`);
    await expect(page.locator('body')).toContainText(otherQuestion);

    await page.goto(`/announcements.php?aid=${attachment.insertId}`);
    await expect(page.locator('body')).toContainText(announcementSubject);

    // attachment.php takes a thumbnail's id in place of an aid. The row has no file behind
    // it, so a request the hook waves through fails as an invalid attachment instead.
    await page.goto(`/attachment.php?thumbnail=${attachment.insertId}`);
    await expectMyBBError(page, /do not have permission/i);

    // Everybody else gets the hidden thread's poll.
    await loginAs(page, 'trooper1');
    await page.goto(`/polls.php?action=showresults&pid=${hiddenPollId}`);
    await expect(page.locator('body')).toContainText(hiddenQuestion);
  });

  test('the troop report is still theirs to read', async ({ page }) => {
    const title = announcementTitle('Reported Troop');
    const eventId = await createEvent({
      title,
      start: relativeToTestNow({ days: -2 }),
      end: relativeToTestNow({ days: -1 }),
      signupCutoff: relativeToTestNow({ days: -3 }),
      excluded: ['excluded'],
    });
    const threadId = await announce(eventId);
    await createRsvp(eventId, 'trooper1', { costumes: [TK] });

    // An attendee writes the report, which posts it to the troop report forum as its own
    // thread and closes the event out.
    await loginAs(page, 'trooper1');
    await page.goto(`/troop_report.php?id=${eventId}`);
    await page.locator('#troop_report_submit').click();

    const report = await getTroopReport(eventId);
    const reportThreadId = Number(report?.thread_id);
    expect(reportThreadId).toBeGreaterThan(0);

    await loginAs(page, 'excluded');

    await page.goto(`/showthread.php?tid=${reportThreadId}`);
    await expect(page.locator('body')).toContainText(`Troop Report: ${title}`);

    await openForumListing(page, FORUMS.troop_reports);
    await expect(page.locator('body')).toContainText(`Troop Report: ${title}`);

    // The event's own thread is still not, archived event or no - and writing the report
    // was never theirs to do.
    await page.goto(`/showthread.php?tid=${threadId}`);
    await expectMyBBError(page, /do not have permission/i);

    await page.goto(`/troop_report.php?id=${eventId}`);
    await expectMyBBError(page, /do not have permission/i);
  });

  test('a coordinator is not hidden from an event they have been excluded from', async ({ page }) => {
    // The exclusion still closes signups - see signup-locking.spec.ts - but an event
    // nobody can open is an event nobody can put right.
    const eventId = await createEvent({ title: 'Coordinated Troop', excluded: ['gec'] });

    await loginAs(page, 'gec');

    await page.goto('/events.php?view=list');
    await expect(page.locator(`[data-event-id="${eventId}"]`)).toBeVisible();

    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('#event_page')).toContainText('Coordinated Troop');

    await page.goto(`/manage_event.php?id=${eventId}`);
    await expect(page.locator('#event_form_title')).toHaveValue('Coordinated Troop');
  });

  test("the archive's forum listing does not name it", async ({ page }) => {
    // The archive's thread page is gated with everything else, but its forum page is a
    // listing of its own, printed line by line with no hook that can drop a line.
    const title = announcementTitle('Archive Listed Troop');
    const eventId = await createEvent({ title, excluded: ['excluded'] });
    await announce(eventId);

    const listing = async (): Promise<string> =>
      (await page.request.get(`/archive/index.php?forum-${FORUMS.events}.html`)).text();

    await loginAs(page, 'excluded');
    const hidden = await listing();
    expect(hidden).toContain('class="listing"');
    expect(hidden).not.toContain(title);

    await loginAs(page, 'trooper1');
    expect(await listing()).toContain(title);
  });

  test("Who's Online and a profile do not say which thread someone is reading", async ({ page }) => {
    const title = announcementTitle('Watched Troop');
    const eventId = await createEvent({ title, excluded: ['excluded'] });
    const threadId = await announce(eventId);

    // Every session is stamped with the same instant when the clock is reset, so a
    // member's older sessions would tie with the one this makes. Only this one is left.
    await execute(`DELETE FROM ${T('sessions')} WHERE uid = ?`, [uid('trooper2')]);
    await loginAs(page, 'trooper2');
    await page.goto(`/showthread.php?tid=${threadId}`);
    await expect(page.locator('body')).toContainText(title);

    const surfaces = [
      { url: '/online.php', proof: 'trooper2' },
      { url: `/member.php?action=profile&uid=${uid('trooper2')}`, proof: 'Reading Thread' },
    ];

    await loginAs(page, 'excluded');
    for (const { url, proof } of surfaces) {
      await page.goto(url);
      await expect(page.locator('body'), url).toContainText(proof);
      await expect(page.locator('body'), url).not.toContainText(title);
    }

    await loginAs(page, 'trooper1');
    for (const { url } of surfaces) {
      await page.goto(url);
      await expect(page.locator('body'), url).toContainText(title);
    }
  });

  test('a thread subscription is dropped by the exclusion that hides the thread', async ({ page }) => {
    // Subscribed before they were excluded: their User CP would go on listing the thread,
    // every reply would mail them its subject and an excerpt, and the unsubscribe link -
    // which names the thread - is refused by the gate, so they could never stop it.
    const title = announcementTitle('Subscribed Troop');
    const eventId = await createEvent({ title });
    const threadId = await announce(eventId);

    for (const username of ['excluded', 'trooper1'] as const) {
      await execute(
        `INSERT INTO ${T('threadsubscriptions')} (uid, tid, notification, dateline) VALUES (?, ?, 1, UNIX_TIMESTAMP())`,
        [uid(username), threadId],
      );
    }

    // Excluded the way both event forms do it.
    await runPhp(`
require_once MYBB_ROOT.'inc/plugins/events/inc/events_form.php';
$input = events_event_form_values(events_get_event(${eventId}));
$input['exclusions'] = 'excluded';
events_save_event(${eventId}, $input, ${uid('gec')});
`);

    const subscriptions = async (): Promise<string> => {
      await page.goto('/usercp.php?action=subscriptions');
      return (await page.locator('body').textContent()) ?? '';
    };

    await loginAs(page, 'excluded');
    expect(await subscriptions()).not.toContain(title);

    await loginAs(page, 'trooper1');
    expect(await subscriptions()).toContain(title);

    // MyBB only notifies a subscriber who has been active since the thread's last post.
    await execute(`UPDATE ${T('threads')} SET lastpost = lastpost - 3600 WHERE tid = ?`, [threadId]);
    await reply(threadId, 'trooper2', 'Count me in for the second shift.');

    const recipients = await mailedAbout(title);
    expect(recipients).toContain(await email('trooper1'));
    expect(recipients).not.toContain(await email('excluded'));
  });

  test("a forum subscription's new-thread notice is not sent to them", async () => {
    // Announcing the event is a new thread in the forum, and MyBB mails its subject and an
    // excerpt of the post to everybody subscribed to that forum.
    for (const username of ['excluded', 'trooper1'] as const) {
      await execute(`INSERT INTO ${T('forumsubscriptions')} (fid, uid) VALUES (?, ?)`, [FORUMS.events, uid(username)]);
    }
    // And only to a subscriber who has been active since the forum's last post - as the
    // forum cache has it, which is what the notice reads, not the forums table.
    await execute(`UPDATE ${T('forums')} SET lastpost = 0 WHERE fid = ?`, [FORUMS.events]);
    await runPhp(`$cache->update_forums();`);

    const title = announcementTitle('Notified Troop');
    const eventId = await createEvent({ title, excluded: ['excluded'] });
    await announce(eventId);

    const recipients = await mailedAbout(title);
    expect(recipients).toContain(await email('trooper1'));
    expect(recipients).not.toContain(await email('excluded'));
  });

  test("a moderator's move leaves no redirect naming it", async ({ page }) => {
    // MyBB's default move leaves a "Moved:" stub in the old forum: a thread of its own,
    // with its own tid and the announcement's subject.
    const title = announcementTitle('Relocated Troop');
    const eventId = await createEvent({ title, excluded: ['excluded'] });
    const threadId = await announce(eventId);

    await runPhp(`
require_once MYBB_ROOT.'inc/class_moderation.php';
$moderation = new Moderation;
$moderation->move_thread(${threadId}, ${FORUMS.general}, 'redirect');
`);

    await loginAs(page, 'excluded');
    await openForumListing(page, FORUMS.events);
    await expect(page.locator('body')).not.toContainText(title);

    await loginAs(page, 'trooper1');
    await openForumListing(page, FORUMS.events);
    await expect(page.locator('body')).toContainText(title);
  });

  test('an announcement cannot be copied', async ({ page }) => {
    // A copy is a whole readable thread under a tid nothing knows is the event's.
    const title = announcementTitle('Duplicated Troop');
    const eventId = await createEvent({ title, excluded: ['excluded'] });
    const threadId = await announce(eventId);

    const ordinary = announcementTitle('Costume Swap');
    const ordinaryId = await createThread(ordinary, FORUMS.general, 'trooper1');
    await reply(ordinaryId, 'trooper1', 'Anyone got a spare TK chest plate?');

    await loginAs(page, 'admin');
    await page.goto('/index.php');
    const postKey = await page.evaluate(() => (window as unknown as { my_post_key?: string }).my_post_key);

    const copy = async (tid: number): Promise<string> =>
      (
        await page.request.post('/moderation.php', {
          form: { action: 'do_move', tid, moveto: FORUMS.general, method: 'copy', my_post_key: postKey ?? '' },
        })
      ).text();

    const copies = async (subject: string): Promise<number> =>
      Number((await queryOne(`SELECT COUNT(*) AS n FROM ${T('threads')} WHERE subject = ?`, [subject]))?.n);

    expect(await copy(threadId)).toContain('cannot be copied');
    expect(await copies(title)).toBe(1);

    // The control: the same request copies an ordinary thread.
    await copy(ordinaryId);
    expect(await copies(ordinary)).toBe(2);
  });

  test("the board statistics' top threads leave it out", async ({ page }) => {
    const title = announcementTitle('Popular Troop');
    const eventId = await createEvent({ title, excluded: ['excluded'] });
    const threadId = await announce(eventId);

    // To the top of both lists, and the lists rebuilt the way the board builds them.
    await execute(`UPDATE ${T('threads')} SET replies = 99999, views = 999999 WHERE tid = ?`, [threadId]);
    await runPhp(`
$cache->update_most_replied_threads();
$cache->update_most_viewed_threads();
`);

    await loginAs(page, 'excluded');
    await page.goto('/stats.php');
    await expect(page.locator('body')).not.toContainText(title);

    await loginAs(page, 'trooper1');
    await page.goto('/stats.php');
    await expect(page.locator('body')).toContainText(title);
  });

  test('a rating for the announcement does not name its thread', async ({ page }) => {
    const title = announcementTitle('Rated Troop');
    const eventId = await createEvent({ title, excluded: ['excluded'] });
    const threadId = await announce(eventId);
    const post = await getThreadFirstPost(threadId);

    const comment = `Great announcement ${Math.random().toString(36).slice(2, 8)}`;
    await execute(
      `INSERT INTO ${T('reputation')} (uid, adduid, pid, reputation, dateline, comments) VALUES (?, ?, ?, 1, UNIX_TIMESTAMP(), ?)`,
      [post.uid, uid('trooper1'), post.pid, comment],
    );

    const url = `/reputation.php?uid=${post.uid}`;

    await loginAs(page, 'excluded');
    await page.goto(url);
    await expect(page.locator('body')).toContainText(comment);
    await expect(page.locator('body')).not.toContainText(title);

    await loginAs(page, 'trooper1');
    await page.goto(url);
    await expect(page.locator('body')).toContainText(title);
  });

  test('a post, its report form, its who-posted list and its send-to-a-friend page refuse', async ({ page }) => {
    // Four pages that name the thread without being showthread.php, each by a different
    // input: the single-post view and the report form by the post's pid, who-posted and
    // send-to-a-friend by the tid. MyBB 1.8 has no showpost.php - a post is shown alone
    // by showthread.php?pid=, which is what a "#pid" permalink opens. Who-posted and
    // send-to-a-friend both put the subject in the page's <title>, and the report form
    // hands back a form keyed to the post, so none of them is harmless to let through.
    const title = announcementTitle('Singled Out Troop');
    const eventId = await createEvent({ title, excluded: ['excluded'] });
    const threadId = await announce(eventId);
    const post = await getThreadFirstPost(threadId);

    // Each with what the page shows a member it does not refuse, so the control below is
    // checking that the page did its job and not merely that it rendered something.
    const pages = [
      { url: `/showthread.php?pid=${post.pid}`, proof: title },
      { url: `/report.php?type=post&pid=${post.pid}`, proof: `name="pid" value="${post.pid}"` },
      { url: `/misc.php?action=whoposted&tid=${threadId}`, proof: title },
      { url: `/sendthread.php?tid=${threadId}`, proof: title },
    ];

    // The refusal has to be the no-permission page, not just a page without the title: an
    // invalid-thread error, or a report form that failed for its own reasons, would pass
    // "does not name it" without the hook having done anything.
    await loginAs(page, 'excluded');
    for (const { url } of pages) {
      await page.goto(url);
      await expectMyBBError(page, NO_PERMISSION);
      expect(await page.content(), url).not.toContain(title);
    }

    // The same pages for a member the event is not hidden from.
    await loginAs(page, 'trooper1');
    for (const { url, proof } of pages) {
      await page.goto(url);
      expect(await page.content(), url).toContain(proof);
      await expect(page.locator('body'), url).not.toContainText(NO_PERMISSION);
    }
  });

  test('an attachment in the announcement is not served, by aid or by pid', async ({ page }) => {
    // attachment.php looks an attachment up by its aid, or - given only a pid - by the post
    // it belongs to, and the gate has to follow either back to the thread. The row needs a
    // real file behind it: MyBB answers "invalid attachment" for a row with none, which
    // would make the control fail and could make a waved-through request look refused.
    const title = announcementTitle('Attached Troop');
    const eventId = await createEvent({ title, excluded: ['excluded'] });
    const threadId = await announce(eventId);
    const post = await getThreadFirstPost(threadId);

    const suffix = Math.random().toString(36).slice(2, 8);
    const attachname = `e2e_exclusions_${suffix}.attach`;
    const contents = `Muster at the loading dock ${suffix}`;

    // .txt is one of MyBB's stock attachment types; an extension it does not know is
    // refused as invalid before any permission is looked at.
    await runPhp(`file_put_contents(MYBB_ROOT.'uploads/${attachname}', ${JSON.stringify(contents)});`);
    try {
      const attachment = await execute(
        `INSERT INTO ${T('attachments')} (pid, posthash, uid, filename, filetype, filesize, attachname, downloads, dateuploaded, visible, thumbnail)
         VALUES (?, '', ?, 'orders.txt', 'text/plain', ?, ?, 0, UNIX_TIMESTAMP(), 1, '')`,
        [post.pid, post.uid, contents.length, attachname],
      );

      // A visible thread's tid alongside: attachment.php never reads tid, so it must not
      // vouch for the attachment.
      const visibleThreadId = await createThread(announcementTitle('Open Thread'), FORUMS.events, 'trooper1');
      const urls = [
        `/attachment.php?aid=${attachment.insertId}`,
        `/attachment.php?pid=${post.pid}`,
        `/attachment.php?aid=${attachment.insertId}&tid=${visibleThreadId}`,
      ];
      const fetch = async (url: string): Promise<string> => (await page.request.get(url)).text();

      // page.request rather than a navigation: served, the file is a download, which a
      // goto() reports as an error rather than as a page.
      await loginAs(page, 'excluded');
      for (const url of urls) {
        const body = await fetch(url);
        expect(body, url).toMatch(NO_PERMISSION);
        expect(body, url).not.toContain(contents);
      }

      await loginAs(page, 'trooper1');
      for (const url of urls) {
        expect(await fetch(url), url).toBe(contents);
      }
    } finally {
      // The attachments table is put back before every test; the file is not.
      await runPhp(`@unlink(MYBB_ROOT.'uploads/${attachname}');`);
    }
  });

  test('the announcement cannot be rated', async ({ page }) => {
    // ratethread.php is a POST that names its thread by tid, and a successful one both
    // writes a rating and redirects to the thread. The gate runs before MyBB's own post
    // key check, so the key is sent properly: a refusal for want of one would not be the
    // hook's.
    const title = announcementTitle('Rated Thread Troop');
    const eventId = await createEvent({ title, excluded: ['excluded'] });
    const threadId = await announce(eventId);

    const rate = async (): Promise<string> => {
      const postKey = await postKeyFor(page);
      const response = await page.request.post('/ratethread.php', {
        form: { tid: threadId, rating: 5, my_post_key: postKey },
        maxRedirects: 0,
      });
      return response.text();
    };
    const ratedBy = async (username: string): Promise<number> =>
      Number(
        (await queryOne(`SELECT COUNT(*) AS n FROM ${T('threadratings')} WHERE tid = ? AND uid = ?`, [threadId, uid(username)]))
          ?.n,
      );

    await loginAs(page, 'excluded');
    const refused = await rate();
    expect(refused).toMatch(NO_PERMISSION);
    expect(refused).not.toContain(title);
    expect(await ratedBy('excluded')).toBe(0);

    // The control: the same POST rates the thread for a member it is not hidden from.
    await loginAs(page, 'trooper1');
    const accepted = await rate();
    expect(accepted).not.toMatch(NO_PERMISSION);
    expect(await ratedBy('trooper1')).toBe(1);
  });

  test("a moderator excluded from the event cannot moderate its thread", async ({ page }) => {
    // Administrators and general coordinators are never hidden from an event (see
    // events_hidden_event_ids()), so the member has to be an ordinary member who is a
    // forum moderator of the announcements forum - a garrison's forum moderators need not
    // be coordinators. Without moderator rights the moderation pages refuse anybody with
    // the same no-permission page the hook uses, and the refusal would prove nothing.
    const title = announcementTitle('Moderated Troop');
    const eventId = await createEvent({ title, excluded: ['excluded'] });
    const threadId = await announce(eventId);

    // `moderators` is board configuration, not content, so restoreBoardContent() does not
    // put it back; the row comes out in the finally below. is_moderator() reads the
    // moderators cache, not the table, so the cache is rebuilt both ways.
    const moderator = await execute(
      `INSERT INTO ${T('moderators')} (fid, id, isgroup, canopenclosethreads, canmanagethreads)
       VALUES (?, ?, 0, 1, 1)`,
      [FORUMS.events, uid('excluded')],
    );
    await runPhp(`$cache->update_moderators();`);

    try {
      await loginAs(page, 'excluded');

      // moderation.php refuses a GET for almost every action - MyBB's own check, and one
      // that answers with the same no-permission page as the hook - so both requests are
      // POSTs, the way the thread tools send them.
      const moderate = async (form: Record<string, string | number>): Promise<string> => {
        const postKey = await postKeyFor(page);
        const response = await page.request.post('/moderation.php', {
          form: { tid: threadId, ...form, my_post_key: postKey },
          maxRedirects: 0,
        });
        return response.text();
      };

      // The move form, which names the thread by tid and puts its subject in the breadcrumb.
      const moveForm = () => moderate({ action: 'move' });

      // Closing it, which changes the thread, so the check is on the thread rather than on
      // what the page said.
      const openClose = () => moderate({ action: 'openclosethread' });
      const closed = async (): Promise<string> => String((await getThread(threadId)).closed);

      const form = await moveForm();
      expect(form).toMatch(NO_PERMISSION);
      expect(form).not.toContain(title);

      // moderation.php swaps the tid for the thread of the pid it is given, so a visible
      // thread's tid next to the announcement's first post must not get the form either.
      const visibleThreadId = await createThread(announcementTitle('Open Thread'), FORUMS.events, 'trooper1');
      const firstPost = await getThreadFirstPost(threadId);
      const moveByPost = () => moderate({ action: 'move', tid: visibleThreadId, pid: Number(firstPost.pid) });
      const byPost = await moveByPost();
      expect(byPost).toMatch(NO_PERMISSION);
      expect(byPost).not.toContain(title);

      expect(await openClose()).toMatch(NO_PERMISSION);
      expect(await closed()).not.toBe('1');

      // The same moderator and the same requests with the exclusion lifted: the move form
      // comes back and the thread closes, so the refusals above were the hook's and not
      // MyBB's moderator checks.
      await liftExclusions(eventId);

      const allowed = await moveForm();
      expect(allowed).toContain('name="moveto"');
      expect(allowed).toContain(title);
      expect(await moveByPost()).toContain(title);

      expect(await openClose()).not.toMatch(NO_PERMISSION);
      expect(await closed()).toBe('1');
    } finally {
      await execute(`DELETE FROM ${T('moderators')} WHERE mid = ?`, [moderator.insertId]);
      await runPhp(`$cache->update_moderators();`);
    }
  });

  test("a visible thread's tid does not vouch for a hidden poll or a quoted post", async ({ page }) => {
    // Pages do not agree on which reference they believe. polls.php finds its thread from
    // the poll, and newreply.php quotes its replyto post whatever thread the tid names, so
    // a tid the member may read sent alongside must not let either through.
    const title = announcementTitle('Two Ids Troop');
    const eventId = await createEvent({ title, excluded: ['excluded'] });
    const threadId = await announce(eventId);
    const secret = `Meet behind the stage ${Math.random().toString(36).slice(2, 8)}`;
    const hiddenPostId = await reply(threadId, 'trooper1', secret);
    const question = `Hidden poll ${Math.random().toString(36).slice(2, 8)}`;
    const pollId = await addPoll(threadId, question);

    const visibleThreadId = await postThread(announcementTitle('Open Thread'), FORUMS.events, 'trooper1');

    const pages = [
      { url: `/polls.php?action=showresults&pid=${pollId}&tid=${visibleThreadId}`, proof: question },
      { url: `/newreply.php?tid=${visibleThreadId}&replyto=${hiddenPostId}&load_all_quotes=1`, proof: secret },
    ];

    await loginAs(page, 'excluded');
    for (const { url } of pages) {
      await page.goto(url);
      await expectMyBBError(page, NO_PERMISSION);
      const html = await page.content();
      expect(html, url).not.toContain(question);
      expect(html, url).not.toContain(secret);
      expect(html, url).not.toContain(title);
    }

    await loginAs(page, 'trooper1');
    for (const { url, proof } of pages) {
      await page.goto(url);
      expect(await page.content(), url).toContain(proof);
    }
  });

  test('the multiquote cookie does not quote a hidden post', async ({ page }) => {
    // newthread.php, newreply.php and xmlhttp.php's get_multiquoted quote every post the
    // multiquote cookie lists in full, whatever thread it is in. The hidden post is taken
    // out of the list; the ordinary post quoted with it is not.
    const title = announcementTitle('Quoted Troop');
    const eventId = await createEvent({ title, excluded: ['excluded'] });
    const threadId = await announce(eventId);
    const secret = `Keys are under the mat ${Math.random().toString(36).slice(2, 8)}`;
    const hiddenPostId = await reply(threadId, 'trooper1', secret);

    const visibleThreadId = await postThread(announcementTitle('Open Thread'), FORUMS.events, 'trooper1');
    const ordinary = `Ordinary quote ${Math.random().toString(36).slice(2, 8)}`;
    const visiblePostId = await reply(visibleThreadId, 'trooper1', ordinary);

    const prefix = await getSetting('cookieprefix');
    const quoteBoth = async (): Promise<void> => {
      await page.context().addCookies([
        { name: `${prefix}multiquote`, value: `${hiddenPostId}|${visiblePostId}`, url: new URL(page.url()).origin },
      ]);
    };

    const urls = [
      `/newthread.php?fid=${FORUMS.general}&load_all_quotes=1`,
      `/newreply.php?tid=${visibleThreadId}&load_all_quotes=1`,
      `/xmlhttp.php?action=get_multiquoted&load_all=1`,
    ];

    await loginAs(page, 'excluded');
    await page.goto('/index.php');
    await quoteBoth();
    for (const url of urls) {
      const body = await (await page.request.get(url)).text();
      expect(body, url).toContain(ordinary);
      expect(body, url).not.toContain(secret);
    }

    await loginAs(page, 'trooper1');
    await page.goto('/index.php');
    await quoteBoth();
    for (const url of urls) {
      const body = await (await page.request.get(url)).text();
      expect(body, url).toContain(ordinary);
      expect(body, url).toContain(secret);
    }
  });

  test('the Forum Subscriptions page does not name it as the newest thread', async ({ page }) => {
    // usercp.php?action=forumsubscriptions names each subscribed forum's newest thread the
    // way the board index does, but builds its rows without build_forumbits(). The title
    // is kept under the page's 25-character cut so the whole subject would show.
    const title = announcementTitle('Subbed Troop');
    const eventId = await createEvent({ title, excluded: ['excluded'] });
    const threadId = await announce(eventId);

    const forum = await queryOne(`SELECT lastposttid FROM ${T('forums')} WHERE fid = ?`, [FORUMS.events]);
    expect(Number(forum?.lastposttid), 'the announcement is not the forum\'s newest thread').toBe(threadId);

    for (const username of ['excluded', 'trooper1']) {
      await execute(`INSERT INTO ${T('forumsubscriptions')} (fid, uid) VALUES (?, ?)`, [FORUMS.events, uid(username)]);
    }

    await loginAs(page, 'excluded');
    await page.goto('/usercp.php?action=forumsubscriptions');
    expect(await page.content()).not.toContain(title);
    expect(await page.content()).not.toContain(`tid=${threadId}&`);

    await loginAs(page, 'trooper1');
    await page.goto('/usercp.php?action=forumsubscriptions');
    await expect(page.locator('body')).toContainText(title);
  });

  test('Similar Threads leaves it out', async ({ page }) => {
    // The board ships with it off, but a board that turns it on lists other threads in the
    // same forum by subject, below any thread. A similarity rating of 0 matches every
    // thread in the forum, so the test does not depend on MySQL's full-text relevance.
    // The garrison's theme leaves {$similarthreads} out of its showthread template, so
    // both members read the thread in MyBB's Default theme (tid 2), which keeps it.
    const restore = await withSettings({ showsimilarthreads: '1', similarityrating: '0', similarlimit: '20' });
    const members = [uid('excluded'), uid('trooper1')];
    const styles = await query(`SELECT uid, style FROM ${T('users')} WHERE uid IN (?, ?)`, members);
    await execute(`UPDATE ${T('users')} SET style = 2 WHERE uid IN (?, ?)`, members);
    try {
      const title = announcementTitle('Lookalike Troop');
      const eventId = await createEvent({ title, excluded: ['excluded'] });
      await announce(eventId);

      const neighbour = announcementTitle('Lookalike Neighbour');
      await postThread(neighbour, FORUMS.events, 'trooper1');
      const visibleThreadId = await postThread(announcementTitle('Lookalike Open'), FORUMS.events, 'trooper1');

      await loginAs(page, 'excluded');
      await page.goto(`/showthread.php?tid=${visibleThreadId}`);
      await expect(page.locator('body')).toContainText(neighbour);
      expect(await page.content()).not.toContain(title);

      await loginAs(page, 'trooper1');
      await page.goto(`/showthread.php?tid=${visibleThreadId}`);
      await expect(page.locator('body')).toContainText(title);
    } finally {
      for (const row of styles) {
        await execute(`UPDATE ${T('users')} SET style = ? WHERE uid = ?`, [row.style, row.uid]);
      }
      await restore();
    }
  });
});

test.describe('excluding a member from an event already under way', () => {
  test('withdraws their signup, gives the place to the waitlist, and closes the thread and the feed to them', async ({
    page,
  }) => {
    // The exclusion tests above all start from an event the member was excluded from
    // before anything happened. The harder case is the one a coordinator actually meets:
    // the event is announced, the member has signed up, subscribed and replied, and only
    // then is excluded. events_save_event() says what that does - their signup is withdrawn
    // for them as if they had withdrawn it, silently, since a PM about the event would
    // tell them what the exclusion hides; the place it held goes to the head of the
    // waitlist, who is PMed; and their subscription to the announcement is dropped.
    const title = announcementTitle('Already Rolling Troop');
    const eventId = await createEvent({ title, maxTroopers: 2 });

    // Two places: the excluded member and trooper1 hold them, trooper2 is next in line.
    await createRsvp(eventId, 'excluded', { at: relativeToTestNow({ hours: -3 }) });
    await createRsvp(eventId, 'trooper1', { at: relativeToTestNow({ hours: -2 }) });
    await createRsvp(eventId, 'trooper2', { at: relativeToTestNow({ hours: -1 }), status: 'waitlisted' });

    const threadId = await announce(eventId);
    for (const username of ['excluded', 'trooper1'] as const) {
      await execute(
        `INSERT INTO ${T('threadsubscriptions')} (uid, tid, notification, dateline) VALUES (?, ?, 1, UNIX_TIMESTAMP())`,
        [uid(username), threadId],
      );
    }
    const replyId = await reply(threadId, 'excluded', `I can bring the banner ${Math.random().toString(36).slice(2, 8)}`);

    // Calendar subscriptions for both, made the way calendar_feed.php makes them. The feed
    // lists the events a member is going to, so it is the listing the withdrawn signup
    // would otherwise keep the event in.
    const tokens = JSON.parse(
      await runPhp(`
require_once MYBB_ROOT.'inc/plugins/events/inc/events_feed.php';
echo json_encode(array(
    'excluded' => events_feed_create_token(${uid('excluded')}),
    'trooper1' => events_feed_create_token(${uid('trooper1')}),
));
`),
    ) as Record<'excluded' | 'trooper1', string>;
    const feed = async (username: 'excluded' | 'trooper1'): Promise<string> =>
      (await page.request.get(`/ical_feed.php?token=${tokens[username]}`)).text();

    // Before: the member reads the thread and has the event in their calendar - so what
    // changes below is the exclusion's doing, not a thread or feed that never worked.
    await loginAs(page, 'excluded');
    await page.goto(`/showthread.php?tid=${threadId}`);
    await expect(page.locator('body')).toContainText(title);
    expect(await feed('excluded')).toContain(title);

    // Excluded the way both event forms do it, by gec, the event's coordinator.
    const saved = JSON.parse(
      await runPhp(`
${LOAD_MESSAGES}
require_once MYBB_ROOT.'inc/plugins/events/inc/events_form.php';
$input = events_event_form_values(events_get_event(${eventId}));
$input['exclusions'] = 'excluded';
$thread_error = null;
$cancelled = $withdrawn = $promoted = $demoted = 0;
events_save_event(${eventId}, $input, ${uid('gec')}, $thread_error, $cancelled, $withdrawn, $promoted, $demoted);
echo json_encode(compact('cancelled', 'withdrawn', 'promoted', 'demoted'));
`),
    );
    expect(saved).toEqual({ cancelled: 0, withdrawn: 1, promoted: 1, demoted: 0 });

    // Their signup is gone, not left standing: a signup they can no longer see or withdraw
    // would go on holding a place, counting toward the maximum and putting their name on
    // the attendance sheet for an event they have been told nothing about.
    const theirRows = await query(`SELECT id FROM ${T('event_plugin_rsvps')} WHERE event_id = ? AND user_id = ?`, [
      eventId,
      uid('excluded'),
    ]);
    expect(theirRows).toHaveLength(0);

    // The place it held goes to the head of the waitlist, and the one who already had a
    // place keeps it.
    expect(await getRsvpStatus(eventId, 'trooper1')).toBe('attending');
    expect(await getRsvpStatus(eventId, 'trooper2')).toBe('attending');
    expect(await countPrivateMessages('trooper2', `You have a place: ${title}`)).toBe(1);
    expect(await countPrivateMessages('trooper1', `%${title}%`)).toBe(0);

    // And nothing reaches the member it was withdrawn for.
    expect(await countPrivateMessages('excluded', `%${title}%`)).toBe(0);

    // Their subscription to the announcement is dropped; trooper1's is not.
    const subscribed = async (username: string): Promise<number> =>
      Number(
        (
          await queryOne(`SELECT COUNT(*) AS n FROM ${T('threadsubscriptions')} WHERE tid = ? AND uid = ?`, [
            threadId,
            uid(username),
          ])
        )?.n,
      );
    expect(await subscribed('excluded')).toBe(0);
    expect(await subscribed('trooper1')).toBe(1);

    // The thread is closed to them now, including their own reply by its pid, and the
    // event is gone from the listing, its page and their calendar.
    await loginAs(page, 'excluded');
    for (const url of [`/showthread.php?tid=${threadId}`, `/showthread.php?pid=${replyId}`, `/event.php?id=${eventId}`]) {
      await page.goto(url);
      await expectMyBBError(page, NO_PERMISSION);
      await expect(page.locator('body'), url).not.toContainText(title);
    }

    await page.goto('/events.php?view=list');
    await expect(page.locator(`[data-event-id="${eventId}"]`)).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(title);

    expect(await feed('excluded')).not.toContain(title);

    // Everybody else's view: the event, its thread and trooper1's calendar as they were,
    // with trooper2 on the attendee list and the excluded member off it.
    await loginAs(page, 'trooper1');
    expect(await feed('trooper1')).toContain(title);

    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator('body')).toContainText(title);
    await expect(page.locator(`.rsvp_row[data-uid="${uid('trooper1')}"]`)).toHaveCount(1);
    await expect(page.locator(`.rsvp_row[data-uid="${uid('trooper2')}"]`)).toHaveCount(1);
    await expect(page.locator(`.rsvp_row[data-uid="${uid('excluded')}"]`)).toHaveCount(0);
    await expect(page.locator(`.waitlist_row[data-uid="${uid('trooper2')}"]`)).toHaveCount(0);
  });
});
