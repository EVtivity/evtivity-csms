// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Deterministic scope counts of an insight, computed in SQL and never by the
 * model. `site` counts the subject's site,
 * `network` every site. The same-error-code count reads the StatusNotification
 * log and is computed for the site only (a network count would scan every
 * station's message log). The network counts are stored but returned only to
 * users with access to every site.
 */

import { client, stationAvailabilitySql } from '@evtivity/database';
import type { InsightScope, InsightScopeCounts } from '@evtivity/lib/ai-insights';

export interface ScopeInput {
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

/** Counts for one site, or for every site when `siteId` is null. */
async function scopeCounts(siteId: string | null, input: ScopeInput): Promise<InsightScopeCounts> {
  const errorCode = input.errorCode ?? null;
  const reason = input.stoppedReason ?? null;
  const [row] = await client<CountsRow[]>`
    WITH st AS (
      SELECT cs.id, cs.station_id, cs.is_online,
        ${client.unsafe(stationAvailabilitySql('cs'))} AS availability
      FROM charging_stations cs
      WHERE ${siteId}::text IS NULL OR cs.site_id = ${siteId}
    )
    SELECT
      (SELECT count(*)::int FROM st) AS stations,
      (SELECT count(*)::int FROM st WHERE NOT is_online) AS stations_offline,
      (SELECT count(*)::int FROM st WHERE availability = 'faulted') AS stations_faulted,
      CASE WHEN ${errorCode}::text IS NULL OR ${siteId}::text IS NULL THEN NULL ELSE (
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

/** The site counts (when the subject has a site) and the network counts. */
export async function computeInsightScope(input: ScopeInput): Promise<InsightScope> {
  const [site, network] = await Promise.all([
    input.siteId == null ? Promise.resolve(undefined) : scopeCounts(input.siteId, input),
    scopeCounts(null, input),
  ]);
  return site === undefined ? { network } : { site, network };
}

/** Removes the network counts for a user restricted to some sites. */
export function scopeForViewer(scope: InsightScope, allSites: boolean): InsightScope {
  if (allSites) return scope;
  return scope.site === undefined ? {} : { site: scope.site };
}

/** The record an insight is about, for its live scope. */
export interface LiveScopeSubject {
  kind: string;
  siteId: string | null;
  stationId: string | null;
  sessionId: string | null;
}

const STATION_SCOPE_KINDS: ReadonlySet<string> = new Set([
  'station_offline',
  'station_faulted',
  'station_alert',
]);

/** Kinds whose scope the analysis computes (worker summaries and findings have none). */
const LIVE_SCOPE_KINDS: ReadonlySet<string> = new Set([
  ...STATION_SCOPE_KINDS,
  'session_failed',
  'authorization_refused',
  'site_incident',
]);

/**
 * The same counts as the stored snapshot, computed now with the same SQL and
 * the same inputs the analysis used (the station's latest error code, the
 * session's stop reason). SQL only: no model call. Null for kinds without a
 * scope. The caller applies `scopeForViewer`.
 */
export async function computeLiveInsightScope(
  subject: LiveScopeSubject,
): Promise<InsightScope | null> {
  if (!LIVE_SCOPE_KINDS.has(subject.kind)) return null;
  let errorCode: string | null = null;
  let stoppedReason: string | null = null;
  if (STATION_SCOPE_KINDS.has(subject.kind) && subject.stationId != null) {
    const [row] = await client<{ error_code: string | null }[]>`
      SELECT payload ->> 'errorCode' AS error_code FROM ocpp_message_logs
      WHERE station_id = ${subject.stationId} AND action = 'StatusNotification'
        AND direction = 'inbound' AND payload ->> 'errorCode' IS NOT NULL
        AND payload ->> 'errorCode' <> 'NoError' AND created_at > now() - interval '24 hours'
      ORDER BY created_at DESC, id DESC LIMIT 1
    `;
    errorCode = row?.error_code ?? null;
  }
  if (subject.kind === 'session_failed' && subject.sessionId != null) {
    const [row] = await client<{ stopped_reason: string | null }[]>`
      SELECT stopped_reason FROM charging_sessions WHERE id = ${subject.sessionId}
    `;
    stoppedReason = row?.stopped_reason ?? null;
  }
  return computeInsightScope({ siteId: subject.siteId, errorCode, stoppedReason });
}
