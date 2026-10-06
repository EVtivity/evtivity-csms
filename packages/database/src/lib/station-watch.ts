// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { availableEvseCountSql } from './driver-availability.js';

// Station watch alerts ("notify me when free"). A station becomes free for a
// driver through many inputs (a connector status, an operator enable, a
// reconnect, a finished firmware install, an ended maintenance window or
// reservation), so the alert is level-triggered: every path that can free a
// station calls alertStationWatchersIfAvailable, which checks the shared driver
// availability rule, and the worker claims the watches only while the rule still
// holds. Claiming deletes the watches, so any number of signals sends one alert.

export const STATION_WATCH_CHANNEL = 'station_watch_available';

export interface StationWatchPublisher {
  publish(channel: string, payload: string): Promise<void>;
}

// The OCPP station id when the station has an active watch and a free EVSE by
// the shared driver availability rule, otherwise null. The watch EXISTS comes
// first, so a station nobody watches costs one index lookup.
export async function findDueStationWatch(
  sql: postgres.Sql,
  stationUuid: string,
): Promise<string | null> {
  const rows = await sql`
    SELECT cs.station_id FROM charging_stations cs
    WHERE cs.id = ${stationUuid}
      AND EXISTS (
        SELECT 1 FROM station_watches w WHERE w.station_id = cs.id AND w.expires_at > now()
      )
      AND ${sql.unsafe(availableEvseCountSql('cs'))} > 0
  `;
  const row = rows[0] as { station_id: string } | undefined;
  return row?.station_id ?? null;
}

// Publishes the station-watch signal when an alert is due. Returns whether it
// published. Throws on a database or publish error; callers are fail-open.
export async function alertStationWatchersIfAvailable(
  sql: postgres.Sql,
  pubsub: StationWatchPublisher,
  stationUuid: string,
): Promise<boolean> {
  const stationId = await findDueStationWatch(sql, stationUuid);
  if (stationId == null) return false;
  await pubsub.publish(STATION_WATCH_CHANNEL, JSON.stringify({ stationId }));
  return true;
}

// Claims (deletes and returns) the station's active watches, only while the
// station still has a free EVSE by the shared rule. One statement, so two
// workers or two signals never alert a driver twice, and a stale signal for a
// station that is no longer free alerts nobody and keeps the watches.
export async function claimStationWatches(
  sql: postgres.Sql,
  stationOcppId: string,
): Promise<string[]> {
  const rows = await sql`
    DELETE FROM station_watches w
    USING charging_stations cs
    WHERE w.station_id = cs.id
      AND cs.station_id = ${stationOcppId}
      AND w.expires_at > now()
      AND ${sql.unsafe(availableEvseCountSql('cs'))} > 0
    RETURNING w.driver_id
  `;
  return (rows as unknown as Array<{ driver_id: string }>).map((r) => r.driver_id);
}
