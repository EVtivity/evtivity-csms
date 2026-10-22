// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

const {
  stored,
  written,
  mockWriteAudit,
  mockRequestHasPermission,
  mockGetProvider,
  mockClear,
  mockSchedule,
  published,
} = vi.hoisted(() => ({
  stored: { rows: [] as Array<{ key: string; value: unknown }> },
  written: [] as Array<{ key: string; value: unknown }>,
  mockWriteAudit: vi.fn(async () => undefined),
  mockRequestHasPermission: vi.fn(async (_request: unknown, _permission: string) => true),
  mockGetProvider: vi.fn(),
  mockClear: vi.fn(),
  mockSchedule: vi.fn(() => new Promise<void>(() => undefined)),
  published: [] as Array<{ channel: string; message: string }>,
}));

vi.mock('@evtivity/services/station-signal-monitor.service', () => ({
  scheduleLowSignalSync: mockSchedule,
}));

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = { from: () => chain, where: () => Promise.resolve(stored.rows) };
  const tx = {
    insert: () => ({
      values: (row: { key: string; value: unknown }) => ({
        onConflictDoUpdate: async () => {
          written.push(row);
        },
      }),
    }),
  };
  return {
    ...actual,
    db: {
      select: vi.fn(() => chain),
      transaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
    },
    writeAudit: mockWriteAudit,
  };
});

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
  invalidatePermissionCache: vi.fn(),
  requestHasPermission: mockRequestHasPermission,
}));

vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);

vi.mock('../lib/sim.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    simProviderRegistry: () => ({ getProvider: mockGetProvider }),
    clearSimCaches: mockClear,
  };
});

import { decryptString, encryptString } from '@evtivity/lib';
import { setPubSub } from '@evtivity/lib/pubsub-instance';
import { SimProviderError } from '@evtivity/services/station-sim.service';
import { registerAuth } from '../plugins/auth.js';
import { config } from '../lib/config.js';
import { simProviderSettingsRoutes } from '../routes/sim-provider-settings.js';
import { setSimKeyStoreForTests } from '../lib/sim-keys.js';
import { resetSiteAccessMock, setMockUserSiteIds } from './helpers/site-access-mock.js';

const KEY = config.SETTINGS_ENCRYPTION_KEY;

describe('SIM provider settings routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    setPubSub({
      publish: async (channel: string, message: string) => {
        published.push({ channel, message });
      },
      subscribe: async () => ({ unsubscribe: async () => undefined }),
      close: async () => undefined,
    });
    app = Fastify();
    await registerAuth(app);
    await app.register(simProviderSettingsRoutes);
    await app.ready();
    token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetSiteAccessMock();
    stored.rows = [];
    written.length = 0;
    published.length = 0;
    mockRequestHasPermission.mockResolvedValue(true);
  });

  const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

  describe('GET /settings/sim-providers', () => {
    beforeEach(() => {
      stored.rows = [
        { key: 'sim.hologram.enabled', value: true },
        { key: 'sim.hologram.orgId', value: '1234' },
        { key: 'sim.hologram.apiKeyEnc', value: encryptString('hologram-key', KEY) },
        { key: 'sim.sessions.retentionDays', value: 30 },
        { key: 'sim.signal.alertBelowDbm', value: '' },
      ];
    });

    it('returns the API key to a caller with settings.system:read', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/settings/sim-providers',
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<Record<string, unknown>>();
      expect(body['hologram']).toEqual({
        enabled: true,
        orgId: '1234',
        apiKey: 'hologram-key',
        apiKeyConfigured: true,
      });
      expect(body['retentionDays']).toBe(30);
      expect(body['fetchDays']).toBe(7);
      expect(body['signalAlertBelowDbm']).toBeNull();
    });

    it('returns only whether the key is stored without settings.system:read', async () => {
      mockRequestHasPermission.mockResolvedValue(false);
      const res = await app.inject({
        method: 'GET',
        url: '/settings/sim-providers',
        headers: auth(),
      });
      const hologram = res.json<{ hologram: Record<string, unknown> }>().hologram;
      expect(hologram['apiKey']).toBeNull();
      expect(hologram['apiKeyConfigured']).toBe(true);
    });

    it('answers a site-restricted user 404', async () => {
      setMockUserSiteIds(['sit_000000000001']);
      const res = await app.inject({
        method: 'GET',
        url: '/settings/sim-providers',
        headers: auth(),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('SETTING_NOT_FOUND');
    });
  });

  describe('PUT /settings/sim-providers', () => {
    const put = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PUT', url: '/settings/sim-providers', headers: auth(), payload });

    it('stores the trimmed values, encrypts the key, audits it redacted and clears the caches', async () => {
      const res = await put({
        hologram: { enabled: true, orgId: ' 4567 ', apiKey: ' new-key ' },
        retentionDays: 120,
        fetchDays: 14,
        signalAlertBelowDbm: -100,
        ocpp16SignalKeys: [' RSSI ', 'RSSI', 'CellID'],
      });
      expect(res.statusCode).toBe(200);
      const byKey = new Map(written.map((row) => [row.key, row.value]));
      expect(byKey.get('sim.hologram.enabled')).toBe(true);
      expect(byKey.get('sim.hologram.orgId')).toBe('4567');
      expect(decryptString(byKey.get('sim.hologram.apiKeyEnc') as string, KEY)).toBe('new-key');
      expect(byKey.get('sim.sessions.retentionDays')).toBe(120);
      expect(byKey.get('sim.sessions.fetchDays')).toBe(14);
      expect(byKey.get('sim.signal.alertBelowDbm')).toBe(-100);
      expect(byKey.get('sim.ocpp16.signalKeys')).toEqual(['RSSI', 'CellID']);
      expect(mockClear).toHaveBeenCalled();
      const keyAudit = mockWriteAudit.mock.calls
        .map((call) => (call as unknown[])[1] as { entityId: string; after: { value: unknown } })
        .find((args) => args.entityId === 'sim.hologram.apiKeyEnc');
      expect(keyAudit?.after.value).toBe('<redacted>');
    });

    it('tells every process to drop its SIM settings cache', async () => {
      const res = await put({ fetchDays: 14 });
      expect(res.statusCode).toBe(200);
      expect(published).toEqual([
        { channel: 'cache_invalidate', message: JSON.stringify({ kind: 'sim_settings' }) },
      ]);
    });

    it('starts the low signal monitor sync without waiting for it, only when the alert changed', async () => {
      // The scheduled sync never settles here: the save still answers.
      let scheduledBeforeAudit = 0;
      mockWriteAudit.mockImplementationOnce(async () => {
        scheduledBeforeAudit = mockSchedule.mock.calls.length;
      });
      const changed = await put({ stationSignalEnabled: true, signalAlertBelowDbm: -100 });
      expect(changed.statusCode).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
      // It starts once the handler is done, never while the save is still running.
      expect(scheduledBeforeAudit).toBe(0);
      expect(mockSchedule).toHaveBeenCalledTimes(1);

      mockSchedule.mockClear();
      stored.rows = [
        { key: 'sim.stationSignal.enabled', value: true },
        { key: 'sim.signal.alertBelowDbm', value: -100 },
      ];
      const same = await put({
        stationSignalEnabled: true,
        signalAlertBelowDbm: -100,
        fetchDays: 7,
      });
      expect(same.statusCode).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockSchedule).not.toHaveBeenCalled();
    });

    it('writes and audits nothing when the stored API key is sent again', async () => {
      stored.rows = [{ key: 'sim.hologram.apiKeyEnc', value: encryptString('same-key', KEY) }];
      mockWriteAudit.mockClear();
      const res = await put({ hologram: { apiKey: ' same-key ', orgId: '42' } });
      expect(res.statusCode).toBe(200);
      expect(written.map((row) => row.key)).toEqual(['sim.hologram.orgId']);
      const audited = mockWriteAudit.mock.calls.map(
        (call) => ((call as unknown[])[1] as { entityId: string }).entityId,
      );
      expect(audited).toEqual(['sim.hologram.orgId']);
    });

    it('stores an empty alert for null and an empty key', async () => {
      stored.rows = [{ key: 'sim.hologram.apiKeyEnc', value: encryptString('old-key', KEY) }];
      const res = await put({ signalAlertBelowDbm: null, hologram: { apiKey: '' } });
      expect(res.statusCode).toBe(200);
      const byKey = new Map(written.map((row) => [row.key, row.value]));
      expect(byKey.get('sim.signal.alertBelowDbm')).toBe('');
      expect(byKey.get('sim.hologram.apiKeyEnc')).toBe('');
    });

    it.each([
      [{ hologram: { orgId: 'org-12' } }],
      [{ hologram: { orgId: '1234567890123456' } }],
      [{ retentionDays: 6 }],
      [{ retentionDays: 731 }],
      [{ fetchDays: 0 }],
      [{ fetchDays: 32 }],
      [{ signalAlertBelowDbm: -141 }],
      [{ signalGoodDbm: -90, signalFairDbm: -80 }],
      [{ signalGoodDbm: -90 }],
      [{ hologram: { apiKeyEnc: 'x' } }],
      [{ retention: 90 }],
    ])('refuses %j with 400 VALIDATION_ERROR and writes nothing', async (payload) => {
      const res = await put(payload);
      expect(res.statusCode).toBe(400);
      expect(written).toEqual([]);
    });
  });

  describe('POST /settings/sim-providers/:provider/test', () => {
    const test = () =>
      app.inject({ method: 'POST', url: '/settings/sim-providers/hologram/test', headers: auth() });
    const backoffs = new Map<string, number>();
    const counts = new Map<string, number>();
    let countFails = false;

    beforeEach(() => {
      backoffs.clear();
      counts.clear();
      countFails = false;
      setSimKeyStoreForTests({
        acquire: vi.fn(),
        renew: vi.fn(),
        release: vi.fn(),
        ttlSeconds: vi.fn((key: string) => Promise.resolve(backoffs.get(key) ?? null)),
        setFor: vi.fn((key: string, seconds: number) => {
          backoffs.set(key, seconds);
          return Promise.resolve();
        }),
        increment: vi.fn((key: string) => {
          if (countFails) return Promise.reject(new Error('connection lost'));
          counts.set(key, (counts.get(key) ?? 0) + 1);
          return Promise.resolve(counts.get(key) ?? 0);
        }),
      });
    });

    it('allows 6 connection tests a minute per provider, then answers 429 without a provider call', async () => {
      const testConnection = vi.fn().mockResolvedValue({ deviceCount: 1, otherOrganizations: [] });
      mockGetProvider.mockResolvedValue({ testConnection });
      for (let i = 0; i < 6; i += 1) expect((await test()).statusCode).toBe(200);
      const limited = await test();
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ code: 'SIM_PROVIDER_RATE_LIMITED', retryAfter: 60 });
      expect(testConnection).toHaveBeenCalledTimes(6);
      expect(counts.get('sim:test:hologram')).toBe(7);
    });

    it('runs the connection test when the limit cannot be counted', async () => {
      countFails = true;
      const testConnection = vi.fn().mockResolvedValue({ deviceCount: 1, otherOrganizations: [] });
      mockGetProvider.mockResolvedValue({ testConnection });
      expect((await test()).statusCode).toBe(200);
      expect(testConnection).toHaveBeenCalledTimes(1);
    });

    afterAll(() => {
      setSimKeyStoreForTests(null);
    });

    it('calls no provider during its backoff and answers 429 with the retry time', async () => {
      backoffs.set('sim:backoff:hologram', 25);
      const testConnection = vi.fn();
      mockGetProvider.mockResolvedValue({ testConnection });
      const res = await test();
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('25');
      expect(res.json()).toMatchObject({ code: 'SIM_PROVIDER_RATE_LIMITED', retryAfter: 25 });
      expect(testConnection).not.toHaveBeenCalled();
    });

    it('starts the provider backoff when the provider answers 429', async () => {
      mockGetProvider.mockResolvedValue({
        testConnection: vi
          .fn()
          .mockRejectedValue(
            new SimProviderError('rate_limited', 'slow', { retryAfterSeconds: 30 }),
          ),
      });
      expect((await test()).statusCode).toBe(429);
      expect(backoffs.get('sim:backoff:hologram')).toBe(30);
    });

    it('answers 400 SIM_PROVIDER_NOT_CONFIGURED while the provider is off', async () => {
      mockGetProvider.mockResolvedValue(null);
      const res = await test();
      expect(res.statusCode).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('SIM_PROVIDER_NOT_CONFIGURED');
    });

    it('returns the SIM counts', async () => {
      mockGetProvider.mockResolvedValue({
        testConnection: vi.fn().mockResolvedValue({
          deviceCount: 0,
          otherOrganizations: [{ id: '2', name: 'Company', deviceCount: 3 }],
        }),
      });
      const res = await test();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        provider: 'hologram',
        deviceCount: 0,
        otherOrganizations: [{ id: '2', name: 'Company', deviceCount: 3 }],
      });
    });

    it('maps a refused key to 502 SIM_PROVIDER_ERROR and a rate limit to 429', async () => {
      mockGetProvider.mockResolvedValue({
        testConnection: vi.fn().mockRejectedValue(new SimProviderError('auth', 'refused')),
      });
      const refused = await test();
      expect(refused.statusCode).toBe(502);
      expect(refused.json()).toMatchObject({ code: 'SIM_PROVIDER_ERROR', kind: 'auth' });

      mockGetProvider.mockResolvedValue({
        testConnection: vi
          .fn()
          .mockRejectedValue(
            new SimProviderError('rate_limited', 'slow', { retryAfterSeconds: 30 }),
          ),
      });
      const limited = await test();
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBe('30');
      expect(limited.json<{ code: string }>().code).toBe('SIM_PROVIDER_RATE_LIMITED');
    });

    it('refuses an unknown provider', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/settings/sim-providers/kore/test',
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
