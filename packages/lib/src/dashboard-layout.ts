// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Dashboard layout: the charts of the Live dashboard and the rules of a
 * layout a user saves (chart order and visibility). Browser-safe: the API
 * validates and resolves a saved layout with it, and the CSMS renders from
 * the same registry (`@evtivity/lib/dashboard-layout`).
 *
 * Only the charts are customizable. The stat cards above them keep their
 * fixed order and are never hidden, so they are not in the registry; a
 * stored layout that still lists stat cards (`cards`) is cleaned on read.
 * Whether a user may see a chart (permissions, all-site access) is decided
 * where it renders, never by the layout: a saved layout can only order and
 * hide charts.
 */

export interface DashboardWidget {
  id: string;
  /** Hidden until the user shows it. */
  defaultHidden: boolean;
  /** Half width (one column from lg) or the full row. */
  span: 'half' | 'full';
}

export interface DashboardLayoutItem {
  id: string;
  hidden: boolean;
}

export interface DashboardLayout {
  version: 1;
  charts: DashboardLayoutItem[];
}

/**
 * Every chart of the Live dashboard, in the default order (the order the
 * dashboard had before layouts existed). The four last charts are new and
 * hidden by default.
 */
export const DASHBOARD_WIDGETS: readonly DashboardWidget[] = [
  { id: 'chart.aiInsights', defaultHidden: false, span: 'full' },
  { id: 'chart.stationStatus', defaultHidden: false, span: 'half' },
  { id: 'chart.utilization', defaultHidden: false, span: 'half' },
  { id: 'chart.energy', defaultHidden: false, span: 'half' },
  { id: 'chart.sessions', defaultHidden: false, span: 'half' },
  { id: 'chart.revenue', defaultHidden: false, span: 'half' },
  { id: 'chart.paymentBreakdown', defaultHidden: false, span: 'half' },
  { id: 'chart.peakUsage', defaultHidden: false, span: 'full' },
  { id: 'chart.activeSessions', defaultHidden: false, span: 'full' },
  { id: 'chart.stationMap', defaultHidden: false, span: 'full' },
  { id: 'chart.locationsByCity', defaultHidden: true, span: 'half' },
  { id: 'chart.evsesByConnectorType', defaultHidden: true, span: 'half' },
  { id: 'chart.plugAndCharge', defaultHidden: true, span: 'half' },
  { id: 'chart.freeVend', defaultHidden: true, span: 'half' },
];

/** The most items a saved layout may hold. */
export const DASHBOARD_LAYOUT_MAX_ITEMS = 100;
/** The longest widget id a saved layout may hold. */
export const DASHBOARD_WIDGET_ID_MAX_LENGTH = 64;

const WIDGETS_BY_ID = new Map(DASHBOARD_WIDGETS.map((w) => [w.id, w]));

export function dashboardWidget(id: string): DashboardWidget | undefined {
  return WIDGETS_BY_ID.get(id);
}

export function defaultDashboardLayout(): DashboardLayout {
  return {
    version: 1,
    charts: DASHBOARD_WIDGETS.map((w) => ({ id: w.id, hidden: w.defaultHidden })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Why a layout sent by a client is refused, or null when it is valid:
 * the shape, version 1, known chart ids, no id twice, at most
 * `DASHBOARD_LAYOUT_MAX_ITEMS` items. Other keys (such as the `cards` an
 * earlier client sent) are ignored. A valid layout may leave charts out:
 * `resolveDashboardLayout` appends them.
 */
export function dashboardLayoutProblem(input: unknown): string | null {
  if (!isRecord(input)) return 'layout must be an object';
  if (input['version'] !== 1) return 'layout version must be 1';
  const items = input['charts'];
  if (!Array.isArray(items)) return 'charts must be an array';
  if (items.length > DASHBOARD_LAYOUT_MAX_ITEMS) {
    return `charts holds more than ${String(DASHBOARD_LAYOUT_MAX_ITEMS)} items`;
  }
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRecord(item) || typeof item['id'] !== 'string' || typeof item['hidden'] !== 'boolean') {
      return 'charts items must be { id, hidden }';
    }
    const id = item['id'];
    if (!WIDGETS_BY_ID.has(id)) {
      return `unknown chart id: ${id.slice(0, DASHBOARD_WIDGET_ID_MAX_LENGTH)}`;
    }
    if (seen.has(id)) return `duplicate chart id: ${id}`;
    seen.add(id);
  }
  return null;
}

/**
 * The layout to render from a stored one: null or an invalid shape gives
 * the default; unknown ids (stat card ids of an earlier layout included)
 * and repeats are dropped, and so is anything but `charts`; charts the
 * stored layout lacks (added after it was saved) are appended in registry
 * order with their default visibility.
 */
export function resolveDashboardLayout(saved: unknown): DashboardLayout {
  if (!isRecord(saved) || saved['version'] !== 1) return defaultDashboardLayout();
  const seen = new Set<string>();
  const charts: DashboardLayoutItem[] = [];
  const raw = saved['charts'];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item) || typeof item['id'] !== 'string') continue;
      const id = item['id'];
      if (!WIDGETS_BY_ID.has(id) || seen.has(id)) continue;
      seen.add(id);
      charts.push({ id, hidden: item['hidden'] === true });
    }
  }
  for (const widget of DASHBOARD_WIDGETS) {
    if (seen.has(widget.id)) continue;
    seen.add(widget.id);
    charts.push({ id: widget.id, hidden: widget.defaultHidden });
  }
  return { version: 1, charts };
}

/** True when the layout equals the default (order and visibility). */
export function isDefaultDashboardLayout(layout: DashboardLayout): boolean {
  const def = defaultDashboardLayout().charts;
  return (
    layout.charts.length === def.length &&
    layout.charts.every((item, i) => item.id === def[i]?.id && item.hidden === def[i].hidden)
  );
}
