// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const access = vi.hoisted(() => ({ allSites: true, permissions: new Set<string>() }));
const svc = vi.hoisted(() => ({
  readAiInsightScope: vi.fn(),
  readAiInsightScopeStations: vi.fn(),
  updateAiInsightScope: vi.fn(),
}));

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    (permission: string) =>
    async (
      _req: unknown,
      reply: { status: (n: number) => { send: (b: unknown) => Promise<void> } },
    ) => {
      if (!access.permissions.has(permission)) {
        await reply.status(403).send({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' });
      }
    },
}));
vi.mock('../lib/site-access.js', () => ({
  requireAllSiteAccess: async (
    _req: unknown,
    reply: { status: (n: number) => { send: (b: unknown) => Promise<void> } },
    notFound: unknown,
  ) => {
    if (access.allSites) return true;
    await reply.status(404).send(notFound);
    return false;
  },
}));
vi.mock('../services/ai-insight-scope.service.js', async () => {
  const actual = await vi.importActual<typeof import('../services/ai-insight-scope.service.js')>(
    '../services/ai-insight-scope.service.js',
  );
  return { AiInsightScopeError: actual.AiInsightScopeError, ...svc };
});

const { aiInsightScopeRoutes } = await import('../routes/ai-insight-scope.js');
const { AiInsightScopeError } = await import('../services/ai-insight-scope.service.js');

const SCOPE = { mode: 'all', sites: [], stationsWithoutSite: 0 };

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    (req as unknown as { user: unknown }).user = { userId: 'usr_1' };
  });
  // The app's error handler answers a ValidationError with 400.
  app.setErrorHandler(async (err: { statusCode?: number; message: string }, _req, reply) => {
    const status = err.statusCode ?? 500;
    await reply
      .status(status)
      .send({ error: err.message, code: status === 400 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR' });
  });
  aiInsightScopeRoutes(app);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  access.allSites = true;
  access.permissions = new Set(['settings.system:read', 'settings.system:write']);
  svc.readAiInsightScope.mockResolvedValue(SCOPE);
});

describe('AI insights scope routes', () => {
  it('reads the scope for an all-site user', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/settings/ai/insights-scope' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(SCOPE);
  });

  it('answers 404 to a site-restricted user before any read or write', async () => {
    access.allSites = false;
    const app = await build();
    const get = await app.inject({ method: 'GET', url: '/settings/ai/insights-scope' });
    const put = await app.inject({
      method: 'PUT',
      url: '/settings/ai/insights-scope',
      payload: { mode: 'selected' },
    });
    expect(get.statusCode).toBe(404);
    expect(put.statusCode).toBe(404);
    expect(svc.readAiInsightScope).not.toHaveBeenCalled();
    expect(svc.updateAiInsightScope).not.toHaveBeenCalled();
  });

  it('needs settings.system:write to change it', async () => {
    access.permissions = new Set(['settings.system:read']);
    const app = await build();
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/ai/insights-scope',
      payload: { mode: 'selected' },
    });
    expect(res.statusCode).toBe(403);
    expect(svc.updateAiInsightScope).not.toHaveBeenCalled();
  });

  it('passes the change to the scope service with the audit actor', async () => {
    svc.updateAiInsightScope.mockResolvedValue({
      scope: { ...SCOPE, mode: 'selected' },
      sitesRemoved: 1,
      stationsRemoved: 2,
      insightsDismissed: 3,
      actionsExpired: 0,
    });
    const app = await build();
    const body = {
      mode: 'selected',
      sites: [{ siteId: 'sit_1', selected: false }],
      stations: [{ stationId: 'sta_1', enabled: false }],
    };
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/ai/insights-scope',
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sitesRemoved: 1, insightsDismissed: 3 });
    expect(svc.updateAiInsightScope).toHaveBeenCalledWith(
      body,
      expect.objectContaining({ actor: 'operator', actorUserId: 'usr_1' }),
      expect.anything(),
    );
  });

  it('answers 400 with the ids for a refused change', async () => {
    svc.updateAiInsightScope.mockRejectedValue(new AiInsightScopeError('Unknown site', ['sit_x']));
    const app = await build();
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/ai/insights-scope',
      payload: { mode: 'selected', sites: [{ siteId: 'sit_x', selected: true }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'Unknown site',
      code: 'VALIDATION_ERROR',
      details: { ids: ['sit_x'] },
    });
  });

  it('refuses an unknown mode and unknown body keys', async () => {
    const app = await build();
    const mode = await app.inject({
      method: 'PUT',
      url: '/settings/ai/insights-scope',
      payload: { mode: 'some' },
    });
    const extra = await app.inject({
      method: 'PUT',
      url: '/settings/ai/insights-scope',
      payload: { mode: 'all', other: true },
    });
    expect(mode.statusCode).toBe(400);
    expect(extra.statusCode).toBe(400);
    expect(svc.updateAiInsightScope).not.toHaveBeenCalled();
  });

  it('answers 404 for the stations of an unknown site', async () => {
    svc.readAiInsightScopeStations.mockResolvedValue(null);
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/settings/ai/insights-scope/sites/sit_missing/stations',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'SITE_NOT_FOUND' });
  });
});
