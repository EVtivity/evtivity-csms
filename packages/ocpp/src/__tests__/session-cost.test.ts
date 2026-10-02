// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const splitEnabledMock = vi.fn();
vi.mock('@evtivity/database', () => ({
  getIdlingGracePeriodMinutes: vi.fn().mockResolvedValue(0),
  isSplitBillingEnabled: splitEnabledMock,
}));

const { calculateSessionCostCentsAt, transactionCostAt, sessionIdleMinutesAt } =
  await import('../server/session-cost.js');

/** A tagged-template sql mock answering by the first matching query fragment. */
function makeSql(answers: Array<[string, Record<string, unknown>[]]>): postgres.Sql {
  const fn = (strings: TemplateStringsArray): Promise<Record<string, unknown>[]> => {
    const text = strings.join('?');
    const match = answers.find(([fragment]) => text.includes(fragment));
    return Promise.resolve(match?.[1] ?? []);
  };
  return fn as unknown as postgres.Sql;
}

const baseSession = {
  id: 'ses_1',
  started_at: '2026-06-04T00:00:00Z',
  tariff_id: 'trf_1',
  tariff_price_per_kwh: '0.30',
  tariff_price_per_minute: null,
  tariff_price_per_session: '1.00',
  tariff_idle_fee_price_per_minute: null,
  tariff_tax_rate: null,
  idle_started_at: null,
  idle_minutes: 0,
  reservation_id: null,
};

beforeEach(() => {
  splitEnabledMock.mockResolvedValue(false);
});

describe('sessionIdleMinutesAt', () => {
  it('adds the open idle period to the accumulated minutes', () => {
    expect(
      sessionIdleMinutesAt(
        { ...baseSession, idle_minutes: '2', idle_started_at: '2026-06-04T00:50:00Z' },
        new Date('2026-06-04T01:00:00Z'),
      ),
    ).toBe(12);
    expect(sessionIdleMinutesAt(baseSession, new Date())).toBe(0);
  });
});

describe('calculateSessionCostCentsAt', () => {
  it('prices energy and the session fee from the tariff snapshot', async () => {
    const sql = makeSql([['reservation_fee_per_minute FROM tariffs', [{}]]]);
    const cents = await calculateSessionCostCentsAt(
      sql,
      baseSession,
      new Date('2026-06-04T01:00:00Z'),
      5000,
    );
    // 5 kWh x 0.30 + 1.00 = 2.50
    expect(cents).toBe(250);
  });

  it('costs an open split-billing segment up to the end time', async () => {
    splitEnabledMock.mockResolvedValue(true);
    const segments = [
      {
        started_at: '2026-06-04T00:00:00Z',
        ended_at: '2026-06-04T00:30:00Z',
        energy_wh_start: 0,
        energy_wh_end: 2000,
        seg_idle_minutes: 0,
        price_per_kwh: '0.30',
        price_per_minute: null,
        price_per_session: '1.00',
        idle_fee_price_per_minute: null,
        reservation_fee_per_minute: null,
        tax_rate: null,
      },
      {
        started_at: '2026-06-04T00:30:00Z',
        ended_at: null,
        energy_wh_start: 2000,
        energy_wh_end: null,
        seg_idle_minutes: null,
        price_per_kwh: '0.50',
        price_per_minute: null,
        price_per_session: '1.00',
        idle_fee_price_per_minute: null,
        reservation_fee_per_minute: null,
        tax_rate: null,
      },
    ];
    const sql = makeSql([['FROM session_tariff_segments', segments]]);
    const cents = await calculateSessionCostCentsAt(
      sql,
      baseSession,
      new Date('2026-06-04T01:00:00Z'),
      5000,
    );
    // 2 kWh x 0.30 + 3 kWh x 0.50 + one session fee 1.00 = 3.10
    expect(cents).toBe(310);
  });
});

describe('reservation holding fee', () => {
  it('reads the tariff reservation fee only when a reservation held the EVSE', async () => {
    const queries: string[] = [];
    const answers: Array<[string, Record<string, unknown>[]]> = [
      ['FROM reservations', [{ starts_at: '2026-06-03T23:50:00Z', created_at: null }]],
      ['reservation_fee_per_minute FROM tariffs', [{ reservation_fee_per_minute: '0.10' }]],
    ];
    const sql = ((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      queries.push(text);
      return Promise.resolve(answers.find(([fragment]) => text.includes(fragment))?.[1] ?? []);
    }) as unknown as postgres.Sql;
    const end = new Date('2026-06-04T00:00:00Z');

    const withoutHold = await calculateSessionCostCentsAt(sql, baseSession, end, 0);
    expect(queries.some((q) => q.includes('reservation_fee_per_minute'))).toBe(false);

    const withHold = await calculateSessionCostCentsAt(
      sql,
      { ...baseSession, reservation_id: 'rsv_1' },
      end,
      0,
    );
    expect(queries.some((q) => q.includes('reservation_fee_per_minute'))).toBe(true);
    // 10 minutes held at 0.10 per minute on top of the 1.00 session fee.
    expect(withHold - withoutHold).toBe(100);
  });
});

describe('transactionCostAt', () => {
  const params = {
    stationId: 'CS-1',
    transactionId: 'tx-1',
    at: new Date('2026-06-04T01:00:00Z'),
    meterRegisterWh: 15000,
  };

  it('prices a session at its start with the session fee (running cost on Started)', async () => {
    const sql = makeSql([
      [
        'FROM charging_sessions s',
        [{ ...baseSession, status: 'active', energy_delivered_wh: null, meter_start: null }],
      ],
    ]);
    await expect(
      transactionCostAt(sql, {
        ...params,
        at: new Date(baseSession.started_at),
        meterRegisterWh: null,
      }),
    ).resolves.toEqual({ totalCostCents: 100, calculated: true });
  });

  it('returns null for an unknown session', async () => {
    await expect(transactionCostAt(makeSql([]), params)).resolves.toBeNull();
  });

  it('uses the Ended register reading when it is higher than the stored energy', async () => {
    const sql = makeSql([
      [
        'FROM charging_sessions s',
        [{ ...baseSession, status: 'active', energy_delivered_wh: '1000', meter_start: 10000 }],
      ],
    ]);
    // 5 kWh x 0.30 + 1.00
    await expect(transactionCostAt(sql, params)).resolves.toEqual({
      totalCostCents: 250,
      calculated: true,
    });
  });

  it('keeps the stored energy when the register reading is missing', async () => {
    const sql = makeSql([
      [
        'FROM charging_sessions s',
        [{ ...baseSession, status: 'active', energy_delivered_wh: '1000', meter_start: 10000 }],
      ],
    ]);
    await expect(transactionCostAt(sql, { ...params, meterRegisterWh: null })).resolves.toEqual({
      totalCostCents: 130,
      calculated: true,
    });
  });

  it('reports a session without a tariff as free', async () => {
    const sql = makeSql([
      ['FROM charging_sessions s', [{ ...baseSession, status: 'active', tariff_id: null }]],
    ]);
    await expect(transactionCostAt(sql, params)).resolves.toEqual({
      totalCostCents: 0,
      calculated: false,
    });
  });

  it('reports the stored cost of a faulted session without recomputing it', async () => {
    const sql = makeSql([
      [
        'FROM charging_sessions s',
        [{ ...baseSession, status: 'faulted', final_cost_cents: 0, meter_start: 10000 }],
      ],
    ]);
    await expect(transactionCostAt(sql, params)).resolves.toEqual({
      totalCostCents: 0,
      calculated: false,
    });
  });
});
