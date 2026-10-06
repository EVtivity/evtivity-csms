// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { state, rec, mockPublish, getUserSiteIdsMock } = vi.hoisted(() => ({
  state: { results: [] as unknown[], index: 0 },
  rec: { where: [] as unknown[] },
  mockPublish: vi.fn(),
  getUserSiteIdsMock: vi.fn(),
}));

/** Results per awaited query, in order. An Error entry makes that query reject. */
function setupDbResults(...results: unknown[]): void {
  state.results = results;
  state.index = 0;
}

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of [
    'select',
    'from',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'values',
    'returning',
    'set',
  ]) {
    chain[m] = vi.fn(() => chain);
  }
  chain['where'] = vi.fn((w: unknown) => {
    rec.where.push(w);
    return chain;
  });
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const r = state.results[state.index] ?? [];
      state.index++;
      return (r instanceof Error ? Promise.reject(r) : Promise.resolve(r)).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    selectDistinct: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
  },
  firmwareCampaigns: { id: 'fc.id', createdAt: 'fc.created_at', status: 'fc.status' },
  firmwareCampaignStatusEnum: { enumValues: ['draft', 'active', 'completed', 'cancelled'] },
  firmwareCampaignStations: {
    id: 'fcs.id',
    campaignId: 'fcs.campaign_id',
    stationId: 'fcs.station_id',
    status: 'fcs.status',
    errorInfo: 'fcs.error_info',
    updatedAt: 'fcs.updated_at',
  },
  chargingStations: {
    id: 'st.id',
    stationId: 'st.station_id',
    isOnline: 'st.is_online',
    siteId: 'st.site_id',
    vendorId: 'st.vendor_id',
    model: 'st.model',
  },
  firmwareUpdates: {},
  sites: { id: 'sites.id', name: 'sites.name' },
  vendors: { id: 'vendors.id', name: 'vendors.name' },
  writeAudit: vi.fn().mockResolvedValue(undefined),
  firmwareCampaignAuditLog: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((c: unknown, v: unknown) => ({ eq: [c, v] })),
  and: vi.fn((...p: unknown[]) => ({ and: p })),
  inArray: vi.fn((c: unknown, v: unknown) => ({ inArray: [c, v] })),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
  notInArray: vi.fn(),
  isNull: vi.fn(),
  isNotNull: vi.fn((c: unknown) => ({ isNotNull: c })),
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({ publish: mockPublish, subscribe: vi.fn() })),
  setPubSub: vi.fn(),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: getUserSiteIdsMock,
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
  invalidatePermissionCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { firmwareCampaignRoutes } from '../routes/firmware-campaigns.js';

const FULL_FILTER = {
  siteId: 'sit_1',
  vendorId: 'vnd_1',
  model: 'Terra AC',
  stationId: 'sta_1',
};

function campaign(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'camp-001',
    name: 'Rollout',
    firmwareUrl: 'https://example.com/fw.bin',
    version: '2.0.0',
    signingCertificate: null,
    signature: null,
    status: 'draft',
    targetFilter: FULL_FILTER,
    createdById: 'usr_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('firmware campaign routes (cov2)', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };
  const logs: Array<{ level: number; msg: string }> = [];

  beforeAll(async () => {
    app = Fastify({
      logger: {
        level: 'warn',
        stream: {
          write: (line: string) => {
            logs.push(JSON.parse(line) as { level: number; msg: string });
          },
        },
      },
    });
    await registerAuth(app);
    await app.register(firmwareCampaignRoutes, { prefix: '/v1' });
    await app.ready();
    auth = { authorization: `Bearer ${app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    rec.where.length = 0;
    logs.length = 0;
    mockPublish.mockReset().mockResolvedValue(undefined);
    getUserSiteIdsMock.mockReset().mockResolvedValue(['sit_1', 'sit_2']);
  });

  describe('GET /v1/firmware-campaigns/filter-options', () => {
    it('filters sites and stations by query and site access', async () => {
      setupDbResults(
        [{ id: 'sit_1', name: 'Downtown' }],
        [{ id: 'vnd_1', name: 'ABB' }],
        [{ model: 'Terra AC' }],
        [{ id: 'sta_1', stationId: 'CS-1' }],
      );
      const res = await app.inject({
        method: 'GET',
        url: '/v1/firmware-campaigns/filter-options?siteId=sit_1&vendorId=vnd_1&model=Terra%20AC',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        sites: [{ id: 'sit_1', name: 'Downtown' }],
        vendors: [{ id: 'vnd_1', name: 'ABB' }],
        models: ['Terra AC'],
        stations: [{ id: 'sta_1', stationId: 'CS-1' }],
      });
      expect(rec.where).toContainEqual({ inArray: ['sites.id', ['sit_1', 'sit_2']] });
      expect(rec.where).toContainEqual({
        and: [
          { eq: ['st.site_id', 'sit_1'] },
          { eq: ['st.vendor_id', 'vnd_1'] },
          { eq: ['st.model', 'Terra AC'] },
          { inArray: ['st.site_id', ['sit_1', 'sit_2']] },
        ],
      });
    });

    it('lists no stations for an operator with no sites', async () => {
      getUserSiteIdsMock.mockResolvedValue([]);
      setupDbResults([], [{ id: 'vnd_1', name: 'ABB' }], []);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/firmware-campaigns/filter-options',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ sites: [], stations: [] });
      expect(state.index).toBe(3);
    });
  });

  it('GET /v1/firmware-campaigns/:id counts stations per status', async () => {
    setupDbResults(
      [campaign({ status: 'active' })],
      [],
      [{ total: 5 }],
      [
        { status: 'installed', count: 2 },
        { status: 'failed', count: 1 },
        { status: 'downloading', count: 2 },
      ],
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/firmware-campaigns/camp-001',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      stationsTotal: 5,
      installedCount: 2,
      failedCount: 1,
      downloadingCount: 2,
      pendingCount: 0,
      downloadedCount: 0,
      installingCount: 0,
    });
  });

  describe('GET /v1/firmware-campaigns/:id/matching-stations', () => {
    it('applies every target filter, the online status and site access', async () => {
      setupDbResults([campaign()], [], [{ total: 0 }]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/firmware-campaigns/camp-001/matching-stations?status=online',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(rec.where[1]).toEqual({
        and: [
          { eq: ['st.site_id', 'sit_1'] },
          { eq: ['st.vendor_id', 'vnd_1'] },
          { eq: ['st.model', 'Terra AC'] },
          { eq: ['st.id', 'sta_1'] },
          { eq: ['st.is_online', true] },
          { inArray: ['st.site_id', ['sit_1', 'sit_2']] },
        ],
      });
    });

    it('filters offline stations', async () => {
      setupDbResults([campaign({ targetFilter: null })], [], [{ total: 0 }]);
      getUserSiteIdsMock.mockResolvedValue(null);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/firmware-campaigns/camp-001/matching-stations?status=offline',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(rec.where[1]).toEqual({ and: [{ eq: ['st.is_online', false] }] });
    });

    it('returns an empty page for an operator with no sites', async () => {
      getUserSiteIdsMock.mockResolvedValue([]);
      setupDbResults([campaign()]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/firmware-campaigns/camp-001/matching-stations',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(state.index).toBe(1);
    });
  });

  describe('POST /v1/firmware-campaigns/:id/start', () => {
    const start = () =>
      app.inject({
        method: 'POST',
        url: '/v1/firmware-campaigns/camp-001/start',
        headers: auth,
      });

    it('refuses to start for an operator with no sites', async () => {
      getUserSiteIdsMock.mockResolvedValue([]);
      setupDbResults([campaign()]);
      const res = await start();
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'No matching stations found', code: 'NO_TARGETS' });
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('targets online stations matching every filter at the allowed sites', async () => {
      setupDbResults(
        [campaign()],
        [{ id: 'sta_1', stationId: 'CS-1' }],
        [{ id: 'camp-001' }],
        [],
        [],
      );
      const res = await start();
      expect(res.statusCode).toBe(200);
      expect(rec.where[1]).toEqual({
        and: [
          { eq: ['st.is_online', true] },
          { eq: ['st.site_id', 'sit_1'] },
          { eq: ['st.vendor_id', 'vnd_1'] },
          { eq: ['st.model', 'Terra AC'] },
          { eq: ['st.id', 'sta_1'] },
          { inArray: ['st.site_id', ['sit_1', 'sit_2']] },
        ],
      });
      expect(mockPublish).toHaveBeenCalledTimes(1);
    });

    it('answers 409 NOT_DRAFT when another start claimed the campaign first', async () => {
      setupDbResults([campaign()], [{ id: 'sta_1', stationId: 'CS-1' }], []);
      const res = await start();
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'Campaign is not in draft state', code: 'NOT_DRAFT' });
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('still dispatches when the firmware_updates pre-insert fails, and warns', async () => {
      setupDbResults(
        [campaign()],
        [{ id: 'sta_1', stationId: 'CS-1' }],
        [{ id: 'camp-001' }],
        [],
        new Error('insert failed'),
      );
      const res = await start();
      expect(res.statusCode).toBe(200);
      expect(mockPublish).toHaveBeenCalledTimes(1);
      expect(mockPublish.mock.calls[0]?.[0]).toBe('ocpp_commands');
      expect(logs.map((l) => l.msg)).toContain(
        'firmware-campaign: batch pre-insert of firmware_updates failed; campaign linkage will be missing for this campaign',
      );
    });

    it('reports success and warns per station whose command could not be published', async () => {
      mockPublish.mockRejectedValueOnce(new Error('redis down')).mockResolvedValueOnce(undefined);
      setupDbResults(
        [campaign({ targetFilter: null })],
        [
          { id: 'sta_1', stationId: 'CS-1' },
          { id: 'sta_2', stationId: 'CS-2' },
        ],
        [{ id: 'camp-001' }],
        [],
        [],
      );
      const res = await start();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(mockPublish).toHaveBeenCalledTimes(2);
      const warns = logs.filter(
        (l) => l.msg === 'firmware-campaign: failed to publish ocpp_commands',
      );
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatchObject({ stationId: 'sta_1', campaignId: 'camp-001' });
    });
  });
});
