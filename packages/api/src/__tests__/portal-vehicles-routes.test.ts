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
  vehicles: {},
  vehicleEfficiencyLookup: {},
}));

vi.mock('drizzle-orm', () => {
  const sqlTag = (...args: unknown[]) => ({ __brand: 'SQL', args });
  return {
    eq: vi.fn(),
    and: vi.fn(),
    sql: sqlTag,
  };
});

import { registerAuth } from '../plugins/auth.js';
import { portalVehicleRoutes } from '../routes/portal/vehicles.js';

const DRIVER_ID = 'drv_000000000001';
const VEHICLE_ID = 'veh_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalVehicleRoutes);
  await app.ready();
  return app;
}

describe('Portal vehicle routes', () => {
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

  describe('GET /v1/portal/vehicles', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({ method: 'GET', url: '/portal/vehicles' });
      expect(response.statusCode).toBe(401);
    });

    it('returns vehicle list for authenticated driver', async () => {
      setupDbResults([
        {
          id: VEHICLE_ID,
          driverId: DRIVER_ID,
          make: 'Tesla',
          model: 'Model 3',
          year: '2024',
          createdAt: new Date(),
        },
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/vehicles',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].make).toBe('Tesla');
    });
  });

  describe('POST /v1/portal/vehicles', () => {
    it('creates a vehicle', async () => {
      const vehicle = {
        id: VEHICLE_ID,
        driverId: DRIVER_ID,
        make: 'Tesla',
        model: 'Model Y',
        year: '2025',
        createdAt: new Date(),
      };
      setupDbResults([vehicle]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/vehicles',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { make: 'Tesla', model: 'Model Y', year: '2025' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().make).toBe('Tesla');
    });

    it('rejects empty make', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/vehicles',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { make: '', model: 'Model Y' },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('DELETE /v1/portal/vehicles/:id', () => {
    it('returns 404 when vehicle not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'DELETE',
        url: `/portal/vehicles/${VEHICLE_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns 403 when vehicle belongs to another driver', async () => {
      setupDbResults([{ id: VEHICLE_ID, driverId: 'drv_other0000001' }]);
      const response = await app.inject({
        method: 'DELETE',
        url: `/portal/vehicles/${VEHICLE_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(403);
    });

    it('deletes own vehicle', async () => {
      setupDbResults([{ id: VEHICLE_ID, driverId: DRIVER_ID }], []);
      const response = await app.inject({
        method: 'DELETE',
        url: `/portal/vehicles/${VEHICLE_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(204);
    });
  });

  describe('GET /v1/portal/vehicles/efficiency', () => {
    it('returns default efficiency when no vehicle', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/vehicles/efficiency',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().efficiencyMiPerKwh).toBe(3.5);
    });

    it('returns default when vehicle has no make', async () => {
      setupDbResults([{ make: null, model: null }]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/vehicles/efficiency',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().efficiencyMiPerKwh).toBe(3.5);
    });

    it('returns looked-up efficiency', async () => {
      setupDbResults([{ make: 'Tesla', model: 'Model 3' }], [{ efficiencyMiPerKwh: 4.0 }]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/vehicles/efficiency',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().efficiencyMiPerKwh).toBe(4.0);
    });
  });
});
