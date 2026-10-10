// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type { ElectricityRatePeriod } from '@evtivity/lib';

vi.mock('../config.js', () => ({ db: {}, client: {} }));

import {
  SEED_ELECTRICITY_RATE_PERIODS,
  ensureSiteElectricityRates,
  seedElectricityRateRows,
  seedSessionElectricityCostCents,
} from '../seed-electricity-rates.js';

const periods: ElectricityRatePeriod[] = seedElectricityRateRows('sit_1').map((row, i) => ({
  id: i + 1,
  ...row,
}));
const TZ = 'America/New_York';

describe('SEED_ELECTRICITY_RATE_PERIODS', () => {
  it('holds a 0.12 Standard default and a 0.22 weekday peak from 16:00 to 21:00', () => {
    expect(SEED_ELECTRICITY_RATE_PERIODS).toEqual([
      {
        name: 'Standard',
        ratePerKwh: '0.120000',
        restrictions: null,
        priority: 0,
        isDefault: true,
      },
      {
        name: 'Weekday Peak',
        ratePerKwh: '0.220000',
        restrictions: {
          timeRange: { startTime: '16:00', endTime: '21:00' },
          daysOfWeek: [1, 2, 3, 4, 5],
        },
        priority: 20,
        isDefault: false,
      },
    ]);
  });

  it('builds insert rows for a site', () => {
    const rows = seedElectricityRateRows('sit_x');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.siteId === 'sit_x')).toBe(true);
  });
});

describe('seedSessionElectricityCostCents', () => {
  it('prices a weekday evening session at the peak rate in the site timezone', () => {
    // Wednesday 2026-10-07 18:00 New York (22:00 UTC).
    const endedAt = new Date('2026-10-07T22:00:00Z');
    expect(seedSessionElectricityCostCents(periods, 10_000, endedAt, TZ)).toBe(220);
  });

  it('prices other times at the Standard rate', () => {
    // Wednesday 10:00 New York, and Saturday 18:00 New York.
    expect(
      seedSessionElectricityCostCents(periods, 10_000, new Date('2026-10-07T14:00:00Z'), TZ),
    ).toBe(120);
    expect(
      seedSessionElectricityCostCents(periods, 10_000, new Date('2026-10-10T22:00:00Z'), TZ),
    ).toBe(120);
  });

  it('rounds through the pricing engine', () => {
    // 1.234 kWh at 0.12 = 14.808 cents.
    expect(
      seedSessionElectricityCostCents(periods, 1234, new Date('2026-10-07T14:00:00Z'), TZ),
    ).toBe(15);
  });

  it('is null without energy or without a matching period', () => {
    const at = new Date('2026-10-07T14:00:00Z');
    expect(seedSessionElectricityCostCents(periods, 0, at, TZ)).toBeNull();
    expect(seedSessionElectricityCostCents([], 10_000, at, TZ)).toBeNull();
  });
});

describe('ensureSiteElectricityRates', () => {
  it('inserts guarded by a site without periods and returns the inserted count', async () => {
    const execute = vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const count = await ensureSiteElectricityRates({ execute } as never, 'sit_000000000001');
    expect(count).toBe(2);
    expect(execute).toHaveBeenCalledTimes(1);
    const query = execute.mock.calls[0]?.[0] as { queryChunks: unknown[] };
    const text = JSON.stringify(query.queryChunks);
    expect(text).toContain('NOT EXISTS (SELECT 1 FROM site_electricity_rate_periods');
    expect(text).toContain('sit_000000000001');
  });

  it('returns 0 when the guard skips the site', async () => {
    const execute = vi.fn().mockResolvedValue([]);
    expect(await ensureSiteElectricityRates({ execute } as never, 'sit_1')).toBe(0);
  });
});
