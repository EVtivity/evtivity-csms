// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerAuth } from '../plugins/auth.js';

describe('authenticate decorator with csms_token cookie', () => {
  async function buildApp() {
    process.env['JWT_SECRET'] = 'test-secret-for-cookie-auth-12345';
    const app = Fastify();
    await app.register(cookie, { secret: 'test-secret-for-cookie-auth-12345' });
    await registerAuth(app);

    app.get('/protected', { onRequest: [app.authenticate] }, async (request) => {
      return { userId: (request.user as { userId: string }).userId };
    });

    await app.ready();
    return app;
  }

  it('authenticates via Authorization header (existing behavior)', async () => {
    const app = await buildApp();
    const token = app.jwt.sign({ userId: 'u1', roleId: 'r1' }, { expiresIn: '1h' });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBe('u1');
    await app.close();
  });

  it('authenticates via csms_token cookie when no Authorization header', async () => {
    const app = await buildApp();
    const token = app.jwt.sign({ userId: 'u2', roleId: 'r2' }, { expiresIn: '1h' });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      cookies: { csms_token: token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBe('u2');
    await app.close();
  });

  it('returns 401 when no token provided at all', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 401 when csms_token cookie has invalid JWT', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      cookies: { csms_token: 'invalid-jwt' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('Authorization header takes priority over cookie', async () => {
    const app = await buildApp();
    const headerToken = app.jwt.sign({ userId: 'header-user', roleId: 'r1' }, { expiresIn: '1h' });
    const cookieToken = app.jwt.sign({ userId: 'cookie-user', roleId: 'r2' }, { expiresIn: '1h' });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${headerToken}` },
      cookies: { csms_token: cookieToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBe('header-user');
    await app.close();
  });
});
