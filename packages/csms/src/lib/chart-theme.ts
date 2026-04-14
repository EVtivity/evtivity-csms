// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Centralized color constants for ApexCharts and SVG elements.
 * ApexCharts requires hex strings, not CSS variables.
 */

export function getGridColor(isDark: boolean): string {
  return isDark ? '#1e293b' : '#e2e8f0';
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
  available: '#22c55e',
  occupied: '#3b82f6',
  reserved: '#f97316',
  faulted: '#ef4444',
  unavailable: '#6b7280',
  removed: '#9ca3af',
  // OCPP 1.6 connector statuses
  charging: '#3b82f6',
  preparing: '#06b6d4',
  ev_connected: '#06b6d4',
  suspended_ev: '#f59e0b',
  suspended_evse: '#f59e0b',
  finishing: '#8b5cf6',
  idle: '#f59e0b',
  discharging: '#8b5cf6',
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
