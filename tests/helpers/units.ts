import fs from 'fs';
import path from 'path';
import { FORUM_DIR } from './config';
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
 */
export async function setRegionUnits(units: RegionUnits): Promise<void> {
	const stored: Record<string, { unit: string; logo: string }> = {};

	for (const [region, entry] of Object.entries(units)) {
		let logo = '';
		if (entry.logo !== undefined) {
			const source = entry.logo;
			const [buffer, extension] =
				typeof source === 'string'
					? [source === 'svg' ? SVG : PNG, source]
					: [source.buffer, source.extension];
			fs.mkdirSync(LOGO_DIR, { recursive: true });
			const name = `unit_${'e2e0'.repeat(4)}${Object.keys(stored).length}.${extension}`;
			fs.writeFileSync(path.join(LOGO_DIR, name), buffer);
			logo = `uploads/events/${name}`;
		}
		stored[region] = { unit: entry.unit, logo };
	}

	await setSettings({ events_region_units: JSON.stringify(stored) });
}

/** Every region back to the garrison's own, and no logos left behind. */
export async function clearRegionUnits(): Promise<void> {
	if ((await getSetting('events_region_units')) !== '') {
		await setSettings({ events_region_units: '' });
	}

	for (const name of storedLogos()) {
		fs.rmSync(path.join(LOGO_DIR, name), { force: true });
	}
}
