// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const { isFleetEnabled } = vi.hoisted(() => ({ isFleetEnabled: vi.fn() }));
vi.mock('../lib/fleet-setting.js', () => ({ isFleetEnabled }));

const {
  resolveAccountBilling,
  pickAccountBilling,
  stampSessionBilling,
  sessionBillingColumns,
  toSessionBilling,
} = await import('../lib/fleet-billing.js');
const { resolveDriverPricingSource } = await import('../lib/tariff-resolution.js');

interface Call {
  text: string;
  values: unknown[];
}

/** A tagged-template sql mock answering by the first matching query fragment. */
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

beforeEach(() => {
  isFleetEnabled.mockReset();
  isFleetEnabled.mockResolvedValue(true);
});

/** A fleet_drivers row joined with its fleet, as loadBillingMemberships reads it. */
function membershipRow(
  id: number,
  fleet: string,
  options: { enabled?: boolean; optOut?: boolean; created?: string; recipient?: string } = {},
): Record<string, unknown> {
  return {
    id,
    fleet_id: `flt_${fleet}`,
    fleet_name: fleet,
    account_billing_enabled: options.enabled ?? true,
    account_invoice_recipient: options.recipient ?? 'fleet',
    account_billing_opt_out: options.optOut ?? false,
    created_at: options.created ?? '2026-10-01T00:00:00.000Z',
  };
}

describe('resolveAccountBilling', () => {
  it('returns the fleet of the oldest qualifying membership', async () => {
    const { sql, calls } = makeSql([
      [
        'FROM fleet_drivers',
        [
          membershipRow(1, 'OptedOut', { optOut: true, created: '2026-01-01T00:00:00.000Z' }),
          membershipRow(2, 'Off', { enabled: false, created: '2026-02-01T00:00:00.000Z' }),
          membershipRow(4, 'Newer', { created: '2026-04-01T00:00:00.000Z' }),
          membershipRow(3, 'Alpha', { created: '2026-03-01T00:00:00.000Z' }),
        ],
      ],
    ]);
    expect(await resolveAccountBilling(sql, 'drv_1')).toEqual({
      fleetId: 'flt_Alpha',
      fleetName: 'Alpha',
      recipient: 'fleet',
    });
    expect(calls[0]?.values).toEqual(['drv_1']);
  });

  it("returns the winning fleet's invoice recipient", async () => {
    const { sql, calls } = makeSql([
      [
        'FROM fleet_drivers',
        [
          membershipRow(1, 'Employer', {
            recipient: 'member',
            created: '2026-01-01T00:00:00.000Z',
          }),
          membershipRow(2, 'Later', { created: '2026-02-01T00:00:00.000Z' }),
        ],
      ],
    ]);
    expect(await resolveAccountBilling(sql, 'drv_1')).toEqual({
      fleetId: 'flt_Employer',
      fleetName: 'Employer',
      recipient: 'member',
    });
    expect(calls[0]?.text).toContain('f.account_invoice_recipient');
  });

  it('reads an unknown stored recipient as fleet', async () => {
    const { sql } = makeSql([['FROM fleet_drivers', [membershipRow(1, 'A', { recipient: 'x' })]]]);
    expect(await resolveAccountBilling(sql, 'drv_1')).toMatchObject({ recipient: 'fleet' });
  });

  it('breaks a created_at tie by the membership id', async () => {
    const { sql } = makeSql([
      ['FROM fleet_drivers', [membershipRow(9, 'Later'), membershipRow(5, 'Earlier')]],
    ]);
    expect(await resolveAccountBilling(sql, 'drv_1')).toMatchObject({ fleetName: 'Earlier' });
  });

  it('returns null when no membership qualifies (opted out, fleet billing off, no fleet)', async () => {
    const { sql } = makeSql([
      [
        'FROM fleet_drivers',
        [membershipRow(1, 'A', { optOut: true }), membershipRow(2, 'B', { enabled: false })],
      ],
    ]);
    expect(await resolveAccountBilling(sql, 'drv_1')).toBeNull();
    expect(await resolveAccountBilling(makeSql().sql, 'drv_1')).toBeNull();
  });

  it('returns null without a query when fleets are turned off', async () => {
    isFleetEnabled.mockResolvedValue(false);
    const { sql, calls } = makeSql([['FROM fleet_drivers', [membershipRow(1, 'A')]]]);
    expect(await resolveAccountBilling(sql, 'drv_1')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('pickAccountBilling applies the same rule to memberships in memory', () => {
    expect(pickAccountBilling([])).toBeNull();
  });
});

describe('stampSessionBilling', () => {
  it('stamps account with the resolved fleet only while the session has no stamp', async () => {
    const { sql, calls } = makeSql([
      ['FROM fleet_drivers', [membershipRow(1, 'a')]],
      [
        'WITH stamped AS',
        [{ billing_mode: 'account', billing_fleet_id: 'flt_a', fleet_name: 'Alpha' }],
      ],
    ]);
    expect(await stampSessionBilling(sql, 'ses_1', 'drv_1')).toEqual({
      mode: 'account',
      fleetId: 'flt_a',
      fleetName: 'Alpha',
    });
    const update = calls[1];
    expect(update?.text).toContain('WHERE id = ? AND billing_mode IS NULL');
    expect(update?.text).toContain('member_billed = ?');
    expect(update?.values.slice(0, 4)).toEqual(['account', 'flt_a', false, 'ses_1']);
  });

  it('stamps member billed in the same write when the fleet invoices its members', async () => {
    const { sql, calls } = makeSql([
      ['FROM fleet_drivers', [membershipRow(1, 'a', { recipient: 'member' })]],
      [
        'WITH stamped AS',
        [{ billing_mode: 'account', billing_fleet_id: 'flt_a', fleet_name: 'Alpha' }],
      ],
    ]);
    await stampSessionBilling(sql, 'ses_1', 'drv_1');
    const update = calls[1];
    expect(update?.text).toContain('WHERE id = ? AND billing_mode IS NULL');
    expect(update?.values.slice(0, 4)).toEqual(['account', 'flt_a', true, 'ses_1']);
  });

  it('stamps card when the driver has no account billing', async () => {
    const { sql, calls } = makeSql([
      ['WITH stamped AS', [{ billing_mode: 'card', billing_fleet_id: null, fleet_name: null }]],
    ]);
    expect(await stampSessionBilling(sql, 'ses_1', 'drv_1')).toEqual({
      mode: 'card',
      fleetId: null,
      fleetName: null,
    });
    expect(calls[1]?.values.slice(0, 3)).toEqual(['card', null, false]);
  });

  it('returns the earlier stamp when the session already has one (write once)', async () => {
    // The driver now resolves to card, but the portal start stamped account.
    const { sql } = makeSql([
      [
        'WITH stamped AS',
        [{ billing_mode: 'account', billing_fleet_id: 'flt_old', fleet_name: 'Old' }],
      ],
    ]);
    expect(await stampSessionBilling(sql, 'ses_1', 'drv_1')).toEqual({
      mode: 'account',
      fleetId: 'flt_old',
      fleetName: 'Old',
    });
  });

  it('returns null for an unknown session', async () => {
    const { sql } = makeSql();
    expect(await stampSessionBilling(sql, 'ses_x', 'drv_1')).toBeNull();
  });
});

describe('sessionBillingColumns and toSessionBilling', () => {
  it('maps a resolver result to the stamp columns', () => {
    expect(sessionBillingColumns(null)).toEqual({
      billingMode: 'card',
      billingFleetId: null,
      memberBilled: false,
    });
    expect(sessionBillingColumns({ fleetId: 'flt_a', fleetName: 'A', recipient: 'fleet' })).toEqual(
      { billingMode: 'account', billingFleetId: 'flt_a', memberBilled: false },
    );
    // A fleet that invoices its members stamps the session member billed.
    expect(
      sessionBillingColumns({ fleetId: 'flt_a', fleetName: 'A', recipient: 'member' }),
    ).toEqual({ billingMode: 'account', billingFleetId: 'flt_a', memberBilled: true });
  });

  it('reads an account stamp with its fleet and anything else as card', () => {
    expect(toSessionBilling('account', 'flt_a', null)).toEqual({
      mode: 'account',
      fleetId: 'flt_a',
      fleetName: '',
    });
    expect(toSessionBilling('account', null, null).mode).toBe('card');
    expect(toSessionBilling(null, null, null).mode).toBe('card');
  });
});

describe('resolveDriverPricingSource', () => {
  it('returns the fleet of the oldest membership in a fleet with a pricing group', async () => {
    const { sql, calls } = makeSql([
      [
        'WITH driver_group AS',
        [
          {
            source: 'fleet',
            fleet_id: 'flt_p',
            fleet_name: 'Priced',
            group_id: 'pgr_1',
            group_name: 'Fleet prices',
          },
        ],
      ],
    ]);
    expect(await resolveDriverPricingSource(sql, 'drv_1')).toEqual({
      source: 'fleet',
      fleetId: 'flt_p',
      fleetName: 'Priced',
      pricingGroupId: 'pgr_1',
      pricingGroupName: 'Fleet prices',
    });
    // Same order and tie-break as loadStationPricing.
    expect(calls[0]?.text).toContain('ORDER BY fd.created_at ASC, fd.id ASC');
  });

  it('reports a driver pricing group that overrides fleet pricing', async () => {
    const { sql } = makeSql([
      [
        'WITH driver_group AS',
        [
          {
            source: 'driver',
            fleet_id: null,
            fleet_name: null,
            group_id: 'pgr_d',
            group_name: 'VIP',
          },
        ],
      ],
    ]);
    expect(await resolveDriverPricingSource(sql, 'drv_1')).toEqual({
      source: 'driver',
      pricingGroupId: 'pgr_d',
      pricingGroupName: 'VIP',
    });
  });

  it('returns null when neither a driver nor a fleet group prices the driver', async () => {
    const { sql } = makeSql();
    expect(await resolveDriverPricingSource(sql, 'drv_1')).toBeNull();
  });
});

describe('moveSessionBillingRecipient', () => {
  function sessionRow(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id,
      driver_id: 'drv_1',
      billing_mode: 'account',
      billing_fleet_id: 'flt_1',
      member_billed: false,
      invoice_id: null,
      has_payment: false,
      is_member: true,
      ...over,
    };
  }

  /** A sql mock with begin() running the work on the same mock. */
  function txSql(
    sessions: Record<string, unknown>[],
    fleets: Record<string, unknown>[] = [{ id: 'flt_1', account_billing_enabled: true }],
  ) {
    const { sql, calls } = makeSql([
      ['SELECT DISTINCT billing_fleet_id', [{ billing_fleet_id: 'flt_1' }]],
      ['FROM fleets', fleets],
      ['FOR UPDATE OF cs', sessions],
    ]);
    (sql as unknown as { begin: unknown }).begin = (work: (tx: postgres.Sql) => unknown) =>
      Promise.resolve(work(sql));
    return { sql, calls };
  }

  it('moves an unbilled account session of a member to the member invoice', async () => {
    const { moveSessionBillingRecipient } = await import('../lib/fleet-billing.js');
    const { sql, calls } = txSql([sessionRow('ses_1')]);
    const moves = await moveSessionBillingRecipient(sql, ['ses_1', 'ses_1'], 'member');
    expect(moves).toEqual([
      { sessionId: 'ses_1', outcome: 'moved', driverId: 'drv_1', fleetId: 'flt_1', from: 'fleet' },
    ]);
    const update = calls.find((c) => c.text.includes('UPDATE charging_sessions'));
    expect(update?.text).toContain('invoice_id IS NULL');
    expect(update?.values).toEqual([true, ['ses_1'], false]);
    // The fleet rows are locked before the sessions, like the invoice issue.
    const order = calls.map((c) => c.text);
    expect(order.findIndex((t) => t.includes('FOR SHARE'))).toBeLessThan(
      order.findIndex((t) => t.includes('FOR UPDATE OF cs')),
    );
  });

  it('refuses each guard and writes nothing', async () => {
    const { moveSessionBillingRecipient } = await import('../lib/fleet-billing.js');
    const { sql, calls } = txSql([
      sessionRow('ses_card', { billing_mode: 'card', billing_fleet_id: null }),
      sessionRow('ses_paid', { has_payment: true }),
      sessionRow('ses_inv', { invoice_id: 'inv_1' }),
      sessionRow('ses_gone', { is_member: false }),
      sessionRow('ses_same', { member_billed: true }),
    ]);
    const moves = await moveSessionBillingRecipient(
      sql,
      ['ses_card', 'ses_paid', 'ses_inv', 'ses_gone', 'ses_same', 'ses_none'],
      'member',
    );
    expect(moves.map((m) => [m.sessionId, m.outcome])).toEqual([
      ['ses_card', 'not_on_account'],
      ['ses_paid', 'not_on_account'],
      ['ses_inv', 'invoiced'],
      ['ses_gone', 'not_member'],
      ['ses_same', 'unchanged'],
      ['ses_none', 'not_found'],
    ]);
    expect(calls.some((c) => c.text.includes('UPDATE charging_sessions'))).toBe(false);
  });

  it('refuses a fleet whose account billing is off', async () => {
    const { moveSessionBillingRecipient } = await import('../lib/fleet-billing.js');
    const { sql } = txSql(
      [sessionRow('ses_1', { member_billed: true })],
      [{ id: 'flt_1', account_billing_enabled: false }],
    );
    const [move] = await moveSessionBillingRecipient(sql, ['ses_1'], 'fleet');
    expect(move?.outcome).toBe('billing_off');
    expect(move?.from).toBe('member');
  });
});

describe('listMovableFleetSessions', () => {
  it('selects what the preview counts on the other side, ended before the period end', async () => {
    const { listMovableFleetSessions } = await import('../lib/fleet-billing.js');
    const { sql, calls } = makeSql([['FROM charging_sessions cs', [{ id: 'ses_1' }]]]);
    const endsBefore = new Date('2026-10-01T00:00:00Z');
    expect(
      await listMovableFleetSessions(sql, {
        fleetId: 'flt_1',
        driverIds: ['drv_1', 'drv_1'],
        recipient: 'member',
        endsBefore,
      }),
    ).toEqual(['ses_1']);
    // Moving to the member invoice takes the fleet's own sessions (not member billed).
    expect(calls[0]?.values).toEqual(['flt_1', ['drv_1'], false, endsBefore]);
    expect(calls[0]?.text).toContain('NOT EXISTS (SELECT 1 FROM payment_records');
    expect(
      await listMovableFleetSessions(sql, {
        fleetId: 'f',
        recipient: 'fleet',
        endsBefore,
        driverIds: [],
      }),
    ).toEqual([]);
  });
});
