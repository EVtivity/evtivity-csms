// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Whether a vehicle is plugged in at a connector of the site layout: the 3D view keeps the car
// on its cable until the connector is unplugged, also after a fault ended the session.

import { client } from '@evtivity/database';

/**
 * Connector statuses that report a cable in the connector (OCPP 1.6 Preparing to Finishing,
 * 2.x Occupied and the chargingState values).
 */
export const PLUGGED_CONNECTOR_STATUSES: ReadonlySet<string> = new Set([
  'occupied',
  'charging',
  'preparing',
  'suspended_ev',
  'suspended_evse',
  'finishing',
  'idle',
  'discharging',
  'ev_connected',
]);

/**
 * Statuses that say nothing about the cable: a fault, or the outage a station or operator
 * reports. The station keeps the cable state it had before.
 */
const DOWN_STATUSES: ReadonlySet<string> = new Set(['faulted', 'unavailable']);

export function isDownConnectorStatus(status: string): boolean {
  return DOWN_STATUSES.has(status);
}

/** One `port_status_log` row of a connector, newest first. */
export interface PortStatusRow {
  previousStatus: string | null;
  newStatus: string;
}

/**
 * The last status of a connector before it went down (faulted or unavailable), from its
 * status history newest first: the newest status that is not a down status, whether a row
 * moved to it or from it. Null when the history holds none.
 */
export function statusBeforeDown(rows: ReadonlyArray<PortStatusRow>): string | null {
  for (const row of rows) {
    if (!DOWN_STATUSES.has(row.newStatus)) return row.newStatus;
    if (row.previousStatus != null && !DOWN_STATUSES.has(row.previousStatus)) {
      return row.previousStatus;
    }
  }
  return null;
}

/**
 * A vehicle is plugged in while the connector has an active session, reports a cable, or is
 * down (a fault ends the session, OCPP has no cable state while Faulted) after a status that
 * reported a cable. The car stays until the connector reports a status without one.
 */
export function connectorPluggedIn(input: {
  hasActiveSession: boolean;
  status: string;
  statusBeforeDown: string | null;
}): boolean {
  if (input.hasActiveSession) return true;
  if (PLUGGED_CONNECTOR_STATUSES.has(input.status)) return true;
  return (
    DOWN_STATUSES.has(input.status) &&
    input.statusBeforeDown != null &&
    PLUGGED_CONNECTOR_STATUSES.has(input.statusBeforeDown)
  );
}

/** A connector to look up: the station's database id and the OCPP EVSE and connector numbers. */
export interface DownConnector {
  stationUuid: string;
  evseId: number;
  connectorId: number;
}

export function downConnectorKey(c: DownConnector): string {
  return `${c.stationUuid}:${String(c.evseId)}:${String(c.connectorId)}`;
}

/** Rows read per connector: enough to step over the outage rows a disconnect writes. */
const HISTORY_ROWS = 20;

/**
 * The status before the current fault or outage of each down connector
 * (`statusBeforeDown` over its newest `port_status_log` rows), keyed by `downConnectorKey`.
 * One query for all of them; the station and EVSE index serves it.
 */
export async function readStatusesBeforeDown(
  connectors: ReadonlyArray<DownConnector>,
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (connectors.length === 0) return result;
  const rows = await client<
    Array<{
      station_id: string;
      evse_id: number;
      connector_id: number;
      previous_status: string | null;
      new_status: string;
      log_id: number;
    }>
  >`
    SELECT c.station_id, c.evse_id, c.connector_id, h.previous_status, h.new_status, h.log_id
    FROM unnest(
      ${connectors.map((c) => c.stationUuid)}::text[],
      ${connectors.map((c) => c.evseId)}::int[],
      ${connectors.map((c) => c.connectorId)}::int[]
    ) AS c(station_id, evse_id, connector_id)
    CROSS JOIN LATERAL (
      SELECT l.previous_status, l.new_status, l.id AS log_id, l.timestamp AS logged_at
      FROM port_status_log l
      WHERE l.station_id = c.station_id
        AND l.evse_id = c.evse_id
        AND l.connector_id = c.connector_id
      ORDER BY l.timestamp DESC, l.id DESC
      LIMIT ${HISTORY_ROWS}
    ) h
    ORDER BY h.logged_at DESC, h.log_id DESC
  `;
  const byKey = new Map<string, PortStatusRow[]>();
  for (const row of rows) {
    const key = downConnectorKey({
      stationUuid: row.station_id,
      evseId: row.evse_id,
      connectorId: row.connector_id,
    });
    const list = byKey.get(key) ?? [];
    list.push({ previousStatus: row.previous_status, newStatus: row.new_status });
    byKey.set(key, list);
  }
  for (const c of connectors) {
    const key = downConnectorKey(c);
    result.set(key, statusBeforeDown(byKey.get(key) ?? []));
  }
  return result;
}
