// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Station evidence: status
 * transitions,
 * connection events, the last boot, firmware and availability state with its
 * reason, recent alerts, StatusNotification error codes, vendor and model,
 * OCPP version and heartbeat freshness. Every column is listed by name.
 * Station-supplied free text (model and firmware version from
 * BootNotification, the vendor error code and info, the alert component,
 * variable, actual value and tech info) goes into the pack's untrusted list
 * only.
 */

import {
  client,
  stationAvailabilitySql,
  stationStatusReasonSql,
  toIsoOrNull,
} from '@evtivity/database';
import type { RawTimestamp } from '@evtivity/database';
import type { EvidenceItem, EvidencePack, UntrustedEvidence } from './pack.js';
import { untrustedString } from './pack.js';

export const STATION_STATUS_LIMIT = 20;
export const STATION_CONNECTION_LIMIT = 20;
export const STATION_ALERT_LIMIT = 5;
export const STATION_ERROR_LIMIT = 5;

export interface StationFactsRow {
  id: string;
  station_id: string;
  site_id: string | null;
  vendor_name: string | null;
  model: string | null;
  firmware_version: string | null;
  ocpp_protocol: string | null;
  is_online: boolean;
  last_heartbeat: RawTimestamp;
  availability: string;
  status_reason: string | null;
  reported_status: string | null;
  firmware_state: string | null;
  disabled_reason: string | null;
  last_boot_at: RawTimestamp;
  last_boot_reason: string | null;
}

export interface StatusTransitionRow {
  id: number;
  evse_id: number;
  connector_id: number | null;
  previous_status: string | null;
  new_status: string;
  timestamp: RawTimestamp;
}

export interface ConnectionEventRow {
  id: number;
  event: string;
  reason: string | null;
  created_at: RawTimestamp;
}

export interface AlertRow {
  id: number;
  component: string | null;
  variable: string | null;
  severity: number | null;
  trigger: string | null;
  actual_value: string | null;
  tech_info: string | null;
  acknowledged: boolean;
  created_at: RawTimestamp;
}

export interface StatusErrorRow {
  id: number;
  connector_id: number | null;
  status: string | null;
  error_code: string | null;
  vendor_error_code: string | null;
  info: string | null;
  created_at: RawTimestamp;
}

export interface StationEvidenceRows {
  station: StationFactsRow;
  transitions: StatusTransitionRow[];
  connections: ConnectionEventRow[];
  alerts: AlertRow[];
  errors: StatusErrorRow[];
}

/** Builds the pack from the rows (pure, unit tested). */
export function buildStationEvidence(rows: StationEvidenceRows, now: Date): EvidencePack {
  const s = rows.station;
  const heartbeat = toIsoOrNull(s.last_heartbeat);
  const items: EvidenceItem[] = [];
  const untrusted: UntrustedEvidence[] = [];
  for (const t of rows.transitions) {
    items.push({
      id: `status:${String(t.id)}`,
      kind: 'status_transition',
      data: {
        evseId: t.evse_id,
        connectorId: t.connector_id,
        previousStatus: t.previous_status,
        newStatus: t.new_status,
        at: toIsoOrNull(t.timestamp),
      },
    });
  }
  for (const c of rows.connections) {
    items.push({
      id: `conn:${String(c.id)}`,
      kind: 'connection_event',
      data: { event: c.event, reason: c.reason, at: toIsoOrNull(c.created_at) },
    });
  }
  for (const a of rows.alerts) {
    const id = `alert:${String(a.id)}`;
    items.push({
      id,
      kind: 'station_alert',
      data: {
        severity: a.severity,
        trigger: a.trigger,
        acknowledged: a.acknowledged,
        at: toIsoOrNull(a.created_at),
      },
    });
    for (const [source, text] of [
      ['station_alert_component', a.component],
      ['station_alert_variable', a.variable],
    ] as const) {
      const value = untrustedString(id, source, text);
      if (value != null) untrusted.push(value);
    }
    const actual = untrustedString(id, 'station_alert_actual_value', a.actual_value);
    if (actual != null) untrusted.push(actual);
    const tech = untrustedString(id, 'station_alert_tech_info', a.tech_info);
    if (tech != null) untrusted.push(tech);
  }
  for (const e of rows.errors) {
    const id = `error:${String(e.id)}`;
    items.push({
      id,
      kind: 'status_error',
      data: {
        connectorId: e.connector_id,
        status: e.status,
        errorCode: e.error_code,
        at: toIsoOrNull(e.created_at),
      },
    });
    const vendor = untrustedString(id, 'station_vendor_error_code', e.vendor_error_code);
    if (vendor != null) untrusted.push(vendor);
    const info = untrustedString(id, 'station_status_info', e.info);
    if (info != null) untrusted.push(info);
  }
  // Model and firmware version come from BootNotification: station supplied.
  for (const [source, text] of [
    ['station_model', s.model],
    ['station_firmware_version', s.firmware_version],
  ] as const) {
    const value = untrustedString('station', source, text);
    if (value != null) untrusted.push(value);
  }
  return {
    subject: { type: 'station', id: s.id, siteId: s.site_id },
    facts: {
      stationId: s.station_id,
      vendor: s.vendor_name,
      ocppProtocol: s.ocpp_protocol,
      isOnline: s.is_online,
      lastHeartbeat: heartbeat,
      heartbeatAgeSeconds:
        heartbeat == null ? null : Math.round((now.getTime() - Date.parse(heartbeat)) / 1000),
      availability: s.availability,
      statusReason: s.status_reason,
      reportedStatus: s.reported_status,
      firmwareState: s.firmware_state,
      disabledReason: s.disabled_reason,
      lastBootAt: toIsoOrNull(s.last_boot_at),
      lastBootReason: s.last_boot_reason,
    },
    items,
    untrusted,
  };
}

/** Reads the station evidence rows; null when the station is gone. */
export async function loadStationEvidenceRows(
  stationId: string,
): Promise<StationEvidenceRows | null> {
  const [station] = await client<StationFactsRow[]>`
    SELECT cs.id, cs.station_id, cs.site_id, v.name AS vendor_name, cs.model,
      cs.firmware_version, cs.ocpp_protocol, cs.is_online, cs.last_heartbeat,
      ${client.unsafe(stationAvailabilitySql('cs'))} AS availability,
      ${client.unsafe(stationStatusReasonSql('cs'))} AS status_reason,
      cs.reported_status::text AS reported_status, cs.firmware_state::text AS firmware_state,
      cs.disabled_reason::text AS disabled_reason,
      boot.created_at AS last_boot_at, boot.reason AS last_boot_reason
    FROM charging_stations cs
    LEFT JOIN vendors v ON v.id = cs.vendor_id
    LEFT JOIN LATERAL (
      SELECT l.created_at, l.payload ->> 'reason' AS reason
      FROM ocpp_message_logs l
      WHERE l.station_id = cs.id AND l.action = 'BootNotification' AND l.direction = 'inbound'
      ORDER BY l.created_at DESC LIMIT 1
    ) boot ON true
    WHERE cs.id = ${stationId}
  `;
  if (station == null) return null;
  const [transitions, connections, alerts, errors] = await Promise.all([
    client<StatusTransitionRow[]>`
      SELECT id, evse_id, connector_id, previous_status, new_status, timestamp
      FROM port_status_log WHERE station_id = ${stationId}
      ORDER BY timestamp DESC, id DESC LIMIT ${STATION_STATUS_LIMIT}
    `,
    client<ConnectionEventRow[]>`
      SELECT id, event, metadata ->> 'reason' AS reason, created_at
      FROM connection_logs WHERE station_id = ${stationId}
      ORDER BY created_at DESC, id DESC LIMIT ${STATION_CONNECTION_LIMIT}
    `,
    client<AlertRow[]>`
      SELECT id, component, variable, severity, trigger, actual_value, tech_info,
        acknowledged_at IS NOT NULL AS acknowledged, created_at
      FROM event_alerts WHERE station_id = ${stationId}
      ORDER BY created_at DESC, id DESC LIMIT ${STATION_ALERT_LIMIT}
    `,
    client<StatusErrorRow[]>`
      SELECT id, (payload ->> 'connectorId')::int AS connector_id, payload ->> 'status' AS status,
        payload ->> 'errorCode' AS error_code, payload ->> 'vendorErrorCode' AS vendor_error_code,
        payload ->> 'info' AS info, created_at
      FROM ocpp_message_logs
      WHERE station_id = ${stationId} AND action = 'StatusNotification' AND direction = 'inbound'
        AND payload ->> 'errorCode' IS NOT NULL AND payload ->> 'errorCode' <> 'NoError'
        AND created_at > now() - interval '24 hours'
      ORDER BY created_at DESC, id DESC LIMIT ${STATION_ERROR_LIMIT}
    `,
  ]);
  return { station, transitions, connections, alerts, errors };
}

/** The most recent StatusNotification error code of a station in the last 24 hours. */
export function latestErrorCode(rows: StationEvidenceRows): string | null {
  return rows.errors[0]?.error_code ?? null;
}

export async function collectStationEvidence(
  stationId: string,
  now: Date = new Date(),
): Promise<{ pack: EvidencePack; errorCode: string | null } | null> {
  const rows = await loadStationEvidenceRows(stationId);
  if (rows == null) return null;
  return { pack: buildStationEvidence(rows, now), errorCode: latestErrorCode(rows) };
}
