// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const h = vi.hoisted(() => {
  // jsdom has no matchMedia; the theme store reads it on import.
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList;
  return {
    perms: ['fleets:read', 'settings.apiKeys:read', 'settings.apiKeys:write'] as string[],
    get: vi.fn(),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: h.get } };
});

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    useAuth: (select: (s: { permissions: string[] }) => unknown) =>
      select({ permissions: h.perms }),
    useHasAllSiteAccess: () => false,
    useIsFleetUser: () => true,
  };
});

vi.mock('@/hooks/use-qr-icon', () => ({ useQrIcon: () => ({ svgDataUri: undefined }) }));
vi.mock('@/components/SystemInfoDialog', () => ({ SystemInfoDialog: () => null }));
vi.mock('@/components/settings/ApiKeysSettings', () => ({
  ApiKeysSettings: () => <div data-testid="api-keys-panel" />,
}));

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

import { Settings } from '../Settings';

afterEach(() => {
  cleanup();
  h.get.mockReset();
  h.perms = ['fleets:read', 'settings.apiKeys:read', 'settings.apiKeys:write'];
});

function renderAt(url: string): void {
  h.get.mockResolvedValue({});
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/settings" element={<Settings />} />
          <Route path="/fleets" element={<div data-testid="fleets-page" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Settings for a fleet user', () => {
  it('shows the API Keys tab only, and no System Information', () => {
    renderAt('/settings');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['settings.apiKeys']);
    expect(screen.getByTestId('api-keys-panel')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'systemInfo.button' })).toBeNull();
    // The company settings are closed to a fleet user: the page never asks for them.
    expect(h.get).not.toHaveBeenCalledWith('/v1/settings');
  });

  it('opens the API Keys tab for a link to another tab', () => {
    renderAt('/settings?tab=company');
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.getByTestId('api-keys-panel')).toBeTruthy();
  });

  it('sends a fleet user without the API key permission to its fleets', () => {
    h.perms = ['fleets:read'];
    renderAt('/settings');
    expect(screen.getByTestId('fleets-page')).toBeTruthy();
  });
});
