// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock, post: vi.fn() } };
});

// Renders the key and its options, so a test sees which label and values a page uses.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options == null || Object.keys(options).length === 0
        ? key
        : `${key}:${Object.values(options).map(String).join('|')}`,
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
vi.mock('@/components/SessionCharts', () => ({ SessionCharts: () => null }));
vi.mock('@/hooks/use-station-events', () => ({ useStationEvents: () => undefined }));
vi.mock('@/hooks/use-price-display', () => ({ usePriceDisplay: () => null }));
vi.mock('@/lib/guest-start', () => ({
  guestStartExtras: vi.fn(() => Promise.resolve({ language: 'en' })),
}));

import { ChargerLanding } from '../ChargerLanding';
import { ChargerStationLanding } from '../ChargerStationLanding';
import { GuestCheckout } from '../GuestCheckout';
import { GuestSession } from '../GuestSession';

// GitHub discussion 59: one OCPP 1.6 station, boxes of 2 AC EVSEs.
function connector(): Record<string, unknown> {
  return {
    connectorId: 1,
    connectorType: 'Type2',
    maxPowerKw: 11,
    maxCurrentAmps: 16,
    status: 'available',
  };
}

const siteFields = {
  siteId: null,
  model: null,
  isOnline: true,
  isSimulator: false,
  siteName: 'Parkhaus',
  siteAddress: null,
  siteCity: null,
  siteState: null,
  maintenance: null,
  stationUnavailable: false,
};

function evsePage(unit: { id: string; name: string } | null): Record<string, unknown> {
  return {
    stationId: 'EM4-MASTER',
    ...siteFields,
    evse: { evseId: 6, connectors: [connector()], reservationExpiresAt: null },
    unit,
  };
}

function stationPage(withUnits: boolean): Record<string, unknown> {
  return {
    stationId: 'EM4-MASTER',
    ...siteFields,
    evses: Array.from({ length: 4 }, (_, i) => ({
      evseId: i + 1,
      unitId: withUnits ? `unt_box${String(Math.floor(i / 2) + 1)}` : null,
      connectors: [connector()],
      reservationExpiresAt: null,
    })),
    units: withUnits
      ? [
          { id: 'unt_box1', name: 'Box 1', evseIds: [1, 2], availableCount: 2 },
          { id: 'unt_box2', name: 'Box 2', evseIds: [3, 4], availableCount: 2 },
        ]
      : [],
  };
}

function renderAt(path: string, routePath: string, element: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe('guest pages of a station with units', () => {
  it('names the box and the port of a scanned EVSE, as the signed-in page does', async () => {
    getMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/guest/charger-config/')
          ? { isFree: true, paymentEnabled: false }
          : evsePage({ id: 'unt_box3', name: 'Box 3' }),
      ),
    );
    renderAt('/charge/EM4-MASTER/6', '/charge/:stationId/:evseId', <ChargerLanding />);
    expect((await screen.findByTestId('charger-title')).textContent).toBe('Box 3');
    expect(screen.getByTestId('charger-station-id').textContent).toBe('EM4-MASTER');
    expect(screen.getByTestId('charger-port').textContent).toContain(
      'stationDetail.connectorPort:6',
    );
  });

  it('shows the scanned EVSE of a station without units by its station and port', async () => {
    getMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/guest/charger-config/')
          ? { isFree: true, paymentEnabled: false }
          : evsePage(null),
      ),
    );
    renderAt('/charge/EM4-MASTER/6', '/charge/:stationId/:evseId', <ChargerLanding />);
    expect((await screen.findByTestId('charger-title')).textContent).toBe('EM4-MASTER');
    expect(screen.queryByTestId('charger-station-id')).toBeNull();
    expect(screen.getByTestId('charger-port').textContent).toContain(
      'stationDetail.connectorPort:6',
    );
  });

  it('shows one box of the station page with its ports only', async () => {
    getMock.mockResolvedValue(stationPage(true));
    renderAt('/charge/EM4-MASTER?unit=unt_box2', '/charge/:stationId', <ChargerStationLanding />);
    expect((await screen.findByTestId('charger-title')).textContent).toBe('Box 2');
    expect(screen.getByTestId('charger-station-id').textContent).toBe('EM4-MASTER');
    expect(screen.getByText('stationDetail.connectorPort:3')).toBeDefined();
    expect(screen.getByText('stationDetail.connectorPort:4')).toBeDefined();
    expect(screen.queryByText('stationDetail.connectorPort:1')).toBeNull();
  });

  it('ignores a unit id the station does not have and shows the whole station', async () => {
    getMock.mockResolvedValue(stationPage(true));
    renderAt('/charge/EM4-MASTER?unit=unt_other', '/charge/:stationId', <ChargerStationLanding />);
    expect((await screen.findByTestId('charger-title')).textContent).toBe('EM4-MASTER');
    expect(screen.queryByTestId('charger-station-id')).toBeNull();
    expect(screen.getByText('stationDetail.connectorPort:1')).toBeDefined();
    expect(screen.getByText('stationDetail.connectorPort:4')).toBeDefined();
  });

  it('names the box in the guest checkout', async () => {
    getMock.mockResolvedValue({ isFree: true, paymentEnabled: false, unitName: 'Box 3' });
    renderAt(
      '/charge/EM4-MASTER/6/checkout',
      '/charge/:stationId/:evseId/checkout',
      <GuestCheckout />,
    );
    expect((await screen.findByTestId('guest-unit-name')).textContent).toBe('Box 3');
    expect(screen.getByText('guest.stationPort:EM4-MASTER|6')).toBeDefined();
  });

  it('keeps the station and port in the guest checkout without a unit', async () => {
    getMock.mockResolvedValue({ isFree: true, paymentEnabled: false, unitName: null });
    renderAt(
      '/charge/EM4-MASTER/6/checkout',
      '/charge/:stationId/:evseId/checkout',
      <GuestCheckout />,
    );
    expect(await screen.findByText('guest.stationPort:EM4-MASTER|6')).toBeDefined();
    expect(screen.queryByTestId('guest-unit-name')).toBeNull();
  });

  it('names the box on the guest session page', async () => {
    getMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/status/')
          ? {
              status: 'charging',
              stationOcppId: 'EM4-MASTER',
              evseId: 6,
              unitName: 'Box 3',
              isSimulator: false,
              currency: 'EUR',
              startedAt: new Date().toISOString(),
              endedAt: null,
            }
          : { data: [] },
      ),
    );
    renderAt('/guest-session/tok1', '/guest-session/:sessionToken', <GuestSession />);
    expect((await screen.findByTestId('guest-unit-name')).textContent).toBe('Box 3');
    expect(screen.getByText('guest.stationPort:EM4-MASTER|6')).toBeDefined();
  });
});
