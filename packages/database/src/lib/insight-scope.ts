// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The site counts of an automatic insight's scope, computed in SQL and never
 * by the model. The one query for these counts: the insight analysis
 * (`computeInsightScope` in `@evtivity/services`) and the demo seed call it.
 */

import type postgres from 'postgres';
import type { InsightScope, InsightScopeCounts } from '@evtivity/lib/ai-insights';
import { client } from '../config.js';
import { stationAvailabilitySql } from './station-status.js';

export interface InsightScopeInput {
  siteId: string | null;
  /** The subject station's latest StatusNotification error code (24 h). */
  errorCode?: string | null;
  /** The subject session's stop reason. */
  stoppedReason?: string | null;
}

interface CountsRow {
  stations: number;
  stations_offline: number;
  stations_faulted: number;
  same_error_code: number | null;
  sessions_interrupted: number;
  sessions_failed_same_reason: number | null;
  token_refusals: number;
}

/** Counts for one site. `sql` defaults to the shared client (the seed passes its own). */
export async function insightSiteScopeCounts(
  siteId: string,
  input: Omit<InsightScopeInput, 'siteId'> = {},
  sql: postgres.Sql = client,
): Promise<InsightScopeCounts> {
  const errorCode = input.errorCode ?? null;
  const reason = input.stoppedReason ?? null;
  const [row] = await sql<CountsRow[]>`
    WITH st AS (
      SELECT cs.id, cs.station_id, cs.is_online,
        ${sql.unsafe(stationAvailabilitySql('cs'))} AS availability
      FROM charging_stations cs
      WHERE cs.site_id = ${siteId}
    )
    SELECT
      (SELECT count(*)::int FROM st) AS stations,
      (SELECT count(*)::int FROM st WHERE NOT is_online) AS stations_offline,
      (SELECT count(*)::int FROM st WHERE availability = 'faulted') AS stations_faulted,
      CASE WHEN ${errorCode}::text IS NULL THEN NULL ELSE (
        SELECT count(DISTINCT l.station_id)::int FROM ocpp_message_logs l
        WHERE l.station_id IN (SELECT id FROM st)
          AND l.action = 'StatusNotification' AND l.direction = 'inbound'
          AND l.created_at > now() - interval '24 hours'
          AND l.payload ->> 'errorCode' = ${errorCode}
      ) END AS same_error_code,
      (SELECT count(*)::int FROM charging_sessions s
        WHERE s.station_id IN (SELECT id FROM st)
          AND s.status IN ('failed', 'faulted')
          AND s.updated_at > now() - interval '24 hours') AS sessions_interrupted,
      CASE WHEN ${reason}::text IS NULL THEN NULL ELSE (
        SELECT count(*)::int FROM charging_sessions s
        WHERE s.station_id IN (SELECT id FROM st)
          AND s.status IN ('failed', 'faulted') AND s.stopped_reason = ${reason}
          AND s.updated_at > now() - interval '24 hours'
      ) END AS sessions_failed_same_reason,
      (SELECT count(*)::int FROM authorize_attempts a
        WHERE a.station_id IN (SELECT station_id FROM st)
          AND a.outcome <> 'accepted'
          AND a.created_at > now() - interval '24 hours') AS token_refusals
  `;
  const counts: InsightScopeCounts = {
    stations: row?.stations ?? 0,
    stationsOffline: row?.stations_offline ?? 0,
    stationsFaulted: row?.stations_faulted ?? 0,
    sessionsInterrupted: row?.sessions_interrupted ?? 0,
    tokenRefusals: row?.token_refusals ?? 0,
  };
  if (row?.same_error_code != null) counts.sameErrorCode = row.same_error_code;
  if (row?.sessions_failed_same_reason != null) {
    counts.sessionsFailedSameReason24h = row.sessions_failed_same_reason;
  }
  return counts;
}

/** The site counts of the subject; empty for a subject without a site. */
export async function computeInsightScopeCounts(
  input: InsightScopeInput,
  sql: postgres.Sql = client,
): Promise<InsightScope> {
  if (input.siteId == null) return {};
  return { site: await insightSiteScopeCounts(input.siteId, input, sql) };
}
