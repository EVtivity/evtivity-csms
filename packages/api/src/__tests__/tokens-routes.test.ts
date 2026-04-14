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
    execute: vi.fn(() => Promise.resolve([])),
  },
  chargingSessions: {},
  chargingStations: {},
  sites: {},
  driverTokens: {},
  drivers: {},
}));

vi.mock('drizzle-orm', () => {
  const sqlFn = () => ({ as: vi.fn() });
  return {
    eq: vi.fn(),
    and: vi.fn(),
    or: vi.fn(),
    ilike: vi.fn(),
    sql: Object.assign(vi.fn(sqlFn), { raw: vi.fn(sqlFn) }),
    desc: vi.fn(),
    count: vi.fn(),
    asc: vi.fn(),
  };
});

import { registerAuth } from '../plugins/auth.js';
import { tokenRoutes } from '../routes/tokens.js';

const VALID_TOKEN_ID = 'dtk_000000000001';
const TOKEN_ID_2 = 'dtk_000000000002';
const VALID_DRIVER_ID = 'drv_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  app.register(async (instance) => {
    tokenRoutes(instance);
  });
  await app.ready();
  return app;
}

describe('Token routes - handler logic', () => {
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

  describe('GET /v1/tokens', () => {
    it('returns paginated tokens with defaults', async () => {
      const tokens = [
        {
          id: TOKEN_ID_2,
          driverId: VALID_DRIVER_ID,
          idToken: 'RFID001',
          tokenType: 'ISO14443',
          isActive: true,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          driverFirstName: 'John',
          driverLastName: 'Doe',
          driverEmail: 'john@example.com',
        },
      ];
      setupDbResults(tokens, [{ count: 1 }]);
      const response = await app.inject({
        method: 'GET',
        url: '/tokens',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(1);
      expect(body.data[0].idToken).toBe('RFID001');
    });

    it('passes search parameter through to service', async () => {
      setupDbResults([], [{ count: 0 }]);
      const response = await app.inject({
        method: 'GET',
        url: '/tokens?search=test',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('returns empty list when no tokens exist', async () => {
      setupDbResults([], [{ count: 0 }]);
      const response = await app.inject({
        method: 'GET',
        url: '/tokens?page=1&limit=10',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });
  });

  describe('GET /v1/tokens/export', () => {
    it('returns CSV with correct headers', async () => {
      const tokens = [
        {
          id: TOKEN_ID_2,
          driverId: VALID_DRIVER_ID,
          idToken: 'RFID001',
          tokenType: 'ISO14443',
          isActive: true,
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
          driverFirstName: 'John',
          driverLastName: 'Doe',
          driverEmail: 'john@example.com',
        },
      ];
      setupDbResults(tokens);
      const response = await app.inject({
        method: 'GET',
        url: '/tokens/export',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/csv');
      expect(response.headers['content-disposition']).toBe('attachment; filename=tokens.csv');
      const csv = response.body;
      expect(csv).toContain('idToken,tokenType,driverEmail,isActive');
      expect(csv).toContain('RFID001');
    });

    it('returns CSV with empty data', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: '/tokens/export',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/csv');
      const csv = response.body;
      expect(csv).toBe('idToken,tokenType,driverEmail,isActive');
    });

    it('passes search to export service', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: '/tokens/export?search=rfid',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/csv');
    });
  });

  describe('POST /v1/tokens/import', () => {
    it('imports tokens from rows', async () => {
      // First DB call: driver lookup for the email
      // Second DB call: insert
      setupDbResults([{ id: VALID_DRIVER_ID }], []);
      const response = await app.inject({
        method: 'POST',
        url: '/tokens/import',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          rows: [{ idToken: 'RFID001', tokenType: 'ISO14443', driverEmail: 'john@example.com' }],
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.imported).toBe(1);
      expect(body.errors).toEqual([]);
    });

    it('returns errors for rows with missing fields', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tokens/import',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          rows: [{ idToken: '', tokenType: '' }],
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.imported).toBe(0);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toContain('Row 1');
    });

    it('returns errors when driver email not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/tokens/import',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          rows: [
            { idToken: 'RFID002', tokenType: 'ISO14443', driverEmail: 'notfound@example.com' },
          ],
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.imported).toBe(0);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toContain('driver not found');
    });

    it('imports tokens without driverEmail', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/tokens/import',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          rows: [{ idToken: 'RFID003', tokenType: 'ISO14443' }],
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.imported).toBe(1);
      expect(body.errors).toEqual([]);
    });

    it('imports empty rows array', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tokens/import',
        headers: { authorization: `Bearer ${token}` },
        payload: { rows: [] },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.imported).toBe(0);
      expect(body.errors).toEqual([]);
    });
  });

  describe('GET /v1/tokens/:id/sessions', () => {
    it('returns 404 when token not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: `/tokens/${VALID_TOKEN_ID}/sessions`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('TOKEN_NOT_FOUND');
    });

    it('returns empty data when token has no driverId', async () => {
      const tokenData = {
        id: TOKEN_ID_2,
        driverId: null,
        idToken: 'RFID001',
        tokenType: 'ISO14443',
        isActive: true,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        driverFirstName: null,
        driverLastName: null,
        driverEmail: null,
      };
      setupDbResults([tokenData]);
      const response = await app.inject({
        method: 'GET',
        url: `/tokens/${VALID_TOKEN_ID}/sessions`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('returns sessions when token has a driverId', async () => {
      const tokenData = {
        id: TOKEN_ID_2,
        driverId: VALID_DRIVER_ID,
        idToken: 'RFID001',
        tokenType: 'ISO14443',
        isActive: true,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        driverFirstName: 'John',
        driverLastName: 'Doe',
        driverEmail: 'john@example.com',
      };
      const sessions = [
        {
          id: 'ses_000000000001',
          stationId: 'sta_000000000001',
          stationName: 'Station-A',
          siteName: 'Main Site',
          driverId: VALID_DRIVER_ID,
          driverName: 'John Doe',
          transactionId: 'TX-001',
          status: 'completed',
          startedAt: '2024-01-01T10:00:00.000Z',
          endedAt: '2024-01-01T11:00:00.000Z',
          energyDeliveredWh: '15000',
          currentCostCents: null,
          finalCostCents: 450,
          currency: 'USD',
        },
      ];
      // First DB call: getToken (service)
      // Second and third: session data + count in Promise.all
      setupDbResults([tokenData], sessions, [{ count: 1 }]);
      const response = await app.inject({
        method: 'GET',
        url: `/tokens/${VALID_TOKEN_ID}/sessions?page=1&limit=10`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(1);
      expect(body.data[0].transactionId).toBe('TX-001');
      expect(body.data[0].status).toBe('completed');
    });

    it('returns total 0 when count row is empty', async () => {
      const tokenData = {
        id: TOKEN_ID_2,
        driverId: VALID_DRIVER_ID,
        idToken: 'RFID001',
        tokenType: 'ISO14443',
        isActive: true,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        driverFirstName: 'John',
        driverLastName: 'Doe',
        driverEmail: 'john@example.com',
      };
      // getToken, sessions data, count returns empty array
      setupDbResults([tokenData], [], []);
      const response = await app.inject({
        method: 'GET',
        url: `/tokens/${VALID_TOKEN_ID}/sessions`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('returns 400 for invalid id param', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/tokens/not-a-nanoid/sessions',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /v1/tokens/:id', () => {
    it('returns token when found', async () => {
      const tokenData = {
        id: TOKEN_ID_2,
        driverId: VALID_DRIVER_ID,
        idToken: 'RFID001',
        tokenType: 'ISO14443',
        isActive: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        driverFirstName: 'John',
        driverLastName: 'Doe',
        driverEmail: 'john@example.com',
      };
      setupDbResults([tokenData]);
      const response = await app.inject({
        method: 'GET',
        url: `/tokens/${VALID_TOKEN_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.idToken).toBe('RFID001');
      expect(body.driverFirstName).toBe('John');
    });

    it('returns 404 when token not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: `/tokens/${VALID_TOKEN_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('TOKEN_NOT_FOUND');
    });

    it('returns 400 for invalid id param', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/tokens/not-a-nanoid',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /v1/tokens', () => {
    it('creates a token and returns 201', async () => {
      const created = {
        id: TOKEN_ID_2,
        driverId: null,
        idToken: 'RFID-NEW',
        tokenType: 'ISO14443',
        isActive: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults([created]);
      const response = await app.inject({
        method: 'POST',
        url: '/tokens',
        headers: { authorization: `Bearer ${token}` },
        payload: { idToken: 'RFID-NEW', tokenType: 'ISO14443' },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.idToken).toBe('RFID-NEW');
      expect(body.tokenType).toBe('ISO14443');
    });

    it('creates a token with driverId', async () => {
      const created = {
        id: TOKEN_ID_2,
        driverId: VALID_DRIVER_ID,
        idToken: 'RFID-DRIVER',
        tokenType: 'ISO14443',
        isActive: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults([created]);
      const response = await app.inject({
        method: 'POST',
        url: '/tokens',
        headers: { authorization: `Bearer ${token}` },
        payload: { idToken: 'RFID-DRIVER', tokenType: 'ISO14443', driverId: VALID_DRIVER_ID },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.driverId).toBe(VALID_DRIVER_ID);
    });
  });

  describe('PATCH /v1/tokens/:id', () => {
    it('updates a token when found', async () => {
      const updated = {
        id: TOKEN_ID_2,
        driverId: null,
        idToken: 'RFID-UPDATED',
        tokenType: 'eMAID',
        isActive: false,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
      };
      setupDbResults([updated]);
      const response = await app.inject({
        method: 'PATCH',
        url: `/tokens/${VALID_TOKEN_ID}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { idToken: 'RFID-UPDATED', tokenType: 'eMAID', isActive: false },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.idToken).toBe('RFID-UPDATED');
      expect(body.isActive).toBe(false);
    });

    it('returns 404 when token not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'PATCH',
        url: `/tokens/${VALID_TOKEN_ID}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { isActive: false },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('TOKEN_NOT_FOUND');
    });

    it('updates driverId to null', async () => {
      const updated = {
        id: TOKEN_ID_2,
        driverId: null,
        idToken: 'RFID001',
        tokenType: 'ISO14443',
        isActive: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
      };
      setupDbResults([updated]);
      const response = await app.inject({
        method: 'PATCH',
        url: `/tokens/${VALID_TOKEN_ID}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { driverId: null },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().driverId).toBeNull();
    });

    it('assigns a driverId', async () => {
      const updated = {
        id: TOKEN_ID_2,
        driverId: VALID_DRIVER_ID,
        idToken: 'RFID001',
        tokenType: 'ISO14443',
        isActive: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
      };
      setupDbResults([updated]);
      const response = await app.inject({
        method: 'PATCH',
        url: `/tokens/${VALID_TOKEN_ID}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { driverId: VALID_DRIVER_ID },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().driverId).toBe(VALID_DRIVER_ID);
    });
  });

  describe('DELETE /v1/tokens/:id', () => {
    it('deletes a token when found', async () => {
      const deleted = {
        id: TOKEN_ID_2,
        driverId: null,
        idToken: 'RFID-DELETED',
        tokenType: 'ISO14443',
        isActive: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults([deleted]);
      const response = await app.inject({
        method: 'DELETE',
        url: `/tokens/${VALID_TOKEN_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.idToken).toBe('RFID-DELETED');
    });

    it('returns 404 when token not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'DELETE',
        url: `/tokens/${VALID_TOKEN_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('TOKEN_NOT_FOUND');
    });

    it('returns 400 for invalid id param', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/tokens/not-a-nanoid',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(400);
    });
  });
});
