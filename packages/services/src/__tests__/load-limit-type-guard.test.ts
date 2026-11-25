// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Guard: the stored allocation records (`AppliedAllocation`, its credit, EVSE
// and default records, and `LimitRecord`) are read for what a station may hold
// only through `mightEnforceKw` and its twins in load-limit-entries.ts. This
// test type-checks the services source and fails on any read of a value field
// of those types outside the state model, unless the read is listed below with
// the reason it does not count what a station holds.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

// The scans run in a child process: coverage instrumentation of the TypeScript
// compiler makes them several times slower inside the test worker.
const SCAN = join(ROOT, 'packages/services/src/__tests__/helpers/load-limit-scan.ts');
function runScan(request: Record<string, unknown>): unknown {
  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', SCAN, JSON.stringify({ root: ROOT, ...request })],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out) as unknown;
}

const RECORD_TYPES = new Set([
  'AppliedAllocation',
  'AppliedCredit',
  'AppliedEvseLimit',
  'AppliedEvseDefault',
  'LimitRecord',
]);

/** The state model, its service rule and its database writer. */
const RECORD_OWNERS = new Set([
  'packages/lib/src/load-limit-state.ts',
  'packages/services/src/load-limit-entries.ts',
  'packages/database/src/lib/load-management-state.ts',
]);

/** Fields that hold what a limit is or may be at the station. */
const VALUE_FIELDS = new Set([
  'allocatedKw',
  'allocatedBaseKw',
  'reserved',
  'limit',
  'limitKw',
  'limitA',
  'credit',
  'until',
]);

/** `<file>#<top-level function>`: the value fields it may read, and why. */
const ALLOWED_READS: Record<string, { fields: string[]; reason: string }> = {
  'packages/services/src/load-management-send.ts#allocationKey': {
    fields: ['allocatedKw', 'reserved', 'allocatedBaseKw', 'limitKw', 'limitA'],
    reason: 'change detection: a hash of what was sent, never a count',
  },
  'packages/services/src/load-management-site-allocation.ts#withHeldEvseLimits': {
    fields: ['limitKw', 'limitA'],
    reason: 'the EVSE limit last sent, compared with the draw; it only lowers that demand',
  },
  'packages/services/src/load-management-unit-boxes.ts#evseLimitUnits': {
    fields: ['limitKw', 'limitA'],
    reason: 'the kW to A ratio of a sent EVSE limit, a unit conversion',
  },
  'packages/services/src/session-profile-cap.ts#sessionProfileCapFrom': {
    fields: ['limitKw'],
    reason: 'caps the ISO 15118 profile at the EVSE limit sent; a cap only lowers it',
  },
  'packages/services/src/charging-plan-input.ts#unplannedHoldKw': {
    fields: ['reserved'],
    reason: 'picks the mightEnforceKw value unless the station was a reservation',
  },
  'packages/services/src/load-management-credit-refresh.ts#refreshCreditProfiles': {
    fields: ['allocatedBaseKw', 'reserved', 'credit', 'until'],
    reason: 'when to resend a credit profile; a missed resend lets it end, the safe side',
  },
  'packages/services/src/load-management-credit-refresh.ts#countedLimits': {
    fields: ['reserved'],
    reason: 'copies the reservation flag into the counted limit',
  },
  'packages/services/src/load-management.service.ts#runSiteLoadManagement': {
    fields: ['until'],
    reason: 'the credit end passed to creditMayHold and the replacement end',
  },
};

/** Files outside services that read the records; each reads identity fields only. */
const OTHER_READERS = [
  'packages/api/src/routes/load-management.ts',
  'packages/api/src/services/depot-system-information.ts',
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '__tests__', '__integration__'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** Every read of a value field of a record type in the services source, scanned once. */
let reads: string[] | null = null;
function valueReads(): string[] {
  reads ??= runScan({
    scan: 'valueReads',
    recordTypes: [...RECORD_TYPES],
    owners: [...RECORD_OWNERS],
    valueFields: [...VALUE_FIELDS],
  }) as string[];
  return reads;
}

describe('load management record value reads', () => {
  it('read a value field only in the state model or a listed function', { timeout: 30_000 }, () => {
    const reads = valueReads();
    expect(reads.length).toBeGreaterThan(0);
    const offenders = reads.filter((read) => {
      const [where = '', typed = ''] = read.split(' ');
      const field = typed.split('.')[1] ?? '';
      return !(ALLOWED_READS[where]?.fields.includes(field) ?? false);
    });
    expect(offenders).toEqual([]);
  });

  it('lists only reads that exist', { timeout: 30_000 }, () => {
    const reads = new Set(valueReads().map((r) => r.split(' ')[0]));
    expect(Object.keys(ALLOWED_READS).filter((where) => !reads.has(where))).toEqual([]);
  });

  it('names the record types outside services only in the listed readers', () => {
    const pattern =
      /\b(?:AppliedAllocation|AppliedCredit|AppliedEvseLimit|AppliedEvseDefault|parseAppliedAllocations)\b/;
    const found = readdirSync(join(ROOT, 'packages'))
      .filter((pkg) => pkg !== 'services')
      .flatMap((pkg) => {
        try {
          return sourceFiles(join(ROOT, 'packages', pkg, 'src'));
        } catch {
          // fail-open: a package without a src folder holds no source to scan
          return [];
        }
      })
      .map((path) => relative(ROOT, path).split('\\').join('/'))
      .filter((rel) => !RECORD_OWNERS.has(rel))
      .filter((rel) => pattern.test(readFileSync(join(ROOT, rel), 'utf8')));
    expect(found.sort()).toEqual([...OTHER_READERS].sort());
  });
});
