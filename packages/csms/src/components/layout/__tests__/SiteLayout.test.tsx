// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock, putMock, permissions, webgl } = vi.hoisted(() => ({
  getMock: vi.fn(),
  putMock: vi.fn(),
  permissions: new Set<string>(),
  webgl: { available: true },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, put: putMock, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/lib/auth', () => ({
  useHasPermission: (permission: string) => permissions.has(permission),
}));

vi.mock('@/lib/webgl', () => ({ webglAvailable: () => webgl.available }));

// The 3D view itself (three.js) is covered by SiteLayout3D.test.tsx.
vi.mock('../SiteLayout3D', () => ({
  default: (props: { editing: boolean; stations: unknown[] }) => (
    <div data-testid="site-layout-3d" data-editing={String(props.editing)}>
      {props.stations.length}
    </div>
  ),
}));

import { SiteLayout } from '../SiteLayout';

const connector = (overrides: Record<string, unknown> = {}) => ({
  connectorId: 1,
  connectorType: 'Type2',
  maxPowerKw: 22,
  status: 'available',
  isPluggedIn: false,
  energyDeliveredWh: null,
  ...overrides,
});

const STATIONS = [
  {
    id: 'sta_ac',
    stationId: 'CS-AC',
    model: null,
    status: 'faulted',
    statusReason: 'station_faulted',
    isOnline: true,
    securityProfile: 1,
    positionX: 20,
    positionY: 20,
    placed: true,
    chargingKind: 'ac',
    cellular: true,
    inMaintenance: false,
    displayMessage: null,
    // A 60 kW AC connector: the 50 kW rule called it DC, the connector rule AC.
    evses: [{ evseId: 1, connectors: [connector({ maxPowerKw: 60, status: 'faulted' })] }],
  },
  {
    id: 'sta_dc',
    stationId: 'CS-DC',
    model: 'Terra',
    status: 'available',
    statusReason: null,
    isOnline: true,
    securityProfile: 1,
    positionX: 220,
    positionY: 20,
    placed: false,
    chargingKind: 'dc',
    cellular: false,
    inMaintenance: true,
    displayMessage: null,
    evses: [{ evseId: 1, connectors: [connector({ connectorType: 'CCS2', maxPowerKw: 150 })] }],
  },
];

function wrap(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SiteLayout siteId="sit_1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockImplementation((url: string) =>
    Promise.resolve(
      url.endsWith('/layout') ? STATIONS : { config: null, hierarchy: [], stations: [] },
    ),
  );
  window.localStorage.clear();
  webgl.available = true;
});

afterEach(() => {
  cleanup();
  permissions.clear();
  vi.clearAllMocks();
});

describe('SiteLayout view toggle', () => {
  it('shows the 3D view by default and the 2D view on the toggle, remembering the choice', async () => {
    wrap();
    expect(await screen.findByTestId('site-layout-3d')).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'sites.layoutView.view3d' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByRole('button', { name: /sites\.layoutView\.fitToView/ })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'sites.layoutView.view2d' }));
    expect(await screen.findByTestId('site-layout-2d')).toBeDefined();
    expect(screen.queryByTestId('site-layout-3d')).toBeNull();
    expect(screen.queryByRole('button', { name: /sites\.layoutView\.fitToView/ })).toBeNull();
    expect(window.localStorage.getItem('site-layout-view')).toBe('2d');

    cleanup();
    wrap();
    expect(await screen.findByTestId('site-layout-2d')).toBeDefined();
  });

  it('shows the 2D view with a note when WebGL is unavailable', async () => {
    webgl.available = false;
    wrap();
    expect(await screen.findByTestId('site-layout-2d')).toBeDefined();
    expect(screen.getByTestId('site-layout-webgl-note')).toBeDefined();
  });

  it('offers Edit Layout only with sites:write', async () => {
    wrap();
    await screen.findByTestId('site-layout-3d');
    expect(screen.queryByRole('button', { name: /sites\.layoutView\.editLayout/ })).toBeNull();
    cleanup();

    permissions.add('sites:write');
    wrap();
    const edit = await screen.findByRole('button', { name: /sites\.layoutView\.editLayout/ });
    fireEvent.click(edit);
    expect(screen.getByTestId('site-layout-3d').getAttribute('data-editing')).toBe('true');
    expect(screen.getByRole('button', { name: /sites\.layoutView\.doneEditing/ })).toBeDefined();
  });

  it('lists every station state with its icon in the legend', async () => {
    wrap();
    const legend = await screen.findByTestId('site-layout-state-legend');
    for (const state of [
      'faulted',
      'unavailable',
      'maintenance',
      'offline',
      'reserved',
      'charging',
      'available',
      'online',
    ]) {
      expect(within(legend).getByRole('img', { name: `sites.layoutState.${state}` })).toBeDefined();
    }
  });
});

describe('SiteLayout 2D cards', () => {
  it('shows the state icon, the 4G badge, the New tag and the connector-based AC or DC icon', async () => {
    window.localStorage.setItem('site-layout-view', '2d');
    wrap();
    const board = await screen.findByTestId('site-layout-2d');
    const ac = within(board).getByText('CS-AC').closest('.rounded-lg') as HTMLElement;
    const dc = within(board).getByText('CS-DC').closest('.rounded-lg') as HTMLElement;

    expect(within(ac).getByRole('img', { name: 'sites.layoutState.faulted' })).toBeDefined();
    expect(within(ac).getByTestId('cellular-badge')).toBeDefined();
    expect(within(ac).queryByTestId('new-placement-tag')).toBeNull();
    // The AC icon is 48 px wide, the DC icon 52 px.
    expect(ac.querySelector('svg[width="48"]')).not.toBeNull();

    expect(within(dc).getByRole('img', { name: 'sites.layoutState.maintenance' })).toBeDefined();
    expect(within(dc).getByTestId('new-placement-tag')).toBeDefined();
    expect(within(dc).queryByTestId('cellular-badge')).toBeNull();
    expect(dc.querySelector('svg[width="52"]')).not.toBeNull();
  });

  it('shows the level from the connector rule: DC Fast for DC, Level 2 for a 60 kW AC connector', async () => {
    window.localStorage.setItem('site-layout-view', '2d');
    wrap();
    const board = await screen.findByTestId('site-layout-2d');
    const ac = within(board).getByText('CS-AC').closest('.rounded-lg') as HTMLElement;
    const dc = within(board).getByText('CS-DC').closest('.rounded-lg') as HTMLElement;

    // The level shows on the expanded card.
    fireEvent.click(ac.querySelector('button.ml-auto') as HTMLElement);
    fireEvent.click(dc.querySelector('button.ml-auto') as HTMLElement);

    expect(within(ac).getByText('sites.levelL2')).toBeDefined();
    expect(within(ac).queryByText('sites.levelDcFast')).toBeNull();
    expect(within(dc).getByText('sites.levelDcFast')).toBeDefined();
  });
});
