// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The AI insights scope (`aiInsights.scope`, `@evtivity/lib/ai-insights`):
 * `all` analyzes every site and station; `selected` only the selected sites
 * (`sites.ai_insights_enabled`) and, inside them, the stations not turned off
 * (`charging_stations.ai_insights_enabled`). The predicates read the mode in
 * the same statement (one primary key lookup), so no producer needs it passed
 * in and a scope change applies to the next scan at once. A missing or
 * unknown stored mode reads as `all`. The insight scan, the generation and
 * translation jobs, the regenerate route, the AI workers, and the station and
 * site detail all decide with these.
 */

import { AI_INSIGHT_SCOPE_SETTING_KEY } from '@evtivity/lib/ai-insights';
import type { AiInsightScopeReason } from '@evtivity/lib/ai-insights';
import { client } from '../config.js';
import { operatorStationSql } from './conformance-stations.js';

/** SQL: the scope is `selected` (else every site and station is in scope). */
export function insightScopeSelectedSql(): string {
  return `(COALESCE((SELECT ais_scope.value #>> '{}' FROM settings ais_scope
    WHERE ais_scope.key = '${AI_INSIGHT_SCOPE_SETTING_KEY}'), 'all') = 'selected')`;
}

/** SQL: site `alias` is in the AI insights scope. */
export function siteInsightsInScopeSql(alias: string): string {
  return `(NOT ${insightScopeSelectedSql()} OR ${alias}.ai_insights_enabled)`;
}

/** SQL: the site of station `alias` is selected (false without a site). */
function stationSiteSelectedSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM sites aisc_site
    WHERE aisc_site.id = ${alias}.site_id AND aisc_site.ai_insights_enabled)`;
}

/**
 * SQL: station `alias` is in the AI insights scope: always while the scope is
 * `all`; with `selected`, its site is selected and the station is not turned off.
 */
export function stationInsightsInScopeSql(alias: string): string {
  return `(NOT ${insightScopeSelectedSql()} OR (${alias}.ai_insights_enabled AND ${stationSiteSelectedSql(alias)}))`;
}

/**
 * SQL: the scope reason of station `alias` (no `feature_off`, which the
 * caller adds from `isAiInsightsEnabled()`).
 */
export function stationInsightScopeReasonSql(alias: string): string {
  return `CASE
    WHEN NOT ${insightScopeSelectedSql()} THEN 'all_sites'
    WHEN ${alias}.site_id IS NULL THEN 'no_site'
    WHEN NOT ${stationSiteSelectedSql(alias)} THEN 'site_not_selected'
    WHEN NOT ${alias}.ai_insights_enabled THEN 'station_turned_off'
    ELSE 'selected' END`;
}

/** SQL: the scope reason of site `alias` (no `feature_off`). */
export function siteInsightScopeReasonSql(alias: string): string {
  return `CASE
    WHEN NOT ${insightScopeSelectedSql()} THEN 'all_sites'
    WHEN NOT ${alias}.ai_insights_enabled THEN 'site_not_selected'
    ELSE 'selected' END`;
}

/**
 * Whether new insights may be made about a subject now: its station when it
 * has one, else its site; a subject with neither (a company summary) is
 * always in scope, and so is a station or site that no longer exists (its
 * insights cascade away with it).
 */
export async function insightSubjectInScope(subject: {
  siteId: string | null;
  stationId: string | null;
}): Promise<boolean> {
  if (subject.stationId != null) {
    const [row] = await client<{ in_scope: boolean }[]>`
      SELECT ${client.unsafe(stationInsightsInScopeSql('cs'))} AS in_scope
      FROM charging_stations cs WHERE cs.id = ${subject.stationId}
    `;
    if (row != null) return row.in_scope;
  }
  if (subject.siteId == null) return true;
  return siteInsightsInScope(subject.siteId);
}

/** Whether site `siteId` is in the AI insights scope (true for an unknown site). */
export async function siteInsightsInScope(siteId: string): Promise<boolean> {
  const [row] = await client<{ in_scope: boolean }[]>`
    SELECT ${client.unsafe(siteInsightsInScopeSql('s'))} AS in_scope FROM sites s WHERE s.id = ${siteId}
  `;
  return row?.in_scope ?? true;
}

/** The station ids of `stationIds` that are in the AI insights scope (operator stations only). */
export async function stationIdsInInsightScope(
  stationIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(stationIds)];
  if (ids.length === 0) return new Set();
  const rows = await client<{ id: string }[]>`
    SELECT cs.id FROM charging_stations cs
    WHERE cs.id = ANY(${ids}::text[]) AND ${client.unsafe(operatorStationSql('cs'))}
      AND ${client.unsafe(stationInsightsInScopeSql('cs'))}
  `;
  return new Set(rows.map((r) => r.id));
}

export type { AiInsightScopeReason };
