import { test, expect } from "../helpers/fixtures";
import { loginAs } from "../helpers/auth";
import { relativeToTestNow, setClock } from "../helpers/clock";
import {
  createEvent,
  createRsvp,
  createThread,
  countPostsInThread,
  findThreadBySubject,
  getEvent,
  getTroopReport,
  setUserField,
  fixtures,
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
    expect(draft).toContain("- wrangler");

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

    await page
      .locator("#troop_report_content")
      .fill("We deployed and it went well.");
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
    await page.locator("#troop_report_content").fill("First report.");
    await page.locator("#troop_report_submit").click();
    await expect(page.locator("body")).toContainText("First report.");

    await loginAs(page, "trooper2");
    await page.goto(`/troop_report.php?id=${eventId}`);
    await expect(page.locator("body")).toContainText(
      "A troop report has already been posted",
    );
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
    await page.locator("#troop_report_content").fill("Linked report body.");
    await page.locator("#troop_report_submit").click();
    await expect(page.locator("body")).toContainText("Linked report body.");

    expect(await countPostsInThread(discussionId)).toBe(postsBefore + 1);

    await page.goto(`/showthread.php?tid=${discussionId}`);
    await expect(page.locator("body")).toContainText(
      "Troop report has been posted",
    );
  });
});
