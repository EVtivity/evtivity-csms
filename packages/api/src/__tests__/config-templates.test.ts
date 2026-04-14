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
  configTemplates: {},
  configTemplatePushes: {},
  configTemplatePushStations: {},
  chargingStations: {},
  stationConfigurations: {},
  sites: {},
  vendors: {},
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
  isNotNull: vi.fn(),
  notInArray: vi.fn(),
  isNull: vi.fn(),
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

const mockSendOcppCommand = vi
  .fn()
  .mockResolvedValue({ commandId: 'cmd-1', response: { status: 'Accepted' } });

vi.mock('../lib/ocpp-command.js', () => ({
  sendOcppCommandAndWait: (...args: unknown[]) => mockSendOcppCommand(...args),
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
import { configTemplateRoutes } from '../routes/config-templates.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(configTemplateRoutes, { prefix: '/v1' });
  await app.ready();
  return app;
}

describe('Config template routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: 'test-id', roleId: 'test-role' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbResults = [];
    dbCallIndex = 0;
    vi.clearAllMocks();
    mockPublish.mockResolvedValue(undefined);
    mockSendOcppCommand.mockResolvedValue({ commandId: 'cmd-1', response: { status: 'Accepted' } });
  });

  // ===================================================================
  // GET /v1/config-templates/filter-options
  // ===================================================================

  describe('GET /v1/config-templates/filter-options', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/config-templates/filter-options',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 with filter options', async () => {
      const siteRows = [{ id: 'site-1', name: 'Site A' }];
      const vendorRows = [{ id: 'vnd-1', name: 'Vendor X' }];
      const modelRows = [{ model: 'Model Y' }];
      setupDbResults(siteRows, vendorRows, modelRows);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/config-templates/filter-options',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.sites).toHaveLength(1);
      expect(body.vendors).toHaveLength(1);
      expect(body.models).toEqual(['Model Y']);
    });
  });

  // ===================================================================
  // GET /v1/config-templates
  // ===================================================================

  describe('GET /v1/config-templates', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/config-templates',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 with paginated templates', async () => {
      const templates = [
        {
          id: 'tpl-1',
          name: 'Default Config',
          description: 'Default station config',
          variables: [{ component: 'EVSE', variable: 'MaxCurrent', value: '32' }],
          targetFilter: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ];
      setupDbResults(templates, [{ total: 1 }]);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/config-templates',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe('Default Config');
      expect(body.total).toBe(1);
    });

    it('returns 200 with empty data when no templates exist', async () => {
      setupDbResults([], [{ total: 0 }]);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/config-templates',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });
  });

  // ===================================================================
  // GET /v1/config-templates/:id
  // ===================================================================

  describe('GET /v1/config-templates/:id', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/config-templates/tpl-1',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when template not found', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/config-templates/nonexistent',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBe('Template not found');
      expect(body.code).toBe('TEMPLATE_NOT_FOUND');
    });

    it('returns 200 with template', async () => {
      const template = {
        id: 'tpl-1',
        name: 'Default Config',
        description: 'Default station config',
        variables: [{ component: 'EVSE', variable: 'MaxCurrent', value: '32' }],
        targetFilter: { siteId: 'site-1' },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };
      setupDbResults([template]);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/config-templates/tpl-1',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.name).toBe('Default Config');
      expect(body.targetFilter).toEqual({ siteId: 'site-1' });
    });
  });

  // ===================================================================
  // POST /v1/config-templates
  // ===================================================================

  describe('POST /v1/config-templates', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/config-templates',
        payload: { name: 'Test', variables: [] },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 201 with created template', async () => {
      const created = {
        id: 'tpl-new',
        name: 'New Template',
        description: 'A new config template',
        ocppVersion: '2.1',
        variables: [{ component: 'EVSE', variable: 'MaxCurrent', value: '32' }],
        targetFilter: { siteId: 'site-1' },
        createdAt: '2026-01-15T00:00:00Z',
        updatedAt: '2026-01-15T00:00:00Z',
      };
      setupDbResults([created]);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/config-templates',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: 'New Template',
          description: 'A new config template',
          ocppVersion: '2.1',
          variables: [{ component: 'EVSE', variable: 'MaxCurrent', value: '32' }],
          targetFilter: { siteId: 'site-1' },
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBe('tpl-new');
      expect(body.name).toBe('New Template');
      expect(body.ocppVersion).toBe('2.1');
    });

    it('returns 201 with 1.6 template', async () => {
      const created = {
        id: 'tpl-16',
        name: '1.6 Template',
        ocppVersion: '1.6',
        variables: [{ component: '', variable: 'HeartbeatInterval', value: '60' }],
        targetFilter: null,
        createdAt: '2026-01-15T00:00:00Z',
        updatedAt: '2026-01-15T00:00:00Z',
      };
      setupDbResults([created]);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/config-templates',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: '1.6 Template',
          ocppVersion: '1.6',
          variables: [{ component: '', variable: 'HeartbeatInterval', value: '60' }],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.ocppVersion).toBe('1.6');
    });

    it('returns 400 when name is empty', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/config-templates',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: '',
          variables: [],
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ===================================================================
  // PATCH /v1/config-templates/:id
  // ===================================================================

  describe('PATCH /v1/config-templates/:id', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/config-templates/tpl-1',
        payload: { name: 'Updated' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when template not found', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/config-templates/nonexistent',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Updated' },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBe('Template not found');
      expect(body.code).toBe('TEMPLATE_NOT_FOUND');
    });

    it('returns 200 on successful update', async () => {
      const existing = { id: 'tpl-1' };
      const updated = {
        id: 'tpl-1',
        name: 'Updated Config',
        description: 'Updated description',
        ocppVersion: '1.6',
        variables: [{ component: 'EVSE', variable: 'MaxCurrent', value: '64' }],
        targetFilter: { vendorId: 'vnd-1' },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-02-01T00:00:00Z',
      };
      setupDbResults([existing], [updated]);

      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/config-templates/tpl-1',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: 'Updated Config',
          ocppVersion: '1.6',
          targetFilter: { vendorId: 'vnd-1' },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.name).toBe('Updated Config');
      expect(body.ocppVersion).toBe('1.6');
    });
  });

  // ===================================================================
  // DELETE /v1/config-templates/:id
  // ===================================================================

  describe('DELETE /v1/config-templates/:id', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/config-templates/tpl-1',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when template not found', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/config-templates/nonexistent',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBe('Template not found');
      expect(body.code).toBe('TEMPLATE_NOT_FOUND');
    });

    it('returns 204 on successful deletion', async () => {
      const existing = { id: 'tpl-1' };
      setupDbResults([existing], []);

      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/config-templates/tpl-1',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(204);
    });
  });

  // ===================================================================
  // GET /v1/config-templates/:id/matching-stations
  // ===================================================================

  describe('GET /v1/config-templates/:id/matching-stations', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/config-templates/tpl-1/matching-stations',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when template not found', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/config-templates/nonexistent/matching-stations',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 200 with matching stations', async () => {
      const template = {
        id: 'tpl-1',
        name: 'Config',
        targetFilter: { siteId: 'site-1' },
      };
      const stations = [
        {
          id: 'sta-1',
          stationId: 'STATION-001',
          model: 'Model X',
          siteName: 'Site A',
          vendorName: 'Vendor Y',
        },
      ];
      // DB calls: 1. template, 2. stations, 3. count
      setupDbResults([template], stations, [{ total: 1 }]);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/config-templates/tpl-1/matching-stations',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(1);
    });
  });

  // ===================================================================
  // POST /v1/config-templates/:id/push
  // ===================================================================

  describe('POST /v1/config-templates/:id/push', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/config-templates/tpl-1/push',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when template not found', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/config-templates/nonexistent/push',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBe('Template not found');
      expect(body.code).toBe('TEMPLATE_NOT_FOUND');
    });

    it('returns 200 with success when template has no variables', async () => {
      const template = {
        id: 'tpl-1',
        name: 'Empty',
        variables: [],
        targetFilter: null,
      };
      setupDbResults([template]);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/config-templates/tpl-1/push',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('returns 200 and publishes commands for matching stations', async () => {
      const template = {
        id: 'tpl-1',
        name: 'Config',
        variables: [
          { component: 'EVSE', variable: 'MaxCurrent', value: '32' },
          { component: 'ChargingStation', variable: 'HeartbeatInterval', value: '60' },
        ],
        targetFilter: { siteId: 'site-1' },
      };
      const onlineStations = [{ id: 'sta-1', stationId: 'STATION-001' }];
      // DB calls: 1. select template, 2. select matching online stations,
      // 3. insert push record (returning), 4. insert push station rows
      setupDbResults([template], onlineStations, [{ id: 'push-1' }], []);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/config-templates/tpl-1/push',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);

      // processConfigPush runs fire-and-forget; wait for it
      // 1 SetVariables + 1 GetBaseReport (auto-refresh) = 2 calls
      await vi.waitFor(() => {
        expect(mockSendOcppCommand).toHaveBeenCalledTimes(2);
      });
      expect(mockSendOcppCommand).toHaveBeenCalledWith(
        'STATION-001',
        'SetVariables',
        expect.objectContaining({
          setVariableData: expect.arrayContaining([
            expect.objectContaining({
              component: { name: 'EVSE' },
              variable: { name: 'MaxCurrent' },
              attributeValue: '32',
            }),
          ]),
        }),
        undefined,
      );
    });

    it('returns 200 and targets all online stations when no filter set', async () => {
      const template = {
        id: 'tpl-1',
        name: 'Config',
        variables: [{ component: 'EVSE', variable: 'MaxCurrent', value: '32' }],
        targetFilter: null,
      };
      const onlineStations = [
        { id: 'sta-1', stationId: 'STATION-001' },
        { id: 'sta-2', stationId: 'STATION-002' },
      ];
      // DB calls: 1. template, 2. online stations, 3. insert push, 4. insert push stations
      setupDbResults([template], onlineStations, [{ id: 'push-1' }], []);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/config-templates/tpl-1/push',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      // processConfigPush runs fire-and-forget; wait for it
      // 2 stations x (1 SetVariables + 1 GetBaseReport) = 4 calls
      await vi.waitFor(() => {
        expect(mockSendOcppCommand).toHaveBeenCalledTimes(4);
      });
    });

    it('dispatches individual commands for 1.6 templates', async () => {
      const template = {
        id: 'tpl-16',
        name: '1.6 Config',
        ocppVersion: '1.6',
        variables: [
          { component: '', variable: 'HeartbeatInterval', value: '60' },
          { component: '', variable: 'MeterValueSampleInterval', value: '30' },
        ],
        targetFilter: null,
      };
      const onlineStations = [{ id: 'sta-1', stationId: 'STATION-001' }];
      // DB calls: 1. template, 2. online stations, 3. insert push, 4. insert push stations
      setupDbResults([template], onlineStations, [{ id: 'push-1' }], []);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/config-templates/tpl-16/push',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      // 1.6 dispatches one command per variable (2 variables) + 1 GetConfiguration (auto-refresh) = 3 calls
      // processConfigPush runs fire-and-forget; wait for it
      await vi.waitFor(() => {
        expect(mockSendOcppCommand).toHaveBeenCalledTimes(3);
      });

      expect(mockSendOcppCommand.mock.calls[0]?.[2]).toEqual(
        expect.objectContaining({
          setVariableData: [expect.objectContaining({ variable: { name: 'HeartbeatInterval' } })],
        }),
      );
      expect(mockSendOcppCommand.mock.calls[1]?.[2]).toEqual(
        expect.objectContaining({
          setVariableData: [
            expect.objectContaining({ variable: { name: 'MeterValueSampleInterval' } }),
          ],
        }),
      );
    });

    it('returns 200 with no publish when no stations are online', async () => {
      const template = {
        id: 'tpl-1',
        name: 'Config',
        variables: [{ component: 'EVSE', variable: 'MaxCurrent', value: '32' }],
        targetFilter: { siteId: 'site-1' },
      };
      // No online stations match
      setupDbResults([template], []);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/config-templates/tpl-1/push',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(mockPublish).not.toHaveBeenCalled();
    });
  });

  // ===================================================================
  // GET /v1/stations/:id/config-drift
  // ===================================================================

  describe('GET /v1/stations/:id/config-drift', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/stations/sta-1/config-drift',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 with empty array when station not found', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/stations/sta-1/config-drift',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual([]);
    });

    it('returns 200 with empty array when no templates match', async () => {
      const station = { id: 'sta-1', siteId: 'site-1', vendorId: 'vnd-1', model: 'Model X' };
      const templates = [
        {
          id: 'tpl-1',
          name: 'Config',
          variables: [{ component: 'EVSE', variable: 'MaxCurrent', value: '32' }],
          targetFilter: { siteId: 'site-other' },
        },
      ];
      // DB calls: 1. station, 2. templates
      setupDbResults([station], templates);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/stations/sta-1/config-drift',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual([]);
    });

    it('returns 200 with drift items when values differ', async () => {
      const station = { id: 'sta-1', siteId: 'site-1', vendorId: 'vnd-1', model: 'Model X' };
      const templates = [
        {
          id: 'tpl-1',
          name: 'Config',
          variables: [
            { component: 'EVSE', variable: 'MaxCurrent', value: '32' },
            { component: 'ChargingStation', variable: 'HeartbeatInterval', value: '60' },
            { component: 'EVSE', variable: 'MinCurrent', value: '6' },
          ],
          targetFilter: { siteId: 'site-1' },
        },
      ];
      const actualVars = [
        { component: 'EVSE', variable: 'MaxCurrent', value: '16' },
        { component: 'EVSE', variable: 'MinCurrent', value: '6' },
      ];
      // DB calls: 1. station, 2. templates, 3. station variables
      setupDbResults([station], templates, actualVars);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/stations/sta-1/config-drift',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveLength(2);

      // MaxCurrent: expected 32, actual 16
      expect(body[0]).toEqual({
        component: 'EVSE',
        variable: 'MaxCurrent',
        expectedValue: '32',
        actualValue: '16',
        hasDrift: true,
      });

      // HeartbeatInterval: expected 60, actual null (missing)
      expect(body[1]).toEqual({
        component: 'ChargingStation',
        variable: 'HeartbeatInterval',
        expectedValue: '60',
        actualValue: null,
        hasDrift: true,
      });
    });

    it('returns 200 with empty array when all values match', async () => {
      const station = { id: 'sta-1', siteId: 'site-1', vendorId: 'vnd-1', model: 'Model X' };
      const templates = [
        {
          id: 'tpl-1',
          name: 'Config',
          variables: [
            { component: 'EVSE', variable: 'MaxCurrent', value: '32' },
            { component: 'EVSE', variable: 'MinCurrent', value: '6' },
          ],
          targetFilter: null,
        },
      ];
      const actualVars = [
        { component: 'EVSE', variable: 'MaxCurrent', value: '32' },
        { component: 'EVSE', variable: 'MinCurrent', value: '6' },
      ];
      setupDbResults([station], templates, actualVars);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/stations/sta-1/config-drift',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual([]);
    });
  });
});
