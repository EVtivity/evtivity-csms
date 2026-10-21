// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import type { FastifyInstance } from 'fastify';

// DB mock helpers
let dbResults: unknown[][] = [];
let dbCallIndex = 0;
function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}
function makeChain() {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
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
    'delete',
    'insert',
    'update',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const r = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(r).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  chain['catch'] = (reject?: (r: unknown) => unknown) => Promise.resolve([]).catch(reject);
  return chain;
}

const {
  mockGetSsoConfig,
  mockGenerateId,
  mockGetAuthorizeUrlAsync,
  mockValidatePostResponseAsync,
  mockCreateRefreshToken,
  mockSetAuthCookies,
  mockCreateMfaChallenge,
  mockDispatchSystemNotification,
  mockSamlOptions,
  mockConsumeRead,
  mockBindingMatches,
  mockCacheBinding,
  mockSecureRequest,
} = vi.hoisted(() => ({
  mockSecureRequest: vi.fn(() => false),
  mockSamlOptions: vi.fn(),
  mockConsumeRead: vi.fn(() => Promise.resolve(true)),
  mockBindingMatches: vi.fn((_value: string | null) => Promise.resolve(true)),
  mockCacheBinding: vi.fn(),
  mockCreateMfaChallenge: vi.fn(),
  mockDispatchSystemNotification: vi.fn(),
  mockGetSsoConfig: vi.fn(),
  mockGenerateId: vi.fn(),
  mockGetAuthorizeUrlAsync: vi.fn(),
  mockValidatePostResponseAsync: vi.fn(),
  mockCreateRefreshToken: vi.fn(),
  mockSetAuthCookies: vi.fn(),
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
    consumeRecoveryCode: vi.fn(async () => ({ used: false, remaining: 0 })),
    issueRecoveryCodes: vi.fn(async () => []),
    deleteRecoveryCodes: vi.fn(async () => undefined),
    deleteWebauthnCredentials: vi.fn(async () => undefined),
  };
});
// When true, readMfaConfig answers the code defaults with fallback set: the settings read failed.
const mfaRead = vi.hoisted(() => ({ fails: false }));
vi.mock('@evtivity/database', () => ({
  readMfaConfig: async () => ({
    config: await (await import('@evtivity/database')).getMfaConfig(),
    fallback: mfaRead.fails,
  }),
  getSessionLifetimes: vi.fn(async () => ({
    ...(await import('@evtivity/lib/session-lifetimes')).DEFAULT_SESSION_LIFETIMES,
  })),
  writeAudit: vi.fn(() => Promise.resolve()),
  userAuditLog: { _table: 'user_audit_log' },
  driverAuditLog: { _table: 'driver_audit_log' },
  stationAuditLog: { _table: 'station_audit_log' },
  sessionAuditLog: { _table: 'session_audit_log' },
  apiKeyAuditLog: { _table: 'api_key_audit_log' },
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
      const { db } = await import('@evtivity/database');
      return fn(db);
    }),
  },
  users: {},
  roles: {},
  userPermissions: { _table: 'user_permissions' },
  getSsoConfig: mockGetSsoConfig,
  client: { name: 'sql-client' },
  getMfaConfig: vi.fn().mockResolvedValue({
    emailEnabled: true,
    totpEnabled: true,
    smsEnabled: false,
    required: 'off',
    requiredRoles: [],
    webauthnEnabled: true,
    passkeyLoginEnabled: false,
    requireDrivers: false,
  }),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  isNull: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
}));

vi.mock('@evtivity/lib', () => ({
  generateId: mockGenerateId,
  createRedisClient: vi.fn(),
  permissionCatalog: {
    defaultsFor: (role: string) => (role === 'operator' ? ['stations:read'] : []),
  },
  createMfaChallenge: mockCreateMfaChallenge,
  createCappedMfaChallenge: vi.fn(async (c: unknown, o: unknown) =>
    (await import('@evtivity/lib')).createMfaChallenge(c as never, o as never),
  ),
  isMfaChallengeLimited: (r: object) => 'limited' in r,
  dispatchSystemNotification: mockDispatchSystemNotification,
}));

vi.mock('@node-saml/node-saml', () => ({
  ValidateInResponseTo: { never: 'never', ifPresent: 'ifPresent', always: 'always' },
  SAML: class {
    constructor(options: unknown) {
      mockSamlOptions(options);
    }
    getAuthorizeUrlAsync(...args: unknown[]) {
      return mockGetAuthorizeUrlAsync(...args);
    }
    validatePostResponseAsync(...args: unknown[]) {
      return mockValidatePostResponseAsync(...args);
    }
  },
}));

// The real SAML client builder and domain check; a request cache whose
// single-use consume answers what the test sets.
vi.mock('../lib/saml-request-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/saml-request-cache.js')>()),
  RedisSamlRequestCache: class {
    constructor(_client?: unknown, binding: string | null = null) {
      mockCacheBinding(binding);
    }
    consumeRead() {
      return mockConsumeRead();
    }
    bindingMatches(value: string | null) {
      return mockBindingMatches(value);
    }
  },
}));

vi.mock('../services/refresh-token.service.js', () => ({
  createRefreshToken: mockCreateRefreshToken,
}));

vi.mock('../lib/auth-cookies.js', () => ({
  setAuthCookies: mockSetAuthCookies,
  isSecureRequest: () => mockSecureRequest(),
}));

import { getMfaConfig } from '@evtivity/database';
import { countRecoveryCodes } from '../services/mfa-factor.service.js';
import { registerAuth } from '../plugins/auth.js';
import { ssoAuthRoutes } from '../routes/sso-auth.js';
import { config as apiConfig } from '../lib/config.js';
import { DEFAULT_SESSION_LIFETIMES } from '@evtivity/lib/session-lifetimes';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie);
  await app.register(formbody);
  await registerAuth(app);
  ssoAuthRoutes(app);
  await app.ready();
  return app;
}

const SSO_CONFIG = {
  entryPoint: 'https://idp.example.com/sso',
  issuer: 'https://csms.example.com',
  cert: 'MIIC...',
  attributeMapping: { email: 'email', firstName: 'firstName', lastName: 'lastName' },
  autoProvision: false,
  defaultRoleId: '',
  allowedDomains: [] as string[],
};

describe('SSO auth routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  describe('GET /auth/sso/login', () => {
    it('returns 400 when SSO is disabled', async () => {
      mockGetSsoConfig.mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/auth/sso/login',
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body['code']).toBe('SSO_DISABLED');
    });

    it('returns redirect when SSO is enabled', async () => {
      mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
      mockGetAuthorizeUrlAsync.mockResolvedValue('https://idp.example.com/sso?SAMLRequest=xxx');

      const res = await app.inject({
        method: 'GET',
        url: '/auth/sso/login',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('https://idp.example.com/sso?SAMLRequest=xxx');
    });
    it('sends a well-formed state as RelayState and drops any other (security review Info 3)', async () => {
      mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
      mockGetAuthorizeUrlAsync.mockResolvedValue('https://idp.example.com/sso?SAMLRequest=xxx');
      const state = 'AbCdEfGhIjKlMnOpQrStUv_-12';
      await app.inject({ method: 'GET', url: `/auth/sso/login?state=${state}` });
      expect(mockGetAuthorizeUrlAsync).toHaveBeenLastCalledWith(state, expect.anything(), {});
      await app.inject({ method: 'GET', url: '/auth/sso/login?state=short' });
      expect(mockGetAuthorizeUrlAsync).toHaveBeenLastCalledWith('/', expect.anything(), {});
      await app.inject({ method: 'GET', url: '/auth/sso/login?state=has%20space%20in%20it%20yes' });
      expect(mockGetAuthorizeUrlAsync).toHaveBeenLastCalledWith('/', expect.anything(), {});
    });
  });

  describe('SSO browser binding (security review L1, login CSRF)', () => {
    const CALLBACK = {
      method: 'POST' as const,
      url: '/auth/sso/callback',
      payload: 'SAMLResponse=base64encodedresponse',
    };

    it('sets a random HttpOnly binding cookie and stores its hash with the request', async () => {
      mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
      mockGetAuthorizeUrlAsync.mockResolvedValue('https://idp.example.com/sso?SAMLRequest=xxx');
      const res = await app.inject({ method: 'GET', url: '/auth/sso/login' });
      const cookie = res.cookies.find((c) => c.name === 'csms_sso_binding');
      expect(cookie).toBeDefined();
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.path).toBe('/v1/auth/sso');
      expect(cookie?.maxAge).toBe(600);
      // Plain HTTP: no SameSite attribute (SameSite=None needs Secure).
      expect(cookie?.sameSite).toBeUndefined();
      expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const { samlBindingHash } = await import('../lib/saml-request-cache.js');
      expect(mockCacheBinding).toHaveBeenLastCalledWith(samlBindingHash(cookie!.value));
      const again = await app.inject({ method: 'GET', url: '/auth/sso/login' });
      expect(again.cookies.find((c) => c.name === 'csms_sso_binding')?.value).not.toBe(
        cookie?.value,
      );
    });

    it('binds the cookie to the API host over HTTPS without COOKIE_DOMAIN (__Host-)', async () => {
      mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
      mockGetAuthorizeUrlAsync.mockResolvedValue('https://idp.example.com/sso?SAMLRequest=xxx');
      mockSecureRequest.mockReturnValue(true);
      const domain = apiConfig.COOKIE_DOMAIN;
      delete apiConfig.COOKIE_DOMAIN;
      try {
        const res = await app.inject({ method: 'GET', url: '/auth/sso/login' });
        expect(res.cookies.find((c) => c.name === 'csms_sso_binding')).toBeUndefined();
        const cookie = res.cookies.find((c) => c.name === '__Host-csms_sso_binding');
        expect(cookie?.sameSite).toBe('None');
        expect(cookie?.secure).toBe(true);
        expect(cookie?.httpOnly).toBe(true);
        expect(cookie?.path).toBe('/');
        expect(cookie?.domain).toBeUndefined();
      } finally {
        mockSecureRequest.mockReturnValue(false);
        if (domain != null) apiConfig.COOKIE_DOMAIN = domain;
      }
    });

    it('keeps the domain cookie over HTTPS when COOKIE_DOMAIN is set', async () => {
      mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
      mockGetAuthorizeUrlAsync.mockResolvedValue('https://idp.example.com/sso?SAMLRequest=xxx');
      mockSecureRequest.mockReturnValue(true);
      const domain = apiConfig.COOKIE_DOMAIN;
      apiConfig.COOKIE_DOMAIN = 'example.com';
      try {
        const res = await app.inject({ method: 'GET', url: '/auth/sso/login' });
        const cookie = res.cookies.find((c) => c.name === 'csms_sso_binding');
        expect(cookie?.domain).toBe('example.com');
        expect(cookie?.path).toBe('/v1/auth/sso');
        expect(cookie?.sameSite).toBe('None');
        expect(cookie?.secure).toBe(true);
      } finally {
        mockSecureRequest.mockReturnValue(false);
        if (domain == null) delete apiConfig.COOKIE_DOMAIN;
        else apiConfig.COOKIE_DOMAIN = domain;
      }
    });

    it('ignores a cookie without the __Host- prefix over HTTPS (planted by a subdomain)', async () => {
      mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
      mockSecureRequest.mockReturnValue(true);
      const domain = apiConfig.COOKIE_DOMAIN;
      delete apiConfig.COOKIE_DOMAIN;
      try {
        const res = await app.inject({
          ...CALLBACK,
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            cookie: 'csms_sso_binding=planted-by-sibling',
          },
        });
        expect(res.headers['location']).toBe('/login?error=sso_session_mismatch');
        expect(mockValidatePostResponseAsync).not.toHaveBeenCalled();
        expect(mockBindingMatches).not.toHaveBeenCalled();
        const cleared = res.cookies.find((c) => c.name === '__Host-csms_sso_binding');
        expect(cleared?.value).toBe('');
        expect(cleared?.path).toBe('/');
      } finally {
        mockSecureRequest.mockReturnValue(false);
        if (domain != null) apiConfig.COOKIE_DOMAIN = domain;
      }
    });

    it('refuses a reply posted without the binding cookie before checking it', async () => {
      mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
      const res = await app.inject({
        ...CALLBACK,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('/login?error=sso_session_mismatch');
      expect(mockValidatePostResponseAsync).not.toHaveBeenCalled();
      expect(mockSetAuthCookies).not.toHaveBeenCalled();
    });

    it('refuses a reply of a sign-in another browser started, for every account path', async () => {
      mockGetSsoConfig.mockResolvedValue({ ...SSO_CONFIG, autoProvision: true });
      mockValidatePostResponseAsync.mockResolvedValue({
        profile: { email: 'attacker@example.com' },
      });
      mockBindingMatches.mockResolvedValueOnce(false);
      const res = await app.inject({
        ...CALLBACK,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: 'csms_sso_binding=victim-browser',
        },
      });
      expect(mockBindingMatches).toHaveBeenCalledWith('victim-browser');
      expect(res.headers['location']).toBe('/login?error=sso_session_mismatch');
      expect(mockSetAuthCookies).not.toHaveBeenCalled();
      expect(mockCreateRefreshToken).not.toHaveBeenCalled();
      // The cookie is cleared whatever the outcome.
      const cleared = res.cookies.find((c) => c.name === 'csms_sso_binding');
      expect(cleared?.value).toBe('');
    });
  });

  describe('SSO state and sign-in time (security review Info 3 and L4)', () => {
    const STATE = 'AbCdEfGhIjKlMnOpQrStUv_-12';

    it('puts the RelayState into the MFA fragment', async () => {
      mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
      mockValidatePostResponseAsync.mockResolvedValue({
        profile: { email: 'admin@example.com' },
      });
      vi.mocked(getMfaConfig).mockResolvedValueOnce({
        emailEnabled: true,
        totpEnabled: true,
        smsEnabled: false,
        required: 'all' as const,
        requiredRoles: [] as string[],
        webauthnEnabled: true,
        passkeyLoginEnabled: false,
        requireDrivers: false,
      });
      setupDbResults(
        [
          {
            id: 'usr_001',
            roleId: 'rol_001',
            isActive: true,
            email: 'admin@example.com',
            phone: null,
            firstName: 'Ada',
            language: 'en',
            mfaEnabled: false,
            mfaMethod: null,
            sessionVersion: 2,
          },
        ],
        [{ name: 'admin' }],
      );
      const res = await app.inject({
        method: 'POST',
        url: '/auth/sso/callback',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: 'csms_sso_binding=browser-binding',
        },
        payload: `SAMLResponse=base64encodedresponse&RelayState=${STATE}`,
      });
      const location = String(res.headers['location']);
      const params = new URLSearchParams(location.slice('/login#'.length));
      expect(params.get('ssoState')).toBe(STATE);
      expect(params.get('ssoMfaEnrollmentToken')).not.toBeNull();
    });

    it('stamps the SSO sign-in time on the session it issues', async () => {
      mockGetSsoConfig.mockResolvedValue({
        ...SSO_CONFIG,
        attributeMapping: { email: 'email', firstName: 'firstName', lastName: 'lastName' },
      });
      mockValidatePostResponseAsync.mockResolvedValue({
        profile: { email: 'test@example.com', firstName: 'Test', lastName: 'User' },
      });
      setupDbResults([{ id: 'usr_001', roleId: 'rol_001', isActive: true }], []);
      mockCreateRefreshToken.mockResolvedValue({ rawToken: 'refresh_xxx', expiresAt: new Date() });
      const before = Math.floor(Date.now() / 1000);
      await app.inject({
        method: 'POST',
        url: '/auth/sso/callback',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: 'csms_sso_binding=browser-binding',
        },
        payload: 'SAMLResponse=base64encodedresponse',
      });
      const token = mockSetAuthCookies.mock.calls.at(-1)?.[2] as string;
      const payload = app.jwt.verify<{ ssoAt?: number }>(token);
      expect(payload.ssoAt).toBeGreaterThanOrEqual(before);
      expect(payload.ssoAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    });
  });

  describe('POST /auth/sso/callback', () => {
    it('sets cookies and redirects for existing active user', async () => {
      mockGetSsoConfig.mockResolvedValue({
        ...SSO_CONFIG,
        attributeMapping: { email: 'email', firstName: 'firstName', lastName: 'lastName' },
      });
      mockValidatePostResponseAsync.mockResolvedValue({
        profile: { email: 'test@example.com', firstName: 'Test', lastName: 'User' },
      });

      // First query: user lookup returns existing active user
      // Second query: update lastLoginAt
      setupDbResults([{ id: 'usr_001', roleId: 'rol_001', isActive: true }], []);

      mockCreateRefreshToken.mockResolvedValue({
        rawToken: 'refresh_xxx',
        expiresAt: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/sso/callback',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: 'csms_sso_binding=browser-binding',
        },
        payload: 'SAMLResponse=base64encodedresponse',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('/');
      expect(mockSetAuthCookies).toHaveBeenCalled();
      expect(mockCreateRefreshToken).toHaveBeenCalledWith({
        userId: 'usr_001',
        lifetimeDays: DEFAULT_SESSION_LIFETIMES.operatorRefreshDays,
      });
      const { writeAudit } = await import('@evtivity/database');
      expect(vi.mocked(writeAudit)).toHaveBeenCalledWith(
        expect.objectContaining({ idColumn: 'user_id' }),
        expect.objectContaining({
          entityId: 'usr_001',
          action: 'login_succeeded',
          actor: 'operator',
          after: expect.objectContaining({ method: 'sso' }),
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it.each([
      ['email', 7, 'ssoMfaToken=', '&ssoMfaMethod=email&ssoMfaChallengeId=7&ssoMfaFactors=email'],
      ['totp', undefined, 'ssoMfaToken=', '&ssoMfaMethod=totp&ssoMfaFactors=totp'],
    ])(
      'hands a user with %s MFA to the MFA challenge instead of a session',
      async (method, challengeId, tokenPart, rest) => {
        mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
        mockValidatePostResponseAsync.mockResolvedValue({
          profile: { email: 'admin@example.com' },
        });
        // An all-site admin with MFA: the assertion alone must not sign it in.
        setupDbResults([
          {
            id: 'usr_001',
            roleId: 'rol_001',
            isActive: true,
            email: 'admin@example.com',
            phone: null,
            firstName: 'Ada',
            language: 'en',
            mfaEnabled: true,
            mfaMethod: method,
          },
        ]);
        mockCreateMfaChallenge.mockResolvedValue({ challengeId, code: '123456' });

        const res = await app.inject({
          method: 'POST',
          url: '/auth/sso/callback',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            cookie: 'csms_sso_binding=browser-binding',
          },
          payload: 'SAMLResponse=base64encodedresponse',
        });

        expect(res.statusCode).toBe(302);
        const location = String(res.headers['location']);
        expect(location.startsWith(`/login#${tokenPart}`)).toBe(true);
        expect(location.endsWith(rest)).toBe(true);
        expect(mockSetAuthCookies).not.toHaveBeenCalled();
        expect(mockCreateRefreshToken).not.toHaveBeenCalled();

        // The fragment carries an MFA pending token, not a session token.
        const token = new URLSearchParams(location.slice('/login#'.length)).get('ssoMfaToken');
        const payload = app.jwt.verify<{ userId: string; mfaPending?: boolean }>(token ?? '');
        expect(payload).toMatchObject({ userId: 'usr_001', mfaPending: true });

        if (method === 'email') {
          expect(mockCreateMfaChallenge).toHaveBeenCalledWith(
            { name: 'sql-client' },
            {
              userId: 'usr_001',
              method: 'email',
              purpose: 'sign_in',
            },
          );
          expect(mockDispatchSystemNotification).toHaveBeenCalledWith(
            { name: 'sql-client' },
            'mfa.VerificationCode',
            expect.objectContaining({ email: 'admin@example.com' }),
            { code: '123456' },
            expect.any(String),
          );
        } else {
          expect(mockCreateMfaChallenge).not.toHaveBeenCalled();
        }
      },
    );

    it('sends a required operator without MFA to set up MFA, with no session', async () => {
      mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
      mockValidatePostResponseAsync.mockResolvedValue({
        profile: { email: 'admin@example.com' },
      });
      vi.mocked(getMfaConfig).mockResolvedValueOnce({
        emailEnabled: true,
        totpEnabled: true,
        smsEnabled: false,
        required: 'all' as const,
        requiredRoles: [] as string[],
        webauthnEnabled: true,
        passkeyLoginEnabled: false,
        requireDrivers: false,
      });
      setupDbResults(
        [
          {
            id: 'usr_001',
            roleId: 'rol_001',
            isActive: true,
            email: 'admin@example.com',
            phone: null,
            firstName: 'Ada',
            language: 'en',
            mfaEnabled: false,
            mfaMethod: null,
            sessionVersion: 2,
          },
        ],
        [{ name: 'admin' }],
      );

      const res = await app.inject({
        method: 'POST',
        url: '/auth/sso/callback',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: 'csms_sso_binding=browser-binding',
        },
        payload: 'SAMLResponse=base64encodedresponse',
      });

      expect(res.statusCode).toBe(302);
      const location = String(res.headers['location']);
      expect(location.startsWith('/login#ssoMfaEnrollmentToken=')).toBe(true);
      const params = new URLSearchParams(location.slice('/login#'.length));
      expect(params.get('ssoMfaEnrollmentMethods')).toBe('email,totp');
      expect(params.get('ssoMfaToken')).toBeNull();
      expect(mockSetAuthCookies).not.toHaveBeenCalled();
      expect(mockCreateRefreshToken).not.toHaveBeenCalled();
      const payload = app.jwt.verify<Record<string, unknown>>(
        params.get('ssoMfaEnrollmentToken') ?? '',
      );
      expect(payload).toMatchObject({ userId: 'usr_001', mfaEnrollment: true, sv: 2 });
    });

    it('sends no code and points to the recovery codes when the method is switched off', async () => {
      mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
      mockValidatePostResponseAsync.mockResolvedValue({
        profile: { email: 'admin@example.com' },
      });
      vi.mocked(getMfaConfig).mockResolvedValueOnce({
        emailEnabled: false,
        totpEnabled: true,
        smsEnabled: false,
        required: 'off' as const,
        requiredRoles: [] as string[],
        webauthnEnabled: true,
        passkeyLoginEnabled: false,
        requireDrivers: false,
      });
      vi.mocked(countRecoveryCodes).mockResolvedValueOnce(4);
      setupDbResults([
        {
          id: 'usr_001',
          roleId: 'rol_001',
          isActive: true,
          email: 'admin@example.com',
          phone: null,
          firstName: 'Ada',
          language: 'en',
          mfaEnabled: true,
          mfaMethod: 'email',
        },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/sso/callback',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: 'csms_sso_binding=browser-binding',
        },
        payload: 'SAMLResponse=base64encodedresponse',
      });

      expect(res.statusCode).toBe(302);
      const params = new URLSearchParams(String(res.headers['location']).slice('/login#'.length));
      expect(params.get('ssoMfaFactors')).toBe('recovery_code');
      expect(params.get('ssoMfaMethodDisabled')).toBe('1');
      expect(params.get('ssoMfaChallengeId')).toBeNull();
      expect(mockCreateMfaChallenge).not.toHaveBeenCalled();
      expect(mockDispatchSystemNotification).not.toHaveBeenCalled();
      expect(mockSetAuthCookies).not.toHaveBeenCalled();
    });

    it('redirects with error when user not found and auto-provision disabled', async () => {
      mockGetSsoConfig.mockResolvedValue({
        ...SSO_CONFIG,
        autoProvision: false,
      });
      mockValidatePostResponseAsync.mockResolvedValue({
        profile: { email: 'unknown@example.com', firstName: 'Unknown', lastName: 'User' },
      });

      // User lookup returns empty
      setupDbResults([]);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/sso/callback',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: 'csms_sso_binding=browser-binding',
        },
        payload: 'SAMLResponse=base64encodedresponse',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('/login?error=sso_user_not_found');
    });

    it('creates user and redirects when auto-provision enabled', async () => {
      mockGetSsoConfig.mockResolvedValue({
        ...SSO_CONFIG,
        autoProvision: true,
        defaultRoleId: 'rol_001',
      });
      mockValidatePostResponseAsync.mockResolvedValue({
        profile: { email: 'new@example.com', firstName: 'New', lastName: 'Driver' },
      });

      // First query: user lookup returns empty (not found)
      // Second query: role lookup returns the default role
      // Third query: insert user
      setupDbResults([], [{ id: 'rol_001' }], []);

      mockGenerateId.mockReturnValue('usr_new001');
      mockCreateRefreshToken.mockResolvedValue({
        rawToken: 'refresh_xxx',
        expiresAt: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/sso/callback',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: 'csms_sso_binding=browser-binding',
        },
        payload: 'SAMLResponse=base64encodedresponse',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('/');
      expect(mockSetAuthCookies).toHaveBeenCalled();
      expect(mockCreateRefreshToken).toHaveBeenCalledWith({
        userId: 'usr_new001',
        lifetimeDays: DEFAULT_SESSION_LIFETIMES.operatorRefreshDays,
      });
      expect(mockGenerateId).toHaveBeenCalledWith('user');
    });

    it('sends an auto-provisioned user to set up required MFA, with no session', async () => {
      mockGetSsoConfig.mockResolvedValue({
        ...SSO_CONFIG,
        autoProvision: true,
        defaultRoleId: 'rol_001',
      });
      mockValidatePostResponseAsync.mockResolvedValue({
        profile: { email: 'new@example.com', firstName: 'New', lastName: 'Operator' },
      });
      vi.mocked(getMfaConfig).mockResolvedValueOnce({
        emailEnabled: true,
        totpEnabled: true,
        smsEnabled: false,
        required: 'all' as const,
        requiredRoles: [] as string[],
        webauthnEnabled: true,
        passkeyLoginEnabled: false,
        requireDrivers: false,
      });
      // User lookup (none), default role, the inserted user, the role name of the MFA gate.
      setupDbResults(
        [],
        [{ id: 'rol_001', name: 'operator' }],
        [{ id: 'usr_new002', language: 'en', sessionVersion: 0 }],
        [{ name: 'operator' }],
      );
      mockGenerateId.mockReturnValue('usr_new002');

      const res = await app.inject({
        method: 'POST',
        url: '/auth/sso/callback',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: 'csms_sso_binding=browser-binding',
        },
        payload: 'SAMLResponse=base64encodedresponse',
      });

      expect(res.statusCode).toBe(302);
      const location = String(res.headers['location']);
      expect(location.startsWith('/login#ssoMfaEnrollmentToken=')).toBe(true);
      const params = new URLSearchParams(location.slice('/login#'.length));
      expect(params.get('ssoMfaEnrollmentMethods')).toBe('email,totp');
      // Only the cleared binding cookie: no session.
      expect(res.cookies.filter((c) => c.value !== '')).toEqual([]);
      expect(mockSetAuthCookies).not.toHaveBeenCalled();
      expect(mockCreateRefreshToken).not.toHaveBeenCalled();
      const payload = app.jwt.verify<Record<string, unknown>>(
        params.get('ssoMfaEnrollmentToken') ?? '',
      );
      expect(payload).toMatchObject({ userId: 'usr_new002', mfaEnrollment: true, sv: 0 });
    });

    it('refuses an SSO sign-in that required MFA covers when no method can be set up', async () => {
      mockGetSsoConfig.mockResolvedValue({
        ...SSO_CONFIG,
        autoProvision: true,
        defaultRoleId: 'rol_001',
      });
      mockValidatePostResponseAsync.mockResolvedValue({
        profile: { email: 'new@example.com', firstName: 'New', lastName: 'Operator' },
      });
      vi.mocked(getMfaConfig).mockResolvedValueOnce({
        emailEnabled: false,
        totpEnabled: false,
        smsEnabled: true,
        required: 'all' as const,
        requiredRoles: [] as string[],
        webauthnEnabled: true,
        passkeyLoginEnabled: false,
        requireDrivers: false,
      });
      setupDbResults(
        [],
        [{ id: 'rol_001', name: 'operator' }],
        [{ id: 'usr_new003', language: 'en', sessionVersion: 0 }],
        [{ name: 'operator' }],
      );
      mockGenerateId.mockReturnValue('usr_new003');

      const res = await app.inject({
        method: 'POST',
        url: '/auth/sso/callback',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: 'csms_sso_binding=browser-binding',
        },
        payload: 'SAMLResponse=base64encodedresponse',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('/login?error=sso_mfa_setup_unavailable');
      // Only the cleared binding cookie: no session.
      expect(res.cookies.filter((c) => c.value !== '')).toEqual([]);
      expect(mockSetAuthCookies).not.toHaveBeenCalled();
      expect(mockCreateRefreshToken).not.toHaveBeenCalled();
    });

    it('refuses an auto-provisioned SSO sign-in when the MFA settings cannot be read', async () => {
      mfaRead.fails = true;
      try {
        mockGetSsoConfig.mockResolvedValue({
          ...SSO_CONFIG,
          autoProvision: true,
          defaultRoleId: 'rol_001',
        });
        mockValidatePostResponseAsync.mockResolvedValue({
          profile: { email: 'new@example.com', firstName: 'New', lastName: 'Operator' },
        });
        setupDbResults(
          [],
          [{ id: 'rol_001', name: 'operator' }],
          [{ id: 'usr_new004', language: 'en', sessionVersion: 0 }],
        );
        mockGenerateId.mockReturnValue('usr_new004');

        const res = await app.inject({
          method: 'POST',
          url: '/auth/sso/callback',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            cookie: 'csms_sso_binding=browser-binding',
          },
          payload: 'SAMLResponse=base64encodedresponse',
        });

        expect(res.statusCode).toBe(302);
        expect(res.headers['location']).toBe('/login?error=sso_mfa_policy_unavailable');
        // Only the cleared binding cookie: no session.
        expect(res.cookies.filter((c) => c.value !== '')).toEqual([]);
        expect(mockSetAuthCookies).not.toHaveBeenCalled();
        expect(mockCreateRefreshToken).not.toHaveBeenCalled();
      } finally {
        mfaRead.fails = false;
      }
    });
  });
});
