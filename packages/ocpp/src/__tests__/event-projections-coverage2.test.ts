// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, type Mock } from 'vitest';
import type { EventBus, DomainEvent, PubSubClient } from '@evtivity/lib';

// SQL mock: records every tagged-template call (strings + interpolated values)
// and returns configurable results per call index. `count` is derived so
// handlers that branch on `.count` (WHERE EXISTS inserts, conditional UPDATEs)
// can be exercised.
const sqlCalls: Array<{ strings: string[]; values: unknown[] }> = [];
let sqlResults: Array<unknown[]> = [];
let sqlCallIndex = 0;
let sqlErrors: Map<number, Error> = new Map();
let sqlCountOverrides: Map<number, number> = new Map();

/** Marker for results whose `.count` should be 0 (no-match insert/update). */
const EMPTY = Object.assign([] as unknown[], { __zeroCount: true });

function createSqlMock() {
  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    sqlCalls.push({ strings: [...strings], values });
    // The resend check (TransactionProjector.isResentEvent) answers by text,
    // outside the queued results: no event is a resend unless a test says so.
    if (strings.join('?').includes('AND te.seq_no = ?')) {
      return Promise.resolve(Object.assign([], { count: 0 }));
    }
    const idx = sqlCallIndex;
    sqlCallIndex++;
    const error = sqlErrors.get(idx);
    if (error != null) return Promise.reject(error);
    const result = sqlResults[idx] ?? [];
    const isZero = (result as unknown as { __zeroCount?: boolean }).__zeroCount === true;
    const count =
      sqlCountOverrides.get(idx) ?? (isZero ? 0 : result.length > 0 ? result.length : 1);
    const resultWithCount = Object.assign([...result], { count });
    return Promise.resolve(resultWithCount);
  };
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

// The payment service (@evtivity/payments): the gate's hold, the settlement on
// Ended, and the NotifySettlement record. The mode classification stays real.
const mockAuthorizeSessionHold = vi.fn();
const mockSettleSessionPayment = vi.fn();
const mockRecordTerminalSettlement = vi.fn();
const mockDispatchFleetCreditNotices = vi.fn().mockResolvedValue(null);
const mockReadFleetCreditLimit = vi.fn().mockResolvedValue(null);
const mockFleetCreditNoticesClaimed = vi.fn().mockResolvedValue(false);
// No credit left by default: the ceiling stays and the cost loop stops at it.
const mockExtendFleetSessionCeiling = vi.fn();
vi.mock('@evtivity/payments', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dispatchFleetCreditLimitNotices: (...args: unknown[]) =>
    mockDispatchFleetCreditNotices(...args) as unknown,
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
const mockIsAutoDisableOnCritical = vi.fn().mockResolvedValue(false);
const mockWriteAudit = vi.fn().mockResolvedValue(undefined);
const mockWriteReservationAudit = vi.fn().mockResolvedValue(undefined);
const mockGetMeterValueInterval = vi.fn().mockResolvedValue(0);
const mockGetClockAlignedInterval = vi.fn().mockResolvedValue(0);
const mockGetSampledMeasurands = vi.fn().mockResolvedValue('');
const mockGetAlignedMeasurands = vi.fn().mockResolvedValue('');
const mockGetTxEndedMeasurands = vi.fn().mockResolvedValue('');
const mockIsSiteFreeVend = vi.fn().mockResolvedValue(false);
const mockIsSplitBilling = vi.fn().mockResolvedValue(false);

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
  isSplitBillingEnabled: mockIsSplitBilling,
  getOfflineCommandTtlHours: vi.fn().mockResolvedValue(24),
  getMeterValueIntervalSeconds: mockGetMeterValueInterval,
  getClockAlignedIntervalSeconds: mockGetClockAlignedInterval,
  getSampledMeasurands: mockGetSampledMeasurands,
  getAlignedMeasurands: mockGetAlignedMeasurands,
  getTxEndedMeasurands: mockGetTxEndedMeasurands,
  writeReservationAudit: mockWriteReservationAudit,
  reservationDiffChanged: vi.fn().mockReturnValue(false),
  writeAudit: mockWriteAudit,
  firmwareCampaignAuditLog: { __table: 'firmware_campaign_audit_log' },
  stationAuditLog: { __table: 'station_audit_log' },
  isAutoDisableOnCriticalEnabled: mockIsAutoDisableOnCritical,
  isSiteFreeVendEnabledByStation: mockIsSiteFreeVend,
  getCompanyCurrency: vi.fn().mockResolvedValue('USD'),
  getCompanyPriceDisplay: vi.fn().mockResolvedValue('net'),
  readFleetCreditLimit: (...args: unknown[]) => mockReadFleetCreditLimit(...args) as unknown,
  fleetCreditNoticesClaimed: (...args: unknown[]) =>
    mockFleetCreditNoticesClaimed(...args) as unknown,
  extendFleetSessionCeiling: (...args: unknown[]) =>
    mockExtendFleetSessionCeiling(...args) as unknown,
  // The rule of fleet-credit-limit.ts: headroom below 20 % of the slice or
  // twice the last reading's cost.
  ceilingExtensionDue: (input: {
    pricedCents: number;
    ceilingCents: number;
    sliceCents: number;
    lastReadingCents?: number;
  }) => {
    const headroom = input.ceilingCents - input.pricedCents;
    return (
      headroom * 100 < input.sliceCents * 20 ||
      headroom < 2 * Math.max(input.lastReadingCents ?? 0, 0)
    );
  },
  getFleetCreditReservationCents: vi.fn().mockResolvedValue(50),
}));

const mockDispatchOcpp = vi.fn().mockResolvedValue(undefined);
const mockDispatchDriver = vi.fn().mockResolvedValue(undefined);
const mockDispatchSystem = vi.fn().mockResolvedValue(undefined);

vi.mock('../server/notification-dispatcher.js', () => ({
  dispatchOcppNotification: mockDispatchOcpp,
  dispatchDriverNotification: mockDispatchDriver,
  dispatchSystemNotification: mockDispatchSystem,
  ALL_TEMPLATES_DIRS: ['/mock/templates'],
}));

const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();
const mockLoggerDebug = vi.fn();

const mockDecryptString = vi.fn().mockReturnValue('sk_test_decrypted');

vi.mock('@evtivity/lib', async () => {
  const actual = await vi.importActual<typeof import('@evtivity/lib')>('@evtivity/lib');
  const child = {
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: mockLoggerError,
    debug: mockLoggerDebug,
  };
  return {
    ...actual,
    decryptString: mockDecryptString,
    createLogger: () => ({
      info: vi.fn(),
      warn: mockLoggerWarn,
      error: mockLoggerError,
      debug: mockLoggerDebug,
      child: () => child,
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

/** Find a recorded SQL call whose concatenated template matches a regex. */
function findSql(re: RegExp): { strings: string[]; values: unknown[] } | undefined {
  return sqlCalls.find((c) => re.test(c.strings.join(' ')));
}

describe('Event projections - coverage round 2', () => {
  let eventBus: ReturnType<typeof createMockEventBus>;
  let mockPubSub: PubSubClient;
  const timerCallbacks: Array<() => void> = [];

  // The first import loads the whole projection module graph, which under coverage on a busy
  // machine took longer than one test's 5 s timeout. Load it once here so setup() reads it
  // from the module cache.
  beforeAll(async () => {
    await import('../server/event-projections.js');
  }, 30_000);

  beforeEach(() => {
    vi.useFakeTimers();
    timerCallbacks.length = 0;
    vi.stubGlobal(
      'setInterval',
      vi.fn((fn: () => void) => {
        timerCallbacks.push(fn);
        return { id: timerCallbacks.length, unref: vi.fn(), ref: vi.fn() };
      }),
    );

    eventBus = createMockEventBus();
    sqlCalls.length = 0;
    sqlResults = [];
    sqlCallIndex = 0;
    sqlErrors = new Map();
    sqlCountOverrides = new Map();
    vi.clearAllMocks();
    mockIsRoamingEnabled.mockResolvedValue(false);
    mockIsAutoDisableOnCritical.mockResolvedValue(false);
    mockGetMeterValueInterval.mockResolvedValue(0);
    mockGetClockAlignedInterval.mockResolvedValue(0);
    mockGetSampledMeasurands.mockResolvedValue('');
    mockGetAlignedMeasurands.mockResolvedValue('');
    mockGetTxEndedMeasurands.mockResolvedValue('');
    mockIsSiteFreeVend.mockResolvedValue(false);
    mockIsSplitBilling.mockResolvedValue(false);
    mockDecryptString.mockReturnValue('sk_test_decrypted');
    mockAuthorizeSessionHold.mockResolvedValue({
      outcome: 'authorized',
      paymentRecordId: 1,
      paymentId: 'pi_test',
    });
    mockSettleSessionPayment.mockResolvedValue({ mode: 'none' });
    mockRecordTerminalSettlement.mockResolvedValue(true);
    process.env['SETTINGS_ENCRYPTION_KEY'] = 'test-encryption-key-32chars!!!!!';

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

  async function emit(type: string, aggregateId: string, payload: Record<string, unknown>) {
    await eventBus.emit(type, makeDomainEvent(type, aggregateId, payload));
  }

  // STA = a resolved charging_stations row for resolveStationUuid()
  const STA = [{ id: 'sta_0001' }];

  // ---- Infra: timers + safeSubscribe error handling ----

  describe('registration infrastructure', () => {
    it('registers periodic timers and they run without throwing', async () => {
      await setup();
      // setInterval registers cache sweeps (4 caches), queue cleanup, plus
      // reservation-expiry and offline-queue-cleanup timers.
      expect(timerCallbacks.length).toBeGreaterThan(0);
      // Fire every captured timer callback; none should throw.
      for (const cb of timerCallbacks) {
        expect(() => cb()).not.toThrow();
      }
    });

    it('safeSubscribe logs and swallows handler errors', async () => {
      await setup();
      // BatterySwap resolves the station then inserts; force the insert to throw.
      setupSqlResults(STA);
      sqlErrors.set(1, new Error('insert failed'));
      await emit('ocpp.BatterySwap', 'CS-1', { eventType: 'BatterySwapStarted' });
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'ocpp.BatterySwap' }),
        'Event projection failed',
      );
    });

    // A foreign key violation as postgres.js reports it.
    const fkViolation = (table: string) =>
      Object.assign(
        new Error(`insert or update on table "${table}" violates foreign key constraint`),
        { code: '23503', constraint_name: `${table}_station_id_fkey` },
      );

    it('logs a message log whose station was deleted meanwhile at debug, not error', async () => {
      await setup();
      // The INSERT ... WHERE EXISTS saw the station, then its FK check waited for
      // the DELETE and failed once it committed. The station lookup finds nothing.
      setupSqlResults([], []);
      sqlErrors.set(0, fkViolation('ocpp_message_logs'));

      await emit('ocpp.MessageLog', 'CS-GONE', {
        stationId: 'CS-GONE',
        stationDbId: 'sta_gone',
        direction: 'inbound',
        messageType: 2,
        messageId: 'm-1',
        action: 'Heartbeat',
        payload: {},
      });

      expect(sqlCalls).toHaveLength(2);
      expect(sqlCalls[1]?.strings.join('?')).toContain(
        'SELECT 1 FROM charging_stations WHERE station_id =',
      );
      expect(sqlCalls[1]?.values).toEqual(['CS-GONE']);
      expect(mockLoggerError).not.toHaveBeenCalledWith(
        expect.anything(),
        'Event projection failed',
      );
      expect(mockLoggerDebug).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'ocpp.MessageLog',
          stationId: 'CS-GONE',
          errorCode: '23503',
          constraint: 'ocpp_message_logs_station_id_fkey',
        }),
        'Event projection skipped: the station no longer exists',
      );
    });

    it('forgets the cached id of a deleted station', async () => {
      await setup();
      // BatterySwap resolves (and caches) the station, then its INSERT fails.
      setupSqlResults(STA, [], []);
      sqlErrors.set(1, fkViolation('battery_swap_events'));
      await emit('ocpp.BatterySwap', 'CS-1', { eventType: 'BatterySwapStarted' });
      expect(mockLoggerError).not.toHaveBeenCalled();

      // The next event looks the station up again instead of using the cache.
      sqlErrors = new Map();
      setupSqlResults([]);
      await emit('ocpp.BatterySwap', 'CS-1', { eventType: 'BatterySwapEnded' });
      expect(sqlCalls[0]?.strings.join('?')).toContain(
        'SELECT id FROM charging_stations WHERE station_id =',
      );
      expect(sqlCalls).toHaveLength(1);
    });

    it('still logs a foreign key violation at error when the station exists', async () => {
      await setup();
      setupSqlResults(STA, [], [{ '?column?': 1 }]);
      sqlErrors.set(1, fkViolation('battery_swap_events'));

      await emit('ocpp.BatterySwap', 'CS-1', { eventType: 'BatterySwapStarted' });

      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'ocpp.BatterySwap', errorCode: '23503' }),
        'Event projection failed',
      );
      expect(mockLoggerDebug).not.toHaveBeenCalledWith(
        expect.anything(),
        'Event projection skipped: the station no longer exists',
      );
    });

    it('logs the foreign key violation at error when the station lookup fails', async () => {
      await setup();
      setupSqlResults(STA);
      sqlErrors.set(1, fkViolation('battery_swap_events'));
      sqlErrors.set(2, new Error('lookup failed'));

      await emit('ocpp.BatterySwap', 'CS-1', { eventType: 'BatterySwapStarted' });

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ stationId: 'CS-1' }),
        'Station lookup after a failed projection failed',
      );
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'ocpp.BatterySwap', errorCode: '23503' }),
        'Event projection failed',
      );
    });

    it('never treats another error as a deleted station', async () => {
      await setup();
      setupSqlResults(STA, [], []);
      sqlErrors.set(1, Object.assign(new Error('not null violation'), { code: '23502' }));

      await emit('ocpp.BatterySwap', 'CS-1', { eventType: 'BatterySwapStarted' });

      // No station lookup ran: only the resolve and the failed INSERT.
      expect(sqlCalls).toHaveLength(2);
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: '23502' }),
        'Event projection failed',
      );
    });

    it('logs each retry at warn and the given-up projection at error with its station', async () => {
      await setup();
      // Heartbeat with stationDbId: its UPDATE is the first statement of every attempt.
      const timeout = () =>
        Object.assign(new Error('write CONNECT_TIMEOUT localhost:5433'), {
          code: 'CONNECT_TIMEOUT',
        });
      for (const idx of [0, 1, 2]) sqlErrors.set(idx, timeout());

      const done = emit('ocpp.Heartbeat', 'CS-1', { stationDbId: 'sta_0001' });
      await vi.advanceTimersByTimeAsync(10_000);
      await done;

      const retries = mockLoggerWarn.mock.calls.filter(
        (c: unknown[]) => c[1] === 'Event projection lost its database connection; retrying',
      );
      expect(retries).toHaveLength(2);
      expect(retries[0]?.[0]).toMatchObject({
        eventType: 'ocpp.Heartbeat',
        stationId: 'CS-1',
        attempt: 1,
        errorCode: 'CONNECT_TIMEOUT',
      });
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'ocpp.Heartbeat',
          stationId: 'CS-1',
          attempts: 3,
          errorCode: 'CONNECT_TIMEOUT',
        }),
        'Event projection failed',
      );
    });

    it('sweeps expired cache + stale queue entries and re-resolves after lazy delete', async () => {
      await setup();
      // Seed the station-id cache and the per-station queue via one event.
      setupSqlResults(STA, []);
      await emit('ocpp.BatterySwap', 'CS-1', { eventType: 'X' });
      sqlCalls.length = 0;

      // Advance past both the 5-minute cache TTL and the 10-minute queue stale
      // threshold so the periodic sweeps actually delete entries.
      vi.advanceTimersByTime(11 * 60 * 1000);
      for (const cb of timerCallbacks) cb();

      // After the cache was swept, the next event must re-resolve the station
      // from the DB (cache miss), proving the entry was evicted.
      setupSqlResults(STA, []);
      await emit('ocpp.BatterySwap', 'CS-1', { eventType: 'Y' });
      expect(findSql(/FROM charging_stations WHERE station_id/)).toBeDefined();
    });
  });

  // ---- Tail handlers: station-not-found early return ----

  describe('unresolvable station early-return branches', () => {
    const handlers: Array<[string, Record<string, unknown>]> = [
      ['ocpp.NotifyEvent', { eventData: [] }],
      ['ocpp.NotifyMonitoringReport', { requestId: 1 }],
      ['ocpp.ReportChargingProfiles', {}],
      ['ocpp.NotifyReport', { reportData: [] }],
      ['ocpp.NotifyCustomerInformation', { requestId: 1 }],
      ['ocpp.LogStatusNotification', { status: 'Idle' }],
      ['ocpp.DiagnosticsStatus', { status: 'Idle' }],
      ['command.SetChargingProfile', { response: { status: 'Accepted' }, request: {} }],
      ['command.GetVariables', { response: {} }],
      ['command.GetConfiguration', { response: {} }],
      ['command.UpdateFirmware', { request: {} }],
      ['command.GetLog', { request: {} }],
      ['command.GetDiagnostics', { request: {} }],
      ['ocpp.NotifyEVChargingNeeds', { evseId: 1, chargingNeeds: {} }],
      ['ocpp.NotifyEVChargingSchedule', {}],
      ['ocpp.BatterySwap', {}],
      ['ocpp.NotifyPeriodicEventStream', {}],
      ['ocpp.VatNumberValidation', {}],
      ['ocpp.NotifyAllowedEnergyTransfer', {}],
      ['ocpp.NotifyDERAlarm', {}],
      ['ocpp.NotifyDERStartStop', {}],
      ['ocpp.ReportDERControl', {}],
      ['ocpp.SecurityEventNotification', { type: 'X' }],
      ['ocpp.NotifyDisplayMessages', { messageInfo: [] }],
    ];

    for (const [type, payload] of handlers) {
      it(`${type} stops after resolveStationUuid returns null`, async () => {
        await setup();
        setupSqlResults([]); // resolveStationUuid -> no row
        await emit(type, 'CS-UNKNOWN', payload);
        // Only the resolveStationUuid lookup ran, nothing else.
        expect(sqlCalls.length).toBe(1);
        expect(findSql(/FROM charging_stations WHERE station_id/)).toBeDefined();
      });
    }
  });

  // ---- ocpp.BootNotification ----

  describe('ocpp.BootNotification', () => {
    it('returns when station unresolvable', async () => {
      await setup();
      setupSqlResults([]);
      await emit('ocpp.BootNotification', 'CS-X', {});
      expect(sqlCalls.length).toBe(1);
    });

    it('accepted station: leaves availability alone and pushes 2.1 SetVariables config', async () => {
      mockGetMeterValueInterval.mockResolvedValue(60);
      mockGetClockAlignedInterval.mockResolvedValue(900);
      mockGetSampledMeasurands.mockResolvedValue('Energy.Active.Import.Register,Temperature');
      mockGetAlignedMeasurands.mockResolvedValue('Voltage');
      mockGetTxEndedMeasurands.mockResolvedValue('Energy.Active.Import.Register');
      await setup();
      setupSqlResults(
        STA, // resolveStationUuid
        [{ onboarding_status: 'accepted' }], // SELECT onboarding_status
        [], // UPDATE charging_stations (accepted)
        [], // reset the status report timestamps (new ordering epoch)
        [], // UPDATE firmware_state (a reboot ends an install)
        [], // SELECT charging_stations FOR UPDATE (availability lock)
        [], // availability recompute (unchanged)
        [{ site_id: null }], // resolveSiteId
        [{ ocpp_protocol: 'ocpp2.1' }], // SELECT protocol (config push)
        [{ ocpp_protocol: 'ocpp2.1' }], // SELECT protocol (station message refresh)
      );
      await emit('ocpp.BootNotification', 'CS-1', {
        firmwareVersion: '1.0',
        model: 'M',
        vendorName: 'Acme',
      });
      // Boot never sets availability directly: it only recomputes it from its
      // inputs, so a disable or fault survives a reboot.
      expect(findSql(/availability = 'available'/)).toBeUndefined();
      expect(findSql(/SET availability = .*IS DISTINCT FROM/s)).toBeDefined();
      // A reboot starts a new status ordering epoch for the station and its connectors.
      const epoch = findSql(/SET status_reported_at = NULL/);
      expect(epoch?.strings.join('')).toContain('SET reported_status_at = NULL');
      // A reboot ends an install, so only an 'installing' state is cleared.
      expect(findSql(/SET firmware_state = NULL.*firmware_state = 'installing'/s)).toBeDefined();
      const cmds = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'ocpp_commands',
      );
      // TxUpdatedInterval, TxUpdatedMeasurands, TxEndedMeasurands, Aligned Interval, Aligned Measurands
      expect(cmds.length).toBe(5);
      // Temperature filtered out of 2.1 measurands
      const txMeas = cmds.find((c) => (c[1] as string).includes('TxUpdatedMeasurands'));
      expect(txMeas?.[1]).not.toContain('Temperature');
      // station_message_refresh published for 2.1
      const refresh = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'station_message_refresh',
      );
      expect(refresh.length).toBe(1);
    });

    it('pending station: updates hardware only, no availability change', async () => {
      await setup();
      setupSqlResults(
        STA,
        [{ onboarding_status: 'pending' }],
        [], // UPDATE (pending branch)
        [{ site_id: null }], // resolveSiteId
        [{ ocpp_protocol: 'ocpp1.6' }], // config push protocol
        [{ ocpp_protocol: 'ocpp1.6' }], // station message refresh check (1.6 -> no publish)
      );
      await emit('ocpp.BootNotification', 'CS-1', { model: 'M' });
      // The pending UPDATE does not include availability assignment
      const upd = findSql(/UPDATE charging_stations/);
      expect(upd?.strings.join(' ')).not.toContain("availability = 'available'");
    });

    it('1.6 station: pushes ChangeConfiguration commands', async () => {
      mockGetMeterValueInterval.mockResolvedValue(30);
      mockGetClockAlignedInterval.mockResolvedValue(600);
      mockGetSampledMeasurands.mockResolvedValue('Energy.Active.Import.Register');
      mockGetAlignedMeasurands.mockResolvedValue('Voltage');
      mockGetTxEndedMeasurands.mockResolvedValue('Energy.Active.Import.Register');
      await setup();
      setupSqlResults(
        STA,
        [{ onboarding_status: 'accepted' }],
        [],
        [], // reset the status report timestamps (new ordering epoch)
        [], // UPDATE firmware_state (a reboot ends an install)
        [], // SELECT charging_stations FOR UPDATE (availability lock)
        [], // availability recompute
        [{ site_id: null }],
        [{ ocpp_protocol: 'ocpp1.6' }], // config push
        [{ ocpp_protocol: 'ocpp1.6' }], // station message check
      );
      await emit('ocpp.BootNotification', 'CS-1', {});
      const cmds = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'ocpp_commands',
      );
      expect(cmds.length).toBe(5);
      expect(cmds.every((c) => (c[1] as string).includes('ChangeConfiguration'))).toBe(true);
    });

    it('re-pushes free-vend variables on boot for 2.1', async () => {
      mockIsSiteFreeVend.mockResolvedValue(true);
      await setup();
      setupSqlResults(
        STA,
        [{ onboarding_status: 'accepted' }],
        [],
        [], // reset the status report timestamps (new ordering epoch)
        [], // UPDATE firmware_state (a reboot ends an install)
        [], // SELECT charging_stations FOR UPDATE (availability lock)
        [], // availability recompute
        [{ site_id: null }],
        [{ ocpp_protocol: 'ocpp2.1' }],
        [{ ocpp_protocol: 'ocpp2.1' }],
      );
      await emit('ocpp.BootNotification', 'CS-1', {});
      const cmds = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'ocpp_commands' && (c[1] as string).includes('SetVariables'),
      );
      expect(cmds.length).toBeGreaterThanOrEqual(1);
    });

    it('re-pushes free-vend keys on boot for 1.6', async () => {
      mockIsSiteFreeVend.mockResolvedValue(true);
      await setup();
      setupSqlResults(
        STA,
        [{ onboarding_status: 'accepted' }],
        [],
        [], // reset the status report timestamps (new ordering epoch)
        [], // UPDATE firmware_state (a reboot ends an install)
        [], // SELECT charging_stations FOR UPDATE (availability lock)
        [], // availability recompute
        [{ site_id: null }],
        [{ ocpp_protocol: 'ocpp1.6' }],
        [{ ocpp_protocol: 'ocpp1.6' }],
      );
      await emit('ocpp.BootNotification', 'CS-1', {});
      const cmds = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'ocpp_commands' && (c[1] as string).includes('ChangeConfiguration'),
      );
      expect(cmds.length).toBeGreaterThanOrEqual(1);
    });

    it('config-push errors are swallowed (fail-open warn)', async () => {
      mockGetMeterValueInterval.mockRejectedValueOnce(new Error('settings down'));
      await setup();
      setupSqlResults(
        STA,
        [{ onboarding_status: 'accepted' }],
        [],
        [], // reset the status report timestamps (new ordering epoch)
        [], // UPDATE firmware_state (a reboot ends an install)
        [], // SELECT charging_stations FOR UPDATE (availability lock)
        [], // availability recompute
        [{ site_id: null }],
        [{ ocpp_protocol: 'ocpp2.1' }], // station message refresh check
      );
      await emit('ocpp.BootNotification', 'CS-1', {});
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ stationId: 'CS-1' }),
        'Failed to push OCPP configuration on boot',
      );
    });
  });

  // ---- ocpp.NotifyMonitoringReport ----

  describe('ocpp.NotifyMonitoringReport', () => {
    it('inserts a monitoring_reports row with monitor JSONB', async () => {
      await setup();
      setupSqlResults(STA, []);
      await emit('ocpp.NotifyMonitoringReport', 'CS-1', {
        requestId: 42,
        seqNo: 3,
        generatedAt: '2026-01-01T00:00:00Z',
        tbc: true,
        monitor: [{ id: 1 }],
      });
      const ins = findSql(/INSERT INTO monitoring_reports/);
      expect(ins).toBeDefined();
      expect(ins?.values).toEqual(['sta_0001', 42, 3, '2026-01-01T00:00:00Z', true, [{ id: 1 }]]);
    });

    it('passes null monitor when monitor is absent', async () => {
      await setup();
      setupSqlResults(STA, []);
      await emit('ocpp.NotifyMonitoringReport', 'CS-1', { requestId: 7, generatedAt: 't' });
      const ins = findSql(/INSERT INTO monitoring_reports/);
      expect(ins?.values).toEqual(['sta_0001', 7, 0, 't', false, null]);
    });
  });

  // ---- ocpp.ReportChargingProfiles ----

  describe('ocpp.ReportChargingProfiles', () => {
    it('deletes prior request rows and inserts station_reported profile', async () => {
      await setup();
      setupSqlResults(STA, [], []);
      await emit('ocpp.ReportChargingProfiles', 'CS-1', {
        evseId: 2,
        requestId: 9,
        chargingLimitSource: 'EMS',
        tbc: false,
        chargingProfile: [{ id: 5 }],
      });
      expect(findSql(/DELETE FROM charging_profiles/)).toBeDefined();
      const ins = findSql(/INSERT INTO charging_profiles .* 'station_reported'/s);
      expect(ins).toBeDefined();
      expect(ins?.values).toContain(2);
      expect(ins?.values).toContain(9);
      expect(ins?.values).toContain('EMS');
    });
  });

  // ---- ocpp.NotifyReport ----

  describe('ocpp.NotifyReport', () => {
    it('returns early when reportData is empty', async () => {
      await setup();
      setupSqlResults(STA);
      await emit('ocpp.NotifyReport', 'CS-1', { reportData: [] });
      expect(sqlCalls.length).toBe(1);
    });

    it('skips entries missing component / variable / variableAttribute', async () => {
      await setup();
      setupSqlResults(STA);
      await emit('ocpp.NotifyReport', 'CS-1', {
        reportData: [
          { variable: { name: 'X' } }, // no component
          { component: { name: 'C' } }, // no variable
          { component: { name: 'C' }, variable: { name: 'V' } }, // no variableAttribute
        ],
      });
      // resolveStationUuid only; no inserts
      expect(sqlCalls.length).toBe(1);
    });

    it('upserts a station_configuration and auto-fills connector type', async () => {
      await setup();
      setupSqlResults(STA, [], []);
      await emit('ocpp.NotifyReport', 'CS-1', {
        reportData: [
          {
            component: { name: 'Connector', evse: { id: 1, connectorId: 1 } },
            variable: { name: 'ConnectorType' },
            variableAttribute: [{ type: 'Actual', value: 'cCCS2' }],
          },
        ],
      });
      expect(findSql(/INSERT INTO station_configurations/)).toBeDefined();
      const upd = findSql(/UPDATE connectors\s+SET connector_type/);
      expect(upd).toBeDefined();
      expect(upd?.values).toContain('CCS2');
    });

    it('stores non-primitive attribute value as null', async () => {
      await setup();
      setupSqlResults(STA, []);
      await emit('ocpp.NotifyReport', 'CS-1', {
        reportData: [
          {
            component: { name: 'Foo' },
            variable: { name: 'Bar' },
            variableAttribute: [{ value: { nested: true } }],
          },
        ],
      });
      const ins = findSql(/INSERT INTO station_configurations/);
      expect(ins?.values).toContain(null);
    });

    it('keeps variable instances apart (ItemsPerMessage[GetReport] vs [GetVariables])', async () => {
      await setup();
      setupSqlResults(STA, [], []);
      await emit('ocpp.NotifyReport', 'CS-1', {
        reportData: [
          {
            component: { name: 'DeviceDataCtrlr' },
            variable: { name: 'ItemsPerMessage', instance: 'GetReport' },
            variableAttribute: [{ type: 'Actual', value: '10' }],
          },
          {
            component: { name: 'DeviceDataCtrlr' },
            variable: { name: 'ItemsPerMessage', instance: 'GetVariables' },
            variableAttribute: [{ type: 'Actual', value: '4' }],
          },
        ],
      });
      const inserts = sqlCalls.filter((c) =>
        /INSERT INTO station_configurations/.test(c.strings.join(' ')),
      );
      expect(inserts).toHaveLength(2);
      for (const ins of inserts) {
        const text = ins.strings.join(' ');
        expect(text).toContain("(COALESCE(instance, ''))");
        expect(text).toContain("(COALESCE(variable_instance, ''))");
      }
      expect(inserts[0]?.values).toEqual(expect.arrayContaining(['GetReport', '10']));
      expect(inserts[1]?.values).toEqual(expect.arrayContaining(['GetVariables', '4']));
    });
  });

  // ---- ocpp.NotifyCustomerInformation ----

  describe('ocpp.NotifyCustomerInformation', () => {
    it('inserts a customer_information_reports row', async () => {
      await setup();
      setupSqlResults(STA, []);
      await emit('ocpp.NotifyCustomerInformation', 'CS-1', {
        requestId: 3,
        seqNo: 1,
        generatedAt: 'when',
        tbc: true,
        data: 'blob',
      });
      const ins = findSql(/INSERT INTO customer_information_reports/);
      expect(ins?.values).toEqual(['sta_0001', 3, 1, 'when', true, 'blob']);
    });
  });

  // ---- ocpp.LogStatusNotification ----

  describe('ocpp.LogStatusNotification', () => {
    it('updates an existing log_uploads row when requestId matches', async () => {
      await setup();
      setupSqlResults(STA, [{}]); // UPDATE count=1
      await emit('ocpp.LogStatusNotification', 'CS-1', {
        status: 'Uploading',
        requestId: 11,
        statusInfo: { reasonCode: 'x' },
      });
      expect(findSql(/UPDATE log_uploads/)).toBeDefined();
      expect(findSql(/INSERT INTO log_uploads/)).toBeUndefined();
    });

    it('inserts when requestId present but no row updated', async () => {
      await setup();
      setupSqlResults(STA, EMPTY); // UPDATE count=0
      await emit('ocpp.LogStatusNotification', 'CS-1', { status: 'Uploaded', requestId: 12 });
      expect(findSql(/INSERT INTO log_uploads/)).toBeDefined();
    });

    it('inserts a fresh row when requestId is absent', async () => {
      await setup();
      setupSqlResults(STA, []);
      await emit('ocpp.LogStatusNotification', 'CS-1', { status: 'BadMessage' });
      const ins = findSql(/INSERT INTO log_uploads/);
      expect(ins).toBeDefined();
      expect(ins?.values).toContain('BadMessage');
    });
  });

  // ---- ocpp.DiagnosticsStatus (1.6) ----

  describe('ocpp.DiagnosticsStatus', () => {
    it('updates the most recent log_uploads row', async () => {
      await setup();
      setupSqlResults(STA, [{}]); // UPDATE count=1
      await emit('ocpp.DiagnosticsStatus', 'CS-1', { status: 'Uploaded' });
      expect(findSql(/UPDATE log_uploads/)).toBeDefined();
      expect(findSql(/INSERT INTO log_uploads/)).toBeUndefined();
    });

    it('inserts a DiagnosticsLog row when no prior upload exists, mapping unknown status', async () => {
      await setup();
      setupSqlResults(STA, EMPTY);
      await emit('ocpp.DiagnosticsStatus', 'CS-1', { status: 'WeirdStatus' });
      const ins = findSql(/INSERT INTO log_uploads/);
      expect(ins).toBeDefined();
      expect(ins?.values).toContain('WeirdStatus');
    });
  });

  // ---- command.SetChargingProfile ----

  describe('command.SetChargingProfile', () => {
    it('does nothing when station did not Accept', async () => {
      await setup();
      setupSqlResults(STA);
      await emit('command.SetChargingProfile', 'CS-1', {
        response: { status: 'Rejected' },
        request: {},
      });
      expect(sqlCalls.length).toBe(1);
    });

    it('deletes prior csms_set profile by id and inserts new', async () => {
      await setup();
      setupSqlResults(STA, [], []);
      await emit('command.SetChargingProfile', 'CS-1', {
        response: { status: 'Accepted' },
        request: { evseId: 1, csChargingProfiles: { id: 77 } },
      });
      const del = findSql(/DELETE FROM charging_profiles/);
      expect(del).toBeDefined();
      expect(del?.values).toContain(77);
      expect(findSql(/INSERT INTO charging_profiles .* 'csms_set'/s)).toBeDefined();
    });

    it('inserts without delete when profile id is absent', async () => {
      await setup();
      setupSqlResults(STA, []);
      await emit('command.SetChargingProfile', 'CS-1', {
        response: { status: 'Accepted' },
        request: { chargingProfile: {} },
      });
      expect(findSql(/DELETE FROM charging_profiles/)).toBeUndefined();
      expect(findSql(/INSERT INTO charging_profiles/)).toBeDefined();
    });
  });

  // ---- command.GetVariables ----

  describe('command.GetVariables', () => {
    it('returns when getVariableResult missing', async () => {
      await setup();
      setupSqlResults(STA);
      await emit('command.GetVariables', 'CS-1', { response: {} });
      expect(sqlCalls.length).toBe(1);
    });

    it('skips non-Accepted and missing component/variable, upserts accepted', async () => {
      await setup();
      setupSqlResults(STA, []);
      await emit('command.GetVariables', 'CS-1', {
        response: {
          getVariableResult: [
            { attributeStatus: 'Rejected' },
            { attributeStatus: 'Accepted' }, // missing component
            { attributeStatus: 'Accepted', component: { name: 'C' } }, // missing variable
            {
              attributeStatus: 'Accepted',
              component: { name: 'C', evse: { id: 1, connectorId: 2 } },
              variable: { name: 'V' },
              attributeType: 'Actual',
              attributeValue: 5,
            },
          ],
        },
      });
      const ins = findSql(/INSERT INTO station_configurations/);
      expect(ins).toBeDefined();
      expect(ins?.values).toContain('GetVariables');
      expect(ins?.values).toContain('5');
    });
  });

  // ---- command.GetConfiguration ----

  describe('command.GetConfiguration', () => {
    it('returns when configurationKey missing', async () => {
      await setup();
      setupSqlResults(STA);
      await emit('command.GetConfiguration', 'CS-1', { response: {} });
      expect(sqlCalls.length).toBe(1);
    });

    it('skips empty keys and upserts populated ones', async () => {
      await setup();
      setupSqlResults(STA, []);
      await emit('command.GetConfiguration', 'CS-1', {
        response: {
          configurationKey: [
            { key: '', value: 'x' },
            { key: 'HeartbeatInterval', value: 300 },
          ],
        },
      });
      const ins = findSql(/INSERT INTO station_configurations/);
      expect(ins).toBeDefined();
      expect(ins?.values).toContain('GetConfiguration');
      expect(ins?.values).toContain('HeartbeatInterval');
      expect(ins?.values).toContain('300');
    });
  });

  // ---- command.UpdateFirmware ----

  describe('command.UpdateFirmware', () => {
    it('upserts with 2.1 firmware.location when requestId present', async () => {
      await setup();
      setupSqlResults(STA, []);
      await emit('command.UpdateFirmware', 'CS-1', {
        request: {
          requestId: 5,
          firmware: { location: 'https://fw', retrieveDateTime: '2026-01-01T00:00:00Z' },
        },
      });
      const ins = findSql(/INSERT INTO firmware_updates/);
      expect(ins).toBeDefined();
      expect(ins?.values).toContain('https://fw');
      expect(ins?.strings.join(' ')).toMatch(/ON CONFLICT/);
    });

    it('uses 1.6 location and inserts without conflict clause when requestId null', async () => {
      await setup();
      setupSqlResults(STA, []);
      await emit('command.UpdateFirmware', 'CS-1', {
        request: { location: 'ftp://fw', retrieveDate: '2026-02-02T00:00:00Z' },
      });
      const ins = findSql(/INSERT INTO firmware_updates/);
      expect(ins).toBeDefined();
      expect(ins?.values).toContain('ftp://fw');
      expect(ins?.strings.join(' ')).not.toMatch(/ON CONFLICT/);
    });
  });

  // ---- command.GetLog / command.GetDiagnostics ----

  describe('command.GetLog and GetDiagnostics', () => {
    it('GetLog inserts a log_uploads row with remoteLocation', async () => {
      await setup();
      setupSqlResults(STA, []);
      await emit('command.GetLog', 'CS-1', {
        request: { requestId: 1, logType: 'DiagnosticsLog', log: { remoteLocation: 'https://x' } },
      });
      const ins = findSql(/INSERT INTO log_uploads/);
      expect(ins?.values).toContain('https://x');
    });

    it('GetDiagnostics inserts a DiagnosticsLog row', async () => {
      await setup();
      setupSqlResults(STA, []);
      await emit('command.GetDiagnostics', 'CS-1', { request: { location: 'ftp://d' } });
      const ins = findSql(/INSERT INTO log_uploads/);
      expect(ins?.values).toContain('ftp://d');
    });
  });

  // ---- command.ReserveNow ----

  describe('command.ReserveNow', () => {
    it('returns immediately when status is Accepted', async () => {
      await setup();
      setupSqlResults();
      await emit('command.ReserveNow', 'CS-1', {
        request: { id: 1 },
        response: { status: 'Accepted' },
      });
      expect(sqlCalls.length).toBe(0);
    });

    it('returns when reservation id cannot be derived', async () => {
      await setup();
      setupSqlResults();
      await emit('command.ReserveNow', 'CS-1', {
        request: {},
        response: { status: 'Rejected' },
      });
      expect(sqlCalls.length).toBe(0);
    });

    it('cancels reservation as occupied and notifies driver', async () => {
      await setup();
      setupSqlResults(STA, [{ driver_id: 'drv_1' }]);
      await emit('command.ReserveNow', 'CS-1', {
        request: { id: 88 },
        response: { status: 'Occupied' },
      });
      const upd = findSql(/UPDATE reservations\s+SET status = 'cancelled'/);
      expect(upd).toBeDefined();
      expect(upd?.values).toContain('station_rejected_occupied');
      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'reservation.Cancelled',
        'drv_1',
        expect.objectContaining({ reservationId: 88 }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('uses reservationId fallback and skips notify when no driver', async () => {
      await setup();
      setupSqlResults(STA, [{ driver_id: null }]);
      await emit('command.ReserveNow', 'CS-1', {
        request: { reservationId: 99 },
        response: { status: 'Faulted' },
      });
      const upd = findSql(/UPDATE reservations\s+SET status = 'cancelled'/);
      expect(upd?.values).toContain('station_rejected_other');
      expect(mockDispatchDriver).not.toHaveBeenCalled();
    });

    it('swallows driver notification failure (fail-open)', async () => {
      await setup();
      mockDispatchDriver.mockRejectedValueOnce(new Error('smtp down'));
      setupSqlResults(STA, [{ driver_id: 'drv_2' }]);
      await emit('command.ReserveNow', 'CS-1', {
        request: { id: 5 },
        response: { status: 'Unavailable' },
      });
      expect(mockLoggerWarn).toHaveBeenCalled();
    });

    it('returns when station unresolvable but id present', async () => {
      await setup();
      setupSqlResults([]); // resolveStationUuid null
      await emit('command.ReserveNow', 'CS-1', {
        request: { id: 5 },
        response: { status: 'Rejected' },
      });
      expect(findSql(/UPDATE reservations/)).toBeUndefined();
    });
  });

  // ---- ocpp.NotifyEVChargingNeeds / Schedule ----

  describe('ocpp.NotifyEVChargingNeeds', () => {
    it('upserts charging needs, notifies, and computes profile', async () => {
      await setup();
      setupSqlResults(STA, [], [{ site_id: 'site-1' }], []);
      await emit('ocpp.NotifyEVChargingNeeds', 'CS-1', {
        evseId: 2,
        maxScheduleTuples: 4,
        chargingNeeds: {
          departureTime: 'dt',
          requestedEnergyTransfer: 'AC',
          controlMode: 'ScheduledControl',
        },
      });
      expect(findSql(/INSERT INTO ev_charging_needs/)).toBeDefined();
      expect(mockPubSub.publish).toHaveBeenCalledWith('csms_events', expect.any(String));
      expect(mockComputeAndSendChargingProfile).toHaveBeenCalled();
    });

    it('logs error when profile computation throws', async () => {
      await setup();
      mockComputeAndSendChargingProfile.mockRejectedValueOnce(new Error('boom'));
      setupSqlResults(STA, [], [{ site_id: null }]);
      await emit('ocpp.NotifyEVChargingNeeds', 'CS-1', { evseId: 1, chargingNeeds: {} });
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'ISO 15118 profile computation failed',
      );
    });
  });

  describe('ocpp.NotifyEVChargingSchedule', () => {
    it('inserts an ev_charging_schedules row', async () => {
      await setup();
      setupSqlResults(STA, []);
      await emit('ocpp.NotifyEVChargingSchedule', 'CS-1', {
        evseId: 3,
        timeBase: 'tb',
        chargingSchedule: { periods: [] },
      });
      const ins = findSql(/INSERT INTO ev_charging_schedules/);
      expect(ins?.values).toContain(3);
      expect(ins?.values).toContain('tb');
    });
  });

  // ---- command.Queued (offline queue) ----

  describe('command.Queued', () => {
    it('inserts an offline_command_queue row with TTL', async () => {
      await setup();
      setupSqlResults([]);
      await emit('command.Queued', 'CS-1', {
        commandId: 'cmd-1',
        stationId: 'CS-1',
        action: 'Reset',
        payload: { type: 'Hard' },
        version: 'ocpp2.1',
      });
      const ins = findSql(/INSERT INTO offline_command_queue/);
      expect(ins).toBeDefined();
      expect(ins?.values).toContain('cmd-1');
      expect(ins?.values).toContain('Reset');
      expect(ins?.values).toContain('24 hours');
      // Only for a station that still exists (FK to charging_stations.station_id).
      expect(ins?.strings.join('?')).toMatch(
        /WHERE EXISTS \(SELECT 1 FROM charging_stations WHERE station_id = \?\)/,
      );
    });
  });

  // ---- ocpp.NotifyPeriodicEventStream ----

  describe('OCPP 2.1 stub persistence', () => {
    it('NotifyPeriodicEventStream inserts a row', async () => {
      await setup();
      setupSqlResults(STA, []);
      await emit('ocpp.NotifyPeriodicEventStream', 'CS-1', { id: 7, data: [{ v: 1 }] });
      const ins = findSql(/INSERT INTO periodic_event_streams/);
      expect(ins?.values).toContain(7);
    });
  });

  // ---- ocpp.StatusNotification ----

  describe('ocpp.StatusNotification', () => {
    it('returns when station unresolvable', async () => {
      await setup();
      setupSqlResults([]);
      await emit('ocpp.StatusNotification', 'CS-X', {
        evseId: 1,
        connectorId: 1,
        connectorStatus: 'Available',
      });
      expect(sqlCalls.length).toBe(1);
    });

    it('auto-creates EVSE + connector when EVSE missing', async () => {
      await setup();
      setupSqlResults(
        STA, // resolveStationUuid
        [], // SELECT evses -> none
        [{ id: 'evs_new' }], // INSERT evses RETURNING
        [{ id: 'con_new' }], // INSERT connectors RETURNING
        [], // INSERT port_status_log
        [{ site_id: null }], // resolveSiteId
        [{ ocpp_protocol: 'ocpp1.6' }], // didAutoCreate GetBaseReport check (1.6, no publish)
      );
      await emit('ocpp.StatusNotification', 'CS-1', {
        evseId: 2,
        connectorId: 1,
        connectorStatus: 'Available',
      });
      expect(findSql(/INSERT INTO evses/)).toBeDefined();
      expect(findSql(/INSERT INTO connectors/)).toBeDefined();
      expect(findSql(/INSERT INTO port_status_log/)).toBeDefined();
      // 1.6 station -> no GetBaseReport command
      const cmds = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'ocpp_commands',
      );
      expect(cmds.length).toBe(0);
    });

    it('auto-create publishes GetBaseReport for OCPP 2.1 station', async () => {
      await setup();
      setupSqlResults(
        STA,
        [], // SELECT evses
        [{ id: 'evs_new' }], // INSERT evses
        [{ id: 'con_new' }], // INSERT connectors RETURNING
        [], // INSERT port_status_log
        [], // SELECT charging_stations FOR UPDATE (availability lock)
        [], // availability recompute (unchanged)
        [{ site_id: null }], // resolveSiteId
        [{ ocpp_protocol: 'ocpp2.1' }], // GetBaseReport branch
        [{ ocpp_protocol: 'ocpp2.1' }], // station_message_refresh branch
      );
      await emit('ocpp.StatusNotification', 'CS-1', {
        evseId: 3,
        connectorId: 1,
        connectorStatus: 'Available',
      });
      const cmds = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'ocpp_commands',
      );
      expect(cmds.length).toBe(1);
      expect(cmds[0]?.[1]).toContain('GetBaseReport');
    });

    it('returns when auto-create EVSE insert hits stale station (WHERE EXISTS 0)', async () => {
      await setup();
      setupSqlResults(
        STA,
        [], // SELECT evses none
        EMPTY, // INSERT evses RETURNING -> length 0
      );
      await emit('ocpp.StatusNotification', 'CS-1', {
        evseId: 4,
        connectorId: 1,
        connectorStatus: 'Available',
      });
      expect(findSql(/INSERT INTO connectors/)).toBeUndefined();
    });

    it('updates existing connector and skips port log on no-op transition', async () => {
      await setup();
      setupSqlResults(
        STA,
        [{ id: 'evs_1' }], // SELECT evses
        [{ previous_status: 'available', applied: true }], // guarded UPDATE connectors (same status)
        [{ site_id: null }], // resolveSiteId
      );
      await emit('ocpp.StatusNotification', 'CS-1', {
        evseId: 1,
        connectorId: 1,
        connectorStatus: 'Available',
      });
      // No status change -> no port_status_log insert
      expect(findSql(/INSERT INTO port_status_log/)).toBeUndefined();
      expect(findSql(/UPDATE connectors c\s+SET status/)).toBeDefined();
    });

    it('logs transition and auto-creates connector when connector row missing', async () => {
      await setup();
      setupSqlResults(
        STA,
        [{ id: 'evs_1' }], // SELECT evses
        [], // guarded UPDATE connectors -> no row (length 0)
        [{ id: 'con_2' }], // INSERT connectors RETURNING
        [], // INSERT port_status_log (status changed: undefined -> faulted)
        [{ site_id: null }], // resolveSiteId
        [{ ocpp_protocol: 'ocpp1.6' }], // GetBaseReport check (1.6)
      );
      await emit('ocpp.StatusNotification', 'CS-1', {
        evseId: 1,
        connectorId: 2,
        connectorStatus: 'Faulted',
      });
      expect(findSql(/INSERT INTO port_status_log/)).toBeDefined();
      expect(findSql(/INSERT INTO connectors/)).toBeDefined();
    });

    it('pushes OCPI location when siteId present and roaming enabled', async () => {
      mockIsRoamingEnabled.mockResolvedValue(true);
      await setup();
      setupSqlResults(
        STA,
        [{ id: 'evs_1' }],
        [{ previous_status: 'occupied', applied: true }], // guarded UPDATE connectors
        [], // SELECT charging_stations FOR UPDATE (availability lock)
        [], // UPDATE charging_stations (connector fault reconciliation)
        [{ site_id: 'site-9' }], // resolveSiteId
      );
      await emit('ocpp.StatusNotification', 'CS-1', {
        evseId: 1,
        connectorId: 1,
        connectorStatus: 'Occupied',
      });
      const ocpi = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'ocpi_push',
      );
      expect(ocpi.length).toBe(1);
    });

    it('1.6 idle detection: SuspendedEV sets idle_started_at and sends no notice at the period start', async () => {
      await setup();
      setupSqlResults(
        STA,
        [{ id: 'evs_1' }],
        [{ previous_status: 'charging', applied: true }], // guarded UPDATE connectors
        [], // INSERT port_status_log (charging -> suspended_ev)
        [], // SELECT charging_stations FOR UPDATE (availability lock)
        [], // UPDATE charging_stations (connector fault reconciliation)
        [{ site_id: null }], // resolveSiteId
        [], // SELECT the active session with an open idle period (JB-2): none yet
        [], // UPDATE charging_sessions set idle_started_at
      );
      await emit('ocpp.StatusNotification', 'CS-1', {
        evseId: 1,
        connectorId: 1,
        connectorStatus: 'SuspendedEV',
        timestamp: '2026-01-01T00:00:00Z',
      });
      expect(findSql(/UPDATE charging_sessions\s+SET idle_started_at/)).toBeDefined();
      // Owner rule (JB-2): the notice waits until the period lasted 60 s.
      expect(findSql(/WITH claimed AS/)).toBeUndefined();
      expect(mockDispatchDriver).not.toHaveBeenCalled();
    });

    it('1.6 idle detection: a later status notifies from the due claim before it ends the period', async () => {
      await setup();
      setupSqlResults(
        STA,
        [{ id: 'evs_1' }],
        [{ previous_status: 'suspended_ev', applied: true }], // guarded UPDATE connectors
        [], // INSERT port_status_log (suspended_ev -> charging)
        [], // SELECT charging_stations FOR UPDATE (availability lock)
        [], // UPDATE charging_stations (connector fault reconciliation)
        [{ site_id: null }], // resolveSiteId
        [{ id: 'ses_1', transaction_id: 'tx_1' }], // SELECT the active session with an open idle period
        // dispatchDueIdlingNotification: the claim (period open for 60 s or more)
        [
          {
            driver_id: 'drv_1',
            idle_started_at: '2026-01-01T00:00:00Z',
            idle_fee_price_per_minute: '0.05',
            currency: 'USD',
            site_name: 'Site A',
          },
        ],
        [], // UPDATE charging_sessions: close the period
      );
      await emit('ocpp.StatusNotification', 'CS-1', {
        evseId: 1,
        connectorId: 1,
        connectorStatus: 'Charging',
        timestamp: '2026-01-01T00:02:00Z',
      });
      const claimIndex = sqlCalls.findIndex((c) => c.strings.join('?').includes('WITH claimed AS'));
      const closeIndex = sqlCalls.findIndex((c) =>
        c.strings.join('?').includes('SET idle_minutes = idle_minutes'),
      );
      expect(claimIndex).toBeGreaterThan(-1);
      expect(closeIndex).toBeGreaterThan(claimIndex);
      expect(sqlCalls[claimIndex]?.values).toContain('2026-01-01T00:02:00Z');
      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'session.IdlingStarted',
        'drv_1',
        expect.objectContaining({ transactionId: 'tx_1', stationId: 'CS-1' }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('1.6 resume: Charging clears idle_started_at and accrues idle_minutes', async () => {
      await setup();
      setupSqlResults(
        STA,
        [{ id: 'evs_1' }],
        [{ previous_status: 'suspended_ev', applied: true }], // guarded UPDATE connectors
        [], // INSERT port_status_log
        [{ site_id: null }], // resolveSiteId
        // station_message_refresh: Charging is not in STATION_MESSAGE_RELEVANT? It is not.
        [], // UPDATE charging_sessions resume
      );
      await emit('ocpp.StatusNotification', 'CS-1', {
        evseId: 1,
        connectorId: 1,
        connectorStatus: 'Charging',
        timestamp: '2026-01-01T00:10:00Z',
      });
      expect(findSql(/SET idle_minutes = idle_minutes/)).toBeDefined();
    });
  });

  // ---- ocpp.MeterValues cost loop + CostUpdated ----

  describe('ocpp.MeterValues', () => {
    it('returns when station unresolvable', async () => {
      await setup();
      setupSqlResults([]);
      await emit('ocpp.MeterValues', 'CS-X', { stationId: 'CS-X', meterValues: [] });
      expect(sqlCalls.length).toBe(1);
    });

    it('buffers transaction-scoped values when no session is found', async () => {
      await setup();
      setupSqlResults(
        STA, // resolveStationUuid
        [], // resolveMeterValueSession by transactionId -> none
        [], // allowCompleted -> none
        [], // by station active -> none
      );
      await emit('ocpp.MeterValues', 'CS-1', {
        stationId: 'CS-1',
        evseId: 0,
        transactionId: 'tx-buf',
        source: 'TransactionEvent',
        meterValues: [{ sampledValue: [{ value: 1 }] }],
      });
      // Buffered: no meter_values insert
      expect(findSql(/INSERT INTO meter_values/)).toBeUndefined();
    });

    it('returns when meterValues is absent', async () => {
      await setup();
      setupSqlResults(STA, [{ id: 'ses_1' }]);
      await emit('ocpp.MeterValues', 'CS-1', {
        stationId: 'CS-1',
        evseId: 0,
        transactionId: 'tx-1',
        source: 'TransactionEvent',
      });
      expect(findSql(/INSERT INTO meter_values/)).toBeUndefined();
    });

    it('inserts energy reading, updates cost, and dispatches CostUpdated (2.1)', async () => {
      mockGetMeterValueInterval.mockResolvedValue(60);
      await setup();
      setupSqlResults(
        STA, // 0 resolveStationUuid
        [{ id: 'ses_1' }], // 1 resolveMeterValueSession by transactionId
        [], // 2 INSERT meter_values (count 1, success)
        [{ energy_delivered_wh: 100, meter_start: '50' }], // 3 prev energy/meter_start
        [], // 4 UPDATE meter_start (no-op, already set)
        [], // 5 UPDATE energy_delivered_wh
        // existingMeterStart='50', prevEnergyWh=100 -> newEnergyWh=1000-50=950, |950-100|>=1 -> energy increased branch
        [], // 6 UPDATE idle accrue (energy increased)
        // active sessions cost loop:
        [
          {
            id: 'ses_1',
            transaction_id: 'tx-1',
            tariff_id: 'trf_1',
            driver_id: 'drv_1',
            started_at: new Date(Date.now() - 3_600_000).toISOString(),
            energy_delivered_wh: 950,
            current_cost_cents: 0,
            currency: 'USD',
            tariff_price_per_kwh: '0.25',
            tariff_price_per_minute: '0',
            tariff_price_per_session: '0',
            tariff_idle_fee_price_per_minute: '0',
            tariff_tax_rate: '0',
            idle_started_at: null,
            idle_minutes: 0,
            ocpp_protocol: 'ocpp2.1',
          },
        ], // 7 active sessions
        [{ site_id: null }], // 8 resolveSiteId
      );
      mockPriceSessionAt.mockResolvedValueOnce(costBreakdown(24));
      await emit('ocpp.MeterValues', 'CS-1', {
        stationId: 'CS-1',
        evseId: 0,
        transactionId: 'tx-1',
        source: 'TransactionEvent',
        meterValues: [
          {
            timestamp: '2026-01-01T01:00:00Z',
            sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: 1000 }],
          },
        ],
      });
      expect(findSql(/INSERT INTO meter_values/)).toBeDefined();
      expect(mockStoreRunningCost).toHaveBeenCalledWith(
        expect.anything(),
        'ses_1',
        expect.objectContaining({ grossCents: 24 }),
      );
      const cost = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'ocpp_commands' && (c[1] as string).includes('CostUpdated'),
      );
      expect(cost.length).toBe(1);
    });

    describe('prepaid credit (cost ceiling)', () => {
      const costSession = (
        ocppProtocol: string,
        costCeilingCents: number | null,
        currentCostCents = 0,
      ) => ({
        id: 'ses_1',
        transaction_id: '1001',
        tariff_id: 'trf_1',
        driver_id: 'drv_1',
        token_id: 'dtk_1',
        energy_delivered_wh: 950,
        current_cost_cents: currentCostCents,
        cost_ceiling_cents: costCeilingCents,
        idle_started_at: null,
        idle_minutes: 0,
        ocpp_protocol: ocppProtocol,
      });
      // The cost assembly (mocked) bills 24 cents.
      beforeEach(() => {
        mockPriceSessionAt.mockResolvedValue(costBreakdown(24));
      });
      afterEach(() => {
        mockPriceSessionAt.mockResolvedValue(costBreakdown(1500));
      });
      const base = [
        STA, // resolveStationUuid
        [{ id: 'ses_1' }], // resolveMeterValueSession
        [], // INSERT meter_values
        [{ energy_delivered_wh: 100, meter_start: '50' }], // prev energy/meter_start
        [], // UPDATE meter_start
        [], // UPDATE energy_delivered_wh
        [], // UPDATE idle accrue
      ];
      const emitReading = () =>
        emit('ocpp.MeterValues', 'CS-1', {
          stationId: 'CS-1',
          evseId: 0,
          transactionId: '1001',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2026-01-01T01:00:00Z',
              sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: 1000 }],
            },
          ],
        });
      const stopCommands = () =>
        (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
          (c) => c[0] === 'ocpp_commands' && (c[1] as string).includes('RequestStopTransaction'),
        );

      it('stops an OCPP 1.6 transaction once the cost reaches the credit', async () => {
        await setup();
        setupSqlResults(
          ...base,
          [costSession('ocpp1.6', 20)], // active sessions
          [{ id: 'ses_1' }], // claim the stop
          [{ site_id: null }], // resolveSiteId
        );

        await emitReading();

        const claim = findSql(/stopped_reason IS NULL/);
        expect(claim?.values).toContain('PrepaidCreditExhausted');
        const stops = stopCommands();
        expect(stops).toHaveLength(1);
        expect(JSON.parse(stops[0]?.[1] as string)).toMatchObject({
          stationId: 'CS-1',
          action: 'RequestStopTransaction',
          payload: { transactionId: '1001' },
        });
        // The session is not faulted: the StopTransaction settles the balance.
        expect(findSql(/SET status = 'faulted'/)).toBeUndefined();
      });

      it('sends the stop only once (the session was already claimed)', async () => {
        await setup();
        setupSqlResults(...base, [costSession('ocpp1.6', 20)], [], [{ site_id: null }]);

        await emitReading();

        expect(findSql(/stopped_reason IS NULL/)).toBeDefined();
        expect(stopCommands()).toHaveLength(0);
      });

      it('keeps charging while the cost is below the credit', async () => {
        await setup();
        setupSqlResults(...base, [costSession('ocpp1.6', 5000)], [{ site_id: null }]);

        await emitReading();

        expect(findSql(/stopped_reason IS NULL/)).toBeUndefined();
        expect(stopCommands()).toHaveLength(0);
      });

      it('leaves an OCPP 2.1 transaction to the station limit at the reading that reaches the credit', async () => {
        await setup();
        setupSqlResults(...base, [costSession('ocpp2.1', 24, 20)], [{ site_id: null }]);

        await emitReading();

        expect(findSql(/stopped_reason IS NULL/)).toBeUndefined();
        expect(stopCommands()).toHaveLength(0);
      });

      it('keeps an OCPP 2.1 transaction the station suspended at its cost limit open', async () => {
        await setup();
        setupSqlResults(
          ...base,
          [costSession('ocpp2.1', 24, 24)], // the credit was reached at an earlier reading
          [{ '?column?': 1 }], // the station reported CostLimitReached
          [{ site_id: null }],
        );

        await emitReading();

        expect(findSql(/stopped_reason IS NULL/)).toBeUndefined();
        expect(stopCommands()).toHaveLength(0);
      });

      it('stops an OCPP 2.1 transaction still running past the credit without CostLimitReached', async () => {
        await setup();
        setupSqlResults(
          ...base,
          [costSession('ocpp2.1', 24, 24)],
          [], // no CostLimitReached (the station ignores or does not support maxCost)
          [{ id: 'ses_1' }], // claim the stop
          [{ site_id: null }],
        );

        await emitReading();

        expect(findSql(/stopped_reason IS NULL/)?.values).toContain('PrepaidCreditExhausted');
        expect(stopCommands()).toHaveLength(1);
      });
    });

    describe('guest hold (cost ceiling)', () => {
      const guestSession = (
        ocppProtocol: string,
        costCeilingCents: number | null,
        currentCostCents: number,
      ) => ({
        id: 'ses_1',
        transaction_id: '1001',
        tariff_id: 'trf_1',
        driver_id: null,
        energy_delivered_wh: 950,
        current_cost_cents: currentCostCents,
        cost_ceiling_cents: costCeilingCents,
        idle_started_at: null,
        idle_minutes: 0,
        ocpp_protocol: ocppProtocol,
        token_id: null,
      });
      // The cost assembly (mocked) bills the ceiling: 24 cents.
      beforeEach(() => {
        mockPriceSessionAt.mockResolvedValue({ ...costBreakdown(24), pricedGrossCents: 31 });
      });
      afterEach(() => {
        mockPriceSessionAt.mockResolvedValue(costBreakdown(1500));
      });
      const base = [
        STA, // resolveStationUuid
        [{ id: 'ses_1' }], // resolveMeterValueSession
        [], // INSERT meter_values
        [{ energy_delivered_wh: 100, meter_start: '50' }], // prev energy/meter_start
        [], // UPDATE meter_start
        [], // UPDATE energy_delivered_wh
        [], // UPDATE idle accrue
      ];
      const emitReading = () =>
        emit('ocpp.MeterValues', 'CS-1', {
          stationId: 'CS-1',
          evseId: 0,
          transactionId: '1001',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2026-01-01T01:00:00Z',
              sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: 1000 }],
            },
          ],
        });
      const stopCommands = () =>
        (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
          (c) => c[0] === 'ocpp_commands' && (c[1] as string).includes('RequestStopTransaction'),
        );

      it('stops an OCPP 1.6 transaction once the cost reaches the hold', async () => {
        await setup();
        setupSqlResults(
          ...base,
          [guestSession('ocpp1.6', 24, 20)], // active sessions
          [{ id: 'ses_1' }], // claim the stop
          [{ site_id: null }], // resolveSiteId
        );

        await emitReading();

        const claim = findSql(/stopped_reason IS NULL/);
        expect(claim?.values).toContain('GuestHoldExhausted');
        const stops = stopCommands();
        expect(stops).toHaveLength(1);
        expect(JSON.parse(stops[0]?.[1] as string)).toMatchObject({
          action: 'RequestStopTransaction',
          payload: { transactionId: '1001' },
        });
        // The station ends the transaction, which settles the hold.
        expect(findSql(/SET status = 'faulted'/)).toBeUndefined();
        expect(findSql(/trigger_reason = 'CostLimitReached'/)).toBeUndefined();
      });

      it('keeps an OCPP 1.6 transaction charging below the hold', async () => {
        await setup();
        setupSqlResults(...base, [guestSession('ocpp1.6', 5000, 20)], [{ site_id: null }]);

        await emitReading();

        expect(findSql(/stopped_reason IS NULL/)).toBeUndefined();
        expect(stopCommands()).toHaveLength(0);
      });

      it('leaves an OCPP 2.1 transaction to the station limit at the reading that reaches the hold', async () => {
        await setup();
        setupSqlResults(...base, [guestSession('ocpp2.1', 24, 20)], [{ site_id: null }]);

        await emitReading();

        expect(findSql(/trigger_reason = 'CostLimitReached'/)).toBeUndefined();
        expect(stopCommands()).toHaveLength(0);
      });

      it('keeps an OCPP 2.1 transaction the station suspended at its cost limit open', async () => {
        await setup();
        setupSqlResults(
          ...base,
          [guestSession('ocpp2.1', 24, 24)], // the hold was reached at an earlier reading
          [{ '?column?': 1 }], // the station reported CostLimitReached
          [{ site_id: null }],
        );

        await emitReading();

        expect(findSql(/trigger_reason = 'CostLimitReached'/)).toBeDefined();
        expect(findSql(/stopped_reason IS NULL/)).toBeUndefined();
        expect(stopCommands()).toHaveLength(0);
      });

      it('stops an OCPP 2.1 transaction still running past the hold without CostLimitReached', async () => {
        await setup();
        setupSqlResults(
          ...base,
          [guestSession('ocpp2.1', 24, 24)],
          [], // no CostLimitReached from the station
          [{ id: 'ses_1' }], // claim the stop
          [{ site_id: null }],
        );

        await emitReading();

        expect(findSql(/stopped_reason IS NULL/)?.values).toContain('GuestHoldExhausted');
        expect(stopCommands()).toHaveLength(1);
      });

      it('does not stop a session without a ceiling', async () => {
        await setup();
        setupSqlResults(...base, [guestSession('ocpp1.6', null, 20)], [{ site_id: null }]);

        await emitReading();

        expect(stopCommands()).toHaveLength(0);
      });
    });

    describe('fleet credit (account cost ceiling, plan S8)', () => {
      // An account driver's RFID card: the session has a token, but the
      // ceiling is the fleet credit it reserved, not a prepaid credit.
      const accountSession = (
        ocppProtocol: string,
        costCeilingCents: number | null,
        currentCostCents: number,
        fleetLimitCents: number | null = 10_000,
      ) => ({
        id: 'ses_1',
        transaction_id: '1001',
        tariff_id: 'trf_1',
        driver_id: 'drv_1',
        token_id: 'dtk_1',
        energy_delivered_wh: 950,
        current_cost_cents: currentCostCents,
        cost_ceiling_cents: costCeilingCents,
        idle_started_at: null,
        idle_minutes: 0,
        ocpp_protocol: ocppProtocol,
        billing_mode: 'account',
        billing_fleet_id: 'flt_1',
        fleet_credit_limit_cents: fleetLimitCents,
      });
      const credit = (level: 'ok' | 'warning' | 'reached') => ({
        fleetId: 'flt_1',
        fleetName: 'Acme',
        limitCents: 10_000,
        warningPercent: 80,
        exposure: {
          unbilledCents: 0,
          invoicedCents: 0,
          runningCents: 24,
          totalCents: 24,
          currency: 'USD',
        },
        level,
        remainingCents: 0,
        ceilingCents: null,
      });
      beforeEach(() => {
        mockPriceSessionAt.mockResolvedValue(costBreakdown(24));
        mockReadFleetCreditLimit.mockReset();
        mockReadFleetCreditLimit.mockResolvedValue(credit('ok'));
        mockDispatchFleetCreditNotices.mockClear();
        mockFleetCreditNoticesClaimed.mockReset();
        mockFleetCreditNoticesClaimed.mockResolvedValue(false);
        mockExtendFleetSessionCeiling.mockReset();
        mockExtendFleetSessionCeiling.mockResolvedValue({
          previousCents: 20,
          ceilingCents: 20,
          grown: false,
        });
      });
      afterEach(() => {
        mockPriceSessionAt.mockResolvedValue(costBreakdown(1500));
      });
      const base = [
        STA, // resolveStationUuid
        [{ id: 'ses_1' }], // resolveMeterValueSession
        [], // INSERT meter_values
        [{ energy_delivered_wh: 100, meter_start: '50' }], // prev energy/meter_start
        [], // UPDATE meter_start
        [], // UPDATE energy_delivered_wh
        [], // UPDATE idle accrue
      ];
      const emitReading = () =>
        emit('ocpp.MeterValues', 'CS-1', {
          stationId: 'CS-1',
          evseId: 0,
          transactionId: '1001',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2026-01-01T01:00:00Z',
              sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: 1000 }],
            },
          ],
        });
      const stopCommands = () =>
        (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
          (c) => c[0] === 'ocpp_commands' && (c[1] as string).includes('RequestStopTransaction'),
        );

      it('stops an OCPP 1.6 transaction at the ceiling with the account reason', async () => {
        await setup();
        setupSqlResults(
          ...base,
          [accountSession('ocpp1.6', 20, 0)], // active sessions
          [{ id: 'ses_1', driver_id: 'drv_1' }], // claim the stop
          [], // station message settings
          [{ driver_id: 'drv_1', fleet_name: 'Acme', site_name: null }], // notice read
          [{ site_id: null }], // resolveSiteId
        );

        await emitReading();

        // The ceiling could not grow (the fleet has no credit left), so it stops.
        expect(mockExtendFleetSessionCeiling).toHaveBeenCalledWith(
          expect.anything(),
          'flt_1',
          'ses_1',
          { pricedCents: 24, sliceCents: 50, lastReadingCents: 24 },
        );
        const claim = findSql(/stopped_reason IS NULL/);
        expect(claim?.values).toContain('AccountCreditLimit');
        expect(claim?.values).not.toContain('PrepaidCreditExhausted');
        expect(stopCommands()).toHaveLength(1);
        // Billed up to the ceiling, not faulted: the station's end settles it.
        expect(findSql(/SET status = 'faulted'/)).toBeUndefined();
        expect(findSql(/LEFT JOIN fleets f ON f.id = cs.billing_fleet_id/)).toBeDefined();
      });

      it('grows the ceiling of a session at its ceiling while the fleet has credit, prices again and does not stop', async () => {
        mockExtendFleetSessionCeiling.mockResolvedValue({
          previousCents: 20,
          ceilingCents: 5020,
          grown: true,
        });
        await setup();
        setupSqlResults(...base, [accountSession('ocpp1.6', 20, 0)], [{ site_id: null }]);
        mockPriceSessionAt.mockClear();

        await emitReading();

        // Priced once with the old ceiling, once more under the grown one.
        expect(mockPriceSessionAt).toHaveBeenCalledTimes(2);
        expect(findSql(/stopped_reason IS NULL/)).toBeUndefined();
        expect(stopCommands()).toHaveLength(0);
      });

      it('grows the ceiling early when the reading added more than half the headroom', async () => {
        mockPriceSessionAt.mockResolvedValue(costBreakdown(70));
        mockExtendFleetSessionCeiling.mockResolvedValue({
          previousCents: 100,
          ceilingCents: 120,
          grown: true,
        });
        await setup();
        // Ceiling 100, cost 50 -> 70: 30 left (above 20 % of the 50 slice),
        // but the reading added 20, and twice that is more than what is left.
        setupSqlResults(...base, [accountSession('ocpp2.1', 100, 50)], [{ site_id: null }]);

        await emitReading();

        expect(mockExtendFleetSessionCeiling).toHaveBeenCalledWith(
          expect.anything(),
          'flt_1',
          'ses_1',
          { pricedCents: 70, sliceCents: 50, lastReadingCents: 20 },
        );
        expect(stopCommands()).toHaveLength(0);
      });

      it('extends nothing while the headroom covers the slice bound and the last reading', async () => {
        mockPriceSessionAt.mockResolvedValue(costBreakdown(60));
        await setup();
        setupSqlResults(...base, [accountSession('ocpp2.1', 100, 50)], [{ site_id: null }]);

        await emitReading();

        expect(mockExtendFleetSessionCeiling).not.toHaveBeenCalled();
      });

      it('extends nothing for a session claimed at the ceiling already', async () => {
        await setup();
        setupSqlResults(
          ...base,
          [{ ...accountSession('ocpp2.1', 24, 24), stopped_reason: 'AccountCreditLimit' }],
          [{ '?column?': 1 }], // the station reported CostLimitReached
          [{ site_id: null }],
        );

        await emitReading();

        expect(mockExtendFleetSessionCeiling).not.toHaveBeenCalled();
      });

      it('stops an OCPP 2.1 transaction still running past the ceiling without CostLimitReached', async () => {
        await setup();
        setupSqlResults(
          ...base,
          [accountSession('ocpp2.1', 24, 24)],
          [], // no CostLimitReached (the station ignores or does not support maxCost)
          [{ id: 'ses_1', driver_id: 'drv_1' }], // claim the stop
          [],
          [{ driver_id: 'drv_1', fleet_name: 'Acme', site_name: null }],
          [{ site_id: null }],
        );

        await emitReading();

        expect(findSql(/stopped_reason IS NULL/)?.values).toContain('AccountCreditLimit');
        expect(stopCommands()).toHaveLength(1);
      });

      it('leaves an OCPP 2.1 transaction that reported CostLimitReached to the station', async () => {
        await setup();
        setupSqlResults(
          ...base,
          [accountSession('ocpp2.1', 24, 24)],
          [{ '?column?': 1 }], // the station reported CostLimitReached
          [{ site_id: null }],
        );

        await emitReading();

        expect(findSql(/stopped_reason IS NULL/)).toBeUndefined();
        expect(stopCommands()).toHaveLength(0);
      });

      it('sends the fleet credit notices when the running cost passes the warning', async () => {
        mockReadFleetCreditLimit.mockResolvedValue(credit('warning'));
        await setup();
        setupSqlResults(...base, [accountSession('ocpp1.6', 5000, 0)], [{ site_id: null }]);

        await emitReading();
        await vi.waitFor(() => {
          expect(mockDispatchFleetCreditNotices).toHaveBeenCalledTimes(1);
        });

        expect(mockReadFleetCreditLimit).toHaveBeenCalledWith(expect.anything(), 'flt_1');
        expect(mockDispatchFleetCreditNotices.mock.calls[0]?.[0]).toMatchObject({
          fleetId: 'flt_1',
          level: 'warning',
        });
        expect(stopCommands()).toHaveLength(0);
      });

      it('sends no fleet notice below the warning', async () => {
        await setup();
        setupSqlResults(...base, [accountSession('ocpp1.6', 5000, 0)], [{ site_id: null }]);

        await emitReading();
        await vi.waitFor(() => {
          expect(mockReadFleetCreditLimit).toHaveBeenCalledTimes(1);
        });

        expect(mockDispatchFleetCreditNotices).not.toHaveBeenCalled();
      });

      it('reads no fleet credit for a fleet without a limit or an unchanged cost', async () => {
        await setup();
        setupSqlResults(...base, [accountSession('ocpp1.6', null, 0, null)], [{ site_id: null }]);
        await emitReading();

        await setup();
        setupSqlResults(...base, [accountSession('ocpp1.6', 5000, 24)], [{ site_id: null }]);
        await emitReading();

        expect(mockReadFleetCreditLimit).not.toHaveBeenCalled();
      });
    });

    it('flat energy reading marks session idle (Power not changing)', async () => {
      await setup();
      setupSqlResults(
        STA, // 0
        [{ id: 'ses_1' }], // 1 session
        [], // 2 INSERT meter_values
        [{ energy_delivered_wh: 100, meter_start: '50', last_rise_at: '2026-01-01T00:59:00Z' }], // 3 prev
        [], // 4 UPDATE meter_start
        [], // 5 UPDATE energy
        // newEnergyWh = 150-50 = 100 == prevEnergyWh -> flat -> mark idle
        [], // 6 UPDATE idle_started_at
        [], // 7 active sessions (empty)
        [{ site_id: null }], // 8 resolveSiteId
      );
      await emit('ocpp.MeterValues', 'CS-1', {
        stationId: 'CS-1',
        evseId: 0,
        transactionId: 'tx-1',
        source: 'TransactionEvent',
        meterValues: [
          {
            timestamp: '2026-01-01T01:00:00Z',
            sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: 150 }],
          },
        ],
      });
      const idleUpdate = sqlCalls.find(
        (c) =>
          /SET idle_started_at/.test(c.strings.join(' ')) &&
          /idle_started_at IS NULL/.test(c.strings.join(' ')),
      );
      expect(idleUpdate).toBeDefined();
      // A reading older than the newest status of the EVSE (offline replay) opens nothing.
      expect(idleUpdate!.strings.join('?')).toContain('c.status_reported_at > ?::timestamptz');
      expect(idleUpdate!.values).toContain('2026-01-01T01:00:00Z');
    });

    it('Power.Active.Import = 0 marks idle; nonzero accrues idle', async () => {
      await setup();
      setupSqlResults(
        STA,
        [{ id: 'ses_1' }], // session
        [], // INSERT meter_values
        [], // UPDATE idle_started_at (power 0)
        [], // active sessions empty
        [{ site_id: null }], // resolveSiteId
      );
      await emit('ocpp.MeterValues', 'CS-1', {
        stationId: 'CS-1',
        evseId: 0,
        transactionId: 'tx-1',
        source: 'TransactionEvent',
        meterValues: [
          {
            timestamp: '2026-01-01T01:00:00Z',
            sampledValue: [{ measurand: 'Power.Active.Import', value: 0 }],
          },
        ],
      });
      const idleOpen = findSql(/SET idle_started_at/);
      expect(idleOpen).toBeDefined();
      // A reading older than the newest status of the EVSE (offline replay) opens nothing.
      expect(idleOpen!.strings.join('?')).toContain('c.status_reported_at > ?::timestamptz');
    });

    it('a nonzero power reading closes an idle period only when it is not older than the status', async () => {
      await setup();
      setupSqlResults(
        STA,
        [{ id: 'ses_1' }], // session
        [], // INSERT meter_values
        [], // UPDATE idle_minutes (power resumed)
        [], // active sessions empty
        [{ site_id: null }], // resolveSiteId
      );
      await emit('ocpp.MeterValues', 'CS-1', {
        stationId: 'CS-1',
        evseId: 0,
        transactionId: 'tx-1',
        source: 'TransactionEvent',
        meterValues: [
          {
            timestamp: '2026-01-01T01:00:00Z',
            sampledValue: [{ measurand: 'Power.Active.Import', value: 7000 }],
          },
        ],
      });
      const idleClose = findSql(/SET idle_minutes/);
      expect(idleClose).toBeDefined();
      expect(idleClose!.strings.join('?')).toContain('c.status_reported_at > ?::timestamptz');
    });

    it('re-resolves station and re-inserts when first meter_values insert conflicts', async () => {
      await setup();
      setupSqlResults(
        STA, // resolveStationUuid
        [{ id: 'ses_1' }], // session
        EMPTY, // INSERT meter_values count 0 (conflict / stale)
        STA, // re-resolveStationUuid after invalidate
        [], // 2nd INSERT meter_values
        [], // active sessions empty
        [{ site_id: null }], // resolveSiteId
      );
      await emit('ocpp.MeterValues', 'CS-1', {
        stationId: 'CS-1',
        evseId: 0,
        transactionId: 'tx-1',
        source: 'TransactionEvent',
        meterValues: [{ timestamp: 't', sampledValue: [{ measurand: 'Voltage', value: 230 }] }],
      });
      // Two meter_values insert statements recorded
      const inserts = sqlCalls.filter((c) => /INSERT INTO meter_values/.test(c.strings.join(' ')));
      expect(inserts.length).toBe(2);
    });
  });

  // ---- ocpp.FirmwareStatusNotification ----

  describe('ocpp.FirmwareStatusNotification', () => {
    it('clears the firmware state on Installed and upserts firmware (2.1 path), no campaign', async () => {
      await setup();
      // firmware_state UPDATE, availability recompute (unchanged), firmware upsert
      setupSqlResults(STA, [], [], [{ campaign_id: null }]);
      await emit('ocpp.FirmwareStatusNotification', 'CS-1', { status: 'Installed', requestId: 5 });
      expect(findSql(/SET firmware_state = /)?.values[0]).toBeNull();
      expect(findSql(/SET availability = /)).toBeDefined();
      expect(findSql(/INSERT INTO firmware_updates .* ON CONFLICT/s)).toBeDefined();
      // No campaign linked -> no campaign station update
      expect(findSql(/UPDATE firmware_campaign_stations/)).toBeUndefined();
    });

    it('records a failed install on InstallationFailed', async () => {
      await setup();
      setupSqlResults(STA, [], [], [{ campaign_id: null }]);
      await emit('ocpp.FirmwareStatusNotification', 'CS-1', {
        status: 'InstallationFailed',
        requestId: 6,
      });
      expect(findSql(/SET firmware_state = /)?.values[0]).toBe('failed');
    });

    it('records an install in progress on Installing', async () => {
      await setup();
      setupSqlResults(STA, [], [], [{ campaign_id: null }]);
      await emit('ocpp.FirmwareStatusNotification', 'CS-1', {
        status: 'Installing',
        requestId: 7,
      });
      expect(findSql(/SET firmware_state = /)?.values[0]).toBe('installing');
    });

    it.each(['Idle', 'DownloadFailed'])(
      'ends an install in progress on %s but keeps a failed install',
      async (status) => {
        await setup();
        setupSqlResults(
          STA,
          [],
          [],
          [{ id: 'sta_1' }],
          [{ site_id: null }],
          [{ campaign_id: null }],
        );
        await emit('ocpp.FirmwareStatusNotification', 'CS-1', { status, requestId: 11 });
        const clear = findSql(/SET firmware_state = NULL/);
        expect(clear?.strings.join(' ')).toContain("firmware_state = 'installing'");
        expect(findSql(/SET firmware_state = 'failed'/)).toBeUndefined();
        const published = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.map(
          (c) => c[1] as string,
        );
        expect(published.some((p) => p.includes('station.status'))).toBe(true);
      },
    );

    it('leaves the firmware state alone for a download in progress', async () => {
      await setup();
      setupSqlResults(STA, [{ campaign_id: null }]);
      await emit('ocpp.FirmwareStatusNotification', 'CS-1', {
        status: 'Downloading',
        requestId: 12,
      });
      expect(findSql(/SET firmware_state/)).toBeUndefined();
      expect(findSql(/SET availability/)).toBeUndefined();
    });

    it('1.6 path: updates most recent non-terminal firmware row', async () => {
      await setup();
      setupSqlResults(STA, [{ campaign_id: null }]); // UPDATE returns a row
      await emit('ocpp.FirmwareStatusNotification', 'CS-1', { status: 'Downloading' });
      expect(findSql(/UPDATE firmware_updates\s+SET status/)).toBeDefined();
      expect(findSql(/INSERT INTO firmware_updates/)).toBeUndefined();
    });

    it('1.6 path: inserts when no non-terminal row exists', async () => {
      await setup();
      setupSqlResults(STA, []); // UPDATE returns empty (length 0)
      await emit('ocpp.FirmwareStatusNotification', 'CS-1', { status: 'Downloaded' });
      expect(findSql(/INSERT INTO firmware_updates/)).toBeDefined();
    });

    it('updates campaign station status and auto-completes campaign with audit', async () => {
      await setup();
      setupSqlResults(
        STA,
        [], // UPDATE charging_stations firmware_state (Installed)
        [], // SELECT charging_stations FOR UPDATE (availability lock)
        [], // availability recompute (unchanged)
        [{ campaign_id: 'fwc_1' }], // upsert firmware_updates RETURNING
        [], // UPDATE firmware_campaign_stations
        [{ id: 'fwc_1' }], // UPDATE firmware_campaigns RETURNING (completed)
      );
      await emit('ocpp.FirmwareStatusNotification', 'CS-1', { status: 'Installed', requestId: 9 });
      expect(findSql(/UPDATE firmware_campaign_stations/)).toBeDefined();
      expect(findSql(/UPDATE firmware_campaigns\s+SET status = 'completed'/)).toBeDefined();
      expect(mockWriteAudit).toHaveBeenCalledWith(
        { table: { __table: 'firmware_campaign_audit_log' }, idColumn: 'campaign_id' },
        expect.objectContaining({ action: 'completed', actor: 'ocpp' }),
      );
      const publishes = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[1] as string,
      );
      expect(publishes.some((p) => p.includes('firmwareCampaign.completed'))).toBe(true);
    });

    it('updates campaign station status but does not complete when stations pending', async () => {
      await setup();
      setupSqlResults(
        STA,
        [], // UPDATE firmware_state (DownloadFailed ends an install in progress)
        [], // SELECT charging_stations FOR UPDATE (availability lock)
        [], // availability recompute (unchanged)
        [{ campaign_id: 'fwc_2' }], // upsert RETURNING
        [], // UPDATE firmware_campaign_stations
        EMPTY, // UPDATE firmware_campaigns -> count 0 (not all terminal)
      );
      await emit('ocpp.FirmwareStatusNotification', 'CS-1', {
        status: 'DownloadFailed',
        requestId: 10,
      });
      expect(findSql(/UPDATE firmware_campaign_stations/)).toBeDefined();
      expect(mockWriteAudit).not.toHaveBeenCalled();
    });
  });

  // ---- ocpp.SecurityEventNotification critical auto-disable ----

  describe('ocpp.SecurityEventNotification', () => {
    it('inserts a security_event and notifies for a non-critical type', async () => {
      await setup();
      setupSqlResults(STA, [], [{ site_id: 'site-1' }]);
      await emit('ocpp.SecurityEventNotification', 'CS-1', {
        type: 'StartupOfTheDevice',
        timestamp: 't',
      });
      expect(findSql(/INSERT INTO security_events/)).toBeDefined();
      // non-critical -> no disable
      expect(findSql(/SET disabled_reason = 'security'/)).toBeUndefined();
    });

    it('auto-disables station and writes audit when critical and toggle enabled', async () => {
      mockIsAutoDisableOnCritical.mockResolvedValue(true);
      await setup();
      setupSqlResults(
        STA,
        [], // INSERT security_events
        [{ availability: 'available', disabled_reason: null }], // prior state
        [], // UPDATE disabled_reason
        [], // SELECT charging_stations FOR UPDATE (availability lock)
        [{ id: 'sta_1' }], // availability recompute (changed)
        [{ site_id: 'site-1' }], // resolveSiteId (station.status)
        [{ site_id: 'site-1' }], // resolveSiteId (station.securityEvent)
      );
      // FirmwareSignatureVerificationFailed is a critical security event
      await emit('ocpp.SecurityEventNotification', 'CS-1', {
        type: 'InvalidFirmwareSignature',
        timestamp: 't',
      });
      expect(findSql(/SET disabled_reason = 'security'/)).toBeDefined();
      const published = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[1] as string,
      );
      expect(published.some((p) => p.includes('station.status'))).toBe(true);
      const command = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[0] === 'ocpp_commands',
      );
      expect(JSON.parse(command?.[1] as string)).toMatchObject({
        stationId: 'CS-1',
        action: 'ChangeAvailability',
        payload: { operationalStatus: 'Inoperative' },
      });
      expect(mockWriteAudit).toHaveBeenCalledWith(
        { table: { __table: 'station_audit_log' }, idColumn: 'station_id' },
        expect.objectContaining({
          action: 'updated',
          actor: 'system',
          before: { availability: 'available' },
          after: { availability: 'unavailable' },
        }),
        undefined,
        expect.anything(),
      );
    });

    it('critical but already disabled: no audit', async () => {
      mockIsAutoDisableOnCritical.mockResolvedValue(true);
      await setup();
      setupSqlResults(
        STA,
        [], // INSERT
        [{ availability: 'unavailable', disabled_reason: 'operator' }], // already disabled
        [{ site_id: null }],
      );
      await emit('ocpp.SecurityEventNotification', 'CS-1', {
        type: 'InvalidFirmwareSignature',
      });
      expect(mockWriteAudit).not.toHaveBeenCalled();
      // Already disabled: the station was told when that happened.
      expect(
        (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.some(
          (c) => c[0] === 'ocpp_commands',
        ),
      ).toBe(false);
    });

    it('critical but toggle disabled: no flip', async () => {
      mockIsAutoDisableOnCritical.mockResolvedValue(false);
      await setup();
      setupSqlResults(STA, [], [{ site_id: null }]);
      await emit('ocpp.SecurityEventNotification', 'CS-1', { type: 'InvalidFirmwareSignature' });
      expect(findSql(/SET disabled_reason = 'security'/)).toBeUndefined();
    });
  });

  // ---- ocpp.ReservationStatusUpdate ----

  describe('ocpp.ReservationStatusUpdate', () => {
    it('Expired: updates to expired and writes audit', async () => {
      await setup();
      setupSqlResults([{ id: 'rsv_1', driver_id: 'drv_1' }]);
      await emit('ocpp.ReservationStatusUpdate', 'CS-1', {
        reservationId: 5,
        reservationUpdateStatus: 'Expired',
      });
      expect(findSql(/UPDATE reservations\s+SET status = 'expired'/)).toBeDefined();
      expect(mockWriteReservationAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'expired', reservationId: 'rsv_1' }),
        undefined,
        expect.anything(),
      );
    });

    it('Expired: no audit when no row transitioned', async () => {
      await setup();
      setupSqlResults([]); // UPDATE returns nothing
      await emit('ocpp.ReservationStatusUpdate', 'CS-1', {
        reservationId: 5,
        reservationUpdateStatus: 'Expired',
      });
      expect(mockWriteReservationAudit).not.toHaveBeenCalled();
    });

    it('Removed: cancels reservation, audits, and notifies driver', async () => {
      await setup();
      setupSqlResults(STA, [{ id: 'rsv_2', driver_id: 'drv_2' }]);
      await emit('ocpp.ReservationStatusUpdate', 'CS-1', {
        reservationId: 6,
        reservationUpdateStatus: 'Removed',
      });
      expect(findSql(/UPDATE reservations\s+SET status = 'cancelled'/)).toBeDefined();
      expect(mockWriteReservationAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'cancelled', reservationId: 'rsv_2' }),
        undefined,
        expect.anything(),
      );
      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'reservation.Cancelled',
        'drv_2',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('Removed: returns when station unresolvable', async () => {
      await setup();
      setupSqlResults([]); // resolveStationUuid null
      await emit('ocpp.ReservationStatusUpdate', 'CS-1', {
        reservationId: 6,
        reservationUpdateStatus: 'Removed',
      });
      expect(findSql(/UPDATE reservations/)).toBeUndefined();
    });

    it('Removed: swallows notification failure', async () => {
      await setup();
      mockDispatchDriver.mockRejectedValueOnce(new Error('boom'));
      setupSqlResults(STA, [{ id: 'rsv_3', driver_id: 'drv_3' }]);
      await emit('ocpp.ReservationStatusUpdate', 'CS-1', {
        reservationId: 7,
        reservationUpdateStatus: 'Removed',
      });
      expect(mockLoggerWarn).toHaveBeenCalled();
    });

    it('ignores other update statuses', async () => {
      await setup();
      setupSqlResults();
      await emit('ocpp.ReservationStatusUpdate', 'CS-1', {
        reservationId: 8,
        reservationUpdateStatus: 'NoTransaction',
      });
      expect(sqlCalls.length).toBe(0);
    });
  });

  // ---- ocpp.NotifySettlement ----

  describe('ocpp.NotifySettlement', () => {
    it('skips when required fields missing', async () => {
      await setup();
      setupSqlResults();
      await emit('ocpp.NotifySettlement', 'CS-1', { transactionId: 'tx-1' });
      expect(sqlCalls.length).toBe(0);
      expect(mockLoggerWarn).toHaveBeenCalled();
    });

    it('returns when session not found', async () => {
      await setup();
      setupSqlResults([]); // session lookup empty
      await emit('ocpp.NotifySettlement', 'CS-1', { transactionId: 'tx-1', settlementAmount: 10 });
      expect(mockRecordTerminalSettlement).not.toHaveBeenCalled();
    });

    it('inserts payment record, notifies SSE and driver', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'ses_1', driver_id: 'drv_1', station_id: 'sta_1', currency: 'USD' }], // session lookup
        [{ name: 'Site A' }], // resolveSiteName
      );
      await emit('ocpp.NotifySettlement', 'CS-1', {
        transactionId: 'tx-1',
        settlementAmount: 12.5,
      });
      expect(mockRecordTerminalSettlement).toHaveBeenCalledWith({
        sessionId: 'ses_1',
        driverId: 'drv_1',
        currency: 'USD',
        capturedCents: 1250, // 12.50 -> cents
      });
      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'session.PaymentReceived',
        'drv_1',
        expect.objectContaining({ amountCents: 1250 }),
        expect.anything(),
        expect.anything(),
      );
      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'payment.Complete',
        'drv_1',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('ignores duplicate settlement (the session already has a record)', async () => {
      mockRecordTerminalSettlement.mockResolvedValueOnce(false);
      await setup();
      setupSqlResults([{ id: 'ses_1', driver_id: 'drv_1', station_id: 'sta_1' }]);
      await emit('ocpp.NotifySettlement', 'CS-1', { transactionId: 'tx-1', settlementAmount: 5 });
      expect(mockRecordTerminalSettlement).toHaveBeenCalledTimes(1);
      expect(mockDispatchDriver).not.toHaveBeenCalled();
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        { transactionId: 'tx-1', sessionId: 'ses_1' },
        'Duplicate NotifySettlement ignored; payment already exists for session',
      );
      expect(
        (mockPubSub.publish as Mock<PubSubClient['publish']>).mock.calls.some((c) =>
          c[1].includes('payment.settled'),
        ),
      ).toBe(false);
    });

    it('anonymous session: inserts but no driver notification', async () => {
      await setup();
      setupSqlResults([{ id: 'ses_2', driver_id: null, station_id: 'sta_1' }]);
      await emit('ocpp.NotifySettlement', 'CS-1', { transactionId: 'tx-2', settlementAmount: 3 });
      expect(mockRecordTerminalSettlement).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'ses_2', driverId: null, capturedCents: 300 }),
      );
      expect(mockDispatchDriver).not.toHaveBeenCalled();
    });
  });

  // ---- ocpp.TransactionEvent Ended: settlement (second subscriber) ----

  describe('ocpp.TransactionEvent Ended settlement', () => {
    // Drive ONLY the settlement subscriber; the payment service is mocked, so
    // its SQL stream is the session lookup and the receipt's site name.

    function endedEvent() {
      return makeDomainEvent('ocpp.TransactionEvent', 'CS-1', {
        eventType: 'Ended',
        transactionId: 'tx-cap',
        triggerReason: 'StopAuthorized',
      });
    }

    async function emitEndedSecondOnly(...secondSqlResults: unknown[][]) {
      await setup();
      // Run only the settlement subscriber (index 1) to control its SQL stream.
      const handlers = eventBus.subscribers.get('ocpp.TransactionEvent') ?? [];
      const second = handlers[1];
      expect(second).toBeDefined();
      setupSqlResults(...secondSqlResults);
      await second?.(endedEvent());
    }

    const sessionRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'ses_1',
      final_cost_cents: 1500,
      currency: 'EUR',
      station_uuid: 'sta_1',
      station_ocpp_id: 'CS-1',
      site_id: 'site_1',
      ...overrides,
    });
    const captured = (overrides: Record<string, unknown> = {}) => ({
      mode: 'card',
      status: 'captured',
      paymentRecordId: 1,
      driverId: 'drv_1',
      capturedCents: 1500,
      shortfallCents: 0,
      recorded: true,
      ...overrides,
    });
    const driverCalls = (eventType: string) =>
      mockDispatchDriver.mock.calls.filter((c: unknown[]) => c[1] === eventType);
    const csmsEvents = () =>
      (mockPubSub.publish as Mock<PubSubClient['publish']>).mock.calls
        .filter((c) => c[0] === 'csms_events')
        .map((c) => JSON.parse(c[1]) as Record<string, unknown>);

    it('returns when session not found', async () => {
      await emitEndedSecondOnly([]); // session lookup empty
      expect(mockSettleSessionPayment).not.toHaveBeenCalled();
    });

    it('settles the session through the payment service', async () => {
      await emitEndedSecondOnly([sessionRow()]);
      expect(mockSettleSessionPayment).toHaveBeenCalledWith(
        'ses_1',
        mockPaymentContext,
        SETTLE_OPTIONS,
      );
      // Nothing to settle (the default outcome): no notification.
      expect(mockDispatchDriver).not.toHaveBeenCalled();
    });

    it('captured and recorded: sends the receipt in the session currency', async () => {
      mockSettleSessionPayment.mockResolvedValueOnce(captured({ capturedCents: 1750 }));
      // [] = the session-end notifications find no driver session (notifySessionEnded).
      await emitEndedSecondOnly([sessionRow()], [], [{ name: 'Site A' }]);
      expect(driverCalls('session.PaymentReceived')).toEqual([
        [
          expect.anything(),
          'session.PaymentReceived',
          'drv_1',
          expect.objectContaining({
            siteName: 'Site A',
            stationId: 'CS-1',
            transactionId: 'tx-cap',
            amountCents: 1750,
            currency: 'EUR',
          }),
          ['/mock/templates'],
          mockPubSub,
        ],
      ]);
      const vars = driverCalls('session.PaymentReceived')[0]?.[3] as {
        amountFormatted: { format: (locale: string) => string };
      };
      expect(vars.amountFormatted.format('en-US')).toBe('€17.50');
    });

    it('captured on a station without a row id: receipt without a site name', async () => {
      mockSettleSessionPayment.mockResolvedValueOnce(captured());
      await emitEndedSecondOnly([sessionRow({ station_uuid: null })]);
      expect(findSql(/FROM sites/)).toBeUndefined();
      expect(driverCalls('session.PaymentReceived')[0]?.[3]).toMatchObject({ siteName: '' });
    });

    it('captured but not recorded: no receipt and no failure notice', async () => {
      mockSettleSessionPayment.mockResolvedValueOnce(captured({ recorded: false }));
      await emitEndedSecondOnly([sessionRow()]);
      expect(driverCalls('session.PaymentReceived')).toHaveLength(0);
      expect(driverCalls('payment.CaptureFailed')).toHaveLength(0);
    });

    it('failed: notifies CaptureFailed with the final cost and the reason', async () => {
      mockSettleSessionPayment.mockResolvedValueOnce({
        mode: 'card',
        status: 'failed',
        paymentRecordId: 1,
        driverId: 'drv_1',
        reason: 'provider boom',
      });
      await emitEndedSecondOnly([sessionRow({ final_cost_cents: 500, currency: 'USD' })]);
      const calls = driverCalls('payment.CaptureFailed');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[2]).toBe('drv_1');
      const vars = calls[0]?.[3] as {
        stationId: string;
        transactionId: string;
        reason: string;
        amountFormatted: { format: (locale: string) => string };
      };
      expect(vars).toMatchObject({
        stationId: 'CS-1',
        transactionId: 'tx-cap',
        reason: 'provider boom',
      });
      expect(vars.amountFormatted.format('en-US')).toBe('$5.00');
      expect(driverCalls('session.PaymentReceived')).toHaveLength(0);
    });

    it('failed: a dispatch that throws is logged and the settlement continues', async () => {
      mockSettleSessionPayment.mockResolvedValueOnce({
        mode: 'card',
        status: 'failed',
        paymentRecordId: 1,
        driverId: 'drv_1',
        reason: 'provider boom',
      });
      mockDispatchDriver.mockImplementationOnce(() => {
        throw new Error('dispatch boom');
      });
      await emitEndedSecondOnly([sessionRow()]);
      expect(mockLoggerDebug).toHaveBeenCalledWith(
        expect.objectContaining({ driverId: 'drv_1', transactionId: 'tx-cap' }),
        'CaptureFailed notification dispatch failed; continuing',
      );
    });

    it('prepaid: reports the settlement and the token balance change', async () => {
      mockSettleSessionPayment.mockResolvedValueOnce({
        mode: 'prepaid',
        tokenId: 'dtk_1',
        debitedCents: 1500,
        balanceCents: 500,
      });
      await emitEndedSecondOnly([sessionRow()]);
      const events = csmsEvents();
      expect(events).toContainEqual({ eventType: 'token.changed', tokenId: 'dtk_1' });
      expect(events.find((e) => e['eventType'] === 'payment.settled')).toMatchObject({
        sessionId: 'ses_1',
        siteId: 'site_1',
      });
      expect(mockDispatchDriver).not.toHaveBeenCalled();
    });

    it('prepaid: a failed token.changed publish is logged and ignored', async () => {
      mockSettleSessionPayment.mockResolvedValueOnce({
        mode: 'prepaid',
        tokenId: 'dtk_1',
        debitedCents: 1500,
        balanceCents: 500,
      });
      await setup();
      vi.mocked(mockPubSub.publish).mockImplementation((_channel, message) =>
        message.includes('token.changed')
          ? Promise.reject(new Error('redis down'))
          : Promise.resolve(),
      );
      const second = (eventBus.subscribers.get('ocpp.TransactionEvent') ?? [])[1];
      setupSqlResults([sessionRow({ site_id: null })]);
      await second?.(endedEvent());
      expect(mockLoggerDebug).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        'token.changed SSE publish failed; continuing',
      );
    });

    it.each([
      { mode: 'card', status: 'cancelled', paymentRecordId: 1, recorded: true },
      { mode: 'guest' },
      { mode: 'none' },
    ])('sends nothing for outcome %o', async (outcome) => {
      mockSettleSessionPayment.mockResolvedValueOnce(outcome);
      await emitEndedSecondOnly([sessionRow()]);
      expect(mockSettleSessionPayment).toHaveBeenCalledTimes(1);
      expect(mockDispatchDriver).not.toHaveBeenCalled();
      expect(csmsEvents()).toHaveLength(0);
    });
  });

  // ---- ocpp.TransactionEvent Ended: carbon + reservation transition (first subscriber) ----

  describe('ocpp.TransactionEvent Ended carbon footprint', () => {
    async function emitEndedFirstOnly(...firstSqlResults: unknown[][]) {
      await setup();
      const handlers = eventBus.subscribers.get('ocpp.TransactionEvent') ?? [];
      const first = handlers[0];
      expect(first).toBeDefined();
      setupSqlResults(...firstSqlResults);
      await first?.(
        makeDomainEvent('ocpp.TransactionEvent', 'CS-1', {
          eventType: 'Ended',
          stationId: 'CS-1',
          transactionId: 'tx-carbon',
          seqNo: 3,
          triggerReason: 'EVDeparted',
          timestamp: '2026-01-01T01:00:00Z',
        }),
      );
    }

    it('computes CO2 avoided and transitions reservation to used', async () => {
      await emitEndedFirstOnly(
        [{ id: 'sta_1' }], // 0 resolveStationId
        [], // 1 failed payment_records -> none
        [], // SELECT the active session with an open idle period (JB-2 due notice): none
        [], // 2 UPDATE charging_sessions CASE
        [
          {
            id: 'ses_1',
            evse_id: null,
            status: 'completed',
            tariff_id: null, // skip cost calc
            current_cost_cents: 0,
            started_at: '2026-01-01T00:00:00Z',
            ended_at: '2026-01-01T01:00:00Z',
            energy_delivered_wh: 5000,
            currency: 'USD',
            tariff_price_per_kwh: null,
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
            idle_started_at: null,
            idle_minutes: 0,
            reservation_id: 'rsv_1',
          },
        ], // 3 SELECT sessionRows
        [], // 4 INSERT transaction_events
        [{ carbon_region_code: 'US-CAL', carbon_intensity_kg_per_kwh: '0.2' }], // 5 carbon query
        [], // 6 UPDATE co2_avoided_kg
        [{ site_id: null }], // 7 resolveSiteId
        [], // 8 UPDATE reservations 'used'
        [
          {
            driver_id: null,
            energy_delivered_wh: 5000,
            final_cost_cents: 0,
            currency: 'USD',
            started_at: '2026-01-01T00:00:00Z',
            ended_at: '2026-01-01T01:00:00Z',
            status: 'completed',
          },
        ], // 9 endedDriverRows
        [], // 10 publishStationMessageTransaction protocol lookup
      );
      const co2 = findSql(/UPDATE charging_sessions SET co2_avoided_kg/);
      expect(co2).toBeDefined();
      expect(findSql(/UPDATE reservations SET status = 'used'/)).toBeDefined();
    });

    it('logs warning when region set but intensity factor missing', async () => {
      await emitEndedFirstOnly(
        [{ id: 'sta_1' }],
        [], // SELECT payment_records (no failed payment)
        [], // SELECT the active session with an open idle period (JB-2 due notice): none
        [],
        [
          {
            id: 'ses_1',
            evse_id: null,
            status: 'completed',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2026-01-01T00:00:00Z',
            ended_at: '2026-01-01T01:00:00Z',
            energy_delivered_wh: 5000,
            currency: 'USD',
            idle_started_at: null,
            idle_minutes: 0,
            reservation_id: null,
          },
        ],
        [], // INSERT transaction_events
        [{ carbon_region_code: 'US-XYZ', carbon_intensity_kg_per_kwh: null }], // region but no factor
        [{ site_id: null }], // resolveSiteId
        [
          {
            driver_id: null,
            status: 'completed',
            started_at: '2026-01-01T00:00:00Z',
            ended_at: '2026-01-01T01:00:00Z',
          },
        ], // endedDriverRows
        [], // station message protocol lookup
      );
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ regionCode: 'US-XYZ' }),
        'Carbon intensity factor missing for region; CO2 calculation skipped',
      );
      expect(findSql(/UPDATE charging_sessions SET co2_avoided_kg/)).toBeUndefined();
    });

    it('swallows carbon query failure (fail-open warn)', async () => {
      await setup();
      const handlers = eventBus.subscribers.get('ocpp.TransactionEvent') ?? [];
      const first = handlers[0];
      setupSqlResults(
        [{ id: 'sta_1' }],
        [], // SELECT payment_records (no failed payment)
        [], // SELECT the active session with an open idle period (JB-2 due notice): none
        [],
        [
          {
            id: 'ses_1',
            evse_id: null,
            status: 'completed',
            tariff_id: null,
            started_at: '2026-01-01T00:00:00Z',
            ended_at: '2026-01-01T01:00:00Z',
            energy_delivered_wh: 5000,
            currency: 'USD',
            idle_started_at: null,
            idle_minutes: 0,
            reservation_id: null,
          },
        ],
        [], // INSERT transaction_events
      );
      // carbon query (index 6, after the JB-2 open idle period SELECT) throws
      sqlErrors.set(6, new Error('carbon table missing'));
      // resolveSiteId (7), endedDriverRows (8), station message protocol (9)
      sqlResults[7] = [{ site_id: null }];
      sqlResults[8] = [
        {
          driver_id: null,
          status: 'completed',
          started_at: '2026-01-01T00:00:00Z',
          ended_at: '2026-01-01T01:00:00Z',
        },
      ];
      sqlResults[9] = [];
      await first?.(
        makeDomainEvent('ocpp.TransactionEvent', 'CS-1', {
          eventType: 'Ended',
          stationId: 'CS-1',
          transactionId: 'tx-carbon-err',
          seqNo: 3,
          triggerReason: 'EVDeparted',
          timestamp: '2026-01-01T01:00:00Z',
        }),
      );
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Failed to compute CO2 avoided',
      );
    });
  });
});
