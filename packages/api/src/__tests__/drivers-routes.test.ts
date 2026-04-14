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
  drivers: {},
  driverTokens: {},
  vehicles: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
}));

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

import { registerAuth } from '../plugins/auth.js';
import { driverRoutes } from '../routes/drivers.js';

const VALID_DRIVER_ID = 'drv_000000000001';

const now = new Date().toISOString();

function makeDriver(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_DRIVER_ID,
    firstName: 'John',
    lastName: 'Doe',
    email: 'john@example.com',
    phone: '+15551234567',
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeToken(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_DRIVER_ID,
    driverId: VALID_DRIVER_ID,
    idToken: 'RFID-ABC-123',
    tokenType: 'ISO14443',
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const VALID_VEHICLE_ID = 'veh_000000000001';

function makeVehicle(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_VEHICLE_ID,
    driverId: VALID_DRIVER_ID,
    make: 'Tesla',
    model: 'Model 3',
    year: '2024',
    vin: '5YJ3E1EA1PF000001',
    licensePlate: 'ABC123',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  driverRoutes(app);
  await app.ready();
  return app;
}

describe('Driver routes (operator)', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: 'test-id', roleId: 'test-role' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
  });

  // -------------------------------------------------------
  // GET /v1/drivers
  // -------------------------------------------------------

  describe('GET /v1/drivers', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({ method: 'GET', url: '/drivers' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 with no search param', async () => {
      const driver = makeDriver();
      // First result: data rows, second result: count rows
      setupDbResults([driver], [{ count: 1 }]);

      const res = await app.inject({
        method: 'GET',
        url: '/drivers',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual([driver]);
      expect(body.total).toBe(1);
    });

    it('returns 200 with search param', async () => {
      const driver = makeDriver({ firstName: 'Jane' });
      setupDbResults([driver], [{ count: 1 }]);

      const res = await app.inject({
        method: 'GET',
        url: '/drivers?search=Jane',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual([driver]);
      expect(body.total).toBe(1);
    });

    it('returns total 0 when count row is missing', async () => {
      setupDbResults([], []);

      const res = await app.inject({
        method: 'GET',
        url: '/drivers',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });
  });

  // -------------------------------------------------------
  // GET /v1/drivers/:id
  // -------------------------------------------------------

  describe('GET /v1/drivers/:id', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({ method: 'GET', url: `/drivers/${VALID_DRIVER_ID}` });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when driver not found', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'GET',
        url: `/drivers/${VALID_DRIVER_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBe('Driver not found');
      expect(body.code).toBe('DRIVER_NOT_FOUND');
    });

    it('returns 200 when driver found', async () => {
      const driver = makeDriver();
      setupDbResults([driver]);

      const res = await app.inject({
        method: 'GET',
        url: `/drivers/${VALID_DRIVER_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(VALID_DRIVER_ID);
      expect(body.firstName).toBe('John');
    });
  });

  // -------------------------------------------------------
  // POST /v1/drivers
  // -------------------------------------------------------

  describe('POST /v1/drivers', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/drivers',
        payload: { firstName: 'John', lastName: 'Doe' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 201 on success', async () => {
      const driver = makeDriver();
      setupDbResults([], [driver]);

      const res = await app.inject({
        method: 'POST',
        url: '/drivers',
        headers: { authorization: `Bearer ${token}` },
        payload: { firstName: 'John', lastName: 'Doe', email: 'john@example.com' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBe(VALID_DRIVER_ID);
      expect(body.firstName).toBe('John');
    });
  });

  // -------------------------------------------------------
  // PATCH /v1/drivers/:id
  // -------------------------------------------------------

  describe('PATCH /v1/drivers/:id', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${VALID_DRIVER_ID}`,
        payload: { firstName: 'Jane' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when update returns empty', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${VALID_DRIVER_ID}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { firstName: 'Jane' },
      });

      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBe('Driver not found');
      expect(body.code).toBe('DRIVER_NOT_FOUND');
    });

    it('returns 200 with all fields updated', async () => {
      const updated = makeDriver({
        firstName: 'Jane',
        lastName: 'Smith',
        email: 'jane@example.com',
        phone: '+15559876543',
        isActive: false,
      });
      setupDbResults([updated]);

      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${VALID_DRIVER_ID}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          firstName: 'Jane',
          lastName: 'Smith',
          email: 'jane@example.com',
          phone: '+15559876543',
          isActive: false,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.firstName).toBe('Jane');
      expect(body.lastName).toBe('Smith');
      expect(body.email).toBe('jane@example.com');
      expect(body.phone).toBe('+15559876543');
      expect(body.isActive).toBe(false);
    });

    it('returns 200 with only firstName', async () => {
      const updated = makeDriver({ firstName: 'Updated' });
      setupDbResults([updated]);

      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${VALID_DRIVER_ID}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { firstName: 'Updated' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().firstName).toBe('Updated');
    });

    it('returns 200 with only lastName', async () => {
      const updated = makeDriver({ lastName: 'Updated' });
      setupDbResults([updated]);

      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${VALID_DRIVER_ID}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { lastName: 'Updated' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().lastName).toBe('Updated');
    });

    it('returns 200 with only email', async () => {
      const updated = makeDriver({ email: 'new@example.com' });
      setupDbResults([updated]);

      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${VALID_DRIVER_ID}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { email: 'new@example.com' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().email).toBe('new@example.com');
    });

    it('returns 200 with only phone', async () => {
      const updated = makeDriver({ phone: '+15550000000' });
      setupDbResults([updated]);

      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${VALID_DRIVER_ID}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { phone: '+15550000000' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().phone).toBe('+15550000000');
    });

    it('returns 200 with only isActive', async () => {
      const updated = makeDriver({ isActive: false });
      setupDbResults([updated]);

      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${VALID_DRIVER_ID}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { isActive: false },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().isActive).toBe(false);
    });
  });

  // -------------------------------------------------------
  // GET /v1/drivers/:id/tokens
  // -------------------------------------------------------

  describe('GET /v1/drivers/:id/tokens', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/drivers/${VALID_DRIVER_ID}/tokens`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 with tokens', async () => {
      const driverToken = makeToken();
      setupDbResults([driverToken]);

      const res = await app.inject({
        method: 'GET',
        url: `/drivers/${VALID_DRIVER_ID}/tokens`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual([driverToken]);
    });
  });

  // -------------------------------------------------------
  // POST /v1/drivers/:id/tokens
  // -------------------------------------------------------

  describe('POST /v1/drivers/:id/tokens', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${VALID_DRIVER_ID}/tokens`,
        payload: { idToken: 'RFID-XYZ', tokenType: 'ISO14443' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 201 on success', async () => {
      const driverToken = makeToken({ idToken: 'RFID-XYZ' });
      setupDbResults([driverToken]);

      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${VALID_DRIVER_ID}/tokens`,
        headers: { authorization: `Bearer ${token}` },
        payload: { idToken: 'RFID-XYZ', tokenType: 'ISO14443' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.idToken).toBe('RFID-XYZ');
      expect(body.tokenType).toBe('ISO14443');
    });
  });

  // -------------------------------------------------------
  // DELETE /v1/drivers/:id
  // -------------------------------------------------------

  describe('DELETE /v1/drivers/:id', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/drivers/${VALID_DRIVER_ID}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when driver not found', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'DELETE',
        url: `/drivers/${VALID_DRIVER_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBe('Driver not found');
      expect(body.code).toBe('DRIVER_NOT_FOUND');
    });

    it('returns 204 on success (soft delete)', async () => {
      const driver = makeDriver();
      // First query: select to check existence, second query: update (soft delete)
      setupDbResults([driver], []);

      const res = await app.inject({
        method: 'DELETE',
        url: `/drivers/${VALID_DRIVER_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
    });
  });

  // -------------------------------------------------------
  // GET /v1/drivers/:id/vehicles
  // -------------------------------------------------------

  describe('GET /v1/drivers/:id/vehicles', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/drivers/${VALID_DRIVER_ID}/vehicles`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 with vehicles', async () => {
      const vehicle = makeVehicle();
      setupDbResults([vehicle]);

      const res = await app.inject({
        method: 'GET',
        url: `/drivers/${VALID_DRIVER_ID}/vehicles`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual([vehicle]);
    });

    it('returns 200 with empty array', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'GET',
        url: `/drivers/${VALID_DRIVER_ID}/vehicles`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });
  });

  // -------------------------------------------------------
  // POST /v1/drivers/:id/vehicles
  // -------------------------------------------------------

  describe('POST /v1/drivers/:id/vehicles', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${VALID_DRIVER_ID}/vehicles`,
        payload: { make: 'Tesla', model: 'Model 3' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 201 on success', async () => {
      const vehicle = makeVehicle();
      setupDbResults([vehicle]);

      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${VALID_DRIVER_ID}/vehicles`,
        headers: { authorization: `Bearer ${token}` },
        payload: { make: 'Tesla', model: 'Model 3' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.make).toBe('Tesla');
      expect(body.model).toBe('Model 3');
    });

    it('returns 201 with all optional fields', async () => {
      const vehicle = makeVehicle();
      setupDbResults([vehicle]);

      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${VALID_DRIVER_ID}/vehicles`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          make: 'Tesla',
          model: 'Model 3',
          year: '2024',
          vin: '5YJ3E1EA1PF000001',
          licensePlate: 'ABC123',
        },
      });

      expect(res.statusCode).toBe(201);
    });

    it('returns 400 when make is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${VALID_DRIVER_ID}/vehicles`,
        headers: { authorization: `Bearer ${token}` },
        payload: { model: 'Model 3' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when model is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/drivers/${VALID_DRIVER_ID}/vehicles`,
        headers: { authorization: `Bearer ${token}` },
        payload: { make: 'Tesla' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // -------------------------------------------------------
  // PATCH /v1/drivers/:id/vehicles/:vehicleId
  // -------------------------------------------------------

  describe('PATCH /v1/drivers/:id/vehicles/:vehicleId', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${VALID_DRIVER_ID}/vehicles/${VALID_VEHICLE_ID}`,
        payload: { make: 'BMW' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 on success', async () => {
      const updated = makeVehicle({ make: 'BMW' });
      setupDbResults([updated]);

      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${VALID_DRIVER_ID}/vehicles/${VALID_VEHICLE_ID}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { make: 'BMW' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().make).toBe('BMW');
    });

    it('returns 404 when vehicle not found', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'PATCH',
        url: `/drivers/${VALID_DRIVER_ID}/vehicles/${VALID_VEHICLE_ID}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { make: 'BMW' },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('VEHICLE_NOT_FOUND');
    });
  });

  // -------------------------------------------------------
  // GET /v1/drivers/:id/vehicles/:vehicleId
  // -------------------------------------------------------

  describe('GET /v1/drivers/:id/vehicles/:vehicleId', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/drivers/${VALID_DRIVER_ID}/vehicles/${VALID_VEHICLE_ID}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 when vehicle found', async () => {
      const vehicle = makeVehicle();
      setupDbResults([vehicle]);

      const res = await app.inject({
        method: 'GET',
        url: `/drivers/${VALID_DRIVER_ID}/vehicles/${VALID_VEHICLE_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(VALID_VEHICLE_ID);
      expect(body.make).toBe('Tesla');
      expect(body.model).toBe('Model 3');
    });

    it('returns 404 when vehicle not found', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'GET',
        url: `/drivers/${VALID_DRIVER_ID}/vehicles/${VALID_VEHICLE_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('VEHICLE_NOT_FOUND');
    });
  });

  // -------------------------------------------------------
  // DELETE /v1/drivers/:id/vehicles/:vehicleId
  // -------------------------------------------------------

  describe('DELETE /v1/drivers/:id/vehicles/:vehicleId', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/drivers/${VALID_DRIVER_ID}/vehicles/${VALID_VEHICLE_ID}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 204 on success', async () => {
      const vehicle = makeVehicle();
      setupDbResults([vehicle]);

      const res = await app.inject({
        method: 'DELETE',
        url: `/drivers/${VALID_DRIVER_ID}/vehicles/${VALID_VEHICLE_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
    });

    it('returns 404 when vehicle not found', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'DELETE',
        url: `/drivers/${VALID_DRIVER_ID}/vehicles/${VALID_VEHICLE_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('VEHICLE_NOT_FOUND');
    });
  });
});
