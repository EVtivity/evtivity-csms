// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { defaultDashboardLayout } from '@evtivity/lib/dashboard-layout';

const store = vi.hoisted(() => new Map<string, unknown>());

vi.mock('@evtivity/database', () => ({
  getUserDashboardLayout: vi.fn((userId: string) => Promise.resolve(store.get(userId) ?? null)),
  saveUserDashboardLayout: vi.fn((userId: string, layout: unknown) => {
    store.set(userId, layout);
    return Promise.resolve();
  }),
  deleteUserDashboardLayout: vi.fn((userId: string) => {
    store.delete(userId);
    return Promise.resolve();
  }),
}));

// The real guard (middleware/rbac.ts) authenticates with the database; this
// stand-in keeps its decision: a signed-in session, never an API key.
vi.mock('../middleware/rbac.js', () => ({
  selfService:
    (opts?: { allowApiKey?: boolean }) =>
    async (
      request: { jwtVerify: () => Promise<void>; user?: { isApiKey?: boolean } },
      reply: { status: (n: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
        return;
      }
      if (request.user?.isApiKey === true && opts?.allowApiKey !== true) {
        await reply.status(403).send({ error: 'Session required', code: 'SESSION_REQUIRED' });
      }
    },
}));

import { registerAuth } from '../plugins/auth.js';
import { userDashboardLayoutRoutes } from '../routes/user-dashboard-layout.js';
import { matchCacheRule } from '../plugins/response-cache.js';
import { saveUserDashboardLayout } from '@evtivity/database';

const URL = '/users/me/dashboard-layout';

describe('dashboard layout routes', () => {
  let app: FastifyInstance;
  let token: string;
  let otherToken: string;
  let apiKeyToken: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    userDashboardLayoutRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
    otherToken = app.jwt.sign({ userId: 'usr_000000000002', roleId: 'rol_000000000001' });
    apiKeyToken = app.jwt.sign({
      userId: 'usr_000000000001',
      roleId: 'rol_000000000001',
      isApiKey: true,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    store.clear();
  });

  const send = (method: 'GET' | 'PUT' | 'DELETE', bearer = token, payload?: unknown) =>
    app.inject({
      method,
      url: URL,
      headers: { authorization: `Bearer ${bearer}` },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  it('gives the default layout to a user without a stored one', async () => {
    const res = await send('GET');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ layout: defaultDashboardLayout(), customized: false });
  });

  it('stores a layout and reads it back resolved, per user', async () => {
    const put = await send('PUT', token, {
      version: 1,
      charts: [{ id: 'chart.freeVend', hidden: false }],
    });
    expect(put.statusCode).toBe(200);
    const body = put.json();
    expect(body.customized).toBe(true);
    expect(body.layout.charts[0]).toEqual({ id: 'chart.freeVend', hidden: false });
    expect(body.layout.charts).toHaveLength(defaultDashboardLayout().charts.length);
    expect(body.layout.cards).toBeUndefined();

    expect((await send('GET')).json()).toEqual(body);
    expect((await send('GET', otherToken)).json().customized).toBe(false);
  });

  it('ignores the stat cards an earlier client sends and cleans them from a stored layout', async () => {
    const put = await send('PUT', token, {
      version: 1,
      cards: [{ id: 'card.uptime', hidden: true }],
      charts: [],
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().layout).toEqual(defaultDashboardLayout());
    expect(store.get('usr_000000000001')).toEqual(defaultDashboardLayout());

    store.set('usr_000000000002', {
      version: 1,
      cards: [{ id: 'card.totalStations', hidden: true }],
      charts: [
        { id: 'card.uptime', hidden: true },
        { id: 'chart.plugAndCharge', hidden: false },
      ],
    });
    const res = await send('GET', otherToken);
    expect(res.statusCode).toBe(200);
    const { layout } = res.json();
    expect(layout.cards).toBeUndefined();
    expect(layout.charts[0]).toEqual({ id: 'chart.plugAndCharge', hidden: false });
    expect(layout.charts).toHaveLength(defaultDashboardLayout().charts.length);
  });

  it('refuses an unknown chart, a repeated one and a stat card among the charts', async () => {
    vi.mocked(saveUserDashboardLayout).mockClear();
    for (const payload of [
      { version: 1, charts: [{ id: 'chart.nope', hidden: false }] },
      {
        version: 1,
        charts: [
          { id: 'chart.energy', hidden: false },
          { id: 'chart.energy', hidden: true },
        ],
      },
      { version: 1, charts: [{ id: 'card.uptime', hidden: false }] },
    ]) {
      const res = await send('PUT', token, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    }
    // The body schema refuses another version (the app error handler codes it VALIDATION_ERROR).
    expect((await send('PUT', token, { version: 2, charts: [] })).statusCode).toBe(400);
    expect(vi.mocked(saveUserDashboardLayout)).not.toHaveBeenCalled();
  });

  it('resets to the default layout, also when nothing was stored', async () => {
    await send('PUT', token, {
      version: 1,
      charts: [{ id: 'chart.energy', hidden: true }],
    });
    for (let i = 0; i < 2; i++) {
      const res = await send('DELETE');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ layout: defaultDashboardLayout(), customized: false });
    }
    expect((await send('GET')).json().customized).toBe(false);
  });

  it('refuses API keys and anonymous requests', async () => {
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      const res = await send(
        method,
        apiKeyToken,
        method === 'PUT' ? defaultDashboardLayout() : undefined,
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('SESSION_REQUIRED');
      const anon = await app.inject({ method, url: URL });
      expect(anon.statusCode).toBe(401);
    }
  });

  it('is never served from the response cache', () => {
    expect(matchCacheRule('/v1/users/me/dashboard-layout')).toBeNull();
  });
});
