// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Site incident evidence: the member stations (state, vendor, model,
 * firmware, heartbeat) and the latest connection events at the site. Only
 * the site's own stations are read, so a pack never holds another site's
 * data, and never a conformance test station. Every column is listed by name.
 */

import {
  client,
  operatorStationSql,
  stationAvailabilitySql,
  stationStatusReasonSql,
  toIsoOrNull,
} from '@evtivity/database';
import type { RawTimestamp } from '@evtivity/database';
import type { EvidenceItem, EvidencePack, UntrustedEvidence } from './pack.js';
import { untrustedString } from './pack.js';

export const SITE_STATION_LIMIT = 20;
export const SITE_CONNECTION_LIMIT = 20;

export interface SiteStationRow {
  id: string;
  station_id: string;
  vendor_name: string | null;
  model: string | null;
  firmware_version: string | null;
  ocpp_protocol: string | null;
  is_online: boolean;
  availability: string;
  status_reason: string | null;
  last_heartbeat: RawTimestamp;
  member: boolean;
}

export interface SiteConnectionRow {
  id: number;
  station_id: string;
  event: string;
  reason: string | null;
  created_at: RawTimestamp;
}

export interface SiteEvidenceRows {
  siteId: string;
  stations: SiteStationRow[];
  connections: SiteConnectionRow[];
}

export function buildSiteEvidence(rows: SiteEvidenceRows, subjectId: string): EvidencePack {
  const items: EvidenceItem[] = [];
  const untrusted: UntrustedEvidence[] = [];
  for (const s of rows.stations) {
    items.push({
      id: `station:${s.id}`,
      kind: s.member ? 'incident_station' : 'site_station',
      data: {
        stationId: s.station_id,
        vendor: s.vendor_name,
        ocppProtocol: s.ocpp_protocol,
        isOnline: s.is_online,
        availability: s.availability,
        statusReason: s.status_reason,
        lastHeartbeat: toIsoOrNull(s.last_heartbeat),
      },
    });
  }
  // Model and firmware version come from BootNotification: station supplied.
  for (const s of rows.stations) {
    for (const [source, text] of [
      ['station_model', s.model],
      ['station_firmware_version', s.firmware_version],
    ] as const) {
      const value = untrustedString(`station:${s.id}`, source, text);
      if (value != null) untrusted.push(value);
    }
  }
  for (const c of rows.connections) {
    items.push({
      id: `conn:${String(c.id)}`,
      kind: 'connection_event',
      data: {
        stationId: c.station_id,
        event: c.event,
        reason: c.reason,
        at: toIsoOrNull(c.created_at),
      },
    });
  }
  return {
    subject: { type: 'site', id: subjectId, siteId: rows.siteId },
    facts: {
      stationsListed: rows.stations.length,
      incidentStations: rows.stations.filter((s) => s.member).length,
    },
    items,
    untrusted,
  };
}

/** Member stations first (the incident's own), then other stations of the site. */
export async function loadSiteEvidenceRows(
  siteId: string,
  memberStationIds: readonly string[],
): Promise<SiteEvidenceRows> {
  const members = [...memberStationIds];
  const [stations, connections] = await Promise.all([
    client<SiteStationRow[]>`
      SELECT cs.id, cs.station_id, v.name AS vendor_name, cs.model, cs.firmware_version,
        cs.ocpp_protocol, cs.is_online,
        ${client.unsafe(stationAvailabilitySql('cs'))} AS availability,
        ${client.unsafe(stationStatusReasonSql('cs'))} AS status_reason,
        cs.last_heartbeat, cs.id = ANY(${members}::text[]) AS member
      FROM charging_stations cs
      LEFT JOIN vendors v ON v.id = cs.vendor_id
      WHERE cs.site_id = ${siteId} AND ${client.unsafe(operatorStationSql('cs'))}
      ORDER BY (cs.id = ANY(${members}::text[])) DESC, cs.station_id
      LIMIT ${SITE_STATION_LIMIT}
    `,
    client<SiteConnectionRow[]>`
      SELECT l.id, cs.station_id, l.event, l.metadata ->> 'reason' AS reason, l.created_at
      FROM connection_logs l
      JOIN charging_stations cs ON cs.id = l.station_id
      WHERE cs.site_id = ${siteId} AND ${client.unsafe(operatorStationSql('cs'))}
      ORDER BY l.created_at DESC, l.id DESC LIMIT ${SITE_CONNECTION_LIMIT}
    `,
  ]);
  return { siteId, stations, connections };
}

export async function collectSiteEvidence(
  siteId: string,
  memberStationIds: readonly string[],
  subjectId: string,
): Promise<{ pack: EvidencePack }> {
  const rows = await loadSiteEvidenceRows(siteId, memberStationIds);
  return { pack: buildSiteEvidence(rows, subjectId) };
}
