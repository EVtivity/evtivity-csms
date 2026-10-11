// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { AppError } from '@evtivity/lib';

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { CORS_ORIGIN: 'local', NODE_ENV: 'test' },
}));

vi.mock('../lib/config.js', () => ({ config: mockConfig }));

import { registerCors } from '../plugins/cors.js';
import { registerPortalCsrf } from '../plugins/csrf.js';

let app: FastifyInstance | undefined;

// The AppError branch of the error handler in app.ts.
// Cookie, CORS and portal CSRF register in the order of app.ts.
async function buildCorsApp(corsOrigin: string, nodeEnv = 'test'): Promise<FastifyInstance> {
  mockConfig.CORS_ORIGIN = corsOrigin;
  mockConfig.NODE_ENV = nodeEnv;
  const instance = Fastify();
  await instance.register(cookie);
  await registerCors(instance);
  registerPortalCsrf(instance);
  instance.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({ error: error.message, code: error.code });
      return;
    }
    void reply.status(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  });
  instance.get('/ping', () => ({ ok: true }));
  instance.post('/v1/portal/support-cases', () => ({ created: true }));
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

    it('TC-CORS-01 sends no CORS headers to an unlisted origin and never answers 500', async () => {
      const server = await buildCorsApp(list);
      const res = await server.inject({
        method: 'GET',
        url: '/ping',
        headers: { origin: 'https://evil.example.com' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('TC-CORS-02 answers a preflight from an unlisted origin with 204 and no CORS grant', async () => {
      const server = await buildCorsApp(list);
      const res = await server.inject({
        method: 'OPTIONS',
        url: '/v1/portal/support-cases',
        headers: {
          origin: 'https://evil.example.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-csrf-token',
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      // @fastify/cors 11 sends Access-Control-Allow-Credentials on every
      // response when credentials are on. Without a matching
      // Access-Control-Allow-Origin the browser's CORS check fails anyway
      // (Fetch standard, CORS check), so the page cannot send or read.
      expect(res.headers['access-control-allow-credentials']).toBe('true');

      // A listed origin gets the grant on the same preflight.
      const listed = await server.inject({
        method: 'OPTIONS',
        url: '/v1/portal/support-cases',
        headers: {
          origin: 'https://portal.example.com',
          'access-control-request-method': 'POST',
        },
      });
      expect(listed.statusCode).toBe(204);
      expect(listed.headers['access-control-allow-origin']).toBe('https://portal.example.com');
      expect(listed.headers['access-control-allow-credentials']).toBe('true');
    });

    it('TC-CORS-03 refuses a credentialed portal POST from an unlisted origin without the CSRF header', async () => {
      const server = await buildCorsApp(list);
      const res = await server.inject({
        method: 'POST',
        url: '/v1/portal/support-cases',
        headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' },
        cookies: { portal_token: 'session-jwt', portal_csrf: 'csrf-secret' },
        payload: { subject: 'x' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'Invalid CSRF token', code: 'CSRF_INVALID' });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();

      // The same request with the token (only the portal can read the cookie) passes.
      const own = await server.inject({
        method: 'POST',
        url: '/v1/portal/support-cases',
        headers: {
          origin: 'https://portal.example.com',
          'content-type': 'application/json',
          'x-csrf-token': 'csrf-secret',
        },
        cookies: { portal_token: 'session-jwt', portal_csrf: 'csrf-secret' },
        payload: { subject: 'x' },
      });
      expect(own.statusCode).toBe(200);
    });

    it('leaves a request without an Origin unchanged', async () => {
      const server = await buildCorsApp(list);
      const res = await server.inject({ method: 'GET', url: '/ping' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('single origin', () => {
    it('TC-CORS-04 answers with the configured origin only, never the request origin', async () => {
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
      expect(other.headers['access-control-allow-origin']).not.toBe('https://evil.example.com');

      const preflight = await server.inject({
        method: 'OPTIONS',
        url: '/ping',
        headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' },
      });
      expect(preflight.headers['access-control-allow-origin']).toBe('https://csms.example.com');

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
