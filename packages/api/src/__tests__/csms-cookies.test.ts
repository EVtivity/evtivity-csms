// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { setAuthCookies, clearAuthCookies } from '../lib/auth-cookies.js';

describe('CSMS cookie helpers', () => {
  it('setAuthCookies sets csms_token and csms_refresh as httpOnly and csms_csrf as readable', async () => {
    const app = Fastify();
    await app.register(cookie, { secret: 'test-cookie-secret-12345' });
    app.get('/test', (_req, reply) => {
      setAuthCookies('csms', reply, 'jwt-value', 'refresh-value', true);
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/test' });
    const cookies = res.cookies as Array<{
      name: string;
      httpOnly?: boolean;
      path?: string;
      sameSite?: string;
    }>;

    const authCookie = cookies.find((c) => c.name === 'csms_token');
    expect(authCookie).toBeDefined();
    expect(authCookie?.httpOnly).toBe(true);
    expect(authCookie?.path).toBe('/');
    expect(authCookie?.sameSite).toBe('Lax');

    const refreshCookie = cookies.find((c) => c.name === 'csms_refresh');
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie?.httpOnly).toBe(true);
    expect(refreshCookie?.path).toBe('/');
    expect(refreshCookie?.sameSite).toBe('Lax');

    const csrfCookie = cookies.find((c) => c.name === 'csms_csrf');
    expect(csrfCookie).toBeDefined();
    expect(csrfCookie?.httpOnly).toBeFalsy();
    expect(csrfCookie?.path).toBe('/');

    await app.close();
  });

  it('clearAuthCookies clears all three cookies', async () => {
    const app = Fastify();
    await app.register(cookie, { secret: 'test-cookie-secret-12345' });
    app.get('/test', (_req, reply) => {
      clearAuthCookies('csms', reply, true);
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/test' });
    const cookies = res.cookies as Array<{ name: string; maxAge?: number }>;
    const authCookie = cookies.find((c) => c.name === 'csms_token');
    expect(authCookie).toBeDefined();

    const refreshCookie = cookies.find((c) => c.name === 'csms_refresh');
    expect(refreshCookie).toBeDefined();

    const csrfCookie = cookies.find((c) => c.name === 'csms_csrf');
    expect(csrfCookie).toBeDefined();

    await app.close();
  });

  it('portal realm uses portal_token path /v1/portal and 7-day refresh', async () => {
    const app = Fastify();
    await app.register(cookie, { secret: 'test-cookie-secret-12345' });
    app.get('/test', (_req, reply) => {
      setAuthCookies('portal', reply, 'jwt-value', 'refresh-value', true);
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/test' });
    const cookies = res.cookies as Array<{ name: string; path?: string; maxAge?: number }>;

    const authCookie = cookies.find((c) => c.name === 'portal_token');
    expect(authCookie?.path).toBe('/v1/portal');

    const refreshCookie = cookies.find((c) => c.name === 'portal_refresh');
    expect(refreshCookie?.maxAge).toBe(7 * 24 * 60 * 60);

    await app.close();
  });
});
