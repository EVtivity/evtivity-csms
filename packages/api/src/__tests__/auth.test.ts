// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { driverTokenRejection, operatorTokenRejection, registerAuth } from '../plugins/auth.js';
import { optionalDriverId } from '../lib/optional-driver.js';
import { healthRoutes } from '../routes/health.js';
import { getUserSessionState } from '../lib/user-active.js';
import { getDriverSessionState } from '../lib/driver-active.js';
import { signDriverAccessToken } from '../lib/driver-session.js';

describe('Auth plugin', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);

    app.get(
      '/protected',
      {
        onRequest: [app.authenticate],
      },
      async () => {
        return { data: 'secret' };
      },
    );

    await app.register(healthRoutes);
    await app.ready();
  });

  it('allows access to unprotected routes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/health',
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects unauthenticated requests to protected routes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts requests with valid JWT', async () => {
    const token = app.jwt.sign({ userId: 'test-id', roleId: 'test-role' });

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body['data']).toBe('secret');
  });

  it('refuses a valid JWT of a deactivated operator with ACCOUNT_DEACTIVATED', async () => {
    vi.mocked(getUserSessionState).mockResolvedValueOnce({ active: false, sessionVersion: 0 });
    const token = app.jwt.sign({ userId: 'usr_off', roleId: 'test-role' });

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Account deactivated', code: 'ACCOUNT_DEACTIVATED' });
    expect(vi.mocked(getUserSessionState)).toHaveBeenCalledWith('usr_off');
  });

  it('rejects requests with invalid JWT', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        authorization: 'Bearer invalid-token',
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('accepts a token of the current session version, a token without one as version 0', async () => {
    vi.mocked(getUserSessionState).mockResolvedValueOnce({ active: true, sessionVersion: 3 });
    const current = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        authorization: `Bearer ${app.jwt.sign({ userId: 'usr_sv', roleId: 'r', sv: 3 })}`,
      },
    });
    expect(current.statusCode).toBe(200);

    const legacy = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${app.jwt.sign({ userId: 'usr_sv0', roleId: 'r' })}` },
    });
    expect(legacy.statusCode).toBe(200);
  });

  it('refuses a token issued before the session version moved on', async () => {
    vi.mocked(getUserSessionState).mockResolvedValueOnce({ active: true, sessionVersion: 4 });
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        authorization: `Bearer ${app.jwt.sign({ userId: 'usr_sv', roleId: 'r', sv: 3 })}`,
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Session ended', code: 'UNAUTHORIZED' });
  });
});

describe('Driver session version (driverTokenRejection)', () => {
  it('accepts a token of the current version and a token without one at version 0', async () => {
    vi.mocked(getDriverSessionState).mockResolvedValueOnce({ active: true, sessionVersion: 2 });
    expect(await driverTokenRejection({ driverId: 'drv_sv', type: 'driver', sv: 2 })).toBeNull();
    vi.mocked(getDriverSessionState).mockResolvedValueOnce({ active: true, sessionVersion: 0 });
    expect(await driverTokenRejection({ driverId: 'drv_old', type: 'driver' })).toBeNull();
  });

  it('refuses a token issued before the version moved on, and a pre-release token after a bump', async () => {
    vi.mocked(getDriverSessionState).mockResolvedValueOnce({ active: true, sessionVersion: 3 });
    expect(await driverTokenRejection({ driverId: 'drv_sv', type: 'driver', sv: 2 })).toEqual({
      status: 401,
      error: 'Session ended',
      code: 'UNAUTHORIZED',
    });
    vi.mocked(getDriverSessionState).mockResolvedValueOnce({ active: true, sessionVersion: 1 });
    expect(await driverTokenRejection({ driverId: 'drv_old', type: 'driver' })).toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(getDriverSessionState).toHaveBeenCalledWith('drv_old');
  });

  it('answers ACCOUNT_DEACTIVATED before the version for a deactivated driver', async () => {
    vi.mocked(getDriverSessionState).mockResolvedValueOnce({ active: false, sessionVersion: 0 });
    expect(await driverTokenRejection({ driverId: 'drv_off', type: 'driver', sv: 5 })).toEqual({
      status: 401,
      error: 'Account deactivated',
      code: 'ACCOUNT_DEACTIVATED',
    });
  });

  it('signs driver tokens with sv', async () => {
    const app = Fastify();
    await registerAuth(app);
    await app.ready();
    const token = signDriverAccessToken(app, { id: 'drv_sv', sessionVersion: 7 }, 60);
    expect(app.jwt.decode<Record<string, unknown>>(token)).toMatchObject({
      driverId: 'drv_sv',
      type: 'driver',
      sv: 7,
    });
    await app.close();
  });
});

describe('MFA enrollment token', () => {
  const enrollment = { userId: 'usr_enroll', roleId: 'rol_1', mfaEnrollment: true, sv: 0 };

  it('is refused on operator routes with 401 MFA_ENROLLMENT_REQUIRED, Bearer and cookie', async () => {
    const app = Fastify();
    await app.register(cookie, { secret: 'test-cookie-secret-12345' });
    await registerAuth(app);
    app.get('/protected', { onRequest: [app.authenticate] }, async () => ({ ok: true }));
    app.get('/driver', { onRequest: [app.authenticateDriver] }, async () => ({ ok: true }));
    await app.ready();
    const token = app.jwt.sign(enrollment, { expiresIn: '10m' });

    const bearer = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(bearer.statusCode).toBe(401);
    expect(bearer.json()).toEqual({
      error: 'Set up MFA to sign in',
      code: 'MFA_ENROLLMENT_REQUIRED',
    });

    const cookieRes = await app.inject({
      method: 'GET',
      url: '/protected',
      cookies: { csms_token: token },
    });
    expect(cookieRes.statusCode).toBe(401);
    expect(cookieRes.json().code).toBe('MFA_ENROLLMENT_REQUIRED');

    const driverRes = await app.inject({
      method: 'GET',
      url: '/driver',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(driverRes.statusCode).toBe(401);
    expect(driverRes.json().code).toBe('MFA_ENROLLMENT_REQUIRED');

    // A public portal route treats the caller as anonymous.
    const anonymous = await optionalDriverId({
      jwtVerify: () => Promise.resolve({ ...enrollment, type: 'driver', driverId: 'drv_1' }),
    } as never);
    expect(anonymous).toBeNull();
    await app.close();
  });

  it('is refused by the shared token checks the event streams use', async () => {
    expect(await operatorTokenRejection(enrollment)).toEqual({
      error: 'Set up MFA to sign in',
      code: 'MFA_ENROLLMENT_REQUIRED',
    });
    expect(await driverTokenRejection(enrollment)).toEqual({
      status: 401,
      error: 'Set up MFA to sign in',
      code: 'MFA_ENROLLMENT_REQUIRED',
    });
    // A session token of the same user still passes.
    expect(
      await operatorTokenRejection({ userId: 'usr_enroll', roleId: 'rol_1', sv: 0 }),
    ).toBeNull();
  });
});

describe('Auth plugin with cookies', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(cookie, { secret: 'test-cookie-secret-0123456789abcdef' });
    await registerAuth(app);
    app.get('/protected', { onRequest: [app.authenticate] }, () => ({ data: 'secret' }));
    await app.ready();
  });

  it('accepts the csms_token cookie without an Authorization header', async () => {
    const token = app.jwt.sign({ userId: 'usr_cookie', roleId: 'r' });
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      cookies: { csms_token: app.signCookie(token) },
    });
    expect(response.statusCode).toBe(200);
  });

  it('never falls back to the cookie when an Authorization header is present', async () => {
    // The CSRF hook skips requests with an Authorization header, so a cookie
    // session must not pass behind a bogus header.
    const token = app.jwt.sign({ userId: 'usr_cookie', roleId: 'r' });
    const get = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer not-a-token' },
      cookies: { csms_token: app.signCookie(token) },
    });
    expect(get.statusCode).toBe(401);
    expect(get.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('authenticateDriver credential source', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(cookie, { secret: 'test-cookie-secret-0123456789abcdef' });
    await registerAuth(app);
    app.get('/driver', { onRequest: [app.authenticateDriver] }, (request) => ({
      source: request.driverAuthSource,
    }));
    await app.ready();
  });

  function driverToken(): string {
    return signDriverAccessToken(app, { id: 'drv_source', sessionVersion: 0 }, 3600);
  }

  it('records the portal_token cookie as the credential without an Authorization header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/driver',
      cookies: { portal_token: app.signCookie(driverToken()) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ source: 'cookie' });
  });

  it('records a Bearer token as the credential', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/driver',
      headers: { authorization: `Bearer ${driverToken()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ source: 'bearer' });
  });

  it('refuses another Authorization scheme instead of falling back to the cookie', async () => {
    // @fastify/jwt reads only a Bearer header and would verify the cookie, so the
    // request would pass as a cookie session that claims a header.
    for (const authorization of ['Basic junk', 'x', `Token ${driverToken()}`]) {
      const res = await app.inject({
        method: 'GET',
        url: '/driver',
        headers: { authorization },
        cookies: { portal_token: app.signCookie(driverToken()) },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    }
  });
});
