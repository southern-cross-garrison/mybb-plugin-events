import { test, expect, Page } from "../helpers/fixtures";
import { loginToAdminCp, gotoEventsAdmin, loginAs } from "../helpers/auth";
import {
  createEvent,
  getEvent,
  getSetting,
  query,
  T,
  fixtures,
} from "../helpers/db";

/**
 * The region list is the board's, not the plugin's: it is edited in Admin CP -> Event
 * Management -> Settings alongside the forums each region announces into.
 *
 * The three operations are three different shapes, and these tests follow that split.
 * Renaming is a text box saved with the rest of the settings. Adding and deleting are
 * actions of their own, confirmed in a dialog and applied on the spot.
 *
 * Deleting is what makes any of this more than a text field. An event stores its region
 * as text, so a region that disappears takes its events out of the region filter and
 * makes them unsavable on the event form - which is why the dialog has a second step
 * that asks where those events go, and why nothing happens until it has an answer.
 *
 * Every test here restores the list through the Admin CP rather than through the
 * database: MyBB reads its settings from the generated inc/settings.php, so a row put
 * back with SQL would leave the cache - and therefore every later test - on the edited
 * list.
 */

const DEFAULT_REGIONS = "Sydney,Hunter,Canberra,Other";

async function gotoSettings(page: Page): Promise<void> {
  await loginToAdminCp(page);
  await gotoEventsAdmin(page, "&action=settings");
}

/** The index a region's row is rendered under, which is what its name box is keyed by. */
async function rowIndex(page: Page, region: string): Promise<number> {
  const field = page.locator(
    `input[type="hidden"][name^="region_original"][value="${region}"]`,
  );
  const name = await field.getAttribute("name");
  const index = name?.match(/\[(\d+)\]/)?.[1];

  expect(index, `no region row for ${region}`).toBeDefined();
  return Number(index);
}

async function renameRegion(
  page: Page,
  region: string,
  to: string,
): Promise<void> {
  await page.locator(`#region_name_${await rowIndex(page, region)}`).fill(to);
}

async function save(page: Page): Promise<void> {
  await page.locator('input[type="submit"][value="Save Settings"]').click();
}

const modal = (page: Page) => page.locator("#events_region_modal");
const modalSubmit = (page: Page) => page.locator("#events_region_modal_submit");

/**
 * Delete a region through the dialog, answering its second step when it asks.
 *
 * The second step only appears for a region that has events, so `moveTo` is what the
 * caller expects to be asked for - passing it for a region with none would be a test
 * that silently stopped exercising the step it was written for.
 */
async function deleteRegion(
  page: Page,
  region: string,
  moveTo?: string,
): Promise<void> {
  await page.locator(`.events_region_delete[data-region="${region}"]`).click();
  await expect(modal(page)).toBeVisible();
  await modalSubmit(page).click();

  if (moveTo !== undefined) {
    await expect(page.locator("#events_region_modal_move")).toBeVisible();
    await page.locator("#events_region_modal_move_to").selectOption(moveTo);
    await modalSubmit(page).click();
  }
}

async function addRegion(page: Page, name: string): Promise<void> {
  await page.locator("#events_region_add").click();
  await expect(modal(page)).toBeVisible();
  await page.locator("#events_region_modal_name").fill(name);
  await modalSubmit(page).click();
}

/**
 * Put the list back the way the suite's baseline has it, through the Admin CP.
 *
 * Written as a teardown that re-derives the current list rather than as the inverse of
 * whatever the test did, so a test that fails halfway still leaves the board usable for
 * the ones after it. Renames go first, so the names the deletions and additions then
 * work with are the baseline's.
 *
 * It goes straight to the confirmation pages rather than through the dialog, so that it
 * works for the scriptless tests too - and so a teardown never fails for a reason the
 * tests themselves are there to catch.
 */
async function restoreRegions(page: Page): Promise<void> {
  const wanted = DEFAULT_REGIONS.split(",");
  let current = (await getSetting("events_regions")).split(",");

  if (current.join(",") === DEFAULT_REGIONS) {
    return;
  }

  await gotoSettings(page);

  let renamed = false;
  for (let i = 0; i < Math.min(current.length, wanted.length); i++) {
    if (current[i] !== wanted[i]) {
      await page.locator(`#region_name_${i}`).fill(wanted[i]);
      renamed = true;
    }
  }

  if (renamed) {
    await save(page);
    current = (await getSetting("events_regions")).split(",");
  }

  for (const extra of current.slice(wanted.length)) {
    await gotoEventsAdmin(
      page,
      `&action=settings&region_action=delete&region=${encodeURIComponent(extra)}`,
    );

    const destination = page.locator('select[name="region_move_to"]');
    const hasEvents = (await destination.count()) > 0;
    if (hasEvents) {
      await destination.selectOption(wanted[0]);
    }

    await page
      .locator(
        `input[type="submit"][value="${hasEvents ? "Move Them and Delete" : "Delete Region"}"]`,
      )
      .click();
  }

  for (const missing of wanted.slice(current.length)) {
    await gotoEventsAdmin(page, "&action=settings&region_action=add");
    await page.locator('input[name="region_add_name"]').fill(missing);
    await page.locator('input[type="submit"][value="Add Region"]').click();
  }

  expect(await getSetting("events_regions")).toBe(DEFAULT_REGIONS);
}

test.describe("configurable regions", () => {
  test.afterEach(async ({ page }) => {
    await restoreRegions(page);
  });

  test("adds a region, and the event form and the listing filter both offer it", async ({
    page,
  }) => {
    await gotoSettings(page);
    await addRegion(page, "Illawarra");

    await expect(page.locator("#flash_message")).toContainText(
      '"Illawarra" added',
    );
    expect(await getSetting("events_regions")).toBe(
      `${DEFAULT_REGIONS},Illawarra`,
    );

    // The page comes back on the settings form with the new region on it, which is the
    // point of applying the addition on the spot rather than folding it into a save.
    await expect(page.locator('input[name="region_name[4]"]')).toHaveValue(
      "Illawarra",
    );

    // And a region only earns its keep if an event can actually be filed under it, so
    // this goes all the way through the front-end form rather than stopping at the row.
    await loginAs(page, "gec");
    await page.goto("/manage_event.php?action=add");
    await expect(
      page.locator("#event_form_region option", { hasText: "Illawarra" }),
    ).toHaveCount(1);

    await page.goto("/events.php");
    await expect(
      page.locator("#events_region_filter option", { hasText: "Illawarra" }),
    ).toHaveCount(1);
  });

  test("will not add a name it could not store, or one the board already has", async ({
    page,
  }) => {
    await gotoSettings(page);

    // Both the region list and the region => forum map are flat comma separated
    // settings, so a name carrying either separator would corrupt the entries after it.
    await addRegion(page, "South, West");
    await expect(page.locator(".error")).toContainText(
      "cannot contain a comma or an equals sign",
    );
    expect(await getSetting("events_regions")).toBe(DEFAULT_REGIONS);

    await gotoSettings(page);
    await addRegion(page, "sydney");
    await expect(page.locator(".error")).toContainText("already a region");
    expect(await getSetting("events_regions")).toBe(DEFAULT_REGIONS);
  });

  test("renames a region and its events follow it", async ({ page }) => {
    const eventId = await createEvent({
      title: "Renamed Region Troop",
      region: "Canberra",
    });

    await gotoSettings(page);
    await renameRegion(page, "Canberra", "ACT");
    await save(page);

    expect(await getSetting("events_regions")).toBe("Sydney,Hunter,ACT,Other");

    // The whole reason renaming is its own operation rather than a deletion and an
    // addition: the event keeps its place in the list instead of being orphaned.
    expect((await getEvent(eventId)).region).toBe("ACT");

    await loginAs(page, "trooper1");
    await page.goto("/events.php?region=ACT");
    await expect(page.locator(".event_region").first()).toHaveText("ACT");
  });

  test("a rename takes the region's announcement forum with it", async ({
    page,
  }) => {
    const f = fixtures();

    await gotoSettings(page);
    await renameRegion(page, "Hunter", "Newcastle");
    await save(page);

    // The forum dropdowns are keyed by region name, so without remapping the rename
    // would silently unroute the region it just renamed.
    expect(await getSetting("events_event_forums")).toBe(
      `Newcastle=${f.forums.events_hunter}`,
    );
  });

  test("deletes a region with no events straight from the are-you-sure step", async ({
    page,
  }) => {
    await gotoSettings(page);

    const x = page.locator('.events_region_delete[data-region="Other"]');
    await expect(x).toHaveAttribute("data-events", "0");
    await x.click();

    await expect(page.locator("#events_region_modal_message")).toContainText(
      "No events are associated with this region.",
    );

    // No second step for a region with nothing to rehome: confirming is the deletion.
    await expect(page.locator("#events_region_modal_move")).toBeHidden();
    await modalSubmit(page).click();

    await expect(page.locator("#flash_message")).toContainText(
      '"Other" deleted',
    );
    expect(await getSetting("events_regions")).toBe("Sydney,Hunter,Canberra");
  });

  test("asks where a region's events go before deleting it, and moves them there", async ({
    page,
  }) => {
    const moved = await createEvent({
      title: "Rehomed Troop",
      region: "Canberra",
    });
    const untouched = await createEvent({
      title: "Stayed Put Troop",
      region: "Hunter",
    });

    await gotoSettings(page);
    await page.locator('.events_region_delete[data-region="Canberra"]').click();
    await expect(page.locator("#events_region_modal_message")).toContainText(
      "1 event is filed under it",
    );

    // Confirming the first step is not the deletion: the event has nowhere to go yet.
    await modalSubmit(page).click();
    await expect(page.locator("#events_region_modal_move")).toBeVisible();
    expect(await getSetting("events_regions")).toBe(DEFAULT_REGIONS);

    // The region on its way out is not offered as somewhere to put its own events.
    await expect(
      page.locator("#events_region_modal_move_to option"),
    ).toHaveText(["Sydney", "Hunter", "Other"]);

    await page.locator("#events_region_modal_move_to").selectOption("Sydney");
    await modalSubmit(page).click();

    await expect(page.locator("#flash_message")).toContainText(
      '1 event was moved to "Sydney"',
    );
    expect(await getSetting("events_regions")).toBe("Sydney,Hunter,Other");

    expect((await getEvent(moved)).region).toBe("Sydney");
    expect((await getEvent(untouched)).region).toBe("Hunter");

    await loginAs(page, "trooper1");
    await page.goto("/events.php?region=Sydney");
    await expect(
      page.locator(".event_link", { hasText: "Rehomed Troop" }),
    ).toHaveCount(1);
  });

  test("backing out of the dialog changes nothing", async ({ page }) => {
    const eventId = await createEvent({
      title: "Reprieved Troop",
      region: "Canberra",
    });

    await gotoSettings(page);
    await page.locator('.events_region_delete[data-region="Canberra"]').click();
    await page.locator(".events_modal_cancel").click();

    await expect(modal(page)).toBeHidden();
    expect(await getSetting("events_regions")).toBe(DEFAULT_REGIONS);
    expect((await getEvent(eventId)).region).toBe("Canberra");
  });

  test("will not leave the board with no regions at all", async ({ page }) => {
    await gotoSettings(page);

    for (const region of ["Other", "Canberra", "Hunter"]) {
      await deleteRegion(page, region);
    }

    expect(await getSetting("events_regions")).toBe("Sydney");

    await deleteRegion(page, "Sydney");
    await expect(page.locator(".error")).toContainText("at least one region");
    expect(await getSetting("events_regions")).toBe("Sydney");
  });

  test("keeps the rest of the settings form when a region name is rejected", async ({
    page,
  }) => {
    const f = fixtures();

    await gotoSettings(page);
    await page
      .locator('select[name="troop_report_forum"]')
      .selectOption(String(f.forums.general));
    await renameRegion(page, "Canberra", "Bad=Name");
    await save(page);

    await expect(page.locator(".error")).toContainText(
      "cannot contain a comma or an equals sign",
    );

    // The settings are untouched, and the form still shows the change that was about to
    // be saved alongside the bad one - otherwise one bad region name silently discards
    // everything else the admin did on the page.
    expect(await getSetting("events_regions")).toBe(DEFAULT_REGIONS);
    expect(await getSetting("events_troop_report_forum")).toBe(
      String(f.forums.troop_reports),
    );
    await expect(page.locator('select[name="troop_report_forum"]')).toHaveValue(
      String(f.forums.general),
    );
  });

  test("stores an event under a region the board added itself", async ({
    page,
  }) => {
    await gotoSettings(page);
    await addRegion(page, "Illawarra");

    // The column shipped as an enum of the four regions the plugin came with, which
    // would have coerced this to '' or rejected the insert outright.
    const eventId = await createEvent({
      title: "Illawarra Troop",
      region: "Illawarra",
    });
    expect((await getEvent(eventId)).region).toBe("Illawarra");

    const [column] = await query(
      `SHOW COLUMNS FROM ${T("event_plugin_events")} LIKE 'region'`,
    );
    expect(String((column as any).Type)).toBe("varchar(64)");
  });
});

/**
 * The dialog is an enhancement over a pair of ordinary links, and this is the half that
 * would rot unnoticed. Without the fallback, turning JavaScript off leaves an admin
 * unable to delete a region at all - or, worse, able to reach a deletion that never
 * asked where the events went.
 */
test.describe("configurable regions without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test.afterEach(async ({ page }) => {
    await restoreRegions(page);
  });

  test("deletes a region from a confirmation page, rehoming its events", async ({
    page,
  }) => {
    const eventId = await createEvent({
      title: "Scriptless Troop",
      region: "Canberra",
    });

    await gotoSettings(page);
    await page.locator('.events_region_delete[data-region="Canberra"]').click();

    await expect(page.locator("body")).toContainText(
      "1 event is filed under it",
    );
    await page.locator('select[name="region_move_to"]').selectOption("Hunter");
    await page
      .locator('input[type="submit"][value="Move Them and Delete"]')
      .click();

    await expect(page.locator("#flash_message")).toContainText(
      '"Canberra" deleted',
    );
    expect(await getSetting("events_regions")).toBe("Sydney,Hunter,Other");
    expect((await getEvent(eventId)).region).toBe("Hunter");
  });

  test("adds a region from a page of its own", async ({ page }) => {
    await gotoSettings(page);
    await page.locator("#events_region_add").click();

    await page.locator('input[name="region_add_name"]').fill("Illawarra");
    await page.locator('input[type="submit"][value="Add Region"]').click();

    await expect(page.locator("#flash_message")).toContainText(
      '"Illawarra" added',
    );
    expect(await getSetting("events_regions")).toBe(
      `${DEFAULT_REGIONS},Illawarra`,
    );
  });
});
