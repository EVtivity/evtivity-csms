// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

type Reader =
  | { kind: 'sites'; siteIds: string[] | null }
  | { kind: 'fleets'; fleetIds: string[]; paymentsRead: boolean };

interface RouteState {
  reader: Reader;
  permissions: Set<string>;
  knownFleets: Set<string>;
  lookedUp: string;
}

const state = vi.hoisted(
  (): RouteState => ({
    reader: { kind: 'sites', siteIds: null },
    permissions: new Set<string>(['fleets:read', 'payments:read']),
    knownFleets: new Set<string>(['flt_000000000001', 'flt_000000000002']),
    lookedUp: '',
  }),
);
const summary = vi.hoisted(() => vi.fn());

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
        await reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }
    },
  requestHasPermission: vi.fn((_r: unknown, p: string) =>
    Promise.resolve(state.permissions.has(p)),
  ),
}));
vi.mock('../lib/fleet-reader.js', () => ({
  fleetReaderOf: vi.fn(() => Promise.resolve(state.reader)),
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_c: unknown, v: string) => {
    state.lookedUp = v;
    return v;
  }),
}));
vi.mock('@evtivity/database', () => ({
  fleets: { id: 'fleets.id' },
  getSystemTimezone: vi.fn(() => Promise.resolve('UTC')),
  getCompanyCurrency: vi.fn(() => Promise.resolve('USD')),
  db: {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve(state.knownFleets.has(state.lookedUp) ? [{ id: state.lookedUp }] : []),
      }),
    }),
  },
}));
const sessions = vi.hoisted(() => vi.fn());
vi.mock('../services/fleet-dashboard.service.js', () => ({
  getFleetDashboardSummary: summary,
  listFleetDashboardSessions: sessions,
}));
vi.mock('../lib/session-charging-point.js', () => ({ sessionChargingPointShape: {} }));

import { registerAuth } from '../plugins/auth.js';
import { fleetDashboardRoutes } from '../routes/fleet-dashboard.js';

const FLEET = 'flt_000000000001';
const OTHER = 'flt_000000000002';

describe('GET /fleets/metrics-summary', () => {
  let app: FastifyInstance;
  let auth: Record<string, string>;
  const routes: Array<{ url: string; fleetScope: unknown }> = [];

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    app.addHook('onRoute', (route) => {
      routes.push({
        url: route.url,
        fleetScope: (route.config as { fleetScope?: unknown } | undefined)?.fleetScope,
      });
    });
    fleetDashboardRoutes(app);
    await app.ready();
    auth = { authorization: `Bearer ${app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    state.reader = { kind: 'sites', siteIds: null };
    state.permissions = new Set(['fleets:read', 'payments:read']);
    summary.mockReset();
    summary.mockResolvedValue({ sessionCount: 1, energyWh: 2, history: [] });
  });

  it('is open to fleet users', () => {
    expect(routes.find((r) => r.url === '/fleets/metrics-summary')?.fleetScope).toBe(true);
  });

  it('answers a fleet user 404 for a fleet it is not assigned, before any read', async () => {
    state.reader = { kind: 'fleets', fleetIds: [FLEET], paymentsRead: true };
    const res = await app.inject({
      method: 'GET',
      url: `/fleets/metrics-summary?fleetId=${OTHER}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('FLEET_NOT_FOUND');
    expect(summary).not.toHaveBeenCalled();
  });

  it('answers a fleet user an unknown fleet id exactly like another fleet, with no lookup', async () => {
    state.reader = { kind: 'fleets', fleetIds: [FLEET], paymentsRead: true };
    state.lookedUp = '';
    const other = await app.inject({
      method: 'GET',
      url: `/fleets/metrics-summary?fleetId=${OTHER}`,
      headers: auth,
    });
    const unknown = await app.inject({
      method: 'GET',
      url: '/fleets/metrics-summary?fleetId=flt_000000000099',
      headers: auth,
    });
    expect(unknown.statusCode).toBe(other.statusCode);
    expect(unknown.body).toBe(other.body);
    expect(other.json()).toEqual({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
    // The answer comes from the assigned fleet ids alone: no fleet row is read.
    expect(state.lookedUp).toBe('');
    expect(summary).not.toHaveBeenCalled();
  });

  it('summarizes the assigned fleet, or every assigned fleet, of a fleet user with its billing', async () => {
    state.reader = { kind: 'fleets', fleetIds: [FLEET], paymentsRead: true };
    const one = await app.inject({
      method: 'GET',
      url: `/fleets/metrics-summary?fleetId=${FLEET}&days=7`,
      headers: auth,
    });
    expect(one.statusCode).toBe(200);
    expect(one.json().fleetId).toBe(FLEET);
    expect(summary).toHaveBeenLastCalledWith(
      state.reader,
      expect.objectContaining({ fleetIds: [FLEET], money: true, billing: true }),
    );
    await app.inject({ method: 'GET', url: '/fleets/metrics-summary', headers: auth });
    expect(summary).toHaveBeenLastCalledWith(
      state.reader,
      expect.objectContaining({ fleetIds: 'all' }),
    );
  });

  it('gives a site-restricted operator no credit limit or invoices, and no money without payments:read', async () => {
    state.reader = { kind: 'sites', siteIds: ['sit_a'] };
    await app.inject({ method: 'GET', url: '/fleets/metrics-summary', headers: auth });
    expect(summary).toHaveBeenLastCalledWith(
      state.reader,
      expect.objectContaining({ money: true, billing: false }),
    );
    state.permissions = new Set(['fleets:read']);
    state.reader = { kind: 'sites', siteIds: null };
    await app.inject({ method: 'GET', url: '/fleets/metrics-summary', headers: auth });
    expect(summary).toHaveBeenLastCalledWith(
      state.reader,
      expect.objectContaining({ money: false, billing: false }),
    );
  });

  it('answers 404 for an unknown fleet and 400 for a range over 90 days', async () => {
    const unknown = await app.inject({
      method: 'GET',
      url: '/fleets/metrics-summary?fleetId=flt_000000000099',
      headers: auth,
    });
    expect(unknown.statusCode).toBe(404);
    const range = await app.inject({
      method: 'GET',
      url: '/fleets/metrics-summary?from=2026-01-01&to=2026-06-01',
      headers: auth,
    });
    expect(range.statusCode).toBe(400);
  });
});

describe('GET /fleets/dashboard-sessions', () => {
  let app: FastifyInstance;
  let auth: Record<string, string>;
  let fleetScope: unknown;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    app.addHook('onRoute', (route) => {
      if (route.url === '/fleets/dashboard-sessions') {
        fleetScope = (route.config as { fleetScope?: unknown } | undefined)?.fleetScope;
      }
    });
    fleetDashboardRoutes(app);
    await app.ready();
    auth = { authorization: `Bearer ${app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    state.reader = { kind: 'fleets', fleetIds: [FLEET], paymentsRead: true };
    state.permissions = new Set(['fleets:read', 'sessions:read', 'payments:read']);
    sessions.mockReset();
    sessions.mockResolvedValue({ data: [], total: 0 });
  });

  it('is open to fleet users', () => {
    expect(fleetScope).toBe(true);
  });

  it('lists every assigned fleet when no fleet is picked, with the cost for payments:read', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/fleets/dashboard-sessions?limit=20',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(sessions).toHaveBeenCalledWith(state.reader, {
      fleetIds: 'all',
      page: 1,
      limit: 20,
      money: true,
    });
  });

  it('lists one picked fleet without the cost when payments:read is missing', async () => {
    state.permissions = new Set(['fleets:read', 'sessions:read']);
    const res = await app.inject({
      method: 'GET',
      url: `/fleets/dashboard-sessions?fleetId=${FLEET}&page=2`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(sessions).toHaveBeenCalledWith(state.reader, {
      fleetIds: [FLEET],
      page: 2,
      limit: 10,
      money: false,
    });
  });

  it('answers a fleet user 404 for a fleet it is not assigned, before any read', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/fleets/dashboard-sessions?fleetId=${OTHER}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('FLEET_NOT_FOUND');
    expect(sessions).not.toHaveBeenCalled();
  });
});
