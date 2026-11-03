// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Centralized color constants for ApexCharts and SVG elements.
 * ApexCharts requires hex strings, not CSS variables.
 */

import { formatCalendarDate } from './formatting';

export function getGridColor(isDark: boolean): string {
  return isDark ? '#1e293b' : '#e2e8f0';
}

/** Format a YYYY-MM-DD calendar-date label for chart x-axes as a short day
 * and month in the UI language ("10/13" in English, "13.10." in German),
 * without a time zone shift (formatCalendarDate).
 *
 * ApexCharts' types promise a string but line charts convert date-like
 * categories to a numeric axis and call this with numbers or undefined;
 * a throw inside the formatter blanks the entire chart, so coerce. */
export function formatChartDateLabel(val: unknown): string {
  if (typeof val === 'number') return String(val);
  if (typeof val !== 'string') return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  return formatCalendarDate(val, { year: undefined, month: 'numeric', day: 'numeric' });
}

export const CHART_COLORS = {
  primary: '#2563eb',
  secondary: '#6366f1',
  accent: '#06b6d4',
  success: '#10b981',
  warning: '#f59e0b',
  destructive: '#ef4444',
  violet: '#8b5cf6',
  muted: '#6b7280',
} as const;

export const STATUS_COLORS: Record<string, string> = {
  available: '#3b82f6',
  occupied: '#3b82f6',
  charging: '#22c55e',
  discharging: '#22c55e',
  preparing: '#06b6d4',
  ev_connected: '#06b6d4',
  reserved: '#f97316',
  suspended_ev: '#f59e0b',
  suspended_evse: '#f59e0b',
  idle: '#f59e0b',
  finishing: '#8b5cf6',
  faulted: '#ef4444',
  unavailable: '#ef4444',
  removed: '#9ca3af',
};

/**
 * Status colors for small line icons on a card (the 2D charger card's port
 * pictograms and payment terminal mark): at least 3:1 against the card in
 * each theme (WCAG 2.2 SC 1.4.11). The light theme takes the 600 shade where
 * the 500 shade of `STATUS_COLORS` falls below 3:1 on white.
 */
export const STATUS_ICON_COLORS: Record<'light' | 'dark', Record<string, string>> = {
  light: {
    ...STATUS_COLORS,
    charging: '#16a34a',
    discharging: '#16a34a',
    preparing: '#0891b2',
    ev_connected: '#0891b2',
    reserved: '#ea580c',
    suspended_ev: '#d97706',
    suspended_evse: '#d97706',
    idle: '#d97706',
    removed: '#6b7280',
  },
  dark: { ...STATUS_COLORS },
};

/** The icon color of a connector status in a theme (an unknown status shows as unavailable). */
export function statusIconColor(status: string, dark: boolean): string {
  const map = STATUS_ICON_COLORS[dark ? 'dark' : 'light'];
  return map[status] ?? map['unavailable'] ?? '#ef4444';
}

export const PAYMENT_STATUS_COLORS: Record<string, string> = {
  pending: '#f59e0b',
  pre_authorized: '#3b82f6',
  captured: '#22c55e',
  partially_refunded: '#8b5cf6',
  refunded: '#6b7280',
  failed: '#dc2626',
  cancelled: '#9ca3af',
};

export const SVG_COLORS = {
  stationBody: '#1e293b',
  stationStroke: '#334155',
  stationPort: '#475569',
  connectorAmber: '#f59e0b',
} as const;
