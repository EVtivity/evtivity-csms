// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const { getMock, features } = vi.hoisted(() => {
  // The auth store reads the color scheme when it loads.
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  return { getMock: vi.fn(), features: { fleetEnabled: false } };
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
import { FLEETS_OFF_RECHECK_MS, FleetsOffPage } from '../FleetsOffPage';
import { useAuth } from '@/lib/auth';

function answer(path: string): Promise<unknown> {
  if (path === '/v1/portal/features') return Promise.resolve({ ...features });
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
            <Route path="profile" element={<p>profile content</p>} />
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
  features.fleetEnabled = false;
  useAuth.setState({ accessScope: 'sites', permissions: [], fleetIds: [] });
});

describe('Fleets off for fleet users', () => {
  it('shows a fleet user the Fleets off page instead of any page', async () => {
    useAuth.setState({ accessScope: 'fleets', permissions: ['fleets:read'] });
    renderAt('/');
    expect(await screen.findByTestId('fleets-off-page')).toBeTruthy();
    expect(screen.getByText('fleetsOff.message')).toBeTruthy();
    expect(screen.queryByText('dashboard content')).toBeNull();
    // No menu entry: the nav is empty for a fleet user while Fleets is off.
    expect(screen.queryByRole('link', { name: 'nav.fleets' })).toBeNull();
  });

  it('keeps the profile of a fleet user reachable', async () => {
    useAuth.setState({ accessScope: 'fleets', permissions: ['fleets:read'] });
    renderAt('/profile');
    expect(await screen.findByText('profile content')).toBeTruthy();
  });

  it('shows the pages again once Fleets is on', async () => {
    useAuth.setState({
      accessScope: 'fleets',
      permissions: ['fleets:read'],
      fleetIds: ['flt_aaaaaaaaaaaa'],
    });
    features.fleetEnabled = true;
    renderAt('/');
    expect(await screen.findByText('dashboard content')).toBeTruthy();
    expect(screen.queryByTestId('fleets-off-page')).toBeNull();
  });

  it('leaves operators alone while Fleets is off', async () => {
    useAuth.setState({ accessScope: 'sites', permissions: ['dashboard:read'] });
    renderAt('/');
    expect(await screen.findByText('dashboard content')).toBeTruthy();
  });

  it('reads the feature flags again while it is shown', () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    render(
      <QueryClientProvider client={client}>
        <FleetsOffPage />
      </QueryClientProvider>,
    );
    act(() => {
      vi.advanceTimersByTime(FLEETS_OFF_RECHECK_MS);
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['settings', 'features'] });
  });
});
