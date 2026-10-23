// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DATA_RETENTION_KEYS, DATA_RETENTION_SETTINGS } from '@evtivity/lib';

const root = resolve(import.meta.dirname, '../..');

describe('data retention seed', () => {
  it('seed.config.default.json holds every retention key at its default', () => {
    const { settings } = JSON.parse(
      readFileSync(resolve(root, 'seed.config.default.json'), 'utf-8'),
    ) as { settings: Record<string, unknown> };
    for (const key of DATA_RETENTION_KEYS) {
      expect(settings[key], key).toBe(DATA_RETENTION_SETTINGS[key].defaultDays);
    }
  });

  it('seed.ts holds every retention key at its default', () => {
    const seed = readFileSync(resolve(root, 'src/seed.ts'), 'utf-8');
    for (const key of DATA_RETENTION_KEYS) {
      const days = String(DATA_RETENTION_SETTINGS[key].defaultDays);
      expect(seed, key).toMatch(new RegExp(`'${key.replaceAll('.', '\\.')}': ${days},`));
    }
  });

  it('a migration seeds every retention key, so no install lacks its row', () => {
    const dir = resolve(root, 'src/migrations');
    const sql = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(resolve(dir, f), 'utf-8'))
      .join('\n');
    for (const key of DATA_RETENTION_KEYS) {
      expect(sql.includes(`'${key}'`), key).toBe(true);
    }
  });
});
