// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The OCPP 2.1 tariff for AC and DC tariffs (owner decision D-D): evseKind
// elements at Authorize, and the scoped fallback within a session's kind.

import { describe, expect, it } from 'vitest';
import { buildOcppKindTariff, buildOcppTariff } from '../ocpp-tariff.js';
import type { OcppTariffSource } from '../ocpp-tariff.js';

function tariff(overrides: Partial<OcppTariffSource> = {}): OcppTariffSource {
  return {
    id: 'trf_default',
    pricePerKwh: '0.40',
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

const AT = new Date('2026-10-09T19:00:00Z');
const BASE = {
  graceMinutes: 0,
  holidays: [],
  at: AT,
  timezone: 'America/Los_Angeles',
  currency: 'EUR',
  taxBasis: 'net' as const,
  support: { conditions: true, maxElements: null },
};
const DEFAULT = tariff();
const AC = tariff({ id: 'trf_ac', pricePerKwh: '0.30', isDefault: false, chargingType: 'ac' });
const DC = tariff({ id: 'trf_dc', pricePerKwh: '0.60', isDefault: false, chargingType: 'dc' });

describe('buildOcppKindTariff', () => {
  it('sends AC and DC elements with evseKind and the Both default as the fallback', () => {
    const result = buildOcppKindTariff({
      ...BASE,
      ac: { current: AC, groupTariffs: [] },
      dc: { current: DC, groupTariffs: [] },
      fallback: DEFAULT,
    });
    expect(result?.energy?.prices).toEqual([
      { priceKwh: 0.3, conditions: { evseKind: 'AC' } },
      { priceKwh: 0.6, conditions: { evseKind: 'DC' } },
      { priceKwh: 0.4 },
    ]);
    expect(result?.tariffId).toMatch(/^evt-[0-9a-f]{40}$/);
  });

  it('keeps the time windows of each kind with its evseKind', () => {
    const peak = tariff({
      id: 'trf_ac_peak',
      pricePerKwh: '0.35',
      isDefault: false,
      priority: 10,
      chargingType: 'ac',
      restrictions: { timeRange: { startTime: '09:00', endTime: '17:00' } },
    });
    const result = buildOcppKindTariff({
      ...BASE,
      ac: { current: peak, groupTariffs: [peak, AC, DEFAULT] },
      dc: { current: DC, groupTariffs: [] },
      fallback: DEFAULT,
    });
    expect(result?.energy?.prices).toEqual([
      {
        priceKwh: 0.35,
        conditions: { startTimeOfDay: '09:00', endTimeOfDay: '17:00', evseKind: 'AC' },
      },
      { priceKwh: 0.3, conditions: { evseKind: 'AC' } },
      { priceKwh: 0.6, conditions: { evseKind: 'DC' } },
      { priceKwh: 0.4 },
    ]);
  });

  it('returns null without conditions, above MaxElements or with two tax rates', () => {
    const kinds = {
      ac: { current: AC, groupTariffs: [] },
      dc: { current: DC, groupTariffs: [] },
      fallback: DEFAULT,
    };
    expect(
      buildOcppKindTariff({ ...BASE, ...kinds, support: { conditions: false, maxElements: null } }),
    ).toBeNull();
    expect(
      buildOcppKindTariff({ ...BASE, ...kinds, support: { conditions: true, maxElements: 2 } }),
    ).toBeNull();
    expect(
      buildOcppKindTariff({
        ...BASE,
        ...kinds,
        dc: { current: { ...DC, taxRate: '0.19' }, groupTariffs: [] },
      }),
    ).toBeNull();
  });

  it('puts evseKind on the fixed fee conditions too', () => {
    const result = buildOcppKindTariff({
      ...BASE,
      ac: { current: { ...AC, pricePerSession: '1.00' }, groupTariffs: [] },
      dc: { current: { ...DC, pricePerSession: '2.00' }, groupTariffs: [] },
      fallback: DEFAULT,
    });
    expect(result?.fixedFee?.prices).toEqual([
      { priceFixed: 1, conditions: { evseKind: 'AC' } },
      { priceFixed: 2, conditions: { evseKind: 'DC' } },
      { priceFixed: 0 },
    ]);
  });
});

describe('buildOcppTariff with a kind-filtered group', () => {
  it('uses the unrestricted AC tariff as the fallback element instead of the default', () => {
    const peak = tariff({
      id: 'trf_peak',
      pricePerKwh: '0.50',
      isDefault: false,
      priority: 10,
      restrictions: { timeRange: { startTime: '09:00', endTime: '17:00' } },
    });
    const result = buildOcppTariff({
      ...BASE,
      current: AC,
      groupTariffs: [peak, AC, DEFAULT],
    });
    expect(result.energy?.prices).toEqual([
      { priceKwh: 0.5, conditions: { startTimeOfDay: '09:00', endTimeOfDay: '17:00' } },
      { priceKwh: 0.3 },
    ]);
  });
});
