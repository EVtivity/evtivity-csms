// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock, permissions } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  permissions: new Set<string>(),
}));

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
vi.mock('@/lib/auth', () => ({
  useHasPermission: (permission: string) => permissions.has(permission),
}));

import { EnergyAssetForm } from '../EnergyAssetForm';
import type { EnergyAssetItem } from '../load-management-types';

const SOLAR: EnergyAssetItem = {
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
  telemetry: 'none',
  readingTtlSeconds: 60,
  reading: null,
  supply: { state: 'none', counted: false, creditKw: 0, loadKw: 0 },
} as unknown as EnergyAssetItem;

const LOT = {
  siteType: 'parking_lot',
  spotsPerRow: 6,
  rows: 3,
  facingDeg: 0,
  transformers: [],
  energyAssets: [{ id: 'ena_solar', row: 0 }],
};

function mockSite(layoutSettings: Record<string, unknown>): void {
  apiMock.get.mockImplementation((url: string) => {
    if (url === '/v1/sites/site1') {
      return Promise.resolve({
        layoutSettings,
        powerEquipment: {
          transformers: [],
          energyAssets: [
            {
              id: 'ena_solar',
              type: 'solar',
              name: 'Carport Solar',
              capacityKwh: null,
              peakKwp: 120,
            },
          ],
        },
      });
    }
    if (url === '/v1/sites/site1/layout') return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

function renderForm(asset: EnergyAssetItem | undefined = SOLAR): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <EnergyAssetForm
        siteId="site1"
        asset={asset}
        transformers={[]}
        panels={[]}
        simulatedAllowed={false}
        open
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

function rowSelect(): HTMLSelectElement | null {
  return document.getElementById('asset-solar-row') as HTMLSelectElement | null;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  permissions.clear();
});

describe('EnergyAssetForm solar carport row (owner decision 2026-11-04)', () => {
  it('stores a new row through the layout route after the asset is saved', async () => {
    permissions.add('sites:write');
    mockSite(LOT);
    apiMock.patch.mockResolvedValue({});
    apiMock.put.mockResolvedValue({ ok: true, moved: [] });
    renderForm();
    await waitFor(() => {
      expect(rowSelect()?.value).toBe('0');
    });
    expect(rowSelect()?.options).toHaveLength(3);
    fireEvent.change(rowSelect() as HTMLSelectElement, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalled();
    });
    expect(apiMock.patch).toHaveBeenCalledWith(
      '/v1/sites/site1/energy-assets/ena_solar',
      expect.any(Object),
    );
    const [url, body] = apiMock.put.mock.calls[0] as [
      string,
      { positions: unknown[]; settings: { energyAssets: unknown[] } },
    ];
    expect(url).toBe('/v1/sites/site1/layout');
    // No station moves: the position by id only.
    expect(body.positions).toEqual([]);
    expect(body.settings.energyAssets).toEqual([{ id: 'ena_solar', row: 2 }]);
  });

  it('writes no layout when the row stays the same', async () => {
    permissions.add('sites:write');
    mockSite(LOT);
    apiMock.patch.mockResolvedValue({});
    renderForm();
    await waitFor(() => {
      expect(rowSelect()?.value).toBe('0');
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalled();
    });
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it('offers no row without sites:write or on a site type whose canopies stand freely', async () => {
    mockSite(LOT);
    renderForm();
    await screen.findByRole('dialog');
    expect(rowSelect()).toBeNull();
    cleanup();

    permissions.add('sites:write');
    mockSite({ ...LOT, siteType: 'custom' });
    renderForm();
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith('/v1/sites/site1/layout');
    });
    expect(rowSelect()).toBeNull();
  });
});
