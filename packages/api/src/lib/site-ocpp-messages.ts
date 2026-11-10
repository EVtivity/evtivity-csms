// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, type SQL } from 'drizzle-orm';
import { db, operatorStationSql, toDate } from '@evtivity/database';
import { maskStationCredentials } from '@evtivity/lib/secret-config';
import { readStationSiteWindows } from './site-layout-replay.js';
import { visibleActionCondition } from './ocpp-log-visibility.js';

/** The most lines one read returns, and the default. */
export const SITE_OCPP_MESSAGES_MAX = 200;
export const SITE_OCPP_MESSAGES_DEFAULT = 100;

export interface SiteOcppMessage {
  id: number;
  stationId: string;
  stationOcppId: string;
  direction: string;
  messageType: number;
  messageId: string | null;
  action: string | null;
  payload: unknown;
  errorCode: string | null;
  errorDescription: string | null;
  createdAt: Date;
}

export interface SiteOcppMessagesQuery {
  siteId: string;
  stationId?: string | undefined;
  after?: Date | undefined;
  limit: number;
  /** Actions the reader may not see (`hiddenOcppLogActions`). */
  hiddenActions?: readonly string[] | undefined;
}

interface Row extends Record<string, unknown> {
  id: number;
  station_id: string;
  station_ocpp_id: string;
  direction: string;
  message_type: number;
  message_id: string | null;
  action: string | null;
  payload: unknown;
  error_code: string | null;
  error_description: string | null;
  created_at: Date | string;
}

/**
 * The newest OCPP messages of the operator stations of a site (or one of
 * them), oldest first, optionally only those logged at or after `after`, and
 * only from the time each station stands at the site (`stationReplaySince`).
 * Each station's newest rows come from its (station_id, created_at) index,
 * then the payloads of the overall newest `limit` rows are read by id, so a
 * large site never loads every station's payloads.
 */
export async function listSiteOcppMessages(
  query: SiteOcppMessagesQuery,
): Promise<SiteOcppMessage[]> {
  const stationConditions: SQL[] = [
    sql`s.site_id = ${query.siteId}`,
    sql.raw(operatorStationSql('s')),
  ];
  if (query.stationId != null) stationConditions.push(sql`s.id = ${query.stationId}`);
  const after = query.after != null ? sql`AND l.created_at >= ${query.after}` : sql``;
  const visible = visibleActionCondition(sql`l.action`, query.hiddenActions ?? []);
  const visibleOnly = visible != null ? sql`AND ${visible}` : sql``;

  const stations = await db.execute<{ id: string; station_id: string }>(sql`
    SELECT s.id, s.station_id FROM charging_stations s
    WHERE ${sql.join(stationConditions, sql` AND `)}
  `);
  if (stations.length === 0) return [];

  // A moved station shows only its rows from its time at this site; one whose
  // time here cannot be told (closed window) shows none.
  const sinceByStation = await readStationSiteWindows(
    query.siteId,
    stations.map((s) => s.id),
  );
  const windowRows: SQL[] = [];
  for (const s of stations) {
    const since = sinceByStation.has(s.id) ? (sinceByStation.get(s.id) ?? null) : 'closed';
    if (since === 'closed') continue;
    const value = since == null ? '-infinity' : since.toISOString();
    windowRows.push(sql`(${s.id}, ${s.station_id}, ${value}::timestamptz)`);
  }
  if (windowRows.length === 0) return [];

  const rows = await db.execute<Row>(sql`
    WITH newest AS (
      SELECT recent.id, recent.created_at, w.station_ocpp_id
      FROM (VALUES ${sql.join(windowRows, sql`, `)}) AS w(station_id, station_ocpp_id, since)
      CROSS JOIN LATERAL (
        SELECT l.id, l.created_at
        FROM ocpp_message_logs l
        WHERE l.station_id = w.station_id AND l.created_at >= w.since ${after} ${visibleOnly}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ${query.limit}
      ) recent
      ORDER BY recent.created_at DESC, recent.id DESC
      LIMIT ${query.limit}
    )
    SELECT l.id, l.station_id, n.station_ocpp_id, l.direction::text AS direction,
      l.message_type, l.message_id, l.action, l.payload, l.error_code,
      l.error_description, l.created_at
    FROM newest n
    JOIN ocpp_message_logs l ON l.id = n.id
    ORDER BY l.created_at ASC, l.id ASC
  `);

  return rows.map((r) => ({
    id: r.id,
    stationId: r.station_id,
    stationOcppId: r.station_ocpp_id,
    direction: r.direction,
    messageType: r.message_type,
    messageId: r.message_id,
    action: r.action,
    // The log stores payloads masked; masking again on read keeps rows
    // written before the masking existed out of the browser too.
    payload: maskStationCredentials(r.payload),
    errorCode: r.error_code,
    errorDescription:
      r.error_description == null ? null : maskStationCredentials(r.error_description),
    createdAt: toDate(r.created_at),
  }));
}
