// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const { getMock } = vi.hoisted(() => {
  // The auth store reads the color scheme when it loads.
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  return { getMock: vi.fn() };
});

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock } };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
vi.mock('@/hooks/use-event-stream', () => ({ useEventStream: () => undefined }));
vi.mock('@/components/ai/AiAssistantLauncher', () => ({ AiAssistantLauncher: () => null }));
vi.mock('@/components/layout/UserDropdown', () => ({ UserDropdown: () => null }));

import { Layout } from '../Layout';
import { NO_FLEETS_RECHECK_MS, NoFleetsPage } from '../NoFleetsPage';
import { useAuth } from '@/lib/auth';

function answer(path: string): Promise<unknown> {
  if (path === '/v1/portal/features') return Promise.resolve({ fleetEnabled: true });
  if (path === '/v1/portal/branding') return Promise.resolve({});
  return new Promise(() => {});
}

function renderAt(path: string): void {
  getMock.mockImplementation(answer);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<p>dashboard content</p>} />
            <Route path="fleets" element={<p>fleets content</p>} />
            <Route path="profile" element={<p>profile content</p>} />
            <Route path="settings" element={<p>settings content</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  getMock.mockReset();
  useAuth.setState({ accessScope: 'sites', permissions: [], fleetIds: [], isAuthenticated: false });
});

describe('fleet user without a fleet', () => {
  it('shows the No Fleets page in place of the fleet pages', async () => {
    useAuth.setState({ accessScope: 'fleets', permissions: ['fleets:read'], fleetIds: [] });
    renderAt('/fleets');
    expect(await screen.findByTestId('no-fleets-page')).toBeTruthy();
    expect(screen.getByText('noFleets.message')).toBeTruthy();
    expect(screen.queryByText('fleets content')).toBeNull();
  });

  it('keeps the profile and the API keys settings reachable', async () => {
    useAuth.setState({ accessScope: 'fleets', permissions: ['fleets:read'], fleetIds: [] });
    renderAt('/profile');
    expect(await screen.findByText('profile content')).toBeTruthy();
    cleanup();
    renderAt('/settings');
    expect(await screen.findByText('settings content')).toBeTruthy();
  });

  it('shows the pages of a fleet user with a fleet and of an operator', async () => {
    useAuth.setState({
      accessScope: 'fleets',
      permissions: ['fleets:read'],
      fleetIds: ['flt_aaaaaaaaaaaa'],
    });
    renderAt('/fleets');
    expect(await screen.findByText('fleets content')).toBeTruthy();
    cleanup();
    useAuth.setState({ accessScope: 'sites', permissions: ['dashboard:read'], fleetIds: [] });
    renderAt('/');
    expect(await screen.findByText('dashboard content')).toBeTruthy();
    expect(screen.queryByTestId('no-fleets-page')).toBeNull();
  });

  it('reads the fleets again while it is shown and shows the pages once one is assigned', async () => {
    vi.useFakeTimers();
    useAuth.setState({
      accessScope: 'fleets',
      permissions: ['fleets:read'],
      fleetIds: [],
      isAuthenticated: true,
    });
    getMock.mockResolvedValue({
      permissions: ['fleets:read'],
      hasAllSiteAccess: false,
      accessScope: 'fleets',
      fleetIds: ['flt_aaaaaaaaaaaa'],
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NoFleetsPage />
      </QueryClientProvider>,
    );
    await act(async () => {
      vi.advanceTimersByTime(NO_FLEETS_RECHECK_MS);
      await Promise.resolve();
    });
    expect(getMock).toHaveBeenCalledWith('/v1/users/me');
    expect(useAuth.getState().fleetIds).toEqual(['flt_aaaaaaaaaaaa']);
  });
});
