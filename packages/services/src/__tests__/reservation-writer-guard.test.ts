// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// TC-RES-30 (P3): the reservations table has a fixed set of writers. Routes,
// projections and jobs call the reservation service instead of writing rows.

const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const SKIP_DIRS = new Set(['__tests__', '__integration__', 'dist', 'generated', 'node_modules']);

/** Files allowed to write `reservations`, as paths relative to `packages/`. */
const ALLOWED: RegExp[] = [
  // The reservation service: create, edit, reassign, station ack.
  /^services\/src\/reservation\.service\.ts$/,
  // The guarded cancel every cancel path calls.
  /^services\/src\/reservation-cancel\.ts$/,
  // Expiry, no-show fee state, station outage cancels.
  /^services\/src\/reservation-expiry\.ts$/,
  // Worker activation and expiry jobs.
  /^worker\/src\/handlers\/reservation-[^/]+\.ts$/,
  // OCPP projections: ReserveNow answer, ReservationStatusUpdate.
  /^ocpp\/src\/server\/reservation-projections\.ts$/,
  // Demo and fixture seeds (fresh databases only, no live reservation).
  /^database\/src\/seed[^/]*\.ts$/,
];

const WRITE_PATTERNS: RegExp[] = [
  // Drizzle builders, also split over lines: `.update(\n reservations\n)`.
  /\.(?:insert|update|delete)\(\s*reservations\s*\)/g,
  // Raw SQL in a template literal.
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+reservations\b/g,
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...sourceFiles(join(dir, entry.name)));
    } else if (/\.(?:ts|tsx|mts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** Files allowed to write `fleet_reservations` (P3: the booking status has one writer). */
const FLEET_ALLOWED: RegExp[] = [
  // The status helper: the only UPDATE of a booking.
  /^services\/src\/fleet-reservation-status\.ts$/,
  // The fleet reservation create route inserts the booking with its first status.
  /^api\/src\/routes\/fleet-reservations\.ts$/,
  // Demo and fixture seeds.
  /^database\/src\/seed[^/]*\.ts$/,
];

const FLEET_WRITE_PATTERNS: RegExp[] = [
  /\.(?:insert|update|delete)\(\s*fleetReservations\s*\)/g,
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+fleet_reservations\b/g,
];

function findWrites(
  allowed: RegExp[] = ALLOWED,
  writePatterns: RegExp[] = WRITE_PATTERNS,
): string[] {
  const violations: string[] = [];
  for (const pkg of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const srcDir = join(PACKAGES_DIR, pkg.name, 'src');
    let files: string[];
    try {
      files = sourceFiles(srcDir);
    } catch (err) {
      // A package without src (assets only) has nothing to scan.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const file of files) {
      const rel = relative(PACKAGES_DIR, file).split(sep).join('/');
      if (allowed.some((re) => re.test(rel))) continue;
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      for (const pattern of writePatterns) {
        for (const match of text.matchAll(pattern)) {
          const lineNo = text.slice(0, match.index).split('\n').length;
          if (isCommentLine(lines[lineNo - 1] ?? '')) continue;
          violations.push(`packages/${rel}:${String(lineNo)}: ${match[0].replace(/\s+/g, ' ')}`);
        }
      }
    }
  }
  return violations.sort();
}

describe('reservation writer guard', () => {
  it('TC-RES-30: only the reservation service, cancel, expiry, worker jobs and OCPP reservation projections write reservations', () => {
    const violations = findWrites();
    expect(
      violations,
      `Write reservations through @evtivity/services (reservation.service, reservation-cancel, reservation-expiry):\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('TC-RES-30: the scan finds the allowed writers (the patterns still match)', () => {
    const text = readFileSync(join(PACKAGES_DIR, 'services/src/reservation.service.ts'), 'utf8');
    expect(text.match(WRITE_PATTERNS[0] as RegExp)?.length ?? 0).toBeGreaterThan(0);
    const expiry = readFileSync(join(PACKAGES_DIR, 'services/src/reservation-expiry.ts'), 'utf8');
    expect(expiry.match(WRITE_PATTERNS[1] as RegExp)?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('fleet reservation writer guard', () => {
  it('P3: only the fleet reservation status helper updates fleet_reservations; the create route inserts it', () => {
    const violations = findWrites(FLEET_ALLOWED, FLEET_WRITE_PATTERNS);
    expect(
      violations,
      `Write the fleet booking status through @evtivity/services/fleet-reservation-status:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('P3: the scan finds the helper and the route (the patterns still match)', () => {
    const helper = readFileSync(
      join(PACKAGES_DIR, 'services/src/fleet-reservation-status.ts'),
      'utf8',
    );
    expect(helper.match(FLEET_WRITE_PATTERNS[0] as RegExp)?.length ?? 0).toBeGreaterThan(0);
    const route = readFileSync(join(PACKAGES_DIR, 'api/src/routes/fleet-reservations.ts'), 'utf8');
    expect(route.match(FLEET_WRITE_PATTERNS[0] as RegExp)?.length ?? 0).toBe(1);
  });
});
