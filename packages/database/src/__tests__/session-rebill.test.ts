// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const graceMock = vi.fn();
vi.mock('../lib/idling-setting.js', () => ({ getIdlingGracePeriodMinutes: graceMock }));
const periodsMock = vi.fn();
vi.mock('../lib/electricity-rate.js', () => ({ getElectricityRatePeriodsForSite: periodsMock }));

const {
  SESSION_REBILL_LEASE_SECONDS,
  claimSessionRebill,
  releaseSessionRebill,
  priceRebill,
  completeRebilledSession,
  rebillElectricityCostCents,
} = await import('../lib/session-rebill.js');
const { computeSessionElectricityCost } = await import('@evtivity/lib');

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
  const helpers = fn as unknown as Record<string, unknown>;
  helpers['json'] = (value: unknown) => ({ json: value });
  helpers['begin'] = (cb: (tx: unknown) => Promise<unknown>) => cb(fn);
  return { sql: fn as unknown as postgres.Sql, calls };
}

const pricingRow = {
  id: 'ses_1',
  started_at: '2026-06-04T00:00:00Z',
  tariff_id: 'trf_1',
  tax_basis: 'net',
  tariff_price_per_kwh: '0.30',
  tariff_price_per_minute: null,
  tariff_price_per_session: '1.00',
  tariff_idle_fee_price_per_minute: null,
  tariff_tax_rate: '0',
  reservation_fee_per_minute: null,
  idle_started_at: null,
  idle_minutes: '0',
  cost_ceiling_cents: null,
  reservation_reference_at: null,
};

beforeEach(() => {
  graceMock.mockResolvedValue(0);
});

describe('claimSessionRebill', () => {
  it('claims only a faulted EndRequestFailed session without a live claim', async () => {
    const { sql, calls } = makeSql([['SET rebill_status', [{ id: 'ses_1' }]]]);
    expect(await claimSessionRebill(sql, 'ses_1')).toBe(true);
    const text = calls[0]?.text ?? '';
    expect(text).toContain("status = 'faulted'");
    expect(text).toContain('rebill_status IS NULL');
    expect(text).toContain("rebill_status = 'in_progress'");
    expect(calls[0]?.values).toEqual(['ses_1', 'EndRequestFailed', SESSION_REBILL_LEASE_SECONDS]);
  });

  it('returns false when another request holds the claim', async () => {
    const { sql } = makeSql();
    expect(await claimSessionRebill(sql, 'ses_1')).toBe(false);
  });
});

describe('releaseSessionRebill', () => {
  it('clears only an in-progress claim', async () => {
    const { sql, calls } = makeSql();
    await releaseSessionRebill(sql, 'ses_1');
    expect(calls[0]?.text).toContain("rebill_status = 'in_progress'");
    expect(calls[0]?.text).toContain('rebill_status = NULL');
  });
});

describe('priceRebill', () => {
  it('prices at the last meter value with the metered energy and closes the given-up segment there', async () => {
    const { sql, calls } = makeSql([
      ['FROM charging_sessions s\n    LEFT JOIN', [pricingRow]],
      [
        'last_reading_at',
        [
          {
            ended_at: '2026-06-04T02:00:00Z',
            energy_delivered_wh: '10000',
            last_reading_at: '2026-06-04T01:00:00Z',
          },
        ],
      ],
      ['ORDER BY started_at, id', [{ id: 1, started_at: '2026-06-04T00:00:00Z' }]],
    ]);
    const result = await priceRebill(sql, 'ses_1');
    expect(result?.endedAt.toISOString()).toBe('2026-06-04T01:00:00.000Z');
    expect(result?.energyWh).toBe(10000);
    // 10 kWh * 0.30 + 1.00 session fee
    expect(result?.breakdown.grossCents).toBe(400);
    // The latest segment closes at the billed end with the energy, closed or not.
    const close = calls.find((c) => c.text.includes('UPDATE session_tariff_segments'));
    expect(close?.values).toEqual([
      '2026-06-04T01:00:00.000Z',
      10000,
      '2026-06-04T01:00:00.000Z',
      0,
      1,
    ]);
  });

  it('bills at most until the fault time and from the start without meter values', async () => {
    const late = makeSql([
      ['FROM charging_sessions s\n    LEFT JOIN', [pricingRow]],
      [
        'last_reading_at',
        [
          {
            ended_at: '2026-06-04T02:00:00Z',
            energy_delivered_wh: '0',
            last_reading_at: '2026-06-04T03:00:00Z',
          },
        ],
      ],
    ]);
    expect((await priceRebill(late.sql, 'ses_1'))?.endedAt.toISOString()).toBe(
      '2026-06-04T02:00:00.000Z',
    );
    const none = makeSql([
      ['FROM charging_sessions s\n    LEFT JOIN', [pricingRow]],
      [
        'last_reading_at',
        [{ ended_at: '2026-06-04T02:00:00Z', energy_delivered_wh: null, last_reading_at: null }],
      ],
    ]);
    const result = await priceRebill(none.sql, 'ses_1');
    expect(result?.endedAt.toISOString()).toBe('2026-06-04T00:00:00.000Z');
    expect(result?.breakdown.grossCents).toBe(100);
  });

  it('removes a segment that started at or after the billed end and closes the previous one (B6)', async () => {
    const { sql, calls } = makeSql([
      ['FROM charging_sessions s\n    LEFT JOIN', [pricingRow]],
      [
        'last_reading_at',
        [
          {
            ended_at: '2026-06-04T02:00:00Z',
            energy_delivered_wh: '10000',
            last_reading_at: '2026-06-04T01:00:00Z',
          },
        ],
      ],
      [
        'ORDER BY started_at, id',
        [
          { id: 1, started_at: '2026-06-04T00:00:00Z' },
          { id: 2, started_at: '2026-06-04T01:30:00Z' },
        ],
      ],
    ]);
    const result = await priceRebill(sql, 'ses_1');
    expect(result?.endedAt.toISOString()).toBe('2026-06-04T01:00:00.000Z');
    const del = calls.find((c) => c.text.includes('DELETE FROM session_tariff_segments'));
    expect(del?.values).toEqual([[2]]);
    const close = calls.find((c) => c.text.includes('UPDATE session_tariff_segments'));
    expect(close?.values[0]).toBe('2026-06-04T01:00:00.000Z');
    expect(close?.values.at(-1)).toBe(1);
  });

  it('never bills a negative idle period (B11)', async () => {
    const { sql, calls } = makeSql([
      [
        'FROM charging_sessions s\n    LEFT JOIN',
        [{ ...pricingRow, idle_minutes: '4', idle_started_at: '2026-06-04T01:30:00Z' }],
      ],
      [
        'last_reading_at',
        [
          {
            ended_at: '2026-06-04T02:00:00Z',
            energy_delivered_wh: '0',
            last_reading_at: '2026-06-04T01:00:00Z',
          },
        ],
      ],
      ['ORDER BY started_at, id', [{ id: 1, started_at: '2026-06-04T00:00:00Z' }]],
    ]);
    await priceRebill(sql, 'ses_1');
    const close = calls.find((c) => c.text.includes('UPDATE session_tariff_segments'));
    // The idle period opened after the billed end adds nothing: 4 minutes.
    expect(close?.values[3]).toBe(4);
  });

  it('returns null for a session without a tariff snapshot', async () => {
    const { sql, calls } = makeSql([
      ['FROM charging_sessions s\n    LEFT JOIN', [{ ...pricingRow, tariff_id: null }]],
    ]);
    expect(await priceRebill(sql, 'ses_1')).toBeNull();
    expect(calls.some((c) => c.text.includes('session_tariff_segments'))).toBe(false);
  });
});

describe('completeRebilledSession', () => {
  const breakdown = {
    basis: 'net',
    grossCents: 400,
    netCents: 400,
    taxCents: 0,
  } as unknown as Parameters<typeof completeRebilledSession>[1]['breakdown'];
  // The seeded shape: Standard 0.12 (default) and Weekday Peak 0.22, 16:00-21:00 Mon-Fri.
  const periods = [
    {
      id: 1,
      siteId: 'sit_1',
      name: 'Standard',
      ratePerKwh: '0.12',
      restrictions: null,
      priority: 0,
      isDefault: true,
    },
    {
      id: 2,
      siteId: 'sit_1',
      name: 'Weekday Peak',
      ratePerKwh: '0.22',
      restrictions: {
        timeRange: { startTime: '16:00', endTime: '21:00' },
        daysOfWeek: [1, 2, 3, 4, 5],
      },
      priority: 20,
      isDefault: false,
    },
  ];

  beforeEach(() => {
    periodsMock.mockReset();
    periodsMock.mockResolvedValue(periods);
  });

  it('moves only a claimed faulted EndRequestFailed session to completed with its cost', async () => {
    const { sql, calls } = makeSql([
      ['LEFT JOIN sites si ON si.id = s.site_id', [{ site_id: 'sit_1', timezone: 'UTC' }]],
      ["SET status = 'completed'", [{ id: 'ses_1' }]],
    ]);
    const changed = await completeRebilledSession(sql, {
      sessionId: 'ses_1',
      breakdown,
      // Thursday 01:00 UTC: the standard rate, 10 kWh x 0.12.
      endedAt: new Date('2026-06-04T01:00:00Z'),
      energyWh: 10_000,
      outcome: 'manual',
    });
    expect(changed).toBe(true);
    const update = calls.find((c) => c.text.includes("SET status = 'completed'"));
    const text = update?.text ?? '';
    expect(text).toContain("AND status = 'faulted'");
    expect(text).toContain("AND rebill_status = 'in_progress'");
    expect(text).toContain('electricity_cost_cents = COALESCE(electricity_cost_cents, ?::integer)');
    expect(update?.values).toEqual([
      '2026-06-04T01:00:00.000Z',
      400,
      400,
      400,
      0,
      { json: breakdown },
      120,
      'manual',
      'ses_1',
      'EndRequestFailed',
    ]);
    expect(periodsMock).toHaveBeenCalledWith('sit_1');
  });

  it('prices the electricity cost like session end (computeSessionElectricityCost)', async () => {
    const { sql } = makeSql([
      [
        'LEFT JOIN sites si ON si.id = s.site_id',
        [{ site_id: 'sit_1', timezone: 'America/Chicago' }],
      ],
    ]);
    // Monday 22:30 UTC is 17:30 in Chicago: the weekday peak.
    const endedAt = new Date('2026-06-08T22:30:00Z');
    expect(await rebillElectricityCostCents(sql, 'ses_1', endedAt, 10_000)).toBe(
      computeSessionElectricityCost({
        periods,
        endedAt,
        energyWh: 10_000,
        timezone: 'America/Chicago',
      }).costCents,
    );
    expect(await rebillElectricityCostCents(sql, 'ses_1', endedAt, 10_000)).toBe(220);
  });

  it('reads the rates of the site the session happened at, not the station current site', async () => {
    const { sql, calls } = makeSql([
      ['LEFT JOIN sites si ON si.id = s.site_id', [{ site_id: 'sit_old', timezone: 'UTC' }]],
    ]);
    periodsMock.mockResolvedValue(periods);
    await rebillElectricityCostCents(sql, 'ses_1', new Date('2026-06-08T22:30:00Z'), 10_000);
    expect(calls[0]?.text).toContain('SELECT s.site_id, si.timezone');
    expect(calls[0]?.text).not.toContain('charging_stations');
    expect(periodsMock).toHaveBeenCalledWith('sit_old');
  });

  it('records no electricity cost without a site, a matching period or energy', async () => {
    const unsited = makeSql([
      ['LEFT JOIN sites si ON si.id = s.site_id', [{ site_id: null, timezone: null }]],
    ]);
    expect(
      await rebillElectricityCostCents(unsited.sql, 'ses_1', new Date('2026-06-08T22:30:00Z'), 1),
    ).toBeNull();
    const sited = makeSql([
      ['LEFT JOIN sites si ON si.id = s.site_id', [{ site_id: 'sit_1', timezone: 'UTC' }]],
    ]);
    periodsMock.mockResolvedValue([]);
    expect(
      await rebillElectricityCostCents(sited.sql, 'ses_1', new Date('2026-06-08T22:30:00Z'), 1),
    ).toBeNull();
    periodsMock.mockResolvedValue(periods);
    expect(
      await rebillElectricityCostCents(sited.sql, 'ses_1', new Date('2026-06-08T22:30:00Z'), 0),
    ).toBeNull();
  });
});
