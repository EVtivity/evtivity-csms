// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// beginOperatorMfa (password login, forced password change, SSO callback) and
// beginDriverMfa (portal login): which code goes out and which factors the
// MFA step offers.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const {
  readMfaConfig,
  countRecoveryCodes,
  createMfaChallenge,
  dispatchSystemNotification,
  requiredMfaEnrollment,
  passkeys,
} = vi.hoisted(() => ({
  passkeys: { count: 0 },
  readMfaConfig: vi.fn(),
  countRecoveryCodes: vi.fn(),
  createMfaChallenge: vi.fn(),
  dispatchSystemNotification: vi.fn(),
  requiredMfaEnrollment: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({ client: { name: 'sql-client' }, readMfaConfig }));
vi.mock('@evtivity/lib', () => ({
  createMfaChallenge,
  createCappedMfaChallenge: (c: unknown, o: unknown) => createMfaChallenge(c, o),
  dispatchSystemNotification,
  isMfaChallengeLimited: (r: object) => 'limited' in r,
}));
vi.mock('@evtivity/services/template-dirs', () => ({ ALL_TEMPLATES_DIRS: ['templates'] }));
vi.mock('../services/mfa-factor.service.js', () => ({
  countRecoveryCodes,
  mfaFactorCounts: async (account: unknown) => ({
    recoveryCodesRemaining: (await countRecoveryCodes(account)) as number,
    passkeyCount: passkeys.count,
  }),
}));
vi.mock('../lib/mfa-enrollment.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/mfa-enrollment.js')>()),
  requiredMfaEnrollment,
}));

import { beginOperatorMfa } from '../lib/operator-mfa.js';
import {
  beginDriverMfa,
  driverMfaEnrollmentAfterVerify,
  mobileMfaUnsupportedAuditReason,
  sendMobileMfaUnsupported,
} from '../lib/driver-mfa.js';

const app = {
  jwt: { sign: vi.fn(() => 'mfa-pending-jwt') },
  log: { error: vi.fn(), warn: vi.fn() },
} as unknown as FastifyInstance;

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
const read = (config: typeof ALL_ON) => ({ config, fallback: false });

const user = {
  id: 'usr_1',
  roleId: 'rol_1',
  email: 'op@example.com',
  phone: '+12015550111',
  firstName: 'Op',
  language: 'en',
  mfaEnabled: true,
  mfaMethod: 'email',
  sessionVersion: 0,
};
const driver = {
  id: 'drv_1',
  email: 'jane@example.com',
  phone: '+12015550122',
  firstName: 'Jane',
  language: 'de',
  mfaEnabled: true,
  mfaMethod: 'sms',
  sessionVersion: 3,
};
const web = { mobile: false };
const mobile = { mobile: true };

beforeEach(() => {
  passkeys.count = 0;
  readMfaConfig.mockResolvedValue(read(ALL_ON));
  countRecoveryCodes.mockResolvedValue(0);
  createMfaChallenge.mockResolvedValue({ challengeId: 7, code: '123456' });
  dispatchSystemNotification.mockResolvedValue({ delivered: 1 });
  requiredMfaEnrollment.mockResolvedValue(null);
});

describe('beginOperatorMfa', () => {
  it('signs nothing for a user without MFA', async () => {
    expect(await beginOperatorMfa(app, { ...user, mfaEnabled: false })).toBeNull();
    expect(createMfaChallenge).not.toHaveBeenCalled();
  });

  it('hands a user without MFA whom required MFA covers the enrollment reply', async () => {
    const enrollment = {
      mfaEnrollmentRequired: true,
      enrollmentToken: 'enrollment-jwt',
      availableMethods: ['email', 'totp'],
    };
    requiredMfaEnrollment.mockResolvedValue(enrollment);
    const noMfa = { ...user, mfaEnabled: false, mfaMethod: null };
    expect(await beginOperatorMfa(app, noMfa)).toEqual(enrollment);
    expect(requiredMfaEnrollment).toHaveBeenCalledWith(app, noMfa);
    expect(createMfaChallenge).not.toHaveBeenCalled();
  });

  it('runs the MFA step for an account whose only factor is a passkey, sending no code', async () => {
    passkeys.count = 1;
    const pending = await beginOperatorMfa(app, { ...user, mfaEnabled: false, mfaMethod: null });
    expect(pending).toEqual({
      mfaRequired: true,
      mfaMethod: 'passkey',
      mfaToken: 'mfa-pending-jwt',
      challengeId: undefined,
      factors: ['passkey'],
    });
    expect(requiredMfaEnrollment).not.toHaveBeenCalled();
    expect(createMfaChallenge).not.toHaveBeenCalled();
  });

  it('offers passkeys next to the method', async () => {
    passkeys.count = 2;
    const pending = await beginOperatorMfa(app, { ...user, mfaMethod: 'totp' });
    expect(pending).toMatchObject({ mfaMethod: 'totp', factors: ['totp', 'passkey'] });
  });

  it('runs the MFA step, not enrollment, for a user with MFA', async () => {
    await beginOperatorMfa(app, user);
    expect(requiredMfaEnrollment).not.toHaveBeenCalled();
  });

  it('sends the email code and offers the method and the recovery codes', async () => {
    countRecoveryCodes.mockResolvedValue(10);
    const pending = await beginOperatorMfa(app, user);
    expect(pending).toEqual({
      mfaRequired: true,
      mfaMethod: 'email',
      mfaToken: 'mfa-pending-jwt',
      challengeId: 7,
      factors: ['email', 'recovery_code'],
    });
    expect(countRecoveryCodes).toHaveBeenCalledWith({ userId: 'usr_1' });
    expect(createMfaChallenge).toHaveBeenCalledWith(
      { name: 'sql-client' },
      { userId: 'usr_1', method: 'email', purpose: 'sign_in' },
    );
    expect(dispatchSystemNotification).toHaveBeenCalledTimes(1);
  });

  // The SSO callback and the forced password change hand over through this gate.
  it('sends no code when the method is switched off and recovery codes are left', async () => {
    readMfaConfig.mockResolvedValue(read({ ...ALL_ON, emailEnabled: false }));
    countRecoveryCodes.mockResolvedValue(3);
    const pending = await beginOperatorMfa(app, user);
    expect(pending).toMatchObject({
      challengeId: undefined,
      factors: ['recovery_code'],
      mfaMethodDisabled: true,
    });
    expect(createMfaChallenge).not.toHaveBeenCalled();
    expect(dispatchSystemNotification).not.toHaveBeenCalled();
  });

  it('still sends the code of a switched-off method that is the only factor', async () => {
    readMfaConfig.mockResolvedValue(read({ ...ALL_ON, emailEnabled: false }));
    const pending = await beginOperatorMfa(app, user);
    expect(pending).toMatchObject({ challengeId: 7, factors: ['email'] });
    expect((pending as { mfaMethodDisabled?: boolean }).mfaMethodDisabled).toBeUndefined();
  });

  it('fails closed on a failed settings read: no SMS code while recovery codes remain', async () => {
    // SMS is off in the defaults, which a failed settings read falls back to.
    readMfaConfig.mockResolvedValue({
      config: { ...ALL_ON, smsEnabled: false },
      fallback: true,
    });
    countRecoveryCodes.mockResolvedValue(5);
    const pending = await beginOperatorMfa(app, { ...user, mfaMethod: 'sms' });
    expect(pending).toMatchObject({ factors: ['recovery_code'], mfaMethodDisabled: true });
    expect(createMfaChallenge).not.toHaveBeenCalled();
  });

  it('sends the code on a failed settings read while SMS is the only factor', async () => {
    readMfaConfig.mockResolvedValue({
      config: { ...ALL_ON, smsEnabled: false },
      fallback: true,
    });
    countRecoveryCodes.mockResolvedValue(0);
    const pending = await beginOperatorMfa(app, { ...user, mfaMethod: 'sms' });
    expect(pending).toMatchObject({ challengeId: 7, factors: ['sms'] });
    expect(createMfaChallenge).toHaveBeenCalledTimes(1);
  });

  it('sends no code for TOTP', async () => {
    const pending = await beginOperatorMfa(app, { ...user, mfaMethod: 'totp' });
    expect(pending).toMatchObject({ challengeId: undefined, factors: ['totp'] });
    expect(createMfaChallenge).not.toHaveBeenCalled();
  });
});

describe('sign-in codes under the resend cap', () => {
  it('binds the operator pending token to the session version', async () => {
    await beginOperatorMfa(app, { ...user, sessionVersion: 4 });
    expect(app.jwt.sign).toHaveBeenCalledWith(
      { userId: 'usr_1', roleId: 'rol_1', mfaPending: true, sv: 4 },
      { expiresIn: '3m' },
    );
  });

  it('binds the driver pending token to the session version', async () => {
    await beginDriverMfa(app, driver, web);
    expect(app.jwt.sign).toHaveBeenCalledWith(
      { driverId: 'drv_1', type: 'driver', mfaPending: true, sv: 3 },
      { expiresIn: '3m' },
    );
  });

  it('sends no new operator code over the cap and points at the code already sent', async () => {
    createMfaChallenge.mockResolvedValueOnce({
      limited: true,
      retryAfterSeconds: 60,
      openChallengeId: 5,
    });
    const pending = await beginOperatorMfa(app, user);
    expect(pending).toMatchObject({ mfaRequired: true, challengeId: 5 });
    expect(dispatchSystemNotification).not.toHaveBeenCalled();
  });

  it('sends no new driver code over the cap and offers no challenge when none is open', async () => {
    createMfaChallenge.mockResolvedValueOnce({
      limited: true,
      retryAfterSeconds: 60,
      openChallengeId: null,
    });
    const pending = await beginDriverMfa(app, driver, web);
    expect(pending).toMatchObject({ mfaRequired: true, challengeId: undefined });
    expect(dispatchSystemNotification).not.toHaveBeenCalled();
  });
});

describe('beginDriverMfa', () => {
  it('signs nothing for a driver without MFA', async () => {
    expect(await beginDriverMfa(app, { ...driver, mfaMethod: null }, web)).toBeNull();
  });

  it('sends the SMS code by SMS and offers the method', async () => {
    const pending = await beginDriverMfa(app, driver, web);
    expect(pending).toEqual({
      mfaRequired: true,
      mfaMethod: 'sms',
      mfaToken: 'mfa-pending-jwt',
      challengeId: 7,
      factors: ['sms'],
    });
    expect(countRecoveryCodes).toHaveBeenCalledWith({ driverId: 'drv_1' });
    expect(dispatchSystemNotification).toHaveBeenCalledWith(
      { name: 'sql-client' },
      'mfa.VerificationCode',
      { phone: '+12015550122', firstName: 'Jane', language: 'de' },
      { code: '123456' },
      ['templates'],
    );
  });

  it('sends no code when the method is switched off and recovery codes are left', async () => {
    readMfaConfig.mockResolvedValue(read({ ...ALL_ON, smsEnabled: false }));
    countRecoveryCodes.mockResolvedValue(2);
    const pending = await beginDriverMfa(app, driver, web);
    expect(pending).toMatchObject({ factors: ['recovery_code'], mfaMethodDisabled: true });
    expect(createMfaChallenge).not.toHaveBeenCalled();
    expect(dispatchSystemNotification).not.toHaveBeenCalled();
  });

  it('offers a passkey-only driver the passkey step, and refuses it in the mobile app', async () => {
    passkeys.count = 1;
    const noMethod = { ...driver, mfaEnabled: false, mfaMethod: null };
    const pending = await beginDriverMfa(app, noMethod, web);
    expect(pending).toMatchObject({
      mfaRequired: true,
      mfaMethod: 'passkey',
      factors: ['passkey'],
    });
    expect(createMfaChallenge).not.toHaveBeenCalled();
    vi.mocked(app.jwt.sign).mockClear();
    // The app can prove codes only: it is told to finish in the portal, and gets no MFA token.
    expect(await beginDriverMfa(app, noMethod, mobile)).toEqual({ mobileMfaUnsupported: 'factor' });
    expect(app.jwt.sign).not.toHaveBeenCalled();
  });

  it('refuses a mobile sign-in left with recovery codes only', async () => {
    readMfaConfig.mockResolvedValue(read({ ...ALL_ON, smsEnabled: false }));
    countRecoveryCodes.mockResolvedValue(2);
    expect(await beginDriverMfa(app, driver, mobile)).toEqual({ mobileMfaUnsupported: 'factor' });
    expect(createMfaChallenge).not.toHaveBeenCalled();
  });

  it('refuses a mobile sign-in whose only factor is a switched-off method, with the method_disabled reason', async () => {
    readMfaConfig.mockResolvedValue(read({ ...ALL_ON, smsEnabled: false }));
    vi.mocked(app.jwt.sign).mockClear();
    expect(await beginDriverMfa(app, driver, mobile)).toEqual({
      mobileMfaUnsupported: 'method_disabled',
    });
    expect(app.jwt.sign).not.toHaveBeenCalled();
  });

  it('keeps the code step for the app when the method is usable', async () => {
    expect(await beginDriverMfa(app, driver, mobile)).toMatchObject({
      mfaRequired: true,
      factors: ['sms'],
    });
  });

  describe('required MFA for drivers', () => {
    const noMfa = { ...driver, mfaEnabled: false, mfaMethod: null };

    it('hands a web sign-in the enrollment token, scoped to the driver and its session version', async () => {
      readMfaConfig.mockResolvedValue(read({ ...ALL_ON, requireDrivers: true }));
      vi.mocked(app.jwt.sign).mockClear();
      expect(await beginDriverMfa(app, noMfa, web)).toEqual({
        mfaEnrollmentRequired: true,
        enrollmentToken: 'mfa-pending-jwt',
        availableMethods: ['email', 'totp', 'sms'],
        webauthnAvailable: true,
      });
      expect(app.jwt.sign).toHaveBeenCalledWith(
        { driverId: 'drv_1', type: 'driver', mfaEnrollment: true, sv: 3 },
        { expiresIn: '10m' },
      );
    });

    it('never hands the mobile app an enrollment token', async () => {
      readMfaConfig.mockResolvedValue(read({ ...ALL_ON, requireDrivers: true }));
      vi.mocked(app.jwt.sign).mockClear();
      expect(await beginDriverMfa(app, noMfa, mobile)).toEqual({
        mobileMfaUnsupported: 'enrollment',
      });
      expect(app.jwt.sign).not.toHaveBeenCalled();
    });

    it('signs a driver in without MFA while required MFA does not cover drivers', async () => {
      expect(await beginDriverMfa(app, noMfa, web)).toBeNull();
    });

    it('refuses the sign-in when no method can be set up', async () => {
      readMfaConfig.mockResolvedValue(
        read({ ...ALL_ON, emailEnabled: false, totpEnabled: false, requireDrivers: true }),
      );
      expect(await beginDriverMfa(app, { ...noMfa, phone: null }, web)).toEqual({
        mfaSetupUnavailable: true,
      });
    });

    it('fails closed when the MFA settings cannot be read', async () => {
      readMfaConfig.mockResolvedValue({ config: ALL_ON, fallback: true });
      expect(await beginDriverMfa(app, noMfa, web)).toEqual({ mfaPolicyUnavailable: true });
      expect(await beginDriverMfa(app, noMfa, mobile)).toEqual({ mfaPolicyUnavailable: true });
    });
  });
});

describe('driverMfaEnrollmentAfterVerify', () => {
  it('hands a web client the enrollment token and the methods it can set up', () => {
    vi.mocked(app.jwt.sign).mockClear();
    expect(
      driverMfaEnrollmentAfterVerify(app, driver, { ...ALL_ON, smsEnabled: false }, web),
    ).toEqual({
      mfaEnrollmentRequired: true,
      enrollmentToken: 'mfa-pending-jwt',
      availableMethods: ['email', 'totp'],
      webauthnAvailable: true,
    });
    expect(app.jwt.sign).toHaveBeenCalledWith(
      { driverId: 'drv_1', type: 'driver', mfaEnrollment: true, sv: 3 },
      { expiresIn: '10m' },
    );
  });

  it('never hands the mobile app a token', () => {
    vi.mocked(app.jwt.sign).mockClear();
    expect(driverMfaEnrollmentAfterVerify(app, driver, ALL_ON, mobile)).toEqual({
      mobileMfaUnsupported: 'method_disabled',
    });
    expect(app.jwt.sign).not.toHaveBeenCalled();
  });

  it('answers null when no method can be set up, so the session is issued', () => {
    const off = { ...ALL_ON, emailEnabled: false, totpEnabled: false, smsEnabled: false };
    expect(driverMfaEnrollmentAfterVerify(app, driver, off, web)).toBeNull();
    expect(driverMfaEnrollmentAfterVerify(app, driver, off, mobile)).toBeNull();
  });
});

describe('mobile refusals', () => {
  it('maps each reason to its audit reason', () => {
    expect(mobileMfaUnsupportedAuditReason('enrollment')).toBe('mfa_enrollment_required');
    expect(mobileMfaUnsupportedAuditReason('factor')).toBe('mfa_factor_unsupported');
    expect(mobileMfaUnsupportedAuditReason('method_disabled')).toBe('mfa_method_disabled');
  });

  it('tells the driver the method was turned off and names the portal', async () => {
    const send = vi.fn(async () => undefined);
    const reply = { status: vi.fn(() => ({ send })) };
    await sendMobileMfaUnsupported(reply as never, 'method_disabled', 'https://portal.example.com');
    expect(reply.status).toHaveBeenCalledWith(403);
    expect(send).toHaveBeenCalledWith({
      error:
        'Your sign-in method was turned off. Set up another one in the driver portal at https://portal.example.com, then sign in here again.',
      code: 'MFA_ENROLLMENT_REQUIRED',
      portalUrl: 'https://portal.example.com',
    });
  });
});
