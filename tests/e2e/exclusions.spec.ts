import { test, expect, expectMyBBError } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import { relativeToTestNow } from '../helpers/clock';
import { runPhp } from '../helpers/container';
import { createEvent, createRsvp, execute, fixtures, getThread, getThreadFirstPost, getTroopReport, T } from '../helpers/db';

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
 * Threads outlive a test - resetPluginData() only truncates what the plugin owns - so a
 * retry would otherwise assert "this subject appears nowhere" against the announcement
 * its own first attempt posted. A suffix keeps each attempt's thread its own.
 */
const announcementTitle = (base: string) => `${base} ${Math.random().toString(36).slice(2, 8)}`;

/** Announce an event the way saving it live does, and return its thread id. */
async function announce(eventId: number): Promise<number> {
  const output = await runPhp(`
require_once MYBB_ROOT.'inc/plugins/events/inc/events_thread.php';
echo events_sync_event_thread(${eventId});
`);

  const threadId = Number(output.trim());
  expect(threadId).toBeGreaterThan(0);

  return threadId;
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
    await page.goto(`/forumdisplay.php?fid=${FORUMS.events}`);
    await expect(page.locator('body')).not.toContainText(title);

    await page.goto('/index.php');
    await expect(page.locator('body')).not.toContainText(title);

    // Everybody else reads it as they always did.
    await loginAs(page, 'trooper1');
    await page.goto(`/showthread.php?tid=${threadId}`);
    await expect(page.locator('body')).toContainText(title);

    await page.goto(`/forumdisplay.php?fid=${FORUMS.events}`);
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

    // edit_post rather than a quote endpoint: it is the xmlhttp action that names its
    // post with a pid, which is how the hook recognises the thread behind a request.
    const post = await getThreadFirstPost(threadId);
    const inline = await page.request.get(`/xmlhttp.php?action=edit_post&pid=${post.pid}`);
    expect(await inline.text()).not.toContain(title);

    // The control, so neither assertion is passing because the endpoint answered nothing
    // to anybody.
    await loginAs(page, 'trooper1');
    expect(await (await page.request.get(`/archive/index.php?thread-${threadId}.html`)).text()).toContain(title);
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

    await page.goto(`/forumdisplay.php?fid=${FORUMS.troop_reports}`);
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
});
