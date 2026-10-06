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

// Status reports are ordered by the station's own timestamp: a report applies
// only when its timestamp is not older than the stored one, so an
// offline-queued report replayed after reconnect, a TransactionEvent projected
// on its own lane, or a report a second OCPP pod projects late cannot
// overwrite a newer status.
// - Equal timestamps apply: OCPP-J allows one outstanding CALL per station, so
//   arrival order is send order, and two changes can share a second.
// - No timestamp (a 1.6 StatusNotification may omit it): applies and stores
//   NULL. Receipt time is not comparable with the station clock, so the report
//   falls back to arrival order and the next timestamped report applies.
// - A timestamp in the future is clamped to the receipt time, so a station
//   clock that ran ahead and was corrected does not freeze the status.
export function statusReportedAt(raw: unknown, receivedAt: Date = new Date()): Date | null {
  if (typeof raw !== 'string' && !(raw instanceof Date)) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.getTime() > receivedAt.getTime() ? receivedAt : parsed;
}

// Starts a new ordering epoch on an accepted BootNotification: forgets the
// stored report timestamps of the station and its connectors, so the
// current-state reports the station sends after boot (B01.FR.05) apply even
// when its clock moved back across the reboot (RTC reset, manual change).
// The statuses themselves are kept. A report cached from before the reboot
// that arrives after boot (B01.FR.08) is still ordered against the post-boot
// report of the same connector once that is stored.
export async function startStatusOrderingEpoch(
  sql: postgres.Sql,
  stationUuid: string,
): Promise<void> {
  await sql`
    WITH reset_connectors AS (
      UPDATE connectors c SET status_reported_at = NULL
      FROM evses e
      WHERE c.evse_id = e.id AND e.station_id = ${stationUuid}
        AND c.status_reported_at IS NOT NULL
      RETURNING c.id
    )
    UPDATE charging_stations SET reported_status_at = NULL
    WHERE id = ${stationUuid} AND reported_status_at IS NOT NULL
  `;
}

export interface StationReportedStatusChange extends AvailabilityChange {
  // False when the station row is gone or a newer report is already stored.
  applied: boolean;
}

// The status a station reports for itself (OCPP 1.6 connector 0, 2.x evseId 0
// or ChargingStation AvailabilityState). Changes are logged as EVSE 0 /
// connector 0 so reports keep station-level history.
export async function setStationReportedStatus(
  sql: postgres.Sql,
  stationUuid: string,
  status: StationAvailability,
  timestamp: string | null,
): Promise<StationReportedStatusChange> {
  const reportedAt = statusReportedAt(timestamp);
  // Read the previous status and write the new one in one statement under the
  // row lock, so a concurrent report cannot slip between the guard and the write.
  const rows = await sql`
    WITH prev AS (
      SELECT id, reported_status FROM charging_stations WHERE id = ${stationUuid} FOR UPDATE
    ),
    upd AS (
      UPDATE charging_stations cs
      SET reported_status = ${status}::charging_station_status,
          reported_status_at = ${reportedAt}::timestamptz,
          updated_at = CASE
            WHEN cs.reported_status IS DISTINCT FROM ${status}::charging_station_status THEN now()
            ELSE cs.updated_at
          END
      FROM prev
      WHERE cs.id = prev.id
        AND (cs.reported_status_at IS NULL OR ${reportedAt}::timestamptz IS NULL
          OR ${reportedAt}::timestamptz >= cs.reported_status_at)
      RETURNING cs.id
    )
    SELECT prev.reported_status AS previous_status, EXISTS (SELECT 1 FROM upd) AS applied
    FROM prev
  `;
  const row = rows[0];
  if (row?.applied !== true) {
    return { applied: false, availabilityChanged: false };
  }
  const previous = (row.previous_status as string | null | undefined) ?? null;
  if (previous !== status) {
    await sql`
      INSERT INTO port_status_log (station_id, evse_id, connector_id, previous_status, new_status, timestamp)
      VALUES (${stationUuid}, 0, 0, ${previous}, ${status}, now())
    `;
  }
  const change = await recomputeStationAvailability(sql, stationUuid);
  return { applied: true, ...change };
}

export interface ConnectorStatusInput {
  stationUuid: string;
  evseId: number;
  connectorId: number;
  status: string;
  // The station's timestamp of the report, null when it sent none.
  timestamp: string | null;
}

// stationExists is false when the station row no longer exists, so nothing
// was written. applied is false when a newer report is already stored, so
// nothing was written either.
export type ConnectorStatusResult =
  | { stationExists: false; applied: false; availabilityChanged: false }
  | (AvailabilityChange & {
      stationExists: true;
      applied: boolean;
      evseUuid: string;
      previousStatus: string | undefined;
      autoCreated: boolean;
    });

// Creates a connector the station reported for the first time. Two reports
// can create it together; the unique index on (EVSE, connector number) makes
// the later one an update that passes the same timestamp guard. Returns false
// when the row already held a newer report.
async function insertReportedConnector(
  sql: postgres.Sql,
  evseUuid: string,
  connectorId: number,
  status: string,
  reportedAt: Date | null,
): Promise<boolean> {
  // StatusNotification has no connector type. 'Unknown' keeps the connector
  // visible in station lists, which skip NULL types; operators can edit it.
  const rows = await sql`
    INSERT INTO connectors (id, evse_id, connector_id, status, status_reported_at, auto_created, connector_type)
    VALUES (${createId('connector')}, ${evseUuid}, ${connectorId}, ${status}, ${reportedAt}::timestamptz, true, 'Unknown')
    ON CONFLICT (evse_id, connector_id) DO UPDATE
      SET status = EXCLUDED.status, status_reported_at = EXCLUDED.status_reported_at, updated_at = now()
      WHERE connectors.status_reported_at IS NULL OR EXCLUDED.status_reported_at IS NULL
        OR EXCLUDED.status_reported_at >= connectors.status_reported_at
    RETURNING id
  `;
  return rows.length > 0;
}

// A plug's status from StatusNotification or NotifyEvent AvailabilityState.
// Creates the EVSE and connector the first time they are reported.
export async function applyConnectorStatus(
  sql: postgres.Sql,
  input: ConnectorStatusInput,
): Promise<ConnectorStatusResult> {
  const { stationUuid, evseId, connectorId, status } = input;
  const reportedAt = statusReportedAt(input.timestamp);
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
      return { stationExists: false, applied: false, availabilityChanged: false };
    }
    const evseUuid = insertedEvse[0]?.id as string;
    const written = await insertReportedConnector(sql, evseUuid, connectorId, status, reportedAt);
    if (!written) {
      return {
        stationExists: true,
        applied: false,
        evseUuid,
        previousStatus: undefined,
        autoCreated: false,
        availabilityChanged: false,
      };
    }
    await sql`
      INSERT INTO port_status_log (station_id, evse_id, connector_id, previous_status, new_status, timestamp)
      VALUES (${stationUuid}, ${evseId}, ${connectorId}, ${null}, ${status}, now())
    `;
    const change = await recomputeStationAvailability(sql, stationUuid);
    return {
      stationExists: true,
      applied: true,
      evseUuid,
      previousStatus: undefined,
      autoCreated: true,
      ...change,
    };
  }

  const evseUuid = evseRow.id as string;
  // Read the previous status and write the new one in one statement under the
  // row lock, so a concurrent report (another lane or pod) cannot slip between
  // the guard and the write.
  const updated = await sql`
    WITH prev AS (
      SELECT id, status FROM connectors
      WHERE evse_id = ${evseUuid} AND connector_id = ${connectorId}
      FOR UPDATE
    ),
    upd AS (
      UPDATE connectors c
      SET status = ${status}, status_reported_at = ${reportedAt}::timestamptz, updated_at = now()
      FROM prev
      WHERE c.id = prev.id
        AND (c.status_reported_at IS NULL OR ${reportedAt}::timestamptz IS NULL
          OR ${reportedAt}::timestamptz >= c.status_reported_at)
      RETURNING c.id
    )
    SELECT prev.status AS previous_status, EXISTS (SELECT 1 FROM upd) AS applied FROM prev
  `;
  const updatedRow = updated[0];

  let previousStatus: string | undefined;
  let autoCreated = false;
  if (updatedRow == null) {
    const written = await insertReportedConnector(sql, evseUuid, connectorId, status, reportedAt);
    if (!written) {
      return {
        stationExists: true,
        applied: false,
        evseUuid,
        previousStatus: undefined,
        autoCreated: false,
        availabilityChanged: false,
      };
    }
    autoCreated = true;
  } else {
    previousStatus = updatedRow.previous_status as string;
    if (updatedRow.applied !== true) {
      return {
        stationExists: true,
        applied: false,
        evseUuid,
        previousStatus,
        autoCreated: false,
        availabilityChanged: false,
      };
    }
  }

  // Stations resend unchanged statuses; logging those would clutter the
  // timeline and inflate transition counts.
  if (previousStatus !== status) {
    await sql`
      INSERT INTO port_status_log (station_id, evse_id, connector_id, previous_status, new_status, timestamp)
      VALUES (${stationUuid}, ${evseId}, ${connectorId}, ${previousStatus ?? null}, ${status}, now())
    `;
  }

  const change = await recomputeStationAvailability(sql, stationUuid);
  return { stationExists: true, applied: true, evseUuid, previousStatus, autoCreated, ...change };
}

// Fine-grained connector status from a TransactionEvent chargingState, ordered
// by the TransactionEvent timestamp like any other status report. A faulted or
// unavailable connector keeps its status until the station reports a new one.
// Returns true when a connector changed.
export async function applyEvseChargingState(
  sql: postgres.Sql,
  evseUuid: string,
  status: string,
  timestamp: string | null,
): Promise<boolean> {
  const reportedAt = statusReportedAt(timestamp);
  const rows = await sql`
    UPDATE connectors
    SET status = ${status}, status_reported_at = ${reportedAt}::timestamptz, updated_at = now()
    WHERE evse_id = ${evseUuid}
      AND status NOT IN ('faulted', 'unavailable')
      AND (status_reported_at IS NULL OR ${reportedAt}::timestamptz IS NULL
        OR ${reportedAt}::timestamptz >= status_reported_at)
    RETURNING id
  `;
  return rows.length > 0;
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

// SQL form of isStationLevelUnavailable for the charging_stations row aliased
// `stationAlias`. Never NULL. The alias is a code constant, never user input.
export function stationLevelUnavailableSql(stationAlias: string): string {
  const s = stationAlias;
  return `(${s}.disabled_reason IS NOT NULL OR ${s}.firmware_state IS NOT NULL
    OR COALESCE(${s}.reported_status = 'unavailable' OR ${s}.reported_status = 'faulted', false))`;
}
