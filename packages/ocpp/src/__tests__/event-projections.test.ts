// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { EventBus, DomainEvent, PubSubClient } from '@evtivity/lib';
import { OCPP_NOTIFICATION_EVENT_TYPES } from '@evtivity/lib';

// SQL mock: a function that handles tagged template calls and returns configurable results
const sqlCalls: Array<{ strings: string[]; values: unknown[] }> = [];
let sqlResults: Array<unknown[]> = [];
let sqlCallIndex = 0;
// Rejects the statements whose text it returns an error for (unique violations).
let sqlFailOn: ((text: string) => Error | null) | null = null;
// Answers the statements whose text it returns rows for, without using an indexed result.
let sqlRoute: ((text: string) => unknown[] | undefined) | null = null;

function createSqlMock() {
  sqlCalls.length = 0;
  sqlResults = [];
  sqlCallIndex = 0;

  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    sqlCalls.push({ strings: [...strings], values });
    const routed = sqlRoute?.(strings.join('?'));
    if (routed !== undefined) return Promise.resolve(routed);
    const result = sqlResults[sqlCallIndex] ?? [];
    sqlCallIndex++;
    const failure = sqlFailOn?.(strings.join(''));
    if (failure != null) return Promise.reject(failure);
    return Promise.resolve(result);
  };

  // Mirror postgres-js's `sql.json(value)` helper so production code that
  // wraps JSONB values can run unchanged in tests. Returning the raw value
  // is sufficient because the mock just records template strings + values.
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
  getCompanyTaxBasis: vi.fn().mockResolvedValue('net'),
  priceSessionAt: (...args: unknown[]) => mockPriceSessionAt(...args) as unknown,
  storeRunningCost: (...args: unknown[]) => mockStoreRunningCost(...args) as unknown,
  client: createSqlMock(),
  isRoamingEnabled: vi.fn().mockResolvedValue(false),
  getIdlingGracePeriodMinutes: vi.fn().mockResolvedValue(0),
  isSplitBillingEnabled: vi.fn().mockResolvedValue(false),
  getOfflineCommandTtlHours: vi.fn().mockResolvedValue(24),
  isSiteFreeVendEnabledByStation: vi.fn().mockResolvedValue(false),
  getCompanyCurrency: vi.fn().mockResolvedValue('USD'),
  getCompanyPriceDisplay: vi.fn().mockResolvedValue('net'),
  writeReservationAudit: vi.fn().mockResolvedValue(undefined),
  // The real Postgres error readers.
  ...(await vi.importActual<Record<string, unknown>>('../../../database/src/lib/pg-errors.js')),
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

// The payment service (@evtivity/payments): the gate's hold, the settlement on
// Ended, and the NotifySettlement record. The mode classification stays real.
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
vi.mock('../lib/payments.js', () => ({
  paymentRegistry: {},
  paymentContext: () => mockPaymentContext,
  activePaymentProvider: () => Promise.resolve({ id: 'stripe' }),
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

/**
 * Matches a notification value (notificationMoney, notificationUnitPrice,
 * notificationTaxRate) that the dispatcher formats as `text` for an en-US
 * recipient.
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

describe('Event projections', () => {
  let eventBus: ReturnType<typeof createMockEventBus>;
  let timerCallback: (() => void) | null = null;

  // Importing the projections module cold is slow on a loaded machine; do it
  // once here so no single test pays for it against its own timeout.
  beforeAll(async () => {
    await import('../server/event-projections.js');
  }, 60_000);

  beforeEach(() => {
    vi.useFakeTimers();
    const origSetInterval = vi.fn((fn: () => void) => {
      timerCallback = fn;
      return { id: 1, unref: vi.fn(), ref: vi.fn() };
    });
    vi.stubGlobal('setInterval', origSetInterval);

    eventBus = createMockEventBus();
    sqlCalls.length = 0;
    sqlResults = [];
    sqlCallIndex = 0;
    sqlFailOn = null;
    sqlRoute = null;
    vi.clearAllMocks();
    mockAuthorizeSessionHold.mockResolvedValue({
      outcome: 'authorized',
      paymentRecordId: 1,
      paymentId: 'pi_test',
    });
    mockSettleSessionPayment.mockResolvedValue({ mode: 'none' });
    mockRecordTerminalSettlement.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const mockPubSub: PubSubClient = {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
    close: vi.fn().mockResolvedValue(undefined),
  };

  // We need to re-import to pick up fresh mocks
  async function setup() {
    const { registerProjections } = await import('../server/event-projections.js');
    registerProjections(eventBus, mockPubSub);
  }

  describe('station.Connected', () => {
    it('updates station online status and inserts connection log', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // UPDATE charging_stations
        [], // INSERT connection_logs
        [], // SELECT evse_id FROM evses
        [{ site_id: 'site-1' }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'station.Connected',
        makeDomainEvent('station.Connected', 'CS-001', { ocppProtocol: 'ocpp2.1' }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(4);
    });

    it('uses stationDbId from payload when available', async () => {
      await setup();

      setupSqlResults(
        [], // UPDATE charging_stations
        [], // INSERT connection_logs
        [], // SELECT evse_id FROM evses
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'station.Connected',
        makeDomainEvent('station.Connected', 'CS-001', {
          ocppProtocol: 'ocpp2.1',
          stationDbId: 'sta_direct00001',
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(3);
    });

    it('skips if station not found in DB', async () => {
      await setup();

      setupSqlResults(
        [], // resolveStationId returns empty
      );

      await eventBus.emit('station.Connected', makeDomainEvent('station.Connected', 'UNKNOWN', {}));

      // Only the lookup call should have been made
      expect(sqlCalls.length).toBe(1);
    });

    it('sends queued commands and refreshes the screen when the station is ready', async () => {
      await setup();

      setupSqlResults(
        [], // expire superseded screen and cost commands
        [
          {
            id: 7,
            command_id: 'cmd-queued',
            action: 'CostUpdated',
            payload: { totalCost: 1.5, transactionId: 'tx-1' },
            version: 'ocpp2.1',
          },
        ], // offline command queue drain
        [], // UPDATE offline_command_queue SET status = 'sent'
        [], // no active maintenance event
      );

      await eventBus.emit(
        'station.Ready',
        makeDomainEvent('station.Ready', 'CS-READY', {
          ocppProtocol: 'ocpp2.1',
          stationDbId: 'sta_ready_test1',
        }),
      );

      const channels = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0],
      );
      expect(channels).toContain('ocpp_commands');
      expect(channels).toContain('station_message_refresh');
      // Superseded screen and cost commands are expired before the queue is read.
      const collapse = sqlCalls.findIndex((c) => c.strings.join('?').includes('rn > 1'));
      const drain = sqlCalls.findIndex((c) =>
        c.strings.join('?').includes("status = 'pending' AND expires_at"),
      );
      expect(collapse).toBeGreaterThanOrEqual(0);
      expect(collapse).toBeLessThan(drain);
    });

    it('does not send queued commands when the WebSocket opens', async () => {
      await setup();

      setupSqlResults(
        [{}], // UPDATE charging_stations
        [{}], // INSERT connection_logs
        [], // SELECT evse_id FROM evses
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'station.Connected',
        makeDomainEvent('station.Connected', 'CS-OPEN', {
          ocppProtocol: 'ocpp2.1',
          stationDbId: 'sta_open_test1',
        }),
      );

      const channels = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0],
      );
      expect(channels).not.toContain('ocpp_commands');
      expect(channels).not.toContain('station_message_refresh');
      expect(channels).not.toContain('maintenance_fanout');
    });

    it('publishes a maintenance re-assert when the station is ready under an active event', async () => {
      await setup();

      setupSqlResults(
        [], // expire superseded screen and cost commands
        [], // offline command queue drain
        [{ id: 'mne_maint1' }], // active maintenance event covering this station
      );

      await eventBus.emit(
        'station.Ready',
        makeDomainEvent('station.Ready', 'CS-MAINT', {
          ocppProtocol: 'ocpp1.6',
          stationDbId: 'sta_maint_test1',
        }),
      );

      const fanoutCall = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => c[0] === 'maintenance_fanout',
      );
      expect(fanoutCall).toBeDefined();
      const payload = JSON.parse(fanoutCall?.[1] as string) as Record<string, unknown>;
      expect(payload.eventId).toBe('mne_maint1');
      expect(payload.phase).toBe('reassert');
      expect(payload.stationDbIds).toEqual(['sta_maint_test1']);
      expect(typeof payload.nonce).toBe('string');
    });

    it('does not publish a maintenance re-assert when no active event covers the station', async () => {
      await setup();

      setupSqlResults(
        [], // expire superseded screen and cost commands
        [], // offline command queue drain
        [], // no active maintenance event
      );

      await eventBus.emit(
        'station.Ready',
        makeDomainEvent('station.Ready', 'CS-NOMAINT', {
          ocppProtocol: 'ocpp1.6',
          stationDbId: 'sta_nomaint_test1',
        }),
      );

      const fanoutCall = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => c[0] === 'maintenance_fanout',
      );
      expect(fanoutCall).toBeUndefined();
    });

    it('logs port status transitions for existing EVSEs', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // UPDATE charging_stations
        [], // INSERT connection_logs
        [], // INSERT port_status_log ... SELECT FROM evses
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'station.Connected',
        makeDomainEvent('station.Connected', 'CS-001', { ocppProtocol: 'ocpp2.1' }),
      );

      // One statement logs every EVSE of the station, so a retry cannot log a part twice.
      const portLogs = sqlCalls.filter((c) => c.strings.join('?').includes('port_status_log'));
      expect(portLogs).toHaveLength(1);
      expect(portLogs[0]?.strings.join('?')).toMatch(
        /SELECT \?, evse_id, 'unavailable', 'available', now\(\)\s+FROM evses WHERE station_id = \?/,
      );
    });
  });

  describe('station.Disconnected', () => {
    it('sets station offline and inserts connection log', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // UPDATE charging_stations
        [], // INSERT connection_logs
        [], // SELECT evse_id, status FROM evses
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'station.Disconnected',
        makeDomainEvent('station.Disconnected', 'CS-001', {}),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(4);
    });

    it('skips if station not found', async () => {
      await setup();
      setupSqlResults([]);

      await eventBus.emit(
        'station.Disconnected',
        makeDomainEvent('station.Disconnected', 'UNKNOWN', {}),
      );

      expect(sqlCalls.length).toBe(1);
    });

    it('dispatches reservation.StationFaulted notification when station disconnects with active reservations', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // UPDATE charging_stations
        [], // INSERT connection_logs
        [], // SELECT connectors JOIN evses
        [{ site_id: null }], // resolveSiteId
        [{ id: 'res_001', driver_id: 'drv_001' }], // SELECT reservations
      );

      await eventBus.emit(
        'station.Disconnected',
        makeDomainEvent('station.Disconnected', 'CS-001', {}),
      );

      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'reservation.StationFaulted',
        'drv_001',
        { reservationId: 'res_001', stationId: 'CS-001' },
        expect.anything(),
        expect.anything(),
      );
    });

    it('does not dispatch notification when disconnected station has no active reservations', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // UPDATE charging_stations
        [], // INSERT connection_logs
        [], // SELECT connectors JOIN evses
        [{ site_id: null }], // resolveSiteId
        [], // SELECT reservations (empty)
      );

      await eventBus.emit(
        'station.Disconnected',
        makeDomainEvent('station.Disconnected', 'CS-001', {}),
      );

      expect(mockDispatchDriver).not.toHaveBeenCalledWith(
        expect.anything(),
        'reservation.StationFaulted',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('does not dispatch notification when reservation has no driver', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // UPDATE charging_stations
        [], // INSERT connection_logs
        [], // SELECT connectors JOIN evses
        [{ site_id: null }], // resolveSiteId
        [{ id: 'res_002', driver_id: null }], // SELECT reservations (driver_id is null)
      );

      await eventBus.emit(
        'station.Disconnected',
        makeDomainEvent('station.Disconnected', 'CS-001', {}),
      );

      expect(mockDispatchDriver).not.toHaveBeenCalledWith(
        expect.anything(),
        'reservation.StationFaulted',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('ocpp.BootNotification', () => {
    it('updates firmware/model/serial on station', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ onboarding_status: 'accepted' }], // SELECT onboarding_status
        [], // UPDATE charging_stations
        [{ site_id: 'site-1' }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.BootNotification',
        makeDomainEvent('ocpp.BootNotification', 'CS-001', {
          firmwareVersion: '2.0',
          model: 'TestModel',
          serialNumber: 'SN-001',
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('ocpp.Heartbeat', () => {
    it('updates last_heartbeat', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // UPDATE charging_stations
      );

      await eventBus.emit('ocpp.Heartbeat', makeDomainEvent('ocpp.Heartbeat', 'CS-001', {}));

      expect(sqlCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // A station becomes free for a watching driver through many inputs, not only
  // a connector status. Every projection that can free a station checks the
  // watches with the shared driver availability rule (findDueStationWatch) and
  // publishes the signal; the worker claim makes repeated signals one alert.
  describe('station watch alerts', () => {
    let watchDue = true;
    let availabilityChanges = true;

    function routeWatch(): void {
      sqlRoute = (text) => {
        if (text.includes('FROM charging_stations WHERE station_id')) {
          return [{ id: 'sta_000000000001' }];
        }
        if (text.includes('SELECT id FROM evses WHERE station_id')) {
          return [{ id: 'evs_000000000001' }];
        }
        if (text.includes('AS previous_status')) {
          return [{ previous_status: 'unavailable', applied: true }];
        }
        if (text.includes('SET availability')) {
          return availabilityChanges ? [{ id: 'sta_000000000001' }] : [];
        }
        if (text.includes('FROM station_watches w')) {
          return watchDue ? [{ station_id: 'CS-001' }] : [];
        }
        if (text.includes('SELECT onboarding_status')) return [{ onboarding_status: 'accepted' }];
        if (text.includes('UPDATE reservations')) {
          return [{ id: 'res_1', driver_id: null, station_id: 'sta_000000000001' }];
        }
        return [];
      };
    }

    function watchSignals(): unknown[][] {
      return (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'station_watch_available',
      );
    }

    beforeEach(() => {
      watchDue = true;
      availabilityChanges = true;
    });

    it('checks the watches with the shared rule when a connector becomes available', async () => {
      await setup();
      routeWatch();
      const { availableEvseCountSql } = await vi.importActual<
        typeof import('../../../database/src/lib/driver-availability.js')
      >('../../../database/src/lib/driver-availability.js');
      const available = (): DomainEvent =>
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 1,
          connectorId: 1,
          connectorStatus: 'Available',
        });

      // Not free by the rule (for example disabled): no signal.
      watchDue = false;
      await eventBus.emit('ocpp.StatusNotification', available());
      const check = sqlCalls.find((c) => c.strings.join('?').includes('FROM station_watches w'));
      expect(check?.values).toContain(availableEvseCountSql('cs'));
      expect(watchSignals()).toHaveLength(0);

      watchDue = true;
      await eventBus.emit('ocpp.StatusNotification', available());
      expect(mockPubSub.publish).toHaveBeenCalledWith(
        'station_watch_available',
        JSON.stringify({ stationId: 'CS-001' }),
      );
    });

    it('checks the watches when the station reports itself available (EVSE 0)', async () => {
      await setup();
      routeWatch();
      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 0,
          connectorId: 0,
          connectorStatus: 'Available',
        }),
      );
      expect(watchSignals()).toHaveLength(1);
    });

    it('checks the watches when the station comes back online', async () => {
      await setup();
      routeWatch();
      await eventBus.emit(
        'station.Connected',
        makeDomainEvent('station.Connected', 'CS-001', { ocppProtocol: 'ocpp2.1' }),
      );
      expect(watchSignals()).toHaveLength(1);
    });

    it('checks the watches when a firmware install finishes', async () => {
      await setup();
      routeWatch();
      await eventBus.emit(
        'ocpp.FirmwareStatusNotification',
        makeDomainEvent('ocpp.FirmwareStatusNotification', 'CS-001', { status: 'Installed' }),
      );
      expect(watchSignals()).toHaveLength(1);
    });

    it('does not check the watches when a firmware status changes no availability', async () => {
      await setup();
      routeWatch();
      availabilityChanges = false;
      await eventBus.emit(
        'ocpp.FirmwareStatusNotification',
        makeDomainEvent('ocpp.FirmwareStatusNotification', 'CS-001', { status: 'Installed' }),
      );
      expect(sqlCalls.some((c) => c.strings.join('?').includes('FROM station_watches w'))).toBe(
        false,
      );
    });

    it('checks the watches when a reboot ends a firmware install', async () => {
      await setup();
      routeWatch();
      await eventBus.emit(
        'ocpp.BootNotification',
        makeDomainEvent('ocpp.BootNotification', 'CS-001', {
          status: 'Accepted',
          firmwareVersion: '1.0',
          model: 'M',
          serialNumber: 'S',
        }),
      );
      expect(watchSignals()).toHaveLength(1);
    });

    it('checks the watches when the station expires or removes a reservation', async () => {
      await setup();
      routeWatch();
      for (const reservationUpdateStatus of ['Expired', 'Removed']) {
        await eventBus.emit(
          'ocpp.ReservationStatusUpdate',
          makeDomainEvent('ocpp.ReservationStatusUpdate', 'CS-001', {
            reservationId: 7,
            reservationUpdateStatus,
          }),
        );
      }
      expect(watchSignals()).toHaveLength(2);
    });
  });

  describe('ocpp.StatusNotification', () => {
    it('auto-creates EVSE when not found', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // SELECT evses (not found)
        [{ id: 'evs_000000000001' }], // INSERT evses RETURNING id
        [{ id: 'con_000000000001' }], // INSERT connectors RETURNING id
        [], // INSERT port_status_log
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 1,
          connectorId: 1,
          connectorStatus: 'Available',
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(5);
    });

    it('updates existing EVSE and creates missing connector', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'evs_000000000001' }], // SELECT evses (found)
        [], // guarded UPDATE connectors (not found)
        [{ id: 'con_000000000001' }], // INSERT connectors RETURNING id
        [], // INSERT port_status_log
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
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

    it('updates existing connector', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'evs_000000000001' }], // SELECT evses
        [{ previous_status: 'available', applied: true }], // guarded UPDATE connectors
        [], // INSERT port_status_log
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
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

    it('maps unknown status to unavailable', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // SELECT evses (not found)
        [{ id: 'evs_000000000001' }], // INSERT evses
        [{ id: 'con_000000000001' }], // INSERT connectors RETURNING id
        [], // INSERT port_status_log
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 1,
          connectorId: 1,
          connectorStatus: 'UnknownStatus',
        }),
      );

      // Should still process without error
      expect(sqlCalls.length).toBeGreaterThanOrEqual(5);
    });

    it('sets idle_started_at on active session when 1.6 SuspendedEV status received', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'evse_000000000001' }], // SELECT evses (found)
        [{ previous_status: 'charging', applied: true }], // guarded UPDATE connectors (prevRows)
        [], // INSERT port_status_log
        [{ site_id: null }], // resolveSiteId
        [], // UPDATE charging_sessions SET idle_started_at
        [], // SELECT active session for notification dispatch (no session found)
      );

      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 1,
          connectorId: 1,
          connectorStatus: 'SuspendedEV',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      const idleCalls = sqlCalls.filter((c) => c.strings.join('').includes('SET idle_started_at'));
      expect(idleCalls.length).toBe(1);
    });

    it('dispatches IdlingStarted notification on 1.6 SuspendedEV', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'evse_000000000001' }], // SELECT evses (found)
        [{ previous_status: 'charging', applied: true }], // guarded UPDATE connectors (prevRows)
        [], // INSERT port_status_log
        [], // SELECT charging_stations FOR UPDATE (availability lock)
        [], // UPDATE charging_stations (connector fault reconciliation)
        [{ site_id: null }], // resolveSiteId
        [], // UPDATE charging_sessions SET idle_started_at
        [{ id: 'session-1', transaction_id: 'tx-1' }], // SELECT active session
        [
          {
            driver_id: 'drv-1',
            idle_started_at: '2024-01-01T01:00:00Z',
            idle_fee_price_per_minute: '0.10',
            tax_rate: '0.19',
            price_display: 'gross',
            currency: 'USD',
            site_name: 'Test Site',
          },
        ], // dispatchIdlingNotification: the claim
      );

      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 1,
          connectorId: 1,
          connectorStatus: 'SuspendedEV',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'session.IdlingStarted',
        'drv-1',
        expect.objectContaining({
          stationId: 'CS-001',
          transactionId: 'tx-1',
          idleFeePricePerMinute: '0.10',
          idleFeeFormatted: formatsTo('$0.119'),
          idleFeeIncludesTax: true,
          taxRatePercent: formatsTo('19'),
          currency: 'USD',
        }),
        ['/mock/templates'],
        expect.anything(),
      );
    });

    it('notifies once per idle period: no notification when the period was already claimed', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'evse_000000000001' }], // SELECT evses (found)
        [{ previous_status: 'charging', applied: true }], // guarded UPDATE connectors (prevRows)
        [], // INSERT port_status_log
        [], // SELECT charging_stations FOR UPDATE (availability lock)
        [], // UPDATE charging_stations (connector fault reconciliation)
        [{ site_id: null }], // resolveSiteId
        [], // UPDATE charging_sessions SET idle_started_at (already set)
        [{ id: 'session-1', transaction_id: 'tx-1' }], // SELECT active session
        [], // dispatchIdlingNotification: claim found idle_notified_at = idle_started_at
      );

      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 1,
          connectorId: 1,
          connectorStatus: 'SuspendedEV',
          timestamp: '2024-01-01T01:05:00Z',
        }),
      );

      const claim = sqlCalls.find((c) =>
        c.strings.join('').includes('idle_notified_at = COALESCE'),
      );
      expect(claim?.strings.join('')).toContain(
        'idle_notified_at IS DISTINCT FROM COALESCE(idle_started_at',
      );
      expect(mockDispatchDriver).not.toHaveBeenCalledWith(
        expect.anything(),
        'session.IdlingStarted',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('shows the idle fee excluding tax when the driver follows a net company setting', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'evse_000000000001' }], // SELECT evses (found)
        [{ previous_status: 'charging', applied: true }], // guarded UPDATE connectors (prevRows)
        [], // INSERT port_status_log
        [], // SELECT charging_stations FOR UPDATE (availability lock)
        [], // UPDATE charging_stations (connector fault reconciliation)
        [{ site_id: null }], // resolveSiteId
        [], // UPDATE charging_sessions SET idle_started_at
        [{ id: 'session-1', transaction_id: 'tx-1' }], // SELECT active session
        [
          {
            driver_id: 'drv-1',
            idle_started_at: '2024-01-01T01:00:00Z',
            idle_fee_price_per_minute: '0.10',
            tax_rate: '0.19',
            price_display: null,
            currency: 'USD',
            site_name: 'Test Site',
          },
        ], // dispatchIdlingNotification: the claim
      );

      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 1,
          connectorId: 1,
          connectorStatus: 'SuspendedEV',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'session.IdlingStarted',
        'drv-1',
        expect.objectContaining({
          stationId: 'CS-001',
          transactionId: 'tx-1',
          idleFeePricePerMinute: '0.10',
          idleFeeFormatted: formatsTo('$0.10'),
          idleFeeIncludesTax: false,
          taxRatePercent: formatsTo('19'),
          currency: 'USD',
        }),
        ['/mock/templates'],
        expect.anything(),
      );
    });

    it.each([
      ['no idle fee', null],
      ['an idle fee of 0', '0.00'],
    ])('sends no idle fee for a tariff with %s', async (_label, idleFee) => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'evse_000000000001' }], // SELECT evses (found)
        [{ previous_status: 'charging', applied: true }], // guarded UPDATE connectors (prevRows)
        [], // INSERT port_status_log
        [], // SELECT charging_stations FOR UPDATE (availability lock)
        [], // UPDATE charging_stations (connector fault reconciliation)
        [{ site_id: null }], // resolveSiteId
        [], // UPDATE charging_sessions SET idle_started_at
        [{ id: 'session-1', transaction_id: 'tx-1' }], // SELECT active session
        [
          {
            driver_id: 'drv-1',
            idle_started_at: '2024-01-01T01:00:00Z',
            idle_fee_price_per_minute: idleFee,
            tax_rate: '0.19',
            price_display: 'gross',
            currency: 'USD',
            site_name: 'Test Site',
          },
        ], // dispatchIdlingNotification: the claim
      );

      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 1,
          connectorId: 1,
          connectorStatus: 'SuspendedEV',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      // Both variables are empty (falsy in Handlebars), so a saved template
      // that tests {{#if idleFeePricePerMinute}} announces no idle fee.
      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'session.IdlingStarted',
        'drv-1',
        expect.objectContaining({
          idleFeePricePerMinute: '',
          idleFeeFormatted: '',
        }),
        ['/mock/templates'],
        expect.anything(),
      );
    });

    it('does NOT set idle_started_at for OCPP 2.1 Occupied status', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'evse_000000000001' }], // SELECT evses (found)
        [{ previous_status: 'charging', applied: true }], // guarded UPDATE connectors (prevRows)
        [], // INSERT port_status_log
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 1,
          connectorId: 1,
          connectorStatus: 'Occupied',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      const idleCalls = sqlCalls.filter((c) => c.strings.join('').includes('SET idle_started_at'));
      expect(idleCalls.length).toBe(0);
    });

    it('clears idle_started_at when 1.6 Charging status received', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'evse_000000000001' }], // SELECT evses (found)
        [{ previous_status: 'suspended_ev', applied: true }], // guarded UPDATE connectors (prevRows)
        [], // INSERT port_status_log
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
        [], // UPDATE charging_sessions (clear idle)
      );

      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 1,
          connectorId: 1,
          connectorStatus: 'Charging',
          timestamp: '2024-01-01T01:05:00Z',
        }),
      );

      const idleClearCalls = sqlCalls.filter((c) => {
        const joined = c.strings.join('');
        return joined.includes('idle_started_at = NULL') && joined.includes('idle_minutes');
      });
      expect(idleClearCalls.length).toBe(1);
    });

    it('publishes station_message_refresh on connector status change for OCPP 2.1 stations', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'evse_000000000001' }], // SELECT evses (found)
        [{ previous_status: 'available', applied: true }], // guarded UPDATE connectors (prev)
        [], // INSERT port_status_log
        [], // SELECT charging_stations FOR UPDATE (availability lock)
        [], // UPDATE charging_stations (connector fault reconciliation)
        [{ site_id: null }], // resolveSiteId
        [{ ocpp_protocol: 'ocpp2.1' }], // SELECT ocpp_protocol for station_message_refresh
      );

      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 1,
          connectorId: 1,
          connectorStatus: 'Occupied',
        }),
      );

      const refreshCalls = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'station_message_refresh',
      );
      expect(refreshCalls.length).toBe(1);
      expect(refreshCalls[0]?.[1]).toContain('CS-001');
      expect(refreshCalls[0]?.[1]).toContain('ocpp2.1');
    });

    it('does NOT publish station_message_refresh when connector status unchanged', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'evse_000000000001' }], // SELECT evses (found)
        [{ previous_status: 'available', applied: true }], // guarded UPDATE connectors (prev = same as new)
        [], // INSERT port_status_log
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 1,
          connectorId: 1,
          connectorStatus: 'Available',
        }),
      );

      const refreshCalls = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'station_message_refresh',
      );
      expect(refreshCalls.length).toBe(0);
    });

    it('publishes station_message_refresh for OCPP 1.6 stations (Idle screen via DataTransfer)', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'evse_000000000001' }], // SELECT evses (found)
        [{ previous_status: 'available', applied: true }], // guarded UPDATE connectors (prev)
        [], // INSERT port_status_log
        [], // SELECT charging_stations FOR UPDATE (availability lock)
        [], // UPDATE charging_stations (connector fault reconciliation)
        [{ site_id: null }], // resolveSiteId
        [{ ocpp_protocol: 'ocpp1.6' }], // SELECT ocpp_protocol for station_message_refresh
      );

      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 1,
          connectorId: 1,
          connectorStatus: 'Occupied',
        }),
      );

      const refreshCalls = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'station_message_refresh',
      );
      expect(refreshCalls.length).toBe(1);
      expect(JSON.parse(refreshCalls[0]?.[1] as string)).toMatchObject({
        stationOcppId: 'CS-001',
        ocppProtocol: 'ocpp1.6',
      });
    });

    it('publishes station_message_refresh for Faulted transitions on OCPP 2.1', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'evse_000000000001' }], // SELECT evses (found)
        [{ previous_status: 'available', applied: true }], // guarded UPDATE connectors (prev)
        [], // INSERT port_status_log
        [], // SELECT charging_stations FOR UPDATE (availability lock)
        [], // UPDATE charging_stations (connector fault reconciliation)
        [{ site_id: null }], // resolveSiteId
        [{ ocpp_protocol: 'ocpp2.1' }], // SELECT ocpp_protocol
      );

      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 1,
          connectorId: 1,
          connectorStatus: 'Faulted',
        }),
      );

      const refreshCalls = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'station_message_refresh',
      );
      expect(refreshCalls.length).toBe(1);
    });

    it('publishes station_message_refresh on auto-create EVSE branch for OCPP 2.1', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [], // SELECT evses (not found)
        [{ id: 'evs_000000000001' }], // INSERT evses RETURNING id
        [{ id: 'con_000000000001' }], // INSERT connectors RETURNING id
        [], // INSERT port_status_log
        [], // SELECT charging_stations FOR UPDATE (availability lock)
        [], // UPDATE charging_stations (connector fault reconciliation)
        [{ site_id: null }], // resolveSiteId
        [{ ocpp_protocol: 'ocpp2.1' }], // SELECT ocpp_protocol (auto-discovery GetBaseReport branch)
        [{ ocpp_protocol: 'ocpp2.1' }], // SELECT ocpp_protocol (station_message_refresh branch)
      );

      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 1,
          connectorId: 1,
          connectorStatus: 'Available',
        }),
      );

      const refreshCalls = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'station_message_refresh',
      );
      expect(refreshCalls.length).toBe(1);
    });
  });

  describe('ocpp.StatusNotification ordering', () => {
    it('passes the station timestamp to the guarded connector write', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'evse_000000000001' }], // SELECT evses
        [{ previous_status: 'available', applied: true }], // guarded UPDATE connectors
      );

      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 1,
          connectorId: 1,
          connectorStatus: 'Occupied',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      const write = sqlCalls.find((c) => c.strings.join('').includes('UPDATE connectors c'));
      expect(write?.values).toContainEqual(new Date('2024-01-01T01:00:00Z'));
    });

    it('an older connector report changes nothing and sends nothing', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'evse_000000000001' }], // SELECT evses
        [{ previous_status: 'available', applied: false }], // guard rejected the report
      );

      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 1,
          connectorId: 1,
          connectorStatus: 'SuspendedEV',
          timestamp: '2024-01-01T00:00:00Z',
        }),
      );

      const joined = sqlCalls.map((c) => c.strings.join(''));
      expect(joined.some((q) => q.includes('INSERT INTO port_status_log'))).toBe(false);
      expect(joined.some((q) => q.includes('SET idle_started_at'))).toBe(false);
      expect(mockPubSub.publish).not.toHaveBeenCalled();
    });

    it('an older station-level report changes nothing and sends nothing', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ previous_status: 'available', applied: false }], // guard rejected the report
      );

      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 0,
          connectorId: 0,
          connectorStatus: 'Unavailable',
          timestamp: '2024-01-01T00:00:00Z',
        }),
      );

      const write = sqlCalls[1];
      expect(write?.strings.join('')).toContain('reported_status_at');
      expect(write?.values).toContainEqual(new Date('2024-01-01T00:00:00Z'));
      expect(sqlCalls).toHaveLength(2);
      expect(mockPubSub.publish).not.toHaveBeenCalled();
    });

    it('a report without a timestamp is applied with a NULL timestamp', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ previous_status: 'available', applied: true }], // guarded station write
      );

      await eventBus.emit(
        'ocpp.StatusNotification',
        makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 0,
          connectorId: 0,
          connectorStatus: 'Unavailable',
        }),
      );

      const write = sqlCalls[1];
      expect(write?.values.some((v) => v instanceof Date)).toBe(false);
      expect(sqlCalls.some((c) => c.strings.join('').includes('INSERT INTO port_status_log'))).toBe(
        true,
      );
    });
  });

  describe('ocpp.TransactionEvent', () => {
    it('creates session on Started event', async () => {
      await setup();

      // Payload below has no idToken, so the eager OCPI roaming SELECT
      // (skipped when earlyIdToken is null) does not consume a result.
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'session-1' }], // INSERT charging_sessions ON CONFLICT DO UPDATE RETURNING id
        [], // INSERT transaction_events
        // free_vend check now goes through isSiteFreeVendEnabledByStation (mocked) -- no SQL call
        [{ is_roaming: false }], // SELECT is_roaming
        [{ driver_id: null }], // SELECT driver_id (no driver yet)
        // resolveTariff: no driver group
        [], // station pricing group
        [], // default pricing group
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify (session.started)
        [], // pg_notify (guest notification)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-1',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(5);
    });

    it('does not remember an EVSE that did not exist yet when a Started arrived', async () => {
      // A Started projected before the station lane created its EVSE finds no EVSE. The
      // next Started on that EVSE must look it up again, not reuse the miss for minutes.
      await setup();
      let evseExists = false;
      sqlRoute = (text) => {
        if (text.includes('FROM charging_stations WHERE station_id')) {
          return [{ id: 'sta_000000000001' }];
        }
        if (text.includes('SELECT id FROM evses WHERE station_id')) {
          return evseExists ? [{ id: 'evs_000000000001' }] : [];
        }
        if (text.includes('INSERT INTO charging_sessions')) return [{ id: 'session-x' }];
        return [];
      };
      const started = (transactionId: string): DomainEvent =>
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId,
          evseId: 1,
          connectorId: 1,
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
        });
      const sessionInsertEvse = (): unknown => {
        const inserts = sqlCalls.filter((c) =>
          c.strings.join('?').includes('INSERT INTO charging_sessions'),
        );
        return inserts[inserts.length - 1]?.values[2];
      };

      await eventBus.emit('ocpp.TransactionEvent', started('tx-before-evse'));
      expect(sessionInsertEvse()).toBeNull();

      evseExists = true;
      await eventBus.emit('ocpp.TransactionEvent', started('tx-after-evse'));
      expect(sessionInsertEvse()).toBe('evs_000000000001');
    });

    it('ends an older active session on the EVSE through a CSMS end, not a fault', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'evs_000000000001' }], // resolveEvseUuid
        [{ id: 'session-new' }], // INSERT charging_sessions RETURNING id
        [{ id: 'session-old' }], // SELECT older active sessions on the EVSE
        [
          {
            transaction_id: 'tx-old',
            updated_at: new Date('2023-12-31T23:30:00Z'),
            station_ocpp_id: 'CS-001',
            next_seq_no: 4,
          },
        ], // requestCsmsSessionEnd claim
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-new',
          evseId: 1,
          connectorId: 1,
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
        }),
      );

      const claim = sqlCalls.find((c) => c.strings.join('?').includes('SET stopped_reason = ?'));
      expect(claim?.strings.join('?')).toContain("cs.status = 'active'");
      expect(claim?.values).toContain('Superseded');
      expect(claim?.values).toContain('session-old');
      // Never faulted at cost 0.
      expect(sqlCalls.some((c) => c.strings.join('?').includes("SET status = 'faulted'"))).toBe(
        false,
      );
      expect(eventBus.publish).toHaveBeenCalledWith({
        eventType: 'session.EndedByCsms',
        aggregateType: 'Transaction',
        aggregateId: 'tx-old',
        payload: {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-old',
          seqNo: 4,
          triggerReason: 'AbnormalCondition',
          timestamp: '2023-12-31T23:30:00.000Z',
          stoppedReason: 'Superseded',
        },
      });
    });

    it('runs the normal end and settlement for a CSMS end of an active session', async () => {
      await setup();
      setupSqlResults(
        [{ status: 'active' }], // status check
        [{ id: 'sta_000000000001' }], // resolveStationId; later queries return []
      );
      await eventBus.emit(
        'session.EndedByCsms',
        makeDomainEvent('session.EndedByCsms', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-old',
          seqNo: 4,
          triggerReason: 'AbnormalCondition',
          timestamp: '2023-12-31T23:30:00Z',
          stoppedReason: 'Superseded',
        }),
      );
      const ended = sqlCalls.find((c) =>
        c.strings.join('?').includes('stopped_reason = COALESCE(stopped_reason, ?)'),
      );
      expect(ended?.values).toContain('completed');
      expect(ended?.values).toContain('Superseded');
      // The settlement subscriber's session lookup ran too.
      expect(
        sqlCalls.some((c) => c.strings.join('?').includes('cs2.station_id AS station_ocpp_id')),
      ).toBe(true);
    });

    it('leaves a session faulted or failed meanwhile alone (P5)', async () => {
      await setup();
      setupSqlResults([{ status: 'faulted' }]);
      await eventBus.emit(
        'session.EndedByCsms',
        makeDomainEvent('session.EndedByCsms', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-old',
          seqNo: 4,
          triggerReason: 'AbnormalCondition',
          timestamp: '2023-12-31T23:30:00Z',
          stoppedReason: 'GhostRecovered',
        }),
      );
      expect(sqlCalls).toHaveLength(1);
      // The session is looked up by station and transaction id (N4).
      expect(sqlCalls[0]?.strings.join('?')).toContain(
        'WHERE st.station_id = ? AND cs.transaction_id = ?',
      );
      expect(sqlCalls[0]?.values).toEqual(['CS-001', 'tx-old']);
      expect(mockSettleSessionPayment).not.toHaveBeenCalled();
    });

    it('falls back to the only connector on the EVSE when the reported one does not match', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'evs_000000000001' }], // resolveEvseUuid
        [{ id: 'session-1' }], // INSERT charging_sessions RETURNING id
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-fallback',
          evseId: 1,
          connectorId: 2,
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
        }),
      );

      const insert = sqlCalls.find((c) =>
        c.strings.join('?').includes('INSERT INTO charging_sessions'),
      );
      const text = insert?.strings.join('?') ?? '';
      expect(insert?.values).toContain(2);
      // The single-connector fallback applies whether or not a connector was reported.
      expect(text).toContain('c.connector_id = ?');
      expect(text).toMatch(
        /OR \(SELECT count\(\*\) FROM connectors c2 WHERE c2\.evse_id = \?\) = 1/,
      );
      expect(text).not.toContain('IS NULL');
    });

    it('inserts NULL meter_start when payload omits meterStart (OCPP 2.1)', async () => {
      // OCPP 2.1 TransactionEvent Started has no meterStart field. The session
      // row must be inserted with NULL so the MeterValues handler can capture
      // the first reading; using 0 would defeat that guard and produce inflated
      // energy values against the station's lifetime register.
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000001' }],
        [],
        [{ id: 'session-1' }],
        [],
        [{ driver_id: null }],
        [],
        [],
        [{ site_id: null }],
        [],
        [],
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-meter-null',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
        }),
      );

      const insertCall = sqlCalls.find((c) =>
        c.strings.join('').includes('INSERT INTO charging_sessions'),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall?.values).toContain(null);
      expect(insertCall?.values).not.toContain(0);
    });

    it('inserts numeric meter_start from payload.meterStart (OCPP 1.6)', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000001' }],
        [],
        [{ id: 'session-1' }],
        [],
        [{ driver_id: null }],
        [],
        [],
        [{ site_id: null }],
        [],
        [],
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-meter-1234',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
          meterStart: 1234,
        }),
      );

      const insertCall = sqlCalls.find((c) =>
        c.strings.join('').includes('INSERT INTO charging_sessions'),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall?.values).toContain(1234);
    });

    it('resolves driver from idToken on Started', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT charging_sessions
        [{ id: 'session-1' }], // SELECT id
        [], // INSERT transaction_events
        [{ driver_id: null }], // SELECT driver_id
        [{ driver_id: 'driver-1' }], // SELECT driver_id FROM driver_tokens
        [], // UPDATE charging_sessions SET driver_id
        // resolveTariff: driver-specific
        [
          {
            id: 'tariff-1',
            price_per_kwh: '0.30',
            price_per_minute: null,
            price_per_session: null,
            tax_rate: null,
          },
        ],
        [], // UPDATE charging_sessions SET tariff_id
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
        [], // pg_notify (guest)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-2',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
          idToken: 'rfid-123',
          tokenType: 'ISO14443',
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(8);
    });

    it('inserts event and notifies driver on Updated', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'session-1' }], // SELECT id FROM charging_sessions
        [], // INSERT transaction_events
        [{ site_id: null }], // resolveSiteId
        // notifyOcpiPush skipped (isRoamingEnabled returns false)
        [
          {
            driver_id: 'driver-1',
            energy_delivered_wh: 5000,
            current_cost_cents: 150,
            tariff_tax_rate: null,
            currency: 'USD',
            started_at: '2024-01-01T00:00:00Z',
          },
        ],
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Updated',
          stationId: 'CS-001',
          transactionId: 'tx-1',
          seqNo: 1,
          triggerReason: 'MeterValuePeriodic',
          timestamp: '2024-01-01T00:30:00Z',
        }),
      );

      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'session.Updated',
        'driver-1',
        // No tariff tax rate: the templates do not label the cost "incl. tax".
        expect.objectContaining({ transactionId: 'tx-1', costIncludesTax: false }),
        ['/mock/templates'],
        expect.anything(),
      );
    });

    it('updates connector status from chargingState in Ended payload (e.g. EVConnected after RemoteStop)', async () => {
      // Verifies the Ended-handler chargingState mapping that handles OCPP 2.1 stations
      // which encode the post-stop state in TransactionEvent (Ended) instead of sending a
      // follow-up StatusNotification. Previously the connector badge stayed on 'charging'.
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // SELECT payment_records (no failed payment)
        [], // UPDATE charging_sessions SET status=completed
        [
          {
            id: 'session-1',
            evse_id: 'evs_000000000001',
            tariff_id: null,
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 5000,
            currency: 'USD',
          },
        ], // SELECT session row (now includes evse_id)
        [], // UPDATE connectors SET status = 'ev_connected'
        [{ site_id: null }], // resolveSiteId for connector notify
        [], // pg_notify station.status
        [], // INSERT transaction_events
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify (session.ended)
        [], // pg_notify (TransactionEnded)
        [
          {
            driver_id: null,
            energy_delivered_wh: 5000,
            final_cost_cents: null,
            currency: 'USD',
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ],
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-ended-charging-state',
          seqNo: 16,
          triggerReason: 'ChargingStateChanged',
          timestamp: '2024-01-01T01:00:00Z',
          stoppedReason: 'Remote',
          chargingState: 'EVConnected',
        }),
      );

      const updateConnectorCall = sqlCalls.find((c) => {
        const joined = c.strings.join('');
        return (
          joined.includes('UPDATE connectors') &&
          joined.includes('status') &&
          c.values.includes('ev_connected')
        );
      });
      expect(updateConnectorCall).toBeDefined();
      // Ordered by the TransactionEvent timestamp, like a status report.
      expect(updateConnectorCall?.strings.join('')).toContain('>= status_reported_at');
      expect(updateConnectorCall?.values).toContainEqual(new Date('2024-01-01T01:00:00Z'));
    });

    it('completes session and computes cost on Ended', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // SELECT payment_records (no failed payment)
        [], // UPDATE charging_sessions SET status=completed
        [
          {
            id: 'session-1',
            tariff_id: 'tariff-1',
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 10000,
            currency: 'USD',
            tariff_price_per_kwh: '0.30',
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
          },
        ], // SELECT session with snapshot columns
        [], // INSERT transaction_events
        [], // UPDATE session_tariff_segments SET ended_at
        [], // UPDATE charging_sessions SET final_cost_cents
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify (session.ended)
        [], // pg_notify (TransactionEnded)
        [
          {
            driver_id: 'driver-1',
            energy_delivered_wh: 10000,
            final_cost_cents: 1500,
            currency: 'USD',
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ],
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-1',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
          stoppedReason: 'Local',
        }),
      );

      // Priced once by the one cost assembly at the end, then stored with its split.
      expect(mockPriceSessionAt).toHaveBeenCalledWith(
        expect.anything(),
        'session-1',
        new Date('2024-01-01T01:00:00Z'),
        10000,
      );
      const finalUpdate = sqlCalls.find((c) => c.strings.join('').includes('final_cost_cents = '));
      expect(finalUpdate?.values.slice(0, 4)).toEqual([1500, 1500, 1500, 0]);
      expect(finalUpdate?.strings.join('')).toContain('cost_breakdown = ');
    });

    it('stores the cost the 2.1 handler sent the station when it differs from the priced cost', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // SELECT payment_records (no failed payment)
        [], // UPDATE charging_sessions SET status=completed
        [
          {
            id: 'session-1',
            status: 'completed',
            tariff_id: 'tariff-1',
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 10000,
            currency: 'EUR',
            tariff_tax_rate: '0.19',
          },
        ],
      );
      mockPriceSessionAt.mockResolvedValueOnce(costBreakdown(1190, 0.19, 190));

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-1',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
          stoppedReason: 'Local',
          finalCostCents: 1309,
        }),
      );

      const finalUpdate = sqlCalls.find((c) => c.strings.join('').includes('final_cost_cents = '));
      // 1309 charged at 19%: net 1100, tax 209. Components dropped.
      expect(finalUpdate?.values.slice(0, 4)).toEqual([1309, 1309, 1100, 209]);
      expect(finalUpdate?.values[4]).toMatchObject({ grossCents: 1309, components: null });
    });

    it('derives the final energy from meterStop on an OCPP 1.6 Ended event', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // SELECT payment_records (no failed payment)
        [], // UPDATE charging_sessions SET status=completed, energy from meterStop
        [
          {
            id: 'session-1',
            tariff_id: 'tariff-1',
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 1218,
            currency: 'EUR',
            tariff_price_per_kwh: '0.30',
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
          },
        ], // SELECT session with snapshot columns (energy after the UPDATE)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: '3',
          seqNo: 0,
          triggerReason: 'Local',
          timestamp: '2024-01-01T01:00:00Z',
          stoppedReason: 'Local',
          meterStop: 2909465,
        }),
      );

      const endUpdate = sqlCalls.find(
        (c) =>
          c.strings.join('').includes('UPDATE charging_sessions') &&
          c.strings.join('').includes('meter_stop = COALESCE'),
      );
      expect(endUpdate).toBeDefined();
      const endSql = endUpdate?.strings.join('?') ?? '';
      expect(endSql).toContain('energy_delivered_wh = CASE');
      expect(endSql).toContain('GREATEST(COALESCE(energy_delivered_wh, 0)');
      expect(endUpdate?.values.filter((v) => v === 2909465).length).toBeGreaterThanOrEqual(3);

      // Cost is priced with the energy of the session row read after the UPDATE.
      expect(mockPriceSessionAt).toHaveBeenCalledWith(
        expect.anything(),
        'session-1',
        new Date('2024-01-01T01:00:00Z'),
        1218,
      );
    });

    it('keeps the meter-derived energy when an Ended event has no meterStop', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // SELECT payment_records (no failed payment)
        [], // UPDATE charging_sessions SET status=completed
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-2',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
          stoppedReason: 'Local',
        }),
      );

      const endUpdate = sqlCalls.find(
        (c) =>
          c.strings.join('').includes('UPDATE charging_sessions') &&
          c.strings.join('').includes('meter_stop = COALESCE'),
      );
      expect(endUpdate).toBeDefined();
      // With meterStop null the CASE falls through to the existing energy.
      expect(endUpdate?.values.filter((v) => v === null).length).toBeGreaterThanOrEqual(3);
    });

    it('skips cost computation when no tariff on Ended', async () => {
      await setup();

      setupSqlResults(
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
          },
        ],
        [], // INSERT transaction_events
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
        [], // pg_notify TransactionEnded
        [
          {
            driver_id: null,
            energy_delivered_wh: 5000,
            final_cost_cents: null,
            currency: 'USD',
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ],
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-2',
          seqNo: 1,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
        }),
      );

      expect(mockPriceSessionAt).not.toHaveBeenCalled();
    });

    it('skips if station not found', async () => {
      await setup();
      setupSqlResults([]);

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-UNKNOWN',
          transactionId: 'tx-x',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
        }),
      );

      // resolveStationId + notification dispatch loop also fires
      expect(sqlCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('sets idle_started_at when chargingState is EVConnected on Updated', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'session-1' }], // SELECT id FROM charging_sessions
        [], // INSERT transaction_events
        [], // UPDATE idle_started_at (chargingState = EVConnected)
        [{ driver_id: null, site_name: null, guest_email: null }], // dispatchIdlingNotification: the claim (no driver, no guest)
        [{ site_id: null }], // resolveSiteId
        [{ driver_id: null }], // SELECT driver_id (no driver)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Updated',
          stationId: 'CS-001',
          transactionId: 'tx-1',
          seqNo: 1,
          triggerReason: 'ChargingStateChanged',
          timestamp: '2024-01-01T01:00:00Z',
          chargingState: 'EVConnected',
        }),
      );

      // Verify the idle_started_at UPDATE was issued
      const idleUpdateCall = sqlCalls.find((c) => {
        const joined = c.strings.join('');
        return joined.includes('idle_started_at') && joined.includes('idle_started_at IS NULL');
      });
      expect(idleUpdateCall).toBeDefined();
    });

    it('dispatches guest idling notification when guest email is present', async () => {
      await setup();
      // Guests follow the company setting.
      const { getCompanyPriceDisplay } = await import('@evtivity/database');
      vi.mocked(getCompanyPriceDisplay).mockResolvedValueOnce('gross');

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'session-1' }], // SELECT id FROM charging_sessions
        [], // INSERT transaction_events
        [], // UPDATE idle_started_at (chargingState = EVConnected)
        [
          {
            driver_id: null,
            idle_started_at: '2024-01-01T01:00:00Z',
            idle_fee_price_per_minute: '0.10',
            tax_rate: '0.19',
            price_display: null,
            currency: 'USD',
            site_name: 'Test Site',
            guest_email: 'guest@example.com',
          },
        ], // dispatchIdlingNotification: the claim (no driver)
        [{ site_id: null }], // resolveSiteId
        [{ driver_id: null }], // SELECT driver_id (no driver)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Updated',
          stationId: 'CS-001',
          transactionId: 'tx-1',
          seqNo: 1,
          triggerReason: 'ChargingStateChanged',
          timestamp: '2024-01-01T01:00:00Z',
          chargingState: 'EVConnected',
        }),
      );

      expect(mockDispatchSystem).toHaveBeenCalledWith(
        expect.anything(),
        'session.IdlingStarted',
        { email: 'guest@example.com' },
        expect.objectContaining({
          stationId: 'CS-001',
          transactionId: 'tx-1',
          idleFeePricePerMinute: '0.10',
          idleFeeFormatted: formatsTo('$0.119'),
          idleFeeIncludesTax: true,
          taxRatePercent: formatsTo('19'),
          currency: 'USD',
        }),
        ['/mock/templates'],
      );
    });

    it('shows guests the idle fee excluding tax when the company setting is net', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'session-1' }], // SELECT id FROM charging_sessions
        [], // INSERT transaction_events
        [], // UPDATE idle_started_at (chargingState = EVConnected)
        [
          {
            driver_id: null,
            idle_started_at: '2024-01-01T01:00:00Z',
            idle_fee_price_per_minute: '0.10',
            tax_rate: '0.19',
            price_display: null,
            currency: 'USD',
            site_name: 'Test Site',
            guest_email: 'guest@example.com',
          },
        ], // dispatchIdlingNotification: the claim (no driver)
        [{ site_id: null }], // resolveSiteId
        [{ driver_id: null }], // SELECT driver_id (no driver)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Updated',
          stationId: 'CS-001',
          transactionId: 'tx-1',
          seqNo: 1,
          triggerReason: 'ChargingStateChanged',
          timestamp: '2024-01-01T01:00:00Z',
          chargingState: 'EVConnected',
        }),
      );

      expect(mockDispatchSystem).toHaveBeenCalledWith(
        expect.anything(),
        'session.IdlingStarted',
        { email: 'guest@example.com' },
        expect.objectContaining({
          stationId: 'CS-001',
          transactionId: 'tx-1',
          idleFeePricePerMinute: '0.10',
          idleFeeFormatted: formatsTo('$0.10'),
          idleFeeIncludesTax: false,
          taxRatePercent: formatsTo('19'),
          currency: 'USD',
        }),
        ['/mock/templates'],
      );
    });

    it('accumulates idle_minutes when chargingState returns to Charging on Updated', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'session-1' }], // SELECT id FROM charging_sessions
        [], // INSERT transaction_events
        [], // UPDATE idle_minutes (chargingState = Charging, accumulate)
        [{ site_id: null }], // resolveSiteId
        [{ driver_id: null }], // SELECT driver_id
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Updated',
          stationId: 'CS-001',
          transactionId: 'tx-1',
          seqNo: 2,
          triggerReason: 'ChargingStateChanged',
          timestamp: '2024-01-01T01:30:00Z',
          chargingState: 'Charging',
        }),
      );

      // Verify the idle_minutes accumulation UPDATE was issued
      const accumulateCall = sqlCalls.find((c) => {
        const joined = c.strings.join('');
        return (
          joined.includes('idle_minutes') &&
          joined.includes('EXTRACT') &&
          joined.includes('idle_started_at IS NOT NULL')
        );
      });
      expect(accumulateCall).toBeDefined();
    });

    it('skips idle logic when no chargingState in Updated payload (OCPP 1.6)', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'session-1' }], // SELECT id FROM charging_sessions
        [], // INSERT transaction_events
        [{ site_id: null }], // resolveSiteId
        [{ driver_id: null }], // SELECT driver_id
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Updated',
          stationId: 'CS-001',
          transactionId: 'tx-1',
          seqNo: 1,
          triggerReason: 'MeterValuePeriodic',
          timestamp: '2024-01-01T00:30:00Z',
        }),
      );

      // No idle-related SQL calls should be issued
      const idleCalls = sqlCalls.filter((c) => {
        const joined = c.strings.join('');
        return joined.includes('SET idle_started_at') || joined.includes('SET idle_minutes');
      });
      expect(idleCalls.length).toBe(0);
    });

    it('includes idle_minutes in final cost calculation on Ended', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // SELECT payment_records (no failed payment)
        [], // UPDATE charging_sessions SET status=completed
        [
          {
            id: 'session-1',
            tariff_id: 'tariff-1',
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T02:00:00Z',
            energy_delivered_wh: 10000,
            currency: 'USD',
            tariff_price_per_kwh: '0.30',
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: '0.10',
            tariff_tax_rate: null,
            idle_started_at: '2024-01-01T01:00:00Z',
            idle_minutes: '15',
          },
        ], // SELECT session with idle columns
        [], // INSERT transaction_events
        [], // UPDATE session_tariff_segments SET ended_at
        [], // UPDATE charging_sessions SET final_cost_cents
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify (session.ended)
        [], // pg_notify (TransactionEnded)
        [
          {
            driver_id: null,
            energy_delivered_wh: 10000,
            final_cost_cents: 1500,
            currency: 'USD',
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T02:00:00Z',
          },
        ],
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-1',
          seqNo: 3,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T02:00:00Z',
          stoppedReason: 'Local',
        }),
      );

      // The closing segment carries idle_minutes = 15 (accumulated) + 60 (open
      // period: 02:00 - 01:00) = 75, which the cost assembly prices.
      const segmentClose = sqlCalls.find((c) =>
        c.strings.join('').includes('UPDATE session_tariff_segments'),
      );
      expect(segmentClose?.values[3]).toBeCloseTo(75, 0);
      expect(mockPriceSessionAt).toHaveBeenCalledWith(
        expect.anything(),
        'session-1',
        new Date('2024-01-01T02:00:00Z'),
        10000,
      );
    });

    it('transitions reservation to in_use when Started event includes reservationId', async () => {
      await setup();

      // Payload below has no idToken, so the eager OCPI roaming SELECT
      // (skipped when earlyIdToken is null) does not consume a result.
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'session-1' }], // INSERT charging_sessions ON CONFLICT DO UPDATE RETURNING id
        [], // UPDATE charging_sessions SET status='faulted' (close stale sessions)
        [], // INSERT transaction_events
        // free_vend check now goes through isSiteFreeVendEnabledByStation (mocked) -- no SQL call
        [{ is_roaming: false }], // SELECT is_roaming (eager-state seed)
        [{ driver_id: null }], // SELECT driver_id FROM charging_sessions (no driver)
        // loadStationPricing resolves the group, its tariffs and the site
        // timezone in one round trip. Empty: no pricing group matched.
        [], // loadStationPricing (no row)
        [{ id: 'reservation_test_uuid' }], // SELECT id FROM reservations WHERE reservation_id = 42
        [], // UPDATE charging_sessions SET reservation_id
        [], // UPDATE reservations SET status = 'in_use'
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify (session.started)
        [], // pg_notify (guest notification)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-res-1',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
          reservationId: 42,
        }),
      );

      const inUseCalls = sqlCalls.filter((c) => {
        const joined = c.strings.join(' ');
        return joined.includes('in_use') && joined.includes('reservations');
      });
      expect(inUseCalls.length).toBe(1);
    });

    it('transitions reservation to used when Ended event has a session with reservation_id', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // SELECT payment_records (no failed payment)
        [], // UPDATE charging_sessions SET status=completed
        [
          {
            id: 'session-1',
            tariff_id: 'tariff-1',
            current_cost_cents: 0,
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
            energy_delivered_wh: 10000,
            currency: 'USD',
            tariff_price_per_kwh: '0.30',
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: null,
            tariff_tax_rate: null,
            idle_started_at: null,
            idle_minutes: '0',
            reservation_id: 'reservation_test_uuid',
          },
        ], // SELECT session with reservation_id
        [], // INSERT transaction_events
        [], // UPDATE session_tariff_segments SET ended_at
        [], // UPDATE charging_sessions SET final_cost_cents
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify (session.ended)
        [], // pg_notify (TransactionEnded)
        [
          {
            driver_id: null,
            energy_delivered_wh: 10000,
            final_cost_cents: 1500,
            currency: 'USD',
            started_at: '2024-01-01T00:00:00Z',
            ended_at: '2024-01-01T01:00:00Z',
          },
        ], // SELECT session for notification
        [], // UPDATE reservations SET status = 'used'
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-res-2',
          seqNo: 1,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
          stoppedReason: 'Local',
        }),
      );

      const usedCalls = sqlCalls.filter((c) => {
        const joined = c.strings.join(' ');
        return joined.includes("'used'") && joined.includes('reservations');
      });
      expect(usedCalls.length).toBe(1);
    });
  });

  describe('ocpp.MeterValues', () => {
    it('inserts meter values and updates energy', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'ses_mv', evse_id: 'evs_mv' }], // resolveMeterValueSession by transactionId
        [], // INSERT meter_values
        [{ energy_delivered_wh: 0, meter_start: 0 }], // SELECT prev energy for flat-reading check
        [], // UPDATE meter_start (set if NULL)
        [], // UPDATE energy_delivered_wh (delta)
        [], // UPDATE idle (flat energy check)
        [], // SELECT active sessions
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          transactionId: 'TX-MV',
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

      expect(sqlCalls.length).toBeGreaterThanOrEqual(6);
    });

    it('converts a kWh energy register to Wh for meter_start and session energy', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'ses_mv', evse_id: 'evs_mv' }], // resolveMeterValueSession by transactionId
        [], // INSERT meter_values
        [{ energy_delivered_wh: null, meter_start: null }], // SELECT prev energy
        [], // UPDATE meter_start (set if NULL)
        [], // UPDATE energy_delivered_wh (delta)
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          transactionId: 'TX-MV',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2024-01-01T00:30:00Z',
              sampledValue: [
                {
                  measurand: 'Energy.Active.Import.Register',
                  value: 2908.2475,
                  unitOfMeasure: { unit: 'kWh' },
                },
              ],
            },
          ],
        }),
      );

      const insert = sqlCalls.find((c) => c.strings.join('?').includes('INSERT INTO meter_values'));
      expect(insert?.values).toContain(2908.2475);
      const meterStart = sqlCalls.find((c) => c.strings.join('?').includes('SET meter_start'));
      expect(meterStart?.values[0]).toBe(2908248);
      const energy = sqlCalls.find((c) => c.strings.join('?').includes('SET energy_delivered_wh'));
      expect(energy?.values[0]).toBe(2908247.5);
    });

    it('applies the OCPP 2.1 multiplier and defaults a missing measurand to the energy register', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'ses_mv', evse_id: 'evs_mv' }], // resolveMeterValueSession by transactionId
        [], // INSERT meter_values
        [{ energy_delivered_wh: null, meter_start: null }], // SELECT prev energy
        [], // UPDATE meter_start (set if NULL)
        [], // UPDATE energy_delivered_wh (delta)
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          transactionId: 'TX-MV',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2024-01-01T00:30:00Z',
              sampledValue: [{ value: 5, unitOfMeasure: { unit: 'Wh', multiplier: 3 } }],
            },
          ],
        }),
      );

      const insert = sqlCalls.find((c) => c.strings.join('?').includes('INSERT INTO meter_values'));
      expect(insert?.values).toContain('Energy.Active.Import.Register');
      expect(insert?.values).toContain(5000);
      const energy = sqlCalls.find((c) => c.strings.join('?').includes('SET energy_delivered_wh'));
      expect(energy?.values[0]).toBe(5000);
    });

    it('does not update session energy for an energy register in a non-energy unit', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'ses_mv', evse_id: 'evs_mv' }], // resolveMeterValueSession by transactionId
        [], // INSERT meter_values
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          transactionId: 'TX-MV',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2024-01-01T00:30:00Z',
              sampledValue: [
                {
                  measurand: 'Energy.Active.Import.Register',
                  value: 11,
                  unitOfMeasure: { unit: 'kW' },
                },
              ],
            },
          ],
        }),
      );

      expect(sqlCalls.some((c) => c.strings.join('?').includes('SET energy_delivered_wh'))).toBe(
        false,
      );
      expect(sqlCalls.some((c) => c.strings.join('?').includes('SET meter_start'))).toBe(false);
    });

    it('passes a decimal energy reading as numeric so Postgres does not infer integer', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'ses_mv', evse_id: 'evs_mv' }], // resolveMeterValueSession by transactionId
        [], // INSERT meter_values
        [{ energy_delivered_wh: 0, meter_start: 2909465 }], // SELECT prev energy
        [], // UPDATE meter_start (set if NULL)
        [], // UPDATE energy_delivered_wh (delta)
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          transactionId: 'TX-MV',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2024-01-01T00:30:00Z',
              sampledValue: [
                { measurand: 'Energy.Active.Import.Register', unit: 'Wh', value: '2909560.3' },
              ],
            },
          ],
        }),
      );

      const meterStart = sqlCalls.find((c) => c.strings.join('?').includes('SET meter_start'));
      expect(meterStart?.values[0]).toBe(2909560);
      const energy = sqlCalls.find((c) => c.strings.join('?').includes('SET energy_delivered_wh'));
      expect(energy?.strings.join('?')).toContain('?::numeric - meter_start');
      expect(energy?.values[0]).toBe(2909560.3);
    });

    it('uses the total energy register, not a per-phase one, for session energy', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'ses_mv', evse_id: 'evs_mv' }], // resolveMeterValueSession by transactionId
        [], // INSERT meter_values (total)
        [], // INSERT meter_values (L1)
        [], // INSERT meter_values (L3)
        [{ energy_delivered_wh: null, meter_start: 0 }], // SELECT prev energy
        [], // UPDATE meter_start (set if NULL)
        [], // UPDATE energy_delivered_wh (delta)
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          transactionId: 'TX-MV',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2024-01-01T00:30:00Z',
              sampledValue: [
                { measurand: 'Energy.Active.Import.Register', value: 9000 },
                { measurand: 'Energy.Active.Import.Register', value: 3000, phase: 'L1' },
                { measurand: 'Energy.Active.Import.Register', value: 3000, phase: 'L3' },
              ],
            },
          ],
        }),
      );

      const energyUpdates = sqlCalls.filter((c) =>
        c.strings.join('?').includes('SET energy_delivered_wh'),
      );
      expect(energyUpdates).toHaveLength(1);
      expect(energyUpdates[0]?.values[0]).toBe(9000);
    });

    it('sums per-phase energy registers when no total is reported', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'ses_mv', evse_id: 'evs_mv' }], // resolveMeterValueSession by transactionId
        [], // INSERT meter_values (L1)
        [], // INSERT meter_values (L2)
        [], // INSERT meter_values (L3)
        [{ energy_delivered_wh: null, meter_start: 0 }], // SELECT prev energy
        [], // UPDATE meter_start (set if NULL)
        [], // UPDATE energy_delivered_wh (delta)
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          transactionId: 'TX-MV',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2024-01-01T00:30:00Z',
              sampledValue: [
                { measurand: 'Energy.Active.Import.Register', value: 1000, phase: 'L1' },
                { measurand: 'Energy.Active.Import.Register', value: 2000, phase: 'L2' },
                { measurand: 'Energy.Active.Import.Register', value: 3000, phase: 'L3' },
              ],
            },
          ],
        }),
      );

      const energy = sqlCalls.find((c) => c.strings.join('?').includes('SET energy_delivered_wh'));
      expect(energy?.values[0]).toBe(6000);
    });

    it('ignores Inlet energy readings for session energy', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'ses_mv', evse_id: 'evs_mv' }], // resolveMeterValueSession by transactionId
        [], // INSERT meter_values
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          transactionId: 'TX-MV',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2024-01-01T00:30:00Z',
              sampledValue: [
                { measurand: 'Energy.Active.Import.Register', value: 5000000, location: 'Inlet' },
              ],
            },
          ],
        }),
      );

      expect(sqlCalls.some((c) => c.strings.join('?').includes('SET energy_delivered_wh'))).toBe(
        false,
      );
    });

    it('does not mark a session idle when one phase reads 0 W but the total is flowing', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'ses_mv', evse_id: 'evs_mv' }], // resolveMeterValueSession by transactionId
        [], // INSERT meter_values (L1)
        [], // INSERT meter_values (L2)
        [], // INSERT meter_values (L3)
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          transactionId: 'TX-MV',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2024-01-01T00:30:00Z',
              sampledValue: [
                {
                  measurand: 'Power.Active.Import',
                  value: 7400,
                  phase: 'L1',
                  unitOfMeasure: { unit: 'W' },
                },
                {
                  measurand: 'Power.Active.Import',
                  value: 0,
                  phase: 'L2',
                  unitOfMeasure: { unit: 'W' },
                },
                {
                  measurand: 'Power.Active.Import',
                  value: 0,
                  phase: 'L3',
                  unitOfMeasure: { unit: 'W' },
                },
              ],
            },
          ],
        }),
      );

      expect(sqlCalls.some((c) => c.strings.join('?').includes('SET idle_started_at = '))).toBe(
        false,
      );
      const resumed = sqlCalls.find((c) => c.strings.join('?').includes('idle_started_at = NULL'));
      expect(resumed).toBeDefined();
    });

    it('recalculates cost for active sessions with tariff', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'ses_mv', evse_id: 'evs_mv' }], // resolveMeterValueSession by transactionId
        [], // INSERT meter_values
        [{ energy_delivered_wh: 4000, meter_start: 0 }], // SELECT prev energy for flat-reading check
        [], // UPDATE meter_start (set if NULL)
        [], // UPDATE energy_delivered_wh (delta)
        [], // UPDATE idle (flat energy, energy increased)
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
            idle_started_at: null,
            idle_minutes: '0',
          },
        ], // active sessions
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          transactionId: 'TX-MV',
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

      // The running cost comes from the one cost assembly and is stored with its split.
      expect(mockPriceSessionAt).toHaveBeenCalledWith(
        expect.anything(),
        'session-1',
        expect.any(Date),
        5000,
      );
      expect(mockStoreRunningCost).toHaveBeenCalledWith(
        expect.anything(),
        'session-1',
        expect.objectContaining({ grossCents: 1500 }),
      );
    });

    it('skips if station not found', async () => {
      await setup();
      setupSqlResults([]);

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'UNKNOWN',
          meterValues: [{ timestamp: '2024-01-01T00:00:00Z', sampledValue: [{ value: 100 }] }],
        }),
      );

      expect(sqlCalls.length).toBe(1);
    });

    it('skips if no meterValues in payload', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', { stationId: 'CS-001' }),
      );

      expect(sqlCalls.length).toBe(1);
    });

    it('sets idle_started_at when Power.Active.Import is 0', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'ses_mv', evse_id: 'evs_mv' }], // resolveMeterValueSession by transactionId
        [], // INSERT meter_values
        [], // UPDATE idle_started_at (power = 0)
        [], // SELECT active sessions (no tariff)
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          transactionId: 'TX-MV',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2024-01-01T01:00:00Z',
              sampledValue: [
                {
                  measurand: 'Power.Active.Import',
                  value: 0,
                  unitOfMeasure: { unit: 'W' },
                },
              ],
            },
          ],
        }),
      );

      const idleSetCall = sqlCalls.find((c) => {
        const joined = c.strings.join('');
        return joined.includes('idle_started_at') && joined.includes('idle_started_at IS NULL');
      });
      expect(idleSetCall).toBeDefined();
    });

    it('accumulates idle_minutes when Power.Active.Import resumes > 0', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'ses_mv', evse_id: 'evs_mv' }], // resolveMeterValueSession by transactionId
        [], // INSERT meter_values
        [], // UPDATE idle_minutes (power > 0, accumulate)
        [], // SELECT active sessions (no tariff)
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          transactionId: 'TX-MV',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2024-01-01T01:30:00Z',
              sampledValue: [
                {
                  measurand: 'Power.Active.Import',
                  value: 7200,
                  unitOfMeasure: { unit: 'W' },
                },
              ],
            },
          ],
        }),
      );

      const accumulateCall = sqlCalls.find((c) => {
        const joined = c.strings.join('');
        return (
          joined.includes('idle_minutes') &&
          joined.includes('EXTRACT') &&
          joined.includes('idle_started_at IS NOT NULL')
        );
      });
      expect(accumulateCall).toBeDefined();
      // The meter fallback never ends an idle period the station reported (claimed).
      expect(accumulateCall?.strings.join('')).toContain(
        'idle_notified_at IS DISTINCT FROM idle_started_at',
      );
    });

    it('sets idle_started_at when energy reading unchanged from previous', async () => {
      await setup();

      // Session has meter_start=1000 and energy_delivered_wh=5000 (meter was at 6000).
      // New reading is also 6000 (same as before), so energy is flat.
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'ses_mv', evse_id: 'evs_mv' }], // resolveMeterValueSession by transactionId
        [], // INSERT meter_values
        [{ energy_delivered_wh: 5000, meter_start: 1000 }], // SELECT prev energy
        [], // UPDATE meter_start (no-op, already set)
        [], // UPDATE energy_delivered_wh
        [], // UPDATE idle_started_at (flat energy)
        [], // SELECT active sessions
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          transactionId: 'TX-MV',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2024-01-01T01:00:00Z',
              sampledValue: [
                {
                  measurand: 'Energy.Active.Import.Register',
                  value: 6000,
                  unitOfMeasure: { unit: 'Wh' },
                },
              ],
            },
          ],
        }),
      );

      const idleSetCall = sqlCalls.find((c) => {
        const joined = c.strings.join('');
        return joined.includes('SET idle_started_at') && joined.includes('idle_started_at IS NULL');
      });
      expect(idleSetCall).toBeDefined();
    });

    it('clears idle_started_at when energy reading increases from previous', async () => {
      await setup();

      // Session has meter_start=1000 and energy_delivered_wh=5000 (meter was at 6000).
      // New reading is 8000, so energy increased by 2000 Wh.
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'ses_mv', evse_id: 'evs_mv' }], // resolveMeterValueSession by transactionId
        [], // INSERT meter_values
        [{ energy_delivered_wh: 5000, meter_start: 1000 }], // SELECT prev energy
        [], // UPDATE meter_start (no-op)
        [], // UPDATE energy_delivered_wh
        [], // UPDATE idle_minutes (energy increased, clear idle)
        [], // SELECT active sessions
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          transactionId: 'TX-MV',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2024-01-01T01:30:00Z',
              sampledValue: [
                {
                  measurand: 'Energy.Active.Import.Register',
                  value: 8000,
                  unitOfMeasure: { unit: 'Wh' },
                },
              ],
            },
          ],
        }),
      );

      const accumulateCall = sqlCalls.find((c) => {
        const joined = c.strings.join('');
        return (
          joined.includes('idle_minutes') &&
          joined.includes('EXTRACT') &&
          joined.includes('idle_started_at IS NOT NULL')
        );
      });
      expect(accumulateCall).toBeDefined();
    });

    it('does not set idle on first energy reading (no previous value)', async () => {
      await setup();

      // Session has no meter_start yet (first reading). prevEnergyWh will be -1.
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'ses_mv', evse_id: 'evs_mv' }], // resolveMeterValueSession by transactionId
        [], // INSERT meter_values
        [{ energy_delivered_wh: null, meter_start: null }], // SELECT prev energy (no previous)
        [], // UPDATE meter_start (sets it for first time)
        [], // UPDATE energy_delivered_wh
        [], // SELECT active sessions
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          transactionId: 'TX-MV',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2024-01-01T00:05:00Z',
              sampledValue: [
                {
                  measurand: 'Energy.Active.Import.Register',
                  value: 1000,
                  unitOfMeasure: { unit: 'Wh' },
                },
              ],
            },
          ],
        }),
      );

      // No idle-related SQL should have been issued
      const idleCalls = sqlCalls.filter((c) => {
        const joined = c.strings.join('');
        return joined.includes('SET idle_started_at') || joined.includes('SET idle_minutes');
      });
      expect(idleCalls.length).toBe(0);
    });

    it('prices an idle active session through the cost assembly', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'ses_mv', evse_id: 'evs_mv' }], // resolveMeterValueSession by transactionId
        [], // INSERT meter_values
        [{ energy_delivered_wh: 9000, meter_start: 0 }], // SELECT prev energy for flat-reading check
        [], // UPDATE meter_start (set if NULL)
        [], // UPDATE energy_delivered_wh (delta)
        [], // UPDATE idle (flat energy, energy increased)
        [
          {
            id: 'session-1',
            tariff_id: 'tariff-1',
            started_at: '2024-01-01T00:00:00Z',
            energy_delivered_wh: 10000,
            current_cost_cents: 300,
            currency: 'USD',
            tariff_price_per_kwh: '0.30',
            tariff_price_per_minute: null,
            tariff_price_per_session: null,
            tariff_idle_fee_price_per_minute: '0.10',
            tariff_tax_rate: null,
            idle_started_at: null,
            idle_minutes: '20',
          },
        ], // active sessions with idle columns
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          transactionId: 'TX-MV',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2024-01-01T01:00:00Z',
              sampledValue: [
                {
                  measurand: 'Energy.Active.Import.Register',
                  value: 10000,
                  unitOfMeasure: { unit: 'Wh' },
                },
              ],
            },
          ],
        }),
      );

      // The assembly reads the idle minutes from the session (see the
      // session-pricing tests in @evtivity/database).
      expect(mockPriceSessionAt).toHaveBeenCalledWith(
        expect.anything(),
        'session-1',
        expect.any(Date),
        10000,
      );
    });

    it('populates session_id, evse_id, phase, location, context, unit, and source for 2.1 format', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'evs_000000000001' }], // resolveEvseUuid
        [{ id: 'ses_000000000001' }], // resolveMeterValueSession (by evse)
        [], // INSERT meter_values
        [], // SELECT active sessions
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          evseId: 1,
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2024-01-01T00:30:00Z',
              sampledValue: [
                {
                  measurand: 'Voltage',
                  value: 230,
                  unitOfMeasure: { unit: 'V' },
                  phase: 'L1',
                  location: 'Outlet',
                  context: 'Sample.Periodic',
                },
              ],
            },
          ],
        }),
      );

      // Find the INSERT call
      const insertCall = sqlCalls.find((c) =>
        c.strings.join('').includes('INSERT INTO meter_values'),
      );
      expect(insertCall).toBeDefined();
      // Values should include evse_id, session_id, phase, location, context, source
      expect(insertCall!.values).toContain('evs_000000000001'); // evse_id
      expect(insertCall!.values).toContain('ses_000000000001'); // session_id
      expect(insertCall!.values).toContain('L1'); // phase
      expect(insertCall!.values).toContain('Outlet'); // location
      expect(insertCall!.values).toContain('Sample.Periodic'); // context
      expect(insertCall!.values).toContain('TransactionEvent'); // source
    });

    it('uses sv.unit fallback for 1.6 format (no unitOfMeasure wrapper)', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'ses_000000000001' }], // resolveMeterValueSession (by transactionId)
        [], // INSERT meter_values
        [], // SELECT active sessions
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          evseId: 0,
          transactionId: '12345',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2024-01-01T00:30:00Z',
              sampledValue: [
                {
                  measurand: 'Voltage',
                  value: 230,
                  unit: 'V',
                  phase: 'L1',
                },
              ],
            },
          ],
        }),
      );

      const insertCall = sqlCalls.find((c) =>
        c.strings.join('').includes('INSERT INTO meter_values'),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall!.values).toContain('V'); // unit from sv.unit fallback
    });

    it('resolves session by transactionId when present (1.6 path)', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'ses_000000000001' }], // resolveMeterValueSession by transactionId
        [], // INSERT meter_values
        [], // SELECT active sessions
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          evseId: 0,
          transactionId: '99999',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2024-01-01T00:30:00Z',
              sampledValue: [{ measurand: 'Voltage', value: 230, unit: 'V' }],
            },
          ],
        }),
      );

      // The resolveMeterValueSession query should include transactionId
      const sessionLookup = sqlCalls[1]!;
      expect(sessionLookup.strings.join('')).toContain('transaction_id');
      expect(sessionLookup.values).toContain('99999');
      // A transactionId is only unique per station.
      expect(sessionLookup.strings.join('')).toContain('station_id');
      expect(sessionLookup.values).toContain('sta_000000000001');
    });

    it('filters energy update by evse_id when available', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'evs_000000000001' }], // resolveEvseUuid
        [{ id: 'ses_000000000001' }], // resolveMeterValueSession
        [], // INSERT meter_values
        [{ energy_delivered_wh: 0, meter_start: 0 }], // SELECT prev energy for flat-reading check
        [], // UPDATE meter_start (set if NULL)
        [], // UPDATE energy (filtered by evse_id)
        [], // UPDATE idle (flat energy check)
        [], // SELECT active sessions
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          evseId: 1,
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

      // Find the UPDATE energy call
      const energyUpdate = sqlCalls.find((c) => {
        const joined = c.strings.join('');
        return joined.includes('energy_delivered_wh') && joined.includes('evse_id');
      });
      expect(energyUpdate).toBeDefined();
      expect(energyUpdate!.values).toContain('ses_000000000001');
    });

    it('scopes a late reading to its own ended session, not the newer one on the EVSE', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'evs_000000000001' }], // resolveEvseUuid
        [{ id: 'ses_old', evse_id: 'evs_000000000001' }], // resolveMeterValueSession (completed)
        [], // INSERT meter_values (energy)
        [], // INSERT meter_values (power)
        [], // SELECT prev energy (session no longer active)
        [], // UPDATE meter_start
        [], // UPDATE energy
        [], // UPDATE idle (power)
        [], // SELECT active sessions
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          evseId: 1,
          transactionId: 'TX-OLD',
          source: 'TransactionEvent',
          meterValues: [
            {
              timestamp: '2024-01-01T00:30:00Z',
              sampledValue: [
                { measurand: 'Energy.Active.Import.Register', value: 9000, unit: 'Wh' },
                { measurand: 'Power.Active.Import', value: 0, unit: 'W' },
              ],
            },
          ],
        }),
      );

      const sessionCalls = sqlCalls.filter((c) => {
        const joined = c.strings.join('');
        return (
          joined.includes('charging_sessions') &&
          !joined.includes('transaction_id = ') &&
          !joined.includes('INSERT INTO meter_values')
        );
      });
      // prev energy, meter_start, energy, idle, cost query
      expect(sessionCalls.length).toBe(5);
      for (const call of sessionCalls) {
        const joined = call.strings.join('?');
        // Matched by session id, still only while active, never by EVSE alone.
        expect(joined).toMatch(/[(.]id = \?/);
        expect(joined).toContain("status = 'active'");
        expect(call.values).toContain('ses_old');
      }
      const insert = sqlCalls.find((c) => c.strings.join('').includes('INSERT INTO meter_values'));
      expect(insert?.values).toContain('ses_old');
    });

    it('stores a station-wide reading without touching any session', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [], // INSERT meter_values
        [{ site_id: null }], // resolveSiteId
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
          evseId: 0,
          meterValues: [
            {
              timestamp: '2024-01-01T00:30:00Z',
              sampledValue: [
                { measurand: 'Energy.Active.Import.Register', value: 120000, unit: 'Wh' },
              ],
            },
          ],
        }),
      );

      const insert = sqlCalls.find((c) => c.strings.join('').includes('INSERT INTO meter_values'));
      expect(insert).toBeDefined();
      expect(insert?.values).toContain(120000);
      expect(sqlCalls.some((c) => c.strings.join('').includes('charging_sessions'))).toBe(false);
    });

    it('stores signedMeterValue in signed_data', async () => {
      await setup();

      const signedData = { signedMeterData: 'abc123', signingMethod: 'ECDSAP256SHA256' };

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [], // INSERT meter_values
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
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
                  measurand: 'Energy.Active.Import.Register',
                  value: 5000,
                  unitOfMeasure: { unit: 'Wh' },
                  signedMeterValue: signedData,
                },
              ],
            },
          ],
        }),
      );

      const insertCall = sqlCalls.find((c) =>
        c.strings.join('').includes('INSERT INTO meter_values'),
      );
      expect(insertCall).toBeDefined();
      // Production passes signedMeterValue through sql.json(); the mock
      // unwraps to the raw object rather than a stringified JSON blob.
      expect(insertCall!.values).toContain(signedData);
    });
  });

  describe('ocpp.FirmwareStatusNotification', () => {
    it('sets availability to available on Installed', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // UPDATE charging_stations
      );

      await eventBus.emit(
        'ocpp.FirmwareStatusNotification',
        makeDomainEvent('ocpp.FirmwareStatusNotification', 'CS-001', { status: 'Installed' }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('sets availability to faulted on InstallationFailed', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // UPDATE charging_stations
      );

      await eventBus.emit(
        'ocpp.FirmwareStatusNotification',
        makeDomainEvent('ocpp.FirmwareStatusNotification', 'CS-001', {
          status: 'InstallationFailed',
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('sets availability to faulted on InvalidSignature', async () => {
      await setup();
      setupSqlResults([{ id: 'sta_000000000001' }], []);

      await eventBus.emit(
        'ocpp.FirmwareStatusNotification',
        makeDomainEvent('ocpp.FirmwareStatusNotification', 'CS-001', {
          status: 'InvalidSignature',
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('sets availability to unavailable on Installing', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // UPDATE charging_stations
      );

      await eventBus.emit(
        'ocpp.FirmwareStatusNotification',
        makeDomainEvent('ocpp.FirmwareStatusNotification', 'CS-001', { status: 'Installing' }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('does nothing for other statuses', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
      );

      await eventBus.emit(
        'ocpp.FirmwareStatusNotification',
        makeDomainEvent('ocpp.FirmwareStatusNotification', 'CS-001', { status: 'Downloading' }),
      );

      // resolveStationId + notification dispatch (notification loop also subscribed)
      expect(sqlCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('ocpp.SecurityEventNotification', () => {
    it('inserts connection log with security event', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT connection_logs
      );

      await eventBus.emit(
        'ocpp.SecurityEventNotification',
        makeDomainEvent('ocpp.SecurityEventNotification', 'CS-001', {
          type: 'FirmwareUpdated',
          timestamp: '2024-01-01T00:00:00Z',
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('ocpp.ReservationStatusUpdate', () => {
    it('updates reservation to expired', async () => {
      await setup();

      setupSqlResults(
        [], // UPDATE reservations
      );

      await eventBus.emit(
        'ocpp.ReservationStatusUpdate',
        makeDomainEvent('ocpp.ReservationStatusUpdate', 'CS-001', {
          reservationId: 42,
          reservationUpdateStatus: 'Expired',
        }),
      );

      expect(sqlCalls.length).toBe(1);
    });

    it('updates reservation to cancelled on Removed', async () => {
      await setup();

      setupSqlResults(
        [], // UPDATE reservations
      );

      await eventBus.emit(
        'ocpp.ReservationStatusUpdate',
        makeDomainEvent('ocpp.ReservationStatusUpdate', 'CS-001', {
          reservationId: 43,
          reservationUpdateStatus: 'Removed',
        }),
      );

      expect(sqlCalls.length).toBe(1);
    });

    it('skips unknown status', async () => {
      await setup();

      await eventBus.emit(
        'ocpp.ReservationStatusUpdate',
        makeDomainEvent('ocpp.ReservationStatusUpdate', 'CS-001', {
          reservationId: 44,
          reservationUpdateStatus: 'UnknownStatus',
        }),
      );

      expect(sqlCalls.length).toBe(0);
    });
  });

  describe('ocpp.NotifySettlement', () => {
    it('inserts payment record and dispatches driver notifications', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'session-1', driver_id: 'driver-1', currency: 'EUR' }], // SELECT from charging_sessions
        [], // pg_notify (payment.settled)
      );

      await eventBus.emit(
        'ocpp.NotifySettlement',
        makeDomainEvent('ocpp.NotifySettlement', 'CS-001', {
          transactionId: 'tx-1',
          settlementAmount: 15.5,
        }),
      );

      expect(mockRecordTerminalSettlement).toHaveBeenCalledWith({
        sessionId: 'session-1',
        driverId: 'driver-1',
        currency: 'EUR',
        capturedCents: 1550,
      });

      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'session.PaymentReceived',
        'driver-1',
        expect.objectContaining({ amountCents: 1550 }),
        ['/mock/templates'],
        expect.anything(),
      );
      expect(mockDispatchDriver).toHaveBeenCalledWith(
        expect.anything(),
        'payment.Complete',
        'driver-1',
        expect.objectContaining({ amountCents: 1550 }),
        ['/mock/templates'],
        expect.anything(),
      );
    });

    it('skips driver notification when no driver', async () => {
      mockDispatchDriver.mockClear();
      await setup();

      setupSqlResults(
        [{ id: 'session-1', driver_id: null }], // no driver
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.NotifySettlement',
        makeDomainEvent('ocpp.NotifySettlement', 'CS-001', {
          transactionId: 'tx-2',
          settlementAmount: 10,
        }),
      );

      expect(mockRecordTerminalSettlement).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-1', driverId: null, capturedCents: 1000 }),
      );
      expect(mockDispatchDriver).not.toHaveBeenCalled();
    });

    it('skips if session not found', async () => {
      await setup();
      setupSqlResults([]);

      await eventBus.emit(
        'ocpp.NotifySettlement',
        makeDomainEvent('ocpp.NotifySettlement', 'CS-001', {
          transactionId: 'tx-unknown',
          settlementAmount: 5,
        }),
      );

      expect(sqlCalls.length).toBe(1);
      expect(mockRecordTerminalSettlement).not.toHaveBeenCalled();
    });
  });

  describe('ocpp.MessageLog', () => {
    it('inserts message log entry and bumps last_heartbeat on inbound', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT ocpp_message_logs
        [], // UPDATE charging_stations.last_heartbeat (inbound liveness bump)
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.MessageLog',
        makeDomainEvent('ocpp.MessageLog', 'CS-001', {
          stationId: 'CS-001',
          direction: 'inbound',
          messageType: 2,
          messageId: 'msg-1',
          action: 'BootNotification',
          payload: {},
        }),
      );

      // Find the last_heartbeat update — it should be present for inbound.
      const heartbeatUpdate = sqlCalls.find((call) =>
        call.strings.some((s) => s.includes('last_heartbeat = now()')),
      );
      expect(heartbeatUpdate).toBeDefined();
    });

    it('does not bump last_heartbeat on outbound messages', async () => {
      await setup();

      setupSqlResults(
        [], // INSERT ocpp_message_logs
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.MessageLog',
        makeDomainEvent('ocpp.MessageLog', 'CS-001', {
          stationId: 'CS-001',
          stationDbId: 'sta_direct00001',
          direction: 'outbound',
          messageType: 3,
          messageId: 'msg-2',
          action: 'Reset',
          payload: {},
        }),
      );

      const heartbeatUpdate = sqlCalls.find((call) =>
        call.strings.some((s) => s.includes('last_heartbeat = now()')),
      );
      expect(heartbeatUpdate).toBeUndefined();
    });
  });

  describe('retry on a lost database connection', () => {
    // A postgres.js connection error (Errors.connection) or Node socket error.
    function connectionError(code: string): Error {
      return Object.assign(new Error(`write ${code} localhost:5433`), { code });
    }

    // Rejects the next `times` unrouted statements whose text includes `match`.
    function failNext(match: string, code: string, times = 1): void {
      let left = times;
      sqlFailOn = (text) => {
        if (left > 0 && text.includes(match)) {
          left--;
          return connectionError(code);
        }
        return null;
      };
    }

    function countCalls(fragment: string): number {
      return sqlCalls.filter((c) => c.strings.join('?').includes(fragment)).length;
    }

    async function emitAndSettle(eventType: string, event: DomainEvent): Promise<void> {
      const done = eventBus.emit(eventType, event);
      await vi.advanceTimersByTimeAsync(10_000);
      await done;
    }

    function messageLogEvent(messageId: string): DomainEvent {
      return makeDomainEvent('ocpp.MessageLog', 'CS-001', {
        stationId: 'CS-001',
        stationDbId: 'sta_000000000001',
        direction: 'inbound',
        messageType: 2,
        messageId,
        action: 'Heartbeat',
        payload: {},
      });
    }

    it('writes a message log whose INSERT timed out connecting, once', async () => {
      await setup();
      sqlRoute = (text) => (text.includes('INSERT INTO ocpp_message_logs') ? undefined : []);
      failNext('INSERT INTO ocpp_message_logs', 'CONNECT_TIMEOUT');

      await emitAndSettle('ocpp.MessageLog', messageLogEvent('msg-1'));

      // The failed attempt and the retry; the retry went on to the liveness bump.
      expect(countCalls('INSERT INTO ocpp_message_logs')).toBe(2);
      expect(countCalls('last_heartbeat = now(), is_online = true')).toBe(1);
      expect(mockPubSub.publish).toHaveBeenCalledWith(
        'csms_events',
        expect.stringContaining('"eventType":"ocpp.message"'),
      );
    });

    it('does not insert the message log again when a later statement failed', async () => {
      await setup();
      sqlRoute = (text) =>
        text.includes('last_heartbeat = now(), is_online = true') ? undefined : [];
      setupSqlResults([], [{ was_online: false }]);
      failNext('last_heartbeat = now(), is_online = true', 'ECONNRESET');

      await emitAndSettle('ocpp.MessageLog', messageLogEvent('msg-2'));

      expect(countCalls('INSERT INTO ocpp_message_logs')).toBe(1);
      expect(countCalls('last_heartbeat = now(), is_online = true')).toBe(2);
      // The station came online: the retry kept the result of its liveness bump.
      expect(mockPubSub.publish).toHaveBeenCalledWith(
        'csms_events',
        expect.stringContaining('"eventType":"station.status"'),
      );
    });

    it('never retries an error that is not a lost connection', async () => {
      await setup();
      sqlRoute = (text) => (text.includes('INSERT INTO ocpp_message_logs') ? undefined : []);
      sqlFailOn = (text) =>
        text.includes('INSERT INTO ocpp_message_logs')
          ? Object.assign(new Error('value too long'), { code: '22001' })
          : null;

      await emitAndSettle('ocpp.MessageLog', messageLogEvent('msg-3'));

      expect(countCalls('INSERT INTO ocpp_message_logs')).toBe(1);
      expect(countCalls('last_heartbeat')).toBe(0);
    });

    it('stops when a log INSERT lost its connection mid-statement (it may have committed)', async () => {
      await setup();
      sqlRoute = (text) => (text.includes('INSERT INTO connection_logs') ? undefined : []);
      failNext('INSERT INTO connection_logs', 'CONNECTION_CLOSED', 3);

      await emitAndSettle(
        'station.Connected',
        makeDomainEvent('station.Connected', 'CS-001', {
          ocppProtocol: 'ocpp2.1',
          stationDbId: 'sta_000000000001',
        }),
      );

      expect(countCalls('INSERT INTO connection_logs')).toBe(1);
      expect(countCalls('SET is_online = true')).toBe(1);
    });

    it('runs the idempotent steps again and the log INSERTs once', async () => {
      await setup();
      sqlRoute = (text) =>
        text.includes('SELECT site_id FROM charging_stations') ? undefined : [];
      setupSqlResults([], [{ site_id: null }]);
      failNext('SELECT site_id FROM charging_stations', 'CONNECT_TIMEOUT');

      await emitAndSettle(
        'station.Connected',
        makeDomainEvent('station.Connected', 'CS-001', {
          ocppProtocol: 'ocpp2.1',
          stationDbId: 'sta_000000000001',
        }),
      );

      expect(countCalls('SET is_online = true')).toBe(2);
      expect(countCalls('INSERT INTO connection_logs')).toBe(1);
      expect(countCalls('INSERT INTO port_status_log')).toBe(1);
      expect(countCalls('SELECT site_id FROM charging_stations')).toBe(2);
      expect(mockPubSub.publish).toHaveBeenCalledWith(
        'csms_events',
        expect.stringContaining('"eventType":"station.status"'),
      );
    });

    it('gives up after three attempts', async () => {
      await setup();
      sqlRoute = (text) =>
        text.includes('SET last_heartbeat = now(), updated_at') ? undefined : [];
      failNext('SET last_heartbeat = now(), updated_at', 'CONNECT_TIMEOUT', 10);

      await emitAndSettle(
        'ocpp.Heartbeat',
        makeDomainEvent('ocpp.Heartbeat', 'CS-001', { stationDbId: 'sta_000000000001' }),
      );

      expect(countCalls('SET last_heartbeat = now(), updated_at')).toBe(3);
    });

    it('does not retry a projection that is not marked retryable', async () => {
      await setup();
      sqlRoute = (text) => (text.includes('display_messages') ? undefined : [{ id: 'sta_1' }]);
      failNext('display_messages', 'CONNECT_TIMEOUT', 10);

      await emitAndSettle(
        'ocpp.NotifyDisplayMessages',
        makeDomainEvent('ocpp.NotifyDisplayMessages', 'CS-001', {
          requestId: 1,
          messageInfo: [
            {
              id: 1,
              priority: 'AlwaysFront',
              message: { content: 'Hello', format: 'UTF8', language: 'en' },
            },
          ],
        }),
      );

      expect(countCalls('display_messages')).toBe(1);
    });

    describe('ocpp.StatusNotification', () => {
      const CONNECTOR_WRITE = 'SELECT id, status FROM connectors';

      function routeStatusNotification(): void {
        sqlRoute = (text) => {
          if (text.includes(CONNECTOR_WRITE)) return undefined;
          if (text.includes('SELECT site_id FROM charging_stations')) return undefined;
          if (text.includes('SELECT id FROM charging_stations WHERE station_id')) {
            return [{ id: 'sta_000000000001' }];
          }
          if (text.includes('SELECT id FROM evses')) return [{ id: 'evs_1' }];
          if (text.includes('SELECT ocpp_protocol')) return [{ ocpp_protocol: 'ocpp2.1' }];
          return [];
        };
      }

      function statusEvent(connectorStatus: string, timestamp: string): DomainEvent {
        return makeDomainEvent('ocpp.StatusNotification', 'CS-001', {
          evseId: 1,
          connectorId: 1,
          connectorStatus,
          timestamp,
        });
      }

      // The statuses each connector write set, in the order they ran.
      function connectorWrites(): unknown[] {
        return sqlCalls
          .filter((c) => c.strings.join('?').includes(CONNECTOR_WRITE))
          .map((c) => c.values[2]);
      }

      it('keeps the order of a station lane: a retried report is written before the next one', async () => {
        await setup();
        routeStatusNotification();
        // Unrouted, in order: connector write (fails), site id, connector write
        // (retry), site id, then the second report's connector write and site id.
        setupSqlResults(
          [],
          [{ previous_status: 'available', applied: true }],
          [{ site_id: null }],
          [{ previous_status: 'occupied', applied: true }],
          [{ site_id: null }],
        );
        failNext(CONNECTOR_WRITE, 'CONNECT_TIMEOUT');

        const first = eventBus.emit(
          'ocpp.StatusNotification',
          statusEvent('Occupied', '2026-10-05T10:00:00Z'),
        );
        const second = eventBus.emit(
          'ocpp.StatusNotification',
          statusEvent('Available', '2026-10-05T10:00:01Z'),
        );
        await vi.advanceTimersByTimeAsync(10_000);
        await Promise.all([first, second]);

        expect(connectorWrites()).toEqual(['occupied', 'occupied', 'available']);
      });

      it('keeps the first status write and its transition when a later step failed', async () => {
        await setup();
        routeStatusNotification();
        // Connector write, site id (fails), site id (retry).
        setupSqlResults([{ previous_status: 'available', applied: true }], [], [{ site_id: null }]);
        failNext('SELECT site_id FROM charging_stations', 'CONNECT_TIMEOUT');

        await emitAndSettle(
          'ocpp.StatusNotification',
          statusEvent('Occupied', '2026-10-05T10:00:00Z'),
        );

        expect(connectorWrites()).toEqual(['occupied']);
        // The station screen refresh follows the real transition, once.
        const refreshes = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
          (c: unknown[]) => c[0] === 'station_message_refresh',
        );
        expect(refreshes).toHaveLength(1);
      });
    });
  });

  describe('ocpp.NotifyDisplayMessages', () => {
    it('upserts display messages', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT display_messages
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.NotifyDisplayMessages',
        makeDomainEvent('ocpp.NotifyDisplayMessages', 'CS-001', {
          requestId: 1,
          messageInfo: [
            {
              id: 1,
              priority: 'AlwaysFront',
              message: { content: 'Hello', format: 'UTF8', language: 'en' },
            },
          ],
        }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('skips if no messageInfo', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
      );

      await eventBus.emit(
        'ocpp.NotifyDisplayMessages',
        makeDomainEvent('ocpp.NotifyDisplayMessages', 'CS-001', { requestId: 1 }),
      );

      expect(sqlCalls.length).toBe(1);
    });

    it('skips empty messageInfo array', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
      );

      await eventBus.emit(
        'ocpp.NotifyDisplayMessages',
        makeDomainEvent('ocpp.NotifyDisplayMessages', 'CS-001', {
          requestId: 1,
          messageInfo: [],
        }),
      );

      expect(sqlCalls.length).toBe(1);
    });
  });

  describe('Notification dispatch loop', () => {
    it('dispatches a notification for every event in the shared OCPP event list', async () => {
      await setup();

      for (const eventType of OCPP_NOTIFICATION_EVENT_TYPES) {
        mockDispatchOcpp.mockClear();
        setupSqlResults();
        await eventBus.emit(eventType, makeDomainEvent(eventType, 'CS-001', {}));
        expect(
          mockDispatchOcpp.mock.calls.filter(
            (call) => (call[1] as DomainEvent).eventType === eventType,
          ),
          `${eventType} is not dispatched`,
        ).toHaveLength(1);
      }
    });
  });

  describe('ocpp.BatterySwap', () => {
    it('inserts battery swap event', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [], // INSERT battery_swap_events
      );

      await eventBus.emit(
        'ocpp.BatterySwap',
        makeDomainEvent('ocpp.BatterySwap', 'CS-001', {
          eventType: 'BatteryIn',
          transactionId: 'txn-001',
          idToken: { idToken: 'TOKEN123', type: 'ISO14443' },
        }),
      );

      expect(sqlCalls.length).toBe(2);
      const insertCall = sqlCalls[1]!;
      expect(insertCall.strings.join('')).toContain('INSERT INTO battery_swap_events');
      expect(insertCall.values).toContain('sta_000000000001');
      expect(insertCall.values).toContain('BatteryIn');
      expect(insertCall.values).toContain('txn-001');
    });

    it('uses defaults for missing fields', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [], // INSERT battery_swap_events
      );

      await eventBus.emit('ocpp.BatterySwap', makeDomainEvent('ocpp.BatterySwap', 'CS-001', {}));

      expect(sqlCalls.length).toBe(2);
      const insertCall = sqlCalls[1]!;
      expect(insertCall.values).toContain('Unknown');
      expect(insertCall.values).toContain(null);
    });

    it('skips if station not found', async () => {
      await setup();

      setupSqlResults(
        [], // resolveStationUuid returns no rows
      );

      await eventBus.emit(
        'ocpp.BatterySwap',
        makeDomainEvent('ocpp.BatterySwap', 'UNKNOWN-STATION', {
          eventType: 'BatteryOut',
        }),
      );

      expect(sqlCalls.length).toBe(1);
    });
  });

  describe('ocpp.NotifyPeriodicEventStream', () => {
    it('inserts periodic event stream record', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [], // INSERT periodic_event_streams
      );

      await eventBus.emit(
        'ocpp.NotifyPeriodicEventStream',
        makeDomainEvent('ocpp.NotifyPeriodicEventStream', 'CS-001', {
          id: 5,
          data: [{ component: 'EVSE', variable: 'Power', value: '7200' }],
        }),
      );

      expect(sqlCalls.length).toBe(2);
      const insertCall = sqlCalls[1]!;
      expect(insertCall.strings.join('')).toContain('INSERT INTO periodic_event_streams');
      expect(insertCall.values).toContain('sta_000000000001');
      expect(insertCall.values).toContain(5);
    });

    it('uses defaults for missing fields', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [], // INSERT periodic_event_streams
      );

      await eventBus.emit(
        'ocpp.NotifyPeriodicEventStream',
        makeDomainEvent('ocpp.NotifyPeriodicEventStream', 'CS-001', {}),
      );

      expect(sqlCalls.length).toBe(2);
      const insertCall = sqlCalls[1]!;
      expect(insertCall.values).toContain(0);
    });

    it('skips if station not found', async () => {
      await setup();

      setupSqlResults(
        [], // resolveStationUuid returns no rows
      );

      await eventBus.emit(
        'ocpp.NotifyPeriodicEventStream',
        makeDomainEvent('ocpp.NotifyPeriodicEventStream', 'UNKNOWN-STATION', {
          id: 1,
          data: [],
        }),
      );

      expect(sqlCalls.length).toBe(1);
    });
  });

  describe('Reservation expiry check', () => {
    it('registers setInterval for reservation expiry', async () => {
      await setup();
      expect(timerCallback).not.toBeNull();
    });
  });

  describe('transactionId another station already used (N4)', () => {
    function uniqueViolation(constraint: string): Error {
      return Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
        constraint_name: constraint,
      });
    }

    function startedFrom(stationId: string, triggerReason = 'Authorized'): DomainEvent {
      return makeDomainEvent('ocpp.TransactionEvent', stationId, {
        eventType: 'Started',
        stationId,
        transactionId: 'tx-shared',
        seqNo: 0,
        triggerReason,
        timestamp: '2024-01-01T00:00:00Z',
      });
    }

    it('records the Started session keyed by station and transactionId', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000002' }], // resolveStationUuid
        [{ id: 'ses_000000000002' }], // INSERT ... RETURNING id
      );

      await eventBus.emit('ocpp.TransactionEvent', startedFrom('CS-002'));

      const texts = sqlCalls.map((c) => c.strings.join(''));
      const insertIdx = texts.findIndex((t) => t.includes('INSERT INTO charging_sessions'));
      expect(insertIdx).toBe(1);
      expect(texts[insertIdx]).toContain('ON CONFLICT (station_id, transaction_id)');
      expect(sqlCalls[insertIdx]!.values).toContain('sta_000000000002');
      expect(sqlCalls[insertIdx]!.values).toContain('tx-shared');
      // The projection goes on with the new session: the stale-session check
      // on its EVSE runs, and nothing looks for another station's session.
      expect(texts.some((t) => t.includes('AND id != '))).toBe(true);
      expect(texts.some((t) => t.includes('cs.station_id !='))).toBe(false);
    });

    it('links a remote start only within its own station', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000002' }], // resolveStationUuid
        [{ id: 'ses_000000000002' }], // remote-start link
      );

      await eventBus.emit('ocpp.TransactionEvent', startedFrom('CS-002', 'RemoteStart'));

      const texts = sqlCalls.map((c) => c.strings.join(''));
      expect(texts[1]).toContain('UPDATE charging_sessions cs');
      expect(texts[1]).toContain('WHERE pending.station_id = ');
      expect(sqlCalls[1]!.values[0]).toBe('sta_000000000002');
      expect(texts.some((t) => t.includes('INSERT INTO charging_sessions'))).toBe(false);
    });

    it('links only a waiting remote start, and only for a transactionId new on the station', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000002' }], // resolveStationUuid
        [{ id: 'ses_000000000002' }], // remote-start link
      );

      await eventBus.emit('ocpp.TransactionEvent', startedFrom('CS-002', 'RemoteStart'));

      const link = sqlCalls[1]!;
      const text = link.strings.join('?');
      // A session that already has its transaction (a transaction_events row) is never moved.
      expect(text).toContain(
        'NOT EXISTS (\n                SELECT 1 FROM transaction_events te WHERE te.session_id = pending.id',
      );
      // A transactionId the station already holds links nothing.
      expect(text).toContain('holder.station_id = ?');
      expect(text).toContain('holder.transaction_id = ?');
      expect(link.values.slice(0, 3)).toEqual([
        'sta_000000000002',
        'sta_000000000002',
        'tx-shared',
      ]);
    });

    it('records a repeated remote-start Started on the session holding its transactionId', async () => {
      await setup();
      setupSqlResults(
        [{ id: 'sta_000000000002' }], // resolveStationUuid
        [], // remote-start link: the station already holds tx-shared
        [{ id: 'ses_000000000002' }], // INSERT ... ON CONFLICT returns the holder
      );

      await eventBus.emit('ocpp.TransactionEvent', startedFrom('CS-002', 'RemoteStart'));

      const texts = sqlCalls.map((c) => c.strings.join(''));
      expect(texts[1]).toContain('UPDATE charging_sessions cs');
      expect(texts[2]).toContain('INSERT INTO charging_sessions');
      expect(texts[2]).toContain('ON CONFLICT (station_id, transaction_id)');
      // No other statement writes a transactionId: no other pending session is claimed.
      expect(texts.filter((t) => t.includes('SET transaction_id'))).toHaveLength(1);
      // The projection goes on with the holder.
      const staleIdx = texts.findIndex((t) => t.includes('AND id != '));
      expect(staleIdx).toBeGreaterThan(2);
      expect(sqlCalls[staleIdx]!.values).toContain('ses_000000000002');
    });

    it('lets a unique violation on the Started insert reach safeSubscribe', async () => {
      await setup();
      sqlFailOn = (text) =>
        text.includes('INSERT INTO charging_sessions')
          ? uniqueViolation('uq_charging_sessions_station_transaction')
          : null;
      setupSqlResults([{ id: 'sta_000000000002' }]);

      await eventBus.emit('ocpp.TransactionEvent', startedFrom('CS-002'));

      // No holder lookup and no further statement after the failed insert.
      const texts = sqlCalls.map((c) => c.strings.join(''));
      expect(texts).toHaveLength(2);
    });
  });

  describe('out-of-order message buffering', () => {
    it('buffers MeterValues when session not found and replays after Started', async () => {
      await setup();

      // MeterValues with transactionId but no active session
      // SQL calls: resolveStationUuid, resolveMeterValueSession (by tx_id), resolveMeterValueSession (fallback)
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [], // resolveMeterValueSession by transactionId (no session)
        [], // resolveMeterValueSession fallback (no session)
      );

      const meterValuesEvent = makeDomainEvent('ocpp.MeterValues', 'CS-001', {
        stationId: 'CS-001',
        evseId: 0,
        transactionId: 'tx-ooo-1',
        source: 'TransactionEvent',
        meterValues: [
          {
            timestamp: '2024-01-01T00:05:00Z',
            sampledValue: [
              {
                measurand: 'Energy.Active.Import.Register',
                value: 1000,
                unitOfMeasure: { unit: 'Wh' },
              },
            ],
          },
        ],
      });

      await eventBus.emit('ocpp.MeterValues', meterValuesEvent);

      // No meter_values INSERT should have happened
      const insertCalls = sqlCalls.filter((c) =>
        c.strings.join('').includes('INSERT INTO meter_values'),
      );
      expect(insertCalls.length).toBe(0);

      // Now emit TransactionEvent Started for the same transactionId.
      // resolveStationUuid is cached from the MeterValues call above.
      setupSqlResults(
        [], // INSERT charging_sessions
        [{ id: 'session-ooo-1' }], // SELECT id FROM charging_sessions
        [], // INSERT transaction_events
        // free_vend check now goes through isSiteFreeVendEnabledByStation (mocked) -- no SQL call
        [{ driver_id: null }], // SELECT driver_id
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Started',
          stationId: 'CS-001',
          transactionId: 'tx-ooo-1',
          seqNo: 0,
          triggerReason: 'Authorized',
          timestamp: '2024-01-01T00:00:00Z',
        }),
      );

      // The drain calls eventBus.publish synchronously for each buffered event
      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'ocpp.MeterValues',
          payload: expect.objectContaining({ transactionId: 'tx-ooo-1' }),
        }),
      );
    });

    it('buffers TransactionEvent Updated when session not found', async () => {
      await setup();

      // SQL calls: resolveStationUuid, SELECT session by transaction_id (returns empty)
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [], // SELECT id FROM charging_sessions WHERE transaction_id (no session)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Updated',
          stationId: 'CS-001',
          transactionId: 'tx-ooo-2',
          seqNo: 1,
          triggerReason: 'MeterValuePeriodic',
          timestamp: '2024-01-01T00:30:00Z',
        }),
      );

      // No transaction_events INSERT should have happened
      const insertCalls = sqlCalls.filter((c) =>
        c.strings.join('').includes('INSERT INTO transaction_events'),
      );
      expect(insertCalls.length).toBe(0);

      // A transactionId is unique per station only: the lookup names the station.
      const lookup = sqlCalls[1]!;
      expect(lookup.strings.join('')).toContain('station_id');
      expect(lookup.values).toEqual(['sta_000000000001', 'tx-ooo-2']);
    });

    it('buffers TransactionEvent Ended when session not found', async () => {
      await setup();

      // SQL calls: resolveStationUuid, SELECT payment_records, UPDATE status=completed, SELECT session (returns empty)
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [], // SELECT payment_records (no failed payment)
        [], // UPDATE charging_sessions SET status=completed
        [], // SELECT session (no rows)
      );

      await eventBus.emit(
        'ocpp.TransactionEvent',
        makeDomainEvent('ocpp.TransactionEvent', 'CS-001', {
          eventType: 'Ended',
          stationId: 'CS-001',
          transactionId: 'tx-ooo-3',
          seqNo: 2,
          triggerReason: 'EVDeparted',
          timestamp: '2024-01-01T01:00:00Z',
          stoppedReason: 'Local',
        }),
      );

      // No transaction_events INSERT should have happened
      const insertCalls = sqlCalls.filter((c) =>
        c.strings.join('').includes('INSERT INTO transaction_events'),
      );
      expect(insertCalls.length).toBe(0);

      // No cost calculation should have happened
      expect(mockPriceSessionAt).not.toHaveBeenCalled();

      // Every Ended statement that names the transaction also names the station
      // (the projection by its id, the settlement subscriber by its OCPP id).
      const byTransaction = sqlCalls.filter((c) => c.values.includes('tx-ooo-3'));
      expect(byTransaction).toHaveLength(4);
      for (const call of byTransaction) {
        expect(call.strings.join('')).toContain('station_id');
        expect(call.values.includes('sta_000000000001') || call.values.includes('CS-001')).toBe(
          true,
        );
      }
    });
  });
});
