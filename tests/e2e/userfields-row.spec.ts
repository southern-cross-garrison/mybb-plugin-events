import { test, expect } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import { createEvent, countRsvps, getUserField, execute, uid, T } from '../helpers/db';

/**
 * A member can have no row in MyBB's `userfields` table at all: the account the installer
 * creates has none, and nor does anything imported around the user datahandler. Saving the
 * prerequisites for such a member is an INSERT rather than an UPDATE, and MyBB declares
 * every fid column TEXT NOT NULL with no default - so a partial insert naming only the
 * plugin's own fields is refused outright under STRICT_TRANS_TABLES, and the signup dies
 * on "Field 'fid1' doesn't have a default value" at the moment the member has just
 * finished filling that form in.
 *
 * The row is deleted here rather than by picking a member who happens to lack one: every
 * fixture user is built through the datahandler and so has one, which is exactly the
 * condition under which this bug is invisible. resetPluginData() restores the whole table
 * from its backup before each test, so the delete does not leak.
 */
test('a member with no userfields row can still complete a signup', async ({ page }) => {
  const eventId = await createEvent({ title: 'No Userfields Row Troop' });

  await execute(`DELETE FROM ${T('userfields')} WHERE ufid = ?`, [uid('newbie')]);

  await loginAs(page, 'newbie');
  await page.goto(`/rsvp.php?id=${eventId}`);
  await page.locator('#rsvp_submit').click();

  await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');
  await page.locator('#prereq_tk_id').fill('12345');
  await page.locator('#prereq_mobile').fill('0400 111 222');
  await page.locator('#prereq_emergency_contact').fill('Next Of Kin 0400 333 444');
  await page.locator('#rsvp_submit').click();

  // Reaching the next step at all is the assertion: before the fix this was MyBB's SQL
  // error page, and the values below were never written.
  await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');

  expect(await getUserField('newbie', 'tk_id')).toBe('12345');
  expect(await getUserField('newbie', 'mobile')).toBe('0400 111 222');
  expect(await getUserField('newbie', 'emergency_contact')).toBe('Next Of Kin 0400 333 444');
  expect(await countRsvps(eventId)).toBe(0);
});
