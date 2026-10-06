// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Each awaited select chain resolves to the next queued result, in the order
// the service awaits its queries.
let selectResults: unknown[][] = [];
const updateSets: Array<Record<string, unknown>> = [];
const limitArgs: number[] = [];
const offsetArgs: number[] = [];

function makeSelectChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'innerJoin']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['limit'] = vi.fn((n: number) => {
    limitArgs.push(n);
    return chain;
  });
  chain['offset'] = vi.fn((n: number) => {
    offsetArgs.push(n);
    return chain;
  });
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(selectResults.shift() ?? []).then(resolve);
  return chain;
}

function makeUpdateChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain['set'] = vi.fn((values: Record<string, unknown>) => {
    updateSets.push(values);
    return chain;
  });
  chain['where'] = vi.fn(() => chain);
  chain['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
  return chain;
}

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: {
    select: vi.fn(() => makeSelectChain()),
    update: vi.fn(() => makeUpdateChain()),
  },
}));

const {
  sessionPlace,
  partnerToken,
  renderCpoSession,
  syncCpoSessionRow,
  cpoSessionLink,
  listPartnerCpoSessions,
} = await import('../services/cpo-sessions.js');
type ChargingSessionRow = import('../services/cpo-sessions.js').ChargingSessionRow;
const { config } = await import('../lib/config.js');

const started = new Date('2026-09-01T10:00:00Z');
const ended = new Date('2026-09-01T11:00:00Z');
const updated = new Date('2026-09-01T11:05:00Z');

function sessionRow(overrides: Record<string, unknown> = {}): ChargingSessionRow {
  return {
    id: 'ses_000000000001',
    stationId: 'sta_000000000001',
    evseId: 'evs_aaaaaaaaaaaa',
    connectorId: 'con_000000000001',
    status: 'completed',
    startedAt: started,
    endedAt: ended,
    updatedAt: updated,
    energyDeliveredWh: '12345',
    currency: 'EUR',
    currentCostCents: null,
    finalCostCents: 1210,
    tariffTaxRate: '0.21',
    idleStartedAt: null,
    idleMinutes: '0',
    costBreakdown: null,
    ...overrides,
  } as unknown as ChargingSessionRow;
}

const STATION = { id: 'sta_000000000001', stationId: 'CS-0001', siteId: 'sit_000000000001' };
const SITE = { id: 'sit_000000000001', name: 'Main Street' };
const EVSE = { id: 'evs_aaaaaaaaaaaa', evseId: 2 };
const CONNECTOR = { connectorId: 3, connectorType: 'CCS2' };

const LINK = {
  id: 9,
  partnerId: 'opr_000000000001',
  ocpiSessionId: 'OCPI-SES-1',
  chargingSessionId: 'ses_000000000001',
  tokenUid: 'TOK001',
};
const TOKEN_ROW = {
  uid: 'TOK001',
  countryCode: 'NL',
  partyId: 'EMS',
  tokenType: 'APP_USER',
  tokenData: { contract_id: 'NL-EMS-C00001-X' },
};

beforeEach(() => {
  selectResults = [];
  updateSets.length = 0;
  limitArgs.length = 0;
  offsetArgs.length = 0;
});

describe('sessionPlace', () => {
  it('returns null when the station no longer exists', async () => {
    selectResults = [[]];
    expect(await sessionPlace(sessionRow())).toBeNull();
  });

  it('uses the published OCPI location id and the EVSE and connector of the session', async () => {
    selectResults = [[STATION], [SITE], [{ ocpiLocationId: 'LOC-PUB-1' }], [EVSE], [CONNECTOR]];
    expect(await sessionPlace(sessionRow())).toEqual({
      siteId: STATION.siteId,
      site: SITE,
      locationId: 'LOC-PUB-1',
      evseUid: 'evs_aaaaaaaaaaaa',
      evseId: 'CS-0001-EVSE-2',
      connectorId: '3',
      connectorType: 'CCS2',
    });
  });

  it('falls back to the site id when the site is not published', async () => {
    selectResults = [[STATION], [SITE], [], [], []];
    const place = await sessionPlace(sessionRow());
    expect(place).toMatchObject({
      locationId: STATION.siteId,
      evseUid: 'unknown',
      evseId: 'unknown',
      connectorId: '1',
      connectorType: null,
    });
  });

  it('falls back to the station id for a station without a site and skips site lookups', async () => {
    selectResults = [[{ ...STATION, siteId: null }]];
    const place = await sessionPlace(sessionRow({ evseId: null, connectorId: null }));
    expect(place).toEqual({
      siteId: null,
      site: null,
      locationId: STATION.id,
      evseUid: 'unknown',
      evseId: 'unknown',
      connectorId: '1',
      connectorType: null,
    });
    expect(selectResults).toHaveLength(0);
  });
});

describe('partnerToken', () => {
  it('returns an empty-party token source when the partner never sent the token', async () => {
    selectResults = [[]];
    expect(await partnerToken('opr_1', 'TOK404')).toEqual({
      uid: 'TOK404',
      countryCode: '',
      partyId: '',
    });
  });

  it('returns the stored token with its contract id', async () => {
    selectResults = [[TOKEN_ROW]];
    expect(await partnerToken('opr_1', 'TOK001')).toEqual({
      uid: 'TOK001',
      countryCode: 'NL',
      partyId: 'EMS',
      tokenType: 'APP_USER',
      contractId: 'NL-EMS-C00001-X',
    });
  });

  it('gives a null contract id when the token data has none', async () => {
    selectResults = [[{ ...TOKEN_ROW, tokenData: null }]];
    expect((await partnerToken('opr_1', 'TOK001')).contractId).toBeNull();
    selectResults = [[{ ...TOKEN_ROW, tokenData: { contract_id: 5 } }]];
    expect((await partnerToken('opr_1', 'TOK001')).contractId).toBeNull();
  });
});

describe('renderCpoSession', () => {
  it('returns null when the session place cannot be resolved', async () => {
    selectResults = [[]];
    expect(await renderCpoSession(LINK, sessionRow(), '2.2.1')).toBeNull();
  });

  it('renders a completed session as a 2.2.1 OCPI Session', async () => {
    selectResults = [
      [STATION],
      [SITE],
      [{ ocpiLocationId: 'LOC-PUB-1' }],
      [EVSE],
      [CONNECTOR],
      [TOKEN_ROW],
    ];
    const session = await renderCpoSession(LINK, sessionRow(), '2.2.1');
    expect(session).toMatchObject({
      country_code: config.OCPI_COUNTRY_CODE,
      party_id: config.OCPI_PARTY_ID,
      id: 'OCPI-SES-1',
      start_date_time: started.toISOString(),
      end_date_time: ended.toISOString(),
      kwh: 12.345,
      location_id: 'LOC-PUB-1',
      evse_uid: 'evs_aaaaaaaaaaaa',
      connector_id: '3',
      currency: 'EUR',
      status: 'COMPLETED',
      auth_method: 'AUTH_REQUEST',
      last_updated: updated.toISOString(),
      cdr_token: {
        country_code: 'NL',
        party_id: 'EMS',
        uid: 'TOK001',
        type: 'APP_USER',
        contract_id: 'NL-EMS-C00001-X',
      },
      total_cost: { excl_vat: 10, incl_vat: 12.1 },
    });
  });

  it('renders the running cost of an active session as 2.3.0 before_taxes', async () => {
    selectResults = [[{ ...STATION, siteId: null }], [EVSE], [CONNECTOR], [TOKEN_ROW]];
    const now = new Date('2026-09-01T10:30:00Z');
    const session = await renderCpoSession(
      LINK,
      sessionRow({ status: 'active', endedAt: null, currentCostCents: 121, finalCostCents: null }),
      '2.3.0',
      now,
    );
    expect(session?.status).toBe('ACTIVE');
    expect(session?.end_date_time).toBeUndefined();
    expect(session?.total_cost).toMatchObject({ before_taxes: 1 });
  });

  it('omits total_cost when the session has no cost yet', async () => {
    selectResults = [[{ ...STATION, siteId: null }], [], [], []];
    const session = await renderCpoSession(
      LINK,
      sessionRow({ status: 'active', endedAt: null, currentCostCents: null }),
      '2.2.1',
    );
    expect(session).not.toHaveProperty('total_cost');
    expect(session?.cdr_token).toMatchObject({ uid: 'TOK001', contract_id: 'TOK001' });
  });
});

describe('syncCpoSessionRow', () => {
  it('stores the status, kWh, net total, and session data', async () => {
    const ocpi = {
      status: 'COMPLETED',
      kwh: 12.345,
      currency: 'EUR',
      total_cost: { excl_vat: 10, incl_vat: 12.1 },
    } as unknown as Parameters<typeof syncCpoSessionRow>[1];
    await syncCpoSessionRow(LINK, ocpi, '2.2.1');
    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]).toMatchObject({
      status: 'COMPLETED',
      kwh: '12.345',
      totalCost: '10',
      currency: 'EUR',
      sessionData: ocpi,
    });
  });

  it('stores a null total when the session has no cost', async () => {
    const ocpi = { status: 'ACTIVE', kwh: 0, currency: 'EUR' } as unknown as Parameters<
      typeof syncCpoSessionRow
    >[1];
    await syncCpoSessionRow(LINK, ocpi, '2.3.0');
    expect(updateSets[0]).toMatchObject({ kwh: '0', totalCost: null });
  });
});

describe('cpoSessionLink', () => {
  it('returns null when no link exists', async () => {
    selectResults = [[]];
    expect(await cpoSessionLink('ses_x')).toBeNull();
  });

  it('returns null for a row without a charging session', async () => {
    selectResults = [[{ ...LINK, chargingSessionId: null }]];
    expect(await cpoSessionLink('ses_x')).toBeNull();
  });

  it('returns the link row', async () => {
    selectResults = [[LINK]];
    expect(await cpoSessionLink('ses_000000000001')).toEqual(LINK);
  });
});

describe('listPartnerCpoSessions', () => {
  it('renders each linked session and returns the total', async () => {
    selectResults = [
      [{ link: LINK, session: sessionRow() }],
      [{ count: 4 }],
      [{ ...STATION, siteId: null }],
      [EVSE],
      [CONNECTOR],
      [TOKEN_ROW],
    ];
    const result = await listPartnerCpoSessions('opr_000000000001', '2.2.1', {
      offset: 3,
      limit: 1,
      dateFrom: new Date('2026-09-01T00:00:00Z'),
      dateTo: new Date('2026-09-02T00:00:00Z'),
    });
    expect(result.total).toBe(4);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ id: 'OCPI-SES-1', location_id: STATION.id });
    expect(limitArgs[0]).toBe(1);
    expect(offsetArgs).toEqual([3]);
  });

  it('drops sessions whose station is gone and defaults a missing count to zero', async () => {
    selectResults = [[{ link: LINK, session: sessionRow() }], [], []];
    const result = await listPartnerCpoSessions('opr_000000000001', '2.3.0', {
      offset: 0,
      limit: 50,
    });
    expect(result).toEqual({ total: 0, sessions: [] });
  });
});
