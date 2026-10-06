// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

let dbResults: unknown[][] = [];
let dbCallIndex = 0;
function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}
function makeChain() {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    const r = dbResults[dbCallIndex] ?? [];
    dbCallIndex++;
    return Promise.resolve(r).then(resolve, reject);
  };
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: { select: vi.fn(() => makeChain()) },
  driverTokens: {},
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn(), desc: vi.fn() }));

const { createTokenMock, updateTokenMock } = vi.hoisted(() => ({
  createTokenMock: vi.fn(),
  updateTokenMock: vi.fn(),
}));

vi.mock('../services/token.service.js', () => {
  class DuplicateTokenError extends Error {}
  return { createToken: createTokenMock, updateToken: updateTokenMock, DuplicateTokenError };
});

vi.mock('../routes/tokens.js', () => ({ OCPP_TOKEN_TYPES: ['ISO14443', 'ISO15693', 'Central'] }));

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

describe('Portal token routes, uncovered paths', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = await buildApp();
    auth = { authorization: `Bearer ${app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
  });

  it('POST returns 500 when the token service fails for a reason other than a duplicate', async () => {
    createTokenMock.mockRejectedValueOnce(new Error('db down'));
    const res = await app.inject({
      method: 'POST',
      url: '/portal/tokens',
      headers: auth,
      payload: { idToken: 'CARD-0001' },
    });
    expect(res.statusCode).toBe(500);
    expect(createTokenMock).toHaveBeenCalledWith(
      { driverId: DRIVER_ID, idToken: 'CARD-0001', tokenType: 'ISO14443' },
      { type: 'driver', driverId: DRIVER_ID },
    );
  });

  describe('PATCH /portal/tokens/:id', () => {
    it('returns 404 for an unknown token', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/portal/tokens/${TOKEN_ID}`,
        headers: auth,
        payload: { isActive: false },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('TOKEN_NOT_FOUND');
      expect(updateTokenMock).not.toHaveBeenCalled();
    });

    it('returns 403 for a token owned by another driver', async () => {
      setupDbResults([{ id: TOKEN_ID, driverId: 'drv_000000000002' }]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/portal/tokens/${TOKEN_ID}`,
        headers: auth,
        payload: { isActive: false },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('FORBIDDEN');
      expect(updateTokenMock).not.toHaveBeenCalled();
    });

    it('toggles the active flag through the token service as the driver', async () => {
      setupDbResults([{ id: TOKEN_ID, driverId: DRIVER_ID }]);
      updateTokenMock.mockResolvedValueOnce({
        id: TOKEN_ID,
        driverId: DRIVER_ID,
        idToken: 'CARD-0001',
        tokenType: 'ISO14443',
        isActive: true,
        createdAt: new Date().toISOString(),
      });
      const res = await app.inject({
        method: 'PATCH',
        url: `/portal/tokens/${TOKEN_ID}`,
        headers: auth,
        payload: { isActive: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: TOKEN_ID, isActive: true });
      expect(updateTokenMock).toHaveBeenCalledWith(
        TOKEN_ID,
        { isActive: true },
        { type: 'driver', driverId: DRIVER_ID },
      );
    });
  });

  describe('DELETE /portal/tokens/:id', () => {
    it('returns 404 for an unknown token', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'DELETE',
        url: `/portal/tokens/${TOKEN_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('TOKEN_NOT_FOUND');
    });

    it('returns 403 for a token owned by another driver', async () => {
      setupDbResults([{ id: TOKEN_ID, driverId: 'drv_000000000002' }]);
      const res = await app.inject({
        method: 'DELETE',
        url: `/portal/tokens/${TOKEN_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(403);
      expect(updateTokenMock).not.toHaveBeenCalled();
    });

    it('deactivates the token instead of deleting it', async () => {
      setupDbResults([{ id: TOKEN_ID, driverId: DRIVER_ID }]);
      updateTokenMock.mockResolvedValueOnce({});
      const res = await app.inject({
        method: 'DELETE',
        url: `/portal/tokens/${TOKEN_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(updateTokenMock).toHaveBeenCalledWith(
        TOKEN_ID,
        { isActive: false, revokedReason: 'Removed by driver' },
        { type: 'driver', driverId: DRIVER_ID },
      );
    });
  });
});
