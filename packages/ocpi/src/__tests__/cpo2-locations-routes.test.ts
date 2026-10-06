// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { OcpiPartnerInfo } from '../middleware/ocpi-auth.js';

// Each awaited query chain resolves to the next queued result.
let dbResults: unknown[][] = [];
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'innerJoin', 'leftJoin', 'orderBy']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(dbResults.shift() ?? []).then(resolve);
  return chain;
}

const { mockFindEvseByUid, mockTariffIds, mockRemoved, mockVisible } = vi.hoisted(() => ({
  mockFindEvseByUid: vi.fn(),
  mockTariffIds: vi.fn(),
  mockRemoved: vi.fn(),
  mockVisible: vi.fn(),
}));

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: { select: vi.fn(() => makeChain()) },
  removedOcpiEvses: mockRemoved,
}));
vi.mock('../services/connector-tariffs.js', () => ({ connectorTariffIds: mockTariffIds }));

let partner: OcpiPartnerInfo | undefined;
vi.mock('../middleware/ocpi-auth.js', () => ({
  ocpiAuthenticate: async (request: { ocpiPartner?: OcpiPartnerInfo }) => {
    if (partner != null) request.ocpiPartner = partner;
  },
}));
vi.mock('../lib/location-visibility.js', () => ({ isLocationVisibleToPartner: mockVisible }));
vi.mock('../lib/evse-lookup.js', () => ({ findEvseByUid: mockFindEvseByUid }));

const { cpoLocationRoutes } = await import('../routes/cpo/locations.js');
const { config } = await import('../lib/config.js');

const PARTNER: OcpiPartnerInfo = {
  partnerId: 'opr_000000000001',
  partnerName: 'Partner One',
  countryCode: 'NL',
  partyId: 'EMS',
  allowPrivateNetwork: false,
  tokenId: 1,
};

const updatedAt = new Date('2026-09-01T00:00:00Z');
const S1 = 'sit_000000000001';
const S2 = 'sit_000000000002';
const AVAILABLE = { disabledReason: null, firmwareState: null, reportedStatus: null };

function site(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `Site ${id}`,
    address: '1 Main St',
    city: 'Springfield',
    state: null,
    postalCode: null,
    country: 'US',
    latitude: '40.0',
    longitude: '-75.0',
    timezone: 'America/New_York',
    contactName: null,
    contactIsPublic: false,
    hoursOfOperation: null,
    freeVendEnabled: false,
    updatedAt,
    ...overrides,
  };
}

function connectorRow(evseId: string, connectorId = 1): Record<string, unknown> {
  return {
    id: `con_${evseId}_${String(connectorId)}`,
    evseId,
    connectorId,
    connectorType: 'Type2',
    maxPowerKw: '22',
    maxCurrentAmps: null,
    status: 'available',
    updatedAt,
  };
}

const EVSE = {
  evseDbId: 'evs_aaaaaaaaaaaa',
  evseNumber: 1,
  stationDbId: 'sta_000000000001',
  stationOcppId: 'CS-0001',
  siteId: S1,
  updatedAt,
  stationState: AVAILABLE,
  stationRemoved: false,
};

const REMOVED_EVSE = {
  evseUid: 'evs_gone',
  siteId: S2,
  stationOcppId: 'CS-0009',
  evseNumber: 2,
  connectors: [
    {
      id: 'con_gone',
      connectorId: 1,
      connectorType: 'CCS2',
      maxPowerKw: '150',
      maxCurrentAmps: null,
    },
  ],
  removedAt: updatedAt,
};

interface Envelope<T> {
  status_code: number;
  status_message?: string;
  data: T;
}
interface LocationOut {
  id: string;
  country_code: string;
  party_id: string;
  evses: Array<{ uid: string; status: string; connectors: Array<{ tariff_ids?: string[] }> }>;
  opening_times?: unknown;
}

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  cpoLocationRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  dbResults = [];
  partner = { ...PARTNER };
  mockFindEvseByUid.mockReset();
  mockTariffIds.mockReset().mockResolvedValue(new Map());
  mockRemoved.mockReset().mockResolvedValue([]);
  mockVisible.mockReset().mockResolvedValue(true);
});

describe('authentication', () => {
  for (const url of [
    '/ocpi/2.2.1/cpo/locations',
    '/ocpi/2.2.1/cpo/locations/LOC-1',
    '/ocpi/2.2.1/cpo/locations/LOC-1/evs_a',
    '/ocpi/2.2.1/cpo/locations/LOC-1/evs_a/1',
  ]) {
    it(`GET ${url} answers 401 without a registered partner`, async () => {
      partner = { ...PARTNER, partnerId: null };
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ status_code: 2000 });
    });
  }
});

describe('GET /cpo/locations (list)', () => {
  it('returns an empty page with a zero total when nothing is published', async () => {
    dbResults = [[]];
    const res = await app.inject({
      method: 'GET',
      url: '/ocpi/2.2.1/cpo/locations?date_from=2026-01-01T00:00:00Z&date_to=2026-12-31T00:00:00Z',
    });
    expect(res.json()).toMatchObject({ status_code: 1000, data: [] });
    expect(res.headers['x-total-count']).toBe('0');
    expect(res.headers['link']).toBeUndefined();
  });

  it('returns an empty page past the end but keeps the total', async () => {
    dbResults = [
      [
        { siteId: S1, ocpiLocationId: null },
        { siteId: S2, ocpiLocationId: null },
      ],
    ];
    const res = await app.inject({ method: 'GET', url: '/ocpi/2.2.1/cpo/locations?offset=5' });
    expect(res.json()).toMatchObject({ data: [] });
    expect(res.headers['x-total-count']).toBe('2');
  });

  it('dedupes allow-list rows, keeps the published order, and names locations', async () => {
    mockRemoved.mockResolvedValue([REMOVED_EVSE]);
    dbResults = [
      [
        { siteId: S1, ocpiLocationId: 'LOC-1' },
        { siteId: S1, ocpiLocationId: 'LOC-1' },
        { siteId: S2, ocpiLocationId: null },
      ], // published (S1 twice from the partner join)
      [site(S2), site(S1)], // sites, unordered
      [], // stations
      [
        { siteId: S1, ocpiLocationId: 'LOC-1' },
        { siteId: S2, ocpiLocationId: null },
      ], // publish settings
      [], // maintenance
    ];
    const res = await app.inject({ method: 'GET', url: '/ocpi/2.3.0/cpo/locations' });
    const body = res.json<Envelope<LocationOut[]>>();
    expect(body.data.map((l) => l.id)).toEqual(['LOC-1', S2]);
    expect(res.headers['x-total-count']).toBe('2');
    expect(res.headers['link']).toBeUndefined();
    expect(body.data[0]).toMatchObject({
      country_code: config.OCPI_COUNTRY_CODE,
      party_id: config.OCPI_PARTY_ID,
      opening_times: { twentyfourseven: true },
      evses: [],
    });
  });

  it('pages the published sites and links to the next page', async () => {
    dbResults = [
      [
        { siteId: S1, ocpiLocationId: 'LOC-1' },
        { siteId: S2, ocpiLocationId: 'LOC-2' },
      ],
      [site(S2)],
      [],
      [{ siteId: S2, ocpiLocationId: 'LOC-2' }],
      [],
    ];
    const res = await app.inject({
      method: 'GET',
      url: '/ocpi/2.2.1/cpo/locations?offset=1&limit=1',
    });
    expect(res.json<Envelope<LocationOut[]>>().data.map((l) => l.id)).toEqual(['LOC-2']);
    expect(res.headers['x-total-count']).toBe('2');
    expect(res.headers['x-limit']).toBe('1');
    expect(res.headers['link']).toBeUndefined();
  });

  it('serves removed EVSEs, falls back to the site id, and applies site maintenance', async () => {
    mockRemoved.mockResolvedValue([REMOVED_EVSE]);
    dbResults = [
      [
        { siteId: S1, ocpiLocationId: null },
        { siteId: S2, ocpiLocationId: null },
      ],
      [site(S1), site(S2)],
      [
        { id: 'sta_000000000001', siteId: S1 },
        { id: 'sta_orphan', siteId: null },
      ],
      [
        {
          id: 'evs_a',
          stationId: 'sta_000000000001',
          stationOcppId: 'CS-0001',
          evseId: 1,
          updatedAt,
          ...AVAILABLE,
          onboardingStatus: 'accepted',
        },
      ],
      [connectorRow('evs_a'), connectorRow('evs_a', 2)],
      [{ siteId: S1, ocpiLocationId: null }], // S2 has no publish setting row
      [{ siteId: S1, affectedStationIds: [] }], // whole-site maintenance on S1
    ];
    const res = await app.inject({ method: 'GET', url: '/ocpi/2.2.1/cpo/locations' });
    const data = res.json<Envelope<LocationOut[]>>().data;
    expect(data.map((l) => l.id)).toEqual([S1, S2]);
    expect(data[0]?.evses).toHaveLength(1);
    expect(data[0]?.evses[0]).toMatchObject({ uid: 'evs_a', status: 'INOPERATIVE' });
    expect(data[0]?.evses[0]?.connectors).toHaveLength(2);
    expect(data[0]).not.toHaveProperty('opening_times');
    expect(data[1]?.evses).toEqual([
      expect.objectContaining({ uid: 'evs_gone', status: 'REMOVED' }),
    ]);
    expect(mockTariffIds).toHaveBeenCalledWith(PARTNER.partnerId, [
      { id: 'sta_000000000001', freeVend: false },
      { id: 'sta_orphan', freeVend: false },
    ]);
  });

  it('marks only the listed stations under maintenance', async () => {
    dbResults = [
      [{ siteId: S1, ocpiLocationId: null }],
      [site(S1, { freeVendEnabled: true })],
      [
        { id: 'sta_1', siteId: S1 },
        { id: 'sta_2', siteId: S1 },
      ],
      [
        {
          id: 'evs_1',
          stationId: 'sta_1',
          stationOcppId: 'CS-1',
          evseId: 1,
          updatedAt,
          ...AVAILABLE,
        },
        {
          id: 'evs_2',
          stationId: 'sta_2',
          stationOcppId: 'CS-2',
          evseId: 1,
          updatedAt,
          ...AVAILABLE,
        },
      ],
      [connectorRow('evs_1'), connectorRow('evs_2')],
      [{ siteId: S1, ocpiLocationId: null }],
      [{ siteId: S1, affectedStationIds: ['sta_2'] }],
    ];
    const res = await app.inject({ method: 'GET', url: '/ocpi/2.2.1/cpo/locations' });
    const evses = res.json<Envelope<LocationOut[]>>().data[0]?.evses;
    expect(evses?.map((e) => [e.uid, e.status])).toEqual([
      ['evs_1', 'AVAILABLE'],
      ['evs_2', 'INOPERATIVE'],
    ]);
    expect(mockTariffIds).toHaveBeenCalledWith(PARTNER.partnerId, [
      { id: 'sta_1', freeVend: true },
      { id: 'sta_2', freeVend: true },
    ]);
  });
});

describe('GET /cpo/locations/:location_id', () => {
  const URL = '/ocpi/2.2.1/cpo/locations/LOC-1';

  it('returns 404 with 2003 for an unpublished location', async () => {
    dbResults = [[]];
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ status_code: 2003, status_message: 'Location not found' });
    expect(mockVisible).not.toHaveBeenCalled();
  });

  it('returns 404 for a location not visible to the partner', async () => {
    mockVisible.mockResolvedValue(false);
    dbResults = [[{ siteId: S1 }]];
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(404);
    expect(mockVisible).toHaveBeenCalledWith(PARTNER.partnerId, S1);
  });

  it('returns 404 when the site is gone', async () => {
    dbResults = [[{ siteId: S1 }], []];
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a site without coordinates', async () => {
    dbResults = [[{ siteId: S1 }], [site(S1, { latitude: null })]];
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ status_code: 2003 });
  });

  it('renders the location with its EVSEs, tariffs, removed EVSEs and maintenance', async () => {
    mockRemoved.mockResolvedValue([{ ...REMOVED_EVSE, siteId: S1 }]);
    mockTariffIds.mockResolvedValue(new Map([['sta_000000000001', ['T-1']]]));
    dbResults = [
      [{ siteId: S1 }],
      [site(S1, { freeVendEnabled: true })],
      [{ id: 'sta_000000000001', siteId: S1 }],
      [
        {
          id: 'evs_a',
          stationId: 'sta_000000000001',
          stationOcppId: 'CS-0001',
          evseId: 1,
          updatedAt,
          ...AVAILABLE,
        },
      ],
      [connectorRow('evs_a')],
      [{ siteId: S1, affectedStationIds: null }],
    ];
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(200);
    const location = res.json<Envelope<LocationOut>>().data;
    expect(location.id).toBe('LOC-1');
    expect(location.evses.map((e) => [e.uid, e.status])).toEqual([
      ['evs_a', 'INOPERATIVE'],
      ['evs_gone', 'REMOVED'],
    ]);
    expect(location.evses[0]?.connectors[0]?.tariff_ids).toEqual(['T-1']);
    expect(mockTariffIds).toHaveBeenCalledWith(PARTNER.partnerId, [
      { id: 'sta_000000000001', freeVend: true },
    ]);
    expect(mockRemoved).toHaveBeenCalledWith([S1]);
  });

  it('renders a location without stations and without maintenance', async () => {
    dbResults = [[{ siteId: S1 }], [site(S1)], [], []];
    const res = await app.inject({ method: 'GET', url: '/ocpi/2.3.0/cpo/locations/LOC-1' });
    const location = res.json<Envelope<LocationOut>>().data;
    expect(location.evses).toEqual([]);
    expect(location.opening_times).toEqual({ twentyfourseven: true });
  });
});

describe('GET /cpo/locations/:location_id/:evse_uid', () => {
  it('returns 404 for a location not visible to the partner', async () => {
    mockVisible.mockResolvedValue(false);
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [[{ siteId: S1 }]];
    const res = await app.inject({
      method: 'GET',
      url: `/ocpi/2.2.1/cpo/locations/LOC-1/${EVSE.evseDbId}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ status_message: 'EVSE not found' });
  });

  it('returns 404 for an unknown EVSE that never left the location', async () => {
    mockFindEvseByUid.mockResolvedValue(null);
    dbResults = [[{ siteId: S1 }]];
    const res = await app.inject({ method: 'GET', url: '/ocpi/2.2.1/cpo/locations/LOC-1/evs_x' });
    expect(res.statusCode).toBe(404);
  });

  it('adds the station tariff ids to each connector', async () => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    mockTariffIds.mockResolvedValue(new Map([[EVSE.stationDbId, ['T-9']]]));
    dbResults = [[{ siteId: S1 }], [{ freeVendEnabled: true }], [connectorRow(EVSE.evseDbId)], []];
    const res = await app.inject({
      method: 'GET',
      url: `/ocpi/2.2.1/cpo/locations/LOC-1/${EVSE.evseDbId}`,
    });
    const evse =
      res.json<Envelope<{ status: string; connectors: Array<{ tariff_ids?: string[] }> }>>().data;
    expect(evse.status).toBe('AVAILABLE');
    expect(evse.connectors[0]?.tariff_ids).toEqual(['T-9']);
    expect(mockTariffIds).toHaveBeenCalledWith(PARTNER.partnerId, [
      { id: EVSE.stationDbId, freeVend: true },
    ]);
  });

  it('masks the EVSE when site-wide maintenance is active', async () => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [
      [{ siteId: S1 }],
      [],
      [connectorRow(EVSE.evseDbId)],
      [{ siteId: S1, affectedStationIds: null }],
    ];
    const res = await app.inject({
      method: 'GET',
      url: `/ocpi/2.2.1/cpo/locations/LOC-1/${EVSE.evseDbId}`,
    });
    expect(res.json<Envelope<{ status: string }>>().data.status).toBe('INOPERATIVE');
  });
});

describe('GET /cpo/locations/:location_id/:evse_uid/:connector_id', () => {
  const URL = `/ocpi/2.2.1/cpo/locations/LOC-1/${EVSE.evseDbId}/1`;

  it('returns 404 for an unpublished location without looking up the EVSE', async () => {
    dbResults = [[]];
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ status_code: 2003, status_message: 'Connector not found' });
    expect(mockFindEvseByUid).not.toHaveBeenCalled();
  });

  it('returns 404 for a location not visible to the partner', async () => {
    mockVisible.mockResolvedValue(false);
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [[{ siteId: S1 }]];
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a removed EVSE without that connector', async () => {
    mockFindEvseByUid.mockResolvedValue(null);
    mockRemoved.mockResolvedValue([{ ...REMOVED_EVSE, siteId: S1 }]);
    dbResults = [[{ siteId: S1 }]];
    const res = await app.inject({
      method: 'GET',
      url: '/ocpi/2.2.1/cpo/locations/LOC-1/evs_gone/7',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when the EVSE has no such connector', async () => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [[{ siteId: S1 }], []];
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ status_message: 'Connector not found' });
  });

  it('returns the connector with the station tariff ids', async () => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    mockTariffIds.mockResolvedValue(new Map([[EVSE.stationDbId, ['T-5']]]));
    dbResults = [[{ siteId: S1 }], [connectorRow(EVSE.evseDbId)], [{ freeVendEnabled: false }]];
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(200);
    expect(res.json<Envelope<Record<string, unknown>>>().data).toMatchObject({
      id: '1',
      tariff_ids: ['T-5'],
    });
  });
});
