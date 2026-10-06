// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { state, svc, selectDistinctMock } = vi.hoisted(() => {
  class DuplicateTokenError extends Error {}
  return {
    state: { results: [] as unknown[][], index: 0 },
    svc: {
      DuplicateTokenError,
      listTokens: vi.fn(),
      getToken: vi.fn(),
      createToken: vi.fn(),
      updateToken: vi.fn(),
      deleteToken: vi.fn(),
      bulkSetActive: vi.fn(),
      exportTokensCsv: vi.fn(),
      importTokensCsv: vi.fn(),
    },
    selectDistinctMock: vi.fn(),
  };
});

function setupDbResults(...results: unknown[][]): void {
  state.results = results;
  state.index = 0;
}

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'innerJoin', 'leftJoin']) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const r = state.results[state.index] ?? [];
      state.index++;
      return Promise.resolve(r).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
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
    selectDistinct: selectDistinctMock,
  },
  chargingSessions: { id: 'cs.id', tokenId: 'cs.token_id', status: 'cs.status' },
  chargingStations: {},
  drivers: {},
  sites: {},
  driverTokens: { tokenType: 'dt.token_type' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, value: unknown) => ({ eq: [col, value] })),
  and: vi.fn((...parts: unknown[]) => ({ and: parts })),
  desc: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));

vi.mock('@evtivity/services/company-currency', () => ({ sessionCurrencySql: vi.fn() }));

vi.mock('../services/token.service.js', () => svc);

import { registerAuth } from '../plugins/auth.js';
import { tokenRoutes } from '../routes/tokens.js';

const TOKEN_ID = 'dtk_000000000001';
const USER_ID = 'usr_000000000001';

function token(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TOKEN_ID,
    driverId: null,
    idToken: 'RFID-1',
    tokenType: 'ISO14443',
    isActive: true,
    expiresAt: null,
    revokedAt: null,
    revokedReason: null,
    prepaidBalanceCents: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('token routes (cov2)', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    tokenRoutes(app);
    await app.ready();
    auth = { authorization: `Bearer ${app.jwt.sign({ userId: USER_ID, roleId: 'rol_1' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    for (const fn of Object.values(svc)) {
      if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
    }
  });

  it('GET /tokens/filter-options lists the distinct token types', async () => {
    const chain = {
      from: vi.fn(() => chain),
      orderBy: vi.fn(() => Promise.resolve([{ tokenType: 'Central' }, { tokenType: 'ISO14443' }])),
    };
    selectDistinctMock.mockReturnValueOnce(chain);
    const res = await app.inject({ method: 'GET', url: '/tokens/filter-options', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tokenTypes: ['Central', 'ISO14443'] });
    expect(selectDistinctMock).toHaveBeenCalledWith({ tokenType: 'dt.token_type' });
    expect(chain.orderBy).toHaveBeenCalledWith('dt.token_type');
  });

  it('POST /tokens/bulk-active forwards ids and state with the operator as actor', async () => {
    svc.bulkSetActive.mockResolvedValue({ updated: 2 });
    const res = await app.inject({
      method: 'POST',
      url: '/tokens/bulk-active',
      headers: auth,
      payload: { ids: [TOKEN_ID, 'dtk_000000000002'], isActive: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updated: 2 });
    expect(svc.bulkSetActive).toHaveBeenCalledWith([TOKEN_ID, 'dtk_000000000002'], false, {
      type: 'operator',
      userId: USER_ID,
    });
  });

  it('POST /tokens/bulk-active refuses an empty id list', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tokens/bulk-active',
      headers: auth,
      payload: { ids: [], isActive: true },
    });
    expect(res.statusCode).toBe(400);
    expect(svc.bulkSetActive).not.toHaveBeenCalled();
  });

  it('POST /tokens rethrows unexpected service errors as 500', async () => {
    svc.createToken.mockRejectedValue(new Error('db down'));
    const res = await app.inject({
      method: 'POST',
      url: '/tokens',
      headers: auth,
      payload: { idToken: 'RFID-1', tokenType: 'ISO14443' },
    });
    expect(res.statusCode).toBe(500);
  });

  describe('PATCH /tokens/:id', () => {
    it('answers 409 TOKEN_DUPLICATE when the new idToken is taken', async () => {
      svc.updateToken.mockRejectedValue(new svc.DuplicateTokenError('dup'));
      const res = await app.inject({
        method: 'PATCH',
        url: `/tokens/${TOKEN_ID}`,
        headers: auth,
        payload: { idToken: 'RFID-2' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'Token already registered', code: 'TOKEN_DUPLICATE' });
      expect(svc.updateToken).toHaveBeenCalledWith(
        TOKEN_ID,
        { idToken: 'RFID-2' },
        { type: 'operator', userId: USER_ID },
      );
    });

    it('rethrows unexpected service errors as 500', async () => {
      svc.updateToken.mockRejectedValue(new Error('db down'));
      const res = await app.inject({
        method: 'PATCH',
        url: `/tokens/${TOKEN_ID}`,
        headers: auth,
        payload: { isActive: false },
      });
      expect(res.statusCode).toBe(500);
    });
  });

  describe('DELETE /tokens/:id', () => {
    it('refuses to delete a token in use by an active session', async () => {
      setupDbResults([{ id: 'ses_active' }]);
      const res = await app.inject({ method: 'DELETE', url: `/tokens/${TOKEN_ID}`, headers: auth });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'Token is currently in use by an active charging session',
        code: 'TOKEN_IN_USE',
      });
      expect(svc.deleteToken).not.toHaveBeenCalled();
    });

    it('answers 404 when the token does not exist', async () => {
      setupDbResults([]);
      svc.deleteToken.mockResolvedValue(null);
      const res = await app.inject({ method: 'DELETE', url: `/tokens/${TOKEN_ID}`, headers: auth });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Token not found', code: 'TOKEN_NOT_FOUND' });
    });

    it('deletes an idle token and returns it', async () => {
      setupDbResults([]);
      svc.deleteToken.mockResolvedValue(token());
      const res = await app.inject({ method: 'DELETE', url: `/tokens/${TOKEN_ID}`, headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: TOKEN_ID, idToken: 'RFID-1' });
      expect(svc.deleteToken).toHaveBeenCalledWith(TOKEN_ID, { type: 'operator', userId: USER_ID });
    });
  });
});
