// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const { getMock, registration } = vi.hoisted(() => ({
  getMock: vi.fn(),
  registration: { state: 'open' },
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock, post: vi.fn() } };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
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
vi.mock('@/hooks/use-registration-enabled', () => ({
  useRegistrationStatus: () => ({ state: registration.state, retry: () => undefined }),
}));

import { ChargerLanding } from '../ChargerLanding';
import { GuestCheckout } from '../GuestCheckout';

const evsePage = {
  stationId: 'EM4-MASTER',
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
  evse: {
    evseId: 6,
    connectors: [
      {
        connectorId: 1,
        connectorType: 'Type2',
        maxPowerKw: 11,
        maxCurrentAmps: 16,
        status: 'available',
      },
    ],
    reservationExpiresAt: null,
  },
  unit: { id: 'unt_box3', name: 'Box 3' },
};

function Where(): React.JSX.Element {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function renderAt(path: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/charge/:stationId/:evseId" element={<ChargerLanding />} />
          <Route path="/charge/:stationId/:evseId/checkout" element={<GuestCheckout />} />
          <Route path="/login" element={<Where />} />
          <Route path="/register" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function config(paymentEnabled: boolean): Record<string, unknown> {
  return {
    isFree: false,
    paymentEnabled,
    paymentProvider: paymentEnabled ? { provider: 'simulated' } : null,
    currency: 'USD',
    preAuthAmountCents: 5000,
  };
}

function serve(paymentEnabled: boolean): void {
  getMock.mockImplementation((url: string) =>
    Promise.resolve(url.includes('/guest/charger-config/') ? config(paymentEnabled) : evsePage),
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  registration.state = 'open';
});

describe('guest charger page without guest payment', () => {
  it('offers Sign In and Register instead of payment and returns to the charger', async () => {
    serve(false);
    renderAt('/charge/EM4-MASTER/6');
    expect(await screen.findByTestId('guest-account-prompt')).toBeTruthy();
    // The port shows as the shared port card, above the prompt.
    const port = screen.getByTestId('charger-port');
    expect(port.textContent).toContain('stationDetail.connectorPort');
    expect(port.textContent).toContain('status.available');
    expect(screen.queryByRole('button', { name: 'charger.payWithCard' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'charger.signIn' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'charger.signIn' }));
    expect(screen.getByTestId('where').textContent).toBe(
      `/login?next=${encodeURIComponent('/charge/EM4-MASTER/6')}`,
    );
  });

  it('hides Register while registration is off', async () => {
    registration.state = 'closed';
    serve(false);
    renderAt('/charge/EM4-MASTER/6');
    expect(await screen.findByTestId('guest-account-prompt')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'charger.register' })).toBeNull();
  });

  it('keeps the card payment where a provider is set up', async () => {
    serve(true);
    renderAt('/charge/EM4-MASTER/6');
    expect(await screen.findByRole('button', { name: 'charger.payWithCard' })).toBeTruthy();
    expect(screen.queryByTestId('guest-account-prompt')).toBeNull();
    expect(screen.getByRole('button', { name: 'charger.signIn' })).toBeTruthy();
  });

  it('sends a checkout link without guest payment back to the charger page', async () => {
    serve(false);
    renderAt('/charge/EM4-MASTER/6/checkout');
    expect(await screen.findByTestId('guest-account-prompt')).toBeTruthy();
    expect(screen.queryByLabelText('guest.emailForReceipt')).toBeNull();
  });
});
