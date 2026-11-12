// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, delete: vi.fn() },
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

// GitHub discussion 59: one OCPP 1.6 station, 8 boxes of 2 AC EVSEs.
function evse(evseId: number, unitId: string | null): Record<string, unknown> {
  return {
    evseId,
    unitId,
    connectors: [
      {
        connectorId: 1,
        connectorType: 'Type2',
        maxPowerKw: '11',
        maxCurrentAmps: 16,
        status: 'charging',
      },
    ],
    reservationExpiresAt: null,
    reserved: false,
    reservedByMe: false,
  };
}

const UNITS = Array.from({ length: 8 }, (_, i) => ({
  id: `unt_box${String(i + 1)}`,
  name: `Box ${String(i + 1)}`,
  evseIds: [i * 2 + 1, i * 2 + 2],
  availableCount: 0,
}));

function station(withUnits: boolean): Record<string, unknown> {
  return {
    stationId: 'EM4-MASTER',
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
    evses: Array.from({ length: 16 }, (_, i) =>
      evse(i + 1, withUnits ? `unt_box${String(Math.floor(i / 2) + 1)}` : null),
    ),
    units: withUnits ? UNITS : [],
    maintenance: null,
    stationUnavailable: false,
  };
}

function renderAt(path: string, data: Record<string, unknown>): void {
  getMock.mockImplementation((url: string) => {
    if (url === '/v1/portal/chargers/EM4-MASTER') return Promise.resolve(data);
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
  postMock.mockReset();
});

describe('ChargerDetail station units', () => {
  it('shows one box as its own charger: its name, its EVSEs only', async () => {
    renderAt('/start/EM4-MASTER?unit=unt_box3', station(true));
    expect(await screen.findByText('stationDetail.connectorPort:5')).toBeDefined();
    expect(screen.getByText('stationDetail.connectorPort:6')).toBeDefined();
    expect(screen.queryByText('stationDetail.connectorPort:1')).toBeNull();
    expect(screen.getByTestId('charger-title').textContent).toBe('Box 3');
    expect(screen.getByTestId('charger-station-id').textContent).toBe('EM4-MASTER');
  });

  it('checks and adds the favorite and the watch of the unit', async () => {
    postMock.mockResolvedValue({ id: 1 });
    renderAt('/start/EM4-MASTER?unit=unt_box3', station(true));
    await screen.findByText('stationDetail.connectorPort:5');
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith('/v1/portal/favorites/check/EM4-MASTER?unitId=unt_box3');
    });
    expect(getMock).toHaveBeenCalledWith(
      '/v1/portal/station-watches/check/EM4-MASTER?unitId=unt_box3',
    );
    fireEvent.click(await screen.findByText('watch.notifyWhenFree'));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/portal/station-watches', {
        stationId: 'EM4-MASTER',
        unitId: 'unt_box3',
      });
    });
  });

  it('names the box of a scanned EVSE and keeps the scanned focus', async () => {
    renderAt('/start/EM4-MASTER?evse=6', station(true));
    expect(await screen.findByText('stationDetail.connectorPort:6')).toBeDefined();
    expect(screen.queryByText('stationDetail.connectorPort:5')).toBeNull();
    expect(screen.getByTestId('charger-title').textContent).toBe('Box 3');
  });

  it('ignores a unit id the station does not have and shows the whole station', async () => {
    renderAt('/start/EM4-MASTER?unit=unt_other', station(true));
    expect(await screen.findByText('stationDetail.connectorPort:1')).toBeDefined();
    expect(screen.getByText('stationDetail.connectorPort:16')).toBeDefined();
    expect(screen.getByTestId('charger-title').textContent).toBe('EM4-MASTER');
  });

  it('shows a station without units as before, with no unit in any request', async () => {
    renderAt('/start/EM4-MASTER', station(false));
    expect(await screen.findByText('stationDetail.connectorPort:16')).toBeDefined();
    expect(screen.getByTestId('charger-title').textContent).toBe('EM4-MASTER');
    expect(screen.queryByTestId('charger-station-id')).toBeNull();
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith('/v1/portal/favorites/check/EM4-MASTER');
    });
  });
});
