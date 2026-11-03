// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** The brand color the CSMS uses when company.themeColor is empty or not a hex color. */
export const DEFAULT_THEME_COLOR = '#2563eb';

/** Front plate colors of the chargers in the 3D site layout, one per charging kind. */
export const CHARGER_PLATE_COLOR_KEYS = [
  'company.chargerColorAc',
  'company.chargerColorDc',
] as const;

export type ChargerPlateColorKey = (typeof CHARGER_PLATE_COLOR_KEYS)[number];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function isChargerPlateColorKey(key: string): key is ChargerPlateColorKey {
  return (CHARGER_PLATE_COLOR_KEYS as readonly string[]).includes(key);
}

/** Whether the value is a `#rrggbb` hex color. */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

/**
 * The stored form of a plate color: '' (use the brand color) or a lowercase
 * `#rrggbb`. Null when the value is neither.
 */
export function normalizeChargerPlateColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  return isHexColor(trimmed) ? trimmed.toLowerCase() : null;
}

/** The brand color: company.themeColor when it is a hex color, else the default. */
export function resolveBrandColor(themeColor: unknown): string {
  const color = typeof themeColor === 'string' ? themeColor.trim() : '';
  return isHexColor(color) ? color.toLowerCase() : DEFAULT_THEME_COLOR;
}

/** The plate color to paint: the stored one, else the brand color. */
export function resolveChargerPlateColor(stored: unknown, themeColor: unknown): string {
  const color = normalizeChargerPlateColor(stored);
  return color != null && color !== '' ? color : resolveBrandColor(themeColor);
}
