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

vi.mock('@evtivity/database', () => ({
  client: createSqlMock(),
  isRoamingEnabled: mockIsRoamingEnabled,
  getIdlingGracePeriodMinutes: vi.fn().mockResolvedValue(0),
  isSplitBillingEnabled: vi.fn().mockResolvedValue(false),
  getOfflineCommandTtlHours: vi.fn().mockResolvedValue(24),
  getMeterValueIntervalSeconds: vi.fn().mockResolvedValue(60),
  getClockAlignedIntervalSeconds: vi.fn().mockResolvedValue(0),
  getSampledMeasurands: vi.fn().mockResolvedValue([]),
  getAlignedMeasurands: vi.fn().mockResolvedValue([]),
  getTxEndedMeasurands: vi.fn().mockResolvedValue([]),
  writeReservationAudit: mockWriteReservationAudit,
  reservationDiffChanged: vi.fn().mockReturnValue(false),
  writeAudit: mockWriteAudit,
  firmwareCampaignAuditLog: { __table: 'firmware_campaign_audit_log' },
  stationAuditLog: { __table: 'station_audit_log' },
  isAutoDisableOnCriticalEnabled: mockIsAutoDisableOnCritical,
  isSiteFreeVendEnabledByStation: vi.fn().mockResolvedValue(false),
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
    createLogger: () => ({
      info: vi.fn(),
      warn: mockLoggerWarn,
      error: mockLoggerError,
      debug: mockLoggerDebug,
      child: () => child,
    }),
  };
});

vi.mock('stripe', () => ({
  default: class MockStripe {
    paymentIntents = {
      create: vi.fn().mockResolvedValue({ id: 'pi_test' }),
      capture: vi.fn().mockResolvedValue({}),
      cancel: vi.fn().mockResolvedValue({}),
      retrieve: vi.fn().mockResolvedValue({ customer: 'cus_x', payment_method: 'pm_x' }),
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

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'setInterval',
      vi.fn(() => ({ id: 1, unref: vi.fn(), ref: vi.fn() })),
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

    mockPubSub = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
      close: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
});
