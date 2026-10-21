// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';

const h = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  passkeyCount: 0,
  recoveryCodes: 0,
  challenge: null as Record<string, unknown> | null,
  stored: null as Record<string, unknown> | null,
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => 'eq') }));
vi.mock('@evtivity/database', () => {
  const chain: Record<string, unknown> = {};
  chain['from'] = () => chain;
  chain['where'] = () => Promise.resolve(h.user != null ? [h.user] : []);
  return {
    client: {},
    db: { select: vi.fn(() => chain) },
    users: {},
    drivers: {},
  };
});
vi.mock('@evtivity/lib', () => ({
  decryptString: vi.fn((v: string) => `plain:${v}`),
  matchTotpStep: vi.fn((_secret: string, code: string) => (code === '123456' ? 4242 : null)),
  verifyMfaChallenge: vi.fn(async (_c: unknown, id: number, code: string) =>
    id === 7 && code === '654321' ? 'verified' : 'invalid',
  ),
}));
vi.mock('../lib/config.js', () => ({ config: { SETTINGS_ENCRYPTION_KEY: 'k' } }));
vi.mock('../lib/operator-session.js', () => ({ passwordAuthBlocked: vi.fn(async () => false) }));
vi.mock('../lib/password-verify.js', () => ({
  verifyPassword: vi.fn(async (_hash: unknown, password: string) => password === 'right'),
}));
vi.mock('../lib/sign-in-backoff.js', () => ({
  acceptTotpStep: vi.fn(async () => true),
  clearSignInFailures: vi.fn(async () => undefined),
  // The lock the test row holds decides, as the guarded UPDATE does.
  takeSignInAttempt: vi.fn(async (account: unknown, factor: 'password' | 'mfa' | 'proof') => {
    const lock = { password: 'loginLockedUntil', mfa: 'mfaLockedUntil', proof: 'proofLockedUntil' };
    const until = h.user?.[lock[factor]] as Date | undefined;
    if (until != null && until.getTime() > Date.now())
      return { granted: false, lockedUntil: until };
    return { granted: true, account, factor, failures: 1, lockedUntil: null };
  }),
  recordAttemptFailure: vi.fn(async () => null),
}));
vi.mock('../lib/webauthn-challenges.js', () => ({
  takeWebauthnChallenge: vi.fn(async () => h.challenge),
}));
vi.mock('../lib/webauthn.js', () => ({
  WebauthnVerificationError: class extends Error {},
  checkAuthentication: vi.fn(async () => ({ newCounter: 1, backedUp: true })),
  webauthnRpFor: (account: { userId?: string }) =>
    account.userId != null
      ? { rpId: 'csms.example.com', origin: 'https://csms.example.com' }
      : { rpId: 'portal.example.com', origin: 'https://portal.example.com' },
  responseChallenge: () => 'chal',
}));
vi.mock('../lib/audit-actor.js', () => ({
  getAuditActor: vi.fn(() => ({ actor: 'user', actorUserId: 'usr_000000000001' })),
}));
vi.mock('../services/mfa-factor.service.js', () => ({
  countRecoveryCodes: vi.fn(async () => h.recoveryCodes),
  consumeRecoveryCode: vi.fn(async (_account: unknown, input: string) =>
    input === 'abcde-fghjk' ? { used: true, remaining: 9 } : { used: false, remaining: 10 },
  ),
  countWebauthnCredentials: vi.fn(async () => h.passkeyCount),
  findWebauthnCredential: vi.fn(async () => h.stored),
  recordWebauthnCredentialUse: vi.fn(async () => true),
}));

import { verifyMfaChallenge } from '@evtivity/lib';
import {
  checkFactorProof,
  factorProofKindsOf,
  lastFactorProofKindsOf,
  factorProofKinds,
  holdsFactor,
  ssoProofUntil,
} from '../lib/mfa-factor-proof.js';
import {
  acceptTotpStep,
  clearSignInFailures,
  recordAttemptFailure,
  takeSignInAttempt,
} from '../lib/sign-in-backoff.js';
import { passwordAuthBlocked } from '../lib/operator-session.js';
import { consumeRecoveryCode } from '../services/mfa-factor.service.js';

const ME = 'usr_000000000001';
const ACCOUNT = { userId: ME };
const DRIVER = { driverId: 'drv_000000000001' };
const request = { log: { warn: vi.fn(), info: vi.fn() } } as unknown as FastifyRequest;
const assertion = {
  id: 'cred',
  rawId: 'cred',
  type: 'public-key' as const,
  response: { clientDataJSON: 'a', authenticatorData: 'b', signature: 'c' },
  clientExtensionResults: {},
};

function user(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mfaEnabled: false,
    mfaMethod: null,
    passwordHash: '$argon2id$x',
    authSource: 'password',
    totpSecretEnc: null,
    ...over,
  };
}

beforeEach(() => {
  h.user = user();
  h.passkeyCount = 0;
  h.recoveryCodes = 0;
  h.challenge = { purpose: 'factor_add', userId: ME };
  h.stored = { id: 1, userId: ME, driverId: null, counter: 0 };
});

describe('factorProofKindsOf', () => {
  it('lists the factors, the password only without one, and nothing for an SSO account', () => {
    const base = { mfaEnabled: false, mfaMethod: null, passkeyCount: 0, hasPassword: true };
    expect(factorProofKindsOf(base)).toEqual(['password']);
    expect(factorProofKindsOf({ ...base, mfaEnabled: true, mfaMethod: 'totp' })).toEqual(['totp']);
    expect(factorProofKindsOf({ ...base, mfaEnabled: true, mfaMethod: 'sms' })).toEqual(['code']);
    expect(
      factorProofKindsOf({ ...base, mfaEnabled: true, mfaMethod: 'email', passkeyCount: 2 }),
    ).toEqual(['code', 'passkey']);
    expect(factorProofKindsOf({ ...base, passkeyCount: 1 })).toEqual(['passkey']);
    expect(factorProofKindsOf({ ...base, hasPassword: false })).toEqual([]);
    expect(factorProofKindsOf({ ...base, hasPassword: false, ssoReauth: true })).toEqual(['sso']);
  });

  it('asks an SSO account while SSO is enabled for a fresh SSO sign-in, not its password', async () => {
    // Security review L4: a session alone no longer adds a first factor to such an account.
    vi.mocked(passwordAuthBlocked).mockResolvedValueOnce(true);
    h.user = user({ authSource: 'sso' });
    expect(await factorProofKinds(ACCOUNT)).toEqual(['sso']);
    h.user = user({ passwordHash: '' });
    expect(await factorProofKinds(ACCOUNT)).toEqual([]);
  });
});

describe('lastFactorProofKindsOf', () => {
  it('takes a factor or a recovery code, never the password, while the account holds a factor', () => {
    // Security review 2 M2: a stolen session with a phished password must not strip the factors.
    const base = { mfaEnabled: false, mfaMethod: null, passkeyCount: 1, hasPassword: true };
    expect(lastFactorProofKindsOf(base)).toEqual(['passkey']);
    expect(lastFactorProofKindsOf({ ...base, recoveryCodeCount: 3 })).toEqual([
      'passkey',
      'recovery_code',
    ]);
    expect(
      lastFactorProofKindsOf({
        ...base,
        passkeyCount: 0,
        mfaEnabled: true,
        mfaMethod: 'totp',
        recoveryCodeCount: 10,
      }),
    ).toEqual(['totp', 'recovery_code']);
    expect(lastFactorProofKindsOf({ ...base, hasPassword: false })).toEqual(['passkey']);
  });

  it('proves an account without a factor as adding one does', () => {
    const base = { mfaEnabled: false, mfaMethod: null, passkeyCount: 0, hasPassword: true };
    expect(lastFactorProofKindsOf({ ...base, recoveryCodeCount: 4 })).toEqual(['password']);
    expect(lastFactorProofKindsOf({ ...base, hasPassword: false, ssoReauth: true })).toEqual([
      'sso',
    ]);
    expect(lastFactorProofKindsOf({ ...base, hasPassword: false })).toEqual([]);
  });
});

describe('checkFactorProof for removing a factor', () => {
  it('refuses the right password from an account that holds a factor', async () => {
    h.passkeyCount = 1;
    h.recoveryCodes = 10;
    const refused = await checkFactorProof(
      request,
      ACCOUNT,
      { kind: 'password', password: 'right' },
      'remove',
    );
    expect(refused?.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      proofKinds: ['passkey', 'recovery_code'],
    });
    expect(takeSignInAttempt).not.toHaveBeenCalled();
    expect(
      await checkFactorProof(
        request,
        ACCOUNT,
        { kind: 'passkey', credential: assertion },
        'remove',
      ),
    ).toBeNull();
  });

  it('takes a recovery code to remove a factor, never to add one', async () => {
    h.user = user({ mfaEnabled: true, mfaMethod: 'totp', totpSecretEnc: 'enc' });
    h.recoveryCodes = 10;
    const proof = { kind: 'recovery_code' as const, recoveryCode: 'abcde-fghjk' };
    expect(await checkFactorProof(request, ACCOUNT, proof, 'remove')).toBeNull();
    expect(consumeRecoveryCode).toHaveBeenCalledWith(ACCOUNT, 'abcde-fghjk', expect.anything());
    expect(takeSignInAttempt).toHaveBeenCalledWith(ACCOUNT, 'proof');
    expect(clearSignInFailures).toHaveBeenCalledWith(ACCOUNT, 'proof');

    vi.mocked(consumeRecoveryCode).mockClear();
    const add = await checkFactorProof(request, ACCOUNT, proof);
    expect(add?.body).toMatchObject({ code: 'VALIDATION_ERROR', proofKinds: ['totp'] });
    expect(consumeRecoveryCode).not.toHaveBeenCalled();
  });

  it('counts a wrong recovery code on the proof backoff and checks none while locked', async () => {
    h.user = user({ mfaEnabled: true, mfaMethod: 'totp', totpSecretEnc: 'enc' });
    h.recoveryCodes = 10;
    const wrong = await checkFactorProof(
      request,
      ACCOUNT,
      { kind: 'recovery_code', recoveryCode: 'zzzzz-zzzzz' },
      'remove',
    );
    expect(wrong?.body.code).toBe('MFA_CODE_INVALID');
    expect(recordAttemptFailure).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ account: ACCOUNT, factor: 'proof' }),
    );
    expect(
      (await checkFactorProof(request, ACCOUNT, { kind: 'recovery_code' }, 'remove'))?.body.code,
    ).toBe('VALIDATION_ERROR');

    vi.mocked(consumeRecoveryCode).mockClear();
    vi.mocked(recordAttemptFailure).mockClear();
    h.user = { ...h.user, proofLockedUntil: new Date(Date.now() + 60_000) };
    const locked = await checkFactorProof(
      request,
      ACCOUNT,
      { kind: 'recovery_code', recoveryCode: 'abcde-fghjk' },
      'remove',
    );
    expect(locked?.body.code).toBe('MFA_CODE_INVALID');
    expect(consumeRecoveryCode).not.toHaveBeenCalled();
    expect(recordAttemptFailure).not.toHaveBeenCalled();
  });

  it('asks an SSO account for its passkey', async () => {
    h.passkeyCount = 1;
    h.user = user({ passwordHash: '' });
    const sso = await checkFactorProof(
      request,
      ACCOUNT,
      { kind: 'password', password: 'right' },
      'remove',
    );
    expect(sso?.body).toMatchObject({ code: 'VALIDATION_ERROR', proofKinds: ['passkey'] });
    expect(
      await checkFactorProof(
        request,
        ACCOUNT,
        { kind: 'passkey', credential: assertion },
        'remove',
      ),
    ).toBeNull();
  });
});

describe('checkFactorProof', () => {
  it('says a code with no tries left is used up', async () => {
    h.user = user({ mfaEnabled: true, mfaMethod: 'email' });
    vi.mocked(verifyMfaChallenge).mockResolvedValueOnce('exhausted');
    const refused = await checkFactorProof(request, ACCOUNT, {
      kind: 'code',
      code: '654321',
      challengeId: 7,
    });
    expect(refused?.body.code).toBe('MFA_CHALLENGE_EXHAUSTED');
    expect(recordAttemptFailure).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ account: ACCOUNT, factor: 'proof' }),
    );
  });

  it('refuses an account without a password, a factor or an SSO sign-in (fail closed)', async () => {
    // Security review 2 Info: an SSO account after SSO was turned off has nothing to prove.
    h.user = user({ passwordHash: '', authSource: 'sso' });
    for (const purpose of ['add', 'remove'] as const) {
      const refused = await checkFactorProof(request, ACCOUNT, undefined, purpose);
      expect(refused).toMatchObject({
        status: 400,
        body: { code: 'VALIDATION_ERROR', proofKinds: [] },
      });
    }
  });

  it('refuses a missing proof and a kind the account cannot give, naming the accepted kinds', async () => {
    expect((await checkFactorProof(request, ACCOUNT, undefined))?.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      proofKinds: ['password'],
    });
    h.passkeyCount = 1;
    expect(
      (await checkFactorProof(request, ACCOUNT, { kind: 'password', password: 'right' }))?.body,
    ).toMatchObject({ code: 'VALIDATION_ERROR', proofKinds: ['passkey'] });
  });

  it('checks the password, counting a wrong one toward the sign-in backoff', async () => {
    expect(
      await checkFactorProof(request, ACCOUNT, { kind: 'password', password: 'right' }),
    ).toBeNull();
    expect(
      (await checkFactorProof(request, ACCOUNT, { kind: 'password', password: 'wrong' }))?.body
        .code,
    ).toBe('INVALID_PASSWORD');
    expect(recordAttemptFailure).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ account: ACCOUNT, factor: 'password' }),
    );
    // While the account is locked, even the right password is not checked.
    h.user = user({ loginLockedUntil: new Date(Date.now() + 60_000) });
    expect(
      (await checkFactorProof(request, ACCOUNT, { kind: 'password', password: 'right' }))?.body
        .code,
    ).toBe('INVALID_PASSWORD');
    expect((await checkFactorProof(request, ACCOUNT, { kind: 'password' }))?.body.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('checks a TOTP code once, through the replay guard', async () => {
    h.user = user({ mfaEnabled: true, mfaMethod: 'totp', totpSecretEnc: 'enc' });
    expect(await checkFactorProof(request, ACCOUNT, { kind: 'totp', code: '123456' })).toBeNull();
    expect(acceptTotpStep).toHaveBeenCalledWith({ userId: ME }, 4242);
    vi.mocked(acceptTotpStep).mockResolvedValueOnce(false);
    expect(
      (await checkFactorProof(request, ACCOUNT, { kind: 'totp', code: '123456' }))?.body.code,
    ).toBe('MFA_CODE_INVALID');
    expect(
      (await checkFactorProof(request, ACCOUNT, { kind: 'totp', code: '000000' }))?.body.code,
    ).toBe('MFA_CODE_INVALID');
    expect(recordAttemptFailure).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ account: ACCOUNT, factor: 'proof' }),
    );
  });

  it('checks an email or SMS code against its challenge', async () => {
    h.user = user({ mfaEnabled: true, mfaMethod: 'email' });
    expect(
      await checkFactorProof(request, ACCOUNT, { kind: 'code', code: '654321', challengeId: 7 }),
    ).toBeNull();
    expect(
      (await checkFactorProof(request, ACCOUNT, { kind: 'code', code: '111111', challengeId: 7 }))
        ?.body.code,
    ).toBe('MFA_CODE_INVALID');
    expect(
      (await checkFactorProof(request, ACCOUNT, { kind: 'code', code: '654321' }))?.body.code,
    ).toBe('VALIDATION_ERROR');
    expect(recordAttemptFailure).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ account: ACCOUNT, factor: 'proof' }),
    );
  });

  it('refuses an email or SMS code while the proof backoff locks the account, without checking it', async () => {
    const lockedUntil = new Date(Date.now() + 60_000);
    h.user = user({ mfaEnabled: true, mfaMethod: 'sms', proofLockedUntil: lockedUntil });
    const locked = await checkFactorProof(request, ACCOUNT, {
      kind: 'code',
      code: '654321',
      challengeId: 7,
    });
    // The same reply as a wrong code, so the lock reveals nothing more.
    expect(locked).toEqual({
      status: 400,
      body: { error: 'Invalid verification code', code: 'MFA_CODE_INVALID' },
    });
    expect(verifyMfaChallenge).not.toHaveBeenCalled();
    expect(recordAttemptFailure).not.toHaveBeenCalled();

    // A lock that has passed no longer holds the code back.
    h.user = user({
      mfaEnabled: true,
      mfaMethod: 'sms',
      proofLockedUntil: new Date(Date.now() - 1),
    });
    expect(
      await checkFactorProof(request, ACCOUNT, { kind: 'code', code: '654321', challengeId: 7 }),
    ).toBeNull();
    expect(verifyMfaChallenge).toHaveBeenCalledWith({}, 7, '654321', {
      userId: ME,
      method: 'sms',
      purpose: 'proof',
      destination: undefined,
    });
  });

  it('checks an SMS code as a proof code bound to the account phone', async () => {
    h.user = user({ mfaEnabled: true, mfaMethod: 'sms', phone: '+1 (201) 555-0123' });
    expect(
      await checkFactorProof(request, ACCOUNT, { kind: 'code', code: '654321', challengeId: 7 }),
    ).toBeNull();
    expect(verifyMfaChallenge).toHaveBeenCalledWith({}, 7, '654321', {
      userId: ME,
      method: 'sms',
      purpose: 'proof',
      destination: '+12015550123',
    });
  });

  it('counts proofs apart from sign-in: the sign-in MFA lock does not hold them', async () => {
    h.user = user({
      mfaEnabled: true,
      mfaMethod: 'totp',
      totpSecretEnc: 'enc',
      mfaLockedUntil: new Date(Date.now() + 60_000),
    });
    expect(await checkFactorProof(request, ACCOUNT, { kind: 'totp', code: '123456' })).toBeNull();
    expect(takeSignInAttempt).toHaveBeenCalledWith(ACCOUNT, 'proof');
    expect(takeSignInAttempt).not.toHaveBeenCalledWith(ACCOUNT, 'mfa');
    expect(clearSignInFailures).toHaveBeenCalledWith(ACCOUNT, 'proof');
  });

  it('refuses a TOTP code while the proof backoff locks the account, without checking it', async () => {
    h.user = user({
      mfaEnabled: true,
      mfaMethod: 'totp',
      totpSecretEnc: 'enc',
      proofLockedUntil: new Date(Date.now() + 60_000),
    });
    expect(await checkFactorProof(request, ACCOUNT, { kind: 'totp', code: '123456' })).toEqual({
      status: 400,
      body: { error: 'Invalid verification code', code: 'MFA_CODE_INVALID' },
    });
    expect(acceptTotpStep).not.toHaveBeenCalled();
    expect(recordAttemptFailure).not.toHaveBeenCalled();
  });

  it('checks a passkey against a factor_add challenge of the user and its own credential', async () => {
    h.passkeyCount = 1;
    const proof = { kind: 'passkey' as const, credential: assertion };
    expect(await checkFactorProof(request, ACCOUNT, proof)).toBeNull();
    h.challenge = { purpose: 'recovery_regenerate', userId: ME };
    expect((await checkFactorProof(request, ACCOUNT, proof))?.body.code).toBe(
      'WEBAUTHN_CHALLENGE_EXPIRED',
    );
    h.challenge = { purpose: 'factor_add', userId: 'usr_000000000002' };
    expect((await checkFactorProof(request, ACCOUNT, proof))?.body.code).toBe(
      'WEBAUTHN_CHALLENGE_EXPIRED',
    );
    h.challenge = { purpose: 'factor_add', userId: ME };
    h.stored = { id: 1, userId: 'usr_000000000002', driverId: null, counter: 0 };
    expect((await checkFactorProof(request, ACCOUNT, proof))?.body.code).toBe(
      'WEBAUTHN_VERIFICATION_FAILED',
    );
  });
});

describe('checkFactorProof for a driver', () => {
  it('proves a driver without a factor by the password and counts a wrong one', async () => {
    h.user = { mfaEnabled: false, mfaMethod: null, passwordHash: '$argon2id$x' };
    expect(await factorProofKinds(DRIVER)).toEqual(['password']);
    expect(
      await checkFactorProof(request, DRIVER, { kind: 'password', password: 'right' }),
    ).toBeNull();
    expect(
      (await checkFactorProof(request, DRIVER, { kind: 'password', password: 'wrong' }))?.body.code,
    ).toBe('INVALID_PASSWORD');
    expect(recordAttemptFailure).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ account: DRIVER, factor: 'password' }),
    );
  });

  it('checks a driver TOTP code through the driver replay guard', async () => {
    h.user = { mfaEnabled: true, mfaMethod: 'totp', passwordHash: 'x', totpSecretEnc: 'enc' };
    expect(await checkFactorProof(request, DRIVER, { kind: 'totp', code: '123456' })).toBeNull();
    expect(acceptTotpStep).toHaveBeenCalledWith(DRIVER, 4242);
    h.user = { ...h.user, proofLockedUntil: new Date(Date.now() + 60_000) };
    expect(
      (await checkFactorProof(request, DRIVER, { kind: 'totp', code: '123456' }))?.body.code,
    ).toBe('MFA_CODE_INVALID');
    expect(recordAttemptFailure).not.toHaveBeenCalled();
  });

  it('checks a driver email code against a challenge of the driver', async () => {
    h.user = { mfaEnabled: true, mfaMethod: 'email', passwordHash: 'x' };
    expect(
      await checkFactorProof(request, DRIVER, { kind: 'code', code: '654321', challengeId: 7 }),
    ).toBeNull();
    // The challenge must have been sent for the driver's method, and a success clears the backoff.
    expect(verifyMfaChallenge).toHaveBeenCalledWith({}, 7, '654321', {
      ...DRIVER,
      method: 'email',
      purpose: 'proof',
      destination: undefined,
    });
    expect(clearSignInFailures).toHaveBeenCalledWith(DRIVER, 'proof');
  });

  it('never accepts an operator credential or challenge as a driver proof', async () => {
    h.user = { mfaEnabled: false, mfaMethod: null, passwordHash: 'x' };
    h.passkeyCount = 1;
    const proof = { kind: 'passkey' as const, credential: assertion };
    h.challenge = { purpose: 'factor_add', driverId: DRIVER.driverId };
    h.stored = { id: 1, userId: null, driverId: DRIVER.driverId, counter: 0 };
    expect(await checkFactorProof(request, DRIVER, proof)).toBeNull();
    // An operator challenge with the same id string is not the driver's.
    h.challenge = { purpose: 'factor_add', userId: DRIVER.driverId };
    expect((await checkFactorProof(request, DRIVER, proof))?.body.code).toBe(
      'WEBAUTHN_CHALLENGE_EXPIRED',
    );
    // An operator credential does not verify for the driver.
    h.challenge = { purpose: 'factor_add', driverId: DRIVER.driverId };
    h.stored = { id: 1, userId: ME, driverId: null, counter: 0 };
    expect((await checkFactorProof(request, DRIVER, proof))?.body.code).toBe(
      'WEBAUTHN_VERIFICATION_FAILED',
    );
  });
});

describe('the sso proof (security review L4)', () => {
  const ssoRequest = (ssoAt: unknown) =>
    ({
      ...request,
      user: { userId: 'usr_1', roleId: 'rol_1', ssoAt },
    }) as unknown as typeof request;

  it('holds within 10 minutes of the SSO sign-in that issued the session', async () => {
    vi.mocked(passwordAuthBlocked).mockResolvedValue(true);
    h.user = user({ authSource: 'sso', passwordHash: '' });
    const now = Math.floor(Date.now() / 1000);
    expect(await checkFactorProof(ssoRequest(now - 60), ACCOUNT, { kind: 'sso' })).toBeNull();
    expect(ssoProofUntil(ssoRequest(now - 60))).toBeInstanceOf(Date);
    vi.mocked(passwordAuthBlocked).mockResolvedValue(false);
  });

  it('refuses a session without a recent SSO sign-in, and the session alone', async () => {
    vi.mocked(passwordAuthBlocked).mockResolvedValue(true);
    h.user = user({ authSource: 'sso', passwordHash: '' });
    const now = Math.floor(Date.now() / 1000);
    for (const ssoAt of [undefined, now - 11 * 60, now + 3600, 'x']) {
      const refused = await checkFactorProof(ssoRequest(ssoAt), ACCOUNT, { kind: 'sso' });
      expect(refused?.body).toMatchObject({ code: 'VALIDATION_ERROR', proofKinds: ['sso'] });
    }
    const none = await checkFactorProof(ssoRequest(now), ACCOUNT, undefined);
    expect(none?.body).toMatchObject({ code: 'VALIDATION_ERROR', proofKinds: ['sso'] });
    vi.mocked(passwordAuthBlocked).mockResolvedValue(false);
  });

  it('never stands in for a factor the account holds', async () => {
    vi.mocked(passwordAuthBlocked).mockResolvedValue(true);
    h.user = user({ authSource: 'sso', passwordHash: '', mfaEnabled: true, mfaMethod: 'totp' });
    const now = Math.floor(Date.now() / 1000);
    const refused = await checkFactorProof(ssoRequest(now), ACCOUNT, { kind: 'sso' });
    expect(refused?.body).toMatchObject({ code: 'VALIDATION_ERROR', proofKinds: ['totp'] });
    expect(holdsFactor(['sso'])).toBe(false);
    expect(holdsFactor(['password'])).toBe(false);
    expect(holdsFactor(['passkey'])).toBe(true);
    vi.mocked(passwordAuthBlocked).mockResolvedValue(false);
  });
});
