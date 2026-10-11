// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { AppError } from '@evtivity/lib';

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { CORS_ORIGIN: 'local', NODE_ENV: 'test' },
}));

vi.mock('../lib/config.js', () => ({ config: mockConfig }));

import { registerCors } from '../plugins/cors.js';

let app: FastifyInstance | undefined;

// The AppError branch of the error handler in app.ts.
async function buildCorsApp(corsOrigin: string, nodeEnv = 'test'): Promise<FastifyInstance> {
  mockConfig.CORS_ORIGIN = corsOrigin;
  mockConfig.NODE_ENV = nodeEnv;
  const instance = Fastify();
  await registerCors(instance);
  instance.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({ error: error.message, code: error.code });
      return;
    }
    void reply.status(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  });
  instance.get('/ping', () => ({ ok: true }));
  await instance.ready();
  app = instance;
  return instance;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('registerCors', () => {
  describe('local mode', () => {
    it('refuses a disallowed origin with 403 FORBIDDEN', async () => {
      const server = await buildCorsApp('local');
      const res = await server.inject({
        method: 'GET',
        url: '/ping',
        headers: { origin: 'https://evil.example.com', host: 'api.example.org' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'CORS origin not allowed', code: 'FORBIDDEN' });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('refuses a preflight from a disallowed origin with 403', async () => {
      const server = await buildCorsApp('local');
      const res = await server.inject({
        method: 'OPTIONS',
        url: '/ping',
        headers: {
          origin: 'https://evil.example.com',
          'access-control-request-method': 'POST',
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
    });

    it('refuses a malformed origin with 403', async () => {
      const server = await buildCorsApp('local');
      const res = await server.inject({
        method: 'GET',
        url: '/ping',
        headers: { origin: 'not a url' },
      });
      expect(res.statusCode).toBe(403);
    });

    it.each([
      'http://localhost:7100',
      'http://192.168.1.20:7100',
      'http://10.0.0.5',
      'http://172.20.1.1',
    ])('allows the private origin %s', async (origin) => {
      const server = await buildCorsApp('local');
      const res = await server.inject({
        method: 'GET',
        url: '/ping',
        headers: { origin, host: 'api.example.org' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('allows a same-origin request from a public hostname', async () => {
      const server = await buildCorsApp('local');
      const res = await server.inject({
        method: 'GET',
        url: '/ping',
        headers: { origin: 'https://csms.example.com', host: 'csms.example.com' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('leaves a request without an Origin unchanged', async () => {
      const server = await buildCorsApp('local');
      const res = await server.inject({ method: 'GET', url: '/ping' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('explicit origin list', () => {
    const list = 'https://csms.example.com, https://portal.example.com';

    it('allows a listed origin', async () => {
      const server = await buildCorsApp(list);
      const res = await server.inject({
        method: 'GET',
        url: '/ping',
        headers: { origin: 'https://portal.example.com' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://portal.example.com');
    });

    it('sends no CORS headers to an unlisted origin and never answers 500', async () => {
      const server = await buildCorsApp(list);
      const res = await server.inject({
        method: 'GET',
        url: '/ping',
        headers: { origin: 'https://evil.example.com' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('leaves a request without an Origin unchanged', async () => {
      const server = await buildCorsApp(list);
      const res = await server.inject({ method: 'GET', url: '/ping' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('single origin', () => {
    it('answers with the configured origin', async () => {
      const server = await buildCorsApp('https://csms.example.com');
      const allowed = await server.inject({
        method: 'GET',
        url: '/ping',
        headers: { origin: 'https://csms.example.com' },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.headers['access-control-allow-origin']).toBe('https://csms.example.com');

      const other = await server.inject({
        method: 'GET',
        url: '/ping',
        headers: { origin: 'https://evil.example.com' },
      });
      expect(other.statusCode).toBe(200);
      expect(other.headers['access-control-allow-origin']).toBe('https://csms.example.com');

      const none = await server.inject({ method: 'GET', url: '/ping' });
      expect(none.statusCode).toBe(200);
    });
  });

  describe('wildcard', () => {
    it('allows any origin outside production', async () => {
      const server = await buildCorsApp('*');
      const res = await server.inject({
        method: 'GET',
        url: '/ping',
        headers: { origin: 'https://anything.example.com' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('*');

      const none = await server.inject({ method: 'GET', url: '/ping' });
      expect(none.statusCode).toBe(200);
    });

    it('refuses to start in production', async () => {
      mockConfig.CORS_ORIGIN = '*';
      mockConfig.NODE_ENV = 'production';
      await expect(registerCors(Fastify())).rejects.toThrow(/must not be "\*" in production/);
    });
  });

  it('refuses to start without CORS_ORIGIN', async () => {
    mockConfig.CORS_ORIGIN = '';
    mockConfig.NODE_ENV = 'test';
    await expect(registerCors(Fastify())).rejects.toThrow(/CORS_ORIGIN/);
  });
});
