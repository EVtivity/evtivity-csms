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
  mockWriteAudit,
  mockSamlOptions,
  mockConsumeRead,
  mockBindingMatches,
} = vi.hoisted(() => ({
  mockSamlOptions: vi.fn(),
  mockConsumeRead: vi.fn(() => Promise.resolve(true)),
  mockBindingMatches: vi.fn((_value: string | null) => Promise.resolve(true)),
  mockWriteAudit: vi.fn(),
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
vi.mock('@evtivity/database', () => ({
  readMfaConfig: async () => ({
    config: {
      emailEnabled: true,
      totpEnabled: true,
      smsEnabled: false,
      required: 'off',
      requiredRoles: [],
    },
    fallback: false,
  }),
  getSessionLifetimes: vi.fn(async () => ({
    ...(await import('@evtivity/lib/session-lifetimes')).DEFAULT_SESSION_LIFETIMES,
  })),
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
  userAuditLog: { name: 'userAuditLog' },
  writeAudit: mockWriteAudit,
  getSsoConfig: mockGetSsoConfig,
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
// single-use consume and browser binding answer what the test sets.
vi.mock('../lib/saml-request-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/saml-request-cache.js')>()),
  RedisSamlRequestCache: class {
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
  isSecureRequest: () => false,
}));

import { registerAuth } from '../plugins/auth.js';
import { ssoAuthRoutes } from '../routes/sso-auth.js';
import { DEFAULT_SESSION_LIFETIMES } from '@evtivity/lib/session-lifetimes';
import { db } from '@evtivity/database';

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

const PROVISION_CONFIG = {
  ...SSO_CONFIG,
  autoProvision: true,
  defaultRoleId: 'rol_default',
};

describe('SSO callback error and provisioning paths', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    setupDbResults();
    mockCreateRefreshToken.mockResolvedValue({ rawToken: 'refresh_raw', expiresAt: new Date() });
    app = await buildApp();
  });

  /** The IdP reply, posted by the browser that started the sign-in (its binding cookie). */
  function callback(form: string) {
    return app.inject({
      method: 'POST',
      url: '/auth/sso/callback',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: 'csms_sso_binding=this-browser',
      },
      payload: form,
    });
  }

  it('checks the binding of this browser only after the reply is consumed', async () => {
    mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
    mockValidatePostResponseAsync.mockResolvedValue({ profile: { email: 'a@corp.com' } });
    mockBindingMatches.mockResolvedValueOnce(false);
    const res = await callback('SAMLResponse=abc');
    expect(mockConsumeRead).toHaveBeenCalled();
    expect(mockBindingMatches).toHaveBeenCalledWith('this-browser');
    expect(res.headers['location']).toBe('/login?error=sso_session_mismatch');
    expect(mockSetAuthCookies).not.toHaveBeenCalled();
  });

  it('refuses a replayed reply before its binding is read', async () => {
    mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
    mockValidatePostResponseAsync.mockResolvedValue({ profile: { email: 'a@corp.com' } });
    mockConsumeRead.mockResolvedValueOnce(false);
    const res = await callback('SAMLResponse=abc');
    expect(res.headers['location']).toBe('/login?error=sso_config_error');
    expect(mockBindingMatches).not.toHaveBeenCalled();
  });

  it('redirects with sso_config_error when SSO is not configured', async () => {
    mockGetSsoConfig.mockResolvedValue(null);
    const res = await callback('SAMLResponse=abc');
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('/login?error=sso_config_error');
    expect(mockValidatePostResponseAsync).not.toHaveBeenCalled();
  });

  it('redirects with sso_config_error when SAMLResponse is missing or empty', async () => {
    mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
    const res = await callback('SAMLResponse=');
    expect(res.headers['location']).toBe('/login?error=sso_config_error');
    expect(mockValidatePostResponseAsync).not.toHaveBeenCalled();
  });

  it('redirects with sso_no_email when the assertion has no profile', async () => {
    mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
    mockValidatePostResponseAsync.mockResolvedValue({ profile: null });
    const res = await callback('SAMLResponse=abc');
    expect(res.headers['location']).toBe('/login?error=sso_no_email');
    expect(mockValidatePostResponseAsync).toHaveBeenCalledWith({ SAMLResponse: 'abc' });
  });

  it('redirects with sso_config_error when signature validation throws', async () => {
    mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
    mockValidatePostResponseAsync.mockRejectedValue(new Error('Invalid signature'));
    const res = await callback('SAMLResponse=abc');
    expect(res.headers['location']).toBe('/login?error=sso_config_error');
    expect(db.select).not.toHaveBeenCalled();
  });

  it('redirects with sso_no_email when no email attribute is present', async () => {
    mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
    mockValidatePostResponseAsync.mockResolvedValue({ profile: { email: 42, firstName: 'A' } });
    const res = await callback('SAMLResponse=abc');
    expect(res.headers['location']).toBe('/login?error=sso_no_email');
    expect(db.select).not.toHaveBeenCalled();
  });

  it('redirects with sso_account_disabled for an inactive existing user', async () => {
    mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
    mockValidatePostResponseAsync.mockResolvedValue({ profile: { email: 'a@example.com' } });
    setupDbResults([{ id: 'usr_1', roleId: 'rol_1', isActive: false }]);
    const res = await callback('SAMLResponse=abc');
    expect(res.headers['location']).toBe('/login?error=sso_account_disabled');
    expect(mockSetAuthCookies).not.toHaveBeenCalled();
    expect(mockCreateRefreshToken).not.toHaveBeenCalled();
  });

  it('reads the email from the claims URI when the mapped key is absent', async () => {
    mockGetSsoConfig.mockResolvedValue({
      ...SSO_CONFIG,
      attributeMapping: { email: 'emailaddress' },
    });
    mockValidatePostResponseAsync.mockResolvedValue({
      profile: {
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'claim@example.com',
      },
    });
    setupDbResults([{ id: 'usr_9', roleId: 'rol_9', isActive: true }], []);
    const res = await callback('SAMLResponse=abc');
    expect(res.headers['location']).toBe('/');
    expect(mockCreateRefreshToken).toHaveBeenCalledWith({
      userId: 'usr_9',
      lifetimeDays: DEFAULT_SESSION_LIFETIMES.operatorRefreshDays,
    });
  });

  it('falls back to the lowercase attribute name', async () => {
    mockGetSsoConfig.mockResolvedValue({ ...SSO_CONFIG, attributeMapping: { email: 'EMail' } });
    mockValidatePostResponseAsync.mockResolvedValue({ profile: { email: 'low@example.com' } });
    setupDbResults([{ id: 'usr_8', roleId: 'rol_8', isActive: true }], []);
    const res = await callback('SAMLResponse=abc');
    expect(res.headers['location']).toBe('/');
    expect(mockCreateRefreshToken).toHaveBeenCalledWith({
      userId: 'usr_8',
      lifetimeDays: DEFAULT_SESSION_LIFETIMES.operatorRefreshDays,
    });
  });

  it('refuses auto-provisioning for an email domain outside the allowed list', async () => {
    mockGetSsoConfig.mockResolvedValue({ ...PROVISION_CONFIG, allowedDomains: ['corp.com'] });
    mockValidatePostResponseAsync.mockResolvedValue({ profile: { email: 'x@other.com' } });
    setupDbResults([]);
    const res = await callback('SAMLResponse=abc');
    expect(res.headers['location']).toBe('/login?error=sso_domain_not_allowed');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('redirects with sso_config_error when no default role is configured', async () => {
    mockGetSsoConfig.mockResolvedValue({ ...PROVISION_CONFIG, defaultRoleId: '' });
    mockValidatePostResponseAsync.mockResolvedValue({ profile: { email: 'x@corp.com' } });
    setupDbResults([]);
    const res = await callback('SAMLResponse=abc');
    expect(res.headers['location']).toBe('/login?error=sso_config_error');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('redirects with sso_config_error when the default role does not exist', async () => {
    mockGetSsoConfig.mockResolvedValue(PROVISION_CONFIG);
    mockValidatePostResponseAsync.mockResolvedValue({ profile: { email: 'x@corp.com' } });
    setupDbResults([], []);
    const res = await callback('SAMLResponse=abc');
    expect(res.headers['location']).toBe('/login?error=sso_config_error');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('provisions an allowed-domain user, audits it as system, and signs them in', async () => {
    mockGetSsoConfig.mockResolvedValue({ ...PROVISION_CONFIG, allowedDomains: ['corp.com'] });
    mockGenerateId.mockReturnValue('usr_new');
    mockValidatePostResponseAsync.mockResolvedValue({
      profile: { email: 'New@Corp.com', firstName: 'New', lastName: 'Person' },
    });
    const created = { id: 'usr_new', email: 'New@Corp.com' };
    setupDbResults([], [{ id: 'rol_default' }], [created]);
    const res = await callback('SAMLResponse=abc');
    expect(res.headers['location']).toBe('/');
    expect(mockGenerateId).toHaveBeenCalledWith('user');
    expect(mockWriteAudit).toHaveBeenCalledWith(
      { table: { name: 'userAuditLog' }, idColumn: 'user_id' },
      expect.objectContaining({
        entityId: 'usr_new',
        action: 'created',
        actor: 'system',
        actorLabel: 'sso:https://csms.example.com',
        after: { ...created, permissions: [] },
        notes: 'auto-provisioned via SSO',
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(mockCreateRefreshToken).toHaveBeenCalledWith({
      userId: 'usr_new',
      lifetimeDays: DEFAULT_SESSION_LIFETIMES.operatorRefreshDays,
    });
    expect(mockSetAuthCookies).toHaveBeenCalledWith(
      'csms',
      expect.anything(),
      expect.any(String),
      'refresh_raw',
      false,
      {
        accessSeconds: DEFAULT_SESSION_LIFETIMES.operatorAccessMinutes * 60,
        refreshSeconds: DEFAULT_SESSION_LIFETIMES.operatorRefreshDays * 24 * 60 * 60,
      },
    );
  });

  it('provisions the user with authSource sso and its role permissions in one transaction', async () => {
    mockGetSsoConfig.mockResolvedValue(PROVISION_CONFIG);
    mockGenerateId.mockReturnValue('usr_op');
    mockValidatePostResponseAsync.mockResolvedValue({ profile: { email: 'op@corp.com' } });
    setupDbResults([], [{ id: 'rol_default', name: 'operator' }], [{ id: 'usr_op' }], []);
    const res = await callback('SAMLResponse=abc');
    expect(res.headers['location']).toBe('/');
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const inserts = vi.mocked(db.insert).mock.calls.map((c) => c[0]);
    expect(inserts).toEqual([{}, { _table: 'user_permissions' }]);
    const insertChains = vi
      .mocked(db.insert)
      .mock.results.map((r) => r.value as { values: ReturnType<typeof vi.fn> });
    expect(insertChains[0]?.values).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'usr_op', authSource: 'sso', passwordHash: '' }),
    );
    expect(insertChains[1]?.values).toHaveBeenCalledWith([
      { userId: 'usr_op', permission: 'stations:read' },
    ]);
  });

  it('refuses an existing user whose email domain is outside the allowed list', async () => {
    mockGetSsoConfig.mockResolvedValue({ ...SSO_CONFIG, allowedDomains: ['corp.com'] });
    mockValidatePostResponseAsync.mockResolvedValue({ profile: { email: 'old@other.com' } });
    setupDbResults([{ id: 'usr_old', roleId: 'rol_1', isActive: true, sessionVersion: 0 }]);
    const res = await callback('SAMLResponse=abc');
    expect(res.headers['location']).toBe('/login?error=sso_domain_not_allowed');
    expect(mockSetAuthCookies).not.toHaveBeenCalled();
    expect(mockWriteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entityId: 'usr_old',
        action: 'login_failed',
        notes: 'domain_not_allowed',
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('refuses a reply whose request id another post already consumed', async () => {
    mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
    mockValidatePostResponseAsync.mockResolvedValue({ profile: { email: 'a@corp.com' } });
    mockConsumeRead.mockResolvedValueOnce(false);
    setupDbResults([{ id: 'usr_a', roleId: 'rol_1', isActive: true, sessionVersion: 0 }]);
    const res = await callback('SAMLResponse=abc');
    expect(res.headers['location']).toBe('/login?error=sso_config_error');
    expect(mockSetAuthCookies).not.toHaveBeenCalled();
    expect(mockCreateRefreshToken).not.toHaveBeenCalled();
  });

  it('builds the SAML client to require InResponseTo with the request cache', async () => {
    mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
    mockValidatePostResponseAsync.mockResolvedValue({ profile: { email: 'a@corp.com' } });
    setupDbResults([{ id: 'usr_a', roleId: 'rol_1', isActive: true, sessionVersion: 0 }], []);
    await callback('SAMLResponse=abc');
    expect(mockSamlOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        validateInResponseTo: 'always',
        requestIdExpirationPeriodMs: 10 * 60 * 1000,
        wantAuthnResponseSigned: true,
        cacheProvider: expect.objectContaining({ consumeRead: expect.any(Function) }),
      }),
    );
  });

  it('signs the access token with the user session version', async () => {
    mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
    mockValidatePostResponseAsync.mockResolvedValue({ profile: { email: 'a@corp.com' } });
    setupDbResults([{ id: 'usr_sv', roleId: 'rol_1', isActive: true, sessionVersion: 4 }], []);
    await callback('SAMLResponse=abc');
    const token = String(mockSetAuthCookies.mock.calls[0]?.[2]);
    expect(app.jwt.verify(token)).toMatchObject({ userId: 'usr_sv', sv: 4 });
  });
});
