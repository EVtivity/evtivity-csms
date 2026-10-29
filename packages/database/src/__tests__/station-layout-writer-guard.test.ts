// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// P3: station_layout_positions has one writer, packages/database/src/lib/station-layout.ts.
// Station create, the CSV import, a site move and the layout Save call it, so a
// station is always placed on a free slot of its own site.

const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const SKIP_DIRS = new Set(['__tests__', '__integration__', 'dist', 'generated', 'node_modules']);

const ALLOWED = /^database\/src\/lib\/station-layout\.ts$/;

const WRITE_PATTERNS: RegExp[] = [
  /\.(?:insert|update|delete)\(\s*stationLayoutPositions\s*\)/g,
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?station_layout_positions"?/gi,
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
      if (ALLOWED.test(rel)) continue;
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

describe('station layout writer guard', () => {
  it('writes station_layout_positions only in lib/station-layout.ts', () => {
    expect(findWrites()).toEqual([]);
  });

  it('finds a write outside the module', () => {
    const text = 'await tx.insert(stationLayoutPositions).values({});';
    const pattern = WRITE_PATTERNS[0];
    expect(pattern).toBeDefined();
    pattern!.lastIndex = 0;
    expect(pattern!.test(text)).toBe(true);
  });
});
