// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { stationLevelUnavailableSql } from './station-status.js';

// The one rule for what a driver sees as available, shared by every portal and
// mobile count (search, nearby, location, favorites, watches) and the
// station-watch alert. It matches the charger pages (ChargerLanding,
// ChargerStationLanding, ChargerDetail), which refuse a start on the same
// grounds. Every function returns SQL text for the rows aliased by its
// arguments; aliases are code constants, never user input.

// Connector statuses a driver can start a session on. Mirrored by the portal
// STARTABLE_STATUSES (packages/portal/src/lib/connector-status.ts).
export const STARTABLE_CONNECTOR_STATUSES = [
  'available',
  'occupied',
  'preparing',
  'ev_connected',
  'finishing',
] as const;

// The station accepts drivers: online, no disable, firmware install or
// station-level fault (isStationLevelUnavailable), and no active maintenance
// window covering it (the same window as getActiveMaintenanceForStation).
export function stationOpenToDriversSql(stationAlias: string): string {
  const s = stationAlias;
  return `(${s}.is_online AND NOT ${stationLevelUnavailableSql(s)} AND NOT EXISTS (
    SELECT 1 FROM maintenance_events dav_m
    WHERE dav_m.site_id = ${s}.site_id
      AND dav_m.status = 'active'
      AND dav_m.planned_start_at <= now()
      AND dav_m.planned_end_at > now()
      AND (dav_m.affected_station_ids IS NULL
        OR dav_m.affected_station_ids = '{}'::text[]
        OR ${s}.id = ANY (dav_m.affected_station_ids))
  ))`;
}

// The EVSE holds a reservation in its current window, for the EVSE or for the
// whole station (evse_id NULL). The connector status flips from reserved once
// the holder plugs in, so the reservation row decides, not the status.
export function evseReservedSql(evseAlias: string): string {
  const e = evseAlias;
  return `EXISTS (
    SELECT 1 FROM reservations dav_r
    WHERE dav_r.station_id = ${e}.station_id
      AND (dav_r.evse_id = ${e}.id OR dav_r.evse_id IS NULL)
      AND dav_r.status IN ('active', 'scheduled')
      AND COALESCE(dav_r.starts_at, dav_r.created_at) <= now()
      AND dav_r.expires_at > now()
  )`;
}

// A driver can act on this EVSE: its station is open and it is not reserved.
export function evseOpenToDriversSql(evseAlias: string, stationAlias: string): string {
  return `(${stationOpenToDriversSql(stationAlias)} AND NOT ${evseReservedSql(evseAlias)})`;
}

// The EVSE is free for a driver: open, with a connector that reports Available.
export function evseAvailableSql(evseAlias: string, stationAlias: string): string {
  const e = evseAlias;
  return `(${evseOpenToDriversSql(e, stationAlias)} AND EXISTS (
    SELECT 1 FROM connectors dav_c WHERE dav_c.evse_id = ${e}.id AND dav_c.status = 'available'
  ))`;
}

// Number of free EVSEs at the station aliased `stationAlias`, as an int.
export function availableEvseCountSql(stationAlias: string): string {
  const s = stationAlias;
  return `(SELECT count(*)::int FROM evses dav_e
    WHERE dav_e.station_id = ${s}.id AND ${evseAvailableSql('dav_e', s)})`;
}
