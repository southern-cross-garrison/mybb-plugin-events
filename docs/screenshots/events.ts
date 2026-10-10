import fs from 'fs';
import path from 'path';
import { createEvent, EventInput, getSetting } from '../../tests/helpers/db';
import { runPhp } from '../../tests/helpers/container';
import { REPO_ROOT } from '../../tests/helpers/config';
import { withSettings } from '../../tests/helpers/settings';
import { clearRegionUnits, setRegionUnits } from '../../tests/helpers/units';

/**
 * Create an event and announce it, the way saving it as Live from the form does.
 *
 * On the forum an event *is* its announcement thread: the event card sits in place of the
 * first post, under the thread's title and its Post Reply buttons, and event.php sends
 * people there. An event created straight into the database has no thread, so event.php
 * shows the bare card instead - which is not a page any member ever sees. Pending events
 * aren't announced, so create those with createEvent().
 */
export async function createAnnouncedEvent(input: EventInput): Promise<number> {
	const eventId = await createEvent(input);
	const output = await runPhp(`
require_once MYBB_ROOT.'inc/plugins/events/inc/events_thread.php';
echo events_sync_event_thread(${eventId});
`);

	if (!(Number(output.trim()) > 0)) {
		throw new Error(`Event ${eventId} was not announced: ${output}`);
	}

	return eventId;
}

/** The border region the guides use for events another garrison runs. */
export const BORDER_REGION = 'Queensland';
export const BORDER_UNIT = 'Redback Garrison';

/**
 * Add Queensland to the region list, run by Redback Garrison with its own logo, and hand
 * back the call that puts the board as it was.
 *
 * Written as settings rather than through the Admin CP: the pictures are of what the
 * board looks like with such a region, not of adding one.
 */
export async function withBorderRegion(): Promise<() => Promise<void>> {
	const restoreRegions = await withSettings({
		events_regions: `${await getSetting('events_regions')},${BORDER_REGION}`,
	});
	await setRegionUnits({
		[BORDER_REGION]: {
			unit: BORDER_UNIT,
			logo: {
				buffer: fs.readFileSync(path.join(REPO_ROOT, 'docs/screenshots/redback-garrison.png')),
				extension: 'png',
			},
		},
	});

	return async () => {
		await clearRegionUnits();
		await restoreRegions();
	};
}
