import fs from 'node:fs';
import path from 'node:path';
import { FORUM_DIR, REPO_ROOT } from './config';

/**
 * The 501st Legion API stand-in (tests/stubs/legion-api.php).
 *
 * Provisioning points events_legion_api_url at it, so the plugin never reaches the real
 * API from the suite. With no answer stubbed it responds 503 - the API is down - and the
 * board falls back to the costumes on file, which is what every test not about the API
 * relies on.
 */
const STUB_FILE = path.join(FORUM_DIR, 'e2e-legion-api.php');
const STUB_DIR = path.join(FORUM_DIR, 'e2e-legion-api');
const REQUEST_LOG = path.join(STUB_DIR, 'requests.log');

export interface LegionApiCostume {
  costumeName: string;
  designation?: string;
}

export type LegionApiResponse =
  | { status?: number; body: unknown }
  | { status?: number; raw: string };

/** Put the stub in the forum root with no answers stubbed. Run by global setup. */
export function installLegionApiStub(): void {
  fs.copyFileSync(path.join(REPO_ROOT, 'tests', 'stubs', 'legion-api.php'), STUB_FILE);
  resetLegionApiStub();
}

/** Forget every stubbed answer and every logged request. */
export function resetLegionApiStub(): void {
  fs.rmSync(STUB_DIR, { recursive: true, force: true });
  fs.mkdirSync(STUB_DIR, { recursive: true });
  // Apache writes the request log, and on Linux it is not the user that made the folder.
  fs.chmodSync(STUB_DIR, 0o777);
}

/** Say what the API answers for one Legion ID (digits, as the plugin requests it). */
export function stubLegionApi(legionId: number | string, response: LegionApiResponse): void {
  fs.writeFileSync(path.join(STUB_DIR, `${legionId}.json`), JSON.stringify(response));
}

/** A member record carrying these costumes, shaped as the real API returns one. */
export function legionApiMember(legionId: number, costumes: LegionApiCostume[]): LegionApiResponse {
  return {
    body: {
      legionId,
      formattedLegionId: `TK ${legionId}`,
      fullName: 'Fixture Trooper',
      memberStatus: 'Active',
      garrisonName: 'Fixture Garrison',
      costumes: costumes.map((costume) => ({
        designation: 'TK',
        designationName: 'Stormtrooper',
        formattedLegionId: `${costume.designation ?? 'TK'} ${legionId}`,
        ...costume,
      })),
    },
  };
}

/** The paths the plugin has requested since the last reset, oldest first. */
export function legionApiRequests(): string[] {
  if (!fs.existsSync(REQUEST_LOG)) {
    return [];
  }
  return fs.readFileSync(REQUEST_LOG, 'utf8').split('\n').filter(Boolean);
}
