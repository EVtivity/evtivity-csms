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
  class TokenFleetNotFoundError extends Error {}
  class FleetCardNotBillableError extends Error {}
  class FleetCardDriverNotMemberError extends Error {}
  class FleetCardSiteScopeError extends Error {}
  class FleetCardPermissionError extends Error {}
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
      TokenFleetNotFoundError,
      FleetCardNotBillableError,
      FleetCardDriverNotMemberError,
      FleetCardSiteScopeError,
      FleetCardPermissionError,
      anyFleetCard: vi.fn(() => Promise.resolve(false)),
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

const fleetCardsPerm = vi.hoisted(() => ({ granted: true }));

vi.mock('../middleware/rbac.js', () => ({
  requestHasPermission: (_request: unknown, permission: string) =>
    Promise.resolve(permission !== 'fleetCards:write' || fleetCardsPerm.granted),
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
  evses: {},
  connectors: {},
  stationUnits: {},
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
vi.mock('../lib/site-access.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/site-access.js')>()),
  isAllSiteUser: vi.fn(() => Promise.resolve(true)),
}));

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
    fleetId: null,
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
    fleetCardsPerm.granted = true;
    for (const fn of Object.values(svc)) {
      if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
    }
  });

  describe('fleet RFID cards need fleetCards:write', () => {
    const refused = { code: 'INSUFFICIENT_PERMISSIONS' };

    it.each([
      ['a fleet', { fleetId: 'flt_000000000001' }],
      ['a monthly limit', { monthlyLimitCents: 5000 }],
    ])('refuses POST /tokens with %s, before any write', async (_name, extra) => {
      fleetCardsPerm.granted = false;
      const res = await app.inject({
        method: 'POST',
        url: '/tokens',
        headers: auth,
        payload: { idToken: 'RFID-1', tokenType: 'ISO14443', ...extra },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject(refused);
      expect(svc.createToken).not.toHaveBeenCalled();
    });

    it('refuses PATCH, DELETE and bulk-active of a fleet card', async () => {
      fleetCardsPerm.granted = false;
      svc.anyFleetCard.mockResolvedValue(true);
      const requests: { method: 'PATCH' | 'DELETE' | 'POST'; url: string; payload?: object }[] = [
        { method: 'PATCH', url: `/tokens/${TOKEN_ID}`, payload: { label: 'Van 1' } },
        { method: 'DELETE', url: `/tokens/${TOKEN_ID}` },
        {
          method: 'POST',
          url: '/tokens/bulk-active',
          payload: { ids: [TOKEN_ID], isActive: false },
        },
      ];
      for (const request of requests) {
        const res = await app.inject({ ...request, headers: auth });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject(refused);
      }
      expect(svc.updateToken).not.toHaveBeenCalled();
      expect(svc.deleteToken).not.toHaveBeenCalled();
      expect(svc.bulkSetActive).not.toHaveBeenCalled();
    });

    it('refuses giving a card a fleet or a monthly limit through PATCH', async () => {
      fleetCardsPerm.granted = false;
      svc.anyFleetCard.mockResolvedValue(false);
      for (const payload of [{ fleetId: 'flt_000000000001' }, { monthlyLimitCents: 100 }]) {
        const res = await app.inject({
          method: 'PATCH',
          url: `/tokens/${TOKEN_ID}`,
          headers: auth,
          payload,
        });
        expect(res.statusCode).toBe(403);
      }
      expect(svc.updateToken).not.toHaveBeenCalled();
    });

    it('keeps an ordinary edit of a card without a fleet on drivers:write, telling the service', async () => {
      fleetCardsPerm.granted = false;
      svc.anyFleetCard.mockResolvedValue(false);
      svc.updateToken.mockResolvedValue(token({ label: 'Spare' }));
      const res = await app.inject({
        method: 'PATCH',
        url: `/tokens/${TOKEN_ID}`,
        headers: auth,
        payload: { label: 'Spare' },
      });
      expect(res.statusCode).toBe(200);
      expect(svc.updateToken).toHaveBeenCalledWith(
        TOKEN_ID,
        { label: 'Spare' },
        expect.anything(),
        { fleetCardsWrite: false },
      );
    });

    it('maps the token service refusal to 403 INSUFFICIENT_PERMISSIONS', async () => {
      svc.createToken.mockRejectedValueOnce(new svc.FleetCardPermissionError());
      const res = await app.inject({
        method: 'POST',
        url: '/tokens',
        headers: auth,
        payload: { idToken: 'RFID-1', tokenType: 'ISO14443' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject(refused);
    });
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
        { fleetCardsWrite: true },
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
    [() => new svc.TokenFleetNotFoundError(), 404, 'FLEET_NOT_FOUND'],
    [() => new svc.FleetCardNotBillableError(), 409, 'FLEET_CARD_NOT_BILLABLE'],
    [() => new svc.FleetCardDriverNotMemberError(), 400, 'FLEET_CARD_DRIVER_NOT_MEMBER'],
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
    [() => new svc.TokenFleetNotFoundError(), 404, 'FLEET_NOT_FOUND'],
    [() => new svc.FleetCardNotBillableError(), 409, 'FLEET_CARD_NOT_BILLABLE'],
    [() => new svc.FleetCardDriverNotMemberError(), 400, 'FLEET_CARD_DRIVER_NOT_MEMBER'],
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
      { fleetCardsWrite: true },
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
