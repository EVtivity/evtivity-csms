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

vi.mock('drizzle-orm', () => ({ eq: vi.fn(), desc: vi.fn(), and: vi.fn() }));

const { createTokenMock, updateTokenMock } = vi.hoisted(() => ({
  createTokenMock: vi.fn(),
  updateTokenMock: vi.fn(),
}));

const { DuplicateTokenError, TokenReactivationBlockedError, PncContractTokenError } = vi.hoisted(
  () => ({
    DuplicateTokenError: class DuplicateTokenError extends Error {},
    TokenReactivationBlockedError: class TokenReactivationBlockedError extends Error {},
    PncContractTokenError: class PncContractTokenError extends Error {},
  }),
);

vi.mock('../services/token.service.js', () => ({
  createToken: createTokenMock,
  updateToken: updateTokenMock,
  DuplicateTokenError,
  TokenReactivationBlockedError,
  PncContractTokenError,
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
    createTokenMock.mockReset();
    updateTokenMock.mockReset();
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

  function ownToken(over: Record<string, unknown> = {}) {
    return {
      id: TOKEN_ID,
      driverId: DRIVER_ID,
      idToken: 'CARD-0001',
      tokenType: 'ISO14443',
      isActive: true,
      expiresAt: null,
      deactivatedBy: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      ...over,
    };
  }

  it('GET marks a card the operator deactivated as blocked, not one the driver removed', async () => {
    setupDbResults([
      ownToken({ isActive: false, deactivatedBy: 'operator' }),
      ownToken({ id: 'dtk_000000000002', isActive: false, deactivatedBy: 'driver' }),
      ownToken({ id: 'dtk_000000000003' }),
    ]);
    const res = await app.inject({ method: 'GET', url: '/portal/tokens', headers: auth });
    expect(res.statusCode).toBe(200);
    const rows: Array<Record<string, unknown>> = res.json();
    expect(rows.map((r) => r['blockedByOperator'])).toEqual([true, false, false]);
    // Who deactivated it is not part of the driver response.
    expect(rows[0]).not.toHaveProperty('deactivatedBy');
  });

  it('POST answers 403 TOKEN_BLOCKED_BY_OPERATOR when re-adding a card the operator blocked', async () => {
    createTokenMock.mockRejectedValueOnce(new TokenReactivationBlockedError());
    const res = await app.inject({
      method: 'POST',
      url: '/portal/tokens',
      headers: auth,
      payload: { idToken: 'CARD-0001' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('TOKEN_BLOCKED_BY_OPERATOR');
  });

  describe('PATCH /portal/tokens/:id', () => {
    it('returns 404 for an unknown token or one owned by another driver', async () => {
      // The lookup filters by the signed-in driver, so another driver's
      // token is not found either.
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

    it('changes nothing when the card is already in the requested state', async () => {
      setupDbResults([ownToken()]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/portal/tokens/${TOKEN_ID}`,
        headers: auth,
        payload: { isActive: true },
      });
      expect(res.statusCode).toBe(200);
      expect(updateTokenMock).not.toHaveBeenCalled();
    });

    it('toggles the active flag through the token service as the driver', async () => {
      setupDbResults(
        [ownToken({ isActive: false, deactivatedBy: 'driver' })],
        [ownToken({ isActive: true })],
      );
      updateTokenMock.mockResolvedValueOnce({});
      const res = await app.inject({
        method: 'PATCH',
        url: `/portal/tokens/${TOKEN_ID}`,
        headers: auth,
        payload: { isActive: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: TOKEN_ID, isActive: true, blockedByOperator: false });
      expect(updateTokenMock).toHaveBeenCalledWith(
        TOKEN_ID,
        { isActive: true },
        { type: 'driver', driverId: DRIVER_ID },
      );
    });

    it('answers 403 TOKEN_BLOCKED_BY_OPERATOR when the operator deactivated the card', async () => {
      setupDbResults([ownToken({ isActive: false, deactivatedBy: 'operator' })]);
      updateTokenMock.mockRejectedValueOnce(new TokenReactivationBlockedError());
      const res = await app.inject({
        method: 'PATCH',
        url: `/portal/tokens/${TOKEN_ID}`,
        headers: auth,
        payload: { isActive: true },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('TOKEN_BLOCKED_BY_OPERATOR');
    });
  });

  describe('DELETE /portal/tokens/:id', () => {
    it('returns 404 for an unknown token or one owned by another driver', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'DELETE',
        url: `/portal/tokens/${TOKEN_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('TOKEN_NOT_FOUND');
      expect(updateTokenMock).not.toHaveBeenCalled();
    });

    it('leaves an inactive card as it is, keeping the operator reason', async () => {
      setupDbResults([ownToken({ isActive: false, deactivatedBy: 'operator' })]);
      const res = await app.inject({
        method: 'DELETE',
        url: `/portal/tokens/${TOKEN_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(updateTokenMock).not.toHaveBeenCalled();
    });

    it('deactivates the token instead of deleting it', async () => {
      setupDbResults([ownToken()]);
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
