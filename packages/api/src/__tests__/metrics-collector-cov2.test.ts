// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockExecute = vi.fn();
const mockGetCompanyCurrency = vi.fn();
const mockQueryRevenueTotal = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('@evtivity/database', () => ({
  db: { execute: mockExecute },
  getCompanyCurrency: mockGetCompanyCurrency,
}));

vi.mock('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

vi.mock('@evtivity/lib', () => ({
  createLogger: () => ({ error: mockLoggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@evtivity/services/session-revenue', () => ({
  queryRevenueTotal: (input: unknown) => mockQueryRevenueTotal(input),
}));

const { collectBusinessMetrics, startMetricsCollector, stopMetricsCollector } =
  await import('../services/metrics-collector.service.js');
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
    [{ trigger_reason: 'Authorized', count: 8 }], // tx events
    [{ status: 'captured', count: 11 }], // payments
    [
      {
        connected_stations: 5,
        avg_ping_latency_ms: '20.5',
        max_ping_latency_ms: 90,
        ping_success_rate: '0.98',
      },
    ], // ocpp health
    [{ count: 1440 }], // heartbeats
  ];
  for (const r of results) mockExecute.mockResolvedValueOnce(r);
}

describe('collectBusinessMetrics gauges', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockGetCompanyCurrency.mockReset().mockResolvedValue('USD');
    mockQueryRevenueTotal.mockReset().mockResolvedValue({ grossCents: 500 });
  });

  it('sets every gauge from the query rows', async () => {
    queueResults();
    await collectBusinessMetrics();

    expect(mockExecute).toHaveBeenCalledTimes(20);
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
    expect(await single(m.ocppPingSuccessRate)).toBe(0.98);
    expect(await single(m.ocppHeartbeatsTotal)).toBe(1440);
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
