// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const { isFleetEnabled } = vi.hoisted(() => ({ isFleetEnabled: vi.fn() }));
vi.mock('../lib/fleet-setting.js', () => ({ isFleetEnabled }));
vi.mock('../lib/fleet-credit-settings.js', () => ({
  getFleetCreditReservationCents: vi.fn().mockResolvedValue(5000),
}));

const { resolveFleetCardBilling, stampFleetCardBilling } = await import('../lib/fleet-billing.js');
const { loadFleetCardAccountCredit } = await import('../lib/fleet-credit-limit.js');

interface Call {
  text: string;
  values: unknown[];
}

function makeSql(answers: Array<[string, Record<string, unknown>[]]> = []): {
  sql: postgres.Sql;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    calls.push({ text, values });
    const match = answers.find(([fragment]) => text.includes(fragment));
    return Promise.resolve(match?.[1] ?? []);
  };
  return { sql: fn as unknown as postgres.Sql, calls };
}

const FLEET_ON = ['FROM fleets WHERE id', [{ name: 'Alpha', account_billing_enabled: true }]] as [
  string,
  Record<string, unknown>[],
];
const FLEET_OFF = ['FROM fleets WHERE id', [{ name: 'Alpha', account_billing_enabled: false }]] as [
  string,
  Record<string, unknown>[],
];

beforeEach(() => {
  isFleetEnabled.mockReset();
  isFleetEnabled.mockResolvedValue(true);
});

describe('resolveFleetCardBilling', () => {
  it('bills the fleet itself, never a member, while the fleet bills on account', async () => {
    const { sql } = makeSql([FLEET_ON]);
    expect(await resolveFleetCardBilling(sql, 'flt_a')).toEqual({
      fleetId: 'flt_a',
      fleetName: 'Alpha',
      recipient: 'fleet',
    });
  });

  it('is null while the fleet does not bill on account', async () => {
    const { sql } = makeSql([FLEET_OFF]);
    expect(await resolveFleetCardBilling(sql, 'flt_a')).toBeNull();
  });

  it('is null while Fleets is off, without reading the fleet', async () => {
    isFleetEnabled.mockResolvedValue(false);
    const { sql, calls } = makeSql([FLEET_ON]);
    expect(await resolveFleetCardBilling(sql, 'flt_a')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('is null for a fleet that no longer exists', async () => {
    const { sql } = makeSql([]);
    expect(await resolveFleetCardBilling(sql, 'flt_gone')).toBeNull();
  });
});

describe('stampFleetCardBilling', () => {
  it('stamps account to the fleet, never member billed, only while unstamped', async () => {
    const { sql, calls } = makeSql([
      FLEET_ON,
      [
        'WITH stamped AS',
        [{ billing_mode: 'account', billing_fleet_id: 'flt_a', fleet_name: 'Alpha' }],
      ],
    ]);
    expect(await stampFleetCardBilling(sql, 'ses_1', 'flt_a')).toEqual({
      mode: 'account',
      fleetId: 'flt_a',
      fleetName: 'Alpha',
    });
    const update = calls[1];
    expect(update?.text).toContain("SET billing_mode = 'account'");
    expect(update?.text).toContain('member_billed = false');
    expect(update?.text).toContain('WHERE id = ? AND billing_mode IS NULL');
    expect(update?.values.slice(0, 2)).toEqual(['flt_a', 'ses_1']);
  });

  it('writes nothing and has no stamp while the fleet cannot bill the card', async () => {
    const { sql, calls } = makeSql([
      FLEET_OFF,
      [
        'FROM charging_sessions cs',
        [{ billing_mode: null, billing_fleet_id: null, fleet_name: null }],
      ],
    ]);
    expect(await stampFleetCardBilling(sql, 'ses_1', 'flt_a')).toBeNull();
    expect(calls.some((c) => c.text.includes('UPDATE charging_sessions'))).toBe(false);
  });

  it('keeps a stamp an earlier run wrote after the fleet stopped billing (write-once)', async () => {
    const { sql } = makeSql([
      FLEET_OFF,
      [
        'FROM charging_sessions cs',
        [{ billing_mode: 'account', billing_fleet_id: 'flt_a', fleet_name: 'Alpha' }],
      ],
    ]);
    expect(await stampFleetCardBilling(sql, 'ses_1', 'flt_a')).toEqual({
      mode: 'account',
      fleetId: 'flt_a',
      fleetName: 'Alpha',
    });
  });
});

describe('loadFleetCardAccountCredit', () => {
  it('is unbillable while the fleet does not bill on account', async () => {
    const { sql } = makeSql([FLEET_OFF]);
    expect(await loadFleetCardAccountCredit(sql, 'flt_a')).toBe('unbillable');
  });

  it('is null for a fleet without a credit limit', async () => {
    const { sql } = makeSql([
      FLEET_ON,
      ['SELECT name, credit_limit_cents', [{ name: 'Alpha', credit_limit_cents: null }]],
    ]);
    expect(await loadFleetCardAccountCredit(sql, 'flt_a')).toBeNull();
  });
});
