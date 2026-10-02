// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Each awaited query chain resolves to the next queued result.
let dbResults: unknown[][] = [];
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of [
    'select',
    'from',
    'where',
    'limit',
    'innerJoin',
    'leftJoin',
    'orderBy',
    'values',
  ]) {
    chain[m] = vi.fn(() => chain);
  }
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(dbResults.shift() ?? []).then(resolve);
  return chain;
}
function makeInsertChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = { values: vi.fn(() => chain) };
  chain['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
  return chain;
}

const { mockFindEvseByUid, putMock } = vi.hoisted(() => ({
  mockFindEvseByUid: vi.fn(),
  putMock: vi.fn(() => Promise.resolve({})),
}));

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: { select: vi.fn(() => makeChain()), insert: vi.fn(() => makeInsertChain()) },
}));
vi.mock('../middleware/ocpi-auth.js', () => ({
  ocpiAuthenticate: async (request: { ocpiPartner?: unknown }) => {
    request.ocpiPartner = { partnerId: 'opr_000000000001' };
  },
}));
vi.mock('../lib/location-visibility.js', () => ({
  isLocationVisibleToPartner: vi.fn().mockResolvedValue(true),
}));
vi.mock('../lib/evse-lookup.js', () => ({ findEvseByUid: mockFindEvseByUid }));
vi.mock('../lib/ocpi-client.js', () => ({
  OcpiClient: class {
    put = putMock;
  },
}));
vi.mock('../lib/outbound-token.js', () => ({
  getOutboundToken: vi.fn(() => Promise.resolve('outbound-token')),
}));

const { cpoLocationRoutes } = await import('../routes/cpo/locations.js');
const { OcpiPushListener } = await import('../services/push.service.js');

const updatedAt = new Date('2026-09-01T00:00:00Z');
const SITE_ID = 'sit_000000000001';
const AVAILABLE = { disabledReason: null, firmwareState: null, reportedStatus: null };
const DISABLED = { disabledReason: 'operator', firmwareState: null, reportedStatus: null };

const SITE = {
  id: SITE_ID,
  name: 'Main Street',
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
  updatedAt,
};

function connector(evseId: string) {
  return {
    id: `con_${evseId}`,
    evseId,
    connectorId: 1,
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
  siteId: SITE_ID,
  updatedAt,
  stationState: AVAILABLE,
};

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
  mockFindEvseByUid.mockReset();
  putMock.mockClear();
});

describe('GET /cpo/locations', () => {
  it('publishes the EVSEs of a station-level unavailable station as INOPERATIVE', async () => {
    dbResults = [
      [{ siteId: SITE_ID, ocpiLocationId: 'LOC-1' }], // published site ids
      [SITE], // sites
      [
        { id: 'sta_000000000001', siteId: SITE_ID },
        { id: 'sta_000000000002', siteId: SITE_ID },
      ], // stations
      [
        {
          id: 'evs_a',
          stationId: 'sta_000000000001',
          stationOcppId: 'CS-0001',
          evseId: 1,
          updatedAt,
          ...DISABLED,
        },
        {
          id: 'evs_b',
          stationId: 'sta_000000000002',
          stationOcppId: 'CS-0002',
          evseId: 1,
          updatedAt,
          ...AVAILABLE,
        },
      ], // evses
      [connector('evs_a'), connector('evs_b')],
      [{ siteId: SITE_ID, ocpiLocationId: 'LOC-1' }], // publish settings
      [], // maintenance events
    ];

    const res = await app.inject({ method: 'GET', url: '/ocpi/2.2.1/cpo/locations' });

    const evses = res.json<{ data: Array<{ evses: Array<{ uid: string; status: string }> }> }>()
      .data[0]?.evses;
    expect(evses).toEqual([
      expect.objectContaining({ uid: 'evs_a', status: 'INOPERATIVE' }),
      expect.objectContaining({ uid: 'evs_b', status: 'AVAILABLE' }),
    ]);
  });
});

describe('GET /cpo/locations/:location_id/:evse_uid', () => {
  it('returns the EVSE when it belongs to the location', async () => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [[{ siteId: SITE_ID }], [connector(EVSE.evseDbId)], []];

    const res = await app.inject({
      method: 'GET',
      url: `/ocpi/2.2.1/cpo/locations/LOC-1/${EVSE.evseDbId}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual(
      expect.objectContaining({ uid: EVSE.evseDbId, status: 'AVAILABLE' }),
    );
  });

  it('masks a station-level unavailable station as INOPERATIVE', async () => {
    mockFindEvseByUid.mockResolvedValue({ ...EVSE, stationState: DISABLED });
    dbResults = [[{ siteId: SITE_ID }], [connector(EVSE.evseDbId)], []];

    const res = await app.inject({
      method: 'GET',
      url: `/ocpi/2.2.1/cpo/locations/LOC-1/${EVSE.evseDbId}`,
    });

    expect(res.json().data.status).toBe('INOPERATIVE');
  });

  it('masks a station under maintenance as INOPERATIVE', async () => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [
      [{ siteId: SITE_ID }],
      [connector(EVSE.evseDbId)],
      [{ siteId: SITE_ID, affectedStationIds: [EVSE.stationDbId] }],
    ];

    const res = await app.inject({
      method: 'GET',
      url: `/ocpi/2.2.1/cpo/locations/LOC-1/${EVSE.evseDbId}`,
    });

    expect(res.json().data.status).toBe('INOPERATIVE');
  });

  it('returns not found for an EVSE at another location', async () => {
    mockFindEvseByUid.mockResolvedValue({ ...EVSE, siteId: 'sit_000000000009' });
    dbResults = [[{ siteId: SITE_ID }]];

    const res = await app.inject({
      method: 'GET',
      url: `/ocpi/2.2.1/cpo/locations/LOC-1/${EVSE.evseDbId}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().status_code).toBe(2003);
  });

  it('returns not found for an unknown location', async () => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [[]];

    const res = await app.inject({
      method: 'GET',
      url: `/ocpi/2.2.1/cpo/locations/LOC-X/${EVSE.evseDbId}`,
    });

    expect(res.statusCode).toBe(404);
    expect(mockFindEvseByUid).not.toHaveBeenCalled();
  });
});

describe('GET /cpo/locations/:location_id/:evse_uid/:connector_id', () => {
  it('returns the connector when the EVSE belongs to the location', async () => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [[{ siteId: SITE_ID }], [connector(EVSE.evseDbId)]];

    const res = await app.inject({
      method: 'GET',
      url: `/ocpi/2.2.1/cpo/locations/LOC-1/${EVSE.evseDbId}/1`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe('1');
  });

  it('returns not found for an EVSE at another location', async () => {
    mockFindEvseByUid.mockResolvedValue({ ...EVSE, siteId: 'sit_000000000009' });
    dbResults = [[{ siteId: SITE_ID }]];

    const res = await app.inject({
      method: 'GET',
      url: `/ocpi/2.2.1/cpo/locations/LOC-1/${EVSE.evseDbId}/1`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().status_code).toBe(2003);
  });
});

describe('location push', () => {
  it('pushes the EVSEs of a station-level unavailable station as INOPERATIVE', async () => {
    dbResults = [
      [{ id: 'olp_1', siteId: SITE_ID, ocpiLocationId: 'LOC-1', publishToAll: false }],
      [SITE],
      [
        { id: 'sta_000000000001', stationId: 'CS-0001', siteId: SITE_ID, ...DISABLED },
        { id: 'sta_000000000002', stationId: 'CS-0002', siteId: SITE_ID, ...AVAILABLE },
      ],
      [
        { id: 'evs_a', stationId: 'sta_000000000001', evseId: 1, updatedAt },
        { id: 'evs_b', stationId: 'sta_000000000002', evseId: 1, updatedAt },
      ],
      [connector('evs_a'), connector('evs_b')],
      [], // maintenance events
      [{ partnerId: 'opr_000000000001' }], // allow-listed partners
      [{ url: 'http://127.0.0.1/locations' }], // partner endpoint
      [{ countryCode: 'DE', partyId: 'ABC', version: '2.2.1' }], // partner
    ];
    let handler: ((payload: string) => void) | undefined;
    const pubsub = {
      subscribe: vi.fn((_channel: string, cb: (payload: string) => void) => {
        handler = cb;
        return Promise.resolve({ unsubscribe: vi.fn() });
      }),
    };
    const listener = new OcpiPushListener(pubsub as never);
    await listener.start();

    handler?.(JSON.stringify({ type: 'location', siteId: SITE_ID }));
    await vi.waitFor(() => {
      expect(putMock).toHaveBeenCalled();
    });

    expect(putMock).toHaveBeenCalledWith(
      expect.stringContaining('/LOC-1'),
      expect.objectContaining({
        evses: [
          expect.objectContaining({ uid: 'evs_a', status: 'INOPERATIVE' }),
          expect.objectContaining({ uid: 'evs_b', status: 'AVAILABLE' }),
        ],
      }),
    );
  });
});
