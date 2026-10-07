// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { LOAD_ALLOCATION_STRATEGIES } from '@evtivity/lib/load-allocation';
import { loadAllocationStrategyEnum } from '../schema/assets.js';

const migrationsDir = join(import.meta.dirname, '..', 'migrations');

// Values the migrations give the `load_allocation_strategy` type: the CREATE TYPE
// list plus every later ADD VALUE.
function migratedEnumValues(): string[] {
  const values: string[] = [];
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const created = /"load_allocation_strategy" AS ENUM\(([^)]*)\)/.exec(sql);
    if (created?.[1] !== undefined) {
      values.push(...[...created[1].matchAll(/'([^']+)'/g)].map((m) => m[1] as string));
    }
    for (const added of sql.matchAll(
      /TYPE\s+"?(?:public"?\."?)?load_allocation_strategy"?\s+ADD VALUE(?: IF NOT EXISTS)?\s+'([^']+)'/g,
    )) {
      values.push(added[1] as string);
    }
  }
  return values;
}

describe('LOAD_ALLOCATION_STRATEGIES', () => {
  it('is the value list of the load_allocation_strategy enum', () => {
    expect(loadAllocationStrategyEnum.enumValues).toEqual([...LOAD_ALLOCATION_STRATEGIES]);
  });

  it('matches the values the migrations create', () => {
    const migrated = migratedEnumValues();
    expect(migrated.length).toBeGreaterThan(0);
    expect([...migrated].sort()).toEqual([...LOAD_ALLOCATION_STRATEGIES].sort());
  });
});
