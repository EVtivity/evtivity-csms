// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';

const { permissionRows, fleetEnabled } = vi.hoisted(() => ({
  permissionRows: { rows: [] as Array<{ permission: string }> },
  fleetEnabled: { value: true },
}));

vi.mock('@evtivity/database', () => {
  const chain = {
    from: () => chain,
    where: () => Promise.resolve(permissionRows.rows),
  };
  return {
    db: { select: () => chain },
    userPermissions: { userId: 'user_id' },
    isFleetEnabled: vi.fn(() => Promise.resolve(fleetEnabled.value)),
  };
});

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: vi.fn(() => Promise.resolve()) }),
}));

vi.mock('../lib/fleet-scope.js', async () =>
  (await import('./helpers/fleet-scope-mock.js')).fleetScopeMock(),
);

import {
  authorize,
  clearPermissionCacheLocal,
  getEffectivePermissions,
  requestHasPermission,
  withinFleetUserCeiling,
} from '../middleware/rbac.js';
import { resetFleetScopeMock, setMockUserAccess } from './helpers/fleet-scope-mock.js';

interface FakeReply {
  statusCode: number | null;
  body: unknown;
  notFound: boolean;
  status: (code: number) => FakeReply;
  send: (body: unknown) => Promise<void>;
  callNotFound: () => Promise<void>;
}

function fakeReply(): FakeReply {
  const reply: FakeReply = {
    statusCode: null,
    body: undefined,
    notFound: false,
    status(code) {
      reply.statusCode = code;
      return reply;
    },
    send(body) {
      reply.body = body;
      return Promise.resolve();
    },
    callNotFound() {
      reply.notFound = true;
      return Promise.resolve();
    },
  };
  return reply;
}

function fakeRequest(
  user: Record<string, unknown>,
  fleetScope?: boolean,
  fleetSelfService?: boolean,
): FastifyRequest {
  const config: Record<string, unknown> = {};
  if (fleetScope !== undefined) config['fleetScope'] = fleetScope;
  if (fleetSelfService !== undefined) config['fleetSelfService'] = fleetSelfService;
  return {
    user,
    server: { authenticate: () => Promise.resolve() },
    routeOptions: { config },
  } as unknown as FastifyRequest;
}

async function run(
  guard: ReturnType<typeof authorize>,
  request: FastifyRequest,
): Promise<FakeReply> {
  const reply = fakeReply();
  await guard(request, reply as unknown as FastifyReply);
  return reply;
}

const OPERATOR = 'usr_operator0001';
const FLEET_USER = 'usr_fleetuser001';

describe('fleet user gate in authorize()', () => {
  beforeEach(() => {
    resetFleetScopeMock();
    clearPermissionCacheLocal(OPERATOR);
    clearPermissionCacheLocal(FLEET_USER);
    fleetEnabled.value = true;
    setMockUserAccess(FLEET_USER, { kind: 'fleets', fleetIds: ['flt_aaaaaaaaaaaa'] });
  });

  it('lets an operator through a route that is not open to fleet users', async () => {
    permissionRows.rows = [{ permission: 'stations:read' }];
    const reply = await run(authorize('stations:read'), fakeRequest({ userId: OPERATOR }));
    expect(reply.notFound).toBe(false);
    expect(reply.statusCode).toBeNull();
  });

  it('answers route-not-found to a fleet user on a route without fleetScope, also with the permission', async () => {
    permissionRows.rows = [{ permission: 'fleets:read' }];
    const reply = await run(authorize('fleets:read'), fakeRequest({ userId: FLEET_USER }));
    expect(reply.notFound).toBe(true);
    expect(reply.statusCode).toBeNull();
  });

  it('answers route-not-found to a fleet user on a route without any permission', async () => {
    const reply = await run(authorize(), fakeRequest({ userId: FLEET_USER }));
    expect(reply.notFound).toBe(true);
  });

  it('runs the permission check for a fleet user on a fleetScope route', async () => {
    permissionRows.rows = [{ permission: 'fleets:read' }];
    const passed = await run(authorize('fleets:read'), fakeRequest({ userId: FLEET_USER }, true));
    expect(passed.notFound).toBe(false);
    expect(passed.statusCode).toBeNull();

    const refused = await run(
      authorize('fleetCards:write'),
      fakeRequest({ userId: FLEET_USER }, true),
    );
    expect(refused.notFound).toBe(false);
    expect(refused.statusCode).toBe(403);
  });

  it('answers a fleet user 403 FLEET_DISABLED on every route while the Fleets feature is off', async () => {
    fleetEnabled.value = false;
    permissionRows.rows = [{ permission: 'fleets:read' }];
    for (const fleetScope of [true, false]) {
      const reply = await run(
        authorize('fleets:read'),
        fakeRequest({ userId: FLEET_USER }, fleetScope),
      );
      expect(reply.notFound).toBe(false);
      expect(reply.statusCode).toBe(403);
      expect(reply.body).toEqual({
        error: 'Fleet management is turned off. Contact your operator.',
        code: 'FLEET_DISABLED',
      });
    }
  });

  it('answers a fleet user with no fleet 403 FLEET_USER_NO_FLEETS on the fleet routes', async () => {
    setMockUserAccess(FLEET_USER, { kind: 'fleets', fleetIds: [] });
    permissionRows.rows = [{ permission: 'fleets:read' }, { permission: 'settings.apiKeys:read' }];
    const fleetRoute = await run(
      authorize('fleets:read'),
      fakeRequest({ userId: FLEET_USER }, true),
    );
    expect(fleetRoute.statusCode).toBe(403);
    expect(fleetRoute.body).toEqual({
      error: 'No fleets are assigned to you. Contact your operator.',
      code: 'FLEET_USER_NO_FLEETS',
    });

    // Its own API keys stay open; an operator route stays route-not-found.
    const keys = await run(
      authorize('settings.apiKeys:read'),
      fakeRequest({ userId: FLEET_USER }, true, true),
    );
    expect(keys.statusCode).toBeNull();
    expect(keys.notFound).toBe(false);
    const other = await run(authorize('fleets:read'), fakeRequest({ userId: FLEET_USER }));
    expect(other.notFound).toBe(true);
  });

  it('leaves operators alone while the Fleets feature is off', async () => {
    fleetEnabled.value = false;
    permissionRows.rows = [{ permission: 'stations:read' }];
    const reply = await run(authorize('stations:read'), fakeRequest({ userId: OPERATOR }));
    expect(reply.notFound).toBe(false);
    expect(reply.statusCode).toBeNull();
  });

  it('never gates a token without a user id', async () => {
    const reply = await run(authorize(), fakeRequest({ driverId: 'drv_aaaaaaaaaaaa' }));
    expect(reply.notFound).toBe(false);
  });
});

describe('fleet user gate on a real Fastify route', () => {
  beforeEach(() => {
    resetFleetScopeMock();
    clearPermissionCacheLocal(FLEET_USER);
    fleetEnabled.value = true;
    setMockUserAccess(FLEET_USER, { kind: 'fleets', fleetIds: ['flt_aaaaaaaaaaaa'] });
    permissionRows.rows = [{ permission: 'fleets:read' }];
  });

  it('answers the route-not-found 404 and never runs the handler', async () => {
    const app = Fastify();
    app.decorate('authenticate', async (request: FastifyRequest) => {
      (request as unknown as { user: unknown }).user = { userId: FLEET_USER };
      await Promise.resolve();
    });
    const handler = vi.fn(() => ({ ok: true }));
    app.get('/closed', { onRequest: [authorize('fleets:read')] }, handler);
    app.get(
      '/open',
      { onRequest: [authorize('fleets:read')], config: { fleetScope: true } },
      handler,
    );
    await app.ready();

    const closed = await app.inject({ method: 'GET', url: '/closed' });
    expect(closed.statusCode).toBe(404);
    expect(closed.json()).toMatchObject({ message: 'Route GET:/closed not found' });
    expect(handler).not.toHaveBeenCalled();

    const open = await app.inject({ method: 'GET', url: '/open' });
    expect(open.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe('fleet user permission ceiling', () => {
  beforeEach(() => {
    resetFleetScopeMock();
    clearPermissionCacheLocal(OPERATOR);
    clearPermissionCacheLocal(FLEET_USER);
    setMockUserAccess(FLEET_USER, { kind: 'fleets', fleetIds: [] });
  });

  it('keeps only the fleet user permissions, whatever the stored rows hold', async () => {
    permissionRows.rows = [
      { permission: 'fleets:read' },
      { permission: 'fleets:write' },
      { permission: 'stations:write' },
      { permission: 'fleetCards:write' },
    ];
    const request = fakeRequest({ userId: FLEET_USER }, true);
    expect(await getEffectivePermissions(request)).toEqual(['fleets:read', 'fleetCards:write']);
    expect(await requestHasPermission(request, 'stations:write')).toBe(false);
    expect(await requestHasPermission(request, 'fleets:write')).toBe(false);
    // Write implies read for fleet cards.
    expect(await requestHasPermission(request, 'fleetCards:read')).toBe(true);
  });

  it('narrows an API key of a fleet user to the ceiling', async () => {
    permissionRows.rows = [{ permission: 'fleets:read' }, { permission: 'stations:read' }];
    const request = fakeRequest(
      { userId: FLEET_USER, isApiKey: true, apiKeyPermissions: ['fleets:read', 'stations:read'] },
      true,
    );
    expect(await getEffectivePermissions(request)).toEqual(['fleets:read']);
  });

  it('keeps every stored permission of an operator', async () => {
    permissionRows.rows = [{ permission: 'stations:write' }, { permission: 'fleets:write' }];
    expect(await getEffectivePermissions(fakeRequest({ userId: OPERATOR }))).toEqual([
      'stations:write',
      'fleets:write',
    ]);
  });

  it('withinFleetUserCeiling drops every permission outside the list', () => {
    expect(
      withinFleetUserCeiling(['payments:read', 'payments:write', 'sessions:read', 'users:read']),
    ).toEqual(['payments:read', 'sessions:read']);
  });
});
