// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The guest station and port pages: an offline station shows the same
// Unavailable state as the location page and an offline notice, and a failed
// guest config read shows an error with Retry instead of loading forever.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock, post: vi.fn() } };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: (selector: (s: unknown) => unknown) =>
    selector({ isAuthenticated: false, driver: null }),
}));
vi.mock('@/components/AuthBranding', () => ({
  AuthBranding: () => null,
  AuthFooter: () => null,
  useAuthBranding: () => ({ companyName: null, companyLogo: null, branding: undefined }),
}));
vi.mock('@/hooks/use-station-events', () => ({ useStationEvents: () => undefined }));
vi.mock('@/hooks/use-price-display', () => ({ usePriceDisplay: () => null }));
vi.mock('@/lib/guest-start', () => ({
  guestStartExtras: vi.fn(() => Promise.resolve({ language: 'en' })),
}));

import { ChargerLanding } from '../ChargerLanding';
import { ChargerStationLanding } from '../ChargerStationLanding';

function connector(): Record<string, unknown> {
  return {
    connectorId: 1,
    connectorType: 'Type2',
    maxPowerKw: 11,
    maxCurrentAmps: 16,
    status: 'available',
  };
}

function siteFields(isOnline: boolean): Record<string, unknown> {
  return {
    siteId: 'sit_1',
    model: null,
    isOnline,
    isSimulator: false,
    siteName: 'Parkhaus',
    siteAddress: 'Main Street 1',
    siteCity: null,
    siteState: null,
    maintenance: null,
    stationUnavailable: false,
  };
}

function stationPage(isOnline: boolean): Record<string, unknown> {
  return {
    stationId: 'CS-1',
    ...siteFields(isOnline),
    evses: [1, 2].map((evseId) => ({
      evseId,
      unitId: evseId === 1 ? 'unt_box1' : null,
      connectors: [connector()],
      reservationExpiresAt: null,
    })),
    units: [{ id: 'unt_box1', name: 'Box 1', evseIds: [1], availableCount: 1 }],
  };
}

function evsePage(isOnline: boolean): Record<string, unknown> {
  return {
    stationId: 'CS-1',
    ...siteFields(isOnline),
    evse: { evseId: 1, connectors: [connector()], reservationExpiresAt: null },
    unit: null,
  };
}

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <p data-testid="location-probe">{`${location.pathname}${location.search}`}</p>;
}

function renderAt(path: string, routePath: string, element: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={element} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe('guest station page of an offline station', () => {
  it('shows Unavailable ports and the offline notice, like the location page', async () => {
    getMock.mockResolvedValue(stationPage(false));
    renderAt('/charge/CS-1', '/charge/:stationId', <ChargerStationLanding />);
    expect(await screen.findByTestId('station-offline-notice')).toBeTruthy();
    const cards = screen.getAllByTestId('port-card');
    for (const card of cards) {
      expect(within(card).getByText('status.unavailable')).toBeTruthy();
      expect(within(card).queryByText('status.available')).toBeNull();
    }
  });

  it('shows Available ports and no notice while the station is online', async () => {
    getMock.mockResolvedValue(stationPage(true));
    renderAt('/charge/CS-1', '/charge/:stationId', <ChargerStationLanding />);
    await screen.findAllByTestId('port-card');
    expect(screen.queryByTestId('station-offline-notice')).toBeNull();
    expect(screen.getAllByText('status.available')).toHaveLength(2);
  });

  it('keeps the unit in the location link so Back returns to the box', async () => {
    getMock.mockResolvedValue(stationPage(true));
    renderAt('/charge/CS-1?unit=unt_box1', '/charge/:stationId', <ChargerStationLanding />);
    const link = await screen.findByRole('link', { name: /Main Street 1/ });
    expect(new URL(link.getAttribute('href') ?? '', 'http://x').searchParams.get('from')).toBe(
      '/charge/CS-1?unit=unt_box1',
    );
  });
});

describe('guest port page', () => {
  it('shows the offline notice and an Unavailable port for an offline station', async () => {
    getMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/guest/charger-config/')
          ? { isFree: true, paymentEnabled: false }
          : evsePage(false),
      ),
    );
    renderAt('/charge/CS-1/1', '/charge/:stationId/:evseId', <ChargerLanding />);
    expect(await screen.findByTestId('station-offline-notice')).toBeTruthy();
    expect(within(screen.getByTestId('charger-port')).getByText('status.unavailable')).toBeTruthy();
  });

  it('shows an error with Retry and Sign In when the guest config cannot be read', async () => {
    let configCalls = 0;
    getMock.mockImplementation((url: string) => {
      if (url.includes('/guest/charger-config/')) {
        configCalls += 1;
        return configCalls === 1
          ? Promise.reject(new Error('down'))
          : Promise.resolve({ isFree: true, paymentEnabled: false });
      }
      return Promise.resolve(evsePage(true));
    });
    renderAt('/charge/CS-1/1', '/charge/:stationId/:evseId', <ChargerLanding />);
    const error = await screen.findByTestId('guest-config-error');
    expect(screen.queryByText('charger.loadingInfo')).toBeNull();
    expect(within(error).getByRole('button', { name: 'charger.signIn' })).toBeTruthy();
    fireEvent.click(within(error).getByRole('button', { name: 'common.retry' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'charger.startCharging' })).toBeTruthy();
    });
    expect(screen.queryByTestId('guest-config-error')).toBeNull();
  });
});
