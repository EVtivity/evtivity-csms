// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const graceMock = vi.fn();
vi.mock('../lib/idling-setting.js', () => ({ getIdlingGracePeriodMinutes: graceMock }));
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
  closeSegmentsAt,
  segmentsAt,
  eventTimeAtMostNow,
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
    // An idle period that opened after `at` adds nothing, never a negative amount (B11).
    expect(
      sessionIdleMinutesAt(
        { idleMinutes: 2, idleStartedAt: new Date('2026-06-04T01:10:00Z') },
        new Date('2026-06-04T01:00:00Z'),
      ),
    ).toBe(2);
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

  const twoSegments = [
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

  it('prices a session with several segments from their snapshots whatever the split billing setting (B8)', async () => {
    const { sql, calls } = makeSql([
      ['FROM charging_sessions s', [sessionRow]],
      ['FROM session_tariff_segments sts', twoSegments],
    ]);
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

  it('prices at `at` without the segments that start at or after it (B6)', async () => {
    const { sql } = makeSql([
      ['FROM charging_sessions s', [sessionRow]],
      ['FROM session_tariff_segments sts', twoSegments],
    ]);
    // Priced at 00:25, before the second segment started: the first segment
    // is open at 00:25 and the session snapshot prices it (150 + 100 at 19%).
    const early = await priceSessionAt(sql, 'ses_1', new Date('2026-06-04T00:25:00Z'), 5000);
    expect(early?.grossCents).toBe(250 + 48);
    expect(early?.components?.map((g) => g.segment)).toEqual([null]);
  });

  it('prices one segment from the session snapshot', async () => {
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
    // The pricing group the tariff belongs to (B7, TC-T3-12).
    expect(calls[0]?.text).toContain(
      'pricing_group_id = (SELECT pricing_group_id FROM tariffs WHERE id = ?)',
    );
    expect(calls[0]?.values).toEqual([
      'trf_2',
      '0.40',
      null,
      null,
      '0.05',
      '0.02',
      '0.07',
      'trf_2',
      'gross',
      'ses_1',
    ]);
    expect(calls[1]?.text).toContain('INSERT INTO session_tariff_segments');
    // A rerun keeps the open segment (one open segment per session, B1).
    expect(calls[1]?.text).toContain('ON CONFLICT (session_id) WHERE ended_at IS NULL DO NOTHING');
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

  describe('segmentsAt', () => {
    const seg = (startedAt: string, endedAt: string | null, energyWhStart: number) => ({
      tariff: {
        pricePerKwh: null,
        pricePerMinute: null,
        pricePerSession: null,
        idleFeePricePerMinute: null,
        reservationFeePerMinute: null,
        taxRate: null,
      },
      startedAt: new Date(startedAt),
      endedAt: endedAt != null ? new Date(endedAt) : null,
      energyWhStart,
      energyWhEnd: endedAt != null ? energyWhStart + 1000 : null,
      idleMinutes: endedAt != null ? 3 : 0,
    });
    const segments = [
      seg('2026-06-04T00:00:00Z', '2026-06-04T01:00:00Z', 0),
      seg('2026-06-04T01:00:00Z', '2026-06-04T02:00:00Z', 1000),
      seg('2026-06-04T02:00:00Z', null, 2000),
    ];

    it('keeps every segment at or after the open segment start', () => {
      expect(segmentsAt(segments, new Date('2026-06-04T02:30:00Z'))).toEqual(segments);
    });

    it('drops later segments and reopens the one that ran past `at` (B6)', () => {
      const view = segmentsAt(segments, new Date('2026-06-04T01:30:00Z'));
      expect(view).toHaveLength(2);
      expect(view[1]).toMatchObject({ endedAt: null, energyWhEnd: null, idleMinutes: 0 });
      // A segment starting exactly at `at` does not exist yet.
      expect(segmentsAt(segments, new Date('2026-06-04T01:00:00Z'))).toHaveLength(1);
      // The first segment always stays.
      expect(segmentsAt(segments, new Date('2026-06-03T23:00:00Z'))).toHaveLength(1);
    });
  });

  it('eventTimeAtMostNow clamps a station timestamp to now (B5)', () => {
    const now = new Date('2026-06-04T12:00:00Z');
    expect(eventTimeAtMostNow('2026-06-04T11:00:00Z', now)).toEqual(
      new Date('2026-06-04T11:00:00Z'),
    );
    expect(eventTimeAtMostNow('2026-06-04T13:00:00Z', now)).toBe(now);
    expect(eventTimeAtMostNow('not a date', now)).toBe(now);
    expect(eventTimeAtMostNow(null, now)).toBe(now);
  });

  describe('closeSegmentsAt', () => {
    const at = new Date('2026-06-04T01:00:00Z');
    const segmentList = 'ORDER BY started_at, id';

    it('closes the latest segment with the idle not attributed to the others', async () => {
      const { sql, calls } = makeSql([
        [segmentList, [{ id: 1, started_at: '2026-06-04T00:00:00Z' }]],
        ['COALESCE(SUM(idle_minutes), 0)', [{ total: '4' }]],
      ]);
      const begin = vi.spyOn(sql as unknown as { begin: () => unknown }, 'begin');
      await closeSegmentsAt(sql, 'ses_1', at, 5000, 10);
      expect(begin).toHaveBeenCalledTimes(1);
      expect(calls[0]?.text).toContain('FOR UPDATE');
      expect(calls.some((c) => c.text.includes('DELETE'))).toBe(false);
      const update = calls.find((c) => c.text.includes('UPDATE session_tariff_segments'));
      expect(update?.text).toContain('GREATEST(energy_wh_start, ?::numeric)');
      expect(update?.text).toContain('GREATEST(0, EXTRACT(EPOCH');
      expect(update?.values).toEqual([at.toISOString(), 5000, at.toISOString(), 6, 1]);

      const over = makeSql([
        [segmentList, [{ id: 1, started_at: '2026-06-04T00:00:00Z' }]],
        ['COALESCE(SUM(idle_minutes), 0)', [{ total: '12' }]],
      ]);
      await closeSegmentsAt(over.sql, 'ses_1', at, 5000, 10);
      const overUpdate = over.calls.find((c) => c.text.includes('UPDATE session_tariff_segments'));
      expect(overUpdate?.values[3]).toBe(0);
    });

    it('removes segments that start at or after the end and closes the previous one (B6)', async () => {
      const { sql, calls } = makeSql([
        [
          segmentList,
          [
            { id: 1, started_at: '2026-06-04T00:00:00Z' },
            { id: 2, started_at: '2026-06-04T00:40:00Z' },
            { id: 3, started_at: '2026-06-04T01:00:00Z' },
            { id: 4, started_at: '2026-06-04T01:05:00Z' },
          ],
        ],
        ['COALESCE(SUM(idle_minutes), 0)', [{ total: '0' }]],
      ]);
      await closeSegmentsAt(sql, 'ses_1', at, 5000, 0);
      expect(calls.some((c) => c.text.includes('DELETE FROM session_tariff_segments'))).toBe(true);
      const update = calls.find((c) => c.text.includes('UPDATE session_tariff_segments'));
      expect(update?.values.at(-1)).toBe(2);
    });

    it('does nothing for a session without segments', async () => {
      const { sql, calls } = makeSql();
      await closeSegmentsAt(sql, 'ses_1', at, 5000, 0);
      expect(calls.some((c) => c.text.includes('UPDATE session_tariff_segments'))).toBe(false);
    });
  });

  describe('switchTariffSegment', () => {
    const at = new Date('2026-06-04T00:30:00Z');
    const openSegment = {
      id: 7,
      tariff_id: 'trf_1',
      started_at: '2026-06-04T00:00:00Z',
      energy_wh_start: '0',
    };
    const active = (overrides: Record<string, unknown> = {}) => ({
      idle_started_at: null,
      idle_minutes: '3',
      ...overrides,
    });
    const openQuery = 'SELECT id, tariff_id, started_at, energy_wh_start';
    // The read without the lock that skips the transaction when nothing changes.
    const preRead = (tariffId = 'trf_1'): [string, Record<string, unknown>[]] => [
      'SELECT tariff_id, started_at, energy_wh_start FROM session_tariff_segments',
      [{ ...openSegment, tariff_id: tariffId }],
    ];

    it('locks the session, closes the open segment by id and opens the new one (B1)', async () => {
      const { sql, calls } = makeSql([
        preRead(),
        ['FROM charging_sessions', [active()]],
        [openQuery, [openSegment]],
        ['COALESCE(SUM(idle_minutes), 0)', [{ total: '1' }]],
        ['RETURNING id', [{ id: 7 }]],
      ]);
      const begin = vi.spyOn(sql as unknown as { begin: () => unknown }, 'begin');
      expect(
        await switchTariffSegment(sql, { sessionId: 'ses_1', tariff, at, energyWh: 2000 }),
      ).toEqual({ fromTariffId: 'trf_1' });
      expect(begin).toHaveBeenCalledTimes(1);
      expect(calls[1]?.text).toContain("status = 'active'");
      expect(calls[1]?.text).toContain('FOR UPDATE');
      const close = calls.find((c) => c.text.includes('UPDATE session_tariff_segments'));
      expect(close?.text).toContain('WHERE id = ? AND ended_at IS NULL');
      // Idle 3 at the switch, 1 already on closed segments: 2 on the closing one.
      expect(close?.values).toEqual([at.toISOString(), 2000, at.toISOString(), 2, 7]);
      const insert = calls.find((c) => c.text.includes('INSERT INTO session_tariff_segments'));
      expect(insert?.values.slice(0, 4)).toEqual(['ses_1', 'trf_2', at.toISOString(), 2000]);
      // No write to the session's own tariff snapshot (issue #33, N7).
      expect(calls.some((c) => c.text.includes('UPDATE charging_sessions'))).toBe(false);
    });

    it('counts an idle period still open at the switch', async () => {
      const { sql, calls } = makeSql([
        preRead(),
        ['FROM charging_sessions', [active({ idle_started_at: '2026-06-04T00:20:00Z' })]],
        [openQuery, [openSegment]],
        ['COALESCE(SUM(idle_minutes), 0)', [{ total: '0' }]],
        ['RETURNING id', [{ id: 7 }]],
      ]);
      await switchTariffSegment(sql, { sessionId: 'ses_1', tariff, at, energyWh: 2000 });
      const close = calls.find((c) => c.text.includes('UPDATE session_tariff_segments'));
      expect(close?.values[3]).toBe(13);
    });

    it('opens nothing when the compare-and-set close changed no row', async () => {
      const { sql, calls } = makeSql([
        preRead(),
        ['FROM charging_sessions', [active()]],
        [openQuery, [openSegment]],
      ]);
      expect(
        await switchTariffSegment(sql, { sessionId: 'ses_1', tariff, at, energyWh: 2000 }),
      ).toBeNull();
      expect(calls.some((c) => c.text.includes('INSERT INTO'))).toBe(false);
    });

    it('changes nothing when the open segment has the tariff already', async () => {
      // Seen without the lock: no transaction.
      const quick = makeSql([preRead('trf_2')]);
      const begin = vi.spyOn(quick.sql as unknown as { begin: () => unknown }, 'begin');
      expect(
        await switchTariffSegment(quick.sql, { sessionId: 'ses_1', tariff, at, energyWh: 2000 }),
      ).toBeNull();
      expect(begin).not.toHaveBeenCalled();
      // Switched by another transaction between the read and the lock.
      const { sql, calls } = makeSql([
        preRead(),
        ['FROM charging_sessions', [active()]],
        [openQuery, [{ ...openSegment, tariff_id: 'trf_2' }]],
      ]);
      expect(
        await switchTariffSegment(sql, { sessionId: 'ses_1', tariff, at, energyWh: 2000 }),
      ).toBeNull();
      expect(calls.some((c) => c.text.includes('UPDATE session_tariff_segments'))).toBe(false);
    });

    it('changes nothing for a time not after the open segment start (B5, B6)', async () => {
      const { sql, calls } = makeSql([
        preRead(),
        ['FROM charging_sessions', [active()]],
        [openQuery, [{ ...openSegment, started_at: '2026-06-04T00:30:00Z' }]],
      ]);
      expect(
        await switchTariffSegment(sql, { sessionId: 'ses_1', tariff, at, energyWh: 2000 }),
      ).toBeNull();
      expect(calls.some((c) => c.text.includes('UPDATE session_tariff_segments'))).toBe(false);
    });

    it('moves the boundary energy up to a reading at or before the open segment start (TC-T2-06)', async () => {
      // The boundary job opened trf_2 at 00:30:00.4 with 0 Wh; the reading
      // taken at 00:30:00 (2000 Wh at it) arrives after the switch.
      const jobOpen = {
        id: 8,
        tariff_id: 'trf_2',
        started_at: '2026-06-04T00:30:00.400Z',
        energy_wh_start: '0',
      };
      const { sql, calls } = makeSql([
        ['SELECT tariff_id, started_at, energy_wh_start FROM session_tariff_segments', [jobOpen]],
        ['FROM charging_sessions', [active()]],
        [openQuery, [jobOpen]],
        ['SET energy_wh_end = ?', [{ id: 7 }]],
      ]);
      expect(
        await switchTariffSegment(sql, {
          sessionId: 'ses_1',
          tariff,
          at,
          energyWh: 2000,
          readingEnergyWh: 2000,
        }),
      ).toBeNull();
      const end = calls.find((c) => c.text.includes('SET energy_wh_end = ?'));
      // Only the segment that ends where the open one starts, and only upward.
      expect(end?.text).toContain('ended_at = (SELECT started_at FROM session_tariff_segments');
      expect(end?.text).toContain('energy_wh_end < ?');
      expect(end?.values).toEqual([2000, 'ses_1', 8, 8, 2000]);
      const start = calls.find((c) => c.text.includes('SET energy_wh_start = ?'));
      expect(start?.values).toEqual([2000, 8]);
      expect(calls.some((c) => c.text.includes('INSERT INTO'))).toBe(false);
    });

    it('moves no boundary energy for the first segment, a lower reading, or a later one', async () => {
      const jobOpen = {
        id: 8,
        tariff_id: 'trf_2',
        started_at: '2026-06-04T00:30:00.400Z',
        energy_wh_start: '2500',
      };
      const pre: [string, Record<string, unknown>[]] = [
        'SELECT tariff_id, started_at, energy_wh_start FROM session_tariff_segments',
        [jobOpen],
      ];
      // Below the boundary energy: no transaction.
      const lower = makeSql([pre]);
      const begin = vi.spyOn(lower.sql as unknown as { begin: () => unknown }, 'begin');
      await switchTariffSegment(lower.sql, {
        sessionId: 'ses_1',
        tariff,
        at,
        energyWh: 2000,
        readingEnergyWh: 2000,
      });
      expect(begin).not.toHaveBeenCalled();
      // After the open segment's start: nothing to move.
      const later = makeSql([pre]);
      await switchTariffSegment(later.sql, {
        sessionId: 'ses_1',
        tariff,
        at: new Date('2026-06-04T00:31:00Z'),
        energyWh: 3000,
        readingEnergyWh: 3000,
      });
      expect(later.calls.some((c) => c.text.includes('energy_wh_end = ?'))).toBe(false);
      // The first segment: no previous segment ends at its start.
      const first = makeSql([pre, ['FROM charging_sessions', [active()]], [openQuery, [jobOpen]]]);
      await switchTariffSegment(first.sql, {
        sessionId: 'ses_1',
        tariff,
        at,
        energyWh: 3000,
        readingEnergyWh: 3000,
      });
      expect(first.calls.some((c) => c.text.includes('SET energy_wh_start = ?'))).toBe(false);
    });

    it('changes nothing for a session that is not active or has no open segment', async () => {
      // No open segment.
      expect(
        await switchTariffSegment(makeSql().sql, {
          sessionId: 'ses_1',
          tariff,
          at,
          energyWh: 2000,
        }),
      ).toBeNull();
      // Not active under the lock.
      expect(
        await switchTariffSegment(makeSql([preRead()]).sql, {
          sessionId: 'ses_1',
          tariff,
          at,
          energyWh: 2000,
        }),
      ).toBeNull();
      expect(
        await switchTariffSegment(
          makeSql([preRead(), ['FROM charging_sessions', [active()]]]).sql,
          {
            sessionId: 'ses_1',
            tariff,
            at,
            energyWh: 2000,
          },
        ),
      ).toBeNull();
    });

    it('never starts the new segment below the open segment starting energy', async () => {
      const { sql, calls } = makeSql([
        preRead(),
        ['FROM charging_sessions', [active()]],
        [openQuery, [{ ...openSegment, energy_wh_start: '2500' }]],
        ['COALESCE(SUM(idle_minutes), 0)', [{ total: '0' }]],
        ['RETURNING id', [{ id: 7 }]],
      ]);
      await switchTariffSegment(sql, { sessionId: 'ses_1', tariff, at, energyWh: 2000 });
      const insert = calls.find((c) => c.text.includes('INSERT INTO session_tariff_segments'));
      expect(insert?.values[3]).toBe(2500);
    });
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
    pricingGroup: { id: 'pgr_fleet', name: 'Fleet', source: 'fleet' },
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
        // Later segments resolve within the driver's group (B7).
        pricingGroupId: 'pgr_fleet',
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
      'trf_fleet',
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
