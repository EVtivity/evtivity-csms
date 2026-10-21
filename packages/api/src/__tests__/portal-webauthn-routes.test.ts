// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { SoftAuthenticator } from './helpers/soft-authenticator.js';

// The driver passkey routes (routes/portal/webauthn.ts) run with the real ceremony code
// against a software authenticator; storage and sessions are in-memory fakes. The relying
// party is the portal, and no operator credential or challenge may verify here.

const { PORTAL, CSMS } = vi.hoisted(() => ({
  PORTAL: 'https://portal.example.com',
  CSMS: 'https://csms.example.com',
}));
const ME = 'drv_000000000001';

interface Cred {
  id: number;
  userId: string | null;
  driverId: string | null;
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
  driver: null as Record<string, unknown> | null,
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
    requireDrivers: false,
  },
  casWins: true,
  recoveryCodes: 0,
}));

vi.mock('../lib/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/config.js')>();
  return {
    ...actual,
    config: { ...actual.config, CSMS_URL: CSMS, PORTAL_URL: PORTAL, WEBAUTHN_RP_ID: undefined },
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ['eq', a, b]),
  and: vi.fn((...a: unknown[]) => ['and', ...a]),
  or: vi.fn((...a: unknown[]) => ['or', ...a]),
  gt: vi.fn((a: unknown, b: unknown) => ['gt', a, b]),
  lt: vi.fn((a: unknown, b: unknown) => ['lt', a, b]),
  isNull: vi.fn((a: unknown) => ['isNull', a]),
  sql: vi.fn(() => 'sql'),
}));

vi.mock('@evtivity/database', () => {
  function chain(kind: 'select' | 'update'): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'set', 'limit']) c[m] = () => c;
    c['returning'] = () => Promise.resolve(state.casWins ? [{ id: ME }] : ([] as unknown[]));
    c['then'] = (resolve: (v: unknown) => unknown) => {
      if (kind === 'update') return Promise.resolve([]).then(resolve);
      return Promise.resolve(state.driver != null ? [state.driver] : []).then(resolve);
    };
    return c;
  }
  const column = (name: string) => `drivers.${name}`;
  return {
    client: {},
    db: { select: vi.fn(() => chain('select')), update: vi.fn(() => chain('update')) },
    drivers: new Proxy({}, { get: (_t, key) => column(String(key)) }),
    users: new Proxy({}, { get: (_t, key) => `users.${String(key)}` }),
    driverAuditLog: { __table: 'driverAuditLog' },
    userAuditLog: { __table: 'userAuditLog' },
    mfaChallenges: {},
    writeAudit: vi.fn(async () => undefined),
    getCompanyName: vi.fn(async () => 'Acme Charging'),
    getMfaConfig: vi.fn(async () => state.mfa),
    readMfaConfig: vi.fn(async () => ({ config: state.mfa, fallback: false })),
  };
});

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  createMfaChallenge: vi.fn(async () => ({ challengeId: 9, code: '123456' })),
  createCappedMfaChallenge: vi.fn(async (c: unknown, o: unknown) =>
    (await import('@evtivity/lib')).createMfaChallenge(c as never, o as never),
  ),
  isMfaChallengeLimited: (r: object) => 'limited' in r,
  dispatchSystemNotification: vi.fn(async () => undefined),
  verifyMfaChallenge: vi.fn(async () => 'verified'),
}));
vi.mock('@evtivity/services/template-dirs', () => ({ ALL_TEMPLATES_DIRS: ['templates'] }));

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
  const own = (account: { userId?: string; driverId?: string }) =>
    state.creds.filter((c) =>
      account.driverId != null ? c.driverId === account.driverId : c.userId === account.userId,
    );
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
    countWebauthnCredentials: vi.fn(async (a: { driverId: string }) => own(a).length),
    countRecoveryCodes: vi.fn(async () => state.recoveryCodes),
    // A recovery code proof: 'good-code' is the one unused code of the driver.
    consumeRecoveryCode: vi.fn(async (_a: unknown, input: string) => {
      if (input !== 'good-code' || state.recoveryCodes === 0) {
        return { used: false, remaining: state.recoveryCodes };
      }
      state.recoveryCodes -= 1;
      return { used: true, remaining: state.recoveryCodes };
    }),
    mfaFactorCounts: vi.fn(async (a: { driverId: string }) => ({
      recoveryCodesRemaining: 0,
      passkeyCount: own(a).length,
    })),
    listWebauthnCredentials: vi.fn(async (a: { driverId: string }) => own(a).map(summary)),
    webauthnCredentialsForCeremony: vi.fn(async (a: { driverId: string }) => own(a)),
    findWebauthnCredential: vi.fn(
      async (id: string) => state.creds.find((c) => c.credentialId === id) ?? null,
    ),
    accountUserHandle: vi.fn(async (a: { driverId: string }) => own(a)[0]?.userHandle ?? null),
    registerWebauthnCredential: vi.fn(
      async (
        a: { driverId: string },
        input: Omit<Cred, 'id' | 'userId' | 'driverId' | 'createdAt' | 'lastUsedAt'>,
      ) => {
        if (state.creds.some((c) => c.credentialId === input.credentialId)) {
          return { status: 'duplicate' };
        }
        const before = own(a).length;
        const d = state.driver ?? {};
        const firstFactor = !(d['mfaEnabled'] === true && d['mfaMethod'] != null) && before === 0;
        const row: Cred = {
          ...input,
          id: state.nextId++,
          userId: null,
          driverId: a.driverId,
          createdAt: new Date(),
          lastUsedAt: null,
        };
        state.creds.push(row);
        return { status: 'registered', credential: summary(row), firstFactor };
      },
    ),
    renameWebauthnCredential: vi.fn(async (a: { driverId: string }, id: number, name: string) => {
      const row = own(a).find((c) => c.id === id);
      if (row == null) return null;
      row.name = name;
      return summary(row);
    }),
    removeWebauthnCredential: vi.fn(
      async (
        a: { driverId: string },
        id: number,
        opts: { lastFactorCheck: () => Promise<string | null> },
      ) => {
        const mine = own(a);
        if (!mine.some((c) => c.id === id)) return { status: 'not_found' };
        const d = state.driver ?? {};
        const lastFactor =
          !(d['mfaEnabled'] === true && d['mfaMethod'] != null) && mine.length === 1;
        if (lastFactor) {
          const reason = await opts.lastFactorCheck();
          if (reason != null) return { status: 'refused', reason };
        }
        state.creds = state.creds.filter((c) => !(c.driverId === a.driverId && c.id === id));
        return { status: 'removed', sessionVersion: null, lastFactor };
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

vi.mock('../lib/driver-mfa.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/driver-mfa.js')>()),
  authenticateDriverOrMfaEnrollment:
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
  isDriverMfaEnrollmentRequest: (request: { user: { mfaEnrollment?: unknown } }) =>
    request.user.mfaEnrollment === true,
  driverMfaPolicy: vi.fn(async () => 'not_required'),
}));

vi.mock('../lib/driver-session.js', () => ({
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
  isMobileClient: (request: { headers: Record<string, unknown> }) =>
    request.headers['x-client'] === 'mobile',
}));
vi.mock('../lib/driver-active.js', () => ({ announceDriverSessionChange: vi.fn() }));
vi.mock('../services/refresh-token.service.js', () => ({
  endDriverSessions: vi.fn(async () => undefined),
}));
vi.mock('../lib/operator-session.js', () => ({ passwordAuthBlocked: vi.fn(async () => false) }));
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
  signInLocks: vi.fn(async () => ({ loginLockedUntil: null, mfaLockedUntil: null })),
}));

import { portalWebauthnRoutes } from '../routes/portal/webauthn.js';
import { recordAuthAudit } from '../lib/auth-audit.js';
import {
  clearSignInFailures,
  recordAttemptFailure,
  takeSignInAttempt,
} from '../lib/sign-in-backoff.js';
import { driverMfaPolicy } from '../lib/driver-mfa.js';
import { issueDriverSession, issueDriverTokens } from '../lib/driver-session.js';
import { endDriverSessions } from '../services/refresh-token.service.js';
import { issueRecoveryCodes } from '../services/mfa-factor.service.js';
import { verifyPassword } from '../lib/password-verify.js';

function driverRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ME,
    email: 'jane@example.com',
    firstName: 'Jane',
    lastName: 'Doe',
    phone: null,
    language: 'en',
    timezone: 'UTC',
    themePreference: 'light',
    distanceUnit: 'km',
    priceDisplay: null,
    isActive: true,
    emailVerified: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    mfaEnabled: false,
    mfaMethod: null,
    mfaLockedUntil: null,
    sessionVersion: 0,
    passwordHash: '$argon2id$x',
    ...over,
  };
}

describe('Driver passkey routes', () => {
  let app: FastifyInstance;
  let session: { authorization: string };
  const keys: SoftAuthenticator[] = [];

  beforeAll(async () => {
    app = Fastify();
    await app.register(jwt, { secret: 'test-secret' });
    app.decorate('authenticateDriver', async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch {
        // fail-open: a bad token is the test case, answered as the real guard does
        await reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }
    });
    portalWebauthnRoutes(app);
    await app.ready();
    session = { authorization: `Bearer ${app.jwt.sign({ driverId: ME, type: 'driver' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    state.driver = driverRow();
    state.creds = [];
    state.nextId = 1;
    state.challenges.clear();
    state.mfa.webauthnEnabled = true;
    state.mfa.passkeyLoginEnabled = true;
    state.casWins = true;
    state.recoveryCodes = 0;
    keys.length = 0;
    vi.mocked(driverMfaPolicy).mockResolvedValue('not_required');
  });

  async function registrationOptions(headers = session) {
    const res = await app.inject({
      method: 'POST',
      url: '/portal/driver/webauthn/registration-options',
      headers,
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  async function register(authenticator: SoftAuthenticator, headers = session, origin = PORTAL) {
    const options = await registrationOptions(headers);
    const res = await app.inject({
      method: 'POST',
      url: '/portal/driver/webauthn/registration',
      headers,
      payload: {
        credential: authenticator.register(options, origin),
        ...(headers === session ? { proof: { kind: 'password', password: 'secret' } } : {}),
      },
    });
    if (res.statusCode === 200) keys.push(authenticator);
    return res;
  }

  /** A passkey proof of `key` to a factor_add challenge, as a removal takes. */
  async function passkeyProof(key: SoftAuthenticator) {
    const options = await app.inject({
      method: 'POST',
      url: '/portal/driver/mfa/factor-proof',
      headers: session,
      payload: { kind: 'passkey' },
    });
    expect(options.statusCode).toBe(200);
    return {
      kind: 'passkey',
      credential: key.authenticate(options.json().options, PORTAL, undefined),
    };
  }

  function mfaToken(payload: Record<string, unknown> = { driverId: ME, type: 'driver' }) {
    return app.jwt.sign({ sv: 0, ...payload, mfaPending: true } as never, { expiresIn: '3m' });
  }

  describe('registration', () => {
    it('registers at the portal relying party and turns MFA on as the first factor', async () => {
      const options = await registrationOptions();
      expect(options).toMatchObject({
        rp: { id: 'portal.example.com', name: 'Acme Charging' },
        user: { name: 'jane@example.com', displayName: 'Jane Doe' },
        attestation: 'none',
      });
      // The challenge belongs to the driver, never to an operator account.
      expect([...state.challenges.values()][0]).toMatchObject({
        purpose: 'registration',
        driverId: ME,
      });
      expect([...state.challenges.values()][0]).not.toHaveProperty('userId');

      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/webauthn/registration',
        headers: session,
        payload: {
          credential: new SoftAuthenticator().register(options, PORTAL),
          name: 'Phone',
          proof: { kind: 'password', password: 'secret' },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        credential: { name: 'Phone' },
        recoveryCodes: ['aaaaa-bbbbb'],
      });
      expect(state.creds[0]?.driverId).toBe(ME);
      expect(issueRecoveryCodes).toHaveBeenCalledWith(
        { driverId: ME },
        'generated',
        expect.anything(),
      );
      // A first factor ends every other session of the driver; this client gets new tokens.
      expect(endDriverSessions).toHaveBeenCalledWith(ME);
      expect(issueDriverTokens).toHaveBeenCalled();
    });

    it('ends no session for a passkey that is not the first factor', async () => {
      const first = new SoftAuthenticator();
      await register(first);
      vi.mocked(endDriverSessions).mockClear();
      // The driver now holds a passkey: it proves itself with it.
      const proofOptions = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/factor-proof',
        headers: session,
        payload: { kind: 'passkey' },
      });
      expect(proofOptions.statusCode).toBe(200);
      const options = await registrationOptions();
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/webauthn/registration',
        headers: session,
        payload: {
          credential: new SoftAuthenticator().register(options, PORTAL),
          proof: {
            kind: 'passkey',
            credential: first.authenticate(proofOptions.json().options, PORTAL, undefined),
          },
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().recoveryCodes).toBeUndefined();
      expect(endDriverSessions).not.toHaveBeenCalled();
    });

    it('needs the fresh proof with a session', async () => {
      const options = await registrationOptions();
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/webauthn/registration',
        headers: session,
        payload: { credential: new SoftAuthenticator().register(options, PORTAL) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR', proofKinds: ['password'] });
      vi.mocked(verifyPassword).mockResolvedValueOnce(false);
      const wrong = await app.inject({
        method: 'POST',
        url: '/portal/driver/webauthn/registration',
        headers: session,
        payload: {
          credential: new SoftAuthenticator().register(await registrationOptions(), PORTAL),
          proof: { kind: 'password', password: 'wrong' },
        },
      });
      expect(wrong.json().code).toBe('INVALID_PASSWORD');
      expect(recordAttemptFailure).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ account: { driverId: ME }, factor: 'password' }),
      );
      expect(state.creds).toHaveLength(0);
    });

    it('refuses a response made for the CSMS origin', async () => {
      const res = await register(new SoftAuthenticator(), session, CSMS);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('WEBAUTHN_VERIFICATION_FAILED');
      expect(state.creds).toHaveLength(0);
    });

    it('refuses an operator challenge, even one naming the same id', async () => {
      const options = await registrationOptions();
      const challenge = options.challenge as string;
      const stored = state.challenges.get(challenge) as Record<string, unknown>;
      state.challenges.set(challenge, {
        purpose: 'registration',
        userId: ME,
        userHandle: stored['userHandle'],
      });
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/webauthn/registration',
        headers: session,
        payload: {
          credential: new SoftAuthenticator().register(options, PORTAL),
          proof: { kind: 'password', password: 'secret' },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('WEBAUTHN_CHALLENGE_EXPIRED');
    });

    it('signs the driver in when a passkey is the enrolled factor of required MFA', async () => {
      const enrollment = {
        authorization: `Bearer ${app.jwt.sign({ driverId: ME, type: 'driver', mfaEnrollment: true, sv: 0 })}`,
      };
      const res = await register(new SoftAuthenticator(), enrollment);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        success: true,
        recoveryCodes: ['aaaaa-bbbbb'],
        credential: { name: 'Passkey' },
        driver: { id: ME },
      });
      expect(recordAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kind: 'driver', method: 'mfa_enrollment' }),
      );
      // The sign-in ends every other session of the driver, refresh tokens included.
      expect(endDriverSessions).toHaveBeenCalledWith(ME);

      // A second registration with the same token lost the compare-and-set.
      state.casWins = false;
      vi.mocked(endDriverSessions).mockClear();
      vi.mocked(issueDriverSession).mockClear();
      const lost = await register(new SoftAuthenticator(), enrollment);
      expect(lost.statusCode).toBe(401);
      expect(issueDriverSession).not.toHaveBeenCalled();
      expect(endDriverSessions).not.toHaveBeenCalled();
    });

    it('answers 403 while passkeys are switched off', async () => {
      state.mfa.webauthnEnabled = false;
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/webauthn/registration-options',
        headers: session,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('MFA_METHOD_DISABLED');
    });
  });

  describe('second factor', () => {
    it('completes the MFA step with a passkey of the driver', async () => {
      const key = new SoftAuthenticator();
      await register(key);
      const options = await app.inject({
        method: 'POST',
        url: '/portal/auth/webauthn/options',
        payload: { mfaToken: mfaToken() },
      });
      expect(options.statusCode).toBe(200);
      expect(options.json().rpId).toBe('portal.example.com');
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/webauthn/verify',
        payload: {
          mfaToken: mfaToken(),
          credential: key.authenticate(options.json(), PORTAL, undefined),
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().driver).toMatchObject({ id: ME });
      // A passkey neither reads nor counts the MFA lock of wrong codes.
      expect(takeSignInAttempt).not.toHaveBeenCalledWith(expect.anything(), 'mfa');
      expect(clearSignInFailures).not.toHaveBeenCalledWith({ driverId: ME }, 'mfa');
    });

    async function verifyWithPasskeysOff(headers: Record<string, string> = {}) {
      const key = new SoftAuthenticator();
      await register(key);
      const options = await app.inject({
        method: 'POST',
        url: '/portal/auth/webauthn/options',
        payload: { mfaToken: mfaToken() },
      });
      expect(options.statusCode).toBe(200);
      // An admin switches passkeys off while they are the driver's only factor.
      state.mfa.webauthnEnabled = false;
      vi.mocked(issueDriverSession).mockClear();
      return app.inject({
        method: 'POST',
        url: '/portal/auth/webauthn/verify',
        headers,
        payload: {
          mfaToken: mfaToken(),
          credential: key.authenticate(options.json(), PORTAL, undefined),
        },
      });
    }

    it('hands the portal the enrollment reply and no session when passkeys were the only factor and are switched off', async () => {
      const res = await verifyWithPasskeysOff();
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        mfaEnrollmentRequired: true,
        availableMethods: ['email', 'totp'],
        webauthnAvailable: false,
      });
      expect(body.driver).toBeUndefined();
      expect(issueDriverSession).not.toHaveBeenCalled();
      const payload = app.jwt.verify<Record<string, unknown>>(body.enrollmentToken as string);
      expect(payload).toMatchObject({ driverId: ME, type: 'driver', mfaEnrollment: true });
    });

    it('refuses the mobile app with the method_disabled message when passkeys were the only factor', async () => {
      const res = await verifyWithPasskeysOff({ 'x-client': 'mobile' });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('MFA_ENROLLMENT_REQUIRED');
      expect(res.json().error).toMatch(/^Your sign-in method was turned off/);
      expect(res.json().enrollmentToken).toBeUndefined();
      expect(issueDriverSession).not.toHaveBeenCalled();
      expect(recordAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'login_failed', reason: 'mfa_method_disabled' }),
      );
    });

    it('refuses an operator MFA token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/webauthn/options',
        payload: { mfaToken: mfaToken({ userId: 'usr_000000000001', roleId: 'rol_1' }) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_TOKEN_INVALID');
    });

    it('never verifies an operator credential for the driver', async () => {
      await register(new SoftAuthenticator());
      // A second authenticator whose credential is an operator's.
      const operatorKey = new SoftAuthenticator();
      await register(operatorKey);
      const cred = state.creds.find((c) => c.credentialId === operatorKey.credentialId);
      if (cred != null) {
        cred.driverId = null;
        cred.userId = 'usr_000000000001';
      }
      const options = await app.inject({
        method: 'POST',
        url: '/portal/auth/webauthn/options',
        payload: { mfaToken: mfaToken() },
      });
      vi.mocked(recordAttemptFailure).mockClear();
      vi.mocked(issueDriverSession).mockClear();
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/webauthn/verify',
        payload: {
          mfaToken: mfaToken(),
          credential: operatorKey.authenticate(options.json(), PORTAL, undefined),
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('WEBAUTHN_VERIFICATION_FAILED');
      expect(recordAttemptFailure).not.toHaveBeenCalled();
      expect(issueDriverSession).not.toHaveBeenCalled();
    });

    it('offers the passkey step while wrong codes locked the MFA step', async () => {
      const key = new SoftAuthenticator();
      await register(key);
      state.driver = driverRow({ mfaLockedUntil: new Date(Date.now() + 60_000) });
      const options = await app.inject({
        method: 'POST',
        url: '/portal/auth/webauthn/options',
        payload: { mfaToken: mfaToken() },
      });
      expect(options.statusCode).toBe(200);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/webauthn/verify',
        payload: {
          mfaToken: mfaToken(),
          credential: key.authenticate(options.json(), PORTAL, undefined),
        },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('passkey sign-in', () => {
    async function signIn(key: SoftAuthenticator) {
      const options = await app.inject({ method: 'POST', url: '/portal/auth/passkey/options' });
      expect(options.statusCode).toBe(200);
      const handle = state.creds.find((c) => c.credentialId === key.credentialId)?.userHandle;
      return app.inject({
        method: 'POST',
        url: '/portal/auth/passkey/verify',
        payload: { credential: key.authenticate(options.json(), PORTAL, handle) },
      });
    }

    it('signs a driver in with a passkey alone', async () => {
      const key = new SoftAuthenticator();
      await register(key);
      const res = await signIn(key);
      expect(res.statusCode).toBe(200);
      expect(res.json().driver).toMatchObject({ id: ME });
      expect(recordAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kind: 'driver', action: 'login_succeeded', method: 'passkey' }),
      );
    });

    it('answers 404 for an operator credential', async () => {
      const key = new SoftAuthenticator();
      await register(key);
      const cred = state.creds[0];
      if (cred != null) {
        cred.driverId = null;
        cred.userId = 'usr_000000000001';
      }
      const res = await signIn(key);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PASSKEY_NOT_FOUND');
    });

    it('refuses a challenge of the operator sign-in', async () => {
      const key = new SoftAuthenticator();
      await register(key);
      const options = await app.inject({ method: 'POST', url: '/portal/auth/passkey/options' });
      const challenge = options.json().challenge as string;
      state.challenges.set(challenge, { purpose: 'passkey_login', realm: 'operator' });
      const res = await app.inject({
        method: 'POST',
        url: '/portal/auth/passkey/verify',
        payload: {
          credential: key.authenticate(options.json(), PORTAL, state.creds[0]?.userHandle),
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('WEBAUTHN_CHALLENGE_EXPIRED');
    });

    it('refuses an inactive driver', async () => {
      const key = new SoftAuthenticator();
      await register(key);
      state.driver = driverRow({ isActive: false });
      const res = await signIn(key);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('ACCOUNT_DISABLED');
    });

    it('is closed while passkey sign-in is switched off', async () => {
      state.mfa.passkeyLoginEnabled = false;
      const res = await app.inject({ method: 'POST', url: '/portal/auth/passkey/options' });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('MFA_METHOD_DISABLED');
    });
  });

  describe('list, rename and remove', () => {
    it('lists, renames and removes a passkey that is not the last factor', async () => {
      state.driver = driverRow({ mfaEnabled: true, mfaMethod: 'totp' });
      // A TOTP driver proves its factor to add a passkey; the proof check itself is covered elsewhere.
      const options = await registrationOptions();
      state.driver = driverRow();
      await app.inject({
        method: 'POST',
        url: '/portal/driver/webauthn/registration',
        headers: session,
        payload: {
          credential: new SoftAuthenticator().register(options, PORTAL),
          proof: { kind: 'password', password: 'secret' },
        },
      });
      state.driver = driverRow({ mfaEnabled: true, mfaMethod: 'totp' });
      const list = await app.inject({
        method: 'GET',
        url: '/portal/driver/webauthn',
        headers: session,
      });
      expect(list.json()).toHaveLength(1);
      const id = list.json()[0].id as number;
      const renamed = await app.inject({
        method: 'PATCH',
        url: `/portal/driver/webauthn/${String(id)}`,
        headers: session,
        payload: { name: 'Work Key' },
      });
      expect(renamed.json().name).toBe('Work Key');
      // Any removal needs a fresh proof, not only the last factor's.
      const refused = await app.inject({
        method: 'DELETE',
        url: `/portal/driver/webauthn/${String(id)}`,
        headers: session,
        payload: {},
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
      // The password alone never removes a factor while the driver holds one.
      state.recoveryCodes = 1;
      const byPassword = await app.inject({
        method: 'DELETE',
        url: `/portal/driver/webauthn/${String(id)}`,
        headers: session,
        payload: { proof: { kind: 'password', password: 'secret' } },
      });
      expect(byPassword.statusCode).toBe(400);
      expect(byPassword.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        proofKinds: ['totp', 'passkey', 'recovery_code'],
      });
      expect(state.creds).toHaveLength(1);
      vi.mocked(issueDriverTokens).mockClear();
      const removed = await app.inject({
        method: 'DELETE',
        url: `/portal/driver/webauthn/${String(id)}`,
        headers: session,
        payload: { proof: { kind: 'recovery_code', recoveryCode: 'good-code' } },
      });
      expect(removed.statusCode).toBe(200);
      expect(issueDriverTokens).toHaveBeenCalled();
    });

    it('asks for a proof to remove the last factor, and keeps it while drivers must have MFA', async () => {
      const key = new SoftAuthenticator();
      await register(key);
      state.recoveryCodes = 10;
      const id = state.creds[0]?.id ?? 0;
      const missing = await app.inject({
        method: 'DELETE',
        url: `/portal/driver/webauthn/${String(id)}`,
        headers: session,
        payload: {},
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        proofKinds: ['passkey', 'recovery_code'],
      });
      const byPassword = await app.inject({
        method: 'DELETE',
        url: `/portal/driver/webauthn/${String(id)}`,
        headers: session,
        payload: { proof: { kind: 'password', password: 'secret' } },
      });
      expect(byPassword.statusCode).toBe(400);
      expect(byPassword.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        proofKinds: ['passkey', 'recovery_code'],
      });

      vi.mocked(driverMfaPolicy).mockResolvedValue('required');
      const required = await app.inject({
        method: 'DELETE',
        url: `/portal/driver/webauthn/${String(id)}`,
        headers: session,
        payload: { proof: await passkeyProof(key) },
      });
      expect(required.statusCode).toBe(409);
      expect(required.json().code).toBe('MFA_REQUIRED_BY_POLICY');

      vi.mocked(driverMfaPolicy).mockResolvedValue('unavailable');
      const unavailable = await app.inject({
        method: 'DELETE',
        url: `/portal/driver/webauthn/${String(id)}`,
        headers: session,
        payload: { proof: await passkeyProof(key) },
      });
      expect(unavailable.statusCode).toBe(503);

      vi.mocked(driverMfaPolicy).mockResolvedValue('not_required');
      const removed = await app.inject({
        method: 'DELETE',
        url: `/portal/driver/webauthn/${String(id)}`,
        headers: session,
        payload: { proof: { kind: 'recovery_code', recoveryCode: 'good-code' } },
      });
      expect(removed.statusCode).toBe(200);
      expect(state.creds).toHaveLength(0);
    });
  });

  describe('proof preparation', () => {
    it('gives a passkey challenge for the factor proof and for new recovery codes', async () => {
      await register(new SoftAuthenticator());
      const proof = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/factor-proof',
        headers: session,
        payload: { kind: 'passkey' },
      });
      expect(proof.statusCode).toBe(200);
      const challenge = proof.json().options.challenge as string;
      expect(state.challenges.get(challenge)).toEqual({ purpose: 'factor_add', driverId: ME });

      const regen = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/recovery-codes/webauthn-options',
        headers: session,
      });
      expect(regen.statusCode).toBe(200);
      expect(state.challenges.get(regen.json().challenge as string)).toEqual({
        purpose: 'recovery_regenerate',
        driverId: ME,
      });
    });

    it('answers MFA_NOT_CONFIGURED without a factor of that kind', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/factor-proof',
        headers: session,
        payload: { kind: 'code' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_NOT_CONFIGURED');
    });
  });
});
