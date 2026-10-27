// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// P3: drivers.avatar_* has one writer, packages/api/src/services/driver-avatar.service.ts
// (the portal routes, the registration and the driver erasure call it), and users.avatar_*
// has one writer, packages/api/src/services/user-avatar.service.ts (the user avatar routes
// and the user delete call it). The two tables share the column names, so the guard also
// checks that each service writes only its own table.

const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const SKIP_DIRS = new Set(['__tests__', '__integration__', 'dist', 'generated', 'node_modules']);

/** Files allowed to write the avatar columns, as paths relative to `packages/`. */
const ALLOWED: RegExp[] = [
  /^api\/src\/services\/driver-avatar\.service\.ts$/,
  /^api\/src\/services\/user-avatar\.service\.ts$/,
  // The schemas declare the columns.
  /^database\/src\/schema\/drivers\.ts$/,
  /^database\/src\/schema\/identity\.ts$/,
];

const SERVICES = join(PACKAGES_DIR, 'api', 'src', 'services');

const COLUMNS = 'avatarKind|avatarOptions|avatarS3Key|avatarS3Bucket|avatarUpdatedAt';
const SQL_COLUMNS = 'avatar_kind|avatar_options|avatar_s3_key|avatar_s3_bucket|avatar_updated_at';

const WRITE_PATTERNS: RegExp[] = [
  // Drizzle `.set({ ... avatarKind ... })` and `.values({ ... avatarKind ... })`.
  new RegExp(`\\.(?:set|values)\\(\\s*\\{[^)]*\\b(?:${COLUMNS})\\b`, 'g'),
  // Raw SQL: an UPDATE assignment or an INSERT column list naming a column.
  new RegExp(`\\b(?:SET\\s+|,\\s*)"?(?:${SQL_COLUMNS})"?\\s*=(?!=)`, 'gi'),
  new RegExp(
    `\\bINSERT\\s+INTO\\s+"?(?:drivers|users)"?\\s*\\([^)]*\\b(?:${SQL_COLUMNS})\\b`,
    'gi',
  ),
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

/** The tables a service file updates or inserts into (drizzle `.update(x)` / `.insert(x)`). */
function writtenTables(file: string): string[] {
  const text = readFileSync(join(SERVICES, file), 'utf8');
  return [...text.matchAll(/\.(?:update|insert)\((\w+)\)/g)].map((m) => m[1] as string);
}

describe('avatar writer guard', () => {
  it('writes the avatar columns only in the driver and user avatar services', () => {
    expect(findWrites()).toEqual([]);
  });

  it('keeps one writer per table: the driver service writes drivers, the user service users', () => {
    expect(new Set(writtenTables('driver-avatar.service.ts'))).toEqual(new Set(['drivers']));
    expect(new Set(writtenTables('user-avatar.service.ts'))).toEqual(new Set(['users']));
  });

  it('catches a drizzle and a raw SQL write', () => {
    const samples = [
      'await db.update(drivers).set({ firstName, avatarKind: null })',
      'await sql`UPDATE drivers SET avatar_s3_key = ${key}`',
      'UPDATE drivers SET first_name = $1, avatar_options = $2',
      'INSERT INTO drivers (id, avatar_kind) VALUES (1, 2)',
    ];
    for (const sample of samples) {
      const hit = WRITE_PATTERNS.some((p) => {
        p.lastIndex = 0;
        return p.test(sample);
      });
      expect(hit, sample).toBe(true);
    }
    const read = 'SELECT d.avatar_kind FROM drivers d WHERE d.avatar_kind = $1';
    expect(WRITE_PATTERNS.some((p) => ((p.lastIndex = 0), p.test(read)))).toBe(false);
  });
});
