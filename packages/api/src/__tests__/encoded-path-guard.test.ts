// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerEncodedPathGuard, routePath } from '../plugins/encoded-path-guard.js';

describe('encoded path guard', () => {
  let app: FastifyInstance;
  const handler = vi.fn(() => ({ ok: true }));
  const seen: string[] = [];

  beforeAll(async () => {
    app = Fastify();
    registerEncodedPathGuard(app);
    // A hook that decides on the path, as CSRF and the feature switches do.
    app.addHook('onRequest', async (request) => {
      seen.push(routePath(request));
    });
    app.patch('/v1/portal/driver/profile', handler);
    app.get('/v1/users/me', handler);
    app.get('/v1/portal/chargers/:stationId', handler);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses an encoded letter before any later hook or the handler runs', async () => {
    seen.length = 0;
    handler.mockClear();
    const portal = await app.inject({
      method: 'PATCH',
      url: '/v1/%70ortal/driver/profile',
      payload: {},
    });
    const operator = await app.inject({ method: 'GET', url: '/%761/users/me' });
    for (const res of [portal, operator]) {
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    }
    expect(seen).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses an encoded slash', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/portal%2Fchargers/CS1' });
    expect(res.statusCode).toBe(400);
  });

  it('passes an encoded reserved character in a parameter and names the route pattern', async () => {
    seen.length = 0;
    const res = await app.inject({ method: 'GET', url: '/v1/portal/chargers/CS%20001' });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual(['/v1/portal/chargers/:stationId']);
  });
});
