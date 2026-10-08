// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { fleetCreditLimitNotices } from '../schema/drivers.js';

const migration = readFileSync(
  join(import.meta.dirname, '..', 'migrations', '0220_fleet_credit_notice_bigint.sql'),
  'utf8',
);

describe('fleet_credit_limit_notices amounts', () => {
  it('are bigint in the schema: a fleet exposure can pass the integer range', () => {
    const columns = getTableConfig(fleetCreditLimitNotices).columns;
    for (const name of ['exposure_cents', 'limit_cents']) {
      expect(columns.find((c) => c.name === name)?.getSQLType()).toBe('bigint');
    }
  });

  it('are widened by migration 0220 only while they are integer (idempotent)', () => {
    for (const name of ['exposure_cents', 'limit_cents']) {
      expect(migration).toContain(`column_name = '${name}'`);
      expect(migration).toContain(`ALTER COLUMN "${name}" TYPE bigint`);
    }
    expect(migration.match(/data_type = 'integer'/g)).toHaveLength(2);
  });
});
