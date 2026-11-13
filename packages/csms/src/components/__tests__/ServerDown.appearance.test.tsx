// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// The API cannot be reached: every request fails like a network error.
const getMock = vi.hoisted(() => vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
vi.mock('@/lib/version', () => ({ APP_VERSION: 'test' }));
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));
vi.mock('@/lib/auth', () => ({
  useAuth: (pick: (s: { retryConnection: () => void; isHydrating: boolean }) => unknown) =>
    pick({ retryConnection: vi.fn(), isHydrating: false }),
}));

import { applyStartupAppearance } from '@/lib/theme';
import { ServerDown } from '../ServerDown';

// The committed pre-paint script, run as the browser runs it (no input reaches it).
const themeInit = Object.values(
  import.meta.glob<string>('../../../public/theme-init.js', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
)[0];

function setSystemDark(dark: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: dark && query.includes('dark'), media: query }),
  });
}

// A page load with the API down: the pre-paint script, then the bundle's
// startup step, then the Unable to Connect page.
function loadServerDown(): void {
  if (themeInit == null) throw new Error('public/theme-init.js not found');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the committed file only
  const runThemeInit = new Function(themeInit) as () => void;
  runThemeInit();
  applyStartupAppearance();
  render(<ServerDown />);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('errors.serverDown');
}

const root = document.documentElement;

describe('ServerDown appearance', () => {
  beforeEach(() => {
    localStorage.clear();
    root.classList.remove('dark');
    root.removeAttribute('data-theme');
    setSystemDark(false);
  });
  afterEach(() => {
    cleanup();
  });

  it('shows the stored dark mode and High Contrast theme while the API is down', () => {
    localStorage.setItem('theme', 'dark');
    localStorage.setItem('ui_theme', 'high-contrast');
    loadServerDown();
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.getAttribute('data-theme')).toBe('high-contrast');
    expect(getMock).not.toHaveBeenCalled();
  });

  it('follows the system color scheme and Default when nothing is stored', () => {
    setSystemDark(true);
    loadServerDown();
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('keeps a stored light mode over a dark system scheme', () => {
    setSystemDark(true);
    localStorage.setItem('theme', 'light');
    localStorage.setItem('ui_theme', 'soft');
    loadServerDown();
    expect(root.classList.contains('dark')).toBe(false);
    expect(root.getAttribute('data-theme')).toBe('soft');
  });
});
