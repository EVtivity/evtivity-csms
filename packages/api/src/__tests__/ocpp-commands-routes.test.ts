// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

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
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
  invalidatePermissionCache: vi.fn(),
}));

// Mock the pubsub singleton used by ocpp-commands route
vi.mock('../lib/pubsub.js', () => ({
  getPubSub: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  setPubSub: vi.fn(),
}));

// Mock the @evtivity/ocpp module for ActionRegistry
vi.mock('@evtivity/ocpp', () => ({
  ActionRegistry: {
    Reset: {
      validateRequest: Object.assign(vi.fn().mockReturnValue(true), { errors: null }),
    },
    GetBaseReport: {
      validateRequest: Object.assign(vi.fn().mockReturnValue(true), { errors: null }),
    },
  },
  ActionRegistry16: {
    Reset: {
      validateRequest: Object.assign(vi.fn().mockReturnValue(true), { errors: null }),
    },
  },
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { ocppCommandRoutes } from '../routes/ocpp-commands.js';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  ocppCommandRoutes(app);
  await app.ready();
  return app;
}

describe('OCPP command routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /ocpp/commands/v21/Reset returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      payload: { stationId: 'STATION-001' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('POST /ocpp/commands/v21/Reset rejects empty body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('POST /ocpp/commands/v21/Reset rejects missing stationId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: { type: 'Immediate' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 for unknown v21 action (no route)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/NonExistentAction',
      headers: { authorization: `Bearer ${token}` },
      payload: { stationId: 'STATION-001' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 404 for unknown v16 action (no route)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v16/NonExistentAction16',
      headers: { authorization: `Bearer ${token}` },
      payload: { stationId: 'STATION-001' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 400 when v21 payload validation fails', async () => {
    // Override validateRequest to return false for this test
    const { ActionRegistry } = await import('@evtivity/ocpp');
    const originalValidate = ActionRegistry['Reset'].validateRequest;
    (
      ActionRegistry['Reset'] as unknown as { validateRequest: ReturnType<typeof vi.fn> }
    ).validateRequest = Object.assign(vi.fn().mockReturnValue(false), {
      errors: [{ message: 'invalid type' }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: { stationId: 'STATION-001', type: 'Immediate' },
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('INVALID_PAYLOAD');

    // Restore
    (ActionRegistry['Reset'] as { validateRequest: unknown }).validateRequest = originalValidate;
  });

  it('route registration works without error', async () => {
    const freshApp = Fastify();
    await registerAuth(freshApp);
    ocppCommandRoutes(freshApp);
    await freshApp.ready();
    await freshApp.close();
  });

  it('returns 404 for invalid version prefix in URL', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v30/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: { stationId: 'STATION-001' },
    });
    // No routes registered under v30, Fastify returns 404
    expect(response.statusCode).toBe(404);
  });
});
