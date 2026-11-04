// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// vehicle_departure_schedules, vehicle_departures, vehicle_departure_notices and
// site_charging_plans have one writer, packages/database/src/lib/vehicle-departures.ts.
// The departure service, the planner and the worker crons call it, so every
// status change stays guarded and every change is audited by the service.

const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const SKIP_DIRS = new Set(['__tests__', '__integration__', 'dist', 'generated', 'node_modules']);

const ALLOWED = /^database\/src\/lib\/vehicle-departures\.ts$/;

const DRIZZLE_TABLES =
  'vehicleDepartureSchedules|vehicleDepartures|vehicleDepartureNotices|siteChargingPlans';
const SQL_TABLES =
  'vehicle_departure_schedules|vehicle_departures|vehicle_departure_notices|site_charging_plans';

const WRITE_VERB = String.raw`(?:INSERT\s+INTO|UPDATE(?:\s+ONLY)?|DELETE\s+FROM(?:\s+ONLY)?|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?(?:\s+ONLY)?)`;

const WRITE_PATTERNS: RegExp[] = [
  // Drizzle builders, also through a namespace import (schema.vehicleDepartures).
  new RegExp(`\\.(?:insert|update|delete)\\(\\s*(?:\\w+\\.)?(?:${DRIZZLE_TABLES})\\s*\\)`, 'g'),
  // Raw SQL by name, also schema-qualified or quoted ("public"."vehicle_departures").
  new RegExp(`\\b${WRITE_VERB}\\s+(?:"?\\w+"?\\.)?"?(?:${SQL_TABLES})"?(?![\\w])`, 'gi'),
  // Raw SQL with the drizzle table interpolated: sql`UPDATE ${vehicleDepartures} ...`.
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

describe('departure writer guard', () => {
  it('writes the departure and plan tables only in lib/vehicle-departures.ts', () => {
    expect(findWrites()).toEqual([]);
  });

  it('finds a drizzle and a raw SQL write of each table', () => {
    for (const sample of [
      'await tx.insert(vehicleDepartureSchedules).values({})',
      'await db.update(vehicleDepartures).set({ status: "cancelled" })',
      'await db.delete( vehicleDepartureNotices )',
      'await tx.insert(siteChargingPlans).values({})',
      'UPDATE vehicle_departures SET readiness = $1',
      'INSERT INTO "site_charging_plans" (site_id) VALUES ($1)',
      'DELETE FROM vehicle_departure_schedules WHERE id = $1',
      'insert into vehicle_departure_notices (departure_id) values ($1)',
      'await tx.update(schema.vehicleDepartures).set({})',
      'await sql`UPDATE ${vehicleDepartures} SET status = ${s}`',
      'await sql`DELETE FROM ${schema.siteChargingPlans}`',
      'UPDATE public.vehicle_departures SET readiness = NULL',
      'UPDATE "public"."site_charging_plans" SET stale_at = NULL',
      'UPDATE ONLY vehicle_departures SET status = $1',
      'TRUNCATE vehicle_departure_schedules',
      'TRUNCATE TABLE sessions, vehicle_departures CASCADE',
      'MERGE INTO vehicle_departures d USING x ON true',
      "const t = sql.identifier('vehicle_departures')",
    ]) {
      expect(matches(sample), sample).toBe(true);
    }
  });

  it('lets reads through', () => {
    for (const sample of [
      'SELECT * FROM vehicle_departures WHERE site_id = $1',
      'await db.select().from(vehicleDepartures)',
      'JOIN site_charging_plans p ON p.site_id = s.id',
      "sql.identifier('vehicle_departure_audit_log')",
      'UPDATE vehicle_departure_audit_log SET notes = $1',
    ]) {
      expect(matches(sample), sample).toBe(false);
    }
  });
});
