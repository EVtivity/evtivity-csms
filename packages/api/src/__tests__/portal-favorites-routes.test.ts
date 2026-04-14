// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// DB mock helpers
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
  driverFavoriteStations: {},
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
    inArray: vi.fn(),
    sql: sqlTag,
  };
});

import { registerAuth } from '../plugins/auth.js';
import { portalFavoriteRoutes } from '../routes/portal/favorites.js';

const DRIVER_ID = 'drv_000000000001';
const STATION_UUID = 'sta_000000000001';
const STATION_OCPP_ID = 'CS-0001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalFavoriteRoutes);
  await app.ready();
  return app;
}

describe('Portal favorite routes', () => {
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

  describe('GET /portal/favorites', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({ method: 'GET', url: '/portal/favorites' });
      expect(response.statusCode).toBe(401);
    });

    it('returns empty array when no favorites', async () => {
      // First DB call: select favorites -> empty
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/favorites',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual([]);
    });

    it('returns favorites with station data', async () => {
      const now = new Date();
      // First DB call: select favorites with joins
      // Second DB call: select EVSE counts
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
            isOnline: true,
            createdAt: now,
          },
        ],
        [
          {
            stationId: STATION_UUID,
            total: 4,
            available: 2,
          },
        ],
      );
      const response = await app.inject({
        method: 'GET',
        url: '/portal/favorites',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe(1);
      expect(body[0].stationId).toBe(STATION_OCPP_ID);
      expect(body[0].siteName).toBe('Test Site');
      expect(body[0].isOnline).toBe(true);
      expect(body[0].evseCount).toBe(4);
      expect(body[0].availableCount).toBe(2);
    });
  });

  describe('GET /portal/favorites/check/:stationId', () => {
    it('returns false for non-favorited station', async () => {
      // First DB call: find station by OCPP ID -> found
      // Second DB call: find favorite -> not found
      setupDbResults([{ id: STATION_UUID }], []);
      const response = await app.inject({
        method: 'GET',
        url: `/portal/favorites/check/${STATION_OCPP_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.isFavorite).toBe(false);
      expect(body.favoriteId).toBeNull();
    });

    it('returns true with id for favorited station', async () => {
      // First DB call: find station -> found
      // Second DB call: find favorite -> found
      setupDbResults([{ id: STATION_UUID }], [{ id: 42 }]);
      const response = await app.inject({
        method: 'GET',
        url: `/portal/favorites/check/${STATION_OCPP_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.isFavorite).toBe(true);
      expect(body.favoriteId).toBe(42);
    });

    it('returns false when station does not exist', async () => {
      // First DB call: find station -> not found
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/favorites/check/UNKNOWN-STATION',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.isFavorite).toBe(false);
      expect(body.favoriteId).toBeNull();
    });
  });

  describe('POST /portal/favorites', () => {
    it('returns 404 for unknown station', async () => {
      // First DB call: find station -> not found
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/favorites',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { stationId: 'UNKNOWN-STATION' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 409 for duplicate favorite', async () => {
      // First DB call: find station -> found
      // Second DB call: check duplicate -> found
      setupDbResults([{ id: STATION_UUID }], [{ id: 99 }]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/favorites',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { stationId: STATION_OCPP_ID },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('ALREADY_FAVORITED');
    });

    it('returns 201 on success', async () => {
      // First DB call: find station -> found
      // Second DB call: check duplicate -> not found
      // Third DB call: insert -> returning id
      setupDbResults([{ id: STATION_UUID }], [], [{ id: 7 }]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/favorites',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { stationId: STATION_OCPP_ID },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().id).toBe(7);
    });
  });

  describe('DELETE /portal/favorites/:id', () => {
    it('returns 404 for non-existent favorite', async () => {
      // First DB call: find favorite -> not found
      setupDbResults([]);
      const response = await app.inject({
        method: 'DELETE',
        url: '/portal/favorites/999',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('FAVORITE_NOT_FOUND');
    });

    it('returns 200 on successful removal', async () => {
      // First DB call: find favorite -> found (ownership matches via WHERE clause)
      // Second DB call: delete
      setupDbResults([{ id: 1 }], []);
      const response = await app.inject({
        method: 'DELETE',
        url: '/portal/favorites/1',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });
  });
});
