// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, afterEach, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

// --- DB mock that records every query chain -------------------------------

interface ChainCall {
  method: string;
  args: unknown[];
}
interface DbOp {
  kind: 'select' | 'insert' | 'update' | 'delete';
  table: string | undefined;
  calls: ChainCall[];
}

interface MockState {
  results: unknown[][];
  index: number;
  ops: DbOp[];
  cfg: Record<string, unknown>;
  publish: null | ((channel: string, message: string) => Promise<void>);
}

const state = vi.hoisted(
  (): MockState => ({ results: [], index: 0, ops: [], cfg: {}, publish: null }),
);
// When true, readMfaConfig answers the code defaults with fallback set: the settings read failed.
const mfaRead = vi.hoisted(() => ({ fails: false }));

function setupDbResults(...results: unknown[][]): void {
  state.results = results;
  state.index = 0;
}

function tableName(arg: unknown): string | undefined {
  if (arg != null && typeof arg === 'object') {
    const name = (arg as Record<string, unknown>)['__table'];
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
}

function makeChain(kind: DbOp['kind'], firstArg: unknown): Record<string, unknown> {
  const op: DbOp = { kind, table: kind === 'select' ? undefined : tableName(firstArg), calls: [] };
  state.ops.push(op);
  const chain: Record<string, unknown> = {};
  const methods = [
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'values',
    'returning',
    'set',
    'onConflictDoUpdate',
    'onConflictDoNothing',
  ];
  for (const m of methods) {
    chain[m] = (...args: unknown[]) => {
      op.calls.push({ method: m, args });
      if (m === 'from') op.table = tableName(args[0]);
      return chain;
    };
  }
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const r = state.results[state.index] ?? [];
      state.index++;
      return Promise.resolve(r).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  return chain;
}

function opsFor(kind: DbOp['kind'], table: string): DbOp[] {
  return state.ops.filter((o) => o.kind === kind && o.table === table);
}

function argOf(op: DbOp | undefined, method: string): unknown {
  return op?.calls.find((c) => c.method === method)?.args[0];
}

// Security notices are fire-and-forget; their dispatch has its own test.
// The device cookie path is covered in 129-auth-attacks; here a browser without one.
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
vi.mock('../lib/security-notice.js', () => ({
  sendSecurityNotice: vi.fn(),
  notifySecurityChange: vi.fn(async () => null),
  factorFlags: (factor: string) => ({ factorPasskey: factor === 'passkey' }),
}));

// The fresh proof itself is covered in session-proof.test.ts and 129-auth-attacks.
vi.mock('../lib/session-proof.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/session-proof.js')>()),
  requireSessionProof: vi.fn(async () => true),
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
vi.mock('@evtivity/database', () => {
  const table = (name: string) =>
    new Proxy(
      { __table: name },
      {
        get: (_t, prop) => {
          if (prop === '__table') return name;
          if (typeof prop !== 'string' || prop === 'then') return undefined;
          return `${name}.${prop}`;
        },
      },
    );
  const db: Record<string, unknown> = {
    select: vi.fn((arg?: unknown) => makeChain('select', arg)),
    insert: vi.fn((arg: unknown) => makeChain('insert', arg)),
    update: vi.fn((arg: unknown) => makeChain('update', arg)),
    delete: vi.fn((arg: unknown) => makeChain('delete', arg)),
    execute: vi.fn(() => Promise.resolve([])),
  };
  // A transaction runs its callback on the same recording mock.
  db['transaction'] = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(db));
  return {
    readMfaConfig: async () => ({
      config: await (await import('@evtivity/database')).getMfaConfig(),
      fallback: mfaRead.fails,
    }),
    getSessionLifetimes: vi.fn(async () => ({
      ...(await import('@evtivity/lib/session-lifetimes')).DEFAULT_SESSION_LIFETIMES,
    })),
    db,
    client: vi.fn(() => Promise.resolve([])),
    users: table('users'),
    roles: table('roles'),
    sites: table('sites'),
    drivers: table('drivers'),
    refreshTokens: table('refreshTokens'),
    userTokens: table('userTokens'),
    userSiteAssignments: table('userSiteAssignments'),
    userPermissions: table('userPermissions'),
    userNotificationPreferences: table('userNotificationPreferences'),
    chatbotAiConfigs: table('chatbotAiConfigs'),
    userAuditLog: table('userAuditLog'),
    OCTT_API_KEY_NAME: 'octt',
    getRecaptchaConfig: vi.fn().mockResolvedValue(null),
    getMfaConfig: vi.fn().mockResolvedValue({
      emailEnabled: true,
      totpEnabled: true,
      smsEnabled: true,
      required: 'off',
      requiredRoles: [],
      webauthnEnabled: true,
      passkeyLoginEnabled: false,
      requireDrivers: false,
    }),
    getPasswordPolicy: vi.fn(),
    writeAudit: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ['eq', a, b]),
  and: vi.fn((...a: unknown[]) => ['and', ...a]),
  or: vi.fn((...a: unknown[]) => ['or', ...a]),
  isNull: vi.fn((a: unknown) => ['isNull', a]),
  ne: vi.fn((a: unknown, b: unknown) => ['ne', a, b]),
  ilike: vi.fn((a: unknown, b: unknown) => ['ilike', a, b]),
  inArray: vi.fn((a: unknown, b: unknown) => ['inArray', a, b]),
  desc: vi.fn((a: unknown) => ['desc', a]),
  sql: vi.fn(() => 'sql'),
  notExists: vi.fn((a: unknown) => ['notExists', a]),
  exists: vi.fn((a: unknown) => ['exists', a]),
  notInArray: vi.fn((a: unknown, b: unknown) => ['notInArray', a, b]),
}));

vi.mock('argon2', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$argon2id$hashed'),
    verify: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('@evtivity/lib', () => ({
  getNotificationSettings: vi.fn(),
  sendEmail: vi.fn(),
  wrapEmailHtml: vi.fn().mockReturnValue('<html>wrapped</html>'),
  renderTemplate: vi.fn(),
  dispatchSystemNotification: vi.fn().mockResolvedValue(undefined),
  decryptString: vi.fn(),
  encryptString: vi.fn((plain: string) => `enc(${plain})`),
  generateTotpSecret: vi.fn().mockReturnValue('JBSWY3DPEHPK3PXP'),
  generateTotpUri: vi.fn().mockReturnValue('otpauth://totp/EVtivity:op@example.com'),
  verifyTotpCode: vi.fn(),
  matchTotpStep: vi.fn(),
  createMfaChallenge: vi.fn(),
  createCappedMfaChallenge: vi.fn(async (c: unknown, o: unknown) =>
    (await import('@evtivity/lib')).createMfaChallenge(c as never, o as never),
  ),
  isMfaChallengeLimited: (r: object) => 'limited' in r,
  verifyMfaChallenge: vi.fn(),
  verifyRecaptcha: vi.fn().mockResolvedValue({ success: true }),
  redactSensitiveNotificationContent: vi.fn((s: string) => `redacted(${s})`),
  recordNotificationAttempt: vi.fn().mockResolvedValue(undefined),
  isSubsetOf: (subset: string[], superset: string[]): boolean =>
    subset.every((p) => superset.includes(p)),
  AI_EFFORTS: ['low', 'medium', 'high'],
  AI_PROVIDER_IDS: ['anthropic', 'openai', 'gemini', 'deepseek'],
  isAiEffort: (v: unknown): boolean => v === 'low' || v === 'medium' || v === 'high',
  permissionCatalog: {
    defaultsFor: (role: string | undefined): string[] =>
      role === 'admin'
        ? ['users:read', 'users:write', 'stations:read']
        : role === 'viewer'
          ? ['stations:read']
          : ['stations:read', 'stations:write'],
    isKnown: (p: string): boolean =>
      ['users:read', 'users:write', 'stations:read', 'stations:write'].includes(p),
    groups: () => [
      {
        resource: 'users',
        kind: 'page',
        labelKey: 'users.permissionGroups.users',
        permissions: ['users:read', 'users:write'],
      },
      {
        resource: 'settings.system',
        kind: 'settings',
        labelKey: 'users.permissionGroups.settings.system',
        permissions: ['settings.system:read', 'settings.system:write'],
      },
    ],
  },
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({
    publish: (channel: string, message: string) =>
      state.publish != null ? state.publish(channel, message) : Promise.resolve(),
  }),
}));

vi.mock('../services/refresh-token.service.js', () => ({
  createRefreshToken: vi.fn(),
  validateAndRotateRefreshToken: vi.fn(),
  revokeRefreshToken: vi.fn().mockResolvedValue(undefined),
  revokeAllUserRefreshTokens: vi.fn().mockResolvedValue(undefined),
  revokeAllUserSessions: vi.fn().mockResolvedValue(undefined),
  sessionRefreshTokenUserId: vi.fn().mockResolvedValue(null),
}));

const ALL_MOCK_PERMISSIONS = ['users:read', 'users:write', 'stations:read', 'stations:write'];
const actorPermissions = vi.hoisted(() => ({
  value: ['users:read', 'users:write', 'stations:read', 'stations:write'],
}));

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (n: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }
    },
  selfService:
    (opts?: { allowApiKey?: boolean }) =>
    async (
      request: { jwtVerify: () => Promise<void>; user?: { isApiKey?: boolean } },
      reply: { status: (n: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
        return;
      }
      if (request.user?.isApiKey === true && opts?.allowApiKey !== true) {
        await reply.status(403).send({ error: 'Session required', code: 'SESSION_REQUIRED' });
      }
    },
  invalidatePermissionCache: vi.fn(),
  // The acting user's permissions: every actor grants only what it holds.
  // All-site tests act with every permission of the mocked catalog; the
  // site-restricted actor holds less (set in its describe block).
  getEffectivePermissions: vi.fn(() => Promise.resolve(actorPermissions.value)),
}));

vi.mock('../lib/operator-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/operator-session.js')>();
  return {
    ...actual,
    passwordAuthBlocked: vi.fn().mockResolvedValue(false),
    ssoManagedUser: vi.fn().mockResolvedValue(false),
    bumpSessionVersion: vi.fn().mockResolvedValue(1),
    endUserSessions: vi.fn().mockResolvedValue(1),
    announceSessionChange: vi.fn(),
  };
});

vi.mock('../lib/phone-change.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/phone-change.js')>()),
  checkPhoneChange: vi.fn(async () => null),
}));
vi.mock('../lib/sign-in-backoff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/sign-in-backoff.js')>();
  return {
    ...actual,
    takeSignInAttempt: vi.fn(async (account: unknown, factor: unknown) => ({
      granted: true,
      account,
      factor,
      failures: 1,
      lockedUntil: null,
    })),
    recordAttemptFailure: vi.fn(async () => null),
    clearSignInFailures: vi.fn().mockResolvedValue(undefined),
    acceptTotpStep: vi.fn().mockResolvedValue(true),
  };
});

vi.mock('../services/user-status.service.js', () => ({
  USER_EMAIL_LINK_TYPES: ['password_reset'],
  applyUserDeactivation: vi.fn().mockResolvedValue(undefined),
  revokeUserEmailLinks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/user-avatar.service.js', () => ({
  userAvatarColumns: {},
  purgeUserAvatarOnDelete: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/password-changed-notice.js', () => ({
  sendPasswordChangedNotice: vi.fn(),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
  assertSitesWithinScope: vi.fn().mockResolvedValue(true),
}));

vi.mock('../lib/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/config.js')>();
  Object.assign(state.cfg, actual.config, {
    SETTINGS_ENCRYPTION_KEY: 'test-encryption-key',
    CSMS_URL: 'https://csms.example.com',
  });
  return { ...actual, config: state.cfg };
});
// The proof checks are covered in mfa-factor-proof.test.ts; here only the routes' use of them.
vi.mock('../lib/mfa-factor-proof.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/mfa-factor-proof.js')>()),
  checkFactorProof: vi.fn(async () => null),
  factorProofKinds: vi.fn(async () => []),
  proofAccountOf: vi.fn(async () => null),
}));
// The ceremony itself is covered in webauthn-routes.test.ts; here only its outcome matters.
vi.mock('../lib/webauthn-http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/webauthn-http.js')>()),
  verifyRecoveryCodesPasskey: vi.fn(async () => 'failed'),
}));

// The pending SSO bind lives in Redis; here only that the routes void it.
vi.mock('../lib/sso-link.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/sso-link.js')>()),
  voidPendingSsoLink: vi.fn(async () => undefined),
}));
vi.mock('../lib/user-active.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/user-active.js')>()),
  invalidateUserActiveCache: vi.fn(),
}));

import argon2 from 'argon2';
import { voidPendingSsoLink } from '../lib/sso-link.js';
import { invalidateUserActiveCache } from '../lib/user-active.js';
import { requireSessionProof } from '../lib/session-proof.js';
import { sendSecurityNotice } from '../lib/security-notice.js';
import { checkFactorProof } from '../lib/mfa-factor-proof.js';
import {
  consumeRecoveryCode,
  countRecoveryCodes,
  issueRecoveryCodes,
} from '../services/mfa-factor.service.js';
import {
  client,
  getMfaConfig,
  getPasswordPolicy,
  getRecaptchaConfig,
  writeAudit,
} from '@evtivity/database';
import { DEFAULT_PASSWORD_POLICY } from '@evtivity/lib/password-policy';
import {
  getNotificationSettings,
  sendEmail,
  renderTemplate,
  dispatchSystemNotification,
  decryptString,
  verifyTotpCode,
  matchTotpStep,
  createMfaChallenge,
  createCappedMfaChallenge,
  verifyMfaChallenge,
} from '@evtivity/lib';
import { acceptTotpStep, takeSignInAttempt } from '../lib/sign-in-backoff.js';
import {
  announceSessionChange,
  bumpSessionVersion,
  endUserSessions,
  ssoManagedUser,
} from '../lib/operator-session.js';
import { applyUserDeactivation, revokeUserEmailLinks } from '../services/user-status.service.js';
import {
  createRefreshToken,
  validateAndRotateRefreshToken,
  sessionRefreshTokenUserId,
} from '../services/refresh-token.service.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { registerAuth } from '../plugins/auth.js';
import { userRoutes } from '../routes/users.js';

// postgres.js Sql type is too deep for vi.mocked(); treat the tag function as a plain mock.
const clientMock = client as unknown as Mock;

const ME = 'usr_000000000001';
const OTHER = 'usr_000000000002';
const ROLE = 'rol_000000000001';

function userRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: OTHER,
    email: 'op@example.com',
    firstName: 'Op',
    lastName: 'Erator',
    phone: '+12015550111',
    roleId: ROLE,
    isActive: true,
    mustResetPassword: false,
    hasAllSiteAccess: false,
    language: 'de',
    timezone: 'UTC',
    themePreference: 'light',
    uiTheme: 'default',
    lastLoginAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function fullUser(over: Record<string, unknown> = {}): Record<string, unknown> {
  return userRow({
    passwordHash: '$argon2id$stored',
    mfaEnabled: false,
    mfaMethod: null,
    totpSecretEnc: null,
    sessionVersion: 0,
    authSource: 'password',
    loginLockedUntil: null,
    mfaLockedUntil: null,
    ...over,
  });
}

function auditCall(index = 0): Record<string, unknown> {
  const call = vi.mocked(writeAudit).mock.calls[index];
  if (call == null) throw new Error(`writeAudit call ${String(index)} missing`);
  return call[1] as unknown as Record<string, unknown>;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie, { secret: 'test-cookie-secret-12345' });
  await registerAuth(app);
  userRoutes(app);
  await app.ready();
  return app;
}

describe('User routes (extended coverage)', () => {
  let app: FastifyInstance;
  let token: string;
  let auth: { authorization: string };
  const published: Array<{ channel: string; message: string }> = [];

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: ME, roleId: ROLE });
    auth = { authorization: `Bearer ${token}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    state.ops = [];
    published.length = 0;
    state.publish = (channel, message) => {
      published.push({ channel, message });
      return Promise.resolve();
    };
    state.cfg['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key';
    vi.mocked(argon2.verify).mockReset().mockResolvedValue(true);
    vi.mocked(countRecoveryCodes).mockReset().mockResolvedValue(0);
    vi.mocked(consumeRecoveryCode).mockReset().mockResolvedValue({ used: false, remaining: 0 });
    vi.mocked(issueRecoveryCodes).mockReset().mockResolvedValue(['abcde-fghjk']);
    vi.mocked(getRecaptchaConfig).mockReset().mockResolvedValue(null);
    vi.mocked(getPasswordPolicy)
      .mockReset()
      .mockResolvedValue({ ...DEFAULT_PASSWORD_POLICY });
    vi.mocked(getMfaConfig)
      .mockReset()
      .mockResolvedValue({
        emailEnabled: true,
        totpEnabled: true,
        smsEnabled: true,
        required: 'off' as const,
        requiredRoles: [] as string[],
        webauthnEnabled: true,
        passkeyLoginEnabled: false,
        requireDrivers: false,
      });
    vi.mocked(decryptString)
      .mockReset()
      .mockImplementation((v: string) => `dec(${v})`);
    vi.mocked(verifyTotpCode).mockReset().mockReturnValue(true);
    vi.mocked(verifyMfaChallenge).mockReset().mockResolvedValue('verified');
    vi.mocked(createMfaChallenge)
      .mockReset()
      .mockResolvedValue({ challengeId: 42, code: '654321' });
    vi.mocked(matchTotpStep).mockReset().mockReturnValue(1);
    vi.mocked(createRefreshToken)
      .mockReset()
      .mockResolvedValue({ rawToken: 'new-refresh', expiresAt: new Date() });
    vi.mocked(validateAndRotateRefreshToken).mockReset().mockResolvedValue(null);
    vi.mocked(sessionRefreshTokenUserId).mockReset().mockResolvedValue(null);
    mfaRead.fails = false;
    vi.mocked(getNotificationSettings)
      .mockReset()
      .mockResolvedValue({
        smtp: { host: 'smtp.test', port: 587, username: 'u', password: 'p', from: 'f@x.com' },
        twilio: null,
        emailWrapperTemplate: null,
      });
    vi.mocked(sendEmail).mockReset().mockResolvedValue(true);
    vi.mocked(renderTemplate)
      .mockReset()
      .mockResolvedValue({ subject: 'Reset', body: 'Body text', html: '<p>Reset</p>' });
    clientMock.mockReset().mockResolvedValue([] as never);
  });

  afterEach(() => {
    state.publish = null;
  });

  // ---------------------------------------------------------------- login

  /** The fresh proof refused: the real check answers 400 itself and returns false. */
  function refuseProofOnce(): void {
    vi.mocked(requireSessionProof).mockImplementationOnce(async (_request, reply) => {
      await reply
        .status(400)
        .send({ error: 'Proof required', code: 'VALIDATION_ERROR', proofKinds: ['password'] });
      return false;
    });
  }

  describe('DELETE /users/:id/sso-link', () => {
    it('clears a binding, voids the pending bind, ends the sessions and audits sso_unlinked', async () => {
      setupDbResults([], [{ ssoSubject: 'idp|sub-1', ssoLinkAllowed: true }]);
      const res = await app.inject({
        method: 'DELETE',
        url: `/users/${OTHER}/sso-link`,
        headers: auth,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(argOf(opsFor('update', 'users')[0], 'set')).toEqual({
        ssoSubject: null,
        ssoLinkAllowed: false,
        updatedAt: expect.any(Date),
      });
      expect(voidPendingSsoLink).toHaveBeenCalledWith(OTHER, expect.anything());
      expect(endUserSessions).toHaveBeenCalledWith(OTHER, { apiKeys: false });
      expect(auditCall()).toMatchObject({
        entityId: OTHER,
        action: 'sso_unlinked',
        before: { ssoLinked: true, ssoLinkAllowed: true },
        after: { ssoLinked: false, ssoLinkAllowed: false },
      });
      expect(sendSecurityNotice).toHaveBeenCalledWith(
        { userId: OTHER },
        'security.SsoUnlinked',
        {},
        expect.anything(),
      );
    });

    it('ends the sessions without an audit row or notice when nothing was bound', async () => {
      setupDbResults([], [{ ssoSubject: null, ssoLinkAllowed: false }]);
      const res = await app.inject({
        method: 'DELETE',
        url: `/users/${OTHER}/sso-link`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(endUserSessions).toHaveBeenCalledWith(OTHER, { apiKeys: false });
      expect(writeAudit).not.toHaveBeenCalled();
      expect(sendSecurityNotice).not.toHaveBeenCalled();
    });

    it('answers 404 for a user that is gone after the scope check', async () => {
      setupDbResults([], []);
      const res = await app.inject({
        method: 'DELETE',
        url: `/users/${OTHER}/sso-link`,
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('USER_NOT_FOUND');
      expect(opsFor('update', 'users')).toHaveLength(0);
    });

    it('answers 404 to a site-restricted actor for an all-site user', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValueOnce(['site-a']);
      setupDbResults([{ hasAllSiteAccess: true }]);
      const res = await app.inject({
        method: 'DELETE',
        url: `/users/${OTHER}/sso-link`,
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('USER_NOT_FOUND');
      expect(endUserSessions).not.toHaveBeenCalled();
    });

    it('changes nothing when the fresh proof is refused', async () => {
      refuseProofOnce();
      setupDbResults([]);
      const res = await app.inject({
        method: 'DELETE',
        url: `/users/${OTHER}/sso-link`,
        headers: auth,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(opsFor('update', 'users')).toHaveLength(0);
      expect(voidPendingSsoLink).not.toHaveBeenCalled();
    });
  });

  describe('POST /users/me/sso-link', () => {
    it('allows the link after the proof and audits sso_link_allowed once', async () => {
      setupDbResults([{ id: ME }]);
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/sso-link',
        headers: auth,
        payload: { proof: { kind: 'password', password: 'secret' } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(checkFactorProof).toHaveBeenCalledWith(
        expect.anything(),
        { userId: ME },
        { kind: 'password', password: 'secret' },
        'confirm',
      );
      expect(argOf(opsFor('update', 'users')[0], 'set')).toEqual({
        ssoLinkAllowed: true,
        updatedAt: expect.any(Date),
      });
      expect(auditCall()).toMatchObject({
        entityId: ME,
        action: 'sso_link_allowed',
        before: { ssoLinkAllowed: false },
        after: { ssoLinkAllowed: true },
      });
    });

    it('writes no audit row when the link was already allowed', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/sso-link',
        headers: auth,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('answers the proof refusal and writes nothing', async () => {
      vi.mocked(checkFactorProof).mockResolvedValueOnce({
        status: 400,
        body: { error: 'Wrong password', code: 'INVALID_PASSWORD' },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/sso-link',
        headers: auth,
        payload: { proof: { kind: 'password', password: 'wrong' } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_PASSWORD');
      expect(opsFor('update', 'users')).toHaveLength(0);
    });
  });

  describe('POST /users/me/phone-verification', () => {
    const smsUser = {
      firstName: 'Op',
      language: 'en',
      phone: '+12015550111',
      mfaEnabled: true,
      mfaMethod: 'sms',
    };

    it('texts a code bound to the new number after the proof', async () => {
      setupDbResults([smsUser]);
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/phone-verification',
        headers: auth,
        payload: { phone: '+1 201 555 0199', proof: { kind: 'password', password: 'secret' } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ challengeId: 42 });
      expect(createCappedMfaChallenge).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          userId: ME,
          purpose: 'setup',
          destination: '+12015550199',
        }),
        expect.anything(),
      );
      expect(dispatchSystemNotification).toHaveBeenCalledWith(
        expect.anything(),
        'mfa.VerificationCode',
        { phone: '+12015550199', language: 'en', firstName: 'Op' },
        { code: '654321' },
        expect.any(String),
      );
    });

    it('leaves out the first name when the account has none', async () => {
      setupDbResults([{ ...smsUser, firstName: null }]);
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/phone-verification',
        headers: auth,
        payload: { phone: '+12015550199' },
      });
      expect(res.statusCode).toBe(200);
      expect(vi.mocked(dispatchSystemNotification).mock.calls[0]?.[2]).toEqual({
        phone: '+12015550199',
        language: 'en',
      });
    });

    it('refuses a number that does not parse before any read', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/phone-verification',
        headers: auth,
        payload: { phone: 'not a number' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(state.ops).toHaveLength(0);
    });

    it('answers 404 for a missing account', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/phone-verification',
        headers: auth,
        payload: { phone: '+12015550199' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('USER_NOT_FOUND');
    });

    it('refuses an account without SMS codes and the current number before the proof', async () => {
      setupDbResults([{ ...smsUser, mfaMethod: 'totp' }], [smsUser]);
      const totp = await app.inject({
        method: 'POST',
        url: '/users/me/phone-verification',
        headers: auth,
        payload: { phone: '+12015550199' },
      });
      expect(totp.statusCode).toBe(400);
      expect(totp.json().code).toBe('VALIDATION_ERROR');
      const same = await app.inject({
        method: 'POST',
        url: '/users/me/phone-verification',
        headers: auth,
        payload: { phone: '+12015550111' },
      });
      expect(same.statusCode).toBe(400);
      expect(same.json().error).toBe('This is already your number');
      expect(checkFactorProof).not.toHaveBeenCalled();
      expect(createCappedMfaChallenge).not.toHaveBeenCalled();
    });

    it('answers the proof refusal without a code', async () => {
      vi.mocked(checkFactorProof).mockResolvedValueOnce({
        status: 400,
        body: { error: 'Proof required', code: 'VALIDATION_ERROR', proofKinds: ['password'] },
      });
      setupDbResults([smsUser]);
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/phone-verification',
        headers: auth,
        payload: { phone: '+12015550199' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().proofKinds).toEqual(['password']);
      expect(createCappedMfaChallenge).not.toHaveBeenCalled();
    });

    it('answers 429 with Retry-After past the code cap', async () => {
      vi.mocked(createMfaChallenge).mockResolvedValueOnce({
        limited: true,
        retryAfterSeconds: 120,
      } as never);
      setupDbResults([smsUser]);
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/phone-verification',
        headers: auth,
        payload: { phone: '+12015550199' },
      });
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ code: 'MFA_RESEND_LIMITED', retryAfterSeconds: 120 });
      expect(res.headers['retry-after']).toBe('120');
      expect(dispatchSystemNotification).not.toHaveBeenCalled();
    });
  });

  describe('POST /users refusals', () => {
    it('refuses unknown permissions', async () => {
      setupDbResults([], [{ id: ROLE, name: 'operator' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: auth,
        payload: { email: 'new@example.com', roleId: ROLE, permissions: ['bogus:perm'] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: 'INVALID_PERMISSIONS',
        error: 'Invalid permissions: bogus:perm',
      });
      expect(opsFor('insert', 'users')).toHaveLength(0);
    });

    it('refuses permissions the actor does not hold', async () => {
      actorPermissions.value = ['stations:read'];
      try {
        setupDbResults([], [{ id: ROLE, name: 'operator' }]);
        const res = await app.inject({
          method: 'POST',
          url: '/users',
          headers: auth,
          payload: { email: 'new@example.com', roleId: ROLE, permissions: ['users:write'] },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('PERMISSIONS_EXCEED_OWN');
        expect(opsFor('insert', 'users')).toHaveLength(0);
      } finally {
        actorPermissions.value = [...ALL_MOCK_PERMISSIONS];
      }
    });

    it('refuses a phone that does not parse', async () => {
      setupDbResults([], [{ id: ROLE, name: 'operator' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: auth,
        payload: { email: 'new@example.com', roleId: ROLE, phone: 'abc' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(opsFor('insert', 'users')).toHaveLength(0);
    });

    it('creates no admin-equivalent user when the fresh proof is refused', async () => {
      refuseProofOnce();
      setupDbResults([], [{ id: ROLE, name: 'admin' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: auth,
        payload: { email: 'new@example.com', roleId: ROLE, permissions: ['users:write'] },
      });
      expect(res.statusCode).toBe(400);
      expect(opsFor('insert', 'users')).toHaveLength(0);
    });
  });

  describe('PATCH /users/:id account changes', () => {
    it('takes the proof to allow the SSO link and audits sso_link_allowed', async () => {
      setupDbResults(
        [userRow({ ssoLinkAllowed: false })],
        [],
        [userRow({ ssoLinkAllowed: true })],
        [],
        [],
      );
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${OTHER}`,
        headers: auth,
        payload: { ssoLinkAllowed: true },
      });
      expect(res.statusCode).toBe(200);
      expect(requireSessionProof).toHaveBeenCalledTimes(1);
      expect(argOf(opsFor('update', 'users')[0], 'set')).toEqual({
        updatedAt: expect.any(Date),
        ssoLinkAllowed: true,
      });
      expect(auditCall()).toMatchObject({ entityId: OTHER, action: 'sso_link_allowed' });
    });

    it('writes nothing when the SSO link proof is refused', async () => {
      refuseProofOnce();
      setupDbResults([userRow({ ssoLinkAllowed: false })], []);
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${OTHER}`,
        headers: auth,
        payload: { ssoLinkAllowed: true },
      });
      expect(res.statusCode).toBe(400);
      expect(opsFor('update', 'users')).toHaveLength(0);
    });

    it('voids the pending bind and ends the token versions when the link is withdrawn', async () => {
      setupDbResults([userRow({ ssoLinkAllowed: true })], [], [userRow()], [], []);
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${OTHER}`,
        headers: auth,
        payload: { ssoLinkAllowed: false },
      });
      expect(res.statusCode).toBe(200);
      expect(voidPendingSsoLink).toHaveBeenCalledWith(OTHER, expect.anything());
      expect(bumpSessionVersion).toHaveBeenCalledWith(OTHER);
      expect(announceSessionChange).toHaveBeenCalledWith(OTHER);
      expect(requireSessionProof).not.toHaveBeenCalled();
      expect(auditCall()).toMatchObject({ action: 'sso_link_allowed' });
    });

    it('answers 404 when the row is gone at the update', async () => {
      setupDbResults([userRow()], []);
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${OTHER}`,
        headers: auth,
        payload: { firstName: 'Renamed' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('USER_NOT_FOUND');
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('tells the user at the previous number when an admin changes the phone', async () => {
      setupDbResults(
        [userRow({ phone: '+12015550111' })],
        [],
        [],
        [userRow({ phone: '+12015550199' })],
        [],
        [],
      );
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${OTHER}`,
        headers: auth,
        payload: { phone: '+12015550199' },
      });
      expect(res.statusCode).toBe(200);
      expect(argOf(opsFor('update', 'users')[0], 'set')).toMatchObject({
        phone: '+12015550199',
      });
      expect(sendSecurityNotice).toHaveBeenCalledWith(
        { userId: OTHER },
        'security.PhoneChanged',
        { byAdmin: true, phoneRemoved: false },
        expect.anything(),
        { phone: '+12015550111' },
      );
    });

    it('refuses a phone that does not parse', async () => {
      setupDbResults([userRow()], []);
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${OTHER}`,
        headers: auth,
        payload: { phone: 'abc' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(opsFor('update', 'users')).toHaveLength(0);
    });

    it('revokes the emailed links and tells the old address on an email change', async () => {
      setupDbResults(
        [userRow({ email: 'old@example.com' })],
        [],
        [],
        [],
        [userRow({ email: 'new@example.com' })],
        [],
        [],
      );
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${OTHER}`,
        headers: auth,
        payload: { email: 'new@example.com' },
      });
      expect(res.statusCode).toBe(200);
      expect(revokeUserEmailLinks).toHaveBeenCalledWith(OTHER, expect.anything());
      expect(sendSecurityNotice).toHaveBeenCalledWith(
        { userId: OTHER },
        'security.EmailChanged',
        {},
        expect.anything(),
        { email: 'old@example.com' },
      );
    });

    it('drops the active cache of a reactivated user', async () => {
      setupDbResults([userRow({ isActive: false })], [], [], [userRow()], [], []);
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${OTHER}`,
        headers: auth,
        payload: { isActive: true },
      });
      expect(res.statusCode).toBe(200);
      expect(invalidateUserActiveCache).toHaveBeenCalledWith(OTHER);
      expect(applyUserDeactivation).not.toHaveBeenCalled();
    });
  });

  describe('admin account routes with a refused proof', () => {
    it('keeps the password when the reset proof is refused', async () => {
      refuseProofOnce();
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: `/users/${OTHER}/reset-password`,
        headers: auth,
        payload: { password: 'Str0ng!Passw0rd#1' },
      });
      expect(res.statusCode).toBe(400);
      expect(argon2.hash).not.toHaveBeenCalled();
      expect(opsFor('update', 'users')).toHaveLength(0);
    });

    it('keeps the MFA of the user when the reset proof is refused', async () => {
      refuseProofOnce();
      setupDbResults([{ id: OTHER, mfaEnabled: true, mfaMethod: 'totp' }], []);
      const res = await app.inject({
        method: 'POST',
        url: `/users/${OTHER}/mfa/reset`,
        headers: auth,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(opsFor('update', 'users')).toHaveLength(0);
      expect(endUserSessions).not.toHaveBeenCalled();
    });

    it('grants no permission when the proof is refused', async () => {
      refuseProofOnce();
      setupDbResults([{ id: OTHER }], [], []);
      const res = await app.inject({
        method: 'PUT',
        url: `/users/${OTHER}/permissions`,
        headers: auth,
        payload: { permissions: ['stations:write'] },
      });
      expect(res.statusCode).toBe(400);
      expect(opsFor('delete', 'userPermissions')).toHaveLength(0);
      expect(opsFor('insert', 'userPermissions')).toHaveLength(0);
    });
  });

  describe('POST /users/:id/resend-invite', () => {
    const invitee = {
      id: OTHER,
      email: 'op@example.com',
      phone: null,
      firstName: 'Op',
      lastName: 'Erator',
      isActive: true,
      language: 'en',
    };

    it('refuses the own account', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/users/${ME}/resend-invite`,
        headers: auth,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('SELF_EDIT_FORBIDDEN');
      expect(state.ops).toHaveLength(0);
    });

    it('answers 409 USER_SSO_MANAGED for an SSO account', async () => {
      vi.mocked(ssoManagedUser).mockResolvedValueOnce(true);
      setupDbResults([invitee], []);
      const res = await app.inject({
        method: 'POST',
        url: `/users/${OTHER}/resend-invite`,
        headers: auth,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('USER_SSO_MANAGED');
      expect(revokeUserEmailLinks).not.toHaveBeenCalled();
    });

    it('sends nothing when the proof is refused', async () => {
      refuseProofOnce();
      setupDbResults([invitee], []);
      const res = await app.inject({
        method: 'POST',
        url: `/users/${OTHER}/resend-invite`,
        headers: auth,
      });
      expect(res.statusCode).toBe(400);
      expect(revokeUserEmailLinks).not.toHaveBeenCalled();
      expect(opsFor('insert', 'userTokens')).toHaveLength(0);
    });
  });

  describe('MFA token and code edges', () => {
    const totpUser = {
      mfaEnabled: true,
      mfaMethod: 'totp',
      totpSecretEnc: 'enc',
      email: 'op@example.com',
      phone: null,
      firstName: 'Op',
      language: 'en',
    };

    it('answers MFA_TOKEN_EXPIRED on resend for a token of an earlier session version', async () => {
      setupDbResults([
        fullUser({ id: OTHER, sessionVersion: 3, mfaEnabled: true, mfaMethod: 'email' }),
      ]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/resend',
        payload: {
          mfaToken: app.jwt.sign({ userId: OTHER, roleId: ROLE, mfaPending: true, sv: 0 }),
        },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('MFA_TOKEN_EXPIRED');
      expect(createMfaChallenge).not.toHaveBeenCalled();
    });

    it('refuses a regeneration code while the proof backoff locks the account', async () => {
      vi.mocked(takeSignInAttempt).mockResolvedValueOnce({
        granted: false,
        account: { userId: ME },
        factor: 'proof',
        failures: 6,
        lockedUntil: new Date(Date.now() + 60_000),
      } as never);
      setupDbResults([totpUser]);
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/mfa/recovery-codes',
        headers: auth,
        payload: { code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_CODE_INVALID');
      expect(takeSignInAttempt).toHaveBeenCalledWith({ userId: ME }, 'proof');
      expect(matchTotpStep).not.toHaveBeenCalled();
      expect(issueRecoveryCodes).not.toHaveBeenCalled();
    });

    it('refuses the code when the TOTP secret cannot be decrypted', async () => {
      vi.mocked(decryptString).mockImplementationOnce(() => {
        throw new Error('bad key');
      });
      setupDbResults([totpUser]);
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/mfa/recovery-codes',
        headers: auth,
        payload: { code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect(acceptTotpStep).not.toHaveBeenCalled();
      expect(issueRecoveryCodes).not.toHaveBeenCalled();
    });
  });

  describe('personal AI configuration audit', () => {
    it('audits a stored support key it cannot decrypt as replaced', async () => {
      vi.mocked(decryptString).mockImplementationOnce(() => {
        throw new Error('other key');
      });
      setupDbResults(
        [
          {
            supportAiProvider: 'openai',
            supportAiApiKeyEnc: 'old-cipher',
            supportAiModel: null,
            supportAiEffort: null,
            supportAiSystemPrompt: null,
            supportAiTone: null,
          },
        ],
        [{ id: 'cfg-1' }],
      );
      const res = await app.inject({
        method: 'PUT',
        url: '/users/me/support-ai-config',
        headers: auth,
        payload: { provider: 'anthropic', apiKey: 'sk-new' },
      });
      expect(res.statusCode).toBe(200);
      expect(opsFor('update', 'chatbotAiConfigs')).toHaveLength(1);
      expect(auditCall()).toMatchObject({
        action: 'updated',
        notes: 'personal support AI configuration',
        before: { provider: 'openai', apiKey: 'set' },
        after: { provider: 'anthropic', apiKey: 'replaced' },
      });
    });

    it('counts a chatbot row without a key as not configured before the save', async () => {
      setupDbResults(
        [{ provider: 'anthropic', apiKeyEnc: '', supportAiApiKeyEnc: 'x' }],
        [{ id: 'cfg-1' }],
      );
      const res = await app.inject({
        method: 'PUT',
        url: '/users/me/chatbot-ai-config',
        headers: auth,
        payload: { provider: 'anthropic', apiKey: 'sk-1' },
      });
      expect(res.statusCode).toBe(200);
      expect(auditCall()).toMatchObject({
        before: { configured: false, apiKey: 'unset' },
        after: { configured: true, provider: 'anthropic', apiKey: 'set' },
      });
    });
  });
});
