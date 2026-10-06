// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AppError, NotFoundError } from '@evtivity/lib';

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  isRoamingEnabled: vi.fn().mockResolvedValue(true),
}));

const { buildOcpiApp } = await import('../app.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildOcpiApp({ logger: false });
  // Test-only routes outside /ocpi/ that raise each error kind the handler maps.
  app.get('/test/not-found', () => {
    throw new NotFoundError('Location', 'LOC-1');
  });
  app.get('/test/app-server-error', () => {
    throw new AppError('Upstream broke', 502, 'UPSTREAM');
  });
  app.post('/test/bad-json', () => ({ ok: true }));
  app.get('/test/crash', () => {
    throw new Error('secret internals');
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('OCPI error handler', () => {
  it('maps a 4xx AppError to an OCPI client error envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/not-found' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      data: null,
      status_code: 2000,
      status_message: 'Location not found: LOC-1',
    });
  });

  it('maps a 5xx AppError to an OCPI server error envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/app-server-error' });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ status_code: 3000, status_message: 'Upstream broke' });
  });

  it('maps a Fastify 4xx error (malformed JSON body) to a client error envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/bad-json',
      headers: { 'content-type': 'application/json' },
      payload: '{"broken":',
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ status_code: number; status_message: string }>();
    expect(body.status_code).toBe(2000);
    expect(body.status_message).not.toBe('');
  });

  it('hides unexpected errors behind a generic 500 envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/crash' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({
      data: null,
      status_code: 3000,
      status_message: 'Internal server error',
    });
    expect(res.body).not.toContain('secret internals');
  });

  it('sends security headers and rate limit headers on non-health routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/not-found' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-ratelimit-limit']).toBe('300');
  });
});
