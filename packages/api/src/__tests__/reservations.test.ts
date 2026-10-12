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

vi.mock('@evtivity/database', async () => ({
  isStationLevelUnavailable: (
    await vi.importActual<typeof import('../../../database/src/lib/station-status.js')>(
      '../../../database/src/lib/station-status.js',
    )
  ).isStationLevelUnavailable,
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([{ next_val: '6' }])),
  },
  client: {},
  reservations: {},
  chargingStations: {},
  chargingSessions: {},
  drivers: {},
  evses: {},
  connectors: {},
  sites: {},
  ocppMessageLogs: {},
  driverPaymentMethods: {},
  driverTokens: {},
  users: {},
  reservationAuditLog: {},
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
    activeSessionCheckHours: 3,
  }),
  writeReservationAudit: vi.fn().mockResolvedValue(undefined),
  reservationDiffChanged: vi.fn().mockReturnValue(false),
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
  inArray: vi.fn(),
  gt: vi.fn(),
  isNull: vi.fn(),
}));

// PubSub mock: commands the routes publish land here.
const mockPublish = vi.fn((_channel: string, _message: string) => Promise.resolve(undefined));
const mockSubscribe = vi.fn().mockResolvedValue({ unsubscribe: vi.fn() });

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({
    publish: mockPublish,
    subscribe: mockSubscribe,
  })),
  setPubSub: vi.fn(),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

const mockChargeReservationCancellationFee = vi
  .fn()
  .mockResolvedValue({ status: 'skipped', reason: 'no_payment_method' });
vi.mock('@evtivity/payments', () => ({
  chargeReservationFee: (...args: unknown[]) => mockChargeReservationCancellationFee(...args),
}));

vi.mock('../lib/payments.js', () => ({
  paymentContext: vi.fn((logger: unknown) => ({ registry: 'registry', logger })),
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

// The station side of the reservation service runs for real (dispatch and
// cancel order, rollback reasons); its database-heavy creates and edits, the
// OCPP round trip, the guarded cancel and the driver notices are mocked.
const mockSendCommand = vi.fn();
vi.mock('@evtivity/services/ocpp-command', () => ({
  sendOcppCommandAndWait: (...args: unknown[]) => mockSendCommand(...args),
}));
const mockApplyCancellation = vi.fn();
vi.mock('@evtivity/services/reservation-cancel', () => ({
  applyReservationCancellation: (...args: unknown[]) => mockApplyCancellation(...args),
}));
const mockNotify = vi.fn().mockResolvedValue(undefined);
vi.mock('@evtivity/services/reservation-notify', () => ({
  notifyReservationDriver: (...args: unknown[]) => mockNotify(...args),
  cancelReasonNoticeFlags: (reason: string) =>
    reason === 'station_no_response' ? { stationNoResponse: true } : {},
}));
const mockCreateReservation = vi.fn();
const mockUpdateReservation = vi.fn();
const mockReassignReservation = vi.fn();
vi.mock('@evtivity/services/reservation.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/services/reservation.service')>();
  return {
    ...actual,
    createReservation: (...args: unknown[]) => mockCreateReservation(...args),
    updateReservation: (...args: unknown[]) => mockUpdateReservation(...args),
    reassignReservation: (...args: unknown[]) => mockReassignReservation(...args),
  };
});

import { registerAuth } from '../plugins/auth.js';
import { reservationRoutes } from '../routes/reservations.js';
import { AppError } from '@evtivity/lib';
import { MaintenanceConflictError } from '@evtivity/services/maintenance-check';
import {
  getReservationSettings,
  resolveReservationFeeTerms,
  writeReservationAudit,
} from '@evtivity/database';

const VALID_RESERVATION_ID = 'rsv_000000000001';
const VALID_DRIVER_ID = 'drv_000000000001';
const VALID_STATION_ID = 'sta_000000000001';

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
  await app.register(reservationRoutes);
  await app.ready();
  return app;
}

function makeReservation(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_RESERVATION_ID,
    reservationId: 1,
    stationId: VALID_STATION_ID,
    stationOcppId: 'CS-001',
    siteId: null,
    siteName: null,
    evseId: null,
    evseOcppId: null,
    connectorType: null,
    connectorMaxPowerKw: null,
    driverId: null,
    driverFirstName: null,
    driverLastName: null,
    tokenId: null,
    tokenIdToken: null,
    tokenType: null,
    status: 'active',
    startsAt: null,
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    cancelledBy: null,
    cancelReason: null,
    cancelNote: null,
    cancellationFeeCents: 0,
    sessionId: null,
    sessionStatus: null,
    sessionEnergyWh: null,
    sessionCostCents: null,
    sessionStartedAt: null,
    sessionEndedAt: null,
    ...overrides,
  };
}

describe('Reservation routes', () => {
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
    setupDbResults();
    mockPublish.mockReset();
    mockPublish.mockResolvedValue(undefined);
    mockSubscribe.mockClear();
    mockChargeReservationCancellationFee.mockClear();
    mockSendCommand.mockReset();
    mockSendCommand.mockResolvedValue({ commandId: 'c1', response: { status: 'Accepted' } });
    mockApplyCancellation.mockReset();
    mockApplyCancellation.mockResolvedValue({
      feeChargedCents: 0,
      cancelled: true,
      feeChargeFailed: false,
      feeCurrency: null,
      statusBefore: 'active',
    });
    mockNotify.mockClear();
    mockCreateReservation.mockReset();
    mockUpdateReservation.mockReset();
    mockReassignReservation.mockReset();
    vi.mocked(writeReservationAudit).mockClear();
    mockChargeReservationCancellationFee.mockResolvedValue({
      status: 'skipped',
      reason: 'no_payment_method',
    });
    vi.mocked(getReservationSettings).mockResolvedValue({
      enabled: true,
      bufferMinutes: 0,
      cancellationWindowMinutes: 0,
      cancellationFeeCents: 0,
      maxHours: 0,
      activeSessionCheckHours: 3,
    });
  });

  // ------------------------------------------------------------------
  // GET /v1/reservations
  // ------------------------------------------------------------------
  describe('GET /v1/reservations', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({ method: 'GET', url: '/reservations' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 with no filters', async () => {
      const items = [makeReservation()];
      // First db call: data query, second db call: count query
      setupDbResults(items, [{ count: 1 }]);

      const res = await app.inject({
        method: 'GET',
        url: '/reservations',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(1);
    });

    it('returns 200 with status filter', async () => {
      setupDbResults([], [{ count: 0 }]);

      const res = await app.inject({
        method: 'GET',
        url: '/reservations?status=active',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('returns 200 with stationId filter', async () => {
      setupDbResults([], [{ count: 0 }]);

      const res = await app.inject({
        method: 'GET',
        url: `/reservations?stationId=${VALID_STATION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('returns total 0 when count result is empty', async () => {
      setupDbResults([], []);

      const res = await app.inject({
        method: 'GET',
        url: '/reservations',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(0);
    });
  });

  // ------------------------------------------------------------------
  // GET /v1/reservations/:id
  // ------------------------------------------------------------------
  describe('GET /v1/reservations/:id', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${VALID_RESERVATION_ID}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when not found', async () => {
      setupDbResults([]);

      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('RESERVATION_NOT_FOUND');
    });

    it('returns 200 when found', async () => {
      const reservation = makeReservation();
      setupDbResults([reservation]);

      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(VALID_RESERVATION_ID);
    });

    it('TC-T3-27 returns the gross cancellation fee of the reservation terms', async () => {
      const reservation = makeReservation({
        status: 'active',
        driverId: VALID_DRIVER_ID,
        feeTaxBasis: 'net',
        feeTaxRate: '0.19',
        feePerMinute: null,
        feeCancellationCents: 300,
      });
      setupDbResults([reservation]);
      vi.mocked(resolveReservationFeeTerms).mockResolvedValueOnce({
        basis: 'net',
        taxRate: '0.19',
        feePerMinute: null,
        cancellationFeeCents: 300,
      });

      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // 300 net at 19 %: the operator sees the 357 the driver is charged.
      expect(body.cancellationFee).toEqual({ grossCents: 357, taxRate: 0.19 });
      expect(body).not.toHaveProperty('feeCancellationCents');
      expect(resolveReservationFeeTerms).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'active',
          driverId: VALID_DRIVER_ID,
          feeTaxBasis: 'net',
          feeTaxRate: '0.19',
          feeCancellationCents: 300,
        }),
      );
    });

    it('returns no cancellation fee for a closed reservation', async () => {
      setupDbResults([makeReservation({ status: 'cancelled' })]);

      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().cancellationFee).toBeNull();
    });

    it('includes evseOcppId in detail response', async () => {
      const reservation = makeReservation({ evseOcppId: 2 });
      setupDbResults([reservation]);

      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.evseOcppId).toBe(2);
    });

    it('returns evseOcppId as null when no EVSE assigned', async () => {
      const reservation = makeReservation({ evseOcppId: null });
      setupDbResults([reservation]);

      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.evseOcppId).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // POST /v1/reservations
  // ------------------------------------------------------------------
  describe('POST /v1/reservations', () => {
    const validBody = { stationId: 'CS-001', expiresAt: '2030-01-01T00:00:00Z' };
    const stationRow = {
      id: VALID_STATION_ID,
      stationId: 'CS-001',
      siteId: 'sit_000000000001',
      isOnline: true,
      reservationsEnabled: true,
      disabledReason: null,
      firmwareState: null,
      reportedStatus: null,
    };
    const createdRow = (overrides: Record<string, unknown> = {}) => ({
      id: VALID_RESERVATION_ID,
      reservationId: 7,
      stationId: VALID_STATION_ID,
      evseId: null,
      driverId: VALID_DRIVER_ID,
      tokenId: null,
      status: 'active',
      startsAt: null,
      expiresAt: new Date('2030-01-01T00:00:00Z'),
      createdAt: new Date('2024-01-01T00:00:00Z'),
      ...overrides,
    });

    function post(payload: Record<string, unknown> = validBody) {
      return app.inject({
        method: 'POST',
        url: '/reservations',
        payload,
        headers: { authorization: `Bearer ${token}` },
      });
    }

    function commandsPublished(): Array<{ action: string; payload: Record<string, unknown> }> {
      return mockPublish.mock.calls
        .filter((c) => c[0] === 'ocpp_commands')
        .map((c) => JSON.parse(c[1]) as { action: string; payload: Record<string, unknown> });
    }

    it('returns 401 without token', async () => {
      const res = await app.inject({ method: 'POST', url: '/reservations', payload: validBody });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when station not found', async () => {
      setupDbResults([]);
      const res = await post();
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('STATION_NOT_FOUND');
      expect(mockCreateReservation).not.toHaveBeenCalled();
    });

    it('returns 404 when the station is on a site the user cannot access', async () => {
      const { getUserSiteIds } = await import('../lib/site-access.js');
      vi.mocked(getUserSiteIds).mockResolvedValueOnce(['sit_other']);
      setupDbResults([stationRow]);
      const res = await post();
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('STATION_NOT_FOUND');
      expect(mockCreateReservation).not.toHaveBeenCalled();
    });

    it('creates through the service as the operator and answers the accepted row', async () => {
      setupDbResults([stationRow]);
      mockCreateReservation.mockResolvedValueOnce(createdRow());
      const res = await post({
        ...validBody,
        evseId: 2,
        driverId: VALID_DRIVER_ID,
        tokenId: 'dtk_000000000001',
        startsAt: '2029-12-31T23:00:00Z',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(VALID_RESERVATION_ID);
      expect(mockCreateReservation).toHaveBeenCalledWith(
        expect.objectContaining({
          station: stationRow,
          evseOcppId: 2,
          driverId: VALID_DRIVER_ID,
          tokenId: 'dtk_000000000001',
          startsAt: new Date('2029-12-31T23:00:00Z'),
          expiresAt: new Date('2030-01-01T00:00:00Z'),
          actor: { kind: 'operator', userId: 'test-id' },
        }),
      );
      // The route builds no ReserveNow payload: the service sends it.
      expect(mockSendCommand).toHaveBeenCalledWith(
        'CS-001',
        'ReserveNow',
        expect.objectContaining({ id: 7, idToken: { idToken: VALID_DRIVER_ID, type: 'Central' } }),
      );
      expect(mockNotify).toHaveBeenCalledWith(
        'reservation.Created',
        expect.objectContaining({ reservationOcppId: 7, stationOcppId: 'CS-001' }),
        {},
        expect.anything(),
      );
    });

    it('answers a scheduled row without waiting for the station', async () => {
      setupDbResults([stationRow]);
      mockCreateReservation.mockResolvedValueOnce(
        createdRow({ status: 'scheduled', startsAt: new Date(Date.now() + 3_600_000) }),
      );
      const res = await post();
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('scheduled');
      expect(mockSendCommand).not.toHaveBeenCalled();
      expect(mockPublish).toHaveBeenCalledWith('reservation_schedule', expect.any(String));
    });

    it('passes service errors through with their status and code', async () => {
      setupDbResults([stationRow]);
      mockCreateReservation.mockRejectedValueOnce(
        new AppError('A reservation already exists', 409, 'RESERVATION_CONFLICT'),
      );
      const res = await post();
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('RESERVATION_CONFLICT');
      expect(mockSendCommand).not.toHaveBeenCalled();
    });

    it('returns 409 with the maintenance window details on a maintenance conflict', async () => {
      setupDbResults([stationRow]);
      mockCreateReservation.mockRejectedValueOnce(
        new MaintenanceConflictError({
          id: 'mnt_000000000001',
          plannedStartAt: new Date('2030-01-01T00:00:00Z'),
          plannedEndAt: new Date('2030-01-01T01:00:00Z'),
        } as never),
      );
      const res = await post();
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual(
        expect.objectContaining({
          code: 'RESERVATION_DURING_MAINTENANCE',
          maintenanceEventId: 'mnt_000000000001',
        }),
      );
    });

    it('returns 400 RESERVATION_REJECTED when the station answers Occupied', async () => {
      setupDbResults([stationRow]);
      mockCreateReservation.mockResolvedValueOnce(createdRow());
      mockSendCommand.mockResolvedValueOnce({ commandId: 'c1', response: { status: 'Occupied' } });
      const res = await post();
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Station rejected reservation: Occupied',
        code: 'RESERVATION_REJECTED',
      });
      expect(mockApplyCancellation).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: 'system',
          reason: 'station_rejected_occupied',
          auditAction: 'station_rejected',
          chargeFee: false,
        }),
      );
      // The station answered: no CancelReservation follows.
      expect(commandsPublished()).toEqual([]);
    });

    it('TC-RES-04: a ReserveNow timeout cancels in the database, then publishes CancelReservation', async () => {
      setupDbResults([stationRow]);
      mockCreateReservation.mockResolvedValueOnce(createdRow());
      const order: string[] = [];
      mockSendCommand.mockResolvedValueOnce({
        commandId: 'c1',
        error: 'No response within 35s',
        timedOut: true,
      });
      mockApplyCancellation.mockImplementationOnce(() => {
        order.push('cancel');
        return Promise.resolve({
          feeChargedCents: 0,
          cancelled: true,
          feeChargeFailed: false,
          feeCurrency: null,
          statusBefore: 'active',
        });
      });
      mockPublish.mockImplementation((channel: string) => {
        if (channel === 'ocpp_commands') order.push('publish');
        return Promise.resolve(undefined);
      });

      const res = await post();

      expect(res.statusCode).toBe(504);
      expect(res.json()).toEqual({ error: 'No response within 35s', code: 'RESERVATION_TIMEOUT' });
      expect(mockApplyCancellation).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationDbId: VALID_RESERVATION_ID,
          actor: 'system',
          reason: 'station_no_response',
          auditAction: 'station_rejected',
          chargeFee: false,
        }),
      );
      expect(commandsPublished()).toEqual([
        expect.objectContaining({ action: 'CancelReservation', payload: { reservationId: 7 } }),
      ]);
      expect(order).toEqual(['cancel', 'publish']);
      expect(mockNotify).toHaveBeenCalledWith(
        'reservation.Cancelled',
        expect.objectContaining({ reservationOcppId: 7 }),
        expect.objectContaining({ stationNoResponse: true }),
        expect.anything(),
      );
    });

    it('returns 502 RESERVATION_REJECTED when the command cannot be sent', async () => {
      setupDbResults([stationRow]);
      mockCreateReservation.mockResolvedValueOnce(createdRow());
      mockSendCommand.mockResolvedValueOnce({
        commandId: 'c1',
        error: 'Internal error sending command',
      });
      const res = await post();
      expect(res.statusCode).toBe(502);
      expect(res.json().code).toBe('RESERVATION_REJECTED');
      expect(mockApplyCancellation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'station_no_response' }),
      );
    });

    it('does not notify when another path already cancelled the failed reservation', async () => {
      setupDbResults([stationRow]);
      mockCreateReservation.mockResolvedValueOnce(createdRow());
      mockSendCommand.mockResolvedValueOnce({ commandId: 'c1', response: { status: 'Rejected' } });
      mockApplyCancellation.mockResolvedValueOnce({
        feeChargedCents: 0,
        cancelled: false,
        feeChargeFailed: false,
        feeCurrency: null,
        statusBefore: null,
      });
      const res = await post();
      expect(res.statusCode).toBe(400);
      expect(mockNotify).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // DELETE /v1/reservations/:id
  // ------------------------------------------------------------------
  describe('DELETE /v1/reservations/:id', () => {
    const activeRow = (overrides: Record<string, unknown> = {}) => ({
      id: VALID_RESERVATION_ID,
      reservationId: 7,
      status: 'active',
      stationOcppId: 'CS-001',
      siteId: null,
      driverId: VALID_DRIVER_ID,
      startsAt: null,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      ...overrides,
    });

    function del(payload?: Record<string, unknown>) {
      return app.inject({
        method: 'DELETE',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        ...(payload != null ? { payload } : {}),
        headers: { authorization: `Bearer ${token}` },
      });
    }

    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/reservations/${VALID_RESERVATION_ID}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when not found', async () => {
      setupDbResults([]);
      const res = await del();
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('RESERVATION_NOT_FOUND');
    });

    it('returns 404 when the site is not accessible', async () => {
      const { getUserSiteIds } = await import('../lib/site-access.js');
      vi.mocked(getUserSiteIds).mockResolvedValueOnce(['sit_other']);
      setupDbResults([activeRow({ siteId: 'sit_000000000001' })]);
      const res = await del();
      expect(res.statusCode).toBe(404);
      expect(mockApplyCancellation).not.toHaveBeenCalled();
    });

    it('returns 400 when reservation is not active', async () => {
      setupDbResults([activeRow({ status: 'used' })]);
      const res = await del();
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('RESERVATION_NOT_ACTIVE');
    });

    it('returns 400 when reason is not a string', async () => {
      const res = await del({ reason: 42 });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when reason exceeds 500 characters', async () => {
      const res = await del({ reason: 'x'.repeat(501) });
      expect(res.statusCode).toBe(400);
    });

    it('TC-RES-09: cancels in the database before sending CancelReservation', async () => {
      setupDbResults([activeRow()]);
      const order: string[] = [];
      mockApplyCancellation.mockImplementationOnce(() => {
        order.push('cancel');
        return Promise.resolve({
          feeChargedCents: 0,
          cancelled: true,
          feeChargeFailed: false,
          feeCurrency: null,
          statusBefore: 'active',
        });
      });
      mockSendCommand.mockImplementationOnce(() => {
        order.push('CancelReservation');
        return Promise.resolve({ commandId: 'c1', response: { status: 'Accepted' } });
      });

      const res = await del({ chargeCancellationFee: true, reason: 'driver called' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'cancelled', cancellationFeeChargedCents: 0 });
      expect(order).toEqual(['cancel', 'CancelReservation']);
      expect(mockApplyCancellation).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationDbId: VALID_RESERVATION_ID,
          actor: 'operator',
          actorUserId: 'test-id',
          reason: 'operator_manual',
          note: 'driver called',
          chargeFee: true,
        }),
      );
      expect(mockSendCommand).toHaveBeenCalledWith('CS-001', 'CancelReservation', {
        reservationId: 7,
      });
    });

    it('TC-RES-09: sends no CancelReservation when the winner was scheduled', async () => {
      setupDbResults([activeRow({ status: 'scheduled' })]);
      mockApplyCancellation.mockResolvedValueOnce({
        feeChargedCents: 0,
        cancelled: true,
        feeChargeFailed: false,
        feeCurrency: null,
        statusBefore: 'scheduled',
      });
      const res = await del();
      expect(res.statusCode).toBe(200);
      expect(mockSendCommand).not.toHaveBeenCalled();
    });

    it('TC-RES-09: sends no CancelReservation and no notice when another cancel won', async () => {
      setupDbResults([activeRow()]);
      mockApplyCancellation.mockResolvedValueOnce({
        feeChargedCents: 0,
        cancelled: false,
        feeChargeFailed: false,
        feeCurrency: null,
        statusBefore: null,
      });
      const res = await del();
      expect(res.statusCode).toBe(200);
      expect(mockSendCommand).not.toHaveBeenCalled();
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('TC-RES-10: a Rejected CancelReservation audits station_cancel_failed and warns', async () => {
      setupDbResults([activeRow()]);
      mockSendCommand.mockResolvedValueOnce({ commandId: 'c1', response: { status: 'Rejected' } });
      const res = await del();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'cancelled',
        cancellationFeeChargedCents: 0,
        warning: 'station_cancel_failed',
      });
      expect(writeReservationAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationId: VALID_RESERVATION_ID,
          action: 'station_cancel_failed',
          actor: 'system',
          reason: 'station_rejected',
        }),
        undefined,
        expect.anything(),
      );
    });

    it('TC-RES-10: a timed-out CancelReservation audits station_cancel_failed and warns', async () => {
      setupDbResults([activeRow()]);
      mockSendCommand.mockResolvedValueOnce({
        commandId: 'c1',
        error: 'No response within 35s',
        timedOut: true,
      });
      const res = await del();
      expect(res.statusCode).toBe(200);
      expect(res.json().warning).toBe('station_cancel_failed');
      expect(writeReservationAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'station_cancel_failed',
          reason: 'station_no_response',
          notes: 'No response within 35s',
        }),
        undefined,
        expect.anything(),
      );
    });

    it('notifies the driver with the formatted fee and flags a failed charge', async () => {
      setupDbResults([activeRow()]);
      mockApplyCancellation.mockResolvedValueOnce({
        feeChargedCents: 357,
        cancelled: true,
        feeChargeFailed: true,
        feeCurrency: 'EUR',
        statusBefore: 'active',
      });
      const res = await del({ chargeCancellationFee: true });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'cancelled',
        cancellationFeeChargedCents: 357,
        feeChargeFailed: true,
      });
      expect(mockApplyCancellation).toHaveBeenCalledWith(
        expect.objectContaining({ payments: { registry: 'registry', logger: expect.anything() } }),
      );
      expect(mockNotify).toHaveBeenCalledWith(
        'reservation.Cancelled',
        {
          reservationDbId: VALID_RESERVATION_ID,
          reservationOcppId: 7,
          stationOcppId: 'CS-001',
          driverId: VALID_DRIVER_ID,
        },
        expect.objectContaining({
          cancellationFeeCents: 357,
          currency: 'EUR',
          cancellationFeeFormatted: expect.objectContaining({ cents: 357, currency: 'EUR' }),
        }),
        expect.anything(),
      );
    });
  });

  // ------------------------------------------------------------------
  // PATCH /v1/reservations/:id
  // ------------------------------------------------------------------
  describe('PATCH /v1/reservations/:id', () => {
    function patch(payload: Record<string, unknown>) {
      return app.inject({
        method: 'PATCH',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        payload,
        headers: { authorization: `Bearer ${token}` },
      });
    }

    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/reservations/${VALID_RESERVATION_ID}`,
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when not found', async () => {
      setupDbResults([]);
      const res = await patch({ expiresAt: '2030-01-01T00:00:00Z' });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('RESERVATION_NOT_FOUND');
      expect(mockUpdateReservation).not.toHaveBeenCalled();
    });

    it('returns 404 when the station site is not accessible', async () => {
      const { getUserSiteIds } = await import('../lib/site-access.js');
      vi.mocked(getUserSiteIds).mockResolvedValueOnce(['sit_other']);
      setupDbResults([{ id: VALID_RESERVATION_ID, siteId: 'sit_000000000001' }]);
      const res = await patch({ expiresAt: '2030-01-01T00:00:00Z' });
      expect(res.statusCode).toBe(404);
      expect(mockUpdateReservation).not.toHaveBeenCalled();
    });

    it('TC-RES-18: edits through the service and answers the re-fetched detail', async () => {
      setupDbResults(
        [{ id: VALID_RESERVATION_ID, siteId: null }],
        [makeReservation({ evseOcppId: 2, driverId: VALID_DRIVER_ID })],
      );
      mockUpdateReservation.mockResolvedValueOnce({});
      const res = await patch({
        driverId: VALID_DRIVER_ID,
        evseId: 2,
        expiresAt: '2030-01-01T00:00:00Z',
        tokenId: null,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().evseOcppId).toBe(2);
      expect(mockUpdateReservation).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationDbId: VALID_RESERVATION_ID,
          changes: {
            driverId: VALID_DRIVER_ID,
            evseOcppId: 2,
            expiresAt: new Date('2030-01-01T00:00:00Z'),
            tokenId: null,
          },
          actor: { kind: 'operator', userId: 'test-id' },
        }),
      );
    });

    it('TC-RES-18: leaves unsent fields undefined so the service keeps them', async () => {
      setupDbResults([{ id: VALID_RESERVATION_ID, siteId: null }], [makeReservation()]);
      mockUpdateReservation.mockResolvedValueOnce({});
      await patch({ expiresAt: '2030-01-01T00:00:00Z' });
      const changes = (mockUpdateReservation.mock.calls[0]?.[0] as { changes: object }).changes;
      expect(changes).toEqual({
        driverId: undefined,
        evseOcppId: undefined,
        expiresAt: new Date('2030-01-01T00:00:00Z'),
        tokenId: undefined,
      });
    });

    it.each([
      [409, 'RESERVATION_CONFLICT'],
      [409, 'RESERVATION_NOT_ACTIVE'],
      [400, 'RESERVATION_NOT_ACTIVE'],
      [400, 'RESERVATION_TOO_LONG'],
      [502, 'RESERVATION_REJECTED'],
      [504, 'RESERVATION_TIMEOUT'],
      [404, 'EVSE_NOT_FOUND'],
    ])('TC-RES-18: answers %i %s from the service', async (status, code) => {
      setupDbResults([{ id: VALID_RESERVATION_ID, siteId: null }]);
      mockUpdateReservation.mockRejectedValueOnce(new AppError('refused', status, code));
      const res = await patch({ expiresAt: '2030-01-01T00:00:00Z' });
      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ error: 'refused', code });
    });
  });

  // ------------------------------------------------------------------
  // POST /v1/reservations/:id/reassign
  // ------------------------------------------------------------------
  describe('POST /v1/reservations/:id/reassign', () => {
    const newStationRow = {
      id: 'sta_000000000002',
      stationId: 'STATION-B',
      siteId: null,
      isOnline: true,
      reservationsEnabled: true,
      disabledReason: null,
      firmwareState: null,
      reportedStatus: null,
    };

    function reassign(payload: Record<string, unknown> = { newStationOcppId: 'STATION-B' }) {
      return app.inject({
        method: 'POST',
        url: `/reservations/${VALID_RESERVATION_ID}/reassign`,
        payload,
        headers: { authorization: `Bearer ${token}` },
      });
    }

    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/reservations/${VALID_RESERVATION_ID}/reassign`,
        payload: { newStationOcppId: 'STATION-B' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when reservation is not found', async () => {
      setupDbResults([]);
      const res = await reassign();
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('RESERVATION_NOT_FOUND');
    });

    it('returns 404 when the reservation site is not accessible', async () => {
      const { getUserSiteIds } = await import('../lib/site-access.js');
      vi.mocked(getUserSiteIds).mockResolvedValueOnce(['sit_other']);
      setupDbResults([{ id: VALID_RESERVATION_ID, siteId: 'sit_000000000001' }]);
      const res = await reassign();
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('RESERVATION_NOT_FOUND');
    });

    it('returns 404 when the new station does not exist', async () => {
      setupDbResults([{ id: VALID_RESERVATION_ID, siteId: null }], []);
      const res = await reassign();
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 404 STATION_NOT_FOUND when the new station site is not accessible', async () => {
      const { getUserSiteIds } = await import('../lib/site-access.js');
      vi.mocked(getUserSiteIds).mockResolvedValueOnce(['sit_000000000001']);
      setupDbResults(
        [{ id: VALID_RESERVATION_ID, siteId: 'sit_000000000001' }],
        [{ ...newStationRow, siteId: 'sit_other' }],
      );
      const res = await reassign();
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('STATION_NOT_FOUND');
      expect(mockReassignReservation).not.toHaveBeenCalled();
    });

    it('TC-RES-19: moves the reservation through the service', async () => {
      setupDbResults([{ id: VALID_RESERVATION_ID, siteId: null }], [newStationRow]);
      mockReassignReservation.mockResolvedValueOnce({
        reservation: {},
        previousStationOcppId: 'CS-001',
      });
      const res = await reassign({ newStationOcppId: 'STATION-B', newEvseId: 2 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'reassigned', newStationOcppId: 'STATION-B' });
      expect(mockReassignReservation).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationDbId: VALID_RESERVATION_ID,
          newStation: newStationRow,
          newEvseOcppId: 2,
          actor: { kind: 'operator', userId: 'test-id' },
        }),
      );
    });

    it.each([
      [409, 'RESERVATION_CONFLICT'],
      [409, 'RESERVATION_NOT_ACTIVE'],
      [409, 'EVSE_IN_USE'],
      [400, 'RESERVATION_REJECTED'],
      [400, 'STATION_OFFLINE'],
      [403, 'RESERVATION_DISABLED'],
    ])('TC-RES-19: answers %i %s from the service', async (status, code) => {
      setupDbResults([{ id: VALID_RESERVATION_ID, siteId: null }], [newStationRow]);
      mockReassignReservation.mockRejectedValueOnce(new AppError('refused', status, code));
      const res = await reassign();
      expect(res.statusCode).toBe(status);
      expect(res.json().code).toBe(code);
    });

    it('returns 409 with the window details on a maintenance conflict at the new station', async () => {
      setupDbResults([{ id: VALID_RESERVATION_ID, siteId: null }], [newStationRow]);
      mockReassignReservation.mockRejectedValueOnce(
        new MaintenanceConflictError({
          id: 'mnt_000000000001',
          plannedStartAt: new Date('2030-01-01T00:00:00Z'),
          plannedEndAt: new Date('2030-01-01T01:00:00Z'),
        } as never),
      );
      const res = await reassign();
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('RESERVATION_DURING_MAINTENANCE');
    });
  });
});
