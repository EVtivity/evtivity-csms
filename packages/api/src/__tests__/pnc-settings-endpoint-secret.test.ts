// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// PUT /v1/pnc/settings: a stored Hubject client secret never follows a new
// endpoint. A caller with
// settings.integrations:write but without settings.system:read cannot read the
// secret, so pointing the token URL at its own host would otherwise post the
// secret there on the next Hubject call.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

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
vi.mock('../lib/hubject-url.js', () => ({
  PRIVATE_HUBJECT_URL_ERROR: { error: 'private', code: 'PRIVATE_URL' },
  validateHubjectUrl: (url: string) => url,
}));

const { store, writes, failAt } = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  writes: [] as Array<{ key: string; value: unknown }>,
  // The write number (1-based) that throws inside the transaction, or 0.
  failAt: { n: 0 },
}));
vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([...store.entries()].map(([key, value]) => ({ key, value }))),
      }),
    }),
    // A transaction stages its writes and applies them only when it commits.
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      const staged: Array<{ key: string; value: unknown }> = [];
      const tx = {
        insert: () => ({
          values: (row: { key: string; value: unknown }) => ({
            onConflictDoUpdate: () => {
              writes.push(row);
              if (failAt.n === writes.length) {
                return Promise.reject(new Error('connection lost'));
              }
              staged.push(row);
              return Promise.resolve();
            },
          }),
        }),
      };
      await fn(tx);
      for (const row of staged) store.set(row.key, row.value);
    },
  },
  writeAudit: vi.fn(() => Promise.resolve()),
}));
vi.mock('@evtivity/ocpp', () => ({
  createLocalContractCa: vi.fn(),
  describeLocalContractCa: vi.fn(),
  parseLocalContractCa: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { pncSettingsRoutes } from '../routes/pnc-settings.js';
import { setMockPermissions } from './helpers/rbac-permission-mock.js';

const BASE = 'https://open.plugncharge-test.hubject.com';
const TOKEN = 'https://auth.eu.plugncharge.hubject.com/oauth/token';

describe('PUT /pnc/settings endpoint and secret', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    pncSettingsRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setMockPermissions(['settings.integrations:write']);
    store.clear();
    writes.length = 0;
    failAt.n = 0;
    store.set('pnc.hubject.baseUrl', BASE);
    store.set('pnc.hubject.tokenUrl', TOKEN);
    store.set('pnc.hubject.clientSecretEnc', 'stored-ciphertext');
  });

  function put(body: Record<string, unknown>) {
    return app.inject({
      method: 'PUT',
      url: '/pnc/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  it('clears the stored secret when the token URL changes without a new secret', async () => {
    const res = await put({ hubjectTokenUrl: 'https://attacker.example/token' });
    expect(res.statusCode).toBe(200);
    expect(store.get('pnc.hubject.clientSecretEnc')).toBe('');
  });

  it('clears the stored secret when the base URL changes without a new secret', async () => {
    const res = await put({ hubjectBaseUrl: 'https://attacker.example' });
    expect(res.statusCode).toBe(200);
    expect(store.get('pnc.hubject.clientSecretEnc')).toBe('');
  });

  it('writes the cleared secret before the new URL, in one transaction', async () => {
    const res = await put({ hubjectTokenUrl: 'https://attacker.example/token' });
    expect(res.statusCode).toBe(200);
    expect(writes.map((w) => w.key)).toEqual([
      'pnc.hubject.clientSecretEnc',
      'pnc.hubject.tokenUrl',
    ]);
  });

  it('changes neither key when the second write fails', async () => {
    failAt.n = 2;
    const res = await put({ hubjectTokenUrl: 'https://attacker.example/token' });
    expect(res.statusCode).toBe(500);
    expect(store.get('pnc.hubject.tokenUrl')).toBe(TOKEN);
    expect(store.get('pnc.hubject.clientSecretEnc')).toBe('stored-ciphertext');
  });

  it('keeps the stored secret when the URLs are saved unchanged', async () => {
    const res = await put({ hubjectBaseUrl: BASE, hubjectTokenUrl: TOKEN, hubjectClientId: 'c' });
    expect(res.statusCode).toBe(200);
    expect(store.get('pnc.hubject.clientSecretEnc')).toBe('stored-ciphertext');
    expect(writes.some((w) => w.key === 'pnc.hubject.clientSecretEnc')).toBe(false);
  });

  it('stores the new secret sent with a new URL', async () => {
    const res = await put({
      hubjectTokenUrl: 'https://auth.other.hubject.com/token',
      hubjectClientSecret: 'new-secret',
    });
    expect(res.statusCode).toBe(200);
    const stored = store.get('pnc.hubject.clientSecretEnc');
    expect(typeof stored).toBe('string');
    expect(stored).not.toBe('');
    expect(stored).not.toBe('stored-ciphertext');
  });
});
