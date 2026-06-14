// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

vi.mock('@evtivity/database', () => ({
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
const mockShouldSimulateFailure = vi.fn().mockReturnValue(false);

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
    shouldSimulatePaymentFailure: mockShouldSimulateFailure,
    createLogger: () => ({
      info: vi.fn(),
      warn: mockLoggerWarn,
      error: mockLoggerError,
      debug: mockLoggerDebug,
      child: () => child,
    }),
  };
});

const mockStripeCreate = vi.fn().mockResolvedValue({ id: 'pi_topup' });
const mockStripeCapture = vi.fn().mockResolvedValue({});
const mockStripeCancel = vi.fn().mockResolvedValue({});
const mockStripeRetrieve = vi.fn().mockResolvedValue({
  customer: 'cus_x',
  payment_method: 'pm_x',
  on_behalf_of: null,
});

vi.mock('stripe', () => ({
  default: class MockStripe {
    paymentIntents = {
      create: mockStripeCreate,
      capture: mockStripeCapture,
      cancel: mockStripeCancel,
      retrieve: mockStripeRetrieve,
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
    mockShouldSimulateFailure.mockReturnValue(false);
    mockDecryptString.mockReturnValue('sk_test_decrypted');
    mockStripeCreate.mockResolvedValue({ id: 'pi_topup' });
    mockStripeCapture.mockResolvedValue({});
    mockStripeCancel.mockResolvedValue({});
    mockStripeRetrieve.mockResolvedValue({
      customer: 'cus_x',
      payment_method: 'pm_x',
      on_behalf_of: null,
    });
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
      ['ocpp.NotifyQRCodeScanned', {}],
      ['ocpp.VatNumberValidation', {}],
      ['ocpp.NotifyWebPaymentStarted', {}],
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

    it('accepted station: sets availability=available and pushes 2.1 SetVariables config', async () => {
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
        [{ site_id: null }], // resolveSiteId
        [{ ocpp_protocol: 'ocpp2.1' }], // SELECT protocol (config push)
        [{ ocpp_protocol: 'ocpp2.1' }], // SELECT protocol (station message refresh)
      );
      await emit('ocpp.BootNotification', 'CS-1', {
        firmwareVersion: '1.0',
        model: 'M',
        vendorName: 'Acme',
      });
      expect(findSql(/availability = 'available'/)).toBeDefined();
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
      const ins = findSql(/INSERT INTO station_configurations .* 'GetVariables'/s);
      expect(ins).toBeDefined();
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
      const ins = findSql(/INSERT INTO station_configurations .* 'GetConfiguration'/s);
      expect(ins).toBeDefined();
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
    });
  });

  // ---- ocpp.NotifyPeriodicEventStream / QRCodeScanned ----

  describe('OCPP 2.1 stub persistence', () => {
    it('NotifyPeriodicEventStream inserts a row', async () => {
      await setup();
      setupSqlResults(STA, []);
      await emit('ocpp.NotifyPeriodicEventStream', 'CS-1', { id: 7, data: [{ v: 1 }] });
      const ins = findSql(/INSERT INTO periodic_event_streams/);
      expect(ins?.values).toContain(7);
    });

    it('NotifyQRCodeScanned inserts a row', async () => {
      await setup();
      setupSqlResults(STA, []);
      await emit('ocpp.NotifyQRCodeScanned', 'CS-1', { evseId: 2, timeout: 30 });
      const ins = findSql(/INSERT INTO qr_scan_events/);
      expect(ins?.values).toEqual(['sta_0001', 2, 30]);
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
        [], // INSERT connectors
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
        [], // INSERT connectors
        [], // INSERT port_status_log
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
        [{ status: 'available' }], // SELECT connectors prev status (same as new)
        [], // UPDATE connectors
        [{ site_id: null }], // resolveSiteId
      );
      await emit('ocpp.StatusNotification', 'CS-1', {
        evseId: 1,
        connectorId: 1,
        connectorStatus: 'Available',
      });
      // No status change -> no port_status_log insert
      expect(findSql(/INSERT INTO port_status_log/)).toBeUndefined();
      expect(findSql(/UPDATE connectors SET status/)).toBeDefined();
    });

    it('logs transition and auto-creates connector when connector row missing', async () => {
      await setup();
      setupSqlResults(
        STA,
        [{ id: 'evs_1' }], // SELECT evses
        [], // SELECT connectors -> none (length 0)
        [], // INSERT port_status_log (status changed: undefined -> faulted)
        [], // INSERT connectors
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
        [{ status: 'occupied' }],
        [], // UPDATE connectors
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

    it('1.6 idle detection: SuspendedEV sets idle_started_at and notifies', async () => {
      await setup();
      setupSqlResults(
        STA,
        [{ id: 'evs_1' }],
        [{ status: 'charging' }],
        [], // INSERT port_status_log (charging -> suspended_ev)
        [], // UPDATE connectors
        [], // UPDATE charging_stations (connector fault reconciliation)
        [{ site_id: null }], // resolveSiteId
        [], // UPDATE charging_sessions set idle_started_at
        [{ id: 'ses_1', transaction_id: 'tx_1' }], // SELECT active session
        // dispatchIdlingNotification:
        [
          {
            driver_id: 'drv_1',
            idle_started_at: 't',
            tariff_idle_fee_price_per_minute: '0.05',
            currency: 'USD',
          },
        ],
        STA, // resolveStationUuid (cached, but be safe)
        [{ name: 'Site A' }], // resolveSiteName
      );
      await emit('ocpp.StatusNotification', 'CS-1', {
        evseId: 1,
        connectorId: 1,
        connectorStatus: 'SuspendedEV',
        timestamp: '2026-01-01T00:00:00Z',
      });
      expect(findSql(/UPDATE charging_sessions\s+SET idle_started_at/)).toBeDefined();
      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'session.IdlingStarted',
        'drv_1',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('1.6 resume: Charging clears idle_started_at and accrues idle_minutes', async () => {
      await setup();
      setupSqlResults(
        STA,
        [{ id: 'evs_1' }],
        [{ status: 'suspended_ev' }],
        [], // INSERT port_status_log
        [], // UPDATE connectors
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
        [], // resolveActiveSessionId by transactionId -> none
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
        [{ id: 'ses_1' }], // 1 resolveActiveSessionId by transactionId
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
        [], // 8 UPDATE current_cost_cents
        [{ site_id: null }], // 9 resolveSiteId
      );
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
      expect(findSql(/SET current_cost_cents/)).toBeDefined();
      const cost = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'ocpp_commands' && (c[1] as string).includes('CostUpdated'),
      );
      expect(cost.length).toBe(1);
    });

    it('flat energy reading marks session idle (Power not changing)', async () => {
      await setup();
      setupSqlResults(
        STA, // 0
        [{ id: 'ses_1' }], // 1 session
        [], // 2 INSERT meter_values
        [{ energy_delivered_wh: 100, meter_start: '50' }], // 3 prev
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
      expect(findSql(/SET idle_started_at/)).toBeDefined();
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
    it('marks station available on Installed and upserts firmware (2.1 path), no campaign', async () => {
      await setup();
      setupSqlResults(STA, [], [{ campaign_id: null }]);
      await emit('ocpp.FirmwareStatusNotification', 'CS-1', { status: 'Installed', requestId: 5 });
      const avail = findSql(/UPDATE charging_stations\s+SET availability = 'available'/);
      expect(avail).toBeDefined();
      expect(findSql(/INSERT INTO firmware_updates .* ON CONFLICT/s)).toBeDefined();
      // No campaign linked -> no campaign station update
      expect(findSql(/UPDATE firmware_campaign_stations/)).toBeUndefined();
    });

    it('marks station faulted on InstallationFailed', async () => {
      await setup();
      setupSqlResults(STA, [], [{ campaign_id: null }]);
      await emit('ocpp.FirmwareStatusNotification', 'CS-1', {
        status: 'InstallationFailed',
        requestId: 6,
      });
      expect(findSql(/SET availability = 'faulted'/)).toBeDefined();
    });

    it('marks station unavailable on Installing', async () => {
      await setup();
      setupSqlResults(STA, [], [{ campaign_id: null }]);
      await emit('ocpp.FirmwareStatusNotification', 'CS-1', {
        status: 'Installing',
        requestId: 7,
      });
      expect(findSql(/SET availability = 'unavailable'/)).toBeDefined();
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
        [], // UPDATE charging_stations (Installed)
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
        // DownloadFailed does not flip charging_stations availability, so the
        // next SQL call is the firmware_updates upsert.
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
      // non-critical -> no availability flip
      expect(findSql(/SET availability = 'unavailable'/)).toBeUndefined();
    });

    it('auto-disables station and writes audit when critical and toggle enabled', async () => {
      mockIsAutoDisableOnCritical.mockResolvedValue(true);
      await setup();
      setupSqlResults(
        STA,
        [], // INSERT security_events
        [{ prior_availability: 'available' }], // CTE flip RETURNING prior
        [{ site_id: 'site-1' }], // resolveSiteId
      );
      // FirmwareSignatureVerificationFailed is a critical security event
      await emit('ocpp.SecurityEventNotification', 'CS-1', {
        type: 'InvalidFirmwareSignature',
        timestamp: 't',
      });
      expect(findSql(/SET availability = 'unavailable'/)).toBeDefined();
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

    it('critical but already unavailable: no audit (CTE returns no prior)', async () => {
      mockIsAutoDisableOnCritical.mockResolvedValue(true);
      await setup();
      setupSqlResults(
        STA,
        [], // INSERT
        [], // CTE flip -> already unavailable, no prior returned
        [{ site_id: null }],
      );
      await emit('ocpp.SecurityEventNotification', 'CS-1', {
        type: 'InvalidFirmwareSignature',
      });
      expect(mockWriteAudit).not.toHaveBeenCalled();
    });

    it('critical but toggle disabled: no flip', async () => {
      mockIsAutoDisableOnCritical.mockResolvedValue(false);
      await setup();
      setupSqlResults(STA, [], [{ site_id: null }]);
      await emit('ocpp.SecurityEventNotification', 'CS-1', { type: 'InvalidFirmwareSignature' });
      expect(findSql(/SET availability = 'unavailable'/)).toBeUndefined();
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
      expect(findSql(/INSERT INTO payment_records/)).toBeUndefined();
    });

    it('inserts payment record, notifies SSE and driver', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'ses_1', driver_id: 'drv_1', station_id: 'sta_1' }], // session lookup
        [], // INSERT payment_records (count 1)
        [{ name: 'Site A' }], // resolveSiteName
      );
      await emit('ocpp.NotifySettlement', 'CS-1', {
        transactionId: 'tx-1',
        settlementAmount: 12.5,
      });
      const ins = findSql(/INSERT INTO payment_records/);
      expect(ins).toBeDefined();
      expect(ins?.values).toContain(1250); // 12.50 -> cents
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

    it('ignores duplicate settlement (ON CONFLICT count 0)', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'ses_1', driver_id: 'drv_1', station_id: 'sta_1' }],
        EMPTY, // INSERT count 0 -> duplicate
      );
      await emit('ocpp.NotifySettlement', 'CS-1', { transactionId: 'tx-1', settlementAmount: 5 });
      expect(mockDispatchDriver).not.toHaveBeenCalled();
      expect(mockLoggerWarn).toHaveBeenCalled();
    });

    it('anonymous session: inserts but no driver notification', async () => {
      await setup();
      setupSqlResults([{ id: 'ses_2', driver_id: null, station_id: 'sta_1' }], []);
      await emit('ocpp.NotifySettlement', 'CS-1', { transactionId: 'tx-2', settlementAmount: 3 });
      expect(findSql(/INSERT INTO payment_records/)).toBeDefined();
      expect(mockDispatchDriver).not.toHaveBeenCalled();
    });
  });

  // ---- ocpp.TransactionEvent Ended: auto-capture (second subscriber) ----

  describe('ocpp.TransactionEvent Ended auto-capture', () => {
    // Drive ONLY the second subscriber. The first subscriber for the same event
    // also runs; we provide enough SQL results so both complete without throwing
    // and assert on the capture-specific writes.

    function endedEvent() {
      return makeDomainEvent('ocpp.TransactionEvent', 'CS-1', {
        eventType: 'Ended',
        transactionId: 'tx-cap',
        triggerReason: 'StopAuthorized',
      });
    }

    async function emitEndedSecondOnly(...secondSqlResults: unknown[][]) {
      await setup();
      // Run only the auto-capture subscriber (index 1) to control its SQL stream.
      const handlers = eventBus.subscribers.get('ocpp.TransactionEvent') ?? [];
      const second = handlers[1];
      expect(second).toBeDefined();
      setupSqlResults(...secondSqlResults);
      await second?.(endedEvent());
    }

    it('returns when session not found', async () => {
      await emitEndedSecondOnly([]); // session lookup empty
      expect(findSql(/payment_records/)).toBeUndefined();
    });

    it('returns when no pre_authorized payment record', async () => {
      await emitEndedSecondOnly(
        [{ id: 'ses_1', final_cost_cents: 100, currency: 'USD', station_uuid: 'sta_1' }],
        [], // payment_records pre_authorized -> none
      );
      expect(findSql(/UPDATE payment_records/)).toBeUndefined();
    });

    it('returns when guest payment record (driver_id null)', async () => {
      await emitEndedSecondOnly(
        [{ id: 'ses_1', final_cost_cents: 100, currency: 'USD' }],
        [{ id: 'pr_1', stripe_payment_intent_id: 'pi_sim_1', driver_id: null }],
      );
      expect(findSql(/UPDATE payment_records/)).toBeUndefined();
    });

    it('simulated success: captures and notifies driver', async () => {
      await emitEndedSecondOnly(
        [{ id: 'ses_1', final_cost_cents: 1500, currency: 'EUR', station_uuid: 'sta_1' }],
        [
          {
            id: 'pr_1',
            stripe_payment_intent_id: 'pi_sim_1',
            driver_id: 'drv_1',
            pre_auth_amount_cents: 2000,
          },
        ],
        [], // UPDATE payment_records captured
      );
      const upd = findSql(/UPDATE payment_records\s+SET status = 'captured'/);
      expect(upd).toBeDefined();
      expect(upd?.values).toContain(1500);
      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'session.PaymentReceived',
        'drv_1',
        expect.objectContaining({ currency: 'EUR', amountCents: 1500 }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('simulated zero-cost: cancels payment record', async () => {
      await emitEndedSecondOnly(
        [{ id: 'ses_1', final_cost_cents: 0, currency: 'USD', station_uuid: 'sta_1' }],
        [{ id: 'pr_1', stripe_payment_intent_id: 'pi_sim_1', driver_id: 'drv_1' }],
        [], // UPDATE cancelled
      );
      expect(findSql(/UPDATE payment_records\s+SET status = 'cancelled'/)).toBeDefined();
    });

    it('simulated failure: marks failed and notifies CaptureFailed', async () => {
      mockShouldSimulateFailure.mockReturnValue(true);
      await emitEndedSecondOnly(
        [{ id: 'ses_1', final_cost_cents: 1000, currency: 'USD', station_uuid: 'sta_1' }],
        [{ id: 'pr_1', stripe_payment_intent_id: 'pi_sim_1', driver_id: 'drv_1' }],
        [], // UPDATE failed
      );
      expect(findSql(/SET status = 'failed'/)).toBeDefined();
      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'payment.CaptureFailed',
        'drv_1',
        expect.objectContaining({ reason: 'Simulated capture failure' }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('real Stripe capture (finalCost <= preAuth): captures and records', async () => {
      await emitEndedSecondOnly(
        [
          {
            id: 'ses_1',
            final_cost_cents: 1200,
            currency: 'USD',
            station_uuid: 'sta_1',
            station_ocpp_id: 'CS-1',
          },
        ],
        [
          {
            id: 'pr_1',
            stripe_payment_intent_id: 'pi_real_1',
            driver_id: 'drv_1',
            pre_auth_amount_cents: 2000,
          },
        ],
        [{ value: 'enc-secret' }], // settings stripe.secretKeyEnc
        [], // UPDATE payment_records captured
        [{ name: 'Site A' }], // resolveSiteName
      );
      expect(mockStripeCapture).toHaveBeenCalledWith(
        'pi_real_1',
        { amount_to_capture: 1200 },
        expect.objectContaining({ idempotencyKey: 'capture_pr_1' }),
      );
      expect(findSql(/UPDATE payment_records\s+SET status = 'captured'/)).toBeDefined();
    });

    it('real Stripe top-up when finalCost > preAuth', async () => {
      await emitEndedSecondOnly(
        [
          {
            id: 'ses_1',
            final_cost_cents: 3000,
            currency: 'USD',
            station_uuid: 'sta_1',
            station_ocpp_id: 'CS-1',
          },
        ],
        [
          {
            id: 'pr_1',
            stripe_payment_intent_id: 'pi_real_1',
            driver_id: 'drv_1',
            pre_auth_amount_cents: 2000,
          },
        ],
        [{ value: 'enc-secret' }], // stripe secret
        [], // UPDATE captured
        [{ name: 'Site A' }], // resolveSiteName
      );
      expect(mockStripeCapture).toHaveBeenCalledWith(
        'pi_real_1',
        { amount_to_capture: 2000 },
        expect.anything(),
      );
      expect(mockStripeRetrieve).toHaveBeenCalledWith('pi_real_1');
      expect(mockStripeCreate).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 1000 }),
        expect.objectContaining({ idempotencyKey: 'topup_pr_1' }),
      );
    });

    it('top-up failure leaves capture recorded with failure_reason', async () => {
      mockStripeCreate.mockRejectedValueOnce(new Error('card declined'));
      await emitEndedSecondOnly(
        [
          {
            id: 'ses_1',
            final_cost_cents: 3000,
            currency: 'USD',
            station_uuid: 'sta_1',
            station_ocpp_id: 'CS-1',
          },
        ],
        [
          {
            id: 'pr_1',
            stripe_payment_intent_id: 'pi_real_1',
            driver_id: 'drv_1',
            pre_auth_amount_cents: 2000,
          },
        ],
        [{ value: 'enc-secret' }],
        [], // UPDATE captured (with failure_reason)
        [{ name: 'Site A' }],
      );
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ paymentRecordId: 'pr_1' }),
        'Top-up PaymentIntent failed; pre-auth was captured but delta uncollected',
      );
      const upd = findSql(/UPDATE payment_records\s+SET status = 'captured'/);
      expect(upd?.values.some((v) => typeof v === 'string' && v.includes('Top-up declined'))).toBe(
        true,
      );
    });

    it('real Stripe cancel when finalCost is zero', async () => {
      await emitEndedSecondOnly(
        [{ id: 'ses_1', final_cost_cents: 0, currency: 'USD', station_uuid: 'sta_1' }],
        [{ id: 'pr_1', stripe_payment_intent_id: 'pi_real_1', driver_id: 'drv_1' }],
        [{ value: 'enc-secret' }], // stripe secret
        [], // UPDATE cancelled
      );
      expect(mockStripeCancel).toHaveBeenCalledWith('pi_real_1');
      expect(findSql(/UPDATE payment_records\s+SET status = 'cancelled'/)).toBeDefined();
    });

    it('returns when stripe secret missing', async () => {
      await emitEndedSecondOnly(
        [{ id: 'ses_1', final_cost_cents: 100, currency: 'USD', station_uuid: 'sta_1' }],
        [{ id: 'pr_1', stripe_payment_intent_id: 'pi_real_1', driver_id: 'drv_1' }],
        [], // settings -> no secret
      );
      expect(mockStripeCapture).not.toHaveBeenCalled();
    });

    it('Stripe capture error marks failed and notifies CaptureFailed', async () => {
      mockStripeCapture.mockRejectedValueOnce(new Error('stripe boom'));
      await emitEndedSecondOnly(
        [{ id: 'ses_1', final_cost_cents: 500, currency: 'USD', station_uuid: 'sta_1' }],
        [
          {
            id: 'pr_1',
            stripe_payment_intent_id: 'pi_real_1',
            driver_id: 'drv_1',
            pre_auth_amount_cents: 1000,
          },
        ],
        [{ value: 'enc-secret' }],
        [], // UPDATE failed
      );
      expect(findSql(/SET status = 'failed'/)).toBeDefined();
      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'payment.CaptureFailed',
        'drv_1',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('returns when payment intent id is null', async () => {
      await emitEndedSecondOnly(
        [{ id: 'ses_1', final_cost_cents: 100, currency: 'USD', station_uuid: 'sta_1' }],
        [{ id: 'pr_1', stripe_payment_intent_id: null, driver_id: 'drv_1' }],
      );
      expect(mockStripeCapture).not.toHaveBeenCalled();
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
            currency: null,
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
        [],
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
            currency: null,
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
        [],
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
            currency: null,
            idle_started_at: null,
            idle_minutes: 0,
            reservation_id: null,
          },
        ],
        [], // INSERT transaction_events
      );
      // carbon query (index 5) throws
      sqlErrors.set(5, new Error('carbon table missing'));
      // resolveSiteId (6), endedDriverRows (7), station message protocol (8)
      sqlResults[6] = [{ site_id: null }];
      sqlResults[7] = [
        {
          driver_id: null,
          status: 'completed',
          started_at: '2026-01-01T00:00:00Z',
          ended_at: '2026-01-01T01:00:00Z',
        },
      ];
      sqlResults[8] = [];
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
