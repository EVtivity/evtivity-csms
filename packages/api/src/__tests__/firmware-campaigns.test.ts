// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// -- DB mock helpers --

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
    'selectDistinct',
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
    'onConflictDoNothing',
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
    selectDistinct: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
  },
  firmwareCampaigns: { id: 'id', createdAt: 'createdAt', status: 'status' },
  firmwareCampaignStations: {
    id: 'id',
    campaignId: 'campaignId',
    stationId: 'stationId',
    status: 'status',
    errorInfo: 'errorInfo',
    updatedAt: 'updatedAt',
  },
  chargingStations: {
    id: 'id',
    stationId: 'stationId',
    isOnline: 'isOnline',
    siteId: 'siteId',
    vendorId: 'vendorId',
    model: 'model',
  },
  firmwareUpdates: {},
  sites: { id: 'id', name: 'name' },
  vendors: { id: 'id', name: 'name' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
  notInArray: vi.fn(),
  isNull: vi.fn(),
  isNotNull: vi.fn(),
  inArray: vi.fn(),
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);

vi.mock('../lib/pubsub.js', () => ({
  getPubSub: vi.fn(() => ({
    publish: mockPublish,
    subscribe: vi.fn(),
  })),
  setPubSub: vi.fn(),
}));

vi.mock('../lib/site-access.js', () => ({
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
  invalidatePermissionCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { firmwareCampaignRoutes } from '../routes/firmware-campaigns.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(firmwareCampaignRoutes, { prefix: '/v1' });
  await app.ready();
  return app;
}

describe('Firmware campaign routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: 'test-user-id', roleId: 'test-role' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbResults = [];
    dbCallIndex = 0;
    vi.clearAllMocks();
    mockPublish.mockResolvedValue(undefined);
  });

  // ===================================================================
  // GET /v1/firmware-campaigns/filter-options
  // ===================================================================

  describe('GET /v1/firmware-campaigns/filter-options', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/firmware-campaigns/filter-options',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 200 with sites, vendors, and models', async () => {
      const siteRows = [{ id: 'site-1', name: 'Downtown' }];
      const vendorRows = [{ id: 'vnd-1', name: 'ABB' }];
      const modelRows = [{ model: 'Terra AC' }];

      // 1. select sites, 2. select vendors, 3. selectDistinct models
      setupDbResults(siteRows, vendorRows, modelRows);

      const response = await app.inject({
        method: 'GET',
        url: '/v1/firmware-campaigns/filter-options',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.sites).toHaveLength(1);
      expect(body.sites[0].name).toBe('Downtown');
      expect(body.vendors).toHaveLength(1);
      expect(body.vendors[0].name).toBe('ABB');
      expect(body.models).toEqual(['Terra AC']);
    });
  });

  // ===================================================================
  // GET /v1/firmware-campaigns
  // ===================================================================

  describe('GET /v1/firmware-campaigns', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/firmware-campaigns',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 200 with data and total', async () => {
      const campaign = {
        id: 'camp-001',
        name: 'Firmware v2.0 rollout',
        firmwareUrl: 'https://example.com/fw.bin',
        version: '2.0.0',
        status: 'draft',
        targetFilter: null,
        createdById: 'test-user-id',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 1. select campaigns, 2. select count
      setupDbResults([campaign], [{ total: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: '/v1/firmware-campaigns',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe('Firmware v2.0 rollout');
      expect(body.total).toBe(1);
    });

    it('returns 200 with empty data when no campaigns exist', async () => {
      // 1. select campaigns, 2. select count
      setupDbResults([], [{ total: 0 }]);

      const response = await app.inject({
        method: 'GET',
        url: '/v1/firmware-campaigns',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });
  });

  // ===================================================================
  // GET /v1/firmware-campaigns/:id
  // ===================================================================

  describe('GET /v1/firmware-campaigns/:id', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/firmware-campaigns/camp-001',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when campaign not found', async () => {
      // 1. select campaign by id
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: '/v1/firmware-campaigns/camp-999',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('CAMPAIGN_NOT_FOUND');
    });

    it('returns 200 with campaign and stations', async () => {
      const campaign = {
        id: 'camp-001',
        name: 'Firmware v2.0 rollout',
        firmwareUrl: 'https://example.com/fw.bin',
        version: '2.0.0',
        status: 'active',
        targetFilter: null,
        createdById: 'test-user-id',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const stationRow = {
        id: 'cs-001',
        stationId: 'sta-uuid-001',
        stationName: 'STATION-001',
        status: 'pending',
        errorInfo: null,
        updatedAt: new Date().toISOString(),
      };

      // 1. select campaign, 2. select campaign stations joined with charging stations
      setupDbResults([campaign], [stationRow]);

      const response = await app.inject({
        method: 'GET',
        url: '/v1/firmware-campaigns/camp-001',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.name).toBe('Firmware v2.0 rollout');
      expect(body.stations).toHaveLength(1);
      expect(body.stations[0].stationName).toBe('STATION-001');
    });
  });

  // ===================================================================
  // POST /v1/firmware-campaigns
  // ===================================================================

  describe('POST /v1/firmware-campaigns', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/firmware-campaigns',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Test campaign',
          firmwareUrl: 'https://example.com/fw.bin',
        }),
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 201 with created campaign', async () => {
      const created = {
        id: 'camp-new',
        name: 'New campaign',
        firmwareUrl: 'https://example.com/fw.bin',
        version: '1.0.0',
        status: 'draft',
        targetFilter: null,
        createdById: 'test-user-id',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 1. insert returning
      setupDbResults([created]);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/firmware-campaigns',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'New campaign',
          firmwareUrl: 'https://example.com/fw.bin',
          version: '1.0.0',
        }),
      });
      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.id).toBe('camp-new');
      expect(body.name).toBe('New campaign');
      expect(body.status).toBe('draft');
    });
  });

  // ===================================================================
  // PATCH /v1/firmware-campaigns/:id
  // ===================================================================

  describe('PATCH /v1/firmware-campaigns/:id', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/v1/firmware-campaigns/camp-001',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when campaign not found', async () => {
      // 1. select campaign
      setupDbResults([]);

      const response = await app.inject({
        method: 'PATCH',
        url: '/v1/firmware-campaigns/camp-999',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Updated' }),
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('CAMPAIGN_NOT_FOUND');
    });

    it('returns 409 when campaign is not draft', async () => {
      const campaign = {
        id: 'camp-001',
        name: 'Active campaign',
        firmwareUrl: 'https://example.com/fw.bin',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 1. select campaign
      setupDbResults([campaign]);

      const response = await app.inject({
        method: 'PATCH',
        url: '/v1/firmware-campaigns/camp-001',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Updated' }),
      });
      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('NOT_DRAFT');
    });

    it('returns 200 on successful update', async () => {
      const campaign = {
        id: 'camp-001',
        name: 'Draft campaign',
        firmwareUrl: 'https://example.com/fw.bin',
        status: 'draft',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const updated = {
        ...campaign,
        name: 'Updated campaign',
        updatedAt: new Date().toISOString(),
      };

      // 1. select campaign, 2. update returning
      setupDbResults([campaign], [updated]);

      const response = await app.inject({
        method: 'PATCH',
        url: '/v1/firmware-campaigns/camp-001',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Updated campaign' }),
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.name).toBe('Updated campaign');
    });
  });

  // ===================================================================
  // DELETE /v1/firmware-campaigns/:id
  // ===================================================================

  describe('DELETE /v1/firmware-campaigns/:id', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/v1/firmware-campaigns/camp-001',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when campaign not found', async () => {
      // 1. select campaign
      setupDbResults([]);

      const response = await app.inject({
        method: 'DELETE',
        url: '/v1/firmware-campaigns/camp-999',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('CAMPAIGN_NOT_FOUND');
    });

    it('returns 409 when campaign is not draft', async () => {
      const campaign = {
        id: 'camp-001',
        name: 'Active campaign',
        firmwareUrl: 'https://example.com/fw.bin',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 1. select campaign
      setupDbResults([campaign]);

      const response = await app.inject({
        method: 'DELETE',
        url: '/v1/firmware-campaigns/camp-001',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('NOT_DRAFT');
    });

    it('returns 204 on successful delete', async () => {
      const campaign = {
        id: 'camp-001',
        name: 'Draft campaign',
        firmwareUrl: 'https://example.com/fw.bin',
        status: 'draft',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 1. select campaign, 2. delete
      setupDbResults([campaign], []);

      const response = await app.inject({
        method: 'DELETE',
        url: '/v1/firmware-campaigns/camp-001',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(204);
    });
  });

  // ===================================================================
  // POST /v1/firmware-campaigns/:id/start
  // ===================================================================

  describe('GET /v1/firmware-campaigns/:id/matching-stations', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/firmware-campaigns/camp-001/matching-stations',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when campaign not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: '/v1/firmware-campaigns/camp-999/matching-stations',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('CAMPAIGN_NOT_FOUND');
    });

    it('returns 200 with matching stations and total', async () => {
      const campaign = {
        id: 'camp-001',
        name: 'Draft campaign',
        firmwareUrl: 'https://example.com/fw.bin',
        status: 'draft',
        targetFilter: { siteId: 'site-1' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const stationRows = [
        {
          id: 'sta-1',
          stationId: 'STATION-001',
          model: 'Terra AC',
          firmwareVersion: '1.0.0',
          siteName: 'Downtown',
          vendorName: 'ABB',
        },
      ];

      // 1. select campaign, 2. select stations, 3. select count
      setupDbResults([campaign], stationRows, [{ total: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: '/v1/firmware-campaigns/camp-001/matching-stations',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].stationId).toBe('STATION-001');
      expect(body.total).toBe(1);
    });
  });

  // ===================================================================

  describe('POST /v1/firmware-campaigns/:id/start', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/firmware-campaigns/camp-001/start',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when campaign not found', async () => {
      // 1. select campaign
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/firmware-campaigns/camp-999/start',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('CAMPAIGN_NOT_FOUND');
    });

    it('returns 409 when campaign is not draft', async () => {
      const campaign = {
        id: 'camp-001',
        name: 'Active campaign',
        firmwareUrl: 'https://example.com/fw.bin',
        status: 'active',
        targetFilter: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 1. select campaign
      setupDbResults([campaign]);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/firmware-campaigns/camp-001/start',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('NOT_DRAFT');
    });

    it('returns 409 when no matching stations found', async () => {
      const campaign = {
        id: 'camp-001',
        name: 'Draft campaign',
        firmwareUrl: 'https://example.com/fw.bin',
        status: 'draft',
        targetFilter: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 1. select campaign, 2. select target stations (empty)
      setupDbResults([campaign], []);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/firmware-campaigns/camp-001/start',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('NO_TARGETS');
    });

    it('returns 200 on successful start and publishes commands', async () => {
      const campaign = {
        id: 'camp-001',
        name: 'Draft campaign',
        firmwareUrl: 'https://example.com/fw.bin',
        version: '2.0.0',
        status: 'draft',
        targetFilter: { siteId: 'site-001' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const targets = [
        { id: 'sta-uuid-001', stationId: 'STATION-001' },
        { id: 'sta-uuid-002', stationId: 'STATION-002' },
      ];

      // 1. select campaign, 2. select target stations,
      // 3. insert campaign_stations, 4. update campaign status,
      // 5. insert firmware_updates (station 1), 6. insert firmware_updates (station 2)
      setupDbResults([campaign], targets, [], [], [], []);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/firmware-campaigns/camp-001/start',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);

      // Verify pubsub.publish was called for each target station
      expect(mockPublish).toHaveBeenCalledTimes(2);
      for (const call of mockPublish.mock.calls) {
        expect(call[0]).toBe('ocpp_commands');
        const payload = JSON.parse(call[1] as string);
        expect(payload.action).toBe('UpdateFirmware');
        expect(payload.payload.firmware.location).toBe('https://example.com/fw.bin');
      }
    });
  });

  // ===================================================================
  // POST /v1/firmware-campaigns/:id/cancel
  // ===================================================================

  describe('POST /v1/firmware-campaigns/:id/cancel', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/firmware-campaigns/camp-001/cancel',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when campaign not found', async () => {
      // 1. select campaign
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/firmware-campaigns/camp-999/cancel',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('CAMPAIGN_NOT_FOUND');
    });

    it('returns 200 on successful cancel', async () => {
      const campaign = {
        id: 'camp-001',
        name: 'Active campaign',
        firmwareUrl: 'https://example.com/fw.bin',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 1. select campaign, 2. update status to cancelled
      setupDbResults([campaign], []);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/firmware-campaigns/camp-001/cancel',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
    });
  });
});
