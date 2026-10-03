// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { clearPricingHolidayCache, resolveStationTariff } from '../server/station-tariff.js';

// A tagged-template stand-in that answers queries in order:
// pricing group, tariffs, holidays, site timezone.
function sqlReturning(...results: unknown[][]): postgres.Sql {
  let index = 0;
  const fn = (() => Promise.resolve(results[index++] ?? [])) as unknown as postgres.Sql;
  return fn;
}

const DEFAULT_TARIFF = {
  id: 'trf_default',
  price_per_kwh: '0.25',
  price_per_minute: null,
  price_per_session: '0.50',
  idle_fee_price_per_minute: null,
  reservation_fee_per_minute: null,
  tax_rate: '0.0825',
  restrictions: null,
  priority: 0,
  is_default: true,
};

const OFF_PEAK_TARIFF = {
  ...DEFAULT_TARIFF,
  id: 'trf_offpeak',
  price_per_kwh: '0.18',
  restrictions: { timeRange: { startTime: '20:00', endTime: '08:00' } },
  priority: 10,
  is_default: false,
};

describe('resolveStationTariff', () => {
  beforeEach(() => {
    clearPricingHolidayCache();
  });

  it('picks the restricted tariff whose time window matches in the site timezone', async () => {
    const sql = sqlReturning(
      [{ id: 'pgr_1' }],
      [DEFAULT_TARIFF, OFF_PEAK_TARIFF],
      [],
      [{ timezone: 'America/New_York' }],
    );

    // 23:30 in New York (03:30 UTC the next day) is off-peak.
    const tariff = await resolveStationTariff(
      sql,
      'sta_1',
      'drv_1',
      new Date('2026-10-03T03:30:00Z'),
    );

    expect(tariff).toMatchObject({ id: 'trf_offpeak', pricePerKwh: '0.18', taxRate: '0.0825' });
  });

  it('falls back to the default tariff outside the restricted window', async () => {
    const sql = sqlReturning(
      [{ id: 'pgr_1' }],
      [DEFAULT_TARIFF, OFF_PEAK_TARIFF],
      [],
      [{ timezone: 'America/New_York' }],
    );

    // 12:00 in New York is outside 20:00-08:00.
    const tariff = await resolveStationTariff(
      sql,
      'sta_1',
      'drv_1',
      new Date('2026-10-03T16:00:00Z'),
    );

    expect(tariff).toMatchObject({ id: 'trf_default', pricePerKwh: '0.25' });
  });

  it('returns null when no pricing group applies', async () => {
    const tariff = await resolveStationTariff(sqlReturning([]), 'sta_1', null);

    expect(tariff).toBeNull();
  });
});
