// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// DB mock helpers (same shape as portal-favorites-routes.test.ts).
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
    execute: vi.fn(() => Promise.resolve([])),
  },
  stationWatches: {},
  chargingStations: {},
  sites: {},
  evses: {},
  connectors: {},
}));

vi.mock('drizzle-orm', () => {
  const sqlTag = (...args: unknown[]) => ({ __brand: 'SQL', args });
  return {
    eq: vi.fn(),
    and: vi.fn(),
    asc: vi.fn(),
    desc: vi.fn(),
    inArray: vi.fn(),
    sql: sqlTag,
  };
});

import { registerAuth } from '../plugins/auth.js';
import { portalStationWatchRoutes } from '../routes/portal/station-watches.js';

const DRIVER_ID = 'drv_000000000001';
const STATION_UUID = 'sta_000000000001';
const STATION_OCPP_ID = 'CS-0001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalStationWatchRoutes);
  await app.ready();
  return app;
}

describe('Portal station-watch routes', () => {
  let app: FastifyInstance;
  let driverToken: string;

  beforeAll(async () => {
    app = await buildApp();
    driverToken = app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    vi.clearAllMocks();
  });

  describe('GET /portal/station-watches', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({ method: 'GET', url: '/portal/station-watches' });
      expect(response.statusCode).toBe(401);
    });

    it('returns watches with station data', async () => {
      const now = new Date();
      const later = new Date(now.getTime() + 86_400_000);
      setupDbResults(
        [
          {
            id: 1,
            stationOcppId: STATION_OCPP_ID,
            stationUuid: STATION_UUID,
            siteName: 'Test Site',
            siteAddress: '123 Main St',
            siteCity: 'Springfield',
            siteState: 'IL',
            isOnline: false,
            createdAt: now,
            expiresAt: later,
          },
        ],
        [{ stationId: STATION_UUID, total: 2, available: 0 }],
      );
      const response = await app.inject({
        method: 'GET',
        url: '/portal/station-watches',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].stationId).toBe(STATION_OCPP_ID);
      expect(body[0].availableCount).toBe(0);
    });
  });

  describe('GET /portal/station-watches/check/:stationId', () => {
    it('returns false when not watching', async () => {
      setupDbResults([{ id: STATION_UUID }], []);
      const response = await app.inject({
        method: 'GET',
        url: `/portal/station-watches/check/${STATION_OCPP_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ isWatching: false, watchId: null });
    });

    it('returns true with id when watching', async () => {
      setupDbResults([{ id: STATION_UUID }], [{ id: 42 }]);
      const response = await app.inject({
        method: 'GET',
        url: `/portal/station-watches/check/${STATION_OCPP_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.json()).toEqual({ isWatching: true, watchId: 42 });
    });
  });

  describe('POST /portal/station-watches', () => {
    it('returns 404 for unknown station', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/station-watches',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { stationId: 'UNKNOWN' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 409 when a connector is already available', async () => {
      // station found, available-count > 0
      setupDbResults([{ id: STATION_UUID }], [{ total: 1 }]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/station-watches',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { stationId: STATION_OCPP_ID },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('STATION_ALREADY_AVAILABLE');
    });

    it('returns the existing watch on idempotent re-tap', async () => {
      // station found, available-count 0, existing watch found
      setupDbResults([{ id: STATION_UUID }], [{ total: 0 }], [{ id: 5 }]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/station-watches',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { stationId: STATION_OCPP_ID },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().id).toBe(5);
    });

    it('returns 409 when over the watch cap', async () => {
      // station found, available 0, no existing, count at cap
      setupDbResults([{ id: STATION_UUID }], [{ total: 0 }], [], [{ total: 25 }]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/station-watches',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { stationId: STATION_OCPP_ID },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('TOO_MANY_WATCHES');
    });

    it('returns 201 on success', async () => {
      // station found, available 0, no existing, count under cap, insert
      setupDbResults([{ id: STATION_UUID }], [{ total: 0 }], [], [{ total: 0 }], [{ id: 7 }]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/station-watches',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { stationId: STATION_OCPP_ID },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().id).toBe(7);
    });
  });

  describe('DELETE /portal/station-watches/:id', () => {
    it('returns 404 for non-existent watch', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'DELETE',
        url: '/portal/station-watches/999',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_WATCH_NOT_FOUND');
    });

    it('returns 200 on successful removal', async () => {
      setupDbResults([{ id: 1 }], []);
      const response = await app.inject({
        method: 'DELETE',
        url: '/portal/station-watches/1',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });
  });
});
