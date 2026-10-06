// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
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

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain('select')),
    insert: vi.fn(() => makeChain('insert')),
    update: vi.fn(() => makeChain('update')),
  },
  client: { name: 'client' },
  drivers: {},
  driverNotificationPreferences: {},
  getMfaConfig: getMfaConfigMock,
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));

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
  verifyTotpCode: vi.fn(() => true),
  createMfaChallenge: vi.fn().mockResolvedValue({ challengeId: 17, code: '654321' }),
  verifyMfaChallenge: vi.fn().mockResolvedValue(true),
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({ publish: vi.fn() })),
}));

vi.mock('@evtivity/services/template-dirs', () => ({
  ALL_TEMPLATES_DIRS: ['/mock/templates'],
}));

vi.mock('../lib/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/config.js')>();
  return { ...actual, config: { ...actual.config, SETTINGS_ENCRYPTION_KEY: 'test-key' } };
});

vi.mock('../services/refresh-token.service.js', () => ({
  revokeAllDriverRefreshTokens: vi.fn().mockResolvedValue(undefined),
}));

import argon2 from 'argon2';
import QRCode from 'qrcode';
import {
  dispatchDriverNotification,
  dispatchSystemNotification,
  createMfaChallenge,
  decryptString,
  verifyTotpCode,
  verifyMfaChallenge,
} from '@evtivity/lib';
import { registerAuth } from '../plugins/auth.js';
import { portalDriverRoutes } from '../routes/portal/driver.js';
import { revokeAllDriverRefreshTokens } from '../services/refresh-token.service.js';

const DRIVER_ID = 'drv_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalDriverRoutes);
  await app.ready();
  return app;
}

const allMethods = { emailEnabled: true, totpEnabled: true, smsEnabled: true };
const noMethods = { emailEnabled: false, totpEnabled: false, smsEnabled: false };

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
    getMfaConfigMock.mockResolvedValue(allMethods);
    vi.mocked(argon2.verify).mockResolvedValue(true);
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
      setupDbResults([updated]);
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
      });
      expect(updates).toHaveLength(0);
      expect(revokeAllDriverRefreshTokens).not.toHaveBeenCalled();
    });
  });

  describe('GET /portal/driver/mfa', () => {
    it('lists the enabled methods and the driver MFA state', async () => {
      setupDbResults([{ mfaEnabled: true, mfaMethod: 'totp' }]);
      const res = await app.inject({ method: 'GET', url: '/portal/driver/mfa', headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        mfaEnabled: true,
        mfaMethod: 'totp',
        availableMethods: ['email', 'totp', 'sms'],
      });
    });

    it('defaults to disabled with no methods when the driver row is missing', async () => {
      getMfaConfigMock.mockResolvedValueOnce(noMethods);
      setupDbResults([]);
      const res = await app.inject({ method: 'GET', url: '/portal/driver/mfa', headers: auth });
      expect(res.json()).toEqual({ mfaEnabled: false, mfaMethod: null, availableMethods: [] });
    });
  });

  describe('POST /portal/driver/mfa/setup', () => {
    const driver = {
      email: 'jane@example.com',
      phone: '+15550001111',
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
      expect(createMfaChallenge).toHaveBeenCalledWith(expect.anything(), {
        driverId: DRIVER_ID,
        method: 'sms',
      });
      expect(dispatchSystemNotification).toHaveBeenCalledWith(
        expect.anything(),
        'mfa.VerificationCode',
        { email: 'jane@example.com', phone: '+15550001111', firstName: 'Jane', language: 'de' },
        { code: '654321' },
        ['/mock/templates'],
      );
    });

    it('sends an email challenge with undefined contact fields when they are null', async () => {
      setupDbResults([{ ...driver, email: null, phone: null }]);
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
        expect.objectContaining({ email: undefined, phone: undefined }),
        { code: '654321' },
        ['/mock/templates'],
      );
    });
  });

  describe('POST /portal/driver/mfa/confirm', () => {
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
      vi.mocked(verifyTotpCode).mockReturnValueOnce(false);
      setupDbResults([{ totpSecretEnc: 'enc(TOTPSECRET)' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/confirm',
        headers: auth,
        payload: { method: 'totp', code: '000000' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_CODE_INVALID');
      expect(verifyTotpCode).toHaveBeenCalledWith('TOTPSECRET', '000000');
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
      expect(res.json()).toEqual({ success: true });
      expect(updates[0]?.['set']).toHaveBeenCalledWith(
        expect.objectContaining({ mfaEnabled: true, mfaMethod: 'totp' }),
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
    it('returns 400 when the driver has no password', async () => {
      setupDbResults([{ passwordHash: null }]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/portal/driver/mfa',
        headers: auth,
        payload: { password: 'whatever' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('DRIVER_NOT_FOUND');
    });

    it('returns 400 for a wrong password and keeps MFA on', async () => {
      vi.mocked(argon2.verify).mockResolvedValueOnce(false);
      setupDbResults([{ passwordHash: '$argon2id$old' }]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/portal/driver/mfa',
        headers: auth,
        payload: { password: 'wrong' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_PASSWORD');
      expect(updates).toHaveLength(0);
      expect(dispatchDriverNotification).not.toHaveBeenCalled();
    });

    it('clears MFA and notifies the driver', async () => {
      setupDbResults([{ passwordHash: '$argon2id$old' }]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/portal/driver/mfa',
        headers: auth,
        payload: { password: 'Correct1Password' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(argon2.verify).toHaveBeenCalledWith('$argon2id$old', 'Correct1Password');
      expect(updates[0]?.['set']).toHaveBeenCalledWith(
        expect.objectContaining({ mfaEnabled: false, mfaMethod: null, totpSecretEnc: null }),
      );
      expect(dispatchDriverNotification).toHaveBeenCalledWith(
        expect.anything(),
        'driver.MfaDisabled',
        DRIVER_ID,
        {},
        ['/mock/templates'],
        expect.anything(),
      );
    });
  });
});
