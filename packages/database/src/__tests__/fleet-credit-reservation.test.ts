// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const { getCompanyCurrency, getSystemTimezone } = vi.hoisted(() => ({
  getCompanyCurrency: vi.fn(),
  getSystemTimezone: vi.fn(),
}));
vi.mock('../lib/system-settings.js', () => ({ getCompanyCurrency, getSystemTimezone }));
vi.mock('../lib/fleet-billing.js', () => ({ resolveAccountBilling: vi.fn() }));
const { getFleetCreditReservationCents } = vi.hoisted(() => ({
  getFleetCreditReservationCents: vi.fn(),
}));
vi.mock('../lib/fleet-credit-settings.js', () => ({ getFleetCreditReservationCents }));

const {
  checkFleetCreditLimit,
  extendFleetSessionCeiling,
  sessionReservationCents,
  ceilingExtensionDue,
  extendedCeilingCents,
  fleetCreditNoticesClaimed,
} = await import('../lib/fleet-credit-limit.js');

interface FakeSession {
  id: string;
  status: 'active' | 'completed';
  ceiling: number | null;
  running: number;
  finalCost: number;
}

/**
 * A fleet with a credit limit and its account sessions, behind a sql mock
 * that answers the credit queries from that state. begin() runs one
 * transaction at a time, as the fleet row lock (FOR UPDATE) does.
 */
function fakeFleet(limitCents: number | null, sessions: FakeSession[]) {
  let lock: Promise<unknown> = Promise.resolve();
  const fn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    if (text.includes('FROM fleets WHERE id')) {
      return Promise.resolve([
        { name: 'Acme', credit_limit_cents: limitCents, credit_limit_warning_percent: 80 },
      ]);
    }
    if (text.includes('SUM(CASE')) {
      const exclude = values[2] as string | null;
      const others = sessions.filter((s) => s.id !== exclude);
      const ended = others.filter((s) => s.status !== 'active');
      const active = others.filter((s) => s.status === 'active');
      return Promise.resolve([
        {
          unbilled: String(ended.reduce((sum, s) => sum + s.finalCost, 0)),
          invoiced: '0',
          running: String(active.reduce((sum, s) => sum + s.running, 0)),
          reserved: String(active.reduce((sum, s) => sum + (s.ceiling ?? s.running), 0)),
        },
      ]);
    }
    if (text.includes('COALESCE(cost_ceiling_cents')) {
      const [reservation, id] = values as [number, string];
      const session = sessions.find((s) => s.id === id);
      if (session == null) return Promise.resolve([]);
      session.ceiling ??= reservation;
      return Promise.resolve([{ cost_ceiling_cents: session.ceiling }]);
    }
    if (text.includes('SELECT cost_ceiling_cents FROM charging_sessions')) {
      const session = sessions.find((s) => s.id === values[0] && s.status === 'active');
      return Promise.resolve(session == null ? [] : [{ cost_ceiling_cents: session.ceiling }]);
    }
    if (text.includes('SET cost_ceiling_cents = ?, updated_at')) {
      const [next, id] = values as [number, string];
      const session = sessions.find((s) => s.id === id);
      if (session != null) session.ceiling = next;
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  (fn as unknown as { begin: unknown }).begin = (
    work: (tx: unknown) => Promise<unknown>,
  ): Promise<unknown> => {
    const run = lock.then(() => work(fn));
    lock = run.catch(() => undefined);
    return run;
  };
  return fn as unknown as postgres.Sql;
}

function active(id: string, ceiling: number | null = null, running = 0): FakeSession {
  return { id, status: 'active', ceiling, running, finalCost: 0 };
}

beforeEach(() => {
  getCompanyCurrency.mockReset();
  getCompanyCurrency.mockResolvedValue('EUR');
  getSystemTimezone.mockReset();
  getSystemTimezone.mockResolvedValue('Europe/Berlin');
  getFleetCreditReservationCents.mockReset();
  getFleetCreditReservationCents.mockResolvedValue(400);
});

describe('pure reservation rules', () => {
  it('reserves the smaller of the credit left and the slice, never below 0', () => {
    expect(sessionReservationCents(10_000, 5000)).toBe(5000);
    expect(sessionReservationCents(1200, 5000)).toBe(1200);
    expect(sessionReservationCents(0, 5000)).toBe(0);
  });

  it('is due once the headroom is below 20 % of the slice (integer math)', () => {
    const base = { ceilingCents: 500, sliceCents: 500 };
    expect(ceilingExtensionDue({ ...base, pricedCents: 400 })).toBe(false);
    expect(ceilingExtensionDue({ ...base, pricedCents: 401 })).toBe(true);
    expect(ceilingExtensionDue({ ...base, pricedCents: 600 })).toBe(true);
    // A larger ceiling keeps the same headroom: one fifth of a slice.
    expect(ceilingExtensionDue({ ...base, ceilingCents: 2000, pricedCents: 1900 })).toBe(false);
    expect(ceilingExtensionDue({ ...base, ceilingCents: 2000, pricedCents: 1901 })).toBe(true);
  });

  it('is due early when the headroom is below twice the cost of the last reading', () => {
    const base = { ceilingCents: 1000, sliceCents: 1000, pricedCents: 500 };
    expect(ceilingExtensionDue({ ...base, lastReadingCents: 250 })).toBe(false);
    expect(ceilingExtensionDue({ ...base, lastReadingCents: 251 })).toBe(true);
    // Not known, or a cost that went down: only the slice bound applies.
    expect(ceilingExtensionDue({ ...base, lastReadingCents: -400 })).toBe(false);
    expect(ceilingExtensionDue(base)).toBe(false);
  });

  it('grows one slice above the larger of ceiling and priced cost, capped at the credit left', () => {
    const base = { currentCents: 500, sliceCents: 500 };
    expect(extendedCeilingCents({ ...base, pricedCents: 450, availableCents: 10_000 })).toBe(1000);
    // A reading that jumped past the ceiling grows from the priced cost.
    expect(extendedCeilingCents({ ...base, pricedCents: 900, availableCents: 10_000 })).toBe(1400);
    expect(extendedCeilingCents({ ...base, pricedCents: 450, availableCents: 700 })).toBe(700);
    // Never shrinks, even when the credit left is below the ceiling.
    expect(extendedCeilingCents({ ...base, pricedCents: 450, availableCents: 300 })).toBe(500);
    // No limit (removed while the session runs): one slice more.
    expect(extendedCeilingCents({ ...base, pricedCents: 450, availableCents: null })).toBe(1000);
  });
});

describe('checkFleetCreditLimit with a bounded reservation', () => {
  it('reserves one slice, so the next driver of the fleet can start', async () => {
    const sessions = [active('ses_a'), active('ses_b')];
    const sql = fakeFleet(1000, sessions);

    const first = await checkFleetCreditLimit(sql, 'flt_1', { reserveForSessionId: 'ses_a' });
    expect(first).toMatchObject({ remainingCents: 1000, ceilingCents: 400 });
    // ses_b sees ses_a at its 400 reservation, not the whole limit.
    const second = await checkFleetCreditLimit(sql, 'flt_1', { reserveForSessionId: 'ses_b' });
    expect(second).toMatchObject({ remainingCents: 600, ceilingCents: 400 });
  });

  it('takes the slice from the setting unless the caller passes one', async () => {
    const sql = fakeFleet(10_000, [active('ses_a'), active('ses_b')]);
    expect(
      (await checkFleetCreditLimit(sql, 'flt_1', { reserveForSessionId: 'ses_a' }))?.ceilingCents,
    ).toBe(400);
    expect(
      (
        await checkFleetCreditLimit(sql, 'flt_1', {
          reserveForSessionId: 'ses_b',
          sliceCents: 2500,
        })
      )?.ceilingCents,
    ).toBe(2500);
    expect(getFleetCreditReservationCents).toHaveBeenCalledTimes(1);
  });

  it('never reserves more than the limit for concurrent starts, and refuses only at 0 credit left', async () => {
    const sessions = [active('ses_a'), active('ses_b'), active('ses_c'), active('ses_d')];
    const sql = fakeFleet(1000, sessions);

    const checks = await Promise.all(
      ['ses_a', 'ses_b', 'ses_c'].map((id) =>
        checkFleetCreditLimit(sql, 'flt_1', { reserveForSessionId: id }),
      ),
    );
    const ceilings = checks.map((c) => c?.ceilingCents ?? 0);
    expect(ceilings).toEqual([400, 400, 200]);
    expect(ceilings.reduce((a, b) => a + b, 0)).toBe(1000);
    // All three could start; the fourth finds no credit left.
    const fourth = await checkFleetCreditLimit(sql, 'flt_1', { reserveForSessionId: 'ses_d' });
    expect(fourth).toMatchObject({ remainingCents: 0, ceilingCents: 0 });
  });

  it('reads no slice without a reservation', async () => {
    const sql = fakeFleet(1000, [active('ses_a')]);
    await checkFleetCreditLimit(sql, 'flt_1');
    expect(getFleetCreditReservationCents).not.toHaveBeenCalled();
  });
});

describe('extendFleetSessionCeiling', () => {
  it('grows the ceiling by a slice once the headroom is below 20 % of the slice', async () => {
    const sessions = [active('ses_a', 400, 330)];
    const sql = fakeFleet(10_000, sessions);
    const result = await extendFleetSessionCeiling(sql, 'flt_1', 'ses_a', { pricedCents: 330 });
    expect(result).toEqual({ previousCents: 400, ceilingCents: 800, grown: true });
    expect(sessions[0]?.ceiling).toBe(800);
  });

  it('grows early for a reading that added more than half the headroom', async () => {
    const sessions = [active('ses_a', 400, 200)];
    const sql = fakeFleet(10_000, sessions);
    expect(
      await extendFleetSessionCeiling(sql, 'flt_1', 'ses_a', {
        pricedCents: 200,
        lastReadingCents: 100,
      }),
    ).toEqual({ previousCents: 400, ceilingCents: 400, grown: false });
    expect(
      await extendFleetSessionCeiling(sql, 'flt_1', 'ses_a', {
        pricedCents: 200,
        lastReadingCents: 101,
      }),
    ).toEqual({ previousCents: 400, ceilingCents: 800, grown: true });
  });

  it('does not grow twice for the same reading (checked again under the lock)', async () => {
    const sessions = [active('ses_a', 400, 330)];
    const sql = fakeFleet(10_000, sessions);
    await extendFleetSessionCeiling(sql, 'flt_1', 'ses_a', { pricedCents: 330 });
    const rerun = await extendFleetSessionCeiling(sql, 'flt_1', 'ses_a', { pricedCents: 330 });
    expect(rerun).toEqual({ previousCents: 800, ceilingCents: 800, grown: false });
  });

  it('caps the growth at the credit the other sessions leave', async () => {
    const sessions = [active('ses_a', 400, 330), active('ses_b', 400, 100)];
    const sql = fakeFleet(1000, sessions);
    const result = await extendFleetSessionCeiling(sql, 'flt_1', 'ses_a', { pricedCents: 330 });
    expect(result).toEqual({ previousCents: 400, ceilingCents: 600, grown: true });
  });

  it('cannot grow when the fleet has no credit left, and grows once a session frees credit', async () => {
    const sessions = [active('ses_a', 400, 330), active('ses_b', 600, 100)];
    const sql = fakeFleet(1000, sessions);
    const stuck = await extendFleetSessionCeiling(sql, 'flt_1', 'ses_a', { pricedCents: 330 });
    expect(stuck).toEqual({ previousCents: 400, ceilingCents: 400, grown: false });

    // ses_b ends at 150: its reservation of 600 becomes a cost of 150.
    Object.assign(sessions[1] as FakeSession, { status: 'completed', finalCost: 150 });
    const freed = await extendFleetSessionCeiling(sql, 'flt_1', 'ses_a', { pricedCents: 330 });
    expect(freed).toEqual({ previousCents: 400, ceilingCents: 800, grown: true });
  });

  it('keeps concurrent extensions of one fleet within the limit', async () => {
    const sessions = [active('ses_a', 400, 330), active('ses_b', 400, 330)];
    const sql = fakeFleet(1000, sessions);
    await Promise.all([
      extendFleetSessionCeiling(sql, 'flt_1', 'ses_a', { pricedCents: 330 }),
      extendFleetSessionCeiling(sql, 'flt_1', 'ses_b', { pricedCents: 330 }),
    ]);
    const total = sessions.reduce((sum, s) => sum + (s.ceiling ?? 0), 0);
    expect(total).toBe(1000);
    expect(sessions.map((s) => s.ceiling)).toEqual([600, 400]);
  });

  it('grows without a cap once the fleet limit was removed', async () => {
    const sessions = [active('ses_a', 400, 330)];
    const sql = fakeFleet(null, sessions);
    const result = await extendFleetSessionCeiling(sql, 'flt_1', 'ses_a', { pricedCents: 330 });
    expect(result).toEqual({ previousCents: 400, ceilingCents: 800, grown: true });
  });

  it('is null for a session that is not running on account with a ceiling', async () => {
    const sql = fakeFleet(1000, [active('ses_a', null, 330)]);
    expect(await extendFleetSessionCeiling(sql, 'flt_1', 'ses_a', { pricedCents: 330 })).toBeNull();
    expect(
      await extendFleetSessionCeiling(sql, 'flt_1', 'ses_gone', { pricedCents: 330 }),
    ).toBeNull();
  });
});

describe('fleetCreditNoticesClaimed', () => {
  function countSql(claimed: number): { sql: postgres.Sql; values: unknown[][] } {
    const values: unknown[][] = [];
    const fn = (strings: TemplateStringsArray, ...v: unknown[]): Promise<unknown[]> => {
      values.push(v);
      expect(strings.join('?')).toContain('FROM fleet_credit_limit_notices');
      return Promise.resolve([{ claimed }]);
    };
    return { sql: fn as unknown as postgres.Sql, values };
  }

  it('is true once both notices of the month are claimed', async () => {
    const { sql, values } = countSql(2);
    expect(await fleetCreditNoticesClaimed(sql, 'flt_1')).toBe(true);
    expect(values[0]).toEqual(['flt_1', 'Europe/Berlin']);
  });

  it('is false while a notice of the month is unclaimed', async () => {
    expect(await fleetCreditNoticesClaimed(countSql(1).sql, 'flt_1')).toBe(false);
    expect(await fleetCreditNoticesClaimed(countSql(0).sql, 'flt_1')).toBe(false);
  });
});
