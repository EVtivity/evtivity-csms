// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { AI_SETTING_DEFAULTS, permissionCatalog } from '@evtivity/lib';
import { AI_INSIGHT_SETTING_KEYS } from '@evtivity/lib/ai-insights';
import { DRIVER_AI_SETTING_KEYS } from '@evtivity/lib/driver-ai';

// The AI setting defaults live in four places that must agree (P10):
// AI_SETTING_DEFAULTS (the readers' fallback), defaultSettings in seed.ts,
// seed.config.default.json, and the seed migrations (0370, 0441, 0469).

const DB_DIR = resolve(import.meta.dirname, '../..');
const MIGRATIONS_DIR = resolve(DB_DIR, 'src/migrations');

const seedConfig = (
  JSON.parse(readFileSync(resolve(DB_DIR, 'seed.config.default.json'), 'utf-8')) as {
    settings: Record<string, unknown>;
  }
).settings;
const seedSource = readFileSync(resolve(DB_DIR, 'src/seed.ts'), 'utf-8');

/** The last value each migration INSERT gives a settings key, in file order. */
function migrationValues(): Map<string, unknown> {
  const values = new Map<string, unknown>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf-8');
    for (const m of sql.matchAll(/\(\s*'([\w.]+)'\s*,\s*'([^']*)'(?:::jsonb)?\s*\)/g)) {
      const [, key, raw] = m;
      if (key == null || raw == null || !Object.hasOwn(AI_SETTING_DEFAULTS, key)) continue;
      values.set(key, JSON.parse(raw));
    }
  }
  return values;
}

/** The literal defaultSettings in seed.ts gives a key, as a JSON value. */
function seedTsValue(key: string): unknown {
  // Every regex metacharacter, backslash included.
  const escaped = key.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
  const match = new RegExp(`'${escaped}': ([^,\\n]+),`).exec(seedSource);
  if (match?.[1] == null) return undefined;
  return JSON.parse(match[1].replace(/'/g, '"').replace(/_/g, ''));
}

describe('AI roadmap permission backfill matches the role defaults (TC-AI-C-12)', () => {
  const sql = readFileSync(
    resolve(MIGRATIONS_DIR, '0442_backfill_ai_roadmap_permissions.sql'),
    'utf-8',
  );
  const [operatorBlock = '', viewerBlock = ''] = sql.split('--> statement-breakpoint');
  const grants = (block: string): string[] =>
    [...block.matchAll(/'(ai\w+:\w+)'/g)].map((m) => m[1] ?? '').sort();
  // aiProposals was granted here and removed by 0473 (the AI Inbox merged into AI Insights).
  const roadmap = (perms: string[]): string[] =>
    perms.filter((p) => /^ai(Usage|Mcp):/.test(p)).sort();

  it('grants operators and viewers exactly the catalog defaults of the R7 groups', () => {
    expect(roadmap(grants(operatorBlock))).toEqual(
      roadmap(permissionCatalog.defaultsFor('operator')),
    );
    expect(roadmap(grants(viewerBlock))).toEqual(roadmap(permissionCatalog.defaultsFor('viewer')));
  });

  it('TC-AI-IA-06 the v0.1.45 migration removes the aiProposals permissions from users, roles and API keys', () => {
    const removal = readFileSync(resolve(MIGRATIONS_DIR, '0474_release_0_1_45.sql'), 'utf-8');
    expect(removal).toContain(
      `DELETE FROM "user_permissions" WHERE "permission" IN ('aiProposals:read', 'aiProposals:write')`,
    );
    expect(removal).toMatch(
      /UPDATE "roles"\s+SET "permissions" = "permissions" - 'aiProposals:read' - 'aiProposals:write'/,
    );
    expect(removal).toMatch(
      /UPDATE "refresh_tokens"\s+SET "permissions" = "permissions" - 'aiProposals:read' - 'aiProposals:write'/,
    );
  });

  it('grants aiInsights (registered by lane R2): operators read and write, viewers read', () => {
    expect(grants(operatorBlock).filter((p) => p.startsWith('aiInsights:'))).toEqual([
      'aiInsights:read',
      'aiInsights:write',
    ]);
    expect(grants(viewerBlock).filter((p) => p.startsWith('aiInsights:'))).toEqual([
      'aiInsights:read',
    ]);
  });
});

describe('AI setting defaults (TC-AI-C-08)', () => {
  const keys = Object.keys(AI_SETTING_DEFAULTS);
  const migrated = migrationValues();

  it('covers the v0.1.44 keys', () => {
    expect(keys).toEqual(expect.arrayContaining(['opsAi.enabled', 'ai.mcp.allowedOrigins']));
    expect(keys.length).toBeGreaterThanOrEqual(36);
  });

  it('TC-CFG-02 covers the v0.1.45 driver AI and reservation insight keys', () => {
    expect(keys).toEqual(
      expect.arrayContaining([
        ...Object.values(DRIVER_AI_SETTING_KEYS),
        AI_INSIGHT_SETTING_KEYS.reservationEnabled,
      ]),
    );
    const sql = readFileSync(resolve(MIGRATIONS_DIR, '0474_release_0_1_45.sql'), 'utf-8');
    for (const key of [
      ...Object.values(DRIVER_AI_SETTING_KEYS),
      AI_INSIGHT_SETTING_KEYS.reservationEnabled,
    ]) {
      expect(sql, key).toContain(`('${key}',`);
    }
  });

  it.each(keys)(
    '%s has the same default in seed.ts, seed.config.default.json and the migrations',
    (key) => {
      const expected = AI_SETTING_DEFAULTS[key];
      expect(seedTsValue(key), 'seed.ts').toEqual(expected);
      expect(seedConfig[key], 'seed.config.default.json').toEqual(expected);
      expect(migrated.get(key), 'migration').toEqual(expected);
    },
  );
});
