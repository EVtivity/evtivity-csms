// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';

// ocpp_server_health holds one row per OCPP process, keyed by the process
// instance ID (the connection registry ID: pod name, ECS task ID or
// hostname). Each process upserts its own row every ping cycle and deletes
// it on shutdown. Readers aggregate the rows that are fresh: a row older than
// OCPP_HEALTH_STALE_MS belongs to a process that died without its shutdown
// delete, and OCPP processes prune those rows (OCPP_HEALTH_PRUNE_MS).
//
// Rolling upgrade from v0.1.42: processes of that release write one shared
// row with the id 'singleton' (last writer wins). New processes never write
// it, so readers count it as one more process while it is fresh: it never
// overlaps a new process's row. Once the last v0.1.42 process stops, the row
// goes stale and the prune deletes it.

/** How often each OCPP process writes its row (the ping cycle). */
export const OCPP_HEALTH_SNAPSHOT_INTERVAL_MS = 30_000;
/** Readers ignore rows older than three snapshot intervals. */
export const OCPP_HEALTH_STALE_MS = 3 * OCPP_HEALTH_SNAPSHOT_INTERVAL_MS;
/** OCPP processes delete rows older than this. */
export const OCPP_HEALTH_PRUNE_MS = 10 * 60_000;
/** The shared row of v0.1.42 processes. */
export const LEGACY_OCPP_HEALTH_ID = 'singleton';

export interface OcppInstanceHealthSnapshot {
  connectedStations: number;
  avgPingLatencyMs: number;
  maxPingLatencyMs: number;
  pingSuccessRate: number;
  totalPingsSent: number;
  totalPongsReceived: number;
  serverStartedAt: Date;
}

export interface OcppInstanceHealth extends OcppInstanceHealthSnapshot {
  instanceId: string;
  updatedAt: Date;
}

export interface OcppFleetHealth {
  /** Fresh OCPP process rows. */
  instanceCount: number;
  connectedStations: number;
  /** Average of the per-process averages, weighted by connected stations. */
  avgPingLatencyMs: number;
  maxPingLatencyMs: number;
  /** Pongs received over pings sent across all processes, in percent. */
  pingSuccessRate: number;
  totalPingsSent: number;
  totalPongsReceived: number;
  /** The oldest start among fresh processes. */
  serverStartedAt: Date | null;
  /** The newest row update. */
  updatedAt: Date | null;
  instances: OcppInstanceHealth[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Aggregates the fresh rows (updated within `staleMs` of `now`). */
export function aggregateOcppHealth(
  rows: readonly OcppInstanceHealth[],
  now: Date,
  staleMs = OCPP_HEALTH_STALE_MS,
): OcppFleetHealth {
  const cutoff = now.getTime() - staleMs;
  const fresh = rows
    .filter((r) => r.updatedAt.getTime() >= cutoff)
    .sort((a, b) => a.instanceId.localeCompare(b.instanceId));

  let connectedStations = 0;
  let latencyWeighted = 0;
  let maxPingLatencyMs = 0;
  let totalPingsSent = 0;
  let totalPongsReceived = 0;
  let serverStartedAt: Date | null = null;
  let updatedAt: Date | null = null;

  for (const r of fresh) {
    connectedStations += r.connectedStations;
    latencyWeighted += r.avgPingLatencyMs * r.connectedStations;
    maxPingLatencyMs = Math.max(maxPingLatencyMs, r.maxPingLatencyMs);
    totalPingsSent += r.totalPingsSent;
    totalPongsReceived += r.totalPongsReceived;
    if (serverStartedAt == null || r.serverStartedAt < serverStartedAt) {
      serverStartedAt = r.serverStartedAt;
    }
    if (updatedAt == null || r.updatedAt > updatedAt) updatedAt = r.updatedAt;
  }

  return {
    instanceCount: fresh.length,
    connectedStations,
    avgPingLatencyMs: connectedStations > 0 ? round2(latencyWeighted / connectedStations) : 0,
    maxPingLatencyMs,
    pingSuccessRate:
      totalPingsSent > 0 ? round2(Math.min(100, (totalPongsReceived / totalPingsSent) * 100)) : 100,
    totalPingsSent,
    totalPongsReceived,
    serverStartedAt,
    updatedAt,
    instances: fresh,
  };
}

interface HealthRow {
  id: string;
  connected_stations: number;
  avg_ping_latency_ms: number;
  max_ping_latency_ms: number;
  ping_success_rate: number;
  total_pings_sent: number;
  total_pongs_received: number;
  server_started_at: Date;
  updated_at: Date;
  now: Date;
}

/**
 * Reads every row and aggregates the fresh ones. Freshness is judged against
 * database time, so the reader's clock does not matter.
 */
export async function getOcppFleetHealth(
  sql: postgres.Sql,
  staleMs = OCPP_HEALTH_STALE_MS,
): Promise<OcppFleetHealth> {
  const rows = await sql<HealthRow[]>`
    SELECT id, connected_stations, avg_ping_latency_ms, max_ping_latency_ms,
           ping_success_rate, total_pings_sent, total_pongs_received,
           server_started_at, updated_at, now() AS now
    FROM ocpp_server_health
  `;
  // postgres.js returns int4 and float8 as numbers, timestamptz as Date.
  const now = rows[0]?.now ?? new Date();
  return aggregateOcppHealth(
    rows.map((r) => ({
      instanceId: r.id,
      connectedStations: r.connected_stations,
      avgPingLatencyMs: r.avg_ping_latency_ms,
      maxPingLatencyMs: r.max_ping_latency_ms,
      pingSuccessRate: r.ping_success_rate,
      totalPingsSent: r.total_pings_sent,
      totalPongsReceived: r.total_pongs_received,
      serverStartedAt: new Date(r.server_started_at),
      updatedAt: new Date(r.updated_at),
    })),
    new Date(now),
    staleMs,
  );
}

/** Upserts the row of one OCPP process. */
export async function writeOcppInstanceHealth(
  sql: postgres.Sql,
  instanceId: string,
  snapshot: OcppInstanceHealthSnapshot,
): Promise<void> {
  await sql`
    INSERT INTO ocpp_server_health (
      id, connected_stations, avg_ping_latency_ms, max_ping_latency_ms,
      ping_success_rate, total_pings_sent, total_pongs_received,
      server_started_at, updated_at
    )
    VALUES (
      ${instanceId},
      ${snapshot.connectedStations},
      ${snapshot.avgPingLatencyMs},
      ${snapshot.maxPingLatencyMs},
      ${snapshot.pingSuccessRate},
      ${snapshot.totalPingsSent},
      ${snapshot.totalPongsReceived},
      ${snapshot.serverStartedAt.toISOString()},
      now()
    )
    ON CONFLICT (id) DO UPDATE SET
      connected_stations = EXCLUDED.connected_stations,
      avg_ping_latency_ms = EXCLUDED.avg_ping_latency_ms,
      max_ping_latency_ms = EXCLUDED.max_ping_latency_ms,
      ping_success_rate = EXCLUDED.ping_success_rate,
      total_pings_sent = EXCLUDED.total_pings_sent,
      total_pongs_received = EXCLUDED.total_pongs_received,
      server_started_at = EXCLUDED.server_started_at,
      updated_at = now()
  `;
}

/** Deletes the row of one OCPP process (on shutdown). */
export async function deleteOcppInstanceHealth(
  sql: postgres.Sql,
  instanceId: string,
): Promise<void> {
  await sql`DELETE FROM ocpp_server_health WHERE id = ${instanceId}`;
}

/** Deletes rows of processes that stopped without deleting their own. */
export async function pruneStaleOcppHealth(
  sql: postgres.Sql,
  olderThanMs = OCPP_HEALTH_PRUNE_MS,
): Promise<number> {
  const result = await sql`
    DELETE FROM ocpp_server_health
    WHERE updated_at < now() - make_interval(secs => ${olderThanMs / 1000})
  `;
  return result.count;
}
