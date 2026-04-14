// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const VALID_SITE_ID = 'sit_000000000001';
const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';
const VALID_STATION_ID = 'sta_000000000001';

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

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
  invalidatePermissionCache: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() =>
      Promise.resolve([
        {
          uptime_percent: '99.5',
          port_count: '4',
          disconnect_count: '2',
          avg_downtime_minutes: '3',
          max_downtime_minutes: '8',
        },
      ]),
    ),
  },
  sites: {},
  chargingStations: {},
  chargingSessions: {},
  drivers: {},
  meterValues: {},
  stationLayoutPositions: {},
  evses: {},
  connectors: {},
  siteLoadManagement: {},
  displayMessages: {},
}));

vi.mock('drizzle-orm', () => {
  const sqlFn = () => ({ as: vi.fn() });
  return {
    eq: vi.fn(),
    and: vi.fn(),
    or: vi.fn(),
    ilike: vi.fn(),
    sql: Object.assign(vi.fn(sqlFn), { raw: vi.fn(sqlFn) }),
    gte: vi.fn(),
    desc: vi.fn(),
    count: vi.fn(),
    inArray: vi.fn(),
  };
});

vi.mock('@evtivity/lib', () => ({
  isValidTimezone: vi.fn(() => true),
}));

vi.mock('../services/site-import.service.js', () => ({
  exportSitesCsv: vi.fn().mockResolvedValue('name,address\nSite1,123 Main St\n'),
  exportSitesTemplateCsv: vi.fn().mockReturnValue('siteName,stationId\n'),
  importSitesCsv: vi.fn().mockResolvedValue({
    sitesCreated: 1,
    sitesUpdated: 0,
    stationsCreated: 0,
    stationsUpdated: 0,
    evsesCreated: 0,
    evsesUpdated: 0,
    connectorsCreated: 0,
    connectorsUpdated: 0,
    errors: [],
  }),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { siteRoutes } from '../routes/sites.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(siteRoutes);
  await app.ready();
  return app;
}

describe('Site routes - handler logic', () => {
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

  // --- GET /v1/sites ---

  describe('GET /v1/sites', () => {
    it('returns paginated site list', async () => {
      const siteRow = {
        id: VALID_SITE_ID,
        name: 'Test Site',
        address: null,
        city: 'Portland',
        state: null,
        postalCode: null,
        country: null,
        latitude: null,
        longitude: null,
        timezone: null,
        contactName: null,
        contactEmail: null,
        contactPhone: null,
        contactIsPublic: false,
        hoursOfOperation: null,
        metadata: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stationCount: 3,
        loadManagementEnabled: false,
        maxPowerKw: null,
        totalDrawKw: 0,
      };
      setupDbResults([siteRow], [{ count: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: '/sites',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe('Test Site');
    });

    it('returns empty when no sites', async () => {
      setupDbResults([], [{ count: 0 }]);

      const response = await app.inject({
        method: 'GET',
        url: '/sites',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data).toHaveLength(0);
      expect(response.json().total).toBe(0);
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/sites',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // --- GET /v1/sites/:id ---

  describe('GET /v1/sites/:id', () => {
    it('returns site when found', async () => {
      const site = {
        id: VALID_SITE_ID,
        name: 'My Site',
        address: null,
        city: null,
        state: null,
        postalCode: null,
        country: null,
        latitude: null,
        longitude: null,
        timezone: null,
        contactName: null,
        contactEmail: null,
        contactPhone: null,
        contactIsPublic: false,
        hoursOfOperation: null,
        metadata: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stationCount: 5,
        loadManagementEnabled: false,
        maxPowerKw: null,
        totalDrawKw: 0,
      };
      setupDbResults([site]);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().name).toBe('My Site');
    });

    it('returns 404 when site not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SITE_NOT_FOUND');
    });
  });

  // --- POST /v1/sites ---

  describe('POST /v1/sites', () => {
    it('creates a site and returns 201', async () => {
      const site = {
        id: VALID_SITE_ID,
        name: 'New Site',
        address: '123 Main St',
        city: null,
        state: null,
        postalCode: null,
        country: null,
        latitude: null,
        longitude: null,
        timezone: null,
        hoursOfOperation: null,
        metadata: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults([site]);

      const response = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { authorization: 'Bearer ' + token },
        payload: { name: 'New Site', address: '123 Main St' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().name).toBe('New Site');
    });

    it('returns 400 for missing name', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // --- PATCH /v1/sites/:id ---

  describe('PATCH /v1/sites/:id', () => {
    it('updates site and returns it', async () => {
      const updated = {
        id: VALID_SITE_ID,
        name: 'Updated Site',
        address: null,
        city: null,
        state: null,
        postalCode: null,
        country: null,
        latitude: null,
        longitude: null,
        timezone: null,
        hoursOfOperation: null,
        metadata: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults([updated]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { name: 'Updated Site' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().name).toBe('Updated Site');
    });

    it('returns 404 when site not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { name: 'X' },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SITE_NOT_FOUND');
    });
  });

  // --- DELETE /v1/sites/:id ---

  describe('DELETE /v1/sites/:id', () => {
    it('deletes site when no stations attached', async () => {
      const site = {
        id: VALID_SITE_ID,
        name: 'Deleted Site',
        address: null,
        city: null,
        state: null,
        postalCode: null,
        country: null,
        latitude: null,
        longitude: null,
        timezone: null,
        hoursOfOperation: null,
        metadata: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults(
        [], // no stations found
        [site], // delete returning
      );

      const response = await app.inject({
        method: 'DELETE',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().name).toBe('Deleted Site');
    });

    it('returns 409 when site has stations', async () => {
      setupDbResults([{ id: 'sta_000000000002' }]);

      const response = await app.inject({
        method: 'DELETE',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('SITE_HAS_STATIONS');
    });

    it('returns 404 when site not found (no stations but no site row)', async () => {
      setupDbResults(
        [], // no stations
        [], // delete returns nothing
      );

      const response = await app.inject({
        method: 'DELETE',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SITE_NOT_FOUND');
    });
  });

  // --- GET /v1/sites/:id/stations ---

  describe('GET /v1/sites/:id/stations', () => {
    it('returns paginated stations for a site', async () => {
      const stationRow = {
        id: 'st-1',
        stationId: 'STATION-001',
        siteId: VALID_SITE_ID,
        model: null,
        serialNumber: null,
        availability: 'available',
        securityProfile: 0,
        lastHeartbeat: null,
        isOnline: false,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        status: 'available',
        connectorCount: 0,
        connectorTypes: null,
      };
      // 1: site exists, 2: data, 3: count
      setupDbResults([{ id: VALID_SITE_ID }], [stationRow], [{ count: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/stations`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(body.data).toHaveLength(1);
    });

    it('returns 404 when site not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/stations`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SITE_NOT_FOUND');
    });
  });

  // --- GET /v1/sites/:id/energy-history ---

  describe('GET /v1/sites/:id/energy-history', () => {
    it('returns daily energy history', async () => {
      setupDbResults([{ timezone: 'America/New_York' }], [{ date: '2025-01-01', energyWh: 10000 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/energy-history`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0]).toHaveProperty('date');
      expect(body[0]).toHaveProperty('energyWh');
    });
  });

  // --- GET /v1/sites/:id/revenue-history ---

  describe('GET /v1/sites/:id/revenue-history', () => {
    it('returns daily revenue history', async () => {
      setupDbResults(
        [{ timezone: 'America/Chicago' }],
        [{ date: '2025-01-01', revenueCents: 5000, sessionCount: 10 }],
      );

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/revenue-history`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0]).toHaveProperty('revenueCents');
      expect(body[0]).toHaveProperty('sessionCount');
    });
  });

  // --- GET /v1/sites/:id/meter-values ---

  describe('GET /v1/sites/:id/meter-values', () => {
    it('returns grouped meter values for a site', async () => {
      const rows = [
        {
          measurand: 'Energy.Active.Import.Register',
          unit: 'Wh',
          timestamp: new Date(),
          value: '1000',
        },
      ];
      setupDbResults(rows);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/meter-values`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].measurand).toBe('Energy.Active.Import.Register');
    });
  });

  // --- GET /v1/sites/:id/sessions ---

  describe('GET /v1/sites/:id/sessions', () => {
    it('returns paginated sessions for site', async () => {
      const session = {
        id: 'sess-1',
        stationId: VALID_STATION_ID,
        stationName: 'STATION-001',
        siteName: 'Test Site',
        driverId: null,
        driverName: null,
        transactionId: null,
        status: 'completed',
        energyDeliveredWh: '5000',
        currentCostCents: null,
        finalCostCents: null,
        currency: null,
        startedAt: '2024-01-01T00:00:00.000Z',
        endedAt: null,
        freeVend: false,
      };
      setupDbResults([session], [{ count: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/sessions`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
    });
  });

  // --- GET /v1/sites/:id/metrics ---

  describe('GET /v1/sites/:id/metrics', () => {
    it('returns site metrics', async () => {
      const sessionStats = {
        totalSessions: 20,
        completedSessions: 18,
        faultedSessions: 1,
        totalEnergyWh: 100000,
        avgDurationMinutes: 45,
      };
      const utilizationStats = { sessionHours: 15, portCount: 4 };
      const financialStats = {
        totalRevenueCents: 25000,
        avgRevenueCentsPerSession: 1250,
        totalTransactions: 16,
      };

      setupDbResults([sessionStats], [utilizationStats], [financialStats]);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/metrics`,
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

  // --- GET /v1/sites/:id/layout ---

  describe('GET /v1/sites/:id/layout', () => {
    it('returns layout with station positions and EVSEs', async () => {
      const stationRow = {
        id: 'sta_000000000003',
        stationId: 'STATION-001',
        model: 'Model X',
        availability: 'available',
        isOnline: true,
        securityProfile: 0,
        positionX: '100',
        positionY: '200',
      };
      const evseRow = {
        id: 'evs_000000000001',
        stationId: 'sta_000000000003',
        evseId: 1,
      };
      const connectorRow = {
        id: 'con_000000000002',
        evseId: 'evs_000000000001',
        connectorId: 1,
        connectorType: 'CCS2',
        maxPowerKw: 150,
        status: 'available',
      };

      // 1: site exists, 2: stations, 3: evses, 4: connectors, 5: sessions, 6: display messages
      setupDbResults(
        [{ id: VALID_SITE_ID }],
        [stationRow],
        [evseRow],
        [connectorRow],
        [], // no active sessions
        [], // no display messages
      );

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].stationId).toBe('STATION-001');
      expect(body[0].positionX).toBe(100);
    });

    it('returns 404 when site not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SITE_NOT_FOUND');
    });
  });

  // --- PUT /v1/sites/:id/layout ---

  describe('PUT /v1/sites/:id/layout', () => {
    it('saves layout positions and returns ok', async () => {
      setupDbResults(
        [{ id: VALID_SITE_ID }], // site exists
        [], // upsert result (for each position)
      );

      const response = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          positions: [{ stationId: VALID_STATION_ID, positionX: 50, positionY: 100 }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().ok).toBe(true);
    });

    it('returns 404 when site not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          positions: [{ stationId: VALID_STATION_ID, positionX: 0, positionY: 0 }],
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SITE_NOT_FOUND');
    });
  });

  // --- GET /v1/sites/export ---

  describe('GET /v1/sites/export', () => {
    it('returns CSV data with correct content type', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/sites/export',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
    });
  });

  // --- GET /v1/sites/export/template ---

  describe('GET /v1/sites/export/template', () => {
    it('returns template CSV', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/sites/export/template',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
    });
  });

  // --- POST /v1/sites/import ---

  describe('POST /v1/sites/import', () => {
    it('imports sites from rows and returns result', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/sites/import',
        headers: { authorization: 'Bearer ' + token },
        payload: {
          rows: [{ siteName: 'Imported Site' }],
          updateExisting: false,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty('sitesCreated');
    });

    it('returns 400 for invalid body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/sites/import',
        headers: { authorization: 'Bearer ' + token },
        payload: { rows: 'not-array', updateExisting: false },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
