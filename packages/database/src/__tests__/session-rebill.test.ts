// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const graceMock = vi.fn();
const splitMock = vi.fn();
vi.mock('../lib/idling-setting.js', () => ({ getIdlingGracePeriodMinutes: graceMock }));
vi.mock('../lib/pricing-settings.js', () => ({ isSplitBillingEnabled: splitMock }));

const {
  SESSION_REBILL_LEASE_SECONDS,
  claimSessionRebill,
  releaseSessionRebill,
  priceRebill,
  completeRebilledSession,
} = await import('../lib/session-rebill.js');

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
  splitMock.mockResolvedValue(false);
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
  it('prices at the last meter value with the metered energy and reopens the given-up segment', async () => {
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
    ]);
    const result = await priceRebill(sql, 'ses_1');
    expect(result?.endedAt.toISOString()).toBe('2026-06-04T01:00:00.000Z');
    expect(result?.energyWh).toBe(10000);
    // 10 kWh * 0.30 + 1.00 session fee
    expect(result?.breakdown.grossCents).toBe(400);
    const reopen = calls.find((c) => c.text.includes('SET ended_at = NULL'));
    expect(reopen?.text).toContain('energy_wh_end IS NULL');
    const close = calls.find((c) => c.text.includes('SET ended_at = ?'));
    expect(close?.values).toContain(10000);
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

  it('never bills before the start of the latest tariff segment (no negative duration)', async () => {
    const { sql, calls } = makeSql([
      ['FROM charging_sessions s\n    LEFT JOIN', [pricingRow]],
      [
        'last_reading_at',
        [
          {
            ended_at: '2026-06-04T02:00:00Z',
            energy_delivered_wh: '10000',
            last_reading_at: '2026-06-04T01:00:00Z',
            last_segment_started_at: '2026-06-04T01:30:00Z',
          },
        ],
      ],
    ]);
    const result = await priceRebill(sql, 'ses_1');
    expect(result?.endedAt.toISOString()).toBe('2026-06-04T01:30:00.000Z');
    expect(calls.find((c) => c.text.includes('last_reading_at'))?.text).toContain(
      'max(seg.started_at)',
    );
    const close = calls.find((c) => c.text.includes('SET ended_at = ?'));
    expect(close?.values[0]).toBe('2026-06-04T01:30:00.000Z');
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
  it('moves only a claimed faulted EndRequestFailed session to completed with its cost', async () => {
    const { sql, calls } = makeSql([["SET status = 'completed'", [{ id: 'ses_1' }]]]);
    const breakdown = {
      basis: 'net',
      grossCents: 400,
      netCents: 400,
      taxCents: 0,
    } as unknown as Parameters<typeof completeRebilledSession>[1]['breakdown'];
    const changed = await completeRebilledSession(sql, {
      sessionId: 'ses_1',
      breakdown,
      endedAt: new Date('2026-06-04T01:00:00Z'),
      outcome: 'manual',
    });
    expect(changed).toBe(true);
    const text = calls[0]?.text ?? '';
    expect(text).toContain("AND status = 'faulted'");
    expect(text).toContain("AND rebill_status = 'in_progress'");
    expect(calls[0]?.values).toEqual([
      '2026-06-04T01:00:00.000Z',
      400,
      400,
      400,
      0,
      { json: breakdown },
      'manual',
      'ses_1',
      'EndRequestFailed',
    ]);
  });
});
