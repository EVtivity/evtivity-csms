// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// P3: charging_stations.data_plan and sites.data_plan have one writer,
// packages/database/src/lib/station-data-plan.ts (setStationDataPlan,
// setSiteDataPlan), driven by the station data plan service. Routes pass the
// plan to the service and never write the column themselves.

const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const SKIP_DIRS = new Set(['__tests__', '__integration__', 'dist', 'generated', 'node_modules']);

/** Files allowed to write the data plan columns, as paths relative to `packages/`. */
const ALLOWED: RegExp[] = [
  /^database\/src\/lib\/station-data-plan\.ts$/,
  // Demo and fixture seeds (fresh databases only).
  /^database\/src\/seed[^/]*\.ts$/,
];

const WRITE_PATTERNS: RegExp[] = [
  // Drizzle `.set({ ... dataPlan ... })` and `.values({ ... dataPlan ... })`.
  /\.(?:set|values)\(\s*\{[^)]*\bdataPlan\b/g,
  // Raw SQL: an UPDATE assignment (`SET data_plan = ...`, `, data_plan = ...`;
  // a comparison such as `s.data_plan = 'cellular'` is a read), or an INSERT
  // column list naming it.
  /\b(?:SET\s+|,\s*)"?data_plan"?\s*=(?!=)/gi,
  /\bINSERT\s+INTO\s+(?:charging_stations|sites)\s*\([^)]*\bdata_plan\b/g,
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

function findWrites(): string[] {
  const violations: string[] = [];
  for (const pkg of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    let files: string[];
    try {
      files = sourceFiles(join(PACKAGES_DIR, pkg.name, 'src'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const file of files) {
      const rel = relative(PACKAGES_DIR, file).split(sep).join('/');
      if (ALLOWED.some((re) => re.test(rel))) continue;
      const text = readFileSync(file, 'utf8');
      for (const pattern of WRITE_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) != null) {
          const line = text.slice(0, match.index).split('\n').length;
          violations.push(`${rel}:${String(line)}`);
        }
      }
    }
  }
  return violations;
}

describe('station data plan writer guard', () => {
  it('writes data_plan only in the station data plan writer', () => {
    expect(findWrites()).toEqual([]);
  });

  it('catches a drizzle and a raw SQL write', () => {
    const samples = [
      'await db.update(sites).set({ name, dataPlan: "cellular" })',
      'await sql`UPDATE charging_stations SET data_plan = ${plan}`',
      'UPDATE sites SET name = $1, data_plan = $2',
      'INSERT INTO sites (id, data_plan) VALUES (1, 2)',
    ];
    for (const sample of samples) {
      const hit = WRITE_PATTERNS.some((p) => {
        p.lastIndex = 0;
        return p.test(sample);
      });
      expect(hit, sample).toBe(true);
    }
    const read = "CASE WHEN s.data_plan = 'cellular' THEN 1 END";
    expect(WRITE_PATTERNS.some((p) => ((p.lastIndex = 0), p.test(read)))).toBe(false);
  });
});
