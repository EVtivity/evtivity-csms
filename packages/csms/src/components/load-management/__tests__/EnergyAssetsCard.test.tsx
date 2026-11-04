// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => {
  // The auth store reads the theme on import.
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
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null ? key : `${key}:${JSON.stringify(opts)}`,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

import { EnergyAssetsCard } from '../EnergyAssetsCard';
import { connectionFields, connectionValue } from '../EnergyAssetForm';
import type { EnergyAssetItem, TransformerItem } from '../load-management-types';

const TRANSFORMER: TransformerItem = {
  id: 'tfm_service',
  siteId: 'site1',
  kind: 'service',
  name: 'Utility Transformer',
  ratedKva: 500,
  phases: 3,
  secondaryVoltageV: 277,
  powerFactor: 0.95,
  loadingLimitPercent: 100,
  safetyMarginKw: 0,
  fedFromPanelId: null,
  maxContinuousKw: 475,
  panelIds: ['pnl_main'],
  sortOrder: 0,
};

const PANELS = [
  { type: 'panel' as const, id: 'pnl_main', name: 'Main Switchboard', childPanels: [] },
];

const BATTERY: EnergyAssetItem = {
  id: 'ena_battery',
  siteId: 'site1',
  type: 'battery',
  name: 'Depot Battery',
  capacityKwh: 400,
  peakKwp: null,
  inverterKw: 200,
  maxDischargeKw: 200,
  maxChargeKw: 100,
  phases: 3,
  connectionTransformerId: null,
  connectionPanelId: 'pnl_main',
  gridCharging: 'possible',
  reservePercent: 10,
  telemetry: 'api',
  readingTtlSeconds: 60,
  reading: {
    reportedAt: '2026-11-04T10:00:00.000Z',
    receivedAt: '2026-11-04T10:00:01.000Z',
    powerKw: 80,
    availableKw: 150,
    socPercent: 62,
    source: 'api',
  },
  supply: { state: 'fresh', counted: true, creditKw: 150, loadKw: 0 },
};

const SOLAR_STALE: EnergyAssetItem = {
  ...BATTERY,
  id: 'ena_solar',
  type: 'solar',
  name: 'Carport Solar',
  capacityKwh: null,
  peakKwp: 120,
  inverterKw: 100,
  maxDischargeKw: null,
  maxChargeKw: null,
  connectionTransformerId: 'tfm_service',
  connectionPanelId: null,
  gridCharging: 'never',
  reading: {
    reportedAt: '2026-11-04T10:00:00.000Z',
    receivedAt: '2026-11-04T10:00:01.000Z',
    powerKw: 80,
    availableKw: null,
    socPercent: null,
    source: 'api',
  },
  supply: { state: 'stale', counted: true, creditKw: 0, loadKw: 0 },
};

const UNCONNECTED: EnergyAssetItem = {
  ...BATTERY,
  id: 'ena_spare',
  name: 'Spare Battery',
  connectionPanelId: null,
  telemetry: 'none',
  reading: null,
  supply: { state: 'none', counted: false, creditKw: 0, loadKw: 0 },
};

function renderCard(props: Partial<Parameters<typeof EnergyAssetsCard>[0]> = {}): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <EnergyAssetsCard
        siteId="site1"
        assets={[BATTERY, SOLAR_STALE, UNCONNECTED]}
        transformers={[TRANSFORMER]}
        panels={PANELS}
        simulatedAllowed={false}
        canWrite
        {...props}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EnergyAssetsCard', () => {
  it('shows each asset with its supply state, last reading, connection and credit', () => {
    renderCard();
    const battery = within(screen.getByTestId('energy-asset-ena_battery'));
    expect(battery.getByText('loadManagement.supplyLive')).toBeTruthy();
    expect(battery.getByText('Main Switchboard')).toBeTruthy();
    expect(battery.getByText('400 kWh, 200.0 kW')).toBeTruthy();
    expect(battery.getByText('150.0 kW')).toBeTruthy();
    expect(battery.getByText(/loadManagement.stateOfChargeValue/)).toBeTruthy();
    expect(battery.queryByText('loadManagement.supplyStaleBody')).toBeNull();

    const solar = within(screen.getByTestId('energy-asset-ena_solar'));
    expect(solar.getByText('loadManagement.supplyStale')).toBeTruthy();
    expect(solar.getByText('loadManagement.supplyStaleBody')).toBeTruthy();
    expect(solar.getByText('Utility Transformer')).toBeTruthy();
    expect(solar.getByText('120 kWp, 100.0 kW')).toBeTruthy();

    const spare = within(screen.getByTestId('energy-asset-ena_spare'));
    expect(spare.getByText('loadManagement.supplyNoData')).toBeTruthy();
    expect(spare.getByText('loadManagement.supplyNotConnected')).toBeTruthy();
    expect(spare.getByText('loadManagement.noReading')).toBeTruthy();
  });

  it('shows the empty state without assets', () => {
    renderCard({ assets: [] });
    expect(screen.getByText('loadManagement.noEnergyAssets')).toBeTruthy();
  });

  it('is read only without loadManagement:write', () => {
    renderCard({ canWrite: false });
    expect(screen.queryByRole('button', { name: /loadManagement.addEnergyAsset/ })).toBeNull();
    expect(
      screen.queryByRole('button', { name: /loadManagement.editEnergyAssetNamed/ }),
    ).toBeNull();
    expect(screen.getByTestId('energy-asset-ena_battery')).toBeTruthy();
  });

  it('adds a battery connected at a panel', async () => {
    apiMock.post.mockResolvedValue({ id: 'ena_new' });
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /loadManagement.addEnergyAsset/ }));
    const dialog = within(screen.getByRole('dialog'));
    const byId = (id: string) => document.getElementById(id) as HTMLInputElement;
    // Simulated readings are not offered where the installation refuses them.
    const telemetry = byId('asset-telemetry') as unknown as HTMLSelectElement;
    expect([...telemetry.options].map((o) => o.value)).toEqual(['none', 'api']);
    const connection = byId('asset-connection') as unknown as HTMLSelectElement;
    expect([...connection.options].map((o) => o.value)).toEqual([
      '',
      'transformer:tfm_service',
      'panel:pnl_main',
    ]);

    fireEvent.change(byId('asset-name'), { target: { value: 'New Battery' } });
    fireEvent.change(byId('asset-capacity'), { target: { value: '200' } });
    fireEvent.change(byId('asset-inverter'), { target: { value: '100' } });
    fireEvent.change(byId('asset-discharge'), { target: { value: '100' } });
    fireEvent.change(byId('asset-charge'), { target: { value: '50' } });
    fireEvent.change(connection, { target: { value: 'panel:pnl_main' } });
    fireEvent.change(telemetry, { target: { value: 'api' } });
    fireEvent.change(byId('asset-ttl'), { target: { value: '30' } });
    fireEvent.click(dialog.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledTimes(1);
    });
    expect(apiMock.post).toHaveBeenCalledWith('/v1/sites/site1/energy-assets', {
      type: 'battery',
      name: 'New Battery',
      inverterKw: 100,
      phases: 3,
      connectionTransformerId: null,
      connectionPanelId: 'pnl_main',
      telemetry: 'api',
      readingTtlSeconds: 30,
      capacityKwh: 200,
      maxDischargeKw: 100,
      maxChargeKw: 50,
      gridCharging: 'possible',
      reservePercent: 10,
    });
  });

  it('offers simulated readings where the installation allows them, and sends only solar fields for solar', async () => {
    apiMock.patch.mockResolvedValue({ id: 'ena_solar' });
    renderCard({ simulatedAllowed: true });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'loadManagement.editEnergyAssetNamed:{"name":"Carport Solar"}',
      }),
    );
    const telemetry = document.getElementById('asset-telemetry') as HTMLSelectElement;
    expect([...telemetry.options].map((o) => o.value)).toEqual(['none', 'api', 'simulated']);
    // The type stays: the asset writer refuses fields of the other type.
    expect((document.getElementById('asset-type') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(telemetry, { target: { value: 'simulated' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledTimes(1);
    });
    const [url, body] = apiMock.patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/v1/sites/site1/energy-assets/ena_solar');
    expect(body).toMatchObject({
      peakKwp: 120,
      connectionTransformerId: 'tfm_service',
      connectionPanelId: null,
      telemetry: 'simulated',
    });
    expect(body).not.toHaveProperty('type');
    expect(body).not.toHaveProperty('capacityKwh');
    expect(body).not.toHaveProperty('gridCharging');
  });

  it('deletes an asset only after the confirmation', async () => {
    apiMock.delete.mockResolvedValue(undefined);
    renderCard();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'loadManagement.deleteEnergyAssetNamed:{"name":"Spare Battery"}',
      }),
    );
    expect(apiMock.delete).not.toHaveBeenCalled();
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('loadManagement.confirmDeleteEnergyAsset')).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: /common.delete/ }));
    await waitFor(() => {
      expect(apiMock.delete).toHaveBeenCalledWith('/v1/sites/site1/energy-assets/ena_spare');
    });
  });
});

describe('connection point values', () => {
  it('round-trips a transformer, a panel and no connection', () => {
    expect(connectionValue(SOLAR_STALE)).toBe('transformer:tfm_service');
    expect(connectionValue(BATTERY)).toBe('panel:pnl_main');
    expect(connectionValue(UNCONNECTED)).toBe('');
    expect(connectionFields('transformer:tfm_service')).toEqual({
      connectionTransformerId: 'tfm_service',
      connectionPanelId: null,
    });
    expect(connectionFields('panel:pnl_main')).toEqual({
      connectionTransformerId: null,
      connectionPanelId: 'pnl_main',
    });
    expect(connectionFields('')).toEqual({
      connectionTransformerId: null,
      connectionPanelId: null,
    });
  });
});
