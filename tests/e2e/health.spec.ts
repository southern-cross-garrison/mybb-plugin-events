import { test, expect } from '../helpers/fixtures';
import { runPhp } from '../helpers/container';
import { loginAs } from '../helpers/auth';
import { createEvent, createRsvp, getEventDays, fixtures } from '../helpers/db';

const TK = fixtures().costumeOptions[0];

/**
 * Broad sweeps that would otherwise only be noticed as a subtly wrong-looking page:
 * PHP notices and SQL errors are logged rather than shown, so they are checked directly.
 */
test.describe('runtime health', () => {
  test('every plugin page renders without a PHP warning or SQL error', async ({ page }) => {
    await runPhp(`
@unlink('/var/www/html/cache/mybb_errors.log');
@unlink('/var/log/php_errors.log');
echo "cleared";
`);

    const eventId = await createEvent({
      title: 'Health Check Troop',
      days: [{ date: '2026-10-17' }, { date: '2026-10-18' }],
    });
    const dayIds = (await getEventDays(eventId)).map((day: any) => Number(day.id));
    await createRsvp(eventId, 'trooper1', { costumes: [TK], dayIds });

    await loginAs(page, 'gec');
    for (const url of [
      '/events.php',
      '/events.php?view=calendar',
      '/events.php?region=Sydney',
      `/event.php?id=${eventId}`,
      `/event.php?id=${eventId}&action=rsvps`,
      `/event.php?id=${eventId}&action=attendance`,
      `/rsvp.php?id=${eventId}`,
    ]) {
      const response = await page.goto(url);
      expect(response?.status(), `${url} should not error`).toBeLessThan(400);
      await expect(page.locator('body'), `${url} should not show a MyBB SQL error`).not.toContainText('MyBB SQL Error');
    }

    // ical.php is a file download, so it is fetched rather than navigated to.
    const ical = await page.request.get(`/ical.php?id=${eventId}`);
    expect(ical.status()).toBe(200);
    expect(await ical.text()).not.toContain('MyBB SQL Error');

    const log = await runPhp(`
foreach(array('/var/www/html/cache/mybb_errors.log', '/var/log/php_errors.log') as $file)
{
    if(file_exists($file)) { echo file_get_contents($file); }
}
echo "END_OF_LOG";
`);

    const relevant = log
      .replace('END_OF_LOG', '')
      .split('\n')
      .filter((line) => /events|event_plugin|rsvp|troop/i.test(line))
      .join('\n');

    expect(relevant, `PHP or MyBB logged errors from the plugin:\n${relevant}`).toBe('');
  });
});
