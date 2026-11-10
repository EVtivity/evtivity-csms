// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { SECURITY_SEVERITY_TABLE, getSecuritySeverity } from '@evtivity/lib/security-severity';

// Migration 0488 re-rates stored security events with a SQL copy of the lib
// table. This guard fails when the two differ, so a lib change that is not in
// the migration (or the reverse) is caught before a release.

const migration = readFileSync(
  resolve(import.meta.dirname, '../migrations/0488_release_0_1_51.sql'),
  'utf-8',
);

function sqlPairs(): Array<[string, string]> {
  const start = migration.indexOf('UPDATE security_events se');
  expect(start).toBeGreaterThan(-1);
  const block = migration.slice(start, migration.indexOf('AS m(type, severity)', start));
  return [...block.matchAll(/\('([^']+)', '([a-z]+)'\)/g)].map((m) => [m[1] ?? '', m[2] ?? '']);
}

describe('0488 security event re-rating', () => {
  it('holds exactly the pairs of SECURITY_SEVERITY_TABLE', () => {
    const pairs = sqlPairs();
    expect(new Map(pairs).size).toBe(pairs.length);
    expect(Object.fromEntries(pairs)).toEqual({ ...SECURITY_SEVERITY_TABLE });
  });

  it('rates an unlisted type info, in SQL and in the lib', () => {
    expect(migration).toContain("COALESCE(m.severity, 'info')");
    expect(getSecuritySeverity('VendorSomething')).toBe('info');
    expect(getSecuritySeverity('constructor')).toBe('info');
    expect(getSecuritySeverity('toString')).toBe('info');
  });
});
