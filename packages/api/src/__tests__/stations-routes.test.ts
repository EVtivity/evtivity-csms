// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const VALID_STATION_ID = 'sta_000000000001';
const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

const { mockPublish, mockSubscribe } = vi.hoisted(() => {
  const pub = vi.fn().mockResolvedValue(undefined);
  const sub = vi.fn().mockImplementation(async (_channel: string, _cb: (raw: string) => void) => {
    return { unsubscribe: vi.fn() };
  });
  return { mockPublish: pub, mockSubscribe: sub };
});

vi.mock('../lib/pubsub.js', () => ({
  getPubSub: vi.fn(() => ({ publish: mockPublish, subscribe: mockSubscribe })),
  setPubSub: vi.fn(),
}));

// -- DB mock helpers --

let dbResults: unknown[][] = [];
let dbCallIndex = 0;

function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}

function makeChain() {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'values',
    'returning',
    'set',
    'onConflictDoUpdate',
    'delete',
    'insert',
    'update',
    'having',
    'selectDistinct',
    'selectDistinctOn',
    'as',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const r = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(r).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  chain['catch'] = (reject?: (r: unknown) => unknown) => Promise.resolve([]).catch(reject);
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    selectDistinct: vi.fn(() => makeChain()),
    selectDistinctOn: vi.fn(() => makeChain()),
    execute: vi.fn(() =>
      Promise.resolve([
        {
          uptime_percent: '99.5',
          port_count: '2',
          disconnect_count: '1',
          avg_downtime_minutes: '5',
          max_downtime_minutes: '10',
        },
      ]),
    ),
    $client: {},
  },
  chargingStations: {},
  evses: {},
  connectors: {},
  chargingSessions: {},
  drivers: {},
  meterValues: {},
  sites: {},
  vendors: { id: 'id', name: 'name' },
  ocppMessageLogs: {},
  connectionLogs: {},
  stationCertificates: {},
  pricingGroupStations: {},
  pricingGroups: {},
}));

vi.mock('drizzle-orm', () => {
  const sqlFn = () => ({ as: vi.fn() });
  return {
    eq: vi.fn(),
    and: vi.fn(),
    or: vi.fn(),
    ilike: vi.fn(),
    sql: Object.assign(vi.fn(sqlFn), { raw: vi.fn(sqlFn), join: vi.fn(() => '') }),
    gte: vi.fn(),
    desc: vi.fn(),
    count: vi.fn(),
    inArray: vi.fn(),
  };
});

vi.mock('argon2', () => ({
  hash: vi.fn().mockResolvedValue('hashed_password'),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
  checkStationSiteAccess: vi.fn().mockResolvedValue(true),
}));

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (n: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
}));

import { registerAuth } from '../plugins/auth.js';
import { stationRoutes } from '../routes/stations.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(stationRoutes);
  await app.ready();
  return app;
}

describe('Station routes - handler logic', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbResults = [];
    dbCallIndex = 0;
    vi.clearAllMocks();
  });

  // --- GET /v1/stations ---

  describe('GET /v1/stations', () => {
    it('returns paginated station list with data and total', async () => {
      const stationRow = {
        id: VALID_STATION_ID,
        stationId: 'STATION-001',
        siteId: null,
        vendorId: null,
        model: 'Model X',
        serialNumber: null,
        firmwareVersion: null,
        iccid: null,
        imsi: null,
        availability: 'available',
        onboardingStatus: 'accepted',
        lastHeartbeat: null,
        isOnline: true,
        isSimulator: false,
        loadPriority: 0,
        securityProfile: 0,
        ocppProtocol: null,
        hasPassword: false,
        metadata: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'available',
        connectorCount: 2,
        connectorTypes: ['CCS2'],
        siteFreeVendEnabled: false,
      };
      // First call: data query, second call: count subquery
      setupDbResults([stationRow], [{ count: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: '/stations',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(body.data).toHaveLength(1);
      expect(body.data[0].stationId).toBe('STATION-001');
    });

    it('returns empty data when no stations exist', async () => {
      setupDbResults([], [{ count: 0 }]);

      const response = await app.inject({
        method: 'GET',
        url: '/stations',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/stations',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // --- GET /v1/stations/:id ---

  describe('GET /v1/stations/:id', () => {
    it('returns a station when found', async () => {
      const station = {
        id: VALID_STATION_ID,
        stationId: 'STATION-001',
        siteId: null,
        vendorId: null,
        vendorName: null,
        model: 'Model X',
        serialNumber: null,
        firmwareVersion: null,
        iccid: null,
        imsi: null,
        availability: 'available',
        onboardingStatus: 'accepted',
        lastHeartbeat: null,
        isOnline: false,
        isSimulator: false,
        loadPriority: 0,
        securityProfile: 0,
        ocppProtocol: null,
        hasPassword: false,
        metadata: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        status: 'available',
        siteHoursOfOperation: null,
        siteFreeVendEnabled: false,
      };
      setupDbResults([station]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().stationId).toBe('STATION-001');
    });

    it('returns 404 when station not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });
  });

  // --- POST /v1/stations ---

  describe('POST /v1/stations', () => {
    it('creates a station and returns 201', async () => {
      const created = {
        id: VALID_STATION_ID,
        stationId: 'NEW-STATION',
        siteId: null,
        vendorId: null,
        model: null,
        serialNumber: null,
        firmwareVersion: null,
        availability: 'available',
        onboardingStatus: 'pending',
        isOnline: false,
        isSimulator: false,
        loadPriority: 0,
        securityProfile: 0,
        hasPassword: false,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults([created]);

      const response = await app.inject({
        method: 'POST',
        url: '/stations',
        headers: { authorization: 'Bearer ' + token },
        payload: { stationId: 'NEW-STATION' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().stationId).toBe('NEW-STATION');
      expect(response.json().hasPassword).toBe(false);
    });

    it('creates a station with password and sets hasPassword true', async () => {
      const created = {
        id: VALID_STATION_ID,
        stationId: 'SECURE-STATION',
        siteId: null,
        vendorId: null,
        model: null,
        serialNumber: null,
        firmwareVersion: null,
        availability: 'available',
        onboardingStatus: 'pending',
        isOnline: false,
        isSimulator: false,
        loadPriority: 0,
        securityProfile: 1,
        hasPassword: false,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults([created]);

      const response = await app.inject({
        method: 'POST',
        url: '/stations',
        headers: { authorization: 'Bearer ' + token },
        payload: { stationId: 'SECURE-STATION', password: 'mypassword123' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().hasPassword).toBe(true);
    });

    it('returns 400 for missing stationId', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/stations',
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // --- PATCH /v1/stations/:id ---

  describe('PATCH /v1/stations/:id', () => {
    it('updates and returns the station', async () => {
      const updated = {
        id: VALID_STATION_ID,
        stationId: 'STATION-001',
        siteId: null,
        vendorId: null,
        model: 'Updated Model',
        serialNumber: null,
        firmwareVersion: null,
        availability: 'available',
        onboardingStatus: 'accepted',
        isOnline: false,
        isSimulator: false,
        loadPriority: 0,
        securityProfile: 0,
        hasPassword: false,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults([updated]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { model: 'Updated Model' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().model).toBe('Updated Model');
    });

    it('returns 404 when station not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { model: 'X' },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 400 when upgrading security profile without password and station has none', async () => {
      // First DB call: check existing hasPassword
      setupDbResults([{ hasPassword: false }]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { securityProfile: 1 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('PASSWORD_REQUIRED');
    });
  });

  // --- DELETE /v1/stations/:id ---

  describe('DELETE /v1/stations/:id', () => {
    it('blocks station by setting onboardingStatus to blocked', async () => {
      const station = {
        id: VALID_STATION_ID,
        stationId: 'STATION-001',
        siteId: null,
        vendorId: null,
        model: null,
        serialNumber: null,
        firmwareVersion: null,
        availability: 'unavailable',
        onboardingStatus: 'blocked',
        isOnline: false,
        isSimulator: false,
        loadPriority: 0,
        securityProfile: 0,
        hasPassword: false,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults([station]);

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().onboardingStatus).toBe('blocked');
    });

    it('returns 404 when station not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });
  });

  // --- GET /v1/stations/:id/connectors ---

  describe('GET /v1/stations/:id/connectors', () => {
    it('returns grouped EVSE/connector data', async () => {
      const rows = [
        {
          evseId: 1,
          evseAutoCreated: false,
          connectorId: 1,
          connectorType: 'CCS2',
          maxPowerKw: '150',
          maxCurrentAmps: null,
          connectorStatus: 'available',
          connectorAutoCreated: false,
          isIdling: false,
        },
        {
          evseId: 1,
          evseAutoCreated: false,
          connectorId: 2,
          connectorType: 'CHAdeMO',
          maxPowerKw: '50',
          maxCurrentAmps: null,
          connectorStatus: 'available',
          connectorAutoCreated: false,
          isIdling: false,
        },
      ];
      setupDbResults(rows);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/connectors`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].evseId).toBe(1);
      expect(body[0].connectors).toHaveLength(2);
    });

    it('returns empty array when no EVSEs exist', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/connectors`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });
  });

  // --- POST /v1/stations/:id/evses ---

  describe('POST /v1/stations/:id/evses', () => {
    it('creates EVSE with connectors and returns 201', async () => {
      // 1: station exists, 2: no duplicate evse, 3: insert evse, 4: insert connectors
      const evse = { id: 'evs_000000000001', evseId: 1, status: 'unavailable' };
      const connectorRow = {
        connectorId: 1,
        connectorType: 'CCS2',
        maxPowerKw: '150',
        maxCurrentAmps: null,
        status: 'unavailable',
      };
      setupDbResults(
        [{ id: VALID_STATION_ID }], // station exists
        [], // no duplicate
        [evse], // inserted evse
        [connectorRow], // inserted connectors
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          evseId: 1,
          connectors: [{ connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150 }],
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().evseId).toBe(1);
    });

    it('returns 404 when station does not exist', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          evseId: 1,
          connectors: [{ connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150 }],
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 409 for duplicate evseId', async () => {
      setupDbResults(
        [{ id: VALID_STATION_ID }], // station exists
        [{ id: 'existing-evse' }], // duplicate found
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          evseId: 1,
          connectors: [{ connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150 }],
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('DUPLICATE_EVSE_ID');
    });
  });

  // --- DELETE /v1/stations/:id/evses/:evseId ---

  describe('DELETE /v1/stations/:id/evses/:evseId', () => {
    it('deletes EVSE when not occupied', async () => {
      setupDbResults(
        [{ id: 'evs_000000000001' }], // evse found
        [], // no occupied connectors
        [], // delete result (not used)
      );

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/evses/1`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('deleted');
    });

    it('returns 404 when EVSE not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/evses/1`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('EVSE_NOT_FOUND');
    });

    it('returns 409 when connector is occupied', async () => {
      setupDbResults(
        [{ id: 'evs_000000000001' }], // evse found
        [{ id: 'con_000000000001' }], // occupied connector found
      );

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/evses/1`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('CONNECTOR_OCCUPIED');
    });
  });

  // --- GET /v1/stations/:id/meter-values ---

  describe('GET /v1/stations/:id/meter-values', () => {
    it('returns grouped meter values', async () => {
      const rows = [
        { measurand: 'Power.Active.Import', unit: 'kW', timestamp: new Date(), value: '11.5' },
        { measurand: 'Power.Active.Import', unit: 'kW', timestamp: new Date(), value: '12.0' },
      ];
      setupDbResults(rows);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/meter-values`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].measurand).toBe('Power.Active.Import');
      expect(body[0].values).toHaveLength(2);
    });
  });

  // --- GET /v1/stations/:id/sessions ---

  describe('GET /v1/stations/:id/sessions', () => {
    it('returns paginated sessions', async () => {
      const sessionRow = {
        id: 'sess-1',
        stationId: VALID_STATION_ID,
        stationName: 'STATION-001',
        siteName: 'Main Site',
        driverId: null,
        driverName: null,
        transactionId: null,
        status: 'completed',
        startedAt: '2024-01-01T00:00:00.000Z',
        endedAt: null,
        energyDeliveredWh: '5000',
        currentCostCents: null,
        finalCostCents: null,
        currency: null,
      };
      // Promise.all: data query and count query
      setupDbResults([sessionRow], [{ count: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/sessions`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(body.data).toHaveLength(1);
    });
  });

  // --- GET /v1/stations/:id/energy-history ---

  describe('GET /v1/stations/:id/energy-history', () => {
    it('returns daily energy data', async () => {
      // First call: site timezone lookup, second: energy rows
      setupDbResults(
        [{ siteTimezone: 'America/New_York' }],
        [{ date: '2025-01-01', energyWh: 5000 }],
      );

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/energy-history`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0]).toHaveProperty('date');
      expect(body[0]).toHaveProperty('energyWh');
    });
  });

  // --- GET /v1/stations/:id/revenue-history ---

  describe('GET /v1/stations/:id/revenue-history', () => {
    it('returns daily revenue data', async () => {
      setupDbResults(
        [{ siteTimezone: 'America/Chicago' }],
        [{ date: '2025-01-01', revenueCents: 1500, sessionCount: 3 }],
      );

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/revenue-history`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0]).toHaveProperty('revenueCents');
      expect(body[0]).toHaveProperty('sessionCount');
    });
  });

  // --- GET /v1/stations/:id/ocpp-logs ---

  describe('GET /v1/stations/:id/ocpp-logs', () => {
    it('returns paginated OCPP logs with actions list', async () => {
      const logRow = {
        id: 'log-1',
        stationId: VALID_STATION_ID,
        action: 'Heartbeat',
        direction: 'inbound',
        messageId: null,
        payload: null,
        createdAt: '2024-01-01T00:00:00.000Z',
      };
      // Promise.all: data rows, count rows, then distinct actions
      setupDbResults(
        [logRow],
        [{ count: 1 }],
        [{ action: 'Heartbeat' }, { action: 'BootNotification' }],
      );

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/ocpp-logs`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(body).toHaveProperty('actions');
    });
  });

  // --- POST /v1/stations/:id/credentials ---

  describe('POST /v1/stations/:id/credentials', () => {
    it('sets password and returns success', async () => {
      const station = { id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: false };
      setupDbResults(
        [station], // update returning
        [], // insert connection log
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/credentials`,
        headers: { authorization: 'Bearer ' + token },
        payload: { password: 'newpassword123' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });

    it('returns 404 when station not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/credentials`,
        headers: { authorization: 'Bearer ' + token },
        payload: { password: 'newpassword123' },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });
  });

  // --- GET /v1/stations/:id/security-logs ---

  describe('GET /v1/stations/:id/security-logs', () => {
    it('returns paginated security logs', async () => {
      const logRow = {
        id: 'log-1',
        event: 'connected',
        remoteAddress: '1.2.3.4',
        metadata: {},
        createdAt: new Date().toISOString(),
      };
      setupDbResults([logRow], [{ count: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/security-logs`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
    });
  });

  // --- GET /v1/stations/:id/metrics ---

  describe('GET /v1/stations/:id/metrics', () => {
    it('returns station metrics', async () => {
      // The metrics endpoint calls: db.execute (uptime), db.select (sessionStats),
      // db.select (utilizationStats), db.select (financialStats), db.execute (disconnects)
      const sessionStats = {
        totalSessions: 10,
        completedSessions: 8,
        faultedSessions: 1,
        totalEnergyWh: 50000,
        avgDurationMinutes: 30,
      };
      const utilizationStats = { sessionHours: 5, portCount: 2 };
      const financialStats = {
        totalRevenueCents: 10000,
        avgRevenueCentsPerSession: 1000,
        totalTransactions: 8,
      };

      setupDbResults([sessionStats], [utilizationStats], [financialStats]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/metrics`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('uptimePercent');
      expect(body).toHaveProperty('totalSessions');
      expect(body).toHaveProperty('utilizationPercent');
      expect(body).toHaveProperty('totalRevenueCents');
      expect(body).toHaveProperty('periodMonths');
    });
  });

  // --- DELETE /v1/stations/:id/evses/:evseId/connectors/:connectorId ---

  describe('DELETE /v1/stations/:id/evses/:evseId/connectors/:connectorId', () => {
    it('deletes connector when not occupied', async () => {
      setupDbResults(
        [{ id: 'evs_000000000001' }], // evse found
        [{ id: 'con_000000000001', status: 'available' }], // connector found, not occupied
        [], // delete
      );

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/evses/1/connectors/1`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('deleted');
    });

    it('returns 409 when connector is occupied', async () => {
      setupDbResults(
        [{ id: 'evs_000000000001' }],
        [{ id: 'con_000000000001', status: 'occupied' }],
      );

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/evses/1/connectors/1`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('CONNECTOR_OCCUPIED');
    });

    it('returns 404 when connector not found', async () => {
      setupDbResults(
        [{ id: 'evs_000000000001' }], // evse found
        [], // connector not found
      );

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/evses/1/connectors/1`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('CONNECTOR_NOT_FOUND');
    });
  });

  // --- POST /v1/stations/:id/evses/:evseId/connectors ---

  describe('POST /v1/stations/:id/evses/:evseId/connectors', () => {
    it('adds a connector to an EVSE and returns 201', async () => {
      const connector = {
        connectorId: 2,
        connectorType: 'Type2',
        maxPowerKw: '22',
        maxCurrentAmps: null,
        status: 'unavailable',
      };
      setupDbResults(
        [{ id: 'evs_000000000001' }], // evse found
        [], // no duplicate connector
        [connector], // inserted connector
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses/1/connectors`,
        headers: { authorization: 'Bearer ' + token },
        payload: { connectorId: 2, connectorType: 'Type2', maxPowerKw: 22 },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().connectorId).toBe(2);
      expect(response.json().connectorType).toBe('Type2');
    });

    it('returns 409 for duplicate connectorId', async () => {
      setupDbResults([{ id: 'evs_000000000001' }], [{ id: 'existing' }]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses/1/connectors`,
        headers: { authorization: 'Bearer ' + token },
        payload: { connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150 },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('DUPLICATE_CONNECTOR_ID');
    });
  });

  // --- PATCH /v1/stations/:id/evses/:evseId ---

  describe('PATCH /v1/stations/:id/evses/:evseId', () => {
    it('updates connector properties on an EVSE', async () => {
      const evse = { id: 'evs_000000000001', evseId: 1, status: 'available' };
      const updatedConnectors = [
        {
          connectorId: 1,
          connectorType: 'CCS2',
          maxPowerKw: '200',
          maxCurrentAmps: null,
          status: 'available',
        },
      ];
      // 1: find evse, 2: update connector (loop), 3: select updated connectors
      setupDbResults(
        [evse],
        [], // update result
        updatedConnectors, // select result
      );

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}/evses/1`,
        headers: { authorization: 'Bearer ' + token },
        payload: { connectors: [{ connectorId: 1, maxPowerKw: 200 }] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().evseId).toBe(1);
      expect(response.json().connectors).toHaveLength(1);
    });

    it('returns 404 when EVSE not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}/evses/1`,
        headers: { authorization: 'Bearer ' + token },
        payload: { connectors: [{ connectorId: 1, maxPowerKw: 200 }] },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('EVSE_NOT_FOUND');
    });
  });

  // --- POST /v1/stations/:id/credentials (online station branch) ---

  describe('POST /v1/stations/:id/credentials (online station)', () => {
    it('publishes OCPP commands when station is online', async () => {
      const station = { id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: true };
      setupDbResults(
        [station], // update returning
        [], // insert connection log
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/credentials`,
        headers: { authorization: 'Bearer ' + token },
        payload: { password: 'newpassword123' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
      // SetVariables + Reset = 2 publishes
      expect(mockPublish).toHaveBeenCalledTimes(2);
    });
  });

  // --- PATCH /v1/stations/:id (online with security profile change) ---

  describe('PATCH /v1/stations/:id (online + security profile)', () => {
    it('publishes SetVariables and Reset when station is online and securityProfile changes', async () => {
      const updated = {
        id: VALID_STATION_ID,
        stationId: 'STATION-001',
        siteId: null,
        vendorId: null,
        model: null,
        serialNumber: null,
        firmwareVersion: null,
        availability: 'available',
        onboardingStatus: 'accepted',
        isOnline: true,
        isSimulator: false,
        loadPriority: 0,
        securityProfile: 2,
        hasPassword: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      // First call: check existing hasPassword (SP2 requires password), second: update returning
      setupDbResults([{ hasPassword: true }], [updated]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { securityProfile: 2 },
      });

      expect(response.statusCode).toBe(200);
      // SetVariables + Reset
      expect(mockPublish).toHaveBeenCalledTimes(2);
    });

    it('allows SP1/SP2 upgrade when password is provided in body', async () => {
      const updated = {
        id: VALID_STATION_ID,
        stationId: 'STATION-001',
        siteId: null,
        vendorId: null,
        model: null,
        serialNumber: null,
        firmwareVersion: null,
        availability: 'available',
        onboardingStatus: 'accepted',
        isOnline: false,
        isSimulator: false,
        loadPriority: 0,
        securityProfile: 1,
        hasPassword: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      // No hasPassword check needed because password is in body; skip to update returning
      setupDbResults([updated]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { securityProfile: 1, password: 'newpassword123' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().securityProfile).toBe(1);
    });

    it('clears password hash when switching to SP0', async () => {
      const updated = {
        id: VALID_STATION_ID,
        stationId: 'STATION-001',
        siteId: null,
        vendorId: null,
        model: null,
        serialNumber: null,
        firmwareVersion: null,
        availability: 'available',
        onboardingStatus: 'accepted',
        isOnline: false,
        isSimulator: false,
        loadPriority: 0,
        securityProfile: 0,
        hasPassword: false,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults([updated]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { securityProfile: 0 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().securityProfile).toBe(0);
    });
  });

  // --- POST /v1/stations/:id/rotate-credentials ---

  describe('POST /v1/stations/:id/rotate-credentials', () => {
    it('returns 404 when station not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/rotate-credentials`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 409 when station is offline', async () => {
      setupDbResults([{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: false }]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/rotate-credentials`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('STATION_OFFLINE');
    });

    it('returns 502 when command times out', async () => {
      vi.useFakeTimers();
      setupDbResults([{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: true }]);

      // Subscribe callback never fires a matching commandId, so it will timeout.
      mockSubscribe.mockImplementationOnce(async (_channel: string, _cb: (raw: string) => void) => {
        return { unsubscribe: vi.fn() };
      });

      const responsePromise = app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/rotate-credentials`,
        headers: { authorization: 'Bearer ' + token },
      });

      // Advance past the 35s timeout
      await vi.advanceTimersByTimeAsync(36_000);

      const response = await responsePromise;
      expect(response.statusCode).toBe(502);
      vi.useRealTimers();
    });

    it('returns success when OCPP command succeeds', async () => {
      setupDbResults(
        [{ id: VALID_STATION_ID, stationId: 'STATION-001', isOnline: true }],
        [], // update password hash
        [], // insert connection log
      );

      // Capture commandId from the first publish call, then when subscribe
      // is called, immediately fire the callback with matching commandId.
      let capturedCommandId: string | null = null;

      mockPublish.mockImplementationOnce(async (_channel: string, payload: string) => {
        const parsed = JSON.parse(payload);
        capturedCommandId = parsed.commandId;
      });

      mockSubscribe.mockImplementationOnce(async (_channel: string, cb: (raw: string) => void) => {
        // Fire callback immediately with the captured commandId
        if (capturedCommandId != null) {
          cb(JSON.stringify({ commandId: capturedCommandId, success: true }));
        }
        return { unsubscribe: vi.fn() };
      });

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/rotate-credentials`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });
  });

  // --- POST /v1/stations/:id/evses (500 on EVSE insert failure) ---

  describe('POST /v1/stations/:id/evses (EVSE insert failure)', () => {
    it('returns 500 when EVSE insert returns empty', async () => {
      setupDbResults(
        [{ id: VALID_STATION_ID }], // station exists
        [], // no duplicate evse
        [], // EVSE insert returns empty (null evse)
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          evseId: 1,
          connectors: [{ connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150 }],
        },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json().code).toBe('INTERNAL_ERROR');
    });
  });

  // --- POST /v1/stations/:id/evses/:evseId/connectors (EVSE not found + connector insert failure) ---

  describe('POST /v1/stations/:id/evses/:evseId/connectors (edge cases)', () => {
    it('returns 404 when EVSE not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses/1/connectors`,
        headers: { authorization: 'Bearer ' + token },
        payload: { connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150 },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('EVSE_NOT_FOUND');
    });

    it('returns 500 when connector insert returns empty', async () => {
      setupDbResults(
        [{ id: 'evs_000000000001' }], // evse found
        [], // no duplicate connector
        [], // connector insert returns empty
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses/1/connectors`,
        headers: { authorization: 'Bearer ' + token },
        payload: { connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150 },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json().code).toBe('INTERNAL_ERROR');
    });
  });

  // --- DELETE /v1/stations/:id/evses/:evseId/connectors/:connectorId (EVSE not found) ---

  describe('DELETE /v1/stations/:id/evses/:evseId/connectors/:connectorId (EVSE not found)', () => {
    it('returns 404 when EVSE not found for connector delete', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/evses/999/connectors/1`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('EVSE_NOT_FOUND');
    });
  });

  // --- GET /v1/stations/:id/certificates ---

  describe('GET /v1/stations/:id/certificates', () => {
    it('returns paginated certificate list', async () => {
      const certRow = {
        id: 'cert-1',
        stationId: VALID_STATION_ID,
        certificateType: 'V2GCertificate',
        status: 'active',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      // Promise.all: data rows, count rows
      setupDbResults([certRow], [{ count: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/certificates`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(body.data).toHaveLength(1);
      expect(body.data[0].certificateType).toBe('V2GCertificate');
    });

    it('returns empty list when no certificates', async () => {
      setupDbResults([], [{ count: 0 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/certificates`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('supports status filter query param', async () => {
      setupDbResults([], [{ count: 0 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/certificates?status=expired`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  // --- POST /v1/stations/:id/certificates/install ---

  describe('POST /v1/stations/:id/certificates/install', () => {
    it('publishes InstallCertificate command and returns success', async () => {
      // db.execute returns station row
      const { db } = await import('@evtivity/database');
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { station_id: 'STATION-001' },
      ]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/certificates/install`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          certificateType: 'V2GRootCertificate',
          certificate: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
      expect(mockPublish).toHaveBeenCalledWith(
        'ocpp_commands',
        expect.stringContaining('InstallCertificate'),
      );
    });

    it('returns 404 when station not found', async () => {
      const { db } = await import('@evtivity/database');
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/certificates/install`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          certificateType: 'V2GRootCertificate',
          certificate: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });
  });

  // --- POST /v1/stations/:id/certificates/delete ---

  describe('POST /v1/stations/:id/certificates/delete', () => {
    it('publishes DeleteCertificate command and returns success', async () => {
      const { db } = await import('@evtivity/database');
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { station_id: 'STATION-001' },
      ]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/certificates/delete`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          certificateHashData: {
            hashAlgorithm: 'SHA256',
            issuerNameHash: 'abc123',
            issuerKeyHash: 'def456',
            serialNumber: '789',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
      expect(mockPublish).toHaveBeenCalledWith(
        'ocpp_commands',
        expect.stringContaining('DeleteCertificate'),
      );
    });

    it('returns 404 when station not found', async () => {
      const { db } = await import('@evtivity/database');
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/certificates/delete`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          certificateHashData: {
            hashAlgorithm: 'SHA256',
            issuerNameHash: 'abc123',
            issuerKeyHash: 'def456',
            serialNumber: '789',
          },
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });
  });

  // --- POST /v1/stations/:id/certificates/query ---

  describe('POST /v1/stations/:id/certificates/query', () => {
    it('publishes GetInstalledCertificateIds command and returns success', async () => {
      const { db } = await import('@evtivity/database');
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { station_id: 'STATION-001' },
      ]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/certificates/query`,
        headers: { authorization: 'Bearer ' + token },
        payload: { certificateType: ['V2GCertificate'] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
      expect(mockPublish).toHaveBeenCalledWith(
        'ocpp_commands',
        expect.stringContaining('GetInstalledCertificateIds'),
      );
    });

    it('returns 404 when station not found', async () => {
      const { db } = await import('@evtivity/database');
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/certificates/query`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });

    it('accepts empty body for querying all certificate types', async () => {
      const { db } = await import('@evtivity/database');
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { station_id: 'STATION-001' },
      ]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/certificates/query`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });
  });

  describe('POST /stations/:id/approve', () => {
    it('approves a pending station', async () => {
      setupDbResults(
        [{ onboardingStatus: 'pending' }], // select station
        [{ id: VALID_STATION_ID }], // update
      );
      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/approve`,
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.statusCode).toBe(200);
    });

    it('returns 409 when station is not pending', async () => {
      setupDbResults([{ onboardingStatus: 'accepted' }]);
      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/approve`,
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.statusCode).toBe(409);
    });

    it('returns 404 when station not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/approve`,
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /stations/:id/reject', () => {
    it('blocks a pending station', async () => {
      setupDbResults([{ onboardingStatus: 'pending' }], [{ id: VALID_STATION_ID }]);
      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/reject`,
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.statusCode).toBe(200);
    });

    it('returns 409 when station is not pending', async () => {
      setupDbResults([{ onboardingStatus: 'blocked' }]);
      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/reject`,
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.statusCode).toBe(409);
    });
  });

  describe('POST /stations/:id/unblock', () => {
    it('unblocks a blocked station back to pending', async () => {
      setupDbResults([{ onboardingStatus: 'blocked' }], [{ id: VALID_STATION_ID }]);
      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/unblock`,
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.statusCode).toBe(200);
    });

    it('returns 409 when station is not blocked', async () => {
      setupDbResults([{ onboardingStatus: 'pending' }]);
      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/unblock`,
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.statusCode).toBe(409);
    });

    it('returns 404 when station not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/unblock`,
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
