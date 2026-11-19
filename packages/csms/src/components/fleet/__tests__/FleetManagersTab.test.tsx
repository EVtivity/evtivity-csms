// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const h = vi.hoisted(() => ({ getMock: vi.fn(), canWrite: true }));

vi.mock('@/lib/auth', () => ({
  useHasPermission: (p: string) => p !== 'users:write' || h.canWrite,
}));
vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (value: string) => `at ${value}`,
}));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => ({ api: { get: h.getMock } }));

import { FleetManagersTab, fleetManagerCreatePath } from '../FleetManagersTab';

function Where(): React.JSX.Element {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

function renderTab(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/fleets/flt_1']}>
        <Routes>
          <Route path="/fleets/:id" element={<FleetManagersTab fleetId="flt_1" />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  h.getMock.mockReset();
  h.canWrite = true;
});

describe('FleetManagersTab', () => {
  it('lists the fleet users with their email and last sign-in, without a permissions column', async () => {
    h.getMock.mockResolvedValue({
      data: [
        {
          id: 'usr_1',
          firstName: 'Fleet',
          lastName: 'Lead',
          email: 'lead@example.com',
          isActive: true,
          lastLoginAt: '2026-11-01T10:00:00.000Z',
          permissions: ['fleetCards:write', 'fleets:read'],
        },
        {
          id: 'usr_2',
          firstName: null,
          lastName: null,
          email: 'new@example.com',
          isActive: false,
          lastLoginAt: null,
          permissions: [],
        },
      ],
      total: 2,
    });
    renderTab();
    expect(await screen.findByText('Fleet Lead')).toBeTruthy();
    expect(h.getMock).toHaveBeenCalledWith('/v1/fleets/flt_1/managers?page=1&limit=10');
    expect(screen.getByText('lead@example.com')).toBeTruthy();
    expect(screen.getByText('at 2026-11-01T10:00:00.000Z')).toBeTruthy();
    expect(screen.getByText('fleets.managers.neverSignedIn')).toBeTruthy();
    expect(screen.getByText('common.unnamedUser')).toBeTruthy();
    expect(screen.getByText('common.inactive')).toBeTruthy();
    expect(screen.queryByText('fleets.managers.permissions')).toBeNull();
    expect(screen.queryByText(/users\.permissionGroups/)).toBeNull();

    fireEvent.click(screen.getByTestId('fleet-manager-row-usr_1'));
    expect(screen.getByTestId('where').textContent).toBe('/users/usr_1');
  });

  it('opens New User with the Fleet Manager role and the fleet', async () => {
    h.getMock.mockResolvedValue({ data: [], total: 0 });
    renderTab();
    expect(await screen.findByText('fleets.managers.empty')).toBeTruthy();
    fireEvent.click(screen.getByTestId('fleet-manager-add'));
    expect(screen.getByTestId('where').textContent).toBe(fleetManagerCreatePath('flt_1'));
    expect(fleetManagerCreatePath('flt_1')).toBe('/users/new?role=fleet_manager&fleetId=flt_1');
  });

  it('hides Add Fleet Manager without users:write', async () => {
    h.canWrite = false;
    h.getMock.mockResolvedValue({ data: [], total: 0 });
    renderTab();
    await screen.findByText('fleets.managers.empty');
    expect(screen.queryByTestId('fleet-manager-add')).toBeNull();
  });
});
