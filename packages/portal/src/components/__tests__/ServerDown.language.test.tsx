// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// The API cannot be reached: every request fails like a network error.
const getMock = vi.hoisted(() => vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));

vi.mock('@/lib/version', () => ({ APP_VERSION: 'test' }));
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));
vi.mock('@/lib/auth', () => ({
  useAuth: (pick: (s: { retryConnection: () => void; isHydrating: boolean }) => unknown) =>
    pick({ retryConnection: vi.fn(), isHydrating: false }),
}));

function setBrowserLanguages(languages: string[]): void {
  Object.defineProperty(navigator, 'languages', { value: languages, configurable: true });
  Object.defineProperty(navigator, 'language', { value: languages[0], configurable: true });
}

// A fresh i18n module, as on a page load: it reads the stored and browser
// language at import, with no request to the API.
async function renderServerDown(): Promise<void> {
  vi.resetModules();
  const { i18nReady } = await import('@/i18n/index');
  await i18nReady;
  const { ServerDown } = await import('../ServerDown');
  render(<ServerDown />);
}

describe('ServerDown language', () => {
  beforeEach(() => {
    localStorage.clear();
    setBrowserLanguages(['en-US']);
  });
  afterEach(() => {
    cleanup();
    getMock.mockClear();
  });

  it('shows the stored driver language while the API is down', async () => {
    localStorage.setItem('portal_language', 'de');
    setBrowserLanguages(['es-ES']);
    await renderServerDown();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Verbindung nicht möglich');
    expect(document.documentElement.lang).toBe('de');
    expect(getMock).not.toHaveBeenCalled();
  });

  it('falls back to the browser language when none is stored', async () => {
    setBrowserLanguages(['fr-FR', 'ko-KR']);
    await renderServerDown();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('연결할 수 없음');
  });

  it('falls back to English for a browser language the portal does not have', async () => {
    setBrowserLanguages(['fr-FR']);
    await renderServerDown();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Unable to Connect');
  });
});
