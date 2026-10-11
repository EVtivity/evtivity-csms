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

function findWrites(): string[] {
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
      if (ALLOWED.some((re) => re.test(rel))) continue;
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      for (const pattern of WRITE_PATTERNS) {
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
