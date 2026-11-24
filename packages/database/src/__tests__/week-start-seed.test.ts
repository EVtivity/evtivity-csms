// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { COMPANY_WEEK_START_KEY, DEFAULT_WEEK_START } from '@evtivity/lib/report-period';

// The report week starts on Monday in seed.ts, seed.config.default.json and
// the v0.1.53 migration, which never overwrites a stored choice.

const DB_DIR = resolve(import.meta.dirname, '../..');
const seedConfig = (
  JSON.parse(readFileSync(resolve(DB_DIR, 'seed.config.default.json'), 'utf-8')) as {
    settings: Record<string, unknown>;
  }
).settings;
const seedSource = readFileSync(resolve(DB_DIR, 'src/seed.ts'), 'utf-8');
const migration = readFileSync(resolve(DB_DIR, 'src/migrations/0492_release_0_1_53.sql'), 'utf-8');

describe('company week start seed default', () => {
  it('starts on monday everywhere', () => {
    expect(DEFAULT_WEEK_START).toBe('monday');
    expect(seedConfig[COMPANY_WEEK_START_KEY]).toBe('monday');
    expect(seedSource).toContain(`'${COMPANY_WEEK_START_KEY}': DEFAULT_WEEK_START,`);
    expect(migration).toContain(`('${COMPANY_WEEK_START_KEY}', '"monday"'::jsonb)`);
  });

  it('inserts without overwriting a stored choice', () => {
    const block = migration.slice(migration.indexOf('-- v0.1.53 report period, block A'));
    expect(block).toContain('ON CONFLICT ("key") DO NOTHING');
  });
});
