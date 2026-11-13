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
import { createCappedMfaChallenge, dispatchSystemNotification } from '@evtivity/lib';
import { recordAuthAudit } from '../lib/auth-audit.js';
import { driverMfaPolicy } from '../lib/driver-mfa.js';
import { issueDriverSession } from '../lib/driver-session.js';

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
    uiTheme: 'default',
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

  const mfaOptions = (token: string) =>
    app.inject({
      method: 'POST',
      url: '/portal/auth/webauthn/options',
      payload: { mfaToken: token },
    });
  const mfaVerify = (token: string, credential: unknown) =>
    app.inject({
      method: 'POST',
      url: '/portal/auth/webauthn/verify',
      payload: { mfaToken: token, credential },
    });

  /** A registered key and a second-factor assertion for it. */
  async function secondFactor(): Promise<unknown> {
    const key = new SoftAuthenticator();
    expect((await register(key)).statusCode).toBe(200);
    const options = await mfaOptions(mfaToken());
    expect(options.statusCode).toBe(200);
    return key.authenticate(options.json(), PORTAL, undefined);
  }

  /** A registered key and a passkey sign-in assertion with its user handle. */
  async function passkeySignIn(): Promise<{ key: SoftAuthenticator; credential: unknown }> {
    const key = new SoftAuthenticator();
    expect((await register(key)).statusCode).toBe(200);
    const options = await app.inject({ method: 'POST', url: '/portal/auth/passkey/options' });
    expect(options.statusCode).toBe(200);
    const handle = state.creds.find((c) => c.credentialId === key.credentialId)?.userHandle;
    return { key, credential: key.authenticate(options.json(), PORTAL, handle) };
  }

  const passkeyVerify = (credential: unknown) =>
    app.inject({ method: 'POST', url: '/portal/auth/passkey/verify', payload: { credential } });

  describe('MFA pending token checks', () => {
    it('refuses a token that does not verify', async () => {
      const res = await mfaOptions('garbage');
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('MFA_TOKEN_EXPIRED');
    });

    it('answers MFA_NOT_CONFIGURED for a driver that is gone', async () => {
      state.driver = null;
      const res = await mfaOptions(mfaToken());
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_NOT_CONFIGURED');
    });

    it('refuses a token of an earlier session version', async () => {
      state.driver = driverRow({ sessionVersion: 3 });
      const res = await mfaOptions(mfaToken());
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('MFA_TOKEN_EXPIRED');
    });

    it('refuses an inactive driver and audits it', async () => {
      state.driver = driverRow({ isActive: false });
      const res = await mfaOptions(mfaToken());
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('ACCOUNT_DISABLED');
      expect(recordAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kind: 'driver', reason: 'inactive' }),
      );
    });

    it('refuses a bad token at the verify too', async () => {
      const credential = await secondFactor();
      const res = await mfaVerify('garbage', credential);
      expect(res.statusCode).toBe(401);
    });
  });

  describe('second factor branches', () => {
    it('answers MFA_NOT_CONFIGURED for options without a credential', async () => {
      const res = await mfaOptions(mfaToken());
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_NOT_CONFIGURED');
    });

    it('refuses options for switched-off passkeys while another factor exists', async () => {
      await register(new SoftAuthenticator());
      state.driver = driverRow({ mfaEnabled: true, mfaMethod: 'totp' });
      state.mfa.webauthnEnabled = false;
      const res = await mfaOptions(mfaToken());
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('MFA_METHOD_DISABLED');
    });

    it('answers MFA_NOT_CONFIGURED when the credential was removed before the verify', async () => {
      const credential = await secondFactor();
      state.creds = [];
      const res = await mfaVerify(mfaToken(), credential);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_NOT_CONFIGURED');
    });

    it('refuses switched-off passkeys at the verify while another factor exists, and audits', async () => {
      const credential = await secondFactor();
      state.driver = driverRow({ mfaEnabled: true, mfaMethod: 'totp' });
      state.mfa.webauthnEnabled = false;
      const res = await mfaVerify(mfaToken(), credential);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('MFA_METHOD_DISABLED');
      expect(recordAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'login_failed', reason: 'mfa_method_disabled' }),
      );
    });

    it('refuses an assertion whose challenge is gone', async () => {
      const credential = await secondFactor();
      state.challenges.clear();
      const res = await mfaVerify(mfaToken(), credential);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('WEBAUTHN_CHALLENGE_EXPIRED');
    });

    it('refuses an assertion that does not verify against the stored key, and audits', async () => {
      const credential = (await secondFactor()) as { response: { signature: string } };
      credential.response.signature = Buffer.from('bad signature').toString('base64url');
      vi.mocked(issueDriverSession).mockClear();
      const res = await mfaVerify(mfaToken(), credential);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('WEBAUTHN_VERIFICATION_FAILED');
      expect(recordAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ reason: 'webauthn_verification_failed' }),
      );
      expect(issueDriverSession).not.toHaveBeenCalled();
    });
  });

  describe('registration branches', () => {
    it('answers DRIVER_NOT_FOUND for registration options of a missing driver', async () => {
      state.driver = null;
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/webauthn/registration-options',
        headers: session,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('DRIVER_NOT_FOUND');
    });

    it('answers PASSKEY_LIMIT_REACHED for options at the limit', async () => {
      expect((await register(new SoftAuthenticator())).statusCode).toBe(200);
      const [stored] = state.creds;
      if (stored == null) throw new Error('no credential stored');
      // Two more stored credentials reach the limit of 3 the fake applies.
      state.creds.push(
        { ...stored, id: 2, credentialId: 'c2' },
        { ...stored, id: 3, credentialId: 'c3' },
      );
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/webauthn/registration-options',
        headers: session,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('PASSKEY_LIMIT_REACHED');
    });

    it('refuses a registration once passkeys are switched off', async () => {
      const options = await registrationOptions();
      state.mfa.webauthnEnabled = false;
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/webauthn/registration',
        headers: session,
        payload: {
          credential: new SoftAuthenticator().register(options, PORTAL),
          proof: { kind: 'password', password: 'secret' },
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('MFA_METHOD_DISABLED');
      expect(state.creds).toHaveLength(0);
    });

    it('refuses a name with no visible character', async () => {
      const options = await registrationOptions();
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/webauthn/registration',
        headers: session,
        payload: {
          credential: new SoftAuthenticator().register(options, PORTAL),
          name: '​',
          proof: { kind: 'password', password: 'secret' },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'The name must have 1 to 100 visible characters',
        code: 'VALIDATION_ERROR',
      });
    });

    it('refuses a credential id that is already registered', async () => {
      const first = new SoftAuthenticator();
      expect((await register(first)).statusCode).toBe(200);
      const options = await registrationOptions();
      const proof = await passkeyProof(first);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/webauthn/registration',
        headers: session,
        payload: {
          credential: new SoftAuthenticator({ credentialId: first.credentialId }).register(
            options,
            PORTAL,
          ),
          proof,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('WEBAUTHN_VERIFICATION_FAILED');
      expect(state.creds).toHaveLength(1);
    });
  });

  describe('rename, remove and proofs', () => {
    it('refuses an invisible name and an unknown credential on rename', async () => {
      const bad = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/webauthn/1',
        headers: session,
        payload: { name: '​' },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().code).toBe('VALIDATION_ERROR');
      const missing = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/webauthn/42',
        headers: session,
        payload: { name: 'Key' },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe('PASSKEY_NOT_FOUND');
    });

    it('answers PASSKEY_NOT_FOUND for a removal of a credential the driver does not hold', async () => {
      const key = new SoftAuthenticator();
      await register(key);
      state.driver = driverRow({ mfaEnabled: true, mfaMethod: 'totp' });
      const proof = await passkeyProof(key);
      const res = await app.inject({
        method: 'DELETE',
        url: '/portal/driver/webauthn/99',
        headers: session,
        payload: { proof },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PASSKEY_NOT_FOUND');
      expect(state.creds).toHaveLength(1);
    });

    it('answers MFA_NOT_CONFIGURED for passkey proofs without a passkey', async () => {
      const recovery = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/recovery-codes/webauthn-options',
        headers: session,
      });
      expect(recovery.statusCode).toBe(400);
      expect(recovery.json().code).toBe('MFA_NOT_CONFIGURED');
      const proof = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/factor-proof',
        headers: session,
        payload: { kind: 'passkey' },
      });
      expect(proof.statusCode).toBe(400);
      expect(proof.json().code).toBe('MFA_NOT_CONFIGURED');
    });

    it('sends a code proof to the email method of the driver', async () => {
      state.driver = driverRow({ mfaEnabled: true, mfaMethod: 'email' });
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/factor-proof',
        headers: session,
        payload: { kind: 'code' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ challengeId: 9 });
      expect(dispatchSystemNotification).toHaveBeenCalledWith(
        expect.anything(),
        'mfa.VerificationCode',
        expect.objectContaining({ email: 'jane@example.com' }),
        { code: '123456' },
        ['templates'],
      );
    });

    it('answers 429 when the code cap refuses the proof code', async () => {
      state.driver = driverRow({ mfaEnabled: true, mfaMethod: 'email' });
      vi.mocked(createCappedMfaChallenge).mockResolvedValueOnce({
        limited: true,
        retryAfterSeconds: 45,
        openChallengeId: null,
      } as never);
      const res = await app.inject({
        method: 'POST',
        url: '/portal/driver/mfa/factor-proof',
        headers: session,
        payload: { kind: 'code' },
      });
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ code: 'MFA_RESEND_LIMITED', retryAfterSeconds: 45 });
      expect(dispatchSystemNotification).not.toHaveBeenCalled();
    });
  });

  describe('passkey sign-in branches', () => {
    it('refuses the verify while passkey sign-in is switched off', async () => {
      const { credential } = await passkeySignIn();
      state.mfa.passkeyLoginEnabled = false;
      const res = await passkeyVerify(credential);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('MFA_METHOD_DISABLED');
    });

    it('refuses a user handle that does not match the stored one, and audits', async () => {
      const { credential } = await passkeySignIn();
      const cred = state.creds[0];
      if (cred != null) cred.userHandle = 'another-handle';
      const res = await passkeyVerify(credential);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('WEBAUTHN_VERIFICATION_FAILED');
      expect(recordAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ method: 'passkey', reason: 'webauthn_verification_failed' }),
      );
    });

    it('refuses a driver without portal access (no password) after the signature checks out', async () => {
      const { credential } = await passkeySignIn();
      state.driver = driverRow({ passwordHash: null });
      vi.mocked(issueDriverSession).mockClear();
      const res = await passkeyVerify(credential);
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('INVALID_CREDENTIALS');
      expect(recordAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ reason: 'no_portal_access' }),
      );
      expect(issueDriverSession).not.toHaveBeenCalled();
    });
  });
});
