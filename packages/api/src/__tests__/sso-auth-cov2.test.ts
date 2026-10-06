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
} = vi.hoisted(() => ({
  mockWriteAudit: vi.fn(),
  mockGetSsoConfig: vi.fn(),
  mockGenerateId: vi.fn(),
  mockGetAuthorizeUrlAsync: vi.fn(),
  mockValidatePostResponseAsync: vi.fn(),
  mockCreateRefreshToken: vi.fn(),
  mockSetAuthCookies: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
  },
  users: {},
  roles: {},
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
}));

vi.mock('@node-saml/node-saml', () => ({
  SAML: class {
    getAuthorizeUrlAsync(...args: unknown[]) {
      return mockGetAuthorizeUrlAsync(...args);
    }
    validatePostResponseAsync(...args: unknown[]) {
      return mockValidatePostResponseAsync(...args);
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

  function callback(form: string) {
    return app.inject({
      method: 'POST',
      url: '/auth/sso/callback',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form,
    });
  }

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
    expect(mockCreateRefreshToken).toHaveBeenCalledWith({ userId: 'usr_9' });
  });

  it('falls back to the lowercase attribute name', async () => {
    mockGetSsoConfig.mockResolvedValue({ ...SSO_CONFIG, attributeMapping: { email: 'EMail' } });
    mockValidatePostResponseAsync.mockResolvedValue({ profile: { email: 'low@example.com' } });
    setupDbResults([{ id: 'usr_8', roleId: 'rol_8', isActive: true }], []);
    const res = await callback('SAMLResponse=abc');
    expect(res.headers['location']).toBe('/');
    expect(mockCreateRefreshToken).toHaveBeenCalledWith({ userId: 'usr_8' });
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
        after: created,
        notes: 'auto-provisioned via SSO',
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(mockCreateRefreshToken).toHaveBeenCalledWith({ userId: 'usr_new' });
    expect(mockSetAuthCookies).toHaveBeenCalledWith(
      'csms',
      expect.anything(),
      expect.any(String),
      'refresh_raw',
      false,
    );
  });
});
