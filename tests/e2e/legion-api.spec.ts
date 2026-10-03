import { test, expect } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import { signUpThroughWizard } from '../helpers/rsvp';
import { createEvent, getRsvpCostumes, getUserField, setUserField, fixtures } from '../helpers/db';
import { legionApiMember, legionApiRequests, stubLegionApi } from '../helpers/legion-api';

/**
 * Saying you will troop fetches your costumes from the 501st Legion API by Legion ID and
 * writes them over the costume profile field, before the prerequisites step decides
 * whether to ask for them. Anything short of a member record with costumes on it leaves
 * the field alone.
 *
 * trooper1 is TK-20001 with two costumes on file; trooper2 is TK-20002 with one.
 */
const [TK, TD, TB] = [0, 1, 2].map((index) => fixtures().costumeOptions[index]);

test.describe('costumes from the 501st Legion API', () => {
  test('replaces the costumes on file with the Legion\'s, formatted one per line', async ({ page }) => {
    const eventId = await createEvent({ title: 'Legion Costumes Troop' });
    stubLegionApi(
      20001,
      legionApiMember(20001, [
        { costumeName: 'Stormtrooper: ANH Stunt', designation: 'TK' },
        // The real API's names carry trailing spaces, and a comma in one would split it
        // in two when the field is read back.
        { costumeName: 'Officer: Line Officer, (Olive Drab) ', designation: 'ID' },
        { costumeName: 'Snowtrooper', designation: 'TS' },
      ]),
    );

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
    await expect(page.locator('input.costume_checkbox')).toHaveCount(3);
    await expect(page.locator(`input.costume_checkbox[value="${TK}"]`)).toHaveCount(0);

    expect(await getUserField('trooper1', 'costume')).toBe(
      'TK - Stormtrooper: ANH Stunt\nID - Officer: Line Officer (Olive Drab)\nTS - Snowtrooper',
    );
    expect(legionApiRequests()).toEqual(['/legionId/20001/costumes']);

    const notice = page.locator('#rsvp_costumes_from_api');
    await expect(notice).toHaveText(
      'If these costumes are not correct, check that your Legion ID is set correctly in your profile and try again.',
    );
    await expect(notice.locator('a')).toHaveText('check that your Legion ID is set correctly in your profile');
    await expect(notice.locator('a')).toHaveAttribute('href', 'usercp.php?action=profile');

    await page.locator('input.costume_checkbox[value="ID - Officer: Line Officer (Olive Drab)"]').check();
    await page.locator('#rsvp_submit').click();
    await page.locator('#rsvp_submit').click();
    await expect(page.locator('#rsvp_success_message')).toBeVisible();
    expect(await getRsvpCostumes(eventId, 'trooper1')).toEqual(['ID - Officer: Line Officer (Olive Drab)']);
  });

  test('fills an empty costume field so the prerequisites step is not needed', async ({ page }) => {
    const eventId = await createEvent({ title: 'Costumeless Legion Troop' });
    await setUserField('trooper2', 'costume', '');
    stubLegionApi(20002, legionApiMember(20002, [{ costumeName: 'Sandtrooper', designation: 'TD' }]));

    await loginAs(page, 'trooper2');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    // trooper2 has every other prerequisite, and one costume is no choice to make.
    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
    await expect(page.locator('#confirm_costumes')).toHaveText('TD - Sandtrooper');
    // Shown wherever the Legion's costumes are, which with the costumes step skipped is here.
    await expect(page.locator('#rsvp_costumes_from_api')).toBeVisible();
    expect(await getUserField('trooper2', 'costume')).toBe('TD - Sandtrooper');
  });

  test('fetches again every time the member says they will troop', async ({ page }) => {
    const eventId = await createEvent({ title: 'Repeat Legion Troop' });
    stubLegionApi(20001, legionApiMember(20001, [{ costumeName: 'Stormtrooper', designation: 'TK' }]));

    await loginAs(page, 'trooper1');
    await signUpThroughWizard(page, eventId);
    expect(await getUserField('trooper1', 'costume')).toBe('TK - Stormtrooper');

    // Approved in another costume since.
    stubLegionApi(
      20001,
      legionApiMember(20001, [
        { costumeName: 'Stormtrooper', designation: 'TK' },
        { costumeName: 'Biker Scout', designation: 'TB' },
      ]),
    );
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
    expect(await getUserField('trooper1', 'costume')).toBe('TK - Stormtrooper\nTB - Biker Scout');
    // The costume already signed up in is still picked.
    await expect(page.locator(`input.costume_checkbox[value="${TK}"]`)).toBeChecked();
    expect(legionApiRequests()).toHaveLength(2);
  });

  test('keeps the costumes on file when the API is down', async ({ page }) => {
    const eventId = await createEvent({ title: 'API Down Troop' });

    await loginAs(page, 'trooper1');
    await signUpThroughWizard(page, eventId, { costumes: [TB] });

    expect(legionApiRequests()).toEqual(['/legionId/20001/costumes']);
    expect(await getUserField('trooper1', 'costume')).toBe(`${TK}\n${TB}`);
    expect(await getRsvpCostumes(eventId, 'trooper1')).toEqual([TB]);
  });

  test('says nothing about the Legion ID when the costumes are the ones on file', async ({ page }) => {
    const eventId = await createEvent({ title: 'On File Troop' });

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
    await expect(page.locator('#rsvp_costumes_from_api')).toHaveCount(0);
  });

  test('still says where the costumes came from after the prerequisites step', async ({ page }) => {
    const eventId = await createEvent({ title: 'Prerequisites Between Troop' });
    await setUserField('trooper1', 'mobile', '');
    stubLegionApi(
      20001,
      legionApiMember(20001, [
        { costumeName: 'Stormtrooper', designation: 'TK' },
        { costumeName: 'Biker Scout', designation: 'TB' },
      ]),
    );

    await loginAs(page, 'trooper1');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');
    await page.locator('#prereq_mobile').fill('0400 000 002');
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
    await expect(page.locator('#rsvp_costumes_from_api')).toBeVisible();
    await page.locator(`input.costume_checkbox[value="${TK}"]`).check();
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
    await expect(page.locator('#rsvp_costumes_from_api')).toBeVisible();
  });

  const unusable: Array<[string, Parameters<typeof stubLegionApi>[1]]> = [
    ['an error', { status: 500, body: { message: 'Internal Server Error' } }],
    ['a body that is not JSON', { raw: '<html>Bad Gateway</html>' }],
    ['a Legion ID it has no record of', { body: { memberStatus: 'Classified Record' } }],
    ['a member with no costumes', legionApiMember(20001, [])],
  ];
  for (const [answer, response] of unusable) {
    test(`keeps the costumes on file when the API answers ${answer}`, async ({ page }) => {
      const eventId = await createEvent({ title: 'Unusable Answer Troop' });
      stubLegionApi(20001, response);

      await loginAs(page, 'trooper1');
      await page.goto(`/rsvp.php?id=${eventId}`);
      await page.locator('#rsvp_submit').click();

      await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
      await expect(page.locator('#rsvp_costumes_from_api')).toHaveCount(0);
      expect(legionApiRequests()).toHaveLength(1);
      expect(await getUserField('trooper1', 'costume')).toBe(`${TK}\n${TB}`);
    });
  }

  test('asks for costumes as usual when the API is down and there are none on file', async ({ page }) => {
    const eventId = await createEvent({ title: 'Nothing On File Troop' });
    await setUserField('trooper2', 'costume', '');

    await loginAs(page, 'trooper2');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');
    await expect(page.locator('#prereq_costume')).toBeVisible();
    expect(legionApiRequests()).toEqual(['/legionId/20002/costumes']);
  });

  test('does not ask the API about a member wrangling', async ({ page }) => {
    const eventId = await createEvent({ title: 'Wrangling Troop' });
    stubLegionApi(20001, legionApiMember(20001, [{ costumeName: 'Stormtrooper', designation: 'TK' }]));

    await loginAs(page, 'trooper1');
    await signUpThroughWizard(page, eventId, { role: 'wrangler' });

    expect(legionApiRequests()).toEqual([]);
    expect(await getUserField('trooper1', 'costume')).toBe(`${TK}\n${TB}`);
  });

  test('does not ask the API about a member with no Legion ID on file', async ({ page }) => {
    const eventId = await createEvent({ title: 'No Legion ID Troop' });

    await loginAs(page, 'newbie');
    await page.goto(`/rsvp.php?id=${eventId}`);
    await page.locator('#rsvp_submit').click();

    await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');
    expect(legionApiRequests()).toEqual([]);
  });

  test.describe('a Legion ID entered on the prerequisites step', () => {
    test('fills the costumes from it, so they are never asked for', async ({ page }) => {
      const eventId = await createEvent({ title: 'New Legion ID Troop' });
      await setUserField('newbie', 'costume', '');
      stubLegionApi(
        33151,
        legionApiMember(33151, [
          { costumeName: 'Stormtrooper', designation: 'TK' },
          { costumeName: 'Biker Scout', designation: 'TB' },
        ]),
      );

      await loginAs(page, 'newbie');
      await page.goto(`/rsvp.php?id=${eventId}`);
      await page.locator('#rsvp_submit').click();

      // Costumes wait until the Legion ID has had its chance to fill them in.
      await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');
      await expect(page.locator('#prereq_tk_id')).toBeVisible();
      await expect(page.locator('#prereq_costume')).toHaveCount(0);
      await expect(page.locator('#rsvp_wrangle_note')).toHaveCount(0);
      expect(legionApiRequests()).toEqual([]);

      await page.locator('#prereq_tk_id').fill('TK-33151');
      await page.locator('#prereq_preferred_name').fill('Newt');
      await page.locator('#prereq_mobile').fill('0400 999 999');
      await page.locator('#prereq_emergency_contact').fill('Next Of Kin 0400 888 888');
      await page.locator('#rsvp_submit').click();

      await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'costumes');
      await expect(page.locator('#rsvp_costumes_from_api')).toBeVisible();
      expect(await getUserField('newbie', 'costume')).toBe(`${TK}\n${TB}`);
    });

    test('asks for the costumes on their own when the Legion has none for it', async ({ page }) => {
      const eventId = await createEvent({ title: 'Unknown Legion ID Troop' });
      await setUserField('newbie', 'costume', '');

      await loginAs(page, 'newbie');
      await page.goto(`/rsvp.php?id=${eventId}`);
      await page.locator('#rsvp_submit').click();

      await page.locator('#prereq_tk_id').fill('33151');
      await page.locator('#prereq_preferred_name').fill('Newt');
      await page.locator('#prereq_mobile').fill('0400 999 999');
      await page.locator('#prereq_emergency_contact').fill('Next Of Kin 0400 888 888');
      await page.locator('#rsvp_submit').click();

      // The same step again, with the costume field alone and nothing to complain about.
      await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'prerequisites');
      await expect(page.locator('#rsvp_errors')).toHaveCount(0);
      await expect(page.locator('#prereq_costume')).toBeVisible();
      await expect(page.locator('#prereq_tk_id')).toHaveCount(0);
      await expect(page.locator('#rsvp_wrangle_instead')).toBeVisible();
      expect(legionApiRequests()).toEqual(['/legionId/33151/costumes']);

      await page.locator('#prereq_costume').fill(TK);
      await page.locator('#rsvp_submit').click();
      await expect(page.locator('#rsvp_page')).toHaveAttribute('data-rsvp-step', 'confirm');
      await expect(page.locator('#rsvp_costumes_from_api')).toHaveCount(0);
    });

    test('shows who it belongs to as it is typed', async ({ page }) => {
      const eventId = await createEvent({ title: 'Lookup Troop' });
      stubLegionApi(33151, {
        body: {
          ...(legionApiMember(33151, [
            { costumeName: 'Stormtrooper: ANH Stunt ', designation: 'TK' },
            { costumeName: 'Snowtrooper', designation: 'TS' },
          ]) as { body: object }).body,
          fullName: 'Newt Trooper',
          garrisonName: 'Southern Cross Garrison',
        },
      });
      stubLegionApi(4242, { body: { memberStatus: 'Classified Record' } });

      await loginAs(page, 'newbie');
      await page.goto(`/rsvp.php?id=${eventId}`);
      await page.locator('#rsvp_submit').click();

      const lookup = page.locator('#prereq_tk_id_lookup');
      await expect(lookup).toBeHidden();

      await page.locator('#prereq_tk_id').fill('TK-33151');
      await expect(lookup.locator('.events_legion_lookup_member')).toHaveText('Newt Trooper - Southern Cross Garrison');
      await expect(lookup.locator('.events_legion_lookup_costumes li')).toHaveText([
        'TK - Stormtrooper: ANH Stunt',
        'TS - Snowtrooper',
      ]);

      await page.locator('#prereq_tk_id').fill('4242');
      await expect(lookup).toHaveText('No 501st member found with this Legion ID.');

      // The API down is no answer at all, rather than a claim the ID is unknown.
      await page.locator('#prereq_tk_id').fill('777');
      await expect(lookup).toBeHidden();

      await page.locator('#prereq_tk_id').fill('');
      await expect(lookup).toBeHidden();
    });

    test('will not look anybody up without the post key', async ({ page }) => {
      await loginAs(page, 'newbie');
      await page.goto('/index.php');
      stubLegionApi(33151, legionApiMember(33151, [{ costumeName: 'Stormtrooper', designation: 'TK' }]));

      const body = await page.evaluate(async () => {
        const response = await fetch('xmlhttp.php?action=events_legion_lookup&legion_id=33151', { credentials: 'same-origin' });
        return response.text();
      });

      expect(body).not.toContain('found');
      expect(legionApiRequests()).toEqual([]);
    });
  });
});

