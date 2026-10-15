// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Whether a station's AI insights are suppressed now: an operator suppressed
 * them (until a date, or until resumed), or an active maintenance event
 * covers the station (the whole site when it names no stations). While
 * suppressed, the insight scan and the AI workers create no insight or
 * action for the station; the end date passing resumes them by itself.
 */

/** SQL: the operator suppression of station `alias` holds now. */
export function stationInsightsOperatorSuppressedSql(alias: string): string {
  const s = alias;
  return `(${s}.ai_insights_suppressed_at IS NOT NULL
    AND (${s}.ai_insights_suppressed_until IS NULL OR ${s}.ai_insights_suppressed_until > now()))`;
}

/** SQL: an active maintenance event covers station `alias`. */
export function stationUnderActiveMaintenanceSql(alias: string): string {
  const s = alias;
  return `EXISTS (
    SELECT 1 FROM maintenance_events me
    WHERE me.site_id = ${s}.site_id AND me.status = 'active'
      AND (me.affected_station_ids IS NULL OR me.affected_station_ids = '{}'::text[]
        OR ${s}.id = ANY(me.affected_station_ids))
  )`;
}

/** SQL: no new AI insight or worker action for station `alias` now. */
export function stationInsightsSuppressedSql(alias: string): string {
  return `(${stationInsightsOperatorSuppressedSql(alias)} OR ${stationUnderActiveMaintenanceSql(alias)})`;
}
