// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// driver_event_settings, driver_notification_preferences and
// driver_notification_event_preferences have one writer,
// packages/database/src/lib/driver-notification-settings.ts (discussion 56):
// the operator switch, the mandatory channels and the driver choices are the
// three layers the dispatcher applies, so no route writes one around the others.

const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const SKIP_DIRS = new Set(['__tests__', '__integration__', 'dist', 'generated', 'node_modules']);

const ALLOWED = /^database\/src\/lib\/driver-notification-settings\.ts$/;

const DRIZZLE_TABLES =
  'driverEventSettings|driverNotificationPreferences|driverNotificationEventPreferences';
const SQL_TABLES =
  'driver_event_settings|driver_notification_preferences|driver_notification_event_preferences';

const WRITE_VERB = String.raw`(?:INSERT\s+INTO|UPDATE(?:\s+ONLY)?|DELETE\s+FROM(?:\s+ONLY)?|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?(?:\s+ONLY)?)`;

const WRITE_PATTERNS: RegExp[] = [
  // Drizzle builders, also through a namespace import (schema.driverEventSettings).
  new RegExp(`\\.(?:insert|update|delete)\\(\\s*(?:\\w+\\.)?(?:${DRIZZLE_TABLES})\\s*\\)`, 'g'),
  // Raw SQL by name, also schema-qualified or quoted ("public"."driver_event_settings").
  new RegExp(`\\b${WRITE_VERB}\\s+(?:"?\\w+"?\\.)?"?(?:${SQL_TABLES})"?(?![\\w])`, 'gi'),
  // Raw SQL with the drizzle table interpolated: sql`UPDATE ${driverEventSettings} ...`.
  new RegExp(`\\b${WRITE_VERB}\\s+\\$\\{\\s*(?:\\w+\\.)?(?:${DRIZZLE_TABLES})\\s*\\}`, 'gi'),
  // A table among others in one TRUNCATE.
  new RegExp(`\\bTRUNCATE\\b[^;\`\n]*?\\b(?:${SQL_TABLES})\\b`, 'gi'),
  // A table named through sql.identifier, which hides it from the patterns above.
  new RegExp(`\\bsql\\.identifier\\(\\s*['"\`](?:${SQL_TABLES})['"\`]\\s*\\)`, 'g'),
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

function matches(sample: string): boolean {
  return WRITE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(sample);
  });
}

describe('driver notification writer guard', () => {
  it('writes the driver notification tables only in lib/driver-notification-settings.ts', () => {
    expect(findWrites()).toEqual([]);
  });

  it('finds a drizzle and a raw SQL write of each table', () => {
    for (const sample of [
      'await tx.insert(driverEventSettings).values({})',
      'await db.update(driverNotificationPreferences).set({ smsEnabled: false })',
      'await db.delete( driverNotificationEventPreferences )',
      'UPDATE driver_event_settings SET email_mandatory = true',
      'INSERT INTO "driver_notification_event_preferences" (driver_id) VALUES ($1)',
      'DELETE FROM driver_notification_preferences WHERE driver_id = $1',
      'await sql`UPDATE ${driverEventSettings} SET is_enabled = ${v}`',
      "const t = sql.identifier('driver_event_settings')",
    ]) {
      expect(matches(sample), sample).toBe(true);
    }
  });

  it('lets reads through', () => {
    for (const sample of [
      'SELECT is_enabled FROM driver_event_settings WHERE event_type = $1',
      'await db.select().from(driverNotificationPreferences)',
      'LEFT JOIN driver_notification_preferences p ON p.driver_id = $1',
    ]) {
      expect(matches(sample), sample).toBe(false);
    }
  });
});
