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
 * hide charts, and pick the site of a widget that shows one site (the API
 * drops a site the user may no longer access).
 */

export interface DashboardWidget {
  id: string;
  /** Hidden until the user shows it. */
  defaultHidden: boolean;
  /** Half width (one column from lg) or the full row. */
  span: 'half' | 'full';
  /** The widget shows one site the user picks (`siteId` on its layout item). */
  siteOption?: boolean;
  /**
   * Where the widget enters a layout saved before it existed: right before
   * this widget (when the layout has it). Without it, the widget is appended.
   */
  enterBefore?: string;
}

export interface DashboardLayoutItem {
  id: string;
  hidden: boolean;
  /**
   * The site a `siteOption` widget shows; null or left out for the default
   * site (the first site the user may access that has stations).
   */
  siteId?: string | null;
}

export interface DashboardLayout {
  version: 1;
  charts: DashboardLayoutItem[];
}

/**
 * Every chart of the Live dashboard, in the default order (the order the
 * dashboard had before layouts existed). The four last charts are new and
 * hidden by default. The 3D site layout (v0.1.49) stands above the map.
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
  {
    id: 'chart.siteLayout3d',
    defaultHidden: false,
    span: 'full',
    siteOption: true,
    enterBefore: 'chart.stationMap',
  },
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
/** The longest site id a layout item may hold. */
export const DASHBOARD_SITE_ID_MAX_LENGTH = 64;

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
 * `DASHBOARD_LAYOUT_MAX_ITEMS` items, and a `siteId` (a non-empty string of
 * at most `DASHBOARD_SITE_ID_MAX_LENGTH` characters, or null) only on a
 * widget with `siteOption`. Other keys (such as the `cards` an earlier
 * client sent) are ignored. A valid layout may leave charts out:
 * `resolveDashboardLayout` puts them back. Whether the user may access the
 * site is checked by the API, which knows the user.
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
    const siteId = item['siteId'];
    if (siteId === undefined || siteId === null) continue;
    if (WIDGETS_BY_ID.get(id)?.siteOption !== true) return `chart ${id} takes no siteId`;
    if (typeof siteId !== 'string' || siteId === '') return 'siteId must be a string or null';
    if (siteId.length > DASHBOARD_SITE_ID_MAX_LENGTH) {
      return `siteId is longer than ${String(DASHBOARD_SITE_ID_MAX_LENGTH)} characters`;
    }
  }
  return null;
}

/** The site of a stored item, kept only for a `siteOption` widget and a valid id. */
function storedSiteId(widget: DashboardWidget, value: unknown): string | null | undefined {
  if (widget.siteOption !== true) return undefined;
  return typeof value === 'string' && value !== '' && value.length <= DASHBOARD_SITE_ID_MAX_LENGTH
    ? value
    : undefined;
}

/**
 * The layout to render from a stored one: null or an invalid shape gives
 * the default; unknown ids (stat card ids of an earlier layout included)
 * and repeats are dropped, and so is anything but `charts`; charts the
 * stored layout lacks (added after it was saved) get their default
 * visibility and are appended in registry order, except a chart with
 * `enterBefore`, which goes right before that chart when the layout has it
 * (the 3D site layout enters above the map, wherever the user moved it).
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
      const widget = WIDGETS_BY_ID.get(id);
      if (widget == null || seen.has(id)) continue;
      seen.add(id);
      const siteId = storedSiteId(widget, item['siteId']);
      charts.push(
        siteId === undefined
          ? { id, hidden: item['hidden'] === true }
          : { id, hidden: item['hidden'] === true, siteId },
      );
    }
  }
  for (const widget of DASHBOARD_WIDGETS) {
    if (seen.has(widget.id)) continue;
    seen.add(widget.id);
    const missing = { id: widget.id, hidden: widget.defaultHidden };
    const before =
      widget.enterBefore == null ? -1 : charts.findIndex((c) => c.id === widget.enterBefore);
    if (before === -1) charts.push(missing);
    else charts.splice(before, 0, missing);
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
