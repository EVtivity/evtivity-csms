// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
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
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> | string) =>
      typeof opts === 'object' && 'id' in opts ? `${key}:${String(opts['id'])}` : key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, put: putMock, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  ApiError: class ApiError extends Error {
    body: unknown = null;
  },
}));

vi.mock('@/lib/auth', () => ({
  useHasPermission: (permission: string) => permissions.has(permission),
}));

vi.mock('@/lib/webgl', () => ({ webglAvailable: () => webgl.available }));

// The 3D view itself (three.js) is covered by SiteLayout3D.test.tsx.
vi.mock('../SiteLayout3D', () => ({
  default: (props: {
    editing: boolean;
    stations: unknown[];
    onMove: (id: string, x: number, y: number) => void;
  }) => (
    <div data-testid="site-layout-3d" data-editing={String(props.editing)}>
      {props.stations.length}
      <button
        type="button"
        onClick={() => {
          props.onMove('sta_ac', 420, 160);
        }}
      >
        stub-move
      </button>
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

  it('keeps the power draw panel out of the board, above it on a phone and over its corner from sm', async () => {
    getMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/layout')
          ? STATIONS
          : {
              config: null,
              hierarchy: [],
              stations: [{ stationId: 'sta_ac', currentDrawKw: 7.4, allocatedLimitKw: null }],
            },
      ),
    );
    window.localStorage.setItem('site-layout-view', '2d');
    wrap();
    const panel = await screen.findByTestId('site-layout-power-draw');
    const board = screen.getByTestId('site-layout-2d');
    // Not inside the board, so it never covers a station card on a phone.
    expect(board.contains(panel)).toBe(false);
    expect(panel.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.className).toContain('mb-3');
    expect(panel.className).not.toMatch(/(^|\s)absolute(\s|$)/);
    expect(panel.className).toContain('sm:absolute');
  });

  it('opens the same station popup as the 3D view: level from the connector rule, Escape closes it', async () => {
    window.localStorage.setItem('site-layout-view', '2d');
    wrap();
    const board = await screen.findByTestId('site-layout-2d');
    const acButton = within(board).getByRole('button', {
      name: 'sites.layoutView.stateDetailsLabel:CS-AC',
    });
    // The card shows no inline details of its own.
    expect(within(board).queryByText('sites.levelL2')).toBeNull();

    acButton.focus();
    fireEvent.click(acButton);
    let popup = screen.getByTestId('station-layout-popup');
    expect(board.contains(popup)).toBe(true);
    expect(popup.textContent).toContain('CS-AC');
    // A 60 kW AC connector: Level 2 by the connector rule, never DC Fast.
    expect(popup.textContent).toContain('sites.levelL2');
    expect(popup.textContent).not.toContain('sites.layoutView.dcFast');
    expect(popup.textContent).toContain('sites.layoutState.faulted');
    expect(popup.textContent).toContain('stations.statusReason.station_faulted');
    expect(screen.getByRole('link', { name: 'sites.layoutView.openStation' })).toBeDefined();
    expect(popup.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('station-layout-popup')).toBeNull();
    expect(document.activeElement).toBe(acButton);

    fireEvent.click(
      within(board).getByRole('button', { name: 'sites.layoutView.stateDetailsLabel:CS-DC' }),
    );
    popup = screen.getByTestId('station-layout-popup');
    expect(popup.textContent).toContain('Terra · sites.layoutView.dcFast');
    expect(screen.getAllByTestId('station-layout-popup')).toHaveLength(1);
  });
});

describe('SiteLayout save', () => {
  it('leaves Edit Layout after a successful save', async () => {
    permissions.add('sites:write');
    putMock.mockResolvedValue({});
    wrap();
    fireEvent.click(await screen.findByRole('button', { name: /sites\.layoutView\.editLayout/ }));
    fireEvent.click(screen.getByRole('button', { name: 'stub-move' }));
    expect(screen.getByTestId('site-layout-3d').getAttribute('data-editing')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: /common\.save/ }));
    await waitFor(() => {
      expect(screen.getByTestId('site-layout-3d').getAttribute('data-editing')).toBe('false');
    });
    expect(putMock).toHaveBeenCalledWith(
      '/v1/sites/sit_1/layout',
      expect.objectContaining({
        positions: expect.arrayContaining([
          { stationId: 'sta_ac', positionX: 420, positionY: 160 },
        ]) as unknown,
      }),
    );
    expect(screen.getByRole('button', { name: /sites\.layoutView\.editLayout/ })).toBeDefined();
    expect(screen.queryByRole('button', { name: /sites\.layoutView\.doneEditing/ })).toBeNull();
  });

  it('stays in Edit Layout with the pending positions and shows the error when the save fails', async () => {
    permissions.add('sites:write');
    putMock.mockRejectedValue(new Error('save failed'));
    wrap();
    fireEvent.click(await screen.findByRole('button', { name: /sites\.layoutView\.editLayout/ }));
    fireEvent.click(screen.getByRole('button', { name: 'stub-move' }));
    fireEvent.click(screen.getByRole('button', { name: /common\.save/ }));

    await waitFor(() => {
      expect(document.querySelector('p.text-destructive')).not.toBeNull();
    });
    expect(screen.getByTestId('site-layout-3d').getAttribute('data-editing')).toBe('true');
    expect(screen.getByRole('button', { name: /sites\.layoutView\.doneEditing/ })).toBeDefined();
    // The pending move is kept: Reset is still enabled.
    const reset = screen.getByRole('button', { name: /common\.reset/ });
    expect((reset as HTMLButtonElement).disabled).toBe(false);
  });
});
