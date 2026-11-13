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
    'for',
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

// The AI insights scope reads the database; these tests cover the routes only.
vi.mock('../services/ai-insight-scope.service.js', () => ({
  initialSiteAiInsightsSelected: vi.fn().mockResolvedValue(true),
  isOutsideAiInsightScope: vi.fn(() => false),
  siteAiInsightsScopeStatus: vi.fn().mockResolvedValue({ enabled: true, reason: 'all_sites' }),
  stationAiInsightsScopeStatus: vi.fn().mockResolvedValue({ enabled: true, reason: 'all_sites' }),
}));
const { mockReadLayoutStationSessions, mockIsFleetEnabled } = vi.hoisted(() => ({
  mockIsFleetEnabled: vi.fn(async () => true),
  mockReadLayoutStationSessions: vi.fn(async () => new Map()),
}));
vi.mock('../lib/site-layout-sessions.js', () => ({
  readLayoutStationSessions: mockReadLayoutStationSessions,
  readLayoutEvseSessions: vi.fn(() => Promise.resolve(new Map())),
}));
// The charger screen text reads its settings and templates apart (site-layout-screen-message.test.ts).
vi.mock('../lib/site-layout-screen-message.js', () => ({
  SCREEN_MESSAGE_SOURCES: ['display_message', 'station_message_template', 'default_welcome'],
  viewerScreenLanguage: () => Promise.resolve('en'),
  resolveLayoutScreenMessages: (stations: Array<{ id: string; displayMessage: string | null }>) =>
    Promise.resolve(
      new Map(
        stations.map((s) => [
          s.id,
          s.displayMessage != null
            ? { text: s.displayMessage, source: 'display_message' }
            : { text: 'Welcome to EVtivity', source: 'default_welcome' },
        ]),
      ),
    ),
}));
// The virtual sign windows read the database apart (integration 156-site-layout-live).
vi.mock('../lib/site-layout-status-windows.js', () => ({
  readLayoutReservations: () => Promise.resolve(new Map()),
  readLayoutMaintenanceWindows: () => Promise.resolve(new Map()),
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
  requestHasPermission: vi.fn().mockResolvedValue(true),
}));

vi.mock('@evtivity/services/station-derived-status', () => ({
  buildDerivedStatusSubquery: vi.fn(() => 'status'),
  buildStatusReasonSubquery: vi.fn(() => null),
}));

vi.mock('@evtivity/database', async () => {
  const rawTimestamp = await import('@evtivity/database/src/lib/raw-timestamp.js');
  const tx = {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
  };
  return {
    ...(await import('./helpers/conformance-station-mocks.js')).conformanceStationMocks(),
    ...(await import('@evtivity/database/src/lib/ai-insight-suppression.js')),
    ...(await import('./helpers/departure-schema-mocks.js')).departureSchemaMocks(),
    isFleetEnabled: mockIsFleetEnabled,
    ...rawTimestamp,
    getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
    readStationDataPlans: vi.fn(() => Promise.resolve(new Map())),
    boardOf: (r: { boardX?: number | null; boardY?: number | null }) =>
      r.boardX != null && r.boardY != null ? { x: r.boardX, y: r.boardY } : null,
    saveSiteLayout: vi.fn(() => Promise.resolve()),
    readSiteLayoutSettings: vi.fn(async () =>
      (await import('@evtivity/lib/site-layout')).effectiveLayoutSettings(null),
    ),
    readStationLayoutKinds: vi.fn(() => Promise.resolve(new Map())),
    readUnitsOfStations: vi.fn(() => Promise.resolve(new Map())),
    readSiteUnitBoardPositions: vi.fn(() => Promise.resolve(new Map())),
    LayoutUnitNotFoundError: class extends Error {},
    ChargerPlacementSiteTypeError: class extends Error {},
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
    setSiteLayoutType: vi.fn(),
    readSiteLayoutPositions: vi.fn(() => Promise.resolve([])),
    PG_UNIQUE_VIOLATION: '23505',
    clearFreeVendCache: vi.fn(),
    clearElectricityRateCache: vi.fn(),
    pgErrorCode: (err: unknown) => (err as { code?: string } | null)?.code,
    PG_FOREIGN_KEY_VIOLATION: '23503',
    siteAuditLog: { name: 'site_audit_log' },
    configTemplateAuditLog: { name: 'config_template_audit_log' },
    pricingAssignmentAuditLog: { name: 'pricing_assignment_audit_log' },
    sites: {},
    vendors: {},
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
    gt: vi.fn(),
    gte: vi.fn(),
    isNull: vi.fn(),
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

vi.mock('../lib/site-access.js', () => {
  const getUserSiteIds = vi.fn().mockResolvedValue(null);
  return {
    getUserSiteIds,
    invalidateSiteAccessCache: vi.fn(),
    // Mirrors the real guard on top of the mocked getUserSiteIds.
    requireAllSiteAccess: vi.fn(
      async (
        _request: unknown,
        reply: { status: (c: number) => { send: (b: unknown) => Promise<unknown> } },
        notFound: unknown,
      ) => {
        if ((await getUserSiteIds()) == null) return true;
        await reply.status(404).send(notFound);
        return false;
      },
    ),
  };
});

vi.mock('../lib/pricing-events.js', () => ({
  publishPricingChanged: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/pricing-group-lookup.js', () => ({
  pricingGroupExists: vi.fn().mockResolvedValue(true),
}));

vi.mock('../lib/ocpi-location-push.js', () => ({
  publishOcpiLocationPush: vi.fn().mockResolvedValue(undefined),
  captureDeletedSiteLocation: vi.fn().mockResolvedValue(null),
  publishOcpiDeletedSiteLocation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/site-ai-insights.service.js', () => ({
  suppressSiteAiInsights: vi.fn(),
  resumeSiteAiInsights: vi.fn(),
}));

vi.mock('../services/free-vend.service.js', () => ({
  setSiteFreeVend: vi.fn().mockResolvedValue({ pushId21: 'push-21', pushId16: '' }),
}));

// The replay reader and the data plan service have their own tests.
vi.mock('../lib/site-layout-replay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/site-layout-replay.js')>()),
  readSiteLayoutReplay: vi.fn(async () => []),
}));
vi.mock('@evtivity/services/station-data-plan.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/services/station-data-plan.service')>()),
  siteDataPlanImpact: vi.fn(async () => 3),
  changeSiteDataPlan: vi.fn(async () => undefined),
}));

import { readSiteLayoutReplay, REPLAY_MAX_DAYS_BACK } from '../lib/site-layout-replay.js';
import {
  changeSiteDataPlan,
  siteDataPlanImpact,
} from '@evtivity/services/station-data-plan.service';
import { isOutsideAiInsightScope } from '../services/ai-insight-scope.service.js';
import { requestHasPermission } from '../middleware/rbac.js';
import { setSiteLayoutType } from '@evtivity/database';
import { requestStationMessageRepush } from '@evtivity/services/station-message.service';
import { db, writeAudit } from '@evtivity/database';
import { getUserSiteIds } from '../lib/site-access.js';
import {
  resumeSiteAiInsights,
  suppressSiteAiInsights,
} from '../services/site-ai-insights.service.js';
import { registerAuth } from '../plugins/auth.js';
import { siteRoutes } from '../routes/sites.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(siteRoutes);
  await app.ready();
  return app;
}

function setWrites(): Record<string, unknown>[] {
  return writes.filter((w) => w.method === 'set').map((w) => w.arg as Record<string, unknown>);
}

/** A sites row with every column the site reply schema names. */
function fullSite(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SITE_ID,
    name: 'Main Street',
    address: null,
    city: null,
    state: null,
    postalCode: null,
    country: null,
    latitude: null,
    longitude: null,
    timezone: 'Europe/Berlin',
    hoursOfOperation: null,
    metadata: null,
    dataPlan: null,
    autochargeEnabled: null,
    stationMessageLanguage: 'en',
    aiInsightsEnabled: true,
    aiMonthlyTokenBudget: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const patchSite = fullSite();

/** A calendar day (YYYY-MM-DD) in UTC, `days` from today. */
function utcDay(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

describe('Site routes - cov3', () => {
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
    vi.mocked(getUserSiteIds).mockResolvedValue(null);
    vi.mocked(isOutsideAiInsightScope).mockReturnValue(false);
    vi.mocked(requestHasPermission).mockResolvedValue(true);
  });

  describe('GET /sites/:id/data-plan-impact', () => {
    it('counts the stations whose plan would change', async () => {
      setupDbResults([{ id: SITE_ID }]);
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/data-plan-impact?dataPlan=cellular`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ stationsChanging: 3 });
      expect(siteDataPlanImpact).toHaveBeenCalledWith(SITE_ID, 'cellular');
    });

    it('asks for the plan not set when the query names none', async () => {
      setupDbResults([{ id: SITE_ID }]);
      await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/data-plan-impact`,
        headers: auth(),
      });
      expect(siteDataPlanImpact).toHaveBeenCalledWith(SITE_ID, null);
    });

    it('answers 404 outside the scope without reading the site', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValueOnce([OTHER_SITE_ID]);
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/data-plan-impact`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SITE_NOT_FOUND');
      expect(db.select).not.toHaveBeenCalled();
      expect(siteDataPlanImpact).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown site', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/data-plan-impact`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(404);
      expect(siteDataPlanImpact).not.toHaveBeenCalled();
    });
  });

  describe('site AI insight suppression', () => {
    const result = {
      suppressedAt: new Date('2026-10-01T12:00:00.000Z'),
      suppressedUntil: null,
      suppressedBy: USER_ID,
      suppressedByName: 'Op Erator',
      reason: 'Works',
      insightsDismissed: 4,
      actionsExpired: 2,
    };

    it('suppresses the site insights and returns the counts', async () => {
      vi.mocked(suppressSiteAiInsights).mockResolvedValueOnce(result);
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/ai-insights/suppress`,
        headers: auth(),
        payload: { reason: 'Works' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        aiInsightsSuppressedReason: 'Works',
        insightsDismissed: 4,
        actionsExpired: 2,
      });
      expect(suppressSiteAiInsights).toHaveBeenCalledWith(
        SITE_ID,
        { reason: 'Works', until: null },
        expect.objectContaining({ actorUserId: USER_ID }),
        expect.anything(),
      );
    });

    it('answers 404 outside the scope and for a missing site', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValueOnce([OTHER_SITE_ID]);
      const denied = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/ai-insights/suppress`,
        headers: auth(),
        payload: { reason: 'Works' },
      });
      expect(denied.statusCode).toBe(404);
      expect(suppressSiteAiInsights).not.toHaveBeenCalled();
      vi.mocked(suppressSiteAiInsights).mockResolvedValueOnce(null);
      const missing = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/ai-insights/suppress`,
        headers: auth(),
        payload: { reason: 'Works' },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe('SITE_NOT_FOUND');
    });

    it('refuses a past end date', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/ai-insights/suppress`,
        headers: auth(),
        payload: { reason: 'Works', until: '2020-01-01T00:00:00.000Z' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(suppressSiteAiInsights).not.toHaveBeenCalled();
    });

    it('answers 409 for a site outside the AI insights scope', async () => {
      vi.mocked(isOutsideAiInsightScope).mockReturnValueOnce(true);
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/ai-insights/suppress`,
        headers: auth(),
        payload: { reason: 'Works' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('AI_INSIGHTS_NOT_IN_SCOPE');
      expect(suppressSiteAiInsights).not.toHaveBeenCalled();
    });

    it('resumes the site insights', async () => {
      vi.mocked(resumeSiteAiInsights).mockResolvedValueOnce({
        ...result,
        suppressedAt: null,
        suppressedBy: null,
        suppressedByName: null,
        reason: null,
      });
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/ai-insights/resume`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        aiInsightsSuppressedAt: null,
        aiInsightsSuppressedReason: null,
      });
      expect(resumeSiteAiInsights).toHaveBeenCalledWith(
        SITE_ID,
        expect.objectContaining({ actorUserId: USER_ID }),
        expect.anything(),
      );
    });

    it('answers 404 to resume outside the scope and for a missing site', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValueOnce([OTHER_SITE_ID]);
      const denied = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/ai-insights/resume`,
        headers: auth(),
      });
      expect(denied.statusCode).toBe(404);
      expect(resumeSiteAiInsights).not.toHaveBeenCalled();
      vi.mocked(resumeSiteAiInsights).mockResolvedValueOnce(null);
      const missing = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/ai-insights/resume`,
        headers: auth(),
      });
      expect(missing.statusCode).toBe(404);
    });
  });

  describe('POST /sites with a site type', () => {
    it('sets the site type through the layout writer in the insert transaction', async () => {
      vi.mocked(setSiteLayoutType).mockResolvedValueOnce({
        changed: true,
        typeChanged: true,
        placementChanged: false,
        moved: [],
      } as never);
      setupDbResults([], [fullSite({ name: 'Depot' })], [fullSite({ name: 'Depot', x: 1 })]);
      const res = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: auth(),
        payload: { name: 'Depot', siteType: 'depot' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: SITE_ID, x: 1 });
      expect(setSiteLayoutType).toHaveBeenCalledWith(expect.anything(), SITE_ID, 'depot', {
        chargerPlacement: undefined,
      });
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
        action: 'created',
        after: { id: SITE_ID, x: 1 },
      });
    });

    it('keeps the inserted row when the type changes nothing', async () => {
      vi.mocked(setSiteLayoutType).mockResolvedValueOnce({ changed: false } as never);
      setupDbResults([], [fullSite({ name: 'Lot' })]);
      const res = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: auth(),
        payload: { name: 'Lot', siteType: 'parking_lot', chargerPlacement: 'lot_edge' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: SITE_ID, name: 'Lot' });
    });

    it('refuses a charger placement for a site that is no parking lot', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: auth(),
        payload: { name: 'Depot', siteType: 'depot', chargerPlacement: 'islands' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(db.select).not.toHaveBeenCalled();
    });

    it('answers 409 when a concurrent create took the name', async () => {
      setupDbResults([], Object.assign(new Error('dup'), { code: '23505' }));
      const res = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: auth(),
        payload: { name: 'Main Street' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DUPLICATE_SITE_NAME');
      expect(writeAudit).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /sites/:id', () => {
    it('hides a site from a restricted operator changing a company-wide AI field', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValue([SITE_ID]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}`,
        headers: auth(),
        payload: { aiMonthlyTokenBudget: 1000 },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SITE_NOT_FOUND');
      expect(setWrites()).toHaveLength(0);
    });

    it('answers 409 when a concurrent write took the name', async () => {
      setupDbResults([patchSite], [], Object.assign(new Error('dup'), { code: '23505' }));
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}`,
        headers: auth(),
        payload: { name: 'Other Name' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DUPLICATE_SITE_NAME');
    });

    it('answers 404 when the update matched no row', async () => {
      setupDbResults([patchSite], []);
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}`,
        headers: auth(),
        payload: { city: 'Freiburg' },
      });
      expect(res.statusCode).toBe(404);
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('leaves a plan-only change to the data plan service', async () => {
      setupDbResults([patchSite], [patchSite]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}`,
        headers: auth(),
        payload: { dataPlan: 'cellular' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ dataPlan: 'cellular' });
      expect(changeSiteDataPlan).toHaveBeenCalledWith(
        SITE_ID,
        'cellular',
        expect.objectContaining({ actorUserId: USER_ID }),
        expect.anything(),
      );
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('asks the stations to repush their messages when the message language changes', async () => {
      setupDbResults([patchSite], [fullSite({ stationMessageLanguage: 'de' })]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}`,
        headers: auth(),
        payload: { stationMessageLanguage: 'de' },
      });
      expect(res.statusCode).toBe(200);
      expect(requestStationMessageRepush).toHaveBeenCalledWith(expect.anything(), {
        siteId: SITE_ID,
      });
    });

    it('audits a site type change with the moved stations and their positions before', async () => {
      vi.mocked(setSiteLayoutType).mockResolvedValueOnce({
        changed: true,
        typeChanged: true,
        placementChanged: false,
        moved: [{ stationId: STATION_ID, x: 5, y: 6 }],
      } as never);
      const { readSiteLayoutPositions } = await import('@evtivity/database');
      vi.mocked(readSiteLayoutPositions).mockResolvedValueOnce([
        { stationId: STATION_ID, x: 1, y: 2 },
        { stationId: 'sta_000000000002', x: 3, y: 4 },
      ] as never);
      setupDbResults([patchSite], [patchSite], [fullSite({ layout: 'depot' })]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}`,
        headers: auth(),
        payload: { siteType: 'custom' },
      });
      expect(res.statusCode).toBe(200);
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
        action: 'updated',
        notes: 'site type changed',
        before: { layoutPositions: [{ stationId: STATION_ID, x: 1, y: 2 }] },
        after: { layoutPositions: [{ stationId: STATION_ID, x: 5, y: 6 }] },
      });
    });
  });

  describe('GET /sites/:id/layout/replay', () => {
    it('replays a day in the site timezone with the session and driver rules', async () => {
      vi.mocked(requestHasPermission).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      setupDbResults([{ id: SITE_ID, timezone: 'Europe/Berlin' }]);
      const date = utcDay(-1);
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/layout/replay?date=${date}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ date, timezone: 'Europe/Berlin', stations: [] });
      expect(readSiteLayoutReplay).toHaveBeenCalledWith(SITE_ID, expect.anything(), {
        sessions: true,
        drivers: false,
      });
    });

    it('falls back to UTC for a stored timezone that is not valid', async () => {
      setupDbResults([{ id: SITE_ID, timezone: 'Mars/Olympus' }]);
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/layout/replay?date=${utcDay(-1)}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().timezone).toBe('UTC');
    });

    it('reads no drivers without sessions:read', async () => {
      vi.mocked(requestHasPermission).mockResolvedValueOnce(false);
      setupDbResults([{ id: SITE_ID, timezone: 'UTC' }]);
      await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/layout/replay?date=${utcDay(-1)}`,
        headers: auth(),
      });
      expect(requestHasPermission).toHaveBeenCalledTimes(1);
      expect(readSiteLayoutReplay).toHaveBeenCalledWith(SITE_ID, expect.anything(), {
        sessions: false,
        drivers: false,
      });
    });

    it.each([
      [utcDay(3), 'The day is in the future'],
      [
        utcDay(-(REPLAY_MAX_DAYS_BACK + 5)),
        `The day is more than ${String(REPLAY_MAX_DAYS_BACK)} days back`,
      ],
      ['2026-02-31', 'Invalid date'],
    ])('refuses %s', async (date, message) => {
      setupDbResults([{ id: SITE_ID, timezone: 'UTC' }]);
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/layout/replay?date=${date}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR', error: message });
      expect(readSiteLayoutReplay).not.toHaveBeenCalled();
    });

    it('answers 404 outside the scope and for a missing site', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValueOnce([OTHER_SITE_ID]);
      const denied = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/layout/replay?date=${utcDay(-1)}`,
        headers: auth(),
      });
      expect(denied.statusCode).toBe(404);
      expect(db.select).not.toHaveBeenCalled();
      setupDbResults([]);
      const missing = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/layout/replay?date=${utcDay(-1)}`,
        headers: auth(),
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe('SITE_NOT_FOUND');
    });
  });
});
