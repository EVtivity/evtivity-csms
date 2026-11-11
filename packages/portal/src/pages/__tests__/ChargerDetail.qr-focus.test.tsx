// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
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
    t: (key: string, options?: { id?: number; total?: number }) =>
      options?.id != null
        ? `${key}:${String(options.id)}`
        : options?.total != null
          ? `${key}:${String(options.total)}`
          : key,
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
vi.mock('@/hooks/use-price-display', () => ({ usePriceDisplay: () => null }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { ChargerDetail } from '../ChargerDetail';

function evse(evseId: number): Record<string, unknown> {
  return {
    evseId,
    connectors: [
      {
        connectorId: 1,
        connectorType: 'Type2',
        maxPowerKw: '11',
        maxCurrentAmps: 16,
        status: 'available',
      },
    ],
    reservationExpiresAt: null,
    reserved: false,
    reservedByMe: false,
  };
}

const station = {
  stationId: 'KebaMaster',
  siteId: null,
  model: null,
  isOnline: true,
  isSimulator: false,
  siteName: 'Parkplatz',
  siteAddress: null,
  siteCity: null,
  siteState: null,
  siteContactName: null,
  siteContactEmail: null,
  siteContactPhone: null,
  paymentEnabled: false,
  evses: [evse(1), evse(2), evse(3)],
  maintenance: null,
  stationUnavailable: false,
};

function renderAt(path: string): void {
  getMock.mockImplementation((url: string) => {
    if (url === '/v1/portal/chargers/KebaMaster') return Promise.resolve(station);
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

describe('ChargerDetail QR focus', () => {
  it('shows only the scanned connector and offers the others', async () => {
    renderAt('/start/KebaMaster?evse=2');
    expect(await screen.findByText('stationDetail.connectorPort:2')).toBeDefined();
    expect(screen.queryByText('stationDetail.connectorPort:1')).toBeNull();
    expect(screen.queryByText('stationDetail.connectorPort:3')).toBeNull();
    expect(screen.queryByText('stationDetail.selectConnector')).toBeNull();

    fireEvent.click(screen.getByText('stationDetail.showAllConnectors:3'));
    expect(screen.getByText('stationDetail.connectorPort:1')).toBeDefined();
    expect(screen.getByText('stationDetail.connectorPort:3')).toBeDefined();
    expect(screen.queryByText('stationDetail.showAllConnectors:3')).toBeNull();
  });

  it('shows every connector without an evse param', async () => {
    renderAt('/start/KebaMaster');
    expect(await screen.findByText('stationDetail.connectorPort:1')).toBeDefined();
    expect(screen.getByText('stationDetail.connectorPort:3')).toBeDefined();
    expect(screen.getByText('stationDetail.selectConnector')).toBeDefined();
    expect(screen.queryByText(/stationDetail\.showAllConnectors/)).toBeNull();
  });

  it('falls back to every connector when the scanned one does not exist', async () => {
    renderAt('/start/KebaMaster?evse=9');
    expect(await screen.findByText('stationDetail.connectorPort:1')).toBeDefined();
    expect(screen.getByText('stationDetail.connectorPort:3')).toBeDefined();
    expect(screen.queryByText(/stationDetail\.showAllConnectors/)).toBeNull();
  });
});
