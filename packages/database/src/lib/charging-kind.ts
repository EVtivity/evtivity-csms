// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The charging kind (AC or DC) a price is resolved for, from the connectors
// of an EVSE (owner decisions 2026-11-13, tariff charging types): an EVSE
// with only AC connectors is AC, only DC is DC; a mixed EVSE (Type 2 and
// CCS2 on one EVSE) takes the kind of the connector the station names, and
// is unknown until then (only Both tariffs apply, D-E).

import type postgres from 'postgres';
import { evseChargingKind, isDcConnector } from '@evtivity/lib';
import type { ChargingKind } from '@evtivity/lib';

interface ConnectorRow {
  id: string;
  connector_type: string | null;
  max_power_kw: string | null;
}

function kindOfRows(rows: readonly ConnectorRow[]): ChargingKind | 'mixed' | null {
  return evseChargingKind(
    rows.map((r) => ({ connectorType: r.connector_type, maxPowerKw: r.max_power_kw })),
  );
}

/**
 * The kind of an EVSE (internal id) from its in-service connectors, or of one
 * of its connectors (internal connector id) when given: `ac`, `dc`, `mixed`
 * (only without a connector), or null (no connector with a type).
 */
export async function loadEvseChargingKind(
  sql: postgres.Sql,
  evseUuid: string,
  connectorUuid?: string | null,
): Promise<ChargingKind | 'mixed' | null> {
  const rows = await sql<ConnectorRow[]>`
    SELECT id, connector_type, max_power_kw::text AS max_power_kw
    FROM connectors
    WHERE evse_id = ${evseUuid} AND retired_at IS NULL
  `;
  if (connectorUuid != null) {
    const connector = rows.find((r) => r.id === connectorUuid);
    if (connector?.connector_type != null && connector.connector_type !== '') {
      return isDcConnector({
        connectorType: connector.connector_type,
        maxPowerKw: connector.max_power_kw,
      })
        ? 'dc'
        : 'ac';
    }
  }
  return kindOfRows(rows);
}

/** The kind a price for the EVSE is resolved for: a mixed or unknown EVSE resolves the Both tariffs. */
export function resolvableKind(kind: ChargingKind | 'mixed' | null): ChargingKind | null {
  return kind === 'ac' || kind === 'dc' ? kind : null;
}

/**
 * The kinds of a station's in-service EVSEs, one entry per EVSE (internal
 * EVSE id to its kind): the station-level price views show AC and DC side by
 * side when they differ.
 */
export async function loadStationEvseKinds(
  sql: postgres.Sql,
  stationUuid: string,
): Promise<Map<string, ChargingKind | 'mixed' | null>> {
  // LEFT JOIN: an EVSE without connectors comes back once with a null id.
  const rows = await sql<Array<Omit<ConnectorRow, 'id'> & { id: string | null; evse_id: string }>>`
    SELECT e.id AS evse_id, c.id, c.connector_type, c.max_power_kw::text AS max_power_kw
    FROM evses e
    LEFT JOIN connectors c ON c.evse_id = e.id AND c.retired_at IS NULL
    WHERE e.station_id = ${stationUuid} AND e.retired_at IS NULL
  `;
  const byEvse = new Map<string, ConnectorRow[]>();
  for (const r of rows) {
    const list = byEvse.get(r.evse_id) ?? [];
    if (r.id != null) list.push({ ...r, id: r.id });
    byEvse.set(r.evse_id, list);
  }
  const out = new Map<string, ChargingKind | 'mixed' | null>();
  for (const [evse, list] of byEvse) out.set(evse, kindOfRows(list));
  return out;
}

/**
 * The kind of a session from its EVSE and connector (the connector the
 * station named, or the EVSE's only connector), stored once on the session
 * (`charging_kind`, only while null). Returns the stored kind, or null when
 * it is not known (no EVSE, a mixed EVSE without a named connector).
 */
export async function stampSessionChargingKind(
  sql: postgres.Sql,
  sessionId: string,
): Promise<ChargingKind | null> {
  const [session] = await sql<
    Array<{ evse_id: string | null; connector_id: string | null; charging_kind: string | null }>
  >`
    SELECT evse_id, connector_id, charging_kind FROM charging_sessions WHERE id = ${sessionId}
  `;
  if (session == null) return null;
  if (session.charging_kind === 'ac' || session.charging_kind === 'dc') {
    return session.charging_kind;
  }
  if (session.evse_id == null) return null;
  const kind = resolvableKind(
    await loadEvseChargingKind(sql, session.evse_id, session.connector_id),
  );
  if (kind == null) return null;
  const [row] = await sql<Array<{ charging_kind: string }>>`
    UPDATE charging_sessions SET charging_kind = ${kind}
    WHERE id = ${sessionId} AND charging_kind IS NULL
    RETURNING charging_kind
  `;
  if (row != null) return kind;
  const [stored] = await sql<Array<{ charging_kind: string | null }>>`
    SELECT charging_kind FROM charging_sessions WHERE id = ${sessionId}
  `;
  return stored?.charging_kind === 'ac' || stored?.charging_kind === 'dc'
    ? stored.charging_kind
    : null;
}

/**
 * The charging kinds a start on the EVSE may be priced at, for the free or
 * paid decision before the session exists: AC or DC for an AC-only or
 * DC-only EVSE; the Both tariffs plus AC and DC for a mixed EVSE (it is
 * re-priced once its connector is named, D-E); without an EVSE every kind of
 * the station's EVSEs and the Both tariffs.
 */
export async function startChargingKinds(
  sql: postgres.Sql,
  q: { stationUuid: string; evseUuid?: string | null },
): Promise<Array<ChargingKind | null>> {
  if (q.evseUuid != null) {
    const kind = await loadEvseChargingKind(sql, q.evseUuid);
    if (kind === 'ac' || kind === 'dc') return [kind];
    return kind === 'mixed' ? [null, 'ac', 'dc'] : [null];
  }
  const kinds = new Set<ChargingKind | null>([null]);
  for (const kind of (await loadStationEvseKinds(sql, q.stationUuid)).values()) {
    if (kind === 'ac' || kind === 'dc') kinds.add(kind);
    if (kind === 'mixed') {
      kinds.add('ac');
      kinds.add('dc');
    }
  }
  return [...kinds];
}

/**
 * The kind a station-level price is shown for: the kind of every EVSE of the
 * station, or null (the Both tariffs) when it has AC and DC EVSEs, a mixed
 * EVSE, or no EVSE with a typed connector.
 */
export async function stationDisplayKind(
  sql: postgres.Sql,
  stationUuid: string,
): Promise<ChargingKind | null> {
  const kinds = [...(await loadStationEvseKinds(sql, stationUuid)).values()];
  if (kinds.length === 0 || kinds.some((k) => k !== kinds[0])) return null;
  return resolvableKind(kinds[0] ?? null);
}
