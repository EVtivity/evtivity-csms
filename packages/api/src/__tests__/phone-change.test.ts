// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  account: null as null | {
    mfaEnabled: boolean;
    mfaMethod: string | null;
    passkeyCount: number;
    hasPassword: boolean;
  },
}));

vi.mock('@evtivity/database', () => ({ client: { name: 'sql' } }));
vi.mock('@evtivity/lib', () => ({ verifyMfaChallenge: vi.fn(async () => 'verified') }));
vi.mock('../lib/config.js', () => ({ config: { PORTAL_URL: 'https://portal.example.com' } }));
vi.mock('../lib/mfa-factor-proof.js', () => {
  return {
    // The factor kinds an account holds, as the real rule lists them.
    factorProofKindsOf: (a: {
      mfaEnabled: boolean;
      mfaMethod: string | null;
      passkeyCount: number;
    }) => [
      ...(a.mfaEnabled && a.mfaMethod === 'totp' ? ['totp'] : []),
      ...(a.mfaEnabled && (a.mfaMethod === 'email' || a.mfaMethod === 'sms') ? ['code'] : []),
      ...(a.passkeyCount > 0 ? ['passkey'] : []),
    ],
    holdsFactor: (kinds: string[]) => kinds.some((k) => k !== 'password' && k !== 'sso'),
    proofAccountOf: vi.fn(async () => h.account),
    checkFactorProof: vi.fn(async (_r: unknown, _a: unknown, proof: unknown) =>
      proof == null
        ? {
            status: 400,
            body: { error: 'Confirm', code: 'VALIDATION_ERROR', proofKinds: ['totp'] },
          }
        : null,
    ),
  };
});

import { verifyMfaChallenge } from '@evtivity/lib';
import { checkFactorProof } from '../lib/mfa-factor-proof.js';
import {
  PHONE_CHANGE_METHOD,
  checkPhoneChange,
  normalizedPhone,
  phoneVerificationRefusal,
} from '../lib/phone-change.js';

const request = {} as FastifyRequest;
const ME = { userId: 'usr_1' };
const NONE = { mfaEnabled: false, mfaMethod: null, passkeyCount: 0, hasPassword: true };
const TOTP = { mfaEnabled: true, mfaMethod: 'totp', passkeyCount: 0, hasPassword: true };
const SMS = { mfaEnabled: true, mfaMethod: 'sms', passkeyCount: 0, hasPassword: true };

beforeEach(() => {
  h.account = TOTP;
});

describe('normalizedPhone', () => {
  it('trims and turns an empty number into none', () => {
    expect(normalizedPhone(' +15550001 ')).toBe('+15550001');
    expect(normalizedPhone('  ')).toBeNull();
    expect(normalizedPhone(undefined)).toBeNull();
  });
});

describe('phoneVerificationRefusal', () => {
  it('sends only for an SMS account and never to its current number', () => {
    const sms = { mfaEnabled: true, mfaMethod: 'sms', phone: ' +1555 ' };
    expect(phoneVerificationRefusal(sms, '+1666')).toBeNull();
    expect(phoneVerificationRefusal(sms, '+1555')).toBe('This is already your number');
    expect(phoneVerificationRefusal({ ...sms, mfaMethod: 'totp' }, '+1666')).not.toBeNull();
    expect(phoneVerificationRefusal({ ...sms, mfaEnabled: false }, '+1666')).not.toBeNull();
  });
});

describe('checkPhoneChange', () => {
  it('lets the same number through without a proof (a full profile save)', async () => {
    expect(await checkPhoneChange(request, ME, { current: '+1555', next: '+1555' })).toBeNull();
    expect(checkFactorProof).not.toHaveBeenCalled();
  });

  it('needs nothing from an account without a factor', async () => {
    h.account = NONE;
    expect(await checkPhoneChange(request, ME, { current: '+1555', next: '+1666' })).toBeNull();
    expect(checkFactorProof).not.toHaveBeenCalled();
  });

  it('refuses a change without a proof for an account with a factor', async () => {
    const refused = await checkPhoneChange(request, ME, { current: '+1555', next: '+1666' });
    expect(refused).toMatchObject({ status: 400, body: { code: 'VALIDATION_ERROR' } });
  });

  it('accepts the change with the proof of the account', async () => {
    const proof = { kind: 'totp' as const, code: '123456' };
    expect(
      await checkPhoneChange(request, ME, { current: '+1555', next: '+1666', proof }),
    ).toBeNull();
    expect(checkFactorProof).toHaveBeenCalledWith(request, ME, proof);
  });

  it('asks an SMS account to confirm the new number with its code', async () => {
    h.account = SMS;
    const missing = await checkPhoneChange(request, ME, {
      current: '+1555',
      next: '+1666',
      proof: { kind: 'code', code: '111111', challengeId: 3 },
    });
    expect(missing).toMatchObject({
      status: 400,
      body: { code: 'VALIDATION_ERROR', phoneVerificationRequired: true },
    });
    expect(
      await checkPhoneChange(request, ME, {
        current: '+1555',
        next: '+1666',
        verification: { challengeId: 9, code: '222222' },
      }),
    ).toBeNull();
    // The code must be one sent to that very number.
    expect(verifyMfaChallenge).toHaveBeenCalledWith({ name: 'sql' }, 9, '222222', {
      userId: 'usr_1',
      method: PHONE_CHANGE_METHOD,
      purpose: 'setup',
      destination: '+1666',
    });
  });

  it('refuses a wrong or used-up code for the new number', async () => {
    h.account = SMS;
    vi.mocked(verifyMfaChallenge).mockResolvedValueOnce('invalid');
    const wrong = await checkPhoneChange(request, ME, {
      current: '+1555',
      next: '+1666',
      verification: { challengeId: 9, code: '000000' },
    });
    expect(wrong?.body.code).toBe('MFA_CODE_INVALID');
    vi.mocked(verifyMfaChallenge).mockResolvedValueOnce('exhausted');
    const spent = await checkPhoneChange(request, ME, {
      current: '+1555',
      next: '+1666',
      verification: { challengeId: 9, code: '000000' },
    });
    expect(spent?.body.code).toBe('MFA_CHALLENGE_EXHAUSTED');
  });

  it('names the driver portal to the mobile app, which sends no proof', async () => {
    const refused = await checkPhoneChange(
      request,
      { driverId: 'drv_1' },
      { current: '+1555', next: '+1666', mobileSession: true },
    );
    expect(refused).toMatchObject({
      status: 400,
      body: {
        code: 'VALIDATION_ERROR',
        portalUrl: 'https://portal.example.com',
        details: { phone: expect.stringContaining('https://portal.example.com') },
      },
    });
  });
});
