// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockExecute = vi.fn();
const mockGetCompanyCurrency = vi.fn();
const mockQueryRevenueTotal = vi.fn();
const mockLoggerError = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerDebug = vi.fn();
const mockGetOcppFleetHealth = vi.fn();
// The queries run under a statement timeout go through db.transaction:
// mockSetConfig gets the set_config statement, mockTxQuery the query itself.
const mockSetConfig = vi.fn();
const mockTxQuery = vi.fn();

type MockSql = { strings: string[]; values: unknown[] };

function sqlText(q: MockSql): string {
  return q.strings
    .map((s, i) => {
      const v = q.values[i] as { raw?: string } | undefined;
      return s + (v?.raw ?? '');
    })
    .join('');
}

function txExecute(q: MockSql): unknown {
  return sqlText(q).includes('set_config') ? mockSetConfig(q) : mockTxQuery(q);
}
const EMPTY_FLEET = {
  instanceCount: 0,
  connectedStations: 0,
  avgPingLatencyMs: 0,
  maxPingLatencyMs: 0,
  pingSuccessRate: 100,
  totalPingsSent: 0,
  totalPongsReceived: 0,
  serverStartedAt: null,
  updatedAt: null,
  instances: [],
};

vi.mock('@evtivity/database', async () => ({
  ...(await import('./helpers/conformance-station-mocks.js')).conformanceStationMocks(),
  client: {},
  db: {
    execute: mockExecute,
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ execute: txExecute }),
  },
  getCompanyCurrency: mockGetCompanyCurrency,
  getOcppFleetHealth: () => mockGetOcppFleetHealth(),
  pgErrorCode: (err: unknown) =>
    (err as { cause?: { code?: string } } | null)?.cause?.code ??
    (err as { code?: string } | null)?.code,
}));

vi.mock('drizzle-orm', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { raw: (text: string) => ({ raw: text }) },
  ),
}));

vi.mock('../lib/payment-site-scope.js', () => ({
  paymentRecordsOfOperatorStations: () => ({ raw: 'PAYMENTS_OF_OPERATOR_STATIONS' }),
}));

vi.mock('@evtivity/lib', () => ({
  createLogger: () => ({
    error: mockLoggerError,
    warn: mockLoggerWarn,
    info: vi.fn(),
    debug: mockLoggerDebug,
  }),
}));

vi.mock('@evtivity/services/session-revenue', () => ({
  queryRevenueTotal: (input: unknown) => mockQueryRevenueTotal(input),
}));

const {
  collectBusinessMetrics,
  startMetricsCollector,
  stopMetricsCollector,
  METRICS_QUERY_TIMEOUT_MS,
} = await import('../services/metrics-collector.service.js');
const m = await import('../plugins/metrics.js');

type Gauge = {
  get: () => Promise<{ values: Array<{ labels: Record<string, unknown>; value: number }> }>;
};

async function series(g: Gauge, label: string): Promise<Array<[unknown, number]>> {
  const { values } = await g.get();
  return values
    .map((v) => [v.labels[label], v.value] as [unknown, number])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

async function single(g: Gauge): Promise<number | undefined> {
  const { values } = await g.get();
  return values[0]?.value;
}

/**
 * The results of the two queries run under the statement timeout, by table:
 * transaction events by trigger and the heartbeat count. A result that is an
 * Error rejects the query with it.
 */
function queueTimedResults(txEvents: unknown, heartbeats: unknown): void {
  mockTxQuery.mockImplementation((q: MockSql) => {
    const result = sqlText(q).includes('ocpp_message_logs') ? heartbeats : txEvents;
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
}

function canceledByTimeout(): Error {
  return Object.assign(new Error('Failed query'), {
    cause: { code: '57014', message: 'canceling statement due to statement timeout' },
  });
}

/** The db.execute results, in the order collectBusinessMetrics issues the queries. */
function queueResults(): void {
  const results: unknown[] = [
    [{ count: 12 }], // drivers
    [{ count: '5' }], // active drivers (string from the driver)
    [
      { is_online: true, count: 3 },
      { is_online: false, count: '2' },
    ], // stations
    [
      { status: 'available', count: 7 },
      { status: 'charging', count: 'x' },
    ], // connectors (unparseable count becomes 0)
    [{ count: 4 }], // active sessions
    [
      { status: 'active', count: 4 },
      { status: 'completed', count: 9 },
    ], // sessions by status
    [
      { hour: 8, avg_count: '1.5' },
      { hour: 17, avg_count: 2.25 },
    ], // sessions by hour
    [{ total: '987654' }], // energy
    [
      { status: 'confirmed', count: 2 },
      { status: 'cancelled', count: 1 },
    ], // reservations
    [{ count: 3 }], // support
    [{ count: 2 }], // sites
    [{ count: 1 }], // fleets
    [{ count: 6 }], // tariffs
    [{ avg_kwh: '12.5', avg_duration_seconds: 3600 }], // averages
    [{ count: 1 }], // idle
    [{ count: 0 }], // firmware
    [{ status: 'captured', count: 11 }], // payments
  ];
  for (const r of results) mockExecute.mockResolvedValueOnce(r);
  queueTimedResults([{ trigger_reason: 'Authorized', count: 8 }], [{ count: 1440 }]);
  const started = new Date('2026-10-09T00:00:00Z');
  const instance = (instanceId: string, connectedStations: number) => ({
    instanceId,
    connectedStations,
    avgPingLatencyMs: 20,
    maxPingLatencyMs: 90,
    pingSuccessRate: 98,
    totalPingsSent: 100,
    totalPongsReceived: 98,
    serverStartedAt: started,
    updatedAt: started,
  });
  mockGetOcppFleetHealth.mockResolvedValueOnce({
    ...EMPTY_FLEET,
    instanceCount: 2,
    connectedStations: 5,
    avgPingLatencyMs: 20.5,
    maxPingLatencyMs: 90,
    pingSuccessRate: 98,
    instances: [instance('ocpp-a', 3), instance('ocpp-b', 2)],
  });
}

describe('collectBusinessMetrics gauges', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockSetConfig.mockReset().mockResolvedValue([]);
    mockTxQuery.mockReset().mockResolvedValue([]);
    mockLoggerError.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerDebug.mockReset();
    mockGetOcppFleetHealth.mockReset().mockResolvedValue(EMPTY_FLEET);
    mockGetCompanyCurrency.mockReset().mockResolvedValue('USD');
    mockQueryRevenueTotal.mockReset().mockResolvedValue({ grossCents: 500 });
  });

  it('leaves conformance stations and their rows out of every station and session query', async () => {
    queueResults();
    await collectBusinessMetrics();

    const texts = mockExecute.mock.calls.map((call) => sqlText(call[0] as MockSql));
    const timedTexts = mockTxQuery.mock.calls.map((call) => sqlText(call[0] as MockSql));
    expect(timedTexts).toHaveLength(2);
    for (const text of timedTexts) expect(text).toMatch(/OPERATOR_STATION_ID/);
    // Drivers, support cases, sites, fleets and tariffs are not station rows.
    const unfiltered = new Set([0, 9, 10, 11, 12]);
    texts.forEach((text, i) => {
      if (unfiltered.has(i)) {
        expect(text).not.toMatch(/OPERATOR_STATION/);
      } else {
        expect(text).toMatch(/OPERATOR_STATION|PAYMENTS_OF_OPERATOR_STATIONS/);
      }
    });
    expect(texts[2]).toContain('OPERATOR_STATION(charging_stations)');
    expect(texts[3]).toContain('OPERATOR_STATION(st)');
    expect(texts[4]).toContain('OPERATOR_STATION_ID(charging_sessions.station_id)');
  });

  it('sets every gauge from the query rows', async () => {
    queueResults();
    await collectBusinessMetrics();

    expect(mockExecute).toHaveBeenCalledTimes(17);
    expect(mockTxQuery).toHaveBeenCalledTimes(2);
    expect(mockGetOcppFleetHealth).toHaveBeenCalledTimes(1);
    expect(await single(m.driversTotal)).toBe(12);
    expect(await single(m.driversActive)).toBe(5);
    expect(await series(m.stationsTotal, 'is_online')).toEqual([
      ['false', 2],
      ['true', 3],
    ]);
    expect(await series(m.connectorsTotal, 'status')).toEqual([
      ['available', 7],
      ['charging', 0],
    ]);
    expect(await single(m.sessionsActive)).toBe(4);
    expect(await series(m.sessionsByStatus, 'status')).toEqual([
      ['active', 4],
      ['completed', 9],
    ]);
    expect(await series(m.sessionsByHour, 'hour')).toEqual([
      ['17', 2.25],
      ['8', 1.5],
    ]);
    expect(await single(m.energyDeliveredWhTotal)).toBe(987654);
    expect(await series(m.reservationsByStatus, 'status')).toEqual([
      ['cancelled', 1],
      ['confirmed', 2],
    ]);
    expect(await single(m.supportCasesOpen)).toBe(3);
    expect(await single(m.sitesTotal)).toBe(2);
    expect(await single(m.fleetsTotal)).toBe(1);
    expect(await single(m.tariffsActive)).toBe(6);
    expect(await single(m.avgSessionKwh)).toBe(12.5);
    expect(await single(m.avgSessionDurationSeconds)).toBe(3600);
    expect(await single(m.idleSessionsActive)).toBe(1);
    expect(await single(m.firmwareUpdatesPending)).toBe(0);
    expect(await series(m.ocppTransactionsByTrigger, 'trigger_reason')).toEqual([
      ['Authorized', 8],
    ]);
    expect(await series(m.paymentsByStatus, 'status')).toEqual([['captured', 11]]);
    expect(await single(m.ocppConnectedStations)).toBe(5);
    expect(await single(m.ocppPingLatencyAvgMs)).toBe(20.5);
    expect(await single(m.ocppPingLatencyMaxMs)).toBe(90);
    expect(await single(m.ocppPingSuccessRate)).toBe(98);
    expect(await single(m.ocppInstances)).toBe(2);
    expect(await series(m.ocppInstanceConnectedStations, 'ocpp_instance')).toEqual([
      ['ocpp-a', 3],
      ['ocpp-b', 2],
    ]);
    expect(await single(m.ocppHeartbeatsTotal)).toBe(1440);
  });

  it('drops the series of a process that stopped reporting', async () => {
    queueResults();
    await collectBusinessMetrics();
    mockExecute.mockResolvedValue([]);
    mockGetOcppFleetHealth.mockResolvedValueOnce(EMPTY_FLEET);

    await collectBusinessMetrics();

    expect(await single(m.ocppInstances)).toBe(0);
    expect(await single(m.ocppConnectedStations)).toBe(0);
    expect(await series(m.ocppInstanceConnectedStations, 'ocpp_instance')).toEqual([]);
  });

  it('logs and keeps the previous values when a query fails', async () => {
    queueResults();
    await collectBusinessMetrics();
    mockExecute.mockReset().mockRejectedValue(new Error('db down'));

    await collectBusinessMetrics();

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'db down' }),
      'Failed to collect business metrics',
    );
    expect(await single(m.driversTotal)).toBe(12);
  });

  it('runs the large table window queries under the statement timeout', async () => {
    queueResults();
    await collectBusinessMetrics();

    expect(mockSetConfig).toHaveBeenCalledTimes(2);
    for (const call of mockSetConfig.mock.calls) {
      const q = call[0] as MockSql;
      expect(sqlText(q)).toContain("set_config('statement_timeout'");
      expect(q.values).toContain(String(METRICS_QUERY_TIMEOUT_MS));
    }
    const timed = mockTxQuery.mock.calls.map((call) => sqlText(call[0] as MockSql));
    expect(timed.some((t) => t.includes('FROM ocpp_message_logs'))).toBe(true);
    expect(timed.some((t) => t.includes('FROM transaction_events'))).toBe(true);
  });

  it('keeps the previous value of a query the timeout cancelled and sets the rest', async () => {
    queueResults();
    await collectBusinessMetrics();
    expect(await single(m.ocppHeartbeatsTotal)).toBe(1440);

    queueResults();
    queueTimedResults([{ trigger_reason: 'Deauthorized', count: 3 }], canceledByTimeout());
    await collectBusinessMetrics();

    expect(await single(m.ocppHeartbeatsTotal)).toBe(1440);
    expect(await series(m.ocppTransactionsByTrigger, 'trigger_reason')).toEqual([
      ['Deauthorized', 3],
    ]);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { metric: 'ocpp_heartbeats_total', timeoutMs: METRICS_QUERY_TIMEOUT_MS },
      'Metrics query timed out, keeping the previous value',
    );
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('keeps the trigger series when its query times out', async () => {
    queueResults();
    await collectBusinessMetrics();

    queueResults();
    queueTimedResults(canceledByTimeout(), [{ count: 7 }]);
    await collectBusinessMetrics();

    expect(await series(m.ocppTransactionsByTrigger, 'trigger_reason')).toEqual([
      ['Authorized', 8],
    ]);
    expect(await single(m.ocppHeartbeatsTotal)).toBe(7);
  });

  it('fails the run on any other error of a timed query', async () => {
    queueResults();
    await collectBusinessMetrics();

    queueResults();
    queueTimedResults([], new Error('connection reset'));
    await collectBusinessMetrics();

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'connection reset' }),
      'Failed to collect business metrics',
    );
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(await single(m.ocppHeartbeatsTotal)).toBe(1440);
  });

  it('never starts a run while the previous one is still running', async () => {
    mockExecute.mockResolvedValue([]);
    let finish: (value: unknown) => void = () => {};
    mockQueryRevenueTotal.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    const first = collectBusinessMetrics();
    await collectBusinessMetrics();
    await collectBusinessMetrics();

    expect(mockQueryRevenueTotal).toHaveBeenCalledTimes(1);
    expect(mockLoggerDebug).toHaveBeenCalledTimes(2);
    expect(mockLoggerDebug).toHaveBeenCalledWith(
      'Metrics collection skipped, the previous run is still running',
    );

    finish({ grossCents: 1 });
    await first;

    // The guard is released when the run ends, also after a failure.
    await collectBusinessMetrics();
    expect(mockQueryRevenueTotal).toHaveBeenCalledTimes(2);
    mockQueryRevenueTotal.mockRejectedValueOnce(new Error('revenue down'));
    await collectBusinessMetrics();
    await collectBusinessMetrics();
    expect(mockQueryRevenueTotal).toHaveBeenCalledTimes(4);
  });

  it('treats non-array results as no rows', async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    await collectBusinessMetrics();
    expect(await single(m.driversTotal)).toBe(0);
    expect(await series(m.stationsTotal, 'is_online')).toEqual([]);
  });
});

describe('startMetricsCollector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockExecute.mockReset().mockResolvedValue([]);
    mockGetCompanyCurrency.mockReset().mockResolvedValue('USD');
    mockQueryRevenueTotal.mockReset().mockResolvedValue({ grossCents: 0 });
  });

  afterEach(() => {
    stopMetricsCollector();
    vi.useRealTimers();
  });

  it('collects at once, then on every interval until stopped', async () => {
    startMetricsCollector(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockQueryRevenueTotal).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockQueryRevenueTotal).toHaveBeenCalledTimes(2);

    stopMetricsCollector();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockQueryRevenueTotal).toHaveBeenCalledTimes(2);
  });

  it('stop is a no-op when the collector is not running', () => {
    expect(() => {
      stopMetricsCollector();
    }).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
