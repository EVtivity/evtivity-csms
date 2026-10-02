// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, getTableName, type SQL, type Column } from 'drizzle-orm';
import { chargingStations, evses, connectors, stationStatusReasonSql } from '@evtivity/database';

// Always table-qualify the correlated column. In a no-join outer query drizzle
// renders columns unqualified, and an unqualified "id" inside these subqueries
// is ambiguous (s2.id, e2.id, and c2.id exist), which Postgres rejects at
// runtime.
function qualified(stationIdColumn: Column): SQL {
  return sql`${sql.identifier(getTableName(stationIdColumn.table))}.${sql.identifier(stationIdColumn.name)}`;
}

// Connector statuses that show the station as charging (a plug in use). Idle
// and discharging are TransactionEvent states of a session in progress.
const IN_USE_STATUSES_SQL = `'occupied', 'charging', 'preparing', 'ev_connected', 'suspended_ev', 'suspended_evse', 'idle', 'discharging'`;

/**
 * Correlated subquery for the one station status every surface shows.
 * Station-level states come first, because they apply to the whole station
 * even while a plug is busy: a disable (operator or security), a failed
 * firmware install or a station that reports itself faulted, an install in
 * progress or a station that reports itself unavailable. Otherwise it is the
 * plug summary: charging > reserved > faulted > unknown (no connectors) >
 * available > unavailable.
 *
 * Pass the station-id column to correlate against (e.g. `chargingStations.id`).
 * The frontend status badge mapping depends on these exact values.
 */
export function buildDerivedStatusSubquery(stationIdColumn: Column): SQL<string> {
  const outerColumn = qualified(stationIdColumn);
  return sql<string>`(
    SELECT CASE
      WHEN MAX(s2.disabled_reason::text) IS NOT NULL THEN 'unavailable'
      WHEN MAX(s2.firmware_state::text) = 'failed' OR MAX(s2.reported_status::text) = 'faulted' THEN 'faulted'
      WHEN MAX(s2.firmware_state::text) = 'installing' OR MAX(s2.reported_status::text) = 'unavailable' THEN 'unavailable'
      WHEN COUNT(c2.id) FILTER (WHERE c2.status::text IN (${sql.raw(IN_USE_STATUSES_SQL)})) > 0 THEN 'charging'
      WHEN COUNT(c2.id) FILTER (WHERE c2.status = 'reserved') > 0 THEN 'reserved'
      WHEN COUNT(c2.id) FILTER (WHERE c2.status = 'faulted') > 0 THEN 'faulted'
      WHEN COUNT(c2.id) = 0 THEN 'unknown'
      WHEN COUNT(c2.id) FILTER (WHERE c2.status = 'available') = COUNT(c2.id) THEN 'available'
      ELSE 'unavailable'
    END
    FROM ${chargingStations} s2
    LEFT JOIN ${evses} e2 ON e2.station_id = s2.id
    LEFT JOIN ${connectors} c2 ON c2.evse_id = e2.id
    WHERE s2.id = ${outerColumn}
  )`;
}

/**
 * Correlated subquery for why the station is not available (null when it is):
 * operator_disabled, security_disabled, firmware_failed, station_faulted,
 * connector_faulted, firmware_installing, station_unavailable. The rule lives
 * in `@evtivity/database` next to the availability rule it explains.
 *
 * A faulted connector only explains the display status when no other plug is
 * in use or reserved: the derived status shows charging or reserved then, so
 * the reason is null, matching buildDerivedStatusSubquery.
 */
export function buildStatusReasonSubquery(stationIdColumn: Column): SQL<string | null> {
  const outerColumn = qualified(stationIdColumn);
  return sql<string | null>`(
    SELECT CASE
      WHEN r3.reason = 'connector_faulted' AND EXISTS (
        SELECT 1 FROM ${connectors} c3 JOIN ${evses} e3 ON e3.id = c3.evse_id
        WHERE e3.station_id = r3.id
          AND c3.status::text IN (${sql.raw(IN_USE_STATUSES_SQL)}, 'reserved')
      ) THEN NULL
      ELSE r3.reason
    END
    FROM (
      SELECT s3.id, ${sql.raw(stationStatusReasonSql('s3'))} AS reason
      FROM ${chargingStations} s3
      WHERE s3.id = ${outerColumn}
    ) r3
  )`;
}
