// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import { DEFAULT_SESSION_LIFETIMES, type SessionLifetimes } from '@evtivity/lib/session-lifetimes';

const { inserted, getSessionLifetimes } = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
  getSessionLifetimes: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return Promise.resolve([]);
      },
    }),
  },
  getSessionLifetimes,
  getSsoConfig: vi.fn().mockResolvedValue(null),
  refreshTokens: {},
  users: {},
}));
vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: vi.fn().mockResolvedValue(undefined) }),
}));

import { issueOperatorSession } from '../lib/operator-session.js';
import { issueDriverSession, issueDriverTokens } from '../lib/driver-session.js';

const CUSTOM: SessionLifetimes = {
  operatorAccessMinutes: 15,
  operatorRefreshDays: 7,
  driverAccessMinutes: 30,
  driverRefreshDays: 60,
};
const DAY_S = 24 * 60 * 60;
const MOBILE = { 'x-client': 'mobile', 'x-device-id': 'device-1' };

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie, { secret: 'test-cookie-secret-12345' });
  await app.register(jwt, { secret: 'x'.repeat(32) });
  app.post('/operator', async (request, reply) => {
    const token = await issueOperatorSession(app, request, reply, {
      id: 'usr_1',
      roleId: 'rol_1',
      sessionVersion: 0,
    });
    return { token };
  });
  app.post('/driver', async (request, reply) => {
    await issueDriverSession(app, request, reply, { id: 'drv_1' });
  });
  app.post('/driver-refresh', async (request, reply) => {
    const tokens = await issueDriverTokens(app, request, reply, 'drv_1');
    return tokens ?? { success: true };
  });
  await app.ready();
  return app;
}

function cookieAge(res: LightMyRequestResponse, name: string): number | undefined {
  return (res.cookies as Array<{ name: string; maxAge?: number }>).find((c) => c.name === name)
    ?.maxAge;
}

function lifetime(app: FastifyInstance, token: string): number {
  const claims = app.jwt.decode<{ exp: number; iat: number }>(token);
  if (claims == null) throw new Error('token does not decode');
  return claims.exp - claims.iat;
}

/** Days from now to the `expiresAt` of the refresh row written last. */
function rowDays(): number {
  const row = inserted.at(-1);
  const expiresAt = row?.['expiresAt'];
  if (!(expiresAt instanceof Date)) throw new Error('no refresh row');
  return Math.round((expiresAt.getTime() - Date.now()) / (DAY_S * 1000));
}

describe('token lifetimes from the session settings', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    inserted.length = 0;
    getSessionLifetimes.mockReset();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('configured lifetimes', () => {
    beforeEach(() => {
      getSessionLifetimes.mockResolvedValue(CUSTOM);
    });

    it('operator: access token, access and CSRF cookies 15 min, refresh cookie and row 7 d', async () => {
      const res = await app.inject({ method: 'POST', url: '/operator' });
      expect(res.statusCode).toBe(200);
      expect(lifetime(app, res.json<{ token: string }>().token)).toBe(900);
      expect(cookieAge(res, 'csms_token')).toBe(900);
      expect(cookieAge(res, 'csms_csrf')).toBe(900);
      expect(cookieAge(res, 'csms_refresh')).toBe(7 * DAY_S);
      expect(rowDays()).toBe(7);
      expect(inserted.at(-1)?.['userId']).toBe('usr_1');
      expect(getSessionLifetimes).toHaveBeenCalledTimes(1);
    });

    it('driver web: access token and cookie 30 min, refresh cookie and row both 60 d', async () => {
      const res = await app.inject({ method: 'POST', url: '/driver' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ driver: { id: 'drv_1' } });
      const token = (res.cookies as Array<{ name: string; value: string }>).find(
        (c) => c.name === 'portal_token',
      )?.value;
      const unsigned = app.unsignCookie(token ?? '');
      expect(unsigned.valid).toBe(true);
      expect(lifetime(app, unsigned.value ?? '')).toBe(1800);
      expect(cookieAge(res, 'portal_token')).toBe(1800);
      expect(cookieAge(res, 'portal_refresh')).toBe(60 * DAY_S);
      expect(rowDays()).toBe(60);
    });

    it('driver mobile: expiresIn and token 1800 s, device-bound 60 d row, no cookies', async () => {
      const res = await app.inject({ method: 'POST', url: '/driver', headers: MOBILE });
      const body = res.json<{ token: string; refreshToken: string; expiresIn: number }>();
      expect(body.expiresIn).toBe(1800);
      expect(lifetime(app, body.token)).toBe(1800);
      expect(typeof body.refreshToken).toBe('string');
      expect(res.cookies).toHaveLength(0);
      expect(rowDays()).toBe(60);
      expect(inserted.at(-1)?.['deviceId']).toBe('device-1');
    });

    it('driver refresh rotation: mobile tokens and web cookies follow the driver lifetimes', async () => {
      const mobile = await app.inject({ method: 'POST', url: '/driver-refresh', headers: MOBILE });
      const body = mobile.json<{ token: string; expiresIn: number }>();
      expect(body.expiresIn).toBe(1800);
      expect(lifetime(app, body.token)).toBe(1800);
      expect(rowDays()).toBe(60);

      const web = await app.inject({ method: 'POST', url: '/driver-refresh' });
      expect(web.json()).toEqual({ success: true });
      expect(cookieAge(web, 'portal_token')).toBe(1800);
      expect(cookieAge(web, 'portal_refresh')).toBe(60 * DAY_S);
      expect(rowDays()).toBe(60);
    });
  });

  describe('default lifetimes', () => {
    beforeEach(() => {
      getSessionLifetimes.mockResolvedValue({ ...DEFAULT_SESSION_LIFETIMES });
    });

    it('operator keeps 1 h access and 30 d refresh', async () => {
      const res = await app.inject({ method: 'POST', url: '/operator' });
      expect(lifetime(app, res.json<{ token: string }>().token)).toBe(3600);
      expect(cookieAge(res, 'csms_token')).toBe(3600);
      expect(cookieAge(res, 'csms_refresh')).toBe(30 * DAY_S);
      expect(rowDays()).toBe(30);
    });

    it('driver keeps 1 h access; the portal refresh cookie now matches its 30 d row', async () => {
      const web = await app.inject({ method: 'POST', url: '/driver' });
      expect(cookieAge(web, 'portal_token')).toBe(3600);
      expect(cookieAge(web, 'portal_refresh')).toBe(30 * DAY_S);
      expect(rowDays()).toBe(30);

      const mobile = await app.inject({ method: 'POST', url: '/driver', headers: MOBILE });
      expect(mobile.json<{ expiresIn: number }>().expiresIn).toBe(3600);
      expect(rowDays()).toBe(30);
    });
  });
});
