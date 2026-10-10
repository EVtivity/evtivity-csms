// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import {
  LEGACY_OCPP_HEALTH_ID,
  OCPP_HEALTH_STALE_MS,
  aggregateOcppHealth,
  getOcppFleetHealth,
  pruneStaleOcppHealth,
} from '../lib/ocpp-server-health.js';
import type { OcppInstanceHealth } from '../lib/ocpp-server-health.js';

const NOW = new Date('2026-10-09T12:00:00Z');

function row(
  instanceId: string,
  over: Partial<OcppInstanceHealth> & { ageMs?: number } = {},
): OcppInstanceHealth {
  const { ageMs = 10_000, ...rest } = over;
  return {
    instanceId,
    connectedStations: 0,
    avgPingLatencyMs: 0,
    maxPingLatencyMs: 0,
    pingSuccessRate: 100,
    totalPingsSent: 0,
    totalPongsReceived: 0,
    serverStartedAt: new Date('2026-10-09T10:00:00Z'),
    updatedAt: new Date(NOW.getTime() - ageMs),
    ...rest,
  };
}

describe('aggregateOcppHealth', () => {
  it('returns the empty fleet when no process reports', () => {
    expect(aggregateOcppHealth([], NOW)).toEqual({
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
    });
  });

  it('sums stations and pings, weights latency by stations, and takes the max latency', () => {
    const a = row('ocpp-b', {
      connectedStations: 764,
      avgPingLatencyMs: 10,
      maxPingLatencyMs: 80,
      totalPingsSent: 7640,
      totalPongsReceived: 7640,
      serverStartedAt: new Date('2026-10-09T09:00:00Z'),
      ageMs: 20_000,
    });
    const b = row('ocpp-a', {
      connectedStations: 736,
      avgPingLatencyMs: 30,
      maxPingLatencyMs: 250,
      totalPingsSent: 7360,
      totalPongsReceived: 6624,
      serverStartedAt: new Date('2026-10-09T11:00:00Z'),
      ageMs: 5_000,
    });

    const fleet = aggregateOcppHealth([a, b], NOW);

    expect(fleet.instanceCount).toBe(2);
    expect(fleet.connectedStations).toBe(1500);
    // (764 * 10 + 736 * 30) / 1500
    expect(fleet.avgPingLatencyMs).toBe(19.81);
    expect(fleet.maxPingLatencyMs).toBe(250);
    expect(fleet.totalPingsSent).toBe(15000);
    expect(fleet.totalPongsReceived).toBe(14264);
    // 14264 / 15000
    expect(fleet.pingSuccessRate).toBe(95.09);
    expect(fleet.serverStartedAt).toEqual(new Date('2026-10-09T09:00:00Z'));
    expect(fleet.updatedAt).toEqual(new Date(NOW.getTime() - 5_000));
    expect(fleet.instances.map((i) => i.instanceId)).toEqual(['ocpp-a', 'ocpp-b']);
  });

  it('ignores rows older than the staleness threshold', () => {
    const fresh = row('ocpp-a', { connectedStations: 10, ageMs: OCPP_HEALTH_STALE_MS });
    const stale = row('ocpp-dead', { connectedStations: 900, ageMs: OCPP_HEALTH_STALE_MS + 1 });

    const fleet = aggregateOcppHealth([fresh, stale], NOW);

    expect(fleet.instanceCount).toBe(1);
    expect(fleet.connectedStations).toBe(10);
    expect(fleet.instances.map((i) => i.instanceId)).toEqual(['ocpp-a']);
  });

  it('counts a fresh v0.1.42 singleton row as one more process during a rolling upgrade', () => {
    const legacy = row(LEGACY_OCPP_HEALTH_ID, { connectedStations: 700 });
    const upgraded = row('ocpp-new', { connectedStations: 800 });

    expect(aggregateOcppHealth([legacy, upgraded], NOW).connectedStations).toBe(1500);
  });

  it('drops the singleton row once the last v0.1.42 process stops writing it', () => {
    const legacy = row(LEGACY_OCPP_HEALTH_ID, {
      connectedStations: 700,
      ageMs: OCPP_HEALTH_STALE_MS + 1,
    });
    const upgraded = row('ocpp-new', { connectedStations: 1500 });

    const fleet = aggregateOcppHealth([legacy, upgraded], NOW);
    expect(fleet.connectedStations).toBe(1500);
    expect(fleet.instanceCount).toBe(1);
  });

  it('reports 0 latency when no station is connected and 100% success without pings', () => {
    const idle = row('ocpp-a', { avgPingLatencyMs: 40, maxPingLatencyMs: 40 });

    const fleet = aggregateOcppHealth([idle], NOW);
    expect(fleet.avgPingLatencyMs).toBe(0);
    expect(fleet.maxPingLatencyMs).toBe(40);
    expect(fleet.pingSuccessRate).toBe(100);
  });
});

describe('getOcppFleetHealth', () => {
  it('judges freshness against database time', async () => {
    const dbNow = new Date('2026-10-09T12:00:00Z');
    const rows = [
      {
        id: 'ocpp-a',
        connected_stations: 5,
        avg_ping_latency_ms: 12,
        max_ping_latency_ms: 20,
        ping_success_rate: 100,
        total_pings_sent: 5,
        total_pongs_received: 5,
        server_started_at: new Date('2026-10-09T11:00:00Z'),
        updated_at: new Date('2026-10-09T11:59:50Z'),
        now: dbNow,
      },
      {
        id: 'ocpp-dead',
        connected_stations: 9,
        avg_ping_latency_ms: 12,
        max_ping_latency_ms: 20,
        ping_success_rate: 100,
        total_pings_sent: 9,
        total_pongs_received: 9,
        server_started_at: new Date('2026-10-09T10:00:00Z'),
        updated_at: new Date('2026-10-09T11:50:00Z'),
        now: dbNow,
      },
    ];
    const sql = vi.fn().mockResolvedValue(rows) as unknown as postgres.Sql;

    const fleet = await getOcppFleetHealth(sql);

    expect(fleet.instanceCount).toBe(1);
    expect(fleet.connectedStations).toBe(5);
    expect(fleet.avgPingLatencyMs).toBe(12);
  });
});

describe('pruneStaleOcppHealth', () => {
  it('deletes rows older than the prune age and returns the count', async () => {
    const sql = vi.fn().mockResolvedValue({ count: 2 }) as unknown as postgres.Sql;

    expect(await pruneStaleOcppHealth(sql, 120_000)).toBe(2);
    const [strings, seconds] = (sql as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      readonly string[],
      number,
    ];
    expect(strings.join('?')).toContain('DELETE FROM ocpp_server_health');
    expect(seconds).toBe(120);
  });
});
