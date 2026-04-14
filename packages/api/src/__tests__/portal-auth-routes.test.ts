// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';

// DB mock helpers
let dbResults: unknown[][] = [];
let dbCallIndex = 0;
function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}
function makeChain() {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'values',
    'returning',
    'set',
    'onConflictDoUpdate',
    'delete',
    'insert',
    'update',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const r = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(r).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  chain['catch'] = (reject?: (r: unknown) => unknown) => Promise.resolve([]).catch(reject);
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => makeChain()),
        insert: vi.fn(() => makeChain()),
        update: vi.fn(() => makeChain()),
        delete: vi.fn(() => makeChain()),
      };
      return fn(tx);
    }),
  },
  client: {},
  drivers: {},
  userTokens: {},
  getRecaptchaConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  isNull: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
}));

vi.mock('argon2', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$argon2id$hashed_password'),
    verify: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('@evtivity/lib', () => ({
  dispatchDriverNotification: vi.fn(),
  dispatchSystemNotification: vi.fn().mockResolvedValue(undefined),
  verifyRecaptcha: vi.fn().mockResolvedValue({ success: true }),
  decryptString: vi.fn().mockReturnValue('decrypted'),
  createMfaChallenge: vi.fn().mockResolvedValue({ challengeId: 1, code: '123456' }),
  verifyMfaChallenge: vi.fn().mockResolvedValue(true),
  verifyTotpCode: vi.fn().mockReturnValue(true),
}));

vi.mock('../services/refresh-token.service.js', () => ({
  createRefreshToken: vi
    .fn()
    .mockResolvedValue({ rawToken: 'mock-refresh-token', expiresAt: new Date() }),
  validateAndRotateRefreshToken: vi.fn().mockResolvedValue(null),
  revokeRefreshToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/pubsub.js', () => ({
  getPubSub: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
  })),
}));

vi.mock('../lib/template-dirs.js', () => ({
  ALL_TEMPLATES_DIRS: ['/mock/templates'],
  API_TEMPLATES_DIR: '/mock/templates',
  OCPP_TEMPLATES_DIR: '/mock/templates',
}));

import { registerAuth } from '../plugins/auth.js';
import { portalAuthRoutes } from '../routes/portal/auth.js';

const VALID_DRIVER_ID = 'drv_000000000001';
const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';
const DRIVER_ID = 'drv_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie, { secret: 'test-cookie-secret-12345' });
  await registerAuth(app);
  await app.register(portalAuthRoutes);
  await app.ready();
  return app;
}

function parseCookies(response: {
  headers: Record<string, unknown>;
}): Map<string, { value: string; httpOnly: boolean }> {
  const result = new Map<string, { value: string; httpOnly: boolean }>();
  const raw = response.headers['set-cookie'] as string | string[] | undefined;
  if (raw == null) return result;

  const entries = Array.isArray(raw) ? raw : [raw];
  for (const entry of entries) {
    const parts = entry.split(';').map((s) => s.trim());
    const [nameValue] = parts;
    if (nameValue == null) continue;
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx === -1) continue;
    const name = nameValue.slice(0, eqIdx);
    const value = nameValue.slice(eqIdx + 1);
    const httpOnly = parts.some((p) => p.toLowerCase() === 'httponly');
    result.set(name, { value, httpOnly });
  }
  return result;
}

describe('Portal auth routes - handler logic', () => {
  let app: FastifyInstance;
  let driverToken: string;
  let signedDriverToken: string;

  beforeAll(async () => {
    app = await buildApp();
    driverToken = app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' });
    signedDriverToken = app.signCookie(driverToken);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
  });

  describe('POST /v1/portal/auth/register', () => {
    it('returns 400 with invalid email', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/register',
        payload: {
          firstName: 'John',
          lastName: 'Doe',
          email: 'not-an-email',
          password: 'TestPassword1',
        },
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 400 with short password', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/register',
        payload: {
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          password: 'short',
        },
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 400 with missing required fields', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/register',
        payload: {
          email: 'john@example.com',
          password: 'TestPassword1',
        },
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 409 when email already registered', async () => {
      setupDbResults([{ id: VALID_DRIVER_ID }]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/register',
        payload: {
          firstName: 'John',
          lastName: 'Doe',
          email: 'existing@example.com',
          password: 'TestPassword1',
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('EMAIL_EXISTS');
    });

    it('registers a new driver and sets auth cookies', async () => {
      const driverRow = {
        id: DRIVER_ID,
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
        phone: null,
        language: 'en',
        timezone: 'America/New_York',
        themePreference: 'light',
        distanceUnit: 'miles',
        isActive: true,
        emailVerified: false,
        createdAt: '2024-01-01',
      };
      setupDbResults([], [driverRow], []);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/register',
        payload: {
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          password: 'TestPassword1',
        },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.token).toBeUndefined();
      expect(body.driver.id).toBe(DRIVER_ID);
      expect(body.driver.firstName).toBe('John');

      const cookies = parseCookies(response);
      expect(cookies.has('portal_token')).toBe(true);
      expect(cookies.get('portal_token')?.httpOnly).toBe(true);
      expect(cookies.has('portal_refresh')).toBe(true);
      expect(cookies.get('portal_refresh')?.httpOnly).toBe(true);
      expect(cookies.has('portal_csrf')).toBe(true);
      expect(cookies.get('portal_csrf')?.httpOnly).toBe(false);
    });

    it('returns 500 when insert returns no rows', async () => {
      setupDbResults([], []);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/register',
        payload: {
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          password: 'TestPassword1',
        },
      });
      expect(response.statusCode).toBe(500);
    });
  });

  describe('POST /v1/portal/auth/login', () => {
    it('returns 400 with invalid email format', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/login',
        payload: {
          email: 'not-an-email',
          password: 'TestPassword1',
        },
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 401 when driver not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/login',
        payload: {
          email: 'unknown@example.com',
          password: 'TestPassword1',
        },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('INVALID_CREDENTIALS');
    });

    it('returns 401 when driver has no password hash', async () => {
      setupDbResults([
        {
          id: DRIVER_ID,
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          passwordHash: null,
          phone: null,
          language: 'en',
          timezone: 'America/New_York',
          isActive: true,
          createdAt: '2024-01-01',
          registrationSource: 'portal',
        },
      ]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/login',
        payload: {
          email: 'john@example.com',
          password: 'TestPassword1',
        },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('INVALID_CREDENTIALS');
    });

    it('returns 401 when password is invalid', async () => {
      const argon2 = await import('argon2');
      vi.mocked(argon2.default.verify).mockResolvedValueOnce(false);

      setupDbResults([
        {
          id: DRIVER_ID,
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          passwordHash: '$argon2id$hashed',
          phone: null,
          language: 'en',
          timezone: 'America/New_York',
          isActive: true,
          createdAt: '2024-01-01',
          registrationSource: 'portal',
        },
      ]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/login',
        payload: {
          email: 'john@example.com',
          password: 'WrongPassword1',
        },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('INVALID_CREDENTIALS');
    });

    it('returns driver and sets auth cookies on successful login', async () => {
      const argon2 = await import('argon2');
      vi.mocked(argon2.default.verify).mockResolvedValueOnce(true);

      setupDbResults([
        {
          id: DRIVER_ID,
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          passwordHash: '$argon2id$hashed',
          phone: '555-1234',
          language: 'en',
          timezone: 'America/New_York',
          themePreference: 'light',
          distanceUnit: 'miles',
          isActive: true,
          emailVerified: true,
          createdAt: '2024-01-01',
          registrationSource: 'portal',
        },
      ]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/login',
        payload: {
          email: 'john@example.com',
          password: 'TestPassword1',
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.token).toBeUndefined();
      expect(body.driver.id).toBe(DRIVER_ID);
      expect(body.driver.email).toBe('john@example.com');
      expect(body.driver.firstName).toBe('John');

      const cookies = parseCookies(response);
      expect(cookies.has('portal_token')).toBe(true);
      expect(cookies.get('portal_token')?.httpOnly).toBe(true);
      expect(cookies.has('portal_refresh')).toBe(true);
      expect(cookies.get('portal_refresh')?.httpOnly).toBe(true);
      expect(cookies.has('portal_csrf')).toBe(true);
      expect(cookies.get('portal_csrf')?.httpOnly).toBe(false);
    });
  });

  describe('POST /v1/portal/auth/logout', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/logout',
      });
      expect(response.statusCode).toBe(401);
    });

    it('clears cookies and returns 204', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/logout',
        cookies: { portal_token: signedDriverToken },
      });
      expect(response.statusCode).toBe(204);

      const cookies = parseCookies(response);
      expect(cookies.has('portal_token')).toBe(true);
      expect(cookies.get('portal_token')?.value).toBe('');
      expect(cookies.has('portal_refresh')).toBe(true);
      expect(cookies.get('portal_refresh')?.value).toBe('');
      expect(cookies.has('portal_csrf')).toBe(true);
      expect(cookies.get('portal_csrf')?.value).toBe('');
    });
  });

  describe('GET /v1/portal/auth/me', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/portal/auth/me',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 with operator token', async () => {
      const operatorToken = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
      const response = await app.inject({
        method: 'GET',
        url: '/portal/auth/me',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(response.statusCode).toBe(403);
    });

    it('authenticates via cookie', async () => {
      setupDbResults([
        {
          id: DRIVER_ID,
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          phone: '555-1234',
          language: 'en',
          timezone: 'America/New_York',
          themePreference: 'light',
          distanceUnit: 'miles',
          isActive: true,
          emailVerified: true,
          createdAt: '2024-01-01',
        },
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/auth/me',
        cookies: { portal_token: signedDriverToken },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().id).toBe(DRIVER_ID);
    });

    it('returns 404 when driver not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/auth/me',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('DRIVER_NOT_FOUND');
    });

    it('returns driver profile for authenticated driver', async () => {
      setupDbResults([
        {
          id: DRIVER_ID,
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          phone: '555-1234',
          language: 'en',
          timezone: 'America/New_York',
          themePreference: 'light',
          distanceUnit: 'miles',
          isActive: true,
          emailVerified: true,
          createdAt: '2024-01-01',
        },
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/auth/me',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(DRIVER_ID);
      expect(body.email).toBe('john@example.com');
    });
  });

  describe('POST /v1/portal/auth/verify-email', () => {
    it('returns 400 with missing token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/verify-email',
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 400 when token not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/verify-email',
        payload: { token: 'invalid-token' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('INVALID_TOKEN');
    });

    it('returns 400 when token is expired', async () => {
      setupDbResults([{ id: 1, driverId: DRIVER_ID, expiresAt: new Date(Date.now() - 60000) }]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/verify-email',
        payload: { token: 'expired-token' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('INVALID_TOKEN');
    });

    it('verifies email with valid token', async () => {
      setupDbResults(
        [{ id: 1, driverId: DRIVER_ID, expiresAt: new Date(Date.now() + 3600000) }],
        [], // update drivers
        [], // revoke token
        [{ id: DRIVER_ID, firstName: 'John', lastName: 'Doe', email: 'john@example.com' }],
      );
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/verify-email',
        payload: { token: 'valid-token-hex' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });
  });

  describe('POST /v1/portal/auth/resend-verification', () => {
    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/resend-verification',
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 400 when already verified', async () => {
      setupDbResults([
        {
          id: DRIVER_ID,
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          phone: null,
          language: 'en',
          emailVerified: true,
        },
      ]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/resend-verification',
        cookies: { portal_token: signedDriverToken },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('ALREADY_VERIFIED');
    });

    it('resends verification for unverified driver', async () => {
      setupDbResults(
        [
          {
            id: DRIVER_ID,
            firstName: 'John',
            lastName: 'Doe',
            email: 'john@example.com',
            phone: null,
            language: 'en',
            emailVerified: false,
          },
        ],
        [], // revoke old tokens
        [], // insert new token
      );
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/resend-verification',
        cookies: { portal_token: signedDriverToken },
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });
  });

  describe('GET /v1/portal/auth/me - emailVerified', () => {
    it('returns emailVerified in driver profile', async () => {
      setupDbResults([
        {
          id: DRIVER_ID,
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          phone: '555-1234',
          language: 'en',
          timezone: 'America/New_York',
          themePreference: 'light',
          distanceUnit: 'miles',
          isActive: true,
          emailVerified: true,
          createdAt: '2024-01-01',
        },
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/auth/me',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().emailVerified).toBe(true);
    });
  });

  describe('Registration - emailVerified', () => {
    it('returns emailVerified: false for new registrations', async () => {
      const driverRow = {
        id: DRIVER_ID,
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
        phone: null,
        language: 'en',
        timezone: 'America/New_York',
        themePreference: 'light',
        distanceUnit: 'miles',
        isActive: true,
        emailVerified: false,
        createdAt: '2024-01-01',
      };
      setupDbResults(
        [], // no existing driver
        [driverRow], // insert returns driver
        [], // insert verification token
      );
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/register',
        payload: {
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          password: 'TestPassword1',
        },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().driver.emailVerified).toBe(false);
    });
  });

  describe('CSRF validation', () => {
    let csrfApp: FastifyInstance;
    let csrfDriverToken: string;
    const csrfValue = 'test-csrf-token';

    let signedCsrfDriverToken: string;

    beforeAll(async () => {
      csrfApp = Fastify();
      await csrfApp.register(cookie, { secret: 'test-cookie-secret-12345' });
      await registerAuth(csrfApp);

      // Register CSRF hook
      const CSRF_SKIP_PATHS = new Set(['/portal/auth/login', '/portal/auth/register']);
      const CSRF_SKIP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

      csrfApp.addHook('onRequest', async (request, reply) => {
        const url = request.url.split('?')[0] ?? request.url;
        if (!url.startsWith('/portal/')) return;
        if (CSRF_SKIP_METHODS.has(request.method)) return;
        if (CSRF_SKIP_PATHS.has(url)) return;

        const cookieToken = request.cookies['portal_csrf'];
        const headerToken = request.headers['x-csrf-token'];
        if (
          cookieToken == null ||
          headerToken == null ||
          cookieToken === '' ||
          cookieToken !== headerToken
        ) {
          await reply.status(403).send({ error: 'Invalid CSRF token', code: 'CSRF_INVALID' });
        }
      });

      await csrfApp.register(portalAuthRoutes);
      await csrfApp.ready();
      csrfDriverToken = csrfApp.jwt.sign({ driverId: DRIVER_ID, type: 'driver' });
      signedCsrfDriverToken = csrfApp.signCookie(csrfDriverToken);
    });

    afterAll(async () => {
      await csrfApp.close();
    });

    it('rejects portal POST without CSRF token', async () => {
      const response = await csrfApp.inject({
        method: 'POST',
        url: '/portal/auth/logout',
        cookies: { portal_token: signedCsrfDriverToken },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('CSRF_INVALID');
    });

    it('rejects portal POST with mismatched CSRF token', async () => {
      const response = await csrfApp.inject({
        method: 'POST',
        url: '/portal/auth/logout',
        cookies: { portal_token: signedCsrfDriverToken, portal_csrf: csrfValue },
        headers: { 'x-csrf-token': 'wrong-token' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('CSRF_INVALID');
    });

    it('allows portal POST with matching CSRF token', async () => {
      const response = await csrfApp.inject({
        method: 'POST',
        url: '/portal/auth/logout',
        cookies: { portal_token: signedCsrfDriverToken, portal_csrf: csrfValue },
        headers: { 'x-csrf-token': csrfValue },
      });
      expect(response.statusCode).toBe(204);
    });

    it('skips CSRF for login endpoint', async () => {
      setupDbResults([]);
      const response = await csrfApp.inject({
        method: 'POST',
        url: '/portal/auth/login',
        payload: { email: 'test@example.com', password: 'TestPassword1' },
      });
      // Should reach the handler (401 from bad credentials), not 403 from CSRF
      expect(response.statusCode).toBe(401);
    });

    it('skips CSRF for GET requests', async () => {
      setupDbResults([
        {
          id: DRIVER_ID,
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          phone: null,
          language: 'en',
          timezone: 'America/New_York',
          themePreference: 'light',
          distanceUnit: 'miles',
          isActive: true,
          emailVerified: true,
          createdAt: '2024-01-01',
        },
      ]);
      const response = await csrfApp.inject({
        method: 'GET',
        url: '/portal/auth/me',
        cookies: { portal_token: signedCsrfDriverToken },
      });
      expect(response.statusCode).toBe(200);
    });
  });
});
