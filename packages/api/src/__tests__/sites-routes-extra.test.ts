// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const SITE_ID = 'sit_000000000001';
const OTHER_SITE_ID = 'sit_000000000999';
const USER_ID = 'usr_000000000001';
const ROLE_ID = 'rol_000000000001';
const STATION_ID = 'sta_000000000001';
const PRICING_GROUP_ID = 'pgr_000000000001';

// -- DB mock: each awaited chain consumes the next queued result. An Error
// result makes that query reject. `values` and `set` arguments are recorded.

let dbResults: unknown[] = [];
let dbCallIndex = 0;
const writes: { method: 'values' | 'set'; arg: unknown }[] = [];

function setupDbResults(...results: unknown[]) {
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
    'having',
    'returning',
    'onConflictDoUpdate',
    'as',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain['values'] = vi.fn((arg: unknown) => {
    writes.push({ method: 'values', arg });
    return chain;
  });
  chain['set'] = vi.fn((arg: unknown) => {
    writes.push({ method: 'set', arg });
    return chain;
  });
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    const r = dbResults[dbCallIndex] ?? [];
    dbCallIndex++;
    if (r instanceof Error) return Promise.reject(r).then(resolve, reject);
    return Promise.resolve(r).then(resolve, reject);
  };
  return chain;
}

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

vi.mock('@evtivity/services/station-derived-status', () => ({
  buildDerivedStatusSubquery: vi.fn(() => 'status'),
  buildStatusReasonSubquery: vi.fn(() => null),
}));

vi.mock('@evtivity/database', () => {
  const tx = {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
  };
  return {
    getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
    db: {
      select: vi.fn(() => makeChain()),
      selectDistinct: vi.fn(() => makeChain()),
      insert: vi.fn(() => makeChain()),
      update: vi.fn(() => makeChain()),
      delete: vi.fn(() => makeChain()),
      execute: vi.fn(() => Promise.resolve([])),
      transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    },
    writeAudit: vi.fn().mockResolvedValue(undefined),
    clearFreeVendCache: vi.fn(),
    clearElectricityRateCache: vi.fn(),
    pgErrorCode: (err: unknown) => (err as { code?: string } | null)?.code,
    PG_FOREIGN_KEY_VIOLATION: '23503',
    siteAuditLog: { name: 'site_audit_log' },
    configTemplateAuditLog: { name: 'config_template_audit_log' },
    pricingAssignmentAuditLog: { name: 'pricing_assignment_audit_log' },
    sites: {},
    chargingStations: {
      id: { name: 'id', table: {} },
      siteId: { name: 'site_id', table: {} },
    },
    chargingSessions: { status: 'charging_sessions.status', idleStartedAt: 'idle_started_at' },
    maintenanceEvents: {},
    drivers: {},
    meterValues: {},
    stationLayoutPositions: {},
    evses: {},
    connectors: {},
    siteLoadManagement: {},
    displayMessages: {},
    pricingGroupSites: {},
    pricingGroups: {},
    configTemplates: {},
    carbonIntensityFactors: {},
    siteElectricityRatePeriods: {},
    paymentRecords: {},
  };
});

vi.mock('drizzle-orm', () => {
  const sqlFn = () => ({ as: vi.fn(), mapWith: vi.fn() });
  return {
    eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
    and: vi.fn(),
    or: vi.fn(),
    ilike: vi.fn(),
    sql: Object.assign(vi.fn(sqlFn), {
      raw: vi.fn(sqlFn),
      identifier: vi.fn(sqlFn),
    }),
    getTableName: vi.fn(() => 'charging_stations'),
    gte: vi.fn(),
    lte: vi.fn(),
    desc: vi.fn(),
    count: vi.fn(),
    inArray: vi.fn(),
    isNotNull: vi.fn((a: unknown) => ({ isNotNull: a })),
  };
});

vi.mock('@evtivity/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/lib')>();
  return {
    ...actual,
    deriveElectricityRatePriority: vi.fn(() => 7),
  };
});

vi.mock('@evtivity/services/station-message.service', () => ({
  requestStationMessageRepush: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/site-import.service.js', () => ({
  exportSitesCsv: vi.fn().mockResolvedValue('name\n'),
  exportSitesTemplateCsv: vi.fn().mockReturnValue('siteName\n'),
  importSitesCsv: vi.fn(),
}));

vi.mock('@evtivity/services/session-revenue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/services/session-revenue')>();
  return {
    ...actual,
    queryRevenue: vi.fn().mockResolvedValue(new Map()),
    queryRevenueTotal: vi.fn().mockResolvedValue(actual.EMPTY_REVENUE),
  };
});

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

vi.mock('../lib/pricing-events.js', () => ({
  publishPricingChanged: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/pricing-group-lookup.js', () => ({
  pricingGroupExists: vi.fn().mockResolvedValue(true),
}));

vi.mock('../lib/config-push.js', () => ({
  pushTemplateToSiteStations: vi.fn((templateId: string) => Promise.resolve(`push-${templateId}`)),
}));

import { db, writeAudit, clearFreeVendCache, clearElectricityRateCache } from '@evtivity/database';
import { ilike, sql, eq, isNotNull, inArray } from 'drizzle-orm';
import { FREE_VEND_OCPP_21_VARIABLES } from '@evtivity/lib';
import { getUserSiteIds } from '../lib/site-access.js';
import { publishPricingChanged } from '../lib/pricing-events.js';
import { pricingGroupExists } from '../lib/pricing-group-lookup.js';
import { pushTemplateToSiteStations } from '../lib/config-push.js';
import { registerAuth } from '../plugins/auth.js';
import { siteRoutes } from '../routes/sites.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(siteRoutes);
  await app.ready();
  return app;
}

function valuesWrites(): Record<string, unknown>[] {
  return writes.filter((w) => w.method === 'values').map((w) => w.arg as Record<string, unknown>);
}
function setWrites(): Record<string, unknown>[] {
  return writes.filter((w) => w.method === 'set').map((w) => w.arg as Record<string, unknown>);
}
function auditCalls(): { action: string; notes?: string; before?: unknown; after?: unknown }[] {
  return vi
    .mocked(writeAudit)
    .mock.calls.map(
      (c) => c[1] as { action: string; notes?: string; before?: unknown; after?: unknown },
    );
}
// Template text of every sql`...` call, joined, so filters built with sql can be asserted.
function sqlTexts(): string[] {
  return vi
    .mocked(sql)
    .mock.calls.map((c) => (Array.isArray(c[0]) ? (c[0] as string[]).join('?') : ''));
}

const siteRow = {
  id: SITE_ID,
  name: 'Main Street',
  freeVendEnabled: false,
  freeVendTemplateId21: null as string | null,
  freeVendTemplateId16: null as string | null,
  carbonRegionCode: null as string | null,
};

describe('Site routes - extra coverage', () => {
  let app: FastifyInstance;
  let token: string;
  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: USER_ID, roleId: ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setupDbResults();
    writes.length = 0;
  });

  describe('site access isolation', () => {
    const notFound = { code: 'SITE_NOT_FOUND', error: 'Site not found' };
    const rateNotFound = {
      code: 'ELECTRICITY_RATE_NOT_FOUND',
      error: 'Electricity rate not found',
    };
    const cases: {
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      url: string;
      payload?: unknown;
      expected: { code: string; error: string };
    }[] = [
      { method: 'GET', url: `/sites/${OTHER_SITE_ID}`, expected: notFound },
      {
        method: 'PATCH',
        url: `/sites/${OTHER_SITE_ID}`,
        payload: { name: 'X' },
        expected: notFound,
      },
      { method: 'DELETE', url: `/sites/${OTHER_SITE_ID}`, expected: notFound },
      { method: 'GET', url: `/sites/${OTHER_SITE_ID}/metrics`, expected: notFound },
      { method: 'GET', url: `/sites/${OTHER_SITE_ID}/stations`, expected: notFound },
      { method: 'GET', url: `/sites/${OTHER_SITE_ID}/energy-history`, expected: notFound },
      { method: 'GET', url: `/sites/${OTHER_SITE_ID}/revenue-history`, expected: notFound },
      { method: 'GET', url: `/sites/${OTHER_SITE_ID}/popular-times`, expected: notFound },
      { method: 'GET', url: `/sites/${OTHER_SITE_ID}/meter-values`, expected: notFound },
      { method: 'GET', url: `/sites/${OTHER_SITE_ID}/sessions`, expected: notFound },
      { method: 'GET', url: `/sites/${OTHER_SITE_ID}/layout`, expected: notFound },
      {
        method: 'PUT',
        url: `/sites/${OTHER_SITE_ID}/layout`,
        payload: { positions: [] },
        expected: notFound,
      },
      { method: 'GET', url: `/sites/${OTHER_SITE_ID}/pricing-groups`, expected: notFound },
      {
        method: 'POST',
        url: `/sites/${OTHER_SITE_ID}/pricing-groups`,
        payload: { pricingGroupId: PRICING_GROUP_ID },
        expected: notFound,
      },
      {
        method: 'DELETE',
        url: `/sites/${OTHER_SITE_ID}/pricing-groups/${PRICING_GROUP_ID}`,
        expected: notFound,
      },
      {
        method: 'POST',
        url: `/sites/${OTHER_SITE_ID}/free-vend`,
        payload: { enabled: true },
        expected: notFound,
      },
      { method: 'GET', url: `/sites/${OTHER_SITE_ID}/carbon-region`, expected: notFound },
      {
        method: 'PUT',
        url: `/sites/${OTHER_SITE_ID}/carbon-region`,
        payload: { regionCode: null },
        expected: notFound,
      },
      { method: 'GET', url: `/sites/${OTHER_SITE_ID}/electricity-rates`, expected: notFound },
      {
        method: 'POST',
        url: `/sites/${OTHER_SITE_ID}/electricity-rates`,
        payload: { name: 'Flat', ratePerKwh: 0.1 },
        expected: notFound,
      },
      {
        method: 'PATCH',
        url: `/sites/${OTHER_SITE_ID}/electricity-rates/1`,
        payload: { name: 'Flat', ratePerKwh: 0.1 },
        expected: rateNotFound,
      },
      {
        method: 'DELETE',
        url: `/sites/${OTHER_SITE_ID}/electricity-rates/1`,
        expected: rateNotFound,
      },
    ];

    it.each(cases)(
      '$method $url returns 404 for a site outside the user scope',
      async ({ method, url, payload, expected }) => {
        vi.mocked(getUserSiteIds).mockResolvedValueOnce([SITE_ID]);
        const res = await app.inject({
          method,
          url,
          headers: auth(),
          ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
        });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual(expected);
        expect(getUserSiteIds).toHaveBeenCalledWith(USER_ID);
        expect(db.select).not.toHaveBeenCalled();
        expect(db.update).not.toHaveBeenCalled();
        expect(db.delete).not.toHaveBeenCalled();
        expect(db.insert).not.toHaveBeenCalled();
        expect(db.execute).not.toHaveBeenCalled();
      },
    );
  });

  describe('GET /sites', () => {
    it('returns an empty page without querying when the user has no sites', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValueOnce([]);
      const res = await app.inject({ method: 'GET', url: '/sites', headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(db.select).not.toHaveBeenCalled();
    });

    it('limits the list to the user site scope', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValueOnce([SITE_ID]);
      setupDbResults([], [{ count: 0 }]);
      const res = await app.inject({ method: 'GET', url: '/sites', headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(inArray).toHaveBeenCalledWith(undefined, [SITE_ID]);
    });

    it('applies search, city and state filters with the right patterns', async () => {
      setupDbResults([], [{ count: 0 }]);
      const res = await app.inject({
        method: 'GET',
        url: '/sites?search=main&city=Portland&state=OR',
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      const patterns = vi.mocked(ilike).mock.calls.map((c) => c[1]);
      expect(patterns.filter((p) => p === '%main%')).toHaveLength(4);
      expect(patterns).toContain('Portland');
      expect(patterns).toContain('OR');
    });

    it('filters to sites with load management enabled', async () => {
      setupDbResults([], [{ count: 0 }]);
      await app.inject({ method: 'GET', url: '/sites?loadManagement=true', headers: auth() });
      const texts = sqlTexts();
      expect(texts.some((t) => t.includes(', false) = true'))).toBe(true);
      expect(texts.some((t) => t.includes(', false) = false'))).toBe(false);
    });

    it('filters to sites with load management disabled', async () => {
      setupDbResults([], [{ count: 0 }]);
      await app.inject({ method: 'GET', url: '/sites?loadManagement=false', headers: auth() });
      const texts = sqlTexts();
      expect(texts.some((t) => t.includes(', false) = false'))).toBe(true);
      expect(texts.some((t) => t.includes(', false) = true'))).toBe(false);
    });

    it('rejects an invalid loadManagement value', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/sites?loadManagement=maybe',
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe('GET /sites/filter-options', () => {
    it('returns no locations without querying for a user with no sites', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValueOnce([]);
      const res = await app.inject({
        method: 'GET',
        url: '/sites/filter-options',
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ locations: [] });
      expect(db.selectDistinct).not.toHaveBeenCalled();
    });

    it('returns distinct city and state pairs', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValueOnce([SITE_ID]);
      setupDbResults([
        { city: 'Austin', state: 'TX' },
        { city: 'Portland', state: 'OR' },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/sites/filter-options',
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        locations: [
          { city: 'Austin', state: 'TX' },
          { city: 'Portland', state: 'OR' },
        ],
      });
    });
  });

  describe('POST /sites and PATCH /sites/:id name uniqueness', () => {
    it('rejects a longitude outside [-180, 180] on create', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: auth(),
        payload: { name: 'Far Away', longitude: '180.5', hoursOfOperation: '  Mon-Fri  ' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(res.json().message).toBe('Longitude must be a number in [-180, 180]');
      expect(db.select).not.toHaveBeenCalled();
    });

    it('stores a trimmed name and whitespace-only hours as null', async () => {
      setupDbResults([], [{ ...siteRow }]);
      await app.inject({
        method: 'POST',
        url: '/sites',
        headers: auth(),
        payload: { name: '  Main Street ', hoursOfOperation: '   ' },
      });
      expect(valuesWrites()[0]).toMatchObject({ name: 'Main Street', hoursOfOperation: null });
    });

    it('returns 409 DUPLICATE_SITE_NAME on create when the name exists', async () => {
      setupDbResults([{ id: OTHER_SITE_ID }]);
      const res = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: auth(),
        payload: { name: '  Main Street ' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DUPLICATE_SITE_NAME');
      expect(db.insert).not.toHaveBeenCalled();
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('returns 409 DUPLICATE_SITE_NAME on rename to a taken name', async () => {
      setupDbResults([{ ...siteRow }], [{ id: OTHER_SITE_ID }]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}`,
        headers: auth(),
        payload: { name: 'Taken Name' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DUPLICATE_SITE_NAME');
      expect(db.update).not.toHaveBeenCalled();
    });

    it('skips the uniqueness check when the name is unchanged', async () => {
      const fullRow = {
        ...siteRow,
        address: null,
        city: null,
        state: null,
        postalCode: null,
        country: null,
        latitude: null,
        longitude: null,
        timezone: null,
        hoursOfOperation: null,
        metadata: null,
        stationMessageLanguage: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults([fullRow], [{ ...fullRow, city: 'Austin' }]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}`,
        headers: auth(),
        payload: { name: 'Main Street', city: 'Austin' },
      });
      expect(res.statusCode).toBe(200);
      // One select for the before row only; no duplicate lookup.
      expect(db.select).toHaveBeenCalledTimes(1);
      expect(res.json().city).toBe('Austin');
      expect(auditCalls()[0]).toMatchObject({ action: 'updated', before: fullRow });
    });

    it('updates with a trimmed name and whitespace-only hours as null', async () => {
      const fullRow = { ...siteRow, hoursOfOperation: '9-5', metadata: null };
      setupDbResults([fullRow], [{ ...fullRow, hoursOfOperation: null }]);
      await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}`,
        headers: auth(),
        payload: { name: '  Main Street  ', hoursOfOperation: '  ' },
      });
      expect(setWrites()[0]).toMatchObject({ name: 'Main Street', hoursOfOperation: null });
    });
  });

  describe('GET /sites/:id/popular-times', () => {
    it('averages session counts over the requested weeks', async () => {
      setupDbResults(
        [{ timezone: 'Europe/Berlin' }],
        [
          { dow: 1, hour: 8, totalSessions: 7 },
          { dow: 5, hour: 18, totalSessions: 2 },
        ],
      );
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/popular-times?weeks=4`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        { dow: 1, hour: 8, avgSessions: 1.8 },
        { dow: 5, hour: 18, avgSessions: 0.5 },
      ]);
    });

    it('falls back to America/New_York when the site has no timezone', async () => {
      setupDbResults([], []);
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/popular-times`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      const tzArgs = vi.mocked(sql).mock.calls.flatMap((c) => c.slice(1));
      expect(tzArgs).toContain('America/New_York');
    });

    it('rejects weeks above 12', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/popular-times?weeks=13`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /sites/:id/meter-values', () => {
    it('returns one per-minute summed series when a measurand is given', async () => {
      setupDbResults([
        { timestamp: '2024-01-01T00:00:00.000Z', value: '22.5', unit: 'kW' },
        { timestamp: '2024-01-01T00:01:00.000Z', value: '30', unit: 'kW' },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/meter-values?measurand=Power.Active.Import`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        {
          measurand: 'Power.Active.Import',
          unit: 'kW',
          values: [
            { timestamp: '2024-01-01T00:00:00.000Z', value: '22.5' },
            { timestamp: '2024-01-01T00:01:00.000Z', value: '30' },
          ],
        },
      ]);
      expect(eq).toHaveBeenCalledWith(undefined, 'Power.Active.Import');
    });

    it('returns a null unit for a measurand with no readings', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/meter-values?measurand=Voltage`,
        headers: auth(),
      });
      expect(res.json()).toEqual([{ measurand: 'Voltage', unit: null, values: [] }]);
    });

    it('groups readings without a measurand under "unknown"', async () => {
      setupDbResults([
        { measurand: null, unit: null, timestamp: '2024-01-01T00:00:00.000Z', value: '1' },
        { measurand: null, unit: null, timestamp: '2024-01-01T00:01:00.000Z', value: '2' },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/meter-values`,
        headers: auth(),
      });
      expect(res.json()).toEqual([
        {
          measurand: 'unknown',
          unit: null,
          values: [
            { timestamp: '2024-01-01T00:00:00.000Z', value: '1' },
            { timestamp: '2024-01-01T00:01:00.000Z', value: '2' },
          ],
        },
      ]);
    });
  });

  describe('GET /sites/:id/sessions filters', () => {
    it('maps status=idling to active sessions with an idle start', async () => {
      setupDbResults([], [{ count: 0 }]);
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/sessions?status=idling&stationId=${STATION_ID}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(eq).toHaveBeenCalledWith('charging_sessions.status', 'active');
      expect(eq).not.toHaveBeenCalledWith('charging_sessions.status', 'idling');
      expect(isNotNull).toHaveBeenCalledWith('idle_started_at');
      expect(eq).toHaveBeenCalledWith(undefined, STATION_ID);
    });

    it('filters by a plain status directly', async () => {
      setupDbResults([], [{ count: 0 }]);
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/sessions?status=faulted`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(eq).toHaveBeenCalledWith('charging_sessions.status', 'faulted');
      expect(isNotNull).not.toHaveBeenCalledWith('idle_started_at');
    });
  });

  describe('GET /sites/:id/layout', () => {
    it('returns an empty list when the site has no stations', async () => {
      setupDbResults([{ id: SITE_ID }], []);
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/layout`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      expect(db.select).toHaveBeenCalledTimes(2);
    });

    it('marks plugged-in connectors and uses the newest display message', async () => {
      setupDbResults(
        [{ id: SITE_ID }],
        [
          {
            id: 'st-uuid-1',
            stationId: 'CS-1',
            model: 'M1',
            status: 'charging',
            statusReason: null,
            isOnline: true,
            securityProfile: 1,
            positionX: null,
            positionY: '12.5',
          },
        ],
        [{ id: 'evse-1', stationId: 'st-uuid-1', evseId: 1 }],
        [
          {
            id: 'conn-1',
            evseId: 'evse-1',
            connectorId: 1,
            connectorType: 'CCS2',
            maxPowerKw: 150,
            status: 'occupied',
          },
          {
            id: 'conn-2',
            evseId: 'evse-1',
            connectorId: 2,
            connectorType: 'Type2',
            maxPowerKw: 22,
            status: 'available',
          },
        ],
        [
          { stationId: 'st-uuid-1', connectorId: 'conn-1', energyDeliveredWh: '1234.5' },
          { stationId: 'st-uuid-1', connectorId: null, energyDeliveredWh: '99' },
        ],
        [
          { stationId: 'st-uuid-1', content: 'Newest message', priority: 'NormalCycle' },
          { stationId: 'st-uuid-1', content: 'Older message', priority: 'NormalCycle' },
        ],
      );
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/layout`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const [station] = res.json();
      expect(station.positionX).toBe(0);
      expect(station.positionY).toBe(12.5);
      expect(station.displayMessage).toBe('Newest message');
      expect(station.evses[0].connectors).toEqual([
        {
          connectorId: 1,
          connectorType: 'CCS2',
          maxPowerKw: 150,
          status: 'occupied',
          isPluggedIn: true,
          energyDeliveredWh: 1234.5,
        },
        {
          connectorId: 2,
          connectorType: 'Type2',
          maxPowerKw: 22,
          status: 'available',
          isPluggedIn: false,
          energyDeliveredWh: null,
        },
      ]);
    });
  });

  describe('GET /sites/:id/pricing-groups', () => {
    it('returns the assigned pricing group', async () => {
      const group = {
        id: PRICING_GROUP_ID,
        name: 'Standard',
        description: null,
        isDefault: false,
        tariffCount: 3,
      };
      setupDbResults([group]);
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/pricing-groups`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(group);
    });

    it('returns null when the site has no pricing group', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/pricing-groups`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('null');
    });
  });

  describe('POST /sites/:id/pricing-groups', () => {
    const url = `/sites/${SITE_ID}/pricing-groups`;
    const payload = { pricingGroupId: PRICING_GROUP_ID };

    it('returns 404 SITE_NOT_FOUND when the site does not exist', async () => {
      setupDbResults([]);
      const res = await app.inject({ method: 'POST', url, headers: auth(), payload });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SITE_NOT_FOUND');
      expect(pricingGroupExists).not.toHaveBeenCalled();
    });

    it('returns 404 PRICING_GROUP_NOT_FOUND when the group does not exist', async () => {
      vi.mocked(pricingGroupExists).mockResolvedValueOnce(false);
      setupDbResults([{ id: SITE_ID }]);
      const res = await app.inject({ method: 'POST', url, headers: auth(), payload });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PRICING_GROUP_NOT_FOUND');
      expect(pricingGroupExists).toHaveBeenCalledWith(PRICING_GROUP_ID);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('maps a foreign key race on insert to 404 PRICING_GROUP_NOT_FOUND', async () => {
      setupDbResults(
        [{ id: SITE_ID }],
        [],
        Object.assign(new Error('fk violation'), { code: '23503' }),
      );
      const res = await app.inject({ method: 'POST', url, headers: auth(), payload });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PRICING_GROUP_NOT_FOUND');
      expect(writeAudit).not.toHaveBeenCalled();
      expect(publishPricingChanged).not.toHaveBeenCalled();
    });

    it('returns 500 for any other insert error', async () => {
      setupDbResults([{ id: SITE_ID }], [], Object.assign(new Error('boom'), { code: '08006' }));
      const res = await app.inject({ method: 'POST', url, headers: auth(), payload });
      expect(res.statusCode).toBe(500);
      expect(publishPricingChanged).not.toHaveBeenCalled();
    });

    it('creates a new assignment, audits it as created and publishes the change', async () => {
      const record = { siteId: SITE_ID, pricingGroupId: PRICING_GROUP_ID };
      setupDbResults([{ id: SITE_ID }], [], [record]);
      const res = await app.inject({ method: 'POST', url, headers: auth(), payload });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual(record);
      expect(valuesWrites()[0]).toEqual(record);
      expect(auditCalls()[0]).toMatchObject({
        action: 'created',
        before: null,
        after: { scope: 'site', siteId: SITE_ID, pricingGroupId: PRICING_GROUP_ID },
      });
      expect(publishPricingChanged).toHaveBeenCalledWith({
        pricingGroupId: PRICING_GROUP_ID,
        action: 'assignment.changed',
        siteId: SITE_ID,
      });
    });

    it('audits a replaced assignment as updated with the previous group', async () => {
      const record = { siteId: SITE_ID, pricingGroupId: PRICING_GROUP_ID };
      setupDbResults(
        [{ id: SITE_ID }],
        [{ siteId: SITE_ID, pricingGroupId: 'pgr_000000000077' }],
        [record],
      );
      const res = await app.inject({ method: 'POST', url, headers: auth(), payload });
      expect(res.statusCode).toBe(201);
      expect(auditCalls()[0]).toMatchObject({
        action: 'updated',
        before: { scope: 'site', siteId: SITE_ID, pricingGroupId: 'pgr_000000000077' },
      });
    });

    it('rejects a malformed pricing group id', async () => {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { pricingGroupId: 'not-an-id' },
      });
      expect(res.statusCode).toBe(400);
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /sites/:id/pricing-groups/:pricingGroupId', () => {
    const url = `/sites/${SITE_ID}/pricing-groups/${PRICING_GROUP_ID}`;

    it('returns 404 PRICING_ASSIGNMENT_NOT_FOUND when nothing was removed', async () => {
      setupDbResults([]);
      const res = await app.inject({ method: 'DELETE', url, headers: auth() });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PRICING_ASSIGNMENT_NOT_FOUND');
      expect(writeAudit).not.toHaveBeenCalled();
      expect(publishPricingChanged).not.toHaveBeenCalled();
    });

    it('removes the assignment, audits it and publishes the change', async () => {
      const record = { siteId: SITE_ID, pricingGroupId: PRICING_GROUP_ID };
      setupDbResults([record]);
      const res = await app.inject({ method: 'DELETE', url, headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(record);
      expect(auditCalls()[0]).toMatchObject({
        action: 'deleted',
        before: { scope: 'site', siteId: SITE_ID, pricingGroupId: PRICING_GROUP_ID },
      });
      expect(publishPricingChanged).toHaveBeenCalledWith({
        pricingGroupId: PRICING_GROUP_ID,
        action: 'assignment.changed',
        siteId: SITE_ID,
      });
    });
  });

  describe('POST /sites/:id/free-vend', () => {
    const url = `/sites/${SITE_ID}/free-vend`;

    it('returns 404 when the site does not exist', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SITE_NOT_FOUND');
      expect(db.transaction).not.toHaveBeenCalled();
      expect(clearFreeVendCache).not.toHaveBeenCalled();
    });

    it('disables free vend without pushing templates', async () => {
      const before = { ...siteRow, freeVendEnabled: true };
      setupDbResults([before], [{ ...before, freeVendEnabled: false }]);
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(setWrites()[0]?.['freeVendEnabled']).toBe(false);
      expect(auditCalls()[0]).toMatchObject({ action: 'updated', notes: 'free-vend disabled' });
      expect(clearFreeVendCache).toHaveBeenCalledTimes(1);
      expect(db.transaction).not.toHaveBeenCalled();
      expect(pushTemplateToSiteStations).not.toHaveBeenCalled();
    });

    it('creates both templates on first enable and pushes each to the site', async () => {
      setupDbResults([siteRow], [{ id: 'tpl-21' }], [{ id: 'tpl-16' }], [siteRow]);
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        success: true,
        pushId21: 'push-tpl-21',
        pushId16: 'push-tpl-16',
      });

      const [tpl21, tpl16] = valuesWrites();
      expect(tpl21).toMatchObject({
        name: 'Free Vend - Main Street (OCPP 2.1)',
        ocppVersion: '2.1',
        variables: FREE_VEND_OCPP_21_VARIABLES,
        targetFilter: { siteId: SITE_ID },
      });
      expect(tpl16).toMatchObject({
        name: 'Free Vend - Main Street (OCPP 1.6)',
        ocppVersion: '1.6',
        targetFilter: { siteId: SITE_ID },
      });
      for (const v of (tpl16 as { variables: { component: string; variable: string }[] })
        .variables) {
        expect(v.component).toBe(v.variable);
      }
      expect(setWrites()[0]).toMatchObject({
        freeVendEnabled: true,
        freeVendTemplateId21: 'tpl-21',
        freeVendTemplateId16: 'tpl-16',
      });
      expect(auditCalls().map((a) => a.notes)).toEqual([
        `auto-created for free-vend on site ${SITE_ID}`,
        `auto-created for free-vend on site ${SITE_ID}`,
        'free-vend enabled',
      ]);
      expect(pushTemplateToSiteStations).toHaveBeenCalledWith('tpl-21', SITE_ID);
      expect(pushTemplateToSiteStations).toHaveBeenCalledWith('tpl-16', SITE_ID);
      expect(clearFreeVendCache).toHaveBeenCalledTimes(1);
    });

    it('reuses existing templates on re-enable without creating new ones', async () => {
      const existing = {
        ...siteRow,
        freeVendTemplateId21: 'old-21',
        freeVendTemplateId16: 'old-16',
      };
      setupDbResults([existing], [existing]);
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        success: true,
        pushId21: 'push-old-21',
        pushId16: 'push-old-16',
      });
      expect(valuesWrites()).toHaveLength(0);
      expect(auditCalls()).toHaveLength(1);
    });

    it('skips the push for a template the insert did not return', async () => {
      setupDbResults([siteRow], [], [{ id: 'tpl-16' }], [siteRow]);
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, pushId21: '', pushId16: 'push-tpl-16' });
      expect(pushTemplateToSiteStations).toHaveBeenCalledTimes(1);
      expect(setWrites()[0]).toMatchObject({ freeVendTemplateId21: null });
    });
  });

  describe('carbon region', () => {
    const url = `/sites/${SITE_ID}/carbon-region`;

    it('GET returns 404 when the site does not exist', async () => {
      setupDbResults([]);
      const res = await app.inject({ method: 'GET', url, headers: auth() });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SITE_NOT_FOUND');
    });

    it('GET returns nulls when no region is set', async () => {
      setupDbResults([{ carbonRegionCode: null }]);
      const res = await app.inject({ method: 'GET', url, headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        regionCode: null,
        regionName: null,
        carbonIntensityKgPerKwh: null,
      });
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    it('GET returns the region with its intensity factor', async () => {
      setupDbResults(
        [{ carbonRegionCode: 'DE' }],
        [{ regionName: 'Germany', carbonIntensityKgPerKwh: '0.380' }],
      );
      const res = await app.inject({ method: 'GET', url, headers: auth() });
      expect(res.json()).toEqual({
        regionCode: 'DE',
        regionName: 'Germany',
        carbonIntensityKgPerKwh: '0.380',
      });
    });

    it('GET returns the code with null details when the factor row is missing', async () => {
      setupDbResults([{ carbonRegionCode: 'XX' }], []);
      const res = await app.inject({ method: 'GET', url, headers: auth() });
      expect(res.json()).toEqual({
        regionCode: 'XX',
        regionName: null,
        carbonIntensityKgPerKwh: null,
      });
    });

    it('PUT returns 404 when the site does not exist', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'PUT',
        url,
        headers: auth(),
        payload: { regionCode: 'DE' },
      });
      expect(res.statusCode).toBe(404);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('PUT returns 400 INVALID_REGION_CODE for an unknown region', async () => {
      setupDbResults([siteRow], []);
      const res = await app.inject({
        method: 'PUT',
        url,
        headers: auth(),
        payload: { regionCode: 'NOPE' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_REGION_CODE');
      expect(db.update).not.toHaveBeenCalled();
    });

    it('PUT stores a valid region and audits the change', async () => {
      setupDbResults([siteRow], [{ id: 1 }], [{ ...siteRow, carbonRegionCode: 'DE' }]);
      const res = await app.inject({
        method: 'PUT',
        url,
        headers: auth(),
        payload: { regionCode: 'DE' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(setWrites()[0]?.['carbonRegionCode']).toBe('DE');
      expect(auditCalls()[0]).toMatchObject({
        action: 'updated',
        notes: 'carbon-region updated',
        after: { carbonRegionCode: 'DE' },
      });
    });

    it('PUT clears the region without a factor lookup', async () => {
      setupDbResults([{ ...siteRow, carbonRegionCode: 'DE' }], []);
      const res = await app.inject({
        method: 'PUT',
        url,
        headers: auth(),
        payload: { regionCode: null },
      });
      expect(res.statusCode).toBe(200);
      expect(db.select).toHaveBeenCalledTimes(1);
      expect(setWrites()[0]?.['carbonRegionCode']).toBeNull();
      // The update returned no row, so the audit falls back to the before row.
      expect(auditCalls()[0]?.after).toMatchObject({ carbonRegionCode: 'DE' });
    });
  });

  describe('electricity rates', () => {
    const url = `/sites/${SITE_ID}/electricity-rates`;

    it('POST returns 404 when the site does not exist', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { name: 'Flat', ratePerKwh: 0.12 },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SITE_NOT_FOUND');
      expect(db.insert).not.toHaveBeenCalled();
      expect(clearElectricityRateCache).not.toHaveBeenCalled();
    });

    it('POST returns 500 when the insert returns no row', async () => {
      setupDbResults([{ id: SITE_ID }], []);
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { name: 'Flat', ratePerKwh: 0.12 },
      });
      expect(res.statusCode).toBe(500);
      expect(clearElectricityRateCache).not.toHaveBeenCalled();
    });

    it('POST stores a flat default rate as a string and clears the cache', async () => {
      setupDbResults(
        [{ id: SITE_ID }],
        [
          {
            id: 5,
            siteId: SITE_ID,
            name: 'Flat',
            ratePerKwh: '0.12',
            restrictions: null,
            priority: 7,
            isDefault: true,
          },
        ],
      );
      const res = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: { name: 'Flat', ratePerKwh: 0.12 },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        id: 5,
        siteId: SITE_ID,
        name: 'Flat',
        ratePerKwh: 0.12,
        restrictions: null,
        priority: 7,
        isDefault: true,
      });
      expect(valuesWrites()[0]).toEqual({
        siteId: SITE_ID,
        name: 'Flat',
        ratePerKwh: '0.12',
        restrictions: null,
        priority: 7,
        isDefault: true,
      });
      expect(clearElectricityRateCache).toHaveBeenCalledWith(SITE_ID);
    });

    it('PATCH returns 404 when the period does not belong to the site', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'PATCH',
        url: `${url}/42`,
        headers: auth(),
        payload: { name: 'Peak', ratePerKwh: 0.3 },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('ELECTRICITY_RATE_NOT_FOUND');
      expect(clearElectricityRateCache).not.toHaveBeenCalled();
    });

    it('DELETE returns 404 when no period was deleted', async () => {
      setupDbResults([]);
      const res = await app.inject({ method: 'DELETE', url: `${url}/42`, headers: auth() });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('ELECTRICITY_RATE_NOT_FOUND');
      expect(clearElectricityRateCache).not.toHaveBeenCalled();
    });

    it('DELETE removes the period and clears the cache', async () => {
      setupDbResults([{ id: 42 }]);
      const res = await app.inject({ method: 'DELETE', url: `${url}/42`, headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(clearElectricityRateCache).toHaveBeenCalledWith(SITE_ID);
    });
  });
});
