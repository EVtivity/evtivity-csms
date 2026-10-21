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

const { getMfaConfigMock } = vi.hoisted(() => ({ getMfaConfigMock: vi.fn() }));

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
    fallback: false,
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
import QRCode from 'qrcode';
import {
  dispatchDriverNotification,
  dispatchSystemNotification,
  createMfaChallenge,
  createCappedMfaChallenge,
  decryptString,
  matchTotpStep,
  verifyMfaChallenge,
} from '@evtivity/lib';
import { writeAudit } from '@evtivity/database';
import { registerAuth } from '../plugins/auth.js';
import { portalDriverRoutes } from '../routes/portal/driver.js';
import { endDriverSessions } from '../services/refresh-token.service.js';
import { issueDriverSession, issueDriverTokens } from '../lib/driver-session.js';
import { checkFactorProof, proofAccountOf } from '../lib/mfa-factor-proof.js';
import {
  countRecoveryCodes,
  deleteRecoveryCodes,
  issueRecoveryCodes,
} from '../services/mfa-factor.service.js';
import { acceptTotpStep, recordAttemptFailure, takeSignInAttempt } from '../lib/sign-in-backoff.js';

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

  describe('PATCH /portal/driver/profile', () => {
    it('stores timezone, theme and distance unit', async () => {
      const updated = {
        id: DRIVER_ID,
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@example.com',
        phone: null,
        language: 'en',
        timezone: 'Asia/Seoul',
        themePreference: 'dark',
        distanceUnit: 'km',
        priceDisplay: null,
        isActive: true,
        createdAt: new Date().toISOString(),
      };
      setupDbResults([{ ...updated, lastName: 'Doe' }], [updated]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/profile',
        headers: auth,
        payload: {
          lastName: 'Kim',
          phone: '+821012345678',
          timezone: 'Asia/Seoul',
          themePreference: 'dark',
          distanceUnit: 'km',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ timezone: 'Asia/Seoul', distanceUnit: 'km' });
      expect(updates[0]?.['set']).toHaveBeenCalledWith(
        expect.objectContaining({
          lastName: 'Kim',
          phone: '+821012345678',
          timezone: 'Asia/Seoul',
          themePreference: 'dark',
          distanceUnit: 'km',
        }),
      );
    });

    it('rejects an unknown IANA timezone before any write', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/profile',
        headers: auth,
        payload: { timezone: 'Mars/Olympus' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'Invalid IANA timezone', code: 'VALIDATION_ERROR' });
      expect(updates).toHaveLength(0);
    });

    it('stores an empty phone as no phone', async () => {
      setupDbResults(
        [{ phone: '+12015550111', mfaEnabled: false, mfaMethod: null }],
        [
          {
            id: DRIVER_ID,
            firstName: 'Jane',
            lastName: 'Doe',
            email: 'jane@example.com',
            phone: null,
            language: 'en',
            timezone: 'Asia/Seoul',
            themePreference: 'light',
            distanceUnit: 'km',
            priceDisplay: null,
            isActive: true,
            createdAt: new Date().toISOString(),
          },
        ],
      );
      const res = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/profile',
        headers: auth,
        payload: { phone: ' ' },
      });
      expect(res.statusCode).toBe(200);
      expect(updates[0]?.['set']).toHaveBeenCalledWith(expect.objectContaining({ phone: null }));
    });

    it('refuses to remove the phone while the driver signs in with SMS codes', async () => {
      setupDbResults([{ phone: '+12015550111', mfaEnabled: true, mfaMethod: 'sms' }]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/profile',
        headers: auth,
        payload: { phone: '' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(updates).toHaveLength(0);
    });
  });

  describe('PATCH /portal/driver/password', () => {
    it('rejects a new password without an uppercase letter and keeps the old hash', async () => {
      setupDbResults([{ passwordHash: '$argon2id$old' }]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/password',
        headers: auth,
        payload: { currentPassword: 'OldPassword1', newPassword: 'alllowercase123' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Password must contain an uppercase letter',
        code: 'WEAK_PASSWORD',
        missing: ['uppercase'],
      });
      expect(updates).toHaveLength(0);
      expect(endDriverSessions).not.toHaveBeenCalled();
    });

    it('counts a wrong current password toward the password backoff', async () => {
      vi.mocked(argon2.verify).mockResolvedValueOnce(false);
      setupDbResults([{ passwordHash: '$argon2id$old', loginLockedUntil: null }]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/password',
        headers: auth,
        payload: { currentPassword: 'Wrong1Password', newPassword: 'NewPassword123' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_PASSWORD');
      expect(recordAttemptFailure).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ account: { driverId: DRIVER_ID }, factor: 'password' }),
      );
      expect(updates).toHaveLength(0);
    });

    it('refuses the current password unchecked while the password backoff locks the driver', async () => {
      vi.mocked(argon2.verify).mockClear();
      setupDbResults([
        { passwordHash: '$argon2id$old', loginLockedUntil: new Date(Date.now() + 60_000) },
      ]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/password',
        headers: auth,
        payload: { currentPassword: 'OldPassword1', newPassword: 'NewPassword123' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_PASSWORD');
      expect(argon2.verify).not.toHaveBeenCalled();
      expect(recordAttemptFailure).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
    });
  });

  describe('GET /portal/driver/mfa', () => {
    it('lists the enabled methods and the driver MFA state', async () => {
      setupDbResults([
        { mfaEnabled: true, mfaMethod: 'totp', email: 'jane@example.com', phone: '+12015550111' },
      ]);
      const res = await app.inject({ method: 'GET', url: '/portal/driver/mfa', headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        mfaEnabled: true,
        mfaMethod: 'totp',
        availableMethods: ['email', 'totp', 'sms'],
        recoveryCodesRemaining: 0,
        recoveryCodesUsedUp: false,
        requiredByPolicy: false,
        passkeyCount: 0,
        webauthnEnabled: true,
        passkeyLoginEnabled: false,
        factorProofKinds: [],
        lastFactorIsPasskey: false,
        lastFactorProofKinds: [],
      });
    });

    it('counts the unused recovery codes', async () => {
      vi.mocked(countRecoveryCodes).mockResolvedValue(9);
      setupDbResults([{ mfaEnabled: true, mfaMethod: 'totp', email: null, phone: null }]);
      const res = await app.inject({ method: 'GET', url: '/portal/driver/mfa', headers: auth });
      expect(res.json().recoveryCodesRemaining).toBe(9);
      expect(countRecoveryCodes).toHaveBeenCalledWith({ driverId: DRIVER_ID });
    });

    it('leaves out SMS without a phone number and email without an email address', async () => {
      setupDbResults([{ mfaEnabled: false, mfaMethod: null, email: null, phone: null }]);
      const res = await app.inject({ method: 'GET', url: '/portal/driver/mfa', headers: auth });
      expect(res.json().availableMethods).toEqual(['totp']);
    });

    it('defaults to disabled with no methods when the driver row is missing', async () => {
      getMfaConfigMock.mockResolvedValueOnce(noMethods);
      setupDbResults([]);
      const res = await app.inject({ method: 'GET', url: '/portal/driver/mfa', headers: auth });
      expect(res.json()).toEqual({
        mfaEnabled: false,
        mfaMethod: null,
        availableMethods: [],
        recoveryCodesRemaining: 0,
        recoveryCodesUsedUp: false,
        requiredByPolicy: false,
        passkeyCount: 0,
        webauthnEnabled: true,
        passkeyLoginEnabled: false,
        factorProofKinds: [],
        lastFactorIsPasskey: false,
        lastFactorProofKinds: [],
      });
    });
  });

  describe('POST /portal/driver/mfa/setup', () => {
    const driver = {
      email: 'jane@example.com',
      phone: '+12015550111',
      firstName: 'Jane',
      language: 'de',
      mfaEnabled: false,
    };

    it.each(['email', 'totp', 'sms'] as const)(
      'returns 403 when %s is disabled by the administrator',
      async (method) => {
        getMfaConfigMock.mockResolvedValueOnce(noMethods);
        const res = await app.inject({
          method: 'POST',
          url: '/portal/driver/mfa/setup',
          headers: auth,
          payload: { method },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('MFA_METHOD_DISABLED');
      },
    );

    it('returns 400 when the driver does not exist', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/setup',
        headers: auth,
        payload: { method: 'email' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('DRIVER_NOT_FOUND');
    });

    it('returns 409 when MFA is already enabled', async () => {
      setupDbResults([{ ...driver, mfaEnabled: true }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/setup',
        headers: auth,
        payload: { method: 'totp' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('MFA_ALREADY_ENABLED');
      expect(updates).toHaveLength(0);
    });

    it('stores the encrypted TOTP secret and returns the QR code', async () => {
      setupDbResults([driver]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/setup',
        headers: auth,
        payload: { method: 'totp' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ qrDataUri: 'data:image/png;base64,QR', secret: 'TOTPSECRET' });
      expect(QRCode.toDataURL).toHaveBeenCalledWith('otpauth://totp/EVtivity:jane');
      expect(updates[0]?.['set']).toHaveBeenCalledWith(
        expect.objectContaining({ totpSecretEnc: 'enc(TOTPSECRET)' }),
      );
    });

    it('answers 429 and sends no SMS over the resend cap', async () => {
      vi.mocked(createCappedMfaChallenge).mockResolvedValueOnce({
        limited: true,
        retryAfterSeconds: 200,
        openChallengeId: null,
      });
      setupDbResults([driver]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/setup',
        headers: auth,
        payload: { method: 'sms' },
      });
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ code: 'MFA_RESEND_LIMITED', retryAfterSeconds: 200 });
      expect(dispatchSystemNotification).not.toHaveBeenCalled();
    });

    it('sends an SMS challenge code and returns the challenge id', async () => {
      setupDbResults([driver]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/setup',
        headers: auth,
        payload: { method: 'sms' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ challengeId: 17 });
      // A setup code to a number the driver has not proven: bound to it, every account counted.
      expect(createMfaChallenge).toHaveBeenCalledWith(expect.anything(), {
        driverId: DRIVER_ID,
        method: 'sms',
        purpose: 'setup',
        destination: '+12015550111',
      });
      expect(createCappedMfaChallenge).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ destinationMax: 3, destinationScope: 'all' }),
      );
      // The SMS code goes by SMS only.
      expect(dispatchSystemNotification).toHaveBeenCalledWith(
        expect.anything(),
        'mfa.VerificationCode',
        { phone: '+12015550111', firstName: 'Jane', language: 'de' },
        { code: '654321' },
        ['/mock/templates'],
      );
    });

    it('sends an email code to the email address only', async () => {
      setupDbResults([driver]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/setup',
        headers: auth,
        payload: { method: 'email' },
      });
      expect(res.statusCode).toBe(200);
      expect(dispatchSystemNotification).toHaveBeenCalledWith(
        expect.anything(),
        'mfa.VerificationCode',
        { email: 'jane@example.com', firstName: 'Jane', language: 'de' },
        { code: '654321' },
        ['/mock/templates'],
      );
    });

    it.each([
      ['sms', { phone: null }],
      ['email', { email: null }],
    ] as const)('refuses %s codes without the contact to send them to', async (method, contact) => {
      setupDbResults([{ ...driver, ...contact }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/setup',
        headers: auth,
        payload: { method },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(createMfaChallenge).not.toHaveBeenCalled();
      expect(dispatchSystemNotification).not.toHaveBeenCalled();
    });
  });

  describe('POST /portal/driver/mfa/confirm', () => {
    it('asks a driver that has a passkey for a proof, and lets the app confirm without one otherwise', async () => {
      vi.mocked(proofAccountOf).mockResolvedValueOnce({
        mfaEnabled: false,
        mfaMethod: null,
        passkeyCount: 1,
        hasPassword: true,
      });
      vi.mocked(checkFactorProof).mockResolvedValueOnce({
        status: 400,
        body: { error: 'Confirm', code: 'VALIDATION_ERROR', proofKinds: ['passkey'] },
      });
      setupDbResults([{ totpSecretEnc: 'enc(TOTPSECRET)', mfaEnabled: false }]);
      const refused = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/confirm',
        headers: auth,
        payload: { method: 'totp', code: '123456' },
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ code: 'VALIDATION_ERROR', proofKinds: ['passkey'] });
      expect(updates).toHaveLength(0);

      // Without a factor (password only) no proof is needed: the mobile app sends none.
      vi.mocked(proofAccountOf).mockResolvedValueOnce({
        mfaEnabled: false,
        mfaMethod: null,
        passkeyCount: 0,
        hasPassword: true,
      });
      vi.mocked(checkFactorProof).mockClear();
      setupDbResults([{ totpSecretEnc: 'enc(TOTPSECRET)', mfaEnabled: false }]);
      const mobileToken = app.jwt.sign({ driverId: DRIVER_ID, type: 'driver', client: 'mobile' });
      const ok = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/confirm',
        headers: { authorization: `Bearer ${mobileToken}` },
        payload: { method: 'totp', code: '123456' },
      });
      expect(ok.statusCode).toBe(200);
      expect(checkFactorProof).not.toHaveBeenCalled();
      // Turning MFA on ends every other session of the driver; this client gets new tokens.
      expect(endDriverSessions).toHaveBeenCalledWith(DRIVER_ID);
      expect(issueDriverTokens).toHaveBeenCalled();
    });

    it('asks a portal cookie value resent as a Bearer token for the proof', async () => {
      // The portal cookie holds a token without the mobile claim.
      vi.mocked(proofAccountOf).mockResolvedValueOnce({
        mfaEnabled: false,
        mfaMethod: null,
        passkeyCount: 0,
        hasPassword: true,
      });
      vi.mocked(checkFactorProof).mockResolvedValueOnce({
        status: 400,
        body: { error: 'Confirm', code: 'VALIDATION_ERROR', proofKinds: ['password'] },
      });
      setupDbResults([{ totpSecretEnc: 'enc(TOTPSECRET)', mfaEnabled: false }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/confirm',
        headers: auth,
        payload: { method: 'totp', code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR', proofKinds: ['password'] });
      expect(checkFactorProof).toHaveBeenCalledWith(
        expect.anything(),
        { driverId: DRIVER_ID },
        undefined,
      );
      expect(updates).toHaveLength(0);
    });

    it('refuses a portal cookie session without a proof, even for a driver without a factor', async () => {
      const cookies = {
        portal_token: app.signCookie(app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' })),
      };
      vi.mocked(proofAccountOf).mockResolvedValueOnce({
        mfaEnabled: false,
        mfaMethod: null,
        passkeyCount: 0,
        hasPassword: true,
      });
      vi.mocked(checkFactorProof).mockResolvedValueOnce({
        status: 400,
        body: { error: 'Confirm', code: 'VALIDATION_ERROR', proofKinds: ['password'] },
      });
      setupDbResults([{ totpSecretEnc: 'enc(TOTPSECRET)', mfaEnabled: false }]);
      const refused = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/confirm',
        cookies,
        payload: { method: 'totp', code: '123456' },
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ code: 'VALIDATION_ERROR', proofKinds: ['password'] });
      expect(checkFactorProof).toHaveBeenCalledWith(
        expect.anything(),
        { driverId: DRIVER_ID },
        undefined,
      );
      expect(updates).toHaveLength(0);

      // With the password proof the same cookie session confirms.
      vi.mocked(proofAccountOf).mockResolvedValueOnce({
        mfaEnabled: false,
        mfaMethod: null,
        passkeyCount: 0,
        hasPassword: true,
      });
      vi.mocked(checkFactorProof).mockClear();
      setupDbResults([{ totpSecretEnc: 'enc(TOTPSECRET)', mfaEnabled: false }]);
      const proof = { kind: 'password', password: 'secret' };
      const ok = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/confirm',
        cookies,
        payload: { method: 'totp', code: '123456', proof },
      });
      expect(ok.statusCode).toBe(200);
      expect(checkFactorProof).toHaveBeenCalledWith(
        expect.anything(),
        { driverId: DRIVER_ID },
        proof,
      );
    });

    it('checks a proof the portal sends for a driver without a factor', async () => {
      setupDbResults([{ totpSecretEnc: 'enc(TOTPSECRET)', mfaEnabled: false }]);
      const proof = { kind: 'password', password: 'secret' };
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/confirm',
        headers: auth,
        payload: { method: 'totp', code: '123456', proof },
      });
      expect(res.statusCode).toBe(200);
      expect(checkFactorProof).toHaveBeenCalledWith(
        expect.anything(),
        { driverId: DRIVER_ID },
        proof,
      );
    });

    it('signs the driver in with the enrollment token, once', async () => {
      const enrollment = `Bearer ${app.jwt.sign({
        driverId: DRIVER_ID,
        type: 'driver',
        mfaEnrollment: true,
        sv: 0,
      } as never)}`;
      // The guard reads the driver (no factor), then the confirm reads the setup and
      // wins the compare-and-set on the session version.
      setupDbResults(
        [{ mfaEnabled: false, mfaMethod: null }],
        [{ totpSecretEnc: 'enc(TOTPSECRET)', mfaEnabled: false }],
        [{ id: DRIVER_ID }],
        [{ id: DRIVER_ID, email: 'jane@example.com', firstName: 'Jane', lastName: 'Doe' }],
      );
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/confirm',
        headers: { authorization: enrollment },
        payload: { method: 'totp', code: '123456' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        success: true,
        recoveryCodes: ['abcde-fghjk'],
        driver: { id: DRIVER_ID },
      });
      expect(checkFactorProof).not.toHaveBeenCalled();
      expect(updates[0]?.['set']).toHaveBeenCalledWith(
        expect.objectContaining({ mfaEnabled: true, sessionVersion: expect.anything() }),
      );
      expect(issueDriverSession).toHaveBeenCalledTimes(1);

      // The other confirm with the same token lost the compare-and-set: no session.
      vi.mocked(issueDriverSession).mockClear();
      setupDbResults(
        [{ mfaEnabled: false, mfaMethod: null }],
        [{ totpSecretEnc: 'enc(TOTPSECRET)', mfaEnabled: false }],
        [],
      );
      const lost = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/confirm',
        headers: { authorization: enrollment },
        payload: { method: 'totp', code: '123456' },
      });
      expect(lost.statusCode).toBe(401);
      expect(issueDriverSession).not.toHaveBeenCalled();
    });

    it('refuses the enrollment token once the driver has a usable factor', async () => {
      const enrollment = `Bearer ${app.jwt.sign({
        driverId: DRIVER_ID,
        type: 'driver',
        mfaEnrollment: true,
        sv: 0,
      } as never)}`;
      setupDbResults([{ mfaEnabled: true, mfaMethod: 'totp' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/confirm',
        headers: { authorization: enrollment },
        payload: { method: 'totp', code: '123456' },
      });
      expect(res.statusCode).toBe(401);
      expect(updates).toHaveLength(0);
    });

    it('refuses the enrollment token on every other driver route', async () => {
      const enrollment = `Bearer ${app.jwt.sign({
        driverId: DRIVER_ID,
        type: 'driver',
        mfaEnrollment: true,
        sv: 0,
      } as never)}`;
      const res = await app.inject({
        method: 'GET',
        url: '/portal/driver/mfa',
        headers: { authorization: enrollment },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('MFA_ENROLLMENT_REQUIRED');
    });

    it('returns 409 and keeps the method when MFA is already enabled', async () => {
      setupDbResults([{ totpSecretEnc: null, mfaEnabled: true }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/confirm',
        headers: auth,
        payload: { method: 'email', code: '654321', challengeId: 17 },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('MFA_ALREADY_ENABLED');
      expect(verifyMfaChallenge).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
    });

    it('returns 400 TOTP_NOT_CONFIGURED when no secret is stored', async () => {
      setupDbResults([{ totpSecretEnc: null }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/confirm',
        headers: auth,
        payload: { method: 'totp', code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('TOTP_NOT_CONFIGURED');
    });

    it('returns 400 TOTP_NOT_CONFIGURED when the secret cannot be decrypted', async () => {
      vi.mocked(decryptString).mockImplementationOnce(() => {
        throw new Error('bad ciphertext');
      });
      setupDbResults([{ totpSecretEnc: 'garbage' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/confirm',
        headers: auth,
        payload: { method: 'totp', code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('TOTP_NOT_CONFIGURED');
      expect(updates).toHaveLength(0);
    });

    it('returns 400 MFA_CODE_INVALID for a wrong TOTP code', async () => {
      vi.mocked(matchTotpStep).mockReturnValueOnce(null);
      setupDbResults([{ totpSecretEnc: 'enc(TOTPSECRET)' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/confirm',
        headers: auth,
        payload: { method: 'totp', code: '000000' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_CODE_INVALID');
      expect(matchTotpStep).toHaveBeenCalledWith('TOTPSECRET', '000000');
    });

    it('enables TOTP MFA for a valid code', async () => {
      setupDbResults([{ totpSecretEnc: 'enc(TOTPSECRET)' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/confirm',
        headers: auth,
        payload: { method: 'totp', code: '123456' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, recoveryCodes: ['abcde-fghjk'] });
      expect(issueRecoveryCodes).toHaveBeenCalledWith(
        { driverId: DRIVER_ID },
        'generated',
        expect.objectContaining({ actor: expect.objectContaining({ actorDriverId: DRIVER_ID }) }),
      );
      // The confirming code's time step is stored, so it cannot be replayed at sign-in.
      expect(updates[0]?.['set']).toHaveBeenCalledWith(
        expect.objectContaining({ mfaEnabled: true, mfaMethod: 'totp', totpLastStep: 1 }),
      );
      expect(vi.mocked(writeAudit)).toHaveBeenCalledWith(
        expect.objectContaining({ idColumn: 'driver_id' }),
        expect.objectContaining({
          entityId: DRIVER_ID,
          action: 'mfa_enabled',
          actor: 'driver',
          after: { mfaMethod: 'totp' },
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('verifies an email challenge for this driver and enables MFA', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/confirm',
        headers: auth,
        payload: { method: 'email', code: '654321', challengeId: 17 },
      });
      expect(res.statusCode).toBe(200);
      expect(verifyMfaChallenge).toHaveBeenCalledWith(expect.anything(), 17, '654321', {
        driverId: DRIVER_ID,
        method: 'email',
        purpose: 'setup',
        destination: undefined,
      });
      expect(updates[0]?.['set']).toHaveBeenCalledWith(
        expect.objectContaining({ mfaEnabled: true, mfaMethod: 'email' }),
      );
    });

    it('rejects an email confirmation without a challenge id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/confirm',
        headers: auth,
        payload: { method: 'sms', code: '654321' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_CODE_INVALID');
      expect(verifyMfaChallenge).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
    });
  });

  describe('DELETE /portal/driver/mfa', () => {
    const RECOVERY_PROOF = { kind: 'recovery_code', recoveryCode: 'abcde-fghjk' };

    it('keeps MFA on while required MFA covers drivers, before the proof check', async () => {
      getMfaConfigMock.mockResolvedValue({ ...allMethods, requireDrivers: true });
      setupDbResults([{ passwordHash: '$argon2id$x', mfaMethod: 'totp' }]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/portal/driver/mfa',
        headers: auth,
        payload: { proof: RECOVERY_PROOF },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('MFA_REQUIRED_BY_POLICY');
      expect(checkFactorProof).not.toHaveBeenCalled();
      expect(deleteRecoveryCodes).not.toHaveBeenCalled();
    });

    it('returns 400 when the driver has no password', async () => {
      setupDbResults([{ passwordHash: null }]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/portal/driver/mfa',
        headers: auth,
        payload: { proof: RECOVERY_PROOF },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('DRIVER_NOT_FOUND');
    });

    it('asks for a removal proof, never taking the password alone, and keeps MFA on', async () => {
      vi.mocked(checkFactorProof).mockResolvedValueOnce({
        status: 400,
        body: {
          error: 'Confirm with a factor you have or a recovery code',
          code: 'VALIDATION_ERROR',
          proofKinds: ['totp', 'recovery_code'],
        },
      });
      setupDbResults([{ passwordHash: '$argon2id$old', mfaMethod: 'totp' }]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/portal/driver/mfa',
        headers: auth,
        payload: { password: 'Correct1Password' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        proofKinds: ['totp', 'recovery_code'],
      });
      // The password field is not part of the body: the proof check gets none.
      expect(checkFactorProof).toHaveBeenCalledWith(
        expect.anything(),
        { driverId: DRIVER_ID },
        undefined,
        'remove',
      );
      expect(argon2.verify).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
      expect(deleteRecoveryCodes).not.toHaveBeenCalled();
      expect(endDriverSessions).not.toHaveBeenCalled();
      expect(issueDriverTokens).not.toHaveBeenCalled();
      expect(dispatchDriverNotification).not.toHaveBeenCalled();
    });

    it('keeps MFA on when the proof is refused', async () => {
      vi.mocked(checkFactorProof).mockResolvedValueOnce({
        status: 400,
        body: { error: 'Invalid recovery code', code: 'MFA_CODE_INVALID' },
      });
      setupDbResults([{ passwordHash: '$argon2id$old', mfaMethod: 'email' }]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/portal/driver/mfa',
        headers: auth,
        payload: { proof: RECOVERY_PROOF },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_CODE_INVALID');
      expect(updates).toHaveLength(0);
      expect(deleteRecoveryCodes).not.toHaveBeenCalled();
      expect(endDriverSessions).not.toHaveBeenCalled();
    });

    it('points a mobile app request without a proof at the portal', async () => {
      const mobileToken = app.jwt.sign({ driverId: DRIVER_ID, type: 'driver', client: 'mobile' });
      setupDbResults([{ passwordHash: '$argon2id$old', mfaMethod: 'email' }]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/portal/driver/mfa',
        headers: { authorization: `Bearer ${mobileToken}` },
        payload: { password: 'Correct1Password' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(typeof res.json().portalUrl).toBe('string');
      expect(res.json().error).toContain(res.json().portalUrl);
      expect(checkFactorProof).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
    });

    it('clears MFA and notifies the driver after a removal proof', async () => {
      setupDbResults([{ passwordHash: '$argon2id$old', mfaMethod: 'email' }]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/portal/driver/mfa',
        headers: auth,
        payload: { proof: RECOVERY_PROOF },
      });
      expect(res.statusCode).toBe(200);
      expect(checkFactorProof).toHaveBeenCalledWith(
        expect.anything(),
        { driverId: DRIVER_ID },
        expect.objectContaining(RECOVERY_PROOF),
        'remove',
      );
      expect(vi.mocked(writeAudit)).toHaveBeenCalledWith(
        expect.objectContaining({ idColumn: 'driver_id' }),
        expect.objectContaining({
          entityId: DRIVER_ID,
          action: 'mfa_disabled',
          actor: 'driver',
          before: { mfaMethod: 'email' },
        }),
        expect.anything(),
        expect.anything(),
      );
      expect(res.json()).toEqual({ success: true });
      expect(argon2.verify).not.toHaveBeenCalled();
      expect(updates[0]?.['set']).toHaveBeenCalledWith(
        expect.objectContaining({ mfaEnabled: false, mfaMethod: null, totpSecretEnc: null }),
      );
      expect(deleteRecoveryCodes).toHaveBeenCalledWith(
        { driverId: DRIVER_ID },
        expect.objectContaining({ tx: true }),
      );
      expect(dispatchDriverNotification).toHaveBeenCalledWith(
        expect.anything(),
        'driver.MfaDisabled',
        DRIVER_ID,
        {},
        ['/mock/templates'],
        expect.anything(),
      );
      // Every other session ends, then this client gets a new one, as for the operator disable.
      expect(endDriverSessions).toHaveBeenCalledWith(DRIVER_ID);
      expect(issueDriverTokens).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        DRIVER_ID,
      );
      expect(vi.mocked(endDriverSessions).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(issueDriverTokens).mock.invocationCallOrder[0] ?? 0,
      );
    });
  });
  describe('POST /portal/driver/mfa/recovery-codes', () => {
    const totpDriver = {
      mfaEnabled: true,
      mfaMethod: 'totp',
      totpSecretEnc: 'enc(TOTPSECRET)',
      email: 'jane@example.com',
      phone: null,
      firstName: 'Jane',
      language: 'en',
    };

    it('answers 400 MFA_NOT_CONFIGURED without MFA', async () => {
      setupDbResults([{ ...totpDriver, mfaEnabled: false, mfaMethod: null }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/recovery-codes',
        headers: auth,
        payload: { code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_NOT_CONFIGURED');
    });

    it('replaces the codes after a valid TOTP code', async () => {
      setupDbResults([totpDriver]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/recovery-codes',
        headers: auth,
        payload: { code: '123456' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ recoveryCodes: ['abcde-fghjk'] });
      expect(matchTotpStep).toHaveBeenCalledWith('TOTPSECRET', '123456');
      expect(issueRecoveryCodes).toHaveBeenCalledWith(
        { driverId: DRIVER_ID },
        'regenerated',
        expect.anything(),
      );
    });

    it('refuses a wrong TOTP code and keeps the old codes', async () => {
      vi.mocked(matchTotpStep).mockReturnValueOnce(null);
      setupDbResults([totpDriver]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/recovery-codes',
        headers: auth,
        payload: { code: '000000' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_CODE_INVALID');
      expect(issueRecoveryCodes).not.toHaveBeenCalled();
      // A wrong code counts toward the driver MFA backoff, as for operators.
      expect(recordAttemptFailure).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ account: { driverId: DRIVER_ID }, factor: 'proof' }),
      );
    });

    it('refuses a code unchecked while the MFA backoff locks the driver', async () => {
      const lockedUntil = new Date(Date.now() + 60_000);
      // The guarded UPDATE that takes the try matches no row while the lock holds.
      vi.mocked(takeSignInAttempt).mockResolvedValueOnce({ granted: false, lockedUntil });
      setupDbResults([{ ...totpDriver, mfaLockedUntil: lockedUntil }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/recovery-codes',
        headers: auth,
        payload: { code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_CODE_INVALID');
      expect(matchTotpStep).not.toHaveBeenCalled();
      expect(recordAttemptFailure).not.toHaveBeenCalled();
      expect(issueRecoveryCodes).not.toHaveBeenCalled();
    });

    it('sends an SMS code first and answers its challenge id', async () => {
      setupDbResults([{ ...totpDriver, mfaMethod: 'sms', phone: '+12015550111' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/recovery-codes',
        headers: auth,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ challengeId: 17 });
      expect(createMfaChallenge).toHaveBeenCalledWith(expect.anything(), {
        driverId: DRIVER_ID,
        method: 'sms',
        purpose: 'proof',
        destination: '+12015550111',
      });
      // The driver's own confirmed number: only other accounts count toward its cap.
      expect(createCappedMfaChallenge).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ destinationScope: 'other_accounts' }),
      );
      expect(issueRecoveryCodes).not.toHaveBeenCalled();
    });

    it('refuses a replayed TOTP code and keeps the old codes', async () => {
      vi.mocked(acceptTotpStep).mockResolvedValueOnce(false);
      setupDbResults([totpDriver]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/recovery-codes',
        headers: auth,
        payload: { code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_CODE_INVALID');
      expect(acceptTotpStep).toHaveBeenCalledWith({ driverId: DRIVER_ID }, 1);
      expect(issueRecoveryCodes).not.toHaveBeenCalled();
    });

    it('answers 429 MFA_RESEND_LIMITED and sends nothing beyond the code cap', async () => {
      vi.mocked(createCappedMfaChallenge).mockResolvedValueOnce({
        limited: true,
        retryAfterSeconds: 90,
        openChallengeId: null,
      });
      setupDbResults([{ ...totpDriver, mfaMethod: 'email', totpSecretEnc: null }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/recovery-codes',
        headers: auth,
        payload: {},
      });
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ code: 'MFA_RESEND_LIMITED', retryAfterSeconds: 90 });
      expect(res.headers['retry-after']).toBe('90');
      expect(createCappedMfaChallenge).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ driverId: DRIVER_ID, purpose: 'proof' }),
        expect.anything(),
      );
      expect(createMfaChallenge).not.toHaveBeenCalled();
      expect(dispatchSystemNotification).not.toHaveBeenCalled();
    });

    it('replaces the codes with a valid email challenge code', async () => {
      vi.mocked(verifyMfaChallenge).mockResolvedValueOnce('verified');
      setupDbResults([{ ...totpDriver, mfaMethod: 'email', totpSecretEnc: null }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/recovery-codes',
        headers: auth,
        payload: { code: '654321', challengeId: 17 },
      });
      expect(res.statusCode).toBe(200);
      expect(verifyMfaChallenge).toHaveBeenCalledWith(expect.anything(), 17, '654321', {
        driverId: DRIVER_ID,
        method: 'email',
        purpose: 'proof',
        destination: undefined,
      });
      expect(res.json().recoveryCodes).toEqual(['abcde-fghjk']);
    });
  });
});
