// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { SoftAuthenticator } from './helpers/soft-authenticator.js';

// Routes run with the real ceremony code (lib/webauthn.ts over @simplewebauthn/server)
// against a software authenticator; storage and sessions are in-memory fakes.

const ORIGIN = 'https://csms.example.com';
const ME = 'usr_000000000001';
const ROLE = vi.hoisted(() => 'rol_000000000001');

interface Cred {
  id: number;
  userId: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  aaguid: string | null;
  userHandle: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

const state = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  creds: [] as Cred[],
  nextId: 1,
  challenges: new Map<string, unknown>(),
  mfa: {
    emailEnabled: true,
    totpEnabled: true,
    smsEnabled: false,
    required: 'off',
    requiredRoles: [] as string[],
    webauthnEnabled: true,
    passkeyLoginEnabled: true,
  },
  recoveryCodes: 0,
  casWins: true,
}));

// The device cookies are covered in 129-auth-attacks; here a browser without one.
vi.mock('../lib/device-cookie.js', () => ({
  knownSignInDevice: vi.fn(() => Promise.resolve(null)),
  takeDeviceAttempt: vi.fn(() =>
    Promise.resolve({ granted: true, failures: 1, lockedUntil: null }),
  ),
  recordDeviceFailure: vi.fn(() => Promise.resolve()),
  clearDeviceFailures: vi.fn(() => Promise.resolve()),
  rememberSignInDevice: vi.fn(() => Promise.resolve()),
  revokeSignInDevices: vi.fn(() => Promise.resolve()),
}));
// The pending SSO bind is covered in 98-account-escalation.
vi.mock('../lib/sso-link.js', () => ({
  bearerToken: vi.fn(() => ''),
  completePendingSsoLink: vi.fn(() => Promise.resolve()),
}));
vi.mock('../lib/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/config.js')>();
  return {
    ...actual,
    config: { ...actual.config, CSMS_URL: 'https://csms.example.com', WEBAUTHN_RP_ID: undefined },
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ['eq', a, b]),
  and: vi.fn((...a: unknown[]) => ['and', ...a]),
  or: vi.fn((...a: unknown[]) => ['or', ...a]),
  isNull: vi.fn((a: unknown) => ['isNull', a]),
  lt: vi.fn((a: unknown, b: unknown) => ['lt', a, b]),
  sql: vi.fn(() => 'sql'),
}));

vi.mock('@evtivity/database', () => {
  function chain(kind: 'select' | 'update'): Record<string, unknown> {
    let table = '';
    const c: Record<string, unknown> = {};
    for (const m of ['where', 'set', 'limit']) c[m] = () => c;
    c['from'] = (t: { __table: string }) => {
      table = t.__table;
      return c;
    };
    c['returning'] = () =>
      Promise.resolve(state.casWins ? [{ sessionVersion: 1 }] : ([] as unknown[]));
    c['then'] = (resolve: (v: unknown) => unknown) => {
      if (kind === 'update') return Promise.resolve([]).then(resolve);
      if (table === 'roles') return Promise.resolve([{ id: ROLE, name: 'operator' }]).then(resolve);
      return Promise.resolve(state.user != null ? [state.user] : []).then(resolve);
    };
    return c;
  }
  return {
    client: {},
    db: { select: vi.fn(() => chain('select')), update: vi.fn(() => chain('update')) },
    users: { __table: 'users', id: 'users.id', sessionVersion: 'users.sv' },
    roles: { __table: 'roles', id: 'roles.id', name: 'roles.name' },
    userAuditLog: { __table: 'userAuditLog' },
    writeAudit: vi.fn(async () => undefined),
    getCompanyName: vi.fn(async () => 'Acme Charging'),
    getMfaConfig: vi.fn(async () => state.mfa),
    readMfaConfig: vi.fn(async () => ({ config: state.mfa, fallback: false })),
  };
});

vi.mock('../lib/webauthn-challenges.js', () => ({
  saveWebauthnChallenge: vi.fn(async (challenge: string, record: unknown) => {
    state.challenges.set(challenge, record);
  }),
  takeWebauthnChallenge: vi.fn(async (challenge: string) => {
    const record = state.challenges.get(challenge) ?? null;
    state.challenges.delete(challenge);
    return record;
  }),
}));

vi.mock('../services/mfa-factor.service.js', () => {
  const own = (account: { userId: string }) =>
    state.creds.filter((c) => c.userId === account.userId);
  const summary = (c: Cred) => ({
    id: c.id,
    name: c.name,
    deviceType: c.deviceType,
    backedUp: c.backedUp,
    transports: c.transports,
    aaguid: c.aaguid,
    createdAt: c.createdAt,
    lastUsedAt: c.lastUsedAt,
  });
  return {
    MAX_WEBAUTHN_CREDENTIALS: 3,
    countWebauthnCredentials: vi.fn(async (a: { userId: string }) => own(a).length),
    countRecoveryCodes: vi.fn(async () => state.recoveryCodes),
    // A recovery code proof: 'good-code' is the one unused code of the account.
    consumeRecoveryCode: vi.fn(async (_a: unknown, input: string) => {
      if (input !== 'good-code' || state.recoveryCodes === 0) {
        return { used: false, remaining: state.recoveryCodes };
      }
      state.recoveryCodes -= 1;
      return { used: true, remaining: state.recoveryCodes };
    }),
    mfaFactorCounts: vi.fn(async (a: { userId: string }) => ({
      recoveryCodesRemaining: state.recoveryCodes,
      passkeyCount: own(a).length,
    })),
    listWebauthnCredentials: vi.fn(async (a: { userId: string }) => own(a).map(summary)),
    webauthnCredentialsForCeremony: vi.fn(async (a: { userId: string }) => own(a)),
    findWebauthnCredential: vi.fn(
      async (id: string) => state.creds.find((c) => c.credentialId === id) ?? null,
    ),
    accountUserHandle: vi.fn(async (a: { userId: string }) => own(a)[0]?.userHandle ?? null),
    registerWebauthnCredential: vi.fn(
      async (
        a: { userId: string },
        input: Omit<Cred, 'id' | 'userId' | 'createdAt' | 'lastUsedAt'>,
      ) => {
        if (state.creds.some((c) => c.credentialId === input.credentialId)) {
          return { status: 'duplicate' };
        }
        const before = own(a).length;
        if (before >= 3) return { status: 'limit_reached' };
        const u = state.user ?? {};
        const firstFactor = !(u['mfaEnabled'] === true && u['mfaMethod'] != null) && before === 0;
        const row: Cred = {
          ...input,
          id: state.nextId++,
          userId: a.userId,
          createdAt: new Date(),
          lastUsedAt: null,
        };
        state.creds.push(row);
        return { status: 'registered', credential: summary(row), firstFactor };
      },
    ),
    renameWebauthnCredential: vi.fn(async (a: { userId: string }, id: number, name: string) => {
      const row = own(a).find((c) => c.id === id);
      if (row == null) return null;
      row.name = name;
      return summary(row);
    }),
    removeWebauthnCredential: vi.fn(
      async (
        a: { userId: string },
        id: number,
        opts: { lastFactorCheck: () => Promise<string | null> },
      ) => {
        const mine = own(a);
        if (!mine.some((c) => c.id === id)) return { status: 'not_found' };
        const u = state.user ?? {};
        const lastFactor =
          !(u['mfaEnabled'] === true && u['mfaMethod'] != null) && mine.length === 1;
        if (lastFactor) {
          const reason = await opts.lastFactorCheck();
          if (reason != null) return { status: 'refused', reason };
        }
        state.creds = state.creds.filter((c) => !(c.userId === a.userId && c.id === id));
        return { status: 'removed', sessionVersion: 2, lastFactor };
      },
    ),
    recordWebauthnCredentialUse: vi.fn(
      async (c: { id: number; counter: number }, u: { newCounter: number }) => {
        const row = state.creds.find((r) => r.id === c.id);
        if (row?.counter !== c.counter) return false;
        row.counter = u.newCounter;
        row.lastUsedAt = new Date();
        return true;
      },
    ),
    issueRecoveryCodes: vi.fn(async () => ['aaaaa-bbbbb']),
  };
});

vi.mock('../middleware/rbac.js', () => ({
  selfService:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (n: number) => { send: (b: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        // fail-open: a bad token is the test case, answered as the real guard does
        await reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }
    },
}));

vi.mock('../lib/mfa-enrollment.js', () => ({
  selfServiceOrMfaEnrollment:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (n: number) => { send: (b: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        // fail-open: a bad token is the test case, answered as the real guard does
        await reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }
    },
  isMfaEnrollmentRequest: (request: { user: { mfaEnrollment?: unknown } }) =>
    request.user.mfaEnrollment === true,
  mfaPolicyForRole: vi.fn(async () => 'not_required'),
  sendMfaPolicyUnavailable: async (
    _request: unknown,
    reply: { status: (n: number) => { send: (b: unknown) => Promise<void> } },
  ) => {
    await reply.status(503).send({ error: 'Unavailable', code: 'MFA_POLICY_UNAVAILABLE' });
  },
  operatorMfaEnrollment: vi.fn(() => ({
    mfaEnrollmentRequired: true,
    enrollmentToken: 'enroll',
    availableMethods: ['totp'],
    webauthnAvailable: false,
  })),
  mfaPendingTokenCurrent: (payload: { sv?: unknown }, sessionVersion: number) =>
    payload.sv === sessionVersion,
  sendMfaTokenExpired: async (reply: {
    status: (n: number) => { send: (b: unknown) => Promise<void> };
  }) => {
    await reply
      .status(401)
      .send({ error: 'Invalid or expired MFA token', code: 'MFA_TOKEN_EXPIRED' });
  },
}));

vi.mock('../lib/operator-session.js', () => ({
  issueOperatorSession: vi.fn(async () => 'session-token'),
  endUserSessions: vi.fn(async () => 1),
  announceSessionChange: vi.fn(),
  passwordAuthBlocked: vi.fn(async () => false),
}));
vi.mock('../services/refresh-token.service.js', () => ({
  revokeAllUserSessions: vi.fn(async () => undefined),
}));
vi.mock('../lib/auth-audit.js', () => ({ recordAuthAudit: vi.fn(async () => undefined) }));
vi.mock('../lib/password-verify.js', () => ({ verifyPassword: vi.fn(async () => true) }));
vi.mock('../lib/sign-in-backoff.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/sign-in-backoff.js')>()),
  takeSignInAttempt: vi.fn(async (account: unknown, factor: unknown) => ({
    granted: true,
    account,
    factor,
    failures: 1,
    lockedUntil: null,
  })),
  recordAttemptFailure: vi.fn(async () => null),
  clearSignInFailures: vi.fn(async () => undefined),
  createAccountMfaChallenge: vi.fn(async () => ({ challengeId: 77, code: '123456' })),
}));
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  dispatchSystemNotification: vi.fn(async () => undefined),
}));

import { webauthnRoutes } from '../routes/webauthn.js';
import { dispatchSystemNotification } from '@evtivity/lib';
import { recordAuthAudit } from '../lib/auth-audit.js';
import { createAccountMfaChallenge } from '../lib/sign-in-backoff.js';

function userRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ME,
    roleId: ROLE,
    email: 'op@example.com',
    firstName: 'Olga',
    lastName: 'Op',
    language: 'en',
    timezone: 'UTC',
    themePreference: 'light',
    uiTheme: 'default',
    isActive: true,
    mustResetPassword: false,
    mfaEnabled: false,
    mfaMethod: null,
    mfaLockedUntil: null,
    sessionVersion: 0,
    authSource: 'password',
    passwordHash: '$argon2id$x',
    ...over,
  };
}

describe('WebAuthn routes', () => {
  let app: FastifyInstance;
  let session: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await app.register(jwt, { secret: 'test-secret' });
    webauthnRoutes(app);
    await app.ready();
    session = { authorization: `Bearer ${app.jwt.sign({ userId: ME, roleId: ROLE })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    state.user = userRow();
    state.creds = [];
    state.nextId = 1;
    state.challenges.clear();
    state.mfa.webauthnEnabled = true;
    state.mfa.passkeyLoginEnabled = true;
    state.recoveryCodes = 0;
    state.casWins = true;
    keys.length = 0;
  });

  const keys: SoftAuthenticator[] = [];

  /** The fresh proof a session registration needs: an existing passkey, else the password. */
  async function proofFor(headers: { authorization: string }) {
    if (headers !== session) return undefined;
    const key = keys.find((k) =>
      state.creds.some((c) => c.userId === ME && c.credentialId === k.credentialId),
    );
    if (key != null) {
      const options = await app.inject({
        method: 'POST',
        url: '/users/me/mfa/factor-proof',
        headers,
        payload: { kind: 'passkey' },
      });
      expect(options.statusCode).toBe(200);
      return {
        kind: 'passkey',
        credential: key.authenticate(options.json().options, ORIGIN, undefined),
      };
    }
    return state.user?.['passwordHash'] !== ''
      ? { kind: 'password', password: 'secret' }
      : undefined;
  }

  async function register(
    authenticator: SoftAuthenticator,
    headers = session,
    overrides: Parameters<SoftAuthenticator['register']>[2] = {},
  ) {
    const options = await app.inject({
      method: 'POST',
      url: '/users/me/webauthn/registration-options',
      headers,
    });
    expect(options.statusCode).toBe(200);
    const credential = authenticator.register(options.json(), ORIGIN, overrides);
    const proof = await proofFor(headers);
    const res = await app.inject({
      method: 'POST',
      url: '/users/me/webauthn/registration',
      headers,
      payload: { credential, ...(proof != null ? { proof } : {}) },
    });
    if (res.statusCode === 200) keys.push(authenticator);
    return res;
  }

  async function mfaToken(): Promise<string> {
    return app.jwt.sign({ userId: ME, roleId: ROLE, mfaPending: true, sv: 0 }, { expiresIn: '3m' });
  }

  const webauthnOptions = (mfa: string) =>
    app.inject({ method: 'POST', url: '/auth/webauthn/options', payload: { mfaToken: mfa } });

  /** A registered key, the MFA token and a second-factor assertion for it. */
  async function secondFactor(): Promise<{ token: string; credential: unknown }> {
    const key = new SoftAuthenticator();
    expect((await register(key)).statusCode).toBe(200);
    const token = await mfaToken();
    const options = await webauthnOptions(token);
    expect(options.statusCode).toBe(200);
    return { token, credential: key.authenticate(options.json(), ORIGIN, undefined) };
  }

  const verify = (token: string, credential: unknown) =>
    app.inject({
      method: 'POST',
      url: '/auth/webauthn/verify',
      payload: { mfaToken: token, credential },
    });

  describe('MFA pending token checks', () => {
    it('refuses a token that does not verify', async () => {
      const res = await webauthnOptions('not-a-jwt');
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('MFA_TOKEN_EXPIRED');
    });

    it('refuses a token that is not MFA pending', async () => {
      const res = await webauthnOptions(app.jwt.sign({ userId: ME, roleId: ROLE }));
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_TOKEN_INVALID');
    });

    it('answers MFA_NOT_CONFIGURED for an account that is gone', async () => {
      state.user = null;
      const res = await webauthnOptions(await mfaToken());
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_NOT_CONFIGURED');
    });

    it('refuses a token of an earlier session version', async () => {
      state.user = userRow({ sessionVersion: 4 });
      const res = await webauthnOptions(await mfaToken());
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('MFA_TOKEN_EXPIRED');
    });

    it('refuses an inactive account and audits it', async () => {
      state.user = userRow({ isActive: false });
      const res = await webauthnOptions(await mfaToken());
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('ACCOUNT_DISABLED');
      expect(recordAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'login_failed', method: 'webauthn', reason: 'inactive' }),
      );
    });
  });

  describe('second factor branches', () => {
    it('answers MFA_NOT_CONFIGURED for options without a credential', async () => {
      const res = await webauthnOptions(await mfaToken());
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_NOT_CONFIGURED');
    });

    it('answers MFA_NOT_CONFIGURED when the credential was removed before the verify', async () => {
      const { token, credential } = await secondFactor();
      state.creds = [];
      const res = await verify(token, credential);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_NOT_CONFIGURED');
    });

    it('refuses switched-off passkeys at the verify while another factor exists, and audits', async () => {
      const { token, credential } = await secondFactor();
      state.user = userRow({ mfaEnabled: true, mfaMethod: 'totp' });
      state.mfa.webauthnEnabled = false;
      const res = await verify(token, credential);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('MFA_METHOD_DISABLED');
      expect(recordAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'login_failed', reason: 'mfa_method_disabled' }),
      );
    });

    it('refuses an assertion whose challenge was never issued or already used', async () => {
      const { token, credential } = await secondFactor();
      state.challenges.clear();
      const res = await verify(token, credential);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('WEBAUTHN_CHALLENGE_EXPIRED');
    });

    it('sends the only-passkey account to set up an allowed method once passkeys are off', async () => {
      const { token, credential } = await secondFactor();
      state.mfa.webauthnEnabled = false;
      const res = await verify(token, credential);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ mfaEnrollmentRequired: true, enrollmentToken: 'enroll' });
      expect(recordAuthAudit).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'login_succeeded' }),
      );
    });
  });

  describe('registration branches', () => {
    it('answers USER_NOT_FOUND for registration options of a missing user', async () => {
      state.user = null;
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/webauthn/registration-options',
        headers: session,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('USER_NOT_FOUND');
    });

    async function registrationCredential(key: SoftAuthenticator): Promise<unknown> {
      const options = await app.inject({
        method: 'POST',
        url: '/users/me/webauthn/registration-options',
        headers: session,
      });
      expect(options.statusCode).toBe(200);
      return key.register(options.json(), ORIGIN, {});
    }

    it('refuses a registration once passkeys are switched off', async () => {
      const credential = await registrationCredential(new SoftAuthenticator());
      state.mfa.webauthnEnabled = false;
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/webauthn/registration',
        headers: session,
        payload: { credential, proof: { kind: 'password', password: 'secret' } },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('MFA_METHOD_DISABLED');
      expect(state.creds).toHaveLength(0);
    });

    it('refuses a name with no visible character', async () => {
      const credential = await registrationCredential(new SoftAuthenticator());
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/webauthn/registration',
        headers: session,
        payload: {
          credential,
          name: '​​',
          proof: { kind: 'password', password: 'secret' },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'The name must have 1 to 100 visible characters',
        code: 'VALIDATION_ERROR',
      });
    });

    it('refuses a response without a readable challenge', async () => {
      const credential = (await registrationCredential(new SoftAuthenticator())) as {
        response: { clientDataJSON: string };
      };
      credential.response.clientDataJSON = Buffer.from('not json').toString('base64url');
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/webauthn/registration',
        headers: session,
        payload: { credential, proof: { kind: 'password', password: 'secret' } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('WEBAUTHN_CHALLENGE_EXPIRED');
    });

    it('refuses a credential id that is already registered', async () => {
      const first = new SoftAuthenticator();
      expect((await register(first)).statusCode).toBe(200);
      const res = await register(new SoftAuthenticator({ credentialId: first.credentialId }));
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('WEBAUTHN_VERIFICATION_FAILED');
      expect(state.creds).toHaveLength(1);
    });
  });

  describe('removal and proofs', () => {
    it('answers PASSKEY_NOT_FOUND for a credential the account does not hold', async () => {
      await register(new SoftAuthenticator());
      state.user = userRow({ mfaEnabled: true, mfaMethod: 'totp' });
      const proof = await proofFor(session);
      const res = await app.inject({
        method: 'DELETE',
        url: '/users/me/webauthn/99',
        headers: session,
        payload: { proof },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PASSKEY_NOT_FOUND');
      expect(state.creds).toHaveLength(1);
    });

    it('sends a code proof to the email method of the account', async () => {
      state.user = userRow({ mfaEnabled: true, mfaMethod: 'email' });
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/mfa/factor-proof',
        headers: session,
        payload: { kind: 'code' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ challengeId: 77 });
      expect(createAccountMfaChallenge).toHaveBeenCalledWith({ userId: ME }, 'email', {
        purpose: 'proof',
        destination: undefined,
        destinationProven: true,
      });
      expect(dispatchSystemNotification).toHaveBeenCalledWith(
        expect.anything(),
        'mfa.VerificationCode',
        expect.objectContaining({ email: 'op@example.com' }),
        { code: '123456' },
        expect.anything(),
      );
    });

    it('answers 429 when the code cap refuses the proof code', async () => {
      state.user = userRow({ mfaEnabled: true, mfaMethod: 'email' });
      vi.mocked(createAccountMfaChallenge).mockResolvedValueOnce({
        limited: true,
        retryAfterSeconds: 60,
        openChallengeId: null,
      } as never);
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/mfa/factor-proof',
        headers: session,
        payload: { kind: 'code' },
      });
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ code: 'MFA_RESEND_LIMITED', retryAfterSeconds: 60 });
      expect(res.headers['retry-after']).toBe('60');
      expect(dispatchSystemNotification).not.toHaveBeenCalled();
    });
  });

  describe('passkey sign-in switched off', () => {
    it('refuses the verify while passkey sign-in is switched off', async () => {
      const key = new SoftAuthenticator();
      await register(key);
      const options = await app.inject({ method: 'POST', url: '/auth/passkey/options' });
      expect(options.statusCode).toBe(200);
      const credential = key.authenticate(options.json(), ORIGIN, undefined);
      state.mfa.passkeyLoginEnabled = false;
      const res = await app.inject({
        method: 'POST',
        url: '/auth/passkey/verify',
        payload: { credential },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('MFA_METHOD_DISABLED');
    });
  });
});
