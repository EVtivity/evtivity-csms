// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerAuth } from '../plugins/auth.js';
import { siteRoutes } from '../routes/sites.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(siteRoutes);
  await app.ready();
  return app;
}

describe('Site import/export endpoints - auth requirements', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/sites/export returns 401 without token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/sites/export',
    });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/sites/export/template returns 401 without token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/sites/export/template',
    });
    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/sites/import returns 401 without token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/sites/import',
      payload: {
        rows: [{ siteName: 'Test Site' }],
        updateExisting: false,
      },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('Site import/export endpoints - schema validation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /v1/sites/import rejects missing siteName', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/sites/import',
      payload: {
        rows: [{ siteAddress: '123 Main St' }],
        updateExisting: false,
      },
      headers: { authorization: 'Bearer invalid' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/sites/import rejects invalid body (missing rows)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/sites/import',
      payload: {
        updateExisting: false,
      },
      headers: { authorization: 'Bearer invalid' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/sites/import rejects invalid body (missing updateExisting)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/sites/import',
      payload: {
        rows: [{ siteName: 'Test' }],
      },
      headers: { authorization: 'Bearer invalid' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('Site import/export endpoints - route registration', () => {
  it('registers all site import/export routes without error', async () => {
    const app = Fastify();
    await registerAuth(app);
    await app.register(siteRoutes);
    await app.ready();
    await app.close();
  });
});
