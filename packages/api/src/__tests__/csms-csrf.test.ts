// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';

const CSRF_SKIP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const CSMS_CSRF_SKIP_PATHS = new Set([
  '/v1/auth/login',
  '/v1/auth/mfa/verify',
  '/v1/auth/mfa/resend',
  '/v1/auth/forgot-password',
  '/v1/auth/reset-password',
  '/v1/health',
]);

function buildApp() {
  const app = Fastify();
  app.register(cookie);

  // Replicate the CSMS CSRF hook from app.ts
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0] ?? request.url;
    if (!url.startsWith('/v1/')) return;
    if (url.startsWith('/v1/portal/')) return;
    if (CSRF_SKIP_METHODS.has(request.method)) return;
    if (CSMS_CSRF_SKIP_PATHS.has(url)) return;
    if (url.startsWith('/v1/security/')) return;

    const authHeader = request.headers['authorization'];
    if (authHeader != null && authHeader !== '') return;

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const csmsToken = request.cookies?.['csms_token'];
    if (csmsToken == null || csmsToken === '') return;

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const cookieCsrf = request.cookies?.['csms_csrf'];
    const headerCsrf = request.headers['x-csrf-token'];
    if (
      cookieCsrf == null ||
      headerCsrf == null ||
      cookieCsrf === '' ||
      cookieCsrf !== headerCsrf
    ) {
      await reply.status(403).send({ error: 'Invalid CSRF token', code: 'CSRF_INVALID' });
    }
  });

  // Test routes
  app.get('/v1/stations', async () => ({ data: [] }));
  app.post('/v1/stations', async () => ({ created: true }));
  app.post('/v1/auth/login', async () => ({ token: 'abc' }));
  app.post('/v1/auth/mfa/verify', async () => ({ token: 'abc' }));
  app.post('/v1/security/recaptcha', async () => ({ ok: true }));
  app.post('/v1/portal/support-cases', async () => ({ created: true }));

  return app;
}

function cookieHeader(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

describe('CSMS CSRF validation', () => {
  it('GET requests with cookie auth pass without CSRF token', async () => {
    const app = buildApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/stations',
      headers: {
        cookie: cookieHeader({ csms_token: 'jwt-value' }),
      },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('POST with cookie auth but no CSRF token returns 403', async () => {
    const app = buildApp();
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/stations',
      headers: {
        cookie: cookieHeader({ csms_token: 'jwt-value' }),
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Invalid CSRF token', code: 'CSRF_INVALID' });
    await app.close();
  });

  it('POST with matching CSRF cookie and header passes', async () => {
    const app = buildApp();
    await app.ready();

    const csrfToken = 'valid-csrf-token-123';
    const res = await app.inject({
      method: 'POST',
      url: '/v1/stations',
      headers: {
        cookie: cookieHeader({ csms_token: 'jwt-value', csms_csrf: csrfToken }),
        'x-csrf-token': csrfToken,
      },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('POST with mismatched CSRF cookie and header returns 403', async () => {
    const app = buildApp();
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/stations',
      headers: {
        cookie: cookieHeader({ csms_token: 'jwt-value', csms_csrf: 'cookie-value' }),
        'x-csrf-token': 'different-header-value',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Invalid CSRF token', code: 'CSRF_INVALID' });
    await app.close();
  });

  it('POST with Authorization header (no cookies) passes without CSRF', async () => {
    const app = buildApp();
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/stations',
      headers: {
        authorization: 'Bearer some-jwt-token',
      },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('POST to skip paths passes without CSRF', async () => {
    const app = buildApp();
    await app.ready();

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: {
        cookie: cookieHeader({ csms_token: 'jwt-value' }),
      },
    });
    expect(loginRes.statusCode).toBe(200);

    const mfaRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      headers: {
        cookie: cookieHeader({ csms_token: 'jwt-value' }),
      },
    });
    expect(mfaRes.statusCode).toBe(200);

    await app.close();
  });

  it('POST to /v1/security/ paths passes without CSRF', async () => {
    const app = buildApp();
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/security/recaptcha',
      headers: {
        cookie: cookieHeader({ csms_token: 'jwt-value' }),
      },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('POST to portal routes is not affected by CSMS CSRF hook', async () => {
    const app = buildApp();
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/portal/support-cases',
      headers: {
        cookie: cookieHeader({ csms_token: 'jwt-value' }),
      },
    });

    // Should pass because CSMS CSRF hook skips /v1/portal/ routes
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('POST without any cookies or auth header passes (not cookie auth)', async () => {
    const app = buildApp();
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/stations',
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
