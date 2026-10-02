// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { createId } from './id.js';

// The only writer of connector status and station availability. Availability
// is computed from separately stored inputs: an operator or security disable,
// the firmware install state, the status the station reports for itself, and
// the connector statuses. Callers publish SSE/OCPI updates themselves when a
// function reports a change.

export type StationAvailability = 'available' | 'unavailable' | 'faulted';
export type StationDisabledReason = 'operator' | 'security';
export type StationFirmwareState = 'installing' | 'failed';
export type StationStatusReason =
  | 'operator_disabled'
  | 'security_disabled'
  | 'firmware_failed'
  | 'station_faulted'
  | 'connector_faulted'
  | 'firmware_installing'
  | 'station_unavailable';

function connectorFaultedSql(stationAlias: string): string {
  return `EXISTS (
    SELECT 1 FROM connectors sc JOIN evses se ON se.id = sc.evse_id
    WHERE se.station_id = ${stationAlias}.id AND sc.status = 'faulted'
  )`;
}

// SQL CASE that computes availability for the charging_stations row aliased
// `stationAlias`. Shared by this module and the API display status so the rule
// exists once. The alias is a code constant, never user input.
export function stationAvailabilitySql(stationAlias: string): string {
  const s = stationAlias;
  return `(CASE
    WHEN ${s}.disabled_reason IS NOT NULL THEN 'unavailable'
    WHEN ${s}.firmware_state = 'failed' OR ${s}.reported_status = 'faulted' OR ${connectorFaultedSql(s)} THEN 'faulted'
    WHEN ${s}.firmware_state = 'installing' OR ${s}.reported_status = 'unavailable' THEN 'unavailable'
    ELSE 'available'
  END)`;
}

// SQL CASE for why the station is not available, null when it is.
export function stationStatusReasonSql(stationAlias: string): string {
  const s = stationAlias;
  return `(CASE
    WHEN ${s}.disabled_reason = 'operator' THEN 'operator_disabled'
    WHEN ${s}.disabled_reason = 'security' THEN 'security_disabled'
    WHEN ${s}.firmware_state = 'failed' THEN 'firmware_failed'
    WHEN ${s}.reported_status = 'faulted' THEN 'station_faulted'
    WHEN ${connectorFaultedSql(s)} THEN 'connector_faulted'
    WHEN ${s}.firmware_state = 'installing' THEN 'firmware_installing'
    WHEN ${s}.reported_status = 'unavailable' THEN 'station_unavailable'
    ELSE NULL
  END)`;
}

export interface AvailabilityChange {
  availabilityChanged: boolean;
}

// Recompute availability from the inputs. Writes only when the value changes.
// The API and OCPP processes both write the inputs, so the station row is
// locked first: the computing statement then starts after the lock and sees
// every input committed before it, and a stale result can never land last.
export async function recomputeStationAvailability(
  sql: postgres.Sql,
  stationUuid: string,
): Promise<AvailabilityChange> {
  const availability = `${stationAvailabilitySql('cs')}::charging_station_status`;
  const rows = await sql.begin(async (tx) => {
    await tx`SELECT 1 FROM charging_stations WHERE id = ${stationUuid} FOR UPDATE`;
    return tx`
      UPDATE charging_stations cs
      SET availability = ${tx.unsafe(availability)}, updated_at = now()
      WHERE cs.id = ${stationUuid} AND cs.availability IS DISTINCT FROM ${tx.unsafe(availability)}
      RETURNING cs.id
    `;
  });
  return { availabilityChanged: rows.length > 0 };
}

// Switch a station off (operator or security) or back on (null). A security
// disable never replaces an existing disable. Enabling also clears any
// firmware state: the operator acknowledges a failed install, or ends an
// install the station never reported as finished.
export async function setStationDisabled(
  sql: postgres.Sql,
  stationUuid: string,
  reason: StationDisabledReason | null,
): Promise<AvailabilityChange> {
  if (reason == null) {
    await sql`
      UPDATE charging_stations
      SET disabled_reason = NULL, firmware_state = NULL, updated_at = now()
      WHERE id = ${stationUuid}
        AND (disabled_reason IS NOT NULL OR firmware_state IS NOT NULL)
    `;
  } else if (reason === 'security') {
    await sql`
      UPDATE charging_stations
      SET disabled_reason = 'security', updated_at = now()
      WHERE id = ${stationUuid} AND disabled_reason IS NULL
    `;
  } else {
    await sql`
      UPDATE charging_stations
      SET disabled_reason = 'operator', updated_at = now()
      WHERE id = ${stationUuid} AND disabled_reason IS DISTINCT FROM 'operator'
    `;
  }
  return recomputeStationAvailability(sql, stationUuid);
}

export async function setStationFirmwareState(
  sql: postgres.Sql,
  stationUuid: string,
  state: StationFirmwareState | null,
): Promise<AvailabilityChange> {
  await sql`
    UPDATE charging_stations
    SET firmware_state = ${state}::station_firmware_state, updated_at = now()
    WHERE id = ${stationUuid} AND firmware_state IS DISTINCT FROM ${state}::station_firmware_state
  `;
  return recomputeStationAvailability(sql, stationUuid);
}

// Ends an install in progress without touching a failed one: the station
// reported Idle or DownloadFailed, or rebooted, which an install ends with.
export async function clearStationFirmwareInstalling(
  sql: postgres.Sql,
  stationUuid: string,
): Promise<AvailabilityChange> {
  await sql`
    UPDATE charging_stations
    SET firmware_state = NULL, updated_at = now()
    WHERE id = ${stationUuid} AND firmware_state = 'installing'
  `;
  return recomputeStationAvailability(sql, stationUuid);
}

// The status a station reports for itself (OCPP 1.6 connector 0, 2.x evseId 0
// or ChargingStation AvailabilityState). Changes are logged as EVSE 0 /
// connector 0 so reports keep station-level history.
export async function setStationReportedStatus(
  sql: postgres.Sql,
  stationUuid: string,
  status: StationAvailability,
): Promise<AvailabilityChange> {
  const [current] = await sql`
    SELECT reported_status FROM charging_stations WHERE id = ${stationUuid}
  `;
  const previous = (current?.reported_status as string | null | undefined) ?? null;
  if (previous !== status) {
    await sql`
      UPDATE charging_stations
      SET reported_status = ${status}::charging_station_status, updated_at = now()
      WHERE id = ${stationUuid}
    `;
    await sql`
      INSERT INTO port_status_log (station_id, evse_id, connector_id, previous_status, new_status, timestamp)
      VALUES (${stationUuid}, 0, 0, ${previous}, ${status}, now())
    `;
  }
  return recomputeStationAvailability(sql, stationUuid);
}

export interface ConnectorStatusInput {
  stationUuid: string;
  evseId: number;
  connectorId: number;
  status: string;
}

// stationExists is false when the station row no longer exists, so nothing
// was written.
export type ConnectorStatusResult =
  | { stationExists: false; availabilityChanged: false }
  | (AvailabilityChange & {
      stationExists: true;
      evseUuid: string;
      previousStatus: string | undefined;
      autoCreated: boolean;
    });

// A plug's status from StatusNotification or NotifyEvent AvailabilityState.
// Creates the EVSE and connector the first time they are reported.
export async function applyConnectorStatus(
  sql: postgres.Sql,
  input: ConnectorStatusInput,
): Promise<ConnectorStatusResult> {
  const { stationUuid, evseId, connectorId, status } = input;
  const evseRows = await sql`
    SELECT id FROM evses WHERE station_id = ${stationUuid} AND evse_id = ${evseId}
  `;
  const evseRow = evseRows[0];

  if (evseRow == null) {
    // Two status reports for a new EVSE can arrive together; the unique
    // indexes on (station, EVSE number) and (EVSE, connector number) make the
    // second one reuse the row instead of creating a duplicate.
    const insertedEvse = await sql`
      INSERT INTO evses (id, station_id, evse_id, auto_created)
      SELECT ${createId('evse')}, ${stationUuid}, ${evseId}, true
      WHERE EXISTS (SELECT 1 FROM charging_stations WHERE id = ${stationUuid})
      ON CONFLICT (station_id, evse_id) DO UPDATE SET updated_at = evses.updated_at
      RETURNING id
    `;
    if (insertedEvse.length === 0) {
      return { stationExists: false, availabilityChanged: false };
    }
    const evseUuid = insertedEvse[0]?.id as string;
    // StatusNotification has no connector type. 'Unknown' keeps the connector
    // visible in station lists, which skip NULL types; operators can edit it.
    await sql`
      INSERT INTO connectors (id, evse_id, connector_id, status, auto_created, connector_type)
      VALUES (${createId('connector')}, ${evseUuid}, ${connectorId}, ${status}, true, 'Unknown')
      ON CONFLICT (evse_id, connector_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()
    `;
    await sql`
      INSERT INTO port_status_log (station_id, evse_id, connector_id, previous_status, new_status, timestamp)
      VALUES (${stationUuid}, ${evseId}, ${connectorId}, ${null}, ${status}, now())
    `;
    const change = await recomputeStationAvailability(sql, stationUuid);
    return {
      stationExists: true,
      evseUuid,
      previousStatus: undefined,
      autoCreated: true,
      ...change,
    };
  }

  const evseUuid = evseRow.id as string;
  const prevRows = await sql`
    SELECT status FROM connectors WHERE evse_id = ${evseUuid} AND connector_id = ${connectorId}
  `;
  const previousStatus = prevRows[0]?.status as string | undefined;

  // Stations resend unchanged statuses; logging those would clutter the
  // timeline and inflate transition counts.
  if (previousStatus !== status) {
    await sql`
      INSERT INTO port_status_log (station_id, evse_id, connector_id, previous_status, new_status, timestamp)
      VALUES (${stationUuid}, ${evseId}, ${connectorId}, ${previousStatus ?? null}, ${status}, now())
    `;
  }

  let autoCreated = false;
  if (prevRows.length === 0) {
    await sql`
      INSERT INTO connectors (id, evse_id, connector_id, status, auto_created, connector_type)
      VALUES (${createId('connector')}, ${evseUuid}, ${connectorId}, ${status}, true, 'Unknown')
      ON CONFLICT (evse_id, connector_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()
    `;
    autoCreated = true;
  } else {
    await sql`
      UPDATE connectors SET status = ${status}, updated_at = now()
      WHERE evse_id = ${evseUuid} AND connector_id = ${connectorId}
    `;
  }

  const change = await recomputeStationAvailability(sql, stationUuid);
  return { stationExists: true, evseUuid, previousStatus, autoCreated, ...change };
}

// Fine-grained connector status from a TransactionEvent chargingState. A
// faulted or unavailable connector keeps its status until the station reports
// a new one.
export async function applyEvseChargingState(
  sql: postgres.Sql,
  evseUuid: string,
  status: string,
): Promise<void> {
  await sql`
    UPDATE connectors
    SET status = CASE
          WHEN status IN ('faulted', 'unavailable') THEN status
          ELSE ${status}
        END,
        updated_at = now()
    WHERE evse_id = ${evseUuid}
  `;
}

export interface StationLevelState {
  disabledReason: string | null;
  firmwareState: string | null;
  reportedStatus: string | null;
}

// True when the whole station cannot charge: disabled, installing or failed
// firmware, or the station reports itself unavailable or faulted. A faulted
// connector is not included; it only blocks that connector.
export function isStationLevelUnavailable(state: StationLevelState): boolean {
  return (
    state.disabledReason != null ||
    state.firmwareState != null ||
    state.reportedStatus === 'unavailable' ||
    state.reportedStatus === 'faulted'
  );
}
