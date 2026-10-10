import fs from 'fs';
import path from 'path';
import { FORUM_DIR } from './config';
import { runPhp } from './container';
import { getSetting } from './db';
import { setSettings } from './settings';

/**
 * Regions run by another unit: the `events_region_units` setting, and the logos the
 * settings page stores under uploads/events/.
 */

export const LOGO_DIR = path.join(FORUM_DIR, 'uploads/events');

/** A 2x1 PNG, as an upload or as the logo a test seeds straight onto the board. */
export const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGM4w8DwH4QBD5MDlwov8gcAAAAASUVORK5CYII=',
	'base64'
);

/** A shield, so it reads as a garrison's emblem in the docs' screenshots. */
export const SVG = Buffer.from(
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 72">' +
		'<path d="M32 2 60 12v22c0 18-12 30-28 36C16 64 4 52 4 34V12z" fill="#1d3557"/>' +
		'<path d="m32 18 5 11 12 1-9 8 3 12-11-6-11 6 3-12-9-8 12-1z" fill="#f1c40f"/></svg>'
);

/** A stock logo by type, or a real image's bytes and the extension to store it under. */
export type LogoSource = 'png' | 'svg' | { buffer: Buffer; extension: string };

export type RegionUnits = Record<string, { unit: string; logo?: LogoSource }>;

export async function getRegionUnits(): Promise<Record<string, { unit: string; logo: string }>> {
	const value = await getSetting('events_region_units');
	return value === '' ? {} : JSON.parse(value);
}

/** The logo files the board holds, by name. */
export function storedLogos(): string[] {
	if (!fs.existsSync(LOGO_DIR)) return [];
	return fs.readdirSync(LOGO_DIR).filter((name) => name.startsWith('unit_'));
}

/**
 * Hand regions to other units without going through the settings page, for tests where
 * that is a precondition rather than the subject. A logo is written where the page would
 * have stored it.
 *
 * Written from inside the container as the web server's user, never from the host. On a
 * Linux host the forum is a bind mount that keeps ownership, so a folder the test runner
 * created would be one Apache could neither upload into nor delete from - which passes on
 * macOS, where the mount ignores ownership, and fails in CI.
 */
export async function setRegionUnits(units: RegionUnits): Promise<void> {
	const stored: Record<string, { unit: string; logo: string }> = {};
	const writes: string[] = [];

	for (const [region, entry] of Object.entries(units)) {
		let logo = '';
		if (entry.logo !== undefined) {
			const source = entry.logo;
			const [buffer, extension] =
				typeof source === 'string'
					? [source === 'svg' ? SVG : PNG, source]
					: [source.buffer, source.extension];
			logo = `uploads/events/unit_${'e2e0'.repeat(4)}${Object.keys(stored).length}.${extension}`;
			writes.push(
				`file_put_contents(MYBB_ROOT.'${logo}', base64_decode('${buffer.toString('base64')}'));`
			);
		}
		stored[region] = { unit: entry.unit, logo };
	}

	if (writes.length > 0) {
		await runPhp(
			`
if(!is_dir(MYBB_ROOT.'uploads/events')) { mkdir(MYBB_ROOT.'uploads/events', 0755, true); }
${writes.join('\n')}
`,
			{ user: 'www-data' }
		);
	}

	await setSettings({ events_region_units: JSON.stringify(stored) });
}

/**
 * Every region back to the garrison's own, and no logos left behind. Deleted by the
 * plugin's own uninstall helper, as the web server's user, for the reason above.
 */
export async function clearRegionUnits(): Promise<void> {
	if ((await getSetting('events_region_units')) !== '') {
		await setSettings({ events_region_units: '' });
	}

	if (storedLogos().length > 0) {
		await runPhp(
			`
require_once MYBB_ROOT.'inc/plugins/events/inc/events_units.php';
events_delete_all_unit_logos();
`,
			{ user: 'www-data' }
		);
	}
}
