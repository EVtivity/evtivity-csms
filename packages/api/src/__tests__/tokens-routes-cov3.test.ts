// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { state, svc, selectDistinctMock } = vi.hoisted(() => {
  class DuplicateTokenError extends Error {}
  class TokenDriverNotFoundError extends Error {}
  class TokenDriverInactiveError extends Error {}
  class PncContractTokenError extends Error {}
  class VehicleIdTokenInUseError extends Error {}
  class PrepaidBalanceConflictError extends Error {}
  class PrepaidBalanceExpectedError extends Error {}
  // A plain function (not a mock) so the per-test mockReset keeps it.
  function tokenActorOf(actor: { actorUserId: string | null }) {
    return { type: 'operator', userId: actor.actorUserId };
  }
  return {
    state: { results: [] as unknown[][], index: 0 },
    svc: {
      DuplicateTokenError,
      TokenDriverNotFoundError,
      TokenDriverInactiveError,
      PncContractTokenError,
      VehicleIdTokenInUseError,
      PrepaidBalanceConflictError,
      PrepaidBalanceExpectedError,
      tokenActorOf,
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
    label: null,
    deactivatedBy: null,
    prepaidBalanceCents: null,
    vehicleId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('token routes error mapping (cov3)', () => {
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

  const pnc = (): Error => new svc.PncContractTokenError();
  const inactive = (): Error => new svc.TokenDriverInactiveError();

  it.each([
    [pnc, 409, 'PNC_CONTRACT_TOKEN_LOCKED'],
    [inactive, 409, 'DRIVER_INACTIVE'],
  ] as const)(
    'POST /tokens/bulk-active answers a service refusal (case %#)',
    async (make, status, code) => {
      svc.bulkSetActive.mockRejectedValueOnce(make());
      const res = await app.inject({
        method: 'POST',
        url: '/tokens/bulk-active',
        headers: auth,
        payload: { ids: [TOKEN_ID], isActive: true },
      });
      expect(res.statusCode).toBe(status);
      expect(res.json().code).toBe(code);
      expect(svc.bulkSetActive).toHaveBeenCalledWith(
        [TOKEN_ID],
        true,
        expect.objectContaining({ userId: USER_ID }),
      );
    },
  );

  it('POST /tokens/bulk-active rethrows an unknown error as 500', async () => {
    svc.bulkSetActive.mockRejectedValueOnce(new Error('db down'));
    const res = await app.inject({
      method: 'POST',
      url: '/tokens/bulk-active',
      headers: auth,
      payload: { ids: [TOKEN_ID], isActive: false },
    });
    expect(res.statusCode).toBe(500);
  });

  it.each([
    [() => new svc.PrepaidBalanceConflictError(), 409, 'PREPAID_BALANCE_CONFLICT'],
    [() => new svc.TokenDriverNotFoundError(), 404, 'DRIVER_NOT_FOUND'],
    [inactive, 409, 'DRIVER_INACTIVE'],
    [pnc, 409, 'PNC_CONTRACT_TOKEN_LOCKED'],
    [() => new svc.VehicleIdTokenInUseError(), 409, 'VEHICLE_ID_IN_USE'],
    [() => new svc.DuplicateTokenError(), 409, 'TOKEN_DUPLICATE'],
  ] as const)('POST /tokens maps a service error (case %#)', async (make, status, code) => {
    svc.createToken.mockRejectedValueOnce(make());
    const res = await app.inject({
      method: 'POST',
      url: '/tokens',
      headers: auth,
      payload: { idToken: 'RFID-1', tokenType: 'ISO14443' },
    });
    expect(res.statusCode).toBe(status);
    expect(res.json().code).toBe(code);
  });

  it('POST /tokens rethrows an unknown error as 500', async () => {
    svc.createToken.mockRejectedValueOnce(new Error('db down'));
    const res = await app.inject({
      method: 'POST',
      url: '/tokens',
      headers: auth,
      payload: { idToken: 'RFID-1', tokenType: 'ISO14443' },
    });
    expect(res.statusCode).toBe(500);
  });

  it.each([
    [() => new svc.TokenDriverNotFoundError(), 404, 'DRIVER_NOT_FOUND'],
    [inactive, 409, 'DRIVER_INACTIVE'],
    [pnc, 409, 'PNC_CONTRACT_TOKEN_LOCKED'],
    [() => new svc.PrepaidBalanceExpectedError(), 400, 'VALIDATION_ERROR'],
    [() => new svc.PrepaidBalanceConflictError(), 409, 'PREPAID_BALANCE_CONFLICT'],
    [() => new svc.VehicleIdTokenInUseError(), 409, 'VEHICLE_ID_IN_USE'],
    [() => new svc.DuplicateTokenError(), 409, 'TOKEN_DUPLICATE'],
  ] as const)('PATCH /tokens/:id maps a service error (case %#)', async (make, status, code) => {
    svc.updateToken.mockRejectedValueOnce(make());
    const res = await app.inject({
      method: 'PATCH',
      url: `/tokens/${TOKEN_ID}`,
      headers: auth,
      payload: { label: 'Pool card' },
    });
    expect(res.statusCode).toBe(status);
    expect(res.json().code).toBe(code);
    expect(svc.updateToken).toHaveBeenCalledWith(
      TOKEN_ID,
      expect.objectContaining({ label: 'Pool card' }),
      expect.objectContaining({ userId: USER_ID }),
    );
  });

  it('PATCH /tokens/:id rethrows an unknown error as 500', async () => {
    svc.updateToken.mockRejectedValueOnce(new Error('db down'));
    const res = await app.inject({
      method: 'PATCH',
      url: `/tokens/${TOKEN_ID}`,
      headers: auth,
      payload: { label: 'Pool card' },
    });
    expect(res.statusCode).toBe(500);
  });

  it('DELETE /tokens/:id answers 409 for the eMAID of a Plug and Charge contract', async () => {
    setupDbResults([]);
    svc.deleteToken.mockRejectedValueOnce(pnc());
    const res = await app.inject({ method: 'DELETE', url: `/tokens/${TOKEN_ID}`, headers: auth });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PNC_CONTRACT_TOKEN_LOCKED');
  });

  it('DELETE /tokens/:id rethrows an unknown error as 500', async () => {
    setupDbResults([]);
    svc.deleteToken.mockRejectedValueOnce(new Error('db down'));
    const res = await app.inject({ method: 'DELETE', url: `/tokens/${TOKEN_ID}`, headers: auth });
    expect(res.statusCode).toBe(500);
  });

  it('DELETE /tokens/:id answers 404 and 200 by what the service removed', async () => {
    setupDbResults([], []);
    svc.deleteToken.mockResolvedValueOnce(null).mockResolvedValueOnce(token({ isActive: false }));
    const missing = await app.inject({
      method: 'DELETE',
      url: `/tokens/${TOKEN_ID}`,
      headers: auth,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('TOKEN_NOT_FOUND');
    const removed = await app.inject({
      method: 'DELETE',
      url: `/tokens/${TOKEN_ID}`,
      headers: auth,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ id: TOKEN_ID, isActive: false });
  });
});
