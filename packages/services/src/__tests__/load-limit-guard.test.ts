// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Guard: what a station might enforce has one rule, `mightEnforceKw` (and its
// EVSE and draw bound twins) in load-limit-entries.ts. This test parses the
// source of every package and fails when code elsewhere reads a limit record
// (`mightKw`, `sentKw`, a record's `limit.state` or `limit.commandId`, the
// transition functions), reads a stored entry's raw `allocatedKw` as a limit,
// or names a field of the earlier derived model, so no consumer can count a
// station another way.

import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
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

/** The state model, its service rule and its database writer. */
const RECORD_OWNERS = new Set([
  'packages/lib/src/load-limit-state.ts',
  'packages/services/src/load-limit-entries.ts',
  'packages/database/src/lib/load-management-state.ts',
]);

/** Reading or moving a limit record. */
const RECORD_NAMES = new Set([
  'mightKw',
  'sentKw',
  'limit.state',
  'limit.commandId',
  'limitMightKw',
  'limitTransition',
  'creditTransition',
]);

/**
 * A stored entry's allocation read from the raw row (`entry['allocatedKw']`):
 * the allocation of the last cycle says nothing about what the station holds.
 */
const RAW_ENTRY_NAMES = new Set(['allocatedKw']);

/** Fields of the derived model the state records replaced. */
const REMOVED_NAMES = new Set([
  'confirmedKw',
  'unconfirmedKw',
  'unconfirmed',
  'limitPending',
  'creditUntil',
  'awaitingReply',
  'sentCommandId',
  'sentLimit',
  'sentUnit',
  'enforcedLimitKw',
  'sendLostEntry',
]);

interface NameUse {
  name: string;
  line: number;
}

// Parsed once for both checks: every package's source, the uses of the tracked names.
let parsed: Array<{ rel: string; uses: NameUse[]; raw: NameUse[] }> | null = null;
function parsedFiles(): Array<{ rel: string; uses: NameUse[]; raw: NameUse[] }> {
  parsed ??= runScan({
    scan: 'names',
    names: [...RECORD_NAMES, ...REMOVED_NAMES],
    rawNames: [...RAW_ENTRY_NAMES],
  }) as Array<{ rel: string; uses: NameUse[]; raw: NameUse[] }>;
  return parsed;
}

describe('load management limit records', () => {
  it('scans the source of the packages', { timeout: 30_000 }, () => {
    const files = parsedFiles().map((f) => f.rel);
    expect(files.some((f) => f.endsWith('load-limit-entries.ts'))).toBe(true);
    expect(files.length).toBeGreaterThan(500);
  });

  it(
    'are read and moved only by the state model, its rule and its writer',
    { timeout: 30_000 },
    () => {
      const offenders: string[] = [];
      for (const { rel, uses, raw } of parsedFiles()) {
        if (RECORD_OWNERS.has(rel)) continue;
        for (const use of uses) {
          if (RECORD_NAMES.has(use.name)) offenders.push(`${rel}:${String(use.line)} ${use.name}`);
        }
        for (const use of raw) {
          if (RAW_ENTRY_NAMES.has(use.name)) {
            offenders.push(`${rel}:${String(use.line)} ['${use.name}']`);
          }
        }
      }
      expect(offenders).toEqual([]);
    },
  );

  it('leave no field of the earlier derived model in the source', { timeout: 30_000 }, () => {
    const offenders: string[] = [];
    for (const { rel, uses } of parsedFiles()) {
      for (const use of uses) {
        if (REMOVED_NAMES.has(use.name)) offenders.push(`${rel}:${String(use.line)} ${use.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
