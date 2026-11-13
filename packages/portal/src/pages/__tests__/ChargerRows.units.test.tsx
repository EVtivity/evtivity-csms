// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock, post: vi.fn(), delete: vi.fn() } };
});
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/components/AuthBranding', () => ({
  AuthBranding: () => null,
  AuthFooter: () => null,
  useAuthBranding: () => ({ companyName: null, companyLogo: null, branding: undefined }),
}));

import { StationSearchList } from '@/components/StationSearchList';
import { Favorites } from '../Favorites';
import { Watching } from '../Watching';
import { LocationDetail } from '../LocationDetail';

const connector = {
  connectorType: 'Type2',
  maxPowerKw: '22',
  maxCurrentAmps: 32,
  status: 'available',
};

function wrap(path: string, routePath: string, element: React.JSX.Element): void {
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

// Owner decision 2026-11-13: a unit row shows the box as its title, the station under it.
describe('charger rows of a station with units', () => {
  it('titles a search row by its box and names the station under it', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.startsWith('/v1/portal/chargers/search')) {
        return Promise.resolve([
          {
            stationId: 'EM4-MASTER-01',
            model: null,
            isOnline: true,
            siteName: 'Parkhaus',
            siteAddress: null,
            siteCity: null,
            evseCount: 2,
            availableCount: 2,
            connectors: [connector],
            unitId: 'unt_box2',
            unitName: 'Box 2',
          },
          {
            stationId: 'CS-0001',
            model: null,
            isOnline: true,
            siteName: 'Office',
            siteAddress: null,
            siteCity: null,
            evseCount: 2,
            availableCount: 2,
            connectors: [connector],
            unitId: null,
            unitName: null,
          },
        ]);
      }
      return Promise.resolve(url === '/v1/portal/features' ? {} : []);
    });
    wrap('/', '/', <StationSearchList onSelect={() => undefined} />);
    fireEvent.change(screen.getByPlaceholderText('chargerSearch.searchPlaceholder'), {
      target: { value: 'EM' },
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('search-row-title')).toHaveLength(2);
    });
    const titles = screen.getAllByTestId('search-row-title').map((e) => e.textContent);
    expect(titles).toEqual(['Box 2', 'CS-0001']);
    const stations = screen.getAllByTestId('search-station-id').map((e) => e.textContent);
    expect(stations).toEqual(['EM4-MASTER-01']);
  });

  it.each([
    ['favorites', '/favorites', <Favorites key="f" />, '/v1/portal/favorites'],
    ['watches', '/station-watches', <Watching key="w" />, '/v1/portal/station-watches'],
  ])('titles a unit in the %s by its box', async (_name, path, element, url) => {
    getMock.mockImplementation((u: string) =>
      Promise.resolve(
        u === url
          ? [
              {
                id: 1,
                stationId: 'EM4-MASTER-01',
                unitId: 'unt_box2',
                unitName: 'Box 2',
                siteName: 'Parkhaus',
                siteAddress: null,
                siteCity: null,
                siteState: null,
                isOnline: true,
                evseCount: 2,
                availableCount: 0,
                createdAt: new Date().toISOString(),
              },
            ]
          : [],
      ),
    );
    wrap(path, path, element);
    expect((await screen.findByTestId('charger-row-title')).textContent).toBe('Box 2');
    expect(screen.getByTestId('charger-row-station').textContent).toBe('EM4-MASTER-01');
  });

  it('titles a unit charger on the location page by its box', async () => {
    getMock.mockImplementation((u: string) =>
      Promise.resolve(
        u.startsWith('/v1/portal/chargers/location/')
          ? {
              siteId: 'sit_1',
              name: 'Parkhaus',
              address: null,
              city: null,
              state: null,
              postalCode: null,
              latitude: null,
              longitude: null,
              hoursOfOperation: null,
              contactName: null,
              contactEmail: null,
              contactPhone: null,
              stationCount: 1,
              evseCount: 1,
              availableCount: 1,
              chargers: [
                {
                  stationId: 'EM4-MASTER-01',
                  evseId: 3,
                  unitId: 'unt_box2',
                  unitName: 'Box 2',
                  connectorType: 'Type2',
                  maxPowerKw: '22',
                  status: 'available',
                  available: true,
                },
              ],
            }
          : [],
      ),
    );
    wrap('/location/sit_1', '/location/:siteId', <LocationDetail />);
    expect((await screen.findByTestId('charger-row-title')).textContent).toBe('Box 2');
    expect(screen.getByTestId('charger-row-station').textContent).toBe('EM4-MASTER-01');
  });
});
