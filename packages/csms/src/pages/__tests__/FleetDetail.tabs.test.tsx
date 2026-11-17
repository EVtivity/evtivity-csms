// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const h = vi.hoisted(() => ({
  fleetUser: false,
  allSites: true,
  permissions: new Set<string>(),
  billingProps: [] as { readOnly?: boolean }[],
}));

vi.mock('@/lib/auth', () => ({
  useIsFleetUser: () => h.fleetUser,
  useHasAllSiteAccess: () => h.allSites,
  useHasPermission: (p: string) =>
    h.permissions.has(p) ||
    (p.endsWith(':read') && h.permissions.has(p.replace(':read', ':write'))),
}));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: () =>
      Promise.resolve({
        id: 'flt_1',
        name: 'Acme Vans',
        description: null,
        accountBillingEnabled: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
  },
}));
vi.mock('@/components/entity-nav-buttons', () => ({ EntityNavButtons: () => null }));
vi.mock('@/components/EntityHistoryTab', () => ({ EntityHistoryTab: () => null }));
vi.mock('@/components/fleet/FleetDetailsTab', () => ({ FleetDetailsTab: () => null }));
vi.mock('@/components/fleet/FleetSessionsTab', () => ({ FleetSessionsTab: () => null }));
vi.mock('@/components/fleet/FleetStationsTab', () => ({ FleetStationsTab: () => null }));
vi.mock('@/components/fleet/FleetVehiclesTab', () => ({ FleetVehiclesTab: () => null }));
vi.mock('@/components/fleet/FleetDeparturesTab', () => ({ FleetDeparturesTab: () => null }));
vi.mock('@/components/fleet/FleetDriversTab', () => ({ FleetDriversTab: () => null }));
vi.mock('@/components/fleet/FleetPricingTab', () => ({ FleetPricingTab: () => null }));
vi.mock('@/components/fleet/FleetReservationsTab', () => ({ FleetReservationsTab: () => null }));
vi.mock('@/components/fleet/FleetCardsTab', () => ({ FleetCardsTab: () => null }));
vi.mock('@/components/fleet/FleetManagersTab', () => ({ FleetManagersTab: () => null }));
vi.mock('@/components/fleet/FleetBillingTab', () => ({
  FleetBillingTab: (props: { readOnly?: boolean }) => {
    h.billingProps.push(props);
    return null;
  },
}));
vi.mock('@/components/fleet/FleetBillingProfileCard', () => ({
  FleetBillingProfileCard: () => <p>billing profile card</p>,
}));
vi.mock('@/components/fleet/FleetCreditLimitCard', () => ({ FleetCreditLimitCard: () => null }));
vi.mock('@/components/fleet/FleetInvoicesCard', () => ({ FleetInvoicesCard: () => null }));

import { FleetDetail } from '../FleetDetail';

function renderPage(tab = 'details'): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/fleets/flt_1?tab=${tab}`]}>
        <Routes>
          <Route path="/fleets/:id" element={<FleetDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function tabNames(): Promise<string[]> {
  await screen.findByText('Acme Vans');
  return screen.getAllByRole('tab').map((tab) => tab.textContent);
}

afterEach(() => {
  cleanup();
  h.fleetUser = false;
  h.allSites = true;
  h.permissions = new Set();
  h.billingProps.length = 0;
});

describe('FleetDetail tabs', () => {
  it('shows a fleet user only Details, Sessions, Vehicles, Members, Billing and RFID Cards', async () => {
    h.fleetUser = true;
    h.allSites = false;
    h.permissions = new Set([
      'fleets:read',
      'sessions:read',
      'payments:read',
      'fleetCards:write',
      'audit:read',
      'reservations:read',
    ]);
    renderPage();
    expect(await tabNames()).toEqual([
      'common.details',
      'sessions.title',
      'fleets.vehicles',
      'fleets.drivers',
      'fleets.billingTab',
      'fleets.cards.title',
    ]);
  });

  it('shows a fleet user no Billing tab without payments:read and no Cards tab without fleetCards:read', async () => {
    h.fleetUser = true;
    h.allSites = false;
    h.permissions = new Set(['fleets:read', 'sessions:read']);
    renderPage();
    const names = await tabNames();
    expect(names).not.toContain('fleets.billingTab');
    expect(names).not.toContain('fleets.cards.title');
  });

  it('shows a fleet user a read-only Billing tab without the billing profile card', async () => {
    h.fleetUser = true;
    h.allSites = false;
    h.permissions = new Set(['fleets:read', 'payments:read']);
    renderPage('billing');
    await screen.findByText('Acme Vans');
    expect(h.billingProps.at(-1)?.readOnly).toBe(true);
    expect(screen.queryByText('billing profile card')).toBeNull();
  });

  it('keeps every operator tab and adds RFID Cards with fleetCards:read', async () => {
    h.permissions = new Set(['fleets:write', 'fleetCards:read', 'audit:read', 'reservations:read']);
    renderPage();
    expect(await tabNames()).toEqual([
      'common.details',
      'sessions.title',
      'fleets.stations',
      'fleets.vehicles',
      'fleets.departures.title',
      'fleets.drivers',
      'fleets.pricing',
      'fleets.billingTab',
      'fleets.cards.title',
      'fleets.bulkReservations',
      'audit.history',
    ]);
  });

  it('adds Fleet Managers for an all-site operator who reads users, never for others', async () => {
    h.permissions = new Set(['fleets:read', 'users:read']);
    renderPage();
    expect(await tabNames()).toContain('fleets.managers.title');
    cleanup();

    h.allSites = false;
    renderPage();
    expect(await tabNames()).not.toContain('fleets.managers.title');
    cleanup();

    h.allSites = true;
    h.permissions = new Set(['fleets:read']);
    renderPage();
    expect(await tabNames()).not.toContain('fleets.managers.title');
    cleanup();

    h.fleetUser = true;
    h.allSites = false;
    h.permissions = new Set(['fleets:read', 'users:read']);
    renderPage();
    expect(await tabNames()).not.toContain('fleets.managers.title');
  });
});
