// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
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

const { mockRecordSessionEndRequest, mockAvailableEvseCountSql, mockSqlRaw } = vi.hoisted(() => ({
  mockRecordSessionEndRequest: vi.fn().mockResolvedValue(true),
  mockAvailableEvseCountSql: vi.fn((alias: string) => `AVAILABLE_EVSE_COUNT(${alias})`),
  mockSqlRaw: vi.fn((text: string) => ({ raw: text })),
}));

vi.mock('@evtivity/database', async () => ({
  SESSION_END_REQUEST_CHANNEL: 'session_end_requests',
  recordSessionEndRequest: mockRecordSessionEndRequest,
  availableEvseCountSql: mockAvailableEvseCountSql,
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
  checkFleetCreditLimit: vi.fn().mockResolvedValue(null),
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
  sql: Object.assign(vi.fn(), { raw: mockSqlRaw }),
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
  mockDispatchFleetCreditLimitNotices,
  mockScheduleRemoteStartTimeout,
} = vi.hoisted(() => ({
  mockActivePaymentProvider: vi.fn(),
  mockAuthorizeSessionHold: vi.fn(),
  mockCancelOpenSessionHold: vi.fn(),
  mockDispatchFleetCreditLimitNotices: vi.fn(),
  mockScheduleRemoteStartTimeout: vi.fn(),
}));

vi.mock('@evtivity/payments', () => ({
  authorizeSessionHold: mockAuthorizeSessionHold,
  cancelOpenSessionHold: mockCancelOpenSessionHold,
  dispatchFleetCreditLimitNotices: mockDispatchFleetCreditLimitNotices,
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

vi.mock('@evtivity/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/lib')>();
  return {
    ...actual,
    dispatchDriverNotification: vi.fn(),
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
    details = {};
  },
}));

import { registerAuth } from '../plugins/auth.js';
import { portalChargerRoutes } from '../routes/portal/charger.js';
import {
  db,
  resolveStationTariff,
  isStationChargingFree,
  resolveAccountBilling,
  checkFleetCreditLimit,
} from '@evtivity/database';
import { sendOcppCommandAndWait } from '@evtivity/services/ocpp-command';
import { isEvseInReservationBuffer } from '../lib/reservation-buffer.js';
import { getActiveMaintenanceForStation } from '@evtivity/services/maintenance.service';
import { assertNoMaintenanceConflict } from '@evtivity/services/maintenance-check';
import * as ocppCommandModule from '@evtivity/services/ocpp-command';
import * as databaseModule from '@evtivity/database';

const VALID_STATION_ID = 'sta_000000000001';
const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';
const VALID_SESSION_ID = 'ses_000000000001';
const VALID_RESERVATION_ID = 'rsv_000000000001';
const DRIVER_ID = 'drv_000000000001';

/** An active payment provider: only its presence matters to these routes. */
const STRIPE_PROVIDER = { id: 'stripe' };

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalChargerRoutes);
  await app.ready();
  return app;
}

describe('Portal charger routes - handler logic', () => {
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
    vi.mocked(resolveStationTariff).mockResolvedValue(null);
    vi.mocked(isStationChargingFree).mockResolvedValue(true);
    vi.mocked(resolveAccountBilling).mockResolvedValue(null);
    vi.mocked(checkFleetCreditLimit).mockResolvedValue(null);
    mockDispatchFleetCreditLimitNotices.mockResolvedValue(null);
    vi.mocked(isEvseInReservationBuffer).mockResolvedValue(false);
    vi.mocked(getActiveMaintenanceForStation).mockResolvedValue(null);
    vi.mocked(assertNoMaintenanceConflict).mockResolvedValue(undefined);
  });

  describe('GET /v1/portal/chargers/:stationId/evse/:evseId', () => {
    it('returns 404 when station is not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/CS-001/evse/1',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 404 when EVSE is not found', async () => {
      setupDbResults(
        [
          {
            id: VALID_STATION_ID,
            stationId: 'CS-001',
            siteId: null,
            model: 'M1',
            isOnline: true,
            siteName: null,
            siteAddress: null,
            siteCity: null,
            siteState: null,
          },
        ],
        [],
      );
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/CS-001/evse/1',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('EVSE_NOT_FOUND');
    });

    it('returns charger info with paymentEnabled false when no payment provider is active', async () => {
      setupDbResults(
        [
          {
            id: VALID_STATION_ID,
            stationId: 'CS-001',
            siteId: null,
            model: 'M1',
            isOnline: true,
            siteName: 'Site A',
            siteAddress: '123 Main',
            siteCity: 'City',
            siteState: 'CA',
          },
        ],
        [{ id: 'evs_000000000001', evseId: 1, status: 'available' }],
        [
          {
            connectorId: 1,
            connectorType: 'CCS2',
            maxPowerKw: '150',
            maxCurrentAmps: null,
            status: 'available',
          },
        ],
      );
      mockActivePaymentProvider.mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/CS-001/evse/1',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.stationId).toBe('CS-001');
      expect(body.paymentEnabled).toBe(false);
      expect(body.evse.evseId).toBe(1);
      expect(body.evse.connectors).toHaveLength(1);
    });

    it('returns paymentEnabled true when a payment provider is active', async () => {
      setupDbResults(
        [
          {
            id: VALID_STATION_ID,
            stationId: 'CS-001',
            siteId: 'site-1',
            model: 'M1',
            isOnline: true,
            siteName: 'Site A',
            siteAddress: '123 Main',
            siteCity: 'City',
            siteState: 'CA',
          },
        ],
        [{ id: 'evs_000000000001', evseId: 1, status: 'available' }],
        [],
      );
      mockActivePaymentProvider.mockResolvedValue(STRIPE_PROVIDER);

      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/CS-001/evse/1',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().paymentEnabled).toBe(true);
    });
  });

  describe('GET /v1/portal/chargers/:stationId', () => {
    const stationRow = {
      id: VALID_STATION_ID,
      stationId: 'CS-001',
      siteId: 'site-1',
      model: 'M1',
      isOnline: true,
      isSimulator: false,
      siteName: 'Site A',
      siteAddress: '123 Main',
      siteCity: 'City',
      siteState: 'CA',
      siteContactIsPublic: false,
    };

    it.each([
      [null, false],
      [STRIPE_PROVIDER, true],
    ])('reports paymentEnabled from the active provider (%o -> %s)', async (provider, enabled) => {
      setupDbResults([stationRow], []);
      mockActivePaymentProvider.mockResolvedValue(provider);

      const response = await app.inject({ method: 'GET', url: '/portal/chargers/CS-001' });

      expect(response.statusCode).toBe(200);
      expect(response.json().paymentEnabled).toBe(enabled);
      expect(mockActivePaymentProvider).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /v1/portal/chargers/:stationId/pricing', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/CS-001/pricing',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when station is not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/CS-001/pricing',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 404 when no tariff found', async () => {
      setupDbResults([{ id: VALID_STATION_ID }]);
      vi.mocked(resolveStationTariff).mockResolvedValue(null);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/CS-001/pricing',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('PRICING_NOT_FOUND');
    });

    it('returns resolved pricing for driver in the company currency', async () => {
      setupDbResults([{ id: VALID_STATION_ID }]);
      vi.mocked(resolveStationTariff).mockResolvedValue({
        id: 'tar_001',
        name: 'Standard',
        pricePerKwh: '0.25',
        pricePerMinute: '0.10',
        pricePerSession: '2.00',
        idleFeePricePerMinute: '0.05',
        reservationFeePerMinute: null,
        taxRate: '0.08',
        restrictions: null,
        priority: 0,
        isDefault: true,
        pricingGroup: { id: 'pgr_1', name: 'Group', source: 'station' },
        timezone: null,
      });
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/CS-001/pricing',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.currency).toBe('EUR');
      expect(body.pricePerKwh).toBe('0.25');
      expect(body.pricePerMinute).toBe('0.10');
      expect(body.pricePerSession).toBe('2.00');
      expect(body.idleFeePricePerMinute).toBe('0.05');
      expect(body.taxRate).toBe('0.08');
      expect(body.taxBasis).toBe('net');
      expect(body.billing).toEqual({ mode: 'card', fleetName: null });
    });

    it('tells an account driver the session is billed to the fleet', async () => {
      setupDbResults([{ id: VALID_STATION_ID }]);
      vi.mocked(resolveStationTariff).mockResolvedValue({
        id: 'tar_001',
        name: 'Standard',
        pricePerKwh: '0.25',
        pricePerMinute: null,
        pricePerSession: null,
        idleFeePricePerMinute: null,
        reservationFeePerMinute: null,
        taxRate: null,
        restrictions: null,
        priority: 0,
        isDefault: true,
        pricingGroup: { id: 'pgr_1', name: 'Group', source: 'station' },
        timezone: null,
      });
      vi.mocked(resolveAccountBilling).mockResolvedValue({ fleetId: 'flt_1', fleetName: 'Acme' });
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/CS-001/pricing',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().billing).toEqual({ mode: 'account', fleetName: 'Acme' });
      expect(resolveAccountBilling).toHaveBeenCalledWith(expect.anything(), DRIVER_ID);
    });

    it('resolves the tariff for the station UUID and driver ID', async () => {
      setupDbResults([{ id: VALID_STATION_ID }]);
      vi.mocked(resolveStationTariff).mockResolvedValue({
        id: 'tar_001',
        name: 'Driver Rate',
        pricePerKwh: '0.30',
        pricePerMinute: null,
        pricePerSession: null,
        idleFeePricePerMinute: null,
        reservationFeePerMinute: null,
        taxRate: null,
        restrictions: null,
        priority: 0,
        isDefault: false,
        pricingGroup: { id: 'pgr_1', name: 'Group', source: 'station' },
        timezone: null,
      });
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/CS-001/pricing',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(resolveStationTariff).toHaveBeenCalledWith(
        { stationUuid: VALID_STATION_ID, driverUuid: DRIVER_ID },
        expect.anything(),
      );
    });
  });

  describe('GET /v1/portal/chargers/search', () => {
    it('returns search results', async () => {
      setupDbResults(
        [
          {
            stationId: 'CS-001',
            stationUuid: 'uuid-001',
            model: 'M1',
            isOnline: true,
            siteName: 'Site A',
            siteAddress: '500 Congress Ave',
            siteCity: 'Austin',
            evseCount: 2,
            availableCount: 1,
          },
          {
            stationId: 'CS-002',
            stationUuid: 'uuid-002',
            model: 'M2',
            isOnline: false,
            siteName: 'Site B',
            siteAddress: null,
            siteCity: null,
            evseCount: 1,
            availableCount: 0,
          },
        ],
        [], // connector rows
      );
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/search?q=CS',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(2);
      expect(body[0].stationId).toBe('CS-001');
      expect(body[0].availableCount).toBe(1);
      expect(body[0].siteAddress).toBe('500 Congress Ave');
      expect(body[0].siteCity).toBe('Austin');
      expect(body[0].connectors).toEqual([]);
    });

    it('returns 400 when q parameter is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/search',
      });
      expect(response.statusCode).toBe(400);
    });

    // An operator-disabled station whose connectors still report Available was
    // counted as "3/3 available". The count must come from the shared rule.
    it('counts available EVSEs with the shared driver availability rule', async () => {
      setupDbResults([], []);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/search?q=CS',
      });
      expect(response.statusCode).toBe(200);
      expect(mockAvailableEvseCountSql).toHaveBeenCalledWith('charging_stations');
      expect(mockSqlRaw).toHaveBeenCalledWith('AVAILABLE_EVSE_COUNT(charging_stations)');
    });
  });

  describe('GET /v1/portal/chargers/nearby', () => {
    it('counts available EVSEs with the shared driver availability rule', async () => {
      setupDbResults(
        [
          {
            stationId: 'CS-001',
            stationUuid: 'uuid-001',
            model: 'M1',
            isOnline: true,
            siteName: 'Site A',
            siteAddress: null,
            siteCity: null,
            distanceKm: 1.23,
            evseCount: 3,
            availableCount: 0,
          },
        ],
        [],
      );
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/nearby?lat=30.2&lng=-97.7',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()[0].availableCount).toBe(0);
      expect(mockAvailableEvseCountSql).toHaveBeenCalledWith('charging_stations');
      expect(mockSqlRaw).toHaveBeenCalledWith('AVAILABLE_EVSE_COUNT(charging_stations)');
    });
  });

  describe('POST /v1/portal/chargers/:stationId/evse/:evseId/start', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 with operator token', async () => {
      const operatorToken = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(response.statusCode).toBe(403);
    });

    it('returns 404 when station not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 400 when station is offline', async () => {
      setupDbResults([
        {
          id: VALID_STATION_ID,
          stationId: 'CS-001',
          siteId: null,
          isOnline: false,
          onboardingStatus: 'accepted',
          ocppProtocol: 'ocpp2.1',
        },
      ]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('STATION_OFFLINE');
    });

    it('returns 404 when EVSE not found', async () => {
      setupDbResults(
        [
          {
            id: VALID_STATION_ID,
            stationId: 'CS-001',
            siteId: null,
            isOnline: true,
            onboardingStatus: 'accepted',
            ocppProtocol: 'ocpp2.1',
          },
        ],
        [],
      );
      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('EVSE_NOT_FOUND');
    });

    it.each([
      { disabledReason: 'operator', firmwareState: null, reportedStatus: null },
      { disabledReason: null, firmwareState: 'failed', reportedStatus: null },
      { disabledReason: null, firmwareState: null, reportedStatus: 'faulted' },
    ])('returns 409 STATION_UNAVAILABLE for a station-level state %o', async (state) => {
      setupDbResults([
        {
          id: VALID_STATION_ID,
          stationId: 'CS-001',
          siteId: null,
          isOnline: true,
          onboardingStatus: 'accepted',
          ocppProtocol: 'ocpp2.1',
          ...state,
        },
      ]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('STATION_UNAVAILABLE');
    });

    it('returns 400 when connector is not available', async () => {
      setupDbResults(
        [
          {
            id: VALID_STATION_ID,
            stationId: 'CS-001',
            siteId: null,
            isOnline: true,
            onboardingStatus: 'accepted',
            ocppProtocol: 'ocpp2.1',
          },
        ],
        [{ id: 'evs_000000000001' }],
        [{ status: 'faulted' }],
      );
      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('CONNECTOR_NOT_AVAILABLE');
    });

    it('returns 400 when payment is required but no paymentMethodId provided', async () => {
      vi.mocked(isStationChargingFree).mockResolvedValue(false);
      setupDbResults(
        [
          {
            id: VALID_STATION_ID,
            stationId: 'CS-001',
            siteId: 'site-1',
            isOnline: true,
            onboardingStatus: 'accepted',
            ocppProtocol: 'ocpp2.1',
          },
        ],
        [{ id: 'evs_000000000001' }],
        [{ status: 'available' }],
      );
      mockActivePaymentProvider.mockResolvedValue(STRIPE_PROVIDER);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('PAYMENT_METHOD_REQUIRED');
      // No reservation held by this driver: the reservation fee does not count.
      expect(vi.mocked(isStationChargingFree)).toHaveBeenCalledWith(
        { stationUuid: VALID_STATION_ID, driverUuid: DRIVER_ID, reserved: false, freeVend: false },
        expect.anything(),
      );
    });

    it('starts charging session without payment when no payment provider is active', async () => {
      setupDbResults(
        [
          {
            id: VALID_STATION_ID,
            stationId: 'CS-001',
            siteId: null,
            isOnline: true,
            onboardingStatus: 'accepted',
            ocppProtocol: 'ocpp2.1',
          },
        ],
        [{ id: 'evs_000000000001' }],
        [{ status: 'available' }],
        [], // active reservation gate (no reservation)
        [], // EVSE active-session check (defense-in-depth)
        [], // driver active-session check
        [{ id: VALID_SESSION_ID }],
      );
      mockActivePaymentProvider.mockResolvedValue(null);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().chargingSessionId).toBe(VALID_SESSION_ID);
      expect(isStationChargingFree).not.toHaveBeenCalled();
      expect(mockAuthorizeSessionHold).not.toHaveBeenCalled();
    });

    describe('OCPP 1.6 transaction id', () => {
      const station16 = {
        id: VALID_STATION_ID,
        stationId: 'CS-016',
        siteId: null,
        isOnline: true,
        onboardingStatus: 'accepted',
        ocppProtocol: 'ocpp1.6',
      };

      function setupStart16(): void {
        setupDbResults(
          [station16],
          [{ id: 'evs_000000000001' }],
          [{ status: 'available' }],
          [], // active reservation gate
          [], // EVSE active-session check
          [], // driver active-session check
          [{ id: VALID_SESSION_ID }],
        );
      }

      function insertedValues(): unknown[] {
        return vi
          .mocked(db.insert)
          .mock.results.flatMap(
            (res) =>
              (res.value as { values: ReturnType<typeof vi.fn> }).values.mock.calls as unknown[][],
          )
          .map(([values]) => values);
      }

      async function start16() {
        return app.inject({
          method: 'POST',
          url: '/portal/chargers/CS-016/evse/1/start',
          headers: { authorization: `Bearer ${driverToken}` },
          payload: {},
        });
      }

      it('stamps the session with the next value of the 1.6 sequence', async () => {
        vi.mocked(db.insert).mockClear();
        setupStart16();

        const response = await start16();

        expect(response.statusCode).toBe(200);
        expect(insertedValues()).toContainEqual(expect.objectContaining({ transactionId: '42' }));
      });

      it('answers 500 SESSION_CREATE_FAILED and creates nothing when the sequence read fails', async () => {
        vi.mocked(db.insert).mockClear();
        vi.mocked(db.execute).mockRejectedValueOnce(new Error('db down'));
        setupStart16();

        const response = await start16();

        expect(response.statusCode).toBe(500);
        expect(response.json().code).toBe('SESSION_CREATE_FAILED');
        expect(db.insert).not.toHaveBeenCalled();
        expect(mockAuthorizeSessionHold).not.toHaveBeenCalled();
      });

      it('answers 500 SESSION_CREATE_FAILED when the sequence returns no row', async () => {
        vi.mocked(db.insert).mockClear();
        vi.mocked(db.execute).mockResolvedValueOnce([] as never);
        setupStart16();

        const response = await start16();

        expect(response.statusCode).toBe(500);
        expect(response.json().code).toBe('SESSION_CREATE_FAILED');
        expect(db.insert).not.toHaveBeenCalled();
      });
    });
  });

  describe('POST /v1/portal/chargers/:stationId/evse/:evseId/start - pre-authorization', () => {
    const stationRow = {
      id: VALID_STATION_ID,
      stationId: 'CS-001',
      siteId: 'sit_000000000001',
      isOnline: true,
      onboardingStatus: 'accepted',
      ocppProtocol: 'ocpp2.1',
    };

    /** Station, EVSE, connector, the three empty gate checks, then the given rows. */
    function setupStartRows(...rest: unknown[][]): void {
      setupDbResults(
        [stationRow],
        [{ id: 'evs_000000000001' }],
        [{ status: 'available' }],
        [], // active reservation gate
        [], // EVSE active-session check
        [], // driver active-session check
        ...rest,
      );
    }

    async function startWithCard() {
      return app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { paymentMethodId: 7 },
      });
    }

    function sessionUpdateSets(): unknown[] {
      return vi
        .mocked(db.update)
        .mock.results.flatMap(
          (res) => (res.value as { set: ReturnType<typeof vi.fn> }).set.mock.calls as unknown[][],
        )
        .map(([values]) => values);
    }

    beforeEach(() => {
      mockActivePaymentProvider.mockResolvedValue(STRIPE_PROVIDER);
      vi.mocked(isStationChargingFree).mockResolvedValue(false);
    });

    function sessionInsertValues(): Array<Record<string, unknown>> {
      return vi
        .mocked(db.insert)
        .mock.results.flatMap(
          (res) =>
            (res.value as { values: ReturnType<typeof vi.fn> }).values.mock.calls as unknown[][],
        )
        .map(([values]) => values as Record<string, unknown>);
    }

    it('starts an account driver without a payment method or a hold, stamped account', async () => {
      vi.mocked(resolveAccountBilling).mockResolvedValue({ fleetId: 'flt_1', fleetName: 'Acme' });
      vi.mocked(db.insert).mockClear();
      setupStartRows([{ id: VALID_SESSION_ID }]);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().chargingSessionId).toBe(VALID_SESSION_ID);
      expect(resolveAccountBilling).toHaveBeenCalledWith(expect.anything(), DRIVER_ID);
      expect(isStationChargingFree).not.toHaveBeenCalled();
      expect(mockAuthorizeSessionHold).not.toHaveBeenCalled();
      expect(sessionInsertValues()[0]).toMatchObject({
        billingMode: 'account',
        billingFleetId: 'flt_1',
      });
    });

    function creditCheck(
      level: 'ok' | 'warning' | 'reached',
      totalCents: number,
      remainingCents = Math.max(10_000 - totalCents, 0),
    ) {
      return {
        fleetId: 'flt_1',
        fleetName: 'Acme',
        limitCents: 10_000,
        warningPercent: 80,
        exposure: {
          unbilledCents: totalCents,
          invoicedCents: 0,
          runningCents: 0,
          totalCents,
          currency: 'USD',
        },
        level,
        remainingCents,
        ceilingCents: null,
      };
    }

    it('refuses an account start at the fleet credit limit with 402 and creates no session', async () => {
      vi.mocked(resolveAccountBilling).mockResolvedValue({ fleetId: 'flt_1', fleetName: 'Acme' });
      const check = creditCheck('reached', 10_000);
      vi.mocked(checkFleetCreditLimit).mockResolvedValue(check);
      vi.mocked(db.insert).mockClear();
      setupStartRows([{ id: VALID_SESSION_ID }]);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });

      expect(response.statusCode).toBe(402);
      expect(response.json().code).toBe('FLEET_CREDIT_LIMIT_REACHED');
      expect(checkFleetCreditLimit).toHaveBeenCalledWith(expect.anything(), 'flt_1');
      expect(mockDispatchFleetCreditLimitNotices).toHaveBeenCalledWith(
        check,
        expect.objectContaining({ templatesDirs: expect.any(Array) as unknown[] }),
        expect.anything(),
      );
      expect(sessionInsertValues()).toHaveLength(0);
      expect(sendOcppCommandAndWait).not.toHaveBeenCalled();
    });

    it('refuses an account start when running sessions reserve the rest of the limit (plan S8)', async () => {
      vi.mocked(resolveAccountBilling).mockResolvedValue({ fleetId: 'flt_1', fleetName: 'Acme' });
      vi.mocked(checkFleetCreditLimit).mockResolvedValue(creditCheck('ok', 2000, 0));
      vi.mocked(db.insert).mockClear();
      setupStartRows([{ id: VALID_SESSION_ID }]);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });

      expect(response.statusCode).toBe(402);
      expect(response.json().code).toBe('FLEET_CREDIT_LIMIT_REACHED');
      expect(sessionInsertValues()).toHaveLength(0);
    });

    it('starts an account driver at the warning percent and notifies the fleet', async () => {
      vi.mocked(resolveAccountBilling).mockResolvedValue({ fleetId: 'flt_1', fleetName: 'Acme' });
      vi.mocked(checkFleetCreditLimit).mockResolvedValue(creditCheck('warning', 8500));
      setupStartRows([{ id: VALID_SESSION_ID }]);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(mockDispatchFleetCreditLimitNotices).toHaveBeenCalledTimes(1);
    });

    it('checks no credit limit for a card driver', async () => {
      setupStartRows([{ id: VALID_SESSION_ID }]);
      await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });
      expect(checkFleetCreditLimit).not.toHaveBeenCalled();
    });

    it('starts an account driver when no payment provider is active', async () => {
      mockActivePaymentProvider.mockResolvedValue(null);
      vi.mocked(resolveAccountBilling).mockResolvedValue({ fleetId: 'flt_1', fleetName: 'Acme' });
      setupStartRows([{ id: VALID_SESSION_ID }]);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(mockAuthorizeSessionHold).not.toHaveBeenCalled();
    });

    it('stamps a card driver card and places the hold', async () => {
      vi.mocked(db.insert).mockClear();
      setupStartRows([{ id: 7 }], [{ id: VALID_SESSION_ID }]);
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'authorized',
        paymentRecordId: 3,
        paymentId: 'pi_test_123',
      });

      const response = await startWithCard();

      expect(response.statusCode).toBe(200);
      expect(mockAuthorizeSessionHold).toHaveBeenCalledTimes(1);
      expect(sessionInsertValues()[0]).toMatchObject({ billingMode: 'card', billingFleetId: null });
    });

    it('returns 404 when the payment method is not the driver', async () => {
      setupStartRows([]); // payment method lookup

      const response = await startWithCard();

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('PAYMENT_METHOD_NOT_FOUND');
      expect(mockAuthorizeSessionHold).not.toHaveBeenCalled();
    });

    it('places the hold for the new session before starting the station', async () => {
      setupStartRows([{ id: 7 }], [{ id: VALID_SESSION_ID }]);
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'authorized',
        paymentRecordId: 3,
        paymentId: 'pi_test_123',
      });

      const response = await startWithCard();

      expect(response.statusCode).toBe(200);
      expect(response.json().chargingSessionId).toBe(VALID_SESSION_ID);
      expect(mockAuthorizeSessionHold).toHaveBeenCalledWith(
        {
          sessionId: VALID_SESSION_ID,
          driverId: DRIVER_ID,
          methodRowId: 7,
          siteId: 'sit_000000000001',
          trigger: 'portal_start',
        },
        { registry: 'registry', logger: expect.anything() },
      );
      expect(sendOcppCommandAndWait).toHaveBeenCalledWith(
        'CS-001',
        'RequestStartTransaction',
        expect.objectContaining({ evseId: 1 }),
      );
      // The accepted start is closed by the worker if no transaction follows.
      expect(mockScheduleRemoteStartTimeout).toHaveBeenCalledWith(
        { kind: 'session', sessionId: VALID_SESSION_ID },
        expect.objectContaining({ id: stationRow.id }),
        expect.anything(),
      );
      expect(mockCancelOpenSessionHold).not.toHaveBeenCalled();
    });

    it('cancels the hold and schedules nothing when the station rejects the start', async () => {
      setupStartRows([{ id: 7 }], [{ id: VALID_SESSION_ID }]);
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'authorized',
        paymentRecordId: 3,
        paymentId: 'pi_test_123',
      });
      mockCancelOpenSessionHold.mockResolvedValueOnce({ status: 'cancelled', paymentRecordId: 3 });
      vi.mocked(sendOcppCommandAndWait).mockResolvedValueOnce({
        response: { status: 'Rejected' },
        error: null,
      } as never);

      const response = await startWithCard();

      expect(response.statusCode).toBe(502);
      expect(response.json().code).toBe('START_REJECTED');
      expect(sessionUpdateSets()).toContainEqual(expect.objectContaining({ status: 'faulted' }));
      expect(mockCancelOpenSessionHold).toHaveBeenCalledWith(
        VALID_SESSION_ID,
        'Station rejected the start: Rejected',
        { registry: 'registry', logger: expect.anything() },
      );
      expect(mockScheduleRemoteStartTimeout).not.toHaveBeenCalled();
    });

    it('still answers the rejection when the hold cancel fails (fail-open)', async () => {
      setupStartRows([{ id: 7 }], [{ id: VALID_SESSION_ID }]);
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'authorized',
        paymentRecordId: 3,
        paymentId: 'pi_test_123',
      });
      mockCancelOpenSessionHold.mockRejectedValueOnce(new Error('provider down'));
      vi.mocked(sendOcppCommandAndWait).mockResolvedValueOnce({
        response: { status: 'Rejected' },
        error: null,
      } as never);

      const response = await startWithCard();

      expect(response.statusCode).toBe(502);
      expect(response.json().code).toBe('START_REJECTED');
    });

    it('returns 402 and fails the session without starting the station when the card is declined', async () => {
      setupStartRows([{ id: 7 }], [{ id: VALID_SESSION_ID }]);
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'declined',
        reason: 'Your card was declined.',
        paymentRecordId: 3,
        failure: 'declined',
      });

      const response = await startWithCard();

      expect(response.statusCode).toBe(402);
      expect(response.json()).toEqual({
        error: 'Payment authorization declined: Your card was declined.',
        code: 'PAYMENT_PREAUTH_FAILED',
      });
      expect(sessionUpdateSets()).toContainEqual(
        expect.objectContaining({ status: 'failed', stoppedReason: 'PreAuthDeclined' }),
      );
      expect(sendOcppCommandAndWait).not.toHaveBeenCalled();
    });

    describe('a cable-first transaction waiting for its authorization (F01)', () => {
      const WAITING_ID = 'ses_waiting00001';

      /** The EVSE has the station's waiting session, which this start takes over. */
      function setupTakeoverRows(...rest: unknown[][]): void {
        setupDbResults(
          [stationRow],
          [{ id: 'evs_000000000001' }],
          [{ status: 'ev_connected' }],
          [], // active reservation gate
          [{ id: WAITING_ID }], // EVSE active-session check
          [{ id: WAITING_ID }], // the session waits for its authorization
          [], // driver active-session check
          ...rest,
        );
      }

      function stopCommands(): unknown[] {
        return mockPublish.mock.calls
          .filter(([channel]) => channel === 'ocpp_commands')
          .map(([, message]) => JSON.parse(message as string) as Record<string, unknown>)
          .filter((command) => command['action'] === 'RequestStopTransaction');
      }

      it('takes over the waiting session: driver, remote start id, hold on it', async () => {
        setupTakeoverRows([{ id: 7 }], [{ id: WAITING_ID, transactionId: 'tx-station' }]);
        mockAuthorizeSessionHold.mockResolvedValueOnce({
          outcome: 'authorized',
          paymentRecordId: 3,
          paymentId: 'pi_test_123',
        });

        const response = await startWithCard();

        expect(response.statusCode).toBe(200);
        expect(response.json().chargingSessionId).toBe(WAITING_ID);
        expect(sessionInsertValues()).toHaveLength(0);
        const takeover = sessionUpdateSets()[0] as Record<string, unknown>;
        expect(takeover).toMatchObject({ driverId: DRIVER_ID, billingMode: 'card' });
        expect(typeof takeover['remoteStartId']).toBe('number');
        expect(mockAuthorizeSessionHold).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: WAITING_ID, methodRowId: 7 }),
          expect.anything(),
        );
        expect(sendOcppCommandAndWait).toHaveBeenCalledWith(
          'CS-001',
          'RequestStartTransaction',
          expect.objectContaining({ remoteStartId: takeover['remoteStartId'] }),
        );
        expect(stopCommands()).toHaveLength(0);
      });

      it('answers EVSE_IN_USE when the session stopped waiting before the takeover', async () => {
        setupTakeoverRows([{ id: 7 }], []);

        const response = await startWithCard();

        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('EVSE_IN_USE');
        expect(mockAuthorizeSessionHold).not.toHaveBeenCalled();
        expect(sendOcppCommandAndWait).not.toHaveBeenCalled();
      });

      it('answers EVSE_IN_USE for an active session that does not wait', async () => {
        setupDbResults(
          [stationRow],
          [{ id: 'evs_000000000001' }],
          [{ status: 'ev_connected' }],
          [],
          [{ id: WAITING_ID }],
          [], // not waiting: a driver, token or idToken already
        );

        const response = await startWithCard();

        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('EVSE_IN_USE');
      });

      it('fails the taken-over session and stops its transaction when the card is declined', async () => {
        setupTakeoverRows([{ id: 7 }], [{ id: WAITING_ID, transactionId: 'tx-station' }]);
        mockAuthorizeSessionHold.mockResolvedValueOnce({
          outcome: 'declined',
          reason: 'Your card was declined.',
          paymentRecordId: 3,
          failure: 'declined',
        });

        const response = await startWithCard();

        expect(response.statusCode).toBe(402);
        expect(sessionUpdateSets()).toContainEqual(
          expect.objectContaining({ status: 'failed', stoppedReason: 'PreAuthDeclined' }),
        );
        expect(stopCommands()).toEqual([
          expect.objectContaining({
            stationId: 'CS-001',
            payload: { transactionId: 'tx-station' },
          }),
        ]);
        expect(sendOcppCommandAndWait).not.toHaveBeenCalled();
      });

      it('stops the taken-over transaction, not as a ghost, when the station rejects', async () => {
        setupTakeoverRows([{ id: 7 }], [{ id: WAITING_ID, transactionId: 'tx-station' }]);
        mockAuthorizeSessionHold.mockResolvedValueOnce({
          outcome: 'authorized',
          paymentRecordId: 3,
          paymentId: 'pi_test_123',
        });
        mockCancelOpenSessionHold.mockResolvedValueOnce({
          status: 'cancelled',
          paymentRecordId: 3,
        });
        vi.mocked(sendOcppCommandAndWait).mockResolvedValueOnce({
          response: {
            status: 'Rejected',
            statusInfo: { reasonCode: 'TxInProgress', additionalInfo: 'tx-station' },
          },
          error: null,
        } as never);

        const response = await startWithCard();

        expect(response.statusCode).toBe(502);
        // No ghost recovery: one RequestStartTransaction, no RequestStop wait.
        expect(sendOcppCommandAndWait).toHaveBeenCalledTimes(1);
        expect(sessionUpdateSets()).toContainEqual(expect.objectContaining({ status: 'faulted' }));
        expect(mockCancelOpenSessionHold).toHaveBeenCalledWith(
          WAITING_ID,
          expect.any(String),
          expect.anything(),
        );
        expect(stopCommands()).toHaveLength(1);
      });
    });

    it('returns 500 and fails the session when the hold could not be recorded', async () => {
      setupStartRows([{ id: 7 }], [{ id: VALID_SESSION_ID }]);
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'record_failed',
        reason: 'insert failed',
      });

      const response = await startWithCard();

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: 'Failed to record payment authorization',
        code: 'INTERNAL_ERROR',
      });
      expect(sessionUpdateSets()).toContainEqual(
        expect.objectContaining({ status: 'failed', stoppedReason: 'PreAuthRecordFailed' }),
      );
      expect(sendOcppCommandAndWait).not.toHaveBeenCalled();
    });

    it('starts the session without a hold when the card provider is not configured', async () => {
      setupStartRows([{ id: 7 }], [{ id: VALID_SESSION_ID }]);
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'not_configured',
        providerId: 'adyen',
      });

      const response = await startWithCard();

      expect(response.statusCode).toBe(200);
      expect(response.json().chargingSessionId).toBe(VALID_SESSION_ID);
      expect(sendOcppCommandAndWait).toHaveBeenCalled();
    });

    it('skips the hold when charging is free for the driver', async () => {
      vi.mocked(isStationChargingFree).mockResolvedValue(true);
      setupStartRows([{ id: VALID_SESSION_ID }]);

      const response = await startWithCard();

      expect(response.statusCode).toBe(200);
      expect(mockAuthorizeSessionHold).not.toHaveBeenCalled();
    });
  });

  describe('GET /v1/portal/chargers/sessions/active', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/sessions/active',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns active sessions for authenticated driver', async () => {
      setupDbResults([
        {
          id: 's1',
          stationId: 'CS-001',
          stationName: 'Lobby Fast Charger',
          transactionId: 'tx1',
          startedAt: '2024-01-01',
          energyDeliveredWh: 1000,
          currentCostCents: 500,
          currency: 'USD',
        },
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/sessions/active',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toHaveLength(1);
      expect(response.json().data[0].id).toBe('s1');
    });

    it('returns empty data array when no active sessions', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/sessions/active',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toHaveLength(0);
    });
  });

  describe('POST /v1/portal/chargers/sessions/:sessionId/stop', () => {
    it('returns 404 when session not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: `/portal/chargers/sessions/${VALID_SESSION_ID}/stop`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('SESSION_NOT_FOUND');
    });

    it('stops an active session', async () => {
      setupDbResults([{ id: VALID_SESSION_ID, transactionId: 'tx-123', stationOcppId: 'CS-001' }]);
      const response = await app.inject({
        method: 'POST',
        url: `/portal/chargers/sessions/${VALID_SESSION_ID}/stop`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('stopping');
      expect(response.json().chargingSessionId).toBe(VALID_SESSION_ID);
    });

    it('lets the OCPP server translate the stop for an OCPP 1.6 station', async () => {
      const { sendOcppCommandAndWait } = ocppCommandModule;
      const sendMock = vi.mocked(sendOcppCommandAndWait);
      sendMock.mockClear();
      setupDbResults([
        {
          id: VALID_SESSION_ID,
          transactionId: '4',
          stationOcppId: 'CS-016',
          ocppProtocol: 'ocpp1.6',
        },
      ]);

      const response = await app.inject({
        method: 'POST',
        url: `/portal/chargers/sessions/${VALID_SESSION_ID}/stop`,
        headers: { authorization: `Bearer ${driverToken}` },
      });

      expect(response.statusCode).toBe(200);
      // Without a version the command is translated to RemoteStopTransaction
      // with an integer transactionId; with it, a 1.6 station got the 2.1
      // RequestStopTransaction and answered CALLERROR.
      expect(sendMock).toHaveBeenCalledWith('CS-016', 'RequestStopTransaction', {
        transactionId: '4',
      });
      expect(sendMock.mock.calls[0]).toHaveLength(3);
    });

    it('ends a ghost session (TxNotFound) through the OCPP server, completed and billed', async () => {
      vi.mocked(sendOcppCommandAndWait).mockResolvedValueOnce({
        commandId: 'm',
        response: { status: 'Rejected', statusInfo: { reasonCode: 'TxNotFound' } },
      });
      mockRecordSessionEndRequest.mockClear();
      mockPublish.mockClear();
      const { db } = databaseModule;
      vi.mocked(db.execute).mockClear();
      setupDbResults([
        { id: VALID_SESSION_ID, transactionId: 'tx-ghost', stationOcppId: 'CS-001' },
      ]);

      const response = await app.inject({
        method: 'POST',
        url: `/portal/chargers/sessions/${VALID_SESSION_ID}/stop`,
        headers: { authorization: `Bearer ${driverToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: 'ghostRecovered',
        chargingSessionId: VALID_SESSION_ID,
      });
      // Recorded durably first (P4), then the OCPP server ends it the normal way.
      expect(mockRecordSessionEndRequest).toHaveBeenCalledWith(
        {},
        VALID_SESSION_ID,
        'GhostRecovered',
      );
      expect(mockPublish).toHaveBeenCalledWith(
        'session_end_requests',
        JSON.stringify({ sessionId: VALID_SESSION_ID, reason: 'GhostRecovered' }),
      );
      // The route never faults the session itself.
      expect(db.execute).not.toHaveBeenCalled();
    });

    it('publishes no end request when the ghost session ended meanwhile (P5)', async () => {
      vi.mocked(sendOcppCommandAndWait).mockResolvedValueOnce({
        commandId: 'm',
        response: { status: 'Rejected', statusInfo: { reasonCode: 'TxNotFound' } },
      });
      mockRecordSessionEndRequest.mockResolvedValueOnce(false);
      mockPublish.mockClear();
      setupDbResults([
        { id: VALID_SESSION_ID, transactionId: 'tx-ghost', stationOcppId: 'CS-001' },
      ]);

      const response = await app.inject({
        method: 'POST',
        url: `/portal/chargers/sessions/${VALID_SESSION_ID}/stop`,
        headers: { authorization: `Bearer ${driverToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(mockPublish).not.toHaveBeenCalledWith('session_end_requests', expect.anything());
    });
  });

  describe('GET /v1/portal/reservations', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/portal/reservations',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns reservations for authenticated driver', async () => {
      setupDbResults([
        {
          id: 'r1',
          reservationId: 1,
          stationOcppId: 'CS-001',
          status: 'active',
          startsAt: null,
          expiresAt: '2025-01-01',
          createdAt: '2024-12-01',
        },
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/reservations',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toHaveLength(1);
    });
  });

  describe('POST /v1/portal/reservations', () => {
    it('returns 404 when station not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/reservations',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {
          stationId: 'CS-999',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 400 when station is offline', async () => {
      setupDbResults([
        {
          id: VALID_STATION_ID,
          isOnline: false,
          onboardingStatus: 'accepted',
          reservationsEnabled: true,
        },
      ]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/reservations',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {
          stationId: 'CS-001',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('STATION_OFFLINE');
    });

    it('returns 409 STATION_UNAVAILABLE when the station is disabled', async () => {
      setupDbResults([
        {
          id: VALID_STATION_ID,
          isOnline: true,
          onboardingStatus: 'accepted',
          reservationsEnabled: true,
          disabledReason: 'security',
          firmwareState: null,
          reportedStatus: null,
        },
      ]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/reservations',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {
          stationId: 'CS-001',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('STATION_UNAVAILABLE');
    });

    it('returns 400 PAYMENT_METHOD_REQUIRED when driver has no default card', async () => {
      // Station -> PM lookup (empty) -> 400
      setupDbResults(
        [
          {
            id: VALID_STATION_ID,
            isOnline: true,
            onboardingStatus: 'accepted',
            reservationsEnabled: true,
          },
        ],
        [],
      );
      const response = await app.inject({
        method: 'POST',
        url: '/portal/reservations',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {
          stationId: 'CS-001',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('PAYMENT_METHOD_REQUIRED');
    });

    it('creates a reservation', async () => {
      const reservationData = {
        id: VALID_RESERVATION_ID,
        reservationId: 1,
        stationId: VALID_STATION_ID,
        driverId: null,
        status: 'active',
        expiresAt: '2024-01-01T00:00:00.000Z',
        createdAt: '2024-01-01T00:00:00.000Z',
      };
      // DB call 1: station lookup
      // DB call 2: default payment method check (always required for portal)
      // DB call 3: conflict check (no conflicts)
      // DB call 4: driverTokens lookup for preferredTokenId (empty)
      // DB call 5: insert returning reservation
      // The new active-session pre-check is gated on activeSessionCheckHours
      // > 0 in settings; the global mock leaves it undefined so the check is
      // skipped and consumes no DB slot.
      // getNextReservationId uses db.execute (sequence) and does not consume a slot.
      setupDbResults(
        [
          {
            id: VALID_STATION_ID,
            isOnline: true,
            onboardingStatus: 'accepted',
            reservationsEnabled: true,
          },
        ],
        [{ id: 1, isDefault: true }],
        [],
        [],
        [reservationData],
      );
      const response = await app.inject({
        method: 'POST',
        url: '/portal/reservations',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {
          stationId: 'CS-001',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().id).toBe(VALID_RESERVATION_ID);
      const call = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
      const message = JSON.parse(call?.[1] as string) as Record<string, unknown>;
      expect(Object.keys(message)).toEqual(['commandId', 'stationId', 'action', 'payload']);
      expect(message).toMatchObject({
        stationId: 'CS-001',
        action: 'ReserveNow',
        payload: { id: expect.any(Number), idToken: { idToken: DRIVER_ID, type: 'Central' } },
      });
    });
  });

  describe('DELETE /v1/portal/reservations/:id', () => {
    it('returns 404 when reservation not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'DELETE',
        url: `/portal/reservations/${VALID_RESERVATION_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('RESERVATION_NOT_FOUND');
    });

    it('returns 400 when reservation is not active', async () => {
      setupDbResults([
        { id: VALID_STATION_ID, reservationId: 1, status: 'expired', stationOcppId: 'CS-001' },
      ]);
      const response = await app.inject({
        method: 'DELETE',
        url: `/portal/reservations/${VALID_RESERVATION_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('RESERVATION_NOT_ACTIVE');
    });

    it('cancels an active reservation', async () => {
      const startsAt = new Date(Date.now() + 30 * 60 * 1000);
      setupDbResults(
        [
          {
            id: VALID_STATION_ID,
            reservationId: 1,
            status: 'active',
            stationOcppId: 'CS-001',
            siteId: null,
            startsAt,
            createdAt: new Date('2024-01-01T00:00:00Z'),
          },
        ],
        // Helper conditional UPDATE+RETURNING wins the race; chargeFee=true
        // but the default settings have cancellationFeeCents=0, so the helper
        // returns early without firing the post-charge UPDATE.
        [{ id: VALID_RESERVATION_ID }],
      );
      const response = await app.inject({
        method: 'DELETE',
        url: `/portal/reservations/${VALID_RESERVATION_ID}`,
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('cancelled');
      const call = mockPublish.mock.calls.find((c) => c[0] === 'ocpp_commands');
      const message = JSON.parse(call?.[1] as string) as Record<string, unknown>;
      expect(Object.keys(message)).toEqual(['commandId', 'stationId', 'action', 'payload']);
      expect(message).toMatchObject({
        stationId: 'CS-001',
        action: 'CancelReservation',
        payload: { reservationId: 1 },
      });
    });
  });

  describe('POST /v1/portal/chargers/:stationId/evse/:evseId/start - reservation buffer', () => {
    const stationRow = {
      id: VALID_STATION_ID,
      stationId: 'CS-001',
      siteId: null,
      isOnline: true,
      onboardingStatus: 'accepted',
      ocppProtocol: 'ocpp2.1',
    };
    const evseRow = { id: 'evs_000000000001' };
    const connectorRow = { status: 'available' };
    const existingSessionsEmpty: unknown[] = [];

    it('returns 409 when EVSE has a reservation starting within the buffer window', async () => {
      setupDbResults([stationRow], [evseRow], [connectorRow], existingSessionsEmpty);
      vi.mocked(isEvseInReservationBuffer).mockResolvedValue(true);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('RESERVATION_BUFFER_ACTIVE');
    });

    it('allows session start when reservation starts outside the buffer window', async () => {
      setupDbResults(
        [stationRow],
        [evseRow],
        [connectorRow],
        existingSessionsEmpty, // active reservation gate (no reservation)
        existingSessionsEmpty, // EVSE active-session check
        existingSessionsEmpty, // driver active-session check
        [{ id: VALID_SESSION_ID }],
      );
      vi.mocked(isEvseInReservationBuffer).mockResolvedValue(false);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().chargingSessionId).toBe(VALID_SESSION_ID);
    });

    it('allows session start when buffer is disabled (bufferMinutes=0)', async () => {
      setupDbResults(
        [stationRow],
        [evseRow],
        [connectorRow],
        existingSessionsEmpty, // active reservation gate (no reservation)
        existingSessionsEmpty, // EVSE active-session check
        existingSessionsEmpty, // driver active-session check
        [{ id: VALID_SESSION_ID }],
      );
      // bufferMinutes=0 means isEvseInReservationBuffer returns false immediately
      vi.mocked(isEvseInReservationBuffer).mockResolvedValue(false);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
    });

    it('returns 409 EVSE_IN_USE when an active session already exists on the EVSE', async () => {
      // Defense-in-depth: even if the connector status reads 'available' (e.g. because
      // a manual StatusNotification refresh momentarily clobbered it), we must not
      // start a second session on top of an active one.
      setupDbResults(
        [stationRow],
        [evseRow],
        [connectorRow],
        [], // active reservation gate (no reservation)
        [{ id: 'ses_existing_evse' }], // EVSE active-session check returns an active session
      );
      vi.mocked(isEvseInReservationBuffer).mockResolvedValue(false);

      const response = await app.inject({
        method: 'POST',
        url: '/portal/chargers/CS-001/evse/1/start',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: {},
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('EVSE_IN_USE');
    });
  });
});
