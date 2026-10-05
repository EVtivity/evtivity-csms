// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadStationPricing: vi.fn(),
  getPricingHolidays: vi.fn(),
  partnerTariffMappings: vi.fn(),
}));

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  client: {},
  loadStationPricing: mocks.loadStationPricing,
  getPricingHolidays: mocks.getPricingHolidays,
}));
vi.mock('../services/published-tariffs.js', () => ({
  partnerTariffMappings: mocks.partnerTariffMappings,
}));

const { connectorTariffIds, stationTariffId } = await import('../services/connector-tariffs.js');

const updatedAt = new Date('2026-09-01T00:00:00Z');

function mapping(
  ocpiTariffId: string,
  source: { tariffId?: string; pricingGroupId?: string },
  partnerId: string | null = null,
) {
  return {
    id: 1,
    ocpiTariffId,
    tariffId: source.tariffId ?? null,
    pricingGroupId: source.pricingGroupId ?? null,
    partnerId,
    updatedAt,
  };
}

function tariff(id: string, restrictions: Record<string, unknown> | null, isDefault: boolean) {
  return {
    id,
    name: id,
    pricePerKwh: '0.30',
    pricePerMinute: null,
    pricePerSession: null,
    idleFeePricePerMinute: null,
    reservationFeePerMinute: null,
    taxRate: null,
    restrictions,
    priority: restrictions == null ? 0 : 10,
    isDefault,
  };
}

const PRICING = {
  group: { id: 'pgr_1', name: 'Group', source: 'site' as const },
  timezone: 'UTC',
  tariffs: [
    // Weekend daytime (Saturday and Sunday, 08:00 to 20:00), else the default.
    tariff(
      'trf_weekend',
      { daysOfWeek: [0, 6], timeRange: { startTime: '08:00', endTime: '20:00' } },
      false,
    ),
    tariff('trf_default', null, true),
  ],
};
// A Wednesday.
const WEDNESDAY = new Date('2026-09-02T12:00:00Z');
const SATURDAY = new Date('2026-09-05T12:00:00Z');

describe('stationTariffId', () => {
  it('links the mapping of the station pricing group', () => {
    const mappings = [
      mapping('T-DEFAULT', { tariffId: 'trf_default' }),
      mapping('T-GROUP', { pricingGroupId: 'pgr_1' }),
    ];
    expect(stationTariffId(PRICING, mappings, [], WEDNESDAY)).toBe('T-GROUP');
  });

  it('prefers the partner own group mapping over a global one', () => {
    const mappings = [
      mapping('A-GLOBAL', { pricingGroupId: 'pgr_1' }),
      mapping('Z-PARTNER', { pricingGroupId: 'pgr_1' }, 'opr_1'),
    ];
    expect(stationTariffId(PRICING, mappings, [], WEDNESDAY)).toBe('Z-PARTNER');
  });

  it('links the mapping of the tariff that applies now when the group is not published', () => {
    const mappings = [
      mapping('T-DEFAULT', { tariffId: 'trf_default' }),
      mapping('T-WEEKEND', { tariffId: 'trf_weekend' }),
    ];
    expect(stationTariffId(PRICING, mappings, [], WEDNESDAY)).toBe('T-DEFAULT');
    expect(stationTariffId(PRICING, mappings, [], SATURDAY)).toBe('T-WEEKEND');
  });

  it('links nothing when no mapping publishes the station pricing', () => {
    const mappings = [mapping('T-OTHER', { pricingGroupId: 'pgr_2' })];
    expect(stationTariffId(PRICING, mappings, [], WEDNESDAY)).toBeNull();
    expect(stationTariffId(null, mappings, [], WEDNESDAY)).toBeNull();
  });
});

describe('connectorTariffIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPricingHolidays.mockResolvedValue([]);
  });

  it('resolves each station without a driver and skips free-vend stations', async () => {
    mocks.partnerTariffMappings.mockResolvedValue([
      mapping('T-GROUP', { pricingGroupId: 'pgr_1' }),
    ]);
    mocks.loadStationPricing.mockResolvedValue(PRICING);

    const result = await connectorTariffIds(
      'opr_1',
      [
        { id: 'sta_1', freeVend: false },
        { id: 'sta_2', freeVend: true },
      ],
      WEDNESDAY,
    );

    expect(result).toEqual(new Map([['sta_1', ['T-GROUP']]]));
    expect(mocks.partnerTariffMappings).toHaveBeenCalledWith('opr_1');
    expect(mocks.loadStationPricing).toHaveBeenCalledTimes(1);
    expect(mocks.loadStationPricing).toHaveBeenCalledWith(
      { stationUuid: 'sta_1', driverUuid: null },
      {},
    );
  });

  it('does not resolve pricing when the partner sees no tariff', async () => {
    mocks.partnerTariffMappings.mockResolvedValue([]);
    const result = await connectorTariffIds('opr_1', [{ id: 'sta_1', freeVend: false }]);
    expect(result.size).toBe(0);
    expect(mocks.loadStationPricing).not.toHaveBeenCalled();
  });
});
