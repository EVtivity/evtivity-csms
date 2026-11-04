// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The vehicle a driver session is linked to when no vehicle id was captured
 * (the captured one is linked after this and wins). In order: the vehicle the
 * session's card belongs to (`driver_tokens.vehicle_id`, only a vehicle of the
 * same driver); at a session whose station is a station of one of the
 * driver's fleets at a Depot site, the driver's only vehicle, or none when the
 * driver has several (a depot cannot guess which bus plugged in); elsewhere
 * the vehicle of the driver's most recent session that carries one of the
 * driver's own vehicles (never a fleet-mate's an operator assigned), so the
 * portal shows estimated miles without asking. A link is written only while the session has
 * no vehicle, so a vehicle an operator assigned by hand stays. Repeats safely.
 */

import type postgres from 'postgres';

export type SessionVehicleLinkRule = 'token' | 'depot_only_vehicle' | 'last_vehicle' | null;

export async function linkSessionVehicle(
  sql: postgres.Sql,
  sessionId: string,
  driverId: string,
): Promise<{ vehicleId: string | null; rule: SessionVehicleLinkRule }> {
  const [byToken] = await sql`
    SELECT t.vehicle_id
    FROM charging_sessions s
    JOIN driver_tokens t ON t.id = s.token_id
    JOIN vehicles v ON v.id = t.vehicle_id AND v.driver_id = ${driverId}
    WHERE s.id = ${sessionId}
  `;
  if (typeof byToken?.vehicle_id === 'string') {
    return linked(await setSessionVehicle(sql, sessionId, byToken.vehicle_id), 'token');
  }

  // Depot by the session's own station: a station of one of the driver's
  // fleets, at a Depot site.
  const [depot] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM charging_sessions s
      JOIN charging_stations cs ON cs.id = s.station_id
      JOIN sites st ON st.id = cs.site_id
      JOIN fleet_stations fs ON fs.station_id = cs.id
      JOIN fleet_drivers fd ON fd.fleet_id = fs.fleet_id AND fd.driver_id = ${driverId}
      WHERE s.id = ${sessionId} AND st.layout_settings->>'siteType' = 'depot'
    ) AS depot_driver,
    ARRAY(SELECT id FROM vehicles WHERE driver_id = ${driverId} ORDER BY id LIMIT 2) AS vehicle_ids
  `;
  if (depot?.depot_driver === true) {
    const ids = (depot.vehicle_ids ?? []) as string[];
    const only = ids.length === 1 ? (ids[0] ?? null) : null;
    if (only == null) return { vehicleId: null, rule: null };
    return linked(await setSessionVehicle(sql, sessionId, only), 'depot_only_vehicle');
  }

  // Only the driver's own vehicle carries over: an operator may have assigned
  // a fleet-mate's vehicle to an earlier session of this driver.
  const [last] = await sql`
    SELECT s.vehicle_id FROM charging_sessions s
    JOIN vehicles v ON v.id = s.vehicle_id AND v.driver_id = ${driverId}
    WHERE s.driver_id = ${driverId}
      AND s.id != ${sessionId}
    ORDER BY s.started_at DESC NULLS LAST, s.created_at DESC
    LIMIT 1
  `;
  if (typeof last?.vehicle_id !== 'string') return { vehicleId: null, rule: null };
  return linked(await setSessionVehicle(sql, sessionId, last.vehicle_id), 'last_vehicle');
}

function linked(
  vehicleId: string | null,
  rule: Exclude<SessionVehicleLinkRule, null>,
): { vehicleId: string | null; rule: SessionVehicleLinkRule } {
  return vehicleId != null ? { vehicleId, rule } : { vehicleId: null, rule: null };
}

/** Sets the vehicle while the session has none; returns it, or null when one was already set. */
async function setSessionVehicle(
  sql: postgres.Sql,
  sessionId: string,
  vehicleId: string,
): Promise<string | null> {
  const rows = await sql`
    UPDATE charging_sessions SET vehicle_id = ${vehicleId}, updated_at = now()
    WHERE id = ${sessionId} AND vehicle_id IS NULL
    RETURNING id
  `;
  return rows.length > 0 ? vehicleId : null;
}
