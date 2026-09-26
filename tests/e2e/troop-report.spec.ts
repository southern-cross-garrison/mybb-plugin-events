import { test, expect } from "../helpers/fixtures";
import { loginAs, logout } from "../helpers/auth";
import { runPhp } from "../helpers/container";
import { relativeToTestNow, setClock } from "../helpers/clock";
import { withSettings } from "../helpers/settings";
// The report box is MyBB's BBCode editor, which hides the textarea it binds to - so
// typing into it goes through the same helper the event description uses.
import { expectEditorAttached, fillDescription } from "../helpers/editor";
import { submitFormAtOnce } from "../helpers/double-submit";
import {
  createEvent,
  createRsvp,
  createThread,
  countPostsInThread,
  findThreadBySubject,
  getEvent,
  getThreadFirstPost,
  getTroopReport,
  setUserField,
  fixtures,
  query,
  T,
  uid,
} from "../helpers/db";

const [TK, TD] = [0, 1].map((index) => fixtures().costumeOptions[index]);

/** An event that finished yesterday, with the clock already past its end date. */
async function finishedEvent(
  title: string,
  options: { threadId?: number } = {},
) {
  const eventId = await createEvent({
    title,
    start: relativeToTestNow({ days: -2 }),
    end: relativeToTestNow({ days: -1 }),
    signupCutoff: relativeToTestNow({ days: -3 }),
    threadId: options.threadId ?? null,
  });
  return eventId;
}

test.describe("troop reports", () => {
  test("cannot be started before the event has finished", async ({ page }) => {
    const eventId = await createEvent({
      title: "Future Troop",
      start: relativeToTestNow({ days: 3 }),
      end: relativeToTestNow({ days: 3, hours: 6 }),
    });
    await createRsvp(eventId, "trooper1", { costumes: [TK] });

    await loginAs(page, "trooper1");
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator("#event_troop_report")).toHaveCount(0);

    await page.goto(`/troop_report.php?id=${eventId}`);
    await expect(page.locator("body")).toContainText(
      "This event has not ended yet",
    );
  });

  test("become available to attendees once the clock passes the end date", async ({
    page,
  }) => {
    const eventId = await createEvent({
      title: "Just Finished Troop",
      start: relativeToTestNow({ days: 1 }),
      end: relativeToTestNow({ days: 1, hours: 6 }),
    });
    await createRsvp(eventId, "trooper1", { costumes: [TK] });

    await loginAs(page, "trooper1");
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator("#event_troop_report")).toHaveCount(0);

    await setClock(relativeToTestNow({ days: 1, hours: 7 }));

    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator("#event_troop_report")).toBeVisible();
  });

  test("are only offered to members who attended", async ({ page }) => {
    const eventId = await finishedEvent("Attendees Only Troop");
    await createRsvp(eventId, "trooper1", { costumes: [TK] });

    await loginAs(page, "trooper2");
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator("#event_troop_report")).toHaveCount(0);

    await page.goto(`/troop_report.php?id=${eventId}`);
    await expect(page.locator("body")).toContainText(
      "You must have attended this event",
    );
  });

  test("draft segments attendees by club membership and lists their costumes", async ({
    page,
  }) => {
    const eventId = await finishedEvent("Segmented Troop");
    // trooper1 is a Garrison member, trooper2 is in the 501st group, newbie is neither.
    await createRsvp(eventId, "trooper1", { costumes: [TK] });
    await createRsvp(eventId, "trooper2", { costumes: [TD] });
    await createRsvp(eventId, "newbie", { costumes: [TK] });

    await loginAs(page, "trooper1");
    await page.goto(`/troop_report.php?id=${eventId}`);

    const draft = await page.locator("#troop_report_content").inputValue();

    expect(draft).toContain("[b]Event:[/b] Segmented Troop");
    expect(draft).toContain("[b]Garrison Members:[/b]");
    expect(draft).toContain("[b]Other 501st Members:[/b]");
    expect(draft).toContain("[b]Others:[/b]");
    expect(draft).toContain("trooper1 (TK-20001)");
    expect(draft).toContain(TK);
    expect(draft).toContain("[b]Total attendees:[/b] 3");

    // Ordering: each attendee must appear under their own heading.
    const garrisonIndex = draft.indexOf("Garrison Members");
    const legionIndex = draft.indexOf("Other 501st Members");
    const otherIndex = draft.indexOf("Others:");
    expect(draft.indexOf("trooper1")).toBeGreaterThan(garrisonIndex);
    expect(draft.indexOf("trooper1")).toBeLessThan(legionIndex);
    expect(draft.indexOf("trooper2")).toBeGreaterThan(legionIndex);
    expect(draft.indexOf("newbie")).toBeGreaterThan(otherIndex);
  });

  test("leaves out anybody who was only on the waitlist", async ({ page }) => {
    const eventId = await finishedEvent("Waitlisted Troop");
    await createRsvp(eventId, "trooper1", { costumes: [TK] });
    await createRsvp(eventId, "trooper2", { costumes: [TD], status: "waitlisted" });

    await loginAs(page, "trooper1");
    await page.goto(`/troop_report.php?id=${eventId}`);

    const draft = await page.locator("#troop_report_content").inputValue();
    expect(draft).toContain("trooper1 (TK-20001)");
    expect(draft).not.toContain("trooper2");
    expect(draft).toContain("[b]Total attendees:[/b] 1");

    // Waiting for a place is not having attended, so there is no report to write either.
    await loginAs(page, "trooper2");
    await page.goto(`/troop_report.php?id=${eventId}`);
    await expect(page.locator("body")).toContainText("You must have attended this event");
  });

  test("the report box is the board's BBCode editor", async ({ page }) => {
    const eventId = await finishedEvent("Edited Troop");
    await createRsvp(eventId, "trooper1", { costumes: [TK] });

    await loginAs(page, "trooper1");
    await page.goto(`/troop_report.php?id=${eventId}`);

    // A report is BBCode posted into a forum, so it is written in the same editor a post
    // is - not in a bare textarea whose tags the author has to know.
    await expectEditorAttached(page, "troop_report_content");
  });

  test("rosters the attendees as a BBCode list, all the way to the thread", async ({
    page,
  }) => {
    const eventId = await finishedEvent("Listed Troop");
    await createRsvp(eventId, "trooper1", { costumes: [TK] });
    await createRsvp(eventId, "trooper2", { costumes: [TD] });

    await loginAs(page, "trooper1");
    await page.goto(`/troop_report.php?id=${eventId}`);

    const draft = await page.locator("#troop_report_content").inputValue();

    expect(draft).toContain("[list]");
    expect(draft).toContain("[/list]");
    expect(draft).toContain("[*]trooper1 (TK-20001)");
    expect(draft).not.toContain("- trooper1 (TK-20001)");

    // Posted unchanged - which also takes the draft back out through the editor - the
    // list tags have to arrive as a list rather than as visible markup.
    await page.locator("#troop_report_submit").click();

    const post = page.locator(".post_body").first();
    await expect(post.locator("ul li").first()).toContainText("trooper1 (TK-20001)");
    await expect(post).not.toContainText("[*]");
  });

  test("lists wranglers in their own section, apart from the membership buckets", async ({
    page,
  }) => {
    const eventId = await finishedEvent("Wrangled Troop");
    await createRsvp(eventId, "trooper1", { costumes: [TK] });
    await createRsvp(eventId, "trooper2", { costumes: [TD] });
    await createRsvp(eventId, "wrangler", { role: "wrangler" });

    await loginAs(page, "trooper1");
    await page.goto(`/troop_report.php?id=${eventId}`);

    const draft = await page.locator("#troop_report_content").inputValue();

    expect(draft).toContain("[b]Wranglers:[/b]");
    expect(draft).toContain("[*]wrangler");

    // Wranglers sit after the membership buckets, not inside them.
    expect(draft.indexOf("wrangler\n")).toBeGreaterThan(
      draft.indexOf("[b]Wranglers:[/b]"),
    );
    expect(draft.indexOf("[b]Wranglers:[/b]")).toBeGreaterThan(
      draft.indexOf("[b]Others:[/b]"),
    );

    // The headline attendance figure stays the costumed count.
    expect(draft).toContain("[b]Total attendees:[/b] 2");
    expect(draft).toContain("[b]Total wranglers:[/b] 1");
  });

  test("omits the wrangler section entirely when nobody wrangled", async ({
    page,
  }) => {
    const eventId = await finishedEvent("Unwrangled Troop");
    await createRsvp(eventId, "trooper1", { costumes: [TK] });

    await loginAs(page, "trooper1");
    await page.goto(`/troop_report.php?id=${eventId}`);

    const draft = await page.locator("#troop_report_content").inputValue();
    expect(draft).not.toContain("Wranglers");
  });

  test("are not offered to somebody who only wrangled", async ({ page }) => {
    const eventId = await finishedEvent("Wrangler Only Troop");
    await createRsvp(eventId, "trooper1", { costumes: [TK] });
    await createRsvp(eventId, "wrangler", { role: "wrangler" });

    await loginAs(page, "wrangler");
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator("#event_troop_report")).toHaveCount(0);

    await page.goto(`/troop_report.php?id=${eventId}`);
    await expect(page.locator("body")).toContainText("as a trooper");
  });

  test("are offered to somebody who both trooped and wrangled", async ({
    page,
  }) => {
    const eventId = await finishedEvent("Dual Role Troop");
    await createRsvp(eventId, "trooper1", { costumes: [TK] });
    await createRsvp(eventId, "trooper1", { role: "wrangler" });

    await loginAs(page, "trooper1");
    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator("#event_troop_report")).toBeVisible();
  });

  test("neutralises BBCode in attendee data, all the way to the posted thread", async ({
    page,
  }) => {
    const eventId = await finishedEvent("Injected Troop");
    await createRsvp(eventId, "trooper1", { costumes: [TK] });
    // The TK ID is a free-text profile field, so it is the easiest injection vector.
    await setUserField(
      "trooper1",
      "tk_id",
      "TK-1[/b][url=http://evil.test]click me[/url]",
    );

    await loginAs(page, "trooper1");
    await page.goto(`/troop_report.php?id=${eventId}`);

    // The draft must carry the brackets as entities, not as live markup.
    const draft = await page.locator("#troop_report_content").inputValue();
    expect(draft).toContain("&#91;/b&#93;");
    expect(draft).not.toContain("[/b][url=");

    await page.locator("#troop_report_submit").click();
    await expect(page.locator("body")).toContainText("Injected Troop");

    // In the posted thread the payload must read as text, with no link and no bold.
    const post = page.locator(".post_body").first();
    await expect(post).toContainText(
      "[/b][url=http://evil.test]click me[/url]",
    );
    await expect(post.locator('a[href*="evil.test"]')).toHaveCount(0);
  });

  test("posting creates the forum thread and archives the event", async ({
    page,
  }) => {
    const eventId = await finishedEvent("Postable Troop");
    await createRsvp(eventId, "trooper1", { costumes: [TK] });

    await loginAs(page, "trooper1");
    await page.goto(`/troop_report.php?id=${eventId}`);

    await fillDescription(
      page,
      "troop_report_content",
      "We deployed and it went well.",
    );
    await page.locator("#troop_report_submit").click();

    await expect(page.locator("body")).toContainText(
      "We deployed and it went well.",
    );

    const thread = await findThreadBySubject("Troop Report: Postable Troop");
    expect(thread).not.toBeNull();
    expect(Number(thread!.fid)).toBe(fixtures().forums.troop_reports);

    const report = await getTroopReport(eventId);
    expect(report).not.toBeNull();
    expect(Number(report!.thread_id)).toBe(Number(thread!.tid));
    expect(report!.posted_at).toBeTruthy();

    // Posting the report closes the event out.
    expect((await getEvent(eventId)).status).toBe("archived");

    await page.goto(`/event.php?id=${eventId}`);
    await expect(page.locator("#event_troop_report_posted")).toBeVisible();
  });

  test("refuses a second report for the same event", async ({ page }) => {
    const eventId = await finishedEvent("Single Report Troop");
    await createRsvp(eventId, "trooper1", { costumes: [TK] });
    await createRsvp(eventId, "trooper2", { costumes: [TD] });

    await loginAs(page, "trooper1");
    await page.goto(`/troop_report.php?id=${eventId}`);
    await fillDescription(page, "troop_report_content", "First report.");
    await page.locator("#troop_report_submit").click();
    await expect(page.locator("body")).toContainText("First report.");

    await loginAs(page, "trooper2");
    await page.goto(`/troop_report.php?id=${eventId}`);
    await expect(page.locator("body")).toContainText(
      "A troop report has already been posted",
    );
  });

  test("a double-clicked submit posts one report and points the second at it", async ({
    page,
  }) => {
    // Both requests used to pass the "already posted" check before either had written
    // anything, so each filed a thread of its own.
    const eventId = await finishedEvent("Double Click Report Troop");
    await createRsvp(eventId, "trooper1", { costumes: [TK] });

    await loginAs(page, "trooper1");
    await page.goto(`/troop_report.php?id=${eventId}`);
    await expectEditorAttached(page, "troop_report_content");

    const bodies = await submitFormAtOnce(page, "#troop_report_form", {
      overrides: { report_content: "Posted once." },
    });

    const threads = await query(
      `SELECT tid FROM ${T("threads")} WHERE subject = ?`,
      ["Troop Report: Double Click Report Troop"],
    );
    expect(threads).toHaveLength(1);
    const tid = Number(threads[0].tid);
    expect(Number((await getTroopReport(eventId))!.thread_id)).toBe(tid);

    const refused = bodies.filter((body) =>
      body.includes("A troop report has already been posted"),
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain(`showthread.php?tid=${tid}`);
    for (const body of bodies) {
      expect(body).not.toMatch(/SQL Error|Fatal error/);
    }
  });

  test("links to the posted report when it is opened again", async ({ page }) => {
    const eventId = await finishedEvent("Linked Report Troop");
    await createRsvp(eventId, "trooper1", { costumes: [TK] });

    await loginAs(page, "trooper1");
    await page.goto(`/troop_report.php?id=${eventId}`);
    await fillDescription(page, "troop_report_content", "Already written.");
    await page.locator("#troop_report_submit").click();
    await expect(page.locator("body")).toContainText("Already written.");

    await page.goto(`/troop_report.php?id=${eventId}`);
    await page.locator("#troop_report_existing").click();
    await expect(page.locator("body")).toContainText("Already written.");
  });

  test("say so when the board has no troop report forum configured", async ({ page }) => {
    // The forum is a setting, and a board that never set one would otherwise lose the
    // report into a PostDataHandler error about forum 0 - after the attendee had written
    // it out.
    const restore = await withSettings({ events_troop_report_forum: "" });

    try {
      const eventId = await finishedEvent("Homeless Report Troop");
      await createRsvp(eventId, "trooper1", { costumes: [TK] });

      await loginAs(page, "trooper1");
      await page.goto(`/troop_report.php?id=${eventId}`);
      await fillDescription(page, "troop_report_content", "Nowhere to put this.");
      await page.locator("#troop_report_submit").click();

      await expect(page.locator("body")).toContainText(
        "No troop report forum has been configured",
      );
      expect(
        await query(
          `SELECT id FROM ${T("event_plugin_troop_reports")} WHERE event_id = ?`,
          [eventId],
        ),
      ).toHaveLength(0);
    } finally {
      await restore();
    }
  });

  test("refuse an empty body rather than posting a blank thread", async ({ page }) => {
    const eventId = await finishedEvent("Empty Report Troop");
    await createRsvp(eventId, "trooper1", { costumes: [TK] });

    await loginAs(page, "trooper1");
    await page.goto(`/troop_report.php?id=${eventId}`);
    await fillDescription(page, "troop_report_content", "");
    await page.locator("#troop_report_submit").click();

    // MyBB's own post validation, surfaced as the page's error rather than swallowed.
    await expect(page.locator("body")).toContainText(/message|empty/i);
    expect(await getTroopReport(eventId)).toBeNull();

    // And the event is not closed out on the strength of a report that was never posted.
    expect((await getEvent(eventId)).status).not.toBe("archived");
  });

  test("leaves a pointer on the linked discussion thread", async ({ page }) => {
    const discussionId = await createThread(
      "Discussion: Linked Troop",
      fixtures().forums.general,
      "gec",
    );
    const eventId = await finishedEvent("Linked Troop", {
      threadId: discussionId,
    });
    await createRsvp(eventId, "trooper1", { costumes: [TK] });

    const postsBefore = await countPostsInThread(discussionId);

    await loginAs(page, "trooper1");
    await page.goto(`/troop_report.php?id=${eventId}`);
    await fillDescription(page, "troop_report_content", "Linked report body.");
    await page.locator("#troop_report_submit").click();
    await expect(page.locator("body")).toContainText("Linked report body.");

    expect(await countPostsInThread(discussionId)).toBe(postsBefore + 1);

    await page.goto(`/showthread.php?tid=${discussionId}`);
    await expect(page.locator("body")).toContainText(
      "Troop report has been posted",
    );
  });

  test("posts the report and its pointer under MyBB's post flood check", async ({ page }) => {
    // The suite's board runs with the flood check off (scripts/provision.php); a real one
    // runs MyBB's default of 60 seconds. Posting the report sets the trooper's last post
    // time, so the pointer that follows it in the same second was refused as flooding -
    // silently, since a refused pointer is not an error - and a trooper who had posted
    // anything a moment before was refused the report itself.
    const restore = await withSettings({ postfloodcheck: "1", postfloodsecs: "60" });
    try {
      const discussionId = await createThread(
        "Discussion: Flooded Troop",
        fixtures().forums.general,
        "gec",
      );
      const eventId = await finishedEvent("Flooded Troop", {
        threadId: discussionId,
      });
      await createRsvp(eventId, "trooper1", { costumes: [TK] });
      await runPhp(`$db->update_query('users', array('lastpost' => TIME_NOW), 'uid = ${uid("trooper1")}');`);

      const postsBefore = await countPostsInThread(discussionId);

      await loginAs(page, "trooper1");
      await page.goto(`/troop_report.php?id=${eventId}`);
      await fillDescription(page, "troop_report_content", "Flooded report body.");
      await page.locator("#troop_report_submit").click();
      await expect(page.locator("body")).toContainText("Flooded report body.");

      expect(await countPostsInThread(discussionId)).toBe(postsBefore + 1);
    } finally {
      await restore();
    }
  });

  test("rewrites the event's announcement as over once the report is posted", async ({
    page,
  }) => {
    // Posting the report is what archives an event, so it is also what has to rewrite
    // the announcement. Members see the card, but guests and Tapatalk read the generated
    // first post - and it went on inviting them to sign up to an event that had finished.
    // Threads outlive a test, so the title is this attempt's own.
    const title = `Announced Troop ${Math.random().toString(36).slice(2, 8)}`;
    const eventId = await finishedEvent(title);
    await createRsvp(eventId, "trooper1", { costumes: [TK] });

    const threadId = Number(
      (
        await runPhp(`
require_once MYBB_ROOT.'inc/plugins/events/inc/events_thread.php';
echo events_sync_event_thread(${eventId});
`)
      ).trim(),
    );
    expect(threadId).toBeGreaterThan(0);
    expect((await getThreadFirstPost(threadId)).message).not.toContain(
      "This event is over",
    );

    await loginAs(page, "trooper1");
    await page.goto(`/troop_report.php?id=${eventId}`);
    await fillDescription(page, "troop_report_content", "Announced report body.");
    await page.locator("#troop_report_submit").click();
    await expect(page.locator("body")).toContainText("Announced report body.");

    const firstPost = await getThreadFirstPost(threadId);
    expect(firstPost.message).toContain(
      "This event is over and signups are closed.",
    );

    await logout(page);
    await page.goto(`/showthread.php?tid=${threadId}`);
    await expect(page.locator(`#pid_${firstPost.pid}`)).toContainText(
      "This event is over and signups are closed.",
    );
  });
});
