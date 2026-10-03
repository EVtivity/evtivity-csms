// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const VALID_STATION_ID = 'sta_000000000001';
const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

// Real self-signed test PEM (from packages/css/test-certs/ca.pem) so the
// X509Certificate validator in InstallCertificate accepts it.
const TEST_PEM_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDYTCCAkmgAwIBAgIUTRwcMo/cq2a8TDMda6I+GpAzyJQwDQYJKoZIhvcNAQEL
BQAwQDELMAkGA1UEBhMCVVMxFjAUBgNVBAoMDUVWdGl2aXR5IFRlc3QxGTAXBgNV
BAMMEEVWdGl2aXR5IFRlc3QgQ0EwHhcNMjYwMjIxMTgxNjEzWhcNMzYwMjE5MTgx
NjEzWjBAMQswCQYDVQQGEwJVUzEWMBQGA1UECgwNRVZ0aXZpdHkgVGVzdDEZMBcG
A1UEAwwQRVZ0aXZpdHkgVGVzdCBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCC
AQoCggEBANsDGoiIRlgTFls3z+pPNTFTG9lxQlXwBhlw9i/wV3yQJPdqSgxFDgp7
PHCev7IHSgP0nBBfHQ560gFjtgMP+8Pgmeqtt8RGknxZPeSMePxwuzvkf1+XYfta
Bg6QAgoChDJkdFbXlqANzE6BB685h+OKI6wDbvOqxFGReQHodBX2ENGk/c0p2BXn
I/9IydpRL5FC918ex++GE9DAf9gZHO35J12WWp5QDmmZHBGrowFLv0nTuISZ0bQw
U/vDGOVR8s/KJ4r0jyb9MuSQFJkg1VBM6j36Ge8vMrQmWoi2yZLGYYaKp+R1zN+V
8DwkbXeQRy4jiqyBYApET5txG2uGuLECAwEAAaNTMFEwHQYDVR0OBBYEFH1zUD3V
8/aR7jGSi5ptHCmMWIUDMB8GA1UdIwQYMBaAFH1zUD3V8/aR7jGSi5ptHCmMWIUD
MA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBADQ2+W8418Zkytha
LIilVOLJdK+AKpWrZWRNYkb/JnEu/husUfZXaxxOUQB+/gEhh4EeFcTSWkEh2GiU
XZbZ9zXDVqKLNBgubMKRjJh7XA4uASdP2dKt7u/aerYdBGPd2Uuku6IBLVNWxHap
GYQS+sRDqF0Qhk6ZnPUUuqpEFcP7/Ib3/Bna1XC/6nitqfoF5jMPZcahQY9eOVR2
2t30h0+FJcLlHC2Sit+scgqcNsIH7dLrn/DGBqRGuNDbLr0en7Gwr1AXUOSpc8/W
43o8KYRCfMwahBKbuSBXvueAXJNpWYEPGxEcZc+sH/IqssqdzsqB8ZGZghiLh6uI
qf/5BbM=
-----END CERTIFICATE-----`;

const { mockSetStationDisabled, mockSendAvailability } = vi.hoisted(() => ({
  mockSetStationDisabled: vi.fn().mockResolvedValue({ availabilityChanged: true }),
  mockSendAvailability: vi.fn().mockResolvedValue({
    command: 'ChangeAvailability',
    commandStatus: 'accepted',
    error: null,
  }),
}));

vi.mock('../lib/availability-command.js', () => ({
  sendAvailabilityCommand: mockSendAvailability,
}));

const { mockPublish, mockSubscribe } = vi.hoisted(() => {
  const pub = vi.fn().mockResolvedValue(undefined);
  const sub = vi.fn().mockImplementation(async (_channel: string, _cb: (raw: string) => void) => {
    return { unsubscribe: vi.fn() };
  });
  return { mockPublish: pub, mockSubscribe: sub };
});

vi.mock('../lib/pubsub.js', () => ({
  getPubSub: vi.fn(() => ({ publish: mockPublish, subscribe: mockSubscribe })),
  setPubSub: vi.fn(),
}));

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
    'selectDistinctOn',
    'as',
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

vi.mock('@evtivity/database', () => {
  const dbMock: Record<string, unknown> = {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    selectDistinct: vi.fn(() => makeChain()),
    selectDistinctOn: vi.fn(() => makeChain()),
    execute: vi.fn(() =>
      Promise.resolve([
        {
          uptime_percent: '99.5',
          port_count: '2',
          disconnect_count: '1',
          avg_downtime_minutes: '5',
          max_downtime_minutes: '10',
        },
      ]),
    ),
    $client: {},
  };
  // POST /v1/stations and PATCH /v1/stations/:id wrap their work in a
  // db.transaction. Reuse the same mocked db inside the callback so the
  // chained query helpers above continue to drive the test.
  dbMock['transaction'] = vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(dbMock));
  return {
    db: dbMock,
    client: {},
    setStationDisabled: mockSetStationDisabled,
    isRoamingEnabled: vi.fn(() => Promise.resolve(true)),
    stationStatusReasonSql: () => 'NULL',
    getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
    // buildDerivedStatusSubquery and buildUnderMaintenanceSubquery read
    // .table and .name off the correlated columns.
    chargingStations: {
      id: { name: 'id', table: {} },
      siteId: { name: 'site_id', table: {} },
    },
    evses: {},
    connectors: {},
    chargingSessions: {},
    drivers: {},
    meterValues: {},
    sites: {},
    maintenanceEvents: {},
    vendors: { id: 'id', name: 'name' },
    ocppMessageLogs: {},
    connectionLogs: {},
    stationCertificates: {},
    pricingGroupStations: {},
    pricingGroups: {},
    guestSessions: {},
    configTemplates: {},
    cssStations: { id: 'id', stationId: 'stationId' },
    cssEvses: {
      cssStationId: 'cssStationId',
      evseId: 'evseId',
      connectorId: 'connectorId',
      connectorType: 'connectorType',
      maxPowerW: 'maxPowerW',
    },
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
  };
});

vi.mock('drizzle-orm', () => {
  const sqlFn = () => ({ as: vi.fn(), mapWith: vi.fn() });
  return {
    eq: vi.fn(),
    and: vi.fn(),
    or: vi.fn(),
    ilike: vi.fn(),
    sql: Object.assign(vi.fn(sqlFn), {
      raw: vi.fn(sqlFn),
      join: vi.fn(() => ''),
      identifier: vi.fn(sqlFn),
    }),
    getTableName: vi.fn(() => 'charging_stations'),
    gte: vi.fn(),
    lte: vi.fn(),
    desc: vi.fn(),
    count: vi.fn(),
    inArray: vi.fn(),
    isNotNull: vi.fn(),
  };
});

const { changeStationPasswordMock, changeSecurityProfileMock, rotateStationPasswordMock } =
  vi.hoisted(() => ({
    changeStationPasswordMock: vi.fn(),
    changeSecurityProfileMock: vi.fn(),
    rotateStationPasswordMock: vi.fn(),
  }));

vi.mock('../services/station-security.service.js', () => ({
  changeStationPassword: changeStationPasswordMock,
  changeSecurityProfile: changeSecurityProfileMock,
  rotateStationPassword: rotateStationPasswordMock,
}));

vi.mock('argon2', () => ({
  hash: vi.fn().mockResolvedValue('hashed_password'),
}));

const { mockQueryRevenue } = vi.hoisted(() => ({ mockQueryRevenue: vi.fn() }));

// Revenue comes from the shared definition (session-revenue.ts); its SQL is
// covered by the integration tests.
vi.mock('../lib/session-revenue.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/session-revenue.js')>();
  return {
    ...actual,
    queryRevenue: (input: unknown) => mockQueryRevenue(input),
    queryRevenueTotal: async (input: unknown) =>
      ((await mockQueryRevenue(input)) as Map<string | null, unknown>).get(null) ??
      actual.EMPTY_REVENUE,
  };
});

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
  checkStationSiteAccess: vi.fn().mockResolvedValue(true),
  userCanAccessSite: vi.fn().mockResolvedValue(true),
}));

vi.mock('../lib/ocpp-command.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/ocpp-command.js')>()),
  sendOcppCommandAndWait: vi.fn().mockResolvedValue({
    commandId: 'mock-cmd',
    response: { status: 'Accepted' },
  }),
  triggerAndWaitForStatus: vi.fn().mockResolvedValue({ status: 'available' }),
}));

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (n: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
}));

import { registerAuth } from '../plugins/auth.js';
import { stationRoutes } from '../routes/stations.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(stationRoutes);
  await app.ready();
  return app;
}

describe('Station routes - handler logic', () => {
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

  // --- GET /v1/stations ---

  describe('GET /v1/stations', () => {
    it('returns paginated station list with data and total', async () => {
      const stationRow = {
        id: VALID_STATION_ID,
        stationId: 'STATION-001',
        siteId: null,
        vendorId: null,
        model: 'Model X',
        serialNumber: null,
        firmwareVersion: null,
        iccid: null,
        imsi: null,
        availability: 'available',
        reportedStatus: null,
        statusReason: null,
        onboardingStatus: 'accepted',
        lastHeartbeat: null,
        isOnline: true,
        isSimulator: false,
        loadPriority: 0,
        securityProfile: 0,
        pendingSecurityProfile: null,
        ocppProtocol: null,
        hasPassword: false,
        metadata: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'available',
        connectorCount: 2,
        connectorTypes: ['CCS2'],
        siteFreeVendEnabled: false,
        underMaintenance: false,
      };
      // First call: data query, second call: count subquery
      setupDbResults([stationRow], [{ count: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: '/stations',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(body.data).toHaveLength(1);
      expect(body.data[0].stationId).toBe('STATION-001');
    });

    it('returns empty data when no stations exist', async () => {
      setupDbResults([], [{ count: 0 }]);

      const response = await app.inject({
        method: 'GET',
        url: '/stations',
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/stations',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // --- GET /v1/stations/:id ---

  describe('GET /v1/stations/:id', () => {
    it('returns a station when found', async () => {
      const station = {
        id: VALID_STATION_ID,
        stationId: 'STATION-001',
        siteId: null,
        vendorId: null,
        vendorName: null,
        model: 'Model X',
        serialNumber: null,
        firmwareVersion: null,
        iccid: null,
        imsi: null,
        availability: 'available',
        reportedStatus: null,
        disabledReason: null,
        firmwareState: null,
        statusReason: null,
        onboardingStatus: 'accepted',
        lastHeartbeat: null,
        isOnline: false,
        isSimulator: false,
        loadPriority: 0,
        securityProfile: 0,
        pendingSecurityProfile: null,
        ocppProtocol: null,
        hasPassword: false,
        metadata: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        status: 'available',
        siteHoursOfOperation: null,
        siteFreeVendEnabled: false,
        underMaintenance: false,
      };
      setupDbResults([station]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().stationId).toBe('STATION-001');
    });

    it('returns 404 when station not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });
  });

  // --- POST /v1/stations ---

  describe('POST /v1/stations', () => {
    it('creates a station and returns 201', async () => {
      const created = {
        id: VALID_STATION_ID,
        stationId: 'NEW-STATION',
        siteId: null,
        vendorId: null,
        model: null,
        serialNumber: null,
        firmwareVersion: null,
        availability: 'available',
        reportedStatus: null,
        statusReason: null,
        onboardingStatus: 'pending',
        isOnline: false,
        isSimulator: false,
        loadPriority: 0,
        securityProfile: 0,
        pendingSecurityProfile: null,
        hasPassword: false,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      // First select: duplicate-check (no existing row), then insert returns the created row.
      setupDbResults([], [created]);

      const response = await app.inject({
        method: 'POST',
        url: '/stations',
        headers: { authorization: 'Bearer ' + token },
        payload: { stationId: 'NEW-STATION' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().stationId).toBe('NEW-STATION');
      expect(response.json().hasPassword).toBe(false);
    });

    it('creates a station with password and sets hasPassword true', async () => {
      const created = {
        id: VALID_STATION_ID,
        stationId: 'SECURE-STATION',
        siteId: null,
        vendorId: null,
        model: null,
        serialNumber: null,
        firmwareVersion: null,
        availability: 'available',
        reportedStatus: null,
        statusReason: null,
        onboardingStatus: 'pending',
        isOnline: false,
        isSimulator: false,
        loadPriority: 0,
        securityProfile: 1,
        pendingSecurityProfile: null,
        hasPassword: false,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      // First select: duplicate-check (no existing row), then insert returns the created row.
      setupDbResults([], [created]);

      const response = await app.inject({
        method: 'POST',
        url: '/stations',
        headers: { authorization: 'Bearer ' + token },
        payload: { stationId: 'SECURE-STATION', password: 'mypassword123456' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().hasPassword).toBe(true);
    });

    it('rejects a password longer than 20 characters for an OCPP 1.6 station', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: '/stations',
        headers: { authorization: 'Bearer ' + token },
        payload: { stationId: 'SECURE-16', ocppProtocol: 'ocpp1.6', password: 'a'.repeat(21) },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('VALIDATION_ERROR');
    });

    it('rejects a password shorter than 16 characters or with characters OCPP does not allow', async () => {
      for (const password of ['short-pass-123', 'has spaces in it 12']) {
        const response = await app.inject({
          method: 'POST',
          url: '/stations',
          headers: { authorization: 'Bearer ' + token },
          payload: { stationId: 'SECURE-X', password },
        });
        expect(response.statusCode).toBe(400);
      }
    });

    it('returns 400 for missing stationId', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/stations',
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // --- PATCH /v1/stations/:id ---

  describe('PATCH /v1/stations/:id', () => {
    it('updates and returns the station', async () => {
      const updated = {
        id: VALID_STATION_ID,
        stationId: 'STATION-001',
        siteId: null,
        vendorId: null,
        model: 'Updated Model',
        serialNumber: null,
        firmwareVersion: null,
        availability: 'available',
        reportedStatus: null,
        statusReason: null,
        onboardingStatus: 'accepted',
        isOnline: false,
        isSimulator: false,
        loadPriority: 0,
        securityProfile: 0,
        pendingSecurityProfile: null,
        hasPassword: false,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      // 1: before SELECT, 2: UPDATE returning
      setupDbResults([updated], [updated]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { model: 'Updated Model' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().model).toBe('Updated Model');
    });

    it('returns 404 when station not found', async () => {
      // 1: before SELECT (empty), 2: UPDATE returning (empty)
      setupDbResults([], []);

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { model: 'X' },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 400 when upgrading security profile without password and station has none', async () => {
      const { AppError } = await import('@evtivity/lib');
      changeSecurityProfileMock.mockRejectedValueOnce(
        new AppError('Password required', 400, 'PASSWORD_REQUIRED'),
      );

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { securityProfile: 1 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('PASSWORD_REQUIRED');
    });

    const stationRow = {
      id: VALID_STATION_ID,
      stationId: 'STATION-001',
      siteId: 'sit_000000000001',
      vendorId: null,
      model: null,
      serialNumber: null,
      firmwareVersion: null,
      availability: 'unavailable',
      reportedStatus: null,
      statusReason: null,
      onboardingStatus: 'accepted',
      isOnline: true,
      isSimulator: false,
      loadPriority: 0,
      securityProfile: 0,
      pendingSecurityProfile: null,
      hasPassword: false,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };

    const enabledInputs = { disabledReason: null, firmwareState: null };
    const operatorDisabled = { disabledReason: 'operator', firmwareState: null };

    async function auditActions(): Promise<string[]> {
      const { writeAudit } = await import('@evtivity/database');
      return vi.mocked(writeAudit).mock.calls.map((c) => (c[1] as { action: string }).action);
    }

    it('disables the station through the status entry point and tells the station', async () => {
      mockSetStationDisabled.mockClear();
      mockSendAvailability.mockClear();
      mockPublish.mockClear();
      const { writeAudit } = await import('@evtivity/database');
      vi.mocked(writeAudit).mockClear();
      // 1: before SELECT, 2: stored inputs after the disable, 3: UPDATE returning
      setupDbResults(
        [{ ...stationRow, ...enabledInputs }],
        [operatorDisabled],
        [{ ...stationRow, ...operatorDisabled }],
      );

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { availability: 'unavailable' },
      });

      expect(response.statusCode).toBe(200);
      expect(mockSetStationDisabled).toHaveBeenCalledWith({}, VALID_STATION_ID, 'operator');
      expect(mockSendAvailability).toHaveBeenCalledWith(
        'STATION-001',
        'Inoperative',
        expect.anything(),
      );
      const published = mockPublish.mock.calls.map((c) => c[1] as string);
      expect(published.some((p) => p.includes('station.status'))).toBe(true);
      expect(mockPublish).toHaveBeenCalledWith(
        'ocpi_push',
        JSON.stringify({ type: 'location', siteId: 'sit_000000000001' }),
      );
      expect(await auditActions()).toEqual(['availability_changed']);
      const auditArgs = vi.mocked(writeAudit).mock.calls[0]?.[1] as {
        after: Record<string, unknown>;
      };
      expect(auditArgs.after.disabledReason).toBe('operator');
    });

    it('audits availability_changed when the disable changes but availability does not', async () => {
      // A station that reports itself unavailable stays unavailable when the
      // operator disables it, but the operator's choice still changed.
      mockSetStationDisabled.mockClear();
      mockSetStationDisabled.mockResolvedValueOnce({ availabilityChanged: false });
      mockPublish.mockClear();
      const { writeAudit } = await import('@evtivity/database');
      vi.mocked(writeAudit).mockClear();
      setupDbResults(
        [{ ...stationRow, ...enabledInputs, reportedStatus: 'unavailable' }],
        [operatorDisabled],
        [{ ...stationRow, ...operatorDisabled }],
      );

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { availability: 'unavailable' },
      });

      expect(response.statusCode).toBe(200);
      expect(await auditActions()).toEqual(['availability_changed']);
      const channels = mockPublish.mock.calls.map((c) => c[0] as string);
      expect(channels).toContain('csms_events');
      expect(channels).toContain('ocpi_push');
    });

    it('audits a plain update and publishes nothing when the disable is unchanged', async () => {
      mockSetStationDisabled.mockClear();
      mockSetStationDisabled.mockResolvedValueOnce({ availabilityChanged: false });
      mockPublish.mockClear();
      const { writeAudit } = await import('@evtivity/database');
      vi.mocked(writeAudit).mockClear();
      setupDbResults(
        [{ ...stationRow, ...operatorDisabled }],
        [operatorDisabled],
        [{ ...stationRow, ...operatorDisabled }],
      );

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { availability: 'unavailable' },
      });

      expect(response.statusCode).toBe(200);
      expect(await auditActions()).toEqual(['updated']);
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('enables the station and sends Operative', async () => {
      mockSetStationDisabled.mockClear();
      mockSendAvailability.mockClear();
      setupDbResults(
        [{ ...stationRow, ...operatorDisabled }],
        [enabledInputs],
        [{ ...stationRow, ...enabledInputs, availability: 'available' }],
      );

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { availability: 'available' },
      });

      expect(response.statusCode).toBe(200);
      expect(mockSetStationDisabled).toHaveBeenCalledWith({}, VALID_STATION_ID, null);
      expect(mockSendAvailability).toHaveBeenCalledWith(
        'STATION-001',
        'Operative',
        expect.anything(),
      );
    });

    it('rejects faulted, which is computed rather than set', async () => {
      mockSetStationDisabled.mockClear();
      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { availability: 'faulted' },
      });

      expect(response.statusCode).toBe(400);
      expect(mockSetStationDisabled).not.toHaveBeenCalled();
    });
  });

  // --- DELETE /v1/stations/:id ---

  describe('DELETE /v1/stations/:id', () => {
    it('blocks station by setting onboardingStatus to blocked', async () => {
      const station = {
        id: VALID_STATION_ID,
        stationId: 'STATION-001',
        siteId: null,
        vendorId: null,
        model: null,
        serialNumber: null,
        firmwareVersion: null,
        availability: 'unavailable',
        onboardingStatus: 'blocked',
        isOnline: false,
        isSimulator: false,
        loadPriority: 0,
        securityProfile: 0,
        pendingSecurityProfile: null,
        hasPassword: false,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      // 1: before SELECT, 2: UPDATE returning
      setupDbResults([station], [station]);

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().onboardingStatus).toBe('blocked');
    });

    it('does not return the password hash', async () => {
      const station = {
        id: VALID_STATION_ID,
        stationId: 'STATION-001',
        siteId: null,
        vendorId: null,
        model: null,
        serialNumber: null,
        firmwareVersion: null,
        availability: 'unavailable',
        onboardingStatus: 'blocked',
        isOnline: false,
        isSimulator: false,
        loadPriority: 0,
        securityProfile: 1,
        pendingSecurityProfile: null,
        basicAuthPasswordHash: '$argon2id$v=19$m=65536,t=3,p=4$salt$hash',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      setupDbResults([station], [station]);

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).not.toHaveProperty('basicAuthPasswordHash');
      expect(body.hasPassword).toBe(true);
    });

    it('returns 404 when station not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });
  });

  // --- GET /v1/stations/:id/connectors ---

  describe('GET /v1/stations/:id/connectors', () => {
    it('returns grouped EVSE/connector data', async () => {
      const rows = [
        {
          evseId: 1,
          evseAutoCreated: false,
          connectorId: 1,
          connectorType: 'CCS2',
          maxPowerKw: '150',
          maxCurrentAmps: null,
          connectorStatus: 'available',
          connectorAutoCreated: false,
          isIdling: false,
        },
        {
          evseId: 1,
          evseAutoCreated: false,
          connectorId: 2,
          connectorType: 'CHAdeMO',
          maxPowerKw: '50',
          maxCurrentAmps: null,
          connectorStatus: 'available',
          connectorAutoCreated: false,
          isIdling: false,
        },
      ];
      setupDbResults(rows);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/connectors`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].evseId).toBe(1);
      expect(body[0].connectors).toHaveLength(2);
    });

    it('returns empty array when no EVSEs exist', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/connectors`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });
  });

  // --- POST /v1/stations/:id/evses ---

  describe('POST /v1/stations/:id/evses', () => {
    it('creates EVSE with connectors and returns 201', async () => {
      // 1: station exists, 2: no duplicate evse, 3: insert evse, 4: insert connectors
      const evse = { id: 'evs_000000000001', evseId: 1, status: 'unavailable' };
      const connectorRow = {
        connectorId: 1,
        connectorType: 'CCS2',
        maxPowerKw: '150',
        maxCurrentAmps: null,
        status: 'unavailable',
      };
      setupDbResults(
        [{ id: VALID_STATION_ID }], // station exists
        [], // no duplicate
        [evse], // inserted evse
        [connectorRow], // inserted connectors
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          evseId: 1,
          connectors: [{ connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150 }],
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().evseId).toBe(1);
    });

    it('returns 404 when station does not exist', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          evseId: 1,
          connectors: [{ connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150 }],
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 409 for duplicate evseId', async () => {
      setupDbResults(
        [{ id: VALID_STATION_ID }], // station exists
        [{ id: 'existing-evse' }], // duplicate found
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          evseId: 1,
          connectors: [{ connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150 }],
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('DUPLICATE_EVSE_ID');
    });

    it.each([
      [[{ connectorId: 1, connectorType: 'CCS2', maxPowerKw: 50 }]],
      [
        [
          { connectorId: 2, connectorType: 'CCS2', maxPowerKw: 50 },
          { connectorId: 3, connectorType: 'CCS2', maxPowerKw: 50 },
        ],
      ],
    ])('rejects a 1.6 EVSE whose connector does not match its number (%o)', async (conns) => {
      setupDbResults([{ id: VALID_STATION_ID, ocppProtocol: 'ocpp1.6' }]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses`,
        headers: { authorization: 'Bearer ' + token },
        payload: { evseId: 2, connectors: conns },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('CONNECTOR_ID_MISMATCH');
    });

    it('accepts a 1.6 EVSE with connector N on EVSE N', async () => {
      const evse = { id: 'evs_000000000002', evseId: 2, status: 'unavailable' };
      setupDbResults(
        [{ id: VALID_STATION_ID, ocppProtocol: 'ocpp1.6' }],
        [],
        [evse],
        [
          {
            connectorId: 2,
            connectorType: 'CCS2',
            maxPowerKw: '50',
            maxCurrentAmps: null,
            status: 'unavailable',
          },
        ],
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          evseId: 2,
          connectors: [{ connectorId: 2, connectorType: 'CCS2', maxPowerKw: 50 }],
        },
      });

      expect(response.statusCode).toBe(201);
    });
  });

  // --- DELETE /v1/stations/:id/evses/:evseId ---

  describe('DELETE /v1/stations/:id/evses/:evseId', () => {
    it('deletes EVSE when not occupied', async () => {
      setupDbResults(
        [{ id: 'evs_000000000001' }], // evse found
        [], // no occupied connectors
        [], // delete result (not used)
      );

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/evses/1`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('deleted');
    });

    it('returns 404 when EVSE not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/evses/1`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('EVSE_NOT_FOUND');
    });

    it('returns 409 when connector is occupied', async () => {
      setupDbResults(
        [{ id: 'evs_000000000001' }], // evse found
        [{ id: 'con_000000000001' }], // occupied connector found
      );

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/evses/1`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('CONNECTOR_OCCUPIED');
    });
  });

  describe('POST /v1/stations/:id/evses/:evseId/refresh-status', () => {
    it('triggers StatusNotification and returns the latest status', async () => {
      setupDbResults(
        [{ stationId: 'CS-001', isOnline: true, ocppProtocol: 'ocpp2.1' }], // SELECT station
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses/1/refresh-status`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('available');
    });

    it('returns offline error when station is not connected', async () => {
      setupDbResults(
        [{ stationId: 'CS-001', isOnline: false, ocppProtocol: 'ocpp2.1' }], // SELECT station
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses/1/refresh-status`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Station is offline', code: 'STATION_OFFLINE' });
    });
  });

  // The payloads are OCPP 2.1 shaped. Without a version the OCPP server
  // translates them for 1.6 stations (evseId -> connectorId, unwrapped criteria).
  describe('charging profile commands to an OCPP 1.6 station', () => {
    it('sends GetCompositeSchedule without a version', async () => {
      const { sendOcppCommandAndWait } = await import('../lib/ocpp-command.js');
      const sendMock = vi.mocked(sendOcppCommandAndWait);
      sendMock.mockResolvedValueOnce({ commandId: 'm', response: { status: 'Rejected' } });
      setupDbResults([{ stationId: 'CS-016', ocppProtocol: 'ocpp1.6', isOnline: true }]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/charging-profiles/composite`,
        headers: { authorization: 'Bearer ' + token },
        payload: { evseId: 1, duration: 3600 },
      });

      expect(response.statusCode).toBe(200);
      expect(sendMock.mock.calls[0]?.[1]).toBe('GetCompositeSchedule');
      expect(sendMock.mock.calls[0]).toHaveLength(3);
    });

    it('sends ClearChargingProfile without a version', async () => {
      const { sendOcppCommandAndWait } = await import('../lib/ocpp-command.js');
      const sendMock = vi.mocked(sendOcppCommandAndWait);
      sendMock.mockResolvedValueOnce({ commandId: 'm', response: { status: 'Unknown' } });
      setupDbResults([{ stationId: 'CS-016', ocppProtocol: 'ocpp1.6', isOnline: true }]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/charging-profiles/clear`,
        headers: { authorization: 'Bearer ' + token },
        payload: { chargingProfilePurpose: 'TxDefaultProfile', stackLevel: 0, evseId: 1 },
      });

      expect(response.statusCode).toBe(200);
      expect(sendMock.mock.calls[0]?.[1]).toBe('ClearChargingProfile');
      expect(sendMock.mock.calls[0]).toHaveLength(3);
    });
  });

  describe('POST /v1/stations/:id/evses/:evseId/stop-active-session', () => {
    it('dispatches RequestStopTransaction and returns ghostRecovered=false on Accepted', async () => {
      const { sendOcppCommandAndWait } = await import('../lib/ocpp-command.js');
      const sendMock = vi.mocked(sendOcppCommandAndWait);
      sendMock.mockResolvedValueOnce({ commandId: 'm', response: { status: 'Accepted' } });
      setupDbResults(
        [{ stationId: 'CS-001', ocppProtocol: 'ocpp2.1' }],
        [{ id: 'evs_000000000001' }],
        [{ id: 'ses_000000000001', transactionId: 'tx-abc' }],
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses/1/stop-active-session`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.sessionId).toBe('ses_000000000001');
      expect(body.transactionId).toBe('tx-abc');
      expect(body.ghostRecovered).toBe(false);
      // No version: the OCPP server translates the 2.1 command for 1.6 stations.
      expect(sendMock).toHaveBeenCalledWith('CS-001', 'RequestStopTransaction', {
        transactionId: 'tx-abc',
      });
      expect(sendMock.mock.calls[0]).toHaveLength(3);
    });

    it('returns ghostRecovered=true and force-cleans the DB on Rejected+TxNotFound', async () => {
      const { sendOcppCommandAndWait } = await import('../lib/ocpp-command.js');
      vi.mocked(sendOcppCommandAndWait).mockResolvedValueOnce({
        commandId: 'm',
        response: { status: 'Rejected', statusInfo: { reasonCode: 'TxNotFound' } },
      });
      setupDbResults(
        [{ stationId: 'CS-001', ocppProtocol: 'ocpp2.1' }],
        [{ id: 'evs_000000000001' }],
        [{ id: 'ses_000000000001', transactionId: 'tx-ghost' }],
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses/1/stop-active-session`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ghostRecovered).toBe(true);
      expect(body.sessionId).toBe('ses_000000000001');
      expect(body.transactionId).toBe('tx-ghost');
    });

    it('returns 504 when station does not respond', async () => {
      const { sendOcppCommandAndWait } = await import('../lib/ocpp-command.js');
      vi.mocked(sendOcppCommandAndWait).mockResolvedValueOnce({
        commandId: 'm',
        error: 'No response within 35s',
      });
      setupDbResults(
        [{ stationId: 'CS-001', ocppProtocol: 'ocpp2.1' }],
        [{ id: 'evs_000000000001' }],
        [{ id: 'ses_000000000001', transactionId: 'tx-abc' }],
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses/1/stop-active-session`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(504);
      expect(response.json().code).toBe('STATION_TIMEOUT');
    });

    it('returns 404 when station not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses/1/stop-active-session`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 404 when EVSE not found', async () => {
      setupDbResults([{ stationId: 'CS-001', ocppProtocol: 'ocpp2.1' }], []);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses/9/stop-active-session`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('EVSE_NOT_FOUND');
    });

    it('returns 404 when no active session on the EVSE', async () => {
      setupDbResults(
        [{ stationId: 'CS-001', ocppProtocol: 'ocpp2.1' }],
        [{ id: 'evs_000000000001' }],
        [],
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses/1/stop-active-session`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('NO_ACTIVE_SESSION');
    });
  });

  // --- GET /v1/stations/:id/meter-values ---

  describe('GET /v1/stations/:id/meter-values', () => {
    it('returns grouped meter values', async () => {
      const rows = [
        { measurand: 'Power.Active.Import', unit: 'kW', timestamp: new Date(), value: '11.5' },
        { measurand: 'Power.Active.Import', unit: 'kW', timestamp: new Date(), value: '12.0' },
      ];
      setupDbResults(rows);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/meter-values`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0].measurand).toBe('Power.Active.Import');
      expect(body[0].values).toHaveLength(2);
    });
  });

  // --- GET /v1/stations/:id/sessions ---

  describe('GET /v1/stations/:id/sessions', () => {
    it('returns paginated sessions', async () => {
      const sessionRow = {
        id: 'sess-1',
        stationId: VALID_STATION_ID,
        stationName: 'STATION-001',
        siteName: 'Main Site',
        driverId: null,
        driverName: null,
        transactionId: null,
        status: 'completed',
        startedAt: '2024-01-01T00:00:00.000Z',
        endedAt: null,
        energyDeliveredWh: '5000',
        currentCostCents: null,
        finalCostCents: null,
        currency: null,
      };
      // Promise.all: data query and count query
      setupDbResults([sessionRow], [{ count: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/sessions`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(body.data).toHaveLength(1);
    });
  });

  // --- GET /v1/stations/:id/energy-history ---

  describe('GET /v1/stations/:id/energy-history', () => {
    it('returns daily energy data', async () => {
      // First call: site timezone lookup, second: energy rows
      setupDbResults(
        [{ siteTimezone: 'America/New_York' }],
        [{ date: '2025-01-01', energyWh: 5000 }],
      );

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/energy-history`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(1);
      expect(body[0]).toHaveProperty('date');
      expect(body[0]).toHaveProperty('energyWh');
    });
  });

  // --- GET /v1/stations/:id/revenue-history ---

  describe('GET /v1/stations/:id/revenue-history', () => {
    it('returns daily revenue data zero-filled across the range', async () => {
      setupDbResults([{ siteTimezone: 'UTC' }]);
      const { aggregateRevenueRows } = await import('../lib/session-revenue.js');
      mockQueryRevenue.mockResolvedValueOnce(
        aggregateRevenueRows([
          { key: '2025-01-02', taxRate: '0', grossCents: 500, source: 'session', count: 3 },
        ]),
      );

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/revenue-history?from=2025-01-01&to=2025-01-03`,
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
        revenueCents: 1500,
        sessionCount: 3,
      });
      expect(body.find((r) => r.date === '2025-01-01')).toEqual({
        date: '2025-01-01',
        revenueCents: 0,
        sessionCount: 0,
      });
    });
  });

  // --- GET /v1/stations/:id/ocpp-logs ---

  describe('GET /v1/stations/:id/ocpp-logs', () => {
    it('returns paginated OCPP logs with actions list', async () => {
      const logRow = {
        id: 1,
        stationId: VALID_STATION_ID,
        action: 'Heartbeat',
        direction: 'inbound',
        messageType: 2,
        messageId: 'msg-1',
        payload: null,
        errorCode: null,
        errorDescription: null,
        createdAt: '2024-01-01T00:00:00.000Z',
      };
      // Promise.all: data rows, count rows, then distinct actions
      setupDbResults(
        [logRow],
        [{ count: 1 }],
        [{ action: 'Heartbeat' }, { action: 'BootNotification' }],
      );

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/ocpp-logs`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(body).toHaveProperty('actions');
    });
  });

  // --- POST /v1/stations/:id/credentials ---

  describe('POST /v1/stations/:id/credentials', () => {
    it('hands the password to the station security service', async () => {
      changeStationPasswordMock.mockResolvedValueOnce({ appliedTo: 'station' });

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/credentials`,
        headers: { authorization: 'Bearer ' + token },
        payload: { password: 'newpassword12345' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ appliedTo: 'station' });
      expect(changeStationPasswordMock).toHaveBeenCalledWith(
        VALID_STATION_ID,
        'newpassword12345',
        expect.objectContaining({ actor: expect.any(Object) as unknown }),
      );
    });

    it('returns the service error when the station rejects the password', async () => {
      const { AppError } = await import('@evtivity/lib');
      changeStationPasswordMock.mockRejectedValueOnce(
        new AppError('rejected', 502, 'STATION_SECURITY_CHANGE_REJECTED'),
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/credentials`,
        headers: { authorization: 'Bearer ' + token },
        payload: { password: 'newpassword12345' },
      });

      expect(response.statusCode).toBe(502);
      expect(response.json().code).toBe('STATION_SECURITY_CHANGE_REJECTED');
    });

    it('rejects a password that breaks the OCPP rules before calling the service', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/credentials`,
        headers: { authorization: 'Bearer ' + token },
        payload: { password: 'newpassword123' },
      });

      expect(response.statusCode).toBe(400);
      expect(changeStationPasswordMock).not.toHaveBeenCalled();
    });
  });

  // --- GET /v1/stations/:id/security-logs ---

  describe('GET /v1/stations/:id/security-logs', () => {
    it('returns unified paginated security logs from both sources', async () => {
      // The handler issues a UNION ALL via db.execute (data) and a wrapping
      // COUNT (via db.execute) so the global execute mock must be overridden
      // for both calls in order. Row shape matches the SQL `SELECT ... AS`
      // aliases the handler emits.
      const { db } = (await import('@evtivity/database')) as unknown as {
        db: { execute: ReturnType<typeof vi.fn> };
      };
      db.execute
        .mockResolvedValueOnce([
          {
            id: 'connection:1',
            source: 'connection',
            event: 'auth_failed',
            severity: null,
            remote_address: '1.2.3.4',
            metadata: { reason: 'Invalid password' },
            created_at: new Date(),
          },
          {
            id: 'security:5',
            source: 'security',
            event: 'TamperDetectionActivated',
            severity: 'critical',
            remote_address: null,
            metadata: { techInfo: 'lid sensor tripped' },
            created_at: new Date(),
          },
        ])
        .mockResolvedValueOnce([{ count: 2 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/security-logs`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(2);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].source).toBe('connection');
      expect(body.data[0].severity).toBeNull();
      expect(body.data[1].source).toBe('security');
      expect(body.data[1].severity).toBe('critical');
    });
  });

  // --- GET /v1/stations/:id/metrics ---

  describe('GET /v1/stations/:id/metrics', () => {
    it('returns station metrics', async () => {
      // The metrics endpoint calls: db.execute (uptime), db.select (sessionStats),
      // db.select (utilizationStats), db.select (financialStats), db.execute (disconnects)
      const sessionStats = {
        totalSessions: 10,
        completedSessions: 8,
        faultedSessions: 1,
        totalEnergyWh: 50000,
        avgDurationMinutes: 30,
      };
      const utilizationStats = { sessionHours: 5, portCount: 2 };
      const financialStats = { totalElectricityCostCents: 3000 };
      // Revenue: 8 sessions of 1190 at 19% and one of 480 at 0%.
      const { aggregateRevenueRows } = await import('../lib/session-revenue.js');
      mockQueryRevenue.mockResolvedValueOnce(
        aggregateRevenueRows([
          { key: null, taxRate: '0.19', grossCents: 1190, source: 'session', count: 8 },
          { key: null, taxRate: '0', grossCents: 480, source: 'session', count: 1 },
        ]),
      );

      setupDbResults([sessionStats], [utilizationStats], [financialStats]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/metrics`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('uptimePercent');
      expect(body).toHaveProperty('totalSessions');
      expect(body).toHaveProperty('utilizationPercent');
      expect(body).toHaveProperty('totalRevenueCents', 8 * 1190 + 480);
      expect(body).toHaveProperty('totalTransactions', 9);
      expect(body).toHaveProperty('totalNetRevenueCents', 8 * 1000 + 480);
      expect(body).toHaveProperty('totalTaxCents', 8 * 190);
      // Profit is revenue excluding tax minus electricity cost.
      expect(body).toHaveProperty('totalProfitCents', 8480 - 3000);
      expect(body).toHaveProperty('periodMonths');
      expect(body).toHaveProperty('currency', 'EUR');
    });
  });

  // --- DELETE /v1/stations/:id/evses/:evseId/connectors/:connectorId ---

  describe('DELETE /v1/stations/:id/evses/:evseId/connectors/:connectorId', () => {
    it('deletes connector when not occupied', async () => {
      setupDbResults(
        [{ id: 'evs_000000000001' }], // evse found
        [{ id: 'con_000000000001', status: 'available' }], // connector found, not occupied
        [], // delete
      );

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/evses/1/connectors/1`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('deleted');
    });

    it('returns 409 when connector is occupied', async () => {
      setupDbResults(
        [{ id: 'evs_000000000001' }],
        [{ id: 'con_000000000001', status: 'occupied' }],
      );

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/evses/1/connectors/1`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('CONNECTOR_OCCUPIED');
    });

    it('returns 404 when connector not found', async () => {
      setupDbResults(
        [{ id: 'evs_000000000001' }], // evse found
        [], // connector not found
      );

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/evses/1/connectors/1`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('CONNECTOR_NOT_FOUND');
    });
  });

  // --- POST /v1/stations/:id/evses/:evseId/connectors ---

  describe('POST /v1/stations/:id/evses/:evseId/connectors', () => {
    it('adds a connector to an EVSE and returns 201', async () => {
      const connector = {
        connectorId: 2,
        connectorType: 'Type2',
        maxPowerKw: '22',
        maxCurrentAmps: null,
        status: 'unavailable',
      };
      setupDbResults(
        [{ id: 'evs_000000000001' }], // evse found
        [], // no duplicate connector
        [connector], // inserted connector
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses/1/connectors`,
        headers: { authorization: 'Bearer ' + token },
        payload: { connectorId: 2, connectorType: 'Type2', maxPowerKw: 22 },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().connectorId).toBe(2);
      expect(response.json().connectorType).toBe('Type2');
    });

    it('rejects a second connector on a 1.6 EVSE', async () => {
      setupDbResults([{ id: 'evs_000000000001', ocppProtocol: 'ocpp1.6' }]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses/1/connectors`,
        headers: { authorization: 'Bearer ' + token },
        payload: { connectorId: 2, connectorType: 'Type2', maxPowerKw: 22 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('CONNECTOR_ID_MISMATCH');
    });

    it('returns 409 for duplicate connectorId', async () => {
      setupDbResults([{ id: 'evs_000000000001' }], [{ id: 'existing' }]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses/1/connectors`,
        headers: { authorization: 'Bearer ' + token },
        payload: { connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150 },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('DUPLICATE_CONNECTOR_ID');
    });
  });

  // --- PATCH /v1/stations/:id/evses/:evseId ---

  describe('PATCH /v1/stations/:id/evses/:evseId', () => {
    it('updates connector properties on an EVSE', async () => {
      const evse = { id: 'evs_000000000001', evseId: 1, status: 'available' };
      const updatedConnectors = [
        {
          connectorId: 1,
          connectorType: 'CCS2',
          maxPowerKw: '200',
          maxCurrentAmps: null,
          status: 'available',
        },
      ];
      // 1: find evse, 2: pre-validate connector ids exist, 3: tx.update (1 per connector),
      // 4: select updated connectors. The mock chain consumes one entry per awaited call.
      setupDbResults(
        [evse],
        [{ connectorId: 1 }], // pre-validation: all body connectorIds exist
        [], // tx.update inside transaction (no .returning(); chain still consumes one slot)
        updatedConnectors, // final select result
      );

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}/evses/1`,
        headers: { authorization: 'Bearer ' + token },
        payload: { connectors: [{ connectorId: 1, maxPowerKw: 200 }] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().evseId).toBe(1);
      expect(response.json().connectors).toHaveLength(1);
    });

    it('returns 404 when EVSE not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}/evses/1`,
        headers: { authorization: 'Bearer ' + token },
        payload: { connectors: [{ connectorId: 1, maxPowerKw: 200 }] },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('EVSE_NOT_FOUND');
    });
  });

  // --- PATCH /v1/stations/:id security fields ---

  describe('PATCH /v1/stations/:id (security profile and password)', () => {
    const station = {
      id: VALID_STATION_ID,
      stationId: 'STATION-001',
      siteId: null,
      vendorId: null,
      model: null,
      serialNumber: null,
      firmwareVersion: null,
      availability: 'available',
      reportedStatus: null,
      statusReason: null,
      onboardingStatus: 'accepted',
      isOnline: true,
      isSimulator: false,
      loadPriority: 0,
      securityProfile: 1,
      pendingSecurityProfile: 2,
      ocppProtocol: 'ocpp2.1',
      hasPassword: true,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };

    it('hands a security profile change to the station security service', async () => {
      changeSecurityProfileMock.mockResolvedValueOnce({ status: 'pending' });
      setupDbResults([station], [station]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { securityProfile: 2 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().pendingSecurityProfile).toBe(2);
      expect(changeSecurityProfileMock).toHaveBeenCalledWith(
        VALID_STATION_ID,
        2,
        undefined,
        expect.any(Object),
      );
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('hands a password-only change to the password flow', async () => {
      changeStationPasswordMock.mockResolvedValueOnce({ appliedTo: 'station' });
      setupDbResults([station], [station]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { password: 'abcdefghijklmnop' },
      });

      expect(response.statusCode).toBe(200);
      expect(changeStationPasswordMock).toHaveBeenCalledWith(
        VALID_STATION_ID,
        'abcdefghijklmnop',
        expect.any(Object),
      );
      expect(changeSecurityProfileMock).not.toHaveBeenCalled();
    });

    it('does not touch security for other field updates', async () => {
      setupDbResults([station], [station]);

      await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { model: 'New Model' },
      });

      expect(changeSecurityProfileMock).not.toHaveBeenCalled();
      expect(changeStationPasswordMock).not.toHaveBeenCalled();
    });

    it('stops the update when the service refuses a downgrade', async () => {
      const { AppError } = await import('@evtivity/lib');
      changeSecurityProfileMock.mockRejectedValueOnce(
        new AppError('no downgrade', 400, 'SECURITY_PROFILE_DOWNGRADE'),
      );
      setupDbResults([station], [station]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}`,
        headers: { authorization: 'Bearer ' + token },
        payload: { securityProfile: 0, model: 'X' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('SECURITY_PROFILE_DOWNGRADE');
    });
  });

  // --- POST /v1/stations/:id/rotate-credentials ---

  describe('POST /v1/stations/:id/rotate-credentials', () => {
    it('hands the rotation to the station security service', async () => {
      rotateStationPasswordMock.mockResolvedValueOnce(undefined);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/rotate-credentials`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
      expect(rotateStationPasswordMock).toHaveBeenCalledWith(VALID_STATION_ID, expect.any(Object));
    });

    it('returns 409 when the service reports the station offline', async () => {
      const { AppError } = await import('@evtivity/lib');
      rotateStationPasswordMock.mockRejectedValueOnce(
        new AppError('Station is offline', 409, 'STATION_OFFLINE'),
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/rotate-credentials`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('STATION_OFFLINE');
    });
  });

  // --- POST /v1/stations/:id/evses (500 on EVSE insert failure) ---

  describe('POST /v1/stations/:id/evses (EVSE insert failure)', () => {
    it('returns 500 when EVSE insert returns empty', async () => {
      setupDbResults(
        [{ id: VALID_STATION_ID }], // station exists
        [], // no duplicate evse
        [], // EVSE insert returns empty (null evse)
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          evseId: 1,
          connectors: [{ connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150 }],
        },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json().code).toBe('INTERNAL_ERROR');
    });
  });

  // --- POST /v1/stations/:id/evses/:evseId/connectors (EVSE not found + connector insert failure) ---

  describe('POST /v1/stations/:id/evses/:evseId/connectors (edge cases)', () => {
    it('returns 404 when EVSE not found', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses/1/connectors`,
        headers: { authorization: 'Bearer ' + token },
        payload: { connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150 },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('EVSE_NOT_FOUND');
    });

    it('returns 500 when connector insert returns empty', async () => {
      setupDbResults(
        [{ id: 'evs_000000000001' }], // evse found
        [], // no duplicate connector
        [], // connector insert returns empty
      );

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/evses/1/connectors`,
        headers: { authorization: 'Bearer ' + token },
        payload: { connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150 },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json().code).toBe('INTERNAL_ERROR');
    });
  });

  // --- DELETE /v1/stations/:id/evses/:evseId/connectors/:connectorId (EVSE not found) ---

  describe('DELETE /v1/stations/:id/evses/:evseId/connectors/:connectorId (EVSE not found)', () => {
    it('returns 404 when EVSE not found for connector delete', async () => {
      setupDbResults([]);

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/evses/999/connectors/1`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('EVSE_NOT_FOUND');
    });
  });

  // --- GET /v1/stations/:id/certificates ---

  describe('GET /v1/stations/:id/certificates', () => {
    it('returns paginated certificate list', async () => {
      const certRow = {
        id: 'cert-1',
        stationId: VALID_STATION_ID,
        certificateType: 'V2GRootCertificate',
        status: 'active',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      // Promise.all: data rows, count rows
      setupDbResults([certRow], [{ count: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/certificates`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(body.data).toHaveLength(1);
      expect(body.data[0].certificateType).toBe('V2GRootCertificate');
    });

    it('returns empty list when no certificates', async () => {
      setupDbResults([], [{ count: 0 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/certificates`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('supports status filter query param', async () => {
      setupDbResults([], [{ count: 0 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/certificates?status=expired`,
        headers: { authorization: 'Bearer ' + token },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  // --- POST /v1/stations/:id/certificates/install ---

  describe('POST /v1/stations/:id/certificates/install', () => {
    it('publishes InstallCertificate command and returns success', async () => {
      // db.execute returns station row
      const { db } = await import('@evtivity/database');
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { station_id: 'STATION-001' },
      ]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/certificates/install`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          certificateType: 'V2GRootCertificate',
          certificate: TEST_PEM_CERTIFICATE,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
      expect(mockPublish).toHaveBeenCalledWith(
        'ocpp_commands',
        expect.stringContaining('InstallCertificate'),
      );
    });

    it('returns 404 when station not found', async () => {
      const { db } = await import('@evtivity/database');
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/certificates/install`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          certificateType: 'V2GRootCertificate',
          certificate: TEST_PEM_CERTIFICATE,
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });
  });

  // --- POST /v1/stations/:id/certificates/delete ---

  describe('POST /v1/stations/:id/certificates/delete', () => {
    it('publishes DeleteCertificate command and returns success', async () => {
      const { db } = await import('@evtivity/database');
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { station_id: 'STATION-001' },
      ]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/certificates/delete`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          certificateHashData: {
            hashAlgorithm: 'SHA256',
            issuerNameHash: 'abc123',
            issuerKeyHash: 'def456',
            serialNumber: '789',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
      expect(mockPublish).toHaveBeenCalledWith(
        'ocpp_commands',
        expect.stringContaining('DeleteCertificate'),
      );
    });

    it('returns 404 when station not found', async () => {
      const { db } = await import('@evtivity/database');
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/certificates/delete`,
        headers: { authorization: 'Bearer ' + token },
        payload: {
          certificateHashData: {
            hashAlgorithm: 'SHA256',
            issuerNameHash: 'abc123',
            issuerKeyHash: 'def456',
            serialNumber: '789',
          },
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });
  });

  // --- POST /v1/stations/:id/certificates/query ---

  describe('POST /v1/stations/:id/certificates/query', () => {
    it('publishes GetInstalledCertificateIds command and returns success', async () => {
      const { db } = await import('@evtivity/database');
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { station_id: 'STATION-001' },
      ]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/certificates/query`,
        headers: { authorization: 'Bearer ' + token },
        payload: { certificateType: ['V2GRootCertificate'] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
      expect(mockPublish).toHaveBeenCalledWith(
        'ocpp_commands',
        expect.stringContaining('GetInstalledCertificateIds'),
      );
    });

    it('returns 404 when station not found', async () => {
      const { db } = await import('@evtivity/database');
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/certificates/query`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('STATION_NOT_FOUND');
    });

    it('accepts empty body for querying all certificate types', async () => {
      const { db } = await import('@evtivity/database');
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { station_id: 'STATION-001' },
      ]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/certificates/query`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });

    it('asks a 1.6 station about each supported certificate type in its own request', async () => {
      const { db } = await import('@evtivity/database');
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { station_id: 'STATION-016', ocpp_protocol: 'ocpp1.6' },
      ]);
      mockPublish.mockClear();

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/certificates/query`,
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const sent = mockPublish.mock.calls
        .filter((c) => c[0] === 'ocpp_commands')
        .map((c) => (JSON.parse(c[1] as string) as { payload: unknown }).payload);
      expect(sent).toEqual([
        { certificateType: ['CSMSRootCertificate'] },
        { certificateType: ['ManufacturerRootCertificate'] },
      ]);
    });

    it('skips certificate types a 1.6 station does not have', async () => {
      const { db } = await import('@evtivity/database');
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { station_id: 'STATION-016', ocpp_protocol: 'ocpp1.6' },
      ]);
      mockPublish.mockClear();

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/certificates/query`,
        headers: { authorization: 'Bearer ' + token },
        payload: { certificateType: ['V2GRootCertificate', 'ManufacturerRootCertificate'] },
      });

      expect(response.statusCode).toBe(200);
      const sent = mockPublish.mock.calls
        .filter((c) => c[0] === 'ocpp_commands')
        .map((c) => (JSON.parse(c[1] as string) as { payload: unknown }).payload);
      expect(sent).toEqual([{ certificateType: ['ManufacturerRootCertificate'] }]);
    });
  });

  describe('POST /stations/:id/approve', () => {
    it('approves a pending station', async () => {
      setupDbResults(
        [{ onboardingStatus: 'pending' }], // select station
        [{ id: VALID_STATION_ID }], // update
      );
      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/approve`,
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.statusCode).toBe(200);
    });

    it('returns 409 when station is not pending', async () => {
      setupDbResults([{ onboardingStatus: 'accepted' }]);
      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/approve`,
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.statusCode).toBe(409);
    });

    it('returns 404 when station not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/approve`,
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /stations/:id/reject', () => {
    it('blocks a pending station', async () => {
      setupDbResults([{ onboardingStatus: 'pending' }], [{ id: VALID_STATION_ID }]);
      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/reject`,
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.statusCode).toBe(200);
    });

    it('returns 409 when station is not pending', async () => {
      setupDbResults([{ onboardingStatus: 'blocked' }]);
      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/reject`,
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.statusCode).toBe(409);
    });
  });

  describe('POST /stations/:id/unblock', () => {
    it('unblocks a blocked station back to pending', async () => {
      setupDbResults([{ onboardingStatus: 'blocked' }], [{ id: VALID_STATION_ID }]);
      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/unblock`,
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.statusCode).toBe(200);
    });

    it('returns 409 when station is not blocked', async () => {
      setupDbResults([{ onboardingStatus: 'pending' }]);
      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/unblock`,
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.statusCode).toBe(409);
    });

    it('returns 404 when station not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/unblock`,
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
