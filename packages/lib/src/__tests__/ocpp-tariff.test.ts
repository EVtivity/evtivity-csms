// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { buildOcppTariff, ocppTariffConditions } from '../ocpp-tariff.js';
import type { OcppTariffInput, OcppTariffSource } from '../ocpp-tariff.js';

function tariff(overrides: Partial<OcppTariffSource> = {}): OcppTariffSource {
  return {
    id: 'trf_default',
    pricePerKwh: null,
    pricePerMinute: null,
    pricePerSession: null,
    idleFeePricePerMinute: null,
    reservationFeePerMinute: null,
    taxRate: null,
    restrictions: null,
    priority: 0,
    isDefault: true,
    ...overrides,
  };
}

// Friday 2026-10-09 12:00 in Los Angeles.
const AT = new Date('2026-10-09T19:00:00Z');

function input(overrides: Partial<OcppTariffInput> = {}): OcppTariffInput {
  return {
    current: tariff(),
    groupTariffs: [],
    graceMinutes: 5,
    holidays: [],
    at: AT,
    timezone: 'America/Los_Angeles',
    currency: 'USD',
    taxBasis: 'net',
    support: { conditions: true, maxElements: null },
    ...overrides,
  };
}

const VAT8 = [{ type: 'VAT', tax: 8 }];

describe('buildOcppTariff: one tariff (no split billing)', () => {
  it('maps every price, billing time over the whole session and the idle fee after the grace', () => {
    const result = buildOcppTariff(
      input({
        current: tariff({
          pricePerKwh: '0.25',
          pricePerMinute: '0.15',
          pricePerSession: '2.00',
          idleFeePricePerMinute: '0.05',
          taxRate: '0.08',
        }),
      }),
    );
    expect(result).toEqual({
      tariffId: expect.stringMatching(/^evt-[0-9a-f]{40}$/),
      currency: 'USD',
      energy: { prices: [{ priceKwh: 0.25 }], taxRates: VAT8 },
      chargingTime: { prices: [{ priceMinute: 0.15 }], taxRates: VAT8 },
      // Idle minutes pay the time price; the idle fee adds to it after the
      // first 5 idle minutes (minIdleTime 300 s, inclusive).
      idleTime: {
        prices: [{ priceMinute: 0.2, conditions: { minIdleTime: 300 } }, { priceMinute: 0.15 }],
        taxRates: VAT8,
      },
      fixedFee: { prices: [{ priceFixed: 2 }], taxRates: VAT8 },
    });
    expect(result).not.toHaveProperty('validFrom');
  });

  it('sends the idle fee from the first idle minute without a grace period', () => {
    const result = buildOcppTariff(
      input({
        graceMinutes: 0,
        current: tariff({ idleFeePricePerMinute: '0.10' }),
      }),
    );
    expect(result.idleTime).toEqual({ prices: [{ priceMinute: 0.1 }] });
  });

  it('leaves the idle fee out for a station without conditions, as it cannot keep the grace free', () => {
    const result = buildOcppTariff(
      input({
        support: { conditions: false, maxElements: null },
        current: tariff({
          pricePerKwh: '0.30',
          pricePerMinute: '0.02',
          idleFeePricePerMinute: '0.10',
        }),
      }),
    );
    expect(result.idleTime).toEqual({ prices: [{ priceMinute: 0.02 }] });
    expect(JSON.stringify(result)).not.toContain('conditions');
  });

  it('maps the reservation fee to reservationTime', () => {
    const result = buildOcppTariff(
      input({ current: tariff({ pricePerKwh: '0.30', reservationFeePerMinute: '0.05' }) }),
    );
    expect(result.reservationTime).toEqual({ prices: [{ priceMinute: 0.05 }] });
  });

  it('sends prices excluding tax for a tariff entered on the gross basis', () => {
    const result = buildOcppTariff(
      input({
        taxBasis: 'gross',
        graceMinutes: 0,
        current: tariff({
          pricePerKwh: '0.357',
          pricePerSession: '1.19',
          idleFeePricePerMinute: '0.50',
          taxRate: '0.19',
        }),
      }),
    );
    expect(result.energy?.prices).toEqual([{ priceKwh: 0.3 }]);
    // 0.50 / 1.19 = 0.42016...
    expect(result.idleTime?.prices).toEqual([{ priceMinute: 0.4202 }]);
    expect(result.fixedFee?.prices).toEqual([{ priceFixed: 1 }]);
    expect(result.energy?.taxRates).toEqual([{ type: 'VAT', tax: 19 }]);
  });

  it('leaves out fields without a price and tax rates without tax', () => {
    const result = buildOcppTariff(
      input({ current: tariff({ pricePerKwh: '0.30', pricePerSession: '0', taxRate: '0' }) }),
    );
    expect(result).toEqual({
      tariffId: expect.any(String),
      currency: 'USD',
      energy: { prices: [{ priceKwh: 0.3 }] },
    });
  });

  it('gives different content a different tariffId and the same content the same one (I08.FR.08)', () => {
    const a = buildOcppTariff(input({ current: tariff({ pricePerKwh: '0.30' }) }));
    const b = buildOcppTariff(input({ current: tariff({ pricePerKwh: '0.30' }) }));
    const c = buildOcppTariff(input({ current: tariff({ pricePerKwh: '0.31' }) }));
    expect(a.tariffId).toBe(b.tariffId);
    expect(c.tariffId).not.toBe(a.tariffId);
    expect(a.tariffId.length).toBeLessThanOrEqual(60);
  });
});

describe('buildOcppTariff: pricing group (split billing)', () => {
  const base = tariff({ pricePerKwh: '0.30', pricePerMinute: '0.01', pricePerSession: '1.00' });
  const peak = tariff({
    id: 'trf_peak',
    isDefault: false,
    priority: 20,
    pricePerKwh: '0.50',
    restrictions: {
      timeRange: { startTime: '17:00', endTime: '21:00' },
      daysOfWeek: [1, 2, 3, 4, 5],
    },
  });
  const night = tariff({
    id: 'trf_night',
    isDefault: false,
    priority: 20,
    pricePerKwh: '0.20',
    restrictions: { timeRange: { startTime: '22:00', endTime: '06:00' }, daysOfWeek: [5] },
  });
  const bulk = tariff({
    id: 'trf_bulk',
    isDefault: false,
    priority: 50,
    pricePerKwh: '0.25',
    restrictions: { energyThresholdKwh: 40 },
  });
  const bigger = tariff({
    id: 'trf_bulk2',
    isDefault: false,
    priority: 50,
    pricePerKwh: '0.22',
    restrictions: { energyThresholdKwh: 80 },
  });

  it('sends every tariff as conditioned elements in resolution order, the default last', () => {
    const result = buildOcppTariff(
      input({ current: base, groupTariffs: [base, peak, night, bulk, bigger], graceMinutes: 0 }),
    );
    expect(result.energy?.prices).toEqual([
      // Highest threshold first: the highest threshold reached applies.
      { priceKwh: 0.22, conditions: { minEnergy: 80000 } },
      { priceKwh: 0.25, conditions: { minEnergy: 40000 } },
      // Night (Fri 22:00-06:00): calendar-day semantics, two windows.
      {
        priceKwh: 0.2,
        conditions: { startTimeOfDay: '00:00', endTimeOfDay: '06:00', dayOfWeek: ['Friday'] },
      },
      {
        priceKwh: 0.2,
        conditions: { startTimeOfDay: '22:00', endTimeOfDay: '00:00', dayOfWeek: ['Friday'] },
      },
      {
        priceKwh: 0.5,
        conditions: {
          startTimeOfDay: '17:00',
          endTimeOfDay: '21:00',
          dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        },
      },
      { priceKwh: 0.3 },
    ]);
    // Each element prices every field its tariff prices, 0 included, so a
    // window never falls through to the default's time price.
    expect(result.chargingTime?.prices.map((p) => p.priceMinute)).toEqual([0, 0, 0, 0, 0, 0.01]);
    // The session fee is applied at the start (0 kWh): no threshold elements.
    expect(result.fixedFee?.prices.map((p) => p.priceFixed)).toEqual([0, 0, 0, 1]);
    expect(JSON.stringify(result.fixedFee)).not.toContain('minEnergy');
  });

  it('sends days without a time window as the whole day (TC-T3-14)', () => {
    expect(ocppTariffConditions({ daysOfWeek: [3, 0] }, [], '2026-10-09')).toEqual([
      { dayOfWeek: ['Sunday', 'Wednesday'] },
    ]);
    const wednesday = tariff({
      id: 'trf_wed',
      isDefault: false,
      priority: 20,
      pricePerKwh: '0.15',
      restrictions: { daysOfWeek: [3] },
    });
    const result = buildOcppTariff(
      input({ current: base, groupTariffs: [base, wednesday, bulk], graceMinutes: 0 }),
    );
    expect(result.energy?.prices).toEqual([
      { priceKwh: 0.25, conditions: { minEnergy: 40000 } },
      { priceKwh: 0.15, conditions: { dayOfWeek: ['Wednesday'] } },
      { priceKwh: 0.3 },
    ]);
  });

  it('orders tariffs of one priority as the resolver does, by id code points', () => {
    // localeCompare would put 'trf_a' before 'trf_B'; the resolver compares
    // code points ('B' < 'a'), and the station must try them in that order.
    const lower = tariff({
      id: 'trf_a',
      isDefault: false,
      priority: 10,
      pricePerKwh: '0.40',
      restrictions: { timeRange: { startTime: '08:00', endTime: '12:00' } },
    });
    const upper = tariff({
      id: 'trf_B',
      isDefault: false,
      priority: 10,
      pricePerKwh: '0.45',
      restrictions: { timeRange: { startTime: '13:00', endTime: '17:00' } },
    });
    const result = buildOcppTariff(
      input({ current: base, groupTariffs: [lower, base, upper], graceMinutes: 0 }),
    );
    expect(result.energy?.prices.map((p) => p.priceKwh)).toEqual([0.45, 0.4, 0.3]);
  });

  it('keeps a midnight window without days as one wrapping window', () => {
    expect(
      ocppTariffConditions(
        { timeRange: { startTime: '22:00', endTime: '06:00' } },
        [],
        '2026-10-09',
      ),
    ).toEqual([{ startTimeOfDay: '22:00', endTimeOfDay: '06:00' }]);
  });

  it('dates holidays and seasons in the site local date', () => {
    // 2026-12-25 03:00 UTC is still December 24 in Los Angeles.
    const conditions = ocppTariffConditions(
      { holidays: true },
      ['2026-12-23', '2026-12-25', '2027-01-01'],
      '2026-12-24',
    );
    expect(conditions).toEqual([{ validFromDate: '2026-12-25', validToDate: '2026-12-26' }]);
    const holiday = tariff({
      id: 'trf_hol',
      isDefault: false,
      priority: 40,
      pricePerKwh: '0.10',
      restrictions: { holidays: true },
    });
    const result = buildOcppTariff(
      input({
        at: new Date('2026-12-25T03:00:00Z'),
        current: base,
        groupTariffs: [base, holiday],
        holidays: [new Date('2026-12-25T00:00:00Z')],
      }),
    );
    expect(result.energy?.prices[0]).toEqual({
      priceKwh: 0.1,
      conditions: { validFromDate: '2026-12-25', validToDate: '2026-12-26' },
    });
    expect(
      ocppTariffConditions(
        { dateRange: { startDate: '11-01', endDate: '02-28' } },
        [],
        '2026-12-24',
      ),
    ).toEqual([{ validFromDate: '2026-11-01', validToDate: '2027-03-01' }]);
  });

  it('combines a window with the idle grace on idleTime', () => {
    const idle = tariff({
      id: 'trf_idle',
      isDefault: false,
      priority: 10,
      idleFeePricePerMinute: '0.40',
      restrictions: { timeRange: { startTime: '08:00', endTime: '18:00' } },
    });
    const result = buildOcppTariff(input({ current: base, groupTariffs: [base, idle] }));
    expect(result.idleTime?.prices).toEqual([
      {
        priceMinute: 0.4,
        conditions: { startTimeOfDay: '08:00', endTimeOfDay: '18:00', minIdleTime: 300 },
      },
      { priceMinute: 0, conditions: { startTimeOfDay: '08:00', endTimeOfDay: '18:00' } },
      { priceMinute: 0.01 },
    ]);
  });

  it('sends the current tariff alone when the tariffs have different tax rates', () => {
    const taxed = { ...peak, taxRate: '0.19' };
    const result = buildOcppTariff(input({ current: base, groupTariffs: [base, taxed] }));
    expect(result.energy?.prices).toEqual([{ priceKwh: 0.3 }]);
  });

  it('sends the current tariff alone when the elements exceed MaxElements', () => {
    const result = buildOcppTariff(
      input({
        current: base,
        groupTariffs: [base, peak, night, bulk],
        support: { conditions: true, maxElements: 3 },
      }),
    );
    expect(result.energy?.prices).toEqual([{ priceKwh: 0.3 }]);
  });

  it('drops the grace element for a station that takes one price per field', () => {
    const result = buildOcppTariff(
      input({
        current: tariff({ pricePerMinute: '0.02', idleFeePricePerMinute: '0.10' }),
        support: { conditions: true, maxElements: 1 },
      }),
    );
    expect(result.idleTime?.prices).toEqual([{ priceMinute: 0.02 }]);
  });

  it('sends the current tariff alone when it is not one of the group', () => {
    const other = tariff({ id: 'trf_other', pricePerKwh: '0.40' });
    const result = buildOcppTariff(input({ current: other, groupTariffs: [base, peak] }));
    expect(result.energy?.prices).toEqual([{ priceKwh: 0.4 }]);
  });

  it('sends no restriction conditions to a station without conditions', () => {
    const result = buildOcppTariff(
      input({
        current: base,
        groupTariffs: [base, peak],
        support: { conditions: false, maxElements: null },
      }),
    );
    expect(result.energy?.prices).toEqual([{ priceKwh: 0.3 }]);
    expect(JSON.stringify(result)).not.toContain('conditions');
  });
});
