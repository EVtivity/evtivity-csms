// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Shared formatting utilities for the CSMS frontend.
 * All display formatting functions used across multiple pages and components.
 */

/**
 * Format cents to a localized currency string using Intl.NumberFormat.
 * Returns '--' for null/undefined values.
 */
export function formatCents(cents: number | null | undefined, currency = 'USD'): string {
  if (cents == null) return '--';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(cents / 100);
}

/**
 * Format a duration between two timestamps as "Xh Ym" or "Xm".
 * Uses Date.now() when end is null (ongoing session).
 * Returns '--' when start is null.
 */
export function formatDuration(start: string | null, end: string | null): string {
  if (start == null) return '--';
  const startMs = new Date(start).getTime();
  const endMs = end != null ? new Date(end).getTime() : Date.now();
  const totalMinutes = Math.round((endMs - startMs) / 60000);
  if (totalMinutes < 60) return `${String(totalMinutes)}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours)}h ${String(minutes)}m`;
}

/**
 * Format a duration in minutes as "Xh Ym", "Xh", or "Xm".
 * Omits the minutes portion when it is zero.
 */
export function formatDurationMinutes(minutes: number): string {
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${String(h)}h ${String(m)}m` : `${String(h)}h`;
  }
  return `${String(minutes)}m`;
}

/**
 * Format CO2 weight in kg. Converts to tonnes when >= 1000 kg.
 */
export function formatCo2(kg: number): string {
  if (kg >= 1000) return `${(kg / 1000).toFixed(1)} t`;
  return `${kg.toFixed(1)} kg`;
}

/**
 * Format energy in Wh. Converts to kWh or MWh based on magnitude.
 * Shows Wh for values under 1000, kWh up to 100 MWh, MWh above.
 */
export function formatEnergy(wh: number): string {
  if (wh >= 100_000_000) return `${(wh / 1_000_000).toFixed(1)} MWh`;
  if (wh >= 1_000) return `${(wh / 1_000).toFixed(1)} kWh`;
  return `${String(Math.round(wh))} Wh`;
}

/**
 * Format file size in bytes to a human-readable string (B, KB, or MB).
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
