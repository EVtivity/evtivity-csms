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
  mockClearSim,
  mockClearAi,
  published,
  proofCheck,
  mockNotice,
} = vi.hoisted(() => ({
  stored: { rows: [] as Array<{ key: string; value: unknown }> },
  written: [] as Array<{ key: string; value: unknown }>,
  mockWriteAudit: vi.fn(async () => undefined),
  mockClearSim: vi.fn(),
  mockClearAi: vi.fn(),
  published: [] as Array<{ channel: string; message: string }>,
  // The proof itself has its own tests (session-proof, mfa-factor-proof).
  proofCheck: { calls: 0, accept: true },
  mockNotice: vi.fn(),
}));

vi.mock('../lib/session-proof.js', () => ({
  requireSessionProof: async (
    _request: unknown,
    reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    proof: unknown,
  ) => {
    proofCheck.calls += 1;
    if (proofCheck.accept && proof != null) return true;
    await reply
      .status(400)
      .send({ error: 'Proof required', code: 'VALIDATION_ERROR', proofKinds: ['password'] });
    return false;
  },
}));

vi.mock('../lib/security-notice.js', () => ({ sendSecurityNotice: mockNotice }));

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
      selectDistinct: vi.fn(() => ({
        from: () => ({
          innerJoin: () => ({ where: () => Promise.resolve([{ id: 'usr_admin_00001' }]) }),
        }),
      })),
      transaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
    },
    writeAudit: mockWriteAudit,
    clearAiSettingsCache: mockClearAi,
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
  requestHasPermission: vi.fn(async () => true),
}));

vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);

vi.mock('../lib/sim.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, clearSimCaches: mockClearSim };
});

import { DATA_RETENTION_KEYS, DATA_RETENTION_SETTINGS } from '@evtivity/lib';
import { setPubSub } from '@evtivity/lib/pubsub-instance';
import { registerAuth } from '../plugins/auth.js';
import { dataRetentionSettingsRoutes } from '../routes/data-retention-settings.js';
import { resetSiteAccessMock, setMockUserSiteIds } from './helpers/site-access-mock.js';

describe('data retention settings routes', () => {
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
    await app.register(dataRetentionSettingsRoutes);
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
    mockWriteAudit.mockClear();
    mockClearSim.mockClear();
    mockClearAi.mockClear();
    mockNotice.mockClear();
    proofCheck.calls = 0;
    proofCheck.accept = true;
  });

  const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });
  const get = () => app.inject({ method: 'GET', url: '/settings/data-retention', headers: auth() });
  const put = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: '/settings/data-retention', headers: auth(), payload });

  describe('GET /settings/data-retention', () => {
    it('returns every key: the stored value, else the default', async () => {
      stored.rows = [
        { key: 'logs.ocppMessage.retentionDays', value: 14 },
        { key: 'logs.meterValues.retentionDays', value: 0 },
        { key: 'sim.sessions.retentionDays', value: 3 },
      ];
      const res = await get();
      expect(res.statusCode).toBe(200);
      const body = res.json<Record<string, number>>();
      expect(Object.keys(body).sort()).toEqual([...DATA_RETENTION_KEYS].sort());
      expect(body['logs.ocppMessage.retentionDays']).toBe(14);
      expect(body['logs.meterValues.retentionDays']).toBe(0);
      // Outside the SIM range the reader uses the default.
      expect(body['sim.sessions.retentionDays']).toBe(90);
      expect(body['audit.retentionDays']).toBe(1095);
    });

    it('answers a site-restricted user 404 SETTING_NOT_FOUND', async () => {
      setMockUserSiteIds(['sit_000000000001']);
      const res = await get();
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('SETTING_NOT_FOUND');
    });
  });

  describe('PUT /settings/data-retention', () => {
    it('stores the changed keys, audits each and returns the new values', async () => {
      stored.rows = [
        { key: 'logs.ocppMessage.retentionDays', value: 30 },
        { key: 'audit.retentionDays', value: 1095 },
      ];
      const res = await put({
        'logs.ocppMessage.retentionDays': 7,
        'audit.retentionDays': 1095,
        'refreshTokens.retentionDays': 0,
      });
      expect(res.statusCode).toBe(200);
      expect(written).toEqual([
        { key: 'logs.ocppMessage.retentionDays', value: 7 },
        { key: 'refreshTokens.retentionDays', value: 0 },
      ]);
      const audits = mockWriteAudit.mock.calls.map(
        (call) =>
          (call as unknown[])[1] as {
            entityId: string;
            before: { value: unknown };
            after: { value: unknown };
          },
      );
      expect(audits.map((a) => [a.entityId, a.before.value, a.after.value])).toEqual([
        ['logs.ocppMessage.retentionDays', 30, 7],
        ['refreshTokens.retentionDays', null, 0],
      ]);
      const body = res.json<Record<string, number>>();
      expect(body['logs.ocppMessage.retentionDays']).toBe(7);
      expect(body['refreshTokens.retentionDays']).toBe(0);
      expect(mockClearSim).not.toHaveBeenCalled();
      expect(mockClearAi).not.toHaveBeenCalled();
    });

    it('clears the AI cache for an AI key and the SIM caches for the SIM key', async () => {
      const res = await put({
        'ai.conversationRetentionDays': 60,
        'sim.sessions.retentionDays': 30,
      });
      expect(res.statusCode).toBe(200);
      expect(mockClearAi).toHaveBeenCalledTimes(1);
      expect(mockClearSim).toHaveBeenCalledTimes(1);
      expect(published).toEqual([
        { channel: 'cache_invalidate', message: JSON.stringify({ kind: 'sim_settings' }) },
      ]);
    });

    it('writes nothing when every value equals the stored one', async () => {
      stored.rows = [{ key: 'logs.access.retentionDays', value: 30 }];
      const res = await put({ 'logs.access.retentionDays': 30 });
      expect(res.statusCode).toBe(200);
      expect(written).toEqual([]);
      expect(mockWriteAudit).not.toHaveBeenCalled();
    });

    const outOfRange = DATA_RETENTION_KEYS.flatMap((key) => {
      const def = DATA_RETENTION_SETTINGS[key];
      return [{ [key]: def.min - 1 }, { [key]: def.max + 1 }];
    });

    it.each([
      ...outOfRange.map((p) => [p] as const),
      [{ 'logs.ocppMessage.retentionDays': 1.5 }] as const,
      // The security history takes 0 or 30 to 3650 days.
      [{ 'audit.retentionDays': 1, proof: { kind: 'password', password: 'x' } }] as const,
      [
        { 'logs.loginAudit.retentionDays': 29, proof: { kind: 'password', password: 'x' } },
      ] as const,
      [
        { 'logs.securityEvents.retentionDays': 15, proof: { kind: 'password', password: 'x' } },
      ] as const,
      [{ 'sim.sessions.fetchDays': 7 }] as const,
      [{ 'aiInsights.expireAfterDays': 7 }] as const,
    ])('refuses %j with 400 and writes nothing', async (payload) => {
      const res = await put(payload);
      expect(res.statusCode).toBe(400);
      expect(written).toEqual([]);
    });

    it('accepts 0 only for the keys whose job keeps the data forever at 0', async () => {
      const zero = await put({ 'logs.meterValues.retentionDays': 0 });
      expect(zero.statusCode).toBe(200);
      const ai = await put({ 'aiInsights.retentionDays': 0 });
      expect(ai.statusCode).toBe(400);
    });

    describe('shortening the audit, sign-in or security event history', () => {
      it.each([
        ['audit.retentionDays', 30],
        ['logs.loginAudit.retentionDays', 30],
        ['logs.securityEvents.retentionDays', 30],
      ] as const)('refuses %s = %d from a session without a proof', async (key, days) => {
        const res = await put({ [key]: days });
        expect(res.statusCode).toBe(400);
        expect(res.json<{ proofKinds: string[] }>().proofKinds).toEqual(['password']);
        expect(written).toEqual([]);
        expect(mockNotice).not.toHaveBeenCalled();
      });

      it('treats a number of days where 0 kept the history forever as shortening', async () => {
        stored.rows = [{ key: 'audit.retentionDays', value: 0 }];
        const res = await put({ 'audit.retentionDays': 3650 });
        expect(res.statusCode).toBe(400);
        expect(written).toEqual([]);
      });

      it('stores a shortening with a proof and notifies the all-site admins once', async () => {
        const res = await put({
          'audit.retentionDays': 30,
          'logs.access.retentionDays': 10,
          proof: { kind: 'password', password: 'x' },
        });
        expect(res.statusCode).toBe(200);
        expect(written).toEqual(
          expect.arrayContaining([
            { key: 'audit.retentionDays', value: 30 },
            { key: 'logs.access.retentionDays', value: 10 },
          ]),
        );
        await vi.waitFor(() => {
          expect(mockNotice).toHaveBeenCalledTimes(1);
        });
        expect(mockNotice).toHaveBeenCalledWith(
          { userId: 'usr_admin_00001' },
          'security.RetentionLowered',
          { changes: 'audit.retentionDays 1095 -> 30' },
          expect.anything(),
        );
      });

      it('needs no proof and sends no notice to lengthen it, keep it forever, or shorten other logs', async () => {
        for (const payload of [
          { 'audit.retentionDays': 2000 },
          { 'logs.loginAudit.retentionDays': 0 },
          { 'logs.access.retentionDays': 1 },
        ]) {
          const res = await put(payload);
          expect(res.statusCode, JSON.stringify(payload)).toBe(200);
        }
        expect(proofCheck.calls).toBe(0);
        expect(mockNotice).not.toHaveBeenCalled();
      });
    });

    it('answers a site-restricted user 404 and writes nothing', async () => {
      setMockUserSiteIds(['sit_000000000001']);
      const res = await put({ 'logs.access.retentionDays': 10 });
      expect(res.statusCode).toBe(404);
      expect(written).toEqual([]);
    });
  });
});
