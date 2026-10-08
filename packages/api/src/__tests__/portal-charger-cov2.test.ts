// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, afterEach, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// DB mock helpers
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

const { mockRecordSessionEndRequest } = vi.hoisted(() => ({
  mockRecordSessionEndRequest: vi.fn().mockResolvedValue(true),
}));

vi.mock('@evtivity/database', async () => ({
  // The shared driver availability rule builds SQL; drizzle is mocked here, so the fragments are stubs.
  availableEvseCountSql: vi.fn(() => 'available_evse_count'),
  evseAvailableSql: vi.fn(() => 'evse_available'),
  evseOpenToDriversSql: vi.fn(() => 'evse_open_to_drivers'),
  STARTABLE_CONNECTOR_STATUSES: ['available', 'occupied', 'preparing', 'ev_connected', 'finishing'],
  SESSION_END_REQUEST_CHANNEL: 'session_end_requests',
  recordSessionEndRequest: mockRecordSessionEndRequest,
  isStationLevelUnavailable: (
    await vi.importActual<typeof import('../../../database/src/lib/station-status.js')>(
      '../../../database/src/lib/station-status.js',
    )
  ).isStationLevelUnavailable,
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
  getCompanyTaxBasis: vi.fn(() => Promise.resolve('net')),
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([{ nextval: '42', next_val: '6' }])),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => makeChain()),
        insert: vi.fn(() => makeChain()),
        update: vi.fn(() => makeChain()),
        delete: vi.fn(() => makeChain()),
      };
      return fn(tx);
    }),
  },
  client: {},
  chargingStations: {},
  evses: {},
  connectors: {},
  sites: {},
  chargingSessions: {},
  driverPaymentMethods: {},
  paymentRecords: {},
  reservations: {},
  stationImages: {},
  settings: {},
  driverTokens: {},
  getReservationSettings: vi.fn().mockResolvedValue({
    enabled: true,
    bufferMinutes: 0,
    cancellationWindowMinutes: 0,
    cancellationFeeCents: 0,
    maxHours: 0,
  }),
  writeReservationAudit: vi.fn().mockResolvedValue(undefined),
  reservationDiffChanged: vi.fn().mockReturnValue(false),
  resolveStationTariff: vi.fn().mockResolvedValue(null),
  isStationChargingFree: vi.fn().mockResolvedValue(true),
  resolveAccountBilling: vi.fn().mockResolvedValue(null),
  sessionBillingColumns: (billing: { fleetId: string } | null) =>
    billing == null
      ? { billingMode: 'card', billingFleetId: null }
      : { billingMode: 'account', billingFleetId: billing.fleetId },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn(), join: vi.fn() }),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
  gt: vi.fn(),
  isNull: vi.fn(),
  inArray: vi.fn(),
}));

const mockPgEnd = vi.fn().mockResolvedValue(undefined);
const mockPgTagged = vi.fn().mockResolvedValue([]);
vi.mock('postgres', () => ({
  default: vi.fn(() => {
    const fn = mockPgTagged as unknown as Record<string, unknown>;
    fn.end = mockPgEnd;
    return fn;
  }),
}));

const {
  mockActivePaymentProvider,
  mockAuthorizeSessionHold,
  mockCancelOpenSessionHold,
  mockScheduleRemoteStartTimeout,
} = vi.hoisted(() => ({
  mockActivePaymentProvider: vi.fn(),
  mockAuthorizeSessionHold: vi.fn(),
  mockCancelOpenSessionHold: vi.fn(),
  mockScheduleRemoteStartTimeout: vi.fn(),
}));

vi.mock('@evtivity/payments', () => ({
  authorizeSessionHold: mockAuthorizeSessionHold,
  cancelOpenSessionHold: mockCancelOpenSessionHold,
  chargeReservationFee: vi.fn(),
}));

vi.mock('../lib/remote-start-timeout.js', () => ({
  scheduleRemoteStartTimeout: mockScheduleRemoteStartTimeout,
}));

vi.mock('../lib/payments.js', () => ({
  activePaymentProvider: mockActivePaymentProvider,
  paymentContext: vi.fn((logger: unknown) => ({ registry: 'registry', logger })),
}));

const { mockPublish } = vi.hoisted(() => ({
  mockPublish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({
    publish: mockPublish,
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  setPubSub: vi.fn(),
}));

vi.mock('@evtivity/services/ocpp-command', () => ({
  sendOcppCommandAndWait: vi.fn().mockResolvedValue({
    response: { status: 'Accepted' },
    error: null,
  }),
}));

vi.mock('../lib/reservation-buffer.js', () => ({
  isEvseInReservationBuffer: vi.fn().mockResolvedValue(false),
}));

const { mockRenderMaintenanceMessage, mockDispatchDriverNotification } = vi.hoisted(() => ({
  mockRenderMaintenanceMessage: vi.fn(),
  mockDispatchDriverNotification: vi.fn(),
}));

vi.mock('@evtivity/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/lib')>();
  return {
    ...actual,
    dispatchDriverNotification: mockDispatchDriverNotification,
    renderMaintenanceMessage: mockRenderMaintenanceMessage,
  };
});

vi.mock('@evtivity/services/template-dirs', () => ({
  ALL_TEMPLATES_DIRS: [],
}));

vi.mock('@evtivity/services/maintenance.service', () => ({
  getActiveMaintenanceForStation: vi.fn().mockResolvedValue(null),
}));

vi.mock('@evtivity/services/maintenance-check', () => ({
  assertNoMaintenanceConflict: vi.fn().mockResolvedValue(undefined),
  MaintenanceConflictError: class MaintenanceConflictError extends Error {
    statusCode = 409;
    code = 'RESERVATION_DURING_MAINTENANCE';
    details: Record<string, unknown> = {};
  },
}));

vi.mock('../lib/reservation-eligibility.js', () => ({
  assertReservationsAllowed: vi.fn().mockResolvedValue(undefined),
}));

const { mockIsStationCheckRateLimited, mockGetCachedConnectorStatus } = vi.hoisted(() => ({
  mockIsStationCheckRateLimited: vi.fn(),
  mockGetCachedConnectorStatus: vi.fn(),
}));

vi.mock('../lib/rate-limiters.js', () => ({
  isStationCheckRateLimited: mockIsStationCheckRateLimited,
  getCachedConnectorStatus: mockGetCachedConnectorStatus,
  setCachedConnectorStatus: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { portalChargerRoutes } from '../routes/portal/charger.js';
import {
  db,
  getReservationSettings,
  isStationChargingFree,
  writeReservationAudit,
} from '@evtivity/database';
import { sendOcppCommandAndWait } from '@evtivity/services/ocpp-command';
import { getActiveMaintenanceForStation } from '@evtivity/services/maintenance.service';
import {
  assertNoMaintenanceConflict,
  MaintenanceConflictError,
} from '@evtivity/services/maintenance-check';

const STATION_UUID = 'sta_000000000001';
const SESSION_ID = 'ses_000000000001';
const RESERVATION_ID = 'rsv_000000000001';
const DRIVER_ID = 'drv_000000000001';

const RESERVATION_SETTINGS = {
  enabled: true,
  bufferMinutes: 0,
  cancellationWindowMinutes: 0,
  cancellationFeeCents: 0,
  maxHours: 0,
  activeSessionCheckHours: 0,
};

const START_STATION = {
  id: STATION_UUID,
  stationId: 'CS-001',
  siteId: 'sit_000000000001',
  isOnline: true,
  onboardingStatus: 'accepted',
  ocppProtocol: 'ocpp2.1',
  disabledReason: null,
  firmwareState: null,
  reportedStatus: null,
  freeVendEnabled: false,
};

const RESERVATION_STATION = {
  id: STATION_UUID,
  siteId: null,
  isOnline: true,
  onboardingStatus: 'accepted',
  reservationsEnabled: true,
};

const CREATED_RESERVATION = {
  id: RESERVATION_ID,
  reservationId: 6,
  stationId: STATION_UUID,
  evseId: null,
  driverId: DRIVER_ID,
  tokenId: null,
  status: 'active',
  expiresAt: '2030-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalChargerRoutes);
  await app.ready();
  return app;
}

/** The `set` payloads of every db.update in the request. */
function updateSets(): unknown[] {
  return vi
    .mocked(db.update)
    .mock.results.flatMap(
      (res) => (res.value as { set: ReturnType<typeof vi.fn> }).set.mock.calls as unknown[][],
    )
    .map(([values]) => values);
}

/** The `values` payloads of every db.insert in the request. */
function insertValues(): unknown[] {
  return vi
    .mocked(db.insert)
    .mock.results.flatMap(
      (res) => (res.value as { values: ReturnType<typeof vi.fn> }).values.mock.calls as unknown[][],
    )
    .map(([values]) => values);
}

function publishedOn(channel: string): Array<Record<string, unknown>> {
  return mockPublish.mock.calls
    .filter((c) => c[0] === channel)
    .map((c) => JSON.parse(c[1] as string) as Record<string, unknown>);
}

describe('Portal charger routes - remaining branches', () => {
  let app: FastifyInstance;
  let driverToken: string;

  beforeAll(async () => {
    app = await buildApp();
    driverToken = app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    mockActivePaymentProvider.mockResolvedValue(null);
    mockIsStationCheckRateLimited.mockReturnValue(false);
    mockGetCachedConnectorStatus.mockReturnValue(null);
    mockRenderMaintenanceMessage.mockResolvedValue('Closed for repairs');
    vi.mocked(isStationChargingFree).mockResolvedValue(true);
    vi.mocked(getActiveMaintenanceForStation).mockResolvedValue(null);
    vi.mocked(assertNoMaintenanceConflict).mockResolvedValue(undefined);
    vi.mocked(getReservationSettings).mockResolvedValue(RESERVATION_SETTINGS);
    vi.mocked(sendOcppCommandAndWait).mockReset();
    vi.mocked(sendOcppCommandAndWait).mockResolvedValue({
      response: { status: 'Accepted' },
      error: null,
    } as never);
  });

  const auth = (): Record<string, string> => ({ authorization: `Bearer ${driverToken}` });

  describe('GET /portal/chargers/:stationId/evse/:evseId', () => {
    const station = {
      id: STATION_UUID,
      stationId: 'CS-001',
      siteId: 'sit_000000000001',
      model: 'M1',
      isOnline: true,
      isSimulator: false,
      siteName: 'Site A',
      siteAddress: '1 Main',
      siteCity: 'Austin',
      siteState: 'TX',
    };

    it('reports the active reservation and the maintenance window', async () => {
      const expiresAt = new Date('2030-05-01T12:00:00.000Z');
      const plannedEndAt = new Date('2030-05-02T00:00:00.000Z');
      vi.mocked(getActiveMaintenanceForStation).mockResolvedValue({
        siteId: 'sit_000000000001',
        plannedEndAt,
      } as never);
      setupDbResults(
        [station],
        [{ id: 'evs_000000000001', evseId: 1 }],
        [],
        [{ expiresAt, driverId: 'drv_000000000002' }],
        [{ name: 'Site A' }],
      );

      const response = await app.inject({ method: 'GET', url: '/portal/chargers/CS-001/evse/1' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.evse.reservationExpiresAt).toBe('2030-05-01T12:00:00.000Z');
      expect(body.evse.reservationDriverId).toBe('drv_000000000002');
      expect(body.maintenance).toEqual({
        active: true,
        plannedEndAt: '2030-05-02T00:00:00.000Z',
        message: 'Closed for repairs',
      });
      expect(mockRenderMaintenanceMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ plannedEndAt }),
        'Site A',
      );
    });

    it('keeps the maintenance window without a message when rendering fails', async () => {
      vi.mocked(getActiveMaintenanceForStation).mockResolvedValue({
        siteId: 'sit_000000000001',
        plannedEndAt: new Date('2030-05-02T00:00:00.000Z'),
      } as never);
      mockRenderMaintenanceMessage.mockRejectedValue(new Error('template broken'));
      setupDbResults([station], [{ id: 'evs_000000000001', evseId: 1 }], [], [], []);

      const response = await app.inject({ method: 'GET', url: '/portal/chargers/CS-001/evse/1' });

      expect(response.statusCode).toBe(200);
      expect(response.json().maintenance).toEqual({
        active: true,
        plannedEndAt: '2030-05-02T00:00:00.000Z',
        message: null,
      });
      expect(response.json().evse.reservationExpiresAt).toBeNull();
    });
  });

  describe('GET /portal/chargers/:stationId/pricing', () => {
    it('answers a zeroed free-vend tariff without resolving the pricing group', async () => {
      setupDbResults([{ id: STATION_UUID, freeVendEnabled: true }]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/CS-001/pricing',
        headers: auth(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        currency: 'EUR',
        pricePerKwh: null,
        pricePerMinute: null,
        pricePerSession: null,
        taxBasis: 'net',
        isFreeVend: true,
        restrictions: null,
        billing: null,
      });
    });
  });

  describe('GET /portal/chargers/search and /nearby', () => {
    const connectorRows = [
      {
        stationId: 'uuid-1',
        connectorType: 'CCS2',
        maxPowerKw: 150,
        maxCurrentAmps: 200,
        status: 'available',
      },
      {
        stationId: 'uuid-1',
        connectorType: 'Type2',
        maxPowerKw: 22,
        maxCurrentAmps: 32,
        status: 'charging',
      },
      {
        stationId: 'uuid-2',
        connectorType: 'CHAdeMO',
        maxPowerKw: 50,
        maxCurrentAmps: null,
        status: 'faulted',
      },
    ];

    it('groups the connectors of each search result under its station', async () => {
      setupDbResults(
        [
          {
            stationId: 'CS-1',
            stationUuid: 'uuid-1',
            model: 'M1',
            isOnline: true,
            siteName: 'A',
            siteAddress: null,
            siteCity: null,
            evseCount: 2,
            availableCount: 1,
          },
          {
            stationId: 'CS-2',
            stationUuid: 'uuid-2',
            model: 'M2',
            isOnline: false,
            siteName: 'B',
            siteAddress: null,
            siteCity: null,
            evseCount: 1,
            availableCount: 0,
          },
        ],
        connectorRows,
      );
      const response = await app.inject({ method: 'GET', url: '/portal/chargers/search?q=CS' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body[0].connectors).toEqual([
        { connectorType: 'CCS2', maxPowerKw: 150, maxCurrentAmps: 200, status: 'available' },
        { connectorType: 'Type2', maxPowerKw: 22, maxCurrentAmps: 32, status: 'charging' },
      ]);
      expect(body[1].connectors).toEqual([
        { connectorType: 'CHAdeMO', maxPowerKw: 50, maxCurrentAmps: null, status: 'faulted' },
      ]);
    });

    it('lists nearby stations with rounded distance and their connectors', async () => {
      setupDbResults(
        [
          {
            stationId: 'CS-1',
            stationUuid: 'uuid-1',
            model: 'M1',
            isOnline: true,
            siteName: 'A',
            siteAddress: '1 Main',
            siteCity: 'Austin',
            distanceKm: 1.26,
            evseCount: 2,
            availableCount: 1,
          },
          {
            stationId: 'CS-3',
            stationUuid: 'uuid-3',
            model: null,
            isOnline: true,
            siteName: 'C',
            siteAddress: null,
            siteCity: null,
            distanceKm: 12.04,
            evseCount: 0,
            availableCount: 0,
          },
        ],
        connectorRows,
      );
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/nearby?lat=30.27&lng=-97.74&radius=25&limit=5',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(2);
      expect(body[0]).toMatchObject({ stationId: 'CS-1', distanceKm: 1.3, siteCity: 'Austin' });
      expect(body[0].connectors).toHaveLength(2);
      expect(body[1]).toMatchObject({ stationId: 'CS-3', distanceKm: 12, connectors: [] });
    });

    it('returns an empty list without a connector query when nothing is nearby', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/nearby?lat=0&lng=0',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    it('rejects a latitude out of range', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/nearby?lat=91&lng=0',
      });
      expect(response.statusCode).toBe(400);
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe('GET /portal/chargers/:stationId', () => {
    const station = {
      id: STATION_UUID,
      stationId: 'CS-001',
      siteId: 'sit_000000000001',
      model: 'M1',
      isOnline: true,
      disabledReason: null,
      firmwareState: null,
      reportedStatus: null,
      isSimulator: false,
      siteName: 'Site A',
      siteAddress: '1 Main',
      siteCity: 'Austin',
      siteState: 'TX',
      siteContactName: 'Ann',
      siteContactEmail: 'ann@example.com',
      siteContactPhone: '+15125550100',
      siteContactIsPublic: true,
    };

    it('returns 404 STATION_NOT_FOUND for an unknown station', async () => {
      setupDbResults([]);
      const response = await app.inject({ method: 'GET', url: '/portal/chargers/CS-404' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
    });

    it('groups connectors per EVSE and applies station-level and EVSE reservations', async () => {
      const stationLevelExpiry = new Date('2030-01-01T10:00:00.000Z');
      const evseExpiry = new Date('2030-01-01T09:00:00.000Z');
      setupDbResults(
        [station],
        [
          {
            id: 'evs_1',
            evseId: 1,
            connectorId: 1,
            connectorType: 'CCS2',
            maxPowerKw: '150.0',
            maxCurrentAmps: 200,
            connectorStatus: 'available',
          },
          {
            id: 'evs_1',
            evseId: 1,
            connectorId: 2,
            connectorType: 'Type2',
            maxPowerKw: null,
            maxCurrentAmps: null,
            connectorStatus: null,
          },
          {
            id: 'evs_2',
            evseId: 2,
            connectorId: null,
            connectorType: null,
            maxPowerKw: null,
            maxCurrentAmps: null,
            connectorStatus: null,
          },
        ],
        [
          // EVSE 2 first (earliest expiry), then a station-level one covering the rest.
          { evseId: 'evs_2', expiresAt: evseExpiry, driverId: 'drv_000000000002' },
          { evseId: null, expiresAt: stationLevelExpiry, driverId: 'drv_000000000003' },
          // An EVSE that is not on this station is ignored.
          { evseId: 'evs_other', expiresAt: evseExpiry, driverId: 'drv_000000000004' },
        ],
      );

      const response = await app.inject({ method: 'GET', url: '/portal/chargers/CS-001' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.siteContactName).toBe('Ann');
      expect(body.siteContactEmail).toBe('ann@example.com');
      expect(body.siteContactPhone).toBe('+15125550100');
      expect(body.stationUnavailable).toBe(false);
      expect(body.maintenance).toBeNull();
      expect(body.evses).toEqual([
        {
          evseId: 1,
          connectors: [
            {
              connectorId: 1,
              connectorType: 'CCS2',
              maxPowerKw: 150,
              maxCurrentAmps: 200,
              status: 'available',
            },
            {
              connectorId: 2,
              connectorType: 'Type2',
              maxPowerKw: null,
              maxCurrentAmps: null,
              status: 'unavailable',
            },
          ],
          reservationExpiresAt: '2030-01-01T10:00:00.000Z',
          reservationDriverId: 'drv_000000000003',
        },
        {
          evseId: 2,
          connectors: [],
          reservationExpiresAt: '2030-01-01T09:00:00.000Z',
          reservationDriverId: 'drv_000000000002',
        },
      ]);
    });

    it('hides the site contact when it is not public and flags a disabled station', async () => {
      setupDbResults([{ ...station, siteContactIsPublic: false, disabledReason: 'operator' }], []);
      const response = await app.inject({ method: 'GET', url: '/portal/chargers/CS-001' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.siteContactName).toBeNull();
      expect(body.siteContactEmail).toBeNull();
      expect(body.siteContactPhone).toBeNull();
      expect(body.stationUnavailable).toBe(true);
      expect(body.evses).toEqual([]);
    });
  });

  describe('POST /portal/chargers/:stationId/evse/:evseId/check-status', () => {
    const online = { id: STATION_UUID, stationId: 'CS-001', isOnline: true, ocppProtocol: null };

    it('serves a cached status without a TriggerMessage', async () => {
      setupDbResults([online]);
      mockGetCachedConnectorStatus.mockReturnValue({ status: 'preparing', cachedAt: Date.now() });
      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/check-status',
        headers: auth(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ connectorStatus: 'preparing' });
      expect(mockIsStationCheckRateLimited).not.toHaveBeenCalled();
      expect(db.execute).not.toHaveBeenCalled();
    });

    it('returns 429 RATE_LIMITED when the station check budget is spent', async () => {
      setupDbResults([online]);
      mockIsStationCheckRateLimited.mockReturnValue(true);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/check-status',
        headers: auth(),
      });
      expect(response.statusCode).toBe(429);
      expect(response.json()).toEqual({
        error: 'Too many status checks for this station',
        code: 'RATE_LIMITED',
      });
      expect(db.execute).not.toHaveBeenCalled();
    });
  });

  describe('POST /portal/chargers/:stationId/evse/:evseId/start', () => {
    function start(payload: Record<string, unknown> = {}) {
      return app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: auth(),
        payload,
      });
    }

    /** Station, EVSE, connector, the three empty gate checks, then the given rows. */
    function setupStartRows(...rest: unknown[][]): void {
      setupDbResults(
        [START_STATION],
        [{ id: 'evs_000000000001' }],
        [{ status: 'available' }],
        [],
        [],
        [],
        ...rest,
      );
    }

    it('returns 409 MAINTENANCE_ACTIVE during a maintenance window', async () => {
      setupDbResults([START_STATION]);
      vi.mocked(getActiveMaintenanceForStation).mockResolvedValue({
        plannedEndAt: new Date('2030-01-01T06:00:00.000Z'),
      } as never);
      const response = await start();
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'MAINTENANCE_ACTIVE',
        plannedEndAt: '2030-01-01T06:00:00.000Z',
      });
      expect(insertValues()).toEqual([]);
    });

    it('returns 403 STATION_PENDING for a station awaiting approval', async () => {
      setupDbResults([{ ...START_STATION, onboardingStatus: 'pending' }]);
      const response = await start();
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('STATION_PENDING');
    });

    it('returns 409 STATION_UNAVAILABLE when the firmware is installing', async () => {
      setupDbResults([{ ...START_STATION, firmwareState: 'installing' }]);
      const response = await start();
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('STATION_UNAVAILABLE');
    });

    it('returns 403 CONNECTOR_RESERVED when another driver holds the reservation', async () => {
      setupDbResults(
        [START_STATION],
        [{ id: 'evs_000000000001' }],
        [{ status: 'reserved' }],
        [{ driverId: 'drv_000000000099' }],
      );
      const response = await start();
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: 'Connector is reserved for another driver',
        code: 'CONNECTOR_RESERVED',
      });
    });

    it('lets the reservation holder start on a reserved connector', async () => {
      setupDbResults(
        [START_STATION],
        [{ id: 'evs_000000000001' }],
        [{ status: 'reserved' }],
        [{ driverId: DRIVER_ID }],
        [],
        [],
        [{ id: SESSION_ID }],
      );
      const response = await start();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ chargingSessionId: SESSION_ID });
    });

    it('returns 400 SESSION_ALREADY_ACTIVE when the driver is already charging', async () => {
      setupDbResults(
        [START_STATION],
        [{ id: 'evs_000000000001' }],
        [{ status: 'available' }],
        [],
        [],
        [{ id: 'ses_000000000002' }],
      );
      const response = await start();
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'You already have an active charging session',
        code: 'SESSION_ALREADY_ACTIVE',
      });
      expect(insertValues()).toEqual([]);
    });

    it('starts without a hold when the card provider is not configured', async () => {
      mockActivePaymentProvider.mockResolvedValue({ id: 'stripe' });
      vi.mocked(isStationChargingFree).mockResolvedValue(false);
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'not_configured',
        providerId: 'adyen',
      });
      setupStartRows([{ id: 7 }], [{ id: SESSION_ID }]);
      const response = await start({ paymentMethodId: 7 });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ chargingSessionId: SESSION_ID });
      expect(updateSets()).toEqual([]);
      expect(sendOcppCommandAndWait).toHaveBeenCalledWith(
        'CS-001',
        'RequestStartTransaction',
        expect.objectContaining({ evseId: 1, idToken: { idToken: DRIVER_ID, type: 'Central' } }),
      );
    });

    it('answers 500 SESSION_CREATE_FAILED and sends nothing when the session insert returns no row', async () => {
      setupStartRows([]);
      const response = await start();
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: 'Failed to create session',
        code: 'SESSION_CREATE_FAILED',
      });
      expect(insertValues()).toEqual([
        expect.objectContaining({ driverId: DRIVER_ID, status: 'active', currency: 'EUR' }),
      ]);
      expect(sendOcppCommandAndWait).not.toHaveBeenCalled();
    });

    it('returns 504 and faults the session when the station does not answer', async () => {
      setupStartRows([{ id: SESSION_ID }]);
      vi.mocked(sendOcppCommandAndWait).mockResolvedValueOnce({
        response: null,
        error: 'timeout',
      } as never);
      const response = await start();
      expect(response.statusCode).toBe(504);
      expect(response.json()).toEqual({
        error: 'Station did not respond',
        code: 'STATION_TIMEOUT',
      });
      expect(updateSets()).toEqual([expect.objectContaining({ status: 'faulted' })]);
      expect(mockDispatchDriverNotification).toHaveBeenCalledWith(
        expect.anything(),
        'session.Faulted',
        DRIVER_ID,
        { stationId: 'CS-001', reason: 'Station did not respond' },
        [],
        expect.anything(),
      );
      expect(mockScheduleRemoteStartTimeout).not.toHaveBeenCalled();
    });

    describe('TxInProgress recovery', () => {
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout'] });
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      /** Waits for the route to schedule its retry delay, then runs it. */
      async function advancePastRetryWait(): Promise<void> {
        for (let i = 0; i < 1000 && vi.getTimerCount() === 0; i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        await vi.advanceTimersByTimeAsync(5000);
      }

      const txInProgress = (extra: Record<string, unknown> = {}) => ({
        response: { status: 'Rejected', statusInfo: { reasonCode: 'TxInProgress', ...extra } },
        error: null,
      });

      it('stops the ghost transaction, waits and retries the start', async () => {
        setupStartRows([{ id: SESSION_ID }], []);
        vi.mocked(sendOcppCommandAndWait)
          .mockResolvedValueOnce(txInProgress({ additionalInfo: 'ghost-tx-1' }) as never)
          .mockResolvedValueOnce({ response: { status: 'Accepted' }, error: null } as never)
          .mockResolvedValueOnce({ response: { status: 'Accepted' }, error: null } as never);

        const pending = start();
        await advancePastRetryWait();
        const response = await pending;

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ chargingSessionId: SESSION_ID });
        const calls = vi.mocked(sendOcppCommandAndWait).mock.calls;
        expect(calls.map((c) => c[1])).toEqual([
          'RequestStartTransaction',
          'RequestStopTransaction',
          'RequestStartTransaction',
        ]);
        expect(calls[1]?.[2]).toEqual({ transactionId: 'ghost-tx-1' });
        // The retry reuses the same remoteStartId so the projection still matches.
        expect((calls[2]?.[2] as { remoteStartId: number }).remoteStartId).toBe(
          (calls[0]?.[2] as { remoteStartId: number }).remoteStartId,
        );
        expect(mockScheduleRemoteStartTimeout).toHaveBeenCalledWith(
          { kind: 'session', sessionId: SESSION_ID },
          expect.objectContaining({ id: STATION_UUID }),
          expect.anything(),
        );
        expect(updateSets()).toEqual([]);
      });

      it('retries without a stop when the ghost transaction id is unknown, then faults on a second rejection', async () => {
        setupStartRows([{ id: SESSION_ID }], []);
        mockCancelOpenSessionHold.mockResolvedValueOnce(undefined);
        vi.mocked(sendOcppCommandAndWait)
          .mockResolvedValueOnce(txInProgress() as never)
          .mockResolvedValueOnce({ response: { status: 'Rejected' }, error: null } as never);

        const pending = start();
        await advancePastRetryWait();
        const response = await pending;

        expect(response.statusCode).toBe(502);
        expect(response.json()).toEqual({
          error: 'Station rejected start request: Rejected',
          code: 'START_REJECTED',
        });
        expect(vi.mocked(sendOcppCommandAndWait).mock.calls.map((c) => c[1])).toEqual([
          'RequestStartTransaction',
          'RequestStartTransaction',
        ]);
        expect(updateSets()).toEqual([expect.objectContaining({ status: 'faulted' })]);
        expect(mockCancelOpenSessionHold).toHaveBeenCalledWith(
          SESSION_ID,
          'Station rejected the start: Rejected',
          expect.anything(),
        );
        expect(mockScheduleRemoteStartTimeout).not.toHaveBeenCalled();
      });

      it('takes the ghost id from transactionId when statusInfo has none', async () => {
        setupStartRows([{ id: SESSION_ID }], []);
        vi.mocked(sendOcppCommandAndWait)
          .mockResolvedValueOnce({
            response: {
              status: 'Rejected',
              statusInfo: { reasonCode: 'TxInProgress' },
              transactionId: 'ghost-tx-2',
            },
            error: null,
          } as never)
          .mockResolvedValueOnce({ response: { status: 'Accepted' }, error: null } as never)
          .mockResolvedValueOnce({ response: { status: 'Accepted' }, error: null } as never);

        const pending = start();
        await advancePastRetryWait();
        const response = await pending;

        expect(response.statusCode).toBe(200);
        expect(sendOcppCommandAndWait).toHaveBeenCalledWith('CS-001', 'RequestStopTransaction', {
          transactionId: 'ghost-tx-2',
        });
      });

      it('does not retry when the CSMS already has an active session on the EVSE', async () => {
        setupStartRows([{ id: SESSION_ID }], [{ id: 'ses_000000000005' }]);
        vi.mocked(sendOcppCommandAndWait).mockResolvedValueOnce(
          txInProgress({ additionalInfo: 'tx-real' }) as never,
        );

        const response = await start();

        expect(response.statusCode).toBe(502);
        expect(response.json().code).toBe('START_REJECTED');
        expect(sendOcppCommandAndWait).toHaveBeenCalledTimes(1);
        expect(updateSets()).toEqual([expect.objectContaining({ status: 'faulted' })]);
      });
    });
  });

  describe('POST /portal/chargers/sessions/:sessionId/stop', () => {
    it('returns 504 STATION_TIMEOUT when the station does not answer the stop', async () => {
      setupDbResults([
        {
          id: SESSION_ID,
          transactionId: 'tx-9',
          stationOcppId: 'CS-001',
          ocppProtocol: 'ocpp2.1',
        },
      ]);
      vi.mocked(sendOcppCommandAndWait).mockResolvedValueOnce({
        response: null,
        error: 'timeout',
      } as never);
      const response = await app.inject({
        method: 'POST',
        url: `/portal/chargers/sessions/${SESSION_ID}/stop`,
        headers: auth(),
      });
      expect(response.statusCode).toBe(504);
      expect(response.json()).toEqual({
        error: 'Station did not respond',
        code: 'STATION_TIMEOUT',
      });
      expect(sendOcppCommandAndWait).toHaveBeenCalledWith('CS-001', 'RequestStopTransaction', {
        transactionId: 'tx-9',
      });
    });
  });

  describe('GET /portal/reservations/:id', () => {
    const row = {
      id: RESERVATION_ID,
      reservationId: 12,
      stationOcppId: 'CS-001',
      siteName: 'Site A',
      siteAddress: '1 Main',
      siteCity: 'Austin',
      siteState: 'TX',
      evseDbId: 'evs_000000000001',
      status: 'active',
      startsAt: null,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    function get() {
      return app.inject({
        method: 'GET',
        url: `/portal/reservations/${RESERVATION_ID}`,
        headers: auth(),
      });
    }

    it('returns 404 RESERVATION_NOT_FOUND for a reservation of another driver', async () => {
      setupDbResults([]);
      const response = await get();
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: 'Reservation not found',
        code: 'RESERVATION_NOT_FOUND',
      });
    });

    it('resolves the EVSE number and links no session to an active reservation', async () => {
      setupDbResults([row], [{ evseId: 3 }]);
      const response = await get();
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        id: RESERVATION_ID,
        reservationId: 12,
        evseId: 3,
        status: 'active',
        sessionId: null,
      });
      expect(db.select).toHaveBeenCalledTimes(2);
    });

    it('links the latest session of a used station-wide reservation', async () => {
      setupDbResults([{ ...row, evseDbId: null, status: 'used' }], [{ id: SESSION_ID }]);
      const response = await get();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        evseId: null,
        status: 'used',
        sessionId: SESSION_ID,
      });
    });

    it('answers a null session when a used reservation has none and the EVSE is gone', async () => {
      setupDbResults([{ ...row, status: 'used' }], [], []);
      const response = await get();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ evseId: null, sessionId: null });
    });
  });

  describe('POST /portal/reservations', () => {
    const inMs = (ms: number): string => new Date(Date.now() + ms).toISOString();

    function create(payload: Record<string, unknown>) {
      return app.inject({
        method: 'POST',
        url: '/portal/reservations',
        headers: auth(),
        payload: { stationId: 'CS-001', ...payload },
      });
    }

    it('returns 403 STATION_PENDING for a station awaiting approval', async () => {
      setupDbResults([{ ...RESERVATION_STATION, onboardingStatus: 'pending' }]);
      const response = await create({ expiresAt: inMs(3_600_000) });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('STATION_PENDING');
      expect(assertNoMaintenanceConflict).not.toHaveBeenCalled();
    });

    it('returns 409 with the maintenance details when the window overlaps maintenance', async () => {
      setupDbResults([RESERVATION_STATION]);
      // The module mock's error class takes a message, like Error.
      const MockConflictError = MaintenanceConflictError as unknown as new (
        message: string,
      ) => Error;
      const conflict = new MockConflictError('Reservation overlaps maintenance');
      (conflict as unknown as { details: Record<string, unknown> }).details = {
        maintenanceId: 'mnt_1',
      };
      vi.mocked(assertNoMaintenanceConflict).mockRejectedValueOnce(conflict);
      const response = await create({ expiresAt: inMs(3_600_000) });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: 'Reservation overlaps maintenance',
        code: 'RESERVATION_DURING_MAINTENANCE',
        maintenanceId: 'mnt_1',
      });
    });

    it('answers 500 when the maintenance check fails for another reason', async () => {
      setupDbResults([RESERVATION_STATION]);
      vi.mocked(assertNoMaintenanceConflict).mockRejectedValueOnce(new Error('db down'));
      const response = await create({ expiresAt: inMs(3_600_000) });
      expect(response.statusCode).toBe(500);
      expect(insertValues()).toEqual([]);
    });

    it('returns 400 RESERVATION_WINDOW_TOO_SHORT for a window under a minute', async () => {
      setupDbResults([RESERVATION_STATION]);
      const response = await create({ expiresAt: inMs(30_000) });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('RESERVATION_WINDOW_TOO_SHORT');
    });

    it('returns 400 RESERVATION_STARTS_IN_PAST for a start beyond the slack', async () => {
      setupDbResults([RESERVATION_STATION]);
      const response = await create({ startsAt: inMs(-600_000), expiresAt: inMs(3_600_000) });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('RESERVATION_STARTS_IN_PAST');
    });

    it('returns 400 RESERVATION_EXPIRES_TOO_SOON when the end is under a minute away', async () => {
      setupDbResults([RESERVATION_STATION]);
      const response = await create({ startsAt: inMs(-45_000), expiresAt: inMs(30_000) });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('RESERVATION_EXPIRES_TOO_SOON');
    });

    it('returns 400 RESERVATION_TOO_LONG over the configured maximum', async () => {
      vi.mocked(getReservationSettings).mockResolvedValue({
        ...RESERVATION_SETTINGS,
        maxHours: 1,
      });
      setupDbResults([RESERVATION_STATION]);
      const response = await create({ expiresAt: inMs(2 * 3_600_000) });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Reservation cannot exceed 1 hours',
        code: 'RESERVATION_TOO_LONG',
      });
    });

    it('returns 404 EVSE_NOT_FOUND for an unknown EVSE', async () => {
      setupDbResults([RESERVATION_STATION], [{ id: 1 }], []);
      const response = await create({ evseId: 9, expiresAt: inMs(3_600_000) });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
    });

    it('returns 409 EVSE_IN_USE when the EVSE is charging inside the check window', async () => {
      vi.mocked(getReservationSettings).mockResolvedValue({
        ...RESERVATION_SETTINGS,
        activeSessionCheckHours: 3,
      });
      setupDbResults(
        [RESERVATION_STATION],
        [{ id: 1 }],
        [{ id: 'evs_000000000001' }],
        [{ id: SESSION_ID }],
      );
      const response = await create({ evseId: 1, expiresAt: inMs(3_600_000) });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: 'EVSE has an active charging session that conflicts with this reservation',
        code: 'EVSE_IN_USE',
      });
    });

    it('returns 409 EVSE_IN_USE for a station-wide reservation on a charging station', async () => {
      vi.mocked(getReservationSettings).mockResolvedValue({
        ...RESERVATION_SETTINGS,
        activeSessionCheckHours: 3,
      });
      setupDbResults([RESERVATION_STATION], [{ id: 1 }], [{ id: SESSION_ID }]);
      const response = await create({ expiresAt: inMs(3_600_000) });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe(
        'Station has an active charging session that conflicts with this reservation',
      );
    });

    it('returns 409 RESERVATION_CONFLICT when the window overlaps another reservation', async () => {
      setupDbResults([RESERVATION_STATION], [{ id: 1 }], [{ id: 'rsv_000000000002' }]);
      const response = await create({ expiresAt: inMs(3_600_000) });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: 'An active reservation already exists for this station',
        code: 'RESERVATION_CONFLICT',
      });
      expect(insertValues()).toEqual([]);
    });

    it('creates the reservation without a token when the token lookup fails', async () => {
      setupDbResults([RESERVATION_STATION], [{ id: 1 }], [], [CREATED_RESERVATION]);
      const realSelect = vi.mocked(db.select).getMockImplementation();
      let calls = 0;
      vi.mocked(db.select).mockImplementation(((...args: unknown[]) => {
        calls++;
        if (calls === 4) throw new Error('token lookup failed');
        return (realSelect as (...a: unknown[]) => unknown)(...args);
      }) as never);
      try {
        const response = await create({ expiresAt: inMs(3_600_000) });
        expect(response.statusCode).toBe(200);
        expect(insertValues()).toEqual([
          expect.objectContaining({ tokenId: null, driverId: DRIVER_ID, status: 'active' }),
        ]);
      } finally {
        vi.mocked(db.select).mockImplementation(realSelect as never);
      }
    });

    it('answers 500 RESERVATION_CREATE_FAILED when the insert returns no row', async () => {
      setupDbResults([RESERVATION_STATION], [{ id: 1 }], [], [], []);
      const response = await create({ expiresAt: inMs(3_600_000) });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: 'Failed to create reservation',
        code: 'RESERVATION_CREATE_FAILED',
      });
      expect(writeReservationAudit).not.toHaveBeenCalled();
      expect(publishedOn('ocpp_commands')).toEqual([]);
    });

    it('schedules a future reservation through the worker instead of sending ReserveNow', async () => {
      setupDbResults(
        [{ ...RESERVATION_STATION, isOnline: false }],
        [{ id: 1 }],
        [],
        [{ id: 'tkn_000000000001' }],
        [{ ...CREATED_RESERVATION, status: 'scheduled', tokenId: 'tkn_000000000001' }],
      );
      const response = await create({
        startsAt: inMs(2 * 3_600_000),
        expiresAt: inMs(3 * 3_600_000),
      });
      expect(response.statusCode).toBe(200);
      expect(insertValues()).toEqual([
        expect.objectContaining({ status: 'scheduled', tokenId: 'tkn_000000000001' }),
      ]);
      const scheduled = publishedOn('reservation_schedule');
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]?.['reservationDbId']).toBe(RESERVATION_ID);
      expect(scheduled[0]?.['delayMs']).toBeGreaterThan(2 * 3_600_000 - 60_000);
      expect(scheduled[0]?.['delayMs']).toBeLessThanOrEqual(2 * 3_600_000);
      expect(publishedOn('ocpp_commands')).toEqual([]);
    });

    it('sends ReserveNow with the EVSE for an EVSE reservation starting now', async () => {
      setupDbResults(
        [RESERVATION_STATION],
        [{ id: 1 }],
        [{ id: 'evs_000000000002' }],
        [],
        [],
        [{ ...CREATED_RESERVATION, evseId: 'evs_000000000002' }],
      );
      const expiresAt = inMs(3_600_000);
      const response = await create({ evseId: 2, expiresAt });
      expect(response.statusCode).toBe(200);
      expect(insertValues()).toEqual([expect.objectContaining({ evseId: 'evs_000000000002' })]);
      const commands = publishedOn('ocpp_commands');
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        stationId: 'CS-001',
        action: 'ReserveNow',
        payload: { evseId: 2, expiryDateTime: expiresAt, idToken: { idToken: DRIVER_ID } },
      });
      // The notification formats the ISO timestamp in the driver's language and time zone.
      expect(mockDispatchDriverNotification).toHaveBeenCalledWith(
        expect.anything(),
        'reservation.Created',
        DRIVER_ID,
        expect.objectContaining({ expiresAt }),
        [],
        expect.anything(),
      );
    });
  });
});
