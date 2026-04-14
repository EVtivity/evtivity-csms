// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerAuth } from '../plugins/auth.js';
import { healthRoutes } from '../routes/health.js';

describe('Auth plugin', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);

    app.get(
      '/protected',
      {
        onRequest: [app.authenticate],
      },
      async () => {
        return { data: 'secret' };
      },
    );

    await app.register(healthRoutes);
    await app.ready();
  });

  it('allows access to unprotected routes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects unauthenticated requests to protected routes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts requests with valid JWT', async () => {
    const token = app.jwt.sign({ userId: 'test-id', roleId: 'test-role' });

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body['data']).toBe('secret');
  });

  it('rejects requests with invalid JWT', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        authorization: 'Bearer invalid-token',
      },
    });

    expect(response.statusCode).toBe(401);
  });
});
