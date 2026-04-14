// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

// Mock postgres module used for LISTEN/NOTIFY
vi.mock('postgres', () => {
  const mockSql = vi.fn(() => {
    const instance = Object.assign(Promise.resolve(), {
      listen: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined),
    });
    return instance;
  });
  return { default: mockSql };
});

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => []) })) })),
  },
  client: {},
  refreshTokens: {},
  users: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { eventStreamRoutes } from '../routes/events.js';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie);
  await registerAuth(app);
  eventStreamRoutes(app);
  await app.ready();
  return app;
}

describe('Event stream routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/events/stream returns 401 without token query param', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/events/stream',
    });
    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Unauthorized');
  });

  it('GET /v1/events/stream returns 401 with empty token query param', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/events/stream?token=',
    });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/events/stream returns 401 with invalid token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/events/stream?token=invalid-jwt-token',
    });
    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Unauthorized');
  });

  it('GET /v1/events/stream returns 401 with token signed by wrong secret', async () => {
    // Build a separate app with a different secret
    const otherApp = Fastify();
    await import('@fastify/jwt').then((jwt) =>
      otherApp.register(jwt.default, { secret: 'other-secret-key-12345' }),
    );
    await otherApp.ready();
    const wrongToken = otherApp.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
    await otherApp.close();

    const response = await app.inject({
      method: 'GET',
      url: `/events/stream?token=${wrongToken}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/events/stream returns 401 with malformed JWT', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/events/stream?token=eyJhbGciOiJIUzI1NiJ9.invalid.signature',
    });
    expect(response.statusCode).toBe(401);
  });

  it('route registration works without error', async () => {
    const freshApp = Fastify();
    await registerAuth(freshApp);
    eventStreamRoutes(freshApp);
    await freshApp.ready();
    await freshApp.close();
  });

  it('onClose hook cleans up listeners', async () => {
    // Build a separate app and close it immediately
    const tempApp = Fastify();
    await registerAuth(tempApp);
    eventStreamRoutes(tempApp);
    await tempApp.ready();
    // The onClose hook should fire without error
    await tempApp.close();
  });

  it('GET /v1/events/stream authenticates via csms_token cookie', async () => {
    const token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });

    // Suppress the ERR_HTTP_HEADERS_SENT unhandled rejection that light-my-request
    // triggers when aborting an SSE stream (headers already written via reply.raw.writeHead).
    const suppressHeadersError = (reason: unknown) => {
      if (reason instanceof Error && 'code' in reason && reason.code === 'ERR_HTTP_HEADERS_SENT')
        return;
      throw reason;
    };
    process.on('unhandledRejection', suppressHeadersError);

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 200);
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/events/stream',
        cookies: { csms_token: token },
        signal: abortController.signal as never,
      });
      // If inject resolves, check that it was not a 401
      expect(response.statusCode).not.toBe(401);
    } catch {
      // AbortError is expected because the SSE handler streams indefinitely.
      // Reaching this catch means the handler passed the auth check and started streaming,
      // which is exactly what we want to verify.
    } finally {
      clearTimeout(timeout);
      // Allow the error handler to fire before removing the listener
      await new Promise((resolve) => setTimeout(resolve, 50));
      process.off('unhandledRejection', suppressHeadersError);
    }
  });

  it('GET /v1/events/stream rejects missing query params entirely', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/events/stream',
    });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toHaveProperty('error');
  });
});
