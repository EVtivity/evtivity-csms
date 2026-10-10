// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { EventBus, DomainEvent, PubSubClient } from '@evtivity/lib';

// The MeterValues projection with split billing on: the tariff that applies
// at the newest reading's timestamp (at most now) decides the segment switch,
// which happens at that timestamp (finding B5), and the session energy follows
// the register rules of session-energy (finding B10). The real session
// pricing, session energy and tariff resolver run on a mocked client that
// answers by statement text.

const sqlCalls: Array<{ text: string; values: unknown[] }> = [];

const db = {
  energyWh: 3000 as number | null,
  meterStart: 1000,
  offsetWh: 0,
  lastRegisterWh: 4000 as number | null,
  lastRegisterAt: '2026-06-04T16:59:00.000Z' as string | null,
  openSegment: {
    id: 1,
    tariff_id: 'trf_offpeak',
    started_at: '2026-06-04T16:00:00.000Z',
    energy_wh_start: '0',
  },
};

const OFF_PEAK = {
  id: 'trf_offpeak',
  name: 'Off-peak',
  price_per_kwh: '0.20',
  price_per_minute: null,
  price_per_session: null,
  idle_fee_price_per_minute: null,
  reservation_fee_per_minute: null,
  tax_rate: '0',
  restrictions: null,
  priority: 0,
  is_default: true,
};
const PEAK = {
  ...OFF_PEAK,
  id: 'trf_peak',
  name: 'Peak',
  price_per_kwh: '0.40',
  restrictions: { timeRange: { startTime: '17:00', endTime: '21:00' } },
  priority: 10,
  is_default: false,
};

function route(text: string, values: unknown[]): unknown[] {
  if (text.includes('SELECT id FROM charging_stations WHERE station_id')) return [{ id: 'sta-1' }];
  if (text.includes('SELECT id FROM evses WHERE station_id')) return [{ id: 'evse-1' }];
  if (text.includes('SELECT site_id FROM charging_stations')) return [{ site_id: null }];
  if (text.includes('SELECT id, evse_id, transaction_id FROM charging_sessions')) {
    return [{ id: 'session-1', evse_id: 'evse-1', transaction_id: 'tx-1' }];
  }
  if (text.includes('AS last_rise_at')) {
    return [{ id: 'session-1', last_rise_at: '2026-06-04T16:00:00.000Z' }];
  }
  if (text.includes('SELECT meter_start, meter_register_offset_wh')) {
    return [
      {
        meter_start: db.meterStart,
        meter_register_offset_wh: String(db.offsetWh),
        meter_last_register_wh: db.lastRegisterWh,
        meter_last_register_at: db.lastRegisterAt,
        energy_delivered_wh: db.energyWh,
      },
    ];
  }
  if (text.includes('meter_register_offset_wh = ?')) {
    db.offsetWh = values[1] as number;
    db.lastRegisterWh = values[2] as number;
    db.lastRegisterAt = values[3] as string;
    db.energyWh = values[4] as number;
    return [];
  }
  if (text.includes('SELECT cs.id, cs.transaction_id, cs.tariff_id')) {
    return [
      {
        id: 'session-1',
        transaction_id: 'tx-1',
        tariff_id: 'trf_offpeak',
        driver_id: null,
        token_id: null,
        energy_delivered_wh: db.energyWh,
        current_cost_cents: 100,
        cost_ceiling_cents: null,
        idle_started_at: null,
        idle_minutes: 0,
        ocpp_protocol: 'ocpp2.1',
      },
    ];
  }
  // The tariff resolver: a station of a group with an off-peak default and a
  // 17:00-21:00 peak tariff, evaluated in UTC.
  if (text.includes('WITH driver_group')) {
    return [OFF_PEAK, PEAK].map((t) => ({
      group_id: 'pgr_1',
      group_name: 'Public',
      group_priority: 3,
      timezone: 'UTC',
      ...t,
    }));
  }
  // The segment switch (switchTariffSegment).
  if (text.includes('SELECT idle_started_at, idle_minutes FROM charging_sessions')) {
    return [{ idle_started_at: null, idle_minutes: '0' }];
  }
  if (text.includes('SELECT tariff_id, started_at, energy_wh_start FROM session_tariff_segments')) {
    return [db.openSegment];
  }
  if (text.includes('SELECT id, tariff_id, started_at, energy_wh_start')) return [db.openSegment];
  if (text.includes('COALESCE(SUM(idle_minutes), 0)')) return [{ total: '0' }];
  if (text.includes('UPDATE session_tariff_segments') && text.includes('RETURNING id')) {
    return [{ id: db.openSegment.id }];
  }
  return [];
}

function createSqlMock() {
  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    sqlCalls.push({ text, values });
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
  isSplitBillingEnabled: vi.fn().mockResolvedValue(true),
}));

const mockPriceSessionAt = vi.fn(() =>
  Promise.resolve({
    basis: 'net',
    netCents: 120,
    taxCents: 0,
    grossCents: 120,
    taxLines: [],
    components: null,
  }),
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
    '../../../database/src/lib/session-energy.js',
  )),
  ...(await vi.importActual<Record<string, unknown>>(
    '../../../database/src/lib/tariff-resolution.js',
  )),
  ...(await vi.importActual<Record<string, unknown>>('../../../database/src/lib/pg-errors.js')),
  priceSessionAt: (...args: unknown[]) => mockPriceSessionAt(...(args as [])),
  storeRunningCost: vi.fn().mockResolvedValue(true),
  getCompanyTaxBasis: vi.fn().mockResolvedValue('net'),
  client: createSqlMock(),
  isRoamingEnabled: vi.fn().mockResolvedValue(false),
  getIdlingGracePeriodMinutes: vi.fn().mockResolvedValue(0),
  isSplitBillingEnabled: vi.fn().mockResolvedValue(true),
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

function meterValues(readings: Array<[string, number]>): DomainEvent {
  return {
    eventType: 'ocpp.MeterValues',
    aggregateType: 'ChargingStation',
    aggregateId: 'CS-1',
    payload: {
      stationId: 'CS-1',
      evseId: 1,
      transactionId: 'tx-1',
      source: 'TransactionEvent',
      meterValues: readings.map(([timestamp, registerWh]) => ({
        timestamp,
        sampledValue: [
          {
            value: registerWh,
            measurand: 'Energy.Active.Import.Register',
            unitOfMeasure: { unit: 'Wh' },
          },
        ],
      })),
    },
    occurredAt: new Date(),
  };
}

const segmentClose = () =>
  sqlCalls.find(
    (c) => c.text.includes('UPDATE session_tariff_segments') && c.text.includes('SET ended_at'),
  );
const boundaryRaise = () =>
  sqlCalls.filter(
    (c) =>
      c.text.includes('UPDATE session_tariff_segments') &&
      (c.text.includes('SET energy_wh_end = ?') || c.text.includes('SET energy_wh_start = ?')),
  );
const segmentInsert = () =>
  sqlCalls.find((c) => c.text.includes('INSERT INTO session_tariff_segments'));

describe('MeterValues with split billing: segment switches and register energy', () => {
  const pubsub: PubSubClient = {
    publish: vi.fn().mockResolvedValue(undefined),
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
    db.energyWh = 3000;
    db.meterStart = 1000;
    db.offsetWh = 0;
    db.lastRegisterWh = 4000;
    db.lastRegisterAt = '2026-06-04T16:59:00.000Z';
    db.openSegment = {
      id: 1,
      tariff_id: 'trf_offpeak',
      started_at: '2026-06-04T16:00:00.000Z',
      energy_wh_start: '0',
    };
    const { registerProjections } = await import('../server/event-projections.js');
    eventBus = createMockEventBus();
    registerProjections(eventBus, pubsub);
  });

  it('switches at the timestamp of a reading replayed after the boundary (B5)', async () => {
    // Delivered now (2026 and later), read at 17:00:30: the peak tariff
    // applies at the reading, so the switch happens there, not at now.
    await eventBus.emit('ocpp.MeterValues', meterValues([['2026-06-04T17:00:30.000Z', 4500]]));

    expect(db.energyWh).toBe(3500);
    const close = segmentClose();
    expect(close?.values[0]).toBe('2026-06-04T17:00:30.000Z');
    expect(close?.values[1]).toBe(3500);
    const insert = segmentInsert();
    expect(insert?.values.slice(0, 4)).toEqual([
      'session-1',
      'trf_peak',
      '2026-06-04T17:00:30.000Z',
      3500,
    ]);
  });

  it('switches at the newest reading of a delivery with several readings', async () => {
    await eventBus.emit(
      'ocpp.MeterValues',
      meterValues([
        ['2026-06-04T16:59:30.000Z', 4200],
        ['2026-06-04T17:00:00.000Z', 4400],
      ]),
    );
    expect(segmentClose()?.values[0]).toBe('2026-06-04T17:00:00.000Z');
    expect(segmentInsert()?.values[3]).toBe(3400);
  });

  it('switches nothing for a reading before the boundary', async () => {
    await eventBus.emit('ocpp.MeterValues', meterValues([['2026-06-04T16:59:59.000Z', 4300]]));
    expect(segmentClose()).toBeUndefined();
    expect(segmentInsert()).toBeUndefined();
  });

  it('switches nothing for a reading older than the open segment start (B5, B6)', async () => {
    // The open segment started at 21:00 (back to off-peak); a reading from
    // 17:00:30 replayed late resolves peak but is not after that start.
    db.openSegment = {
      id: 2,
      tariff_id: 'trf_offpeak',
      started_at: '2026-06-04T21:00:00.000Z',
      energy_wh_start: '6000',
    };
    db.lastRegisterAt = '2026-06-04T21:00:00.000Z';
    await eventBus.emit('ocpp.MeterValues', meterValues([['2026-06-04T17:00:30.000Z', 4500]]));
    expect(segmentClose()).toBeUndefined();
    // The older reading leaves the energy as it was (B10).
    expect(db.energyWh).toBe(3000);
  });

  it('moves the boundary energy up to a reading at or before a job switch (TC-T2-06)', async () => {
    // The boundary job switched to peak at 17:00:00.4 with the energy it
    // knew (2000 Wh); the reading taken at 17:00:00 arrives after it.
    db.openSegment = {
      id: 2,
      tariff_id: 'trf_peak',
      started_at: '2026-06-04T17:00:00.400Z',
      energy_wh_start: '2000',
    };
    await eventBus.emit('ocpp.MeterValues', meterValues([['2026-06-04T17:00:00.000Z', 4400]]));
    expect(segmentClose()).toBeUndefined();
    expect(segmentInsert()).toBeUndefined();
    // The energy at that reading (4400 - 1000 meter start) was delivered
    // before the boundary: the closed segment ends and the open one starts there.
    const [end, start] = boundaryRaise();
    expect(end?.text).toContain('SET energy_wh_end = ?');
    expect(end?.values[0]).toBe(3400);
    expect(start?.text).toContain('SET energy_wh_start = ?');
    expect(start?.values).toEqual([3400, 2]);
  });

  it('moves no boundary energy for a stale reading or one after the switch', async () => {
    db.openSegment = {
      id: 2,
      tariff_id: 'trf_peak',
      started_at: '2026-06-04T17:00:00.400Z',
      energy_wh_start: '2000',
    };
    // Older than the newest projected register reading: its energy at the
    // reading is not known (a later drop may have moved the offset).
    db.lastRegisterAt = '2026-06-04T17:00:20.000Z';
    await eventBus.emit('ocpp.MeterValues', meterValues([['2026-06-04T17:00:00.000Z', 4400]]));
    expect(boundaryRaise()).toEqual([]);
    // After the switch: energy delivered on the open segment.
    sqlCalls.length = 0;
    await eventBus.emit('ocpp.MeterValues', meterValues([['2026-06-04T17:00:30.000Z', 4500]]));
    expect(boundaryRaise()).toEqual([]);
  });

  it('never lowers the energy from an out-of-order reading (B10)', async () => {
    await eventBus.emit('ocpp.MeterValues', meterValues([['2026-06-04T16:30:00.000Z', 3000]]));
    expect(db.energyWh).toBe(3000);
    expect(db.lastRegisterWh).toBe(4000);
    expect(sqlCalls.some((c) => c.text.includes('meter_register_offset_wh = ?'))).toBe(false);
  });

  it('a power reading older than the newest register reading opens and closes no idle period (B11)', async () => {
    const event = meterValues([]);
    (event.payload as { meterValues: unknown[] }).meterValues = [
      {
        timestamp: '2026-06-04T16:30:00.000Z',
        sampledValue: [
          { value: 7000, measurand: 'Power.Active.Import', unitOfMeasure: { unit: 'W' } },
        ],
      },
    ];
    await eventBus.emit('ocpp.MeterValues', event);
    const close = sqlCalls.find((c) => c.text.includes('idle_started_at = NULL'));
    expect(close?.text).toContain('AND idle_started_at <= ?::timestamptz');
    expect(close?.text).toContain(
      'AND (meter_last_register_at IS NULL OR meter_last_register_at <= ?::timestamptz)',
    );
    expect(close?.text).toContain('GREATEST(0, EXTRACT(EPOCH');
  });

  it('rebases on a register reset and keeps counting from it (B10)', async () => {
    await eventBus.emit(
      'ocpp.MeterValues',
      meterValues([
        ['2026-06-04T16:59:20.000Z', 0],
        ['2026-06-04T16:59:40.000Z', 500],
      ]),
    );
    // 3000 Wh before the reset, then 500 Wh on the new register.
    expect(db.offsetWh).toBe(4000);
    expect(db.energyWh).toBe(3500);
  });

  it('a register drop opens no flat-energy idle period (B10, TC-T2-07)', async () => {
    // The meter is replaced: the energy is kept (3000 Wh), which is not a
    // flat reading, so the energy fallback opens no idle period.
    await eventBus.emit('ocpp.MeterValues', meterValues([['2026-06-04T16:59:20.000Z', 0]]));
    expect(db.offsetWh).toBe(4000);
    expect(db.energyWh).toBe(3000);
    expect(sqlCalls.some((c) => c.text.includes('SET idle_started_at = ?'))).toBe(false);
  });
});
