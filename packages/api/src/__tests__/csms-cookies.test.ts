// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {
  setAuthCookies,
  clearAuthCookies,
  CSMS_ACCESS_COOKIE_MAX_AGE,
  CSMS_REFRESH_COOKIE_MAX_AGE,
} from '../lib/csms-cookies.js';

describe('CSMS cookie helpers', () => {
  it('setAuthCookies sets csms_token and csms_refresh as httpOnly and csms_csrf as readable', async () => {
    const app = Fastify();
    await app.register(cookie, { secret: 'test-cookie-secret-12345' });
    app.get('/test', (_req, reply) => {
      setAuthCookies(reply, 'jwt-value', 'refresh-value', true);
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
      clearAuthCookies(reply, true);
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

  it('CSMS_ACCESS_COOKIE_MAX_AGE is 1 hour', () => {
    expect(CSMS_ACCESS_COOKIE_MAX_AGE).toBe(60 * 60);
  });

  it('CSMS_REFRESH_COOKIE_MAX_AGE is 30 days', () => {
    expect(CSMS_REFRESH_COOKIE_MAX_AGE).toBe(30 * 24 * 60 * 60);
  });
});
