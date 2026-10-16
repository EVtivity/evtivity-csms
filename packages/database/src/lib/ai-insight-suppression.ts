// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Whether AI insights are suppressed now. A station is suppressed when an
 * operator suppressed the station, or its site (each until a date, or until
 * resumed), or an active maintenance event covers it (the whole site when it
 * names no stations). A site is suppressed when an operator suppressed it or
 * an active maintenance event covers the whole site. While suppressed, the
 * insight scan and the AI workers create no insight or action for it; the end
 * date passing resumes them by itself.
 */

/** Effective suppression sources of a station, in display order. */
export const STATION_INSIGHT_SUPPRESSION_SOURCES = ['station', 'site', 'maintenance'] as const;
export type StationInsightSuppressionSource = (typeof STATION_INSIGHT_SUPPRESSION_SOURCES)[number];

/** Effective suppression sources of a site, in display order. */
export const SITE_INSIGHT_SUPPRESSION_SOURCES = ['site', 'maintenance'] as const;
export type SiteInsightSuppressionSource = (typeof SITE_INSIGHT_SUPPRESSION_SOURCES)[number];

/** SQL: the operator suppression stored on row `alias` (a station or a site) holds now. */
function operatorSuppressionHoldsSql(alias: string): string {
  const s = alias;
  return `(${s}.ai_insights_suppressed_at IS NOT NULL
    AND (${s}.ai_insights_suppressed_until IS NULL OR ${s}.ai_insights_suppressed_until > now()))`;
}

/** SQL: the operator suppression of station `alias` itself holds now. */
export function stationInsightsOperatorSuppressedSql(alias: string): string {
  return operatorSuppressionHoldsSql(alias);
}

/** SQL: the operator suppression of site `alias` holds now. */
export function siteInsightsOperatorSuppressedSql(alias: string): string {
  return operatorSuppressionHoldsSql(alias);
}

/** SQL: the site of station `alias` is suppressed by an operator now. */
export function stationSiteInsightsSuppressedSql(alias: string): string {
  return `EXISTS (
    SELECT 1 FROM sites ais_site
    WHERE ais_site.id = ${alias}.site_id AND ${siteInsightsOperatorSuppressedSql('ais_site')}
  )`;
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

/** SQL: an active maintenance event covers the whole of site `alias` (it names no stations). */
export function siteUnderActiveMaintenanceSql(alias: string): string {
  return `EXISTS (
    SELECT 1 FROM maintenance_events ais_me
    WHERE ais_me.site_id = ${alias}.id AND ais_me.status = 'active'
      AND (ais_me.affected_station_ids IS NULL OR ais_me.affected_station_ids = '{}'::text[])
  )`;
}

/**
 * SQL: no new AI insight or worker action for station `alias` now. The one
 * predicate of the scan, the workers, the station list filter and the
 * station detail: the station, its site, or an active maintenance event.
 */
export function stationInsightsSuppressedSql(alias: string): string {
  return `(${stationInsightsOperatorSuppressedSql(alias)} OR ${stationSiteInsightsSuppressedSql(alias)} OR ${stationUnderActiveMaintenanceSql(alias)})`;
}

/**
 * SQL: no new site-level AI insight (site incident, site summary, tariff
 * findings) for site `alias` now: an operator suppressed the site, or an
 * active maintenance event covers all of it.
 */
export function siteInsightsSuppressedSql(alias: string): string {
  return `(${siteInsightsOperatorSuppressedSql(alias)} OR ${siteUnderActiveMaintenanceSql(alias)})`;
}

/** SQL: the text[] of the sources suppressing station `alias` now (empty when in scope). */
export function stationInsightSuppressionSourcesSql(alias: string): string {
  return `array_remove(ARRAY[
    CASE WHEN ${stationInsightsOperatorSuppressedSql(alias)} THEN 'station' END,
    CASE WHEN ${stationSiteInsightsSuppressedSql(alias)} THEN 'site' END,
    CASE WHEN ${stationUnderActiveMaintenanceSql(alias)} THEN 'maintenance' END
  ]::text[], NULL)`;
}

/** SQL: the text[] of the sources suppressing site `alias` now (empty when in scope). */
export function siteInsightSuppressionSourcesSql(alias: string): string {
  return `array_remove(ARRAY[
    CASE WHEN ${siteInsightsOperatorSuppressedSql(alias)} THEN 'site' END,
    CASE WHEN ${siteUnderActiveMaintenanceSql(alias)} THEN 'maintenance' END
  ]::text[], NULL)`;
}
