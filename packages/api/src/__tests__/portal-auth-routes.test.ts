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
  getSessionLifetimes: vi.fn(async () => ({
    ...(await import('@evtivity/lib/session-lifetimes')).DEFAULT_SESSION_LIFETIMES,
  })),
  getPasswordPolicy: vi.fn().mockResolvedValue({
    minLength: 12,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSymbol: false,
  }),
  writeAudit: vi.fn(() => Promise.resolve()),
  userAuditLog: { _table: 'user_audit_log' },
  driverAuditLog: { _table: 'driver_audit_log' },
  stationAuditLog: { _table: 'station_audit_log' },
  sessionAuditLog: { _table: 'session_audit_log' },
  apiKeyAuditLog: { _table: 'api_key_audit_log' },
  ACCOUNT_INVOICE_RECIPIENTS: ['fleet', 'member'],
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
  drivers: { passwordHash: 'drivers.password_hash', registrationSource: 'drivers.source' },
  userTokens: {},
  getRecaptchaConfig: vi.fn().mockResolvedValue(null),
  isPortalRegistrationEnabled: vi.fn().mockResolvedValue(true),
  resolveAccountBilling: vi.fn().mockResolvedValue(null),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  isNull: vi.fn(),
  isNotNull: vi.fn(),
  gt: vi.fn(),
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
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  AppError: class AppError extends Error {
    constructor(
      message: string,
      public readonly statusCode: number,
      public readonly code: string,
    ) {
      super(message);
    }
  },
  dispatchDriverNotification: vi.fn(),
  dispatchSystemNotification: vi.fn().mockResolvedValue(undefined),
  verifyRecaptcha: vi.fn().mockResolvedValue({ success: true }),
  decryptString: vi.fn().mockReturnValue('decrypted'),
  createMfaChallenge: vi.fn().mockResolvedValue({ challengeId: 1, code: '123456' }),
  verifyMfaChallenge: vi.fn().mockResolvedValue('verified'),
  verifyTotpCode: vi.fn().mockReturnValue(true),
}));

vi.mock('../services/refresh-token.service.js', () => ({
  createRefreshToken: vi
    .fn()
    .mockResolvedValue({ rawToken: 'mock-refresh-token', expiresAt: new Date() }),
  validateAndRotateRefreshToken: vi.fn().mockResolvedValue(null),
  revokeRefreshToken: vi.fn().mockResolvedValue(undefined),
  endDriverSessions: vi.fn().mockResolvedValue(undefined),
  bumpDriverSessionVersion: vi.fn().mockResolvedValue(1),
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
  })),
}));

vi.mock('@evtivity/services/template-dirs', () => ({
  ALL_TEMPLATES_DIRS: ['/mock/templates'],
  API_TEMPLATES_DIR: '/mock/templates',
  OCPP_TEMPLATES_DIR: '/mock/templates',
}));

const signupLimits = vi.hoisted(() => ({
  registrationPhone: vi.fn((phone: string | undefined) =>
    phone == null || phone === '' ? null : phone,
  ),
  isPhoneRegistrationLimited: vi.fn().mockResolvedValue(false),
  verificationResendRetryAfter: vi.fn().mockResolvedValue(null),
}));

vi.mock('../lib/signup-limits.js', () => signupLimits);

const { activateDriverPortalMock } = vi.hoisted(() => ({
  activateDriverPortalMock: vi.fn(),
}));

vi.mock('../services/driver-portal-access.service.js', () => ({
  activateDriverPortal: activateDriverPortalMock,
}));

import { eq, isNotNull } from 'drizzle-orm';
import { AppError, dispatchSystemNotification } from '@evtivity/lib';
import { db, resolveAccountBilling, writeAudit, driverAuditLog } from '@evtivity/database';
import { registerAuth } from '../plugins/auth.js';
import { portalAuthRoutes } from '../routes/portal/auth.js';
import * as argon2Module from 'argon2';

/** The audit rows written through the mocked writeAudit: [table, args]. */
function auditCalls(): { table: unknown; args: Record<string, unknown> }[] {
  return vi.mocked(writeAudit).mock.calls.map(([config, args]) => ({
    table: (config as { table: unknown }).table,
    args: args as unknown as Record<string, unknown>,
  }));
}

const VALID_DRIVER_ID = 'drv_000000000001';
const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';
// The billing address columns of a driver row (GET /v1/portal/auth/me).
const NO_BILLING_ADDRESS = {
  billingName: null,
  billingStreet: null,
  billingCity: null,
  billingState: null,
  billingZip: null,
  billingCountry: null,
};
const DRIVER_ID = 'drv_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({ error: error.message, code: error.code });
      return;
    }
    void reply.send(error);
  });
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
    vi.mocked(writeAudit).mockClear();
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

    it('answers 202 for an already registered email, like a new one', async () => {
      setupDbResults([
        {
          id: VALID_DRIVER_ID,
          firstName: 'John',
          lastName: 'Doe',
          email: 'existing@example.com',
          language: 'en',
        },
      ]);
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
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ success: true });
      expect(auditCalls()).toEqual([]);
    });

    it('registers a new driver without signing in', async () => {
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
        priceDisplay: null,
        isActive: true,
        emailVerified: false,
        createdAt: '2024-01-01',
      };
      setupDbResults([], [driverRow], [], []);
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
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ success: true });
      expect(auditCalls()).toEqual([
        {
          table: driverAuditLog,
          args: expect.objectContaining({
            entityId: DRIVER_ID,
            action: 'created',
            actor: 'driver',
            actorDriverId: DRIVER_ID,
          }),
        },
      ]);

      // The driver signs in after opening the verification link.
      const cookies = parseCookies(response);
      expect(cookies.has('portal_token')).toBe(false);
      expect(cookies.has('portal_refresh')).toBe(false);
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
      // An unknown email has no driver to key on: no audit row.
      expect(auditCalls()).toEqual([]);
      // A password check still runs (against a dummy hash), so the answer
      // takes as long as a wrong password and does not reveal the email.
      expect(argon2Module.default.verify).toHaveBeenCalledWith(expect.any(String), 'TestPassword1');
    });

    it('records a refused login on an inactive driver', async () => {
      // The active-account lookup finds nothing; the email names an inactive driver.
      setupDbResults([], [{ id: DRIVER_ID, isActive: false }]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/login',
        headers: { 'user-agent': 'portal-test' },
        payload: { email: 'john@example.com', password: 'TestPassword1' },
      });
      expect(response.statusCode).toBe(401);
      expect(auditCalls()).toEqual([
        {
          table: driverAuditLog,
          args: expect.objectContaining({
            entityId: DRIVER_ID,
            action: 'login_failed',
            actor: 'system',
            actorLabel: 'login',
            notes: 'inactive',
            after: { method: 'password', ip: '127.0.0.1', userAgent: 'portal-test' },
          }),
        },
      ]);
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
      const argon2 = argon2Module;
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
      const [row] = auditCalls();
      expect(row?.args).toMatchObject({
        entityId: DRIVER_ID,
        action: 'login_failed',
        actor: 'system',
        notes: 'bad_password',
      });
      // Never the password.
      expect(JSON.stringify(row?.args)).not.toContain('WrongPassword1');
    });

    it('returns driver and sets auth cookies on successful login', async () => {
      const argon2 = argon2Module;
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
          priceDisplay: null,
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
      expect(auditCalls()).toEqual([
        {
          table: driverAuditLog,
          args: expect.objectContaining({
            entityId: DRIVER_ID,
            action: 'login_succeeded',
            actor: 'driver',
            actorDriverId: DRIVER_ID,
            after: expect.objectContaining({ method: 'password' }),
          }),
        },
      ]);

      const cookies = parseCookies(response);
      expect(cookies.has('portal_token')).toBe(true);
      expect(cookies.get('portal_token')?.httpOnly).toBe(true);
      expect(cookies.has('portal_refresh')).toBe(true);
      expect(cookies.get('portal_refresh')?.httpOnly).toBe(true);
      expect(cookies.has('portal_csrf')).toBe(true);
      expect(cookies.get('portal_csrf')?.httpOnly).toBe(false);
    });
  });

  describe('portal access requires a password', () => {
    const sourceFilter = (): unknown[] =>
      vi.mocked(eq).mock.calls.filter(([column]) => (column as unknown) === 'drivers.source');

    it('login looks up only drivers with a password, whatever their origin', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/login',
        payload: { email: 'admin-created@example.com', password: 'TestPassword1' },
      });
      expect(response.statusCode).toBe(401);
      expect(isNotNull).toHaveBeenCalledWith('drivers.password_hash');
      expect(sourceFilter()).toHaveLength(0);
    });

    it('forgot-password sends nothing to a driver without a password', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/forgot-password',
        payload: { email: 'admin-created@example.com' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
      expect(isNotNull).toHaveBeenCalledWith('drivers.password_hash');
      expect(sourceFilter()).toHaveLength(0);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('forgot-password issues a reset token to a driver with a password', async () => {
      setupDbResults([
        {
          id: DRIVER_ID,
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          language: 'en',
          phone: null,
        },
      ]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/forgot-password',
        payload: { email: 'john@example.com' },
      });
      expect(response.statusCode).toBe(200);
      expect(db.insert).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /v1/portal/auth/activate', () => {
    const STRONG = 'Str0ng!Password';

    it('activates with the token and password', async () => {
      activateDriverPortalMock.mockResolvedValueOnce(undefined);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/activate',
        payload: { token: 'raw-token', password: STRONG },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
      expect(activateDriverPortalMock).toHaveBeenCalledWith('raw-token', STRONG, expect.anything());
    });

    it.each(['INVALID_TOKEN', 'WEAK_PASSWORD'])('returns 400 %s from the service', async (code) => {
      activateDriverPortalMock.mockRejectedValueOnce(new AppError('rejected', 400, code));
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/activate',
        payload: { token: 'raw-token', password: STRONG },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe(code);
    });

    it('rejects a missing token or short password before calling the service', async () => {
      for (const payload of [{ password: STRONG }, { token: 'raw-token', password: 'short' }]) {
        const response = await app.inject({
          method: 'POST',
          url: '/portal/auth/activate',
          payload,
        });
        expect(response.statusCode).toBe(400);
      }
      expect(activateDriverPortalMock).not.toHaveBeenCalled();
    });

    it('does not require a driver session', async () => {
      activateDriverPortalMock.mockResolvedValueOnce(undefined);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/activate',
        payload: { token: 'raw-token', password: STRONG },
      });
      expect(response.statusCode).not.toBe(401);
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
          priceDisplay: null,
          isActive: true,
          emailVerified: true,
          createdAt: '2024-01-01',
          ...NO_BILLING_ADDRESS,
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
          priceDisplay: null,
          isActive: true,
          emailVerified: true,
          createdAt: '2024-01-01',
          ...NO_BILLING_ADDRESS,
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
      expect(body.billing).toEqual({ mode: 'card', fleetName: null, invoicedTo: null });
    });

    it('returns the billing address with the profile', async () => {
      setupDbResults([
        {
          id: DRIVER_ID,
          firstName: 'Erika',
          lastName: 'Muster',
          email: 'erika@example.com',
          phone: null,
          language: 'de',
          timezone: null,
          themePreference: 'light',
          distanceUnit: 'km',
          priceDisplay: null,
          isActive: true,
          emailVerified: true,
          createdAt: '2024-01-01',
          billingName: null,
          billingStreet: 'Hauptstrasse 1',
          billingCity: 'Berlin',
          billingState: null,
          billingZip: '10115',
          billingCountry: 'Germany',
        },
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/auth/me',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.billingAddress).toEqual({
        billingName: null,
        billingStreet: 'Hauptstrasse 1',
        billingCity: 'Berlin',
        billingState: null,
        billingZip: '10115',
        billingCountry: 'Germany',
      });
      expect(body).not.toHaveProperty('billingCity');
    });

    it('returns account billing for a driver whose fleet bills on account', async () => {
      setupDbResults([
        {
          id: DRIVER_ID,
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          phone: null,
          language: 'en',
          timezone: null,
          themePreference: 'light',
          distanceUnit: 'miles',
          priceDisplay: null,
          isActive: true,
          emailVerified: true,
          createdAt: '2024-01-01',
          ...NO_BILLING_ADDRESS,
        },
      ]);
      vi.mocked(resolveAccountBilling).mockResolvedValueOnce({
        fleetId: 'flt_1',
        fleetName: 'Acme Logistics',
        recipient: 'fleet',
      });
      const response = await app.inject({
        method: 'GET',
        url: '/portal/auth/me',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().billing).toEqual({
        mode: 'account',
        fleetName: 'Acme Logistics',
        invoicedTo: 'fleet',
      });
      expect(resolveAccountBilling).toHaveBeenCalledWith(expect.anything(), DRIVER_ID);
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

    it('returns 400 and verifies nothing when the token is expired or already used', async () => {
      // The guarded consume (unrevoked, unexpired) matches no row: a second
      // click on the link sends no second welcome email.
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/verify-email',
        payload: { token: 'expired-token' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('INVALID_TOKEN');
      expect(auditCalls()).toEqual([]);
    });

    it('verifies email with valid token', async () => {
      setupDbResults(
        [{ driverId: DRIVER_ID }], // consume the token
        [], // update drivers
        [{ id: DRIVER_ID, firstName: 'John', lastName: 'Doe', email: 'john@example.com' }],
      );
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/verify-email',
        payload: { token: 'valid-token-hex' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
      expect(auditCalls()).toEqual([
        {
          table: driverAuditLog,
          args: expect.objectContaining({
            entityId: DRIVER_ID,
            action: 'email_verified',
            actor: 'driver',
            after: expect.objectContaining({ method: 'verification_token' }),
          }),
        },
      ]);
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
      const call = vi.mocked(dispatchSystemNotification).mock.calls.at(-1);
      expect(call?.[1]).toBe('driver.AccountVerification');
      expect(call?.[2]).not.toHaveProperty('phone');
    });

    it('refuses a resend over the per-driver cap with 429 and Retry-After', async () => {
      signupLimits.verificationResendRetryAfter.mockResolvedValueOnce(42);
      vi.mocked(dispatchSystemNotification).mockClear();
      setupDbResults([
        {
          id: DRIVER_ID,
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          language: 'en',
          emailVerified: false,
        },
      ]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/auth/resend-verification',
        cookies: { portal_token: signedDriverToken },
        payload: {},
      });
      expect(response.statusCode).toBe(429);
      expect(response.headers['retry-after']).toBe('42');
      expect(response.json()).toMatchObject({
        code: 'VERIFICATION_RESEND_LIMITED',
        retryAfterSeconds: 42,
      });
      expect(signupLimits.verificationResendRetryAfter).toHaveBeenCalledWith(DRIVER_ID);
      expect(dispatchSystemNotification).not.toHaveBeenCalled();
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
          priceDisplay: null,
          isActive: true,
          emailVerified: true,
          createdAt: '2024-01-01',
          ...NO_BILLING_ADDRESS,
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
          priceDisplay: null,
          isActive: true,
          emailVerified: true,
          createdAt: '2024-01-01',
          ...NO_BILLING_ADDRESS,
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
