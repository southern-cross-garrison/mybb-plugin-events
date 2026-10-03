import fs from 'node:fs';
import path from 'node:path';
import { BASE_URL, FAKETIME_FILE, TEST_NOW } from './config';

/**
 * Clock control for the web container.
 *
 * The container runs with libfaketime preloaded and FAKETIME_TIMESTAMP_FILE pointing at
 * a bind-mounted file, so writing that file moves PHP's idea of "now" for both Apache
 * requests and CLI runs - without touching the host clock or the database.
 *
 * The control file always holds a *relative* offset in seconds ("+1209600"). libfaketime resolves
 * an absolute "@" spec against each process's start time, which means long-lived Apache
 * workers drift away from the requested instant; an offset is applied to the real clock
 * on every call and therefore stays put.
 */

const toEpochSeconds = (mysqlDateTime: string): number =>
	Date.parse(`${mysqlDateTime.replace(' ', 'T')}Z`) / 1000;

const toMysqlDateTime = (epochSeconds: number): string =>
	new Date(epochSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ');

/**
 * Replaced by rename, never rewritten in place. FAKETIME_NO_CACHE has every process in the
 * container re-read the file on every clock call, and libfaketime 0.9.13 exit()s a process
 * that reads it empty or half-written - which is what a truncate-then-write leaves it for
 * an instant. When the reader was Apache's parent the whole container went down, and the
 * rest of the run failed on "Could not read the container clock".
 */
function write(spec: string): void {
	fs.mkdirSync(path.dirname(FAKETIME_FILE), { recursive: true });
	const staging = `${FAKETIME_FILE}.${process.pid}.tmp`;
	fs.writeFileSync(staging, spec);
	fs.renameSync(staging, FAKETIME_FILE);
}

/** What PHP inside the container currently thinks the time is. */
export async function readContainerClock(attempts = 5): Promise<string> {
	let lastError: unknown;

	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			const response = await fetch(`${BASE_URL}/_clockprobe.php`);
			if (!response.ok) {
				throw new Error(`clock probe returned HTTP ${response.status}`);
			}
			return (await response.text()).trim();
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}

	throw new Error(
		`Could not read the container clock at ${BASE_URL}/_clockprobe.php ` +
			`(${(lastError as Error)?.message}). Is the dev environment bootstrapped?`
	);
}

/**
 * Move the container clock to an absolute instant, e.g. "2026-10-05 18:30:00".
 *
 * The clock keeps ticking from there at normal speed, so tests should treat the instant
 * as "no earlier than" rather than frozen. A tolerance of a couple of minutes is applied
 * when verifying, which is far tighter than any interval the plugin cares about.
 */
export async function setClock(when: string): Promise<void> {
	const target = toEpochSeconds(when);
	if (Number.isNaN(target)) {
		throw new Error(`setClock expects "YYYY-MM-DD HH:MM:SS", got "${when}"`);
	}

	// Round up so the container clock is never left a fraction of a second *before* the
	// requested instant, which would make boundary assertions flap.
	const offset = Math.ceil(target - Date.now() / 1000);
	// No unit: seconds are the default, and libfaketime 0.9.13 kills the process over an
	// "s" suffix that older versions let pass.
	write(`${offset >= 0 ? '+' : '-'}${Math.abs(offset)}`);

	await waitForClock(
		(observed) => Math.abs(toEpochSeconds(observed) - target) <= 120,
		`clock to reach ${when}`
	);
}

/** Move the clock forward (or backward) from wherever it currently is. */
export async function advanceClock(offset: {
	days?: number;
	hours?: number;
	minutes?: number;
	seconds?: number;
}): Promise<string> {
	const current = toEpochSeconds(await readContainerClock());
	const target = toMysqlDateTime(current + offsetInSeconds(offset));
	await setClock(target);
	return target;
}

/** Hand the container back the real wall clock. */
export async function resetClock(): Promise<void> {
	write('+0');
}

/** Put the clock at the suite's canonical starting instant. */
export async function resetToTestNow(): Promise<void> {
	await setClock(TEST_NOW);
}

function offsetInSeconds(offset: {
	days?: number;
	hours?: number;
	minutes?: number;
	seconds?: number;
}): number {
	return (
		(offset.days ?? 0) * 86_400 +
		(offset.hours ?? 0) * 3_600 +
		(offset.minutes ?? 0) * 60 +
		(offset.seconds ?? 0)
	);
}

async function waitForClock(
	matches: (observed: string) => boolean,
	description: string
): Promise<void> {
	const deadline = Date.now() + 10_000;
	let last = '';

	while (Date.now() < deadline) {
		last = await readContainerClock();
		if (matches(last)) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	throw new Error(`Timed out waiting for ${description}; container clock reads ${last}`);
}

/**
 * Format an offset from the suite's fixed "now" as a MySQL datetime.
 *
 * e.g. relativeToTestNow({ days: 7 }) -> "2026-10-08 09:00:00"
 */
export function relativeToTestNow(offset: {
	days?: number;
	hours?: number;
	minutes?: number;
	seconds?: number;
}): string {
	return relativeTo(TEST_NOW, offset);
}

/** Format an offset from an arbitrary base datetime as a MySQL datetime. */
export function relativeTo(
	base: string,
	offset: { days?: number; hours?: number; minutes?: number; seconds?: number }
): string {
	return toMysqlDateTime(toEpochSeconds(base) + offsetInSeconds(offset));
}
