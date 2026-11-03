// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { CHARGER_PLATE_COLOR_KEYS } from '@evtivity/lib';

// The charger plate colors start empty (the brand color) in seed.ts,
// seed.config.default.json and their seed migration.

const DB_DIR = resolve(import.meta.dirname, '../..');

const seedConfig = (
  JSON.parse(readFileSync(resolve(DB_DIR, 'seed.config.default.json'), 'utf-8')) as {
    settings: Record<string, unknown>;
  }
).settings;
const seedSource = readFileSync(resolve(DB_DIR, 'src/seed.ts'), 'utf-8');
const migration = readFileSync(
  resolve(DB_DIR, 'src/migrations/0483_release_0_1_49_charger_colors.sql'),
  'utf-8',
);

describe('charger plate color seed defaults', () => {
  it.each(CHARGER_PLATE_COLOR_KEYS)('%s starts empty everywhere', (key) => {
    expect(seedConfig[key]).toBe('');
    expect(seedSource).toContain(`'${key}': '',`);
    expect(migration).toContain(`('${key}', '""'::jsonb)`);
  });

  it('inserts without overwriting a stored color', () => {
    expect(migration).toContain('ON CONFLICT ("key") DO NOTHING');
  });
});
