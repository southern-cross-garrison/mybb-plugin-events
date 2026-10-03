import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Driving the event form's excluded members field.
 *
 * The field is a tag input: typing searches the board's members, and only a name picked
 * from the list it offers can be added. There is no box to type a comma separated list
 * into any more, so a test that wants somebody excluded has to pick them the way a person
 * would - type enough of the name, wait for the option, click it.
 *
 * The box that posts is still an input named "exclusions", hidden behind the widget; it is
 * what `excludedValue()` reads, and it is what the server sees.
 */

/** The menu option offering this username. */
export function tagOption(page: Page, username: string): Locator {
	return page.locator(`[data-events-tag-option="${username}"]`);
}

/** The lozenge for a username that has been added. */
export function tag(page: Page, username: string): Locator {
	return page.locator(`[data-events-tag="${username}"]`);
}

/** What the field will post: the comma separated list the server has always read. */
export function excludedValue(page: Page): Locator {
	return page.locator('input[name="exclusions"]');
}

/**
 * Search for each username and take it from the list.
 *
 * @param entry Selector for the box that is typed into - '#exclusions' in the Admin CP,
 *              '#event_form_exclusions' on the front end
 */
export async function addTags(page: Page, entry: string, usernames: string[]): Promise<void> {
	for (const username of usernames) {
		// fill() dispatches the input event the field searches on, and the search is debounced,
		// so the option is waited for rather than assumed to be there by the next line.
		await page.locator(entry).fill(username);
		await tagOption(page, username).click();
		await expect(tag(page, username)).toBeVisible();
	}
}

/** Take a username back off the list with its own X. */
export async function removeTag(page: Page, username: string): Promise<void> {
	await tag(page, username).locator('.events_tag_remove').click();
	await expect(tag(page, username)).toHaveCount(0);
}
