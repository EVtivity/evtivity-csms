// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';

// Each awaited query takes the next queued result.
let dbResults: unknown[][] = [];
let dbCallIndex = 0;
function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}
type Chain = Record<string, ReturnType<typeof vi.fn>> & { then: unknown };
const updates: Chain[] = [];
function makeChain(kind: string): Chain {
  const chain = {} as Chain;
  for (const m of ['from', 'where', 'values', 'returning', 'set', 'onConflictDoUpdate']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    const r = dbResults[dbCallIndex] ?? [];
    dbCallIndex++;
    return Promise.resolve(r).then(resolve, reject);
  };
  if (kind === 'update') updates.push(chain);
  return chain;
}

const { getMfaConfigMock, mfaReading, verifyRecoveryCodesPasskey } = vi.hoisted(() => ({
  getMfaConfigMock: vi.fn(),
  mfaReading: { fallback: false },
  verifyRecoveryCodesPasskey: vi.fn(),
}));

vi.mock('../lib/webauthn-http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/webauthn-http.js')>()),
  verifyRecoveryCodesPasskey,
}));

vi.mock('../lib/phone-change.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/phone-change.js')>()),
  checkPhoneChange: vi.fn(async () => null),
}));
vi.mock('../lib/sign-in-backoff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/sign-in-backoff.js')>();
  return {
    ...actual,
    clearSignInFailures: vi.fn().mockResolvedValue(undefined),
    acceptTotpStep: vi.fn().mockResolvedValue(true),
    takeSignInAttempt: vi.fn(async (account: unknown, factor: unknown) => ({
      granted: true,
      account,
      factor,
      failures: 1,
      lockedUntil: null,
    })),
    recordAttemptFailure: vi.fn(async () => null),
  };
});
// Security notices are fire-and-forget; their dispatch has its own test.
vi.mock('../lib/security-notice.js', () => ({
  sendSecurityNotice: vi.fn(),
  notifySecurityChange: vi.fn(async () => null),
  factorFlags: (factor: string) => ({ factorPasskey: factor === 'passkey' }),
}));

vi.mock('../services/mfa-factor.service.js', () => {
  const countRecoveryCodes = vi.fn(async (_account: unknown) => 0);
  return {
    countRecoveryCodes,
    // The gates read both counts; tests set the recovery code count.
    mfaFactorCounts: vi.fn(async (account: unknown) => ({
      recoveryCodesRemaining: await countRecoveryCodes(account),
      passkeyCount: 0,
    })),
    recoveryCodesUsedUp: vi.fn(async () => false),
    countWebauthnCredentials: vi.fn(async () => 0),
    consumeRecoveryCode: vi.fn(async () => ({ used: false, remaining: 0 })),
    issueRecoveryCodes: vi.fn(async () => []),
    deleteRecoveryCodes: vi.fn(async () => undefined),
    deleteWebauthnCredentials: vi.fn(async () => undefined),
  };
});
vi.mock('@evtivity/database', () => ({
  readMfaConfig: async () => ({
    config: await (await import('@evtivity/database')).getMfaConfig(),
    fallback: mfaReading.fallback,
  }),
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
  db: {
    select: vi.fn(() => makeChain('select')),
    insert: vi.fn(() => makeChain('insert')),
    update: vi.fn(() => makeChain('update')),
    // A transaction runs its callback on a recording executor of its own.
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ update: vi.fn(() => makeChain('update')), tx: true }),
    ),
  },
  client: { name: 'client' },
  drivers: {},
  driverNotificationPreferences: {},
  getMfaConfig: getMfaConfigMock,
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn(), sql: vi.fn(() => 'sql') }));

vi.mock('argon2', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$argon2id$new'),
    verify: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,QR') },
}));

vi.mock('@evtivity/lib', () => ({
  dispatchDriverNotification: vi.fn(),
  dispatchSystemNotification: vi.fn().mockResolvedValue(undefined),
  encryptString: vi.fn((v: string) => `enc(${v})`),
  decryptString: vi.fn((v: string) => v.replace(/^enc\((.*)\)$/, '$1')),
  generateTotpSecret: vi.fn(() => 'TOTPSECRET'),
  generateTotpUri: vi.fn(() => 'otpauth://totp/EVtivity:jane'),
  matchTotpStep: vi.fn(() => 1),
  createMfaChallenge: vi.fn().mockResolvedValue({ challengeId: 17, code: '654321' }),
  createCappedMfaChallenge: vi.fn(async (c: unknown, o: unknown) =>
    (await import('@evtivity/lib')).createMfaChallenge(c as never, o as never),
  ),
  isMfaChallengeLimited: (r: object) => 'limited' in r,
  verifyMfaChallenge: vi.fn().mockResolvedValue('verified'),
  isValidTimezone: vi.fn((tz: string) => tz !== 'Mars/Olympus'),
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({ publish: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock('@evtivity/services/template-dirs', () => ({
  ALL_TEMPLATES_DIRS: ['/mock/templates'],
}));

vi.mock('../lib/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/config.js')>();
  return { ...actual, config: { ...actual.config, SETTINGS_ENCRYPTION_KEY: 'test-key' } };
});

vi.mock('../services/refresh-token.service.js', () => ({
  endDriverSessions: vi.fn().mockResolvedValue(undefined),
}));

// Sessions are covered in driver-session tests; here only what the routes hand them.
vi.mock('../lib/driver-session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/driver-session.js')>()),
  issueDriverSession: vi.fn(
    async (
      _app: unknown,
      _request: unknown,
      reply: { status: (n: number) => { send: (b: unknown) => Promise<void> } },
      driver: unknown,
      opts?: { extra?: Record<string, unknown> },
    ) => {
      await reply.status(200).send({ driver, ...opts?.extra });
    },
  ),
  issueDriverTokens: vi.fn(async () => null),
}));

// The proof checks are covered in mfa-factor-proof.test.ts; here only the routes' use of them.
vi.mock('../lib/mfa-factor-proof.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/mfa-factor-proof.js')>()),
  checkFactorProof: vi.fn(async () => null),
  proofAccountOf: vi.fn(async () => null),
}));

import argon2 from 'argon2';
import {
  dispatchSystemNotification,
  createCappedMfaChallenge,
  decryptString,
  verifyMfaChallenge,
} from '@evtivity/lib';
import { writeAudit } from '@evtivity/database';
import { registerAuth } from '../plugins/auth.js';
import { portalDriverRoutes } from '../routes/portal/driver.js';
import { checkFactorProof } from '../lib/mfa-factor-proof.js';
import { countRecoveryCodes, issueRecoveryCodes } from '../services/mfa-factor.service.js';
import { recordAttemptFailure } from '../lib/sign-in-backoff.js';

const DRIVER_ID = 'drv_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie, { secret: 'test-cookie-secret-12345' });
  await registerAuth(app);
  await app.register(portalDriverRoutes);
  await app.ready();
  return app;
}

const POLICY = {
  required: 'off' as const,
  requiredRoles: [] as string[],
  webauthnEnabled: true,
  passkeyLoginEnabled: false,
  requireDrivers: false,
};
const allMethods = { emailEnabled: true, totpEnabled: true, smsEnabled: true, ...POLICY };
const noMethods = { emailEnabled: false, totpEnabled: false, smsEnabled: false, ...POLICY };

describe('Portal driver routes, uncovered paths', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = await buildApp();
    auth = { authorization: `Bearer ${app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    updates.length = 0;
    vi.mocked(writeAudit).mockClear();
    getMfaConfigMock.mockResolvedValue(allMethods);
    vi.mocked(argon2.verify).mockResolvedValue(true);
    vi.mocked(countRecoveryCodes).mockResolvedValue(0);
    vi.mocked(issueRecoveryCodes).mockResolvedValue(['abcde-fghjk']);
  });

  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url, headers: auth, payload });

  describe('POST /portal/driver/phone-verification', () => {
    const smsDriver = {
      firstName: 'Jane',
      language: 'de',
      phone: '+12015550111',
      mfaEnabled: true,
      mfaMethod: 'sms',
    };

    it('refuses a number that does not parse before any read', async () => {
      const res = await post('/portal/driver/phone-verification', { phone: 'not a phone' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(checkFactorProof).not.toHaveBeenCalled();
    });

    it('answers 404 for a driver row that is gone', async () => {
      setupDbResults([]);
      const res = await post('/portal/driver/phone-verification', { phone: '+12015550123' });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('DRIVER_NOT_FOUND');
    });

    it('refuses a driver without SMS sign-in and the current number, spending no proof', async () => {
      setupDbResults([{ ...smsDriver, mfaMethod: 'totp' }]);
      const notSms = await post('/portal/driver/phone-verification', { phone: '+12015550123' });
      expect(notSms.statusCode).toBe(400);
      expect(notSms.json().error).toContain('SMS codes');
      setupDbResults([smsDriver]);
      const same = await post('/portal/driver/phone-verification', { phone: '+1 201 555 0111' });
      expect(same.statusCode).toBe(400);
      expect(same.json().error).toBe('This is already your number');
      expect(checkFactorProof).not.toHaveBeenCalled();
    });

    it('sends the proof refusal and texts nothing', async () => {
      vi.mocked(checkFactorProof).mockResolvedValueOnce({
        status: 400,
        body: { error: 'Invalid password', code: 'INVALID_PASSWORD' },
      } as never);
      setupDbResults([smsDriver]);
      const res = await post('/portal/driver/phone-verification', { phone: '+12015550123' });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_PASSWORD');
      expect(dispatchSystemNotification).not.toHaveBeenCalled();
    });

    it('answers 429 beyond the code cap', async () => {
      vi.mocked(createCappedMfaChallenge).mockResolvedValueOnce({
        limited: true,
        retryAfterSeconds: 120,
        openChallengeId: null,
      } as never);
      setupDbResults([smsDriver]);
      const res = await post('/portal/driver/phone-verification', { phone: '+12015550123' });
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ code: 'MFA_RESEND_LIMITED', retryAfterSeconds: 120 });
      expect(dispatchSystemNotification).not.toHaveBeenCalled();
    });

    it('texts a code bound to the new number in E.164', async () => {
      setupDbResults([smsDriver]);
      const res = await post('/portal/driver/phone-verification', { phone: '(201) 555-0123' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ challengeId: 17 });
      expect(createCappedMfaChallenge).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          driverId: DRIVER_ID,
          purpose: 'setup',
          destination: '+12015550123',
        }),
        expect.anything(),
      );
      expect(dispatchSystemNotification).toHaveBeenCalledWith(
        expect.anything(),
        'mfa.VerificationCode',
        { phone: '+12015550123', language: 'de', firstName: 'Jane' },
        { code: '654321' },
        ['/mock/templates'],
      );
    });
  });

  describe('PATCH /portal/driver/profile', () => {
    it('refuses a phone that does not parse', async () => {
      setupDbResults([{ mfaEnabled: false, mfaMethod: null, phone: null }]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/profile',
        headers: auth,
        payload: { phone: 'abc' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(updates).toHaveLength(0);
    });
  });

  describe('POST /portal/driver/mfa/confirm', () => {
    it('answers 403 MFA_METHOD_DISABLED for a method turned off', async () => {
      getMfaConfigMock.mockResolvedValue(noMethods);
      const res = await post('/portal/driver/mfa/confirm', { method: 'sms', code: '123456' });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('MFA_METHOD_DISABLED');
    });
  });

  describe('DELETE /portal/driver/mfa', () => {
    const del = () =>
      app.inject({ method: 'DELETE', url: '/portal/driver/mfa', headers: auth, payload: {} });

    it('answers 400 DRIVER_NOT_FOUND for a driver without a password', async () => {
      setupDbResults([{ passwordHash: null, mfaMethod: 'totp' }]);
      const res = await del();
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('DRIVER_NOT_FOUND');
    });

    it('fails closed with 503 while the MFA settings cannot be read', async () => {
      mfaReading.fallback = true;
      setupDbResults([{ passwordHash: '$argon2id$x', mfaMethod: 'totp' }]);
      const res = await del();
      mfaReading.fallback = false;
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('MFA_POLICY_UNAVAILABLE');
      expect(updates).toHaveLength(0);
    });

    it('keeps MFA on while required MFA covers drivers', async () => {
      getMfaConfigMock.mockResolvedValue({ ...allMethods, requireDrivers: true });
      setupDbResults([{ passwordHash: '$argon2id$x', mfaMethod: 'totp' }]);
      const res = await del();
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('MFA_REQUIRED_BY_POLICY');
    });
  });

  describe('POST /portal/driver/mfa/recovery-codes (cov3)', () => {
    const credential = {
      id: 'Y3JlZA',
      rawId: 'Y3JlZA',
      type: 'public-key',
      response: { clientDataJSON: 'YQ', authenticatorData: 'YQ', signature: 'YQ' },
      clientExtensionResults: {},
    };
    const url = '/portal/driver/mfa/recovery-codes';

    it('refuses a code and a passkey together', async () => {
      const res = await post(url, { code: '123456', credential });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Send a code or a passkey, not both');
      expect(verifyRecoveryCodesPasskey).not.toHaveBeenCalled();
    });

    it.each([
      ['challenge_expired', 'WEBAUTHN_CHALLENGE_EXPIRED'],
      ['failed', 'WEBAUTHN_VERIFICATION_FAILED'],
    ])('maps a passkey result %s to %s', async (result, code) => {
      verifyRecoveryCodesPasskey.mockResolvedValueOnce(result);
      const res = await post(url, { credential });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(code);
      expect(issueRecoveryCodes).not.toHaveBeenCalled();
    });

    it('replaces the codes after a verified passkey', async () => {
      verifyRecoveryCodesPasskey.mockResolvedValueOnce('verified');
      const res = await post(url, { credential });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ recoveryCodes: ['abcde-fghjk'] });
      expect(verifyRecoveryCodesPasskey).toHaveBeenCalledWith(
        expect.anything(),
        { driverId: DRIVER_ID },
        expect.objectContaining({ id: 'Y3JlZA' }),
      );
    });

    const driver = {
      mfaEnabled: true,
      mfaMethod: 'totp',
      totpSecretEnc: null as string | null,
      email: 'jane@example.com',
      phone: null,
      firstName: 'Jane',
      language: 'en',
    };

    it('asks a TOTP driver for the app code instead of sending one', async () => {
      setupDbResults([{ ...driver, totpSecretEnc: 'enc(S)' }]);
      const res = await post(url, {});
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Send the code from your authenticator app');
      expect(createCappedMfaChallenge).not.toHaveBeenCalled();
    });

    it('answers 400 TOTP_NOT_CONFIGURED for a TOTP driver without a secret', async () => {
      setupDbResults([driver]);
      const res = await post(url, { code: '123456' });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('TOTP_NOT_CONFIGURED');
    });

    it('refuses the code when the TOTP secret does not decrypt and counts the try', async () => {
      vi.mocked(decryptString).mockImplementationOnce(() => {
        throw new Error('bad key');
      });
      setupDbResults([{ ...driver, totpSecretEnc: 'enc(S)' }]);
      const res = await post(url, { code: '123456' });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_CODE_INVALID');
      expect(recordAttemptFailure).toHaveBeenCalled();
      expect(issueRecoveryCodes).not.toHaveBeenCalled();
    });

    it('refuses an email code without a challenge id', async () => {
      setupDbResults([{ ...driver, mfaMethod: 'email' }]);
      const res = await post(url, { code: '123456' });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_CODE_INVALID');
      expect(verifyMfaChallenge).not.toHaveBeenCalled();
    });
  });
});
