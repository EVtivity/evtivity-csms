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
  return {
    db: {
      select: vi.fn((arg?: unknown) => makeChain('select', arg)),
      insert: vi.fn((arg: unknown) => makeChain('insert', arg)),
      update: vi.fn((arg: unknown) => makeChain('update', arg)),
      delete: vi.fn((arg: unknown) => makeChain('delete', arg)),
      execute: vi.fn(() => Promise.resolve([])),
    },
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
    }),
    writeAudit: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ['eq', a, b]),
  and: vi.fn((...a: unknown[]) => ['and', ...a]),
  or: vi.fn((...a: unknown[]) => ['or', ...a]),
  isNull: vi.fn((a: unknown) => ['isNull', a]),
  ilike: vi.fn((a: unknown, b: unknown) => ['ilike', a, b]),
  inArray: vi.fn((a: unknown, b: unknown) => ['inArray', a, b]),
  desc: vi.fn((a: unknown) => ['desc', a]),
  sql: vi.fn(() => 'sql'),
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
  createMfaChallenge: vi.fn(),
  verifyMfaChallenge: vi.fn(),
  verifyRecaptcha: vi.fn().mockResolvedValue({ success: true }),
  redactSensitiveNotificationContent: vi.fn((s: string) => `redacted(${s})`),
  recordNotificationAttempt: vi.fn().mockResolvedValue(undefined),
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
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
  invalidatePermissionCache: vi.fn(),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

vi.mock('../lib/rate-limiters.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/rate-limiters.js')>();
  return {
    ...actual,
    isMfaChallengeExhausted: vi.fn().mockReturnValue(false),
    recordMfaChallengeAttempt: vi.fn(),
    clearMfaChallengeAttempts: vi.fn(),
  };
});

vi.mock('../lib/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/config.js')>();
  Object.assign(state.cfg, actual.config, {
    SETTINGS_ENCRYPTION_KEY: 'test-encryption-key',
    CSMS_URL: 'https://csms.example.com',
  });
  return { ...actual, config: state.cfg };
});

import argon2 from 'argon2';
import { client, getMfaConfig, getRecaptchaConfig, writeAudit } from '@evtivity/database';
import {
  getNotificationSettings,
  sendEmail,
  renderTemplate,
  dispatchSystemNotification,
  decryptString,
  verifyTotpCode,
  createMfaChallenge,
  verifyMfaChallenge,
  recordNotificationAttempt,
} from '@evtivity/lib';
import {
  createRefreshToken,
  validateAndRotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserRefreshTokens,
  revokeAllUserSessions,
} from '../services/refresh-token.service.js';
import { invalidatePermissionCache } from '../middleware/rbac.js';
import { invalidateSiteAccessCache } from '../lib/site-access.js';
import {
  isMfaChallengeExhausted,
  recordMfaChallengeAttempt,
  clearMfaChallengeAttempts,
} from '../lib/rate-limiters.js';
import { hashUserToken } from '../lib/user-token.js';
import { registerAuth } from '../plugins/auth.js';
import { userRoutes } from '../routes/users.js';

// postgres.js Sql type is too deep for vi.mocked(); treat the tag function as a plain mock.
const clientMock = client as unknown as Mock;

const ME = 'usr_000000000001';
const OTHER = 'usr_000000000002';
const ROLE = 'rol_000000000001';
const ROLE2 = 'rol_000000000002';

function userRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: OTHER,
    email: 'op@example.com',
    firstName: 'Op',
    lastName: 'Erator',
    phone: '+15550001111',
    roleId: ROLE,
    isActive: true,
    mustResetPassword: false,
    hasAllSiteAccess: false,
    language: 'de',
    timezone: 'UTC',
    themePreference: 'light',
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
    ...over,
  });
}

function cookieNames(res: { cookies: Array<{ name: string; value: string }> }): string[] {
  return res.cookies.map((c) => c.name);
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
    vi.mocked(getRecaptchaConfig).mockReset().mockResolvedValue(null);
    vi.mocked(getMfaConfig)
      .mockReset()
      .mockResolvedValue({ emailEnabled: true, totpEnabled: true, smsEnabled: true });
    vi.mocked(decryptString)
      .mockReset()
      .mockImplementation((v: string) => `dec(${v})`);
    vi.mocked(verifyTotpCode).mockReset().mockReturnValue(true);
    vi.mocked(verifyMfaChallenge).mockReset().mockResolvedValue(true);
    vi.mocked(createMfaChallenge)
      .mockReset()
      .mockResolvedValue({ challengeId: 42, code: '654321' });
    vi.mocked(isMfaChallengeExhausted).mockReset().mockReturnValue(false);
    vi.mocked(createRefreshToken)
      .mockReset()
      .mockResolvedValue({ rawToken: 'new-refresh', expiresAt: new Date() });
    vi.mocked(validateAndRotateRefreshToken).mockReset().mockResolvedValue(null);
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

  describe('POST /auth/login', () => {
    it('returns 400 RECAPTCHA_REQUIRED before any user lookup when reCAPTCHA is on', async () => {
      vi.mocked(getRecaptchaConfig).mockResolvedValue({
        secretKeyEnc: 'x',
        threshold: 0.5,
      } as never);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'op@example.com', password: 'Whatever1' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('RECAPTCHA_REQUIRED');
      expect(state.ops).toHaveLength(0);
    });

    it('returns 401 INVALID_CREDENTIALS on a wrong password without issuing a session', async () => {
      setupDbResults([fullUser()]);
      vi.mocked(argon2.verify).mockResolvedValue(false);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'op@example.com', password: 'WrongPass1' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('INVALID_CREDENTIALS');
      expect(createRefreshToken).not.toHaveBeenCalled();
      expect(cookieNames(res)).not.toContain('csms_token');
    });

    it('runs a dummy argon2 verify when the email does not exist (timing equalization)', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'ghost@example.com', password: 'Whatever1' },
      });
      expect(res.statusCode).toBe(401);
      expect(argon2.verify).toHaveBeenCalledWith(expect.any(String), 'Whatever1');
    });

    it('returns 403 ACCOUNT_DISABLED for an inactive user with a valid password', async () => {
      setupDbResults([fullUser({ isActive: false })]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'op@example.com', password: 'Correct1' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('ACCOUNT_DISABLED');
      expect(createRefreshToken).not.toHaveBeenCalled();
    });

    it('returns mustResetPassword without a token when a reset is pending', async () => {
      setupDbResults([fullUser({ mustResetPassword: true })]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'op@example.com', password: 'Correct1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ mustResetPassword: true });
      expect(createRefreshToken).not.toHaveBeenCalled();
    });

    it('starts an email MFA challenge and returns an mfaPending token instead of a session', async () => {
      setupDbResults([fullUser({ mfaEnabled: true, mfaMethod: 'email' })]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'op@example.com', password: 'Correct1' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.mfaRequired).toBe(true);
      expect(body.mfaMethod).toBe('email');
      expect(body.challengeId).toBe(42);
      expect(body.token).toBeUndefined();
      const decoded = app.jwt.verify<Record<string, unknown>>(body.mfaToken as string);
      expect(decoded).toMatchObject({ userId: OTHER, roleId: ROLE, mfaPending: true });
      expect(createMfaChallenge).toHaveBeenCalledWith(client, { userId: OTHER, method: 'email' });
      expect(dispatchSystemNotification).toHaveBeenCalledWith(
        client,
        'mfa.VerificationCode',
        { email: 'op@example.com', phone: '+15550001111', firstName: 'Op', language: 'de' },
        { code: '654321' },
        expect.any(String),
      );
      expect(createRefreshToken).not.toHaveBeenCalled();
      expect(cookieNames(res)).not.toContain('csms_token');
    });

    it('does not create a challenge for TOTP MFA', async () => {
      setupDbResults([fullUser({ mfaEnabled: true, mfaMethod: 'totp', phone: null })]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'op@example.com', password: 'Correct1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().mfaMethod).toBe('totp');
      expect(res.json().challengeId).toBeUndefined();
      expect(createMfaChallenge).not.toHaveBeenCalled();
      expect(dispatchSystemNotification).not.toHaveBeenCalled();
    });

    it('issues cookies, records lastLoginAt and returns role null when the role row is gone', async () => {
      setupDbResults([fullUser()], [], []);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'op@example.com', password: 'Correct1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().role).toBeNull();
      expect(createRefreshToken).toHaveBeenCalledWith({ userId: OTHER });
      expect(cookieNames(res)).toEqual(expect.arrayContaining(['csms_token', 'csms_refresh']));
      const update = opsFor('update', 'users')[0];
      expect(argOf(update, 'set')).toEqual({ lastLoginAt: expect.any(Date) });
      expect(argOf(update, 'where')).toEqual(['eq', 'users.id', OTHER]);
    });
  });

  // --------------------------------------------------------------- logout

  describe('POST /auth/logout', () => {
    it('revokes the refresh cookie, clears the permission cache and the auth cookies', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: auth,
        cookies: { csms_refresh: app.signCookie('raw-refresh-value') },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(revokeRefreshToken).toHaveBeenCalledWith('raw-refresh-value');
      expect(invalidatePermissionCache).toHaveBeenCalledWith(ME);
      const cleared = res.cookies.filter((c) => c.name === 'csms_token');
      expect(cleared).toHaveLength(1);
      expect(cleared[0]?.value).toBe('');
    });

    it('skips refresh revocation for a tampered refresh cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: auth,
        cookies: { csms_refresh: 'raw-refresh-value.bad-signature' },
      });
      expect(res.statusCode).toBe(200);
      expect(revokeRefreshToken).not.toHaveBeenCalled();
    });

    it('skips refresh revocation when no refresh cookie is present', async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/logout', headers: auth });
      expect(res.statusCode).toBe(200);
      expect(revokeRefreshToken).not.toHaveBeenCalled();
    });

    it('returns 401 without authentication', async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/logout' });
      expect(res.statusCode).toBe(401);
      expect(revokeRefreshToken).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------- refresh

  describe('POST /auth/refresh', () => {
    it('returns 401 NO_REFRESH_TOKEN without a cookie', async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/refresh' });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('NO_REFRESH_TOKEN');
      expect(validateAndRotateRefreshToken).not.toHaveBeenCalled();
    });

    it('returns 401 INVALID_REFRESH_TOKEN and clears cookies when rotation fails', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: { csms_refresh: app.signCookie('bad') },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('INVALID_REFRESH_TOKEN');
      expect(validateAndRotateRefreshToken).toHaveBeenCalledWith('bad');
      expect(cookieNames(res)).toContain('csms_refresh');
      expect(createRefreshToken).not.toHaveBeenCalled();
    });

    it('returns 401 INVALID_REFRESH_TOKEN and clears cookies for a tampered cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: { csms_refresh: 'good.not-a-valid-signature' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('INVALID_REFRESH_TOKEN');
      expect(validateAndRotateRefreshToken).not.toHaveBeenCalled();
      expect(cookieNames(res)).toContain('csms_refresh');
      expect(createRefreshToken).not.toHaveBeenCalled();
    });

    it('returns 401 INVALID_REFRESH_TOKEN when the token belongs to no operator', async () => {
      vi.mocked(validateAndRotateRefreshToken).mockResolvedValue({ userId: null } as never);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: { csms_refresh: app.signCookie('driver-token') },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('returns 401 ACCOUNT_DISABLED for an inactive user', async () => {
      vi.mocked(validateAndRotateRefreshToken).mockResolvedValue({ userId: OTHER } as never);
      setupDbResults([{ id: OTHER, roleId: ROLE, isActive: false }]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: { csms_refresh: app.signCookie('good') },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('ACCOUNT_DISABLED');
      expect(createRefreshToken).not.toHaveBeenCalled();
    });

    it('returns 401 ACCOUNT_DISABLED when the user row is gone', async () => {
      vi.mocked(validateAndRotateRefreshToken).mockResolvedValue({ userId: OTHER } as never);
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: { csms_refresh: app.signCookie('good') },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('ACCOUNT_DISABLED');
    });

    it('issues a new access token and refresh cookie for an active user', async () => {
      vi.mocked(validateAndRotateRefreshToken).mockResolvedValue({ userId: OTHER } as never);
      setupDbResults([{ id: OTHER, roleId: ROLE, isActive: true }]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: { csms_refresh: app.signCookie('good') },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(createRefreshToken).toHaveBeenCalledWith({ userId: OTHER });
      const refresh = res.cookies.find((c) => c.name === 'csms_refresh');
      // Cookies are signed: value is '<raw>.<signature>'.
      expect(refresh?.value).toMatch(/^new-refresh\./);
      expect(cookieNames(res)).toContain('csms_token');
    });
  });

  // ------------------------------------------------------ forgot-password

  describe('POST /auth/forgot-password', () => {
    it('revokes old reset tokens, stores a 1h token, emails it and logs the attempt', async () => {
      setupDbResults([{ id: OTHER, firstName: 'Op', lastName: null, language: 'ko' }]);
      clientMock.mockResolvedValue([
        { key: 'company.name', value: 'Acme Charging' },
        { key: 'company.city', value: 'Berlin' },
        { key: 'company.zip', value: 12345 },
      ] as never);
      const before = Date.now();
      const res = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email: 'op@example.com' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });

      const revoke = opsFor('update', 'userTokens')[0];
      expect(argOf(revoke, 'set')).toEqual({ revokedAt: expect.any(Date) });
      expect(argOf(revoke, 'where')).toEqual([
        'and',
        ['eq', 'userTokens.userId', OTHER],
        ['eq', 'userTokens.type', 'password_reset'],
        ['isNull', 'userTokens.revokedAt'],
      ]);

      const inserted = argOf(opsFor('insert', 'userTokens')[0], 'values') as Record<
        string,
        unknown
      >;
      expect(inserted['userId']).toBe(OTHER);
      expect(inserted['type']).toBe('password_reset');
      const expiresMs = (inserted['expiresAt'] as Date).getTime();
      expect(expiresMs).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
      expect(expiresMs).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);

      const renderArgs = vi.mocked(renderTemplate).mock.calls[0];
      expect(renderArgs?.[0]).toBe('email');
      expect(renderArgs?.[1]).toBe('operator.ForgotPassword');
      expect(renderArgs?.[2]).toBe('ko');
      const vars = renderArgs?.[3] as Record<string, string>;
      expect(vars['companyName']).toBe('Acme Charging');
      expect(vars['companyCity']).toBe('Berlin');
      expect(vars['companyZip']).toBe('');
      expect(vars['firstName']).toBe('Op');
      expect(vars['lastName']).toBe('');
      const match = /^https:\/\/csms\.example\.com\/reset-password\?token=([0-9a-f]{64})$/.exec(
        vars['resetUrl'] ?? '',
      );
      expect(match).not.toBeNull();
      expect(inserted['tokenHash']).toBe(hashUserToken(match?.[1] ?? ''));

      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'smtp.test' }),
        'op@example.com',
        'Reset',
        'Body text',
        '<html>wrapped</html>',
      );
      expect(recordNotificationAttempt).toHaveBeenCalledWith(client, {
        channel: 'email',
        recipient: 'op@example.com',
        subject: 'redacted(Reset)',
        body: 'redacted(<html>wrapped</html>)',
        status: 'sent',
        eventType: 'operator.ForgotPassword',
        metadata: {},
      });
    });

    it('records credentials_decrypt_failed when SMTP credentials could not be decrypted', async () => {
      setupDbResults([{ id: OTHER, firstName: null, lastName: null, language: 'en' }]);
      vi.mocked(getNotificationSettings).mockResolvedValue({
        smtp: { host: 'h', port: 1, credentialError: 'decrypt_failed' },
        twilio: null,
        emailWrapperTemplate: null,
      } as never);
      vi.mocked(sendEmail).mockResolvedValue(false);
      vi.mocked(renderTemplate).mockResolvedValue({ subject: 'S', body: 'B', html: null } as never);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email: 'op@example.com' },
      });
      expect(res.statusCode).toBe(200);
      const call = vi.mocked(recordNotificationAttempt).mock.calls[0]?.[1] as Record<
        string,
        unknown
      >;
      expect(call['status']).toBe('failed');
      expect(call['metadata']).toEqual({ failureReason: 'credentials_decrypt_failed' });
      // With no HTML, the stored body falls back to the plain text body.
      expect(call['body']).toBe('redacted(B)');
      expect(vi.mocked(sendEmail).mock.calls[0]?.[4]).toBeUndefined();
      const vars = vi.mocked(renderTemplate).mock.calls[0]?.[3] as Record<string, string>;
      expect(vars['companyName']).toBe('EVtivity CSMS');
    });

    it('records smtp_send_failed for other send failures', async () => {
      setupDbResults([{ id: OTHER, firstName: null, lastName: null, language: 'en' }]);
      vi.mocked(sendEmail).mockResolvedValue(false);
      await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email: 'op@example.com' },
      });
      const call = vi.mocked(recordNotificationAttempt).mock.calls[0]?.[1] as Record<
        string,
        unknown
      >;
      expect(call['metadata']).toEqual({ failureReason: 'smtp_send_failed' });
    });

    it('stores the token but sends nothing when SMTP is not configured', async () => {
      setupDbResults([{ id: OTHER, firstName: null, lastName: null, language: 'en' }]);
      vi.mocked(getNotificationSettings).mockResolvedValue({
        smtp: null,
        twilio: null,
        emailWrapperTemplate: null,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email: 'op@example.com' },
      });
      expect(res.statusCode).toBe(200);
      expect(opsFor('insert', 'userTokens')).toHaveLength(1);
      expect(sendEmail).not.toHaveBeenCalled();
      expect(recordNotificationAttempt).not.toHaveBeenCalled();
    });

    it('still returns success when the email pipeline throws', async () => {
      setupDbResults([{ id: OTHER, firstName: null, lastName: null, language: 'en' }]);
      vi.mocked(getNotificationSettings).mockRejectedValue(new Error('db down'));
      const res = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email: 'op@example.com' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });

    it('does not create a token for an unknown email', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email: 'ghost@example.com' },
      });
      expect(res.statusCode).toBe(200);
      expect(opsFor('insert', 'userTokens')).toHaveLength(0);
      expect(getNotificationSettings).not.toHaveBeenCalled();
    });

    it('requires reCAPTCHA when enabled', async () => {
      vi.mocked(getRecaptchaConfig).mockResolvedValue({
        secretKeyEnc: 'x',
        threshold: 0.5,
      } as never);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email: 'op@example.com' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('RECAPTCHA_REQUIRED');
      expect(state.ops).toHaveLength(0);
    });
  });

  // -------------------------------------------------------- reset-password

  describe('POST /auth/reset-password', () => {
    it('rejects a password without an uppercase letter with WEAK_PASSWORD', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: { token: 'abc', password: 'alllowercase123' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('WEAK_PASSWORD');
      expect(state.ops).toHaveLength(0);
    });

    it('looks the token up by its hash, resets, revokes sessions and notifies', async () => {
      setupDbResults(
        [{ id: 7, userId: OTHER, expiresAt: new Date(Date.now() + 60_000) }],
        [],
        [],
        [{ id: OTHER, email: 'op@example.com', phone: null, firstName: null, lastName: 'L' }],
      );
      const res = await app.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: { token: 'raw-token', password: 'NewPassword123' },
      });
      expect(res.statusCode).toBe(200);
      const lookup = opsFor('select', 'userTokens')[0];
      expect(argOf(lookup, 'where')).toEqual([
        'and',
        ['eq', 'userTokens.tokenHash', hashUserToken('raw-token')],
        ['eq', 'userTokens.type', 'password_reset'],
        ['isNull', 'userTokens.revokedAt'],
      ]);
      expect(argOf(opsFor('update', 'users')[0], 'set')).toEqual({
        passwordHash: '$argon2id$hashed',
        mustResetPassword: false,
        updatedAt: expect.any(Date),
      });
      expect(argOf(opsFor('update', 'userTokens')[0], 'where')).toEqual(['eq', 'userTokens.id', 7]);
      expect(revokeAllUserSessions).toHaveBeenCalledWith(OTHER);
      expect(dispatchSystemNotification).toHaveBeenCalledWith(
        client,
        'operator.PasswordChanged',
        { email: 'op@example.com', phone: undefined, userId: OTHER, language: undefined },
        { firstName: '', lastName: 'L', email: 'op@example.com' },
        expect.any(Array),
      );
    });

    it('returns 400 INVALID_TOKEN for a token row without a user', async () => {
      setupDbResults([{ id: 7, userId: null, expiresAt: new Date(Date.now() + 60_000) }]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: { token: 'raw-token', password: 'NewPassword123' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_TOKEN');
      expect(opsFor('update', 'users')).toHaveLength(0);
    });

    it('skips the notification when the user vanished after the reset', async () => {
      setupDbResults([{ id: 7, userId: OTHER, expiresAt: new Date(Date.now() + 60_000) }]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: { token: 'raw-token', password: 'NewPassword123' },
      });
      expect(res.statusCode).toBe(200);
      expect(dispatchSystemNotification).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------- force-change-password

  describe('POST /auth/force-change-password', () => {
    it('rejects a weak new password after verifying the current one', async () => {
      setupDbResults([fullUser({ mustResetPassword: true })]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/force-change-password',
        payload: {
          email: 'op@example.com',
          currentPassword: 'Temp1',
          newPassword: 'NOLOWERCASE123',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('WEAK_PASSWORD');
      expect(opsFor('update', 'users')).toHaveLength(0);
    });

    it('routes MFA users through the SMS challenge instead of issuing a session', async () => {
      setupDbResults([fullUser({ mustResetPassword: true, mfaEnabled: true, mfaMethod: 'sms' })]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/force-change-password',
        payload: {
          email: 'op@example.com',
          currentPassword: 'Temp1',
          newPassword: 'NewPassword123',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.mfaRequired).toBe(true);
      expect(body.mfaMethod).toBe('sms');
      expect(body.challengeId).toBe(42);
      expect(body.token).toBeUndefined();
      expect(argOf(opsFor('update', 'users')[0], 'set')).toMatchObject({
        passwordHash: '$argon2id$hashed',
        mustResetPassword: false,
      });
      expect(revokeAllUserSessions).toHaveBeenCalledWith(OTHER);
      expect(auditCall()).toMatchObject({
        entityId: OTHER,
        action: 'password_reset',
        notes: 'User changed own password (forced reset)',
      });
      expect(createMfaChallenge).toHaveBeenCalledWith(client, { userId: OTHER, method: 'sms' });
      expect(createRefreshToken).not.toHaveBeenCalled();
    });

    it('returns mfaRequired without a challenge for TOTP users', async () => {
      setupDbResults([
        fullUser({
          mustResetPassword: true,
          mfaEnabled: true,
          mfaMethod: 'totp',
          firstName: null,
          phone: null,
        }),
      ]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/force-change-password',
        payload: {
          email: 'op@example.com',
          currentPassword: 'Temp1',
          newPassword: 'NewPassword123',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().mfaMethod).toBe('totp');
      expect(createMfaChallenge).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------ users/me

  describe('GET /users/me', () => {
    it('returns role null and the stored permissions when the role row is missing', async () => {
      setupDbResults([userRow({ id: ME })], [], [{ permission: 'stations:read' }]);
      const res = await app.inject({ method: 'GET', url: '/users/me', headers: auth });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.role).toBeNull();
      expect(body.permissions).toEqual(['stations:read']);
      expect(argOf(opsFor('select', 'users')[0], 'where')).toEqual(['eq', 'users.id', ME]);
    });
  });

  describe('PATCH /users/me', () => {
    it('updates only the supplied profile fields and writes an audit row', async () => {
      const before = userRow({ id: ME, firstName: 'Old' });
      const after = userRow({ id: ME, firstName: 'New', phone: null, language: 'zh-TW' });
      setupDbResults([before], [after], [{ id: ROLE, name: 'operator' }]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/users/me',
        headers: auth,
        payload: {
          firstName: 'New',
          lastName: 'Last',
          phone: null,
          language: 'zh-TW',
          timezone: 'Asia/Taipei',
          themePreference: 'dark',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().role).toEqual({ id: ROLE, name: 'operator' });
      expect(res.json().firstName).toBe('New');
      const set = argOf(opsFor('update', 'users')[0], 'set');
      expect(set).toEqual({
        updatedAt: expect.any(Date),
        firstName: 'New',
        lastName: 'Last',
        phone: null,
        language: 'zh-TW',
        timezone: 'Asia/Taipei',
        themePreference: 'dark',
      });
      expect(auditCall()).toMatchObject({
        entityId: ME,
        action: 'updated',
        actor: 'operator',
        actorUserId: ME,
        before,
        after,
      });
    });

    it('leaves untouched fields out of the update', async () => {
      setupDbResults([userRow({ id: ME })], [userRow({ id: ME })], [{ id: ROLE, name: 'x' }]);
      await app.inject({
        method: 'PATCH',
        url: '/users/me',
        headers: auth,
        payload: { themePreference: 'light' },
      });
      expect(argOf(opsFor('update', 'users')[0], 'set')).toEqual({
        updatedAt: expect.any(Date),
        themePreference: 'light',
      });
    });

    it('rejects a language outside the six supported locales', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/users/me',
        headers: auth,
        payload: { language: 'fr' },
      });
      expect(res.statusCode).toBe(400);
      expect(state.ops).toHaveLength(0);
    });

    it('returns 404 USER_NOT_FOUND when the update matches no row', async () => {
      setupDbResults([], []);
      const res = await app.inject({
        method: 'PATCH',
        url: '/users/me',
        headers: auth,
        payload: { firstName: 'X' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('USER_NOT_FOUND');
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('returns role null without a role lookup when the user has no role', async () => {
      setupDbResults([userRow({ id: ME })], [userRow({ id: ME, roleId: '' })]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/users/me',
        headers: auth,
        payload: { firstName: 'X' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().role).toBeNull();
      expect(opsFor('select', 'roles')).toHaveLength(0);
    });

    it('returns 401 without authentication', async () => {
      const res = await app.inject({ method: 'PATCH', url: '/users/me', payload: {} });
      expect(res.statusCode).toBe(401);
    });
  });

  // ------------------------------------------------------------ GET /users

  describe('GET /users', () => {
    it('applies search, role and status filters and enriches site counts', async () => {
      setupDbResults(
        [
          userRow({ id: OTHER, hasAllSiteAccess: false }),
          userRow({ id: 'usr_000000000003', hasAllSiteAccess: true }),
          userRow({ id: 'usr_000000000004', hasAllSiteAccess: false }),
        ],
        [{ count: 3 }],
        [{ userId: OTHER, count: 2 }],
      );
      const res = await app.inject({
        method: 'GET',
        url: `/users?search=op&roleId=${ROLE}&status=inactive&page=2&limit=10`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(3);
      expect(body.data.map((u: { siteCount: number | null }) => u.siteCount)).toEqual([2, null, 0]);
      const list = opsFor('select', 'users')[0];
      expect(argOf(list, 'where')).toEqual([
        'and',
        [
          'or',
          ['ilike', 'users.id', '%op%'],
          ['ilike', 'users.email', '%op%'],
          ['ilike', 'users.firstName', '%op%'],
          ['ilike', 'users.lastName', '%op%'],
        ],
        ['eq', 'users.roleId', ROLE],
        ['eq', 'users.isActive', false],
      ]);
      expect(argOf(list, 'limit')).toBe(10);
      expect(argOf(list, 'offset')).toBe(10);
      expect(argOf(opsFor('select', 'userSiteAssignments')[0], 'where')).toEqual([
        'inArray',
        'userSiteAssignments.userId',
        [OTHER, 'usr_000000000003', 'usr_000000000004'],
      ]);
    });

    it('maps status=active to isActive true and skips the site count query for no rows', async () => {
      setupDbResults([], []);
      const res = await app.inject({ method: 'GET', url: '/users?status=active', headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(argOf(opsFor('select', 'users')[0], 'where')).toEqual([
        'and',
        ['eq', 'users.isActive', true],
      ]);
      expect(opsFor('select', 'userSiteAssignments')).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------- POST /users

  describe('POST /users', () => {
    it('returns 409 DUPLICATE_EMAIL using a case-insensitive email match', async () => {
      setupDbResults([{ id: OTHER }]);
      const res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: auth,
        payload: { email: 'op@example.com', roleId: ROLE },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DUPLICATE_EMAIL');
      // Exact match on lower(email): ilike would treat _ and % as wildcards.
      expect(argOf(opsFor('select', 'users')[0], 'where')).toEqual(['eq', 'sql', 'op@example.com']);
      expect(opsFor('insert', 'users')).toHaveLength(0);
    });

    it('stores a new user email lowercased and trimmed', async () => {
      setupDbResults([], [{ id: ROLE }], [{ id: OTHER, email: 'op@example.com', roleId: ROLE }]);
      await app.inject({
        method: 'POST',
        url: '/users',
        headers: auth,
        payload: { email: 'Op@Example.COM', roleId: ROLE },
      });
      expect(argOf(opsFor('select', 'users')[0], 'where')).toEqual(['eq', 'sql', 'op@example.com']);
      expect(argOf(opsFor('insert', 'users')[0], 'values')).toMatchObject({
        email: 'op@example.com',
      });
    });

    it('returns 400 ROLE_NOT_FOUND for an unknown role', async () => {
      setupDbResults([], []);
      const res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: auth,
        payload: { email: 'new@example.com', roleId: ROLE2 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('ROLE_NOT_FOUND');
      expect(opsFor('insert', 'users')).toHaveLength(0);
    });

    it('returns 400 INVALID_SITE_IDS when a deduped site id does not exist', async () => {
      setupDbResults([], [{ id: ROLE }], [{ id: 'site-a' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: auth,
        payload: { email: 'new@example.com', roleId: ROLE, siteIds: ['site-a', 'site-b'] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_SITE_IDS');
      expect(argOf(opsFor('select', 'sites')[0], 'where')).toEqual([
        'inArray',
        'sites.id',
        ['site-a', 'site-b'],
      ]);
      expect(opsFor('insert', 'users')).toHaveLength(0);
    });

    it('creates a user with deduped site assignments, admin defaults and an invite token', async () => {
      const created = {
        id: OTHER,
        email: 'new@example.com',
        firstName: 'New',
        lastName: null,
        phone: null,
        roleId: ROLE,
      };
      setupDbResults(
        [],
        [{ id: ROLE }],
        [{ id: 'site-a' }, { id: 'site-b' }],
        [created],
        [],
        [{ name: 'admin' }],
      );
      const before = Date.now();
      const res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: auth,
        payload: {
          email: 'new@example.com',
          firstName: 'New',
          roleId: ROLE,
          siteIds: ['site-a', 'site-b', 'site-a'],
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        id: OTHER,
        hasAllSiteAccess: false,
        siteIds: ['site-a', 'site-b', 'site-a'],
      });

      const userInsert = argOf(opsFor('insert', 'users')[0], 'values') as Record<string, unknown>;
      expect(userInsert).toMatchObject({
        email: 'new@example.com',
        firstName: 'New',
        roleId: ROLE,
        mustResetPassword: true,
        passwordHash: '$argon2id$hashed',
      });
      expect(argOf(opsFor('insert', 'userSiteAssignments')[0], 'values')).toEqual([
        { userId: OTHER, siteId: 'site-a' },
        { userId: OTHER, siteId: 'site-b' },
      ]);
      expect(argOf(opsFor('insert', 'userPermissions')[0], 'values')).toEqual([
        { userId: OTHER, permission: 'users:read' },
        { userId: OTHER, permission: 'users:write' },
        { userId: OTHER, permission: 'stations:read' },
      ]);

      const tokenInsert = argOf(opsFor('insert', 'userTokens')[0], 'values') as Record<
        string,
        unknown
      >;
      expect(tokenInsert['type']).toBe('password_reset');
      const expires = (tokenInsert['expiresAt'] as Date).getTime();
      expect(expires).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
      expect(expires).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);

      const notify = vi.mocked(dispatchSystemNotification).mock.calls[0];
      expect(notify?.[1]).toBe('operator.UserCreated');
      expect(notify?.[2]).toEqual({
        email: 'new@example.com',
        phone: undefined,
        userId: OTHER,
        language: 'en',
      });
      const vars = notify?.[3] as Record<string, string>;
      const raw = /token=([0-9a-f]{64})$/.exec(vars['setPasswordUrl'] ?? '')?.[1] ?? '';
      expect(tokenInsert['tokenHash']).toBe(hashUserToken(raw));
      expect(vars['lastName']).toBe('');

      expect(auditCall()).toMatchObject({
        entityId: OTHER,
        action: 'created',
        after: { hasAllSiteAccess: false, siteIds: ['site-a', 'site-b', 'site-a'] },
      });
    });

    it('sets hasAllSiteAccess, ignores siteIds and applies viewer defaults', async () => {
      const created = {
        id: OTHER,
        email: 'v@example.com',
        firstName: null,
        lastName: null,
        phone: '+1',
        roleId: ROLE,
      };
      setupDbResults([], [{ id: ROLE }], [created], [], [{ name: 'viewer' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: auth,
        payload: {
          email: 'v@example.com',
          roleId: ROLE,
          hasAllSiteAccess: true,
          siteIds: ['site-a'],
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ hasAllSiteAccess: true, siteIds: [] });
      expect(opsFor('select', 'sites')).toHaveLength(0);
      expect(opsFor('insert', 'userSiteAssignments')).toHaveLength(0);
      const flag = opsFor('update', 'users')[0];
      expect(argOf(flag, 'set')).toEqual({ hasAllSiteAccess: true });
      expect(argOf(flag, 'where')).toEqual(['eq', 'users.id', OTHER]);
      expect(argOf(opsFor('insert', 'userPermissions')[0], 'values')).toEqual([
        { userId: OTHER, permission: 'stations:read' },
      ]);
      expect(vi.mocked(dispatchSystemNotification).mock.calls[0]?.[2]).toMatchObject({
        phone: '+1',
      });
    });

    it('falls back to operator defaults for any other role name', async () => {
      const created = {
        id: OTHER,
        email: 'o@example.com',
        firstName: null,
        lastName: null,
        phone: null,
        roleId: ROLE,
      };
      setupDbResults([], [{ id: ROLE }], [created], [{ name: 'custom' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: auth,
        payload: { email: 'o@example.com', roleId: ROLE },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().siteIds).toEqual([]);
      expect(opsFor('update', 'users')).toHaveLength(0);
      expect(argOf(opsFor('insert', 'userPermissions')[0], 'values')).toEqual([
        { userId: OTHER, permission: 'stations:read' },
        { userId: OTHER, permission: 'stations:write' },
      ]);
    });
  });

  // ------------------------------------------------------- PATCH /users/:id

  describe('PATCH /users/:id', () => {
    it('blocks self-edit of siteIds', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${ME}`,
        headers: auth,
        payload: { siteIds: [] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('SELF_EDIT_FORBIDDEN');
      expect(state.ops).toHaveLength(0);
    });

    it('returns 400 ROLE_NOT_FOUND for an unknown roleId', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${OTHER}`,
        headers: auth,
        payload: { roleId: ROLE2 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('ROLE_NOT_FOUND');
      expect(opsFor('update', 'users')).toHaveLength(0);
    });

    it('returns 400 INVALID_SITE_IDS without replacing assignments', async () => {
      setupDbResults([userRow()], [userRow()], []);
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${OTHER}`,
        headers: auth,
        payload: { siteIds: ['site-x'] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_SITE_IDS');
      expect(opsFor('delete', 'userSiteAssignments')).toHaveLength(0);
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('replaces site assignments, invalidates site access and audits site_access_changed', async () => {
      setupDbResults(
        [userRow()],
        [userRow()],
        [{ id: 'site-a' }, { id: 'site-b' }],
        [],
        [],
        [{ siteId: 'site-a' }, { siteId: 'site-b' }],
        [{ permission: 'stations:read' }],
      );
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${OTHER}`,
        headers: auth,
        payload: { siteIds: ['site-a', 'site-b', 'site-b'], hasAllSiteAccess: false },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        siteIds: ['site-a', 'site-b'],
        permissions: ['stations:read'],
      });
      expect(argOf(opsFor('update', 'users')[0], 'set')).toEqual({
        updatedAt: expect.any(Date),
        hasAllSiteAccess: false,
      });
      expect(argOf(opsFor('delete', 'userSiteAssignments')[0], 'where')).toEqual([
        'eq',
        'userSiteAssignments.userId',
        OTHER,
      ]);
      expect(argOf(opsFor('insert', 'userSiteAssignments')[0], 'values')).toEqual([
        { userId: OTHER, siteId: 'site-a' },
        { userId: OTHER, siteId: 'site-b' },
      ]);
      expect(invalidateSiteAccessCache).toHaveBeenCalledWith(OTHER);
      expect(revokeAllUserRefreshTokens).not.toHaveBeenCalled();
      expect(auditCall()).toMatchObject({
        action: 'site_access_changed',
        after: { siteIds: ['site-a', 'site-b'] },
      });
    });

    it('clears all assignments for an empty siteIds list without a site lookup', async () => {
      setupDbResults([userRow()], [userRow()], [], [], []);
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${OTHER}`,
        headers: auth,
        payload: { siteIds: [] },
      });
      expect(res.statusCode).toBe(200);
      expect(opsFor('select', 'sites')).toHaveLength(0);
      expect(opsFor('delete', 'userSiteAssignments')).toHaveLength(1);
      expect(opsFor('insert', 'userSiteAssignments')).toHaveLength(0);
    });

    it('deactivation revokes refresh tokens and broadcasts the isActive cache drop', async () => {
      setupDbResults([userRow()], [userRow({ isActive: false })], [], []);
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${OTHER}`,
        headers: auth,
        payload: { isActive: false },
      });
      expect(res.statusCode).toBe(200);
      expect(argOf(opsFor('update', 'users')[0], 'set')).toEqual({
        updatedAt: expect.any(Date),
        isActive: false,
      });
      expect(revokeAllUserRefreshTokens).toHaveBeenCalledWith(OTHER);
      expect(published).toContainEqual({
        channel: 'cache_invalidate',
        message: JSON.stringify({ kind: 'active', userId: OTHER }),
      });
      expect(invalidateSiteAccessCache).not.toHaveBeenCalled();
      expect(auditCall()).toMatchObject({ action: 'updated' });
    });

    it('a role change resets permissions to the new role defaults and revokes sessions', async () => {
      setupDbResults(
        [{ id: ROLE2 }],
        [userRow({ roleId: ROLE })],
        [userRow({ roleId: ROLE2 })],
        [{ name: 'viewer' }],
        [],
        [],
        [],
        [{ permission: 'stations:read' }],
      );
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${OTHER}`,
        headers: auth,
        payload: { roleId: ROLE2 },
      });
      expect(res.statusCode).toBe(200);
      expect(argOf(opsFor('delete', 'userPermissions')[0], 'where')).toEqual([
        'eq',
        'userPermissions.userId',
        OTHER,
      ]);
      expect(argOf(opsFor('insert', 'userPermissions')[0], 'values')).toEqual([
        { userId: OTHER, permission: 'stations:read' },
      ]);
      expect(invalidatePermissionCache).toHaveBeenCalledWith(OTHER);
      expect(revokeAllUserSessions).toHaveBeenCalledWith(OTHER);
      expect(auditCall()).toMatchObject({
        action: 'role_changed',
        before: { roleId: ROLE },
        after: { roleId: ROLE2, siteIds: [] },
      });
    });

    it('audits as updated when the roleId equals the current role', async () => {
      setupDbResults(
        [{ id: ROLE }],
        [userRow({ roleId: ROLE })],
        [userRow({ roleId: ROLE })],
        [{ name: 'admin' }],
      );
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${OTHER}`,
        headers: auth,
        payload: { roleId: ROLE },
      });
      expect(res.statusCode).toBe(200);
      expect(argOf(opsFor('insert', 'userPermissions')[0], 'values')).toEqual([
        { userId: OTHER, permission: 'users:read' },
        { userId: OTHER, permission: 'users:write' },
        { userId: OTHER, permission: 'stations:read' },
      ]);
      expect(auditCall()).toMatchObject({ action: 'updated' });
    });

    it('records before as null when the pre-update read finds nothing', async () => {
      setupDbResults([], [userRow()]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${OTHER}`,
        headers: auth,
        payload: { lastName: 'Z', phone: '+49', timezone: 'Europe/Berlin', language: 'es' },
      });
      expect(res.statusCode).toBe(200);
      expect(argOf(opsFor('update', 'users')[0], 'set')).toEqual({
        updatedAt: expect.any(Date),
        lastName: 'Z',
        phone: '+49',
        timezone: 'Europe/Berlin',
        language: 'es',
      });
      expect(auditCall()['before']).toBeNull();
    });
  });

  // ------------------------------------------------- password management

  describe('password endpoints', () => {
    it('admin reset rejects a password without a digit', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/users/${OTHER}/reset-password`,
        headers: auth,
        payload: { password: 'NoDigitsHereAtAll' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('WEAK_PASSWORD');
      expect(state.ops).toHaveLength(0);
    });

    it('admin reset forces a reset, revokes sessions and audits', async () => {
      setupDbResults([{ id: OTHER }]);
      const res = await app.inject({
        method: 'POST',
        url: `/users/${OTHER}/reset-password`,
        headers: auth,
        payload: { password: 'TempPassword123' },
      });
      expect(res.statusCode).toBe(200);
      expect(argOf(opsFor('update', 'users')[0], 'set')).toEqual({
        passwordHash: '$argon2id$hashed',
        mustResetPassword: true,
        updatedAt: expect.any(Date),
      });
      expect(revokeAllUserSessions).toHaveBeenCalledWith(OTHER);
      expect(auditCall()).toMatchObject({
        entityId: OTHER,
        action: 'password_reset',
        notes: 'Password reset by admin',
        actorUserId: ME,
      });
    });

    it('change-password returns 400 INVALID_PASSWORD on a wrong current password', async () => {
      setupDbResults([{ id: ME, passwordHash: 'h' }]);
      vi.mocked(argon2.verify).mockResolvedValue(false);
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/change-password',
        headers: auth,
        payload: { currentPassword: 'wrong', newPassword: 'NewPassword123' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_PASSWORD');
      expect(opsFor('update', 'users')).toHaveLength(0);
      expect(revokeAllUserSessions).not.toHaveBeenCalled();
    });

    it('change-password rejects a weak new password', async () => {
      setupDbResults([{ id: ME, passwordHash: 'h' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/change-password',
        headers: auth,
        payload: { currentPassword: 'Current1', newPassword: 'nouppercase123' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('WEAK_PASSWORD');
      expect(opsFor('update', 'users')).toHaveLength(0);
    });

    it('change-password updates the hash, revokes sessions and audits', async () => {
      setupDbResults([{ id: ME, passwordHash: 'h' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/change-password',
        headers: auth,
        payload: { currentPassword: 'Current1', newPassword: 'NewPassword123' },
      });
      expect(res.statusCode).toBe(200);
      expect(argon2.verify).toHaveBeenCalledWith('h', 'Current1');
      expect(argOf(opsFor('update', 'users')[0], 'where')).toEqual(['eq', 'users.id', ME]);
      expect(revokeAllUserSessions).toHaveBeenCalledWith(ME);
      expect(auditCall()).toMatchObject({ entityId: ME, notes: 'User changed own password' });
    });
  });

  // ------------------------------------------------------ DELETE /users/:id

  describe('DELETE /users/:id', () => {
    it('refuses to deactivate the caller', async () => {
      const res = await app.inject({ method: 'DELETE', url: `/users/${ME}`, headers: auth });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('SELF_EDIT_FORBIDDEN');
      expect(state.ops).toHaveLength(0);
    });

    it('returns 404 for an unknown user', async () => {
      setupDbResults([]);
      const res = await app.inject({ method: 'DELETE', url: `/users/${OTHER}`, headers: auth });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('USER_NOT_FOUND');
      expect(opsFor('update', 'users')).toHaveLength(0);
    });

    it('soft-deactivates, clears every cache, revokes tokens and audits', async () => {
      const row = fullUser();
      setupDbResults([row]);
      const res = await app.inject({ method: 'DELETE', url: `/users/${OTHER}`, headers: auth });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      expect(argOf(opsFor('update', 'users')[0], 'set')).toEqual({
        isActive: false,
        updatedAt: expect.any(Date),
      });
      expect(opsFor('delete', 'users')).toHaveLength(0);
      expect(invalidatePermissionCache).toHaveBeenCalledWith(OTHER);
      expect(invalidateSiteAccessCache).toHaveBeenCalledWith(OTHER);
      expect(revokeAllUserRefreshTokens).toHaveBeenCalledWith(OTHER);
      expect(published).toContainEqual({
        channel: 'cache_invalidate',
        message: JSON.stringify({ kind: 'active', userId: OTHER }),
      });
      expect(auditCall()).toMatchObject({ entityId: OTHER, action: 'deleted', before: row });
    });
  });

  // ------------------------------------------------------- resend-invite

  describe('POST /users/:id/resend-invite', () => {
    it('returns 404 for an unknown user', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: `/users/${OTHER}/resend-invite`,
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('USER_NOT_FOUND');
    });

    it('returns 403 ACCOUNT_DISABLED for an inactive user without creating a token', async () => {
      setupDbResults([{ id: OTHER, email: 'op@example.com', isActive: false, language: 'en' }]);
      const res = await app.inject({
        method: 'POST',
        url: `/users/${OTHER}/resend-invite`,
        headers: auth,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('ACCOUNT_DISABLED');
      expect(opsFor('insert', 'userTokens')).toHaveLength(0);
      expect(dispatchSystemNotification).not.toHaveBeenCalled();
    });

    it('revokes open setup tokens, stores a new one and sends it in the user language', async () => {
      setupDbResults([
        {
          id: OTHER,
          email: 'op@example.com',
          phone: '+1',
          firstName: 'Op',
          lastName: null,
          isActive: true,
          language: 'es',
        },
      ]);
      const res = await app.inject({
        method: 'POST',
        url: `/users/${OTHER}/resend-invite`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(argOf(opsFor('update', 'userTokens')[0], 'where')).toEqual([
        'and',
        ['eq', 'userTokens.userId', OTHER],
        ['eq', 'userTokens.type', 'password_reset'],
        ['isNull', 'userTokens.revokedAt'],
      ]);
      const inserted = argOf(opsFor('insert', 'userTokens')[0], 'values') as Record<
        string,
        unknown
      >;
      const notify = vi.mocked(dispatchSystemNotification).mock.calls[0];
      expect(notify?.[1]).toBe('operator.UserCreated');
      expect(notify?.[2]).toEqual({
        email: 'op@example.com',
        phone: '+1',
        userId: OTHER,
        language: 'es',
      });
      const vars = notify?.[3] as Record<string, string>;
      expect(vars['setPasswordUrl']).toMatch(
        /^https:\/\/csms\.example\.com\/reset-password\?token=/,
      );
      const raw = /token=([0-9a-f]{64})$/.exec(vars['setPasswordUrl'] ?? '')?.[1] ?? '';
      expect(inserted['tokenHash']).toBe(hashUserToken(raw));
    });
  });

  // --------------------------------------------------------- MFA verify

  describe('POST /auth/mfa/verify', () => {
    function mfaToken(extra: Record<string, unknown> = { mfaPending: true }): string {
      return app.jwt.sign({ userId: OTHER, roleId: ROLE, ...extra });
    }

    it('returns 401 MFA_TOKEN_EXPIRED for an invalid token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        payload: { mfaToken: 'not-a-jwt', code: '123456' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('MFA_TOKEN_EXPIRED');
    });

    it('returns 400 MFA_TOKEN_INVALID for a regular access token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        payload: { mfaToken: mfaToken({}), code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_TOKEN_INVALID');
      expect(state.ops).toHaveLength(0);
    });

    it('returns 400 MFA_CHALLENGE_EXHAUSTED once the challenge is locked out', async () => {
      vi.mocked(isMfaChallengeExhausted).mockReturnValue(true);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        payload: { mfaToken: mfaToken(), code: '123456', challengeId: 9 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_CHALLENGE_EXHAUSTED');
      expect(isMfaChallengeExhausted).toHaveBeenCalledWith(9);
      expect(verifyMfaChallenge).not.toHaveBeenCalled();
    });

    it('returns 400 MFA_NOT_CONFIGURED when the user has MFA off', async () => {
      setupDbResults([fullUser({ mfaEnabled: false })]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        payload: { mfaToken: mfaToken(), code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_NOT_CONFIGURED');
    });

    it('returns 403 ACCOUNT_DISABLED for an inactive MFA user', async () => {
      setupDbResults([fullUser({ mfaEnabled: true, mfaMethod: 'totp', isActive: false })]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        payload: { mfaToken: mfaToken(), code: '123456' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('ACCOUNT_DISABLED');
    });

    it('returns 400 TOTP_NOT_CONFIGURED when no TOTP secret is stored', async () => {
      setupDbResults([fullUser({ mfaEnabled: true, mfaMethod: 'totp', totpSecretEnc: null })]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        payload: { mfaToken: mfaToken(), code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('TOTP_NOT_CONFIGURED');
    });

    it('treats an undecryptable TOTP secret as an invalid code', async () => {
      setupDbResults([fullUser({ mfaEnabled: true, mfaMethod: 'totp', totpSecretEnc: 'bad' })]);
      vi.mocked(decryptString).mockImplementation(() => {
        throw new Error('bad key');
      });
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        payload: { mfaToken: mfaToken(), code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_CODE_INVALID');
      expect(verifyTotpCode).not.toHaveBeenCalled();
      expect(createRefreshToken).not.toHaveBeenCalled();
    });

    it('completes login with a valid TOTP code', async () => {
      setupDbResults(
        [fullUser({ mfaEnabled: true, mfaMethod: 'totp', totpSecretEnc: 'cipher' })],
        [{ id: ROLE, name: 'admin' }],
        [],
      );
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        payload: { mfaToken: mfaToken(), code: '123456' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.role).toEqual({ id: ROLE, name: 'admin' });
      expect(body.user).toMatchObject({ id: OTHER, email: 'op@example.com' });
      const decoded = app.jwt.verify<Record<string, unknown>>(body.token as string);
      expect(decoded['mfaPending']).toBeUndefined();
      expect(decoded['userId']).toBe(OTHER);
      expect(decryptString).toHaveBeenCalledWith('cipher', 'test-encryption-key');
      expect(verifyTotpCode).toHaveBeenCalledWith('dec(cipher)', '123456');
      expect(cookieNames(res)).toEqual(expect.arrayContaining(['csms_token', 'csms_refresh']));
      expect(argOf(opsFor('update', 'users')[0], 'set')).toEqual({
        lastLoginAt: expect.any(Date),
      });
      expect(clearMfaChallengeAttempts).not.toHaveBeenCalled();
    });

    it('records a failed attempt for a wrong email code', async () => {
      setupDbResults([fullUser({ mfaEnabled: true, mfaMethod: 'email' })]);
      vi.mocked(verifyMfaChallenge).mockResolvedValue(false);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        payload: { mfaToken: mfaToken(), code: '000000', challengeId: 5 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_CODE_INVALID');
      expect(verifyMfaChallenge).toHaveBeenCalledWith(client, 5, '000000', { userId: OTHER });
      expect(recordMfaChallengeAttempt).toHaveBeenCalledWith(5);
      expect(createRefreshToken).not.toHaveBeenCalled();
    });

    it('rejects an email-method code sent without a challengeId', async () => {
      setupDbResults([fullUser({ mfaEnabled: true, mfaMethod: 'email' })]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        payload: { mfaToken: mfaToken(), code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_CODE_INVALID');
      expect(verifyMfaChallenge).not.toHaveBeenCalled();
      expect(recordMfaChallengeAttempt).not.toHaveBeenCalled();
    });

    it('clears the attempt counter and returns role null after a valid SMS code', async () => {
      setupDbResults([fullUser({ mfaEnabled: true, mfaMethod: 'sms' })], [], []);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        payload: { mfaToken: mfaToken(), code: '123456', challengeId: 5 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().role).toBeNull();
      expect(clearMfaChallengeAttempts).toHaveBeenCalledWith(5);
      expect(createRefreshToken).toHaveBeenCalledWith({ userId: OTHER });
    });
  });

  // --------------------------------------------------------- MFA resend

  describe('POST /auth/mfa/resend', () => {
    function mfaToken(extra: Record<string, unknown> = { mfaPending: true }): string {
      return app.jwt.sign({ userId: OTHER, roleId: ROLE, ...extra });
    }

    it('returns 401 MFA_TOKEN_EXPIRED for an invalid token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/resend',
        payload: { mfaToken: 'garbage' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('MFA_TOKEN_EXPIRED');
    });

    it('returns 400 MFA_TOKEN_INVALID for a token without mfaPending', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/resend',
        payload: { mfaToken: mfaToken({}) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_TOKEN_INVALID');
    });

    it('returns 400 MFA_NOT_CONFIGURED for an unknown user', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/resend',
        payload: { mfaToken: mfaToken() },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_NOT_CONFIGURED');
    });

    it('returns 400 MFA_TOTP_NO_RESEND for TOTP users', async () => {
      setupDbResults([fullUser({ mfaEnabled: true, mfaMethod: 'totp' })]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/resend',
        payload: { mfaToken: mfaToken() },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_TOTP_NO_RESEND');
      expect(createMfaChallenge).not.toHaveBeenCalled();
    });

    it('creates a new challenge and sends the code', async () => {
      setupDbResults([fullUser({ mfaEnabled: true, mfaMethod: 'sms', phone: null })]);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/mfa/resend',
        payload: { mfaToken: mfaToken() },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ challengeId: 42 });
      expect(createMfaChallenge).toHaveBeenCalledWith(client, { userId: OTHER, method: 'sms' });
      expect(dispatchSystemNotification).toHaveBeenCalledWith(
        client,
        'mfa.VerificationCode',
        { email: 'op@example.com', phone: undefined, firstName: 'Op', language: 'de' },
        { code: '654321' },
        expect.any(String),
      );
    });
  });

  // ------------------------------------------------------ MFA profile

  describe('MFA profile endpoints', () => {
    it('GET /users/me/mfa lists only the enabled methods', async () => {
      vi.mocked(getMfaConfig).mockResolvedValue({
        emailEnabled: false,
        totpEnabled: true,
        smsEnabled: true,
      });
      setupDbResults([{ mfaEnabled: true, mfaMethod: 'totp' }]);
      const res = await app.inject({ method: 'GET', url: '/users/me/mfa', headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        mfaEnabled: true,
        mfaMethod: 'totp',
        availableMethods: ['totp', 'sms'],
      });
    });

    it('GET /users/me/mfa defaults to disabled when the user row is missing', async () => {
      vi.mocked(getMfaConfig).mockResolvedValue({
        emailEnabled: true,
        totpEnabled: false,
        smsEnabled: false,
      });
      setupDbResults([]);
      const res = await app.inject({ method: 'GET', url: '/users/me/mfa', headers: auth });
      expect(res.json()).toEqual({
        mfaEnabled: false,
        mfaMethod: null,
        availableMethods: ['email'],
      });
    });

    it('setup returns 403 MFA_METHOD_DISABLED for a disabled method', async () => {
      vi.mocked(getMfaConfig).mockResolvedValue({
        emailEnabled: true,
        totpEnabled: false,
        smsEnabled: false,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/mfa/setup',
        headers: auth,
        payload: { method: 'sms' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('MFA_METHOD_DISABLED');
      expect(state.ops).toHaveLength(0);
    });

    it('setup returns 400 USER_NOT_FOUND for a missing user', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/mfa/setup',
        headers: auth,
        payload: { method: 'email' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('USER_NOT_FOUND');
    });

    it('setup returns 409 MFA_ALREADY_ENABLED without overwriting the live secret', async () => {
      setupDbResults([{ email: 'op@example.com', mfaEnabled: true, language: 'en' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/mfa/setup',
        headers: auth,
        payload: { method: 'totp' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('MFA_ALREADY_ENABLED');
      expect(opsFor('update', 'users')).toHaveLength(0);
    });

    it('TOTP setup stores the encrypted secret and returns a QR data URI', async () => {
      setupDbResults([{ email: 'op@example.com', mfaEnabled: false, language: 'en' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/mfa/setup',
        headers: auth,
        payload: { method: 'totp' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.secret).toBe('JBSWY3DPEHPK3PXP');
      expect(body.qrDataUri).toMatch(/^data:image\/png;base64,/);
      const update = opsFor('update', 'users')[0];
      expect(argOf(update, 'set')).toEqual({
        totpSecretEnc: 'enc(JBSWY3DPEHPK3PXP)',
        updatedAt: expect.any(Date),
      });
      expect(argOf(update, 'where')).toEqual(['eq', 'users.id', ME]);
      expect(createMfaChallenge).not.toHaveBeenCalled();
    });

    it('email setup sends a verification code and returns the challenge id', async () => {
      setupDbResults([
        {
          email: 'op@example.com',
          phone: null,
          firstName: null,
          mfaEnabled: false,
          language: 'en',
        },
      ]);
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/mfa/setup',
        headers: auth,
        payload: { method: 'email' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ challengeId: 42 });
      expect(createMfaChallenge).toHaveBeenCalledWith(client, { userId: ME, method: 'email' });
      expect(dispatchSystemNotification).toHaveBeenCalledWith(
        client,
        'mfa.VerificationCode',
        { email: 'op@example.com', phone: undefined, firstName: undefined, language: 'en' },
        { code: '654321' },
        expect.any(String),
      );
      expect(opsFor('update', 'users')).toHaveLength(0);
    });

    it('confirm returns 403 for a disabled method', async () => {
      vi.mocked(getMfaConfig).mockResolvedValue({
        emailEnabled: false,
        totpEnabled: false,
        smsEnabled: false,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/mfa/confirm',
        headers: auth,
        payload: { method: 'totp', code: '123456' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('MFA_METHOD_DISABLED');
    });

    it('confirm returns 400 TOTP_NOT_CONFIGURED before setup', async () => {
      setupDbResults([{ totpSecretEnc: null }]);
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/mfa/confirm',
        headers: auth,
        payload: { method: 'totp', code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('TOTP_NOT_CONFIGURED');
    });

    it('confirm treats an undecryptable secret as an invalid code', async () => {
      setupDbResults([{ totpSecretEnc: 'bad' }]);
      vi.mocked(decryptString).mockImplementation(() => {
        throw new Error('bad');
      });
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/mfa/confirm',
        headers: auth,
        payload: { method: 'totp', code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_CODE_INVALID');
      expect(opsFor('update', 'users')).toHaveLength(0);
    });

    it('confirm enables TOTP, revokes sessions and audits mfa_enabled', async () => {
      setupDbResults([{ totpSecretEnc: 'cipher' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/mfa/confirm',
        headers: auth,
        payload: { method: 'totp', code: '123456' },
      });
      expect(res.statusCode).toBe(200);
      expect(verifyTotpCode).toHaveBeenCalledWith('dec(cipher)', '123456');
      expect(argOf(opsFor('update', 'users')[0], 'set')).toEqual({
        mfaEnabled: true,
        mfaMethod: 'totp',
        updatedAt: expect.any(Date),
      });
      expect(revokeAllUserSessions).toHaveBeenCalledWith(ME);
      expect(auditCall()).toMatchObject({
        entityId: ME,
        action: 'mfa_enabled',
        after: { mfaMethod: 'totp' },
      });
    });

    it('confirm verifies an SMS code against its challenge', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/mfa/confirm',
        headers: auth,
        payload: { method: 'sms', code: '123456', challengeId: 3 },
      });
      expect(res.statusCode).toBe(200);
      expect(verifyMfaChallenge).toHaveBeenCalledWith(client, 3, '123456', { userId: ME });
      expect(argOf(opsFor('update', 'users')[0], 'set')).toMatchObject({ mfaMethod: 'sms' });
    });

    it('confirm rejects a wrong SMS code without enabling MFA', async () => {
      vi.mocked(verifyMfaChallenge).mockResolvedValue(false);
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/mfa/confirm',
        headers: auth,
        payload: { method: 'email', code: '123456', challengeId: 3 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('MFA_CODE_INVALID');
      expect(opsFor('update', 'users')).toHaveLength(0);
      expect(revokeAllUserSessions).not.toHaveBeenCalled();
    });

    it('confirm rejects an email code without a challengeId', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/users/me/mfa/confirm',
        headers: auth,
        payload: { method: 'email', code: '123456' },
      });
      expect(res.statusCode).toBe(400);
      expect(verifyMfaChallenge).not.toHaveBeenCalled();
    });

    it('disable returns 400 USER_NOT_FOUND for a missing user', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/users/me/mfa',
        headers: auth,
        payload: { password: 'x' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('USER_NOT_FOUND');
    });

    it('disable returns 400 INVALID_PASSWORD for a wrong password', async () => {
      setupDbResults([{ passwordHash: 'h', mfaEnabled: true, mfaMethod: 'totp' }]);
      vi.mocked(argon2.verify).mockResolvedValue(false);
      const res = await app.inject({
        method: 'DELETE',
        url: '/users/me/mfa',
        headers: auth,
        payload: { password: 'wrong' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_PASSWORD');
      expect(opsFor('update', 'users')).toHaveLength(0);
    });

    it('disable clears MFA fields, revokes sessions and audits the before state', async () => {
      setupDbResults([{ passwordHash: 'h', mfaEnabled: true, mfaMethod: 'email' }]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/users/me/mfa',
        headers: auth,
        payload: { password: 'Correct1' },
      });
      expect(res.statusCode).toBe(200);
      expect(argon2.verify).toHaveBeenCalledWith('h', 'Correct1');
      expect(argOf(opsFor('update', 'users')[0], 'set')).toEqual({
        mfaEnabled: false,
        mfaMethod: null,
        totpSecretEnc: null,
        updatedAt: expect.any(Date),
      });
      expect(revokeAllUserSessions).toHaveBeenCalledWith(ME);
      expect(auditCall()).toMatchObject({
        action: 'mfa_disabled',
        before: { mfaEnabled: true, mfaMethod: 'email' },
        after: { mfaEnabled: false, mfaMethod: null },
      });
    });
  });

  // -------------------------------------------- notification preferences

  describe('notification preferences', () => {
    it('GET defaults smsEnabled to true without a stored row', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: '/users/me/notification-preferences',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ smsEnabled: true });
    });

    it('GET returns the stored preference', async () => {
      setupDbResults([{ userId: ME, smsEnabled: false }]);
      const res = await app.inject({
        method: 'GET',
        url: '/users/me/notification-preferences',
        headers: auth,
      });
      expect(res.json()).toEqual({ smsEnabled: false });
      expect(argOf(opsFor('select', 'userNotificationPreferences')[0], 'where')).toEqual([
        'eq',
        'userNotificationPreferences.userId',
        ME,
      ]);
    });

    it('PUT upserts the preference for the caller', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/users/me/notification-preferences',
        headers: auth,
        payload: { smsEnabled: false },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ smsEnabled: false });
      const op = opsFor('insert', 'userNotificationPreferences')[0];
      expect(argOf(op, 'values')).toEqual({ userId: ME, smsEnabled: false });
      expect(argOf(op, 'onConflictDoUpdate')).toEqual({
        target: ['userNotificationPreferences.userId'],
        set: { smsEnabled: false, updatedAt: expect.any(Date) },
      });
    });

    it('PUT rejects a non-boolean body', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/users/me/notification-preferences',
        headers: auth,
        payload: { smsEnabled: 'maybe' },
      });
      expect(res.statusCode).toBe(400);
      expect(state.ops).toHaveLength(0);
    });
  });

  // -------------------------------------------------- chatbot AI config

  describe('chatbot AI config', () => {
    const empty = {
      configured: false,
      provider: null,
      apiKey: null,
      model: null,
      temperature: null,
      topP: null,
      topK: null,
      systemPrompt: null,
    };

    it('GET reports not configured without a row', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: '/users/me/chatbot-ai-config',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(empty);
    });

    it('GET reports not configured for a cleared row kept for support AI', async () => {
      setupDbResults([{ provider: '', apiKeyEnc: '' }]);
      const res = await app.inject({
        method: 'GET',
        url: '/users/me/chatbot-ai-config',
        headers: auth,
      });
      expect(res.json()).toEqual(empty);
      expect(decryptString).not.toHaveBeenCalled();
    });

    it('GET decrypts the key and converts numeric strings', async () => {
      setupDbResults([
        {
          provider: 'anthropic',
          apiKeyEnc: 'cipher',
          model: 'claude-x',
          temperature: '0.7',
          topP: '0.9',
          topK: 40,
          systemPrompt: 'Be brief',
        },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/users/me/chatbot-ai-config',
        headers: auth,
      });
      expect(res.json()).toEqual({
        configured: true,
        provider: 'anthropic',
        apiKey: 'dec(cipher)',
        model: 'claude-x',
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        systemPrompt: 'Be brief',
      });
    });

    it('GET returns a null key and null optionals when the encryption key is empty', async () => {
      state.cfg['SETTINGS_ENCRYPTION_KEY'] = '';
      setupDbResults([
        {
          provider: 'openai',
          apiKeyEnc: 'cipher',
          model: null,
          temperature: null,
          topP: null,
          topK: null,
          systemPrompt: null,
        },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/users/me/chatbot-ai-config',
        headers: auth,
      });
      expect(res.json()).toEqual({ ...empty, configured: true, provider: 'openai' });
      expect(decryptString).not.toHaveBeenCalled();
    });

    it('PUT encrypts the key and upserts all fields', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/users/me/chatbot-ai-config',
        headers: auth,
        payload: {
          provider: 'gemini',
          apiKey: 'sk-plain',
          model: 'g-1',
          temperature: 1.5,
          topP: 0.5,
          topK: 10,
          systemPrompt: 'Hi',
        },
      });
      expect(res.statusCode).toBe(200);
      const op = opsFor('insert', 'chatbotAiConfigs')[0];
      const expected = {
        provider: 'gemini',
        apiKeyEnc: 'enc(sk-plain)',
        model: 'g-1',
        temperature: '1.5',
        topP: '0.5',
        topK: 10,
        systemPrompt: 'Hi',
        updatedAt: expect.any(Date),
      };
      expect(argOf(op, 'values')).toEqual({ userId: ME, ...expected });
      expect(argOf(op, 'onConflictDoUpdate')).toEqual({
        target: 'chatbotAiConfigs.userId',
        set: expected,
      });
    });

    it('PUT stores nulls for omitted optional fields', async () => {
      await app.inject({
        method: 'PUT',
        url: '/users/me/chatbot-ai-config',
        headers: auth,
        payload: { provider: 'openai', apiKey: 'k' },
      });
      expect(argOf(opsFor('insert', 'chatbotAiConfigs')[0], 'values')).toMatchObject({
        model: null,
        temperature: null,
        topP: null,
        topK: null,
        systemPrompt: null,
      });
    });

    it('PUT fails with 500 and stores nothing when the encryption key is empty', async () => {
      state.cfg['SETTINGS_ENCRYPTION_KEY'] = '';
      const res = await app.inject({
        method: 'PUT',
        url: '/users/me/chatbot-ai-config',
        headers: auth,
        payload: { provider: 'openai', apiKey: 'k' },
      });
      expect(res.statusCode).toBe(500);
      expect(state.ops).toHaveLength(0);
    });

    it('PUT rejects a temperature above 2', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/users/me/chatbot-ai-config',
        headers: auth,
        payload: { provider: 'openai', apiKey: 'k', temperature: 2.5 },
      });
      expect(res.statusCode).toBe(400);
      expect(state.ops).toHaveLength(0);
    });

    it('DELETE is a no-op without a row', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/users/me/chatbot-ai-config',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(opsFor('delete', 'chatbotAiConfigs')).toHaveLength(0);
      expect(opsFor('update', 'chatbotAiConfigs')).toHaveLength(0);
    });

    it('DELETE drops the row when no support AI config shares it', async () => {
      setupDbResults([{ supportAiApiKeyEnc: '' }]);
      await app.inject({ method: 'DELETE', url: '/users/me/chatbot-ai-config', headers: auth });
      expect(argOf(opsFor('delete', 'chatbotAiConfigs')[0], 'where')).toEqual([
        'eq',
        'chatbotAiConfigs.userId',
        ME,
      ]);
      expect(opsFor('update', 'chatbotAiConfigs')).toHaveLength(0);
    });

    it('DELETE blanks only the chatbot columns when a support AI config exists', async () => {
      setupDbResults([{ supportAiApiKeyEnc: 'support-cipher' }]);
      await app.inject({ method: 'DELETE', url: '/users/me/chatbot-ai-config', headers: auth });
      expect(opsFor('delete', 'chatbotAiConfigs')).toHaveLength(0);
      expect(argOf(opsFor('update', 'chatbotAiConfigs')[0], 'set')).toEqual({
        provider: '',
        apiKeyEnc: '',
        model: null,
        temperature: null,
        topP: null,
        topK: null,
        systemPrompt: null,
        updatedAt: expect.any(Date),
      });
    });
  });

  // --------------------------------------------------- support AI config

  describe('support AI config', () => {
    const empty = {
      configured: false,
      provider: null,
      apiKey: null,
      model: null,
      temperature: null,
      topP: null,
      topK: null,
      systemPrompt: null,
      tone: null,
    };

    it('GET reports not configured without a row', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: '/users/me/support-ai-config',
        headers: auth,
      });
      expect(res.json()).toEqual(empty);
    });

    it('GET reports not configured when only the chatbot config exists', async () => {
      setupDbResults([{ supportAiProvider: null, supportAiApiKeyEnc: null }]);
      const res = await app.inject({
        method: 'GET',
        url: '/users/me/support-ai-config',
        headers: auth,
      });
      expect(res.json()).toEqual(empty);
    });

    it('GET decrypts the support key and converts numbers', async () => {
      setupDbResults([
        {
          supportAiProvider: 'anthropic',
          supportAiApiKeyEnc: 'scipher',
          supportAiModel: 'm',
          supportAiTemperature: '0.2',
          supportAiTopP: '1',
          supportAiTopK: 5,
          supportAiSystemPrompt: 'sp',
          supportAiTone: 'formal',
        },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/users/me/support-ai-config',
        headers: auth,
      });
      expect(res.json()).toEqual({
        configured: true,
        provider: 'anthropic',
        apiKey: 'dec(scipher)',
        model: 'm',
        temperature: 0.2,
        topP: 1,
        topK: 5,
        systemPrompt: 'sp',
        tone: 'formal',
      });
    });

    it('GET returns a null key when the stored support key is empty', async () => {
      setupDbResults([
        {
          supportAiProvider: 'openai',
          supportAiApiKeyEnc: '',
          supportAiModel: null,
          supportAiTemperature: null,
          supportAiTopP: null,
          supportAiTopK: null,
          supportAiSystemPrompt: null,
          supportAiTone: null,
        },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/users/me/support-ai-config',
        headers: auth,
      });
      expect(res.json()).toEqual({ ...empty, configured: true, provider: 'openai' });
      expect(decryptString).not.toHaveBeenCalled();
    });

    it('PUT updates only support columns on an existing row', async () => {
      setupDbResults([{ id: 1 }]);
      const res = await app.inject({
        method: 'PUT',
        url: '/users/me/support-ai-config',
        headers: auth,
        payload: { provider: 'openai', apiKey: 'sk', tone: 'friendly', temperature: 0 },
      });
      expect(res.statusCode).toBe(200);
      expect(opsFor('insert', 'chatbotAiConfigs')).toHaveLength(0);
      const op = opsFor('update', 'chatbotAiConfigs')[0];
      expect(argOf(op, 'set')).toEqual({
        supportAiProvider: 'openai',
        supportAiApiKeyEnc: 'enc(sk)',
        supportAiModel: null,
        supportAiTemperature: '0',
        supportAiTopP: null,
        supportAiTopK: null,
        supportAiSystemPrompt: null,
        supportAiTone: 'friendly',
        updatedAt: expect.any(Date),
      });
      expect(argOf(op, 'where')).toEqual(['eq', 'chatbotAiConfigs.userId', ME]);
    });

    it('PUT inserts a row with an empty chatbot key when none exists', async () => {
      setupDbResults([]);
      await app.inject({
        method: 'PUT',
        url: '/users/me/support-ai-config',
        headers: auth,
        payload: {
          provider: 'gemini',
          apiKey: 'sk',
          model: 'gm',
          topP: 0.3,
          topK: 2,
          systemPrompt: 'x',
        },
      });
      expect(argOf(opsFor('insert', 'chatbotAiConfigs')[0], 'values')).toEqual({
        userId: ME,
        provider: 'gemini',
        apiKeyEnc: '',
        supportAiProvider: 'gemini',
        supportAiApiKeyEnc: 'enc(sk)',
        supportAiModel: 'gm',
        supportAiTemperature: null,
        supportAiTopP: '0.3',
        supportAiTopK: 2,
        supportAiSystemPrompt: 'x',
        supportAiTone: null,
        updatedAt: expect.any(Date),
      });
    });

    it('PUT fails with 500 when the encryption key is empty', async () => {
      state.cfg['SETTINGS_ENCRYPTION_KEY'] = '';
      const res = await app.inject({
        method: 'PUT',
        url: '/users/me/support-ai-config',
        headers: auth,
        payload: { provider: 'openai', apiKey: 'sk' },
      });
      expect(res.statusCode).toBe(500);
      expect(state.ops).toHaveLength(0);
    });

    it('PUT rejects an unknown tone', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/users/me/support-ai-config',
        headers: auth,
        payload: { provider: 'openai', apiKey: 'sk', tone: 'sarcastic' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('DELETE is a no-op without a row', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/users/me/support-ai-config',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(opsFor('delete', 'chatbotAiConfigs')).toHaveLength(0);
      expect(opsFor('update', 'chatbotAiConfigs')).toHaveLength(0);
    });

    it('DELETE drops the row when the chatbot config is empty', async () => {
      setupDbResults([{ provider: 'openai', apiKeyEnc: '' }]);
      await app.inject({ method: 'DELETE', url: '/users/me/support-ai-config', headers: auth });
      expect(opsFor('delete', 'chatbotAiConfigs')).toHaveLength(1);
      expect(opsFor('update', 'chatbotAiConfigs')).toHaveLength(0);
    });

    it('DELETE clears only the support columns when a chatbot config exists', async () => {
      setupDbResults([{ provider: 'openai', apiKeyEnc: 'cipher' }]);
      await app.inject({ method: 'DELETE', url: '/users/me/support-ai-config', headers: auth });
      expect(opsFor('delete', 'chatbotAiConfigs')).toHaveLength(0);
      expect(argOf(opsFor('update', 'chatbotAiConfigs')[0], 'set')).toEqual({
        supportAiProvider: null,
        supportAiApiKeyEnc: null,
        supportAiModel: null,
        supportAiTemperature: null,
        supportAiTopP: null,
        supportAiTopK: null,
        supportAiSystemPrompt: null,
        supportAiTone: null,
        updatedAt: expect.any(Date),
      });
    });
  });

  // --------------------------------------------------------- permissions

  describe('permission endpoints', () => {
    it('GET /permissions returns the permission group catalog', async () => {
      const res = await app.inject({ method: 'GET', url: '/permissions', headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
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
      ]);
    });

    it('GET /users/me/permissions returns the caller permissions', async () => {
      setupDbResults([{ permission: 'users:read' }, { permission: 'stations:read' }]);
      const res = await app.inject({ method: 'GET', url: '/users/me/permissions', headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(['users:read', 'stations:read']);
      expect(argOf(opsFor('select', 'userPermissions')[0], 'where')).toEqual([
        'eq',
        'userPermissions.userId',
        ME,
      ]);
    });

    it('GET /users/:id/permissions returns 404 for an unknown user', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: `/users/${OTHER}/permissions`,
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('USER_NOT_FOUND');
      expect(opsFor('select', 'userPermissions')).toHaveLength(0);
    });

    it('GET /users/:id/permissions returns the user permissions', async () => {
      setupDbResults([{ id: OTHER }], [{ permission: 'stations:write' }]);
      const res = await app.inject({
        method: 'GET',
        url: `/users/${OTHER}/permissions`,
        headers: auth,
      });
      expect(res.json()).toEqual(['stations:write']);
    });

    it('PUT /users/:id/permissions refuses to edit the caller', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/users/${ME}/permissions`,
        headers: auth,
        payload: { permissions: [] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('SELF_EDIT_FORBIDDEN');
      expect(state.ops).toHaveLength(0);
    });

    it('PUT /users/:id/permissions returns 404 for an unknown user', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'PUT',
        url: `/users/${OTHER}/permissions`,
        headers: auth,
        payload: { permissions: ['users:read'] },
      });
      expect(res.statusCode).toBe(404);
      expect(opsFor('delete', 'userPermissions')).toHaveLength(0);
    });

    it('PUT /users/:id/permissions rejects permissions outside the catalog', async () => {
      setupDbResults([{ id: OTHER }]);
      const res = await app.inject({
        method: 'PUT',
        url: `/users/${OTHER}/permissions`,
        headers: auth,
        payload: { permissions: ['users:read', 'root:everything', 'x:y'] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Invalid permissions: root:everything, x:y',
        code: 'INVALID_PERMISSIONS',
      });
      expect(opsFor('delete', 'userPermissions')).toHaveLength(0);
    });

    it('PUT /users/:id/permissions replaces the set, clears the cache and audits', async () => {
      setupDbResults([{ id: OTHER }], [{ permission: 'stations:read' }]);
      const res = await app.inject({
        method: 'PUT',
        url: `/users/${OTHER}/permissions`,
        headers: auth,
        payload: { permissions: ['users:read', 'stations:write'] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(['users:read', 'stations:write']);
      expect(argOf(opsFor('delete', 'userPermissions')[0], 'where')).toEqual([
        'eq',
        'userPermissions.userId',
        OTHER,
      ]);
      expect(argOf(opsFor('insert', 'userPermissions')[0], 'values')).toEqual([
        { userId: OTHER, permission: 'users:read' },
        { userId: OTHER, permission: 'stations:write' },
      ]);
      expect(invalidatePermissionCache).toHaveBeenCalledWith(OTHER);
      expect(auditCall()).toMatchObject({
        entityId: OTHER,
        action: 'permissions_changed',
        before: { permissions: ['stations:read'] },
        after: { permissions: ['users:read', 'stations:write'] },
      });
    });

    it('PUT /users/:id/permissions with an empty list deletes without inserting', async () => {
      setupDbResults([{ id: OTHER }], []);
      const res = await app.inject({
        method: 'PUT',
        url: `/users/${OTHER}/permissions`,
        headers: auth,
        payload: { permissions: [] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      expect(opsFor('delete', 'userPermissions')).toHaveLength(1);
      expect(opsFor('insert', 'userPermissions')).toHaveLength(0);
    });
  });
});
