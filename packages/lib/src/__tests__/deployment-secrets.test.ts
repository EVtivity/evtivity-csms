// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  isWeakJwtSecret,
  isWeakSettingsEncryptionKey,
  KNOWN_JWT_SECRETS,
  KNOWN_SETTINGS_ENCRYPTION_KEYS,
} from '../deployment-secrets.js';

const ROOT = resolve(import.meta.dirname, '../../../..');

describe('deployment secrets', () => {
  it('treats short and published JWT secrets as weak', () => {
    for (const known of KNOWN_JWT_SECRETS) expect(isWeakJwtSecret(known)).toBe(true);
    expect(isWeakJwtSecret('x'.repeat(31))).toBe(true);
    expect(isWeakJwtSecret('a'.repeat(64))).toBe(false);
  });

  it('treats short and published settings keys as weak', () => {
    for (const known of KNOWN_SETTINGS_ENCRYPTION_KEYS) {
      expect(isWeakSettingsEncryptionKey(known)).toBe(true);
    }
    expect(isWeakSettingsEncryptionKey('k')).toBe(true);
    expect(isWeakSettingsEncryptionKey('b'.repeat(64))).toBe(false);
  });

  it('lists every secret value the repository publishes', () => {
    const example = readFileSync(resolve(ROOT, '.env.example'), 'utf8');
    for (const line of example.split('\n')) {
      const match = /^#?\s*(JWT_SECRET|SETTINGS_ENCRYPTION_KEY)=(.+)$/.exec(line.trim());
      if (match == null) continue;
      const [, name, value = ''] = match;
      if (value.trim() === '') continue;
      const list = name === 'JWT_SECRET' ? KNOWN_JWT_SECRETS : KNOWN_SETTINGS_ENCRYPTION_KEYS;
      expect(list).toContain(value.trim());
    }
  });

  it('matches the published values the Compose secret script refuses', () => {
    const script = readFileSync(resolve(ROOT, 'scripts/lib/compose-secrets.sh'), 'utf8');
    const settingsKey = /^COMPOSE_BUILTIN_SETTINGS_KEY='([^']*)'$/m.exec(script)?.[1];
    const jwtList = /^COMPOSE_KNOWN_JWT_SECRETS=\(([^)]*)\)$/m.exec(script)?.[1] ?? '';
    const jwtSecrets = [...jwtList.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect([settingsKey]).toEqual([...KNOWN_SETTINGS_ENCRYPTION_KEYS]);
    expect(jwtSecrets.sort()).toEqual([...KNOWN_JWT_SECRETS].sort());
  });
});
