// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { apiMock, permissions } = vi.hoisted(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
  return {
    apiMock: { get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    permissions: new Set<string>(),
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null ? key : `${key}:${JSON.stringify(opts)}`,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, useHasPermission: (permission: string) => permissions.has(permission) };
});

import { LoadManagement } from '../LoadManagement';

const STATION = {
  id: 'sta_one',
  stationId: 'CS-ONE',
  currentDrawKw: 0,
  allocatedLimitKw: null,
  maxPowerKw: 22,
  loadPriority: 5,
  loadMinPowerKw: null,
  rateUnit: 'W',
  isOnline: true,
  hasActiveSession: true,
};

function mockApi(stations: Array<Record<string, unknown>>): void {
  apiMock.get.mockImplementation((url: string) => {
    if (url === '/v1/pricing/tariffs') {
      return Promise.resolve({
        data: [
          {
            id: 'trf_limited',
            pricingGroupId: 'pgr_one',
            name: 'Reduced 16 A',
            currentLimitNotEnforcedSiteIds: ['site1'],
          },
          {
            id: 'trf_other_site',
            pricingGroupId: 'pgr_one',
            name: 'Elsewhere',
            currentLimitNotEnforcedSiteIds: ['site2'],
          },
          {
            id: 'trf_plain',
            pricingGroupId: 'pgr_one',
            name: 'Plain',
            currentLimitNotEnforcedSiteIds: [],
          },
        ],
        total: 3,
      });
    }
    if (url.endsWith('/load-management')) {
      return Promise.resolve({
        config: { strategy: 'equal_share', isEnabled: false },
        hierarchy: [],
        stations,
      });
    }
    return Promise.resolve([]);
  });
}

function renderTab(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <LoadManagement siteId="site1" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  permissions.clear();
});

describe('LoadManagement unenforced tariff current limits', () => {
  it('lists the tariffs whose limits this site does not enforce, linked to each tariff', async () => {
    permissions.add('pricing:read');
    mockApi([STATION]);
    renderTab();
    const alert = await screen.findByTestId('tariff-limits-not-enforced');
    const link = await screen.findByRole('link', { name: 'Reduced 16 A' });
    expect(link.getAttribute('href')).toBe('/pricing/pgr_one/tariffs/trf_limited');
    expect(alert.textContent).not.toContain('Elsewhere');
    expect(alert.textContent).not.toContain('Plain');
  });

  it('names the stations with an unenforced session limit', async () => {
    permissions.add('pricing:read');
    mockApi([{ ...STATION, tariffLimitsNotEnforced: true }]);
    renderTab();
    expect(
      await screen.findByText(
        'loadManagement.tariffLimitsNotEnforcedStations:{"stations":"CS-ONE"}',
      ),
    ).toBeTruthy();
  });

  it('reads no tariffs and shows no warning without pricing:read', async () => {
    mockApi([STATION]);
    renderTab();
    await screen.findByText('loadManagement.allocationStrategy');
    expect(apiMock.get).not.toHaveBeenCalledWith('/v1/pricing/tariffs');
    expect(screen.queryByTestId('tariff-limits-not-enforced')).toBeNull();
  });
});
