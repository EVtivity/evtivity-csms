// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import {
  FLEET_MANAGER_NOTICE_PERMISSION,
  claimFleetManagerInvoiceNotice,
  loadFleetManagerRecipients,
} from '../lib/fleet-managers.js';

function fakeSql(rows: unknown[]): {
  sql: postgres.Sql;
  text: () => string;
  values: () => unknown[];
} {
  const calls: { strings: readonly string[]; values: unknown[] }[] = [];
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings, values });
    return Promise.resolve(rows);
  }) as unknown as postgres.Sql;
  return {
    sql,
    text: () => (calls[0]?.strings ?? []).join('?').replace(/\s+/g, ' '),
    values: () => calls[0]?.values ?? [],
  };
}

describe('loadFleetManagerRecipients', () => {
  it('reads the active fleet users of the fleet who may read its payments', async () => {
    const db = fakeSql([
      {
        id: 'usr_1',
        email: 'fm@example.com',
        phone: null,
        first_name: 'Fleet',
        last_name: null,
        language: 'de',
        timezone: null,
      },
    ]);
    const recipients = await loadFleetManagerRecipients(db.sql, 'flt_1');
    expect(db.text()).toContain("u.is_active AND u.access_scope = 'fleets'");
    expect(db.text()).toContain('FROM user_fleet_assignments a');
    expect(db.text()).toContain('FROM user_permissions p');
    expect(db.values()).toEqual(['flt_1', FLEET_MANAGER_NOTICE_PERMISSION]);
    expect(FLEET_MANAGER_NOTICE_PERMISSION).toBe('payments:read');
    expect(recipients).toEqual([
      {
        userId: 'usr_1',
        email: 'fm@example.com',
        phone: undefined,
        firstName: 'Fleet',
        lastName: undefined,
        language: 'de',
        timezone: undefined,
      },
    ]);
  });
});

describe('claimFleetManagerInvoiceNotice', () => {
  it('claims only an issued or paid fleet invoice that was not claimed', async () => {
    const db = fakeSql([{ id: 'inv_1' }]);
    expect(await claimFleetManagerInvoiceNotice(db.sql, 'inv_1')).toBe(true);
    const text = db.text();
    expect(text).toContain('fleet_managers_notified_at IS NULL');
    expect(text).toContain("NOT member_billed AND kind = 'invoice'");
    expect(text).toContain("status IN ('issued', 'paid')");
    expect(await claimFleetManagerInvoiceNotice(fakeSql([]).sql, 'inv_1')).toBe(false);
  });
});
