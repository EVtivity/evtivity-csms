// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Each awaited select chain resolves to the next queued result.
let selectResults: unknown[][] = [];
let whereCalls = 0;
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'limit', 'orderBy', 'innerJoin', 'leftJoin']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['where'] = vi.fn(() => {
    whereCalls += 1;
    return chain;
  });
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(selectResults.shift() ?? []).then(resolve);
  return chain;
}

const { mockCurrency, mockTaxBasis } = vi.hoisted(() => ({
  mockCurrency: vi.fn(),
  mockTaxBasis: vi.fn(),
}));

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: { select: vi.fn(() => makeChain()) },
  getCompanyCurrency: mockCurrency,
  getCompanyTaxBasis: mockTaxBasis,
}));

const {
  partnerTariffMappings,
  mappingsForPricingChange,
  sessionTariffMapping,
  renderTariffMapping,
  renderPartnerTariffs,
} = await import('../services/published-tariffs.js');
type TariffMappingRow = import('../services/published-tariffs.js').TariffMappingRow;
const { findEvseByUid } = await import('../lib/evse-lookup.js');
const { isLocationVisibleToPartner } = await import('../lib/location-visibility.js');
const { config } = await import('../lib/config.js');

const at = (day: number): Date => new Date(Date.UTC(2026, 8, day));

function mapping(overrides: Partial<TariffMappingRow> = {}): TariffMappingRow {
  return {
    id: 1,
    tariffId: 'trf_1',
    pricingGroupId: null,
    partnerId: null,
    ocpiTariffId: 'T-1',
    updatedAt: at(1),
    ...overrides,
  };
}

function tariffRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'trf_1',
    pricePerKwh: '0.30',
    pricePerMinute: null,
    pricePerSession: null,
    idleFeePricePerMinute: null,
    reservationFeePerMinute: null,
    taxRate: null,
    restrictions: null,
    priority: 0,
    isDefault: true,
    isActive: true,
    updatedAt: at(2),
    ...overrides,
  };
}

beforeEach(() => {
  selectResults = [];
  whereCalls = 0;
  mockCurrency.mockReset().mockResolvedValue('EUR');
  mockTaxBasis.mockReset().mockResolvedValue('net');
});

describe('partnerTariffMappings', () => {
  it('returns the effective mappings for the partner', async () => {
    selectResults = [
      [
        mapping({ id: 1, ocpiTariffId: 'A' }),
        mapping({ id: 2, partnerId: 'opr_1', ocpiTariffId: 'A' }),
        mapping({ id: 3, ocpiTariffId: 'B' }),
      ],
    ];
    const rows = await partnerTariffMappings('opr_1');
    expect(rows.map((r) => r.id).sort()).toEqual([2, 3]);
  });
});

describe('mappingsForPricingChange', () => {
  it('filters on the tariff and the pricing group when given', async () => {
    selectResults = [[mapping()]];
    const rows = await mappingsForPricingChange({ tariffId: 'trf_1', pricingGroupId: 'pg_1' });
    expect(rows).toEqual([mapping()]);
    expect(whereCalls).toBe(1);
  });

  it('returns every mapping for a holiday change (no filter)', async () => {
    selectResults = [[mapping(), mapping({ id: 2 })]];
    const rows = await mappingsForPricingChange({});
    expect(rows).toHaveLength(2);
    expect(whereCalls).toBe(0);
  });
});

describe('sessionTariffMapping', () => {
  it('prefers the partner own mapping over a global one', async () => {
    selectResults = [
      [{ pricingGroupId: 'pg_1' }],
      [
        mapping({ id: 1, tariffId: 'trf_1', ocpiTariffId: 'G' }),
        mapping({
          id: 2,
          tariffId: null,
          pricingGroupId: 'pg_1',
          partnerId: 'opr_1',
          ocpiTariffId: 'P',
        }),
      ],
    ];
    expect((await sessionTariffMapping('opr_1', 'trf_1'))?.id).toBe(2);
  });

  it('prefers a mapping to the tariff over one to its pricing group', async () => {
    selectResults = [
      [{ pricingGroupId: 'pg_1' }],
      [
        mapping({ id: 1, tariffId: null, pricingGroupId: 'pg_1', ocpiTariffId: 'A' }),
        mapping({ id: 2, tariffId: 'trf_1', ocpiTariffId: 'B' }),
      ],
    ];
    expect((await sessionTariffMapping('opr_1', 'trf_1'))?.id).toBe(2);
  });

  it('orders equal candidates by OCPI tariff id', async () => {
    selectResults = [
      [{ pricingGroupId: null }],
      [mapping({ id: 1, ocpiTariffId: 'Z' }), mapping({ id: 2, ocpiTariffId: 'M' })],
    ];
    expect((await sessionTariffMapping('opr_1', 'trf_1'))?.ocpiTariffId).toBe('M');
  });

  it('returns null when no mapping publishes the tariff', async () => {
    selectResults = [[], [mapping({ tariffId: 'trf_other' })]];
    expect(await sessionTariffMapping('opr_1', 'trf_1')).toBeNull();
  });
});

describe('renderTariffMapping', () => {
  it('returns null when the mapped tariff is gone', async () => {
    selectResults = [[]];
    expect(await renderTariffMapping(mapping(), '2.2.1')).toBeNull();
  });

  it('returns null when the mapped pricing group is gone', async () => {
    selectResults = [[]];
    expect(
      await renderTariffMapping(mapping({ tariffId: null, pricingGroupId: 'pg_1' }), '2.2.1'),
    ).toBeNull();
  });

  it('returns null for a mapping with neither source', async () => {
    expect(
      await renderTariffMapping(mapping({ tariffId: null, pricingGroupId: null }), '2.2.1'),
    ).toBeNull();
  });

  it('renders a tariff mapping in the company currency with the latest update time', async () => {
    selectResults = [[tariffRow({ updatedAt: at(5) })]];
    const tariff = await renderTariffMapping(mapping({ updatedAt: at(3) }), '2.2.1');
    expect(tariff).toMatchObject({
      country_code: config.OCPI_COUNTRY_CODE,
      party_id: config.OCPI_PARTY_ID,
      id: 'T-1',
      currency: 'EUR',
      last_updated: at(5).toISOString(),
    });
    expect(tariff?.elements[0]?.price_components).toEqual([
      { type: 'ENERGY', price: 0.3, step_size: 1 },
    ]);
  });

  it('renders a pricing group with its holidays and counts their creation time', async () => {
    selectResults = [
      [{ updatedAt: at(4) }],
      [
        tariffRow({ restrictions: { holidays: true } }),
        tariffRow({ id: 'trf_2', updatedAt: at(3) }),
      ],
      [
        { date: '2026-12-25', createdAt: at(10) },
        { date: new Date('2026-12-26T00:00:00Z'), createdAt: at(6) },
      ],
    ];
    const tariff = await renderTariffMapping(
      mapping({ tariffId: null, pricingGroupId: 'pg_1' }),
      '2.3.0',
      new Date('2026-12-01T00:00:00Z'),
    );
    expect(tariff?.last_updated).toBe(at(10).toISOString());
    expect(tariff?.currency).toBe('EUR');
    expect(selectResults).toHaveLength(0);
  });

  it('skips the holiday query when no group tariff uses holidays', async () => {
    selectResults = [
      [{ updatedAt: at(8) }],
      [tariffRow()],
      [{ date: '2026-12-25', createdAt: at(20) }],
    ];
    const tariff = await renderTariffMapping(
      mapping({ tariffId: null, pricingGroupId: 'pg_1' }),
      '2.2.1',
    );
    expect(tariff?.last_updated).toBe(at(8).toISOString());
    expect(selectResults).toHaveLength(1);
  });
});

describe('renderPartnerTariffs', () => {
  it('drops mappings whose source is gone', async () => {
    // One mapping: its tariff is gone, so nothing is rendered.
    selectResults = [[mapping()], []];
    expect(await renderPartnerTariffs('opr_1', '2.2.1')).toEqual([]);
  });

  it('sorts newest first, then by id', async () => {
    selectResults = [
      [
        mapping({ id: 1, tariffId: 'trf_1', ocpiTariffId: 'OLD', updatedAt: at(1) }),
        mapping({ id: 2, tariffId: 'trf_2', ocpiTariffId: 'NEW-B', updatedAt: at(9) }),
        mapping({ id: 3, tariffId: 'trf_3', ocpiTariffId: 'NEW-A', updatedAt: at(9) }),
      ],
      [tariffRow({ updatedAt: at(1) })],
      [tariffRow({ id: 'trf_2', updatedAt: at(1) })],
      [tariffRow({ id: 'trf_3', updatedAt: at(1) })],
    ];
    const tariffs = await renderPartnerTariffs('opr_1', '2.2.1');
    expect(tariffs.map((t) => t.id)).toEqual(['NEW-A', 'NEW-B', 'OLD']);
  });

  it('renders each mapping of the partner', async () => {
    selectResults = [[mapping({ ocpiTariffId: 'ONLY' })], [tariffRow()]];
    const tariffs = await renderPartnerTariffs('opr_1', '2.2.1');
    expect(tariffs.map((t) => t.id)).toEqual(['ONLY']);
  });
});

describe('findEvseByUid', () => {
  it('returns null for an unknown uid', async () => {
    selectResults = [[]];
    expect(await findEvseByUid('evs_missing')).toBeNull();
  });

  it('splits station state and flags a blocked station as removed', async () => {
    const updatedAt = at(1);
    const base = {
      evseDbId: 'evs_aaaaaaaaaaaa',
      evseNumber: 1,
      stationDbId: 'sta_1',
      stationOcppId: 'CS-1',
      siteId: 'sit_1',
      updatedAt,
      disabledReason: 'operator',
      firmwareState: null,
      reportedStatus: 'Faulted',
    };
    selectResults = [[{ ...base, onboardingStatus: 'blocked' }]];
    expect(await findEvseByUid('evs_aaaaaaaaaaaa')).toEqual({
      evseDbId: 'evs_aaaaaaaaaaaa',
      evseNumber: 1,
      stationDbId: 'sta_1',
      stationOcppId: 'CS-1',
      siteId: 'sit_1',
      updatedAt,
      stationState: { disabledReason: 'operator', firmwareState: null, reportedStatus: 'Faulted' },
      stationRemoved: true,
    });
    selectResults = [[{ ...base, onboardingStatus: 'accepted' }]];
    expect((await findEvseByUid('evs_aaaaaaaaaaaa'))?.stationRemoved).toBe(false);
  });
});

describe('isLocationVisibleToPartner', () => {
  it('is true when a published row matches', async () => {
    selectResults = [[{ id: 1 }]];
    expect(await isLocationVisibleToPartner('opr_1', 'sit_1')).toBe(true);
  });

  it('is false when nothing matches', async () => {
    selectResults = [[]];
    expect(await isLocationVisibleToPartner('opr_1', 'sit_1')).toBe(false);
  });
});
