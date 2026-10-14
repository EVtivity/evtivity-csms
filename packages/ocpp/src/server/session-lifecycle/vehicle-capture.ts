// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The vehicle id a start carries (Autocharge, charge by plugging in), for the
 * TransactionEvent projection: stored on the session, the Autocharge vehicle
 * that authorized it, and the driver's vehicle the session is linked to. The
 * authorize pipeline (authorization/authorize-token.ts) decides what the
 * station is told; the projection makes the same decision again from the
 * database (defense in depth), so a station that started on a cached or local
 * authorization still gets the right driver, or none.
 */

import type postgres from 'postgres';
import {
  findAutochargeVehicle,
  getCompanyPortalUrl,
  isAutochargeEnabledForStation,
} from '@evtivity/database';
import {
  VEHICLE_ID_SOURCES,
  isVehicleIdType,
  vehicleIdColumn,
  type VehicleIdCapture,
  type VehicleIdSource,
} from '@evtivity/lib/vehicle-id';

/** The capture the OCPP handlers put on the TransactionEvent payload (`vehicleId`). */
export function readVehicleCapture(payload: Record<string, unknown>): VehicleIdCapture | null {
  const raw = payload['vehicleId'];
  if (raw == null || typeof raw !== 'object') return null;
  const { value, type, source } = raw as Record<string, unknown>;
  if (typeof value !== 'string' || value === '' || typeof type !== 'string') return null;
  if (!isVehicleIdType(type)) return null;
  if (typeof source !== 'string' || !(VEHICLE_ID_SOURCES as readonly string[]).includes(source)) {
    return null;
  }
  return { value, type, source: source as VehicleIdSource };
}

/** Stores the captured id on the session, once: the first event that carries one wins. */
export async function recordSessionVehicleCapture(
  sql: postgres.Sql,
  sessionId: string,
  capture: VehicleIdCapture,
): Promise<void> {
  await sql`
    UPDATE charging_sessions
    SET vehicle_id_value = ${capture.value}, vehicle_id_type = ${capture.type},
        vehicle_id_source = ${capture.source}, updated_at = now()
    WHERE id = ${sessionId} AND vehicle_id_value IS NULL
  `;
}

/**
 * The Autocharge vehicle that authorizes a start without a driver token: the
 * token itself is the vehicle id (never an additionalInfo entry), Autocharge
 * is on at the station's site, the vehicle has Autocharge on and is not
 * blocked, and its driver is active. Null otherwise.
 */
export async function resolveAutochargeVehicle(
  stationOcppId: string,
  capture: VehicleIdCapture | null,
): Promise<{ vehicleId: string; driverId: string } | null> {
  if (capture == null || capture.source === 'additional_info') return null;
  const match = await findAutochargeVehicle(capture);
  if (match == null || match.blocked || !match.driverIsActive) return null;
  if (!(await isAutochargeEnabledForStation(stationOcppId))) return null;
  return { vehicleId: match.vehicleId, driverId: match.driverId };
}

/**
 * Links a session the Autocharge vehicle authorized: its driver (only while
 * the session has none), the vehicle, and the autocharge flag. Repeats safely.
 */
export async function linkAutochargeSession(
  sql: postgres.Sql,
  sessionId: string,
  match: { vehicleId: string; driverId: string },
): Promise<void> {
  await sql`
    UPDATE charging_sessions
    SET driver_id = ${match.driverId}, vehicle_id = ${match.vehicleId}, autocharge = true,
        updated_at = now()
    WHERE id = ${sessionId} AND (driver_id IS NULL OR driver_id = ${match.driverId})
  `;
}

/**
 * Links the session to the driver's vehicle whose VIN or EVCCID is the
 * captured id, over the driver's last vehicle the projection linked first. A
 * vehicle of another driver is never linked. Repeats safely.
 */
export async function linkCapturedVehicle(
  sql: postgres.Sql,
  sessionId: string,
  driverId: string,
  capture: VehicleIdCapture,
): Promise<void> {
  const matches =
    vehicleIdColumn(capture.type) === 'vin'
      ? sql`v.vin = ${capture.value}`
      : sql`v.evccid = ${capture.value}`;
  await sql`
    UPDATE charging_sessions cs
    SET vehicle_id = v.id, updated_at = now()
    FROM (
      SELECT v.id FROM vehicles v
      WHERE v.driver_id = ${driverId} AND ${matches}
      ORDER BY v.autocharge_enabled DESC, v.created_at DESC
      LIMIT 1
    ) v
    WHERE cs.id = ${sessionId} AND cs.vehicle_id IS DISTINCT FROM v.id
  `;
}

/**
 * The variables of `session.AutochargeStarted` beyond the session.Started
 * ones: the vehicle's name and the portal page where the driver turns
 * Autocharge off (empty when the portal URL setting is not set).
 */
export async function autochargeNoticeVariables(
  sql: postgres.Sql,
  vehicleId: string,
): Promise<{ vehicleName: string; vehiclesUrl: string }> {
  const [row] = await sql`
    SELECT make, model, year, license_plate FROM vehicles WHERE id = ${vehicleId}
  `;
  const name = [row?.year, row?.make, row?.model]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' ');
  const plate = typeof row?.license_plate === 'string' ? row.license_plate : '';
  const portalUrl = await getCompanyPortalUrl();
  return {
    vehicleName: name !== '' ? name : plate,
    vehiclesUrl: portalUrl != null ? `${portalUrl}/vehicles` : '',
  };
}
