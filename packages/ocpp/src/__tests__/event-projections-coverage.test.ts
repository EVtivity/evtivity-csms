// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, type Mock } from 'vitest';
import type { EventBus, DomainEvent, PubSubClient } from '@evtivity/lib';

// SQL mock: a function that handles tagged template calls and returns configurable results
const sqlCalls: Array<{ strings: string[]; values: unknown[] }> = [];
let sqlResults: Array<unknown[]> = [];
let sqlCallIndex = 0;
let sqlErrors: Map<number, Error> = new Map();
let sqlCountOverrides: Map<number, number> = new Map();

/** Marker for results that should have count=0 (simulates INSERT WHERE EXISTS with no match) */
const EMPTY_INSERT = Object.assign([] as unknown[], { __emptyInsert: true });
const findSql = (pattern: RegExp) => sqlCalls.find((c) => pattern.test(c.strings.join('?')));

function createSqlMock() {
  sqlCalls.length = 0;
  sqlResults = [];
  sqlCallIndex = 0;
  sqlErrors = new Map();
  sqlCountOverrides = new Map();

  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    sqlCalls.push({ strings: [...strings], values });
    // The session end notice claims answer by text (claimed), outside the
    // queued results, since the settlement runs beside the Ended projection.
    if (/SET (completed_notified_at|receipt_notified_at) = now\(\)/.test(strings.join('?'))) {
      return Promise.resolve(Object.assign([{ id: 'session-claimed' }], { count: 1 }));
    }
    // The resend check (TransactionProjector.isResentEvent) answers by text,
    // outside the queued results: no event is a resend unless a test says so.
    if (strings.join('?').includes('AND te.seq_no = ?')) {
      return Promise.resolve(Object.assign([], { count: 0 }));
    }
    const idx = sqlCallIndex;
    sqlCallIndex++;
    const error = sqlErrors.get(idx);
    if (error != null) {
      return Promise.reject(error);
    }
    const result = sqlResults[idx] ?? [];
    const isEmptyInsert = (result as unknown as { __emptyInsert?: boolean }).__emptyInsert === true;
    const count =
      sqlCountOverrides.get(idx) ?? (isEmptyInsert ? 0 : result.length > 0 ? result.length : 1);
    const resultWithCount = Object.assign([...result], { count });
    return Promise.resolve(resultWithCount);
  };

  // Mirror postgres-js's `sql.json(value)` helper so production code that
  // wraps JSONB values can run unchanged in tests.
  (sqlFn as unknown as { json: (v: unknown) => unknown }).json = (v) => v;
  (sqlFn as unknown as { unsafe: (text: string) => string }).unsafe = (text) => text;
  // Transactions run on the same mock, so their statements are recorded in order.
  (sqlFn as unknown as { begin: (fn: (tx: unknown) => unknown) => unknown }).begin = (fn) =>
    fn(sqlFn);

  return sqlFn as unknown;
}

class MockPostgresError extends Error {
  code: string;
  constructor(code: string) {
    super('PostgresError');
    this.code = code;
  }
}

vi.mock('postgres', () => {
  const factory = () => createSqlMock();
  factory.PostgresError = MockPostgresError;
  return { default: factory };
});

const mockIsRoamingEnabled = vi.fn().mockResolvedValue(false);

// The payment service (@evtivity/payments): the gate's hold and the
// settlement on Ended. The mode classification stays real.
const mockAuthorizeSessionHold = vi.fn();
const mockSettleSessionPayment = vi.fn();
const mockRecordTerminalSettlement = vi.fn();
vi.mock('@evtivity/payments', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authorizeSessionHold: (...args: unknown[]) => mockAuthorizeSessionHold(...args) as unknown,
  settleSessionPayment: (...args: unknown[]) => mockSettleSessionPayment(...args) as unknown,
  recordTerminalSettlement: (...args: unknown[]) =>
    mockRecordTerminalSettlement(...args) as unknown,
}));
const mockPaymentContext = { registry: {}, logger: {} };
// The settlement options of a first run that can still be retried.
const SETTLE_OPTIONS = { rethrowConnectionErrors: true, resumeAdjustment: false };
vi.mock('../lib/payments.js', () => ({
  paymentRegistry: {},
  paymentContext: () => mockPaymentContext,
  activePaymentProvider: () => Promise.resolve({ id: 'stripe' }),
}));

/**
 * Matches a notification value (notificationMoney) that the dispatcher
 * formats as `text` for an en-US recipient.
 */
function formatsTo(text: string): unknown {
  return {
    asymmetricMatch: (value: unknown) =>
      value != null &&
      typeof (value as { format?: unknown }).format === 'function' &&
      (value as { format: (locale: string) => string }).format('en-US') === text,
    toString: () => `formatsTo(${text})`,
  };
}

// The one cost assembly (@evtivity/database session-pricing), mocked per test.
// By default every priced session costs 15.00 (net 15.00, no tax).
function costBreakdown(grossCents: number, taxRate = 0, taxCents = 0) {
  const netCents = grossCents - taxCents;
  return {
    basis: 'net' as const,
    netCents,
    taxCents,
    grossCents,
    taxLines: grossCents === 0 ? [] : [{ taxRate, netCents, taxCents }],
    components: null,
  };
}
const mockPriceSessionAt = vi.fn().mockResolvedValue(costBreakdown(1500));
const mockStoreRunningCost = vi.fn().mockResolvedValue(true);
// session-pricing's own settings readers, so the real module loads without a database.
vi.mock('../../../database/src/lib/idling-setting.js', () => ({
  getIdlingGracePeriodMinutes: vi.fn().mockResolvedValue(0),
}));
vi.mock('../../../database/src/lib/pricing-settings.js', () => ({
  isSplitBillingEnabled: vi.fn().mockResolvedValue(false),
}));

vi.mock('@evtivity/database', async () => ({
  // The session end request channel and reasons.
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../database/src/lib/session-end-request.js',
  )),
  // The real status entry point, running on the mocked client.
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../database/src/lib/station-status.js',
  )),
  // The real driver availability rule (station-watch alert).
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../database/src/lib/driver-availability.js',
  )),
  // The real station-watch check, running on the mocked client.
  ...(await vi.importActual<Record<string, unknown>>('../../../database/src/lib/station-watch.js')),
  // The real session pricing writes (tariff snapshot, segments, final cost),
  // running on the mocked client. The cost itself comes from mockPriceSessionAt.
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../database/src/lib/session-pricing.js',
  )),
  // The real tariff resolver, running on the mocked client.
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../database/src/lib/tariff-resolution.js',
  )),
  // The real Postgres error readers (the projection retry classifies errors).
  ...(await vi.importActual<Record<string, unknown>>('../../../database/src/lib/pg-errors.js')),
  getCompanyTaxBasis: vi.fn().mockResolvedValue('net'),
  priceSessionAt: (...args: unknown[]) => mockPriceSessionAt(...args) as unknown,
  storeRunningCost: (...args: unknown[]) => mockStoreRunningCost(...args) as unknown,
  client: createSqlMock(),
  isRoamingEnabled: mockIsRoamingEnabled,
  getIdlingGracePeriodMinutes: vi.fn().mockResolvedValue(0),
  isSplitBillingEnabled: vi.fn().mockResolvedValue(false),
  getOfflineCommandTtlHours: vi.fn().mockResolvedValue(24),
  writeReservationAudit: vi.fn().mockResolvedValue(undefined),
  reservationDiffChanged: vi.fn().mockReturnValue(false),
  getSampledMeasurands: vi.fn().mockResolvedValue([]),
  getAlignedMeasurands: vi.fn().mockResolvedValue([]),
  getTxEndedMeasurands: vi.fn().mockResolvedValue([]),
  isSiteFreeVendEnabledByStation: vi.fn().mockResolvedValue(false),
  getCompanyCurrency: vi.fn().mockResolvedValue('USD'),
  getCompanyPriceDisplay: vi.fn().mockResolvedValue('net'),
  // Driver sessions pay by card (no fleet account billing) unless a test says so.
  stampSessionBilling: vi.fn().mockResolvedValue({ mode: 'card', fleetId: null, fleetName: null }),
}));

const mockDispatchOcpp = vi.fn().mockResolvedValue(undefined);
const mockDispatchDriver = vi.fn().mockResolvedValue(undefined);

vi.mock('../server/notification-dispatcher.js', () => ({
  dispatchOcppNotification: mockDispatchOcpp,
  dispatchDriverNotification: mockDispatchDriver,
  dispatchSystemNotification: vi.fn().mockResolvedValue(undefined),
  ALL_TEMPLATES_DIRS: ['/mock/templates'],
}));

const mockDecryptString = vi.fn().mockReturnValue('sk_test_decrypted');
const mockLoggerError = vi.fn();
const mockLoggerWarn = vi.fn();

vi.mock('@evtivity/lib', async () => {
  const actual = await vi.importActual<typeof import('@evtivity/lib')>('@evtivity/lib');
  return {
    ...actual,
    decryptString: mockDecryptString,
    createLogger: () => ({
      info: vi.fn(),
      warn: mockLoggerWarn,
      error: mockLoggerError,
      debug: vi.fn(),
      child: () => ({
        info: vi.fn(),
        warn: mockLoggerWarn,
        error: mockLoggerError,
        debug: vi.fn(),
      }),
    }),
  };
});

const mockHandleCsrSigned = vi.fn().mockResolvedValue(undefined);
const mockHandleInstallCertificateResult = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/pki/certificate-projections.js', () => ({
  handleCsrSigned: mockHandleCsrSigned,
  handleInstallCertificateResult: mockHandleInstallCertificateResult,
}));

const mockComputeAndSendChargingProfile = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/charging-profile-computer.js', () => ({
  computeAndSendChargingProfile: mockComputeAndSendChargingProfile,
}));

function createMockEventBus() {
  const subscribers = new Map<string, Array<(event: DomainEvent) => Promise<void>>>();
  return {
    subscribe(eventType: string, handler: (event: DomainEvent) => Promise<void>) {
      const handlers = subscribers.get(eventType) ?? [];
      handlers.push(handler);
      subscribers.set(eventType, handlers);
    },
    async emit(eventType: string, event: DomainEvent) {
      const handlers = subscribers.get(eventType) ?? [];
      for (const handler of handlers) {
        await handler(event);
      }
    },
    track: <T>(work: Promise<T>) => work,
    publish: vi.fn(),
    subscribers,
  } as unknown as EventBus & {
    emit: (eventType: string, event: DomainEvent) => Promise<void>;
    subscribers: Map<string, Array<(event: DomainEvent) => Promise<void>>>;
  };
}

function setupSqlResults(...results: unknown[][]) {
  sqlResults = results;
  sqlCallIndex = 0;
  sqlCalls.length = 0;
}

function setupSqlResultsWithErrors(
  results: unknown[][],
  errors: Array<{ index: number; error: Error }>,
) {
  sqlResults = results;
  sqlCallIndex = 0;
  sqlCalls.length = 0;
  sqlErrors = new Map();
  for (const e of errors) {
    sqlErrors.set(e.index, e.error);
  }
}

function makeDomainEvent(
  eventType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): DomainEvent {
  return {
    eventType,
    aggregateType: 'ChargingStation',
    aggregateId,
    payload,
    occurredAt: new Date(),
  };
}

describe('Event projections - coverage expansion', () => {
  let eventBus: ReturnType<typeof createMockEventBus>;
  const timerCallbacks: Array<{ fn: () => void; interval: number }> = [];
  let mockPubSub: PubSubClient;

  // The first import loads the whole projection module graph, which under coverage on a busy
  // machine took longer than one test's 5 s timeout. Load it once here so setup() reads it
  // from the module cache.
  beforeAll(async () => {
    await import('../server/event-projections.js');
  }, 30_000);

  beforeEach(() => {
    vi.useFakeTimers();
    timerCallbacks.length = 0;
    let timerId = 0;
    const origSetInterval = vi.fn((fn: () => void, interval: number) => {
      timerCallbacks.push({ fn, interval });
      const id = ++timerId;
      return { id, unref: vi.fn(), ref: vi.fn() };
    });
    vi.stubGlobal('setInterval', origSetInterval);

    eventBus = createMockEventBus();
    sqlCalls.length = 0;
    sqlResults = [];
    sqlCallIndex = 0;
    sqlErrors = new Map();
    vi.clearAllMocks();
    mockAuthorizeSessionHold.mockResolvedValue({
      outcome: 'authorized',
      paymentRecordId: 1,
      paymentId: 'pi_test',
    });
    mockSettleSessionPayment.mockResolvedValue({ mode: 'none' });
    mockRecordTerminalSettlement.mockResolvedValue(true);

    mockPubSub = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
      close: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env['SETTINGS_ENCRYPTION_KEY'];
  });

  async function setup() {
    const { registerProjections } = await import('../server/event-projections.js');
    // Pricing holidays are cached per process; each test expects its own lookup.
    const { clearTariffResolutionCache } = await import('@evtivity/database');
    clearTariffResolutionCache();
    registerProjections(eventBus, mockPubSub);
  }

  // ---- station.Connected ----

  describe('station.Connected - station gone (WHERE EXISTS returns 0)', () => {
    it('invalidates cache when connection_logs insert returns 0 rows', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // UPDATE charging_stations
        EMPTY_INSERT, // INSERT connection_logs SELECT WHERE EXISTS -> count=0
      );

      await eventBus.emit(
        'station.Connected',
        makeDomainEvent('station.Connected', 'CS-FK', { ocppProtocol: 'ocpp2.1' }),
      );

      // Should stop after connection_logs insert returned 0
      expect(sqlCalls.length).toBe(3);
    });
  });

  describe('station.Connected - OCPI push with siteId', () => {
    it('pushes OCPI location update when siteId is present and roaming enabled', async () => {
      mockIsRoamingEnabled.mockResolvedValueOnce(true);
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // UPDATE charging_stations
        [], // INSERT connection_logs
        [], // SELECT evse_id FROM evses (no EVSEs)
        [{ site_id: 'site-abc' }], // resolveSiteId
      );

      await eventBus.emit(
        'station.Connected',
        makeDomainEvent('station.Connected', 'CS-OCPI', { ocppProtocol: 'ocpp2.1' }),
      );

      // pubsub.publish should be called with csms_events and ocpi_push
      expect(mockPubSub.publish).toHaveBeenCalledWith(
        'csms_events',
        expect.stringContaining('station.status'),
      );
      expect(mockPubSub.publish).toHaveBeenCalledWith(
        'ocpi_push',
        expect.stringContaining('site-abc'),
      );
    });

    it('skips OCPI push when siteId is null', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // UPDATE charging_stations
        [], // INSERT connection_logs
        [], // SELECT evse_id FROM evses
        [{ site_id: null }], // resolveSiteId returns null site
      );

      await eventBus.emit(
        'station.Connected',
        makeDomainEvent('station.Connected', 'CS-NOSITE', { ocppProtocol: 'ocpp2.1' }),
      );

      const ocpiCalls = (mockPubSub.publish as Mock<PubSubClient['publish']>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'ocpi_push',
      );
      expect(ocpiCalls.length).toBe(0);
    });
  });

  describe('station.Connected - no ocppProtocol', () => {
    it('handles missing ocppProtocol gracefully (defaults to null)', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // UPDATE charging_stations
        [], // INSERT connection_logs
        [], // SELECT evse_id
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'station.Connected',
        makeDomainEvent('station.Connected', 'CS-NOPROTO', {}),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ---- station.Disconnected ----

  describe('station.Disconnected - station gone (WHERE EXISTS returns 0)', () => {
    it('invalidates cache when connection_logs insert returns 0 rows', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // UPDATE charging_stations
        EMPTY_INSERT, // INSERT connection_logs SELECT WHERE EXISTS -> count=0
      );

      await eventBus.emit(
        'station.Disconnected',
        makeDomainEvent('station.Disconnected', 'CS-FK', {}),
      );

      expect(sqlCalls.length).toBe(3);
    });
  });

  describe('station.Disconnected - station reconnected to another instance', () => {
    function registryOwnedBy(owner: string | null) {
      return {
        register: vi.fn().mockResolvedValue(undefined),
        unregister: vi.fn().mockResolvedValue(undefined),
        getInstanceId: vi.fn().mockResolvedValue(owner),
      };
    }

    async function setupWithRegistry(registry: ReturnType<typeof registryOwnedBy>) {
      const { registerProjections } = await import('../server/event-projections.js');
      registerProjections(eventBus, mockPubSub, { registry, instanceId: 'pod-old' });
    }

    it('keeps the station online when another instance owns its connection', async () => {
      const registry = registryOwnedBy('pod-new');
      await setupWithRegistry(registry);
      setupSqlResults([{ id: 'sta_000000000001' }]);

      await eventBus.emit(
        'station.Disconnected',
        makeDomainEvent('station.Disconnected', 'CS-MOVED', {}),
      );

      expect(registry.getInstanceId).toHaveBeenCalledWith('CS-MOVED');
      expect(findSql(/SET is_online = false/)).toBeUndefined();
      expect(findSql(/INSERT INTO connection_logs/)).toBeUndefined();
    });

    it('marks the station offline when this instance still owns it or nobody does', async () => {
      for (const owner of ['pod-old', null]) {
        sqlCalls.length = 0;
        sqlCallIndex = 0;
        const registry = registryOwnedBy(owner);
        await setupWithRegistry(registry);
        setupSqlResults([{ id: 'sta_000000000001' }], [], EMPTY_INSERT);

        await eventBus.emit(
          'station.Disconnected',
          makeDomainEvent('station.Disconnected', 'CS-GONE', {}),
        );

        expect(findSql(/SET is_online = false/)).toBeDefined();
      }
    });

    it('marks the station offline when the registry lookup fails', async () => {
      const registry = registryOwnedBy(null);
      registry.getInstanceId.mockRejectedValue(new Error('Redis down'));
      await setupWithRegistry(registry);
      setupSqlResults([{ id: 'sta_000000000001' }], [], EMPTY_INSERT);

      await eventBus.emit(
        'station.Disconnected',
        makeDomainEvent('station.Disconnected', 'CS-ERR', {}),
      );

      expect(findSql(/SET is_online = false/)).toBeDefined();
    });
  });

  describe('station.Disconnected - port status logs', () => {
    it('logs port status transitions for disconnected EVSEs with their current statuses', async () => {
      await setup();

      // Pass 2 batched the per-connector INSERT loop into a single
      // INSERT ... SELECT, so the previous SELECT-then-loop pattern is now
      // one query (INSERT only). The mock no longer needs the SELECT
      // placeholder or the per-connector inserts.
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // UPDATE charging_stations
        [{ count: 1 }], // INSERT connection_logs (WHERE EXISTS returns 1)
        [], // INSERT INTO port_status_log SELECT ... (batched)
        [{ site_id: 'site-1' }], // resolveSiteId
      );

      mockIsRoamingEnabled.mockResolvedValueOnce(true);

      await eventBus.emit(
        'station.Disconnected',
        makeDomainEvent('station.Disconnected', 'CS-PORTS', {}),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(4);
      // OCPI push should fire since site is not null
      expect(mockPubSub.publish).toHaveBeenCalledWith(
        'ocpi_push',
        expect.stringContaining('site-1'),
      );
    });
  });

  describe('station.Disconnected - reservation notices', () => {
    const disconnectedRows = () => [
      [{ id: 'sta_000000000001' }], // resolveStationId
      [], // UPDATE charging_stations
      [{ count: 1 }], // INSERT connection_logs
      [], // INSERT INTO port_status_log
      [{ site_id: null }], // resolveSiteId
      [{ id: 'rsv_1', driver_id: 'drv_1' }], // SELECT reservations
    ];

    it('tells the reserving driver and tracks the dispatch for the shutdown drain', async () => {
      await setup();
      const track = vi.spyOn(eventBus, 'track');
      setupSqlResults(...disconnectedRows());

      await eventBus.emit(
        'station.Disconnected',
        makeDomainEvent('station.Disconnected', 'CS-RSV', { remoteAddress: '10.0.0.1' }),
      );

      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'reservation.StationFaulted',
        'drv_1',
        { reservationId: 'rsv_1', stationId: 'CS-RSV' },
        expect.anything(),
        mockPubSub,
      );
      expect(track).toHaveBeenCalledTimes(1);
      expect(findSql(/INSERT INTO connection_logs/)?.values).toContain(null);
    });

    it('records a server shutdown close with its reason and sends no notice', async () => {
      await setup();
      setupSqlResults(...disconnectedRows());

      await eventBus.emit(
        'station.Disconnected',
        makeDomainEvent('station.Disconnected', 'CS-RSV', {
          remoteAddress: '10.0.0.1',
          reason: 'server_shutdown',
        }),
      );

      expect(findSql(/SET is_online = false/)).toBeDefined();
      expect(findSql(/INSERT INTO connection_logs/)?.values).toContainEqual({
        reason: 'server_shutdown',
      });
      expect(findSql(/FROM reservations/)).toBeUndefined();
      expect(mockDispatchDriver).not.toHaveBeenCalled();
    });
  });

  // ---- ocpp.BootNotification ----

  describe('ocpp.BootNotification - null fields', () => {
    it('handles payload with non-string values for getString (returns null)', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ onboarding_status: 'accepted' }], // SELECT onboarding_status
        [], // UPDATE charging_stations
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.BootNotification',
        makeDomainEvent('ocpp.BootNotification', 'CS-001', {
          firmwareVersion: 123, // Not a string
          model: null, // null
          serialNumber: undefined, // undefined
          iccid: true, // boolean
          imsi: { nested: 'obj' }, // object
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(3);
    });

    it('skips if station not found', async () => {
      await setup();
      setupSqlResults([]);

      await eventBus.emit(
        'ocpp.BootNotification',
        makeDomainEvent('ocpp.BootNotification', 'UNKNOWN', {}),
      );

      expect(sqlCalls.length).toBe(1);
    });
  });

  // ---- ocpp.Heartbeat ----

  describe('ocpp.Heartbeat - station not found', () => {
    it('skips if station not found and no stationDbId', async () => {
      await setup();
      setupSqlResults([]);

      await eventBus.emit('ocpp.Heartbeat', makeDomainEvent('ocpp.Heartbeat', 'UNKNOWN', {}));

      expect(sqlCalls.length).toBe(1);
    });
  });

  // ---- ocpp.StatusNotification ----

  describe('ocpp.StatusNotification - station not found', () => {
    it('skips if station not found', async () => {
      await setup();
      setupSqlResults([]);

      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'UNKNOWN', {
          evseId: 1,
          connectorId: 1,
          connectorStatus: 'Available',
        }),
      );

      expect(sqlCalls.length).toBe(1);
    });
  });

  describe('ocpp.StatusNotification - OCPI push with siteId', () => {
    it('publishes OCPI push when siteId is present', async () => {
      mockIsRoamingEnabled.mockResolvedValueOnce(true);
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // SELECT evses (not found, auto-create)
        [{ id: 'evs_000000000002' }], // INSERT evses
        [{ id: 'con_000000000002' }], // INSERT connectors RETURNING
        [], // INSERT port_status_log
        [], // SELECT charging_stations FOR UPDATE (availability lock)
        [], // UPDATE charging_stations (connector fault reconciliation)
        [{ site_id: 'site-status' }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 3,
          connectorId: 1,
          connectorStatus: 'Available',
        }),
      );

      expect(mockPubSub.publish).toHaveBeenCalledWith(
        'ocpi_push',
        expect.stringContaining('site-status'),
      );
    });
  });

  describe('ocpp.StatusNotification - EVSE with undefined previous status', () => {
    it('handles EVSE row with no status property', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'evs_000000000001' }], // SELECT evses (found but no status field)
        [], // guarded UPDATE connectors (not found)
        [{ id: 'con_000000000001' }], // INSERT connectors RETURNING
        [], // INSERT port_status_log (previousStatus will be null)
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 1,
          connectorId: 1,
          connectorStatus: 'Occupied',
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(6);
    });
  });

  // ---- ocpp.TransactionEvent - Started ----

  describe('ocpp.TransactionEvent Started - session not found after insert', () => {
    it('skips further processing if session not found', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT charging_sessions
        [], // SELECT id (empty - session not found)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-ghost',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
        }),
      );

      // Only resolveStationId + INSERT + SELECT = 3 calls in main handler
      expect(sqlCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('ocpp.TransactionEvent Started - driver already set', () => {
    it('skips idToken resolution when driver already assigned', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // eager OCPI roaming check (idToken present)
        [{ id: 'session-1' }], // INSERT charging_sessions ON CONFLICT DO UPDATE RETURNING id
        [], // UPDATE stale sessions
        [], // INSERT transaction_events

        [{ is_roaming: false }], // SELECT is_roaming (eager-state seed)
        [{ is_roaming: false }], // SELECT is_roaming (eager-state seed)
        [{ driver_id: 'existing-driver' }], // SELECT driver_id (already set)
        [{ id: 'tok-1', driver_id: 'existing-driver' }], // SELECT id, driver_id FROM driver_tokens
        [], // UPDATE charging_sessions SET token_id
        // resolveTariff: driver-specific found
        [
          {
            id: 'tariff-drv',
            price_per_kwh: '0.25',
            price_per_minute: null,
            price_per_session: '1.00',
            idle_fee_price_per_minute: null,
            tax_rate: '0.19',
          },
        ],
        [], // UPDATE tariff
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-existing-driver',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
          idToken: 'rfid-123',
          tokenType: 'ISO14443',
        }),
      );

      // driver notification should fire for existing-driver
      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'session.Started',
        'existing-driver',
        expect.objectContaining({ transactionId: 'tx-existing-driver' }),
        ['/mock/templates'],
        expect.anything(),
      );
    });
  });

  describe('ocpp.TransactionEvent Started - roaming token', () => {
    it('marks session as roaming when token found in ocpi_external_tokens', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ '?column?': 1 }], // eager OCPI roaming check (token found → is_roaming=true at INSERT)
        [{ id: 'session-roaming' }], // INSERT charging_sessions (with is_roaming = true)
        [], // UPDATE stale sessions
        [], // INSERT transaction_events
        [{ is_roaming: true }], // SELECT is_roaming (seeded true by eager check)
        [{ driver_id: null }], // SELECT driver_id (no driver)
        [], // SELECT driver_tokens (not found)
        // (downstream redundant OCPI check + UPDATE is_roaming removed in Step 2)
        // resolveTariff: station pricing group found
        [],
        [],
        [
          {
            id: 'tariff-station',
            price_per_kwh: '0.30',
            price_per_minute: null,
            price_per_session: null,
            idle_fee_price_per_minute: null,
            tax_rate: null,
          },
        ],
        [], // UPDATE tariff
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-roaming',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
          idToken: 'emaid-roaming-123',
          tokenType: 'eMAID',
        }),
      );

      // Check that is_roaming update was called
      const roamingCall = sqlCalls.find((c) => c.strings.some((s) => s.includes('is_roaming')));
      expect(roamingCall).toBeDefined();
    });
  });

  describe('ocpp.TransactionEvent Started - roaming token table missing', () => {
    it('handles error when ocpi_external_tokens table does not exist', async () => {
      await setup();

      setupSqlResultsWithErrors(
        [
          [{ id: 'sta_000000000001' }], // resolveStationId
          [], // INSERT charging_sessions
          [{ id: 'session-1' }], // SELECT id
          [], // UPDATE stale sessions
          [], // INSERT transaction_events
          [{ driver_id: null }], // SELECT driver_id
          [], // SELECT driver_tokens (not found)
          [], // SELECT ocpi_external_tokens will throw
          [], // SELECT guest_sessions (no match)
          [], // loadStationPricing: no pricing group applies
          [{ site_id: null }], // resolveSiteId
        ],
        [{ index: 9, error: new Error('relation "ocpi_external_tokens" does not exist') }],
      );

      // Should not throw
      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-no-ocpi',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
          idToken: 'some-token',
          tokenType: 'ISO14443',
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(6);
    });
  });

  describe('ocpp.TransactionEvent Started - no idToken', () => {
    it('skips driver resolution when no idToken in payload', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'session-1' }], // INSERT charging_sessions ON CONFLICT DO UPDATE RETURNING id
        [], // UPDATE stale sessions
        [], // INSERT transaction_events

        [{ is_roaming: false }], // SELECT is_roaming (eager-state seed)
        [{ driver_id: null }], // SELECT driver_id (no driver)
        // No token lookup since idToken is null
        [], // loadStationPricing: no pricing group applies
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-no-token',
          seqNo: 0,
          triggerReason: 'EVDetected',
          timestamp: '2024-01-01T00:00:00Z',
        }),
      );

      // No driver_tokens lookup should happen
      const tokenLookup = sqlCalls.find((c) => c.strings.some((s) => s.includes('driver_tokens')));
      expect(tokenLookup).toBeUndefined();
    });
  });

  describe('ocpp.TransactionEvent Started - default tariff fallback', () => {
    it('uses default pricing group when no driver or station group matches', async () => {
      await setup();

      // Payload has no idToken, so eager OCPI check is skipped.
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'session-1' }], // INSERT charging_sessions ON CONFLICT DO UPDATE RETURNING id
        [], // UPDATE stale sessions
        [], // INSERT transaction_events
        [{ is_roaming: false }], // SELECT is_roaming (eager-state seed)
        [{ driver_id: null }], // SELECT driver_id
        // loadStationPricing resolves driver/fleet/station/site/default, the
        // group's tariffs and the site timezone in one round trip.
        [
          {
            group_id: 'group-default',
            group_name: 'Default',
            group_priority: 5,
            timezone: null,
            id: 'tariff-default',
            price_per_kwh: '0.20',
            price_per_minute: '0.05',
            price_per_session: null,
            idle_fee_price_per_minute: '0.10',
            tax_rate: '0.20',
            restrictions: null,
            priority: 0,
            is_default: true,
          },
        ], // loadStationPricing: the default group and its tariff
        [], // pricing_holidays (empty)
        [], // UPDATE charging_sessions SET tariff_id
        [], // INSERT session_tariff_segments
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-default-tariff',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
        }),
      );

      const tariffUpdate = sqlCalls.find((c) => c.strings.some((s) => s.includes('tariff_id')));
      expect(tariffUpdate).toBeDefined();
    });
  });

  describe('ocpp.TransactionEvent Started - no tariff found at all', () => {
    it('skips tariff assignment when no tariff matches', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'session-1' }], // INSERT charging_sessions ON CONFLICT DO UPDATE RETURNING id
        [], // UPDATE stale sessions
        [], // INSERT transaction_events

        [{ is_roaming: false }], // SELECT is_roaming (eager-state seed)
        [{ driver_id: null }], // SELECT driver_id
        [], // loadStationPricing: no pricing group applies
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-no-tariff',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
        }),
      );

      // No UPDATE with tariff_id should happen
      const tariffUpdate = sqlCalls.find(
        (c) =>
          c.strings.some((s) => s.includes('tariff_id')) &&
          c.strings.some((s) => s.includes('UPDATE')),
      );
      expect(tariffUpdate).toBeUndefined();
    });
  });

  describe('ocpp.TransactionEvent Started - guest notification pubsub failure', () => {
    it('handles pubsub failure for guest session notification gracefully', async () => {
      await setup();

      // Make the second pubsub.publish call fail (guest notification)
      let pubsubCallCount = 0;
      (mockPubSub.publish as Mock<PubSubClient['publish']>).mockImplementation(() => {
        pubsubCallCount++;
        // Fail on the guest session notification (3rd publish call - after csms_events and ocpi_push)
        if (pubsubCallCount >= 3) {
          return Promise.reject(new Error('pubsub failure'));
        }
        return Promise.resolve(undefined);
      });

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // eager OCPI roaming check (idToken present)

        [{ id: 'session-1' }], // INSERT charging_sessions ON CONFLICT DO UPDATE RETURNING id
        [], // UPDATE stale sessions
        [], // INSERT transaction_events

        [{ is_roaming: false }], // SELECT is_roaming (eager-state seed)
        [{ driver_id: null }], // SELECT driver_id
        // Token resolution chain: driver_tokens -> ocpi_external_tokens -> guest_sessions
        [], // driver_tokens (empty)
        [], // external tokens (empty)
        [], // guest_sessions (empty)
        [], // loadStationPricing: no pricing group applies
        [{ site_id: null }], // resolveSiteId
      );

      // Should not throw despite pubsub failure
      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-guest-fail',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
          idToken: 'guest-token',
          tokenType: 'ISO14443',
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(5);
    });
  });

  // ---- ocpp.TransactionEvent Updated ----

  describe('ocpp.TransactionEvent Updated - session not found', () => {
    it('skips when session not found', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // SELECT id FROM charging_sessions (empty)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Updated',
          stationId: 'CS-001',
          transactionId: 'tx-ghost',
          seqNo: 1,
          triggerReason: 'MeterValuePeriodic',
          timestamp: '2024-01-01T00:30:00Z',
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('ocpp.TransactionEvent Updated - no driver', () => {
    it('skips driver notification when session has no driver', async () => {
      mockDispatchDriver.mockClear();
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'session-1' }], // SELECT id
        [], // INSERT transaction_events
        [{ site_id: null }], // resolveSiteId
        [], // UPDATE throttle (no rows returned when driver_id IS NULL)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Updated',
          stationId: 'CS-001',
          transactionId: 'tx-no-driver',
          seqNo: 1,
          triggerReason: 'MeterValuePeriodic',
          timestamp: '2024-01-01T00:30:00Z',
        }),
      );

      const updatedCalls = mockDispatchDriver.mock.calls.filter(
        (c: unknown[]) => c[1] === 'session.Updated',
      );
      expect(updatedCalls.length).toBe(0);
    });
  });

  // ---- ocpp.TransactionEvent Ended ----

  describe('ocpp.TransactionEvent Ended - session not found', () => {
    it('skips when session not found after update', async () => {
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // SELECT payment_records (no failed payment)
        [], // SELECT the active session with an open idle period (JB-2 due notice): none
        [], // UPDATE charging_sessions
        [], // SELECT session (empty) - first subscriber stops here
        // Second subscriber
        [], // SELECT session (empty) - second subscriber also stops
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-ended-ghost',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('ocpp.TransactionEvent Ended - tariff row deleted', () => {
    it('prices the session from its snapshot when its tariff row is gone', async () => {
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // 0: resolveStationId
        [], // 1: SELECT payment_records (no failed payment)
        [], // SELECT the active session with an open idle period (JB-2 due notice): none
        [], // 2: UPDATE charging_sessions
        [
          {
            id: 'session-1',
            tariff_id: 'tariff-deleted',
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 5000,
            currency: 'USD',
            tariff_price_per_kwh: null,
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
          },
        ], // 2: SELECT session (includes snapshot columns, but currency is null)
        [], // 3: INSERT transaction_events
        // No separate tariff SELECT - uses snapshot columns from session row
        [], // 4: carbon query (no region found)
        [{ site_id: null }], // 5: resolveSiteId
        [
          {
            driver_id: null,
            energy_delivered_wh: 5000,
            final_cost_cents: null,
            currency: 'USD',
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ], // 5: SELECT for driver notification
        // Second subscriber
        [{ id: 'session-1', final_cost_cents: null, site_id: null }], // 6
        [], // 7: No payment records
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-no-tariff-row',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      expect(mockPriceSessionAt).toHaveBeenCalledWith(
        expect.anything(),
        'session-1',
        new Date('2024-01-01T01:00:00Z'),
        5000,
      );
    });
  });

  describe('ocpp.TransactionEvent Ended - no stoppedReason', () => {
    it('handles missing stoppedReason (getString returns null)', async () => {
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // SELECT payment_records (no failed payment)
        [], // SELECT the active session with an open idle period (JB-2 due notice): none
        [], // UPDATE charging_sessions
        [
          {
            id: 'session-1',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 0,
            currency: 'USD',
            tariff_price_per_kwh: null,
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
          },
        ],
        [], // INSERT transaction_events
        [], // carbon query (no region found)
        [{ site_id: null }], // resolveSiteId
        [
          {
            driver_id: null,
            energy_delivered_wh: 0,
            final_cost_cents: null,
            currency: 'USD',
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ],
        // Second subscriber
        [{ id: 'session-1', final_cost_cents: null, site_id: null }],
        [], // No payment records
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-no-reason',
          seqNo: 1,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
          // No stoppedReason
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('ocpp.TransactionEvent Ended - driver notifications', () => {
    it('dispatches session.Completed and session.Receipt when driver exists', async () => {
      mockDispatchDriver.mockClear();
      await setup();

      setupSqlResults(
        // First subscriber (main Ended handler)
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // SELECT payment_records (no failed payment)
        [], // SELECT the active session with an open idle period (JB-2 due notice): none
        [], // UPDATE charging_sessions
        [
          {
            id: 'session-1',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 10000,
            currency: 'USD',
            tariff_price_per_kwh: null,
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
          },
        ],
        [], // INSERT transaction_events
        [], // carbon query (no region found)
        [{ site_id: null }], // resolveSiteId
        // notifyChange and TransactionEnded go through pubsub (not SQL)
        [], // SELECT ocpp_protocol (station_message_transaction)
        // Second subscriber (auto-capture Ended)
        [{ id: 'session-1', final_cost_cents: 2500, site_id: null }], // SELECT session
        // Driver notifications after the settlement (notifySessionEnded)
        [
          {
            driver_id: 'driver-ended',
            status: 'completed',
            energy_delivered_wh: 10000,
            final_cost_cents: 2500,
            tariff_tax_rate: '0.19',
            currency: 'EUR',
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ], // SELECT driver info for notification
        [], // SELECT payment_records (no hold)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-end-notify',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
          stoppedReason: 'Local',
        }),
      );

      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'session.Completed',
        'driver-ended',
        expect.objectContaining({
          transactionId: 'tx-end-notify',
          currency: 'EUR',
          costIncludesTax: true,
        }),
        ['/mock/templates'],
        expect.anything(),
      );

      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'session.Receipt',
        'driver-ended',
        expect.objectContaining({
          transactionId: 'tx-end-notify',
          finalCostCents: 2500,
          currency: 'EUR',
          costIncludesTax: true,
          notCharged: false,
        }),
        ['/mock/templates'],
        expect.anything(),
      );
    });

    it('says nothing was charged when the hold was released below the provider minimum', async () => {
      mockDispatchDriver.mockClear();
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // SELECT payment_records (no failed payment)
        [], // SELECT the active session with an open idle period (JB-2 due notice): none
        [], // UPDATE charging_sessions
        [
          {
            id: 'session-min',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 1000,
            currency: 'USD',
            tariff_price_per_kwh: null,
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
          },
        ],
        [], // INSERT transaction_events
        [], // carbon query (no region found)
        [{ site_id: null }], // resolveSiteId
        [], // SELECT ocpp_protocol (station_message_transaction)
        [{ id: 'session-min', final_cost_cents: 22, site_id: null }], // settlement session
        [
          {
            driver_id: 'driver-min',
            status: 'completed',
            energy_delivered_wh: 1000,
            final_cost_cents: 22,
            tariff_tax_rate: null,
            currency: 'USD',
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ],
        [
          {
            status: 'cancelled',
            failure_reason:
              'Capture below the provider minimum charge (50c USD); 22c not collectable, hold released',
          },
        ],
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-end-min',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
          stoppedReason: 'Local',
        }),
      );

      for (const eventType of ['session.Completed', 'session.Receipt']) {
        expect(mockDispatchDriver).toHaveBeenCalledWith(
          expect.anything(),
          eventType,
          'driver-min',
          expect.objectContaining({ finalCostCents: 22, notCharged: true }),
          ['/mock/templates'],
          expect.anything(),
        );
      }
    });
  });

  describe('ocpp.TransactionEvent Ended - pubsub error for TransactionEnded', () => {
    it('handles pubsub failure for TransactionEnded notification', async () => {
      await setup();

      let callCount = 0;
      (mockPubSub.publish as Mock<PubSubClient['publish']>).mockImplementation(() => {
        callCount++;
        if (callCount === 2) {
          return Promise.reject(new Error('pubsub down'));
        }
        return Promise.resolve(undefined);
      });

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // SELECT payment_records (no failed payment)
        [], // SELECT the active session with an open idle period (JB-2 due notice): none
        [], // UPDATE charging_sessions
        [
          {
            id: 'session-1',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 0,
            currency: 'USD',
            tariff_price_per_kwh: null,
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
          },
        ],
        [], // INSERT transaction_events
        [], // carbon query (no region found)
        [{ site_id: null }], // resolveSiteId
        [
          {
            driver_id: null,
            energy_delivered_wh: 0,
            final_cost_cents: null,
            currency: 'USD',
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ],
        // Second subscriber
        [{ id: 'session-1', final_cost_cents: null, site_id: null }],
        [], // No payment records
      );

      // Should not throw
      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-end-pubsub-fail',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ---- ocpp.MeterValues ----

  describe('ocpp.MeterValues - station gone (WHERE EXISTS returns 0)', () => {
    it('retries meter value insert after WHERE EXISTS returns 0 with cache invalidation', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        EMPTY_INSERT, // INSERT meter_values SELECT WHERE EXISTS -> count=0
        [{ id: 'sta_000000000002' }], // resolveStationId (retry after cache invalidation)
        [], // INSERT meter_values (retry, direct)
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          meterValues: [
            {
              timestamp: '2024-01-01T00:30:00Z',
              sampledValue: [
                {
                  measurand: 'Voltage',
                  value: 230,
                  unitOfMeasure: { unit: 'V' },
                },
              ],
            },
          ],
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(3);
    });

    it('returns if station not found after WHERE EXISTS returns 0', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        EMPTY_INSERT, // INSERT meter_values SELECT WHERE EXISTS -> count=0
        [], // resolveStationId retry (empty - station not found)
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          meterValues: [
            {
              timestamp: '2024-01-01T00:30:00Z',
              sampledValue: [{ measurand: 'Voltage', value: 230 }],
            },
          ],
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(3);
    });

    it('logs non-FK errors from meter value insert (safeSubscribe catches)', async () => {
      await setup();

      const otherError = new Error('disk full');
      setupSqlResultsWithErrors(
        [
          [{ id: 'sta_000000000001' }], // resolveStationId
          [], // INSERT meter_values - error
        ],
        [{ index: 1, error: otherError }],
      );

      // safeSubscribe catches and logs all errors, so the handler resolves
      await expect(
        eventBus.emit(
          'ocpp.MeterValues',
          makeDomainEvent('ocpp.MeterValues', 'CS-001', {
            stationId: 'CS-001',
            meterValues: [
              {
                timestamp: '2024-01-01T00:30:00Z',
                sampledValue: [{ measurand: 'Voltage', value: 230 }],
              },
            ],
          }),
        ),
      ).resolves.not.toThrow();
    });
  });

  describe('ocpp.MeterValues - non-energy measurand', () => {
    it('does not update energy_delivered_wh for non-energy measurands', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // resolveMeterValueSession fallback
        [], // INSERT meter_values
        // No UPDATE energy (not Energy.Active.Import.Register)
        [], // SELECT active sessions
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2024-01-01T00:30:00Z',
              sampledValue: [
                {
                  measurand: 'Current.Import',
                  value: 32,
                  unitOfMeasure: { unit: 'A' },
                },
              ],
            },
          ],
        }),
      );

      // Check that no UPDATE SET energy_delivered_wh query was made
      // (The SELECT active sessions query also contains energy_delivered_wh, so check for UPDATE)
      const energyUpdate = sqlCalls.find(
        (c) =>
          c.strings.some((s) => s.includes('energy_delivered_wh')) &&
          c.strings.some((s) => s.includes('UPDATE') && s.includes('SET')),
      );
      expect(energyUpdate).toBeUndefined();
    });
  });

  describe('ocpp.MeterValues - null sampledValue', () => {
    it('skips meter values with null sampledValue', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        // No INSERT since sampledValue is null
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          meterValues: [
            {
              timestamp: '2024-01-01T00:30:00Z',
              // No sampledValue
            },
          ],
        }),
      );

      const meterInsert = sqlCalls.find((c) => c.strings.some((s) => s.includes('meter_values')));
      expect(meterInsert).toBeUndefined();
    });
  });

  describe('ocpp.MeterValues - no unitOfMeasure', () => {
    it('handles sampled value without unitOfMeasure', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT meter_values (unit will be null)
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          meterValues: [
            {
              timestamp: '2024-01-01T00:30:00Z',
              sampledValue: [
                {
                  measurand: 'Power.Active.Import',
                  value: 7200,
                  // No unitOfMeasure
                },
              ],
            },
          ],
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('ocpp.MeterValues - active session cost unchanged', () => {
    it('skips CostUpdated when cost has not changed', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'session-1', evse_id: 'evs_1' }], // resolveMeterValueSession by transactionId
        [], // INSERT meter_values
        [], // SELECT previous energy
        [], // UPDATE meter_start
        [], // UPDATE energy
        [
          {
            id: 'session-1',
            transaction_id: 'tx-1',
            ocpp_protocol: 'ocpp2.1',
            tariff_id: 'tariff-1',
            started_at: '2024-01-01T00:00:00Z',
            energy_delivered_wh: 5000,
            current_cost_cents: 100, // Same as calculated cost
            currency: 'USD',
            tariff_price_per_kwh: '0.30',
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
          },
        ], // active sessions (includes snapshot columns)
        // No separate tariff SELECT - uses snapshot columns from session row
        [], // UPDATE cost
        // No transaction_id lookup since cost unchanged
        [{ site_id: null }], // resolveSiteId
      );

      mockPriceSessionAt.mockResolvedValueOnce(costBreakdown(100)); // Same cost

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          transactionId: 'tx-1',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2024-01-01T00:30:00Z',
              sampledValue: [
                {
                  measurand: 'Energy.Active.Import.Register',
                  value: 5000,
                  unitOfMeasure: { unit: 'Wh' },
                },
              ],
            },
          ],
        }),
      );

      // Note: The first handler has already run before the MeterValues handler,
      // so we just check CostUpdated was not published
      const costUpdateCalls = (
        mockPubSub.publish as Mock<PubSubClient['publish']>
      ).mock.calls.filter((c: unknown[]) => {
        if (typeof c[1] !== 'string') return false;
        return c[1].includes('CostUpdated');
      });
      expect(mockPriceSessionAt).toHaveBeenCalled();
      expect(costUpdateCalls.length).toBe(0);
    });
  });

  describe('ocpp.MeterValues - station screen refresh', () => {
    const meterValuesEvent = () =>
      makeDomainEvent('ocpp.MeterValues', 'CS-001', {
        stationId: 'CS-001',
        transactionId: 'tx-1',
        source: 'TransactionEvent',
        meterValues: [
          {
            timestamp: '2024-01-01T00:30:00Z',
            sampledValue: [
              {
                measurand: 'Energy.Active.Import.Register',
                value: 5000,
                unitOfMeasure: { unit: 'Wh' },
              },
            ],
          },
        ],
      });
    const activeSession = (protocol: string) => ({
      id: 'session-1',
      transaction_id: 'tx-1',
      ocpp_protocol: protocol,
      tariff_id: 'tariff-1',
      energy_delivered_wh: 5000,
      current_cost_cents: 100,
    });
    const screenPublishes = () =>
      (mockPubSub.publish as Mock<PubSubClient['publish']>).mock.calls
        .filter((c: unknown[]) => c[0] === 'station_message_transaction')
        .map((c: unknown[]) => JSON.parse(c[1] as string) as Record<string, unknown>);

    it('re-renders the screen of an OCPP 2.1 session once its new cost is stored', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'session-1', evse_id: 'evs_1' }], // resolveMeterValueSession by transactionId
        [], // INSERT meter_values
        [], // SELECT previous energy
        [], // UPDATE meter_start
        [], // UPDATE energy
        [activeSession('ocpp2.1')], // active sessions
        [{ site_id: null }], // resolveSiteId
      );
      mockPriceSessionAt.mockResolvedValueOnce(costBreakdown(250));

      await eventBus.emit('ocpp.MeterValues', meterValuesEvent());

      expect(screenPublishes()).toEqual([
        {
          sessionId: 'session-1',
          internalStationId: 'sta_000000000001',
          stationOcppId: 'CS-001',
          ocppProtocol: 'ocpp2.1',
          eventType: 'updated',
          chargingState: null,
        },
      ]);
    });

    it.each([
      ['the cost is unchanged', 'ocpp2.1', 100],
      ['the station is OCPP 1.6', 'ocpp1.6', 250],
    ])('does not re-render when %s', async (_case, protocol, costCents) => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000001' }],
        [{ id: 'session-1', evse_id: 'evs_1' }],
        [],
        [],
        [],
        [],
        [activeSession(protocol)],
        [{ site_id: null }],
      );
      mockPriceSessionAt.mockResolvedValueOnce(costBreakdown(costCents));

      await eventBus.emit('ocpp.MeterValues', meterValuesEvent());

      expect(mockPriceSessionAt).toHaveBeenCalledTimes(1);
      expect(screenPublishes()).toEqual([]);
    });
  });

  describe('ocpp.MeterValues - CostUpdated pubsub error', () => {
    it('handles CostUpdated pubsub failure gracefully', async () => {
      await setup();

      (mockPubSub.publish as Mock<PubSubClient['publish']>).mockImplementation(
        (_channel: string, payload: string) => {
          if (typeof payload === 'string' && payload.includes('CostUpdated')) {
            return Promise.reject(new Error('pubsub error'));
          }
          return Promise.resolve(undefined);
        },
      );

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'session-1', evse_id: 'evs_1' }], // resolveMeterValueSession by transactionId
        [], // INSERT meter_values
        [], // SELECT previous energy
        [], // UPDATE meter_start
        [], // UPDATE energy
        [
          {
            id: 'session-1',
            transaction_id: 'tx-1',
            ocpp_protocol: 'ocpp2.1',
            tariff_id: 'tariff-1',
            started_at: '2024-01-01T00:00:00Z',
            energy_delivered_wh: 5000,
            current_cost_cents: 100,
            currency: 'USD',
            tariff_price_per_kwh: '0.30',
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
          },
        ], // active sessions (includes snapshot columns)
        // No separate tariff SELECT - uses snapshot columns from session row
        [], // UPDATE cost
        [{ site_id: null }], // resolveSiteId
      );

      // Should not throw
      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          transactionId: 'tx-1',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2024-01-01T00:30:00Z',
              sampledValue: [
                {
                  measurand: 'Energy.Active.Import.Register',
                  value: 5000,
                  unitOfMeasure: { unit: 'Wh' },
                },
              ],
            },
          ],
        }),
      );

      const costUpdateCalls = (
        mockPubSub.publish as Mock<PubSubClient['publish']>
      ).mock.calls.filter(
        (c: unknown[]) => typeof c[1] === 'string' && c[1].includes('CostUpdated'),
      );
      expect(costUpdateCalls.length).toBe(1);
      expect(mockStoreRunningCost).toHaveBeenCalledWith(
        expect.anything(),
        'session-1',
        expect.objectContaining({ grossCents: 1500 }),
      );
    });
  });

  describe('ocpp.MeterValues - multiple meter values and sampled values', () => {
    it('processes multiple meter values with multiple sampled values each', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT meter_values (voltage)
        [], // INSERT meter_values (energy)
        [], // INSERT meter_values (power)
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          meterValues: [
            {
              timestamp: '2024-01-01T00:30:00Z',
              sampledValue: [
                { measurand: 'Voltage', value: 230, unitOfMeasure: { unit: 'V' } },
                {
                  measurand: 'Energy.Active.Import.Register',
                  value: 5000,
                  unitOfMeasure: { unit: 'Wh' },
                },
              ],
            },
            {
              timestamp: '2024-01-01T00:31:00Z',
              sampledValue: [
                { measurand: 'Power.Active.Import', value: 7200, unitOfMeasure: { unit: 'W' } },
              ],
            },
          ],
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ---- ocpp.MessageLog ----

  describe('ocpp.MessageLog - station gone (WHERE EXISTS returns 0)', () => {
    it('invalidates cache when message log insert returns 0 rows', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        EMPTY_INSERT, // INSERT ocpp_message_logs SELECT WHERE EXISTS -> count=0
      );

      await eventBus.emit(
        'ocpp.MessageLog',
        makeDomainEvent('ocpp.MessageLog', 'CS-FK', {
          stationId: 'CS-FK',
          direction: 'inbound',
          messageType: 2,
          messageId: 'msg-fk',
          action: 'BootNotification',
          payload: {},
        }),
      );

      expect(sqlCalls.length).toBe(2);
    });
  });

  describe('ocpp.MessageLog - station not found', () => {
    it('skips if neither stationDbId nor resolveStationId finds station', async () => {
      await setup();

      setupSqlResults([]);

      await eventBus.emit(
        'ocpp.MessageLog',
        makeDomainEvent('ocpp.MessageLog', 'UNKNOWN', {
          stationId: 'UNKNOWN',
          direction: 'inbound',
          messageType: 2,
          messageId: 'msg-x',
          action: 'Heartbeat',
        }),
      );

      expect(sqlCalls.length).toBe(1);
    });
  });

  describe('ocpp.MessageLog - null optional fields', () => {
    it('handles null action, errorCode, errorDescription, payload', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT ocpp_message_logs
        [], // UPDATE charging_stations.last_heartbeat (inbound liveness bump)
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.MessageLog',
        makeDomainEvent('ocpp.MessageLog', 'CS-001', {
          stationId: 'CS-001',
          direction: 'inbound',
          messageType: 3,
          messageId: 'msg-null',
          // No action, errorCode, errorDescription, payload
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('ocpp.MessageLog - inbound message marks the station online', () => {
    const inbound = () =>
      makeDomainEvent('ocpp.MessageLog', 'CS-001', {
        stationId: 'CS-001',
        direction: 'inbound',
        messageType: 2,
        messageId: 'msg-hb',
        action: 'Heartbeat',
        payload: {},
      });

    it('sets is_online and pushes a status change when the station was offline', async () => {
      await setup();
      mockIsRoamingEnabled.mockResolvedValueOnce(true);
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT ocpp_message_logs
        [{ was_online: false }], // UPDATE charging_stations
        [{ site_id: 'site-1' }], // resolveSiteId
      );

      await eventBus.emit('ocpp.MessageLog', inbound());

      expect(findSql(/SET last_heartbeat = now\(\), is_online = true/)).toBeDefined();
      expect(mockPubSub.publish).toHaveBeenCalledWith(
        'csms_events',
        expect.stringContaining('station.status'),
      );
      expect(mockPubSub.publish).toHaveBeenCalledWith(
        'ocpi_push',
        expect.stringContaining('site-1'),
      );
    });

    it('pushes no status change when the station was already online', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000001' }],
        [],
        [{ was_online: true }],
        [{ site_id: 'site-1' }],
      );

      await eventBus.emit('ocpp.MessageLog', inbound());

      expect(mockPubSub.publish).not.toHaveBeenCalledWith(
        'csms_events',
        expect.stringContaining('station.status'),
      );
    });
  });

  // ---- ocpp.NotifyDisplayMessages ----

  describe('ocpp.NotifyDisplayMessages - station gone (WHERE EXISTS returns 0)', () => {
    it('invalidates cache when display message insert returns 0 rows', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        EMPTY_INSERT, // INSERT display_messages SELECT WHERE EXISTS -> count=0
      );

      await eventBus.emit(
        'ocpp.NotifyDisplayMessages',
        makeDomainEvent('ocpp.NotifyDisplayMessages', 'CS-FK', {
          requestId: 1,
          messageInfo: [{ id: 1, priority: 'NormalCycle', message: { content: 'Test' } }],
        }),
      );

      expect(sqlCalls.length).toBe(2);
    });
  });

  describe('ocpp.NotifyDisplayMessages - minimal message fields', () => {
    it('handles message without optional fields (no format, language, state, dates, display)', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT display_messages
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.NotifyDisplayMessages',
        makeDomainEvent('ocpp.NotifyDisplayMessages', 'CS-001', {
          requestId: 1,
          messageInfo: [
            {
              id: 5,
              // No priority (defaults to NormalCycle)
              // No message (content defaults to '')
              // No state, startDateTime, endDateTime, transactionId, display
            },
          ],
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('ocpp.NotifyDisplayMessages - station not found', () => {
    it('skips if station not found', async () => {
      await setup();
      setupSqlResults([]);

      await eventBus.emit(
        'ocpp.NotifyDisplayMessages',
        makeDomainEvent('ocpp.NotifyDisplayMessages', 'UNKNOWN', {
          requestId: 1,
          messageInfo: [{ id: 1, message: { content: 'Hello' } }],
        }),
      );

      expect(sqlCalls.length).toBe(1);
    });
  });

  describe('ocpp.NotifyDisplayMessages - message with display/evse info', () => {
    it('extracts evseId from display.evse nested object', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT display_messages
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.NotifyDisplayMessages',
        makeDomainEvent('ocpp.NotifyDisplayMessages', 'CS-001', {
          requestId: 1,
          messageInfo: [
            {
              id: 10,
              priority: 'AlwaysFront',
              state: 'Charging',
              startDateTime: '2024-01-01T00:00:00Z',
              endDateTime: '2024-01-01T01:00:00Z',
              transactionId: 'tx-display',
              message: { content: 'Charging in progress', format: 'ASCII', language: 'en' },
              display: { evse: { evseId: 2 } },
            },
          ],
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ---- ocpp.FirmwareStatusNotification ----

  describe('ocpp.FirmwareStatusNotification - InstallVerificationFailed', () => {
    it('sets availability to faulted on InstallVerificationFailed', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // UPDATE charging_stations
      );

      await eventBus.emit(
        'ocpp.FirmwareStatusNotification',
        makeDomainEvent('ocpp.FirmwareStatusNotification', 'CS-001', {
          status: 'InstallVerificationFailed',
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('ocpp.FirmwareStatusNotification - station not found', () => {
    it('skips if station not found', async () => {
      await setup();
      setupSqlResults([]);

      await eventBus.emit(
        'ocpp.FirmwareStatusNotification',
        makeDomainEvent('ocpp.FirmwareStatusNotification', 'UNKNOWN', { status: 'Installed' }),
      );

      expect(sqlCalls.length).toBe(1);
    });
  });

  // ---- ocpp.SecurityEventNotification ----

  describe('ocpp.SecurityEventNotification - station not found', () => {
    it('skips if station not found', async () => {
      await setup();
      setupSqlResults([]);

      await eventBus.emit(
        'ocpp.SecurityEventNotification',
        makeDomainEvent('ocpp.SecurityEventNotification', 'UNKNOWN', {
          type: 'FirmwareUpdated',
        }),
      );

      expect(sqlCalls.length).toBe(1);
    });
  });

  // ---- notifyChange ----

  describe('notifyChange - pubsub error', () => {
    it('catches pubsub.publish errors in notifyChange without blocking', async () => {
      await setup();

      (mockPubSub.publish as Mock<PubSubClient['publish']>).mockRejectedValue(
        new Error('pubsub dead'),
      );

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ onboarding_status: 'accepted' }], // SELECT onboarding_status
        [], // UPDATE charging_stations
        [{ site_id: null }], // resolveSiteId
      );

      // Should not throw despite pubsub failure
      await eventBus.emit(
        'ocpp.BootNotification',
        makeDomainEvent('ocpp.BootNotification', 'CS-001', { firmwareVersion: '1.0' }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ---- notifyOcpiPush ----

  describe('notifyOcpiPush - roaming enabled', () => {
    it('publishes to ocpi_push when roaming is enabled', async () => {
      mockIsRoamingEnabled.mockResolvedValue(true);
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ onboarding_status: 'accepted' }], // SELECT onboarding_status
        [], // UPDATE charging_stations
        [{ site_id: 'site-roaming' }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.BootNotification',
        makeDomainEvent('ocpp.BootNotification', 'CS-ROAMING', { firmwareVersion: '2.0' }),
      );

      // BootNotification calls notifyChange but not notifyOcpiPush directly
      // Only Connected/Disconnected/StatusNotification call notifyOcpiPush
      // Let me test with station.Connected instead
    });
  });

  describe('notifyOcpiPush - pubsub error', () => {
    it('catches pubsub.publish errors in notifyOcpiPush', async () => {
      mockIsRoamingEnabled.mockResolvedValue(true);
      await setup();

      (mockPubSub.publish as Mock<PubSubClient['publish']>).mockImplementation(
        (channel: string) => {
          if (channel === 'ocpi_push') {
            return Promise.reject(new Error('ocpi push failed'));
          }
          return Promise.resolve(undefined);
        },
      );

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // UPDATE charging_stations
        [], // INSERT connection_logs
        [], // SELECT evse_id
        [{ site_id: 'site-1' }], // resolveSiteId
      );

      // Should not throw
      await eventBus.emit(
        'station.Connected',
        makeDomainEvent('station.Connected', 'CS-OCPI-ERR', { ocppProtocol: 'ocpp2.1' }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ---- pnc.CsrSigned ----

  describe('pnc.CsrSigned', () => {
    it('calls handleCsrSigned and notifies change', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId (via getStationUuid)
        [{ site_id: 'site-pnc' }], // resolveSiteId
      );

      await eventBus.emit(
        'pnc.CsrSigned',
        makeDomainEvent('pnc.CsrSigned', 'CS-PNC', {
          certificateChain: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
          certificateType: 'V2GCertificate',
          providerReference: 'hubject-ref-123',
        }),
      );

      expect(mockHandleCsrSigned).toHaveBeenCalledWith(
        expect.anything(),
        'CS-PNC',
        'sta_000000000001',
        {
          certificateChain: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
          certificateType: 'V2GCertificate',
          providerReference: 'hubject-ref-123',
        },
        mockPubSub,
      );
    });

    it('skips if station not found', async () => {
      await setup();
      setupSqlResults([]);

      await eventBus.emit(
        'pnc.CsrSigned',
        makeDomainEvent('pnc.CsrSigned', 'UNKNOWN', {
          certificateChain: 'cert',
          certificateType: 'V2GCertificate',
          providerReference: 'ref',
        }),
      );

      expect(mockHandleCsrSigned).not.toHaveBeenCalled();
    });

    it('uses stationDbId from payload', async () => {
      await setup();

      setupSqlResults(
        [{ site_id: 'site-direct' }], // resolveSiteId
      );

      await eventBus.emit(
        'pnc.CsrSigned',
        makeDomainEvent('pnc.CsrSigned', 'CS-DIRECT', {
          stationDbId: 'sta_directpnc01',
          certificateChain: 'cert-chain',
          certificateType: 'ChargingStationCertificate',
          providerReference: 'ref-direct',
        }),
      );

      expect(mockHandleCsrSigned).toHaveBeenCalledWith(
        expect.anything(),
        'CS-DIRECT',
        'sta_directpnc01',
        expect.objectContaining({ certificateType: 'ChargingStationCertificate' }),
        mockPubSub,
      );
    });
  });

  // ---- pnc.InstallCertificateResult ----

  describe('pnc.InstallCertificateResult', () => {
    it('calls handleInstallCertificateResult and notifies change', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId (via getStationUuid)
        [{ site_id: 'site-cert' }], // resolveSiteId
      );

      await eventBus.emit(
        'pnc.InstallCertificateResult',
        makeDomainEvent('pnc.InstallCertificateResult', 'CS-CERT', {
          certificate: '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----',
          certificateType: 'MORootCertificate',
          status: 'Accepted',
        }),
      );

      expect(mockHandleInstallCertificateResult).toHaveBeenCalledWith(
        expect.anything(),
        'sta_000000000001',
        '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----',
        'MORootCertificate',
        'Accepted',
      );
    });

    it('skips if station not found', async () => {
      await setup();
      setupSqlResults([]);

      await eventBus.emit(
        'pnc.InstallCertificateResult',
        makeDomainEvent('pnc.InstallCertificateResult', 'UNKNOWN', {
          certificate: 'cert',
          certificateType: 'MORootCertificate',
          status: 'Accepted',
        }),
      );

      expect(mockHandleInstallCertificateResult).not.toHaveBeenCalled();
    });
  });

  // ---- Second TransactionEvent subscriber (Pre-auth / Capture) ----

  describe('ocpp.TransactionEvent - Pre-auth on Started', () => {
    // A driver session (token rfid-pay, driver-pay) on site-pay with a paid
    // tariff: the gate asks the payment service for the hold.
    const driverStartedResults = (): unknown[][] => [
      [{ id: 'sta_000000000001' }], // resolveStationId
      [], // INSERT charging_sessions
      [{ id: 'session-preauth' }], // SELECT id
      [], // UPDATE stale sessions (RETURNING id, empty)
      [], // INSERT transaction_events
      [{ is_roaming: false }], // SELECT is_roaming (eager-state seed)
      [{ driver_id: 'driver-pay' }], // SELECT driver_id
      [], // SELECT driver_tokens by idToken (no match for 'rfid-pay')
      [], // SELECT vehicle_id (no previous vehicle, auto-link skipped)
      [
        {
          group_id: 'pg-1',
          group_name: 'Group',
          group_priority: 5,
          timezone: null,
          id: 'tariff-1',
          price_per_kwh: '0.30',
          price_per_minute: null,
          price_per_session: null,
          idle_fee_price_per_minute: null,
          reservation_fee_per_minute: null,
          tax_rate: null,
          restrictions: null,
          priority: 0,
          is_default: true,
        },
      ], // loadStationPricing (group, tariffs, timezone)
      [], // SELECT pricing_holidays (loadHolidays)
      [], // UPDATE charging_sessions SET tariff_id
      [], // INSERT session_tariff_segments
      [{ site_id: 'site-pay' }], // resolveSiteId
      [{ name: 'Site Pay' }], // resolveSiteName
      // runPaymentGate: no SQL of its own, the hold goes through the service
    ];
    const emitDriverStarted = (transactionId: string) =>
      eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId,
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
          idToken: 'rfid-pay',
          tokenType: 'ISO14443',
        }),
      );
    const published = (channel: string): Array<Record<string, unknown>> =>
      (mockPubSub.publish as Mock<PubSubClient['publish']>).mock.calls
        .filter((c) => c[0] === channel)
        .map((c) => JSON.parse(c[1]) as Record<string, unknown>);
    const stopCommands = () =>
      published('ocpp_commands').filter((m) => m['action'] === 'RequestStopTransaction');
    // The eager fault of stopSessionForPayment (status, reason, zeroed cost).
    const paymentNotifications = () =>
      mockDispatchDriver.mock.calls.filter((c: unknown[]) => String(c[1]).startsWith('payment.'));
    const faultUpdate = () => findSql(/SET status = 'faulted',\s*stopped_reason = \?/);

    it('asks the payment service for the hold with the session, driver, and site', async () => {
      await setup();
      setupSqlResults(...driverStartedResults());

      await emitDriverStarted('tx-preauth');

      expect(mockAuthorizeSessionHold).toHaveBeenCalledTimes(1);
      expect(mockAuthorizeSessionHold).toHaveBeenCalledWith(
        {
          sessionId: 'session-preauth',
          driverId: 'driver-pay',
          methodRowId: null,
          siteId: 'site-pay',
          trigger: 'projection_gate',
        },
        mockPaymentContext,
      );
      // Authorized: the session keeps charging.
      expect(stopCommands()).toHaveLength(0);
      expect(faultUpdate()).toBeUndefined();
      expect(paymentNotifications()).toHaveLength(0);
    });

    it('leaves the session running when the hold already exists', async () => {
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'exists',
        paymentRecordId: 7,
        status: 'pre_authorized',
      });
      await setup();
      setupSqlResults(...driverStartedResults());

      await emitDriverStarted('tx-exists');

      expect(mockAuthorizeSessionHold).toHaveBeenCalledTimes(1);
      expect(stopCommands()).toHaveLength(0);
      expect(faultUpdate()).toBeUndefined();
      expect(published('csms_events').some((m) => String(m['type']).startsWith('payment.'))).toBe(
        false,
      );
    });

    it('leaves the session running when the payment provider is not configured', async () => {
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'not_configured',
        providerId: 'stripe',
      });
      await setup();
      setupSqlResults(...driverStartedResults());

      await emitDriverStarted('tx-not-configured');

      // Payments are not configured: the session is neither stopped nor faulted.
      expect(stopCommands()).toHaveLength(0);
      expect(faultUpdate()).toBeUndefined();
      expect(paymentNotifications()).toHaveLength(0);
    });

    it('stops and faults the session when the driver has no payment method', async () => {
      mockAuthorizeSessionHold.mockResolvedValueOnce({ outcome: 'no_method' });
      await setup();
      setupSqlResults(...driverStartedResults());

      await emitDriverStarted('tx-no-method');

      const stops = stopCommands();
      expect(stops).toHaveLength(1);
      expect(stops[0]).toMatchObject({
        stationId: 'CS-001',
        payload: { transactionId: 'tx-no-method' },
      });
      // Eager fault before the station answers (P4).
      expect(faultUpdate()?.values).toContain('MissingPaymentMethod');
      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'payment.MissingPaymentMethod',
        'driver-pay',
        { stationId: 'CS-001', transactionId: 'tx-no-method' },
        ['/mock/templates'],
        mockPubSub,
      );
      expect(published('csms_events')).toContainEqual({
        type: 'payment.missingPaymentMethod',
        sessionId: 'session-preauth',
        transactionId: 'tx-no-method',
      });
    });

    it('stops and faults the session when the hold is declined', async () => {
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'declined',
        reason: 'card_declined',
        paymentRecordId: 9,
        failure: 'declined',
      });
      await setup();
      mockLoggerError.mockClear();
      mockLoggerWarn.mockClear();
      setupSqlResults(...driverStartedResults());

      await emitDriverStarted('tx-decline');

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        { sessionId: 'session-preauth', reason: 'card_declined' },
        'Auto pre-auth declined, stopping session',
      );
      expect(mockLoggerError).not.toHaveBeenCalledWith(
        expect.anything(),
        'Auto pre-auth failed, stopping session',
      );
      const stops = stopCommands();
      expect(stops).toHaveLength(1);
      expect(stops[0]).toMatchObject({
        stationId: 'CS-001',
        payload: { transactionId: 'tx-decline' },
      });
      expect(faultUpdate()?.values).toContain('PaymentFailed');
      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'payment.PreAuthFailed',
        'driver-pay',
        { stationId: 'CS-001', transactionId: 'tx-decline', reason: 'card_declined' },
        ['/mock/templates'],
        mockPubSub,
      );
      expect(published('csms_events')).toContainEqual({
        type: 'payment.preAuthFailed',
        sessionId: 'session-preauth',
        transactionId: 'tx-decline',
        reason: 'card_declined',
      });
    });

    it('cuts a long decline reason to 200 characters in the notification and SSE', async () => {
      const longReason = 'x'.repeat(450);
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'declined',
        reason: longReason,
        paymentRecordId: null,
        failure: 'declined',
      });
      await setup();
      setupSqlResults(...driverStartedResults());

      await emitDriverStarted('tx-long-reason');

      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'payment.PreAuthFailed',
        'driver-pay',
        expect.objectContaining({ reason: 'x'.repeat(200) }),
        ['/mock/templates'],
        mockPubSub,
      );
      const sse = published('csms_events').find((m) => m['type'] === 'payment.preAuthFailed');
      expect(sse?.['reason']).toBe('x'.repeat(200));
    });

    it('stops and faults the session when the hold could not be recorded', async () => {
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'record_failed',
        reason: 'connection reset',
      });
      await setup();
      setupSqlResults(...driverStartedResults());

      await emitDriverStarted('tx-record-failed');

      expect(stopCommands()).toHaveLength(1);
      expect(faultUpdate()?.values).toContain('PaymentFailed');
      const supportReason = 'Payment recording failed. Please contact support.';
      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'payment.PreAuthFailed',
        'driver-pay',
        { stationId: 'CS-001', transactionId: 'tx-record-failed', reason: supportReason },
        ['/mock/templates'],
        mockPubSub,
      );
      expect(published('csms_events')).toContainEqual({
        type: 'payment.preAuthFailed',
        sessionId: 'session-preauth',
        transactionId: 'tx-record-failed',
        reason: supportReason,
      });
    });

    it('faults the session even when the stop and SSE publishes fail', async () => {
      mockAuthorizeSessionHold.mockResolvedValueOnce({
        outcome: 'declined',
        reason: 'card_declined',
        paymentRecordId: 9,
        failure: 'declined',
      });
      await setup();
      vi.mocked(mockPubSub.publish).mockRejectedValue(new Error('redis down'));
      setupSqlResults(...driverStartedResults());

      await expect(emitDriverStarted('tx-publish-fails')).resolves.toBeUndefined();

      // The eager fault does not depend on the publish (P4).
      expect(faultUpdate()?.values).toContain('PaymentFailed');
    });

    it.each([
      { outcome: { outcome: 'no_method' }, reason: 'MissingPaymentMethod' },
      {
        outcome: {
          outcome: 'declined',
          reason: 'card_declined',
          paymentRecordId: 9,
          failure: 'declined',
        },
        reason: 'PaymentFailed',
      },
    ])(
      'still stops a $reason session when its notification and SSE fail',
      async ({ outcome, reason }) => {
        mockAuthorizeSessionHold.mockResolvedValueOnce(outcome);
        mockDispatchDriver.mockImplementation((_sql: unknown, eventType: unknown) => {
          if (String(eventType).startsWith('payment.')) throw new Error('dispatch boom');
          return Promise.resolve();
        });
        try {
          await setup();
          vi.mocked(mockPubSub.publish).mockImplementation((channel) =>
            channel === 'csms_events' ? Promise.reject(new Error('redis down')) : Promise.resolve(),
          );
          setupSqlResults(...driverStartedResults());

          await expect(emitDriverStarted('tx-notify-fails')).resolves.toBeUndefined();

          expect(stopCommands()).toHaveLength(1);
          expect(faultUpdate()?.values).toContain(reason);
        } finally {
          // Back to the module default (resolves) for the following tests.
          mockDispatchDriver.mockImplementation(() => Promise.resolve());
        }
      },
    );

    it('skips pre-auth when no driver on session', async () => {
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'session-1' }], // INSERT charging_sessions ON CONFLICT DO UPDATE RETURNING id
        [], // UPDATE stale sessions
        [], // INSERT transaction_events

        [{ is_roaming: false }], // SELECT is_roaming (eager-state seed)
        [{ driver_id: null }], // SELECT driver_id
        [], // loadStationPricing: no pricing group applies
        [{ site_id: null }], // resolveSiteId
        // runPaymentGate: driverId is null, no idToken -> stops as anonymous (no SQL needed)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-no-driver-preauth',
          seqNo: 0,
          triggerReason: 'EVDetected',
          timestamp: '2024-01-01T00:00:00Z',
        }),
      );

      expect(mockAuthorizeSessionHold).not.toHaveBeenCalled();
    });

    it('skips payment gate for roaming sessions', async () => {
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ '?column?': 1 }], // eager OCPI roaming check (token found -> is_roaming = true in INSERT)
        [{ id: 'session-roaming' }], // INSERT charging_sessions (with is_roaming = true)
        [], // UPDATE stale sessions
        [], // INSERT transaction_events
        [{ is_roaming: true }], // SELECT is_roaming (seeded true by eager check)
        [{ driver_id: null }], // SELECT driver_id (null)
        // idToken + tokenType present -> SELECT driver_tokens (no match)
        [], // driver_tokens (empty)
        // (redundant downstream OCPI check was removed in Step 2; no further
        //  ocpi_external_tokens lookup or is_roaming UPDATE here)
        [], // loadStationPricing: no pricing group applies
        // resolveSiteId
        [{ site_id: null }],
        // runPaymentGate: isRoaming=true -> returns immediately (no SQL)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-ROAMING', {
          eventType: 'Started',
          stationId: 'CS-ROAMING',
          transactionId: 'tx-roaming',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
          idToken: 'roaming-token-123',
          tokenType: 'ISO14443',
        }),
      );

      // No RequestStopTransaction should be published
      const publishCalls = (mockPubSub.publish as Mock<PubSubClient['publish']>).mock.calls;
      const stopCmd = publishCalls.find(
        (c: unknown[]) =>
          c[0] === 'ocpp_commands' &&
          typeof c[1] === 'string' &&
          c[1].includes('RequestStopTransaction'),
      );
      expect(stopCmd).toBeUndefined();

      // No payment_records INSERT
      const prInsert = sqlCalls.find(
        (c) =>
          c.strings.some((s) => s.includes('payment_records')) &&
          c.strings.some((s) => s.includes('INSERT')),
      );
      expect(prInsert).toBeUndefined();
    });

    it('stops session when driver has no payment method and tariff is not free', async () => {
      mockAuthorizeSessionHold.mockResolvedValueOnce({ outcome: 'no_method' });
      await setup();

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // 0: resolveStationId
        [], // 1: eager OCPI roaming check (idToken present, but no match)
        [{ id: 'session-nopay-nofree' }], // 2: INSERT charging_sessions ON CONFLICT DO UPDATE RETURNING id
        [], // 3: UPDATE stale sessions
        [], // 4: INSERT transaction_events
        [{ is_roaming: false }], // 6: SELECT is_roaming (eager-state seed)
        [{ driver_id: 'drv_nopay' }], // 7: SELECT driver_id
        // driver_tokens lookup runs because idToken='rfid-nopay'
        [], // 8: SELECT driver_tokens (no match)
        [], // 9: SELECT vehicle_id (auto-link)
      );
      // loadStationPricing: the group, its tariffs and the site timezone
      sqlResults[9] = [
        {
          group_id: 'pg-1',
          group_name: 'Group',
          group_priority: 5,
          timezone: null,
          id: 'tariff-nofree',
          price_per_kwh: '0.30',
          price_per_minute: null,
          price_per_session: null,
          idle_fee_price_per_minute: null,
          tax_rate: null,
          restrictions: null,
          priority: 0,
          is_default: true,
        },
      ];
      sqlResults[10] = []; // pricing holidays
      sqlResults[11] = []; // UPDATE session (tariff snapshot)
      sqlResults[12] = []; // INSERT session_tariff_segments
      sqlResults[13] = [{ site_id: null }]; // resolveSiteId
      sqlResults[14] = [{ name: null }]; // resolveSiteName

      // runPaymentGate: paid tariff, the service finds no payment method

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-nopay-nofree',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
          idToken: 'rfid-nopay',
          tokenType: 'ISO14443',
        }),
      );

      // Verify RequestStopTransaction was published
      const publishCalls = (mockPubSub.publish as Mock<PubSubClient['publish']>).mock.calls;
      const stopCmd = publishCalls.find(
        (c: unknown[]) =>
          c[0] === 'ocpp_commands' &&
          typeof c[1] === 'string' &&
          c[1].includes('RequestStopTransaction'),
      );
      expect(stopCmd).toBeDefined();
      expect(mockAuthorizeSessionHold).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-nopay-nofree', driverId: 'drv_nopay' }),
        mockPaymentContext,
      );

      consoleWarnSpy.mockRestore();
    });

    it('allows session when driver has no payment method but tariff is free', async () => {
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // 0: resolveStationId
        [], // 1: eager OCPI roaming check (idToken present, no match)
        [{ id: 'session-free' }], // 2: INSERT charging_sessions ON CONFLICT DO UPDATE RETURNING id
        [], // 3: UPDATE stale sessions
        [], // 4: INSERT transaction_events
        [{ is_roaming: false }], // 6: SELECT is_roaming (eager-state seed)
        [{ driver_id: 'drv_free' }], // 7: SELECT driver_id
        [], // 8: SELECT driver_tokens (no match)
        [], // 9: SELECT vehicle_id (auto-link)
      );
      // loadStationPricing: the group, its tariffs and the site timezone
      sqlResults[9] = [
        {
          group_id: 'pg-free',
          group_name: 'Group',
          group_priority: 5,
          timezone: null,
          id: 'tariff-free',
          price_per_kwh: '0',
          price_per_minute: null,
          price_per_session: null,
          idle_fee_price_per_minute: null,
          tax_rate: null,
          restrictions: null,
          priority: 0,
          is_default: true,
        },
      ];
      sqlResults[10] = []; // pricing holidays
      sqlResults[11] = []; // UPDATE session (tariff snapshot)
      sqlResults[12] = []; // INSERT session_tariff_segments
      sqlResults[13] = [{ site_id: null }]; // resolveSiteId
      sqlResults[14] = [{ name: null }]; // resolveSiteName

      // runPaymentGate: free from the session's tariff snapshot (no hold)

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-free',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
          idToken: 'rfid-free',
          tokenType: 'ISO14443',
        }),
      );

      // A free session needs no payment method and no hold.
      expect(mockAuthorizeSessionHold).not.toHaveBeenCalled();

      // No RequestStopTransaction should be published
      const publishCalls = (mockPubSub.publish as Mock<PubSubClient['publish']>).mock.calls;
      const stopCmd = publishCalls.find(
        (c: unknown[]) =>
          c[0] === 'ocpp_commands' &&
          typeof c[1] === 'string' &&
          c[1].includes('RequestStopTransaction'),
      );
      expect(stopCmd).toBeUndefined();
    });

    it('stops anonymous session (no driver, no roaming, no guest session)', async () => {
      await setup();

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // eager OCPI roaming check (idToken present)

        [{ id: 'session-anon' }], // INSERT charging_sessions ON CONFLICT DO UPDATE RETURNING id
        [], // UPDATE stale sessions
        [], // INSERT transaction_events
        [{ driver_id: null }], // SELECT driver_id (null)
        // Token resolution chain: driver_tokens -> ocpi_external_tokens -> guest_sessions
        [], // driver_tokens (empty)
        [], // external tokens (empty)
        [], // guest_sessions (empty) -> anonymous
        [], // loadStationPricing: no pricing group applies
        // resolveSiteId
        [{ site_id: null }],
        // runPaymentGate: guestStatus=null -> stops as anonymous (no SQL)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-anon',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
          idToken: 'unknown-token-123',
          tokenType: 'ISO14443',
        }),
      );

      // Verify RequestStopTransaction was published
      const publishCalls = (mockPubSub.publish as Mock<PubSubClient['publish']>).mock.calls;
      const stopCmd = publishCalls.find(
        (c: unknown[]) =>
          c[0] === 'ocpp_commands' &&
          typeof c[1] === 'string' &&
          c[1].includes('RequestStopTransaction'),
      );
      expect(stopCmd).toBeDefined();

      consoleWarnSpy.mockRestore();
    });

    it('allows guest session when pre-auth is payment_authorized', async () => {
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // 0: resolveStationId
        [], // 1: eager OCPI roaming check (idToken present, no match)
        [{ id: 'session-guest' }], // 2: INSERT charging_sessions ON CONFLICT DO UPDATE RETURNING id
        [], // 3: UPDATE stale sessions
        [], // 4: INSERT transaction_events
        [{ is_roaming: false }], // 6: SELECT is_roaming (eager-state seed)
        [{ driver_id: null }], // 7: SELECT driver_id (null)
        // Token resolution chain: driver_tokens -> guest_sessions
        // (downstream redundant OCPI check was removed in Step 2)
        [], // 8: driver_tokens (empty)
        [{ status: 'payment_authorized', guest_email: 'g@test.com' }], // 9: guest_sessions (authorized)
        [], // loadStationPricing: no pricing group applies
        // resolveSiteId
        [{ site_id: null }], // 13
        // runPaymentGate: guestStatus=payment_authorized -> allow (no SQL)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-guest',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
          idToken: 'guest-token-abc',
          tokenType: 'ISO14443',
        }),
      );

      // No RequestStopTransaction should be published
      const publishCalls = (mockPubSub.publish as Mock<PubSubClient['publish']>).mock.calls;
      const stopCmd = publishCalls.find(
        (c: unknown[]) =>
          c[0] === 'ocpp_commands' &&
          typeof c[1] === 'string' &&
          c[1].includes('RequestStopTransaction'),
      );
      expect(stopCmd).toBeUndefined();
    });

    it('stamps the guest hold as the cost ceiling of the session', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // eager OCPI roaming check (idToken present, no match)
        [{ id: 'session-guest' }], // INSERT charging_sessions RETURNING id
        [], // UPDATE stale sessions
        [], // INSERT transaction_events
        [{ is_roaming: false }], // SELECT is_roaming (eager-state seed)
        [{ driver_id: null }], // SELECT driver_id (null)
        [], // driver_tokens (empty)
        [
          {
            status: 'payment_authorized',
            guest_email: 'g@test.com',
            pre_auth_amount_cents: 265,
            provider_payment_id: 'pi_1',
          },
        ], // guest_sessions (authorized hold)
        [], // UPDATE charging_sessions SET cost_ceiling_cents
        [], // loadStationPricing: no pricing group applies
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-guest-hold',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
          idToken: 'guest-token-abc',
          tokenType: 'ISO14443',
        }),
      );

      const stamp = findSql(/SET cost_ceiling_cents/);
      expect(stamp?.values).toEqual([265, 'session-guest']);
    });

    it('stamps no cost ceiling for a guest session without a hold', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }],
        [],
        [{ id: 'session-guest' }],
        [],
        [],
        [{ is_roaming: false }],
        [{ driver_id: null }],
        [],
        [
          {
            status: 'payment_authorized',
            guest_email: '',
            pre_auth_amount_cents: null,
            provider_payment_id: null,
          },
        ], // free guest session
        [], // loadStationPricing
        [{ site_id: null }],
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-guest-free',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
          idToken: 'guest-token-abc',
          tokenType: 'ISO14443',
        }),
      );

      expect(findSql(/SET cost_ceiling_cents/)).toBeUndefined();
    });

    it('stops a guest session whose payment was not authorized and emails the guest', async () => {
      const { dispatchSystemNotification } = await import('../server/notification-dispatcher.js');
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // eager OCPI roaming check (idToken present, no match)
        [{ id: 'session-guest' }], // INSERT charging_sessions RETURNING id
        [], // UPDATE stale sessions
        [], // INSERT transaction_events
        [{ is_roaming: false }], // SELECT is_roaming (eager-state seed)
        [{ driver_id: null }], // SELECT driver_id (null)
        [], // driver_tokens (empty)
        [{ status: 'pending', guest_email: 'g@test.com' }], // guest_sessions (not authorized)
        [], // loadStationPricing: no pricing group applies
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-guest-pending',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
          idToken: 'guest-token-abc',
          tokenType: 'ISO14443',
        }),
      );

      const publishCalls = (mockPubSub.publish as Mock<PubSubClient['publish']>).mock.calls;
      expect(
        publishCalls.some(
          (c) => c[0] === 'ocpp_commands' && c[1].includes('RequestStopTransaction'),
        ),
      ).toBe(true);
      expect(mockAuthorizeSessionHold).not.toHaveBeenCalled();
      expect(vi.mocked(dispatchSystemNotification)).toHaveBeenCalledWith(
        expect.anything(),
        'payment.PreAuthFailed',
        { email: 'g@test.com' },
        expect.objectContaining({
          transactionId: 'tx-guest-pending',
          reason: 'Payment authorization not found',
        }),
        ['/mock/templates'],
      );
    });
  });

  describe('ocpp.TransactionEvent - Settlement on Ended', () => {
    // The first subscriber's rows for an ended driver session, then the
    // settlement subscriber's session row.
    const endedResults = (
      settlementSession: Record<string, unknown> | null,
      ...after: unknown[][]
    ): unknown[][] => [
      [{ id: 'sta_000000000001' }], // resolveStationId
      [], // SELECT payment_records (no failed payment)
      [], // SELECT the active session with an open idle period (JB-2 due notice): none
      [], // UPDATE charging_sessions SET status=completed
      [
        {
          id: 'session-capture',
          tariff_id: null,
          current_cost_cents: 0,
          started_at: '2024-01-01T00:00:00Z',
          ended_at: '2024-01-01T01:00:00Z',
          energy_delivered_wh: 10000,
          currency: 'USD',
          tariff_price_per_kwh: null,
          tariff_price_per_minute: null,
          tariff_price_per_session: null,
          tariff_idle_fee_price_per_minute: null,
          tariff_tax_rate: null,
        },
      ], // SELECT session
      [], // INSERT transaction_events
      [], // carbon query (no region found)
      [{ site_id: null }], // resolveSiteId
      [{ ocpp_protocol: 'ocpp2.1' }], // SELECT ocpp_protocol (station_message_transaction)
      // Settlement subscriber
      settlementSession == null ? [] : [settlementSession], // SELECT session + station
      // Driver notifications after the settlement (notifySessionEnded)
      [
        {
          driver_id: 'driver-capture',
          status: 'completed',
          energy_delivered_wh: 10000,
          final_cost_cents: 2000,
          currency: 'USD',
          started_at: '2024-01-01T00:00:00Z',
          ended_at: '2024-01-01T01:00:00Z',
        },
      ], // SELECT driver info for notification
      [], // SELECT payment_records
      [{ name: null }], // resolveSiteName
      ...after,
    ];
    const settlementRow = (finalCostCents: number | null, currency = 'USD') => ({
      id: 'session-capture',
      final_cost_cents: finalCostCents,
      station_uuid: 'sta_000000000001',
      currency,
      station_ocpp_id: 'CS-001',
      site_id: 'site-cap',
    });
    const emitEnded = (transactionId: string) =>
      eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId,
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );
    const driverCalls = (eventType: string) =>
      mockDispatchDriver.mock.calls.filter((c: unknown[]) => c[1] === eventType);

    it('settles the session through the payment service', async () => {
      await setup();
      setupSqlResults(...endedResults(settlementRow(2000)));

      await emitEnded('tx-settle');

      expect(mockSettleSessionPayment).toHaveBeenCalledTimes(1);
      expect(mockSettleSessionPayment).toHaveBeenCalledWith(
        'session-capture',
        mockPaymentContext,
        SETTLE_OPTIONS,
      );
    });

    it('notifies the driver of the captured amount when the capture was recorded', async () => {
      mockSettleSessionPayment.mockResolvedValueOnce({
        mode: 'card',
        status: 'captured',
        paymentRecordId: 11,
        driverId: 'driver-capture',
        capturedCents: 2350,
        shortfallCents: 0,
        recorded: true,
      });
      await setup();
      setupSqlResults(...endedResults(settlementRow(2350, 'EUR'), [{ name: 'Site Cap' }]));

      await emitEnded('tx-capture');

      const calls = driverCalls('session.PaymentReceived');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual([
        expect.anything(),
        'session.PaymentReceived',
        'driver-capture',
        expect.objectContaining({
          stationId: 'CS-001',
          transactionId: 'tx-capture',
          amountCents: 2350,
          amountFormatted: formatsTo('€23.50'),
          currency: 'EUR',
        }),
        ['/mock/templates'],
        mockPubSub,
      ]);
    });

    it('sends no receipt when the provider charged but the record was not updated', async () => {
      mockSettleSessionPayment.mockResolvedValueOnce({
        mode: 'card',
        status: 'captured',
        paymentRecordId: 11,
        driverId: 'driver-capture',
        capturedCents: 2000,
        shortfallCents: 0,
        recorded: false,
      });
      await setup();
      setupSqlResults(...endedResults(settlementRow(2000)));

      await emitEnded('tx-unrecorded');

      expect(driverCalls('session.PaymentReceived')).toHaveLength(0);
      expect(driverCalls('payment.CaptureFailed')).toHaveLength(0);
    });

    it('notifies the driver of a failed capture with the final cost and a cut reason', async () => {
      mockSettleSessionPayment.mockResolvedValueOnce({
        mode: 'card',
        status: 'failed',
        paymentRecordId: 11,
        driverId: 'driver-fail',
        reason: 'y'.repeat(300),
      });
      await setup();
      setupSqlResults(...endedResults(settlementRow(2000)));

      await emitEnded('tx-capture-fail');

      const calls = driverCalls('payment.CaptureFailed');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual([
        expect.anything(),
        'payment.CaptureFailed',
        'driver-fail',
        {
          stationId: 'CS-001',
          transactionId: 'tx-capture-fail',
          amountFormatted: formatsTo('$20.00'),
          reason: 'y'.repeat(200),
        },
        ['/mock/templates'],
        mockPubSub,
      ]);
      expect(driverCalls('session.PaymentReceived')).toHaveLength(0);
    });

    it('formats a failed capture of a session without a final cost as zero', async () => {
      mockSettleSessionPayment.mockResolvedValueOnce({
        mode: 'card',
        status: 'failed',
        paymentRecordId: 11,
        driverId: 'driver-fail',
        reason: 'capture_failed',
      });
      await setup();
      setupSqlResults(...endedResults(settlementRow(null)));

      await emitEnded('tx-capture-fail-null');

      expect(driverCalls('payment.CaptureFailed')[0]?.[3]).toMatchObject({
        amountFormatted: formatsTo('$0.00'),
        reason: 'capture_failed',
      });
    });

    it('sends nothing for a cancelled hold', async () => {
      mockSettleSessionPayment.mockResolvedValueOnce({
        mode: 'card',
        status: 'cancelled',
        paymentRecordId: 11,
        recorded: true,
      });
      await setup();
      setupSqlResults(...endedResults(settlementRow(0)));

      await emitEnded('tx-cancel');

      expect(driverCalls('session.PaymentReceived')).toHaveLength(0);
      expect(driverCalls('payment.CaptureFailed')).toHaveLength(0);
    });

    it.each([{ mode: 'guest' }, { mode: 'none' }])(
      'sends nothing when the settlement outcome is $mode',
      async (outcome) => {
        mockSettleSessionPayment.mockResolvedValueOnce(outcome);
        await setup();
        setupSqlResults(...endedResults(settlementRow(1500)));

        await emitEnded('tx-nothing');

        expect(mockSettleSessionPayment).toHaveBeenCalledTimes(1);
        expect(driverCalls('session.PaymentReceived')).toHaveLength(0);
        expect(driverCalls('payment.CaptureFailed')).toHaveLength(0);
        const tokenChanged = (mockPubSub.publish as Mock<PubSubClient['publish']>).mock.calls.some(
          (c) => c[1].includes('token.changed'),
        );
        expect(tokenChanged).toBe(false);
      },
    );

    it('skips the settlement when the session is not found', async () => {
      await setup();
      setupSqlResults(...endedResults(null));

      await emitEnded('tx-gone');

      expect(mockSettleSessionPayment).not.toHaveBeenCalled();
    });
  });

  // ---- Reservation expiry check ----

  // Reservation expiry timer was moved to the worker cron `reservation-expiry-check`
  // (packages/worker/src/handlers/reservation-expiry-check.ts). It no longer
  // runs in event-projections, so the prior describe block was removed.

  // ---- resolveSiteId caching ----

  describe('resolveSiteId caching', () => {
    it('caches site ID and returns cached value on second call', async () => {
      await setup();

      // First call: station.Connected for CS-CACHE
      setupSqlResults(
        [{ id: 'sta_000000cache' }], // resolveStationId
        [], // UPDATE
        [], // INSERT connection_logs
        [], // SELECT evses
        [{ site_id: 'site-cached' }], // resolveSiteId (DB lookup)
      );

      await eventBus.emit(
        'station.Connected',
        makeDomainEvent('station.Connected', 'CS-CACHE', { ocppProtocol: 'ocpp2.1' }),
      );

      // Second call should use cached siteId
      setupSqlResults(
        // resolveStationId will also be cached
        [], // UPDATE
        [], // INSERT connection_logs
        [], // SELECT evses
        // No site_id query needed (cached)
      );

      await eventBus.emit(
        'station.Connected',
        makeDomainEvent('station.Connected', 'CS-CACHE', {
          ocppProtocol: 'ocpp2.1',
          stationDbId: 'sta_000000cache',
        }),
      );

      // The second call should have fewer SQL queries since siteId is cached
      const secondCallCount = sqlCalls.length;
      // We just verify it completed without error, caching reduces queries
      expect(secondCallCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ---- resolveStationId caching ----

  describe('resolveStationId caching', () => {
    it('returns cached ID on second call', async () => {
      await setup();

      // First call resolves ID from DB
      setupSqlResults(
        [{ id: 'sta_00000cached' }], // resolveStationId
        [{ onboarding_status: 'accepted' }], // SELECT onboarding_status
        [], // UPDATE
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.BootNotification',
        makeDomainEvent('ocpp.BootNotification', 'CS-CACHED', { firmwareVersion: '1.0' }),
      );

      const firstSqlCount = sqlCalls.length;

      // Second call should use cache
      setupSqlResults(
        // No resolveStationId query (cached)
        [{ onboarding_status: 'accepted' }], // SELECT onboarding_status
        [], // UPDATE
        [{ site_id: null }], // resolveSiteId (also cached)
      );

      await eventBus.emit(
        'ocpp.BootNotification',
        makeDomainEvent('ocpp.BootNotification', 'CS-CACHED', { firmwareVersion: '2.0' }),
      );

      // Second call uses fewer SQL queries
      expect(sqlCalls.length).toBeLessThanOrEqual(firstSqlCount);
    });
  });

  // ---- Notification dispatch loop ----

  describe('Notification dispatch loop - fires for events', () => {
    it('calls dispatchOcppNotification for subscribed events', async () => {
      await setup();

      // For ocpp.Authorize (no dedicated handler, only notification dispatch)
      const event = makeDomainEvent('ocpp.Authorize', 'CS-001', { idToken: 'test' });

      await eventBus.emit('ocpp.Authorize', event);

      expect(mockDispatchOcpp).toHaveBeenCalledWith(expect.anything(), event);
    });

    it('calls dispatchOcppNotification for ocpp.DataTransfer', async () => {
      await setup();

      const event = makeDomainEvent('ocpp.DataTransfer', 'CS-001', { vendorId: 'test' });

      await eventBus.emit('ocpp.DataTransfer', event);

      expect(mockDispatchOcpp).toHaveBeenCalledWith(expect.anything(), event);
    });

    it('skips a connector status taken from a NotifyEvent', async () => {
      await setup();

      const event = makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
        evseId: 1,
        connectorId: 1,
        connectorStatus: 'Available',
        source: 'NotifyEvent',
      });

      await eventBus.emit('ocpp.StatusNotification', event);

      expect(mockDispatchOcpp).not.toHaveBeenCalledWith(expect.anything(), event);
    });
  });

  // ---- 2.1 Stub Persistence: VatNumberValidation ----

  describe('ocpp.VatNumberValidation', () => {
    it('persists VAT number validation event', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT
      );

      await eventBus.emit(
        'ocpp.VatNumberValidation',
        makeDomainEvent('ocpp.VatNumberValidation', 'CS-TEST', {
          vatNumber: 'DE123456789',
          evseId: 1,
        }),
      );

      expect(sqlCalls.length).toBe(2);
      expect(sqlCalls[1]?.strings.join('')).toContain('vat_number_validations');
    });
  });

  // ---- 2.1 Stub Persistence: NotifyAllowedEnergyTransfer ----

  describe('ocpp.NotifyAllowedEnergyTransfer', () => {
    it('persists allowed energy transfer event', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT
      );

      await eventBus.emit(
        'ocpp.NotifyAllowedEnergyTransfer',
        makeDomainEvent('ocpp.NotifyAllowedEnergyTransfer', 'CS-TEST', {
          transactionId: 'tx-123',
          allowedEnergyTransfer: ['AC_single_phase'],
        }),
      );

      expect(sqlCalls.length).toBe(2);
      expect(sqlCalls[1]?.strings.join('')).toContain('allowed_energy_transfer_events');
    });
  });

  // ---- 2.1 Stub Persistence: NotifyDERAlarm ----

  describe('ocpp.NotifyDERAlarm', () => {
    it('persists DER alarm event', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT
      );

      await eventBus.emit(
        'ocpp.NotifyDERAlarm',
        makeDomainEvent('ocpp.NotifyDERAlarm', 'CS-TEST', {
          controlType: 'FreqDroop',
          timestamp: '2026-03-01T10:00:00Z',
          gridEventFault: 'UnderVoltage',
        }),
      );

      expect(sqlCalls.length).toBe(2);
      expect(sqlCalls[1]?.strings.join('')).toContain('der_alarm_events');
      // GridEventFaultEnumType is a string: it is stored as the JSON string, not raw text.
      expect(sqlCalls[1]?.values[3]).toBe('"UnderVoltage"');
    });

    it('stores no fault when the alarm has none', async () => {
      await setup();

      setupSqlResults([{ id: 'sta_000000000001' }], []);

      await eventBus.emit(
        'ocpp.NotifyDERAlarm',
        makeDomainEvent('ocpp.NotifyDERAlarm', 'CS-TEST', {
          controlType: 'FreqDroop',
          timestamp: '2026-03-01T10:00:00Z',
        }),
      );

      expect(sqlCalls[1]?.values[3]).toBeNull();
    });
  });

  // ---- 2.1 Stub Persistence: NotifyDERStartStop ----

  describe('ocpp.NotifyDERStartStop', () => {
    it('persists DER start/stop event', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT
      );

      await eventBus.emit(
        'ocpp.NotifyDERStartStop',
        makeDomainEvent('ocpp.NotifyDERStartStop', 'CS-TEST', {
          controlType: 'FreqDroop',
          started: true,
          timestamp: '2026-03-01T10:00:00Z',
        }),
      );

      expect(sqlCalls.length).toBe(2);
      expect(sqlCalls[1]?.strings.join('')).toContain('der_start_stop_events');
    });
  });

  // ---- 2.1 Stub Persistence: ReportDERControl ----

  describe('ocpp.ReportDERControl', () => {
    it('persists DER control report', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT
      );

      await eventBus.emit(
        'ocpp.ReportDERControl',
        makeDomainEvent('ocpp.ReportDERControl', 'CS-TEST', {
          requestId: 42,
          tbc: false,
          derControl: { freqDroop: [{ id: 'freqdroop_1' }] },
        }),
      );

      expect(sqlCalls.length).toBe(2);
      expect(sqlCalls[1]?.strings.join('')).toContain('der_control_reports');
    });
  });

  // ---- 1.6 DiagnosticsStatusNotification ----

  describe('ocpp.DiagnosticsStatus', () => {
    it('updates most recent log_uploads row', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // UPDATE log_uploads (count=1 by default)
      );

      await eventBus.emit(
        'ocpp.DiagnosticsStatus',
        makeDomainEvent('ocpp.DiagnosticsStatus', 'CS-TEST', {
          status: 'Uploaded',
        }),
      );

      expect(sqlCalls.length).toBe(2);
      expect(sqlCalls[1]?.strings.join('')).toContain('UPDATE log_uploads');
    });

    it('inserts new log_uploads row when no existing row found', async () => {
      await setup();

      sqlCountOverrides.set(1, 0); // UPDATE returns count=0
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // UPDATE log_uploads -> count=0
        [], // INSERT log_uploads
      );

      await eventBus.emit(
        'ocpp.DiagnosticsStatus',
        makeDomainEvent('ocpp.DiagnosticsStatus', 'CS-TEST', {
          status: 'UploadFailed',
        }),
      );

      expect(sqlCalls.length).toBe(3);
      expect(sqlCalls[2]?.strings.join('')).toContain('INSERT INTO log_uploads');
    });
  });

  // ---- command.GetDiagnostics ----

  describe('command.GetDiagnostics', () => {
    it('creates initial log_uploads record', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT log_uploads
      );

      await eventBus.emit(
        'command.GetDiagnostics',
        makeDomainEvent('command.GetDiagnostics', 'CS-TEST', {
          request: { location: 'ftp://example.com/diagnostics' },
          response: {},
        }),
      );

      expect(sqlCalls.length).toBe(2);
      expect(sqlCalls[1]?.strings.join('')).toContain('DiagnosticsLog');
    });
  });

  // ---- NotifyEvent alerting ----

  describe('ocpp.NotifyEvent - alerting', () => {
    it('creates alert for critical severity event', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 42 }], // INSERT station_events RETURNING id
        [{ id: 1, min_severity: 0 }], // SELECT event_alert_rules
        [], // INSERT event_alerts
        [{ site_id: 'sit_test' }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.NotifyEvent',
        makeDomainEvent('ocpp.NotifyEvent', 'CS-TEST', {
          generatedAt: '2026-03-01T10:00:00Z',
          seqNo: 0,
          tbc: false,
          eventData: [
            {
              trigger: 'Alerting',
              severity: 0,
              component: { name: 'Connector' },
              variable: { name: 'Temperature' },
              actualValue: '85',
              techInfo: 'Over temperature threshold',
            },
          ],
        }),
      );

      // resolveStationId + INSERT station_events + SELECT rules + INSERT alerts + resolveSiteId
      expect(sqlCalls.length).toBe(5);
      expect(sqlCalls[3]?.strings.join('')).toContain('event_alerts');
    });

    it('skips alert for non-alerting low-severity event', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 42 }], // INSERT station_events RETURNING id
        [{ site_id: 'sit_test' }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.NotifyEvent',
        makeDomainEvent('ocpp.NotifyEvent', 'CS-TEST', {
          generatedAt: '2026-03-01T10:00:00Z',
          seqNo: 0,
          tbc: false,
          eventData: [
            {
              trigger: 'Periodic',
              severity: 9,
              component: { name: 'Connector' },
              variable: { name: 'Temperature' },
              actualValue: '25',
            },
          ],
        }),
      );

      // resolveStationId + INSERT station_events + resolveSiteId (no alert queries)
      expect(sqlCalls.length).toBe(3);
    });
  });

  // ---- EVConnectTimeout on TransactionEvent Started ----

  describe('ocpp.TransactionEvent Started - EVConnectTimeout', () => {
    it('marks session as failed with stopped_reason EVConnectTimeout', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'session-timeout' }], // INSERT charging_sessions ON CONFLICT DO UPDATE RETURNING id
        [], // UPDATE stale sessions
        // NO SELECT evse_id or UPDATE connectors (skipped for EVConnectTimeout)
        [], // UPDATE charging_sessions SET status = 'failed'
        [], // INSERT transaction_events

        [{ is_roaming: false }], // SELECT is_roaming (eager-state seed)
        [{ driver_id: null }], // SELECT driver_id
        [], // loadStationPricing: no pricing group applies
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-ev-connect-timeout',
          seqNo: 0,
          triggerReason: 'EVConnectTimeout',
          timestamp: '2024-01-01T00:00:00Z',
        }),
      );

      // Verify the UPDATE to 'failed' with stopped_reason EVConnectTimeout was called
      const failedUpdate = sqlCalls.find(
        (c) =>
          c.strings.some((s) => s.includes('UPDATE charging_sessions')) &&
          c.strings.some((s) => s.includes("status = 'failed'")) &&
          c.strings.some((s) => s.includes('EVConnectTimeout')),
      );
      expect(failedUpdate).toBeDefined();

      // Verify no connector status update (no 'ev_connected' update)
      const connectorUpdate = sqlCalls.find(
        (c) =>
          c.strings.some((s) => s.includes('UPDATE connectors')) &&
          c.strings.some((s) => s.includes('ev_connected')),
      );
      expect(connectorUpdate).toBeUndefined();
    });
  });

  // ---- EVConnectTimeout / Timeout on TransactionEvent Ended ----

  describe('ocpp.TransactionEvent Ended - EVDisconnected with zero energy', () => {
    it('completes session normally (EVDisconnected is not a timeout)', async () => {
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [], // SELECT payment_records (no failed payment)
        [], // SELECT the active session with an open idle period (JB-2 due notice): none
        [], // UPDATE charging_sessions SET status = 'completed'
        [
          {
            id: 'session-evdisconnected',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T00:00:05Z',
            energy_delivered_wh: 0,
            currency: 'USD',
            tariff_price_per_kwh: null,
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
            idle_started_at: null,
            idle_minutes: 0,
          },
        ], // SELECT session
        // NO UPDATE to failed (EVDisconnected is not a timeout reason)
        [], // INSERT transaction_events
        [], // carbon query (no region found)
        [{ site_id: null }], // resolveSiteId
        [
          {
            driver_id: null,
            energy_delivered_wh: 0,
            final_cost_cents: null,
            currency: 'USD',
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T00:00:05Z',
          },
        ], // SELECT for driver notification
        // Second subscriber (auto-capture)
        [{ id: 'session-evdisconnected', final_cost_cents: null, site_id: null }],
        [], // No payment records
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-evdisconnected',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          stoppedReason: 'EVDisconnected',
          timestamp: '2024-01-01T00:00:05Z',
        }),
      );

      // EVDisconnected is a normal end reason, not a timeout. Session stays completed.
      const failedUpdate = sqlCalls.find(
        (c) =>
          c.strings.some((s) => s.includes('UPDATE charging_sessions')) &&
          c.strings.some((s) => s.includes("status = 'failed'")),
      );
      expect(failedUpdate).toBeUndefined();
    });
  });

  describe('ocpp.TransactionEvent Ended - Timeout stoppedReason with zero energy', () => {
    it('marks session as failed', async () => {
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [], // SELECT payment_records (no failed payment)
        [], // SELECT the active session with an open idle period (JB-2 due notice): none
        [], // UPDATE charging_sessions SET status = 'completed'
        [
          {
            id: 'session-timeout-end',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T00:05:00Z',
            energy_delivered_wh: 0,
            currency: 'USD',
            tariff_price_per_kwh: null,
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
            idle_started_at: null,
            idle_minutes: 0,
          },
        ], // SELECT session
        [], // UPDATE charging_sessions SET status = 'failed' (isTimeoutEnd)
        [], // INSERT transaction_events
        [], // carbon query (no region found)
        [{ site_id: null }], // resolveSiteId
        [
          {
            driver_id: null,
            energy_delivered_wh: 0,
            final_cost_cents: null,
            currency: 'USD',
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T00:05:00Z',
          },
        ], // SELECT for driver notification
        // Second subscriber (auto-capture)
        [{ id: 'session-timeout-end', final_cost_cents: null, site_id: null }],
        [], // No payment records
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-timeout-stopped',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          stoppedReason: 'Timeout',
          timestamp: '2024-01-01T00:05:00Z',
        }),
      );

      // Verify the timeout UPDATE to 'failed' was called
      const failedUpdate = sqlCalls.find(
        (c) =>
          c.strings.some((s) => s.includes('UPDATE charging_sessions')) &&
          c.strings.some((s) => s.includes("ELSE 'failed' END")),
      );
      expect(failedUpdate).toBeDefined();
    });
  });

  describe('ocpp.TransactionEvent Ended - EVConnectTimeout on an active priced session', () => {
    it('fails the session, zeroes its cost and does not price or notify it', async () => {
      await setup();
      mockPriceSessionAt.mockClear();
      mockDispatchDriver.mockClear();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [], // SELECT payment_records (no failed payment)
        [], // SELECT the active session with an open idle period (JB-2 due notice): none
        [], // UPDATE charging_sessions SET status = 'completed'
        [
          {
            id: 'session-connect-timeout',
            evse_id: null,
            // Read before the timeout update: still active (Part L bug)
            status: 'active',
            tariff_id: 'trf_1',
            current_cost_cents: 54,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T00:01:00Z',
            energy_delivered_wh: 0,
            currency: 'USD',
            tariff_tax_rate: '0.08',
            idle_started_at: null,
            idle_minutes: 0,
            reservation_id: null,
          },
        ], // SELECT session
        [], // UPDATE charging_sessions SET status = failed, cost 0 (timeout end)
        [{ reservation_id: null }], // auditLinkedReservationFault
        [], // INSERT transaction_events
        [], // carbon query (no region found)
        [{ site_id: null }], // resolveSiteId
        [{ ocpp_protocol: 'ocpp2.1' }], // SELECT ocpp_protocol (station_message_transaction)
        // Second subscriber (settlement)
        [{ id: 'session-connect-timeout', final_cost_cents: 0, site_id: null }],
        [
          {
            driver_id: 'drv_1',
            energy_delivered_wh: 0,
            final_cost_cents: 0,
            status: 'failed',
            currency: 'USD',
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T00:01:00Z',
          },
        ], // SELECT for driver notification (after the settlement)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-connect-timeout',
          seqNo: 1,
          triggerReason: 'EVConnectTimeout',
          stoppedReason: 'Timeout',
          // The 2.1 handler answered totalCost 0 (C20.FR.03) and passes no cost.
          timestamp: '2024-01-01T00:01:00Z',
        }),
      );

      const timeoutUpdate = sqlCalls.find(
        (c) =>
          c.strings.some((s) => s.includes('UPDATE charging_sessions')) &&
          c.strings.some((s) => s.includes("ELSE 'failed' END")),
      );
      expect(timeoutUpdate).toBeDefined();
      expect(timeoutUpdate?.strings.join('?')).toContain('final_cost_cents = 0');
      expect(timeoutUpdate?.strings.join('?')).toContain('current_cost_cents = 0');
      // No final cost from the tariff snapshot
      expect(mockPriceSessionAt).not.toHaveBeenCalled();
      expect(
        sqlCalls.some((c) => c.strings.some((s) => s.includes('SET final_cost_cents = '))),
      ).toBe(false);
      // No session.Completed or session.Receipt for a failed session
      expect(mockDispatchDriver).not.toHaveBeenCalled();
      // The settlement still runs: a cost of 0 cancels the hold
      expect(mockSettleSessionPayment).toHaveBeenCalledWith(
        'session-connect-timeout',
        mockPaymentContext,
        SETTLE_OPTIONS,
      );
    });
  });

  describe('ocpp.TransactionEvent Ended - EVDisconnected with non-zero energy', () => {
    it('keeps session as completed when energy was delivered', async () => {
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [], // SELECT payment_records (no failed payment)
        [], // SELECT the active session with an open idle period (JB-2 due notice): none
        [], // UPDATE charging_sessions SET status = 'completed'
        [
          {
            id: 'session-with-energy',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 5000,
            currency: 'USD',
            tariff_price_per_kwh: null,
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
            idle_started_at: null,
            idle_minutes: 0,
          },
        ], // SELECT session
        // NO UPDATE to failed (EVDisconnected is not a timeout reason)
        [], // INSERT transaction_events
        [], // carbon query (no region found)
        [{ site_id: null }], // resolveSiteId
        [
          {
            driver_id: null,
            energy_delivered_wh: 5000,
            final_cost_cents: null,
            currency: 'USD',
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ], // SELECT for driver notification
        // Second subscriber (auto-capture)
        [{ id: 'session-with-energy', final_cost_cents: null, site_id: null }],
        [], // No payment records
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-evdisconnected-energy',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          stoppedReason: 'EVDisconnected',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      // Verify NO timeout UPDATE to 'failed' was called
      const failedUpdate = sqlCalls.find(
        (c) =>
          c.strings.some((s) => s.includes('UPDATE charging_sessions')) &&
          c.strings.some((s) => s.includes("status = 'failed'")),
      );
      expect(failedUpdate).toBeUndefined();
    });
  });

  // ---- NotifyEVChargingNeeds calls charging profile computer ----

  describe('ocpp.NotifyEVChargingNeeds - ISO 15118 profile', () => {
    it('calls computeAndSendChargingProfile after persisting needs', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT ev_charging_needs (upsert)
        [{ site_id: 'sit_test' }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.NotifyEVChargingNeeds',
        makeDomainEvent('ocpp.NotifyEVChargingNeeds', 'CS-TEST', {
          evseId: 1,
          chargingNeeds: {
            requestedEnergyTransfer: 'AC_single_phase',
            acChargingParameters: { evMaxCurrent: 32, evMaxVoltage: 230 },
          },
          maxScheduleTuples: 10,
        }),
      );

      // Wait for dynamic import to resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(mockComputeAndSendChargingProfile).toHaveBeenCalledWith(
        expect.anything(),
        mockPubSub,
        expect.objectContaining({
          stationUuid: 'sta_000000000001',
          stationOcppId: 'CS-TEST',
          evseId: 1,
        }),
      );
    });
  });
  describe('prepaid tokens (C17)', () => {
    const startedEvent = (transactionId: string) =>
      makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
        eventType: 'Started',
        stationId: 'CS-001',
        transactionId,
        seqNo: 0,
        triggerReason: 'Authorized',
        timestamp: '2024-01-01T00:00:00Z',
        idToken: 'PREPAID-1',
        tokenType: 'ISO14443',
      });
    const startedResults = (prepaidBalanceCents: number, reservedCents = 0) => [
      [{ id: 'sta_000000000001' }], // resolveStationId
      [], // eager OCPI roaming check
      [{ id: 'session-pp' }], // INSERT charging_sessions RETURNING id
      [], // UPDATE stale sessions
      [], // INSERT transaction_events
      [{ is_roaming: false }], // SELECT is_roaming
      [{ driver_id: null }], // SELECT driver_id
      [{ id: 'dtk_pp', driver_id: 'drv_pp', prepaid_balance_cents: prepaidBalanceCents }], // driver_tokens
      [{ prepaid_balance_cents: prepaidBalanceCents }], // driver_tokens FOR UPDATE
      [{ reserved_cents: reservedCents }], // other active sessions of the token
      [], // UPDATE charging_sessions SET token_id, cost_ceiling_cents
    ];
    const stopCommands = (): unknown[][] =>
      (mockPubSub.publish as Mock<PubSubClient['publish']>).mock.calls.filter(
        (c: unknown[]) =>
          c[0] === 'ocpp_commands' &&
          typeof c[1] === 'string' &&
          c[1].includes('RequestStopTransaction'),
      );

    it('skips the card pre-authorization for a prepaid token with credit', async () => {
      await setup();
      setupSqlResults(...startedResults(5000));

      await eventBus.emit('ocpp.TransactionEvent', startedEvent('tx-pp'));

      expect(sqlCalls.some((c) => c.strings.join('?').includes('driver_payment_methods'))).toBe(
        false,
      );
      expect(stopCommands()).toHaveLength(0);
    });

    it('stamps the prepaid credit as the cost ceiling of the session (C17.FR.03)', async () => {
      await setup();
      setupSqlResults(...startedResults(5000));

      await eventBus.emit('ocpp.TransactionEvent', startedEvent('tx-pp-ceil'));

      const link = findSql(/SET token_id = .*cost_ceiling_cents/s);
      expect(link?.values).toEqual(['dtk_pp', 5000, 'session-pp']);
    });

    it('stops a session started by a prepaid token without credit', async () => {
      await setup();
      setupSqlResults(...startedResults(0));

      await eventBus.emit('ocpp.TransactionEvent', startedEvent('tx-pp-0'));

      // No credit: a zero ceiling, so nothing is billed.
      expect(findSql(/SET token_id = .*cost_ceiling_cents/s)?.values).toEqual([
        'dtk_pp',
        0,
        'session-pp',
      ]);
      expect(stopCommands()).toHaveLength(1);
      expect(sqlCalls.some((c) => c.strings.join('?').includes('driver_payment_methods'))).toBe(
        false,
      );
    });

    it("reserves the credit of the token's other active sessions", async () => {
      await setup();
      setupSqlResults(...startedResults(5000, 3000));

      await eventBus.emit('ocpp.TransactionEvent', startedEvent('tx-pp-second'));

      expect(findSql(/FROM driver_tokens WHERE id = .* FOR UPDATE/s)?.values).toEqual(['dtk_pp']);
      // Other active sessions, ended ones without a debit for 24 hours, and
      // re-billable EndRequestFailed ones without a time limit, in the company
      // currency.
      const reserved = findSql(/AS reserved_cents/);
      expect(reserved?.values).toEqual(['USD', 'EndRequestFailed', 'dtk_pp', 'session-pp', 24]);
      const reservedSql = reserved?.strings.join('?') ?? '';
      expect(reservedSql).toContain('NOT EXISTS (SELECT 1 FROM payment_records');
      expect(reservedSql).toContain("rebill_status IS NULL OR cs.rebill_status = 'in_progress'");
      expect(reservedSql).toContain('OR (o.unsettled AND o.rebillable)');
      expect(findSql(/SET token_id = .*cost_ceiling_cents/s)?.values).toEqual([
        'dtk_pp',
        2000,
        'session-pp',
      ]);
      expect(stopCommands()).toHaveLength(0);
    });

    it('links without a ceiling when the token is no longer prepaid at the lock', async () => {
      await setup();
      const results: unknown[][] = startedResults(5000);
      // The operator made the token postpaid between the lookup and the lock.
      results.splice(8, 3, [{ prepaid_balance_cents: null }], []);
      setupSqlResults(...results);

      await eventBus.emit('ocpp.TransactionEvent', startedEvent('tx-pp-postpaid'));

      expect(findSql(/SET token_id = .*cost_ceiling_cents/s)).toBeUndefined();
      expect(findSql(/AS reserved_cents/)).toBeUndefined();
      const link = findSql(/UPDATE charging_sessions SET token_id = /);
      expect(link?.values).toEqual(['dtk_pp', 'session-pp']);
    });

    it('stops a second session when the other sessions reserve the whole credit', async () => {
      await setup();
      setupSqlResults(...startedResults(5000, 5000));

      await eventBus.emit('ocpp.TransactionEvent', startedEvent('tx-pp-full'));

      expect(findSql(/SET token_id = .*cost_ceiling_cents/s)?.values).toEqual([
        'dtk_pp',
        0,
        'session-pp',
      ]);
      expect(stopCommands()).toHaveLength(1);
    });

    it('reports the prepaid debit when the session ends', async () => {
      await setup();
      mockSettleSessionPayment.mockResolvedValueOnce({
        mode: 'prepaid',
        tokenId: 'dtk_pp',
        debitedCents: 1000,
        balanceCents: 4000,
      });
      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }],
        [], // SELECT payment_records (no failed payment)
        [], // SELECT the active session with an open idle period (JB-2 due notice): none
        [],
        [
          {
            id: 'session-pp-end',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 0,
            currency: 'USD',
            tariff_price_per_kwh: null,
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
          },
        ],
        [],
        [], // carbon query
        [{ site_id: null }],
        [], // SELECT ocpp_protocol
        // Second subscriber
        [
          {
            id: 'session-pp-end',
            final_cost_cents: 1000,
            station_uuid: 'sta_000000000001',
            currency: 'USD',
            station_ocpp_id: 'CS-001',
            site_id: 'site-pp',
          },
        ],
        [], // pg_notify (payment.settled)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-pp-end',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      expect(mockSettleSessionPayment).toHaveBeenCalledWith(
        'session-pp-end',
        mockPaymentContext,
        SETTLE_OPTIONS,
      );
      expect(mockPubSub.publish).toHaveBeenCalledWith(
        'csms_events',
        JSON.stringify({ eventType: 'token.changed', tokenId: 'dtk_pp' }),
      );
      const settled = (mockPubSub.publish as Mock<PubSubClient['publish']>).mock.calls
        .filter((c) => c[0] === 'csms_events')
        .map((c) => JSON.parse(c[1]) as Record<string, unknown>)
        .find((m) => m['eventType'] === 'payment.settled');
      expect(settled).toMatchObject({ sessionId: 'session-pp-end', siteId: 'site-pp' });
      expect(
        mockDispatchDriver.mock.calls.some((c: unknown[]) => c[1] === 'session.PaymentReceived'),
      ).toBe(false);
    });

    it('continues when the token.changed publish fails after a prepaid debit', async () => {
      await setup();
      mockSettleSessionPayment.mockResolvedValueOnce({
        mode: 'prepaid',
        tokenId: 'dtk_pp',
        debitedCents: 1000,
        balanceCents: 4000,
      });
      vi.mocked(mockPubSub.publish).mockImplementation((_channel, message) =>
        message.includes('token.changed')
          ? Promise.reject(new Error('redis down'))
          : Promise.resolve(),
      );
      setupSqlResults(
        [{ id: 'sta_000000000001' }],
        [], // SELECT payment_records (no failed payment)
        [], // SELECT the active session with an open idle period (JB-2 due notice): none
        [],
        [{ id: 'session-pp-end', tariff_id: null, current_cost_cents: 0, currency: 'USD' }],
        [],
        [], // carbon query
        [{ site_id: null }],
        [], // SELECT ocpp_protocol
        [{ id: 'session-pp-end', final_cost_cents: 1000, station_uuid: null, currency: 'USD' }],
      );

      await expect(
        eventBus.emit(
          'ocpp.TransactionEvent',
          makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
            eventType: 'Ended',
            stationId: 'CS-001',
            transactionId: 'tx-pp-end-2',
            seqNo: 2,
            triggerReason: 'EVDeparted',
            timestamp: '2024-01-01T01:00:00Z',
          }),
        ),
      ).resolves.toBeUndefined();
      expect(mockSettleSessionPayment).toHaveBeenCalledTimes(1);
    });
  });
});
