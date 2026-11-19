// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { state, svc } = vi.hoisted(() => {
  class DuplicateTokenError extends Error {}
  class TokenDriverNotFoundError extends Error {}
  class TokenDriverInactiveError extends Error {}
  class PncContractTokenError extends Error {}
  class VehicleIdTokenInUseError extends Error {}
  class VehicleShapedCardError extends Error {}
  class FleetCardTypeNotAllowedError extends Error {}
  class TokenReactivationBlockedError extends Error {}
  class FleetCardDeactivatedError extends Error {}
  class TokenFleetNotFoundError extends Error {}
  class FleetCardDriverNotMemberError extends Error {}
  class FleetCardSiteScopeError extends Error {}
  class FleetCardNotBillableError extends Error {}
  function tokenActorOf(actor: { actorUserId: string | null }) {
    return { type: 'operator', userId: actor.actorUserId };
  }
  return {
    state: { results: [] as unknown[][], index: 0, allSites: true, paymentsRead: true },
    svc: {
      DuplicateTokenError,
      TokenDriverNotFoundError,
      TokenDriverInactiveError,
      PncContractTokenError,
      VehicleIdTokenInUseError,
      VehicleShapedCardError,
      FleetCardTypeNotAllowedError,
      TokenReactivationBlockedError,
      FleetCardDeactivatedError,
      TokenFleetNotFoundError,
      FleetCardDriverNotMemberError,
      FleetCardSiteScopeError,
      FleetCardNotBillableError,
      tokenActorOf,
      createToken: vi.fn(),
      updateToken: vi.fn(),
    },
  };
});

function setupDbResults(...results: unknown[][]): void {
  state.results = results;
  state.index = 0;
}

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'offset', 'leftJoin']) {
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
  requestHasPermission: (_request: unknown, permission: string) =>
    Promise.resolve(permission !== 'payments:read' || state.paymentsRead),
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
  db: { select: vi.fn(() => makeChain()) },
  client: {},
  cardsMonthSpend: (...args: unknown[]) =>
    (spend.cardsMonthSpend as (...a: unknown[]) => Promise<Map<string, number>>)(...args),
  driverTokens: {},
  drivers: {},
  fleets: {},
  chargingSessions: {},
  userFleetAssignments: {},
  users: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));

vi.mock('../services/token.service.js', () => svc);
vi.mock('../lib/site-access.js', () => ({
  isAllSiteUser: vi.fn(() => Promise.resolve(state.allSites)),
  getUserSiteIds: vi.fn(() => Promise.resolve(state.allSites ? null : ['sit_000000000001'])),
}));
const history = vi.hoisted(() => ({ readFleetCardHistory: vi.fn() }));
const spend = vi.hoisted(() => ({
  cardsMonthSpend: vi.fn((): Promise<Map<string, number>> => Promise.resolve(new Map())),
}));
vi.mock('../lib/fleet-card-history.js', () => history);
vi.mock('../lib/fleet-scope.js', async () =>
  (await import('./helpers/fleet-scope-mock.js')).fleetScopeMock(),
);

import { registerAuth } from '../plugins/auth.js';
import { fleetCardRoutes } from '../routes/fleet-cards.js';
import { resetFleetScopeMock, setMockUserAccess } from './helpers/fleet-scope-mock.js';

const USER_ID = 'usr_000000000001';
const FLEET_ID = 'flt_000000000001';
const OTHER_FLEET = 'flt_000000000002';
const TOKEN_ID = 'dtk_000000000001';

function cardRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TOKEN_ID,
    idToken: 'CARD-1',
    tokenType: 'ISO14443',
    label: 'Van 12',
    isActive: true,
    revokedAt: null,
    deactivatedBy: null,
    driverId: null,
    driverFirstName: null,
    driverLastName: null,
    monthlyLimitCents: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

let app: FastifyInstance;
let auth: Record<string, string>;
const registered: Array<{ method: string; url: string; fleetScope: unknown }> = [];

beforeAll(async () => {
  app = Fastify();
  await registerAuth(app);
  app.addHook('onRoute', (route) => {
    const config = route.config as { fleetScope?: unknown } | undefined;
    registered.push({
      method: String(route.method),
      url: route.url,
      fleetScope: config?.fleetScope,
    });
  });
  fleetCardRoutes(app);
  await app.ready();
  auth = { authorization: `Bearer ${app.jwt.sign({ userId: USER_ID, roleId: 'rol_1' })}` };
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  setupDbResults();
  state.allSites = true;
  state.paymentsRead = true;
  resetFleetScopeMock();
  svc.createToken.mockReset();
  svc.updateToken.mockReset();
  history.readFleetCardHistory.mockReset();
});

describe('fleet card history', () => {
  it('reads the history of a card of the fleet for a fleet user, with its scope', async () => {
    setMockUserAccess(USER_ID, { kind: 'fleets', fleetIds: [FLEET_ID] });
    setupDbResults([{ id: FLEET_ID }], [cardRow()]);
    history.readFleetCardHistory.mockResolvedValue({
      data: [
        {
          id: 5,
          createdAt: '2026-11-17T10:00:00.000Z',
          changes: ['given'],
          reason: null,
          memberBefore: null,
          memberAfter: { id: 'drv_000000000001', name: 'Ana Lee', erased: false },
          labelBefore: 'Van 1',
          labelAfter: 'Van 1',
          actor: { kind: 'operator', name: null, viaApiKey: false },
        },
      ],
      total: 1,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/fleets/${FLEET_ID}/cards/${TOKEN_ID}/history?page=2&limit=5`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 1, data: [{ id: 5, changes: ['given'] }] });
    expect(history.readFleetCardHistory).toHaveBeenCalledWith(
      TOKEN_ID,
      FLEET_ID,
      { userId: USER_ID, fleetUser: true, siteIds: [] },
      2,
      5,
    );
  });

  it('passes the site scope of an operator', async () => {
    state.allSites = false;
    setupDbResults([{ id: FLEET_ID }], [cardRow()]);
    history.readFleetCardHistory.mockResolvedValue({ data: [], total: 0 });
    const res = await app.inject({
      method: 'GET',
      url: `/fleets/${FLEET_ID}/cards/${TOKEN_ID}/history`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(history.readFleetCardHistory).toHaveBeenCalledWith(
      TOKEN_ID,
      FLEET_ID,
      { userId: USER_ID, fleetUser: false, siteIds: ['sit_000000000001'] },
      1,
      10,
    );
  });

  it('answers 404 TOKEN_NOT_FOUND for a card the fleet does not own', async () => {
    setupDbResults([{ id: FLEET_ID }], []);
    const res = await app.inject({
      method: 'GET',
      url: `/fleets/${FLEET_ID}/cards/${TOKEN_ID}/history`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('TOKEN_NOT_FOUND');
    expect(history.readFleetCardHistory).not.toHaveBeenCalled();
  });

  it('answers a fleet user 404 FLEET_NOT_FOUND for another fleet, before any read', async () => {
    setMockUserAccess(USER_ID, { kind: 'fleets', fleetIds: [OTHER_FLEET] });
    const res = await app.inject({
      method: 'GET',
      url: `/fleets/${FLEET_ID}/cards/${TOKEN_ID}/history`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('FLEET_NOT_FOUND');
    expect(state.index).toBe(0);
    expect(history.readFleetCardHistory).not.toHaveBeenCalled();
  });
});

describe('fleet card routes', () => {
  it('lists the cards of the fleet with the member and a status', async () => {
    setupDbResults(
      [{ id: FLEET_ID }],
      [
        cardRow(),
        cardRow({
          id: 'dtk_000000000002',
          isActive: false,
          deactivatedBy: 'operator',
          revokedAt: '2026-02-01T00:00:00.000Z',
          driverId: 'drv_000000000001',
          driverFirstName: 'Ana',
          driverLastName: 'Lee',
        }),
        cardRow({ id: 'dtk_000000000003', isActive: false, deactivatedBy: 'system' }),
      ],
      [{ count: 3 }],
    );
    const res = await app.inject({
      method: 'GET',
      url: `/fleets/${FLEET_ID}/cards`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.data[0]).toMatchObject({
      status: 'active',
      blockedByOperator: false,
      driver: null,
    });
    expect(body.data[1]).toMatchObject({
      status: 'deactivated',
      blockedByOperator: true,
      driver: { id: 'drv_000000000001', firstName: 'Ana', lastName: 'Lee' },
    });
    expect(body.data[2]).toMatchObject({ status: 'suspended', blockedByOperator: false });
  });

  it('answers 404 FLEET_NOT_FOUND for an unknown fleet', async () => {
    setupDbResults([]);
    const res = await app.inject({
      method: 'GET',
      url: `/fleets/${FLEET_ID}/cards`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('FLEET_NOT_FOUND');
  });

  it('answers a fleet user 404 for a fleet not assigned to it, before any read', async () => {
    setMockUserAccess(USER_ID, { kind: 'fleets', fleetIds: [OTHER_FLEET] });
    const res = await app.inject({
      method: 'GET',
      url: `/fleets/${FLEET_ID}/cards`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('FLEET_NOT_FOUND');
    expect(state.index).toBe(0);
  });

  it('adds a card in the fleet scope of a fleet user', async () => {
    setMockUserAccess(USER_ID, { kind: 'fleets', fleetIds: [FLEET_ID] });
    setupDbResults([{ id: FLEET_ID }], [cardRow()]);
    svc.createToken.mockResolvedValue({ id: TOKEN_ID });
    const res = await app.inject({
      method: 'POST',
      url: `/fleets/${FLEET_ID}/cards`,
      headers: auth,
      payload: { idToken: 'CARD-1', label: 'Van 12' },
    });
    expect(res.statusCode).toBe(201);
    expect(svc.createToken).toHaveBeenCalledWith(
      { idToken: 'CARD-1', tokenType: 'ISO14443', label: 'Van 12', driverId: null },
      { type: 'operator', userId: USER_ID },
      { fleet: { fleetId: FLEET_ID, byFleetUser: true } },
    );
  });

  it('lists this month next to the limit of each card', async () => {
    spend.cardsMonthSpend.mockResolvedValueOnce(new Map([[TOKEN_ID, 2_500]]));
    setupDbResults([{ id: FLEET_ID }], [cardRow({ monthlyLimitCents: 10_000 })], [{ count: 1 }]);
    const res = await app.inject({
      method: 'GET',
      url: `/fleets/${FLEET_ID}/cards`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0]).toMatchObject({ monthlyLimitCents: 10_000, monthSpentCents: 2_500 });
    expect(spend.cardsMonthSpend).toHaveBeenCalledWith({}, [TOKEN_ID]);
  });

  it('leaves this month out without payments:read and for a site-restricted operator', async () => {
    state.paymentsRead = false;
    setupDbResults([{ id: FLEET_ID }], [cardRow({ monthlyLimitCents: 10_000 })], [{ count: 1 }]);
    let res = await app.inject({ method: 'GET', url: `/fleets/${FLEET_ID}/cards`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0]).toMatchObject({ monthlyLimitCents: 10_000, monthSpentCents: null });
    state.paymentsRead = true;
    state.allSites = false;
    setupDbResults([{ id: FLEET_ID }], [cardRow({})], [{ count: 1 }]);
    res = await app.inject({ method: 'GET', url: `/fleets/${FLEET_ID}/cards`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0]).toMatchObject({ monthSpentCents: null });
    expect(spend.cardsMonthSpend).not.toHaveBeenCalled();
  });

  it('passes a monthly limit to the token service and refuses one out of range', async () => {
    setMockUserAccess(USER_ID, { kind: 'fleets', fleetIds: [FLEET_ID] });
    setupDbResults([{ id: FLEET_ID }], [cardRow({ monthlyLimitCents: 5_000 })]);
    svc.updateToken.mockResolvedValue({ id: TOKEN_ID });
    const res = await app.inject({
      method: 'PATCH',
      url: `/fleets/${FLEET_ID}/cards/${TOKEN_ID}`,
      headers: auth,
      payload: { monthlyLimitCents: 5_000 },
    });
    expect(res.statusCode).toBe(200);
    expect(svc.updateToken).toHaveBeenCalledWith(
      TOKEN_ID,
      { monthlyLimitCents: 5_000 },
      { type: 'operator', userId: USER_ID },
      { fleet: { fleetId: FLEET_ID, byFleetUser: true } },
    );
    const refused = await app.inject({
      method: 'PATCH',
      url: `/fleets/${FLEET_ID}/cards/${TOKEN_ID}`,
      headers: auth,
      payload: { monthlyLimitCents: 0 },
    });
    expect(refused.statusCode).toBe(400);
  });

  it('refuses a card type drivers cannot register', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/fleets/${FLEET_ID}/cards`,
      headers: auth,
      payload: { idToken: 'CARD-1', tokenType: 'Central' },
    });
    expect(res.statusCode).toBe(400);
  });

  it.each([
    [() => new svc.FleetCardDriverNotMemberError(), 400, 'FLEET_CARD_DRIVER_NOT_MEMBER'],
    // Unknown and inactive drivers answer as not a member: nothing leaks.
    [() => new svc.TokenDriverNotFoundError(), 400, 'FLEET_CARD_DRIVER_NOT_MEMBER'],
    [() => new svc.TokenDriverInactiveError(), 400, 'FLEET_CARD_DRIVER_NOT_MEMBER'],
    [() => new svc.VehicleShapedCardError(), 400, 'VALIDATION_ERROR'],
    [() => new svc.DuplicateTokenError(), 409, 'TOKEN_DUPLICATE'],
    [() => new svc.VehicleIdTokenInUseError(), 409, 'VEHICLE_ID_IN_USE'],
    [() => new svc.TokenReactivationBlockedError(), 403, 'TOKEN_BLOCKED_BY_OPERATOR'],
    [() => new svc.FleetCardDeactivatedError(), 409, 'FLEET_CARD_DEACTIVATED'],
    [() => new svc.TokenFleetNotFoundError(), 404, 'FLEET_NOT_FOUND'],
    [() => new svc.FleetCardNotBillableError(), 409, 'FLEET_CARD_NOT_BILLABLE'],
  ] as const)('maps a refused card write (case %#)', async (make, status, code) => {
    setupDbResults([{ id: FLEET_ID }]);
    svc.createToken.mockRejectedValueOnce(make());
    const res = await app.inject({
      method: 'POST',
      url: `/fleets/${FLEET_ID}/cards`,
      headers: auth,
      payload: { idToken: 'CARD-1', driverId: 'drv_000000000001' },
    });
    expect(res.statusCode).toBe(status);
    expect(res.json().code).toBe(code);
  });

  it.each([
    () => new svc.DuplicateTokenError(),
    () => new svc.VehicleIdTokenInUseError(),
    () => new svc.VehicleShapedCardError(),
  ])(
    'answers a fleet user one refusal for a value it may not add, never that it exists (case %#)',
    async (make) => {
      setMockUserAccess(USER_ID, { kind: 'fleets', fleetIds: [FLEET_ID] });
      setupDbResults([{ id: FLEET_ID }]);
      svc.createToken.mockRejectedValueOnce(make());
      const res = await app.inject({
        method: 'POST',
        url: `/fleets/${FLEET_ID}/cards`,
        headers: auth,
        payload: { idToken: 'CARD-1' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'This RFID card value cannot be added',
        code: 'VALIDATION_ERROR',
        details: { field: 'idToken' },
      });
    },
  );

  it('answers a card type a fleet user is not offered with 400 on the tokenType field', async () => {
    setupDbResults([{ id: FLEET_ID }]);
    svc.createToken.mockRejectedValueOnce(new svc.FleetCardTypeNotAllowedError());
    const res = await app.inject({
      method: 'POST',
      url: `/fleets/${FLEET_ID}/cards`,
      headers: auth,
      payload: { idToken: 'CARD-1', tokenType: 'KeyCode' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR', details: { field: 'tokenType' } });
  });

  it('changes the label, status and member only, through the fleet scope', async () => {
    setupDbResults([{ id: FLEET_ID }], [cardRow({ driverId: 'drv_000000000001' })]);
    svc.updateToken.mockResolvedValue({ id: TOKEN_ID });
    const res = await app.inject({
      method: 'PATCH',
      url: `/fleets/${FLEET_ID}/cards/${TOKEN_ID}`,
      headers: auth,
      payload: { driverId: 'drv_000000000001', isActive: true },
    });
    expect(res.statusCode).toBe(200);
    expect(svc.updateToken).toHaveBeenCalledWith(
      TOKEN_ID,
      { isActive: true, driverId: 'drv_000000000001' },
      { type: 'operator', userId: USER_ID },
      { fleet: { fleetId: FLEET_ID, byFleetUser: false } },
    );
  });

  it('answers 400 for an empty change and 404 for a card of another fleet', async () => {
    let res = await app.inject({
      method: 'PATCH',
      url: `/fleets/${FLEET_ID}/cards/${TOKEN_ID}`,
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');

    setupDbResults([{ id: FLEET_ID }]);
    svc.updateToken.mockResolvedValue(null);
    res = await app.inject({
      method: 'PATCH',
      url: `/fleets/${FLEET_ID}/cards/${TOKEN_ID}`,
      headers: auth,
      payload: { label: 'X' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('TOKEN_NOT_FOUND');
  });

  it('answers 409 FLEET_CARD_DEACTIVATED for turning on a deactivated card', async () => {
    setupDbResults([{ id: FLEET_ID }]);
    svc.updateToken.mockRejectedValueOnce(new svc.FleetCardDeactivatedError());
    const res = await app.inject({
      method: 'PATCH',
      url: `/fleets/${FLEET_ID}/cards/${TOKEN_ID}`,
      headers: auth,
      payload: { isActive: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('FLEET_CARD_DEACTIVATED');
  });

  it('lets an operator deactivate a card for good, recording who did it', async () => {
    setupDbResults(
      [{ id: FLEET_ID }],
      [cardRow()],
      [
        cardRow({
          isActive: false,
          revokedAt: '2026-02-01T00:00:00.000Z',
          deactivatedBy: 'operator',
        }),
      ],
    );
    svc.updateToken.mockResolvedValue({ id: TOKEN_ID });
    const res = await app.inject({
      method: 'DELETE',
      url: `/fleets/${FLEET_ID}/cards/${TOKEN_ID}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'deactivated', blockedByOperator: true });
    expect(svc.updateToken).toHaveBeenCalledWith(
      TOKEN_ID,
      { isActive: false, revokedReason: 'Deactivated by an operator' },
      { type: 'operator', userId: USER_ID },
      { fleet: { fleetId: FLEET_ID, byFleetUser: false, revoke: true } },
    );
  });

  it('refuses a fleet user the deactivation for good, after the fleet and card checks', async () => {
    setMockUserAccess(USER_ID, { kind: 'fleets', fleetIds: [FLEET_ID] });
    setupDbResults([{ id: FLEET_ID }], [cardRow()]);
    let res = await app.inject({
      method: 'DELETE',
      url: `/fleets/${FLEET_ID}/cards/${TOKEN_ID}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
    expect(svc.updateToken).not.toHaveBeenCalled();

    // A card of another fleet still answers 404, so the refusal tells nothing about it.
    setupDbResults([{ id: FLEET_ID }], []);
    res = await app.inject({
      method: 'DELETE',
      url: `/fleets/${FLEET_ID}/cards/${TOKEN_ID}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('TOKEN_NOT_FOUND');
  });

  it('answers a deactivated card unchanged and an unknown card 404', async () => {
    setupDbResults(
      [{ id: FLEET_ID }],
      [cardRow({ isActive: false, revokedAt: '2026-02-01T00:00:00.000Z' })],
    );
    let res = await app.inject({
      method: 'DELETE',
      url: `/fleets/${FLEET_ID}/cards/${TOKEN_ID}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(svc.updateToken).not.toHaveBeenCalled();

    setupDbResults([{ id: FLEET_ID }], []);
    res = await app.inject({
      method: 'DELETE',
      url: `/fleets/${FLEET_ID}/cards/${TOKEN_ID}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('TOKEN_NOT_FOUND');
  });

  it('refuses every card write of a site-restricted operator with 404, before any read', async () => {
    state.allSites = false;
    const writes = [
      { method: 'POST' as const, url: `/fleets/${FLEET_ID}/cards`, payload: { idToken: 'CARD-9' } },
      {
        method: 'PATCH' as const,
        url: `/fleets/${FLEET_ID}/cards/${TOKEN_ID}`,
        payload: { label: 'Van 9' },
      },
      { method: 'DELETE' as const, url: `/fleets/${FLEET_ID}/cards/${TOKEN_ID}` },
    ];
    for (const write of writes) {
      setupDbResults([{ id: FLEET_ID }], [cardRow()]);
      const res = await app.inject({ ...write, headers: auth });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('FLEET_NOT_FOUND');
      expect(state.index).toBe(0);
    }
    expect(svc.createToken).not.toHaveBeenCalled();
    expect(svc.updateToken).not.toHaveBeenCalled();
  });

  it('keeps the card list open to a site-restricted operator', async () => {
    state.allSites = false;
    setupDbResults([{ id: FLEET_ID }], [cardRow()], [{ count: 1 }]);
    const res = await app.inject({
      method: 'GET',
      url: `/fleets/${FLEET_ID}/cards`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
  });

  it("lets a site-restricted fleet user's own fleet card writes through", async () => {
    state.allSites = false;
    setMockUserAccess(USER_ID, { kind: 'fleets', fleetIds: [FLEET_ID] });
    setupDbResults([{ id: FLEET_ID }], [cardRow()]);
    svc.updateToken.mockResolvedValue({ id: TOKEN_ID });
    const res = await app.inject({
      method: 'PATCH',
      url: `/fleets/${FLEET_ID}/cards/${TOKEN_ID}`,
      headers: auth,
      payload: { label: 'Van 9' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('maps the token service refusal of a site-restricted write to 404', async () => {
    setupDbResults([{ id: FLEET_ID }]);
    svc.createToken.mockRejectedValue(new svc.FleetCardSiteScopeError());
    const res = await app.inject({
      method: 'POST',
      url: `/fleets/${FLEET_ID}/cards`,
      headers: auth,
      payload: { idToken: 'CARD-9' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('FLEET_NOT_FOUND');
  });

  it('opens every card route to fleet users (fleetScope)', () => {
    const cardRoutes = registered.filter((r) => r.url.startsWith('/fleets/:id/cards'));
    expect(cardRoutes.map((r) => `${r.method} ${r.url}`).sort()).toEqual([
      'DELETE /fleets/:id/cards/:tokenId',
      'GET /fleets/:id/cards',
      'GET /fleets/:id/cards/:tokenId/history',
      'HEAD /fleets/:id/cards',
      'HEAD /fleets/:id/cards/:tokenId/history',
      'PATCH /fleets/:id/cards/:tokenId',
      'POST /fleets/:id/cards',
      'POST /fleets/:id/cards/import',
    ]);
    expect(cardRoutes.every((r) => r.fleetScope === true)).toBe(true);
  });
});
