// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// P3: the panels and circuits tables have one writer,
// packages/database/src/lib/load-management-tree.ts (the panel and circuit
// routes and the seeds call it, and it writes the site audit row).

const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const SKIP_DIRS = new Set(['__tests__', '__integration__', 'dist', 'generated', 'node_modules']);

/** Files allowed to write panels and circuits, as paths relative to `packages/`. */
const ALLOWED: RegExp[] = [/^database\/src\/lib\/load-management-tree\.ts$/];

const WRITE_PATTERNS: RegExp[] = [
  // Drizzle `.insert(panels)`, `.update(circuits)`, `.delete(panels)`.
  /\.(?:insert|update|delete)\(\s*(?:panels|circuits)\s*\)/g,
  // Raw SQL INSERT, UPDATE or DELETE of either table.
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(?:panels|circuits)"?(?![\w.])/g,
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

describe('load management tree writer guard', () => {
  it('writes panels and circuits only in the load management tree writer', () => {
    expect(findWrites()).toEqual([]);
  });

  it('catches a drizzle and a raw SQL write, and passes a read', () => {
    const samples = [
      'await db.insert(panels).values(rows)',
      'await tx.update(circuits).set({ name })',
      'await db.delete(panels).where(eq(panels.id, id))',
      'await sql`INSERT INTO panels (id) VALUES (${id})`',
      'await sql`UPDATE circuits SET name = ${name}`',
      'DELETE FROM "panels" WHERE id = $1',
    ];
    for (const sample of samples) {
      const hit = WRITE_PATTERNS.some((p) => {
        p.lastIndex = 0;
        return p.test(sample);
      });
      expect(hit, sample).toBe(true);
    }
    for (const read of [
      'SELECT * FROM panels WHERE site_id = $1',
      'db.select().from(circuits)',
      'UPDATE charging_stations SET circuit_id = NULL',
      'UPDATE panels_view SET x = 1',
    ]) {
      expect(
        WRITE_PATTERNS.some((p) => ((p.lastIndex = 0), p.test(read))),
        read,
      ).toBe(false);
    }
  });
});
