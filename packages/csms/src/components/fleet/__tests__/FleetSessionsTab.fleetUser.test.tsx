// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const h = vi.hoisted(() => ({ get: vi.fn(), fleetUser: true, payments: false, erased: false }));

vi.mock('@/lib/auth', () => ({
  useIsFleetUser: () => h.fleetUser,
  useHasPermission: (p: string) => (p === 'payments:read' ? h.payments : true),
}));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => ({ api: { get: h.get } }));
vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (value: string) => value,
}));
vi.mock('@/hooks/use-charging-point-path', () => ({
  useChargingPointPath: () => (input: { siteName?: string | null; stationName?: string | null }) =>
    [input.siteName, input.stationName].filter((part) => part != null).join(' / '),
}));

import { FleetSessionsTab } from '../FleetSessionsTab';

const ROW = {
  id: 'ses_1',
  stationId: 'sta_1',
  stationName: 'CS-1',
  siteName: 'Depot',
  driverId: null,
  driverName: null,
  transactionId: null,
  status: 'completed',
  startedAt: '2026-01-01T10:00:00Z',
  endedAt: '2026-01-01T11:00:00Z',
  idleStartedAt: null,
  energyDeliveredWh: 12000,
  currentCostCents: null,
  finalCostCents: null,
  currency: 'USD',
  freeVend: null,
  co2AvoidedKg: null,
};

function renderTab(): void {
  h.get.mockImplementation((url: string) =>
    Promise.resolve(
      url.includes('/sessions/ses_1')
        ? {
            id: 'ses_1',
            status: 'completed',
            startedAt: ROW.startedAt,
            endedAt: ROW.endedAt,
            energyDeliveredWh: 12000,
            siteName: 'Depot',
            stationName: 'CS-1',
            driverName: null,
            driverErased: h.erased,
            cardLabel: 'Van 12',
          }
        : { data: [ROW], total: 1 },
    ),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/fleets/flt_1']}>
        <Routes>
          <Route path="/fleets/:id" element={<FleetSessionsTab fleetId="flt_1" />} />
          <Route path="/sessions/:id" element={<p>session page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  h.get.mockReset();
  h.fleetUser = true;
  h.payments = false;
  h.erased = false;
});

describe('FleetSessionsTab for a fleet user', () => {
  it('opens the reduced session view in a dialog, never the session page', async () => {
    renderTab();
    const row = await screen.findByTestId('session-row-ses_1');
    // The station is plain text: a fleet user has no station page.
    expect(within(row).queryByRole('link')).toBeNull();
    fireEvent.click(within(row).getByTestId('row-click-target'));
    const dialog = await screen.findByRole('dialog', { name: 'fleets.sessionDialog.title' });
    expect(await within(dialog).findByText('Van 12')).toBeTruthy();
    expect(within(dialog).getByText('Depot / CS-1')).toBeTruthy();
    // No cost row without payments:read (the API sends no currency).
    expect(within(dialog).queryByText('payments.cost')).toBeNull();
    expect(screen.queryByText('session page')).toBeNull();
    expect(h.get).toHaveBeenCalledWith('/v1/fleets/flt_1/sessions/ses_1');
  });

  it('shows an erased member as Erased Driver in the session view', async () => {
    h.erased = true;
    renderTab();
    const row = await screen.findByTestId('session-row-ses_1');
    fireEvent.click(within(row).getByTestId('row-click-target'));
    const dialog = await screen.findByRole('dialog', { name: 'fleets.sessionDialog.title' });
    expect(await within(dialog).findByText('drivers.erasedName')).toBeTruthy();
  });

  it('leaves out the driver, vehicle, guest, CO2 and, without payments:read, cost columns', async () => {
    renderTab();
    await screen.findByTestId('session-row-ses_1');
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
    for (const key of [
      'sessions.driverName',
      'vehicles.vehicle',
      'sessions.guestSession',
      'sessions.co2Avoided',
      'payments.cost',
    ]) {
      expect(headers).not.toContain(key);
    }
  });

  it('keeps the session page link for operators', async () => {
    h.fleetUser = false;
    renderTab();
    const row = await screen.findByTestId('session-row-ses_1');
    fireEvent.click(within(row).getByTestId('row-click-target'));
    expect(await screen.findByText('session page')).toBeTruthy();
  });
});
