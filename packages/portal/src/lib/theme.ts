// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { toUiTheme, type UiTheme } from '@evtivity/lib/ui-theme';

export type { UiTheme } from '@evtivity/lib/ui-theme';

/** The Mode (light or dark), stored as `drivers.theme_preference`. */
export type Theme = 'light' | 'dark';

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
 * Stores and applies the driver's theme. `public/theme-init.js` reads the
 * same localStorage key (`portal_ui_theme`) before the first paint.
 */
export function adoptUiTheme(uiTheme: unknown): UiTheme {
  const theme = toUiTheme(uiTheme);
  localStorage.setItem('portal_ui_theme', theme);
  applyUiTheme(theme);
  return theme;
}

/** The theme stored in this browser, Default when none or unknown. */
export function storedUiTheme(): UiTheme {
  return toUiTheme(localStorage.getItem('portal_ui_theme'));
}
