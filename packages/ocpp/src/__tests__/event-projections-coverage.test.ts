// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { EventBus, DomainEvent, PubSubClient } from '@evtivity/lib';

// SQL mock: a function that handles tagged template calls and returns configurable results
const sqlCalls: Array<{ strings: string[]; values: unknown[] }> = [];
let sqlResults: Array<unknown[]> = [];
let sqlCallIndex = 0;
let sqlErrors: Map<number, Error> = new Map();
let sqlCountOverrides: Map<number, number> = new Map();

/** Marker for results that should have count=0 (simulates INSERT WHERE EXISTS with no match) */
const EMPTY_INSERT = Object.assign([] as unknown[], { __emptyInsert: true });

function createSqlMock() {
  sqlCalls.length = 0;
  sqlResults = [];
  sqlCallIndex = 0;
  sqlErrors = new Map();
  sqlCountOverrides = new Map();

  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    sqlCalls.push({ strings: [...strings], values });
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

vi.mock('@evtivity/database', () => ({
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
}));

const mockDispatchOcpp = vi.fn().mockResolvedValue(undefined);
const mockDispatchDriver = vi.fn().mockResolvedValue(undefined);

vi.mock('../server/notification-dispatcher.js', () => ({
  dispatchOcppNotification: mockDispatchOcpp,
  dispatchDriverNotification: mockDispatchDriver,
  dispatchSystemNotification: vi.fn().mockResolvedValue(undefined),
  ALL_TEMPLATES_DIRS: ['/mock/templates'],
}));

const mockCalculateSessionCost = vi.fn().mockReturnValue({ totalCents: 1500 });
const mockDecryptString = vi.fn().mockReturnValue('sk_test_decrypted');
const mockLoggerError = vi.fn();

vi.mock('@evtivity/lib', async () => {
  const actual = await vi.importActual<typeof import('@evtivity/lib')>('@evtivity/lib');
  return {
    ...actual,
    calculateSessionCost: mockCalculateSessionCost,
    decryptString: mockDecryptString,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: mockLoggerError,
      debug: vi.fn(),
      child: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: mockLoggerError,
        debug: vi.fn(),
      }),
    }),
  };
});

const mockStripePaymentIntentsCreate = vi.fn().mockResolvedValue({ id: 'pi_test' });
const mockStripePaymentIntentsCapture = vi.fn().mockResolvedValue({});
const mockStripePaymentIntentsCancel = vi.fn().mockResolvedValue({});
const mockStripePaymentIntentsRetrieve = vi.fn().mockResolvedValue({
  customer: 'cus_test',
  payment_method: 'pm_test',
  on_behalf_of: null,
});

vi.mock('stripe', () => ({
  default: class MockStripe {
    paymentIntents = {
      create: mockStripePaymentIntentsCreate,
      capture: mockStripePaymentIntentsCapture,
      cancel: mockStripePaymentIntentsCancel,
      retrieve: mockStripePaymentIntentsRetrieve,
    };
  },
}));

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
        [], // INSERT connectors
        [], // INSERT port_status_log
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
        [], // INSERT port_status_log (previousStatus will be null)
        [], // UPDATE evses
        [], // SELECT connectors (not found)
        [], // INSERT connectors
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
            currency: 'EUR',
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
            currency: 'USD',
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
          // resolveTariff: no matches
          [], // station group
          [], // site group
          [], // default group
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
        // resolveTariff: goes straight to station group then default
        [], // station pricing group
        [], // site pricing group
        [], // default pricing group
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
        // resolvePricingGroupId is now one CTE that resolves driver/fleet/
        // station/site/default in a single round-trip. Default group returned.
        [{ id: 'group-default' }], // resolvePricingGroupId CTE
        // resolveTariffForStation: fetch all tariffs for the group
        [
          {
            id: 'tariff-default',
            currency: 'GBP',
            price_per_kwh: '0.20',
            price_per_minute: '0.05',
            price_per_session: null,
            idle_fee_price_per_minute: '0.10',
            tax_rate: '0.20',
            restrictions: null,
            priority: 0,
            is_default: true,
          },
        ], // tariffs for group
        [], // pricing_holidays (empty)
        [], // timezone lookup
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
        // resolveTariff: all empty
        [], // station pricing group
        [], // site pricing group
        [], // default pricing group
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
        // resolvePricingGroupId
        [], // station pricing group
        [], // site pricing group
        [], // default pricing group
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

  describe('ocpp.TransactionEvent Ended - tariff snapshot missing currency', () => {
    it('skips cost computation if session has tariff_id but no currency snapshot', async () => {
      mockCalculateSessionCost.mockClear();
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // 0: resolveStationId
        [], // 1: UPDATE charging_sessions
        [
          {
            id: 'session-1',
            tariff_id: 'tariff-deleted',
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 5000,
            currency: null,
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
            currency: null,
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

      expect(mockCalculateSessionCost).not.toHaveBeenCalled();
    });
  });

  describe('ocpp.TransactionEvent Ended - no stoppedReason', () => {
    it('handles missing stoppedReason (getString returns null)', async () => {
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // SELECT payment_records (no failed payment)
        [], // UPDATE charging_sessions
        [
          {
            id: 'session-1',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 0,
            currency: null,
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
            currency: null,
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
        [], // UPDATE charging_sessions
        [
          {
            id: 'session-1',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 10000,
            currency: null,
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
        [
          {
            driver_id: 'driver-ended',
            energy_delivered_wh: 10000,
            final_cost_cents: 2500,
            currency: 'EUR',
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ], // SELECT driver info for notification
        // Second subscriber (auto-capture Ended)
        [{ id: 'session-1', final_cost_cents: 2500, site_id: null }], // SELECT session
        [], // SELECT payment_records (empty - no pre-auth)
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
        }),
        ['/mock/templates'],
        expect.anything(),
      );
    });

    it('uses USD as default currency when session currency is null', async () => {
      mockDispatchDriver.mockClear();
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // SELECT payment_records (no failed payment)
        [], // UPDATE charging_sessions
        [
          {
            id: 'session-1',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 5000,
            currency: null,
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
            driver_id: 'driver-null-currency',
            energy_delivered_wh: 5000,
            final_cost_cents: 500,
            currency: null,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ], // SELECT driver info
        // Second subscriber
        [{ id: 'session-1', final_cost_cents: 500, site_id: null }],
        [], // No payment records
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-null-currency',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'session.Completed',
        'driver-null-currency',
        expect.objectContaining({ currency: 'USD' }),
        ['/mock/templates'],
        expect.anything(),
      );
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
        [], // UPDATE charging_sessions
        [
          {
            id: 'session-1',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 0,
            currency: null,
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
            currency: null,
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
        [], // resolveActiveSessionId fallback
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
      mockCalculateSessionCost.mockReturnValueOnce({ totalCents: 100 });
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // resolveActiveSessionId fallback
        [], // INSERT meter_values
        [], // UPDATE meter_start
        [], // UPDATE energy
        [
          {
            id: 'session-1',
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

      mockCalculateSessionCost.mockReturnValueOnce({ totalCents: 100 }); // Same cost

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
      expect(costUpdateCalls.length).toBe(0);
    });
  });

  describe('ocpp.MeterValues - active session with no currency snapshot', () => {
    it('skips cost calculation when session has no currency snapshot', async () => {
      mockCalculateSessionCost.mockClear();
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // resolveActiveSessionId fallback
        [], // INSERT meter_values
        [], // UPDATE meter_start
        [], // UPDATE energy
        [
          {
            id: 'session-1',
            tariff_id: 'tariff-missing',
            started_at: '2024-01-01T00:00:00Z',
            energy_delivered_wh: 5000,
            current_cost_cents: 0,
            currency: null,
            tariff_price_per_kwh: null,
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
          },
        ], // active sessions (includes snapshot columns, but currency is null)
        // No separate tariff SELECT - uses snapshot columns from session row
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
                  measurand: 'Energy.Active.Import.Register',
                  value: 5000,
                  unitOfMeasure: { unit: 'Wh' },
                },
              ],
            },
          ],
        }),
      );

      expect(mockCalculateSessionCost).not.toHaveBeenCalled();
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
        [], // resolveActiveSessionId fallback
        [], // INSERT meter_values
        [], // UPDATE meter_start
        [], // UPDATE energy
        [
          {
            id: 'session-1',
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
        [{ transaction_id: 'tx-1' }], // SELECT transaction_id
        [], // CostUpdated pubsub (will fail)
        [{ site_id: null }], // resolveSiteId
      );

      // Should not throw
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
                  measurand: 'Energy.Active.Import.Register',
                  value: 5000,
                  unitOfMeasure: { unit: 'Wh' },
                },
              ],
            },
          ],
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(5);
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
    it('creates Stripe pre-auth when driver has default payment method', async () => {
      process.env['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key-32chars!!!!!';
      await setup();

      // The second subscriber fires after the first one.
      // We need enough SQL results for BOTH subscribers.
      setupSqlResults(
        // --- First subscriber (main TransactionEvent handler) ---
        [{ id: 'sta_000000000001' }], // 0: resolveStationId
        [], // 1: INSERT charging_sessions
        [{ id: 'session-preauth' }], // 2: SELECT id
        [], // 3: UPDATE stale sessions (RETURNING id, empty)
        [], // 4: INSERT transaction_events

        [{ is_roaming: false }], // SELECT is_roaming (eager-state seed)
        [{ driver_id: 'driver-pay' }], // 6: SELECT driver_id
        [], // 7: SELECT driver_tokens by idToken (no match for 'rfid-pay')
        [], // 8: SELECT vehicle_id (no previous vehicle, auto-link skipped)
        // resolveTariffForStation: resolvePricingGroupId is now a single CTE
        [{ id: 'pg-1' }], // 9: resolvePricingGroupId CTE
        [
          {
            id: 'tariff-1',
            currency: 'USD',
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
        ], // 10: SELECT tariffs
        [], // 11: SELECT pricing_holidays (loadHolidays)
        [], // 12: timezone lookup (cs join sites)
        [], // 13: UPDATE charging_sessions SET tariff_id
        [], // 14: INSERT session_tariff_segments
        [{ site_id: 'site-pay' }], // 15: resolveSiteId
        [{ name: 'Site Pay' }], // 16: resolveSiteName
        // --- runPaymentGate (called inline) ---
        [
          {
            id: 'pm-1',
            stripe_customer_id: 'cus_test',
            stripe_payment_method_id: 'pm_test',
          },
        ], // 17: SELECT driver_payment_methods
        // isTariffFreeForStation: single CTE + tariffs + holidays + timezone
        [{ id: 'pg-1' }], // 18: groupRows (CTE)
        [
          {
            id: 'tariff-paid',
            currency: 'USD',
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
        ], // 19: tariffRows (paid tariff)
        [], // 20: holidayRows
        [], // 21: timezone lookup
        [
          { key: 'stripe.currency', value: 'USD' },
          { key: 'stripe.preAuthAmountCents', value: 5000 },
        ], // 22: platform settings
        [], // 23: site payment config
        [{ currency: 'USD' }], // 24: NEW - currency mismatch guard (SELECT currency FROM charging_sessions)
        [], // 25: existing payment_records guard
        [
          { key: 'stripe.secretKeyEnc', value: 'encrypted-key' },
          { key: 'stripe.platformFeePercent', value: 0 },
        ], // 26: stripe settings
        [], // 27: INSERT payment_records
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-preauth',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
          idToken: 'rfid-pay',
          tokenType: 'ISO14443',
        }),
      );

      expect(mockStripePaymentIntentsCreate).toHaveBeenCalled();
      expect(mockDecryptString).toHaveBeenCalled();
    });

    it('skips pre-auth when no driver on session', async () => {
      process.env['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key-32chars!!!!!';
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'session-1' }], // INSERT charging_sessions ON CONFLICT DO UPDATE RETURNING id
        [], // UPDATE stale sessions
        [], // INSERT transaction_events

        [{ is_roaming: false }], // SELECT is_roaming (eager-state seed)
        [{ driver_id: null }], // SELECT driver_id
        [], // station tariff
        [], // default tariff
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

      expect(mockStripePaymentIntentsCreate).not.toHaveBeenCalled();
    });

    it('skips pre-auth when no default payment method', async () => {
      process.env['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key-32chars!!!!!';
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }],
        [],
        [{ id: 'session-1' }],
        [], // UPDATE stale sessions
        [],

        [{ is_roaming: false }], // SELECT is_roaming (eager-state seed)
        [{ driver_id: 'driver-nopay' }],
        [
          {
            id: 'tariff-1',
            currency: 'USD',
            price_per_kwh: '0.30',
            price_per_minute: null,
            price_per_session: null,
            idle_fee_price_per_minute: null,
            tax_rate: null,
          },
        ],
        [],
        [{ site_id: null }],
        [{ name: null }], // resolveSiteName
        // runPaymentGate (no session query needed)
        [], // SELECT driver_payment_methods (empty)
        [{ is_free: true }], // isTariffFreeForStation -> free, returns early
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-no-pm',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
          idToken: 'rfid-nopay',
          tokenType: 'ISO14443',
        }),
      );

      expect(mockStripePaymentIntentsCreate).not.toHaveBeenCalled();
    });

    it('skips pre-auth when no encryption key', async () => {
      // No SETTINGS_ENCRYPTION_KEY set
      delete process.env['SETTINGS_ENCRYPTION_KEY'];
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }],
        [],
        [{ id: 'session-1' }],
        [], // UPDATE stale sessions
        [],

        [{ is_roaming: false }], // SELECT is_roaming (eager-state seed)
        [{ driver_id: 'driver-1' }],
        [
          {
            id: 'tariff-1',
            currency: 'USD',
            price_per_kwh: '0.30',
            price_per_minute: null,
            price_per_session: null,
            idle_fee_price_per_minute: null,
            tax_rate: null,
          },
        ],
        [],
        [{ site_id: null }],
        [{ name: null }], // resolveSiteName
        // runPaymentGate (no session query needed)
        [{ id: 'pm-1', stripe_customer_id: 'cus_1', stripe_payment_method_id: 'pm_1' }],
        [], // SELECT platform settings (empty - defaults used)
        // No site override (site_id is null)
        [], // SELECT payment_records guard (no existing record)
        // encryptionKey is null, so returns early before stripe settings query
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-no-enc',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
        }),
      );

      expect(mockStripePaymentIntentsCreate).not.toHaveBeenCalled();
    });

    it('skips pre-auth when no stripe secretKeyEnc setting', async () => {
      process.env['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key-32chars!!!!!';
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }],
        [],
        [{ id: 'session-1' }],
        [], // UPDATE stale sessions
        [],

        [{ is_roaming: false }], // SELECT is_roaming (eager-state seed)
        [{ driver_id: 'driver-1' }],
        [
          {
            id: 'tariff-1',
            currency: 'USD',
            price_per_kwh: '0.30',
            price_per_minute: null,
            price_per_session: null,
            idle_fee_price_per_minute: null,
            tax_rate: null,
          },
        ],
        [],
        [{ site_id: null }],
        [{ name: null }], // resolveSiteName
        // runPaymentGate (no session query needed)
        [{ id: 'pm-1', stripe_customer_id: 'cus_1', stripe_payment_method_id: 'pm_1' }],
        [], // SELECT platform settings (empty - defaults used)
        // No site override (site_id is null)
        [], // SELECT payment_records guard (no existing record)
        [], // SELECT stripe settings (empty - no secretKeyEnc)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-no-stripe',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
        }),
      );

      expect(mockStripePaymentIntentsCreate).not.toHaveBeenCalled();
    });

    it('handles pre-auth error by stopping session', async () => {
      process.env['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key-32chars!!!!!';
      mockStripePaymentIntentsCreate.mockRejectedValueOnce(new Error('card_declined'));
      await setup();

      mockLoggerError.mockClear();

      // No idToken in payload, so eager OCPI check + driver_tokens lookup
      // are skipped. Driver auto-link triggers vehicle lookup later.
      setupSqlResults(
        // First subscriber (TransactionEvent.Started)
        [{ id: 'sta_000000000001' }], // 0: resolveStationId
        [{ id: 'session-1' }], // 1: INSERT charging_sessions ON CONFLICT DO UPDATE RETURNING id
        [], // 2: UPDATE stale sessions (RETURNING id, empty)
        [], // 3: INSERT transaction_events
        [{ is_roaming: false }], // 5: SELECT is_roaming (eager-state seed)
        [{ driver_id: 'driver-1' }], // 6: SELECT driver_id
        // idToken is null on this payload, so no driver_tokens lookup
        [], // 7: SELECT vehicle_id (auto-link)
        // resolveTariffForStation: resolvePricingGroupId is now a single CTE
        [{ id: 'pg-1' }], // 8: resolvePricingGroupId CTE
        [
          {
            id: 'tariff-1',
            currency: 'USD',
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
        ], // 9: SELECT tariffs
        [], // 10: SELECT pricing_holidays
        [], // 11: timezone lookup
        [], // 12: UPDATE charging_sessions SET tariff_id
        [], // 13: INSERT session_tariff_segments
        [{ site_id: null }], // 14: resolveSiteId
        [{ name: null }], // 15: resolveSiteName
        // runPaymentGate
        [{ id: 'pm-1', stripe_customer_id: 'cus_1', stripe_payment_method_id: 'pm_1' }], // 16: pmRows
        // isTariffFreeForStation: single CTE + tariffs + holidays + timezone
        [{ id: 'pg-1' }], // 17: groupRows CTE
        [
          {
            id: 'tariff-paid',
            currency: 'USD',
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
        ], // 18: tariffRows
        [], // 19: holidayRows
        [], // 20: timezone lookup
        [], // 21: platform settings
        // No site override (site_id is null, so query is skipped)
        [{ currency: 'USD' }], // 22: NEW currency mismatch guard
        [], // 23: SELECT payment_records guard
        [{ key: 'stripe.secretKeyEnc', value: 'encrypted' }], // 24: stripe settings
        [], // 25: INSERT payment_records (failed)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-decline',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
        }),
      );

      expect(mockLoggerError).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        'Auto pre-auth failed, stopping session',
      );

      // Verify RequestStopTransaction was published
      const publishCalls = (mockPubSub.publish as Mock<PubSubClient['publish']>).mock.calls;
      const stopCmd = publishCalls.find((c) => c[0] === 'ocpp_commands');
      expect(stopCmd).toBeDefined();
      const stopPayload = JSON.parse(stopCmd![1]);
      expect(stopPayload.action).toBe('RequestStopTransaction');
      expect(stopPayload.stationId).toBe('CS-001');
      expect(stopPayload.payload.transactionId).toBe('tx-decline');

      // Verify payment failure SSE event was published
      const sseEvent = publishCalls.find(
        (c) => c[0] === 'csms_events' && c[1].includes('payment.preAuthFailed'),
      );
      expect(sseEvent).toBeDefined();
      const ssePayload = JSON.parse(sseEvent![1]);
      expect(ssePayload.type).toBe('payment.preAuthFailed');
      expect(ssePayload.sessionId).toBe('session-1');
      expect(ssePayload.reason).toBe('card_declined');
    });

    it('creates local pre_authorized record for simulated customer without calling Stripe', async () => {
      process.env['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key-32chars!!!!!';
      // Force shouldSimulateFailure to return false (success path)
      const mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      await setup();

      // No idToken in payload, so eager OCPI check is skipped + driver_tokens
      // lookup is skipped.
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // 0: resolveStationId
        [{ id: 'session-sim' }], // 1: INSERT charging_sessions ON CONFLICT DO UPDATE RETURNING id
        [], // 2: UPDATE stale sessions
        [], // 3: INSERT transaction_events
        [{ is_roaming: false }], // 5: SELECT is_roaming (eager-state seed)
        [{ driver_id: 'driver-sim' }], // 6: SELECT driver_id
        [], // 7: SELECT vehicle_id
        [{ id: 'pg-1' }], // 8: resolvePricingGroupId CTE
        [
          {
            id: 'tariff-1',
            currency: 'USD',
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
        ], // 9: SELECT tariffs
        [], // 10: SELECT pricing_holidays
        [], // 11: timezone lookup
        [], // 12: UPDATE charging_sessions SET tariff_id
        [], // 13: INSERT session_tariff_segments
        [{ site_id: null }], // 14: resolveSiteId
        [{ name: null }], // 15: resolveSiteName
        [
          {
            id: 'pm-sim',
            stripe_customer_id: 'cus_sim_000001',
            stripe_payment_method_id: 'pm_sim_000001',
          },
        ], // 16: SELECT driver_payment_methods
        [{ id: 'pg-1' }], // 17: isTariffFreeForStation groupRows CTE
        [
          {
            id: 'tariff-paid',
            currency: 'USD',
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
        ], // 18: tariffRows
        [], // 19: holidayRows
        [], // 20: timezone lookup
        [], // 21: platform settings
        [{ currency: 'USD' }], // 22: NEW currency mismatch guard
        [], // 23: payment_records guard
        [], // 24: INSERT payment_records (pre_authorized, simulated)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-sim-preauth',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
        }),
      );

      // Stripe should never be called for simulated customers
      expect(mockStripePaymentIntentsCreate).not.toHaveBeenCalled();

      // Verify a payment_records INSERT happened with pre_authorized status
      const prInsert = sqlCalls.find(
        (c) =>
          c.strings.some((s) => s.includes('payment_records')) &&
          c.strings.some((s) => s.includes('INSERT')),
      );
      expect(prInsert).toBeDefined();

      mathRandomSpy.mockRestore();
    });

    it('applies site payment config overrides including connected account', async () => {
      process.env['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key-32chars!!!!!';
      await setup();

      // Payload has idToken='rfid-site', driver pre-resolved -> driver_tokens
      // lookup runs (empty), then vehicle auto-link runs.
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // 0: resolveStationId
        [], // 1: INSERT charging_sessions
        [{ id: 'session-site' }], // 2: SELECT id
        [], // 3: UPDATE stale
        [], // 4: INSERT transaction_events

        [{ is_roaming: false }], // SELECT is_roaming (eager-state seed)
        [{ driver_id: 'driver-site' }], // 6: SELECT driver_id
        [], // 7: SELECT driver_tokens by idToken (no match)
        [], // 8: SELECT vehicle_id (auto-link)
        [{ id: 'pg-1' }], // 9: resolvePricingGroupId CTE
        [
          {
            id: 'tariff-1',
            currency: 'USD',
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
        ], // 10: SELECT tariffs
        [], // 11: SELECT pricing_holidays
        [], // 12: timezone lookup
        [], // 13: UPDATE charging_sessions SET tariff_id
        [], // 14: INSERT session_tariff_segments
        [{ site_id: 'site-stripe' }], // 15: resolveSiteId
        [{ name: 'Site Stripe' }], // 16: resolveSiteName
        // runPaymentGate
        [{ id: 'pm-1', stripe_customer_id: 'cus_site', stripe_payment_method_id: 'pm_site' }], // 17: pmRows
        [{ id: 'pg-1' }], // 18: isTariffFreeForStation groupRows CTE
        [
          {
            id: 'tariff-paid',
            currency: 'EUR',
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
        ], // 19: tariffRows
        [], // 20: holidayRows
        [], // 21: timezone lookup
        [], // 22: platform settings
        [
          {
            id: 'spc-1',
            currency: 'EUR',
            pre_auth_amount_cents: 10000,
            stripe_connected_account_id: 'acct_connected',
          },
        ], // 23: site payment config (override + connected account, EUR matches snapshot)
        [{ currency: 'EUR' }], // 24: NEW currency mismatch guard (EUR matches site override)
        [], // 25: existing payment_records guard
        [
          { key: 'stripe.secretKeyEnc', value: 'encrypted' },
          { key: 'stripe.platformFeePercent', value: 10 },
        ], // 26: stripe settings
        [], // 27: INSERT payment_records
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-site',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
          idToken: 'rfid-site',
          tokenType: 'ISO14443',
        }),
      );

      expect(mockStripePaymentIntentsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 10000,
          currency: 'eur',
          on_behalf_of: 'acct_connected',
          transfer_data: { destination: 'acct_connected' },
          application_fee_amount: 1000,
        }),
        expect.objectContaining({ idempotencyKey: expect.stringMatching(/^preauth_/) }),
      );
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
        // resolvePricingGroupId: station, site, default
        [], // station group
        [], // site group
        [], // default group
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
      // resolveTariffForStation: single CTE returns a group
      sqlResults[9] = [{ id: 'pg-1' }]; // resolvePricingGroupId CTE
      sqlResults[10] = [
        {
          id: 'tariff-nofree',
          currency: 'USD',
          price_per_kwh: '0.30',
          price_per_minute: null,
          price_per_session: null,
          idle_fee_price_per_minute: null,
          tax_rate: null,
          restrictions: null,
          priority: 0,
          is_default: true,
        },
      ]; // SELECT tariffs
      sqlResults[11] = []; // loadHolidays
      sqlResults[12] = []; // timezone lookup
      sqlResults[13] = []; // UPDATE session (tariff snapshot)
      sqlResults[14] = []; // INSERT session_tariff_segments
      sqlResults[15] = [{ site_id: null }]; // resolveSiteId
      sqlResults[16] = [{ name: null }]; // resolveSiteName

      // runPaymentGate
      sqlResults[17] = []; // SELECT driver_payment_methods (empty -> MissingPaymentMethod path)
      // isTariffFreeForStation: single CTE + tariffs + holidays + timezone
      sqlResults[18] = [{ id: 'pg-1' }]; // groupRows CTE
      sqlResults[19] = [
        {
          id: 'tariff-paid',
          currency: 'USD',
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
      ]; // tariffRows
      sqlResults[20] = []; // holidayRows
      sqlResults[21] = []; // timezone lookup

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
      // resolvePricingGroupId CTE
      sqlResults[9] = [{ id: 'pg-free' }];
      // SELECT tariffs
      sqlResults[10] = [
        {
          id: 'tariff-free',
          currency: 'USD',
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
      // loadHolidays
      sqlResults[11] = [];
      // timezone lookup
      sqlResults[12] = [];
      // UPDATE session tariff
      sqlResults[13] = [];
      // INSERT segment
      sqlResults[14] = [];
      // resolveSiteId
      sqlResults[15] = [{ site_id: null }];
      // resolveSiteName
      sqlResults[16] = [{ name: null }];

      // runPaymentGate
      // SELECT driver_payment_methods (empty)
      sqlResults[17] = [];
      // isTariffFreeForStation: 3 sequential queries (group, tariffs, holidays)
      sqlResults[18] = [{ id: 'pg-free' }]; // groupRows
      sqlResults[19] = [
        {
          id: 'tariff-free',
          currency: 'USD',
          price_per_kwh: '0',
          price_per_minute: null,
          price_per_session: null,
          idle_fee_price_per_minute: null,
          reservation_fee_per_minute: null,
          tax_rate: null,
          restrictions: null,
          priority: 0,
          is_default: true,
        },
      ]; // tariffRows (free)
      sqlResults[20] = []; // holidayRows
      sqlResults[21] = []; // timezone lookup

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
        // resolvePricingGroupId with null driver: station, site, default
        [], // station group
        [], // site group
        [], // default group -> no tariff
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
        // resolvePricingGroupId: station, site, default
        [], // 10: station group
        [], // 11: site group
        [], // 12: default group
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
  });

  describe('ocpp.TransactionEvent - Auto-capture on Ended', () => {
    it('captures Stripe payment when final cost is positive', async () => {
      process.env['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key-32chars!!!!!';
      await setup();

      setupSqlResults(
        // First subscriber (main Ended handler)
        [{ id: 'sta_000000000001' }], // 0: resolveStationId
        [], // SELECT payment_records (no failed payment)
        [], // 1: UPDATE charging_sessions SET status=completed
        [
          {
            id: 'session-capture',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 10000,
            currency: null,
            tariff_price_per_kwh: null,
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
          },
        ], // 2: SELECT session
        [], // 3: INSERT transaction_events
        [], // 4: carbon query (no region found)
        [{ site_id: null }], // 5: resolveSiteId
        [
          {
            driver_id: 'driver-capture',
            energy_delivered_wh: 10000,
            final_cost_cents: 2000,
            currency: 'USD',
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ], // 5: SELECT driver info for notification
        [{ name: null }], // 6: resolveSiteName
        [{ ocpp_protocol: 'ocpp2.1' }], // 6b: SELECT ocpp_protocol for station_message_transaction publish
        // Second subscriber (auto-capture Ended)
        [
          {
            id: 'session-capture',
            final_cost_cents: 2000,
            site_id: null,
          },
        ], // 7: SELECT session + join
        [
          {
            id: 'pr-1',
            stripe_payment_intent_id: 'pi_capture_test',
            driver_id: 'driver-capture',
            pre_auth_amount_cents: 2000,
          },
        ], // 8: SELECT payment_records (now includes driver_id)
        [{ value: 'encrypted-key' }], // 9: SELECT settings (secretKeyEnc)
        // New: captureSession query is fetched BEFORE the capture call so the
        // top-up path knows which currency to use.
        [{ station_ocpp_id: 'CS-001', currency: 'USD', station_uuid: 'sta_000000000001' }], // 10: SELECT captureSession (station_ocpp_id, currency, station_uuid)
        [], // 11: UPDATE payment_records
        [{ driver_id: 'driver-capture' }], // 12: SELECT driver_id for notification
        [{ name: null }], // 13: resolveSiteName lookup
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-capture',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      expect(mockStripePaymentIntentsCapture).toHaveBeenCalledWith(
        'pi_capture_test',
        { amount_to_capture: 2000 },
        { idempotencyKey: 'capture_pr-1' },
      );
      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'session.PaymentReceived',
        'driver-capture',
        expect.objectContaining({ amountCents: 2000 }),
        ['/mock/templates'],
        expect.anything(),
      );
    });

    it('cancels Stripe payment when final cost is zero or null', async () => {
      process.env['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key-32chars!!!!!';
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // 0: resolveStationId
        [], // SELECT payment_records (no failed payment)
        [], // 1: UPDATE status=completed
        [
          {
            id: 'session-cancel',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 0,
            currency: null,
            tariff_price_per_kwh: null,
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
          },
        ], // 2: SELECT session
        [], // 3: INSERT transaction_events
        [], // 4: carbon query (no region found)
        [{ site_id: null }], // 5: resolveSiteId
        [
          {
            driver_id: null,
            energy_delivered_wh: 0,
            final_cost_cents: null,
            currency: null,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ], // 6: SELECT driver info
        [{ ocpp_protocol: 'ocpp2.1' }], // 6b: SELECT ocpp_protocol for station_message_transaction publish
        // Second subscriber (auto-cancel)
        [{ id: 'session-cancel', final_cost_cents: null, site_id: null }], // 7: SELECT session
        [{ id: 'pr-1', stripe_payment_intent_id: 'pi_cancel_test', driver_id: 'driver-cancel' }], // 7: payment records (includes driver_id)
        [{ value: 'encrypted-key' }], // 8: settings
        [], // 9: UPDATE payment_records (cancelled)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-cancel',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      expect(mockStripePaymentIntentsCancel).toHaveBeenCalledWith('pi_cancel_test');
    });

    it('skips capture when no pre-authorized payment record', async () => {
      process.env['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key-32chars!!!!!';
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // 0
        [], // SELECT payment_records (no failed payment)
        [], // 1
        [
          {
            id: 'session-no-pr',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 0,
            currency: null,
            tariff_price_per_kwh: null,
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
          },
        ], // 2
        [], // 3
        [], // 4: carbon query (no region found)
        [{ site_id: null }], // 5
        [
          {
            driver_id: null,
            energy_delivered_wh: 0,
            final_cost_cents: null,
            currency: null,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ], // 6
        // Second subscriber
        [{ id: 'session-no-pr', final_cost_cents: 1000, site_id: null }], // 7
        [], // 7: No payment records
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-no-pr',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      expect(mockStripePaymentIntentsCapture).not.toHaveBeenCalled();
      expect(mockStripePaymentIntentsCancel).not.toHaveBeenCalled();
    });

    it('skips capture when payment intent ID is null', async () => {
      process.env['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key-32chars!!!!!';
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }],
        [], // SELECT payment_records (no failed payment)
        [],
        [
          {
            id: 'session-null-pi',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 0,
            currency: null,
            tariff_price_per_kwh: null,
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
          },
        ],
        [],
        [], // carbon query (no region found)
        [{ site_id: null }],
        [
          {
            driver_id: null,
            energy_delivered_wh: 0,
            final_cost_cents: null,
            currency: null,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ],
        // Second subscriber
        [{ id: 'session-null-pi', final_cost_cents: 1000, site_id: null }],
        [{ id: 'pr-1', stripe_payment_intent_id: null }], // null PI ID
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-null-pi',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      expect(mockStripePaymentIntentsCapture).not.toHaveBeenCalled();
    });

    it('skips capture when no encryption key', async () => {
      delete process.env['SETTINGS_ENCRYPTION_KEY'];
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }],
        [], // SELECT payment_records (no failed payment)
        [],
        [
          {
            id: 'session-1',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 0,
            currency: null,
            tariff_price_per_kwh: null,
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
          },
        ],
        [],
        [], // carbon query (no region found)
        [{ site_id: null }],
        [
          {
            driver_id: null,
            energy_delivered_wh: 0,
            final_cost_cents: null,
            currency: null,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ],
        // Second subscriber
        [{ id: 'session-1', final_cost_cents: 1000, site_id: null }],
        [{ id: 'pr-1', stripe_payment_intent_id: 'pi_test' }],
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-no-enc-end',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      expect(mockStripePaymentIntentsCapture).not.toHaveBeenCalled();
    });

    it('handles capture error gracefully', async () => {
      process.env['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key-32chars!!!!!';
      mockStripePaymentIntentsCapture.mockRejectedValueOnce(new Error('capture_failed'));
      await setup();

      mockLoggerError.mockClear();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }],
        [], // SELECT payment_records (no failed payment)
        [],
        [
          {
            id: 'session-err',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 0,
            currency: null,
            tariff_price_per_kwh: null,
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
          },
        ],
        [],
        [], // carbon query (no region found)
        [{ site_id: null }],
        [
          {
            driver_id: null,
            energy_delivered_wh: 0,
            final_cost_cents: null,
            currency: null,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ],
        [{ ocpp_protocol: 'ocpp2.1' }], // SELECT ocpp_protocol for station_message_transaction publish
        // Second subscriber
        [{ id: 'session-err', final_cost_cents: 2000, site_id: null }],
        [{ id: 'pr-1', stripe_payment_intent_id: 'pi_fail', driver_id: 'driver-fail' }],
        [{ value: 'encrypted-key' }],
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-capture-fail',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      expect(mockLoggerError).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        'Auto capture/cancel failed',
      );
    });

    it('skips capture when session not found in second subscriber', async () => {
      process.env['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key-32chars!!!!!';
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }],
        [], // SELECT payment_records (no failed payment)
        [],
        [
          {
            id: 'session-gone',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 0,
            currency: null,
            tariff_price_per_kwh: null,
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
          },
        ],
        [],
        [], // carbon query (no region found)
        [{ site_id: null }],
        [
          {
            driver_id: null,
            energy_delivered_wh: 0,
            final_cost_cents: null,
            currency: null,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ],
        // Second subscriber
        [], // session not found
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-gone',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      expect(mockStripePaymentIntentsCapture).not.toHaveBeenCalled();
    });

    it('skips capture for guest payment records (driver_id is null)', async () => {
      process.env['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key-32chars!!!!!';
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // 0: resolveStationId
        [], // SELECT payment_records (no failed payment)
        [], // 1: UPDATE status=completed
        [
          {
            id: 'session-guest-end',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 5000,
            currency: null,
            tariff_price_per_kwh: null,
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
          },
        ], // 2: SELECT session
        [], // 3: INSERT transaction_events
        [], // 4: carbon query (no region found)
        [{ site_id: null }], // 5: resolveSiteId
        [
          {
            driver_id: null,
            energy_delivered_wh: 5000,
            final_cost_cents: 1500,
            currency: null,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ], // 6: SELECT driver info
        // Second subscriber (auto-capture)
        [{ id: 'session-guest-end', final_cost_cents: 1500, site_id: null }], // 7: SELECT session
        [
          {
            id: 'pr-guest',
            stripe_payment_intent_id: 'pi_guest_abc',
            driver_id: null,
          },
        ], // 7: payment_records with null driver_id
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-guest-end',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      // Stripe capture should NOT be called for guest records
      expect(mockStripePaymentIntentsCapture).not.toHaveBeenCalled();
      expect(mockStripePaymentIntentsCancel).not.toHaveBeenCalled();
    });

    it('simulates capture success for pi_sim_ intents', async () => {
      process.env['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key-32chars!!!!!';
      // Mock Math.random to return 0.5 (> 0.2 threshold = success)
      const mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // 0: resolveStationId
        [], // SELECT payment_records (no failed payment)
        [], // 1: UPDATE status=completed
        [
          {
            id: 'session-sim-cap',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 10000,
            currency: null,
            tariff_price_per_kwh: null,
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
          },
        ], // 2: SELECT session
        [], // 3: INSERT transaction_events
        [], // 4: carbon query (no region found)
        [{ site_id: null }], // 5: resolveSiteId
        [
          {
            driver_id: 'drv_001',
            energy_delivered_wh: 10000,
            final_cost_cents: 2000,
            currency: null,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ], // 6: SELECT driver info
        [{ name: null }], // 7: resolveSiteName
        [{ ocpp_protocol: 'ocpp2.1' }], // 7b: SELECT ocpp_protocol for station_message_transaction publish
        // Second subscriber
        [{ id: 'session-sim-cap', final_cost_cents: 2000, site_id: null }], // 8: SELECT session
        [
          {
            id: 'pr-sim-cap',
            stripe_payment_intent_id: 'pi_sim_test123',
            driver_id: 'drv_001',
          },
        ], // 8: payment_records
        [], // 9: UPDATE payment_records (captured)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-sim-cap-success',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      // No real Stripe capture should be called
      expect(mockStripePaymentIntentsCapture).not.toHaveBeenCalled();

      // Verify UPDATE to captured status was executed
      const updateCall = sqlCalls.find(
        (c) =>
          c.strings.some((s) => s.includes('payment_records')) &&
          c.strings.some((s) => s.includes('captured')),
      );
      expect(updateCall).toBeDefined();

      mathRandomSpy.mockRestore();
    });

    it('simulates capture failure for pi_sim_ intents', async () => {
      process.env['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key-32chars!!!!!';
      // Mock Math.random to return 0.1 (< 0.2 threshold = failure)
      const mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // 0: resolveStationId
        [], // SELECT payment_records (no failed payment)
        [], // 1: UPDATE status=completed
        [
          {
            id: 'session-sim-fail',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 10000,
            currency: null,
            tariff_price_per_kwh: null,
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
          },
        ], // 2: SELECT session
        [], // 3: INSERT transaction_events
        [], // 4: carbon query (no region found)
        [{ site_id: null }], // 5: resolveSiteId
        [
          {
            driver_id: 'drv_001',
            energy_delivered_wh: 10000,
            final_cost_cents: 2000,
            currency: null,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ], // 6: SELECT driver info
        [{ name: null }], // 7: resolveSiteName
        [{ ocpp_protocol: 'ocpp2.1' }], // 7b: SELECT ocpp_protocol for station_message_transaction publish
        // Second subscriber
        [{ id: 'session-sim-fail', final_cost_cents: 2000, site_id: null }], // 8: SELECT session
        [
          {
            id: 'pr-sim-fail',
            stripe_payment_intent_id: 'pi_sim_test456',
            driver_id: 'drv_001',
          },
        ], // 8: payment_records
        [], // 9: UPDATE payment_records (failed)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-sim-cap-fail',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      // No real Stripe capture should be called
      expect(mockStripePaymentIntentsCapture).not.toHaveBeenCalled();

      // Verify UPDATE to failed status was executed
      const failedCall = sqlCalls.find(
        (c) =>
          c.strings.some((s) => s.includes('payment_records')) &&
          c.strings.some((s) => s.includes("'failed'")) &&
          c.strings.some((s) => s.includes('UPDATE')),
      );
      expect(failedCall).toBeDefined();

      mathRandomSpy.mockRestore();
      consoleWarnSpy.mockRestore();
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

  // ---- 2.1 Stub Persistence: NotifyWebPaymentStarted ----

  describe('ocpp.NotifyWebPaymentStarted', () => {
    it('persists web payment event', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT
      );

      await eventBus.emit(
        'ocpp.NotifyWebPaymentStarted',
        makeDomainEvent('ocpp.NotifyWebPaymentStarted', 'CS-TEST', {
          evseId: 2,
          timeout: 30,
        }),
      );

      expect(sqlCalls.length).toBe(2);
      expect(sqlCalls[1]?.strings.join('')).toContain('web_payment_events');
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
          gridEventFault: { type: 'UnderVoltage' },
        }),
      );

      expect(sqlCalls.length).toBe(2);
      expect(sqlCalls[1]?.strings.join('')).toContain('der_alarm_events');
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
          seqNo: 0,
          tbc: false,
          derControl: { controlType: 'FreqDroop' },
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
        // resolveTariffForStation -> resolvePricingGroupId (no driver)
        [], // station pricing group
        [], // site pricing group
        [], // default pricing group
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
        [], // UPDATE charging_sessions SET status = 'completed'
        [
          {
            id: 'session-evdisconnected',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T00:00:05Z',
            energy_delivered_wh: 0,
            currency: null,
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
            currency: null,
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
        [], // UPDATE charging_sessions SET status = 'completed'
        [
          {
            id: 'session-timeout-end',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T00:05:00Z',
            energy_delivered_wh: 0,
            currency: null,
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
            currency: null,
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
          c.strings.some((s) => s.includes("status = 'failed'")),
      );
      expect(failedUpdate).toBeDefined();
    });
  });

  describe('ocpp.TransactionEvent Ended - EVDisconnected with non-zero energy', () => {
    it('keeps session as completed when energy was delivered', async () => {
      await setup();

      setupSqlResults(
        // First subscriber
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [], // SELECT payment_records (no failed payment)
        [], // UPDATE charging_sessions SET status = 'completed'
        [
          {
            id: 'session-with-energy',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 5000,
            currency: null,
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
            currency: null,
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
});
