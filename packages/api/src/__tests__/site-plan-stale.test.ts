// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { markSitePlanStale } = vi.hoisted(() => ({
  markSitePlanStale: vi.fn().mockResolvedValue(true),
}));
vi.mock('@evtivity/database', () => ({ markSitePlanStale }));

import { replanSiteAfterWrite } from '../lib/site-plan-stale.js';

describe('replanSiteAfterWrite', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.post(
      '/sites/:siteId/things',
      { onResponse: [replanSiteAfterWrite('thing_changed')] },
      async (_request, reply) => reply.status(201).send({ ok: true }),
    );
    app.delete(
      '/sites/:siteId/things/:thingId',
      { onResponse: [replanSiteAfterWrite('thing_changed')] },
      async (_request, reply) => reply.status(404).send({ error: 'x', code: 'THING_NOT_FOUND' }),
    );
    app.put(
      '/sites/:id/config',
      { onResponse: [replanSiteAfterWrite('config_changed', 'id')] },
      async () => ({ ok: true }),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('marks the plan of a departure-aware site after a successful write', async () => {
    const res = await app.inject({ method: 'POST', url: '/sites/sit_a/things' });
    expect(res.statusCode).toBe(201);
    await vi.waitFor(() => {
      expect(markSitePlanStale).toHaveBeenCalledWith('sit_a', 'thing_changed', expect.anything(), {
        departureAwareOnly: true,
      });
    });
  });

  it('reads the site from the param the route names', async () => {
    await app.inject({ method: 'PUT', url: '/sites/sit_b/config' });
    await vi.waitFor(() => {
      expect(markSitePlanStale).toHaveBeenCalledWith('sit_b', 'config_changed', expect.anything(), {
        departureAwareOnly: true,
      });
    });
  });

  it('marks nothing after a refused write', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/sites/sit_a/things/thg_1' });
    expect(res.statusCode).toBe(404);
    await new Promise((resolve) => setImmediate(resolve));
    expect(markSitePlanStale).not.toHaveBeenCalled();
  });
});
