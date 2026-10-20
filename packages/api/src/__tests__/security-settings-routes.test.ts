// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const { storedRows, upserts, failing, mockClearCache, mockPublish, mockWriteAudit } = vi.hoisted(
  () => ({
    storedRows: [] as Array<{ key: string; value: unknown }>,
    // Committed upserts only: a rolled-back transaction adds nothing.
    upserts: [] as Array<{ key: string; value: unknown }>,
    failing: { key: null as string | null },
    mockClearCache: vi.fn(),
    mockPublish: vi.fn(),
    mockWriteAudit: vi.fn((..._args: unknown[]) => Promise.resolve()),
  }),
);

vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);

vi.mock('@evtivity/database', () => {
  const insertInto = (target: Array<{ key: string; value: unknown }>) => () => ({
    values: (row: { key: string; value: unknown }) => ({
      onConflictDoUpdate: () => {
        if (row.key === failing.key) return Promise.reject(new Error('upsert failed'));
        target.push(row);
        return Promise.resolve();
      },
    }),
  });
  return {
    db: {
      select: () => ({ from: () => ({ where: () => Promise.resolve(storedRows) }) }),
      insert: insertInto(upserts),
      transaction: async (fn: (tx: unknown) => Promise<void>) => {
        const pending: Array<{ key: string; value: unknown }> = [];
        await fn({ insert: insertInto(pending) });
        upserts.push(...pending);
      },
    },
    settings: { key: 'key' },
    settingAuditLog: { name: 'setting_audit_log' },
    clearSecuritySettingsCache: mockClearCache,
    writeAudit: mockWriteAudit,
  };
});

vi.mock('drizzle-orm', () => ({ like: vi.fn(), inArray: vi.fn() }));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: mockPublish }),
}));

vi.mock('../lib/config.js', () => ({
  config: { SETTINGS_ENCRYPTION_KEY: 'test-encryption-key-32chars!!!!!' },
}));

// The caller's permissions come from the `x-perms` header; a missing one is 403.
vi.mock('../middleware/rbac.js', () => ({
  authorize:
    (...required: string[]) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const held = String(request.headers['x-perms'] ?? '').split(',');
      request.user = { userId: 'usr_000000000001', roleId: 'rol_000000000001' };
      if (!required.every((p) => held.includes(p))) {
        await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
      }
    },
}));

const READ = { 'x-perms': 'settings.security:read' };
const WRITE = { 'x-perms': 'settings.security:write' };

vi.mock('../lib/audit-actor.js', () => ({
  getAuditActor: () => ({
    actor: 'user',
    actorUserId: 'usr_000000000001',
    actorDriverId: null,
    actorApiKeyId: null,
    actorLabel: null,
  }),
}));

import { securitySettingsRoutes } from '../routes/security-settings.js';
import { resetSiteAccessMock, setMockUserSiteIds } from './helpers/site-access-mock.js';

describe('PUT /security/recaptcha', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    securitySettingsRoutes(app);
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    storedRows.length = 0;
    upserts.length = 0;
    mockClearCache.mockClear();
    mockPublish.mockReset();
    mockPublish.mockResolvedValue(undefined);
  });

  const put = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: '/security/recaptcha', headers: WRITE, payload });

  it('refuses to enable reCAPTCHA when no secret is sent and none is stored', async () => {
    storedRows.push({ key: 'security.recaptcha.secretKeyEnc', value: '' });
    const res = await put({ enabled: true, siteKey: 'site', threshold: 0.5 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'A reCAPTCHA secret key is required to enable reCAPTCHA',
      code: 'RECAPTCHA_SECRET_REQUIRED',
    });
    expect(upserts).toHaveLength(0);
    expect(mockClearCache).not.toHaveBeenCalled();
  });

  it('refuses an empty secret when no secret row exists', async () => {
    const res = await put({ enabled: true, siteKey: 'site', secretKey: '', threshold: 0.5 });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('RECAPTCHA_SECRET_REQUIRED');
    expect(upserts).toHaveLength(0);
  });

  it('enables reCAPTCHA with a stored secret and keeps it', async () => {
    storedRows.push({ key: 'security.recaptcha.secretKeyEnc', value: 'stored-ciphertext' });
    const res = await put({ enabled: true, siteKey: 'site', threshold: 0.5 });
    expect(res.statusCode).toBe(200);
    expect(upserts.map((u) => u.key)).toEqual([
      'security.recaptcha.enabled',
      'security.recaptcha.siteKey',
      'security.recaptcha.threshold',
    ]);
    expect(mockClearCache).toHaveBeenCalledTimes(1);
  });

  it('enables reCAPTCHA with a new secret and stores it encrypted', async () => {
    const res = await put({
      enabled: true,
      siteKey: 'site',
      secretKey: 'new-secret',
      threshold: 0.5,
    });
    expect(res.statusCode).toBe(200);
    const secret = upserts.find((u) => u.key === 'security.recaptcha.secretKeyEnc');
    expect(typeof secret?.value).toBe('string');
    expect(secret?.value).not.toBe('new-secret');
  });

  it('saves a disabled configuration without a secret', async () => {
    const res = await put({ enabled: false, siteKey: '', threshold: 0.5 });
    expect(res.statusCode).toBe(200);
    expect(upserts.find((u) => u.key === 'security.recaptcha.enabled')?.value).toBe(false);
  });
});

describe('password policy and session lifetime routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    securitySettingsRoutes(app);
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    storedRows.length = 0;
    upserts.length = 0;
    mockClearCache.mockClear();
    mockWriteAudit.mockClear();
    mockPublish.mockReset();
    mockPublish.mockResolvedValue(undefined);
    resetSiteAccessMock();
    failing.key = null;
  });

  const POLICY = {
    minLength: 14,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSymbol: true,
  };
  const SESSIONS = {
    operatorAccessMinutes: 15,
    operatorRefreshDays: 7,
    driverAccessMinutes: 30,
    driverRefreshDays: 60,
  };

  const put = (url: string, payload: Record<string, unknown>, headers = WRITE) =>
    app.inject({ method: 'PUT', url, headers, payload });

  function auditedKeys(): string[] {
    return mockWriteAudit.mock.calls.map((call) => (call[1] as { entityId: string }).entityId);
  }

  describe('PUT /security/password-policy', () => {
    it('writes the five keys, audits each changed key and clears the cache', async () => {
      storedRows.push(
        { key: 'security.password.minLength', value: 12 },
        { key: 'security.password.requireUppercase', value: true },
        { key: 'security.password.requireLowercase', value: true },
        { key: 'security.password.requireNumber', value: true },
        { key: 'security.password.requireSymbol', value: false },
      );
      const res = await put('/security/password-policy', POLICY);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(upserts).toEqual([
        { key: 'security.password.minLength', value: 14 },
        { key: 'security.password.requireUppercase', value: true },
        { key: 'security.password.requireLowercase', value: true },
        { key: 'security.password.requireNumber', value: true },
        { key: 'security.password.requireSymbol', value: true },
      ]);
      expect(auditedKeys().sort()).toEqual([
        'security.password.minLength',
        'security.password.requireSymbol',
      ]);
      expect(mockClearCache).toHaveBeenCalledTimes(1);
      expect(mockPublish).toHaveBeenCalledWith(
        'cache_invalidate',
        JSON.stringify({ kind: 'security_settings' }),
      );
    });

    it.each([7, 65, 12.5])('refuses a minimum length of %s with 400', async (minLength) => {
      const res = await put('/security/password-policy', { ...POLICY, minLength });
      expect(res.statusCode).toBe(400);
      expect(upserts).toHaveLength(0);
      expect(mockClearCache).not.toHaveBeenCalled();
    });

    it('refuses a body without every field with 400', async () => {
      const partial: Partial<typeof POLICY> = { ...POLICY };
      delete partial.requireSymbol;
      const res = await put('/security/password-policy', partial);
      expect(res.statusCode).toBe(400);
      expect(upserts).toHaveLength(0);
    });

    it('answers 404 SETTING_NOT_FOUND to a site-restricted user and writes nothing', async () => {
      setMockUserSiteIds(['sit_000000000001']);
      const res = await put('/security/password-policy', POLICY);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SETTING_NOT_FOUND');
      expect(upserts).toHaveLength(0);
    });

    it('answers 403 without settings.security:write', async () => {
      const res = await put('/security/password-policy', POLICY, READ);
      expect(res.statusCode).toBe(403);
      expect(upserts).toHaveLength(0);
    });
  });

  describe('PUT /security/sessions', () => {
    it('writes the four keys, audits each changed key and clears the cache', async () => {
      storedRows.push(
        { key: 'security.session.operatorAccessMinutes', value: 60 },
        { key: 'security.session.operatorRefreshDays', value: 30 },
        { key: 'security.session.driverAccessMinutes', value: 30 },
      );
      const res = await put('/security/sessions', SESSIONS);
      expect(res.statusCode).toBe(200);
      expect(upserts).toEqual([
        { key: 'security.session.operatorAccessMinutes', value: 15 },
        { key: 'security.session.operatorRefreshDays', value: 7 },
        { key: 'security.session.driverAccessMinutes', value: 30 },
        { key: 'security.session.driverRefreshDays', value: 60 },
      ]);
      expect(auditedKeys().sort()).toEqual([
        'security.session.driverRefreshDays',
        'security.session.operatorAccessMinutes',
        'security.session.operatorRefreshDays',
      ]);
      expect(mockClearCache).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['operatorAccessMinutes', 4],
      ['operatorAccessMinutes', 1441],
      ['operatorRefreshDays', 0],
      ['operatorRefreshDays', 91],
      ['driverAccessMinutes', 4],
      ['driverAccessMinutes', 1441],
      ['driverRefreshDays', 0],
      ['driverRefreshDays', 366],
      ['driverRefreshDays', 1.5],
    ])('refuses %s = %s with 400', async (field, value) => {
      const res = await put('/security/sessions', { ...SESSIONS, [field]: value });
      expect(res.statusCode).toBe(400);
      expect(upserts).toHaveLength(0);
    });

    it('accepts the range limits', async () => {
      const res = await put('/security/sessions', {
        operatorAccessMinutes: 1440,
        operatorRefreshDays: 90,
        driverAccessMinutes: 5,
        driverRefreshDays: 365,
      });
      expect(res.statusCode).toBe(200);
    });

    it('answers 404 SETTING_NOT_FOUND to a site-restricted user', async () => {
      setMockUserSiteIds(['sit_000000000001']);
      const res = await put('/security/sessions', SESSIONS);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SETTING_NOT_FOUND');
      expect(upserts).toHaveLength(0);
    });

    it('answers 403 without settings.security:write', async () => {
      const res = await put('/security/sessions', SESSIONS, READ);
      expect(res.statusCode).toBe(403);
      expect(upserts).toHaveLength(0);
    });
  });

  describe('one transaction per save', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['/security/password-policy', POLICY, 'security.password.requireNumber'],
      ['/security/sessions', SESSIONS, 'security.session.driverAccessMinutes'],
      [
        '/security/recaptcha',
        { enabled: false, siteKey: 'site', threshold: 0.5 },
        'security.recaptcha.siteKey',
      ],
      [
        '/security/mfa',
        { emailEnabled: true, totpEnabled: false, smsEnabled: true },
        'security.mfa.totpEnabled',
      ],
    ];

    it.each(cases)(
      '%s: a failed upsert rolls back every key and writes no audit row',
      async (url, payload, failingKey) => {
        failing.key = failingKey;
        const res = await put(url, payload);
        expect(res.statusCode).toBe(500);
        expect(upserts).toHaveLength(0);
        expect(mockWriteAudit).not.toHaveBeenCalled();
        expect(mockClearCache).not.toHaveBeenCalled();
      },
    );

    it('commits every key of a save and audits after the commit', async () => {
      const res = await put('/security/mfa', {
        emailEnabled: true,
        totpEnabled: false,
        smsEnabled: true,
      });
      expect(res.statusCode).toBe(200);
      expect(upserts.map((u) => u.key)).toEqual([
        'security.mfa.emailEnabled',
        'security.mfa.totpEnabled',
        'security.mfa.smsEnabled',
      ]);
      expect(auditedKeys()).toEqual([
        'security.mfa.emailEnabled',
        'security.mfa.totpEnabled',
        'security.mfa.smsEnabled',
      ]);
      expect(mockClearCache).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /security/settings', () => {
    it('returns the stored keys and both parsed groups', async () => {
      storedRows.push(
        { key: 'security.mfa.emailEnabled', value: true },
        { key: 'security.password.minLength', value: 16 },
        { key: 'security.password.requireSymbol', value: true },
        { key: 'security.session.operatorAccessMinutes', value: 15 },
        { key: 'security.session.driverRefreshDays', value: 90 },
      );
      const res = await app.inject({ method: 'GET', url: '/security/settings', headers: READ });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body['security.mfa.emailEnabled']).toBe(true);
      expect(body['security.password.minLength']).toBe(16);
      expect(body['security.session.operatorAccessMinutes']).toBe(15);
      expect(body.passwordPolicy).toEqual({
        minLength: 16,
        requireUppercase: true,
        requireLowercase: true,
        requireNumber: true,
        requireSymbol: true,
      });
      expect(body.sessionLifetimes).toEqual({
        operatorAccessMinutes: 15,
        operatorRefreshDays: 30,
        driverAccessMinutes: 60,
        driverRefreshDays: 90,
      });
    });

    it('returns the defaults when nothing is stored', async () => {
      const res = await app.inject({ method: 'GET', url: '/security/settings', headers: READ });
      expect(res.statusCode).toBe(200);
      expect(res.json().passwordPolicy.minLength).toBe(12);
      expect(res.json().sessionLifetimes.driverAccessMinutes).toBe(60);
    });

    it('answers 404 SETTING_NOT_FOUND to a site-restricted user', async () => {
      setMockUserSiteIds(['sit_000000000001']);
      const res = await app.inject({ method: 'GET', url: '/security/settings', headers: READ });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SETTING_NOT_FOUND');
    });
  });
});
