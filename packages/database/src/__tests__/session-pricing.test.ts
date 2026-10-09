// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const graceMock = vi.fn();
const splitMock = vi.fn();
vi.mock('../lib/idling-setting.js', () => ({ getIdlingGracePeriodMinutes: graceMock }));
vi.mock('../lib/pricing-settings.js', () => ({ isSplitBillingEnabled: splitMock }));
const resolveTariffMock = vi.fn();
vi.mock('../lib/tariff-resolution.js', () => ({ resolveStationTariff: resolveTariffMock }));

const {
  loadSessionPricing,
  priceSession,
  priceSessionAt,
  reservationHoldingMinutes,
  sessionIdleMinutesAt,
  storeRunningCost,
  storeFinalCost,
  snapshotSessionTariff,
  openFirstTariffSegment,
  closeOpenSegment,
  openSegmentTariffId,
  switchTariffSegment,
  repriceSessionForDriver,
  zeroCostBreakdown,
  faultUnbilledSession,
} = await import('../lib/session-pricing.js');

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
  const helpers = fn as unknown as Record<string, unknown>;
  helpers['json'] = (value: unknown) => ({ json: value });
  helpers['begin'] = (cb: (tx: unknown) => Promise<unknown>) => cb(fn);
  return { sql: fn as unknown as postgres.Sql, calls };
}

const sessionRow = {
  id: 'ses_1',
  started_at: '2026-06-04T00:00:00Z',
  tariff_id: 'trf_1',
  tax_basis: 'net',
  tariff_price_per_kwh: '0.30',
  tariff_price_per_minute: null,
  tariff_price_per_session: '1.00',
  tariff_idle_fee_price_per_minute: '0.10',
  tariff_tax_rate: '0.19',
  reservation_fee_per_minute: '0.10',
  idle_started_at: null,
  idle_minutes: '0',
  reservation_reference_at: null,
};

beforeEach(() => {
  graceMock.mockResolvedValue(0);
  splitMock.mockResolvedValue(false);
});

describe('loadSessionPricing', () => {
  it('reads the snapshot, tax basis, idle state, and reservation start', async () => {
    const { sql, calls } = makeSql([
      [
        'FROM charging_sessions s',
        [
          {
            ...sessionRow,
            tax_basis: 'gross',
            idle_minutes: '3.5',
            idle_started_at: '2026-06-04T00:40:00Z',
            reservation_reference_at: new Date('2026-06-03T23:50:00Z'),
          },
        ],
      ],
    ]);
    const row = await loadSessionPricing(sql, 'ses_1');
    expect(row).toEqual({
      id: 'ses_1',
      startedAt: new Date('2026-06-04T00:00:00Z'),
      tariffId: 'trf_1',
      basis: 'gross',
      tariff: {
        pricePerKwh: '0.30',
        pricePerMinute: null,
        pricePerSession: '1.00',
        idleFeePricePerMinute: '0.10',
        reservationFeePerMinute: '0.10',
        taxRate: '0.19',
      },
      idleStartedAt: new Date('2026-06-04T00:40:00Z'),
      idleMinutes: 3.5,
      reservationReferenceAt: new Date('2026-06-03T23:50:00Z'),
      costCeilingCents: null,
    });
    // A snapshot from before 0108 (tax_basis null) reads its tariff's reservation fee.
    expect(calls[0]?.text).toContain(
      'CASE WHEN s.tax_basis IS NULL THEN t.reservation_fee_per_minute',
    );
  });

  it('returns null for an unknown or unstarted session and defaults the basis to net', async () => {
    expect(await loadSessionPricing(makeSql().sql, 'ses_x')).toBeNull();
    expect(
      await loadSessionPricing(
        makeSql([['FROM charging_sessions s', [{ ...sessionRow, started_at: null }]]]).sql,
        'ses_1',
      ),
    ).toBeNull();
    const row = await loadSessionPricing(
      makeSql([['FROM charging_sessions s', [{ ...sessionRow, tax_basis: null }]]]).sql,
      'ses_1',
    );
    expect(row?.basis).toBe('net');
  });
});

describe('sessionIdleMinutesAt and reservationHoldingMinutes', () => {
  it('adds an open idle period and rounds holding up to whole minutes', () => {
    expect(
      sessionIdleMinutesAt(
        { idleMinutes: 2, idleStartedAt: new Date('2026-06-04T00:50:00Z') },
        new Date('2026-06-04T01:00:00Z'),
      ),
    ).toBe(12);
    expect(sessionIdleMinutesAt({ idleMinutes: 2, idleStartedAt: null }, new Date())).toBe(2);
    const session = {
      id: 'ses_1',
      startedAt: new Date('2026-06-04T00:00:00Z'),
      tariffId: 'trf_1',
      basis: 'net' as const,
      tariff: {
        pricePerKwh: null,
        pricePerMinute: null,
        pricePerSession: null,
        idleFeePricePerMinute: null,
        reservationFeePerMinute: null,
        taxRate: null,
      },
      idleStartedAt: null,
      idleMinutes: 0,
      reservationReferenceAt: new Date('2026-06-03T23:50:30Z'),
      costCeilingCents: null,
    };
    expect(reservationHoldingMinutes(session)).toBe(10);
    expect(reservationHoldingMinutes({ ...session, reservationReferenceAt: null })).toBe(0);
    expect(
      reservationHoldingMinutes({
        ...session,
        reservationReferenceAt: new Date('2026-06-04T00:10:00Z'),
      }),
    ).toBe(0);
  });
});

describe('priceSessionAt', () => {
  const end = new Date('2026-06-04T01:00:00Z');

  it('prices the session snapshot with grace and the reservation holding fee', async () => {
    graceMock.mockResolvedValue(5);
    const { sql } = makeSql([
      [
        'FROM charging_sessions s',
        [
          {
            ...sessionRow,
            idle_minutes: '15',
            reservation_reference_at: '2026-06-03T23:50:00Z',
          },
        ],
      ],
    ]);
    const breakdown = await priceSessionAt(sql, 'ses_1', end, 5000);
    // 5 kWh x 0.30 = 150, fee 100, idle (15 - 5) x 0.10 = 100, holding 10 x 0.10 = 100.
    // 450 net at 19%: 85.5 -> 86 tax.
    expect(breakdown).toMatchObject({
      basis: 'net',
      netCents: 450,
      taxCents: 86,
      grossCents: 536,
      taxLines: [{ taxRate: 0.19, netCents: 450, taxCents: 86 }],
    });
    expect(breakdown?.components?.[0]?.taxLines[0]).toMatchObject({
      energyCostCents: 150,
      sessionFeeCents: 100,
      idleFeeCents: 100,
      reservationHoldingFeeCents: 100,
    });
  });

  it('returns null for an unknown session and for a session without a tariff', async () => {
    expect(await priceSessionAt(makeSql().sql, 'ses_x', end, 0)).toBeNull();
    const { sql } = makeSql([['FROM charging_sessions s', [{ ...sessionRow, tariff_id: null }]]]);
    expect(await priceSessionAt(sql, 'ses_1', end, 5000)).toBeNull();
  });

  it('prices split segments from their snapshots only when split billing is on', async () => {
    const segments = [
      {
        started_at: '2026-06-04T00:00:00Z',
        ended_at: '2026-06-04T00:30:00Z',
        energy_wh_start: '0',
        energy_wh_end: '2000',
        idle_minutes: '0',
        price_per_kwh: '0.30',
        price_per_minute: null,
        price_per_session: '1.00',
        idle_fee_price_per_minute: null,
        reservation_fee_per_minute: null,
        tax_rate: '0.19',
      },
      {
        started_at: '2026-06-04T00:30:00Z',
        ended_at: null,
        energy_wh_start: '2000',
        energy_wh_end: null,
        idle_minutes: '0',
        price_per_kwh: '0.50',
        price_per_minute: null,
        price_per_session: '1.00',
        idle_fee_price_per_minute: null,
        reservation_fee_per_minute: null,
        tax_rate: '0.07',
      },
    ];
    const { sql, calls } = makeSql([
      ['FROM charging_sessions s', [sessionRow]],
      ['FROM session_tariff_segments sts', segments],
    ]);

    const single = await priceSessionAt(sql, 'ses_1', end, 5000);
    // Split billing off: the session snapshot prices it all. 150 + 100 = 250 at 19%.
    expect(single?.grossCents).toBe(250 + 48);
    expect(calls.some((c) => c.text.includes('FROM session_tariff_segments'))).toBe(false);

    splitMock.mockResolvedValue(true);
    const split = await priceSessionAt(sql, 'ses_1', end, 5000);
    // Segment 1: 60 + 100 fee = 160 at 19% (30.4 -> 30). Segment 2: 3 kWh x 0.50 =
    // 150 at 7% (10.5 -> 11). The open segment runs to `end` with all 5 kWh.
    expect(split).toMatchObject({
      netCents: 310,
      taxCents: 41,
      grossCents: 351,
      taxLines: [
        { taxRate: 0.07, netCents: 150, taxCents: 11 },
        { taxRate: 0.19, netCents: 160, taxCents: 30 },
      ],
    });
    expect(split?.components?.map((g) => g.segment)).toEqual([1, 2]);
    const segmentQuery = calls.find((c) => c.text.includes('FROM session_tariff_segments sts'));
    // Segments opened before 0108 (no snapshot) are priced from their tariff.
    expect(segmentQuery?.text).toContain(
      'CASE WHEN sts.price_snapshot THEN sts.price_per_kwh ELSE t.price_per_kwh END',
    );
  });

  it('prices one segment from the session snapshot', async () => {
    splitMock.mockResolvedValue(true);
    const { sql } = makeSql([
      ['FROM charging_sessions s', [sessionRow]],
      [
        'FROM session_tariff_segments sts',
        [
          {
            started_at: '2026-06-04T00:00:00Z',
            ended_at: null,
            energy_wh_start: '0',
            energy_wh_end: null,
            idle_minutes: '0',
            price_per_kwh: '9.99',
            tax_rate: '0',
          },
        ],
      ],
    ]);
    expect((await priceSessionAt(sql, 'ses_1', end, 5000))?.grossCents).toBe(298);
  });

  it('prices the gross basis from gross prices', async () => {
    const { sql } = makeSql([
      [
        'FROM charging_sessions s',
        [
          {
            ...sessionRow,
            tax_basis: 'gross',
            tariff_price_per_kwh: '0.357',
            tariff_price_per_session: '1.19',
            reservation_fee_per_minute: null,
          },
        ],
      ],
    ]);
    const breakdown = await priceSession(
      sql,
      (await loadSessionPricing(sql, 'ses_1'))!,
      end,
      10_000,
    );
    // 357 + 119 = 476 gross, 400 net, 76 tax.
    expect(breakdown).toMatchObject({
      basis: 'gross',
      grossCents: 476,
      netCents: 400,
      taxCents: 76,
    });
  });

  it('bills at most the cost ceiling and keeps the tariff price on record', async () => {
    const { sql, calls } = makeSql([
      ['FROM charging_sessions s', [{ ...sessionRow, cost_ceiling_cents: 400 }]],
    ]);
    // 10 kWh at 0.30 plus the 1.00 session fee: 400 net, 76 tax, 476 gross.
    const breakdown = await priceSessionAt(sql, 'ses_1', end, 10_000);
    expect(calls[0]?.text).toContain('s.cost_ceiling_cents');
    expect(breakdown).toEqual({
      basis: 'net',
      netCents: 336,
      taxCents: 64,
      grossCents: 400,
      taxLines: [{ taxRate: 0.19, netCents: 336, taxCents: 64 }],
      components: null,
      pricedGrossCents: 476,
    });
  });

  it('bills the tariff price at or below the cost ceiling', async () => {
    const { sql } = makeSql([
      ['FROM charging_sessions s', [{ ...sessionRow, cost_ceiling_cents: 476 }]],
    ]);
    const breakdown = await priceSessionAt(sql, 'ses_1', end, 10_000);
    expect(breakdown?.grossCents).toBe(476);
    expect(breakdown?.components).not.toBeNull();
    expect(breakdown).not.toHaveProperty('pricedGrossCents');
  });
});

describe('cost writes', () => {
  const breakdown = zeroCostBreakdown('net');

  it('stores the running cost only on an active session', async () => {
    const active = makeSql([['UPDATE charging_sessions', [{ id: 'ses_1' }]]]);
    expect(await storeRunningCost(active.sql, 'ses_1', breakdown)).toBe(true);
    expect(active.calls[0]?.text).toContain("WHERE id = ? AND status = 'active'");
    expect(active.calls[0]?.values).toEqual([0, 0, 0, { json: breakdown }, 'ses_1']);

    const ended = makeSql();
    expect(await storeRunningCost(ended.sql, 'ses_1', breakdown)).toBe(false);
  });

  it('stores the final cost with its split', async () => {
    const { sql, calls } = makeSql();
    await storeFinalCost(sql, 'ses_1', breakdown);
    expect(calls[0]?.text).toContain('final_cost_cents = ?');
    expect(calls[0]?.text).toContain('cost_breakdown = ?');
  });

  it('faults an active session unbilled: cost, net, and tax 0 with a zero breakdown', async () => {
    const active = makeSql([['UPDATE charging_sessions', [{ id: 'ses_1' }]]]);
    const endedAt = new Date('2026-06-04T01:00:00Z');
    expect(
      await faultUnbilledSession(active.sql, {
        sessionId: 'ses_1',
        reason: 'StaleSession',
        endedAt,
      }),
    ).toBe(true);
    const call = active.calls[0];
    expect(call?.text).toContain("SET status = 'faulted'");
    for (const column of [
      'final_cost_cents = 0',
      'current_cost_cents = 0',
      'net_cents = 0',
      'tax_cents = 0',
    ]) {
      expect(call?.text).toContain(column);
    }
    expect(call?.text).toContain("to_jsonb(COALESCE(tax_basis, 'net'))");
    expect(call?.text).toContain("WHERE id = ? AND status = 'active'");
    expect(call?.values).toEqual([
      'StaleSession',
      '2026-06-04T01:00:00.000Z',
      { json: zeroCostBreakdown('net') },
      'ses_1',
    ]);

    // A session that is no longer active is left alone (P5).
    const ended = makeSql();
    expect(
      await faultUnbilledSession(ended.sql, {
        sessionId: 'ses_1',
        reason: 'StaleSession',
        endedAt: '2026-06-04T01:00:00Z',
      }),
    ).toBe(false);
    expect(ended.calls[0]?.values[1]).toBe('2026-06-04T01:00:00Z');
  });

  it('zeroCostBreakdown is an empty breakdown in the basis', () => {
    expect(zeroCostBreakdown('gross')).toEqual({
      basis: 'gross',
      netCents: 0,
      taxCents: 0,
      grossCents: 0,
      taxLines: [],
      components: null,
    });
  });
});

describe('segment writes', () => {
  const tariff = {
    id: 'trf_2',
    pricePerKwh: '0.40',
    pricePerMinute: null,
    pricePerSession: null,
    idleFeePricePerMinute: '0.05',
    reservationFeePerMinute: '0.02',
    taxRate: '0.07',
  };

  it('snapshots the tariff and basis on the session and opens the first segment', async () => {
    const { sql, calls } = makeSql();
    await snapshotSessionTariff(sql, 'ses_1', tariff, 'gross');
    await openFirstTariffSegment(sql, 'ses_1', tariff, '2026-06-04T00:00:00Z');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.text).toContain('tariff_reservation_fee_per_minute = ?');
    expect(calls[0]?.values).toEqual([
      'trf_2',
      '0.40',
      null,
      null,
      '0.05',
      '0.02',
      '0.07',
      'gross',
      'ses_1',
    ]);
    expect(calls[1]?.text).toContain('INSERT INTO session_tariff_segments');
    expect(calls[1]?.values).toEqual([
      'ses_1',
      'trf_2',
      '2026-06-04T00:00:00Z',
      0,
      '0.40',
      null,
      null,
      '0.05',
      '0.02',
      '0.07',
    ]);
  });

  it('closes the open segment with the idle not attributed to closed segments', async () => {
    const { sql, calls } = makeSql([['COALESCE(SUM(idle_minutes), 0)', [{ total: '4' }]]]);
    const at = new Date('2026-06-04T01:00:00Z');
    await closeOpenSegment(sql, 'ses_1', at, 5000, 10);
    expect(calls[1]?.text).toContain('UPDATE session_tariff_segments');
    expect(calls[1]?.values).toEqual([at.toISOString(), 5000, at.toISOString(), 6, 'ses_1']);

    const over = makeSql([['COALESCE(SUM(idle_minutes), 0)', [{ total: '12' }]]]);
    await closeOpenSegment(over.sql, 'ses_1', at, 5000, 10);
    expect(over.calls[1]?.values[3]).toBe(0);
  });

  it('switches the tariff by closing and opening segments in one transaction', async () => {
    const { sql, calls } = makeSql([['COALESCE(SUM(idle_minutes), 0)', [{ total: '0' }]]]);
    const begin = vi.spyOn(sql as unknown as { begin: () => unknown }, 'begin');
    const at = new Date('2026-06-04T00:30:00Z');
    await switchTariffSegment(sql, {
      sessionId: 'ses_1',
      tariff,
      at,
      energyWh: 2000,
      sessionIdleMinutes: 3,
    });
    expect(begin).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.text.trim().split(/\s+/).slice(0, 2).join(' '))).toEqual([
      'SELECT COALESCE(SUM(idle_minutes),',
      'UPDATE session_tariff_segments',
      'INSERT INTO',
    ]);
    expect(calls[2]?.values.slice(0, 4)).toEqual(['ses_1', 'trf_2', at.toISOString(), 2000]);
    // No write to the session's own tariff snapshot (issue #33, N7).
    expect(calls.some((c) => c.text.includes('UPDATE charging_sessions'))).toBe(false);
  });

  it('reads the tariff of the open segment', async () => {
    expect(
      await openSegmentTariffId(
        makeSql([['FROM session_tariff_segments', [{ tariff_id: 'trf_9' }]]]).sql,
        'ses_1',
      ),
    ).toBe('trf_9');
    expect(await openSegmentTariffId(makeSql().sql, 'ses_1')).toBeNull();
  });
});

describe('repriceSessionForDriver', () => {
  const fleetTariff = {
    id: 'trf_fleet',
    pricePerKwh: '0.20',
    pricePerMinute: null,
    pricePerSession: null,
    idleFeePricePerMinute: null,
    reservationFeePerMinute: null,
    taxRate: '0.10',
  };
  const params = { sessionId: 'ses_1', stationUuid: 'sta_1', driverUuid: 'drv_1', basis: 'net' };
  const lockedSession: [string, Record<string, unknown>[]] = [
    'FOR UPDATE',
    [{ started_at: '2026-06-04T00:00:00Z', tariff_id: 'trf_1', tax_basis: 'gross' }],
  ];

  beforeEach(() => {
    resolveTariffMock.mockReset();
  });

  it('replaces the snapshot and re-prices the segments from the tariff of the driver', async () => {
    const { sql, calls } = makeSql([
      lockedSession,
      [
        'SELECT id, started_at, energy_wh_start FROM session_tariff_segments',
        [
          { id: 1, started_at: '2026-06-04T00:00:00Z', energy_wh_start: 0 },
          { id: 2, started_at: '2026-06-04T01:00:00Z', energy_wh_start: 4000 },
        ],
      ],
    ]);
    resolveTariffMock
      .mockResolvedValueOnce(fleetTariff)
      .mockResolvedValueOnce({ ...fleetTariff, id: 'trf_fleet_peak' });

    expect(await repriceSessionForDriver(sql, params as never)).toBe(true);

    // Resolved for the driver at the session start, then at the second
    // segment's start and energy.
    expect(resolveTariffMock).toHaveBeenNthCalledWith(
      1,
      { stationUuid: 'sta_1', driverUuid: 'drv_1', at: new Date('2026-06-04T00:00:00Z') },
      sql,
    );
    expect(resolveTariffMock).toHaveBeenNthCalledWith(
      2,
      {
        stationUuid: 'sta_1',
        driverUuid: 'drv_1',
        at: new Date('2026-06-04T01:00:00Z'),
        sessionEnergyKwh: 4,
      },
      sql,
    );
    const snapshot = calls.find((c) => c.text.includes('UPDATE charging_sessions'));
    // The tax basis stamped at Started stays.
    expect(snapshot?.values).toEqual([
      'trf_fleet',
      '0.20',
      null,
      null,
      null,
      null,
      '0.10',
      'gross',
      'ses_1',
    ]);
    const segments = calls.filter((c) => c.text.includes('UPDATE session_tariff_segments'));
    expect(segments.map((c) => [c.values[0], c.values.at(-1)])).toEqual([
      ['trf_fleet', 1],
      ['trf_fleet_peak', 2],
    ]);
  });

  it('changes nothing when the driver resolves the tariff the session has', async () => {
    const { sql, calls } = makeSql([lockedSession]);
    resolveTariffMock.mockResolvedValueOnce({ ...fleetTariff, id: 'trf_1' });

    expect(await repriceSessionForDriver(sql, params as never)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('opens the first segment of a session that had no tariff', async () => {
    const { sql, calls } = makeSql([
      ['FOR UPDATE', [{ started_at: '2026-06-04T00:00:00Z', tariff_id: null, tax_basis: null }]],
    ]);
    resolveTariffMock.mockResolvedValueOnce(fleetTariff);

    expect(await repriceSessionForDriver(sql, params as never)).toBe(true);
    const snapshot = calls.find((c) => c.text.includes('UPDATE charging_sessions'));
    expect(snapshot?.values.at(-2)).toBe('net');
    const insert = calls.find((c) => c.text.includes('INSERT INTO session_tariff_segments'));
    expect(insert?.values.slice(0, 4)).toEqual([
      'ses_1',
      'trf_fleet',
      '2026-06-04T00:00:00.000Z',
      0,
    ]);
  });
});
