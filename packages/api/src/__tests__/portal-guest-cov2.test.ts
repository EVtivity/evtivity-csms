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

vi.mock('@evtivity/database', async () => ({
  isStationLevelUnavailable: (
    await vi.importActual<typeof import('../../../database/src/lib/station-status.js')>(
      '../../../database/src/lib/station-status.js',
    )
  ).isStationLevelUnavailable,
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
  getCompanyCountry: vi.fn(() => Promise.resolve('NL')),
  getCompanyTaxBasis: vi.fn(() => Promise.resolve('net')),
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
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
  chargingStations: {},
  evses: {},
  connectors: {},
  guestSessions: {},
  chargingSessions: {},
  meterValues: {},
  paymentRecords: {},
  reservations: {},
  sites: { id: 'id', freeVendEnabled: 'freeVendEnabled' },
  client: {},
  resolveStationTariff: vi.fn().mockResolvedValue(null),
  isStationChargingFree: vi.fn().mockResolvedValue(true),
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
  mockAuthorizeGuestHold,
  mockClaimGuestStart,
  mockContinueGuestHold,
  mockHoldTerms,
  mockRollbackGuestStart,
  mockScheduleGuestStartTimeout,
} = vi.hoisted(() => ({
  mockActivePaymentProvider: vi.fn(),
  mockAuthorizeGuestHold: vi.fn(),
  mockClaimGuestStart: vi.fn(),
  mockContinueGuestHold: vi.fn(),
  mockHoldTerms: vi.fn(),
  mockRollbackGuestStart: vi.fn(),
  mockScheduleGuestStartTimeout: vi.fn(),
}));

vi.mock('../lib/remote-start-timeout.js', () => ({
  scheduleGuestStartTimeout: mockScheduleGuestStartTimeout,
}));

vi.mock('@evtivity/payments', () => ({
  authorizeGuestHold: mockAuthorizeGuestHold,
  claimGuestStart: mockClaimGuestStart,
  continueGuestHold: mockContinueGuestHold,
  holdTerms: mockHoldTerms,
  guestHoldTerms: mockHoldTerms,
  rollbackGuestStart: mockRollbackGuestStart,
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
    subscribe: vi.fn().mockResolvedValue(undefined),
  })),
  setPubSub: vi.fn(),
}));

vi.mock('@evtivity/services/ocpp-command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/services/ocpp-command')>()),
  sendOcppCommandAndWait: vi.fn().mockResolvedValue({
    commandId: 'mock-command-id',
    response: { status: 'Accepted' },
  }),
}));

vi.mock('../lib/station-status-check.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/station-status-check.js')>()),
  triggerAndWaitForStatus: vi.fn().mockResolvedValue({ status: 'available' }),
}));

vi.mock('../lib/session-limit.js', () => ({ sessionLimitReached: vi.fn(async () => null) }));

vi.mock('../lib/reservation-buffer.js', () => ({
  isEvseInReservationBuffer: vi.fn().mockResolvedValue(false),
}));

vi.mock('@evtivity/services/maintenance.service', () => ({
  getActiveMaintenanceForStation: vi.fn().mockResolvedValue(null),
}));

const {
  mockIsGuestSessionRateLimited,
  mockIsStationCheckRateLimited,
  mockGetCachedConnectorStatus,
  mockSetCachedConnectorStatus,
} = vi.hoisted(() => ({
  mockIsGuestSessionRateLimited: vi.fn(),
  mockIsStationCheckRateLimited: vi.fn(),
  mockGetCachedConnectorStatus: vi.fn(),
  mockSetCachedConnectorStatus: vi.fn(),
}));

vi.mock('../lib/rate-limiters.js', () => ({
  isGuestSessionRateLimited: mockIsGuestSessionRateLimited,
  isStationCheckRateLimited: mockIsStationCheckRateLimited,
  getCachedConnectorStatus: mockGetCachedConnectorStatus,
  setCachedConnectorStatus: mockSetCachedConnectorStatus,
}));

import { registerAuth } from '../plugins/auth.js';
import { portalGuestRoutes } from '../routes/portal/guest.js';
import { db } from '@evtivity/database';
import { triggerAndWaitForStatus } from '../lib/station-status-check.js';
import { getActiveMaintenanceForStation } from '@evtivity/services/maintenance.service';
import { sessionLimitReached } from '../lib/session-limit.js';

const TOKEN = 'abc123def456abc12345';
const START_BODY = { paymentMethodId: 'pm_test', guestEmail: 'guest@example.com' };

const ONLINE_STATION = {
  id: 'sta_000000000001',
  stationId: 'CS-001',
  siteId: null,
  isOnline: true,
  onboardingStatus: 'accepted',
  ocppProtocol: 'ocpp2.1',
  disabledReason: null,
  firmwareState: null,
  reportedStatus: null,
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalGuestRoutes);
  await app.ready();
  return app;
}

describe('Portal guest routes - gates and history', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    mockIsGuestSessionRateLimited.mockReturnValue(false);
    mockIsStationCheckRateLimited.mockReturnValue(false);
    mockGetCachedConnectorStatus.mockReturnValue(null);
    vi.mocked(db.execute).mockResolvedValue([] as never);
    vi.mocked(getActiveMaintenanceForStation).mockResolvedValue(null);
    vi.mocked(sessionLimitReached).mockResolvedValue(null);
  });

  describe('POST /portal/guest/qr/validate', () => {
    it('refuses a URL that does not parse', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/qr/validate',
        payload: { url: 'not a url' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ valid: false, reason: 'malformed_url' });
    });

    it('refuses a URL without the qr path parameters', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/qr/validate',
        payload: { url: 'https://portal.example.com/qr/CS-001' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ valid: false, reason: 'missing_parameter' });
    });

    it('rejects an empty url with 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/qr/validate',
        payload: { url: '' },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /portal/guest/check-status/:stationId/:evseId', () => {
    it('returns 404 STATION_NOT_FOUND for an unknown station', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/check-status/CS-NONE/1',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
    });

    it('serves a cached status without triggering the station or charging the rate limit', async () => {
      setupDbResults([{ id: 'sta_c', stationId: 'CS-C', isOnline: true, ocppProtocol: null }]);
      mockGetCachedConnectorStatus.mockReturnValue({ status: 'charging', cachedAt: Date.now() });
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/check-status/CS-C/2',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ connectorStatus: 'charging' });
      expect(mockGetCachedConnectorStatus).toHaveBeenCalledWith('CS-C', 2);
      expect(mockIsStationCheckRateLimited).not.toHaveBeenCalled();
      expect(triggerAndWaitForStatus).not.toHaveBeenCalled();
    });

    it('replays a cached error code', async () => {
      setupDbResults([{ id: 'sta_c', stationId: 'CS-C', isOnline: true, ocppProtocol: null }]);
      mockGetCachedConnectorStatus.mockReturnValue({
        status: null,
        errorCode: 'STATUS_CHECK_REJECTED',
        cachedAt: Date.now(),
      });
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/check-status/CS-C/1',
      });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({
        error: 'Station rejected the status check',
        code: 'STATUS_CHECK_REJECTED',
      });
      expect(triggerAndWaitForStatus).not.toHaveBeenCalled();
    });

    it('returns 429 RATE_LIMITED when the station check budget is spent', async () => {
      setupDbResults([{ id: 'sta_r', stationId: 'CS-R', isOnline: true, ocppProtocol: null }]);
      mockIsStationCheckRateLimited.mockReturnValue(true);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/check-status/CS-R/1',
      });
      expect(response.statusCode).toBe(429);
      expect(response.json()).toEqual({
        error: 'Too many status checks for this station',
        code: 'RATE_LIMITED',
      });
      expect(mockIsStationCheckRateLimited).toHaveBeenCalledWith('CS-R');
      expect(db.execute).not.toHaveBeenCalled();
    });

    it('returns 404 CONNECTOR_NOT_FOUND when the EVSE has no connector', async () => {
      setupDbResults([{ id: 'sta_n', stationId: 'CS-N', isOnline: true, ocppProtocol: null }]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/check-status/CS-N/3',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: 'Connector not found',
        code: 'CONNECTOR_NOT_FOUND',
      });
      expect(triggerAndWaitForStatus).not.toHaveBeenCalled();
    });

    it('caches the fresh result for the next caller', async () => {
      setupDbResults([{ id: 'sta_ok', stationId: 'CS-OK', isOnline: true, ocppProtocol: null }]);
      vi.mocked(db.execute).mockResolvedValueOnce([{ connector_id: 2 }] as never);
      vi.mocked(triggerAndWaitForStatus).mockResolvedValueOnce({ status: 'available' });
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/check-status/CS-OK/1',
      });
      expect(response.statusCode).toBe(200);
      expect(triggerAndWaitForStatus).toHaveBeenCalledWith('CS-OK', 1, 2, 'sta_ok', undefined);
      expect(mockSetCachedConnectorStatus).toHaveBeenCalledWith('CS-OK', 1, {
        status: 'available',
      });
    });
  });

  describe('POST /portal/guest/start/:stationId/:evseId - gates', () => {
    it('returns 409 MAINTENANCE_ACTIVE with the planned end during maintenance', async () => {
      setupDbResults([ONLINE_STATION]);
      vi.mocked(getActiveMaintenanceForStation).mockResolvedValue({
        plannedEndAt: new Date('2030-01-02T03:04:05.000Z'),
      } as never);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: START_BODY,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'MAINTENANCE_ACTIVE',
        plannedEndAt: '2030-01-02T03:04:05.000Z',
      });
      expect(getActiveMaintenanceForStation).toHaveBeenCalledWith('sta_000000000001');
    });

    it('returns 403 STATION_PENDING for a station awaiting approval', async () => {
      setupDbResults([{ ...ONLINE_STATION, onboardingStatus: 'pending' }]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: START_BODY,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: 'Station is pending approval',
        code: 'STATION_PENDING',
      });
    });

    it('returns 403 STATION_BLOCKED for a blocked station', async () => {
      setupDbResults([{ ...ONLINE_STATION, onboardingStatus: 'blocked' }]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: START_BODY,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('STATION_BLOCKED');
    });

    it('returns 409 STATION_UNAVAILABLE for an operator-disabled station', async () => {
      setupDbResults([{ ...ONLINE_STATION, disabledReason: 'operator' }]);
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: START_BODY,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: 'Station is unavailable',
        code: 'STATION_UNAVAILABLE',
      });
    });

    it('returns 403 CONNECTOR_RESERVED when a reservation covers the EVSE', async () => {
      setupDbResults(
        [ONLINE_STATION],
        [{ id: 'evs_000000000001' }],
        [{ status: 'reserved' }],
        [{ id: 'rsv_000000000001' }],
      );
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: START_BODY,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: 'Connector is reserved',
        code: 'CONNECTOR_RESERVED',
      });
    });

    it('returns 409 EVSE_IN_USE when a session is already active on the EVSE', async () => {
      setupDbResults(
        [ONLINE_STATION],
        [{ id: 'evs_000000000001' }],
        [{ status: 'occupied' }],
        [],
        [{ id: 'ses_000000000009' }],
      );
      const response = await app.inject({
        method: 'POST',
        url: '/portal/guest/start/CS-001/1',
        payload: START_BODY,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: 'Another session is already active on this connector',
        code: 'EVSE_IN_USE',
      });
      expect(mockPublish).not.toHaveBeenCalled();
    });
  });

  describe('GET /portal/guest/status/:sessionToken', () => {
    it('returns 429 RATE_LIMITED for a client over its budget', async () => {
      mockIsGuestSessionRateLimited.mockReturnValue(true);
      const response = await app.inject({ method: 'GET', url: `/portal/guest/status/${TOKEN}` });
      expect(response.statusCode).toBe(429);
      expect(response.json()).toEqual({ error: 'Too many requests', code: 'RATE_LIMITED' });
      expect(db.select).not.toHaveBeenCalled();
    });

    it('includes the payment failure reason of a failed session', async () => {
      setupDbResults(
        [{ status: 'failed', stationOcppId: 'CS-001', evseId: 1, chargingSessionId: 'ses_1' }],
        [{ isSimulator: true }],
        [
          {
            energyDeliveredWh: 0,
            currentCostCents: 0,
            finalCostCents: 0,
            taxCents: 0,
            currency: 'EUR',
            startedAt: null,
            endedAt: null,
            idleStartedAt: null,
          },
        ],
        [{ failureReason: 'card_declined' }],
      );
      const response = await app.inject({ method: 'GET', url: `/portal/guest/status/${TOKEN}` });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('failed');
      expect(body.isSimulator).toBe(true);
      expect(body.currency).toBe('EUR');
      expect(body.failureReason).toBe('card_declined');
    });

    it('omits the failure reason when the payment record has none', async () => {
      setupDbResults(
        [{ status: 'failed', stationOcppId: 'CS-001', evseId: 1, chargingSessionId: 'ses_1' }],
        [],
        [],
        [{ failureReason: null }],
      );
      const response = await app.inject({ method: 'GET', url: `/portal/guest/status/${TOKEN}` });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.isSimulator).toBe(false);
      expect(body).not.toHaveProperty('failureReason');
      expect(body).not.toHaveProperty('energyDeliveredWh');
    });
  });

  describe.each([['power-history'], ['energy-history']])(
    'GET /portal/guest/%s/:sessionToken',
    (route) => {
      it('returns 429 RATE_LIMITED for a client over its budget', async () => {
        mockIsGuestSessionRateLimited.mockReturnValue(true);
        const response = await app.inject({
          method: 'GET',
          url: `/portal/guest/${route}/${TOKEN}`,
        });
        expect(response.statusCode).toBe(429);
        expect(response.json().code).toBe('RATE_LIMITED');
      });

      it('returns 404 SESSION_NOT_FOUND for an unknown token', async () => {
        setupDbResults([]);
        const response = await app.inject({
          method: 'GET',
          url: `/portal/guest/${route}/${TOKEN}`,
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      });

      it('returns an empty series before a charging session is linked', async () => {
        setupDbResults([{ chargingSessionId: null }]);
        const response = await app.inject({
          method: 'GET',
          url: `/portal/guest/${route}/${TOKEN}`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ data: [] });
        expect(db.select).toHaveBeenCalledTimes(1);
      });

      it('refuses a malformed token', async () => {
        const response = await app.inject({ method: 'GET', url: `/portal/guest/${route}/nothex` });
        expect(response.statusCode).toBe(400);
        expect(db.select).not.toHaveBeenCalled();
      });
    },
  );

  it('returns the power samples of the linked session', async () => {
    setupDbResults(
      [{ chargingSessionId: 'ses_1' }],
      [
        { timestamp: '2026-01-01T10:00:00.000Z', powerW: 7000 },
        { timestamp: '2026-01-01T10:01:00.000Z', powerW: 7200 },
      ],
    );
    const response = await app.inject({
      method: 'GET',
      url: `/portal/guest/power-history/${TOKEN}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [
        { timestamp: '2026-01-01T10:00:00.000Z', powerW: 7000 },
        { timestamp: '2026-01-01T10:01:00.000Z', powerW: 7200 },
      ],
    });
  });

  it('returns the energy samples of the linked session', async () => {
    setupDbResults(
      [{ chargingSessionId: 'ses_1' }],
      [{ meterStart: 1000 }],
      [{ timestamp: '2026-01-01T10:00:00.000Z', energyWh: 250 }],
    );
    const response = await app.inject({
      method: 'GET',
      url: `/portal/guest/energy-history/${TOKEN}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [{ timestamp: '2026-01-01T10:00:00.000Z', energyWh: 250 }],
    });
  });

  it('reads the energy samples even when the session row is gone', async () => {
    setupDbResults([{ chargingSessionId: 'ses_1' }], [], []);
    const response = await app.inject({
      method: 'GET',
      url: `/portal/guest/energy-history/${TOKEN}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: [] });
    expect(db.select).toHaveBeenCalledTimes(3);
  });
});
