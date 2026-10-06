// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

let dbResults: unknown[] = [];
let dbCallIndex = 0;
interface Chain {
  kind: string;
  calls: Array<{ method: string; args: unknown[] }>;
}
const chains: Chain[] = [];

function setupDbResults(...results: unknown[]) {
  dbResults = results;
  dbCallIndex = 0;
  chains.length = 0;
}

function makeChain(kind: string) {
  const rec: Chain = { kind, calls: [] };
  chains.push(rec);
  const chain: Record<string, unknown> = {};
  for (const m of [
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
  ]) {
    chain[m] = vi.fn((...args: unknown[]) => {
      rec.calls.push({ method: m, args });
      return chain;
    });
  }
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    const r = dbResults[dbCallIndex] ?? [];
    dbCallIndex++;
    return Promise.resolve(r).then(resolve, reject);
  };
  return chain;
}

function argsOf(kind: string, method: string): unknown[][] {
  return chains
    .filter((c) => c.kind === kind)
    .flatMap((c) => c.calls.filter((x) => x.method === method).map((x) => x.args));
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain('select')),
    selectDistinct: vi.fn(() => makeChain('select')),
    insert: vi.fn(() => makeChain('insert')),
    update: vi.fn(() => makeChain('update')),
    delete: vi.fn(() => makeChain('delete')),
  },
  configTemplates: { id: 'ct.id' },
  configTemplatePushes: { id: 'ctp.id', templateId: 'ctp.templateId' },
  configTemplatePushStations: {
    pushId: 'ctps.pushId',
    status: 'ctps.status',
    stationId: 'ctps.stationId',
  },
  chargingStations: {
    id: 'cs.id',
    siteId: 'cs.siteId',
    vendorId: 'cs.vendorId',
    model: 'cs.model',
    stationId: 'cs.stationId',
    isOnline: 'cs.isOnline',
    ocppProtocol: 'cs.ocppProtocol',
  },
  stationConfigurations: { stationId: 'sc.stationId' },
  sites: { id: 's.id', name: 's.name' },
  vendors: { id: 'v.id', name: 'v.name' },
  writeAudit: vi.fn().mockResolvedValue(undefined),
  configTemplateAuditLog: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  and: vi.fn((...a: unknown[]) => ({ and: a })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
  isNotNull: vi.fn((a: unknown) => ({ isNotNull: a })),
  desc: vi.fn(),
  asc: vi.fn(),
  count: vi.fn(),
}));

vi.mock('../lib/config-push.js', () => ({
  processConfigPush: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
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
}));

import { registerAuth } from '../plugins/auth.js';
import { configTemplateRoutes } from '../routes/config-templates.js';
import { writeAudit } from '@evtivity/database';
import { processConfigPush } from '../lib/config-push.js';
import { getUserSiteIds } from '../lib/site-access.js';

const FILTER = { siteId: 'sit_1', vendorId: 'ven_1', model: 'M1', stationId: 'sta_1' };

function template(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tpl_1',
    name: 'Heartbeat',
    description: 'desc',
    variables: [{ component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval', value: '60' }],
    ocppVersion: '2.1',
    targetFilter: null,
    stationId: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function whereConds(index: number): unknown[] {
  const w = argsOf('select', 'where')[index]?.[0] as { and: unknown[] };
  return w.and;
}

describe('config template routes, uncovered paths', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(configTemplateRoutes, { prefix: '/v1' });
    await app.ready();
    auth = { authorization: `Bearer ${app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    vi.mocked(getUserSiteIds).mockResolvedValue(null);
  });

  describe('GET /v1/config-templates/filter-options', () => {
    it('applies every filter plus the site scope to the station query', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValue(['sit_1', 'sit_2']);
      setupDbResults(
        [{ id: 'sit_1', name: 'A' }],
        [{ id: 'ven_1', name: 'V' }],
        [{ model: 'M1' }],
        [{ id: 'sta_1', stationId: 'CS-1' }],
      );
      const res = await app.inject({
        method: 'GET',
        url: '/v1/config-templates/filter-options?siteId=sit_1&vendorId=ven_1&model=M1',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        sites: [{ id: 'sit_1', name: 'A' }],
        vendors: [{ id: 'ven_1', name: 'V' }],
        models: ['M1'],
        stations: [{ id: 'sta_1', stationId: 'CS-1' }],
      });
      // first where: site scope on sites; third: station conditions
      expect(argsOf('select', 'where')[0]?.[0]).toEqual({ inArray: ['s.id', ['sit_1', 'sit_2']] });
      const stationWhere = argsOf('select', 'where')[2]?.[0] as { and: unknown[] };
      expect(stationWhere.and).toEqual([
        { eq: ['cs.siteId', 'sit_1'] },
        { eq: ['cs.vendorId', 'ven_1'] },
        { eq: ['cs.model', 'M1'] },
        { inArray: ['cs.siteId', ['sit_1', 'sit_2']] },
      ]);
    });

    it('returns no stations without querying them for a user with no sites', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValue([]);
      setupDbResults([], [], []);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/config-templates/filter-options',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().stations).toEqual([]);
      expect(chains.filter((c) => c.kind === 'select')).toHaveLength(3);
    });
  });

  describe('GET /v1/config-templates', () => {
    it('counts matching stations with the template filter and site scope', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValue(['sit_1']);
      setupDbResults([template({ targetFilter: FILTER })], [{ total: 1 }], [{ total: 4 }]);
      const res = await app.inject({ method: 'GET', url: '/v1/config-templates', headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json().data[0].matchingStationsCount).toBe(4);
      expect(whereConds(0)).toEqual([
        { eq: ['cs.ocppProtocol', 'ocpp2.1'] },
        { eq: ['cs.siteId', 'sit_1'] },
        { eq: ['cs.vendorId', 'ven_1'] },
        { eq: ['cs.model', 'M1'] },
        { eq: ['cs.id', 'sta_1'] },
        { inArray: ['cs.siteId', ['sit_1']] },
      ]);
    });

    it('reports zero matching stations for a user with no sites', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValue([]);
      setupDbResults([template()], [{ total: 1 }]);
      const res = await app.inject({ method: 'GET', url: '/v1/config-templates', headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ total: 1, data: [{ matchingStationsCount: 0 }] });
    });
  });

  describe('POST /v1/config-templates/:id/duplicate', () => {
    it('returns 404 when the template does not exist', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/config-templates/tpl_x/duplicate',
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('TEMPLATE_NOT_FOUND');
    });

    it('inserts a copy and audits it as created', async () => {
      const original = template({ targetFilter: { siteId: 'sit_1' } });
      const copy = template({
        id: 'tpl_2',
        name: 'Heartbeat (Copy)',
        targetFilter: { siteId: 'sit_1' },
      });
      setupDbResults([original], [copy]);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/config-templates/tpl_1/duplicate',
        headers: auth,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: 'tpl_2', name: 'Heartbeat (Copy)' });
      expect(argsOf('insert', 'values')[0]?.[0]).toEqual({
        name: 'Heartbeat (Copy)',
        description: 'desc',
        ocppVersion: '2.1',
        variables: original.variables,
        targetFilter: { siteId: 'sit_1' },
      });
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
        entityId: 'tpl_2',
        action: 'created',
        notes: 'Duplicated from tpl_1',
      });
    });
  });

  describe('GET /v1/config-templates/:id/matching-stations', () => {
    it('applies filter, online status, and site scope', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValue(['sit_1']);
      const station = {
        id: 'sta_1',
        stationId: 'CS-1',
        model: 'M1',
        isOnline: true,
        siteName: 'A',
        vendorName: 'V',
      };
      setupDbResults([template({ targetFilter: FILTER })], [station], [{ total: 1 }]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/config-templates/tpl_1/matching-stations?status=online',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [station], total: 1 });
      expect(argsOf('select', 'where')[1]?.[0]).toEqual({
        and: [
          { eq: ['cs.ocppProtocol', 'ocpp2.1'] },
          { eq: ['cs.siteId', 'sit_1'] },
          { eq: ['cs.vendorId', 'ven_1'] },
          { eq: ['cs.model', 'M1'] },
          { eq: ['cs.id', 'sta_1'] },
          { eq: ['cs.isOnline', true] },
          { inArray: ['cs.siteId', ['sit_1']] },
        ],
      });
    });

    it('filters offline stations', async () => {
      setupDbResults([template()], [], [{ total: 0 }]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/config-templates/tpl_1/matching-stations?status=offline',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect((argsOf('select', 'where')[1]?.[0] as { and: unknown[] }).and).toContainEqual({
        eq: ['cs.isOnline', false],
      });
    });

    it('returns an empty page for a user with no sites', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValue([]);
      setupDbResults([template()]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/config-templates/tpl_1/matching-stations',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
    });
  });

  describe('POST /v1/config-templates/:id/push', () => {
    it('targets online stations matching the filter in the user sites', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValue(['sit_1']);
      const targets = [{ id: 'sta_1', stationId: 'CS-1' }];
      setupDbResults([template({ targetFilter: FILTER, ocppVersion: '1.6' })], targets, [
        { id: 'push_1' },
      ]);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/config-templates/tpl_1/push',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, pushId: 'push_1' });
      expect(whereConds(1)).toEqual([
        { eq: ['cs.isOnline', true] },
        { eq: ['cs.ocppProtocol', 'ocpp1.6'] },
        { eq: ['cs.siteId', 'sit_1'] },
        { eq: ['cs.vendorId', 'ven_1'] },
        { eq: ['cs.model', 'M1'] },
        { eq: ['cs.id', 'sta_1'] },
        { inArray: ['cs.siteId', ['sit_1']] },
      ]);
      expect(processConfigPush).toHaveBeenCalledWith(
        'push_1',
        targets,
        template().variables,
        '1.6',
      );
    });

    it('does nothing for a user with no sites', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValue([]);
      setupDbResults([template()]);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/config-templates/tpl_1/push',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, pushId: '' });
      expect(argsOf('insert', 'values')).toHaveLength(0);
      expect(processConfigPush).not.toHaveBeenCalled();
    });
  });

  describe('GET /v1/config-templates/:id/pushes', () => {
    it('returns 404 when the template does not exist', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/config-templates/tpl_x/pushes',
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('TEMPLATE_NOT_FOUND');
    });

    it('merges per-status counts into each push, with zeros for a push without rows', async () => {
      const push = (id: string) => ({
        id,
        templateId: 'tpl_1',
        status: 'completed',
        stationCount: 3,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      setupDbResults(
        [{ id: 'tpl_1' }],
        [push('push_1'), push('push_2')],
        [{ total: 2 }],
        [
          { pushId: 'push_1', status: 'accepted', count: 2 },
          { pushId: 'push_1', status: 'failed', count: 1 },
        ],
      );
      const res = await app.inject({
        method: 'GET',
        url: '/v1/config-templates/tpl_1/pushes',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(2);
      expect(body.data[0]).toMatchObject({
        id: 'push_1',
        acceptedCount: 2,
        failedCount: 1,
        pendingCount: 0,
        rejectedCount: 0,
      });
      expect(body.data[1]).toMatchObject({
        id: 'push_2',
        acceptedCount: 0,
        failedCount: 0,
        pendingCount: 0,
        rejectedCount: 0,
      });
    });

    it('skips the status query when there are no pushes', async () => {
      setupDbResults([{ id: 'tpl_1' }], [], [{ total: 0 }]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/config-templates/tpl_1/pushes',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(chains.filter((c) => c.kind === 'select')).toHaveLength(3);
    });
  });

  describe('GET /v1/config-template-pushes/:pushId', () => {
    it('returns 404 when the push does not exist', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/config-template-pushes/push_x',
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PUSH_NOT_FOUND');
    });

    it('returns status counts and per-station results', async () => {
      const station = {
        id: 1,
        stationId: 'sta_1',
        stationName: 'CS-1',
        status: 'rejected',
        errorInfo: 'Rejected',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults(
        [
          {
            id: 'push_1',
            templateId: 'tpl_1',
            status: 'completed',
            stationCount: 7,
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        [
          { status: 'rejected', count: 1 },
          { status: 'accepted', count: 6 },
        ],
        [station],
      );
      const res = await app.inject({
        method: 'GET',
        url: '/v1/config-template-pushes/push_1?page=2&limit=5',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: 'push_1',
        acceptedCount: 6,
        rejectedCount: 1,
        failedCount: 0,
        pendingCount: 0,
        stations: [station],
        stationsTotal: 7,
      });
      expect(argsOf('select', 'offset')[0]?.[0]).toBe(5);
    });
  });

  describe('GET /v1/stations/:id/config-drift', () => {
    const station = { id: 'sta_1', siteId: 'sit_1', vendorId: 'ven_1', model: 'M1' };

    it('returns no drift for a station outside the user sites', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValue(['sit_9']);
      setupDbResults([station]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/stations/sta_1/config-drift',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      expect(chains.filter((c) => c.kind === 'select')).toHaveLength(1);
    });

    it('ignores templates whose filter excludes the station', async () => {
      setupDbResults(
        [station],
        [
          template({ id: 'a', targetFilter: { siteId: 'sit_2' } }),
          template({ id: 'b', targetFilter: { vendorId: 'ven_2' } }),
          template({ id: 'c', targetFilter: { model: 'M2' } }),
          template({ id: 'd', targetFilter: { stationId: 'sta_2' } }),
        ],
      );
      const res = await app.inject({
        method: 'GET',
        url: '/v1/stations/sta_1/config-drift',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      // station configurations are never read when no template matches
      expect(chains.filter((c) => c.kind === 'select')).toHaveLength(2);
    });

    it('reports drift for a template whose full filter matches', async () => {
      setupDbResults([station], [template({ targetFilter: FILTER })], []);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/stations/sta_1/config-drift',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        {
          component: 'OCPPCommCtrlr',
          variable: 'HeartbeatInterval',
          expectedValue: '60',
          actualValue: null,
          hasDrift: true,
        },
      ]);
    });
  });
});
