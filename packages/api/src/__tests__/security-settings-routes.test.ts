// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { storedRows, upserts, mockClearCache, mockPublish } = vi.hoisted(() => ({
  storedRows: [] as Array<{ key: string; value: unknown }>,
  upserts: [] as Array<{ key: string; value: unknown }>,
  mockClearCache: vi.fn(),
  mockPublish: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve(storedRows) }) }),
    insert: () => ({
      values: (row: { key: string; value: unknown }) => ({
        onConflictDoUpdate: () => {
          upserts.push(row);
          return Promise.resolve();
        },
      }),
    }),
  },
  settings: { key: 'key' },
  settingAuditLog: { name: 'setting_audit_log' },
  clearSecuritySettingsCache: mockClearCache,
  writeAudit: vi.fn(() => Promise.resolve()),
}));

vi.mock('drizzle-orm', () => ({ like: vi.fn(), inArray: vi.fn() }));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: mockPublish }),
}));

vi.mock('../lib/config.js', () => ({
  config: { SETTINGS_ENCRYPTION_KEY: 'test-encryption-key-32chars!!!!!' },
}));

vi.mock('../middleware/rbac.js', () => ({
  authorize: () => async () => {},
}));

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
    app.inject({ method: 'PUT', url: '/security/recaptcha', payload });

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
