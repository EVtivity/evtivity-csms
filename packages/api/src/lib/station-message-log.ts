// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, type SQL } from 'drizzle-orm';
import { db, toDate } from '@evtivity/database';

/**
 * A station's OCPP message log: the messages exchanged (`processed`) and the
 * CSMS commands held in the offline command queue for the station
 * (`queued`: pending and not expired). A queued command is an outbound CALL
 * the station has not received yet; once the queue drains on reconnect it
 * leaves the queue and its CALL is logged as processed.
 */
export type MessageProcessingStatus = 'processed' | 'queued';

export interface StationMessageLogEntry {
  id: number;
  stationId: string;
  direction: string;
  messageType: number;
  messageId: string | null;
  action: string | null;
  payload: unknown;
  errorCode: string | null;
  errorDescription: string | null;
  createdAt: Date;
  processingStatus: MessageProcessingStatus;
}

export interface StationMessageLogQuery {
  page: number;
  limit: number;
  action?: string | undefined;
  direction?: 'inbound' | 'outbound' | undefined;
}

export interface StationMessageLogPage {
  data: StationMessageLogEntry[];
  total: number;
  actions: string[];
}

interface Row extends Record<string, unknown> {
  id: number;
  station_id: string;
  direction: string;
  message_type: number;
  message_id: string | null;
  action: string | null;
  payload: unknown;
  error_code: string | null;
  error_description: string | null;
  created_at: Date | string;
  processing_status: MessageProcessingStatus;
}

/** The pending, unexpired queue rows of a station (`stationDbId` is `charging_stations.id`). */
function queuedFilter(stationDbId: string, action: string | null): SQL {
  const conditions = [
    sql`s.id = ${stationDbId}`,
    sql`q.status = 'pending'`,
    sql`q.expires_at > now()`,
  ];
  if (action != null) conditions.push(sql`q.action = ${action}`);
  return sql.join(conditions, sql` AND `);
}

export async function listStationMessageLog(
  stationDbId: string,
  query: StationMessageLogQuery,
): Promise<StationMessageLogPage> {
  const action = query.action != null && query.action !== '' ? query.action : null;
  // Queued commands are outbound CALLs: an inbound filter leaves them out.
  const withQueued = query.direction !== 'inbound';
  const offset = (query.page - 1) * query.limit;

  const logConditions = [sql`l.station_id = ${stationDbId}`];
  if (action != null) logConditions.push(sql`l.action = ${action}`);
  if (query.direction != null) logConditions.push(sql`l.direction = ${query.direction}`);
  const logFilter = sql.join(logConditions, sql` AND `);

  const logs = sql`
    SELECT l.id, l.station_id, l.direction::text AS direction, l.message_type,
      l.message_id, l.action, l.payload, l.error_code, l.error_description, l.created_at,
      'processed'::text AS processing_status
    FROM ocpp_message_logs l
    WHERE ${logFilter}`;
  const queued = sql`
    SELECT q.id, s.id AS station_id, 'outbound'::text AS direction, 2 AS message_type,
      q.command_id AS message_id, q.action, q.payload, NULL::varchar AS error_code,
      NULL::text AS error_description, q.created_at, 'queued'::text AS processing_status
    FROM offline_command_queue q
    JOIN charging_stations s ON s.station_id = q.station_id
    WHERE ${queuedFilter(stationDbId, action)}`;
  const entries = withQueued ? sql`${logs} UNION ALL ${queued}` : logs;

  const [rows, logCount, queuedCount, logActions, queuedActions] = await Promise.all([
    db.execute<Row>(sql`
      SELECT * FROM (${entries}) entries
      ORDER BY created_at DESC, processing_status DESC, id DESC
      LIMIT ${query.limit} OFFSET ${offset}
    `),
    db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM ocpp_message_logs l WHERE ${logFilter}`,
    ),
    withQueued
      ? db.execute<{ count: number }>(sql`
          SELECT count(*)::int AS count
          FROM offline_command_queue q
          JOIN charging_stations s ON s.station_id = q.station_id
          WHERE ${queuedFilter(stationDbId, action)}`)
      : Promise.resolve([{ count: 0 }]),
    // Skip-scan emulation: a plain SELECT DISTINCT walks every log row for
    // the station (~500ms at a few thousand rows, worse as the table
    // grows); this recursive CTE probes the (station_id, action) index
    // once per distinct action (~40 probes) regardless of row count.
    db.execute<{ action: string | null }>(sql`
      WITH RECURSIVE distinct_actions AS (
        (SELECT action FROM ocpp_message_logs
         WHERE station_id = ${stationDbId} AND action IS NOT NULL
         ORDER BY action LIMIT 1)
        UNION ALL
        SELECT (
          SELECT action FROM ocpp_message_logs
          WHERE station_id = ${stationDbId} AND action > da.action
          ORDER BY action LIMIT 1
        )
        FROM distinct_actions da
        WHERE da.action IS NOT NULL
      )
      SELECT action FROM distinct_actions WHERE action IS NOT NULL
    `),
    db.execute<{ action: string }>(sql`
      SELECT DISTINCT q.action
      FROM offline_command_queue q
      JOIN charging_stations s ON s.station_id = q.station_id
      WHERE ${queuedFilter(stationDbId, null)}`),
  ]);

  const actions = new Set<string>();
  for (const r of logActions) if (r.action != null) actions.add(r.action);
  for (const r of queuedActions) actions.add(r.action);

  return {
    data: rows.map((r) => ({
      id: r.id,
      stationId: r.station_id,
      direction: r.direction,
      messageType: r.message_type,
      messageId: r.message_id,
      action: r.action,
      payload: r.payload,
      errorCode: r.error_code,
      errorDescription: r.error_description,
      createdAt: toDate(r.created_at),
      processingStatus: r.processing_status,
    })),
    total: (logCount[0]?.count ?? 0) + (queuedCount[0]?.count ?? 0),
    actions: [...actions].sort(),
  };
}
