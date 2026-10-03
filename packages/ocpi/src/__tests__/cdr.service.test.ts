// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Each awaited select chain resolves to the next queued result; inserts are recorded.
let selectResults: unknown[][] = [];
let inserted: Record<string, unknown>[] = [];
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(selectResults.shift() ?? []).then(resolve);
  return chain;
}
function makeInsertChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    values: vi.fn((v: Record<string, unknown>) => {
      inserted.push(v);
      return chain;
    }),
  };
  chain['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
  return chain;
}

const mocks = vi.hoisted(() => ({
  ocpiCdrCost: vi.fn(),
  sessionTariffMapping: vi.fn(),
  renderTariffMapping: vi.fn(),
  createCreditCdr: vi.fn(),
  notifyRoamingCdrChanged: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: { select: vi.fn(() => makeChain()), insert: vi.fn(() => makeInsertChain()) },
  chargingSessions: { id: {} },
  ocpiCdrs: { ocpiCdrId: {}, id: {} },
  ocpiRoamingSessions: { chargingSessionId: {}, tokenUid: {} },
  ocpiPartnerEndpoints: {},
  ocpiPartners: { id: {}, version: {} },
  ocpiSyncLog: {},
  createCreditCdr: mocks.createCreditCdr,
}));
vi.mock('../lib/pubsub.js', () => ({ notifyRoamingCdrChanged: mocks.notifyRoamingCdrChanged }));
vi.mock('../lib/outbound-token.js', () => ({ getOutboundToken: vi.fn() }));
vi.mock('../services/session-cost-split.js', () => ({
  ocpiCdrCost: mocks.ocpiCdrCost,
  idleMinutesAt: () => 0,
}));
vi.mock('../services/cpo-sessions.js', () => ({
  sessionPlace: vi.fn(async () => ({
    siteId: 'sit_1',
    site: null,
    locationId: 'LOC-1',
    evseUid: 'evs_1',
    evseId: 'CS-1-EVSE-1',
    connectorId: '1',
    connectorType: 'Type2',
  })),
  partnerToken: vi.fn(async (_partnerId: string, uid: string) => ({
    uid,
    countryCode: 'NL',
    partyId: 'MSP',
  })),
}));
vi.mock('../services/published-tariffs.js', () => ({
  sessionTariffMapping: mocks.sessionTariffMapping,
  renderTariffMapping: mocks.renderTariffMapping,
}));

const { generateCdr, generateCreditCdr } = await import('../services/cdr.service.js');

const startedAt = new Date('2026-09-01T10:00:00Z');
const endedAt = new Date('2026-09-01T11:00:00Z');
const SESSION = {
  id: 'ses_1',
  transactionId: 'tx-1',
  stationId: 'sta_1',
  evseId: null,
  connectorId: null,
  startedAt,
  endedAt,
  energyDeliveredWh: '10000',
  finalCostCents: 476,
  currency: 'eur',
  tariffId: 'trf_1',
};

function primeGenerate(version: string): void {
  selectResults = [[SESSION], [{ tokenUid: 'TOKEN-1' }], [{ version }]];
}

beforeEach(() => {
  selectResults = [];
  inserted = [];
  vi.clearAllMocks();
  mocks.ocpiCdrCost.mockReturnValue({
    total: [{ taxRate: 0.19, netCents: 400, taxCents: 76 }],
  });
  mocks.sessionTariffMapping.mockResolvedValue(null);
});

describe('generateCdr', () => {
  it('sends the net as excl_vat and the amount charged as incl_vat to a 2.2.1 partner', async () => {
    primeGenerate('2.2.1');
    const cdr = await generateCdr('ses_1', 'opr_1');
    expect(cdr?.total_cost).toEqual({ excl_vat: 4, incl_vat: 4.76 });
    expect(mocks.ocpiCdrCost).toHaveBeenCalledWith(SESSION);
    // ocpi_cdrs.total_cost holds the amount excluding tax.
    expect(inserted[0]).toMatchObject({ totalCost: '4', currency: 'EUR' });
  });

  it('sends a 2.3.0 Price to a 2.3.0 partner', async () => {
    primeGenerate('2.3.0');
    const cdr = await generateCdr('ses_1', 'opr_1');
    expect(cdr?.total_cost).toEqual({
      before_taxes: 4,
      taxes: [{ name: 'VAT', percentage: 19, amount: 0.76 }],
    });
    expect(inserted[0]).toMatchObject({ totalCost: '4' });
  });

  it('uses the published location id and the partner token', async () => {
    primeGenerate('2.2.1');
    const cdr = await generateCdr('ses_1', 'opr_1');
    expect(cdr?.cdr_location.id).toBe('LOC-1');
    expect(cdr?.cdr_token).toMatchObject({ uid: 'TOKEN-1', country_code: 'NL', party_id: 'MSP' });
  });

  it('embeds the tariff generated for the partner from the mapping covering the session tariff', async () => {
    primeGenerate('2.3.0');
    const mapping = { id: 1, ocpiTariffId: 'T-1', tariffId: null, pricingGroupId: 'pgr_1' };
    const generated = { id: 'T-1', currency: 'EUR', elements: [], tax_included: 'NO' };
    mocks.sessionTariffMapping.mockResolvedValue(mapping);
    mocks.renderTariffMapping.mockResolvedValue(generated);
    const cdr = await generateCdr('ses_1', 'opr_1');
    expect(mocks.sessionTariffMapping).toHaveBeenCalledWith('opr_1', 'trf_1');
    expect(mocks.renderTariffMapping).toHaveBeenCalledWith(mapping, '2.3.0');
    expect(cdr?.tariffs).toEqual([generated]);
  });

  it('embeds no tariff when no mapping publishes the session tariff to the partner', async () => {
    primeGenerate('2.2.1');
    const cdr = await generateCdr('ses_1', 'opr_1');
    expect(cdr).not.toHaveProperty('tariffs');
  });
});

describe('generateCreditCdr', () => {
  it('stores the credit through the shared builder and notifies the CSMS', async () => {
    const cdrData = { id: 'cdr-2', credit: true, total_cost: { excl_vat: -4 } };
    mocks.createCreditCdr.mockResolvedValue({ status: 'created', cdrId: 'cdr-2', cdrData });
    expect(await generateCreditCdr('cdr-1', 'wrong tariff')).toEqual(cdrData);
    expect(mocks.createCreditCdr).toHaveBeenCalledWith('cdr-1', 'wrong tariff');
    expect(mocks.notifyRoamingCdrChanged).toHaveBeenCalled();
  });

  it('returns the existing credit CDR without a second notification', async () => {
    const cdrData = { id: 'cdr-2', credit: true };
    mocks.createCreditCdr.mockResolvedValue({ status: 'existing', cdrId: 'cdr-2', cdrData });
    expect(await generateCreditCdr('cdr-1', 'again')).toEqual(cdrData);
    expect(mocks.notifyRoamingCdrChanged).not.toHaveBeenCalled();
  });

  it('returns null when the CDR cannot be credited', async () => {
    for (const status of ['not_found', 'is_credit', 'invalid_cdr']) {
      mocks.createCreditCdr.mockResolvedValue({ status });
      expect(await generateCreditCdr('cdr-1', 'x')).toBeNull();
    }
  });
});
