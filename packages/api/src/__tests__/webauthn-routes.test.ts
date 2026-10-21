// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
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
}));

import { webauthnRoutes } from '../routes/webauthn.js';
import { verifyRecoveryCodesPasskey } from '../lib/webauthn-http.js';
import { recordAuthAudit } from '../lib/auth-audit.js';
import { recordAttemptFailure, takeSignInAttempt } from '../lib/sign-in-backoff.js';
import { mfaPolicyForRole } from '../lib/mfa-enrollment.js';
import { issueRecoveryCodes } from '../services/mfa-factor.service.js';
import {
  endUserSessions,
  issueOperatorSession,
  passwordAuthBlocked,
} from '../lib/operator-session.js';
import { verifyPassword } from '../lib/password-verify.js';

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

  describe('registration', () => {
    it('registers a passkey, names the RP after the company, and turns MFA on as the first factor', async () => {
      const authenticator = new SoftAuthenticator();
      const options = await app.inject({
        method: 'POST',
        url: '/users/me/webauthn/registration-options',
        headers: session,
      });
      expect(options.json()).toMatchObject({
        rp: { id: 'csms.example.com', name: 'Acme Charging' },
        user: { name: 'op@example.com', displayName: 'Olga Op' },
        attestation: 'none',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/webauthn/registration',
        headers: session,
        payload: {
          credential: authenticator.register(options.json(), ORIGIN),
          name: '\u202eLaptop\u200b',
          proof: { kind: 'password', password: 'secret' },
        },
      });
      expect(res.statusCode).toBe(200);
      // Control and format characters are dropped from the name.
      expect(res.json()).toMatchObject({
        credential: { name: 'Laptop', deviceType: 'multiDevice', backedUp: true },
        recoveryCodes: ['aaaaa-bbbbb'],
      });
      expect(state.creds).toHaveLength(1);
      expect(endUserSessions).toHaveBeenCalledWith(ME, { apiKeys: false });
      expect(issueRecoveryCodes).toHaveBeenCalledWith(
        { userId: ME },
        'generated',
        expect.anything(),
      );
    });

    it('adds a second factor with a passkey proof, without new recovery codes or ending sessions', async () => {
      await register(new SoftAuthenticator());
      vi.mocked(endUserSessions).mockClear();
      vi.mocked(issueRecoveryCodes).mockClear();
      const res = await register(new SoftAuthenticator());
      expect(res.statusCode).toBe(200);
      expect(res.json().recoveryCodes).toBeUndefined();
      expect(endUserSessions).not.toHaveBeenCalled();
      expect(issueRecoveryCodes).not.toHaveBeenCalled();
      expect(state.creds).toHaveLength(2);
    });

    describe('fresh proof with a session', () => {
      async function attempt(proof?: Record<string, unknown>) {
        const options = await app.inject({
          method: 'POST',
          url: '/users/me/webauthn/registration-options',
          headers: session,
        });
        return app.inject({
          method: 'POST',
          url: '/users/me/webauthn/registration',
          headers: session,
          payload: {
            credential: new SoftAuthenticator().register(options.json(), ORIGIN),
            ...(proof != null ? { proof } : {}),
          },
        });
      }

      it('asks an account without a factor for its password', async () => {
        const none = await attempt();
        expect(none.statusCode).toBe(400);
        expect(none.json()).toMatchObject({ code: 'VALIDATION_ERROR', proofKinds: ['password'] });
        vi.mocked(verifyPassword).mockResolvedValueOnce(false);
        const wrong = await attempt({ kind: 'password', password: 'wrong' });
        expect(wrong.json().code).toBe('INVALID_PASSWORD');
        expect(state.creds).toHaveLength(0);
        const ok = await attempt({ kind: 'password', password: 'secret' });
        expect(ok.statusCode).toBe(200);
      });

      it('asks an account with a factor for that factor, not the password', async () => {
        state.user = userRow({ mfaEnabled: true, mfaMethod: 'totp' });
        const password = await attempt({ kind: 'password', password: 'secret' });
        expect(password.statusCode).toBe(400);
        expect(password.json()).toMatchObject({ code: 'VALIDATION_ERROR', proofKinds: ['totp'] });
        const noCode = await attempt({ kind: 'totp' });
        expect(noCode.json().code).toBe('VALIDATION_ERROR');
        expect(state.creds).toHaveLength(0);
        expect(verifyPassword).not.toHaveBeenCalled();
      });

      it('refuses a passkey proof of another purpose or another user', async () => {
        const key = new SoftAuthenticator();
        await register(key);
        const recovery = await app.inject({
          method: 'POST',
          url: '/users/me/mfa/recovery-codes/webauthn-options',
          headers: session,
        });
        const wrongPurpose = await attempt({
          kind: 'passkey',
          credential: key.authenticate(recovery.json(), ORIGIN, undefined),
        });
        expect(wrongPurpose.json().code).toBe('WEBAUTHN_CHALLENGE_EXPIRED');

        const options = await app.inject({
          method: 'POST',
          url: '/users/me/mfa/factor-proof',
          headers: session,
          payload: { kind: 'passkey' },
        });
        // The assertion's credential now belongs to another account; this one keeps a passkey.
        const cred = state.creds[0];
        if (cred != null) cred.userId = 'usr_000000000002';
        state.creds.push({ ...(cred as Cred), id: 99, credentialId: 'own-other', userId: ME });
        const foreign = await attempt({
          kind: 'passkey',
          credential: key.authenticate(options.json().options, ORIGIN, undefined),
        });
        expect(foreign.json().code).toBe('WEBAUTHN_VERIFICATION_FAILED');
        expect(state.creds).toHaveLength(2);
      });

      it('refuses an account with no password, factor or SSO sign-in (fail closed)', async () => {
        // An SSO account after SSO was turned off: nothing can prove it.
        state.user = userRow({ passwordHash: '', authSource: 'sso' });
        const res = await attempt();
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR', proofKinds: [] });
        expect(state.creds).toHaveLength(0);
        expect(verifyPassword).not.toHaveBeenCalled();
      });

      it('answers MFA_NOT_CONFIGURED for a proof the account cannot give', async () => {
        for (const kind of ['passkey', 'code']) {
          const res = await app.inject({
            method: 'POST',
            url: '/users/me/mfa/factor-proof',
            headers: session,
            payload: { kind },
          });
          expect(res.statusCode).toBe(400);
          expect(res.json().code).toBe('MFA_NOT_CONFIGURED');
        }
      });
    });

    it('refuses a replayed challenge', async () => {
      const authenticator = new SoftAuthenticator();
      const options = await app.inject({
        method: 'POST',
        url: '/users/me/webauthn/registration-options',
        headers: session,
      });
      const credential = authenticator.register(options.json(), ORIGIN);
      const first = await app.inject({
        method: 'POST',
        url: '/users/me/webauthn/registration',
        headers: session,
        payload: { credential, proof: { kind: 'password', password: 'secret' } },
      });
      expect(first.statusCode).toBe(200);
      keys.push(authenticator);
      const replay = await app.inject({
        method: 'POST',
        url: '/users/me/webauthn/registration',
        headers: session,
        payload: { credential, proof: await proofFor(session) },
      });
      expect(replay.statusCode).toBe(400);
      expect(replay.json().code).toBe('WEBAUTHN_CHALLENGE_EXPIRED');
    });

    it('refuses a wrong origin and a wrong RP ID', async () => {
      for (const overrides of [
        { origin: 'https://evil.example.net' },
        { rpId: 'evil.example.net' },
      ]) {
        const res = await register(new SoftAuthenticator(), session, overrides);
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('WEBAUTHN_VERIFICATION_FAILED');
      }
      expect(state.creds).toHaveLength(0);
    });

    it('refuses the challenge of another user', async () => {
      const other = {
        authorization: `Bearer ${app.jwt.sign({ userId: 'usr_000000000002', roleId: ROLE })}`,
      };
      const options = await app.inject({
        method: 'POST',
        url: '/users/me/webauthn/registration-options',
        headers: other,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/webauthn/registration',
        headers: session,
        payload: {
          credential: new SoftAuthenticator().register(options.json(), ORIGIN),
          proof: { kind: 'password', password: 'secret' },
        },
      });
      expect(res.json().code).toBe('WEBAUTHN_CHALLENGE_EXPIRED');
    });

    it('refuses registration while passkeys are switched off, and over the limit', async () => {
      state.mfa.webauthnEnabled = false;
      const off = await app.inject({
        method: 'POST',
        url: '/users/me/webauthn/registration-options',
        headers: session,
      });
      expect(off.statusCode).toBe(403);
      expect(off.json().code).toBe('MFA_METHOD_DISABLED');

      state.mfa.webauthnEnabled = true;
      const pending = await app.inject({
        method: 'POST',
        url: '/users/me/webauthn/registration-options',
        headers: session,
      });
      for (let i = 0; i < 3; i++)
        expect((await register(new SoftAuthenticator())).statusCode).toBe(200);
      // Options taken before the limit was reached: the final call counts again.
      const late = await app.inject({
        method: 'POST',
        url: '/users/me/webauthn/registration',
        headers: session,
        payload: {
          credential: new SoftAuthenticator().register(pending.json(), ORIGIN),
          proof: await proofFor(session),
        },
      });
      expect(late.statusCode).toBe(409);
      expect(late.json().code).toBe('PASSKEY_LIMIT_REACHED');
      const full = await app.inject({
        method: 'POST',
        url: '/users/me/webauthn/registration-options',
        headers: session,
      });
      expect(full.statusCode).toBe(409);
      expect(full.json().code).toBe('PASSKEY_LIMIT_REACHED');
    });

    it('enrolls with the enrollment token: signs in, and a second use loses the race', async () => {
      const enrolling = {
        authorization: `Bearer ${app.jwt.sign({ userId: ME, roleId: ROLE, mfaEnrollment: true, sv: 0 })}`,
      };
      const res = await register(new SoftAuthenticator(), enrolling);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        token: 'session-token',
        user: { id: ME, email: 'op@example.com' },
        role: { id: ROLE, name: 'operator' },
        recoveryCodes: ['aaaaa-bbbbb'],
      });
      expect(recordAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'login_succeeded', method: 'mfa_enrollment' }),
      );

      state.casWins = false;
      const lost = await register(new SoftAuthenticator(), enrolling);
      expect(lost.statusCode).toBe(401);
    });
  });

  describe('list, rename and remove', () => {
    it('lists, renames and refuses another account credential', async () => {
      await register(new SoftAuthenticator());
      const list = await app.inject({ method: 'GET', url: '/users/me/webauthn', headers: session });
      expect(list.json()).toHaveLength(1);
      const id = list.json<Array<{ id: number }>>()[0]?.id ?? 0;
      const renamed = await app.inject({
        method: 'PATCH',
        url: `/users/me/webauthn/${String(id)}`,
        headers: session,
        payload: { name: 'Work Key' },
      });
      expect(renamed.json().name).toBe('Work Key');
      const blank = await app.inject({
        method: 'PATCH',
        url: `/users/me/webauthn/${String(id)}`,
        headers: session,
        payload: { name: '\u200b\u202e\u0007' },
      });
      expect(blank.statusCode).toBe(400);
      expect(blank.json().code).toBe('VALIDATION_ERROR');
      const missing = await app.inject({
        method: 'PATCH',
        url: '/users/me/webauthn/999',
        headers: session,
        payload: { name: 'x' },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe('PASSKEY_NOT_FOUND');
    });

    it('refuses removing the last factor while MFA is required', async () => {
      await register(new SoftAuthenticator());
      const proof = await proofFor(session);
      vi.mocked(mfaPolicyForRole).mockResolvedValueOnce('required');
      const res = await app.inject({
        method: 'DELETE',
        url: '/users/me/webauthn/1',
        headers: session,
        payload: { proof },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('MFA_REQUIRED_BY_POLICY');
      expect(state.creds).toHaveLength(1);
    });

    it('refuses removing the last factor when the MFA settings cannot be read', async () => {
      await register(new SoftAuthenticator());
      const proof = await proofFor(session);
      vi.mocked(mfaPolicyForRole).mockResolvedValueOnce('unavailable');
      const res = await app.inject({
        method: 'DELETE',
        url: '/users/me/webauthn/1',
        headers: session,
        payload: { proof },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('MFA_POLICY_UNAVAILABLE');
      expect(state.creds).toHaveLength(1);
    });

    it('asks for a factor or recovery code proof to remove the last factor, never the password', async () => {
      await register(new SoftAuthenticator());
      state.recoveryCodes = 10;
      const noProof = await app.inject({
        method: 'DELETE',
        url: '/users/me/webauthn/1',
        headers: session,
        payload: {},
      });
      expect(noProof.statusCode).toBe(400);
      expect(noProof.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        proofKinds: ['passkey', 'recovery_code'],
      });
      vi.mocked(verifyPassword).mockClear();
      const password = await app.inject({
        method: 'DELETE',
        url: '/users/me/webauthn/1',
        headers: session,
        payload: { proof: { kind: 'password', password: 'secret' } },
      });
      expect(password.statusCode).toBe(400);
      expect(password.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        proofKinds: ['passkey', 'recovery_code'],
      });
      expect(verifyPassword).not.toHaveBeenCalled();
      const wrong = await app.inject({
        method: 'DELETE',
        url: '/users/me/webauthn/1',
        headers: session,
        payload: { proof: { kind: 'recovery_code', recoveryCode: 'wrong-code' } },
      });
      expect(wrong.json().code).toBe('MFA_CODE_INVALID');
      expect(recordAttemptFailure).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ account: { userId: ME }, factor: 'proof' }),
      );
      expect(state.creds).toHaveLength(1);

      const ok = await app.inject({
        method: 'DELETE',
        url: '/users/me/webauthn/1',
        headers: session,
        payload: { proof: { kind: 'recovery_code', recoveryCode: 'good-code' } },
      });
      expect(ok.statusCode).toBe(200);
      expect(state.creds).toHaveLength(0);
      expect(issueOperatorSession).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ id: ME, sessionVersion: 2 }),
      );
    });

    it('removes the last factor with a proof by that passkey', async () => {
      const key = new SoftAuthenticator();
      await register(key);
      const proof = await proofFor(session);
      expect(proof?.kind).toBe('passkey');
      const res = await app.inject({
        method: 'DELETE',
        url: '/users/me/webauthn/1',
        headers: session,
        payload: { proof },
      });
      expect(res.statusCode).toBe(200);
      expect(state.creds).toHaveLength(0);
    });

    it('lets an SSO account without a password remove its only passkey by proving it', async () => {
      await register(new SoftAuthenticator());
      state.user = userRow({ passwordHash: '', authSource: 'sso' });
      const password = await app.inject({
        method: 'DELETE',
        url: '/users/me/webauthn/1',
        headers: session,
        payload: { proof: { kind: 'password', password: 'secret' } },
      });
      expect(password.statusCode).toBe(400);
      expect(password.json()).toMatchObject({ code: 'VALIDATION_ERROR', proofKinds: ['passkey'] });
      expect(state.creds).toHaveLength(1);

      const proof = await proofFor(session);
      const res = await app.inject({
        method: 'DELETE',
        url: '/users/me/webauthn/1',
        headers: session,
        payload: { proof },
      });
      expect(res.statusCode).toBe(200);
      expect(state.creds).toHaveLength(0);
    });

    it('refuses a replayed passkey proof for the last factor', async () => {
      await register(new SoftAuthenticator());
      await register(new SoftAuthenticator());
      const proof = await proofFor(session);
      // The first removal is not the last factor; its proof spends the challenge.
      const first = await app.inject({
        method: 'DELETE',
        url: '/users/me/webauthn/2',
        headers: session,
        payload: { proof },
      });
      expect(first.statusCode).toBe(200);
      const replay = await app.inject({
        method: 'DELETE',
        url: '/users/me/webauthn/1',
        headers: session,
        payload: { proof },
      });
      expect(replay.statusCode).toBe(400);
      expect(replay.json().code).toBe('WEBAUTHN_CHALLENGE_EXPIRED');
      expect(state.creds).toHaveLength(1);
    });

    it('needs a proof to remove any passkey, not only the last factor', async () => {
      await register(new SoftAuthenticator());
      state.user = userRow({ mfaEnabled: true, mfaMethod: 'totp' });
      const refused = await app.inject({
        method: 'DELETE',
        url: '/users/me/webauthn/1',
        headers: session,
        payload: {},
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        proofKinds: ['totp', 'passkey'],
      });
      expect(state.creds).toHaveLength(1);
    });

    it('removes one of several factors with a factor proof, without the password', async () => {
      await register(new SoftAuthenticator());
      state.user = userRow({ mfaEnabled: true, mfaMethod: 'totp' });
      vi.mocked(verifyPassword).mockClear();
      const proof = await proofFor(session);
      const res = await app.inject({
        method: 'DELETE',
        url: '/users/me/webauthn/1',
        headers: session,
        payload: { proof },
      });
      expect(res.statusCode).toBe(200);
      expect(verifyPassword).not.toHaveBeenCalled();
    });
  });

  describe('second factor', () => {
    it('signs in with a security key without user verification', async () => {
      const key = new SoftAuthenticator({ userVerified: false, backedUp: false });
      await register(key);
      state.user = userRow({ mfaEnabled: true, mfaMethod: 'totp' });
      const token = await mfaToken();
      const options = await app.inject({
        method: 'POST',
        url: '/auth/webauthn/options',
        payload: { mfaToken: token },
      });
      expect(options.json()).toMatchObject({
        userVerification: 'preferred',
        allowCredentials: [{ id: key.credentialId, type: 'public-key' }],
      });
      const res = await app.inject({
        method: 'POST',
        url: '/auth/webauthn/verify',
        payload: {
          mfaToken: token,
          credential: key.authenticate(options.json(), ORIGIN, undefined),
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ token: 'session-token', user: { id: ME } });
      expect(recordAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'login_succeeded', method: 'webauthn' }),
      );
    });

    it('neither checks nor counts the MFA lock for a refused assertion', async () => {
      const key = new SoftAuthenticator();
      await register(key);
      const token = await mfaToken();
      const options = await app.inject({
        method: 'POST',
        url: '/auth/webauthn/options',
        payload: { mfaToken: token },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/auth/webauthn/verify',
        payload: {
          mfaToken: token,
          credential: key.authenticate(options.json(), ORIGIN, undefined, {
            origin: 'https://evil.example.net',
          }),
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('WEBAUTHN_VERIFICATION_FAILED');
      // A signature cannot be guessed: a refused one does not lock the owner's sign-in.
      expect(takeSignInAttempt).not.toHaveBeenCalledWith(expect.anything(), 'mfa');
      expect(recordAttemptFailure).not.toHaveBeenCalled();
    });

    it('signs in with a passkey while wrong codes locked the MFA step', async () => {
      const key = new SoftAuthenticator();
      await register(key);
      state.user = userRow({
        mfaEnabled: true,
        mfaMethod: 'totp',
        mfaLockedUntil: new Date(Date.now() + 10 * 60_000),
      });
      const token = await mfaToken();
      const options = await app.inject({
        method: 'POST',
        url: '/auth/webauthn/options',
        payload: { mfaToken: token },
      });
      expect(options.statusCode).toBe(200);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/webauthn/verify',
        payload: {
          mfaToken: token,
          credential: key.authenticate(options.json(), ORIGIN, undefined),
        },
      });
      expect(res.statusCode).toBe(200);
    });

    it('refuses a credential of another account as the second factor', async () => {
      const key = new SoftAuthenticator();
      await register(key);
      const token = await mfaToken();
      const options = await app.inject({
        method: 'POST',
        url: '/auth/webauthn/options',
        payload: { mfaToken: token },
      });
      const cred = state.creds[0];
      if (cred != null) cred.userId = 'usr_000000000002';
      state.creds.push({ ...(cred as Cred), id: 99, credentialId: 'own-other', userId: ME });
      const res = await app.inject({
        method: 'POST',
        url: '/auth/webauthn/verify',
        payload: {
          mfaToken: token,
          credential: key.authenticate(options.json(), ORIGIN, undefined),
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('WEBAUTHN_VERIFICATION_FAILED');
      expect(recordAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'login_failed', reason: 'webauthn_unknown_credential' }),
      );
      expect(recordAttemptFailure).not.toHaveBeenCalled();
    });

    it('refuses a counter that goes backwards above 0', async () => {
      const key = new SoftAuthenticator({ counter: 10 });
      await register(key);
      const token = await mfaToken();
      const options = await app.inject({
        method: 'POST',
        url: '/auth/webauthn/options',
        payload: { mfaToken: token },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/auth/webauthn/verify',
        payload: {
          mfaToken: token,
          credential: key.authenticate(options.json(), ORIGIN, undefined, { counter: 5 }),
        },
      });
      expect(res.json().code).toBe('WEBAUTHN_VERIFICATION_FAILED');
    });

    it('refuses switched-off passkeys while another factor exists', async () => {
      await register(new SoftAuthenticator());
      state.user = userRow({ mfaEnabled: true, mfaMethod: 'totp' });
      state.mfa.webauthnEnabled = false;
      const res = await app.inject({
        method: 'POST',
        url: '/auth/webauthn/options',
        payload: { mfaToken: await mfaToken() },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('MFA_METHOD_DISABLED');
    });

    it('refuses a token that is not MFA pending', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/webauthn/options',
        payload: { mfaToken: app.jwt.sign({ userId: ME, roleId: ROLE }) },
      });
      expect(res.json().code).toBe('MFA_TOKEN_INVALID');
    });
  });

  describe('recovery codes proof', () => {
    const request = { log: { info: vi.fn() } } as unknown as FastifyRequest;

    async function proofOptions() {
      return app.inject({
        method: 'POST',
        url: '/users/me/mfa/recovery-codes/webauthn-options',
        headers: session,
      });
    }

    it('answers MFA_NOT_CONFIGURED without a passkey', async () => {
      const res = await proofOptions();
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_NOT_CONFIGURED');
    });

    it('lists only the user credentials and accepts their assertion once', async () => {
      const key = new SoftAuthenticator();
      await register(key);
      const options = await proofOptions();
      expect(options.statusCode).toBe(200);
      expect(options.json()).toMatchObject({
        userVerification: 'preferred',
        allowCredentials: [{ id: key.credentialId, type: 'public-key' }],
      });
      expect(state.challenges.get(options.json<{ challenge: string }>().challenge)).toEqual({
        purpose: 'recovery_regenerate',
        userId: ME,
      });
      const credential = key.authenticate(options.json(), ORIGIN, undefined);
      expect(await verifyRecoveryCodesPasskey(request, { userId: ME }, credential)).toBe(
        'verified',
      );
      expect(await verifyRecoveryCodesPasskey(request, { userId: ME }, credential)).toBe(
        'challenge_expired',
      );
    });

    it('works while passkeys are switched off: the caller is signed in', async () => {
      const key = new SoftAuthenticator();
      await register(key);
      state.mfa.webauthnEnabled = false;
      const options = await proofOptions();
      expect(options.statusCode).toBe(200);
      const credential = key.authenticate(options.json(), ORIGIN, undefined);
      expect(await verifyRecoveryCodesPasskey(request, { userId: ME }, credential)).toBe(
        'verified',
      );
    });

    it('refuses a sign-in challenge, another user, a foreign credential and a bad origin', async () => {
      const key = new SoftAuthenticator();
      await register(key);

      const signIn = await app.inject({
        method: 'POST',
        url: '/auth/webauthn/options',
        payload: { mfaToken: await mfaToken() },
      });
      expect(
        await verifyRecoveryCodesPasskey(
          request,
          { userId: ME },
          key.authenticate(signIn.json(), ORIGIN, undefined),
        ),
      ).toBe('challenge_expired');

      const forOther = await proofOptions();
      expect(
        await verifyRecoveryCodesPasskey(
          request,
          { userId: 'usr_000000000002' },
          key.authenticate(forOther.json(), ORIGIN, undefined),
        ),
      ).toBe('challenge_expired');

      // A credential that belongs to another account fails even with this user's challenge.
      const foreign = await proofOptions();
      const cred = state.creds[0];
      expect(cred).toBeDefined();
      if (cred != null) cred.userId = 'usr_000000000002';
      expect(
        await verifyRecoveryCodesPasskey(
          request,
          { userId: ME },
          key.authenticate(foreign.json(), ORIGIN, undefined),
        ),
      ).toBe('failed');
      if (cred != null) cred.userId = ME;

      const badOrigin = await proofOptions();
      expect(
        await verifyRecoveryCodesPasskey(
          request,
          { userId: ME },
          key.authenticate(badOrigin.json(), ORIGIN, undefined, {
            origin: 'https://evil.example.net',
          }),
        ),
      ).toBe('failed');
    });
  });

  describe('passkey sign-in', () => {
    async function signIn(key: SoftAuthenticator, overrides = {}) {
      const options = await app.inject({ method: 'POST', url: '/auth/passkey/options' });
      expect(options.json()).toMatchObject({
        rpId: 'csms.example.com',
        userVerification: 'required',
      });
      const handle = state.creds[0]?.userHandle;
      return app.inject({
        method: 'POST',
        url: '/auth/passkey/verify',
        payload: { credential: key.authenticate(options.json(), ORIGIN, handle, overrides) },
      });
    }

    it('signs in with a passkey as both factors', async () => {
      const key = new SoftAuthenticator();
      await register(key);
      const res = await signIn(key);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ token: 'session-token', role: { name: 'operator' } });
      expect(recordAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'login_succeeded', method: 'passkey' }),
      );
    });

    it('refuses a passkey sign-in without user verification', async () => {
      const key = new SoftAuthenticator({ userVerified: false });
      await register(key);
      const res = await signIn(key);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('WEBAUTHN_VERIFICATION_FAILED');
    });

    it('refuses a missing or mismatched user handle', async () => {
      const key = new SoftAuthenticator();
      await register(key);
      const options = await app.inject({ method: 'POST', url: '/auth/passkey/options' });
      const noHandle = await app.inject({
        method: 'POST',
        url: '/auth/passkey/verify',
        payload: { credential: key.authenticate(options.json(), ORIGIN, undefined) },
      });
      expect(noHandle.statusCode).toBe(400);
      expect(noHandle.json().code).toBe('WEBAUTHN_VERIFICATION_FAILED');
      const other = await signIn(key, { userHandle: 'b3RoZXItaGFuZGxl' });
      expect(other.statusCode).toBe(400);
      expect(other.json().code).toBe('WEBAUTHN_VERIFICATION_FAILED');
      expect(recordAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'login_failed', method: 'passkey', accountId: ME }),
      );
    });

    it('refuses an SSO account while SSO is enabled', async () => {
      const key = new SoftAuthenticator();
      await register(key);
      state.user = userRow({ authSource: 'sso', passwordHash: '' });
      vi.mocked(passwordAuthBlocked).mockResolvedValueOnce(true);
      vi.mocked(issueOperatorSession).mockClear();
      const res = await signIn(key);
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('INVALID_CREDENTIALS');
      expect(recordAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'login_failed', reason: 'sso_account' }),
      );
      expect(issueOperatorSession).not.toHaveBeenCalled();
    });

    it('refuses an inactive user after the signature checks out', async () => {
      const key = new SoftAuthenticator();
      await register(key);
      state.user = userRow({ isActive: false });
      const res = await signIn(key);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('ACCOUNT_DISABLED');
    });

    it('sends a user who must change the password there instead of signing in', async () => {
      const key = new SoftAuthenticator();
      await register(key);
      state.user = userRow({ mustResetPassword: true });
      const res = await signIn(key);
      expect(res.json()).toEqual({ mustResetPassword: true });
    });

    it('answers PASSKEY_NOT_FOUND for an unknown credential and refuses a replay', async () => {
      const key = new SoftAuthenticator();
      const unknown = await signIn(key);
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().code).toBe('PASSKEY_NOT_FOUND');
      expect(recordAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          accountId: null,
          action: 'login_failed',
          method: 'passkey',
          reason: 'webauthn_unknown_credential',
        }),
      );

      await register(key);
      const options = await app.inject({ method: 'POST', url: '/auth/passkey/options' });
      const credential = key.authenticate(options.json(), ORIGIN, state.creds[0]?.userHandle);
      const first = await app.inject({
        method: 'POST',
        url: '/auth/passkey/verify',
        payload: { credential },
      });
      expect(first.statusCode).toBe(200);
      const replay = await app.inject({
        method: 'POST',
        url: '/auth/passkey/verify',
        payload: { credential },
      });
      expect(replay.json().code).toBe('WEBAUTHN_CHALLENGE_EXPIRED');
    });

    it('is closed while passkey sign-in is switched off', async () => {
      state.mfa.passkeyLoginEnabled = false;
      const res = await app.inject({ method: 'POST', url: '/auth/passkey/options' });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('MFA_METHOD_DISABLED');
      state.mfa.passkeyLoginEnabled = true;
      state.mfa.webauthnEnabled = false;
      const off = await app.inject({ method: 'POST', url: '/auth/passkey/options' });
      expect(off.statusCode).toBe(403);
    });
  });
});
