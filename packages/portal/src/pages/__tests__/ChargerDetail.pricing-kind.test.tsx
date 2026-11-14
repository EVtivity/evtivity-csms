// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A station whose Both tariff is free while its DC tariff is paid: the
// payment section follows the picked EVSE's own answer (pricing evseFree),
// never the free Both tariff above the AC and DC prices.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: vi.fn(), delete: vi.fn() },
  ApiError: class ApiError extends Error {},
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: { id?: number }) =>
      options?.id != null ? `${key}:${String(options.id)}` : key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: (selector: (s: unknown) => unknown) =>
    selector({ isAuthenticated: true, driver: { id: 'drv_1', timezone: 'UTC' } }),
}));

vi.mock('@/lib/fleet-billing', () => ({
  useDriverBilling: () => ({ data: undefined }),
  accountBillingAt: () => null,
}));

vi.mock('@/hooks/use-station-events', () => ({ useStationEvents: () => undefined }));
vi.mock('@/hooks/use-price-display', () => ({ usePriceDisplay: () => 'net' }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { ChargerDetail } from '../ChargerDetail';

function evse(evseId: number, connectorType: string, maxPowerKw: string): Record<string, unknown> {
  return {
    evseId,
    connectors: [
      { connectorId: 1, connectorType, maxPowerKw, maxCurrentAmps: null, status: 'available' },
    ],
    reservationExpiresAt: null,
    reserved: false,
    reservedByMe: false,
  };
}

const station = {
  stationId: 'ACDC',
  siteId: null,
  model: null,
  isOnline: true,
  isSimulator: false,
  siteName: 'Depot',
  siteAddress: null,
  siteCity: null,
  siteState: null,
  siteContactName: null,
  siteContactEmail: null,
  siteContactPhone: null,
  paymentEnabled: true,
  evses: [evse(1, 'Type2', '22'), evse(2, 'CCS2', '150')],
  maintenance: null,
  stationUnavailable: false,
};

const pricing = {
  currency: 'EUR',
  pricePerKwh: '0',
  pricePerMinute: null,
  pricePerSession: null,
  idleFeePricePerMinute: null,
  taxRate: null,
  taxBasis: 'net',
  isFreeVend: false,
  paidTariffAhead: false,
  byChargingKind: [
    {
      chargingKind: 'ac',
      pricePerKwh: '0',
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
      taxRate: null,
    },
    {
      chargingKind: 'dc',
      pricePerKwh: '0.50',
      pricePerMinute: null,
      pricePerSession: null,
      idleFeePricePerMinute: null,
      taxRate: null,
    },
  ],
  evseFree: [
    { evseId: 1, free: true },
    { evseId: 2, free: false },
  ],
};

function renderAt(path: string): void {
  getMock.mockImplementation((url: string) => {
    if (url === '/v1/portal/chargers/ACDC') return Promise.resolve(station);
    if (url === '/v1/portal/chargers/ACDC/pricing') return Promise.resolve(pricing);
    if (url === '/v1/portal/chargers/sessions/active') return Promise.resolve({ data: [] });
    if (url === '/v1/portal/payment-methods') return Promise.resolve([]);
    if (url.includes('favorites')) return Promise.resolve({ isFavorite: false, favoriteId: null });
    if (url.includes('watch')) return Promise.resolve({ isWatching: false, watchId: null });
    return Promise.resolve(null);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/start/:stationId" element={<ChargerDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe('ChargerDetail with AC and DC tariffs', () => {
  it('asks for a payment method on the paid DC port', async () => {
    renderAt('/start/ACDC?evse=2');
    expect(await screen.findByText('stationDetail.addPaymentMethod')).toBeDefined();
  });

  it('asks for no payment method on the free AC port', async () => {
    renderAt('/start/ACDC?evse=1');
    expect(await screen.findByText('stationDetail.connectorPort:1')).toBeDefined();
    // The pricing card renders once the pricing query answered.
    expect(await screen.findByText('€0.50/charger.unitKwh')).toBeDefined();
    expect(screen.queryByText('stationDetail.addPaymentMethod')).toBeNull();
  });
});
