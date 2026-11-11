// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { toUiTheme, type UiTheme } from '@evtivity/lib/ui-theme';

export type { UiTheme } from '@evtivity/lib/ui-theme';

/** The Mode (light or dark), stored as `users.theme_preference`. */
export type Theme = 'light' | 'dark';

/** i18n key of each theme's name (`profile.uiTheme<Suffix>`), for Profile > Appearance and the user menu. */
export const UI_THEME_LABEL_KEY: Record<
  UiTheme,
  'profile.uiThemeDefault' | 'profile.uiThemeSoft' | 'profile.uiThemeHighContrast'
> = {
  default: 'profile.uiThemeDefault',
  soft: 'profile.uiThemeSoft',
  'high-contrast': 'profile.uiThemeHighContrast',
};

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

/** The theme (Default, Soft, High Contrast): `data-theme` on the root, none for Default. */
export function applyUiTheme(theme: UiTheme): void {
  const root = document.documentElement;
  if (theme === 'default') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

/**
 * Stores and applies the account's theme. `public/theme-init.js` reads the
 * same localStorage key (`ui_theme`, with `theme` for the mode) before the first paint.
 */
export function adoptUiTheme(uiTheme: unknown): UiTheme {
  const theme = toUiTheme(uiTheme);
  localStorage.setItem('ui_theme', theme);
  applyUiTheme(theme);
  return theme;
}

/**
 * Resolve the mode to use on app startup. Uses the persisted localStorage
 * preference when present; on first visit falls back to the OS-level
 * prefers-color-scheme so users with system dark mode aren't forced into
 * light mode the first time they load the app (frontend/ui.md).
 */
export function resolveInitialTheme(): Theme {
  const stored = localStorage.getItem('theme');
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** The theme stored in this browser, Default when none or unknown. */
export function resolveInitialUiTheme(): UiTheme {
  return toUiTheme(localStorage.getItem('ui_theme'));
}
