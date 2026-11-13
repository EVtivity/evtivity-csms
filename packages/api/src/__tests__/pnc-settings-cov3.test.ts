// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Plug and Charge settings routes: the read with or without the secret read
// permission, the update (URL and OCSP host checks, the secret first, audit of
// changed keys only) and the provider connectivity test for each provider.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  results: [] as unknown[],
  index: 0,
  writes: [] as Array<{ key: string; value: unknown }>,
  allSites: true,
  canReadSecrets: false,
  fetchImpl: vi.fn(),
}));

function queue(...results: unknown[]): void {
  state.results = results;
  state.index = 0;
}

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'where']) chain[method] = vi.fn(() => chain);
    chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
      const result = state.results[state.index] ?? [];
      state.index++;
      return Promise.resolve(result).then(resolve, reject);
    };
    return chain;
  }
  const tx = {
    insert: () => ({
      values: (row: { key: string; value: unknown }) => ({
        onConflictDoUpdate: () => {
          state.writes.push(row);
          return Promise.resolve();
        },
      }),
    }),
  };
  return {
    ...actual,
    db: {
      select: vi.fn(() => makeChain()),
      transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    },
    writeAudit: vi.fn().mockResolvedValue(undefined),
    clearPncSettingsCache: vi.fn(),
  };
});

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  encryptString: vi.fn((value: string) => `enc:${value}`),
  decryptString: vi.fn((value: string) => value.replace(/^enc:/, '')),
  safeFetch: (...args: unknown[]) => state.fetchImpl(...args) as Promise<Response>,
}));

vi.mock('../lib/site-access.js', () => ({
  requireAllSiteAccess: vi.fn(
    async (
      _request: unknown,
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
      notFound: unknown,
    ) => {
      if (state.allSites) return true;
      await reply.status(404).send(notFound);
      return false;
    },
  ),
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
  requestHasPermission: vi.fn(async () => state.canReadSecrets),
  invalidatePermissionCache: vi.fn(),
}));

import { writeAudit, clearPncSettingsCache } from '@evtivity/database';
import { config } from '../lib/config.js';
import { clearSettingsDecryptCache } from '../lib/settings-crypto.js';
import { registerAuth } from '../plugins/auth.js';
import { pncSettingsRoutes } from '../routes/pnc-settings.js';

const mutableConfig = config as { SETTINGS_ENCRYPTION_KEY: string };

const HUBJECT_ROWS = [
  { key: 'pnc.provider', value: 'hubject' },
  { key: 'pnc.hubject.baseUrl', value: 'https://hubject.example.com' },
  { key: 'pnc.hubject.clientId', value: 'client' },
  { key: 'pnc.hubject.tokenUrl', value: 'https://hubject.example.com/token' },
  { key: 'pnc.hubject.clientSecretEnc', value: 'enc:secret' },
];

describe('PnC settings routes', () => {
  let app: FastifyInstance;
  let token: string;
  const originalKey = mutableConfig.SETTINGS_ENCRYPTION_KEY;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(pncSettingsRoutes, { prefix: '/v1' });
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' });
  });

  afterAll(async () => {
    mutableConfig.SETTINGS_ENCRYPTION_KEY = originalKey;
    await app.close();
  });

  beforeEach(() => {
    state.allSites = true;
    state.canReadSecrets = false;
    state.writes = [];
    state.fetchImpl.mockReset();
    mutableConfig.SETTINGS_ENCRYPTION_KEY = 'test-key';
    clearSettingsDecryptCache();
    queue();
  });

  const send = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  it('answers 404 to a site-restricted user on every route', async () => {
    state.allSites = false;
    for (const [method, url, body] of [
      ['GET', '/v1/pnc/settings', undefined],
      ['PUT', '/v1/pnc/settings', {}],
      ['POST', '/v1/pnc/settings/test-provider', undefined],
    ] as const) {
      const res = await send(method, url, body);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Setting not found', code: 'SETTING_NOT_FOUND' });
    }
  });

  describe('GET /pnc/settings', () => {
    it('hides the client secret without the secret read permission', async () => {
      queue(HUBJECT_ROWS);
      const res = await send('GET', '/v1/pnc/settings');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        'pnc.provider': 'hubject',
        'pnc.hubject.clientSecretEnc': null,
        'pnc.hubject.clientSecretConfigured': true,
      });
    });

    it('decrypts the client secret with the permission', async () => {
      state.canReadSecrets = true;
      queue(HUBJECT_ROWS);
      const res = await send('GET', '/v1/pnc/settings');
      expect(res.json()).toMatchObject({ 'pnc.hubject.clientSecretEnc': 'secret' });
    });
  });

  describe('PUT /pnc/settings', () => {
    it('writes every sent key, the secret first, and audits changed keys only', async () => {
      // before rows
      queue([
        { key: 'pnc.enabled', value: true },
        { key: 'pnc.provider', value: 'manual' },
      ]);
      const res = await send('PUT', '/v1/pnc/settings', {
        enabled: true,
        provider: 'hubject',
        hubjectBaseUrl: 'https://hubject.example.com',
        hubjectClientId: 'client',
        hubjectClientSecret: 'new-secret',
        hubjectTokenUrl: 'https://hubject.example.com/token',
        expirationWarningDays: 30,
        expirationCriticalDays: 7,
        localEmaidCountry: 'DE',
        localEmaidProviderId: 'ABC',
        ocspAllowedPrivateHosts: ['ocsp.internal'],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(state.writes[0]).toEqual({
        key: 'pnc.hubject.clientSecretEnc',
        value: 'enc:new-secret',
      });
      expect(state.writes.map((w) => w.key)).toEqual([
        'pnc.hubject.clientSecretEnc',
        'pnc.enabled',
        'pnc.provider',
        'pnc.hubject.baseUrl',
        'pnc.hubject.clientId',
        'pnc.hubject.tokenUrl',
        'pnc.expirationWarningDays',
        'pnc.expirationCriticalDays',
        'pnc.ocsp.allowedPrivateHosts',
        'pnc.local.emaidCountry',
        'pnc.local.emaidProviderId',
      ]);
      expect(state.writes.find((w) => w.key === 'pnc.ocsp.allowedPrivateHosts')?.value).toEqual([
        'ocsp.internal',
      ]);
      expect(clearPncSettingsCache).toHaveBeenCalledTimes(1);
      // pnc.enabled did not change: no audit row for it.
      const audited = vi
        .mocked(writeAudit)
        .mock.calls.map((c) => (c[1] as { entityId: string }).entityId);
      expect(audited).not.toContain('pnc.enabled');
      expect(audited).toContain('pnc.provider');
      expect(audited).toHaveLength(10);
    });

    it('writes nothing and reads no before rows for an empty body', async () => {
      const res = await send('PUT', '/v1/pnc/settings', {});
      expect(res.statusCode).toBe(200);
      expect(state.writes).toHaveLength(0);
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('clears the stored secret when a URL changes without a new secret', async () => {
      queue(
        [
          { key: 'pnc.hubject.baseUrl', value: 'https://old.example.com' },
          { key: 'pnc.hubject.tokenUrl', value: 'https://old.example.com/token' },
          { key: 'pnc.hubject.clientSecretEnc', value: 'enc:secret' },
        ],
        [],
      );
      const res = await send('PUT', '/v1/pnc/settings', {
        hubjectTokenUrl: 'https://attacker.example.com/token',
        hubjectClientSecret: '',
      });
      expect(res.statusCode).toBe(200);
      expect(state.writes[0]).toEqual({ key: 'pnc.hubject.clientSecretEnc', value: '' });
    });

    it('keeps the secret when the URLs are unchanged or no secret is stored', async () => {
      queue([{ key: 'pnc.hubject.baseUrl', value: 'https://old.example.com' }], []);
      await send('PUT', '/v1/pnc/settings', { hubjectBaseUrl: 'https://old.example.com' });
      expect(state.writes.map((w) => w.key)).toEqual(['pnc.hubject.baseUrl']);

      state.writes = [];
      queue([{ key: 'pnc.hubject.baseUrl', value: 42 }], []);
      await send('PUT', '/v1/pnc/settings', { hubjectBaseUrl: 'https://new.example.com' });
      expect(state.writes.map((w) => w.key)).toEqual(['pnc.hubject.baseUrl']);
    });

    it('refuses a private Hubject URL and an invalid OCSP host', async () => {
      const privateUrl = await send('PUT', '/v1/pnc/settings', {
        hubjectTokenUrl: 'http://127.0.0.1/token',
      });
      expect(privateUrl.statusCode).toBe(400);
      expect(privateUrl.json()).toMatchObject({ code: 'PRIVATE_URL' });
      const badHost = await send('PUT', '/v1/pnc/settings', {
        ocspAllowedPrivateHosts: ['http://host:80'],
      });
      expect(badHost.statusCode).toBe(400);
      expect(badHost.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(state.writes).toHaveLength(0);
    });

    it('answers 500 when a new secret arrives without an encryption key', async () => {
      mutableConfig.SETTINGS_ENCRYPTION_KEY = '';
      const res = await send('PUT', '/v1/pnc/settings', { hubjectClientSecret: 's' });
      expect(res.statusCode).toBe(500);
      expect(state.writes).toHaveLength(0);
    });
  });

  describe('POST /pnc/settings/test-provider', () => {
    it('passes the manual provider, also when none is stored', async () => {
      queue([]);
      const res = await send('POST', '/v1/pnc/settings/test-provider');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ success: true, provider: 'manual' });
    });

    it('checks the local provider CA and eMAID settings', async () => {
      const localRows = [
        { key: 'pnc.provider', value: 'local' },
        { key: 'pnc.local.emaidCountry', value: 'DE' },
        { key: 'pnc.local.emaidProviderId', value: 'ABC' },
      ];
      queue(localRows, [{ value: 'enc:ca' }]);
      const ok = await send('POST', '/v1/pnc/settings/test-provider');
      expect(ok.json()).toMatchObject({ success: true, provider: 'local' });

      queue(localRows, []);
      const noCa = await send('POST', '/v1/pnc/settings/test-provider');
      expect(noCa.statusCode).toBe(400);
      expect(noCa.json()).toMatchObject({ success: false });

      queue([{ key: 'pnc.provider', value: 'local' }], [{ value: 'enc:ca' }]);
      const noPrefix = await send('POST', '/v1/pnc/settings/test-provider');
      expect(noPrefix.statusCode).toBe(400);
    });

    it('answers 400 when a Hubject setting is missing', async () => {
      queue(HUBJECT_ROWS.filter((r) => r.key !== 'pnc.hubject.clientSecretEnc'));
      const res = await send('POST', '/v1/pnc/settings/test-provider');
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ success: false });
      expect(state.fetchImpl).not.toHaveBeenCalled();
    });

    it('refuses a stored private base URL', async () => {
      queue(
        HUBJECT_ROWS.map((r) =>
          r.key === 'pnc.hubject.baseUrl' ? { ...r, value: 'http://10.0.0.1' } : r,
        ),
      );
      const res = await send('POST', '/v1/pnc/settings/test-provider');
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ success: false, code: 'PRIVATE_URL' });
      expect(state.fetchImpl).not.toHaveBeenCalled();
    });

    it('counts 200, 401 and 403 as reachable and fetches the EST cacerts URL', async () => {
      for (const status of [200, 401, 403]) {
        state.fetchImpl.mockResolvedValueOnce(new Response(null, { status }));
        queue(HUBJECT_ROWS);
        const res = await send('POST', '/v1/pnc/settings/test-provider');
        expect(res.statusCode, String(status)).toBe(200);
        expect(res.json()).toMatchObject({ success: true, provider: 'hubject' });
      }
      expect(state.fetchImpl.mock.calls[0]?.[0]).toBe(
        'https://hubject.example.com/.well-known/est/cacerts',
      );
      expect(state.fetchImpl.mock.calls[0]?.[1]).toMatchObject({
        method: 'GET',
        redirect: 'error',
      });
    });

    it('fails the test for another provider status and for a fetch error', async () => {
      state.fetchImpl.mockResolvedValueOnce(new Response('down', { status: 503 }));
      queue(HUBJECT_ROWS);
      const bad = await send('POST', '/v1/pnc/settings/test-provider');
      expect(bad.statusCode).toBe(502);
      expect(bad.json()).toEqual({
        success: false,
        error: 'Provider returned 503',
        code: 'PROVIDER_TEST_FAILED',
      });

      state.fetchImpl.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      queue(HUBJECT_ROWS);
      const failed = await send('POST', '/v1/pnc/settings/test-provider');
      expect(failed.statusCode).toBe(502);
      expect(failed.json()).toEqual({
        success: false,
        error: 'ECONNREFUSED',
        code: 'PROVIDER_TEST_FAILED',
      });

      state.fetchImpl.mockRejectedValueOnce('not an error');
      queue(HUBJECT_ROWS);
      const unknown = await send('POST', '/v1/pnc/settings/test-provider');
      expect(unknown.statusCode).toBe(502);
      expect(unknown.json()).toEqual({
        success: false,
        error: 'Unknown error',
        code: 'PROVIDER_TEST_FAILED',
      });
      expect(state.fetchImpl).toHaveBeenCalledTimes(3);
    });
  });
});
