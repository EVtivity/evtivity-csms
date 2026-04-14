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
  driverTokens: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { portalTokenRoutes } from '../routes/portal/tokens.js';

const DRIVER_ID = 'drv_000000000001';
const TOKEN_ID = 'dtk_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalTokenRoutes);
  await app.ready();
  return app;
}

describe('Portal token routes', () => {
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

  describe('GET /v1/portal/tokens', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({ method: 'GET', url: '/portal/tokens' });
      expect(response.statusCode).toBe(401);
    });

    it('returns token list', async () => {
      setupDbResults([
        {
          id: TOKEN_ID,
          driverId: DRIVER_ID,
          idToken: 'ABCD1234',
          tokenType: 'ISO14443',
          isActive: true,
          createdAt: new Date(),
        },
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/tokens',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].idToken).toBe('ABCD1234');
    });
  });

  describe('POST /v1/portal/tokens', () => {
    it('creates a token', async () => {
      const newToken = {
        id: TOKEN_ID,
        driverId: DRIVER_ID,
        idToken: 'NEWTOKEN01',
        tokenType: 'ISO14443',
        isActive: true,
        createdAt: new Date(),
      };
      setupDbResults([], [newToken]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/tokens',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { idToken: 'NEWTOKEN01' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().idToken).toBe('NEWTOKEN01');
    });

    it('returns 409 for duplicate token', async () => {
      setupDbResults([{ id: 'dtk_existing00001' }]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/tokens',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { idToken: 'ABCD1234' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('TOKEN_DUPLICATE');
    });

    it('rejects non-alphanumeric token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/tokens',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { idToken: 'AB!@#' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects too-short token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/tokens',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { idToken: 'AB' },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('PATCH /v1/portal/tokens/:id', () => {
    it('returns 404 when token not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'PATCH',
        url: `/portal/tokens/${TOKEN_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { isActive: false },
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns 403 when token belongs to another driver', async () => {
      setupDbResults([{ id: TOKEN_ID, driverId: 'drv_other0000001' }]);
      const response = await app.inject({
        method: 'PATCH',
        url: `/portal/tokens/${TOKEN_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { isActive: false },
      });
      expect(response.statusCode).toBe(403);
    });

    it('toggles token active status', async () => {
      const updatedToken = {
        id: TOKEN_ID,
        driverId: DRIVER_ID,
        idToken: 'ABCD1234',
        tokenType: 'ISO14443',
        isActive: false,
        createdAt: new Date(),
      };
      setupDbResults([{ id: TOKEN_ID, driverId: DRIVER_ID }], [updatedToken]);
      const response = await app.inject({
        method: 'PATCH',
        url: `/portal/tokens/${TOKEN_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { isActive: false },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().isActive).toBe(false);
    });
  });
});
