// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
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

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => makeChain()),
        insert: vi.fn(() => makeChain()),
        update: vi.fn(() => makeChain()),
        delete: vi.fn(() => makeChain()),
      };
      return fn(tx);
    }),
  },
  settings: {},
  clearSsoSettingsCache: vi.fn(),
  getSsoConfig: vi.fn(() => Promise.resolve(null)),
  getRecaptchaConfig: vi.fn(() => Promise.resolve(null)),
  getMfaConfig: vi.fn(() =>
    Promise.resolve({ emailEnabled: false, totpEnabled: false, smsEnabled: false }),
  ),
  isRoamingEnabled: vi.fn(() => Promise.resolve(false)),
  isSupportAiEnabled: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  like: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
  inArray: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
  between: vi.fn(),
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
}));

vi.mock('@evtivity/lib', () => ({
  encryptString: vi.fn((value: string) => `encrypted:${value}`),
}));

process.env['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key-32chars!!!!!';

import { registerAuth } from '../plugins/auth.js';
import { ssoSettingsRoutes } from '../routes/sso-settings.js';
import { securityPublicRoutes } from '../routes/security-public.js';
import { getSsoConfig } from '@evtivity/database';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  ssoSettingsRoutes(app);
  securityPublicRoutes(app);
  await app.ready();
  return app;
}

describe('SSO Settings routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    vi.mocked(getSsoConfig).mockResolvedValue(null);
  });

  // --- Auth requirements ---

  it('GET /sso/settings returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/sso/settings' });
    expect(response.statusCode).toBe(401);
  });

  it('PUT /sso/settings returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/sso/settings',
      payload: {
        enabled: true,
        provider: 'okta',
        entryPoint: 'https://example.com/sso',
        issuer: 'https://example.com',
        autoProvision: false,
        defaultRoleId: 'rol_000000000001',
        attributeMapping: { email: 'email' },
      },
    });
    expect(response.statusCode).toBe(401);
  });

  // --- GET /sso/settings ---

  it('GET /sso/settings returns masked cert value when cert is set', async () => {
    setupDbResults([
      { key: 'sso.enabled', value: true },
      { key: 'sso.provider', value: 'okta' },
      { key: 'sso.entryPoint', value: 'https://example.com/sso' },
      { key: 'sso.issuer', value: 'https://example.com' },
      { key: 'sso.certEnc', value: 'encrypted-cert-data' },
      { key: 'sso.autoProvision', value: false },
      { key: 'sso.defaultRoleId', value: 'rol_000000000001' },
      { key: 'sso.attributeMapping', value: '{"email":"email"}' },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/sso/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body['sso.certEnc']).toBe('********');
    expect(body['sso.enabled']).toBe(true);
    expect(body['sso.provider']).toBe('okta');
  });

  it('GET /sso/settings returns empty cert when cert is not set', async () => {
    setupDbResults([
      { key: 'sso.enabled', value: false },
      { key: 'sso.provider', value: 'custom' },
      { key: 'sso.entryPoint', value: '' },
      { key: 'sso.issuer', value: '' },
      { key: 'sso.certEnc', value: '' },
      { key: 'sso.autoProvision', value: false },
      { key: 'sso.defaultRoleId', value: '' },
      { key: 'sso.attributeMapping', value: '{}' },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/sso/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body['sso.certEnc']).toBe('');
  });

  // --- PUT /sso/settings ---

  it('PUT /sso/settings stores settings and encrypts cert', async () => {
    // Each upsert (7 settings + 1 cert = 8 total) resolves from the chain
    setupDbResults([], [], [], [], [], [], [], []);
    const response = await app.inject({
      method: 'PUT',
      url: '/sso/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        enabled: true,
        provider: 'okta',
        entryPoint: 'https://example.com/sso',
        issuer: 'https://example.com',
        cert: 'PEM-CERT-DATA',
        autoProvision: true,
        defaultRoleId: 'rol_000000000001',
        attributeMapping: { email: 'email', firstName: 'givenName' },
      },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);

    const { encryptString } = await import('@evtivity/lib');
    expect(encryptString).toHaveBeenCalledWith('PEM-CERT-DATA', expect.any(String));

    const { clearSsoSettingsCache } = await import('@evtivity/database');
    expect(clearSsoSettingsCache).toHaveBeenCalled();
  });

  it('PUT /sso/settings without cert field does not overwrite existing cert', async () => {
    // 7 upserts (no cert)
    setupDbResults([], [], [], [], [], [], []);
    const response = await app.inject({
      method: 'PUT',
      url: '/sso/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        enabled: true,
        provider: 'azure-ad',
        entryPoint: 'https://login.microsoftonline.com/sso',
        issuer: 'https://sts.windows.net/tenant',
        autoProvision: false,
        defaultRoleId: 'rol_000000000001',
        attributeMapping: {
          email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
        },
      },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);

    const { encryptString } = await import('@evtivity/lib');
    // Since cert is omitted, encryptString should not have been called for cert data
    const calls = vi.mocked(encryptString).mock.calls;
    expect(calls.filter((c) => typeof c[0] === 'string' && c[0] !== 'PEM-CERT-DATA').length).toBe(
      0,
    );
  });

  // --- GET /security/public ---

  it('GET /security/public includes ssoEnabled field when SSO is configured', async () => {
    vi.mocked(getSsoConfig).mockResolvedValue({
      enabled: true,
      provider: 'okta',
      entryPoint: 'https://example.com/sso',
      issuer: 'https://example.com',
      cert: 'cert-data',
      autoProvision: false,
      defaultRoleId: 'rol_000000000001',
      attributeMapping: { email: 'email', firstName: 'firstName', lastName: 'lastName' },
      allowedDomains: [],
    });
    const response = await app.inject({ method: 'GET', url: '/security/public' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ssoEnabled).toBe(true);
  });

  it('GET /security/public returns ssoEnabled: false when SSO disabled', async () => {
    vi.mocked(getSsoConfig).mockResolvedValue(null);
    const response = await app.inject({ method: 'GET', url: '/security/public' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ssoEnabled).toBe(false);
  });
});
