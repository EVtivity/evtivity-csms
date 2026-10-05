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

const { mockFindEvseByUid, putMock, patchMock, mockTariffIds, mockAudience, mockRemoved } =
  vi.hoisted(() => ({
    mockFindEvseByUid: vi.fn(),
    putMock: vi.fn(() => Promise.resolve({})),
    patchMock: vi.fn(() => Promise.resolve({ status_code: 1000 })),
    mockTariffIds: vi.fn(),
    mockAudience: vi.fn(),
    mockRemoved: vi.fn(),
  }));

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: { select: vi.fn(() => makeChain()), insert: vi.fn(() => makeInsertChain()) },
  ocpiLocationAudience: mockAudience,
  removedOcpiEvses: mockRemoved,
}));
vi.mock('../services/connector-tariffs.js', () => ({ connectorTariffIds: mockTariffIds }));
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
    patch = patchMock;
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
  stationRemoved: false,
};
const NO_FREE_VEND = [{ freeVendEnabled: false }];
// An EVSE deleted from the site (ocpi_removed_evses).
const REMOVED_EVSE = {
  evseUid: 'evs_gone',
  siteId: SITE_ID,
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
  patchMock.mockClear();
  mockTariffIds.mockReset();
  mockTariffIds.mockResolvedValue(new Map());
  mockAudience.mockReset();
  mockRemoved.mockReset();
  mockRemoved.mockResolvedValue([]);
});

describe('GET /cpo/locations', () => {
  it('masks unavailable stations, removes deleted ones, and links connector tariffs', async () => {
    dbResults = [
      [{ siteId: SITE_ID, ocpiLocationId: 'LOC-1' }], // published site ids
      [{ ...SITE, freeVendEnabled: false }], // sites
      [
        { id: 'sta_000000000001', siteId: SITE_ID },
        { id: 'sta_000000000002', siteId: SITE_ID },
        { id: 'sta_000000000003', siteId: SITE_ID },
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
        {
          id: 'evs_c',
          stationId: 'sta_000000000003',
          stationOcppId: 'CS-0003',
          evseId: 1,
          updatedAt,
          ...AVAILABLE,
          onboardingStatus: 'blocked',
        },
      ], // evses
      [connector('evs_a'), connector('evs_b'), connector('evs_c')],
      [{ siteId: SITE_ID, ocpiLocationId: 'LOC-1' }], // publish settings
      [], // maintenance events
    ];
    mockTariffIds.mockResolvedValue(new Map([['sta_000000000002', ['T-GROUP']]]));

    const res = await app.inject({ method: 'GET', url: '/ocpi/2.2.1/cpo/locations' });

    const evses = res.json<{
      data: Array<{
        evses: Array<{ uid: string; status: string; connectors: Array<{ tariff_ids?: string[] }> }>;
      }>;
    }>().data[0]?.evses;
    expect(evses).toEqual([
      expect.objectContaining({ uid: 'evs_a', status: 'INOPERATIVE' }),
      expect.objectContaining({ uid: 'evs_b', status: 'AVAILABLE' }),
      expect.objectContaining({ uid: 'evs_c', status: 'REMOVED' }),
    ]);
    expect(evses?.[0]?.connectors[0]).not.toHaveProperty('tariff_ids');
    expect(evses?.[1]?.connectors[0]?.tariff_ids).toEqual(['T-GROUP']);
  });
});

describe('GET /cpo/locations/:location_id/:evse_uid', () => {
  it('returns the EVSE when it belongs to the location', async () => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [[{ siteId: SITE_ID }], NO_FREE_VEND, [connector(EVSE.evseDbId)], []];

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
    dbResults = [[{ siteId: SITE_ID }], NO_FREE_VEND, [connector(EVSE.evseDbId)], []];

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
      NO_FREE_VEND,
      [connector(EVSE.evseDbId)],
      [{ siteId: SITE_ID, affectedStationIds: [EVSE.stationDbId] }],
    ];

    const res = await app.inject({
      method: 'GET',
      url: `/ocpi/2.2.1/cpo/locations/LOC-1/${EVSE.evseDbId}`,
    });

    expect(res.json().data.status).toBe('INOPERATIVE');
  });

  it('reports an EVSE of a deleted station as REMOVED', async () => {
    mockFindEvseByUid.mockResolvedValue({ ...EVSE, stationRemoved: true });
    dbResults = [[{ siteId: SITE_ID }], NO_FREE_VEND, [connector(EVSE.evseDbId)], []];

    const res = await app.inject({
      method: 'GET',
      url: `/ocpi/2.2.1/cpo/locations/LOC-1/${EVSE.evseDbId}`,
    });

    expect(res.json().data.status).toBe('REMOVED');
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

  it('serves an EVSE that left the location as REMOVED', async () => {
    mockFindEvseByUid.mockResolvedValue(null);
    mockRemoved.mockResolvedValue([REMOVED_EVSE]);
    dbResults = [[{ siteId: SITE_ID }]];

    const res = await app.inject({
      method: 'GET',
      url: '/ocpi/2.2.1/cpo/locations/LOC-1/evs_gone',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ uid: 'evs_gone', status: 'REMOVED' });
    expect(mockRemoved).toHaveBeenCalledWith([SITE_ID]);
  });

  it('serves the connector of an EVSE that left the location', async () => {
    mockFindEvseByUid.mockResolvedValue({ ...EVSE, evseDbId: 'evs_gone', siteId: 'sit_other' });
    mockRemoved.mockResolvedValue([REMOVED_EVSE]);
    dbResults = [[{ siteId: SITE_ID }]];

    const res = await app.inject({
      method: 'GET',
      url: '/ocpi/2.2.1/cpo/locations/LOC-1/evs_gone/1',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ id: '1', standard: 'IEC_62196_T2_COMBO' });
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
    mockTariffIds.mockResolvedValue(new Map([[EVSE.stationDbId, ['T-1']]]));
    dbResults = [[{ siteId: SITE_ID }], [connector(EVSE.evseDbId)], NO_FREE_VEND];

    const res = await app.inject({
      method: 'GET',
      url: `/ocpi/2.2.1/cpo/locations/LOC-1/${EVSE.evseDbId}/1`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe('1');
    expect(res.json().data.tariff_ids).toEqual(['T-1']);
    expect(mockTariffIds).toHaveBeenCalledWith('opr_000000000001', [
      { id: EVSE.stationDbId, freeVend: false },
    ]);
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
    mockAudience.mockResolvedValue({ ocpiLocationId: 'LOC-1', partnerIds: ['opr_000000000001'] });
    dbResults = [
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

  async function startListener(): Promise<(payload: string) => void> {
    let handler: ((payload: string) => void) | undefined;
    const pubsub = {
      subscribe: vi.fn((_channel: string, cb: (payload: string) => void) => {
        handler = cb;
        return Promise.resolve({ unsubscribe: vi.fn() });
      }),
    };
    await new OcpiPushListener(pubsub as never).start();
    return (payload) => handler?.(payload);
  }

  it('sends the location with every EVSE REMOVED to partners that lost it', async () => {
    mockAudience.mockResolvedValue(null); // unpublished
    dbResults = [
      [SITE],
      [{ id: 'sta_000000000001', stationId: 'CS-0001', siteId: SITE_ID, ...AVAILABLE }],
      [{ id: 'evs_a', stationId: 'sta_000000000001', evseId: 1, updatedAt }],
      [connector('evs_a')],
      [], // maintenance events
      [{ url: 'http://127.0.0.1/locations' }], // partner endpoint
      [{ countryCode: 'DE', partyId: 'ABC', version: '2.3.0' }], // partner
    ];
    const send = await startListener();

    send(
      JSON.stringify({
        type: 'location',
        siteId: SITE_ID,
        removed: { ocpiLocationId: 'LOC-OLD', partnerIds: ['opr_000000000001'] },
      }),
    );
    await vi.waitFor(() => {
      expect(putMock).toHaveBeenCalled();
    });

    expect(putMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/LOC-OLD$/),
      expect.objectContaining({
        id: 'LOC-OLD',
        evses: [expect.objectContaining({ uid: 'evs_a', status: 'REMOVED' })],
      }),
    );
    expect(mockTariffIds).not.toHaveBeenCalled();
  });

  it('pushes the EVSEs that left the site as REMOVED, with their connectors', async () => {
    mockAudience.mockResolvedValue({ ocpiLocationId: 'LOC-1', partnerIds: ['opr_000000000001'] });
    mockRemoved.mockResolvedValue([REMOVED_EVSE]);
    dbResults = [
      [SITE],
      [], // no stations left at the site
      [], // maintenance events
      [{ url: 'http://127.0.0.1/locations' }], // partner endpoint
      [{ countryCode: 'DE', partyId: 'ABC', version: '2.2.1' }], // partner
    ];
    const send = await startListener();

    send(JSON.stringify({ type: 'location', siteId: SITE_ID }));
    await vi.waitFor(() => {
      expect(putMock).toHaveBeenCalled();
    });

    expect(putMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/LOC-1$/),
      expect.objectContaining({
        evses: [
          expect.objectContaining({
            uid: 'evs_gone',
            evse_id: 'CS-0009-EVSE-2',
            status: 'REMOVED',
            connectors: [expect.objectContaining({ id: '1' })],
          }),
        ],
      }),
    );
  });
});
