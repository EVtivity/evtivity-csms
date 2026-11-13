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

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    console.warn('Could not read the saved appearance, using the defaults', err);
    return null;
  }
}

/**
 * The mode on startup, before any server reply, the rule of
 * `public/theme-init.js`: the stored mode, else the system color scheme. So a
 * page shown while the API is down (Unable to Connect) keeps the driver's mode.
 */
export function resolveInitialTheme(): Theme {
  const stored = readStored('portal_theme');
  if (stored === 'dark' || stored === 'light') return stored;
  // A browser without matchMedia (and jsdom) has no system scheme: light.
  if (typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** The theme stored in this browser, Default when none or unknown. */
export function storedUiTheme(): UiTheme {
  return toUiTheme(readStored('portal_ui_theme'));
}

/** Applies the stored (or system) mode and theme at startup, before any server reply. */
export function applyStartupAppearance(): void {
  applyTheme(resolveInitialTheme());
  applyUiTheme(storedUiTheme());
}
