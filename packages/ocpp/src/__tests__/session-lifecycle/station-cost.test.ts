// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import type { Logger } from '@evtivity/lib';
import {
  recordStationCost,
  stationCostTolerance,
  stationReportedCost,
} from '../../server/session-lifecycle/station-cost.js';

interface Call {
  text: string;
  values: unknown[];
}

function makeSql(returning: Record<string, unknown>[]): { sql: postgres.Sql; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    calls.push({ text, values });
    return Promise.resolve(text.includes('RETURNING') ? returning : []);
  };
  return { sql: fn as unknown as postgres.Sql, calls };
}

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger & {
    warn: ReturnType<typeof vi.fn>;
  };
}

const details = (total: Record<string, number>, extra: Record<string, unknown> = {}) => ({
  totalCost: { currency: 'EUR', typeOfCost: 'Normal', total },
  totalUsage: { energy: 10000, chargingTime: 3600, idleTime: 600 },
  ...extra,
});

describe('stationReportedCost', () => {
  it('reads the total including tax in cents', () => {
    expect(stationReportedCost(details({ exclTax: 10, inclTax: 11.9 }))).toEqual({
      cents: 1190,
      includesTax: true,
      currency: 'EUR',
    });
  });

  it('falls back to the total excluding tax', () => {
    expect(stationReportedCost(details({ exclTax: 10 }))).toEqual({
      cents: 1000,
      includesTax: false,
      currency: 'EUR',
    });
  });

  it('is null when the station could not calculate the cost (I12.FR.14)', () => {
    expect(stationReportedCost(details({ inclTax: 0 }, { failureToCalculate: true }))).toBeNull();
    expect(stationReportedCost(null)).toBeNull();
    expect(stationReportedCost({ totalCost: { total: {} } })).toBeNull();
  });
});

describe('stationCostTolerance', () => {
  it('is 1% of the billed cost, at least 2 cents', () => {
    expect(stationCostTolerance(0)).toBe(2);
    expect(stationCostTolerance(150)).toBe(2);
    expect(stationCostTolerance(1190)).toBe(12);
  });
});

describe('recordStationCost', () => {
  const event = {
    stationUuid: 'sta_1',
    transactionId: 'tx-1',
    stationTariffId: 'evt-abc',
  };

  it('stores the tariff id and the cost details of an Updated event without comparing', async () => {
    const { sql, calls } = makeSql([
      { id: 'ses_1', final_cost_cents: null, net_cents: 500, currency: 'EUR' },
    ]);
    const logger = makeLogger();
    await recordStationCost(sql, logger, {
      ...event,
      eventType: 'Updated',
      costDetails: details({ inclTax: 5.95 }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.values).toEqual(expect.arrayContaining(['evt-abc', 595, 'sta_1', 'tx-1']));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stores the difference on Ended and logs it above the tolerance', async () => {
    const { sql, calls } = makeSql([
      { id: 'ses_1', final_cost_cents: 1100, net_cents: 924, currency: 'eur' },
    ]);
    const logger = makeLogger();
    await recordStationCost(sql, logger, {
      ...event,
      eventType: 'Ended',
      costDetails: details({ exclTax: 10, inclTax: 11.9 }),
    });
    expect(calls[1]?.text).toContain('station_cost_difference_cents');
    expect(calls[1]?.values).toEqual([90, 'ses_1']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_1', differenceCents: 90, billedCents: 1100 }),
      'Station-calculated cost differs from the billed cost',
    );
  });

  it('compares a total without tax with the net and stays quiet within the tolerance', async () => {
    const { sql, calls } = makeSql([
      { id: 'ses_1', final_cost_cents: 1100, net_cents: 1000, currency: 'EUR' },
    ]);
    const logger = makeLogger();
    await recordStationCost(sql, logger, {
      ...event,
      eventType: 'Ended',
      costDetails: details({ exclTax: 10.01 }),
    });
    expect(calls[1]?.values).toEqual([1, 'ses_1']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not compare amounts in another currency', async () => {
    const { sql, calls } = makeSql([
      { id: 'ses_1', final_cost_cents: 1100, net_cents: 1000, currency: 'USD' },
    ]);
    const logger = makeLogger();
    await recordStationCost(sql, logger, {
      ...event,
      eventType: 'Ended',
      costDetails: details({ inclTax: 11 }),
    });
    expect(calls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a tariff id or cost details', async () => {
    const { sql, calls } = makeSql([]);
    await recordStationCost(sql, makeLogger(), {
      ...event,
      stationTariffId: null,
      eventType: 'Ended',
      costDetails: undefined,
    });
    expect(calls).toHaveLength(0);
  });

  it('logs and goes on when the update fails', async () => {
    const sql = (() => Promise.reject(new Error('db down'))) as unknown as postgres.Sql;
    const logger = makeLogger();
    await recordStationCost(sql, logger, { ...event, eventType: 'Ended', costDetails: null });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'tx-1' }),
      'Failed to record the station-calculated cost',
    );
  });
});
