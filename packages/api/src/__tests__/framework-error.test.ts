// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { frameworkClientError, sendRouteNotFound } from '../lib/framework-error.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

// The framework branch of the app.ts error handler and its not-found handler.
async function build(): Promise<FastifyInstance> {
  const instance = Fastify({ bodyLimit: 32 });
  instance.setErrorHandler((error: unknown, _request, reply) => {
    const client = frameworkClientError(error);
    if (client != null) {
      void reply.status(client.status).send(client.body);
      return;
    }
    void reply.status(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  });
  instance.setNotFoundHandler(sendRouteNotFound);
  instance.post(
    '/body',
    {
      schema: {
        body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      },
    },
    () => ({ ok: true }),
  );
  instance.get('/denied', () => {
    throw Object.assign(new Error('No Authorization was found in request.headers'), {
      statusCode: 401,
    });
  });
  instance.get('/limited', () => {
    throw Object.assign(new Error('Rate limit exceeded'), { statusCode: 429 });
  });
  await instance.ready();
  app = instance;
  return instance;
}

describe('framework error codes', () => {
  it('codes a schema failure VALIDATION_ERROR with the field details', async () => {
    const res = await (await build()).inject({ method: 'POST', url: '/body', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('codes 401, 404, 413, 415 and 429 by status', async () => {
    const server = await build();
    const denied = await server.inject({ method: 'GET', url: '/denied' });
    expect([denied.statusCode, denied.json<{ code: string }>().code]).toEqual([
      401,
      'UNAUTHORIZED',
    ]);

    const missing = await server.inject({ method: 'GET', url: '/nowhere' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Not found', code: 'NOT_FOUND' });

    const large = await server.inject({
      method: 'POST',
      url: '/body',
      payload: { name: 'x'.repeat(100) },
    });
    expect([large.statusCode, large.json<{ code: string }>().code]).toEqual([
      413,
      'PAYLOAD_TOO_LARGE',
    ]);

    const media = await server.inject({
      method: 'POST',
      url: '/body',
      headers: { 'content-type': 'text/xml' },
      payload: '<a/>',
    });
    expect([media.statusCode, media.json<{ code: string }>().code]).toEqual([
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    ]);

    const limited = await server.inject({ method: 'GET', url: '/limited' });
    expect([limited.statusCode, limited.json<{ code: string }>().code]).toEqual([
      429,
      'RATE_LIMITED',
    ]);
  });

  it('leaves server errors to the caller', () => {
    expect(frameworkClientError(Object.assign(new Error('boom'), { statusCode: 503 }))).toBeNull();
    expect(frameworkClientError(new Error('boom'))).toBeNull();
  });
});
