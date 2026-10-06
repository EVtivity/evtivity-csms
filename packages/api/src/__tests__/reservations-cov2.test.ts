// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// DB mock helpers: each awaited query chain consumes the next queued result.
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

const { MockMaintenanceConflictError } = vi.hoisted(() => {
  class MockMaintenanceConflictError extends Error {
    public readonly code = 'RESERVATION_DURING_MAINTENANCE';
    public readonly statusCode = 409;
    public readonly details = {
      maintenanceEventId: 'mnt_000000000001',
      plannedStartAt: '2030-01-01T00:00:00.000Z',
      plannedEndAt: '2030-01-01T04:00:00.000Z',
    };
    constructor() {
      super('Reservation falls within a scheduled maintenance window');
    }
  }
  return { MockMaintenanceConflictError };
});

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

vi.mock('@evtivity/database', () => ({
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
  getReservationSettings: vi.fn(),
  writeReservationAudit: vi.fn().mockResolvedValue(undefined),
  reservationDiffChanged: vi.fn().mockReturnValue(false),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn((col: unknown, pattern: string) => ({ ilike: pattern })),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
  inArray: vi.fn((col: unknown, values: unknown) => ({ inArray: values })),
  gt: vi.fn(),
  isNull: vi.fn(),
}));

const mockPublish = vi.fn((_channel: string, _message: string) => Promise.resolve(undefined));
vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({ publish: mockPublish, subscribe: vi.fn() })),
  setPubSub: vi.fn(),
}));

const mockGetUserSiteIds = vi.fn();
vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: (...args: unknown[]) => mockGetUserSiteIds(...args),
  invalidateSiteAccessCache: vi.fn(),
}));

const mockSendOcpp = vi.fn();
vi.mock('@evtivity/services/ocpp-command', () => ({
  sendOcppCommandAndWait: (...args: unknown[]) => mockSendOcpp(...args),
}));

const mockApplyCancel = vi.fn();
vi.mock('@evtivity/services/reservation-cancel', () => ({
  applyReservationCancellation: (...args: unknown[]) => mockApplyCancel(...args),
}));

const mockAssertAllowed = vi.fn();
vi.mock('../lib/reservation-eligibility.js', () => ({
  assertReservationsAllowed: (...args: unknown[]) => mockAssertAllowed(...args),
}));

const mockAssertNoMaintenance = vi.fn();
vi.mock('@evtivity/services/maintenance-check', () => ({
  assertNoMaintenanceConflict: (...args: unknown[]) => mockAssertNoMaintenance(...args),
  MaintenanceConflictError: MockMaintenanceConflictError,
}));

vi.mock('../lib/payments.js', () => ({
  paymentContext: vi.fn(() => ({ registry: 'registry' })),
}));

const mockDispatch = vi.fn();
vi.mock('@evtivity/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/lib')>();
  return {
    ...actual,
    dispatchDriverNotification: (...args: unknown[]) => mockDispatch(...args),
  };
});

vi.mock('@evtivity/services/template-dirs', () => ({
  ALL_TEMPLATES_DIRS: [],
}));

import { notificationMoney } from '@evtivity/lib';
import { registerAuth } from '../plugins/auth.js';
import { reservationRoutes } from '../routes/reservations.js';
import {
  db,
  getReservationSettings,
  writeReservationAudit,
  reservationDiffChanged,
} from '@evtivity/database';
import * as drizzleOrmModule from 'drizzle-orm';

const RSV_ID = 'rsv_000000000001';
const DRV_ID = 'drv_000000000001';
const DRV_OTHER = 'drv_000000000002';
const TOKEN_ID = 'dtk_000000000001';
const STATION_DB_ID = 'sta_000000000001';
const SITE_A = 'sit_000000000001';
const SITE_B = 'sit_000000000002';

function inHours(h: number): string {
  return new Date(Date.now() + h * 3_600_000).toISOString();
}

function makeStation(overrides: Record<string, unknown> = {}) {
  return {
    id: STATION_DB_ID,
    siteId: SITE_A,
    isOnline: true,
    reservationsEnabled: true,
    disabledReason: null,
    firmwareState: null,
    reportedStatus: null,
    ...overrides,
  };
}

function makeInserted(overrides: Record<string, unknown> = {}) {
  return {
    id: RSV_ID,
    reservationId: 6,
    stationId: STATION_DB_ID,
    evseId: null,
    driverId: null,
    tokenId: null,
    status: 'active',
    startsAt: null,
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: RSV_ID,
    reservationId: 1,
    stationId: STATION_DB_ID,
    stationOcppId: 'CS-001',
    siteId: SITE_A,
    siteName: 'Site A',
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

function insertedValues(): Record<string, unknown> {
  const chain = vi.mocked(db.insert).mock.results[0]?.value as {
    values: { mock: { calls: unknown[][] } };
  };
  return chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
}

function updateSetArgs(callIndex = 0): Record<string, unknown> {
  const chain = vi.mocked(db.update).mock.results[callIndex]?.value as {
    set: { mock: { calls: unknown[][] } };
  };
  return chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe('Reservation routes (additional coverage)', () => {
  let app: FastifyInstance;
  let token: string;
  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(reservationRoutes);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    vi.mocked(db.insert).mockClear();
    vi.mocked(db.update).mockClear();
    vi.mocked(db.select).mockClear();
    vi.mocked(db.insert).mockImplementation(() => makeChain() as never);
    mockGetUserSiteIds.mockReset().mockResolvedValue(null);
    mockSendOcpp.mockReset().mockResolvedValue({ response: { status: 'Accepted' } });
    mockApplyCancel.mockReset().mockResolvedValue({
      cancelled: true,
      feeChargedCents: 0,
      feeChargeFailed: false,
      feeCurrency: null,
    });
    mockAssertAllowed.mockReset().mockResolvedValue(undefined);
    mockAssertNoMaintenance.mockReset().mockResolvedValue(undefined);
    mockDispatch.mockReset();
    mockPublish.mockClear();
    vi.mocked(writeReservationAudit).mockClear();
    vi.mocked(reservationDiffChanged).mockReset().mockReturnValue(false);
    vi.mocked(getReservationSettings).mockResolvedValue({
      enabled: true,
      bufferMinutes: 0,
      cancellationWindowMinutes: 0,
      cancellationFeeCents: 0,
      maxHours: 0,
      activeSessionCheckHours: 3,
    });
  });

  describe('GET /reservations', () => {
    it('applies the search pattern and siteId filter', async () => {
      const { ilike, eq } = drizzleOrmModule;
      vi.mocked(ilike).mockClear();
      vi.mocked(eq).mockClear();
      setupDbResults([], [{ count: 0 }]);
      const res = await app.inject({
        method: 'GET',
        url: `/reservations?search=CS-0&siteId=${SITE_A}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(vi.mocked(ilike).mock.calls.map((c) => c[1])).toEqual([
        '%CS-0%',
        '%CS-0%',
        '%CS-0%',
        '%CS-0%',
      ]);
      expect(vi.mocked(eq)).toHaveBeenCalledWith(undefined, SITE_A);
    });

    it('returns an empty page without querying when the user has no sites', async () => {
      mockGetUserSiteIds.mockResolvedValue([]);
      const res = await app.inject({ method: 'GET', url: '/reservations', headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(db.select).not.toHaveBeenCalled();
    });

    it('restricts the query to the user sites', async () => {
      const { inArray } = drizzleOrmModule;
      vi.mocked(inArray).mockClear();
      mockGetUserSiteIds.mockResolvedValue([SITE_A]);
      setupDbResults([], [{ count: 0 }]);
      const res = await app.inject({ method: 'GET', url: '/reservations', headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(vi.mocked(inArray).mock.calls.some((c) => (c[1] as string[])[0] === SITE_A)).toBe(
        true,
      );
    });
  });

  describe('GET /reservations/:id', () => {
    it('returns 404 when the reservation belongs to a site the user cannot access', async () => {
      mockGetUserSiteIds.mockResolvedValue([SITE_B]);
      setupDbResults([makeDetail()]);
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${RSV_ID}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('RESERVATION_NOT_FOUND');
    });
  });

  describe('GET /reservations/:id/audit', () => {
    it('returns 404 when the reservation does not exist', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${RSV_ID}/audit`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('RESERVATION_NOT_FOUND');
    });

    it('returns 404 when the site is not accessible', async () => {
      mockGetUserSiteIds.mockResolvedValue([SITE_B]);
      setupDbResults([{ id: RSV_ID, siteId: SITE_A }]);
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${RSV_ID}/audit`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(404);
    });

    it('projects before/after JSONB into the legacy columns', async () => {
      setupDbResults(
        [{ id: RSV_ID, siteId: SITE_A }],
        [
          {
            id: 10,
            reservationId: RSV_ID,
            action: 'updated',
            actor: 'operator',
            actorUserId: 'usr_000000000001',
            actorUserName: 'Ops User',
            actorDriverId: null,
            actorDriverName: null,
            before: {
              driverId: DRV_ID,
              tokenId: TOKEN_ID,
              evseId: 'evs_000000000001',
              status: 'active',
              expiresAt: '2030-01-01T00:00:00.000Z',
            },
            after: {
              driverId: DRV_OTHER,
              status: 'active',
              expiresAt: 'not-a-date',
            },
            notes: 'moved',
            createdAt: new Date('2024-02-01T00:00:00Z'),
          },
          {
            id: 9,
            reservationId: RSV_ID,
            action: 'created',
            actor: 'system',
            actorUserId: null,
            actorUserName: null,
            actorDriverId: null,
            actorDriverName: null,
            before: null,
            after: { expiresAt: new Date('2031-01-01T00:00:00Z') },
            notes: null,
            createdAt: new Date('2024-01-01T00:00:00Z'),
          },
        ],
        [{ count: 2 }],
      );
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${RSV_ID}/audit?page=1&limit=10`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(2);
      expect(body.data[0]).toMatchObject({
        id: 10,
        action: 'updated',
        actorUserName: 'Ops User',
        driverIdBefore: DRV_ID,
        driverIdAfter: DRV_OTHER,
        tokenIdBefore: TOKEN_ID,
        tokenIdAfter: null,
        evseIdBefore: 'evs_000000000001',
        evseIdAfter: null,
        statusBefore: 'active',
        statusAfter: 'active',
        expiresAtBefore: '2030-01-01T00:00:00.000Z',
        expiresAtAfter: null,
        notes: 'moved',
      });
      expect(body.data[1]).toMatchObject({
        id: 9,
        driverIdBefore: null,
        statusBefore: null,
        expiresAtBefore: null,
        expiresAtAfter: '2031-01-01T00:00:00.000Z',
      });
    });

    it('returns total 0 when the count query is empty', async () => {
      setupDbResults([{ id: RSV_ID, siteId: null }], [], []);
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${RSV_ID}/audit`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
    });
  });

  describe('GET /reservations/:id/commands', () => {
    it('returns 404 when the reservation does not exist', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${RSV_ID}/commands`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('RESERVATION_NOT_FOUND');
    });

    it('returns 404 when the site is not accessible', async () => {
      mockGetUserSiteIds.mockResolvedValue([SITE_B]);
      setupDbResults([{ stationId: STATION_DB_ID, reservationId: 1, siteId: SITE_A }]);
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${RSV_ID}/commands`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns an empty page when no CALL logs match', async () => {
      setupDbResults([{ stationId: STATION_DB_ID, reservationId: 1, siteId: SITE_A }], []);
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${RSV_ID}/commands`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
    });

    it('pairs CALL and RESULT messages and computes response times', async () => {
      const callAt = new Date('2024-01-01T00:00:00.000Z');
      setupDbResults(
        [{ stationId: STATION_DB_ID, reservationId: 1, siteId: SITE_A }],
        [{ messageId: 'm1' }, { messageId: 'm2' }],
        [
          {
            id: 3,
            stationId: STATION_DB_ID,
            stationOcppId: 'CS-001',
            direction: 'inbound',
            messageType: 3,
            messageId: 'm1',
            action: null,
            payload: { status: 'Accepted' },
            errorCode: null,
            errorDescription: null,
            createdAt: new Date('2024-01-01T00:00:00.250Z'),
          },
          {
            id: 2,
            stationId: STATION_DB_ID,
            stationOcppId: 'CS-001',
            direction: 'inbound',
            messageType: 4,
            messageId: 'm-unknown',
            action: null,
            payload: {},
            errorCode: 'InternalError',
            errorDescription: 'boom',
            createdAt: new Date('2024-01-01T00:00:01.000Z'),
          },
          {
            id: 1,
            stationId: STATION_DB_ID,
            stationOcppId: 'CS-001',
            direction: 'outbound',
            messageType: 2,
            messageId: 'm1',
            action: 'ReserveNow',
            payload: { id: 1 },
            errorCode: null,
            errorDescription: null,
            createdAt: callAt,
          },
        ],
        [{ count: 3 }],
      );
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${RSV_ID}/commands`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(3);
      expect(body.data.map((d: { id: number; responseTimeMs: number | null }) => d)).toEqual([
        expect.objectContaining({ id: 3, responseTimeMs: 250 }),
        expect.objectContaining({ id: 2, responseTimeMs: null, errorCode: 'InternalError' }),
        expect.objectContaining({ id: 1, responseTimeMs: null, action: 'ReserveNow' }),
      ]);
    });

    it('returns total 0 when the count query is empty', async () => {
      setupDbResults(
        [{ stationId: STATION_DB_ID, reservationId: 1, siteId: null }],
        [{ messageId: 'm1' }],
        [],
        [],
      );
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${RSV_ID}/commands`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
    });
  });

  describe('POST /reservations', () => {
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/reservations', headers: auth(), payload });

    it('returns 404 when the station is on a site the user cannot access', async () => {
      mockGetUserSiteIds.mockResolvedValue([SITE_B]);
      setupDbResults([makeStation()]);
      const res = await post({ stationId: 'CS-001', expiresAt: inHours(1) });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('STATION_NOT_FOUND');
      expect(mockAssertNoMaintenance).not.toHaveBeenCalled();
    });

    it('returns 409 with the maintenance window details on a maintenance conflict', async () => {
      mockAssertNoMaintenance.mockRejectedValue(new MockMaintenanceConflictError());
      setupDbResults([makeStation()]);
      const res = await post({ stationId: 'CS-001', expiresAt: inHours(1) });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        code: 'RESERVATION_DURING_MAINTENANCE',
        maintenanceEventId: 'mnt_000000000001',
        plannedStartAt: '2030-01-01T00:00:00.000Z',
      });
    });

    it('rethrows unexpected maintenance check errors as 500', async () => {
      mockAssertNoMaintenance.mockRejectedValue(new Error('db down'));
      setupDbResults([makeStation()]);
      const res = await post({ stationId: 'CS-001', expiresAt: inHours(1) });
      expect(res.statusCode).toBe(500);
    });

    it('returns 400 RESERVATION_STARTS_IN_PAST for a start more than 60s ago', async () => {
      setupDbResults([makeStation()]);
      const res = await post({
        stationId: 'CS-001',
        startsAt: inHours(-0.5),
        expiresAt: inHours(1),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('RESERVATION_STARTS_IN_PAST');
    });

    it('returns 400 RESERVATION_TOO_LONG when the window exceeds maxHours', async () => {
      vi.mocked(getReservationSettings).mockResolvedValue({
        enabled: true,
        bufferMinutes: 0,
        cancellationWindowMinutes: 0,
        cancellationFeeCents: 0,
        maxHours: 2,
        activeSessionCheckHours: 3,
      });
      setupDbResults([makeStation()]);
      const res = await post({ stationId: 'CS-001', expiresAt: inHours(5) });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Reservation cannot exceed 2 hours',
        code: 'RESERVATION_TOO_LONG',
      });
    });

    it('maps an eligibility error to its status and code', async () => {
      mockAssertAllowed.mockRejectedValue(
        Object.assign(new Error('Station is unavailable'), {
          statusCode: 409,
          code: 'STATION_UNAVAILABLE',
        }),
      );
      setupDbResults([makeStation()]);
      const res = await post({ stationId: 'CS-001', expiresAt: inHours(1) });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'Station is unavailable', code: 'STATION_UNAVAILABLE' });
    });

    it('returns 409 EVSE_IN_USE for a station-wide request with a busy connector', async () => {
      setupDbResults([makeStation()], [{ status: 'occupied' }]);
      const res = await post({ stationId: 'CS-001', expiresAt: inHours(1) });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'Station has no available connector (status: occupied)',
        code: 'EVSE_IN_USE',
      });
    });

    it('returns 409 EVSE_IN_USE naming the EVSE for an EVSE-specific request', async () => {
      setupDbResults([makeStation()], [{ id: 'evs_000000000001' }], [{ status: 'faulted' }]);
      const res = await post({ stationId: 'CS-001', evseId: 1, expiresAt: inHours(1) });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('EVSE is not available (connector status: faulted)');
    });

    it('returns 400 when tokenId is sent without driverId', async () => {
      setupDbResults([makeStation()], [], []);
      const res = await post({ stationId: 'CS-001', tokenId: TOKEN_ID, expiresAt: inHours(1) });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'tokenId requires driverId', code: 'VALIDATION_ERROR' });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('returns 400 when tokenId belongs to another driver', async () => {
      setupDbResults(
        [makeStation()],
        [],
        [],
        [{ id: DRV_ID }],
        [{ id: 'pm_1' }],
        [{ id: TOKEN_ID, driverId: DRV_OTHER }],
      );
      const res = await post({
        stationId: 'CS-001',
        driverId: DRV_ID,
        tokenId: TOKEN_ID,
        expiresAt: inHours(1),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('tokenId does not belong to driver');
    });

    it('returns 400 when tokenId does not exist', async () => {
      setupDbResults([makeStation()], [], [], [{ id: DRV_ID }], [{ id: 'pm_1' }], []);
      const res = await post({
        stationId: 'CS-001',
        driverId: DRV_ID,
        tokenId: TOKEN_ID,
        expiresAt: inHours(1),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('binds a token of the same driver and notifies the driver on Accepted', async () => {
      const expiresAt = inHours(1);
      setupDbResults(
        [makeStation()],
        [],
        [],
        [{ id: DRV_ID }],
        [{ id: 'pm_1' }],
        [{ id: TOKEN_ID, driverId: DRV_ID }],
        [makeInserted({ driverId: DRV_ID, tokenId: TOKEN_ID })],
      );
      const res = await post({
        stationId: 'CS-001',
        driverId: DRV_ID,
        tokenId: TOKEN_ID,
        expiresAt,
      });
      expect(res.statusCode).toBe(200);
      expect(insertedValues()).toMatchObject({
        reservationId: 6,
        driverId: DRV_ID,
        tokenId: TOKEN_ID,
        status: 'active',
      });
      expect(mockSendOcpp).toHaveBeenCalledWith('CS-001', 'ReserveNow', {
        id: 6,
        expiryDateTime: expiresAt,
        idToken: { idToken: DRV_ID, type: 'Central' },
      });
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.anything(),
        'reservation.Created',
        DRV_ID,
        expect.objectContaining({ reservationId: 6, stationId: 'CS-001', expiresAt }),
        [],
        expect.anything(),
      );
    });

    it('returns 500 RESERVATION_CREATE_FAILED with the DB message when the insert throws', async () => {
      vi.mocked(db.insert).mockImplementationOnce(() => {
        throw new Error('duplicate key value violates unique constraint');
      });
      setupDbResults([makeStation()], [], []);
      const res = await post({ stationId: 'CS-001', expiresAt: inHours(1) });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        error: 'duplicate key value violates unique constraint',
        code: 'RESERVATION_CREATE_FAILED',
      });
    });

    it('returns a generic message when the insert throws a non-Error', async () => {
      vi.mocked(db.insert).mockImplementationOnce(
        () =>
          ({
            values: () => ({ returning: vi.fn().mockRejectedValue('boom') }),
          }) as never,
      );
      setupDbResults([makeStation()], [], []);
      const res = await post({ stationId: 'CS-001', expiresAt: inHours(1) });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('Failed to create reservation');
    });

    it('schedules a future reservation through the worker and notifies the driver', async () => {
      const startsAt = inHours(5);
      const expiresAt = inHours(6);
      setupDbResults(
        [makeStation({ isOnline: false })],
        [],
        [{ id: DRV_ID }],
        [{ id: 'pm_1' }],
        [makeInserted({ driverId: DRV_ID, status: 'scheduled' })],
      );
      const res = await post({
        stationId: 'CS-001',
        driverId: DRV_ID,
        startsAt,
        expiresAt,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('scheduled');
      expect(insertedValues()).toMatchObject({ status: 'scheduled' });
      expect(mockSendOcpp).not.toHaveBeenCalled();
      const schedule = mockPublish.mock.calls.find((c) => c[0] === 'reservation_schedule');
      expect(schedule).toBeDefined();
      const msg = JSON.parse(schedule?.[1] ?? '{}') as { reservationDbId: string; delayMs: number };
      expect(msg.reservationDbId).toBe(RSV_ID);
      expect(msg.delayMs).toBeGreaterThan(4.9 * 3_600_000);
      expect(msg.delayMs).toBeLessThanOrEqual(5 * 3_600_000);
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.anything(),
        'reservation.Created',
        DRV_ID,
        expect.objectContaining({ expiresAt }),
        [],
        expect.anything(),
      );
    });

    it('schedules a future operator reservation without notifying anyone', async () => {
      setupDbResults([makeStation()], [], [makeInserted({ status: 'scheduled' })]);
      const res = await post({ stationId: 'CS-001', startsAt: inHours(5), expiresAt: inHours(6) });
      expect(res.statusCode).toBe(200);
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it('rolls back and notifies the driver when ReserveNow fails', async () => {
      setupDbResults(
        [makeStation()],
        [],
        [],
        [{ id: DRV_ID }],
        [{ id: 'pm_1' }],
        [makeInserted({ driverId: DRV_ID })],
      );
      mockSendOcpp.mockResolvedValue({ error: 'Station not connected' });
      const res = await post({ stationId: 'CS-001', driverId: DRV_ID, expiresAt: inHours(1) });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'Station not connected', code: 'RESERVATION_REJECTED' });
      expect(mockApplyCancel).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationDbId: RSV_ID,
          actor: 'system',
          reason: 'station_rejected_other',
          chargeFee: false,
        }),
      );
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.anything(),
        'reservation.Cancelled',
        DRV_ID,
        expect.objectContaining({ cancellationFeeFormatted: '' }),
        [],
        expect.anything(),
      );
    });

    it('does not notify when another path already cancelled the failed reservation', async () => {
      setupDbResults(
        [makeStation()],
        [],
        [],
        [{ id: DRV_ID }],
        [{ id: 'pm_1' }],
        [makeInserted({ driverId: DRV_ID })],
      );
      mockSendOcpp.mockResolvedValue({ error: 'No response within 30s' });
      mockApplyCancel.mockResolvedValue({ cancelled: false, feeChargedCents: 0 });
      const res = await post({ stationId: 'CS-001', driverId: DRV_ID, expiresAt: inHours(1) });
      expect(res.statusCode).toBe(504);
      expect(res.json().code).toBe('RESERVATION_TIMEOUT');
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it('maps an Occupied reply to station_rejected_occupied and notifies the driver', async () => {
      setupDbResults(
        [makeStation()],
        [],
        [],
        [{ id: DRV_ID }],
        [{ id: 'pm_1' }],
        [makeInserted({ driverId: DRV_ID })],
      );
      mockSendOcpp.mockResolvedValue({ response: { status: 'Occupied' } });
      const res = await post({ stationId: 'CS-001', driverId: DRV_ID, expiresAt: inHours(1) });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Station rejected reservation: Occupied',
        code: 'RESERVATION_REJECTED',
      });
      expect(mockApplyCancel).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'station_rejected_occupied' }),
      );
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.anything(),
        'reservation.Cancelled',
        DRV_ID,
        expect.anything(),
        [],
        expect.anything(),
      );
    });

    it('maps other rejections to station_rejected_other', async () => {
      setupDbResults([makeStation()], [], [], [makeInserted()]);
      mockSendOcpp.mockResolvedValue({ response: { status: 'Faulted' } });
      const res = await post({ stationId: 'CS-001', expiresAt: inHours(1) });
      expect(res.statusCode).toBe(400);
      expect(mockApplyCancel).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'station_rejected_other' }),
      );
      expect(mockDispatch).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /reservations/:id', () => {
    const existing = (overrides: Record<string, unknown> = {}) => ({
      id: RSV_ID,
      stationId: STATION_DB_ID,
      evseId: 'evs_000000000001',
      status: 'active',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
      driverId: DRV_ID,
      tokenId: TOKEN_ID,
      ...overrides,
    });
    const patch = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PATCH', url: `/reservations/${RSV_ID}`, headers: auth(), payload });

    it('returns 404 when the station site is not accessible', async () => {
      mockGetUserSiteIds.mockResolvedValue([SITE_B]);
      setupDbResults([existing()], [{ siteId: SITE_A }]);
      const res = await patch({ expiresAt: '2030-02-01T00:00:00Z' });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('RESERVATION_NOT_FOUND');
    });

    it('allows access when the station site is in the user sites', async () => {
      mockGetUserSiteIds.mockResolvedValue([SITE_A]);
      setupDbResults([existing()], [{ siteId: SITE_A }], [], [], [makeDetail()]);
      const res = await patch({ expiresAt: '2030-02-01T00:00:00Z' });
      expect(res.statusCode).toBe(200);
    });

    it('clears the old token when the driver changes and writes an audit row', async () => {
      vi.mocked(reservationDiffChanged).mockReturnValue(true);
      setupDbResults([existing()], [], [makeDetail({ driverId: DRV_OTHER })]);
      const res = await patch({ driverId: DRV_OTHER });
      expect(res.statusCode).toBe(200);
      expect(updateSetArgs()).toMatchObject({ driverId: DRV_OTHER, tokenId: null });
      expect(writeReservationAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationId: RSV_ID,
          action: 'updated',
          driverIdBefore: DRV_ID,
          driverIdAfter: DRV_OTHER,
          tokenIdBefore: TOKEN_ID,
          tokenIdAfter: null,
          evseIdAfter: 'evs_000000000001',
        }),
        undefined,
        expect.anything(),
      );
    });

    it('keeps the token when the same driver is resent', async () => {
      setupDbResults([existing()], [], [makeDetail()]);
      const res = await patch({ driverId: DRV_ID });
      expect(res.statusCode).toBe(200);
      expect(updateSetArgs()).not.toHaveProperty('tokenId');
      expect(writeReservationAudit).not.toHaveBeenCalled();
    });

    it('clears the EVSE for evseId null and runs a station-wide conflict check', async () => {
      vi.mocked(reservationDiffChanged).mockReturnValue(true);
      setupDbResults([existing()], [], [], [makeDetail()]);
      const res = await patch({ evseId: null });
      expect(res.statusCode).toBe(200);
      expect(updateSetArgs()).toMatchObject({ evseId: null });
      expect(writeReservationAudit).toHaveBeenCalledWith(
        expect.objectContaining({ evseIdBefore: 'evs_000000000001', evseIdAfter: null }),
        undefined,
        expect.anything(),
      );
    });

    it('updates expiresAt and checks conflicts against the current EVSE', async () => {
      setupDbResults([existing()], [{ id: 'rsv_000000000009' }]);
      const res = await patch({ expiresAt: '2030-02-01T00:00:00Z' });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('RESERVATION_CONFLICT');
      expect(db.update).not.toHaveBeenCalled();
    });

    it('resolves a new EVSE number to its id', async () => {
      setupDbResults([existing()], [{ id: 'evs_000000000002' }], [], [], [makeDetail()]);
      const res = await patch({ evseId: 2 });
      expect(res.statusCode).toBe(200);
      expect(updateSetArgs()).toMatchObject({ evseId: 'evs_000000000002' });
    });

    it('unbinds the token for tokenId null', async () => {
      setupDbResults([existing()], [], [makeDetail()]);
      const res = await patch({ tokenId: null });
      expect(res.statusCode).toBe(200);
      expect(updateSetArgs()).toMatchObject({ tokenId: null });
    });

    it('returns 400 when binding a token to a reservation without a driver', async () => {
      setupDbResults([existing({ driverId: null, tokenId: null })]);
      const res = await patch({ tokenId: TOKEN_ID });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'tokenId requires driverId', code: 'VALIDATION_ERROR' });
    });

    it('returns 400 when the token belongs to another driver', async () => {
      setupDbResults([existing()], [{ id: TOKEN_ID, driverId: DRV_OTHER }]);
      const res = await patch({ tokenId: TOKEN_ID });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('tokenId does not belong to driver');
    });

    it('validates the token against the driver sent in the same PATCH', async () => {
      setupDbResults([existing()], [{ id: TOKEN_ID, driverId: DRV_OTHER }], [], [makeDetail()]);
      const res = await patch({ driverId: DRV_OTHER, tokenId: TOKEN_ID });
      expect(res.statusCode).toBe(200);
      expect(updateSetArgs()).toMatchObject({ driverId: DRV_OTHER, tokenId: TOKEN_ID });
    });
  });

  describe('DELETE /reservations/:id', () => {
    const del = (payload?: Record<string, unknown>) =>
      app.inject({
        method: 'DELETE',
        url: `/reservations/${RSV_ID}`,
        headers: auth(),
        ...(payload != null ? { payload } : {}),
      });
    const row = (overrides: Record<string, unknown> = {}) => ({
      id: RSV_ID,
      reservationId: 7,
      status: 'active',
      stationOcppId: 'CS-001',
      siteId: SITE_A,
      driverId: DRV_ID,
      startsAt: null,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      ...overrides,
    });

    it('returns 400 when reason is not a string', async () => {
      const res = await del({ reason: 42 });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'reason must be a string', code: 'VALIDATION_ERROR' });
      expect(db.select).not.toHaveBeenCalled();
    });

    it('returns 400 when reason exceeds 500 characters', async () => {
      const res = await del({ reason: 'x'.repeat(501) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('reason cannot exceed 500 characters');
    });

    it('accepts a reason of exactly 500 characters', async () => {
      setupDbResults([row()]);
      const res = await del({ reason: 'x'.repeat(500) });
      expect(res.statusCode).toBe(200);
      expect(mockApplyCancel).toHaveBeenCalledWith(
        expect.objectContaining({ note: 'x'.repeat(500), actor: 'operator' }),
      );
    });

    it('returns 404 when the site is not accessible', async () => {
      mockGetUserSiteIds.mockResolvedValue([SITE_B]);
      setupDbResults([row()]);
      const res = await del();
      expect(res.statusCode).toBe(404);
      expect(mockApplyCancel).not.toHaveBeenCalled();
    });

    it('skips CancelReservation for a scheduled reservation', async () => {
      setupDbResults([row({ status: 'scheduled' })]);
      const res = await del();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'cancelled', cancellationFeeChargedCents: 0 });
      expect(mockSendOcpp).not.toHaveBeenCalled();
    });

    it('formats the charged fee for the driver notification and flags a failed charge', async () => {
      mockApplyCancel.mockResolvedValue({
        cancelled: true,
        feeChargedCents: 250,
        feeChargeFailed: true,
        feeCurrency: 'USD',
      });
      mockSendOcpp.mockResolvedValue({ error: 'No response within 30s' });
      setupDbResults([row()]);
      const res = await del({ chargeCancellationFee: true });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'cancelled',
        cancellationFeeChargedCents: 250,
        feeChargeFailed: true,
        warning: 'No response within 30s',
      });
      const vars = mockDispatch.mock.calls[0]?.[3] as Record<string, unknown>;
      expect(vars.cancellationFeeCents).toBe(250);
      expect(vars.currency).toBe('USD');
      expect(vars.cancellationFeeFormatted).toEqual(notificationMoney(250, 'USD'));
    });

    it('returns feeChargeFailed without a warning when the station replied', async () => {
      mockApplyCancel.mockResolvedValue({
        cancelled: false,
        feeChargedCents: 0,
        feeChargeFailed: true,
        feeCurrency: null,
      });
      setupDbResults([row()]);
      const res = await del();
      expect(res.json()).toEqual({
        status: 'cancelled',
        cancellationFeeChargedCents: 0,
        feeChargeFailed: true,
      });
      expect(mockDispatch).not.toHaveBeenCalled();
    });
  });

  describe('POST /reservations/:id/reassign', () => {
    const row = (overrides: Record<string, unknown> = {}) => ({
      id: RSV_ID,
      reservationId: 7,
      stationId: STATION_DB_ID,
      stationOcppId: 'CS-OLD',
      siteId: SITE_A,
      evseId: 'evs_000000000001',
      driverId: null,
      startsAt: null,
      expiresAt: new Date('2030-01-01T00:00:00Z'),
      createdAt: new Date('2024-01-01T00:00:00Z'),
      status: 'active',
      ...overrides,
    });
    const reassign = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: `/reservations/${RSV_ID}/reassign`,
        headers: auth(),
        payload,
      });

    it('returns 404 when the reservation site is not accessible', async () => {
      mockGetUserSiteIds.mockResolvedValue([SITE_B]);
      setupDbResults([row()]);
      const res = await reassign({ newStationOcppId: 'CS-NEW' });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('RESERVATION_NOT_FOUND');
    });

    it('returns 404 STATION_NOT_FOUND when the new station site is not accessible', async () => {
      mockGetUserSiteIds.mockResolvedValue([SITE_A]);
      setupDbResults([row()], [makeStation({ id: 'sta_000000000002', siteId: SITE_B })]);
      const res = await reassign({ newStationOcppId: 'CS-NEW' });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns the eligibility error status and code', async () => {
      mockAssertAllowed.mockRejectedValue(
        Object.assign(new Error('Reservations are disabled for this station'), {
          statusCode: 403,
          code: 'RESERVATION_DISABLED',
        }),
      );
      setupDbResults([row()], [makeStation({ id: 'sta_000000000002' })]);
      const res = await reassign({ newStationOcppId: 'CS-NEW' });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('RESERVATION_DISABLED');
    });

    it('falls back to 500 when the eligibility error has no status', async () => {
      mockAssertAllowed.mockRejectedValue({});
      setupDbResults([row()], [makeStation({ id: 'sta_000000000002' })]);
      const res = await reassign({ newStationOcppId: 'CS-NEW' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('Reservations not allowed');
    });

    it('returns 409 on a maintenance conflict at the new station', async () => {
      mockAssertNoMaintenance.mockRejectedValue(new MockMaintenanceConflictError());
      setupDbResults([row()], [makeStation({ id: 'sta_000000000002' })]);
      const res = await reassign({ newStationOcppId: 'CS-NEW' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        code: 'RESERVATION_DURING_MAINTENANCE',
        maintenanceEventId: 'mnt_000000000001',
      });
      expect(mockAssertNoMaintenance).toHaveBeenCalledWith(
        'sta_000000000002',
        new Date('2024-01-01T00:00:00Z'),
        new Date('2030-01-01T00:00:00Z'),
      );
    });

    it('rethrows unexpected maintenance errors', async () => {
      mockAssertNoMaintenance.mockRejectedValue(new Error('db down'));
      setupDbResults([row()], [makeStation({ id: 'sta_000000000002' })]);
      const res = await reassign({ newStationOcppId: 'CS-NEW' });
      expect(res.statusCode).toBe(500);
    });

    it('moves a scheduled reservation with a DB update only, even when offline', async () => {
      setupDbResults(
        [row({ status: 'scheduled', startsAt: new Date('2029-12-31T00:00:00Z') })],
        [makeStation({ id: 'sta_000000000002', isOnline: false })],
        [{ id: 'evs_000000000002' }],
        [],
      );
      const res = await reassign({ newStationOcppId: 'CS-NEW', newEvseId: 2 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'reassigned', newStationOcppId: 'CS-NEW' });
      expect(mockSendOcpp).not.toHaveBeenCalled();
      expect(updateSetArgs()).toMatchObject({
        stationId: 'sta_000000000002',
        evseId: 'evs_000000000002',
      });
      expect(writeReservationAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          evseIdBefore: 'evs_000000000001',
          evseIdAfter: 'evs_000000000002',
          notes: 'reassigned to station CS-NEW (was CS-OLD)',
        }),
        undefined,
        expect.anything(),
      );
    });

    it('sends ReserveNow with the new EVSE and continues when the old cancel throws', async () => {
      setupDbResults(
        [row({ driverId: DRV_ID })],
        [makeStation({ id: 'sta_000000000002' })],
        [{ id: 'evs_000000000002' }],
        [],
      );
      mockSendOcpp
        .mockResolvedValueOnce({ response: { status: 'Accepted' } })
        .mockRejectedValueOnce(new Error('pubsub down'));
      const res = await reassign({ newStationOcppId: 'CS-NEW', newEvseId: 2 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'reassigned', newStationOcppId: 'CS-NEW' });
      expect(mockSendOcpp).toHaveBeenNthCalledWith(1, 'CS-NEW', 'ReserveNow', {
        id: 7,
        expiryDateTime: '2030-01-01T00:00:00.000Z',
        idToken: { idToken: DRV_ID, type: 'Central' },
        evseId: 2,
      });
      expect(mockSendOcpp).toHaveBeenNthCalledWith(2, 'CS-OLD', 'CancelReservation', {
        reservationId: 7,
      });
    });

    it('returns 400 RESERVATION_REJECTED when ReserveNow errors', async () => {
      setupDbResults([row()], [makeStation({ id: 'sta_000000000002' })]);
      mockSendOcpp.mockResolvedValue({ error: 'Station not connected' });
      const res = await reassign({ newStationOcppId: 'CS-NEW' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'Station not connected', code: 'RESERVATION_REJECTED' });
      expect(db.update).not.toHaveBeenCalled();
    });
  });
});
