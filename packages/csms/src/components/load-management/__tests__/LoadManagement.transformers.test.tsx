// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { apiMock } = vi.hoisted(() => {
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
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

import { useAuth } from '@/lib/auth';
import { LoadManagement } from '../LoadManagement';

const SOLAR = {
  id: 'ena_solar',
  siteId: 'site1',
  type: 'solar',
  name: 'Carport Solar',
  capacityKwh: null,
  peakKwp: 120,
  inverterKw: 100,
  maxDischargeKw: null,
  maxChargeKw: null,
  phases: 3,
  connectionTransformerId: null,
  connectionPanelId: null,
  gridCharging: 'never',
  reservePercent: 10,
  telemetry: 'simulated',
  readingTtlSeconds: 60,
  reading: null,
  supply: { state: 'none', counted: false, creditKw: 0, loadKw: 0 },
};

function mockApi(simulatedEnergyAssetsAllowed: boolean): void {
  apiMock.get.mockImplementation((url: string) => {
    if (url.endsWith('/transformers')) return Promise.resolve([]);
    if (url.endsWith('/energy-assets')) return Promise.resolve([SOLAR]);
    return Promise.resolve({
      config: { strategy: 'equal_share', isEnabled: true },
      hierarchy: [],
      stations: [],
      simulatedEnergyAssetsAllowed,
    });
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
  useAuth.setState({ permissions: [] });
});

describe('LoadManagement transformers, batteries and solar', () => {
  it('reads the transformers and energy assets of the site and shows the Energy Storage and Solar card', async () => {
    useAuth.setState({ permissions: ['loadManagement:write'] });
    mockApi(true);
    renderTab();
    expect(await screen.findByText('Carport Solar')).toBeTruthy();
    expect(apiMock.get).toHaveBeenCalledWith('/v1/sites/site1/transformers');
    expect(apiMock.get).toHaveBeenCalledWith('/v1/sites/site1/energy-assets');
    expect(screen.getByText('loadManagement.energyAssets')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'loadManagement.addTransformer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'loadManagement.addPanel' })).toBeTruthy();

    // The simulated source is offered only where the API allows it.
    fireEvent.click(screen.getByRole('button', { name: 'loadManagement.addEnergyAsset' }));
    const telemetry = document.getElementById('asset-telemetry') as HTMLSelectElement;
    expect([...telemetry.options].map((o) => o.value)).toContain('simulated');
  });

  it('offers no simulated readings when the installation refuses them', async () => {
    useAuth.setState({ permissions: ['loadManagement:write'] });
    mockApi(false);
    renderTab();
    await screen.findByText('Carport Solar');
    fireEvent.click(screen.getByRole('button', { name: 'loadManagement.addEnergyAsset' }));
    const telemetry = document.getElementById('asset-telemetry') as HTMLSelectElement;
    expect([...telemetry.options].map((o) => o.value)).toEqual(['none', 'api']);
  });

  it('shows the equipment read only with loadManagement:read', async () => {
    useAuth.setState({ permissions: ['loadManagement:read'] });
    mockApi(true);
    renderTab();
    await screen.findByText('Carport Solar');
    expect(screen.queryByRole('button', { name: 'loadManagement.addTransformer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'loadManagement.addPanel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'loadManagement.addEnergyAsset' })).toBeNull();
  });
});
