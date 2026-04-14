// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerAuth } from '../plugins/auth.js';
import { clearAuthCookies } from '../lib/csms-cookies.js';

function isSecureRequest(request: {
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  return (
    request.headers['x-forwarded-proto'] === 'https' || request.headers['x-forwarded-ssl'] === 'on'
  );
}

describe('POST /v1/auth/logout', () => {
  async function buildApp() {
    process.env['JWT_SECRET'] = 'test-secret-for-logout-12345';
    const app = Fastify();
    await app.register(cookie, { secret: 'test-secret-for-logout-12345' });
    await registerAuth(app);

    app.post('/v1/auth/logout', { onRequest: [app.authenticate] }, async (request, reply) => {
      clearAuthCookies(reply, isSecureRequest(request));
      return { success: true };
    });

    await app.ready();
    return app;
  }

  it('returns 200 with { success: true } and clears cookies', async () => {
    const app = await buildApp();
    const token = app.jwt.sign({ userId: 'u1', roleId: 'r1' }, { expiresIn: '1h' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      cookies: { csms_token: token },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    const cookies = res.cookies as Array<{ name: string; maxAge?: number; value?: string }>;
    const authCookie = cookies.find((c) => c.name === 'csms_token');
    expect(authCookie).toBeDefined();

    const refreshCookie = cookies.find((c) => c.name === 'csms_refresh');
    expect(refreshCookie).toBeDefined();

    const csrfCookie = cookies.find((c) => c.name === 'csms_csrf');
    expect(csrfCookie).toBeDefined();

    await app.close();
  });

  it('returns 200 when authenticated via Authorization header', async () => {
    const app = await buildApp();
    const token = app.jwt.sign({ userId: 'u1', roleId: 'r1' }, { expiresIn: '1h' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    const cookies = res.cookies as Array<{ name: string }>;
    expect(cookies.find((c) => c.name === 'csms_token')).toBeDefined();
    expect(cookies.find((c) => c.name === 'csms_refresh')).toBeDefined();
    expect(cookies.find((c) => c.name === 'csms_csrf')).toBeDefined();

    await app.close();
  });

  it('returns 401 without auth', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
