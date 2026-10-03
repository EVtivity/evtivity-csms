// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { toOcpiRestrictions, transformTariff } from '../transformers/tariff.transformer.js';
import type { TariffSource, TariffTransformInput } from '../transformers/tariff.transformer.js';

const tariff: TariffSource = {
  id: 'trf_1',
  pricePerKwh: '0.30',
  pricePerMinute: null,
  pricePerSession: '1.00',
  idleFeePricePerMinute: null,
  reservationFeePerMinute: null,
  taxRate: null,
  restrictions: null,
  priority: 0,
  isDefault: true,
  isActive: true,
};

function input(overrides: Partial<TariffTransformInput> = {}): TariffTransformInput {
  return {
    tariffs: [tariff],
    applyRestrictions: false,
    holidays: [],
    today: '2026-10-02',
    currency: 'EUR',
    taxBasis: 'net',
    countryCode: 'DE',
    partyId: 'EVT',
    ocpiTariffId: 'T-1',
    lastUpdated: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

function single(source: Partial<TariffSource>): TariffTransformInput {
  return input({ tariffs: [{ ...tariff, ...source }] });
}

describe('transformTariff', () => {
  it('publishes the tariff in the given company currency with the mapping id', () => {
    const result = transformTariff(input(), '2.2.1');
    expect(result).toMatchObject({
      country_code: 'DE',
      party_id: 'EVT',
      id: 'T-1',
      currency: 'EUR',
      type: 'REGULAR',
      last_updated: '2026-09-01T00:00:00.000Z',
    });
  });

  it('prices energy and the session fee net, with step_size 1', () => {
    const result = transformTariff(input(), '2.2.1');
    expect(result.elements).toEqual([
      {
        price_components: [
          { type: 'ENERGY', price: 0.3, step_size: 1 },
          { type: 'FLAT', price: 1, step_size: 1 },
        ],
      },
    ]);
  });

  it('sends the tax rate as a VAT percentage on every component', () => {
    const result = transformTariff(
      single({ taxRate: '0.19', pricePerMinute: '0.05', idleFeePricePerMinute: '0.10' }),
      '2.2.1',
    );
    const components = result.elements.flatMap((e) => e.price_components);
    expect(components).toHaveLength(4);
    for (const component of components) {
      expect(component.vat).toBe(19);
    }
  });

  it('keeps a fractional percentage exact', () => {
    const result = transformTariff(single({ taxRate: '0.0825' }), '2.2.1');
    expect(result.elements[0]?.price_components[0]?.vat).toBe(8.25);
  });

  it('sends no vat for a tariff without a tax rate or with rate 0', () => {
    for (const taxRate of [null, '0']) {
      const result = transformTariff(single({ taxRate }), '2.3.0');
      for (const component of result.elements.flatMap((e) => e.price_components)) {
        expect(component).not.toHaveProperty('vat');
      }
      expect(result).toHaveProperty('tax_included', 'N/A');
    }
  });

  it('prices TIME per hour and PARKING_TIME as the time price plus the idle fee', () => {
    // The calculator bills the time price for the whole session and the idle
    // fee on top while the EV is not charging.
    const result = transformTariff(
      single({ pricePerMinute: '0.05', idleFeePricePerMinute: '0.10' }),
      '2.2.1',
    );
    expect(result.elements[0]?.price_components).toEqual(
      expect.arrayContaining([
        { type: 'TIME', price: 3, step_size: 1 },
        { type: 'PARKING_TIME', price: 9, step_size: 1 },
      ]),
    );
  });

  it('prices PARKING_TIME with the time price when there is no idle fee', () => {
    const result = transformTariff(single({ pricePerMinute: '0.05' }), '2.2.1');
    expect(result.elements[0]?.price_components).toEqual(
      expect.arrayContaining([{ type: 'PARKING_TIME', price: 3, step_size: 1 }]),
    );
  });

  it('publishes a reservation fee as a TIME element with the RESERVATION restriction', () => {
    const result = transformTariff(
      single({ reservationFeePerMinute: '0.02', taxRate: '0.19' }),
      '2.2.1',
    );
    expect(result.elements[0]).toEqual({
      price_components: [{ type: 'TIME', price: 1.2, step_size: 1, vat: 19 }],
      restrictions: { reservation: 'RESERVATION' },
    });
    expect(result.elements[1]?.restrictions).toBeUndefined();
  });

  it('states in 2.3.0 that prices exclude tax', () => {
    expect(transformTariff(single({ taxRate: '0.19' }), '2.3.0')).toHaveProperty(
      'tax_included',
      'NO',
    );
    expect(transformTariff(input(), '2.2.1')).not.toHaveProperty('tax_included');
  });

  it('publishes a single mapped tariff without its restrictions, even when inactive', () => {
    const result = transformTariff(
      single({
        restrictions: { timeRange: { startTime: '22:00', endTime: '06:00' } },
        priority: 10,
        isDefault: false,
        isActive: false,
      }),
      '2.2.1',
    );
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]?.restrictions).toBeUndefined();
  });

  it('sends a free ENERGY component when nothing is priced', () => {
    const result = transformTariff(single({ pricePerKwh: null, pricePerSession: null }), '2.2.1');
    expect(result.elements).toEqual([
      { price_components: [{ type: 'ENERGY', price: 0, step_size: 1 }] },
    ]);
  });
});

describe('transformTariff for a pricing group', () => {
  const offPeak: TariffSource = {
    ...tariff,
    id: 'trf_off',
    pricePerKwh: '0.20',
    pricePerSession: null,
    restrictions: { timeRange: { startTime: '22:00', endTime: '06:00' }, daysOfWeek: [6, 0] },
    priority: 20,
    isDefault: false,
  };
  const bulk: TariffSource = {
    ...tariff,
    id: 'trf_bulk',
    pricePerKwh: '0.25',
    pricePerSession: null,
    restrictions: { energyThresholdKwh: 40 },
    priority: 50,
    isDefault: false,
  };

  it('orders elements as the resolver does, restricted first, default last', () => {
    const result = transformTariff(
      input({ tariffs: [tariff, offPeak, bulk], applyRestrictions: true }),
      '2.2.1',
    );
    expect(result.elements.map((e) => e.restrictions)).toEqual([
      { min_kwh: 40 },
      { start_time: '22:00', end_time: '06:00', day_of_week: ['SUNDAY', 'SATURDAY'] },
      undefined,
    ]);
  });

  it('lists every priced dimension in every element, 0 where the tariff does not price it', () => {
    // Partners look up each dimension in the first matching element: the
    // off-peak window must not fall through to the default session fee.
    const result = transformTariff(
      input({ tariffs: [tariff, offPeak], applyRestrictions: true }),
      '2.2.1',
    );
    expect(result.elements[0]?.price_components).toEqual([
      { type: 'ENERGY', price: 0.2, step_size: 1 },
      { type: 'FLAT', price: 0, step_size: 1 },
    ]);
    expect(result.elements[1]?.price_components).toEqual([
      { type: 'ENERGY', price: 0.3, step_size: 1 },
      { type: 'FLAT', price: 1, step_size: 1 },
    ]);
  });

  it('leaves out inactive tariffs and tariffs the resolver never picks', () => {
    const result = transformTariff(
      input({
        tariffs: [
          tariff,
          { ...offPeak, isActive: false },
          { ...bulk, restrictions: null, priority: 0, isDefault: false },
        ],
        applyRestrictions: true,
      }),
      '2.2.1',
    );
    expect(result.elements).toHaveLength(1);
  });

  it('reports tax_included NO when any tariff of the group is taxed', () => {
    const result = transformTariff(
      input({ tariffs: [tariff, { ...offPeak, taxRate: '0.19' }], applyRestrictions: true }),
      '2.3.0',
    );
    expect(result).toHaveProperty('tax_included', 'NO');
  });

  it('expands holidays into one element per upcoming holiday', () => {
    const holiday: TariffSource = {
      ...offPeak,
      id: 'trf_hol',
      restrictions: { holidays: true },
      priority: 40,
    };
    const result = transformTariff(
      input({
        tariffs: [tariff, holiday],
        applyRestrictions: true,
        holidays: ['2026-01-01', '2026-12-25', '2026-12-26'],
      }),
      '2.2.1',
    );
    expect(result.elements.map((e) => e.restrictions)).toEqual([
      { start_date: '2026-12-25', end_date: '2026-12-26' },
      { start_date: '2026-12-26', end_date: '2026-12-27' },
      undefined,
    ]);
  });

  it('publishes nothing for a group without an applicable tariff but a free ENERGY component', () => {
    const result = transformTariff(input({ tariffs: [], applyRestrictions: true }), '2.2.1');
    expect(result.elements).toEqual([
      { price_components: [{ type: 'ENERGY', price: 0, step_size: 1 }] },
    ]);
  });
});

describe('toOcpiRestrictions', () => {
  it('maps a time range to start_time and end_time', () => {
    expect(
      toOcpiRestrictions({ timeRange: { startTime: '09:00', endTime: '17:00' } }, [], '2026-10-02'),
    ).toEqual([{ start_time: '09:00', end_time: '17:00' }]);
  });

  it('maps an energy threshold to min_kwh', () => {
    expect(toOcpiRestrictions({ energyThresholdKwh: 20 }, [], '2026-10-02')).toEqual([
      { min_kwh: 20 },
    ]);
  });

  it('maps a yearly date range to the occurrences that have not ended, end exclusive', () => {
    expect(
      toOcpiRestrictions({ dateRange: { startDate: '06-01', endDate: '08-31' } }, [], '2026-10-02'),
    ).toEqual([{ start_date: '2027-06-01', end_date: '2027-09-01' }]);
  });

  it('maps a date range across the new year, including the running one', () => {
    expect(
      toOcpiRestrictions({ dateRange: { startDate: '11-01', endDate: '02-29' } }, [], '2026-12-10'),
    ).toEqual([
      { start_date: '2026-11-01', end_date: '2027-03-01' },
      { start_date: '2027-11-01', end_date: '2028-03-01' },
    ]);
  });

  it('returns no restriction (tariff left out) without an upcoming holiday', () => {
    expect(toOcpiRestrictions({ holidays: true }, ['2026-01-01'], '2026-10-02')).toEqual([]);
  });
});

describe('transformTariff on the gross tax basis', () => {
  it('sends net prices: the tax rate taken out of every gross price', () => {
    const result = transformTariff(
      input({
        taxBasis: 'gross',
        tariffs: [
          {
            ...tariff,
            pricePerKwh: '0.357',
            pricePerSession: '1.19',
            pricePerMinute: '0.0595',
            idleFeePricePerMinute: '0.119',
            reservationFeePerMinute: '0.0119',
            taxRate: '0.19',
          },
        ],
      }),
      '2.3.0',
    );
    // Net: 0.30/kWh, 0.05/min = 3.00/h, 1.00 fee, idle 0.10/min on top = 9.00/h
    // parking, reservation 0.01/min = 0.60/h.
    expect(result.elements).toEqual([
      {
        price_components: [{ type: 'TIME', price: 0.6, step_size: 1, vat: 19 }],
        restrictions: { reservation: 'RESERVATION' },
      },
      {
        price_components: [
          { type: 'ENERGY', price: 0.3, step_size: 1, vat: 19 },
          { type: 'TIME', price: 3, step_size: 1, vat: 19 },
          { type: 'PARKING_TIME', price: 9, step_size: 1, vat: 19 },
          { type: 'FLAT', price: 1, step_size: 1, vat: 19 },
        ],
      },
    ]);
  });

  it('rounds a converted price to 4 decimals', () => {
    const result = transformTariff(
      input({
        taxBasis: 'gross',
        tariffs: [{ ...tariff, pricePerKwh: '0.50', pricePerSession: null, taxRate: '0.19' }],
      }),
      '2.2.1',
    );
    // 0.50 / 1.19 = 0.42016806...
    expect(result.elements[0]?.price_components[0]?.price).toBe(0.4202);
  });
});
