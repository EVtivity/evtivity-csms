// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventBus, DomainEvent, PubSubClient } from '@evtivity/lib';

// SQL mock: a function that handles tagged template calls and returns configurable results
const sqlCalls: Array<{ strings: string[]; values: unknown[] }> = [];
let sqlResults: Array<unknown[]> = [];
let sqlCallIndex = 0;

function createSqlMock() {
  sqlCalls.length = 0;
  sqlResults = [];
  sqlCallIndex = 0;

  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    sqlCalls.push({ strings: [...strings], values });
    const result = sqlResults[sqlCallIndex] ?? [];
    sqlCallIndex++;
    return Promise.resolve(result);
  };

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

vi.mock('@evtivity/database', () => ({
  isRoamingEnabled: vi.fn().mockResolvedValue(false),
  getIdlingGracePeriodMinutes: vi.fn().mockResolvedValue(0),
  isSplitBillingEnabled: vi.fn().mockResolvedValue(false),
  getOfflineCommandTtlHours: vi.fn().mockResolvedValue(24),
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

const mockCalculateSessionCost = vi.fn().mockReturnValue({ totalCents: 1500 });

vi.mock('@evtivity/lib', async () => {
  const actual = await vi.importActual<typeof import('@evtivity/lib')>('@evtivity/lib');
  return {
    ...actual,
    calculateSessionCost: mockCalculateSessionCost,
  };
});

vi.mock('stripe', () => ({
  default: class MockStripe {
    paymentIntents = {
      create: vi.fn().mockResolvedValue({ id: 'pi_test' }),
      capture: vi.fn().mockResolvedValue({}),
      cancel: vi.fn().mockResolvedValue({}),
    };
  },
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

describe('Event projections', () => {
  let eventBus: ReturnType<typeof createMockEventBus>;
  let timerCallback: (() => void) | null = null;

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
    vi.clearAllMocks();
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
    registerProjections(eventBus, 'postgres://test:test@localhost:5432/test', mockPubSub);
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

    it('logs port status transitions for existing EVSEs', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // UPDATE charging_stations
        [], // INSERT connection_logs
        [{ evse_id: 1 }, { evse_id: 2 }], // SELECT evse_id FROM evses
        [], // INSERT port_status_log #1
        [], // INSERT port_status_log #2
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'station.Connected',
        makeDomainEvent('station.Connected', 'CS-001', { ocppProtocol: 'ocpp2.1' }),
      );

      expect(sqlCalls.length).toBeGreaterThanOrEqual(6);
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

  describe('ocpp.StatusNotification', () => {
    it('auto-creates EVSE when not found', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // SELECT evses (not found)
        [{ id: 'evs_000000000001' }], // INSERT evses RETURNING id
        [], // INSERT connectors
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
        [{ id: 'evs_000000000001', status: 'available' }], // SELECT evses (found)
        [], // INSERT port_status_log
        [], // UPDATE evses
        [], // SELECT connectors (not found)
        [], // INSERT connectors
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
        [{ id: 'evs_000000000001', status: 'available' }], // SELECT evses
        [], // INSERT port_status_log
        [], // UPDATE evses
        [{ id: 'con_000000000001' }], // SELECT connectors (found)
        [], // UPDATE connectors
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
        [], // INSERT connectors
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
        [{ status: 'charging' }], // SELECT status FROM connectors (prevRows)
        [], // INSERT port_status_log
        [], // UPDATE connectors
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
        [{ status: 'charging' }], // SELECT status FROM connectors (prevRows)
        [], // INSERT port_status_log
        [], // UPDATE connectors
        [{ site_id: null }], // resolveSiteId
        [], // UPDATE charging_sessions SET idle_started_at
        [{ id: 'session-1', transaction_id: 'tx-1' }], // SELECT active session
        [
          {
            driver_id: 'drv-1',
            idle_started_at: '2024-01-01T01:00:00Z',
            tariff_idle_fee_price_per_minute: '0.10',
            currency: 'USD',
          },
        ], // dispatchIdlingNotification: SELECT from charging_sessions
        [{ name: 'Test Site' }], // dispatchIdlingNotification: resolveSiteName
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
          currency: 'USD',
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
        [{ status: 'charging' }], // SELECT status FROM connectors (prevRows)
        [], // INSERT port_status_log
        [], // UPDATE connectors
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
        [{ status: 'suspended_ev' }], // SELECT status FROM connectors (prevRows)
        [], // INSERT port_status_log
        [], // UPDATE connectors
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
  });

  describe('ocpp.TransactionEvent', () => {
    it('creates session on Started event', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT charging_sessions
        [{ id: 'session-1' }], // SELECT id FROM charging_sessions
        [], // INSERT transaction_events
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
            currency: 'USD',
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
        expect.objectContaining({ transactionId: 'tx-1' }),
        ['/mock/templates'],
        expect.anything(),
      );
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

      expect(mockCalculateSessionCost).toHaveBeenCalled();
    });

    it('skips cost computation when no tariff on Ended', async () => {
      await import('@evtivity/lib');
      mockCalculateSessionCost.mockClear();
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
            currency: null,
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

      expect(mockCalculateSessionCost).not.toHaveBeenCalled();
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
        [{ driver_id: null }], // dispatchIdlingNotification: SELECT from charging_sessions (no driver)
        [{ name: null }], // dispatchIdlingNotification: resolveSiteName
        [], // dispatchIdlingNotification: SELECT guest_email FROM guest_sessions (no guest)
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

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [{ id: 'session-1' }], // SELECT id FROM charging_sessions
        [], // INSERT transaction_events
        [], // UPDATE idle_started_at (chargingState = EVConnected)
        [
          {
            driver_id: null,
            idle_started_at: '2024-01-01T01:00:00Z',
            tariff_idle_fee_price_per_minute: '0.10',
            currency: 'USD',
          },
        ], // dispatchIdlingNotification: SELECT from charging_sessions (no driver)
        [{ name: 'Test Site' }], // dispatchIdlingNotification: resolveSiteName
        [{ guest_email: 'guest@example.com' }], // dispatchIdlingNotification: SELECT guest_email
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
      await import('@evtivity/lib');
      mockCalculateSessionCost.mockClear();
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

      expect(mockCalculateSessionCost).toHaveBeenCalled();
      // idle_minutes = 15 (accumulated) + 60 (open period: 02:00 - 01:00) = 75
      const callArgs = mockCalculateSessionCost.mock.calls[0]!;
      expect(callArgs[3]).toBeCloseTo(75, 0);
    });

    it('transitions reservation to in_use when Started event includes reservationId', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT charging_sessions
        [{ id: 'session-1' }], // SELECT id FROM charging_sessions
        [], // UPDATE charging_sessions SET status='faulted' (close stale sessions)
        [], // SELECT evse_id FROM charging_sessions (returns empty → skip connector update)
        [], // INSERT transaction_events
        [], // SELECT free_vend_enabled (not free vend)
        [{ driver_id: null }], // SELECT driver_id FROM charging_sessions (no driver)
        // resolveTariff (no driver): station group, site group, default group — all empty
        [], // Priority 3: station pricing group
        [], // Priority 4: site pricing group
        [], // Priority 5: default pricing group
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
        [], // resolveActiveSessionId fallback
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

    it('recalculates cost for active sessions with tariff', async () => {
      await import('@evtivity/lib');
      mockCalculateSessionCost.mockClear();
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [], // resolveActiveSessionId fallback
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
        ], // active sessions with snapshot columns
        [], // UPDATE charging_sessions cost
        [{ transaction_id: 'tx-1' }], // SELECT transaction_id (cost changed)
        [], // pg_notify CostUpdated
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
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

      expect(mockCalculateSessionCost).toHaveBeenCalled();
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
        [], // resolveActiveSessionId fallback
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
        [], // resolveActiveSessionId fallback
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
    });

    it('sets idle_started_at when energy reading unchanged from previous', async () => {
      await setup();

      // Session has meter_start=1000 and energy_delivered_wh=5000 (meter was at 6000).
      // New reading is also 6000 (same as before), so energy is flat.
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [], // resolveActiveSessionId fallback
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
        [], // resolveActiveSessionId fallback
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
        [], // resolveActiveSessionId fallback
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

    it('passes non-zero idleMinutes to calculateSessionCost for active sessions', async () => {
      await import('@evtivity/lib');
      mockCalculateSessionCost.mockClear();
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [], // resolveActiveSessionId fallback
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
        [], // UPDATE charging_sessions cost
        [{ transaction_id: 'tx-1' }], // SELECT transaction_id
        [], // pg_notify CostUpdated
        [{ site_id: null }], // resolveSiteId
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.MeterValues',
        makeDomainEvent('ocpp.MeterValues', 'CS-001', {
          stationId: 'CS-001',
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

      expect(mockCalculateSessionCost).toHaveBeenCalled();
      // idle_minutes = 20 (accumulated), no open idle period (idle_started_at is null)
      const callArgs = mockCalculateSessionCost.mock.calls[0]!;
      expect(callArgs[3]).toBe(20);
    });

    it('populates session_id, evse_id, phase, location, context, unit, and source for 2.1 format', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'evs_000000000001' }], // resolveEvseUuid
        [{ id: 'ses_000000000001' }], // resolveActiveSessionId (by evse)
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
        [{ id: 'ses_000000000001' }], // resolveActiveSessionId (by transactionId)
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
        [{ id: 'ses_000000000001' }], // resolveActiveSessionId by transactionId
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

      // The resolveActiveSessionId query should include transactionId
      const sessionLookup = sqlCalls[1]!;
      expect(sessionLookup.strings.join('')).toContain('transaction_id');
      expect(sessionLookup.values).toContain('99999');
    });

    it('filters energy update by evse_id when available', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [{ id: 'evs_000000000001' }], // resolveEvseUuid
        [{ id: 'ses_000000000001' }], // resolveActiveSessionId
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
      expect(energyUpdate!.values).toContain('evs_000000000001');
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
      expect(insertCall!.values).toContain(JSON.stringify(signedData));
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
        [{ id: 'session-1', driver_id: 'driver-1' }], // SELECT from charging_sessions
        [], // INSERT payment_records
        [], // pg_notify (payment.settled)
      );

      await eventBus.emit(
        'ocpp.NotifySettlement',
        makeDomainEvent('ocpp.NotifySettlement', 'CS-001', {
          transactionId: 'tx-1',
          settlementAmount: 15.5,
        }),
      );

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
        [], // INSERT payment_records
        [], // pg_notify
      );

      await eventBus.emit(
        'ocpp.NotifySettlement',
        makeDomainEvent('ocpp.NotifySettlement', 'CS-001', {
          transactionId: 'tx-2',
          settlementAmount: 10,
        }),
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
    });
  });

  describe('ocpp.MessageLog', () => {
    it('inserts message log entry', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationId
        [], // INSERT ocpp_message_logs
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

      expect(sqlCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('uses stationDbId when provided', async () => {
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

      expect(sqlCalls.length).toBeGreaterThanOrEqual(1);
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
    it('registers subscribers for all notifiable events', async () => {
      await setup();

      const notifiableEvents = [
        'station.Connected',
        'station.Disconnected',
        'ocpp.Authorize',
        'ocpp.BootNotification',
        'ocpp.DataTransfer',
        'ocpp.FirmwareStatusNotification',
        'ocpp.Heartbeat',
        'ocpp.MeterValues',
        'ocpp.SecurityEventNotification',
        'ocpp.StatusNotification',
        'ocpp.TransactionEvent',
      ];

      for (const eventType of notifiableEvents) {
        const handlers = eventBus.subscribers.get(eventType);
        expect(handlers, `Missing subscriber for ${eventType}`).toBeDefined();
        expect(handlers!.length).toBeGreaterThanOrEqual(1);
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

  describe('ocpp.NotifyQRCodeScanned', () => {
    it('inserts QR code scan event', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [], // INSERT qr_scan_events
      );

      await eventBus.emit(
        'ocpp.NotifyQRCodeScanned',
        makeDomainEvent('ocpp.NotifyQRCodeScanned', 'CS-001', {
          evseId: 1,
          timeout: 30,
        }),
      );

      expect(sqlCalls.length).toBe(2);
      const insertCall = sqlCalls[1]!;
      expect(insertCall.strings.join('')).toContain('INSERT INTO qr_scan_events');
      expect(insertCall.values).toContain('sta_000000000001');
      expect(insertCall.values).toContain(1);
      expect(insertCall.values).toContain(30);
    });

    it('uses null for missing fields', async () => {
      await setup();

      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [], // INSERT qr_scan_events
      );

      await eventBus.emit(
        'ocpp.NotifyQRCodeScanned',
        makeDomainEvent('ocpp.NotifyQRCodeScanned', 'CS-001', {}),
      );

      expect(sqlCalls.length).toBe(2);
      const insertCall = sqlCalls[1]!;
      expect(insertCall.values).toContain(null);
    });

    it('skips if station not found', async () => {
      await setup();

      setupSqlResults(
        [], // resolveStationUuid returns no rows
      );

      await eventBus.emit(
        'ocpp.NotifyQRCodeScanned',
        makeDomainEvent('ocpp.NotifyQRCodeScanned', 'UNKNOWN-STATION', {
          evseId: 2,
          timeout: 60,
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

  describe('out-of-order message buffering', () => {
    it('buffers MeterValues when session not found and replays after Started', async () => {
      await setup();

      // MeterValues with transactionId but no active session
      // SQL calls: resolveStationUuid, resolveActiveSessionId (by tx_id), resolveActiveSessionId (fallback)
      setupSqlResults(
        [{ id: 'sta_000000000001' }], // resolveStationUuid
        [], // resolveActiveSessionId by transactionId (no session)
        [], // resolveActiveSessionId fallback (no session)
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
        [], // SELECT free_vend_enabled (not free vend)
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
      expect(mockCalculateSessionCost).not.toHaveBeenCalled();
    });
  });
});
