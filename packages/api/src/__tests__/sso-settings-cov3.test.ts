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

const proofState = vi.hoisted(() => ({ allow: true, apiKey: false, calls: 0 }));
vi.mock('../lib/mfa-factor-proof.js', async () => {
  const { z } = await import('zod');
  return { factorProof: z.object({ kind: z.string() }).loose() };
});
vi.mock('../lib/session-proof.js', () => {
  return {
    sessionProofErrorFields: {},
    SESSION_PROOF_ERROR_CODES: ['VALIDATION_ERROR', 'INVALID_PASSWORD'],
    isApiKeyRequest: vi.fn(() => proofState.apiKey),
    requireSessionProof: vi.fn(
      async (
        _req: unknown,
        reply: { status: (n: number) => { send: (b: unknown) => unknown } },
      ) => {
        proofState.calls += 1;
        if (proofState.allow) return true;
        await reply
          .status(400)
          .send({ error: 'proof', code: 'VALIDATION_ERROR', proofKinds: ['password'] });
        return false;
      },
    ),
  };
});
const grantState = vi.hoisted(() => ({ allow: true }));
vi.mock('../lib/user-management-scope.js', () => ({
  canGrantPermissions: vi.fn(() => Promise.resolve(grantState.allow)),
}));
vi.mock('../lib/security-notice.js', () => ({ sendSecurityNotice: vi.fn() }));

vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    selectDistinct: vi.fn(() => makeChain()),
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
  roles: {},
  users: {},
  userPermissions: {},
  settingAuditLog: { _name: 'settingAuditLog' },
  writeAudit: vi.fn(() => Promise.resolve()),
  clearSsoSettingsCache: vi.fn(),
  getSsoConfig: vi.fn(() => Promise.resolve(null)),
  getRecaptchaConfig: vi.fn(() => Promise.resolve(null)),
  getMfaConfig: vi.fn(() =>
    Promise.resolve({
      emailEnabled: false,
      totpEnabled: false,
      smsEnabled: false,
      webauthnEnabled: true,
      passkeyLoginEnabled: false,
      requireDrivers: false,
    }),
  ),
  isRoamingEnabled: vi.fn(() => Promise.resolve(false)),
  isSupportAiEnabled: vi.fn(() => Promise.resolve(false)),
  getPasswordPolicy: vi.fn(() =>
    Promise.resolve({
      minLength: 14,
      requireUppercase: true,
      requireLowercase: false,
      requireNumber: true,
      requireSymbol: true,
    }),
  ),
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
  OCTT_PENDING_RESTORE_SETTING_KEY: 'octt.pendingRestore',
  permissionCatalog: { defaultsFor: vi.fn(() => ['stations:read']) },
  WEBHOOK_SIGNING_SECRET_KEY: 'notifications.webhookSigningSecretEnc',
  encryptString: vi.fn((value: string) => `encrypted:${value}`),
  decryptString: vi.fn((value: string) =>
    value.startsWith('encrypted:') ? value.slice('encrypted:'.length) : value,
  ),
}));

process.env['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key-32chars!!!!!';

import { registerAuth } from '../plugins/auth.js';
import { ssoSettingsRoutes } from '../routes/sso-settings.js';
import { securityPublicRoutes } from '../routes/security-public.js';

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

// Imported once, not in the first test: loading the module graph can exceed the 5 s test timeout under load.
let libModule: typeof import('@evtivity/lib');
let databaseModule: typeof import('@evtivity/database');
beforeAll(async () => {
  libModule = await import('@evtivity/lib');
  databaseModule = await import('@evtivity/database');
}, 30_000);

const base = {
  enabled: true,
  provider: 'okta',
  entryPoint: 'https://example.com/sso',
  issuer: 'https://example.com',
  autoProvision: false,
  defaultRoleId: '',
  attributeMapping: { email: 'email' },
};
const storedIdp = [
  { key: 'sso.enabled', value: true },
  { key: 'sso.provider', value: 'okta' },
  { key: 'sso.entryPoint', value: 'https://example.com/sso' },
  { key: 'sso.issuer', value: 'https://example.com' },
  { key: 'sso.autoProvision', value: false },
  { key: 'sso.defaultRoleId', value: '' },
  { key: 'sso.attributeMapping', value: '{"email":"email"}' },
];

describe('SSO settings routes, more branches', () => {
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
    proofState.allow = true;
    proofState.apiKey = false;
    proofState.calls = 0;
    grantState.allow = true;
  });

  const put = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'PUT',
      url: '/sso/settings',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  it('GET leaves out stored keys that are no SSO setting', async () => {
    setupDbResults([
      { key: 'sso.enabled', value: true },
      { key: 'sso.legacyFlag', value: 'x' },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/sso/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body['sso.enabled']).toBe(true);
    expect(body).not.toHaveProperty('sso.legacyFlag');
  });

  it('refuses an API key that widens the allowed domains', async () => {
    proofState.apiKey = true;
    setupDbResults([...storedIdp, { key: 'sso.allowedDomains', value: ['a.com'] }]);
    const wider = await put({ ...base, allowedDomains: ['a.com', 'B.com'] });
    expect(wider.statusCode).toBe(403);
    expect(JSON.parse(wider.body).code).toBe('SESSION_REQUIRED');

    // An empty list lets in every domain: wider too.
    setupDbResults([...storedIdp, { key: 'sso.allowedDomains', value: 'a.com, b.com' }]);
    const every = await put({ ...base, allowedDomains: [] });
    expect(every.statusCode).toBe(403);
  });

  it('lets an API key narrow the domains, or set them while none are stored', async () => {
    proofState.apiKey = true;
    const { clearSsoSettingsCache } = databaseModule;
    vi.mocked(clearSsoSettingsCache).mockClear();
    setupDbResults([...storedIdp, { key: 'sso.allowedDomains', value: 'a.com,b.com' }]);
    const narrower = await put({ ...base, allowedDomains: [' A.com ', 'a.com'] });
    expect(narrower.statusCode).toBe(200);
    expect(clearSsoSettingsCache).toHaveBeenCalledTimes(1);

    // A stored value of no known shape reads as every domain: nothing to widen.
    setupDbResults([...storedIdp, { key: 'sso.allowedDomains', value: 42 }]);
    const fromNone = await put({ ...base, allowedDomains: ['c.com'] });
    expect(fromNone.statusCode).toBe(200);
  });

  it('answers 500 and saves nothing when the certificate cannot be encrypted', async () => {
    const { encryptString } = libModule;
    const { clearSsoSettingsCache } = databaseModule;
    vi.mocked(clearSsoSettingsCache).mockClear();
    vi.mocked(encryptString).mockImplementationOnce(() => {
      throw new Error('bad key');
    });
    setupDbResults(storedIdp);
    const response = await put({ ...base, cert: 'NEW-PEM' });
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      error: 'SETTINGS_ENCRYPTION_KEY not configured on server',
      code: 'ENCRYPTION_KEY_MISSING',
    });
    expect(clearSsoSettingsCache).not.toHaveBeenCalled();
  });

  it('answers 500 when the server has no encryption key', async () => {
    const { config } = await import('../lib/config.js');
    const mutable = config as { SETTINGS_ENCRYPTION_KEY: string };
    const saved = mutable.SETTINGS_ENCRYPTION_KEY;
    mutable.SETTINGS_ENCRYPTION_KEY = '';
    try {
      setupDbResults(storedIdp);
      const response = await put({ ...base, cert: 'NEW-PEM' });
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).code).toBe('ENCRYPTION_KEY_MISSING');
    } finally {
      mutable.SETTINGS_ENCRYPTION_KEY = saved;
    }
  });

  it('tells every SSO admin of a change, saying whether the identity provider changed', async () => {
    const { sendSecurityNotice } = await import('../lib/security-notice.js');
    // The stored read, 7 upserts, then the admin ids.
    setupDbResults(storedIdp, [], [], [], [], [], [], [], [{ id: 'usr_a' }, { id: 'usr_b' }]);
    const response = await put({ ...base, issuer: 'https://idp.example' });
    expect(response.statusCode).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    const calls = vi.mocked(sendSecurityNotice).mock.calls;
    expect(calls.map((c) => c[0])).toEqual([{ userId: 'usr_a' }, { userId: 'usr_b' }]);
    expect(calls[0]?.[1]).toBe('security.SsoSettingsChanged');
    expect(calls[0]?.[2]).toEqual({ idpChanged: true, ssoEnabled: true, autoProvision: false });
  });

  it('keeps the change when the notice recipients cannot be read', async () => {
    const { sendSecurityNotice } = await import('../lib/security-notice.js');
    const { db } = databaseModule;
    vi.mocked(db.selectDistinct).mockImplementationOnce(() => {
      throw new Error('db down');
    });
    setupDbResults(storedIdp);
    const response = await put({ ...base, enabled: false });
    expect(response.statusCode).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sendSecurityNotice).not.toHaveBeenCalled();
  });

  it('sends no notice and asks no proof for a save that changes nothing', async () => {
    const { sendSecurityNotice } = await import('../lib/security-notice.js');
    setupDbResults(storedIdp, [], [], [], [], [], [], [], [{ id: 'usr_a' }]);
    const response = await put(base);
    expect(response.statusCode).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sendSecurityNotice).not.toHaveBeenCalled();
    expect(proofState.calls).toBe(0);
  });
});
