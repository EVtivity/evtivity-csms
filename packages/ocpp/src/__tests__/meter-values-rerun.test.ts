// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { EventBus, DomainEvent, PubSubClient } from '@evtivity/lib';

// The MeterValues projection run again after a lost database connection, as
// the retry runs it: each reading's idle update happens once, a rerun decides
// from what the first run read, and a cost ceiling stop does not fire early.

const sqlCalls: string[] = [];
// Rejects the `nth` (1-based) statement whose text includes `match`, `left` times.
let failOn: { match: string; code: string; nth: number; left: number } | null = null;
let matches = 0;

// The session the readings belong to, as the database holds it.
const db = {
  energyWh: 0,
  meterStart: 1000,
  idleStartedAt: null as string | null,
  // The reading that last raised the energy (energy_rose_at).
  energyRoseAt: null as string | null,
  costCents: 800 as number | null,
};

function connectionError(code: string): Error {
  return Object.assign(new Error(`write ${code} localhost:5433`), { code });
}

function route(text: string, values: unknown[]): unknown[] {
  if (text.includes('SELECT id FROM charging_stations WHERE station_id')) return [{ id: 'sta-1' }];
  if (text.includes('SELECT id FROM evses WHERE station_id')) return [{ id: 'evse-1' }];
  if (text.includes('SELECT site_id FROM charging_stations')) return [{ site_id: 'site-1' }];
  if (text.includes('SELECT id, evse_id, transaction_id FROM charging_sessions')) {
    return [{ id: 'session-1', evse_id: 'evse-1', transaction_id: 'tx-1' }];
  }
  if (text.includes('SELECT energy_delivered_wh, meter_start')) {
    return [
      {
        energy_delivered_wh: db.energyWh,
        meter_start: String(db.meterStart),
        last_rise_at: db.energyRoseAt,
      },
    ];
  }
  if (text.includes('SET energy_delivered_wh = GREATEST')) {
    const energyWh = Math.max(0, Number(values[0]) - db.meterStart);
    if (energyWh - db.energyWh >= 1) db.energyRoseAt = values[2] as string;
    db.energyWh = energyWh;
    return [];
  }
  if (text.includes('SET idle_started_at = ?') && text.includes('idle_started_at IS NULL')) {
    if (db.idleStartedAt == null) db.idleStartedAt = values[0] as string;
    return [];
  }
  if (text.includes('idle_started_at = NULL') && text.includes('idle_started_at IS NOT NULL')) {
    db.idleStartedAt = null;
    return [];
  }
  if (text.includes('SELECT cs.id, cs.transaction_id, cs.tariff_id')) {
    return [
      {
        id: 'session-1',
        transaction_id: 'tx-1',
        tariff_id: 'tariff-1',
        driver_id: null,
        token_id: null,
        energy_delivered_wh: db.energyWh,
        current_cost_cents: db.costCents,
        cost_ceiling_cents: 1000,
        idle_started_at: db.idleStartedAt,
        idle_minutes: 0,
        ocpp_protocol: 'ocpp2.1',
      },
    ];
  }
  return [];
}

function createSqlMock() {
  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    sqlCalls.push(text);
    if (failOn != null && failOn.left > 0 && text.includes(failOn.match)) {
      matches++;
      if (matches >= failOn.nth) {
        failOn.left--;
        return Promise.reject(connectionError(failOn.code));
      }
    }
    return Promise.resolve(route(text, values));
  };
  (sqlFn as unknown as { json: (v: unknown) => unknown }).json = (v) => v;
  (sqlFn as unknown as { unsafe: (text: string) => string }).unsafe = (text) => text;
  (sqlFn as unknown as { begin: (fn: (tx: unknown) => unknown) => unknown }).begin = (fn) =>
    fn(sqlFn);
  return sqlFn as unknown;
}

vi.mock('postgres', () => {
  const factory = () => createSqlMock();
  factory.PostgresError = class extends Error {};
  return { default: factory };
});

vi.mock('../../../database/src/lib/idling-setting.js', () => ({
  getIdlingGracePeriodMinutes: vi.fn().mockResolvedValue(0),
}));
vi.mock('../../../database/src/lib/pricing-settings.js', () => ({
  isSplitBillingEnabled: vi.fn().mockResolvedValue(false),
}));

// Every reading prices the session at 12.00, above its 10.00 ceiling.
const mockStoreRunningCost = vi.fn(
  (_sql: unknown, _sessionId: string, b: { grossCents: number }) => {
    db.costCents = b.grossCents;
    return Promise.resolve(true);
  },
);
vi.mock('@evtivity/database', async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../database/src/lib/session-end-request.js',
  )),
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../database/src/lib/station-status.js',
  )),
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../database/src/lib/driver-availability.js',
  )),
  ...(await vi.importActual<Record<string, unknown>>('../../../database/src/lib/station-watch.js')),
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../database/src/lib/session-pricing.js',
  )),
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../database/src/lib/tariff-resolution.js',
  )),
  ...(await vi.importActual<Record<string, unknown>>('../../../database/src/lib/pg-errors.js')),
  priceSessionAt: vi.fn(() =>
    Promise.resolve({
      basis: 'net',
      netCents: 1200,
      taxCents: 0,
      grossCents: 1200,
      taxLines: [],
      components: null,
    }),
  ),
  storeRunningCost: (...args: Parameters<typeof mockStoreRunningCost>) =>
    mockStoreRunningCost(...args),
  getCompanyTaxBasis: vi.fn().mockResolvedValue('net'),
  client: createSqlMock(),
  isRoamingEnabled: vi.fn().mockResolvedValue(false),
  getIdlingGracePeriodMinutes: vi.fn().mockResolvedValue(0),
  isSplitBillingEnabled: vi.fn().mockResolvedValue(false),
  getOfflineCommandTtlHours: vi.fn().mockResolvedValue(24),
  isSiteFreeVendEnabledByStation: vi.fn().mockResolvedValue(false),
  getCompanyCurrency: vi.fn().mockResolvedValue('USD'),
  getCompanyPriceDisplay: vi.fn().mockResolvedValue('net'),
  writeReservationAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../server/notification-dispatcher.js', () => ({
  dispatchOcppNotification: vi.fn().mockResolvedValue(undefined),
  dispatchDriverNotification: vi.fn().mockResolvedValue(undefined),
  dispatchSystemNotification: vi.fn().mockResolvedValue(undefined),
  ALL_TEMPLATES_DIRS: ['/mock/templates'],
}));

vi.mock('../lib/payments.js', () => ({
  paymentRegistry: {},
  paymentContext: () => ({ registry: {}, logger: {} }),
  activePaymentProvider: () => Promise.resolve({ id: 'stripe' }),
}));

// No backoff between runs. The number of runs stays the subscription's own
// (retryOnConnectionError), so these tests also check that it retries.
vi.mock('../server/projection-retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/projection-retry.js')>();
  return {
    ...actual,
    runProjectionWithRetry: (
      work: Parameters<typeof actual.runProjectionWithRetry>[0],
      options: Parameters<typeof actual.runProjectionWithRetry>[1],
    ) =>
      actual.runProjectionWithRetry(work, {
        ...options,
        baseDelayMs: 0,
        maxDelayMs: 0,
      }),
  };
});

function createMockEventBus() {
  const subscribers = new Map<string, Array<(event: DomainEvent) => Promise<void>>>();
  return {
    subscribe(eventType: string, handler: (event: DomainEvent) => Promise<void>) {
      const handlers = subscribers.get(eventType) ?? [];
      handlers.push(handler);
      subscribers.set(eventType, handlers);
    },
    async emit(eventType: string, event: DomainEvent) {
      for (const handler of subscribers.get(eventType) ?? []) {
        await handler(event);
      }
    },
    track: <T>(work: Promise<T>) => work,
    publish: vi.fn(),
  } as unknown as EventBus & { emit: (eventType: string, event: DomainEvent) => Promise<void> };
}

function energyReading(timestamp: string, registerWh: number): Record<string, unknown> {
  return {
    timestamp,
    sampledValue: [
      {
        value: registerWh,
        measurand: 'Energy.Active.Import.Register',
        unitOfMeasure: { unit: 'Wh' },
      },
    ],
  };
}

function meterValues(readings: Array<Record<string, unknown>>): DomainEvent {
  return {
    eventType: 'ocpp.MeterValues',
    aggregateType: 'ChargingStation',
    aggregateId: 'CS-1',
    payload: {
      stationId: 'CS-1',
      evseId: 1,
      transactionId: 'tx-1',
      source: 'TransactionEvent',
      meterValues: readings,
    },
    occurredAt: new Date(),
  };
}

function countCalls(fragment: string, also?: string): number {
  return sqlCalls.filter((text) => text.includes(fragment) && (also == null || text.includes(also)))
    .length;
}

const IDLE_OPEN = 'SET idle_started_at = ?';
const IDLE_CLOSE = 'idle_started_at = NULL';

describe('MeterValues run again after a lost connection', () => {
  const publish = vi.fn().mockResolvedValue(undefined);
  const pubsub: PubSubClient = {
    publish,
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  let eventBus: ReturnType<typeof createMockEventBus>;

  beforeAll(async () => {
    await import('../server/event-projections.js');
  }, 60_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    failOn = null;
    matches = 0;
    // An idle period is open; the last reading put the session at 3000 Wh.
    db.energyWh = 3000;
    db.meterStart = 1000;
    db.idleStartedAt = '2026-10-07T09:50:00.000Z';
    db.energyRoseAt = '2026-10-07T09:40:00.000Z';
    db.costCents = 800;
    const { registerProjections } = await import('../server/event-projections.js');
    eventBus = createMockEventBus();
    registerProjections(eventBus, pubsub);
  });

  function stopCommands(): unknown[] {
    return publish.mock.calls.filter(
      (call) => call[0] === 'ocpp_commands' && String(call[1]).includes('RequestStopTransaction'),
    );
  }

  it('decides reading 1 from its first read when its idle close fails', async () => {
    // Reading 1 raises the energy (closes the idle period), reading 2 is flat
    // (opens a new one). The close never reaches the server.
    failOn = { match: IDLE_CLOSE, code: 'CONNECT_TIMEOUT', nth: 1, left: 1 };

    await eventBus.emit(
      'ocpp.MeterValues',
      meterValues([
        energyReading('2026-10-07T10:00:00.000Z', 5000),
        energyReading('2026-10-07T10:01:00.000Z', 5000),
      ]),
    );

    // A rerun reading the energy the first run wrote would see reading 1 as
    // flat and keep the old idle period open.
    expect(countCalls('SELECT energy_delivered_wh, meter_start')).toBe(2);
    expect(countCalls(IDLE_CLOSE)).toBe(2);
    expect(countCalls(IDLE_OPEN, 'idle_started_at IS NULL')).toBe(1);
    expect(db.idleStartedAt).toBe('2026-10-07T10:01:00.000Z');
    expect(db.energyWh).toBe(4000);
  });

  it('runs each idle update once per reading when a later step fails', async () => {
    failOn = {
      match: 'SELECT site_id FROM charging_stations',
      code: 'CONNECT_TIMEOUT',
      nth: 1,
      left: 1,
    };

    await eventBus.emit(
      'ocpp.MeterValues',
      meterValues([
        energyReading('2026-10-07T10:00:00.000Z', 5000),
        energyReading('2026-10-07T10:01:00.000Z', 5000),
      ]),
    );

    expect(countCalls('SELECT site_id FROM charging_stations')).toBe(2);
    expect(countCalls('SELECT energy_delivered_wh, meter_start')).toBe(2);
    expect(countCalls(IDLE_CLOSE)).toBe(1);
    expect(countCalls(IDLE_OPEN, 'idle_started_at IS NULL')).toBe(1);
    expect(db.idleStartedAt).toBe('2026-10-07T10:01:00.000Z');
  });

  it('does not stop a 2.1 guest session early when run again after the cost was stored', async () => {
    // The cost moves from 8.00 to 12.00, past the 10.00 hold: the station got
    // the hold as its transaction limit and suspends itself, so the CSMS does
    // not stop it on this reading. A rerun reading 12.00 as the previous cost
    // would.
    failOn = {
      match: 'SELECT site_id FROM charging_stations',
      code: 'CONNECT_TIMEOUT',
      nth: 1,
      left: 1,
    };

    await eventBus.emit(
      'ocpp.MeterValues',
      meterValues([energyReading('2026-10-07T10:00:00.000Z', 5000)]),
    );

    expect(countCalls('SELECT site_id FROM charging_stations')).toBe(2);
    expect(countCalls('SELECT cs.id, cs.transaction_id, cs.tariff_id')).toBe(1);
    expect(mockStoreRunningCost).toHaveBeenCalledTimes(2);
    expect(stopCommands()).toHaveLength(0);
  });
});
