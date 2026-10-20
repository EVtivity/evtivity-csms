// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';

// DB mock: each awaited chain consumes the next queued result. An Error result
// makes that query reject. `values` and `set` arguments are recorded so tests
// can assert what was written.
let dbResults: unknown[] = [];
let dbCallIndex = 0;
const writes: { method: 'values' | 'set'; arg: unknown }[] = [];
function setupDbResults(...results: unknown[]) {
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
    'returning',
    'onConflictDoUpdate',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain['values'] = vi.fn((arg: unknown) => {
    writes.push({ method: 'values', arg });
    return chain;
  });
  chain['set'] = vi.fn((arg: unknown) => {
    writes.push({ method: 'set', arg });
    return chain;
  });
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    const r = dbResults[dbCallIndex] ?? [];
    dbCallIndex++;
    if (r instanceof Error) return Promise.reject(r).then(resolve, reject);
    return Promise.resolve(r).then(resolve, reject);
  };
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
    // The transaction runs its callback on the same mocked builders.
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const { db } = await import('@evtivity/database');
      return fn(db);
    }),
  },
  client: {},
  drivers: { id: 'drivers.id', passwordHash: 'drivers.password_hash' },
  userTokens: { id: 'user_tokens.id' },
  getRecaptchaConfig: vi.fn().mockResolvedValue(null),
  isPortalRegistrationEnabled: vi.fn().mockResolvedValue(true),
  pgErrorCode: (err: unknown) => (err as { code?: string } | null)?.code,
  PG_UNIQUE_VIOLATION: '23505',
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
}));

vi.mock('argon2', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$argon2id$hashed_password'),
    verify: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('@evtivity/lib', () => ({
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
  decryptString: vi.fn().mockReturnValue('decrypted-secret'),
  decryptSettingOrNull: vi.fn().mockReturnValue('decrypted-secret'),
  createMfaChallenge: vi.fn().mockResolvedValue({ challengeId: 41, code: '654321' }),
  verifyMfaChallenge: vi.fn().mockResolvedValue('verified'),
  verifyTotpCode: vi.fn().mockReturnValue(true),
}));

vi.mock('../services/refresh-token.service.js', () => ({
  createRefreshToken: vi
    .fn()
    .mockResolvedValue({ rawToken: 'new-refresh-token', expiresAt: new Date() }),
  validateAndRotateRefreshToken: vi.fn().mockResolvedValue(null),
  revokeRefreshToken: vi.fn().mockResolvedValue(undefined),
  endDriverSessions: vi.fn().mockResolvedValue(undefined),
  bumpDriverSessionVersion: vi.fn().mockResolvedValue(1),
}));

vi.mock('../lib/device-attestation/index.js', () => ({
  issueChallenge: vi.fn().mockResolvedValue('nonce-abc'),
  registerIosAttestation: vi.fn().mockResolvedValue({ ok: true }),
  verifyDeviceAttestation: vi.fn().mockResolvedValue(true),
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({ publish: vi.fn().mockResolvedValue(undefined) })),
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

vi.mock('../services/driver-portal-access.service.js', () => ({
  activateDriverPortal: vi.fn(),
}));

import argon2 from 'argon2';
import { AppError } from '@evtivity/lib';
import {
  dispatchSystemNotification,
  decryptString,
  createMfaChallenge,
  verifyMfaChallenge,
  verifyTotpCode,
} from '@evtivity/lib';
import {
  db,
  getRecaptchaConfig,
  isPortalRegistrationEnabled,
  writeAudit,
} from '@evtivity/database';
import {
  createRefreshToken,
  validateAndRotateRefreshToken,
  revokeRefreshToken,
  endDriverSessions,
  bumpDriverSessionVersion,
} from '../services/refresh-token.service.js';
import {
  issueChallenge,
  registerIosAttestation,
  verifyDeviceAttestation,
} from '../lib/device-attestation/index.js';
import { hashUserToken } from '../lib/user-token.js';
import { registerAuth } from '../plugins/auth.js';
import { portalAuthRoutes } from '../routes/portal/auth.js';
import { DEFAULT_SESSION_LIFETIMES } from '@evtivity/lib/session-lifetimes';
import * as libModule from '@evtivity/lib';

const DRIVER_ID = 'drv_000000000001';
const STRONG = 'TestPassword1';
const MOBILE = { 'x-client': 'mobile', 'x-device-id': 'device-123' };

const driverRow = {
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
  createdAt: '2024-01-01T00:00:00.000Z',
  passwordHash: '$argon2id$hashed',
  mfaEnabled: false,
  mfaMethod: null as string | null,
  totpSecretEnc: null as string | null,
};

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

function cookieMap(response: { headers: Record<string, unknown> }): Map<string, string> {
  const result = new Map<string, string>();
  const raw = response.headers['set-cookie'] as string | string[] | undefined;
  if (raw == null) return result;
  for (const entry of Array.isArray(raw) ? raw : [raw]) {
    const nameValue = entry.split(';')[0] ?? '';
    const idx = nameValue.indexOf('=');
    if (idx !== -1) result.set(nameValue.slice(0, idx), nameValue.slice(idx + 1));
  }
  return result;
}

function valuesWrites(): Record<string, unknown>[] {
  return writes.filter((w) => w.method === 'values').map((w) => w.arg as Record<string, unknown>);
}
function setWrites(): Record<string, unknown>[] {
  return writes.filter((w) => w.method === 'set').map((w) => w.arg as Record<string, unknown>);
}

describe('Portal auth routes - extra coverage', () => {
  let app: FastifyInstance;
  let signedDriverToken: string;
  let mfaToken: string;

  beforeAll(async () => {
    app = await buildApp();
    signedDriverToken = app.signCookie(app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' }));
    mfaToken = app.jwt.sign({ driverId: DRIVER_ID, type: 'driver', mfaPending: true } as never);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setupDbResults();
    writes.length = 0;
  });

  describe('POST /portal/auth/attest/challenge', () => {
    it('returns the issued nonce', async () => {
      const res = await app.inject({ method: 'POST', url: '/portal/auth/attest/challenge' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ challenge: 'nonce-abc' });
      expect(issueChallenge).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /portal/auth/attest/register', () => {
    const payload = { keyId: 'a2V5', attestation: 'YXR0', challenge: 'nonce-abc' };

    it('returns success when attestation verifies', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/attest/register',
        payload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });

    it('returns 403 ATTESTATION_FAILED when verification fails', async () => {
      vi.mocked(registerIosAttestation).mockResolvedValueOnce({ ok: false });
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/attest/register',
        payload,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('ATTESTATION_FAILED');
    });

    it('rejects a missing keyId with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/attest/register',
        payload: { attestation: 'YXR0', challenge: 'nonce' },
      });
      expect(res.statusCode).toBe(400);
      expect(registerIosAttestation).not.toHaveBeenCalled();
    });
  });

  describe('POST /portal/auth/register', () => {
    const body = {
      firstName: 'John',
      lastName: 'Doe',
      email: 'john@example.com',
      password: STRONG,
    };

    it('returns 403 when portal registration is disabled', async () => {
      vi.mocked(isPortalRegistrationEnabled).mockResolvedValueOnce(false);
      const res = await app.inject({ method: 'POST', url: '/portal/auth/register', payload: body });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('PORTAL_REGISTRATION_DISABLED');
      expect(db.select).not.toHaveBeenCalled();
    });

    it('returns 400 WEAK_PASSWORD for a password without a digit', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/register',
        payload: { ...body, password: 'NoDigitsHereAtAll' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Password must contain a number',
        code: 'WEAK_PASSWORD',
        missing: ['number'],
      });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('returns 400 RECAPTCHA_REQUIRED when reCAPTCHA is on and no token is sent', async () => {
      vi.mocked(getRecaptchaConfig).mockResolvedValueOnce({
        secretKeyEnc: 'enc',
        threshold: 0.5,
      } as never);
      const res = await app.inject({ method: 'POST', url: '/portal/auth/register', payload: body });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('RECAPTCHA_REQUIRED');
      expect(db.select).not.toHaveBeenCalled();
    });

    it('returns 403 ATTESTATION_FAILED for a mobile client that fails attestation', async () => {
      vi.mocked(verifyDeviceAttestation).mockResolvedValueOnce(false);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/register',
        headers: MOBILE,
        payload: body,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('ATTESTATION_FAILED');
      expect(getRecaptchaConfig).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('signs an attested mobile client in nowhere: no tokens, no cookies', async () => {
      setupDbResults([], [driverRow], [], []);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/register',
        headers: MOBILE,
        payload: body,
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ success: true });
      expect(cookieMap(res).size).toBe(0);
      expect(createRefreshToken).not.toHaveBeenCalled();
    });

    it('answers a known email the same way, changes nothing and emails the owner', async () => {
      setupDbResults([
        {
          id: DRIVER_ID,
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          language: 'de',
        },
      ]);
      const res = await app.inject({ method: 'POST', url: '/portal/auth/register', payload: body });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ success: true });
      expect(cookieMap(res).size).toBe(0);
      // The password is hashed for a known email too, so both answers take as long.
      expect(argon2.hash).toHaveBeenCalledWith(STRONG);
      expect(valuesWrites()).toEqual([]);
      expect(setWrites()).toEqual([]);
      expect(writeAudit).not.toHaveBeenCalled();
      const call = vi.mocked(dispatchSystemNotification).mock.calls[0];
      expect(call?.[1]).toBe('driver.RegistrationAttempt');
      expect(call?.[2]).toEqual({ email: 'john@example.com', firstName: 'John', language: 'de' });
      const vars = call?.[3] as { signInUrl: string; resetUrl: string };
      expect(vars.signInUrl).toMatch(/\/login$/);
      expect(vars.resetUrl).toMatch(/\/forgot-password$/);
    });

    it('stores the hashed password and a verification token, and emails the link', async () => {
      setupDbResults([], [driverRow], [], []);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/register',
        payload: { ...body, phone: '555-1234' },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ success: true });
      expect(cookieMap(res).has('portal_token')).toBe(false);
      expect(argon2.hash).toHaveBeenCalledWith(STRONG);
      const [driverInsert, tokenInsert] = valuesWrites();
      expect(driverInsert).toEqual({
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
        phone: '555-1234',
        passwordHash: '$argon2id$hashed_password',
        registrationSource: 'portal',
      });
      expect(tokenInsert).toMatchObject({ driverId: DRIVER_ID, type: 'email_verification' });
      const expiresAt = (tokenInsert as { expiresAt: Date }).expiresAt.getTime();
      expect(expiresAt - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
      expect(expiresAt - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);

      const call = vi.mocked(dispatchSystemNotification).mock.calls[0];
      expect(call?.[1]).toBe('driver.AccountVerification');
      // Email only: the phone is never verified, so the link never goes by SMS.
      expect(call?.[2]).toEqual(expect.objectContaining({ email: 'john@example.com' }));
      expect(call?.[2]).not.toHaveProperty('phone');
      const vars = call?.[3] as { verifyUrl: string };
      const rawToken = new URL(vars.verifyUrl).searchParams.get('token') ?? '';
      expect(vars.verifyUrl).toContain('/verify-email?token=');
      // The stored hash is the hash of the emailed raw token.
      expect((tokenInsert as { tokenHash: string }).tokenHash).toBe(hashUserToken(rawToken));
    });

    it('refuses a phone number used in too many registrations with 429', async () => {
      signupLimits.isPhoneRegistrationLimited.mockResolvedValueOnce(true);
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/register',
        payload: { ...body, phone: '555-1234' },
      });
      expect(res.statusCode).toBe(429);
      expect(res.json().code).toBe('PHONE_REGISTRATION_LIMITED');
      expect(signupLimits.isPhoneRegistrationLimited).toHaveBeenCalledWith('555-1234');
      expect(valuesWrites()).toEqual([]);
      expect(dispatchSystemNotification).not.toHaveBeenCalled();
    });

    it('does not check the phone cap without a phone', async () => {
      setupDbResults([], [driverRow], [], []);
      const res = await app.inject({ method: 'POST', url: '/portal/auth/register', payload: body });
      expect(res.statusCode).toBe(202);
      expect(signupLimits.isPhoneRegistrationLimited).not.toHaveBeenCalled();
    });

    it('answers a concurrent unique violation on insert like a known email', async () => {
      setupDbResults([], Object.assign(new Error('duplicate key'), { code: '23505' }));
      const res = await app.inject({ method: 'POST', url: '/portal/auth/register', payload: body });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ success: true });
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('rethrows other insert errors as 500', async () => {
      setupDbResults([], Object.assign(new Error('connection lost'), { code: '08006' }));
      const res = await app.inject({ method: 'POST', url: '/portal/auth/register', payload: body });
      expect(res.statusCode).toBe(500);
      expect(cookieMap(res).has('portal_token')).toBe(false);
    });
  });

  describe('POST /portal/auth/login', () => {
    const body = { email: 'john@example.com', password: STRONG };

    it('returns 403 ATTESTATION_FAILED for a mobile client that fails attestation', async () => {
      vi.mocked(verifyDeviceAttestation).mockResolvedValueOnce(false);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/login',
        headers: MOBILE,
        payload: body,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('ATTESTATION_FAILED');
      expect(db.select).not.toHaveBeenCalled();
    });

    it('returns 403 RECAPTCHA_FAILED when the token scores below threshold', async () => {
      vi.mocked(getRecaptchaConfig).mockResolvedValueOnce({
        secretKeyEnc: 'enc',
        threshold: 0.5,
      } as never);
      const { verifyRecaptcha } = libModule;
      vi.mocked(verifyRecaptcha).mockResolvedValueOnce({ success: false } as never);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/login',
        payload: { ...body, recaptchaToken: 'tok' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('RECAPTCHA_FAILED');
      expect(db.select).not.toHaveBeenCalled();
    });

    it('returns mobile tokens without cookies for an attested mobile login', async () => {
      setupDbResults([driverRow]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/login',
        headers: MOBILE,
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.driver.id).toBe(DRIVER_ID);
      expect(json.refreshToken).toBe('new-refresh-token');
      expect(json.driver.passwordHash).toBeUndefined();
      expect(cookieMap(res).size).toBe(0);
    });

    it('starts an email MFA challenge and returns no session', async () => {
      setupDbResults([{ ...driverRow, mfaEnabled: true, mfaMethod: 'email' }]);
      const res = await app.inject({ method: 'POST', url: '/portal/auth/login', payload: body });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.mfaRequired).toBe(true);
      expect(json.mfaMethod).toBe('email');
      expect(json.challengeId).toBe(41);
      expect(json.driver).toBeUndefined();
      const decoded = app.jwt.verify<{ driverId: string; mfaPending: boolean }>(json.mfaToken);
      expect(decoded).toMatchObject({ driverId: DRIVER_ID, mfaPending: true });
      expect(cookieMap(res).has('portal_token')).toBe(false);
      expect(createMfaChallenge).toHaveBeenCalledWith(expect.anything(), {
        driverId: DRIVER_ID,
        method: 'email',
      });
      const call = vi.mocked(dispatchSystemNotification).mock.calls[0];
      expect(call?.[1]).toBe('mfa.VerificationCode');
      expect(call?.[3]).toEqual({ code: '654321' });
    });

    it('requires TOTP MFA without creating a challenge or sending a code', async () => {
      setupDbResults([{ ...driverRow, mfaEnabled: true, mfaMethod: 'totp' }]);
      const res = await app.inject({ method: 'POST', url: '/portal/auth/login', payload: body });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.mfaRequired).toBe(true);
      expect(json.mfaMethod).toBe('totp');
      expect(json.challengeId).toBeUndefined();
      expect(createMfaChallenge).not.toHaveBeenCalled();
      expect(dispatchSystemNotification).not.toHaveBeenCalled();
    });
  });

  describe('POST /portal/auth/logout', () => {
    it('revokes the refresh cookie for a web client and clears cookies', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/logout',
        cookies: { portal_token: signedDriverToken, portal_refresh: app.signCookie('web-refresh') },
      });
      expect(res.statusCode).toBe(204);
      expect(revokeRefreshToken).toHaveBeenCalledWith('web-refresh');
      // Every access token issued before ends, like the operator logout.
      expect(bumpDriverSessionVersion).toHaveBeenCalledWith(DRIVER_ID);
      expect(endDriverSessions).not.toHaveBeenCalled();
      expect(cookieMap(res).get('portal_refresh')).toBe('');
    });

    it('revokes nothing for a tampered refresh cookie and still clears cookies', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/logout',
        cookies: { portal_token: signedDriverToken, portal_refresh: 'web-refresh.bad-signature' },
      });
      expect(res.statusCode).toBe(204);
      expect(revokeRefreshToken).not.toHaveBeenCalled();
      expect(cookieMap(res).get('portal_refresh')).toBe('');
    });

    it('revokes the body refresh token for a mobile client and clears no cookies', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/logout',
        headers: {
          ...MOBILE,
          authorization: `Bearer ${app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' })}`,
        },
        payload: { refreshToken: 'mobile-refresh' },
      });
      expect(res.statusCode).toBe(204);
      expect(revokeRefreshToken).toHaveBeenCalledWith('mobile-refresh');
      expect(cookieMap(res).size).toBe(0);
    });
  });

  describe('POST /portal/auth/refresh', () => {
    it('returns 401 NO_REFRESH_TOKEN without a token', async () => {
      const res = await app.inject({ method: 'POST', url: '/portal/auth/refresh' });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('NO_REFRESH_TOKEN');
      expect(validateAndRotateRefreshToken).not.toHaveBeenCalled();
    });

    it('returns 401 INVALID_REFRESH_TOKEN and clears cookies for a bad web token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/refresh',
        cookies: { portal_refresh: app.signCookie('stale') },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('INVALID_REFRESH_TOKEN');
      expect(validateAndRotateRefreshToken).toHaveBeenCalledWith('stale', { deviceId: undefined });
      expect(cookieMap(res).get('portal_token')).toBe('');
    });

    it('returns 401 INVALID_REFRESH_TOKEN and clears cookies for a tampered web cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/refresh',
        cookies: { portal_refresh: 'stale.not-a-valid-signature' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('INVALID_REFRESH_TOKEN');
      expect(validateAndRotateRefreshToken).not.toHaveBeenCalled();
      expect(cookieMap(res).get('portal_refresh')).toBe('');
    });

    it('returns 401 INVALID_REFRESH_TOKEN for an operator refresh token', async () => {
      vi.mocked(validateAndRotateRefreshToken).mockResolvedValueOnce({
        userId: 'usr_1',
        driverId: null,
      } as never);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/refresh',
        headers: MOBILE,
        payload: { refreshToken: 'operator-token' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('INVALID_REFRESH_TOKEN');
      expect(cookieMap(res).size).toBe(0);
    });

    it('returns 401 ACCOUNT_DISABLED for a deactivated driver', async () => {
      vi.mocked(validateAndRotateRefreshToken).mockResolvedValueOnce({
        driverId: DRIVER_ID,
      } as never);
      setupDbResults([{ id: DRIVER_ID, isActive: false }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/refresh',
        cookies: { portal_refresh: app.signCookie('valid') },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('ACCOUNT_DISABLED');
      expect(createRefreshToken).not.toHaveBeenCalled();
      expect(cookieMap(res).get('portal_refresh')).toBe('');
    });

    it('sets rotated cookies for a web client', async () => {
      vi.mocked(validateAndRotateRefreshToken).mockResolvedValueOnce({
        driverId: DRIVER_ID,
      } as never);
      setupDbResults([{ id: DRIVER_ID, isActive: true }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/refresh',
        cookies: { portal_refresh: app.signCookie('valid') },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      const cookies = cookieMap(res);
      expect(cookies.get('portal_refresh')).toMatch(/^new-refresh-token\./);
      expect(cookies.get('portal_token')).toBeTruthy();
    });

    it('returns device-bound tokens in the body for a mobile client', async () => {
      vi.mocked(validateAndRotateRefreshToken).mockResolvedValueOnce({
        driverId: DRIVER_ID,
      } as never);
      setupDbResults([{ id: DRIVER_ID, isActive: true }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/refresh',
        headers: MOBILE,
        payload: { refreshToken: 'valid' },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.refreshToken).toBe('new-refresh-token');
      expect(json.expiresIn).toBe(DEFAULT_SESSION_LIFETIMES.driverAccessMinutes * 60);
      expect(app.jwt.verify<{ driverId: string }>(json.token).driverId).toBe(DRIVER_ID);
      expect(validateAndRotateRefreshToken).toHaveBeenCalledWith('valid', {
        deviceId: 'device-123',
      });
      expect(createRefreshToken).toHaveBeenCalledWith({
        driverId: DRIVER_ID,
        deviceId: 'device-123',
        lifetimeDays: DEFAULT_SESSION_LIFETIMES.driverRefreshDays,
      });
      expect(cookieMap(res).size).toBe(0);
    });
  });

  describe('POST /portal/auth/mfa/verify', () => {
    const mfaDriver = { ...driverRow, mfaEnabled: true, mfaMethod: 'email' };

    it('returns 401 MFA_TOKEN_EXPIRED for an unverifiable token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/verify',
        payload: { mfaToken: 'garbage', code: '123456' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('MFA_TOKEN_EXPIRED');
    });

    it('returns 400 MFA_TOKEN_INVALID for a full session token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/verify',
        payload: {
          mfaToken: app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' }),
          code: '123456',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_TOKEN_INVALID');
      expect(db.select).not.toHaveBeenCalled();
    });

    it('returns 400 MFA_NOT_CONFIGURED when the driver has MFA off', async () => {
      setupDbResults([driverRow]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/verify',
        payload: { mfaToken, code: '123456', challengeId: 9001 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_NOT_CONFIGURED');
    });

    it('returns 403 ACCOUNT_DISABLED for a driver deactivated after login', async () => {
      setupDbResults([{ ...mfaDriver, isActive: false }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/verify',
        payload: { mfaToken, code: '123456', challengeId: 9002 },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('ACCOUNT_DISABLED');
      expect(verifyMfaChallenge).not.toHaveBeenCalled();
      expect(cookieMap(res).has('portal_token')).toBe(false);
      expect(vi.mocked(writeAudit)).toHaveBeenCalledWith(
        expect.objectContaining({ idColumn: 'driver_id' }),
        expect.objectContaining({
          entityId: DRIVER_ID,
          action: 'login_failed',
          actor: 'system',
          notes: 'inactive',
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('completes login with a valid email challenge code', async () => {
      setupDbResults([mfaDriver]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/verify',
        payload: { mfaToken, code: '654321', challengeId: 9003 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().driver.id).toBe(DRIVER_ID);
      expect(res.json().driver.totpSecretEnc).toBeUndefined();
      expect(verifyMfaChallenge).toHaveBeenCalledWith(expect.anything(), 9003, '654321', {
        driverId: DRIVER_ID,
      });
      expect(cookieMap(res).get('portal_refresh')).toMatch(/^new-refresh-token\./);
      expect(vi.mocked(writeAudit)).toHaveBeenCalledWith(
        expect.objectContaining({ idColumn: 'driver_id' }),
        expect.objectContaining({
          entityId: DRIVER_ID,
          action: 'login_succeeded',
          actor: 'driver',
          after: expect.objectContaining({ method: 'mfa' }),
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('rejects an email code sent without a challengeId', async () => {
      setupDbResults([mfaDriver]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/verify',
        payload: { mfaToken, code: '654321' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_CODE_INVALID');
      expect(verifyMfaChallenge).not.toHaveBeenCalled();
      expect(vi.mocked(writeAudit)).toHaveBeenCalledWith(
        expect.objectContaining({ idColumn: 'driver_id' }),
        expect.objectContaining({
          entityId: DRIVER_ID,
          action: 'login_failed',
          notes: 'mfa_code_invalid',
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('answers MFA_CHALLENGE_EXHAUSTED when the challenge has no tries left', async () => {
      // The tries are counted on the challenge row (verifyMfaChallenge).
      vi.mocked(verifyMfaChallenge).mockResolvedValue('exhausted');
      setupDbResults([mfaDriver]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/verify',
        payload: { mfaToken, code: '654321', challengeId: 9004 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_CHALLENGE_EXHAUSTED');
      expect(verifyMfaChallenge).toHaveBeenCalledWith(expect.anything(), 9004, '654321', {
        driverId: mfaDriver.id,
      });
      vi.mocked(verifyMfaChallenge).mockResolvedValue('verified');
    });

    it('returns 400 TOTP_NOT_CONFIGURED when the TOTP secret is missing', async () => {
      setupDbResults([{ ...driverRow, mfaEnabled: true, mfaMethod: 'totp', totpSecretEnc: null }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/verify',
        payload: { mfaToken, code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('TOTP_NOT_CONFIGURED');
      expect(verifyTotpCode).not.toHaveBeenCalled();
    });

    it('returns 400 TOTP_NOT_CONFIGURED when the TOTP secret cannot be decrypted', async () => {
      vi.mocked(decryptString).mockImplementationOnce(() => {
        throw new Error('bad auth tag');
      });
      setupDbResults([{ ...driverRow, mfaEnabled: true, mfaMethod: 'totp', totpSecretEnc: 'x' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/verify',
        payload: { mfaToken, code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('TOTP_NOT_CONFIGURED');
      expect(cookieMap(res).has('portal_token')).toBe(false);
    });

    it('verifies a TOTP code against the decrypted secret', async () => {
      setupDbResults([{ ...driverRow, mfaEnabled: true, mfaMethod: 'totp', totpSecretEnc: 'enc' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/verify',
        payload: { mfaToken, code: '123456' },
      });
      expect(res.statusCode).toBe(200);
      expect(verifyTotpCode).toHaveBeenCalledWith('decrypted-secret', '123456');
      expect(res.json().driver.id).toBe(DRIVER_ID);
    });

    it('rejects a wrong TOTP code', async () => {
      vi.mocked(verifyTotpCode).mockReturnValueOnce(false);
      setupDbResults([{ ...driverRow, mfaEnabled: true, mfaMethod: 'totp', totpSecretEnc: 'enc' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/verify',
        payload: { mfaToken, code: '999999' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_CODE_INVALID');
    });
  });

  describe('POST /portal/auth/mfa/resend', () => {
    it('returns 401 MFA_TOKEN_EXPIRED for an unverifiable token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/resend',
        payload: { mfaToken: 'garbage' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('MFA_TOKEN_EXPIRED');
    });

    it('returns 400 MFA_TOKEN_INVALID for a token without mfaPending', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/resend',
        payload: { mfaToken: app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' }) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_TOKEN_INVALID');
    });

    it('returns 400 MFA_NOT_CONFIGURED for an unknown driver', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/resend',
        payload: { mfaToken },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_NOT_CONFIGURED');
    });

    it('returns 400 MFA_TOTP_NO_RESEND for a TOTP driver', async () => {
      setupDbResults([{ ...driverRow, mfaEnabled: true, mfaMethod: 'totp' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/resend',
        payload: { mfaToken },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_TOTP_NO_RESEND');
      expect(createMfaChallenge).not.toHaveBeenCalled();
    });

    it('creates a new SMS challenge and sends the code', async () => {
      setupDbResults([{ ...driverRow, mfaEnabled: true, mfaMethod: 'sms' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/resend',
        payload: { mfaToken },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ challengeId: 41 });
      expect(createMfaChallenge).toHaveBeenCalledWith(expect.anything(), {
        driverId: DRIVER_ID,
        method: 'sms',
      });
      const call = vi.mocked(dispatchSystemNotification).mock.calls[0];
      expect(call?.[1]).toBe('mfa.VerificationCode');
      // The SMS method sends the code by SMS only, never to the email address.
      expect(call?.[2]).toEqual({ phone: '555-1234', firstName: 'John', language: 'en' });
      expect(call?.[3]).toEqual({ code: '654321' });
    });

    it('sends an email code to the email address only', async () => {
      setupDbResults([{ ...driverRow, mfaEnabled: true, mfaMethod: 'email' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/resend',
        payload: { mfaToken },
      });
      expect(res.statusCode).toBe(200);
      const call = vi.mocked(dispatchSystemNotification).mock.calls[0];
      expect(call?.[2]).toEqual({ email: 'john@example.com', firstName: 'John', language: 'en' });
    });

    it('returns 403 ACCOUNT_DISABLED and sends no code to a deactivated driver', async () => {
      setupDbResults([{ ...driverRow, mfaEnabled: true, mfaMethod: 'sms', isActive: false }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/resend',
        payload: { mfaToken },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('ACCOUNT_DISABLED');
      expect(createMfaChallenge).not.toHaveBeenCalled();
      expect(dispatchSystemNotification).not.toHaveBeenCalled();
    });
  });

  describe('POST /portal/auth/forgot-password', () => {
    const resetDriver = {
      id: DRIVER_ID,
      firstName: 'John',
      lastName: 'Doe',
      email: 'john@example.com',
      language: 'en',
      phone: null,
    };

    it('returns 403 ATTESTATION_FAILED for a mobile client that fails attestation', async () => {
      vi.mocked(verifyDeviceAttestation).mockResolvedValueOnce(false);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/forgot-password',
        headers: MOBILE,
        payload: { email: 'john@example.com' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('ATTESTATION_FAILED');
      expect(db.select).not.toHaveBeenCalled();
    });

    it('revokes open reset tokens, stores a 1-hour token and emails its link', async () => {
      setupDbResults([resetDriver], [], []);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/forgot-password',
        headers: MOBILE,
        payload: { email: 'john@example.com' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(setWrites()[0]?.['revokedAt']).toBeInstanceOf(Date);
      const tokenInsert = valuesWrites()[0] as { tokenHash: string; expiresAt: Date };
      expect(tokenInsert).toMatchObject({ driverId: DRIVER_ID, type: 'password_reset' });
      expect(tokenInsert.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
      expect(tokenInsert.expiresAt.getTime() - Date.now()).toBeGreaterThan(59 * 60 * 1000);
      const call = vi.mocked(dispatchSystemNotification).mock.calls[0];
      expect(call?.[1]).toBe('driver.ForgotPassword');
      const { resetUrl } = call?.[3] as { resetUrl: string };
      const raw = new URL(resetUrl).searchParams.get('token') ?? '';
      expect(hashUserToken(raw)).toBe(tokenInsert.tokenHash);
      // Email only: no verified phone flag exists, so the link never goes by SMS.
      expect(call?.[2]).not.toHaveProperty('phone');
    });

    it('still returns success when the email dispatch fails', async () => {
      vi.mocked(dispatchSystemNotification).mockRejectedValueOnce(new Error('smtp down'));
      setupDbResults([resetDriver], [], []);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/forgot-password',
        payload: { email: 'john@example.com' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });
  });

  describe('POST /portal/auth/reset-password', () => {
    it('returns 400 RECAPTCHA_REQUIRED when reCAPTCHA is on and no token is sent', async () => {
      vi.mocked(getRecaptchaConfig).mockResolvedValueOnce({
        secretKeyEnc: 'enc',
        threshold: 0.5,
      } as never);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/reset-password',
        payload: { token: 'abc', password: STRONG },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('RECAPTCHA_REQUIRED');
      expect(db.select).not.toHaveBeenCalled();
    });

    it('returns 403 ATTESTATION_FAILED for a mobile client that fails attestation', async () => {
      vi.mocked(verifyDeviceAttestation).mockResolvedValueOnce(false);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/reset-password',
        headers: MOBILE,
        payload: { token: 'abc', password: STRONG },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('ATTESTATION_FAILED');
      expect(getRecaptchaConfig).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
    });

    it('returns 400 WEAK_PASSWORD before looking up the token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/reset-password',
        payload: { token: 'abc', password: 'alllowercase123' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Password must contain an uppercase letter',
        code: 'WEAK_PASSWORD',
        missing: ['uppercase'],
      });
      expect(db.select).not.toHaveBeenCalled();
    });

    it('refuses a password over 128 characters in the schema before looking up the token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/reset-password',
        payload: { token: 'abc', password: `Aa1${'x'.repeat(126)}` },
      });
      expect(res.statusCode).toBe(400);
      // This test app has no validation mapping, so Fastify's own code shows; the real app
      // answers VALIDATION_ERROR (integration file 59 checks it).
      expect(res.json().code).toBe('FST_ERR_VALIDATION');
      expect(db.select).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it('accepts a password of exactly 128 characters past the schema', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/reset-password',
        payload: { token: 'abc', password: `Aa1${'x'.repeat(125)}` },
      });
      expect(res.json().code).not.toBe('FST_ERR_VALIDATION');
      expect(res.json().code).not.toBe('WEAK_PASSWORD');
    });

    it('returns 400 INVALID_TOKEN for an unknown, used or expired token', async () => {
      // The guarded UPDATE (unrevoked, unexpired) matches no row.
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/reset-password',
        payload: { token: 'abc', password: STRONG },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_TOKEN');
      // Only the token consume ran: no password was written.
      expect(setWrites()).toHaveLength(1);
      expect(setWrites()[0]?.['passwordHash']).toBeUndefined();
      expect(endDriverSessions).not.toHaveBeenCalled();
    });

    it('hashes the password before the token lookup, so both answers take as long', async () => {
      setupDbResults([]);
      await app.inject({
        method: 'POST',
        url: '/portal/auth/reset-password',
        payload: { token: 'abc', password: STRONG },
      });
      expect(argon2.hash).toHaveBeenCalledWith(STRONG);
    });

    it('returns 400 INVALID_TOKEN when the driver was deactivated after the link went out', async () => {
      setupDbResults([{ driverId: DRIVER_ID }], []);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/reset-password',
        payload: { token: 'abc', password: STRONG },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_TOKEN');
      expect(endDriverSessions).not.toHaveBeenCalled();
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('consumes the token, sets the new hash, verifies the email and revokes every refresh token', async () => {
      setupDbResults([{ driverId: DRIVER_ID }], [{ id: DRIVER_ID }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/reset-password',
        payload: { token: 'abc', password: STRONG },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(argon2.hash).toHaveBeenCalledWith(STRONG);
      const [tokenSet, driverSet] = setWrites();
      expect(tokenSet?.['revokedAt']).toBeInstanceOf(Date);
      expect(driverSet?.['passwordHash']).toBe('$argon2id$hashed_password');
      expect(driverSet?.['emailVerified']).toBe(true);
      expect(endDriverSessions).toHaveBeenCalledWith(DRIVER_ID);
      expect(vi.mocked(writeAudit)).toHaveBeenCalledWith(
        expect.objectContaining({ idColumn: 'driver_id' }),
        expect.objectContaining({
          entityId: DRIVER_ID,
          action: 'password_reset',
          actor: 'driver',
          actorDriverId: DRIVER_ID,
        }),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('POST /portal/auth/resend-verification', () => {
    it('returns 400 DRIVER_NOT_FOUND when the driver row is gone', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/resend-verification',
        cookies: { portal_token: signedDriverToken },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('DRIVER_NOT_FOUND');
      expect(db.insert).not.toHaveBeenCalled();
    });
  });
});
