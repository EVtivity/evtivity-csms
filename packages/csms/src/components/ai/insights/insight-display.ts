// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';
import {
  AlertOctagon,
  AlertTriangle,
  BellRing,
  FileText,
  Receipt,
  ShieldX,
  WifiOff,
  ZapOff,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { FixCode, InsightKind, InsightScopeCounts } from '@evtivity/lib/ai-insights';
import type { AiInsightView } from './insight-api';
import { isSummaryInsight } from './insight-api';

/**
 * How an insight reads in a list (dashboard card, insights list, detail
 * title): built from structured fields only (kind, record names, scope
 * counts, category, fix codes), never from model text.
 */

/** Lower is more severe. A site incident outranks everything it groups. */
export const INSIGHT_SEVERITY: Readonly<Record<InsightKind, number>> = {
  site_incident: 0,
  station_faulted: 1,
  station_offline: 2,
  session_failed: 3,
  station_alert: 4,
  authorization_refused: 5,
  tariff_anomaly: 6,
  site_summary: 7,
  company_summary: 8,
};

export type InsightTone = 'destructive' | 'warning' | 'info' | 'muted';

export const INSIGHT_ICONS: Readonly<Record<InsightKind, { icon: LucideIcon; tone: InsightTone }>> =
  {
    site_incident: { icon: AlertOctagon, tone: 'destructive' },
    station_faulted: { icon: AlertTriangle, tone: 'destructive' },
    station_offline: { icon: WifiOff, tone: 'warning' },
    session_failed: { icon: ZapOff, tone: 'warning' },
    station_alert: { icon: BellRing, tone: 'warning' },
    authorization_refused: { icon: ShieldX, tone: 'info' },
    tariff_anomaly: { icon: Receipt, tone: 'info' },
    site_summary: { icon: FileText, tone: 'muted' },
    company_summary: { icon: FileText, tone: 'muted' },
  };

/** Station detail tabs a suggested fix leads to (`?tab=`). */
const FIX_TABS: Readonly<Partial<Record<FixCode, string>>> = {
  reboot_station: 'commands',
  update_firmware: 'firmware-history',
  review_station_configuration: 'configurations',
  push_local_auth_list: 'local-auth',
  review_tariff_assignment: 'pricing',
};

/** The page a suggested fix is done on, when it maps to one (a station tab). */
export function fixPath(code: FixCode, insight: Pick<AiInsightView, 'stationId'>): string | null {
  const tab = FIX_TABS[code];
  if (tab == null || insight.stationId == null) return null;
  return `/stations/${encodeURIComponent(insight.stationId)}?tab=${tab}`;
}

/** The scope count that says how big an insight is, per kind (site scope). */
const SIZE_KEYS: Readonly<Partial<Record<InsightKind, readonly (keyof InsightScopeCounts)[]>>> = {
  station_offline: ['stationsOffline'],
  station_faulted: ['stationsFaulted', 'sameErrorCode'],
  station_alert: ['sameErrorCode'],
  session_failed: ['sessionsFailedSameReason24h', 'sessionsInterrupted'],
  authorization_refused: ['tokenRefusals'],
};

/**
 * The scope count worth showing next to the headline: only when it says more
 * than the insight itself (more than one station, session or refusal).
 */
export function insightSize(
  insight: Pick<AiInsightView, 'kind' | 'scope'>,
): { key: keyof InsightScopeCounts; count: number } | null {
  const counts = insight.scope.site;
  if (counts == null) return null;
  for (const key of SIZE_KEYS[insight.kind] ?? []) {
    const count = counts[key] ?? 0;
    if (count > 1) return { key, count };
  }
  return null;
}

/** A one-line headline: what happened, where and, for an incident, how many. */
export function insightHeadline(t: TFunction, insight: AiInsightView): string {
  const station = insight.stationName ?? t('aiInsights.headline.noStation');
  const site = insight.siteName ?? t('aiInsights.headline.noSite');
  if (insight.kind === 'site_incident') {
    const offline = insight.scope.site?.stationsOffline ?? 0;
    const faulted = insight.scope.site?.stationsFaulted ?? 0;
    if (offline >= faulted && offline > 0) {
      return t('aiInsights.headline.siteIncidentOffline', { count: offline, site });
    }
    if (faulted > 0) {
      return t('aiInsights.headline.siteIncidentFaulted', { count: faulted, site });
    }
  }
  return t(`aiInsights.headline.${insight.kind}`, { station, site });
}

/** Where an insight opens: its own detail page. */
export function insightPath(insight: Pick<AiInsightView, 'id'>): string {
  return `/ai/insights/${encodeURIComponent(insight.id)}`;
}

/** The category worth naming in a list (not for summaries, not `unknown`). */
export function shownCategory(insight: AiInsightView): AiInsightView['category'] {
  if (isSummaryInsight(insight) || insight.category === 'unknown') return null;
  return insight.category;
}

export interface InsightRow {
  /** The most severe, newest insight of the row. */
  insight: AiInsightView;
  /** How many insights the row stands for (1 unless collapsed). */
  count: number;
  /** The insight's page, or the insights list filtered to the collapsed group. */
  href: string;
}

function compareInsights(a: AiInsightView, b: AiInsightView): number {
  const severity = INSIGHT_SEVERITY[a.kind] - INSIGHT_SEVERITY[b.kind];
  if (severity !== 0) return severity;
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

/**
 * The dashboard rows: site incidents first, then by severity, then newest.
 * Insights of the same kind and category at one site collapse into one row with a
 * count that opens the insights list filtered to them. At most `max` rows.
 */
export function insightRows(insights: readonly AiInsightView[], max: number): InsightRow[] {
  const sorted = [...insights].sort(compareInsights);
  const groups = new Map<string, InsightRow>();
  const rows: InsightRow[] = [];
  for (const insight of sorted) {
    const category = shownCategory(insight);
    const collapsible =
      insight.kind !== 'site_incident' && insight.siteId != null && category != null;
    const key = collapsible ? `${insight.siteId ?? ''}|${insight.kind}|${category}` : null;
    const existing = key != null ? groups.get(key) : undefined;
    if (existing != null && key != null) {
      existing.count += 1;
      const params = new URLSearchParams({
        status: insight.status,
        kind: insight.kind,
        siteId: insight.siteId ?? '',
        category: category ?? '',
      });
      existing.href = `/ai/insights?${params.toString()}`;
      continue;
    }
    const row: InsightRow = { insight, count: 1, href: insightPath(insight) };
    if (key != null) groups.set(key, row);
    rows.push(row);
  }
  return rows.slice(0, max);
}
