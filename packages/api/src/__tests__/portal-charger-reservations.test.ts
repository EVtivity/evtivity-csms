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

const { mockRecordSessionEndRequest, mockWriteCsmsSessionAudit } = vi.hoisted(() => ({
  mockRecordSessionEndRequest: vi.fn().mockResolvedValue(true),
  mockWriteCsmsSessionAudit: vi.fn(),
}));

vi.mock('@evtivity/database', async () => ({
  ...(await import('./helpers/conformance-station-mocks.js')).conformanceStationMocks(),
  ACCOUNT_INVOICE_RECIPIENTS: ['fleet', 'member'],
  // The shared driver availability rule builds SQL; drizzle is mocked here, so the fragments are stubs.
  availableEvseCountSql: vi.fn(() => 'available_evse_count'),
  evseAvailableSql: vi.fn(() => 'evse_available'),
  evseOpenToDriversSql: vi.fn(() => 'evse_open_to_drivers'),
  STARTABLE_CONNECTOR_STATUSES: ['available', 'occupied', 'preparing', 'ev_connected', 'finishing'],
  SESSION_END_REQUEST_CHANNEL: 'session_end_requests',
  recordSessionEndRequest: mockRecordSessionEndRequest,
  writeCsmsSessionAudit: mockWriteCsmsSessionAudit,
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
  snapshotReservationFeeTerms: vi.fn().mockResolvedValue({
    feeTaxBasis: 'gross',
    feeTaxRate: '0.19',
    feePerMinute: '0.10',
    feeCancellationCents: 300,
  }),
  resolveReservationFeeTerms: vi.fn().mockResolvedValue({
    basis: 'gross',
    taxRate: '0.19',
    feePerMinute: '0.10',
    cancellationFeeCents: 300,
  }),
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

// The station side of the reservation service runs for real (dispatch and
// cancel order, rollback reasons); its database-heavy create, the guarded
// cancel and the driver notices are mocked.
const { mockCreateReservation, mockApplyCancellation, mockNotify } = vi.hoisted(() => ({
  mockCreateReservation: vi.fn(),
  mockApplyCancellation: vi.fn(),
  mockNotify: vi.fn(),
}));
vi.mock('@evtivity/services/reservation.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/services/reservation.service')>();
  return { ...actual, createReservation: mockCreateReservation };
});
vi.mock('@evtivity/services/reservation-cancel', () => ({
  applyReservationCancellation: mockApplyCancellation,
}));
vi.mock('@evtivity/services/reservation-notify', () => ({
  notifyReservationDriver: mockNotify,
  cancelReasonNoticeFlags: (reason: string) =>
    reason === 'station_no_response' ? { stationNoResponse: true } : {},
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
import { AppError } from '@evtivity/lib';
import { writeReservationAudit } from '@evtivity/database';
import { sendOcppCommandAndWait } from '@evtivity/services/ocpp-command';
import { MaintenanceConflictError } from '@evtivity/services/maintenance-check';

const STATION_UUID = 'sta_000000000001';
const RESERVATION_ID = 'rsv_000000000001';
const DRIVER_ID = 'drv_000000000001';

const PORTAL_STATION = {
  id: STATION_UUID,
  stationId: 'CS-001',
  siteId: 'sit_000000000001',
  isOnline: true,
  availability: 'available',
  onboardingStatus: 'accepted',
  reservationsEnabled: true,
  disabledReason: null,
  firmwareState: null,
  reportedStatus: null,
};

function createdRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RESERVATION_ID,
    reservationId: 6,
    stationId: STATION_UUID,
    evseId: null,
    driverId: DRIVER_ID,
    tokenId: null,
    status: 'active',
    startsAt: null,
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function cancelledResult(statusBefore: 'active' | 'scheduled' | null = 'active') {
  return {
    feeChargedCents: 0,
    cancelled: statusBefore != null,
    feeChargeFailed: false,
    feeCurrency: null,
    statusBefore,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  // The API error handler: an AppError answers its status and code.
  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({ error: error.message, code: error.code });
      return;
    }
    void reply.status(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  });
  await registerAuth(app);
  await app.register(portalChargerRoutes);
  await app.ready();
  return app;
}

function commandsPublished(): Array<{ stationId: string; action: string; payload: unknown }> {
  return mockPublish.mock.calls
    .filter((c) => c[0] === 'ocpp_commands')
    .map(
      (c) => JSON.parse(c[1] as string) as { stationId: string; action: string; payload: unknown },
    );
}

describe('Portal reservation routes', () => {
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
    mockPublish.mockReset();
    mockPublish.mockResolvedValue(undefined);
    mockCreateReservation.mockReset();
    mockApplyCancellation.mockReset();
    mockApplyCancellation.mockResolvedValue(cancelledResult());
    mockNotify.mockReset();
    mockNotify.mockResolvedValue(undefined);
    vi.mocked(writeReservationAudit).mockClear();
    vi.mocked(sendOcppCommandAndWait).mockReset();
    vi.mocked(sendOcppCommandAndWait).mockResolvedValue({
      commandId: 'c1',
      response: { status: 'Accepted' },
    });
  });

  const auth = (): Record<string, string> => ({ authorization: `Bearer ${driverToken}` });

  describe('POST /portal/reservations', () => {
    const expiresAt = '2030-01-01T00:00:00.000Z';

    function create(payload: Record<string, unknown> = {}) {
      return app.inject({
        method: 'POST',
        url: '/portal/reservations',
        headers: auth(),
        payload: { stationId: 'CS-001', expiresAt, ...payload },
      });
    }

    it('returns 404 STATION_NOT_FOUND for an unknown or unlisted station', async () => {
      setupDbResults([]);
      const response = await create();
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
      expect(mockCreateReservation).not.toHaveBeenCalled();
    });

    it('returns 403 STATION_PENDING for a station awaiting approval', async () => {
      setupDbResults([{ ...PORTAL_STATION, onboardingStatus: 'pending' }]);
      const response = await create();
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('STATION_PENDING');
      expect(mockCreateReservation).not.toHaveBeenCalled();
    });

    it('creates through the service as the driver and answers the accepted row', async () => {
      setupDbResults([PORTAL_STATION]);
      mockCreateReservation.mockResolvedValueOnce(createdRow());
      const response = await create({ evseId: 2, startsAt: '2029-12-31T23:30:00.000Z' });
      expect(response.statusCode).toBe(200);
      expect(response.json().id).toBe(RESERVATION_ID);
      expect(mockCreateReservation).toHaveBeenCalledWith(
        expect.objectContaining({
          station: PORTAL_STATION,
          evseOcppId: 2,
          driverId: DRIVER_ID,
          startsAt: new Date('2029-12-31T23:30:00.000Z'),
          expiresAt: new Date(expiresAt),
          actor: { kind: 'driver', driverId: DRIVER_ID },
        }),
      );
      // The portal create now waits for the station's answer (G4).
      expect(sendOcppCommandAndWait).toHaveBeenCalledWith(
        'CS-001',
        'ReserveNow',
        expect.objectContaining({ id: 6 }),
      );
      expect(mockNotify).toHaveBeenCalledWith(
        'reservation.Created',
        expect.objectContaining({ reservationOcppId: 6, driverId: DRIVER_ID }),
        {},
        expect.anything(),
      );
    });

    it('schedules a future reservation through the worker without ReserveNow', async () => {
      setupDbResults([PORTAL_STATION]);
      mockCreateReservation.mockResolvedValueOnce(
        createdRow({ status: 'scheduled', startsAt: new Date(Date.now() + 3_600_000) }),
      );
      const response = await create();
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('scheduled');
      expect(sendOcppCommandAndWait).not.toHaveBeenCalled();
      expect(mockPublish).toHaveBeenCalledWith('reservation_schedule', expect.any(String));
    });

    it('passes service errors through with their status and code', async () => {
      setupDbResults([PORTAL_STATION]);
      mockCreateReservation.mockRejectedValueOnce(
        new AppError('A default payment method is required', 400, 'PAYMENT_METHOD_REQUIRED'),
      );
      const response = await create();
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('PAYMENT_METHOD_REQUIRED');
    });

    it('returns 409 with the maintenance details when the window overlaps maintenance', async () => {
      setupDbResults([PORTAL_STATION]);
      mockCreateReservation.mockRejectedValueOnce(
        new MaintenanceConflictError({
          id: 'mnt_000000000001',
          plannedStartAt: new Date('2030-01-01T00:00:00.000Z'),
          plannedEndAt: new Date('2030-01-01T02:00:00.000Z'),
        } as never),
      );
      const response = await create();
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: 'Reservation falls within a scheduled maintenance window',
        code: 'RESERVATION_DURING_MAINTENANCE',
        maintenanceEventId: 'mnt_000000000001',
        plannedStartAt: '2030-01-01T00:00:00.000Z',
        plannedEndAt: '2030-01-01T02:00:00.000Z',
      });
    });

    it('TC-RES-05: a Rejected ReserveNow answers 502 RESERVATION_REJECTED and cancels without a fee', async () => {
      setupDbResults([PORTAL_STATION]);
      mockCreateReservation.mockResolvedValueOnce(createdRow());
      vi.mocked(sendOcppCommandAndWait).mockResolvedValueOnce({
        commandId: 'c1',
        response: { status: 'Rejected' },
      });
      const response = await create();
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({
        error: 'Station rejected reservation: Rejected',
        code: 'RESERVATION_REJECTED',
      });
      expect(mockApplyCancellation).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationDbId: RESERVATION_ID,
          actor: 'system',
          reason: 'station_rejected_other',
          auditAction: 'station_rejected',
          chargeFee: false,
        }),
      );
      // The station answered: it holds nothing to cancel.
      expect(commandsPublished()).toEqual([]);
    });

    it('TC-RES-05: no reply answers 504 RESERVATION_TIMEOUT and cancels as station_no_response', async () => {
      setupDbResults([PORTAL_STATION]);
      mockCreateReservation.mockResolvedValueOnce(createdRow());
      vi.mocked(sendOcppCommandAndWait).mockResolvedValueOnce({
        commandId: 'c1',
        error: 'No response within 35s',
        timedOut: true,
      });
      const response = await create();
      expect(response.statusCode).toBe(504);
      expect(response.json()).toEqual({
        error: 'No response within 35s',
        code: 'RESERVATION_TIMEOUT',
      });
      expect(mockApplyCancellation).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: 'system',
          reason: 'station_no_response',
          auditAction: 'station_rejected',
          chargeFee: false,
        }),
      );
      expect(commandsPublished()).toEqual([
        expect.objectContaining({
          stationId: 'CS-001',
          action: 'CancelReservation',
          payload: { reservationId: 6 },
        }),
      ]);
      expect(mockNotify).toHaveBeenCalledWith(
        'reservation.Cancelled',
        expect.objectContaining({ reservationOcppId: 6 }),
        expect.objectContaining({ stationNoResponse: true, cancellationFeeFormatted: '' }),
        expect.anything(),
      );
    });

    it('TC-RES-05: a station offline at send answers 504 like no reply', async () => {
      setupDbResults([PORTAL_STATION]);
      mockCreateReservation.mockResolvedValueOnce(createdRow());
      vi.mocked(sendOcppCommandAndWait).mockResolvedValueOnce({
        commandId: 'c1',
        queued: true,
        error: 'Station offline, command queued',
      });
      const response = await create();
      expect(response.statusCode).toBe(504);
      expect(response.json().code).toBe('RESERVATION_TIMEOUT');
    });

    it('TC-RES-05: a failed send answers 502 RESERVATION_REJECTED', async () => {
      setupDbResults([PORTAL_STATION]);
      mockCreateReservation.mockResolvedValueOnce(createdRow());
      vi.mocked(sendOcppCommandAndWait).mockResolvedValueOnce({
        commandId: 'c1',
        error: 'Internal error sending command',
      });
      const response = await create();
      expect(response.statusCode).toBe(502);
      expect(response.json().code).toBe('RESERVATION_REJECTED');
      // A send error never reached the station: no answer, not a rejection.
      expect(mockApplyCancellation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'station_no_response' }),
      );
    });
  });

  describe('DELETE /portal/reservations/:id', () => {
    function cancel() {
      return app.inject({
        method: 'DELETE',
        url: `/portal/reservations/${RESERVATION_ID}`,
        headers: auth(),
      });
    }

    const ownRow = (overrides: Record<string, unknown> = {}) => ({
      id: RESERVATION_ID,
      reservationId: 6,
      status: 'active',
      stationOcppId: 'CS-001',
      siteId: 'sit_000000000001',
      startsAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    });

    it('returns 404 for a reservation the driver does not own', async () => {
      setupDbResults([]);
      const response = await cancel();
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('RESERVATION_NOT_FOUND');
    });

    it('returns 400 RESERVATION_NOT_ACTIVE for an ended reservation', async () => {
      setupDbResults([ownRow({ status: 'expired' })]);
      const response = await cancel();
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('RESERVATION_NOT_ACTIVE');
      expect(mockApplyCancellation).not.toHaveBeenCalled();
    });

    it('TC-RES-09: cancels in the database before sending CancelReservation', async () => {
      setupDbResults([ownRow()]);
      const order: string[] = [];
      mockApplyCancellation.mockImplementationOnce(() => {
        order.push('cancel');
        return Promise.resolve({ ...cancelledResult(), feeChargedCents: 250, feeCurrency: 'EUR' });
      });
      vi.mocked(sendOcppCommandAndWait).mockImplementationOnce(() => {
        order.push('send');
        return Promise.resolve({ commandId: 'c9', response: { status: 'Accepted' } });
      });

      const response = await cancel();

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'cancelled', cancellationFeeChargedCents: 250 });
      expect(order).toEqual(['cancel', 'send']);
      expect(mockApplyCancellation).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationDbId: RESERVATION_ID,
          driverId: DRIVER_ID,
          actor: 'driver',
          actorDriverId: DRIVER_ID,
          reason: 'driver_initiated',
          chargeFee: true,
        }),
      );
      expect(sendOcppCommandAndWait).toHaveBeenCalledWith('CS-001', 'CancelReservation', {
        reservationId: 6,
      });
      expect(mockNotify).toHaveBeenCalledWith(
        'reservation.Cancelled',
        expect.objectContaining({ reservationDbId: RESERVATION_ID, driverId: DRIVER_ID }),
        expect.objectContaining({ cancellationFeeCents: 250, currency: 'EUR' }),
        expect.anything(),
      );
    });

    it('TC-RES-10: a refused cancel answers 200 with warning station_cancel_failed', async () => {
      setupDbResults([ownRow()]);
      mockApplyCancellation.mockResolvedValueOnce(cancelledResult());
      vi.mocked(sendOcppCommandAndWait).mockResolvedValueOnce({
        commandId: 'c10',
        response: { status: 'Rejected' },
      });
      const response = await cancel();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ warning: 'station_cancel_failed' });
    });

    it('TC-RES-09: publishes nothing when the winner was scheduled', async () => {
      setupDbResults([ownRow({ status: 'scheduled' })]);
      mockApplyCancellation.mockResolvedValueOnce(cancelledResult('scheduled'));
      const response = await cancel();
      expect(response.statusCode).toBe(200);
      expect(commandsPublished()).toEqual([]);
    });

    it('TC-RES-09: publishes nothing and sends no notice when another cancel won', async () => {
      setupDbResults([ownRow()]);
      mockApplyCancellation.mockResolvedValueOnce(cancelledResult(null));
      const response = await cancel();
      expect(response.statusCode).toBe(200);
      expect(commandsPublished()).toEqual([]);
      expect(mockNotify).not.toHaveBeenCalled();
    });
  });
});
