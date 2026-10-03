// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type postgres from 'postgres';

const {
  loadStationPricing,
  resolveStationTariff,
  resolveGroupTariffs,
  isStationChargingFree,
  getPricingHolidays,
  clearTariffResolutionCache,
} = await import('../lib/tariff-resolution.js');

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
  return { sql: fn as unknown as postgres.Sql, calls };
}

const GROUP = { group_id: 'pgr_1', group_name: 'Members', group_priority: 1, timezone: null };

const DEFAULT_TARIFF = {
  id: 'trf_default',
  name: 'Standard',
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
  name: 'Off-peak',
  price_per_kwh: '0.18',
  restrictions: { timeRange: { startTime: '20:00', endTime: '08:00' } },
  priority: 10,
  is_default: false,
};

const HOLIDAY_TARIFF = {
  ...DEFAULT_TARIFF,
  id: 'trf_holiday',
  name: 'Holiday',
  price_per_kwh: '0.10',
  restrictions: { holidays: true },
  priority: 30,
  is_default: false,
};

const ENERGY_TARIFF = {
  ...DEFAULT_TARIFF,
  id: 'trf_bulk',
  name: 'Bulk',
  price_per_kwh: '0.20',
  restrictions: { energyThresholdKwh: 20 },
  priority: 50,
  is_default: false,
};

function pricingRows(
  tariffs: Array<Record<string, unknown>>,
  group: Record<string, unknown> = GROUP,
): Record<string, unknown>[] {
  return tariffs.map((t) => ({ ...group, ...t }));
}

beforeEach(() => {
  clearTariffResolutionCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('loadStationPricing', () => {
  it('passes the station and driver to the one statement and maps every tier', async () => {
    const sources = ['driver', 'fleet', 'station', 'site', 'default'];
    for (const [i, source] of sources.entries()) {
      const { sql, calls } = makeSql([
        ['WITH driver_group', pricingRows([DEFAULT_TARIFF], { ...GROUP, group_priority: i + 1 })],
      ]);
      const pricing = await loadStationPricing({ stationUuid: 'sta_1', driverUuid: 'drv_1' }, sql);
      expect(pricing?.group).toEqual({ id: 'pgr_1', name: 'Members', source });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.values).toEqual(['drv_1', 'drv_1', 'sta_1', 'sta_1', 'sta_1']);
      // driver > fleet (oldest membership) > station > site > default.
      expect(calls[0]?.text).toContain('ORDER BY fd.created_at ASC');
      expect(calls[0]?.text).toContain('ORDER BY priority');
    }
  });

  it('matches no driver tier for a driverless lookup', async () => {
    const { sql, calls } = makeSql([]);
    expect(await loadStationPricing({ stationUuid: 'sta_1', driverUuid: null }, sql)).toBeNull();
    expect(calls[0]?.values.slice(0, 2)).toEqual(['', '']);
  });

  it('reports a group without active tariffs with an empty list', async () => {
    const { sql } = makeSql([
      ['WITH driver_group', [{ ...GROUP, timezone: 'Europe/Berlin', id: null, name: null }]],
    ]);
    const pricing = await loadStationPricing({ stationUuid: 'sta_1', driverUuid: null }, sql);
    expect(pricing).toEqual({
      group: { id: 'pgr_1', name: 'Members', source: 'driver' },
      timezone: 'Europe/Berlin',
      tariffs: [],
    });
  });
});

describe('resolveStationTariff', () => {
  it('picks the restricted tariff whose time window matches in the site timezone', async () => {
    const { sql } = makeSql([
      [
        'WITH driver_group',
        pricingRows([DEFAULT_TARIFF, OFF_PEAK_TARIFF], { ...GROUP, timezone: 'America/New_York' }),
      ],
    ]);

    // 23:30 in New York (03:30 UTC the next day) is off-peak.
    const tariff = await resolveStationTariff(
      { stationUuid: 'sta_1', driverUuid: 'drv_1', at: new Date('2026-10-03T03:30:00Z') },
      sql,
    );

    expect(tariff).toEqual({
      id: 'trf_offpeak',
      name: 'Off-peak',
      pricePerKwh: '0.18',
      pricePerMinute: null,
      pricePerSession: '0.50',
      idleFeePricePerMinute: null,
      reservationFeePerMinute: null,
      taxRate: '0.0825',
      restrictions: { timeRange: { startTime: '20:00', endTime: '08:00' } },
      priority: 10,
      isDefault: false,
      pricingGroup: { id: 'pgr_1', name: 'Members', source: 'driver' },
      timezone: 'America/New_York',
    });
  });

  it('falls back to the default tariff outside the restricted window', async () => {
    const { sql } = makeSql([
      [
        'WITH driver_group',
        pricingRows([DEFAULT_TARIFF, OFF_PEAK_TARIFF], { ...GROUP, timezone: 'America/New_York' }),
      ],
    ]);

    // 12:00 in New York is outside 20:00-08:00.
    const tariff = await resolveStationTariff(
      { stationUuid: 'sta_1', driverUuid: 'drv_1', at: new Date('2026-10-03T16:00:00Z') },
      sql,
    );

    expect(tariff).toMatchObject({ id: 'trf_default', pricePerKwh: '0.25', isDefault: true });
  });

  it('applies the holiday tariff on a pricing holiday', async () => {
    const { sql } = makeSql([
      ['WITH driver_group', pricingRows([DEFAULT_TARIFF, HOLIDAY_TARIFF])],
      ['FROM pricing_holidays', [{ date: '2026-12-25' }]],
    ]);

    const onHoliday = await resolveStationTariff(
      { stationUuid: 'sta_1', driverUuid: null, at: new Date('2026-12-25T12:00:00Z') },
      sql,
    );
    const nextDay = await resolveStationTariff(
      { stationUuid: 'sta_1', driverUuid: null, at: new Date('2026-12-26T12:00:00Z') },
      sql,
    );

    expect(onHoliday?.id).toBe('trf_holiday');
    expect(nextDay?.id).toBe('trf_default');
  });

  it('uses the session energy for energy-threshold tariffs (0 by default)', async () => {
    const { sql } = makeSql([['WITH driver_group', pricingRows([DEFAULT_TARIFF, ENERGY_TARIFF])]]);
    const q = { stationUuid: 'sta_1', driverUuid: null, at: new Date('2026-10-03T12:00:00Z') };

    expect((await resolveStationTariff(q, sql))?.id).toBe('trf_default');
    expect((await resolveStationTariff({ ...q, sessionEnergyKwh: 25 }, sql))?.id).toBe('trf_bulk');
  });

  it('returns null without a group, without active tariffs, or without a match', async () => {
    const q = { stationUuid: 'sta_1', driverUuid: null };
    expect(await resolveStationTariff(q, makeSql([]).sql)).toBeNull();
    expect(
      await resolveStationTariff(
        q,
        makeSql([['WITH driver_group', [{ ...GROUP, id: null, name: null }]]]).sql,
      ),
    ).toBeNull();
    // Only a restricted tariff and no default: nothing applies at noon.
    expect(
      await resolveStationTariff(
        { ...q, at: new Date('2026-10-03T12:00:00Z') },
        makeSql([['WITH driver_group', pricingRows([OFF_PEAK_TARIFF])]]).sql,
      ),
    ).toBeNull();
  });

  it('does not read holidays when the group has no tariffs', async () => {
    const { sql, calls } = makeSql([]);
    await resolveStationTariff({ stationUuid: 'sta_1', driverUuid: null }, sql);
    expect(calls.some((c) => c.text.includes('pricing_holidays'))).toBe(false);
  });
});

describe('resolveGroupTariffs', () => {
  it('returns every active tariff with the current one in the given timezone', async () => {
    const { sql, calls } = makeSql([['FROM tariffs', [DEFAULT_TARIFF, OFF_PEAK_TARIFF]]]);

    const result = await resolveGroupTariffs(
      'pgr_1',
      { at: new Date('2026-10-03T03:30:00Z'), timezone: 'America/New_York' },
      sql,
    );

    expect(result.tariffs.map((t) => t.id)).toEqual(['trf_default', 'trf_offpeak']);
    expect(result.current?.id).toBe('trf_offpeak');
    expect(calls[0]?.values).toEqual(['pgr_1']);
  });

  it('has no current tariff for a group without tariffs', async () => {
    const result = await resolveGroupTariffs('pgr_1', { at: new Date() }, makeSql([]).sql);
    expect(result).toEqual({ tariffs: [], current: null });
  });
});

describe('isStationChargingFree', () => {
  const RESERVATION_ONLY = {
    ...DEFAULT_TARIFF,
    price_per_kwh: '0',
    price_per_session: '0',
    reservation_fee_per_minute: '0.10',
  };

  it('is free at a free-vend site without looking up a tariff', async () => {
    const { sql, calls } = makeSql([['WITH driver_group', pricingRows([DEFAULT_TARIFF])]]);
    const free = await isStationChargingFree(
      { stationUuid: 'sta_1', driverUuid: 'drv_1', reserved: false, freeVend: true },
      sql,
    );
    expect(free).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('is free without a tariff and paid with a priced tariff', async () => {
    const q = { stationUuid: 'sta_1', driverUuid: 'drv_1', reserved: false, freeVend: false };
    expect(await isStationChargingFree(q, makeSql([]).sql)).toBe(true);
    expect(
      await isStationChargingFree(
        q,
        makeSql([['WITH driver_group', pricingRows([DEFAULT_TARIFF])]]).sql,
      ),
    ).toBe(false);
  });

  it('counts the reservation fee only for the reservation holder', async () => {
    const { sql } = makeSql([['WITH driver_group', pricingRows([RESERVATION_ONLY])]]);
    const q = { stationUuid: 'sta_1', driverUuid: 'drv_1', freeVend: false };
    expect(await isStationChargingFree({ ...q, reserved: false }, sql)).toBe(true);
    expect(await isStationChargingFree({ ...q, reserved: true }, sql)).toBe(false);
  });
});

describe('getPricingHolidays', () => {
  it('caches for 60 seconds and reloads after the TTL or a clear', async () => {
    vi.useFakeTimers();
    const { sql, calls } = makeSql([['FROM pricing_holidays', [{ date: '2026-12-25' }]]]);

    expect(await getPricingHolidays(sql)).toEqual([new Date('2026-12-25')]);
    await getPricingHolidays(sql);
    expect(calls).toHaveLength(1);

    vi.advanceTimersByTime(60_001);
    await getPricingHolidays(sql);
    expect(calls).toHaveLength(2);

    clearTariffResolutionCache();
    await getPricingHolidays(sql);
    expect(calls).toHaveLength(3);
  });
});
