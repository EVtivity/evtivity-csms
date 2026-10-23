// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Deleting a `charging_stations` row cascades the SIM attachments of the
 * station away, so no attachment close raises the history floor of the SIM it
 * held, and the SIM's rows from that station would show on its next station.
 * Every server source file that deletes station rows calls
 * `raiseStationSimHistoryFloor` (`lib/sim-inventory.ts`) first. A new delete
 * path fails here until it does.
 *
 * `payment_terminals` has the same cascade to `sim_attachments` and no delete
 * path yet. When terminal deletes are added, extend this guard to them (a
 * terminal delete raises the floor of the SIM the terminal holds first).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGES = resolve(import.meta.dirname, '../../..');

const STATION_DELETE =
  /DELETE\s+FROM\s+"?charging_stations"?\b|\.delete\(\s*chargingStations\s*\)/i;
const FLOOR_WRITER = /\braiseStationSimHistoryFloor\(/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    if (name === '__tests__' || name === '__integration__' || name === 'e2e') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

function packageSources(): string[] {
  return readdirSync(PACKAGES).flatMap((pkg) => {
    const src = join(PACKAGES, pkg, 'src');
    return existsSync(src) && statSync(src).isDirectory() ? sourceFiles(src) : [];
  });
}

describe('station deletes raise the SIM history floor first', () => {
  it('every file that deletes charging_stations rows calls raiseStationSimHistoryFloor', () => {
    const deleting = packageSources().filter((file) =>
      STATION_DELETE.test(readFileSync(file, 'utf8')),
    );
    // The scan finds the known paths, so a broken pattern cannot pass silently.
    expect(deleting.map((file) => relative(PACKAGES, file)).sort()).toEqual(
      expect.arrayContaining(['database/src/lib/conformance-stations.ts']),
    );
    const missing = deleting
      .filter((file) => !FLOOR_WRITER.test(readFileSync(file, 'utf8')))
      .map((file) => relative(PACKAGES, file));
    expect(missing).toEqual([]);
  });
});
