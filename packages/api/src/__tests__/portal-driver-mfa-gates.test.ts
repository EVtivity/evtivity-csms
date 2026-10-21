// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';

// Driver sign-in backoff, required MFA for drivers and the mobile reply at the portal
// sign-in, MFA verify and session renewal (lib/driver-mfa.ts, routes/portal/auth.ts).

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

vi.mock('../lib/phone-change.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/phone-change.js')>()),
  checkPhoneChange: vi.fn(async () => null),
}));
vi.mock('../lib/sign-in-backoff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/sign-in-backoff.js')>();
  return {
    ...actual,
    acceptTotpStep: vi.fn().mockResolvedValue(true),
    takeSignInAttempt: vi.fn(async (account: unknown, factor: unknown) => ({
      granted: true,
      account,
      factor,
      failures: 1,
      lockedUntil: null,
    })),
    recordAttemptFailure: vi.fn(async () => null),
    clearSignInFailures: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('../services/mfa-factor.service.js', () => {
  const countRecoveryCodes = vi.fn(async (_account: unknown) => 0);
  return {
    countRecoveryCodes,
    // The gates read both counts; tests set the recovery code count.
    mfaFactorCounts: vi.fn(async (account: unknown) => ({
      recoveryCodesRemaining: await countRecoveryCodes(account),
      passkeyCount: 0,
    })),
    consumeRecoveryCode: vi.fn(async () => ({ used: false, remaining: 0 })),
    issueRecoveryCodes: vi.fn(async () => []),
    deleteRecoveryCodes: vi.fn(async () => undefined),
    deleteWebauthnCredentials: vi.fn(async () => undefined),
  };
});
const reading = vi.hoisted(() => ({ fallback: false }));
vi.mock('@evtivity/database', () => ({
  readMfaConfig: async () => ({
    config: await (await import('@evtivity/database')).getMfaConfig(),
    fallback: reading.fallback,
  }),
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
  getMfaConfig: vi.fn(),
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
  createCappedMfaChallenge: vi.fn(async (c: unknown, o: unknown) =>
    (await import('@evtivity/lib')).createMfaChallenge(c as never, o as never),
  ),
  isMfaChallengeLimited: (r: object) => 'limited' in r,
  verifyMfaChallenge: vi.fn().mockResolvedValue('verified'),
  matchTotpStep: vi.fn().mockReturnValue(1),
}));

vi.mock('../services/refresh-token.service.js', () => ({
  createRefreshToken: vi
    .fn()
    .mockResolvedValue({ rawToken: 'new-refresh-token', expiresAt: new Date() }),
  validateAndRotateRefreshToken: vi.fn().mockResolvedValue(null),
  revokeRefreshToken: vi.fn().mockResolvedValue(undefined),
  endDriverSessions: vi.fn().mockResolvedValue(undefined),
  bumpDriverSessionVersion: vi.fn().mockResolvedValue(1),
  sessionRefreshTokenDriverId: vi.fn().mockResolvedValue(null),
}));

vi.mock('../lib/auth-audit.js', () => ({ recordAuthAudit: vi.fn(async () => undefined) }));

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
  clearSignInFailures,
  recordAttemptFailure,
  takeSignInAttempt,
} from '../lib/sign-in-backoff.js';
import { recordAuthAudit } from '../lib/auth-audit.js';
import { verifyMfaChallenge } from '@evtivity/lib';
import { getMfaConfig } from '@evtivity/database';
import { countRecoveryCodes } from '../services/mfa-factor.service.js';
import {
  validateAndRotateRefreshToken,
  revokeRefreshToken,
  sessionRefreshTokenDriverId,
} from '../services/refresh-token.service.js';
import { registerAuth } from '../plugins/auth.js';
import { portalAuthRoutes } from '../routes/portal/auth.js';

const DRIVER_ID = 'drv_000000000001';
const MOBILE = { 'x-client': 'mobile', 'x-device-id': 'device-123' };

const driverRow = {
  sessionVersion: 0,
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

const ALL_ON = {
  emailEnabled: true,
  totpEnabled: true,
  smsEnabled: true,
  required: 'off' as const,
  requiredRoles: [] as string[],
  webauthnEnabled: true,
  passkeyLoginEnabled: false,
  requireDrivers: false,
};
const LOGIN = { email: 'john@example.com', password: 'secret-password' };

describe('Portal driver MFA gates', () => {
  let app: FastifyInstance;
  let mfaToken: string;

  beforeAll(async () => {
    app = await buildApp();
    mfaToken = app.jwt.sign({
      driverId: DRIVER_ID,
      type: 'driver',
      mfaPending: true,
      sv: 0,
    } as never);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setupDbResults();
    writes.length = 0;
    reading.fallback = false;
    vi.mocked(getMfaConfig).mockResolvedValue(ALL_ON);
    vi.mocked(countRecoveryCodes).mockResolvedValue(0);
    vi.mocked(argon2.verify).mockResolvedValue(true);
  });

  describe('sign-in backoff', () => {
    it('answers a locked driver as a wrong password, without checking it', async () => {
      const lockedUntil = new Date(Date.now() + 60_000);
      // The guarded UPDATE that takes the try matches no row while the lock holds.
      vi.mocked(takeSignInAttempt).mockResolvedValueOnce({ granted: false, lockedUntil });
      setupDbResults([{ ...driverRow, loginLockedUntil: lockedUntil }]);
      const res = await app.inject({ method: 'POST', url: '/portal/auth/login', payload: LOGIN });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('INVALID_CREDENTIALS');
      // Only the dummy hash runs, never the driver's hash.
      expect(
        vi.mocked(argon2.verify).mock.calls.every((c) => c[0] !== driverRow.passwordHash),
      ).toBe(true);
      expect(recordAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kind: 'driver', reason: 'locked' }),
      );
      expect(recordAttemptFailure).not.toHaveBeenCalled();
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('counts a wrong password and clears the count after a right one', async () => {
      vi.mocked(argon2.verify).mockResolvedValueOnce(false);
      setupDbResults([driverRow]);
      const wrong = await app.inject({ method: 'POST', url: '/portal/auth/login', payload: LOGIN });
      expect(wrong.statusCode).toBe(401);
      expect(recordAttemptFailure).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ account: { driverId: DRIVER_ID }, factor: 'password' }),
      );

      setupDbResults([driverRow]);
      const right = await app.inject({ method: 'POST', url: '/portal/auth/login', payload: LOGIN });
      expect(right.statusCode).toBe(200);
      expect(clearSignInFailures).toHaveBeenCalledWith({ driverId: DRIVER_ID }, 'password');
    });

    it('answers 429 MFA_LOCKED at MFA verify while the driver is locked', async () => {
      vi.mocked(takeSignInAttempt).mockResolvedValueOnce({
        granted: false,
        lockedUntil: new Date(Date.now() + 90_000),
      });
      setupDbResults([
        {
          ...driverRow,
          mfaEnabled: true,
          mfaMethod: 'totp',
          totpSecretEnc: 'enc',
          mfaLockedUntil: new Date(Date.now() + 90_000),
        },
      ]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/verify',
        payload: { mfaToken, code: '123456' },
      });
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ code: 'MFA_LOCKED' });
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('counts a wrong MFA code, an exhausted challenge and a wrong recovery code', async () => {
      const smsDriver = { ...driverRow, mfaEnabled: true, mfaMethod: 'sms' };
      vi.mocked(verifyMfaChallenge).mockResolvedValueOnce('invalid');
      setupDbResults([smsDriver]);
      const wrong = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/verify',
        payload: { mfaToken, code: '000000', challengeId: 4 },
      });
      expect(wrong.json().code).toBe('MFA_CODE_INVALID');

      vi.mocked(verifyMfaChallenge).mockResolvedValueOnce('exhausted');
      setupDbResults([smsDriver]);
      const exhausted = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/verify',
        payload: { mfaToken, code: '000000', challengeId: 4 },
      });
      expect(exhausted.json().code).toBe('MFA_CHALLENGE_EXHAUSTED');

      vi.mocked(countRecoveryCodes).mockResolvedValue(3);
      setupDbResults([smsDriver]);
      const recovery = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/verify',
        payload: { mfaToken, recoveryCode: 'aaaaa-bbbbb' },
      });
      expect(recovery.json().code).toBe('MFA_CODE_INVALID');
      expect(recordAttemptFailure).toHaveBeenCalledTimes(3);
      for (const call of vi.mocked(recordAttemptFailure).mock.calls) {
        expect(call[1]).toMatchObject({ account: { driverId: DRIVER_ID }, factor: 'mfa' });
      }
    });

    it('clears the MFA count after a right code', async () => {
      setupDbResults([{ ...driverRow, mfaEnabled: true, mfaMethod: 'sms' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/mfa/verify',
        payload: { mfaToken, code: '123456', challengeId: 4 },
      });
      expect(res.statusCode).toBe(200);
      expect(clearSignInFailures).toHaveBeenCalledWith({ driverId: DRIVER_ID }, 'mfa');
    });
  });

  describe('required MFA for drivers', () => {
    beforeEach(() => {
      vi.mocked(getMfaConfig).mockResolvedValue({ ...ALL_ON, requireDrivers: true });
    });

    it('answers a web sign-in with the enrollment token and no session', async () => {
      setupDbResults([driverRow]);
      const res = await app.inject({ method: 'POST', url: '/portal/auth/login', payload: LOGIN });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        mfaEnrollmentRequired: true,
        availableMethods: ['email', 'totp', 'sms'],
        webauthnAvailable: true,
      });
      expect(body.driver).toBeUndefined();
      expect(res.headers['set-cookie']).toBeUndefined();
      const payload = app.jwt.verify<Record<string, unknown>>(body.enrollmentToken as string);
      expect(payload).toMatchObject({ driverId: DRIVER_ID, type: 'driver', mfaEnrollment: true });
    });

    it('gives the mobile app 403 MFA_ENROLLMENT_REQUIRED with a message naming the portal, never a token', async () => {
      setupDbResults([driverRow]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/login',
        headers: MOBILE,
        payload: LOGIN,
      });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.code).toBe('MFA_ENROLLMENT_REQUIRED');
      expect(body.error).toMatch(/Two-factor authentication is required/);
      expect(body.error).toContain('driver portal');
      expect(typeof body.portalUrl).toBe('string');
      expect(body.enrollmentToken).toBeUndefined();
      expect(body.token).toBeUndefined();
      expect(body.refreshToken).toBeUndefined();
      expect(recordAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'login_failed', reason: 'mfa_enrollment_required' }),
      );
    });

    it('refuses the sign-in with 503 when the MFA settings cannot be read', async () => {
      reading.fallback = true;
      setupDbResults([driverRow]);
      const res = await app.inject({ method: 'POST', url: '/portal/auth/login', payload: LOGIN });
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('MFA_POLICY_UNAVAILABLE');
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('refuses the sign-in with 403 MFA_SETUP_UNAVAILABLE when no method can be set up', async () => {
      vi.mocked(getMfaConfig).mockResolvedValue({
        ...ALL_ON,
        emailEnabled: false,
        totpEnabled: false,
        requireDrivers: true,
      });
      setupDbResults([{ ...driverRow, phone: null }]);
      const res = await app.inject({ method: 'POST', url: '/portal/auth/login', payload: LOGIN });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('MFA_SETUP_UNAVAILABLE');
    });

    it('lets a driver with MFA sign in through the MFA step as before', async () => {
      setupDbResults([{ ...driverRow, mfaEnabled: true, mfaMethod: 'totp' }]);
      const res = await app.inject({ method: 'POST', url: '/portal/auth/login', payload: LOGIN });
      expect(res.json()).toMatchObject({ mfaRequired: true, mfaMethod: 'totp' });
    });
  });

  describe('session renewal', () => {
    function holder(over: Record<string, unknown> = {}) {
      return { id: DRIVER_ID, isActive: true, mfaEnabled: false, mfaMethod: null, ...over };
    }

    it('revokes the refresh token of a driver without a factor once drivers must have MFA', async () => {
      vi.mocked(getMfaConfig).mockResolvedValue({ ...ALL_ON, requireDrivers: true });
      vi.mocked(sessionRefreshTokenDriverId).mockResolvedValue(DRIVER_ID);
      setupDbResults([holder()]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/refresh',
        headers: MOBILE,
        payload: { refreshToken: 'raw-refresh' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('MFA_ENROLLMENT_REQUIRED');
      expect(revokeRefreshToken).toHaveBeenCalledWith('raw-refresh');
      expect(validateAndRotateRefreshToken).not.toHaveBeenCalled();
      expect(sessionRefreshTokenDriverId).toHaveBeenCalledWith('raw-refresh', 'device-123');
    });

    it('keeps the refresh token and answers 503 when the MFA settings cannot be read', async () => {
      reading.fallback = true;
      vi.mocked(sessionRefreshTokenDriverId).mockResolvedValue(DRIVER_ID);
      setupDbResults([holder()]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/refresh',
        headers: MOBILE,
        payload: { refreshToken: 'raw-refresh' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('MFA_POLICY_UNAVAILABLE');
      expect(revokeRefreshToken).not.toHaveBeenCalled();
    });

    it('renews a driver with a factor while drivers must have MFA', async () => {
      vi.mocked(getMfaConfig).mockResolvedValue({ ...ALL_ON, requireDrivers: true });
      vi.mocked(sessionRefreshTokenDriverId).mockResolvedValue(DRIVER_ID);
      vi.mocked(validateAndRotateRefreshToken).mockResolvedValue({
        userId: null,
        driverId: DRIVER_ID,
        tokenId: 1,
        client: null,
      });
      setupDbResults(
        [holder({ mfaEnabled: true, mfaMethod: 'totp' })],
        [{ id: DRIVER_ID, isActive: true }],
      );
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/refresh',
        headers: MOBILE,
        payload: { refreshToken: 'raw-refresh' },
      });
      expect(res.statusCode).toBe(200);
      expect(revokeRefreshToken).not.toHaveBeenCalled();
    });
  });
});
