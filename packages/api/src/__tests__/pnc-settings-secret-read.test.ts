// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// GET /v1/pnc/settings returns the Hubject client secret decrypted only to a
// caller that also holds settings.system:read; every caller gets
// pnc.hubject.clientSecretConfigured.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { encryptString } from '@evtivity/lib';

const { KEY } = vi.hoisted(() => ({ KEY: 'test-encryption-key-32chars!!!!!' }));

vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);
vi.mock('../middleware/rbac.js', async () =>
  (await import('./helpers/rbac-permission-mock.js')).rbacPermissionMock(),
);
vi.mock('../lib/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/config.js')>();
  return { ...actual, config: { ...actual.config, SETTINGS_ENCRYPTION_KEY: KEY } };
});

const { rows } = vi.hoisted(() => ({ rows: [] as Array<{ key: string; value: unknown }> }));
vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
  },
}));
vi.mock('@evtivity/ocpp', () => ({
  createLocalContractCa: vi.fn(),
  describeLocalContractCa: vi.fn(),
  parseLocalContractCa: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { pncSettingsRoutes } from '../routes/pnc-settings.js';
import { setMockPermissions } from './helpers/rbac-permission-mock.js';

describe('GET /pnc/settings secret read', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    pncSettingsRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
    rows.push(
      { key: 'pnc.hubject.clientId', value: 'client-1' },
      { key: 'pnc.hubject.clientSecretEnc', value: encryptString('hubject-secret', KEY) },
    );
  });

  afterAll(async () => {
    await app.close();
  });

  function get() {
    return app.inject({
      method: 'GET',
      url: '/pnc/settings',
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it('returns null and the configured flag without settings.system:read', async () => {
    setMockPermissions(['settings.integrations:read']);
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      'pnc.hubject.clientId': 'client-1',
      'pnc.hubject.clientSecretEnc': null,
      'pnc.hubject.clientSecretConfigured': true,
    });
    expect(res.body).not.toContain('hubject-secret');
  });

  it('returns the decrypted secret with settings.system:read (control)', async () => {
    setMockPermissions(['settings.integrations:read', 'settings.system:read']);
    const res = await get();
    expect(res.json()).toMatchObject({
      'pnc.hubject.clientSecretEnc': 'hubject-secret',
      'pnc.hubject.clientSecretConfigured': true,
    });
  });
});
