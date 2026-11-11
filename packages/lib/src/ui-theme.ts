// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * UI themes: the look a CSMS user or a driver picks on the own account
 * (`users.ui_theme`, `drivers.ui_theme`). Each theme is a set of design tokens
 * with a light and a dark version (`ui-theme-tokens.ts`); the light or dark
 * choice is the separate Mode (`theme_preference`, `light` or `dark`).
 */
export const UI_THEMES = ['default', 'soft', 'high-contrast'] as const;

export type UiTheme = (typeof UI_THEMES)[number];

export const DEFAULT_UI_THEME: UiTheme = 'default';

/** Mode values stored in `theme_preference`. No System option (owner decision 2026-11-11). */
export const UI_MODES = ['light', 'dark'] as const;

export type UiMode = (typeof UI_MODES)[number];

export function isUiTheme(value: unknown): value is UiTheme {
  return typeof value === 'string' && (UI_THEMES as readonly string[]).includes(value);
}

/** A stored or sent value as a theme; anything unknown is the default theme. */
export function toUiTheme(value: unknown): UiTheme {
  return isUiTheme(value) ? value : DEFAULT_UI_THEME;
}

/**
 * Applies a theme and a mode to the document root: the `dark` class for the
 * mode, `data-theme` for a theme other than Default (Default has no attribute,
 * so its tokens are the plain `:root` and `.dark` ones). The pre-paint scripts
 * (`public/theme-init.js` in both apps) do the same before the bundle loads.
 */
export function applyUiThemeToRoot(root: HTMLElement, theme: UiTheme, mode: UiMode): void {
  root.classList.toggle('dark', mode === 'dark');
  if (theme === DEFAULT_UI_THEME) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}
