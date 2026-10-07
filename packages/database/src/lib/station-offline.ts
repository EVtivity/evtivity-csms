// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';

// The offline sweep (worker cron `station-offline-sweep`) marks offline a
// station left online by an OCPP process that died without publishing
// station.Disconnected. The caller checks the connection registry first;
// these functions own the database side. Times are database time, so the
// worker clock does not matter.

/** connection_logs metadata reason of a disconnect recorded by the sweep. */
export const OFFLINE_SWEEP_REASON = 'offline_sweep';

export interface StaleOnlineStation {
  id: string;
  stationId: string;
  lastActivityAt: Date | null;
  staleBefore: Date;
}

/**
 * Online stations whose last activity (`last_heartbeat`, bumped by every
 * inbound message) is older than `thresholdMs`, oldest first.
 */
export async function findStaleOnlineStations(
  sql: postgres.Sql,
  thresholdMs: number,
  limit = 500,
): Promise<StaleOnlineStation[]> {
  const rows = await sql<
    { id: string; station_id: string; last_heartbeat: Date | null; stale_before: Date }[]
  >`
    SELECT id, station_id, last_heartbeat,
           now() - make_interval(secs => ${thresholdMs / 1000}) AS stale_before
    FROM charging_stations
    WHERE is_online = true
      AND (last_heartbeat IS NULL
        OR last_heartbeat < now() - make_interval(secs => ${thresholdMs / 1000}))
    ORDER BY last_heartbeat ASC NULLS FIRST
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    stationId: r.station_id,
    lastActivityAt: r.last_heartbeat,
    staleBefore: r.stale_before,
  }));
}

export interface StationMarkedOffline {
  siteId: string | null;
}

/**
 * Marks a station offline with the effects of a disconnect: a `disconnected`
 * connection log row (metadata reason `offline_sweep`, so disconnect counts
 * and downtime include it) and a port status row per connector going
 * unavailable. The update is conditional (still online, still stale), so a
 * station that sent a message or reconnected meanwhile is left alone, and a
 * second run or replica changes nothing and logs nothing. Returns null when
 * nothing changed.
 */
export async function markStationOfflineIfStale(
  sql: postgres.Sql,
  stationUuid: string,
  thresholdMs: number,
): Promise<StationMarkedOffline | null> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ site_id: string | null }[]>`
      UPDATE charging_stations
      SET is_online = false, updated_at = now()
      WHERE id = ${stationUuid}
        AND is_online = true
        AND (last_heartbeat IS NULL
          OR last_heartbeat < now() - make_interval(secs => ${thresholdMs / 1000}))
      RETURNING site_id
    `;
    if (row == null) return null;

    await tx`
      INSERT INTO connection_logs (station_id, event, metadata)
      VALUES (${stationUuid}, 'disconnected', ${tx.json({ reason: OFFLINE_SWEEP_REASON })})
    `;
    await tx`
      INSERT INTO port_status_log (station_id, evse_id, connector_id, previous_status, new_status, timestamp)
      SELECT ${stationUuid}, e.evse_id, c.connector_id, c.status, 'unavailable', now()
      FROM connectors c
      INNER JOIN evses e ON c.evse_id = e.id
      WHERE e.station_id = ${stationUuid}
        AND c.status != 'unavailable'
    `;
    return { siteId: row.site_id };
  });
}
