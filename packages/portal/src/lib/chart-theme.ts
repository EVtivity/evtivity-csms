// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Centralized color constants for ApexCharts.
 * ApexCharts requires hex strings, not CSS variables.
 */

export function getGridColor(isDark: boolean): string {
  return isDark ? '#1e293b' : '#e2e8f0';
}

export const CHART_COLORS = {
  primary: '#2563eb',
} as const;
