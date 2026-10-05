// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const insertValues = vi.fn();
const publish = vi.fn();

vi.mock('@evtivity/database', () => ({
  db: { insert: vi.fn(() => ({ values: insertValues })) },
  accessLogs: {},
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish }),
}));

import { registerApiAccessLog } from '../plugins/api-access-log.js';

async function buildApp(): Promise<{ app: FastifyInstance; warn: ReturnType<typeof vi.fn> }> {
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    const header = request.headers['x-test-user'];
    if (typeof header === 'string') {
      (request as unknown as { user: unknown }).user = JSON.parse(header) as unknown;
    }
  });
  const warn = vi.fn();
  app.addHook('onRequest', async (request) => {
    request.log.warn = warn as never;
  });
  registerApiAccessLog(app);
  app.get('/v1/things', async () => ({ ok: true }));
  app.post('/v1/things', async () => ({ ok: true }));
  app.get('/v1/health', async () => ({ ok: true }));
  await app.ready();
  return { app, warn };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe('API access log', () => {
  let app: FastifyInstance;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    insertValues.mockReset().mockResolvedValue(undefined);
    publish.mockReset().mockResolvedValue(undefined);
    ({ app, warn } = await buildApp());
  });

  afterEach(async () => {
    await app.close();
  });

  it('records an operator request with its user and redacted body', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/things?x=1',
      headers: { 'x-test-user': JSON.stringify({ userId: 'usr_1', roleId: 'rol_1' }) },
      payload: { name: 'a' },
    });
    await flush();

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'usr_1',
        authType: 'session',
        action: 'POST /v1/things',
        path: '/v1/things',
        statusCode: 200,
        metadata: { name: 'a' },
      }),
    );
  });

  it('records an API key request as api_key with its name', async () => {
    await app.inject({
      method: 'GET',
      url: '/v1/things',
      headers: {
        'x-test-user': JSON.stringify({ userId: 'usr_2', isApiKey: true, apiKeyName: 'ci' }),
      },
    });
    await flush();

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_2', authType: 'api_key', apiKeyName: 'ci' }),
    );
  });

  it('skips the health path', async () => {
    await app.inject({ method: 'GET', url: '/v1/health' });
    await flush();

    expect(insertValues).not.toHaveBeenCalled();
  });

  it('logs a failed write at warn instead of dropping it silently', async () => {
    insertValues.mockRejectedValue(new Error('violates foreign key constraint'));

    const res = await app.inject({ method: 'GET', url: '/v1/things' });
    await flush();

    expect(res.statusCode).toBe(200);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/v1/things' }),
      'API access log write failed',
    );
  });

  it('logs a failed SSE publish at warn', async () => {
    publish.mockRejectedValue(new Error('redis down'));

    await app.inject({ method: 'GET', url: '/v1/things' });
    await flush();

    expect(warn).toHaveBeenCalledWith(expect.anything(), 'API access log SSE publish failed');
  });

  it('publishes the SSE refresh at most once per throttle window', async () => {
    await app.inject({ method: 'GET', url: '/v1/things' });
    await app.inject({ method: 'GET', url: '/v1/things' });
    await flush();

    expect(insertValues).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
