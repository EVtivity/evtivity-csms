// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const VALID_SITE_ID = 'sit_000000000001';
const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';
const VALID_STATION_ID = 'sta_000000000001';

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
    'delete',
    'insert',
    'update',
    'having',
    'selectDistinct',
    'as',
    'for',
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

// The AI insights scope reads the database; these tests cover the routes only.
vi.mock('../services/ai-insight-scope.service.js', () => ({
  initialSiteAiInsightsSelected: vi.fn().mockResolvedValue(true),
  isOutsideAiInsightScope: () => false,
  siteAiInsightsScopeStatus: vi.fn().mockResolvedValue({ enabled: true, reason: 'all_sites' }),
  stationAiInsightsScopeStatus: vi.fn().mockResolvedValue({ enabled: true, reason: 'all_sites' }),
}));
const { mockReadLayoutStationSessions, mockIsFleetEnabled } = vi.hoisted(() => ({
  mockIsFleetEnabled: vi.fn(async () => true),
  mockReadLayoutStationSessions: vi.fn(async () => new Map()),
}));
vi.mock('../lib/site-layout-sessions.js', () => ({
  readLayoutStationSessions: mockReadLayoutStationSessions,
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

const {
  mockSaveSiteLayout,
  MockLayoutGridTooSmallError,
  MockLayoutSpotsOverlapError,
  MockLoadTreeValidationError,
  mockReadLayoutPowerEquipment,
  mockReadSiteLayoutSettings,
  mockReadStationLayoutKinds,
} = vi.hoisted(() => {
  class MockLayoutGridTooSmallError extends Error {
    constructor(readonly stations: string[]) {
      super('too small');
    }
  }
  class MockLayoutSpotsOverlapError extends Error {
    constructor(readonly stations: string[]) {
      super('overlap');
    }
  }
  class MockLoadTreeValidationError extends Error {
    constructor(
      message: string,
      readonly field: string,
    ) {
      super(message);
    }
  }
  const unchanged = { settingsBefore: {}, settingsAfter: {}, settingsChanged: false, moved: [] };
  return {
    mockSaveSiteLayout: vi.fn(
      (..._args: unknown[]): Promise<unknown> => Promise.resolve(unchanged),
    ),
    MockLayoutGridTooSmallError,
    MockLayoutSpotsOverlapError,
    MockLoadTreeValidationError,
    mockReadLayoutPowerEquipment: vi.fn(
      (..._args: unknown[]): Promise<unknown> =>
        Promise.resolve({ transformers: [], energyAssets: [] }),
    ),
    mockReadSiteLayoutSettings: vi.fn(
      async (..._args: unknown[]): Promise<unknown> =>
        (await import('@evtivity/lib/site-layout')).effectiveLayoutSettings(null),
    ),
    mockReadStationLayoutKinds: vi.fn(
      (
        ..._args: unknown[]
      ): Promise<Map<string, { charging: 'ac' | 'dc'; depot: 'bus' | 'truck' | null }>> =>
        Promise.resolve(new Map()),
    ),
  };
});

const { mockSetSiteLayoutType, mockReadSiteLayoutPositions } = vi.hoisted(() => ({
  mockSetSiteLayoutType: vi.fn(
    (..._args: unknown[]): Promise<unknown> =>
      Promise.resolve({ changed: false, settingsBefore: {}, settingsAfter: {}, moved: [] }),
  ),
  mockReadSiteLayoutPositions: vi.fn(
    (..._args: unknown[]): Promise<unknown[]> => Promise.resolve([]),
  ),
}));

const mockReadStationDataPlans = vi.hoisted(() =>
  vi.fn((): Promise<Map<string, unknown>> => Promise.resolve(new Map())),
);

vi.mock('@evtivity/database', async () => ({
  ...(await import('./helpers/conformance-station-mocks.js')).conformanceStationMocks(),
  ...(await import('@evtivity/database/src/lib/ai-insight-suppression.js')),
  ...(await import('./helpers/departure-schema-mocks.js')).departureSchemaMocks(),
  isFleetEnabled: mockIsFleetEnabled,
  readStationDataPlans: mockReadStationDataPlans,
  boardOf: (r: { boardX?: number | null; boardY?: number | null }) =>
    r.boardX != null && r.boardY != null ? { x: r.boardX, y: r.boardY } : null,
  saveSiteLayout: mockSaveSiteLayout,
  setSiteLayoutType: mockSetSiteLayoutType,
  readSiteLayoutPositions: mockReadSiteLayoutPositions,
  readSiteLayoutSettings: mockReadSiteLayoutSettings,
  readStationLayoutKinds: mockReadStationLayoutKinds,
  LayoutGridTooSmallError: MockLayoutGridTooSmallError,
  LayoutSpotsOverlapError: MockLayoutSpotsOverlapError,
  LoadTreeValidationError: MockLoadTreeValidationError,
  readLayoutPowerEquipment: mockReadLayoutPowerEquipment,
  ChargerPlacementSiteTypeError: class extends Error {},
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    // The transaction runs on the same chain mock, in call order.
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => makeChain(),
        insert: () => makeChain(),
        update: () => makeChain(),
        delete: () => makeChain(),
      }),
    ),
    execute: vi.fn(() =>
      Promise.resolve([
        {
          uptime_percent: '99.5',
          port_count: '4',
          disconnect_count: '2',
          avg_downtime_minutes: '3',
          max_downtime_minutes: '8',
        },
      ]),
    ),
  },
  sites: {},
  sitePaymentConfigs: {},
  paymentRecords: {},
  pgErrorCode: (err: unknown) => (err as { code?: string } | null)?.code,
  PG_FOREIGN_KEY_VIOLATION: '23503',
  PG_UNIQUE_VIOLATION: '23505',
  chargingStations: {
    id: { name: 'id', table: {} },
    siteId: { name: 'site_id', table: {} },
  },
  maintenanceEvents: {},
  chargingSessions: {},
  drivers: {},
  meterValues: {},
  stationLayoutPositions: {},
  evses: {},
  connectors: {},
  siteLoadManagement: {},
  displayMessages: {},
  writeAudit: vi.fn().mockResolvedValue(undefined),
  siteAuditLog: {},
  stationAuditLog: {},
  driverAuditLog: {},
  fleetAuditLog: {},
  userAuditLog: {},
  vehicleAuditLog: {},
  supportCaseAuditLog: {},
  ocpiPartnerAuditLog: {},
  certificateAuditLog: {},
  roleAuditLog: {},
  apiKeyAuditLog: {},
  settingAuditLog: {},
  smartChargingTemplateAuditLog: {},
  configTemplateAuditLog: {},
  firmwareCampaignAuditLog: {},
  stationImageAuditLog: {},
  localAuthListAuditLog: {},
}));

vi.mock('drizzle-orm', () => {
  const sqlFn = () => ({ as: vi.fn(), mapWith: vi.fn() });
  return {
    eq: vi.fn(),
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
    isNotNull: vi.fn(),
  };
});

vi.mock('@evtivity/lib', async (importOriginal) => {
  const { z } = await import('zod');
  const actual = await importOriginal<typeof import('@evtivity/lib')>();
  return {
    ValidationError: actual.ValidationError,
    isValidTimezone: actual.isValidTimezone,
    electricityRateRestrictionsSchema: z.object({}).loose(),
    deriveElectricityRatePriority: vi.fn(() => 0),
    revenueFromGrossGroups: actual.revenueFromGrossGroups,
    createLogger: actual.createLogger,
    STATION_MESSAGE_LANGUAGES: actual.STATION_MESSAGE_LANGUAGES,
    isKnownCountry: actual.isKnownCountry,
    DATA_PLANS: actual.DATA_PLANS,
    ENERGY_ASSET_TYPES: actual.ENERGY_ASSET_TYPES,
    TRANSFORMER_KINDS: actual.TRANSFORMER_KINDS,
  };
});

vi.mock('@evtivity/services/station-message.service', () => ({
  requestStationMessageRepush: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/ocpi-location-push.js', () => ({
  publishOcpiLocationPush: vi.fn().mockResolvedValue(undefined),
  captureDeletedSiteLocation: vi.fn().mockResolvedValue(null),
  publishOcpiDeletedSiteLocation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/site-import.service.js', () => ({
  exportSitesCsv: vi.fn().mockResolvedValue('name,address\nSite1,123 Main St\n'),
  exportSitesTemplateCsv: vi.fn().mockReturnValue('siteName,stationId\n'),
  importSitesCsv: vi.fn().mockResolvedValue({
    sitesCreated: 1,
    sitesUpdated: 0,
    stationsCreated: 0,
    stationsUpdated: 0,
    evsesCreated: 0,
    evsesUpdated: 0,
    connectorsCreated: 0,
    connectorsUpdated: 0,
    errors: [],
  }),
}));

const { mockQueryRevenue } = vi.hoisted(() => ({ mockQueryRevenue: vi.fn() }));

// Revenue comes from the shared definition (session-revenue.ts); its SQL is
// covered by the integration tests.
vi.mock('@evtivity/services/session-revenue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/services/session-revenue')>();
  return {
    ...actual,
    queryRevenue: (input: unknown) => mockQueryRevenue(input),
    queryRevenueTotal: async (input: unknown) =>
      ((await mockQueryRevenue(input)) as Map<string | null, unknown>).get(null) ??
      actual.EMPTY_REVENUE,
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

import { registerAuth } from '../plugins/auth.js';
import { siteRoutes } from '../routes/sites.js';
import * as databaseModule from '@evtivity/database';
import { getUserSiteIds } from '../lib/site-access.js';
import { requestStationMessageRepush } from '@evtivity/services/station-message.service';
import {
  captureDeletedSiteLocation,
  publishOcpiDeletedSiteLocation,
  publishOcpiLocationPush,
} from '../lib/ocpi-location-push.js';
import { requestHasPermission } from '../middleware/rbac.js';
import { importSitesCsv } from '../services/site-import.service.js';
import * as sessionRevenueModule from '@evtivity/services/session-revenue';

const FULL_SITE_ROW = {
  id: VALID_SITE_ID,
  name: 'Site',
  address: null,
  city: null,
  state: null,
  postalCode: null,
  country: null,
  latitude: null,
  longitude: null,
  timezone: 'UTC',
  hoursOfOperation: null,
  metadata: null,
  stationMessageLanguage: null,
  aiInsightsEnabled: true,
  dataPlan: null,
  layoutSettings: null,
  aiMonthlyTokenBudget: null,
  aiInsightsSuppressed: false,
  aiInsightsSuppressedSources: [],
  aiInsightsSuppressedAt: null,
  aiInsightsSuppressedUntil: null,
  aiInsightsSuppressedBy: null,
  aiInsightsSuppressedByName: null,
  aiInsightsSuppressedReason: null,
  autochargeEnabled: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(siteRoutes);
  await app.ready();
  return app;
}

describe('Site routes - handler logic', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbResults = [];
    dbCallIndex = 0;
    vi.clearAllMocks();
  });

  // --- GET /v1/sites ---

  describe('GET /v1/sites', () => {
    it('returns paginated site list', async () => {
      const siteRow = {
        id: VALID_SITE_ID,
        name: 'Test Site',
        address: null,
        city: 'Portland',
        state: null,
        postalCode: null,
        country: null,
        latitude: null,
        longitude: null,
        timezone: null,
        contactName: null,
        contactEmail: null,
        contactPhone: null,
        contactIsPublic: false,
        hoursOfOperation: null,
        metadata: null,
        stationMessageLanguage: null,
        autochargeEnabled: null,
        aiInsightsEnabled: true,
        dataPlan: null,
        layoutSettings: null,
        aiMonthlyTokenBudget: null,
        aiInsightsSuppressed: false,
        aiInsightsSuppressedSources: [],
        aiInsightsSuppressedAt: null,
        aiInsightsSuppressedUntil: null,
        aiInsightsSuppressedBy: null,
        aiInsightsSuppressedByName: null,
        aiInsightsSuppressedReason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stationCount: 3,
        loadManagementEnabled: false,
        underMaintenance: false,
        maxPowerKw: null,
        totalDrawKw: 0,
      };
      setupDbResults([siteRow], [{ count: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: '/sites',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe('Test Site');
      // Conformance test stations do not count at a site.
      expect(databaseModule.isOperatorStation).toHaveBeenCalled();
    });

    it('returns empty when no sites', async () => {
      setupDbResults([], [{ count: 0 }]);

      const response = await app.inject({
        method: 'GET',
        url: '/sites',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data).toHaveLength(0);
      expect(response.json().total).toBe(0);
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/sites',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // --- GET /v1/sites/:id ---

  describe('GET /v1/sites/:id', () => {
    const layoutWithEquipment = {
      spotsPerRow: 10,
      rows: 2,
      facingDeg: 0,
      transformers: [{ id: 'tfm_a', x: 30, z: 2 }],
      energyAssets: [{ id: 'ena_b', x: 5, z: -2.5 }],
    };

    it('returns site when found, with its power equipment rows', async () => {
      const site = {
        id: VALID_SITE_ID,
        name: 'My Site',
        address: null,
        city: null,
        state: null,
        postalCode: null,
        country: null,
        latitude: null,
        longitude: null,
        timezone: null,
        contactName: null,
        contactEmail: null,
        contactPhone: null,
        contactIsPublic: false,
        hoursOfOperation: null,
        metadata: null,
        stationMessageLanguage: null,
        autochargeEnabled: null,
        aiInsightsEnabled: true,
        dataPlan: null,
        layoutSettings: null,
        aiMonthlyTokenBudget: null,
        aiInsightsSuppressed: false,
        aiInsightsSuppressedSources: [],
        aiInsightsSuppressedAt: null,
        aiInsightsSuppressedUntil: null,
        aiInsightsSuppressedBy: null,
        aiInsightsSuppressedByName: null,
        aiInsightsSuppressedReason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stationCount: 5,
        loadManagementEnabled: false,
        underMaintenance: false,
        maxPowerKw: null,
        totalDrawKw: 0,
      };
      setupDbResults([{ ...site, layoutSettings: { ...layoutWithEquipment } }]);
      const equipment = {
        transformers: [
          {
            id: 'tfm_a',
            kind: 'service',
            name: 'Utility Transformer',
            ratedKva: 1500,
            maxContinuousKw: 1425,
          },
        ],
        energyAssets: [
          { id: 'ena_b', type: 'battery', name: 'Storage', capacityKwh: 500, peakKwp: null },
        ],
      };
      mockReadLayoutPowerEquipment.mockResolvedValueOnce(equipment);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().name).toBe('My Site');
      // Positions by id in the layout settings, the names and ratings joined from the tables.
      expect(response.json().layoutSettings.transformers).toEqual([{ id: 'tfm_a', x: 30, z: 2 }]);
      expect(response.json().powerEquipment).toEqual(equipment);
      expect(mockReadLayoutPowerEquipment).toHaveBeenCalledWith(VALID_SITE_ID);

      // Without loadManagement:read the equipment is left out and not read (AZ50-I1).
      vi.mocked(requestHasPermission).mockImplementation(
        async (_r, permission) => permission !== 'loadManagement:read',
      );
      mockReadLayoutPowerEquipment.mockClear();
      setupDbResults([{ ...site, layoutSettings: { ...layoutWithEquipment } }]);
      const hidden = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });
      expect(hidden.statusCode).toBe(200);
      expect(hidden.json()).not.toHaveProperty('powerEquipment');
      expect(mockReadLayoutPowerEquipment).not.toHaveBeenCalled();
      vi.mocked(requestHasPermission).mockResolvedValue(true);
    });

    it('returns 404 when site not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SITE_NOT_FOUND');
    });
  });

  // --- POST /v1/sites ---

  describe('POST /v1/sites', () => {
    it('creates a site and returns 201', async () => {
      const site = {
        id: VALID_SITE_ID,
        name: 'New Site',
        address: '123 Main St',
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
        autochargeEnabled: null,
        aiInsightsEnabled: true,
        dataPlan: null,
        layoutSettings: null,
        aiMonthlyTokenBudget: null,
        aiInsightsSuppressed: false,
        aiInsightsSuppressedSources: [],
        aiInsightsSuppressedAt: null,
        aiInsightsSuppressedUntil: null,
        aiInsightsSuppressedBy: null,
        aiInsightsSuppressedByName: null,
        aiInsightsSuppressedReason: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      // First query: ilike duplicate-name pre-check (no match -> [])
      // Second query: insert returning the new site
      setupDbResults([], [site]);

      const response = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { authorization: 'Bearer ' + token },
        payload: { name: 'New Site', address: '123 Main St' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().name).toBe('New Site');
      expect(mockSetSiteLayoutType).not.toHaveBeenCalled();
    });

    it('stores the site type of a new site through the layout writer', async () => {
      mockSetSiteLayoutType.mockClear();
      const created = { ...FULL_SITE_ROW, name: 'Curb Site', layoutSettings: null };
      const withType = {
        ...created,
        layoutSettings: {
          siteType: 'curbside',
          spotsPerRow: 10,
          rows: 2,
          facingDeg: 0,
          transformers: [],
        },
      };
      mockSetSiteLayoutType.mockResolvedValueOnce({
        changed: true,
        typeChanged: true,
        placementChanged: false,
        settingsBefore: {},
        settingsAfter: {},
        moved: [],
      });
      // Name pre-check, then the insert and the re-read in the transaction.
      setupDbResults([], [created], [withType]);
      const response = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { authorization: 'Bearer ' + token },
        payload: { name: 'Curb Site', siteType: 'curbside' },
      });
      expect(response.statusCode).toBe(201);
      expect(mockSetSiteLayoutType.mock.calls[0]?.[1]).toBe(VALID_SITE_ID);
      expect(mockSetSiteLayoutType.mock.calls[0]?.[2]).toBe('curbside');
      expect(response.json().layoutSettings.siteType).toBe('curbside');
    });

    it('refuses an unknown site type', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { authorization: 'Bearer ' + token },
        payload: { name: 'X', siteType: 'garage' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 404 to a site-restricted user and inserts nothing', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValueOnce([VALID_SITE_ID]);

      const response = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { authorization: 'Bearer ' + token },
        payload: { name: 'New Site' },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SITE_NOT_FOUND');
      expect(vi.mocked(databaseModule.db.insert)).not.toHaveBeenCalled();
    });

    it('returns 400 for missing name', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 400 for an invalid IANA timezone', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { authorization: 'Bearer ' + token },
        payload: { name: 'New Site', timezone: 'Mars/Olympus_Mons' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('returns 400 for a country that is not an ISO 3166-1 code or country name', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { authorization: 'Bearer ' + token },
        payload: { name: 'New Site', country: 'Atlantis' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Unknown country: use an ISO 3166-1 code or the English country name',
      });
    });
  });

  // --- PATCH /v1/sites/:id ---

  describe('PATCH /v1/sites/:id', () => {
    it('updates site and returns it', async () => {
      const updated = {
        id: VALID_SITE_ID,
        name: 'Updated Site',
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
        autochargeEnabled: null,
        aiInsightsEnabled: true,
        dataPlan: null,
        layoutSettings: null,
        aiMonthlyTokenBudget: null,
        aiInsightsSuppressed: false,
        aiInsightsSuppressedSources: [],
        aiInsightsSuppressedAt: null,
        aiInsightsSuppressedUntil: null,
        aiInsightsSuppressedBy: null,
        aiInsightsSuppressedByName: null,
        aiInsightsSuppressedReason: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      // 1: before SELECT, 2: UPDATE returning
      setupDbResults([updated], [updated]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { name: 'Updated Site' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().name).toBe('Updated Site');
    });

    it('returns 404 when site not found', async () => {
      // 1: before SELECT (empty), 2: UPDATE returning (empty)
      setupDbResults([], []);

      const response = await app.inject({
        method: 'PATCH',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { name: 'X' },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SITE_NOT_FOUND');
    });

    it('clears optional fields sent as null or an empty string', async () => {
      const before = {
        ...FULL_SITE_ROW,
        address: '1 Main St',
        contactEmail: 'ops@example.com',
        contactPhone: '555',
        latitude: '40.1',
        longitude: '-70.2',
      };
      const after = {
        ...before,
        address: null,
        contactEmail: null,
        contactPhone: null,
        latitude: null,
        longitude: null,
      };
      setupDbResults([before], [after]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          address: '',
          contactEmail: '',
          contactPhone: null,
          latitude: '',
          longitude: null,
        },
      });

      expect(response.statusCode).toBe(200);
      const chain = vi.mocked(databaseModule.db.update).mock.results[0]?.value as {
        set: ReturnType<typeof vi.fn>;
      };
      expect(chain.set.mock.calls[0]?.[0]).toMatchObject({
        address: null,
        contactEmail: null,
        contactPhone: null,
        latitude: null,
        longitude: null,
      });
      // The OCPI location carries the address and coordinates.
      expect(publishOcpiLocationPush).toHaveBeenCalledWith(VALID_SITE_ID, null, expect.anything());
    });

    it('changes the site type through the layout writer and audits the stations it moved', async () => {
      vi.mocked(databaseModule.writeAudit).mockClear();
      mockSetSiteLayoutType.mockClear();
      mockReadSiteLayoutPositions.mockResolvedValueOnce([
        { stationId: VALID_STATION_ID, positionX: 20, positionY: 160 },
        { stationId: 'other', positionX: 20, positionY: 20 },
      ]);
      mockSetSiteLayoutType.mockResolvedValueOnce({
        changed: true,
        typeChanged: true,
        placementChanged: false,
        settingsBefore: {},
        settingsAfter: {},
        moved: [{ stationId: VALID_STATION_ID, positionX: 220, positionY: 20 }],
      });
      const withType = {
        ...FULL_SITE_ROW,
        layoutSettings: {
          siteType: 'office_retail',
          spotsPerRow: 10,
          rows: 2,
          facingDeg: 0,
          transformers: [],
        },
      };
      setupDbResults([FULL_SITE_ROW], [FULL_SITE_ROW], [withType]);
      const response = await app.inject({
        method: 'PATCH',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { siteType: 'office_retail' },
      });
      expect(response.statusCode).toBe(200);
      expect(mockSetSiteLayoutType.mock.calls[0]?.[2]).toBe('office_retail');
      expect(response.json().layoutSettings.siteType).toBe('office_retail');
      expect(vi.mocked(databaseModule.writeAudit).mock.calls[0]?.[1]).toMatchObject({
        action: 'updated',
        before: {
          layoutPositions: [{ stationId: VALID_STATION_ID, positionX: 20, positionY: 160 }],
        },
        after: {
          layoutSettings: { siteType: 'office_retail' },
          layoutPositions: [{ stationId: VALID_STATION_ID, positionX: 220, positionY: 20 }],
        },
        notes: 'site type changed',
      });
    });

    it('sets the Depot site type through the writer', async () => {
      mockSetSiteLayoutType.mockClear();
      mockSetSiteLayoutType.mockResolvedValueOnce({
        changed: true,
        typeChanged: true,
        placementChanged: false,
        settingsBefore: {},
        settingsAfter: {},
        moved: [],
      });
      const withType = {
        ...FULL_SITE_ROW,
        layoutSettings: {
          siteType: 'depot',
          spotsPerRow: 10,
          rows: 2,
          facingDeg: 0,
          transformers: [],
        },
      };
      setupDbResults([FULL_SITE_ROW], [FULL_SITE_ROW], [withType]);
      const response = await app.inject({
        method: 'PATCH',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { siteType: 'depot' },
      });
      expect(response.statusCode).toBe(200);
      expect(mockSetSiteLayoutType.mock.calls[0]?.[2]).toBe('depot');
      expect(response.json().layoutSettings.siteType).toBe('depot');
    });

    it('writes no type change when the site already has the type', async () => {
      mockSetSiteLayoutType.mockClear();
      vi.mocked(databaseModule.writeAudit).mockClear();
      setupDbResults([FULL_SITE_ROW], [FULL_SITE_ROW]);
      const response = await app.inject({
        method: 'PATCH',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { siteType: 'parking_lot' },
      });
      expect(response.statusCode).toBe(200);
      expect(mockSetSiteLayoutType).toHaveBeenCalledTimes(1);
      expect(vi.mocked(databaseModule.writeAudit).mock.calls[0]?.[1]).not.toHaveProperty('notes');
    });

    it('still rejects an invalid email or coordinate', async () => {
      for (const payload of [{ contactEmail: 'not-an-email' }, { latitude: '91' }]) {
        const response = await app.inject({
          method: 'PATCH',
          url: `/sites/${VALID_SITE_ID}`,
          headers: { authorization: 'Bearer ' + token },
          payload,
        });
        expect(response.statusCode).toBe(400);
      }
    });

    it('does not push the OCPI location for a field partners do not see', async () => {
      const row = { ...FULL_SITE_ROW, reservationsEnabled: true };
      setupDbResults([row], [{ ...row, reservationsEnabled: false }]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { reservationsEnabled: false },
      });

      expect(response.statusCode).toBe(200);
      expect(publishOcpiLocationPush).not.toHaveBeenCalled();
    });

    it('answers 409 DUPLICATE_SITE_NAME when a concurrent rename takes the name', async () => {
      setupDbResults([{ id: VALID_SITE_ID, name: 'Old' }], []);
      vi.mocked(databaseModule.db.update).mockImplementationOnce(
        () =>
          ({
            set: () => ({
              where: () => ({
                returning: () => Promise.reject(Object.assign(new Error('dup'), { code: '23505' })),
              }),
            }),
          }) as never,
      );

      const response = await app.inject({
        method: 'PATCH',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { name: 'Taken' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('DUPLICATE_SITE_NAME');
    });

    it("re-renders the site's station screens when its display language changes", async () => {
      vi.mocked(requestStationMessageRepush).mockClear();
      const base = {
        id: VALID_SITE_ID,
        name: 'Site',
        address: null,
        city: null,
        state: null,
        postalCode: null,
        country: null,
        latitude: null,
        longitude: null,
        timezone: null,
        aiInsightsEnabled: true,
        dataPlan: null,
        layoutSettings: null,
        aiMonthlyTokenBudget: null,
        aiInsightsSuppressed: false,
        aiInsightsSuppressedSources: [],
        aiInsightsSuppressedAt: null,
        aiInsightsSuppressedUntil: null,
        aiInsightsSuppressedBy: null,
        aiInsightsSuppressedByName: null,
        aiInsightsSuppressedReason: null,
        autochargeEnabled: null,
        hoursOfOperation: null,
        metadata: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults(
        [{ ...base, stationMessageLanguage: null }],
        [{ ...base, stationMessageLanguage: 'de' }],
      );

      const response = await app.inject({
        method: 'PATCH',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { stationMessageLanguage: 'de' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().stationMessageLanguage).toBe('de');
      expect(requestStationMessageRepush).toHaveBeenCalledWith(expect.anything(), {
        siteId: VALID_SITE_ID,
      });
    });

    it('does not re-render station screens when the display language is unchanged', async () => {
      vi.mocked(requestStationMessageRepush).mockClear();
      const row = {
        id: VALID_SITE_ID,
        name: 'Site',
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
        stationMessageLanguage: 'de',
        autochargeEnabled: null,
        aiInsightsEnabled: true,
        dataPlan: null,
        layoutSettings: null,
        aiMonthlyTokenBudget: null,
        aiInsightsSuppressed: false,
        aiInsightsSuppressedSources: [],
        aiInsightsSuppressedAt: null,
        aiInsightsSuppressedUntil: null,
        aiInsightsSuppressedBy: null,
        aiInsightsSuppressedByName: null,
        aiInsightsSuppressedReason: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults([row], [row]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { stationMessageLanguage: 'de' },
      });

      expect(response.statusCode).toBe(200);
      expect(requestStationMessageRepush).not.toHaveBeenCalled();
    });

    it('rejects an unsupported display language', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { stationMessageLanguage: 'fr' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 400 for a latitude outside [-90, 90]', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { latitude: '999' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Latitude must be a number in [-90, 90]',
      });
    });

    it('returns 400 for a key the body does not define, naming the free vend route', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { name: 'Site', freeVendEnabled: true },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        message:
          'Unknown field freeVendEnabled: free vend is set with POST /v1/sites/:id/free-vend',
      });
    });

    it('returns 400 for any other unknown key', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { nmae: 'Typo' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Unknown field nmae',
      });
    });

    it('returns 400 for an unknown country', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { country: 'XX' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  // --- DELETE /v1/sites/:id ---

  describe('DELETE /v1/sites/:id', () => {
    it('deletes site when no stations attached', async () => {
      const site = {
        id: VALID_SITE_ID,
        name: 'Deleted Site',
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
        autochargeEnabled: null,
        aiInsightsEnabled: true,
        dataPlan: null,
        layoutSettings: null,
        aiMonthlyTokenBudget: null,
        aiInsightsSuppressed: false,
        aiInsightsSuppressedSources: [],
        aiInsightsSuppressedAt: null,
        aiInsightsSuppressedUntil: null,
        aiInsightsSuppressedBy: null,
        aiInsightsSuppressedByName: null,
        aiInsightsSuppressedReason: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults(
        [site], // site row lock
        [], // no stations
        [], // no payment config
      );

      const response = await app.inject({
        method: 'DELETE',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().name).toBe('Deleted Site');
      expect(databaseModule.db.transaction).toHaveBeenCalled();
    });

    it('publishes the location it captured before the delete, REMOVED to its partners', async () => {
      const captured = {
        siteId: VALID_SITE_ID,
        ocpiLocationId: 'LOC-1',
        partnerIds: ['opr_000000000001'],
        site: { id: VALID_SITE_ID },
        removedEvses: [],
      };
      vi.mocked(captureDeletedSiteLocation).mockResolvedValueOnce(captured as never);
      setupDbResults(
        [
          {
            id: VALID_SITE_ID,
            name: 'Gone',
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
            autochargeEnabled: null,
            aiInsightsEnabled: true,
            dataPlan: null,
            layoutSettings: null,
            aiMonthlyTokenBudget: null,
            aiInsightsSuppressed: false,
            aiInsightsSuppressedSources: [],
            aiInsightsSuppressedAt: null,
            aiInsightsSuppressedUntil: null,
            aiInsightsSuppressedBy: null,
            aiInsightsSuppressedByName: null,
            aiInsightsSuppressedReason: null,
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        [],
        [],
      );

      const response = await app.inject({
        method: 'DELETE',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(captureDeletedSiteLocation).toHaveBeenCalledWith(
        expect.objectContaining({ id: VALID_SITE_ID }),
        expect.anything(),
      );
      expect(publishOcpiDeletedSiteLocation).toHaveBeenCalledWith(captured, expect.anything());
    });

    it('returns 409 when site has stations', async () => {
      setupDbResults([{ id: VALID_SITE_ID }], [{ id: 'sta_000000000002' }]);

      const response = await app.inject({
        method: 'DELETE',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('SITE_HAS_STATIONS');
    });

    it('returns 409 SITE_PAYMENT_CONFIG_IN_USE when the payment config has payments', async () => {
      setupDbResults(
        [{ id: VALID_SITE_ID }],
        [], // no stations
        [{ id: 7, siteId: VALID_SITE_ID }], // payment config
        [{ id: 99 }], // a payment made with it
      );

      const response = await app.inject({
        method: 'DELETE',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('SITE_PAYMENT_CONFIG_IN_USE');
      expect(databaseModule.writeAudit).not.toHaveBeenCalled();
    });

    it('deletes a site whose payment config has no payments and audits the config', async () => {
      const config = { id: 7, siteId: VALID_SITE_ID, payoutAccountId: 'acct_1' };
      setupDbResults(
        [{ ...FULL_SITE_ROW, name: 'Paid Site' }],
        [], // no stations
        [config],
        [], // no payments
      );

      const response = await app.inject({
        method: 'DELETE',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(databaseModule.writeAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'deleted',
          before: expect.objectContaining({ paymentConfig: config }),
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('maps a foreign key race to 409 SITE_HAS_STATIONS', async () => {
      vi.mocked(databaseModule.db.transaction).mockRejectedValueOnce(
        Object.assign(new Error('fk'), { code: '23503' }),
      );
      setupDbResults([{ id: 'sta_000000000002' }]);

      const response = await app.inject({
        method: 'DELETE',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('SITE_HAS_STATIONS');
    });

    it('returns 404 when site not found', async () => {
      setupDbResults([]); // no site row to lock

      const response = await app.inject({
        method: 'DELETE',
        url: `/sites/${VALID_SITE_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SITE_NOT_FOUND');
    });
  });

  // --- GET /v1/sites/:id/stations ---

  describe('GET /v1/sites/:id/stations', () => {
    it('returns paginated stations for a site', async () => {
      const stationRow = {
        id: 'st-1',
        stationId: 'STATION-001',
        siteId: VALID_SITE_ID,
        model: null,
        serialNumber: null,
        availability: 'available',
        securityProfile: 0,
        ocppProtocol: 'ocpp2.1',
        lastHeartbeat: null,
        isOnline: false,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        status: 'available',
        statusReason: null,
        connectorCount: 0,
        connectorTypes: null,
        underMaintenance: false,
      };
      // 1: site exists, 2: data, 3: count
      setupDbResults([{ id: VALID_SITE_ID }], [stationRow], [{ count: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/stations`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(body.data).toHaveLength(1);
      expect(body.data[0].ocppProtocol).toBe('ocpp2.1');
      // Conformance test stations are never listed at a site.
      expect(databaseModule.isOperatorStation).toHaveBeenCalled();
    });

    it('returns 404 when site not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/stations`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SITE_NOT_FOUND');
    });
  });

  // --- GET /v1/sites/:id/energy-history ---

  describe('GET /v1/sites/:id/energy-history', () => {
    it('returns daily energy history', async () => {
      setupDbResults([{ timezone: 'America/New_York' }], [{ date: '2025-01-01', energyWh: 10000 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/energy-history`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0]).toHaveProperty('date');
      expect(body[0]).toHaveProperty('energyWh');
    });
  });

  // --- GET /v1/sites/:id/revenue-history ---

  describe('GET /v1/sites/:id/revenue-history', () => {
    it('returns daily revenue history zero-filled across the range', async () => {
      setupDbResults([{ timezone: 'UTC' }]);
      const { aggregateRevenueRows } = sessionRevenueModule;
      mockQueryRevenue.mockResolvedValueOnce(
        aggregateRevenueRows([
          { key: '2025-01-02', taxRate: '0', grossCents: 500, source: 'session', count: 10 },
        ]),
      );

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/revenue-history?from=2025-01-01&to=2025-01-03`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body: { date: string; revenueCents: number; sessionCount: number }[] = response.json();
      // Every requested day is present; days without rows are zero-filled.
      const dates = body.map((r) => r.date);
      expect(dates).toContain('2025-01-01');
      expect(dates).toContain('2025-01-02');
      expect(dates).toContain('2025-01-03');
      expect(body.find((r) => r.date === '2025-01-02')).toEqual({
        date: '2025-01-02',
        revenueCents: 5000,
        sessionCount: 10,
      });
      expect(body.find((r) => r.date === '2025-01-01')).toEqual({
        date: '2025-01-01',
        revenueCents: 0,
        sessionCount: 0,
      });
    });
  });

  // --- GET /v1/sites/:id/meter-values ---

  describe('GET /v1/sites/:id/meter-values', () => {
    it('returns grouped meter values for a site', async () => {
      const rows = [
        {
          measurand: 'Energy.Active.Import.Register',
          unit: 'Wh',
          timestamp: new Date(),
          value: '1000',
        },
      ];
      setupDbResults(rows);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/meter-values`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].measurand).toBe('Energy.Active.Import.Register');
    });
  });

  // --- GET /v1/sites/:id/sessions ---

  describe('GET /v1/sites/:id/sessions', () => {
    it('returns paginated sessions for site', async () => {
      const session = {
        id: 'sess-1',
        stationId: VALID_STATION_ID,
        stationName: 'STATION-001',
        siteName: 'Test Site',
        driverId: null,
        driverName: null,
        transactionId: null,
        status: 'completed',
        energyDeliveredWh: '5000',
        currentCostCents: null,
        finalCostCents: null,
        currency: null,
        startedAt: '2024-01-01T00:00:00.000Z',
        endedAt: null,
        freeVend: false,
      };
      setupDbResults([session], [{ count: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/sessions`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      // Sessions of conformance test stations are never listed.
      expect(databaseModule.inOperatorStation).toHaveBeenCalledWith(
        databaseModule.chargingSessions.stationId,
      );
    });
  });

  // --- GET /v1/sites/:id/metrics ---

  describe('GET /v1/sites/:id/metrics', () => {
    it('returns site metrics', async () => {
      const sessionStats = {
        totalSessions: 20,
        completedSessions: 18,
        faultedSessions: 1,
        totalEnergyWh: 100000,
        avgDurationMinutes: 45,
      };
      const utilizationStats = { sessionHours: 15, portCount: 4 };
      const financialStats = { totalElectricityCostCents: 5000 };
      // Revenue: 20 sessions of 1070 at 7%, 3600 at 20%, and a 595 fee at 19%.
      const { aggregateRevenueRows } = sessionRevenueModule;
      mockQueryRevenue.mockResolvedValueOnce(
        aggregateRevenueRows([
          { key: null, taxRate: '0.07', grossCents: 1070, source: 'session', count: 20 },
          { key: null, taxRate: '0.2', grossCents: 3600, source: 'session', count: 1 },
          { key: null, taxRate: '0.19', grossCents: 595, source: 'fee', count: 1 },
        ]),
      );

      setupDbResults([sessionStats], [utilizationStats], [financialStats]);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/metrics`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('uptimePercent');
      expect(body).toHaveProperty('totalSessions');
      expect(body).toHaveProperty('utilizationPercent');
      expect(body).toHaveProperty('totalRevenueCents', 20 * 1070 + 3600 + 595);
      expect(body).toHaveProperty('totalNetRevenueCents', 20 * 1000 + 3000 + 500);
      expect(body).toHaveProperty('totalTaxCents', 20 * 70 + 600 + 95);
      expect(body).toHaveProperty('totalTransactions', 22);
      expect(body).toHaveProperty('avgRevenueCentsPerSession', Math.round((20 * 1070 + 3600) / 21));
      // Profit is revenue excluding tax minus electricity cost.
      expect(body).toHaveProperty('totalProfitCents', 23500 - 5000);
      expect(body).toHaveProperty('periodMonths');
      expect(body).toHaveProperty('costMissingSessionCount', 0);
      expect(body).toHaveProperty('currency', 'EUR');
      // Conformance test stations and their sessions stay out of the metrics.
      expect(databaseModule.inOperatorStation).toHaveBeenCalledWith(
        databaseModule.chargingSessions.stationId,
      );
      expect(databaseModule.operatorStationSql).toHaveBeenCalledWith('charging_stations');
      expect(databaseModule.operatorStationSql).toHaveBeenCalledWith('cs');
    });

    it('leaves sessions without an electricity cost out of profit and reports them', async () => {
      const { aggregateRevenueRows } = sessionRevenueModule;
      mockQueryRevenue.mockResolvedValueOnce(
        aggregateRevenueRows([
          {
            key: null,
            taxRate: '0',
            grossCents: 1000,
            source: 'session',
            costMissing: false,
            count: 3,
          },
          {
            key: null,
            taxRate: '0.25',
            grossCents: 1250,
            source: 'session',
            costMissing: true,
            count: 2,
          },
          { key: null, taxRate: '0', grossCents: 200, source: 'fee', costMissing: false, count: 1 },
        ]),
      );
      setupDbResults(
        [
          {
            totalSessions: 5,
            completedSessions: 5,
            faultedSessions: 0,
            totalEnergyWh: 1,
            avgDurationMinutes: 1,
          },
        ],
        [{ sessionHours: 1, portCount: 1 }],
        [{ totalElectricityCostCents: 900 }],
      );

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/metrics`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // Revenue keeps every session; profit only the sessions with a cost and the fee.
      expect(body).toHaveProperty('totalRevenueCents', 3000 + 2500 + 200);
      expect(body).toHaveProperty('totalNetRevenueCents', 3000 + 2000 + 200);
      expect(body).toHaveProperty('totalProfitCents', 3000 + 200 - 900);
      expect(body).toHaveProperty('costMissingSessionCount', 2);
      expect(body).toHaveProperty('costMissingRevenueCents', 2500);
    });
  });

  // --- GET /v1/sites/:id/layout ---

  describe('GET /v1/sites/:id/layout', () => {
    it('returns layout with station positions and EVSEs', async () => {
      const stationRow = {
        id: 'sta_000000000003',
        stationId: 'STATION-001',
        model: 'Model X',
        status: 'available',
        statusReason: null,
        isOnline: true,
        securityProfile: 0,
        positionX: '100',
        positionY: '200',
        inMaintenance: false,
        isSimulator: false,
      };
      const evseRow = {
        id: 'evs_000000000001',
        stationId: 'sta_000000000003',
        evseId: 1,
      };
      const connectorRow = {
        id: 'con_000000000002',
        evseId: 'evs_000000000001',
        connectorId: 1,
        connectorType: 'CCS2',
        maxPowerKw: 150,
        status: 'available',
      };

      // 1: site exists, 2: stations, 3: evses, 4: connectors, 5: sessions, 6: display messages
      setupDbResults(
        [{ id: VALID_SITE_ID }],
        [stationRow],
        [evseRow],
        [connectorRow],
        [], // no active sessions
        [], // no display messages
      );

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].stationId).toBe('STATION-001');
      expect(body[0].positionX).toBe(100);
      expect(body[0]).toMatchObject({
        placed: true,
        chargingKind: 'ac',
        cellular: false,
        // The layout popup offers its simulator actions only for a simulator station.
        isSimulator: false,
      });
    });

    it('adds free slots, the charging kind and the cellular flag', async () => {
      const saved = {
        id: 'sta_000000000003',
        stationId: 'STATION-001',
        model: null,
        status: 'available',
        statusReason: null,
        isOnline: true,
        securityProfile: 0,
        positionX: '20',
        positionY: '20',
        inMaintenance: false,
        isSimulator: false,
      };
      const unplaced = {
        ...saved,
        id: 'sta_000000000004',
        stationId: 'STATION-002',
        positionX: null,
        positionY: null,
        inMaintenance: true,
        isSimulator: false,
      };
      mockReadStationDataPlans.mockResolvedValueOnce(
        new Map([
          [
            'sta_000000000003',
            { chargingKind: 'dc', plan: 'wifi_or_wired', hasConfirmedSim: true },
          ],
          ['sta_000000000004', { chargingKind: 'ac', plan: 'cellular', hasConfirmedSim: false }],
        ]),
      );
      setupDbResults([{ id: VALID_SITE_ID }], [saved, unplaced], [], [], [], []);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const [first, second] = response.json();
      expect(first).toMatchObject({
        positionX: 20,
        positionY: 20,
        placed: true,
        chargingKind: 'dc',
        cellular: true,
        inMaintenance: false,
        isSimulator: false,
      });
      expect(second).toMatchObject({
        positionX: 220,
        positionY: 20,
        placed: false,
        chargingKind: 'ac',
        cellular: true,
        inMaintenance: true,
        isSimulator: false,
      });
    });

    it('gives a custom site its free positions and picks one for a station without', async () => {
      const lib = await import('@evtivity/lib/site-layout');
      mockReadSiteLayoutSettings.mockResolvedValueOnce({
        ...lib.effectiveLayoutSettings(null),
        siteType: 'custom',
      });
      const saved = {
        id: 'sta_000000000003',
        stationId: 'STATION-001',
        model: null,
        status: 'available',
        statusReason: null,
        isOnline: true,
        securityProfile: 0,
        positionX: '20',
        positionY: '20',
        freeXM: '4.50',
        freeZM: '-2.00',
        freeRotationDeg: '30.0',
        inMaintenance: false,
        isSimulator: false,
      };
      const unsaved = {
        ...saved,
        id: 'sta_000000000004',
        stationId: 'STATION-002',
        positionX: '220',
        freeXM: null,
        freeZM: null,
        freeRotationDeg: null,
      };
      setupDbResults([{ id: VALID_SITE_ID }], [saved, unsaved], [], [], [], []);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const [first, second] = response.json();
      expect(first).toMatchObject({
        placed: true,
        freePosition: { x: 4.5, z: -2, rotationDeg: 30 },
      });
      expect(second.placed).toBe(false);
      expect(
        lib.freeFootprintsOverlap(
          { placement: first.freePosition, spots: 1 },
          { placement: second.freePosition, spots: 1 },
        ),
      ).toBe(false);
    });

    it('reads the station counts by depot kind for the layout defaults', async () => {
      // One truck station: the counts the depot defaults read (an AC station would count in neither).
      const counts = { total: 1, bus: 0, truck: 1, spots: 1, rowSpots: 1 };
      mockReadStationLayoutKinds.mockResolvedValueOnce(
        new Map([['sta_000000000003', { charging: 'dc', depot: 'truck' }]]),
      );
      mockReadSiteLayoutSettings.mockClear();
      const station = {
        id: 'sta_000000000003',
        stationId: 'STATION-001',
        model: null,
        status: 'available',
        statusReason: null,
        isOnline: true,
        securityProfile: 0,
        positionX: '20',
        positionY: '20',
        freeXM: null,
        freeZM: null,
        freeRotationDeg: null,
        inMaintenance: false,
        isSimulator: false,
      };
      setupDbResults([{ id: VALID_SITE_ID }], [station], [], [], [], []);
      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.statusCode).toBe(200);
      expect(mockReadSiteLayoutSettings.mock.calls.at(-1)?.[2]).toEqual(counts);
    });

    it('returns no free position on a grid site', async () => {
      const station = {
        id: 'sta_000000000003',
        stationId: 'STATION-001',
        model: null,
        status: 'available',
        statusReason: null,
        isOnline: true,
        securityProfile: 0,
        positionX: '20',
        positionY: '20',
        inMaintenance: false,
        isSimulator: false,
      };
      setupDbResults([{ id: VALID_SITE_ID }], [station], [], [], [], []);
      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()[0]).toMatchObject({ placed: true, freePosition: null });
    });

    it('shows the active session only with sessions:read, and its driver only with drivers:read too', async () => {
      const station = {
        id: 'sta_000000000003',
        stationId: 'STATION-001',
        model: null,
        status: 'charging',
        statusReason: null,
        isOnline: true,
        securityProfile: 0,
        positionX: '20',
        positionY: '20',
        inMaintenance: false,
        isSimulator: false,
      };
      const session = {
        id: 'ses_1',
        startedAt: '2026-10-31T10:00:00.000Z',
        energyDeliveredWh: 1200,
        currentCostCents: 150,
        currency: 'USD',
        driver: null,
        vehicle: { color: 'red', bodyType: 'suv' },
      };
      const get = () =>
        app.inject({
          method: 'GET',
          url: `/sites/${VALID_SITE_ID}/layout`,
          headers: { authorization: 'Bearer ' + token },
        });

      // No sessions:read: no session, and nothing read.
      vi.mocked(requestHasPermission).mockImplementation(
        async (_r, permission) => permission !== 'sessions:read',
      );
      mockReadLayoutStationSessions.mockClear();
      setupDbResults([{ id: VALID_SITE_ID }], [station], [], [], [], []);
      const hidden = await get();
      expect(hidden.statusCode).toBe(200);
      expect(hidden.json()[0].session).toBeNull();
      expect(mockReadLayoutStationSessions).not.toHaveBeenCalled();

      // sessions:read without drivers:read: the reader is told to leave the driver out.
      vi.mocked(requestHasPermission).mockImplementation(
        async (_r, permission) => permission !== 'drivers:read' && permission !== 'fleets:read',
      );
      mockReadLayoutStationSessions.mockResolvedValueOnce(new Map([[station.id, session]]));
      setupDbResults([{ id: VALID_SITE_ID }], [station], [], [], [], []);
      const shown = await get();
      expect(shown.json()[0].session).toEqual(session);
      expect(mockReadLayoutStationSessions).toHaveBeenLastCalledWith([station.id], false);

      // Both, without fleets:read: the driver is read, no departure.
      vi.mocked(requestHasPermission).mockImplementation(
        async (_r, permission) => permission !== 'fleets:read',
      );
      setupDbResults([{ id: VALID_SITE_ID }], [station], [], [], [], []);
      await get();
      expect(mockReadLayoutStationSessions).toHaveBeenLastCalledWith([station.id], true);
    });

    it('asks for the departures of the site only with fleets:read while the Fleet feature is on', async () => {
      const station = {
        id: 'sta_000000000003',
        stationId: 'STATION-001',
        model: null,
        status: 'charging',
        statusReason: null,
        isOnline: true,
        securityProfile: 0,
        positionX: '20',
        positionY: '20',
        inMaintenance: false,
        isSimulator: false,
      };
      const departure = {
        id: 'vdp_1',
        departureAt: '2026-11-03T13:30:00.000Z',
        timezone: 'America/Los_Angeles',
        readiness: 'on_track',
        reason: null,
        targetKwh: 120,
        targetSocPercent: null,
        deliveredKwh: 45,
        shortfallKwh: 0,
        predictedReadyAt: '2026-11-03T12:10:00.000Z',
      };
      const session = {
        id: 'ses_1',
        startedAt: '2026-10-31T10:00:00.000Z',
        energyDeliveredWh: 1200,
        currentCostCents: 150,
        currency: 'USD',
        driver: null,
        vehicle: null,
        departure,
      };
      const get = () =>
        app.inject({
          method: 'GET',
          url: `/sites/${VALID_SITE_ID}/layout`,
          headers: { authorization: 'Bearer ' + token },
        });

      vi.mocked(requestHasPermission).mockResolvedValue(true);
      mockIsFleetEnabled.mockResolvedValue(true);
      mockReadLayoutStationSessions.mockResolvedValueOnce(new Map([[station.id, session]]));
      setupDbResults([{ id: VALID_SITE_ID }], [station], [], [], [], []);
      const shown = await get();
      expect(mockReadLayoutStationSessions).toHaveBeenLastCalledWith(
        [station.id],
        true,
        VALID_SITE_ID,
      );
      expect(shown.json()[0].session.departure).toEqual(departure);
      // No driver id in the departure.
      expect(JSON.stringify(shown.json()[0].session.departure)).not.toContain('drv_');

      // Without fleets:read: the reader is not asked for departures.
      vi.mocked(requestHasPermission).mockImplementation(
        async (_r, permission) => permission !== 'fleets:read',
      );
      setupDbResults([{ id: VALID_SITE_ID }], [station], [], [], [], []);
      await get();
      expect(mockReadLayoutStationSessions).toHaveBeenLastCalledWith([station.id], true);

      // The Fleet feature off: no departures either.
      vi.mocked(requestHasPermission).mockResolvedValue(true);
      mockIsFleetEnabled.mockResolvedValue(false);
      setupDbResults([{ id: VALID_SITE_ID }], [station], [], [], [], []);
      await get();
      expect(mockReadLayoutStationSessions).toHaveBeenLastCalledWith([station.id], true);
      mockIsFleetEnabled.mockResolvedValue(true);
    });

    it('returns 404 when site not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SITE_NOT_FOUND');
    });
  });

  // --- PUT /v1/sites/:id/layout ---

  describe('PUT /v1/sites/:id/layout', () => {
    it('saves layout positions, returns ok and audits the old and new positions', async () => {
      vi.mocked(databaseModule.writeAudit).mockClear();
      setupDbResults(
        [{ id: VALID_SITE_ID }], // site exists
        [{ id: VALID_STATION_ID }], // the station belongs to the site
        [{ stationId: VALID_STATION_ID, positionX: '10', positionY: '20' }], // previous position
      );

      const response = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          positions: [{ stationId: VALID_STATION_ID, positionX: 50, positionY: 100 }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().ok).toBe(true);
      const auditArgs = vi.mocked(databaseModule.writeAudit).mock.calls[0]?.[1];
      expect(auditArgs).toMatchObject({
        entityId: VALID_SITE_ID,
        action: 'updated',
        actor: 'operator',
        before: {
          layoutPositions: [{ stationId: VALID_STATION_ID, positionX: 10, positionY: 20 }],
        },
        after: {
          layoutPositions: [{ stationId: VALID_STATION_ID, positionX: 50, positionY: 100 }],
        },
        notes: 'station layout updated',
      });
    });

    it('returns 404 for a station of another site and writes nothing', async () => {
      setupDbResults(
        [{ id: VALID_SITE_ID }], // site exists
        [], // the station is not in this site
      );

      const response = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          positions: [{ stationId: VALID_STATION_ID, positionX: 1, positionY: 2 }],
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
      expect(vi.mocked(databaseModule.db.insert)).not.toHaveBeenCalled();
      expect(vi.mocked(databaseModule.writeAudit)).not.toHaveBeenCalled();
    });

    it('returns 404 when site not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          positions: [{ stationId: VALID_STATION_ID, positionX: 0, positionY: 0 }],
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SITE_NOT_FOUND');
    });

    const settings = {
      spotsPerRow: 6,
      rows: 2,
      facingDeg: 90,
      transformers: [{ id: 'tx-1', x: 26, z: 3 }],
    };

    it('saves the layout settings and audits them with the stations they moved', async () => {
      vi.mocked(databaseModule.writeAudit).mockClear();
      const before = { ...settings, spotsPerRow: 10, facingDeg: 0 };
      mockSaveSiteLayout.mockResolvedValueOnce({
        settingsBefore: before,
        settingsAfter: settings,
        settingsChanged: true,
        moved: [{ stationId: VALID_STATION_ID, positionX: 1020, positionY: 20 }],
      });
      setupDbResults(
        [{ id: VALID_SITE_ID }], // site exists
        [{ stationId: VALID_STATION_ID, positionX: '1820', positionY: '20' }], // previous positions
      );

      const response = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
        payload: { positions: [], settings },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().moved).toEqual([
        { stationId: VALID_STATION_ID, positionX: 1020, positionY: 20, freePosition: null },
      ]);
      expect(mockSaveSiteLayout.mock.calls[0]?.[3]).toEqual(settings);
      expect(vi.mocked(databaseModule.writeAudit).mock.calls[0]?.[1]).toMatchObject({
        action: 'updated',
        before: {
          layoutSettings: before,
          layoutPositions: [{ stationId: VALID_STATION_ID, positionX: 1820, positionY: 20 }],
        },
        after: {
          layoutSettings: settings,
          layoutPositions: [{ stationId: VALID_STATION_ID, positionX: 1020, positionY: 20 }],
        },
        notes: 'station layout and layout settings updated',
      });
    });

    it('saves a site type change and audits the settings before and after', async () => {
      vi.mocked(databaseModule.writeAudit).mockClear();
      const office = { ...settings, siteType: 'office_retail' as const };
      const before = { ...settings, siteType: 'parking_lot' as const };
      mockSaveSiteLayout.mockResolvedValueOnce({
        settingsBefore: before,
        settingsAfter: office,
        settingsChanged: true,
        moved: [],
      });
      setupDbResults([{ id: VALID_SITE_ID }], []);
      const response = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
        payload: { positions: [], settings: office },
      });
      expect(response.statusCode).toBe(200);
      expect(mockSaveSiteLayout.mock.calls[0]?.[3]).toEqual(office);
      expect(vi.mocked(databaseModule.writeAudit).mock.calls[0]?.[1]).toMatchObject({
        before: { layoutSettings: { siteType: 'parking_lot' } },
        after: { layoutSettings: { siteType: 'office_retail' } },
        notes: 'station layout and layout settings updated',
      });
    });

    it('drops the spot and lane sizes of earlier clients (standard dimensions)', async () => {
      mockSaveSiteLayout.mockResolvedValueOnce({
        settingsBefore: settings,
        settingsAfter: settings,
        settingsChanged: false,
        moved: [],
      });
      setupDbResults([{ id: VALID_SITE_ID }], []);
      const response = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
        payload: { positions: [], settings: { ...settings, spotWidthM: 3.2, laneWidthM: 6 } },
      });
      expect(response.statusCode).toBe(200);
      expect(mockSaveSiteLayout.mock.calls[0]?.[3]).toEqual(settings);
    });

    it('passes null to reset the settings and nothing to keep them', async () => {
      setupDbResults([{ id: VALID_SITE_ID }], []);
      await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
        payload: { positions: [], settings: null },
      });
      expect(mockSaveSiteLayout.mock.calls[0]?.[3]).toBeNull();
      setupDbResults([{ id: VALID_SITE_ID }], []);
      await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
        payload: { positions: [] },
      });
      expect(mockSaveSiteLayout.mock.calls[1]?.[3]).toBeUndefined();
    });

    it.each([
      ['spots out of range', { spotsPerRow: 0 }],
      ['no charger on either curb', { siteType: 'curbside', chargersLeft: 0, chargersRight: 0 }],
      ['a depot with no bus bay or truck lane', { siteType: 'depot', busBays: 0, truckLanes: 0 }],
      ['too many bus bays', { siteType: 'depot', busBays: 101 }],
      ['an unknown charger mounting', { mounting: 'ceiling' }],
      ['a facing that is no quarter turn', { facingDeg: 45 }],
      ['an unknown site type', { siteType: 'garage' }],
      [
        'a transformer name or rating (they live in the transformers table)',
        { transformers: [{ id: 'tfm_a', name: 'Main Feed', ratedKva: 2500, x: 26, z: 3 }] },
      ],
      [
        'an energy asset type or capacity (they live in the energy assets table)',
        { energyAssets: [{ id: 'ena_a', type: 'battery', capacityKwh: 500, x: 1, z: 1 }] },
      ],
      [
        'duplicate transformer ids',
        {
          transformers: [
            { id: 'a', x: 40, z: 0 },
            { id: 'a', x: 50, z: 0 },
          ],
        },
      ],
    ])('refuses %s with 400 VALIDATION_ERROR and saves nothing', async (_name, patch) => {
      setupDbResults([{ id: VALID_SITE_ID }], []);
      const response = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
        payload: { positions: [], settings: { ...settings, ...patch } },
      });
      expect(response.statusCode).toBe(400);
      // Ajv (FST_ERR_VALIDATION here, VALIDATION_ERROR in the app) or the Zod check.
      expect(['VALIDATION_ERROR', 'FST_ERR_VALIDATION']).toContain(response.json().code);
      expect(mockSaveSiteLayout).not.toHaveBeenCalled();
    });

    it('answers 400 VALIDATION_ERROR with the field when a position names equipment of no site row', async () => {
      vi.mocked(databaseModule.writeAudit).mockClear();
      mockSaveSiteLayout.mockRejectedValueOnce(
        new MockLoadTreeValidationError(
          'Transformer not found on this site: tfm_other',
          'settings.transformers',
        ),
      );
      setupDbResults([{ id: VALID_SITE_ID }], []);
      const response = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          positions: [],
          settings: { ...settings, transformers: [{ id: 'tfm_other', x: 26, z: 3 }] },
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        field: 'settings.transformers',
      });
      expect(databaseModule.writeAudit).not.toHaveBeenCalled();
    });

    it('passes a free position to the writer and audits it before and after', async () => {
      vi.mocked(databaseModule.writeAudit).mockClear();
      mockSaveSiteLayout.mockResolvedValueOnce({
        settingsBefore: {},
        settingsAfter: {},
        settingsChanged: false,
        moved: [],
      });
      setupDbResults(
        [{ id: VALID_SITE_ID }],
        [{ id: VALID_STATION_ID }],
        [
          {
            stationId: VALID_STATION_ID,
            positionX: '20',
            positionY: '20',
            freeXM: '1.00',
            freeZM: '2.00',
            freeRotationDeg: '0.0',
          },
        ],
      );
      const response = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          positions: [
            {
              stationId: VALID_STATION_ID,
              positionX: 20,
              positionY: 20,
              freePosition: { x: 6.5, z: 2, rotationDeg: 45 },
            },
          ],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(mockSaveSiteLayout.mock.calls.at(-1)?.[2]).toEqual([
        {
          stationId: VALID_STATION_ID,
          positionX: 20,
          positionY: 20,
          free: { x: 6.5, z: 2, rotationDeg: 45 },
        },
      ]);
      expect(vi.mocked(databaseModule.writeAudit).mock.calls[0]?.[1]).toMatchObject({
        before: { layoutPositions: [{ free: { x: 1, z: 2, rotationDeg: 0 } }] },
        after: { layoutPositions: [{ free: { x: 6.5, z: 2, rotationDeg: 45 } }] },
      });
    });

    it('drops a spot type an older client sends with a free position (custom sites have car spots only)', async () => {
      mockSaveSiteLayout.mockClear();
      mockSaveSiteLayout.mockResolvedValueOnce({
        settingsBefore: {},
        settingsAfter: {},
        settingsChanged: false,
        moved: [],
      });
      setupDbResults([{ id: VALID_SITE_ID }], [{ id: VALID_STATION_ID }], []);
      const response = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          positions: [
            {
              stationId: VALID_STATION_ID,
              positionX: 20,
              positionY: 20,
              freePosition: { x: 1, z: 2, rotationDeg: 0, spotType: 'bus_bay' },
            },
          ],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(mockSaveSiteLayout.mock.calls.at(-1)?.[2]).toEqual([
        {
          stationId: VALID_STATION_ID,
          positionX: 20,
          positionY: 20,
          free: { x: 1, z: 2, rotationDeg: 0 },
        },
      ]);
    });

    it('refuses a turn of 360 degrees before the writer runs', async () => {
      mockSaveSiteLayout.mockClear();
      const response = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          positions: [
            {
              stationId: VALID_STATION_ID,
              positionX: 20,
              positionY: 20,
              freePosition: { x: 0, z: 0, rotationDeg: 360 },
            },
          ],
        },
      });
      expect(response.statusCode).toBe(400);
      expect(mockSaveSiteLayout).not.toHaveBeenCalled();
    });

    it('names the stations whose spots overlap on a custom site and audits nothing', async () => {
      vi.mocked(databaseModule.writeAudit).mockClear();
      mockSaveSiteLayout.mockRejectedValueOnce(new MockLayoutSpotsOverlapError(['CS-0982']));
      setupDbResults([{ id: VALID_SITE_ID }], []);
      const response = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
        payload: { positions: [] },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: { stations: ['CS-0982'] },
      });
      expect(vi.mocked(databaseModule.writeAudit)).not.toHaveBeenCalled();
    });

    it('names the stations a smaller lot cannot hold and audits nothing', async () => {
      vi.mocked(databaseModule.writeAudit).mockClear();
      mockSaveSiteLayout.mockRejectedValueOnce(new MockLayoutGridTooSmallError(['CS-0981']));
      setupDbResults([{ id: VALID_SITE_ID }], []);
      const response = await app.inject({
        method: 'PUT',
        url: `/sites/${VALID_SITE_ID}/layout`,
        headers: { authorization: 'Bearer ' + token },
        payload: { positions: [], settings },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: { stations: ['CS-0981'] },
      });
      expect(vi.mocked(databaseModule.writeAudit)).not.toHaveBeenCalled();
    });
  });

  // --- GET /v1/sites/export ---

  describe('GET /v1/sites/export', () => {
    it('returns CSV data with correct content type', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/sites/export',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
    });
  });

  // --- GET /v1/sites/export/template ---

  describe('GET /v1/sites/export/template', () => {
    it('returns template CSV', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/sites/export/template',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
    });
  });

  // --- POST /v1/sites/import ---

  describe('POST /v1/sites/import', () => {
    it('imports sites from rows and returns result', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/sites/import',
        headers: { authorization: 'Bearer ' + token },
        payload: {
          rows: [{ siteName: 'Imported Site' }],
          updateExisting: false,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty('sitesCreated');
    });

    it('refuses station rows without stations:write', async () => {
      vi.mocked(requestHasPermission).mockResolvedValueOnce(false);
      const response = await app.inject({
        method: 'POST',
        url: '/sites/import',
        headers: { authorization: 'Bearer ' + token },
        payload: {
          rows: [{ siteName: 'Imported Site', stationId: 'CS-1' }],
          updateExisting: true,
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(requestHasPermission).toHaveBeenCalledWith(expect.anything(), 'stations:write');
      expect(importSitesCsv).not.toHaveBeenCalled();
    });

    it('imports site-only rows without asking for stations:write', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/sites/import',
        headers: { authorization: 'Bearer ' + token },
        payload: { rows: [{ siteName: 'Only A Site', stationId: '' }], updateExisting: false },
      });

      expect(response.statusCode).toBe(200);
      expect(requestHasPermission).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/sites/import',
        headers: { authorization: 'Bearer ' + token },
        payload: { rows: 'not-array', updateExisting: false },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
