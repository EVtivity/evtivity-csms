// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { computeSessionElectricityCost } from '@evtivity/lib';
import type { ElectricityRatePeriod } from '@evtivity/lib';

// Results of the select chains, in call order, and of each UPDATE.
const selectResults: unknown[][] = [];
const executeCalls: SQL[] = [];
const mockLoadPeriods = vi.fn();

function chain(): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'where', 'orderBy', 'limit']) c[m] = () => c;
  c['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(selectResults.shift() ?? []).then(resolve);
  return c;
}

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/database')>();
  return {
    ...actual,
    db: {
      select: () => chain(),
      execute: (q: SQL) => {
        executeCalls.push(q);
        // The UPDATE returns one row per (id, cost) pair it was given.
        const params = new PgDialect().sqlToQuery(q).params;
        return Promise.resolve(params.filter((_, i) => i % 2 === 0).map((id) => ({ id })));
      },
    },
    loadElectricityRatePeriodsForSite: (siteId: string) => mockLoadPeriods(siteId),
  };
});

import { recalculateSiteElectricityCost, sessionCostMissing } from '../electricity-cost.service.js';

const SITE = 'sit_000000000001';
const periods: ElectricityRatePeriod[] = [
  {
    id: 1,
    siteId: SITE,
    name: 'Standard',
    ratePerKwh: '0.12',
    restrictions: null,
    priority: 0,
    isDefault: true,
  },
  {
    id: 2,
    siteId: SITE,
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

function updateParams(index: number): unknown[] {
  const q = executeCalls[index];
  return q == null ? [] : new PgDialect().sqlToQuery(q).params;
}

beforeEach(() => {
  selectResults.length = 0;
  executeCalls.length = 0;
  mockLoadPeriods.mockReset();
  mockLoadPeriods.mockResolvedValue(periods);
});

describe('sessionCostMissing', () => {
  it('matches the revenue definition of cost missing', () => {
    const { sql: text, params } = new PgDialect().sqlToQuery(sessionCostMissing('EUR'));
    expect(text).toContain('"final_cost_cents" is not null');
    expect(text).toContain('"electricity_cost_cents" is null');
    expect(text).toContain('coalesce("charging_sessions"."energy_delivered_wh", 0) > 0');
    expect(text).toContain('upper("charging_sessions"."currency") = $1');
    expect(text).toContain("IS NOT DISTINCT FROM 'account'");
    // Sessions of conformance test stations are left out (inOperatorStation).
    expect(text).toContain('conf_st.id = "charging_sessions"."station_id"');
    expect(params).toEqual(['EUR']);
  });
});

describe('recalculateSiteElectricityCost', () => {
  it('prices each session through computeSessionElectricityCost in the site timezone', async () => {
    const sessions = [
      // Monday 17:30 in Chicago: the peak.
      { id: 'ses_a', endedAt: new Date('2026-06-08T22:30:00Z'), energyWh: '10000' },
      // Monday 12:00 in Chicago (17:00 UTC): the standard rate.
      { id: 'ses_b', endedAt: new Date('2026-06-08T17:00:00Z'), energyWh: '5000' },
    ];
    selectResults.push([{ n: 2 }], [{ timezone: 'America/Chicago' }], sessions, [{ n: 0 }]);
    const result = await recalculateSiteElectricityCost(SITE, { companyCurrency: 'EUR' });
    expect(result).toEqual({ before: 2, updated: 2, remaining: 0 });
    expect(mockLoadPeriods).toHaveBeenCalledWith(SITE);
    const expected = sessions.flatMap((s) => [
      s.id,
      computeSessionElectricityCost({
        periods,
        endedAt: s.endedAt,
        energyWh: Number(s.energyWh),
        timezone: 'America/Chicago',
      }).costCents,
    ]);
    expect(updateParams(0)).toEqual(expected);
    expect(expected).toEqual(['ses_a', 220, 'ses_b', 60]);
    expect(new PgDialect().sqlToQuery(executeCalls[0] as SQL).sql).toContain(
      'cs.electricity_cost_cents IS NULL',
    );
  });

  it('does nothing when no session misses a cost', async () => {
    selectResults.push([{ n: 0 }]);
    expect(await recalculateSiteElectricityCost(SITE, { companyCurrency: 'EUR' })).toEqual({
      before: 0,
      updated: 0,
      remaining: 0,
    });
    expect(mockLoadPeriods).not.toHaveBeenCalled();
    expect(executeCalls).toHaveLength(0);
  });

  it('writes nothing for a site without rate periods', async () => {
    mockLoadPeriods.mockResolvedValue([]);
    selectResults.push([{ n: 3 }], [{ timezone: 'UTC' }]);
    expect(await recalculateSiteElectricityCost(SITE, { companyCurrency: 'EUR' })).toEqual({
      before: 3,
      updated: 0,
      remaining: 3,
    });
    expect(executeCalls).toHaveLength(0);
  });

  it('reads in chunks, skips a session no period matches, and stops at maxUpdates', async () => {
    mockLoadPeriods.mockResolvedValue([periods[1]]);
    const peak = new Date('2026-06-08T18:00:00Z');
    const offPeak = new Date('2026-06-08T10:00:00Z');
    selectResults.push(
      [{ n: 5 }],
      [{ timezone: 'UTC' }],
      [
        { id: 'ses_1', endedAt: offPeak, energyWh: '1000' },
        { id: 'ses_2', endedAt: peak, energyWh: '1000' },
      ],
      [
        { id: 'ses_3', endedAt: peak, energyWh: '2000' },
        { id: 'ses_4', endedAt: peak, energyWh: '3000' },
      ],
      [{ n: 2 }],
    );
    const result = await recalculateSiteElectricityCost(SITE, {
      companyCurrency: 'EUR',
      chunkSize: 2,
      maxUpdates: 2,
    });
    expect(result).toEqual({ before: 5, updated: 2, remaining: 2 });
    expect(executeCalls).toHaveLength(2);
    expect(updateParams(0)).toEqual(['ses_2', 22]);
    expect(updateParams(1)).toEqual(['ses_3', 44]);
  });
});
