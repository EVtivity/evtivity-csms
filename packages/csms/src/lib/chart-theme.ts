// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Centralized color constants for ApexCharts and SVG elements.
 * ApexCharts requires hex strings, not CSS variables.
 */

export function getGridColor(isDark: boolean): string {
  return isDark ? '#1e293b' : '#e2e8f0';
}

/** Format a YYYY-MM-DD calendar-date label as "M/D" for chart x-axes.
 * Parses by splitting the string rather than `new Date(val)` because
 * `new Date("2024-03-12")` parses as UTC midnight and would shift the
 * label by one day for browsers west of UTC. */
export function formatChartDateLabel(val: string): string {
  const parts = val.split('-');
  if (parts.length !== 3) return val;
  return `${String(Number(parts[1]))}/${String(Number(parts[2]))}`;
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
  chargingPulse: '#3b82f6',
  connectorAmber: '#f59e0b',
} as const;
