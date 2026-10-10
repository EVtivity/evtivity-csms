// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

let segmentRows: unknown[] = [];

vi.mock('@evtivity/database', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'leftJoin', 'where', 'orderBy']) chain[m] = vi.fn(() => chain);
  chain['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(segmentRows).then(resolve);
  return {
    db: { select: vi.fn(() => chain) },
    sessionTariffSegments: new Proxy({}, { get: (_t, key) => String(key) }),
    tariffs: new Proxy({}, { get: (_t, key) => String(key) }),
    sessionIdleMinutesAt: (s: { idleMinutes: number }) => s.idleMinutes,
  };
});

const { sessionCdrParts, partTimes } = await import('../services/cdr-parts.js');
const { cdrChargingPeriods } = await import('../lib/charging-periods.js');

const startedAt = new Date('2026-09-01T10:00:00Z');
const endedAt = new Date('2026-09-01T11:00:00Z');

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ses_1',
    status: 'completed',
    currentCostCents: null,
    finalCostCents: 500,
    tariffTaxRate: '0.19',
    idleStartedAt: null,
    idleMinutes: '15',
    costBreakdown: {
      basis: 'net',
      netCents: 420,
      taxCents: 80,
      grossCents: 500,
      taxLines: [{ taxRate: 0.19, netCents: 420, taxCents: 80 }],
      components: [{ segment: null, billableIdleMinutes: 5, taxLines: [] }],
    },
    startedAt,
    endedAt,
    energyDeliveredWh: '10000',
    tariffId: 'trf_1',
    tariffPricePerKwh: '0.30',
    tariffPricePerMinute: '0.02',
    tariffPricePerSession: null,
    tariffIdleFeePricePerMinute: '0.10',
    tariffReservationFeePerMinute: null,
    ...overrides,
  };
}

beforeEach(() => {
  segmentRows = [];
});

describe('sessionCdrParts', () => {
  it('prices a single-tariff session from its own snapshot', async () => {
    const parts = await sessionCdrParts(session());
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      segment: null,
      tariffId: 'trf_1',
      prices: { pricePerKwh: '0.30', idleFeePricePerMinute: '0.10', taxRate: '0.19' },
      period: { kwh: 10, chargingMinutes: 45, idleMinutes: 15, billableIdleMinutes: 5 },
    });
    expect(partTimes(parts)).toEqual([{ segment: null, chargingMinutes: 45, idleMinutes: 15 }]);
  });

  it('counts the whole idle as grace when an idle fee was not billed', async () => {
    const parts = await sessionCdrParts(
      session({
        costBreakdown: {
          ...session().costBreakdown,
          components: [{ segment: null, taxLines: [] }],
        },
      }),
    );
    expect(parts[0]?.period.billableIdleMinutes).toBe(0);
  });

  it('prices each segment of a split session from its snapshot, older rows from their tariff', async () => {
    segmentRows = [
      {
        tariffId: 'trf_day',
        startedAt,
        endedAt: new Date('2026-09-01T10:30:00Z'),
        energyWhStart: '0',
        energyWhEnd: '6000',
        durationMinutes: '30',
        idleMinutes: '0',
        priceSnapshot: true,
        pricePerKwh: '0.40',
        pricePerMinute: null,
        pricePerSession: null,
        idleFeePricePerMinute: null,
        reservationFeePerMinute: null,
        taxRate: '0.19',
        tariffPricePerKwh: '9.99',
      },
      {
        tariffId: 'trf_night',
        startedAt: new Date('2026-09-01T10:30:00Z'),
        endedAt,
        energyWhStart: '6000',
        energyWhEnd: '10000',
        durationMinutes: '30',
        idleMinutes: '10',
        priceSnapshot: false,
        pricePerKwh: null,
        tariffPricePerKwh: '0.20',
        tariffPricePerMinute: null,
        tariffPricePerSession: null,
        tariffIdleFeePricePerMinute: null,
        tariffReservationFeePerMinute: null,
        tariffTaxRate: '0.19',
      },
    ];
    const parts = await sessionCdrParts(
      session({
        costBreakdown: {
          ...session().costBreakdown,
          components: [
            { segment: 1, taxLines: [] },
            { segment: 2, taxLines: [] },
            { segment: null, taxLines: [] },
          ],
        },
      }),
    );
    expect(parts.map((p) => [p.segment, p.tariffId, p.prices.pricePerKwh])).toEqual([
      [1, 'trf_day', '0.40'],
      [2, 'trf_night', '0.20'],
    ]);
    expect(parts.map((p) => p.period)).toEqual([
      {
        startedAt,
        kwh: 6,
        chargingMinutes: 30,
        idleMinutes: 0,
        billableIdleMinutes: null,
      },
      {
        startedAt: new Date('2026-09-01T10:30:00Z'),
        kwh: 4,
        chargingMinutes: 20,
        idleMinutes: 10,
        billableIdleMinutes: null,
      },
    ]);
  });
});

describe('cdrChargingPeriods', () => {
  it('reports each part, with its parking split into grace and billed minutes', () => {
    const periods = cdrChargingPeriods([
      {
        startedAt,
        kwh: 6,
        chargingMinutes: 30,
        idleMinutes: 0,
        billableIdleMinutes: null,
        tariffId: 'T-1',
      },
      {
        startedAt: new Date('2026-09-01T10:30:00Z'),
        kwh: 4,
        chargingMinutes: 18,
        idleMinutes: 12,
        billableIdleMinutes: 6,
        tariffId: 'T-2',
      },
    ]);
    expect(periods).toEqual([
      {
        start_date_time: '2026-09-01T10:00:00.000Z',
        tariff_id: 'T-1',
        dimensions: [
          { type: 'ENERGY', volume: 6 },
          { type: 'TIME', volume: 0.5 },
        ],
      },
      {
        start_date_time: '2026-09-01T10:30:00.000Z',
        tariff_id: 'T-2',
        dimensions: [
          { type: 'ENERGY', volume: 4 },
          { type: 'TIME', volume: 0.3 },
        ],
      },
      {
        start_date_time: '2026-09-01T10:48:00.000Z',
        tariff_id: 'T-2',
        dimensions: [{ type: 'PARKING_TIME', volume: 0.1 }],
      },
      {
        start_date_time: '2026-09-01T10:54:00.000Z',
        tariff_id: 'T-2',
        dimensions: [{ type: 'PARKING_TIME', volume: 0.1 }],
      },
    ]);
  });

  it('reports the parking of a part without an idle fee as one period', () => {
    const periods = cdrChargingPeriods([
      { startedAt, kwh: 1, chargingMinutes: 30, idleMinutes: 30, billableIdleMinutes: null },
    ]);
    expect(periods).toHaveLength(2);
    expect(periods[1]?.dimensions).toEqual([{ type: 'PARKING_TIME', volume: 0.5 }]);
    expect(periods[1]).not.toHaveProperty('tariff_id');
  });
});
