// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { use } from 'react';

const { getMock, putMock, permissions, webgl, chunk } = vi.hoisted(() => ({
  getMock: vi.fn(),
  putMock: vi.fn(),
  permissions: new Set<string>(),
  webgl: { available: true },
  // While set, the 3D view suspends as if its lazy chunk were still loading.
  chunk: { loading: null as Promise<void> | null },
}));

vi.mock('react-i18next', () => ({
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
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
    replaying?: boolean;
    stations: Array<{ status: string; isOnline: boolean }>;
    currentDrawKw: (id: string) => number | undefined;
    hierarchy: unknown[] | null;
    loadManaged: boolean;
    onMove: (id: string, x: number, y: number) => void;
  }) => {
    if (chunk.loading != null) use(chunk.loading);
    return (
      <div
        data-testid="site-layout-3d"
        data-editing={String(props.editing)}
        data-replaying={String(props.replaying === true)}
        data-statuses={props.stations.map((s) => `${s.status}:${String(s.isOnline)}`).join(',')}
        data-draw={String(props.currentDrawKw('sta_ac') ?? '')}
        data-panels={props.hierarchy == null ? 'none' : String(props.hierarchy.length)}
        data-load-managed={String(props.loadManaged)}
      >
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
    );
  },
}));

import { effectiveLayoutSettings } from '@evtivity/lib/site-layout';
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
    connectionType: 'cellular',
    signal: { bars: 2, dbm: -92 },
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
    connectionType: 'wifi_or_wired',
    signal: null,
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

const DAY_FROM = '2026-01-10T05:00:00.000Z';
const minute = (m: number): string => new Date(Date.parse(DAY_FROM) + m * 60_000).toISOString();
const REPLAY = {
  date: '2026-01-10',
  timezone: 'America/New_York',
  from: DAY_FROM,
  to: '2026-01-11T04:59:59.999Z',
  stations: [
    {
      id: 'sta_ac',
      initialOnline: true,
      onlineChanges: [],
      connectors: [
        {
          evseId: 1,
          connectorId: 1,
          initialStatus: 'Available',
          changes: [{ at: minute(600), status: 'Charging' }],
        },
      ],
      sessions: [{ startedAt: minute(600), endedAt: minute(700), energyWh: 10_000 }],
      power: [{ at: minute(600), kw: 11 }],
    },
  ],
};

beforeEach(() => {
  getMock.mockImplementation((url: string) =>
    Promise.resolve(
      url.endsWith('/layout')
        ? STATIONS
        : url.includes('/layout/replay?date=')
          ? REPLAY
          : { config: null, hierarchy: [], stations: [] },
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
    // The 3D Fit to View leaves the header; the board has its own Fit button.
    const fits = screen.getAllByRole('button', { name: /sites\.layoutView\.fitToView/ });
    expect(fits).toHaveLength(1);
    expect(within(screen.getByTestId('site-layout-2d')).getByTestId('site-layout-2d-fit')).toBe(
      fits[0],
    );
    expect(window.localStorage.getItem('site-layout-view')).toBe('2d');

    cleanup();
    wrap();
    expect(await screen.findByTestId('site-layout-2d')).toBeDefined();
  });

  it('shows the loading spinner, labeled and without text, while the 3D view loads', async () => {
    let finish: () => void = () => undefined;
    chunk.loading = new Promise<void>((resolve) => {
      finish = resolve;
    });
    wrap();
    const loading = await screen.findByTestId('site-layout-3d-loading');
    const status = within(loading).getByRole('status', { name: 'sites.layoutView.loading3d' });
    expect(status.querySelector('img')?.getAttribute('src')).toBe('/evtivity-logo-animated.svg');
    expect(loading.textContent).toBe('');
    expect(screen.queryByText('sites.layoutView.loading3d')).toBeNull();

    chunk.loading = null;
    finish();
    expect(await screen.findByTestId('site-layout-3d')).toBeDefined();
    expect(screen.queryByTestId('site-layout-3d-loading')).toBeNull();
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

  it('has no Power Equipment button, for viewers and in Edit Layout (owner decision 2026-11-04)', async () => {
    wrap();
    await screen.findByTestId('site-layout-3d');
    expect(screen.queryByRole('button', { name: /powerEquipment/i })).toBeNull();
    cleanup();

    permissions.add('sites:write');
    wrap();
    await screen.findByTestId('site-layout-3d');
    fireEvent.click(screen.getByRole('button', { name: /sites\.layoutView\.editLayout/ }));
    expect(screen.queryByRole('button', { name: /powerEquipment/i })).toBeNull();
    // Equipment is placed by drag and edited on the Load Management tab.
    expect(screen.getByTestId('layout-power-equipment-note')).toBeDefined();
  });

  it('lists the states a station can reach and those shown, each with its icon, once', async () => {
    wrap();
    const legend = await screen.findByTestId('site-layout-state-legend');
    // Every station can fault, be turned off, go offline, charge or be free; one is in maintenance.
    for (const state of [
      'faulted',
      'unavailable',
      'maintenance',
      'offline',
      'charging',
      'available',
    ]) {
      expect(
        within(legend).getAllByRole('img', { name: `sites.layoutState.${state}` }),
      ).toHaveLength(1);
    }
    // Reserved and the unknown online state: listed only when a station shows them.
    expect(within(legend).queryByRole('img', { name: 'sites.layoutState.reserved' })).toBeNull();
    expect(within(legend).queryByRole('img', { name: 'sites.layoutState.online' })).toBeNull();
  });
});

describe('SiteLayout legend', () => {
  it('renders one legend per view with the shared state entries and no virtual sign entries', async () => {
    window.localStorage.setItem('site-layout-view', '2d');
    wrap();
    await screen.findByTestId('site-layout-2d');
    const legends2d = screen.getAllByTestId('site-layout-state-legend');
    expect(legends2d).toHaveLength(1);
    const [legend2d] = legends2d as [HTMLElement];
    expect(within(legend2d).getByRole('img', { name: 'sites.layoutState.charging' })).toBeDefined();
    // The 2D board draws no signs.
    expect(within(legend2d).queryByTestId('site-layout-virtual-reserved-legend')).toBeNull();
    // No second legend of the old 2D board.
    expect(screen.queryByText('stations.sp0')).toBeNull();
    cleanup();

    window.localStorage.setItem('site-layout-view', '3d');
    wrap();
    await screen.findByTestId('site-layout-3d');
    const legends3d = screen.getAllByTestId('site-layout-state-legend');
    expect(legends3d).toHaveLength(1);
    const [legend3d] = legends3d as [HTMLElement];
    expect(within(legend3d).getByRole('img', { name: 'sites.layoutState.charging' })).toBeDefined();
    // The virtual Reserved and Maintenance signs carry their own text: not in the legend.
    expect(within(legend3d).queryByTestId('site-layout-virtual-reserved-legend')).toBeNull();
    expect(within(legend3d).queryByTestId('site-layout-virtual-maintenance-legend')).toBeNull();
    // Only the station kinds the site has: an AC and a DC station here.
    expect(within(legend3d).getByTestId('site-layout-ac-legend')).toBeDefined();
    expect(within(legend3d).getByTestId('site-layout-dc-legend')).toBeDefined();
    expect(within(legend3d).queryByTestId('site-layout-bus-bay-legend')).toBeNull();
  });
});

describe('SiteLayout 2D cards', () => {
  it('shows the state icon, the connection badge and the connector-based AC or DC icon, and no New tag for an unsaved position', async () => {
    window.localStorage.setItem('site-layout-view', '2d');
    wrap();
    const board = await screen.findByTestId('site-layout-2d');
    const ac = within(board).getByTestId('site-layout-card-sta_ac');
    const dc = within(board).getByTestId('site-layout-card-sta_dc');

    // The station status: the Stations list badge, no separate state icon.
    expect(within(ac).getByTestId('station-card-status').textContent).toBe('status.faulted');
    expect(within(ac).queryByRole('img', { name: 'sites.layoutState.faulted' })).toBeNull();
    expect(within(ac).getByTestId('connection-badge').getAttribute('data-connection')).toBe(
      'cellular',
    );
    expect(
      within(ac).getByTestId('connection-badge').querySelector('[data-bars="2"]'),
    ).not.toBeNull();
    expect(within(ac).queryByTestId('new-placement-tag')).toBeNull();
    // The picture is the station's own 3D model: an AC pedestal, a DC dispenser.
    expect(within(ac).getByTestId('station-card-thumbnail').getAttribute('data-model')).toMatch(
      /^ac-pedestal/,
    );

    expect(within(dc).getByTestId('station-card-status').textContent).toBe('status.available');
    expect(within(dc).queryByTestId('new-placement-tag')).toBeNull();
    expect(within(dc).getByTestId('connection-badge').getAttribute('data-connection')).toBe(
      'wifi_or_wired',
    );
    // The legend lists the connection types of the site: Cellular, the signal bars, Wi-Fi or Wired.
    expect(screen.getByTestId('connection-legend-cellular')).toBeDefined();
    expect(screen.getByTestId('connection-legend-signal')).toBeDefined();
    expect(screen.getByTestId('connection-legend-wifi_or_wired')).toBeDefined();
    expect(screen.queryByTestId('connection-legend-wifi')).toBeNull();
    expect(screen.queryByTestId('connection-legend-wired')).toBeNull();
    expect(within(dc).getByTestId('station-card-thumbnail').getAttribute('data-model')).toBe(
      'dc-dispenser',
    );
  });

  it('shows only the cards on an office or retail site: no building, lot or ground legend', async () => {
    const office = { ...effectiveLayoutSettings(null), siteType: 'office_retail' };
    getMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/layout')
          ? STATIONS
          : url === '/v1/sites/sit_1'
            ? { id: 'sit_1', name: 'Lakeside', layoutSettings: office }
            : { config: null, hierarchy: [], stations: [] },
      ),
    );
    window.localStorage.setItem('site-layout-view', '2d');
    wrap();
    const board = await screen.findByTestId('site-layout-2d');
    expect(await within(board).findByTestId('site-layout-card-sta_ac')).toBeDefined();
    expect(within(board).queryByTestId('site-layout-2d-building')).toBeNull();
    expect(within(board).queryByTestId('site-layout-2d-lot')).toBeNull();
    expect(screen.queryByTestId('site-layout-building-legend')).toBeNull();
  });

  it('shows a curbside site as its two rows of cards, with no street drawing', async () => {
    const curb = {
      ...effectiveLayoutSettings(null),
      siteType: 'curbside',
      chargersLeft: 2,
      chargersRight: 3,
    };
    getMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/layout')
          ? STATIONS
          : url === '/v1/sites/sit_1'
            ? { id: 'sit_1', name: 'Main Street', layoutSettings: curb }
            : { config: null, hierarchy: [], stations: [] },
      ),
    );
    window.localStorage.setItem('site-layout-view', '2d');
    wrap();
    const board = await screen.findByTestId('site-layout-2d');
    const ac = await within(board).findByTestId('site-layout-card-sta_ac');
    const dc = within(board).getByTestId('site-layout-card-sta_dc');
    expect(within(board).queryByTestId('site-layout-2d-street')).toBeNull();
    expect(screen.queryByTestId('site-layout-street-legend')).toBeNull();
    // No two cards overlap.
    const left = (el: HTMLElement): number => Number.parseFloat(el.style.left);
    const top = (el: HTMLElement): number => Number.parseFloat(el.style.top);
    expect(left(ac) !== left(dc) || top(ac) !== top(dc)).toBe(true);
  });

  it('names the AC chargers by site type and shows energy assets in the legend on a parking lot only', async () => {
    const curb = {
      ...effectiveLayoutSettings(null),
      siteType: 'curbside',
      energyAssets: [{ id: 'bat-1', type: 'battery', name: null, capacityKwh: 200, x: -4, z: 2 }],
    };
    getMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/layout')
          ? STATIONS
          : url === '/v1/sites/sit_1'
            ? { id: 'sit_1', name: 'Main Street', layoutSettings: curb }
            : { config: null, hierarchy: [], stations: [] },
      ),
    );
    wrap();
    const legend = await screen.findByTestId('site-layout-state-legend');
    expect(await within(legend).findByText('sites.layoutView.acPost')).toBeDefined();
    expect(within(legend).queryByTestId('site-layout-battery-legend')).toBeNull();
  });

  it('shows only the charger cards on the 2D board, no partner spot or access aisle labels', async () => {
    const [acStation, dcStation] = STATIONS;
    if (acStation == null || dcStation == null) throw new Error('fixture');
    const pedestal = {
      ...acStation,
      id: 'sta_ped',
      stationId: 'CS-PED',
      status: 'available',
      positionX: 420,
      positionY: 20,
      evses: [1, 2].map((evseId) => ({
        evseId,
        connectors: [connector({ connectorType: 'J1772', maxPowerKw: 7 })],
      })),
    };
    const dcAtStart = { ...dcStation, positionX: 20, positionY: 20 };
    getMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/layout')
          ? [pedestal, dcAtStart]
          : url === '/v1/sites/sit_1'
            ? { id: 'sit_1', name: 'Plaza', layoutSettings: effectiveLayoutSettings(null) }
            : { config: null, hierarchy: [], stations: [] },
      ),
    );
    window.localStorage.setItem('site-layout-view', '2d');
    wrap();
    const board = await screen.findByTestId('site-layout-2d');
    // Only the cards: no "Shared with" partner spot, access aisle or split dispenser markers.
    await within(board).findByTestId('site-layout-card-sta_ped');
    expect(within(board).queryByTestId(/^site-layout-2d-held-/)).toBeNull();
    expect(board.textContent).not.toContain('sites.layoutView.pedestalSecondSpot');
    expect(board.textContent).not.toContain('sites.layoutView.accessAisle');
  });

  it('draws no building edge on a parking lot', async () => {
    window.localStorage.setItem('site-layout-view', '2d');
    wrap();
    const board = await screen.findByTestId('site-layout-2d');
    expect(within(board).queryByTestId('site-layout-2d-building')).toBeNull();
    expect(screen.queryByTestId('site-layout-building-legend')).toBeNull();
  });

  // Owner decision 2026-11-01: the equipment shows whether or not load
  // management is on; the cable runs only while it is on.
  it.each([
    [false, 'false'],
    [true, 'true'],
  ])('passes the panels with load management on=%s, links=%s', async (isEnabled, linked) => {
    getMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/layout')
          ? STATIONS
          : {
              config: { isEnabled, strategy: 'equal_share' },
              hierarchy: [{ id: 'p1', name: 'Main', childPanels: [], circuits: [] }],
              stations: [],
            },
      ),
    );
    wrap();
    const view = await screen.findByTestId('site-layout-3d');
    await waitFor(() => {
      expect(view.getAttribute('data-panels')).toBe('1');
    });
    expect(view.getAttribute('data-load-managed')).toBe(linked);
  });

  it('passes no panels and no links when load management cannot be read', async () => {
    getMock.mockImplementation((url: string) =>
      url.endsWith('/layout')
        ? Promise.resolve(STATIONS)
        : url.endsWith('/load-management')
          ? Promise.reject(new Error('403'))
          : Promise.resolve({}),
    );
    wrap();
    const view = await screen.findByTestId('site-layout-3d');
    expect(view.getAttribute('data-panels')).toBe('none');
    expect(view.getAttribute('data-load-managed')).toBe('false');
  });

  it('keeps the power draw panel out of the board, above it at every width', async () => {
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
    // Above the board at every width: never over a station card.
    expect(panel.className).not.toMatch(/absolute/);
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
    expect(within(popup).getByTestId('layout-popup-status').textContent).toBe('status.faulted');
    // Each connector ends with the connector views' status badge, no leading status icon.
    expect(within(popup).getAllByTestId('connector-status-badge').length).toBeGreaterThan(0);
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

describe('SiteLayout custom site 2D', () => {
  const custom = { ...effectiveLayoutSettings(null), siteType: 'custom' };
  const freeStations = [
    { ...STATIONS[0], freePosition: { x: 0, z: 0, rotationDeg: 0 } },
    { ...STATIONS[1], freePosition: { x: 8, z: 0, rotationDeg: 90 } },
  ];
  beforeEach(() => {
    getMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/layout')
          ? freeStations
          : url === '/v1/sites/sit_1'
            ? { id: 'sit_1', name: 'Willow Creek', layoutSettings: custom }
            : { config: null, hierarchy: [], stations: [] },
      ),
    );
    window.localStorage.setItem('site-layout-view', '2d');
  });

  it('shows every station as its card only, moves one on the board and saves only its board position', async () => {
    permissions.add('sites:write');
    putMock.mockResolvedValue({});
    wrap();
    const board = await screen.findByTestId('site-layout-2d');
    expect(within(board).queryByTestId('site-layout-2d-spots-sta_ac')).toBeNull();
    expect(within(board).queryByTestId('site-layout-2d-lot')).toBeNull();
    expect(screen.getByTestId('site-layout-2d-hint').textContent).toBe(
      'sites.layoutView.board2d.hint',
    );
    const card = within(board).getByTestId('site-layout-card-sta_ac');
    const top = parseFloat(card.style.top);
    const left = parseFloat(card.style.left);
    fireEvent.keyDown(card, { key: 'ArrowUp' });
    const moved = within(board).getByTestId('site-layout-card-sta_ac');
    expect(parseFloat(moved.style.top)).toBeLessThan(top);
    expect(parseFloat(moved.style.left)).toBe(left);
    expect(parseFloat(moved.style.top)).toBe(top - 12);
    const boardPosition = { x: parseFloat(moved.style.left), y: parseFloat(moved.style.top) };
    fireEvent.click(screen.getByRole('button', { name: /common\.save/ }));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalled();
    });
    // The 3D spot (free position) stays as it was: moving a card never moves the station.
    expect(putMock).toHaveBeenCalledWith(
      '/v1/sites/sit_1/layout',
      expect.objectContaining({
        positions: [
          {
            stationId: 'sta_ac',
            positionX: 20,
            positionY: 20,
            freePosition: { x: 0, z: 0, rotationDeg: 0 },
            boardPosition,
          },
          {
            stationId: 'sta_dc',
            positionX: 220,
            positionY: 20,
            freePosition: { x: 8, z: 0, rotationDeg: 90 },
          },
        ],
      }),
    );
  });

  it('drags a card freely: only the card follows the pointer and it lands where dropped', async () => {
    permissions.add('sites:write');
    // jsdom has no pointer capture.
    HTMLElement.prototype.setPointerCapture = vi.fn();
    wrap();
    const board = await screen.findByTestId('site-layout-2d');
    const card = within(board).getByTestId('site-layout-card-sta_ac');
    const left = parseFloat(card.style.left);
    const top = parseFloat(card.style.top);
    fireEvent.pointerDown(card, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(card, { pointerId: 1, buttons: 1, clientX: 117, clientY: 503 });
    // The card follows the pointer by a transform, its stored corner unchanged.
    await waitFor(() => {
      expect(card.style.transform).toBe('translate(17px, 403px)');
    });
    expect(parseFloat(card.style.left)).toBe(left);
    // No landing preview: only the card shows under the pointer.
    expect(within(board).queryByTestId('site-layout-2d-drop-slot')).toBeNull();
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 117, clientY: 503 });
    // It lands exactly where it was dropped, with nothing left to animate.
    const dropped = within(board).getByTestId('site-layout-card-sta_ac');
    expect(parseFloat(dropped.style.left)).toBe(left + 17);
    expect(parseFloat(dropped.style.top)).toBe(top + 403);
    expect(dropped.style.transform).toBe('');
  });

  it('stops a card exactly where it is released, however the drag ends', async () => {
    permissions.add('sites:write');
    // jsdom has no pointer capture.
    HTMLElement.prototype.setPointerCapture = vi.fn();
    wrap();
    const board = await screen.findByTestId('site-layout-2d');
    const corner = (): { x: number; y: number; transform: string } => {
      const el = within(board).getByTestId('site-layout-card-sta_ac');
      return {
        x: parseFloat(el.style.left),
        y: parseFloat(el.style.top),
        transform: el.style.transform,
      };
    };
    const start = corner();
    const settled = async (): Promise<void> => {
      // Let any frame loop or timer run: nothing may move after the release.
      await new Promise((resolve) => setTimeout(resolve, 300));
    };

    // Released with pointerup.
    let card = within(board).getByTestId('site-layout-card-sta_ac');
    fireEvent.pointerDown(card, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(card, { pointerId: 1, buttons: 1, clientX: 0, clientY: 300 });
    fireEvent.pointerMove(card, { pointerId: 1, buttons: 1, clientX: 40, clientY: 600 });
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 40, clientY: 600 });
    await settled();
    expect(corner()).toEqual({ x: start.x + 40, y: start.y + 600, transform: '' });
    // Later hover moves with no button held never move it.
    card = within(board).getByTestId('site-layout-card-sta_ac');
    fireEvent.pointerMove(card, { pointerId: 1, buttons: 0, clientX: 300, clientY: 900 });
    await settled();
    expect(corner()).toEqual({ x: start.x + 40, y: start.y + 600, transform: '' });

    // A missed pointerup: the next move without a button ends the drag where it was.
    fireEvent.pointerDown(card, { pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(card, { pointerId: 2, buttons: 1, clientX: 0, clientY: 200 });
    fireEvent.pointerMove(card, { pointerId: 2, buttons: 0, clientX: 500, clientY: 900 });
    await settled();
    expect(corner()).toEqual({ x: start.x + 40, y: start.y + 800, transform: '' });

    // Lost pointer capture ends it too.
    card = within(board).getByTestId('site-layout-card-sta_ac');
    fireEvent.pointerDown(card, { pointerId: 3, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(card, { pointerId: 3, buttons: 1, clientX: 0, clientY: 200 });
    fireEvent.lostPointerCapture(card, { pointerId: 3 });
    await settled();
    expect(corner()).toEqual({ x: start.x + 40, y: start.y + 1000, transform: '' });
    card = within(board).getByTestId('site-layout-card-sta_ac');
    fireEvent.pointerMove(card, { pointerId: 3, buttons: 1, clientX: 500, clientY: 500 });
    await settled();
    expect(corner()).toEqual({ x: start.x + 40, y: start.y + 1000, transform: '' });
  });

  it('eases a card dropped onto another to the nearest clear place', async () => {
    permissions.add('sites:write');
    // jsdom has no pointer capture.
    HTMLElement.prototype.setPointerCapture = vi.fn();
    wrap();
    const board = await screen.findByTestId('site-layout-2d');
    const ac = within(board).getByTestId('site-layout-card-sta_ac');
    const dc = within(board).getByTestId('site-layout-card-sta_dc');
    const dx = parseFloat(dc.style.left) - parseFloat(ac.style.left) + 10;
    const dy = parseFloat(dc.style.top) - parseFloat(ac.style.top);
    fireEvent.pointerDown(ac, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(ac, { pointerId: 1, buttons: 1, clientX: dx, clientY: dy });
    fireEvent.pointerUp(ac, { pointerId: 1, clientX: dx, clientY: dy });
    const landed = within(board).getByTestId('site-layout-card-sta_ac');
    const a = { x: parseFloat(landed.style.left), y: parseFloat(landed.style.top) };
    const b = { x: parseFloat(dc.style.left), y: parseFloat(dc.style.top) };
    expect(a.x + 216 <= b.x || b.x + 216 <= a.x || a.y + 128 <= b.y || b.y + 128 <= a.y).toBe(true);
    // It starts where the pointer left it and transitions to the clear place.
    await waitFor(() => {
      expect(landed.style.transition).toContain('150ms');
    });
    expect(landed.style.transform).toBe('');
  });

  it('moves a card past another with the arrow keys and never overlaps it', async () => {
    permissions.add('sites:write');
    wrap();
    const board = await screen.findByTestId('site-layout-2d');
    const rect = (id: string): { x: number; y: number } => {
      const el = within(board).getByTestId(`site-layout-card-${id}`);
      return { x: parseFloat(el.style.left), y: parseFloat(el.style.top) };
    };
    const startX = rect('sta_ac').x;
    for (let i = 0; i < 40; i++) {
      fireEvent.keyDown(within(board).getByTestId('site-layout-card-sta_ac'), {
        key: 'ArrowRight',
      });
      const a = rect('sta_ac');
      const b = rect('sta_dc');
      const apart = a.x + 216 <= b.x || b.x + 216 <= a.x || a.y + 128 <= b.y || b.y + 128 <= a.y;
      expect(apart).toBe(true);
    }
    expect(rect('sta_ac').x).toBeGreaterThan(rect('sta_dc').x);
    expect(rect('sta_ac').x).toBeGreaterThan(startX);
  });

  it('shows no move hint and moves nothing without sites:write', async () => {
    wrap();
    const board = await screen.findByTestId('site-layout-2d');
    expect(screen.getByTestId('site-layout-2d-hint').textContent).toBe(
      'sites.layoutView.board2d.hintViewOnly',
    );
    const card = within(board).getByTestId('site-layout-card-sta_ac');
    const top = card.style.top;
    fireEvent.keyDown(card, { key: 'ArrowUp' });
    expect(within(board).getByTestId('site-layout-card-sta_ac').style.top).toBe(top);
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

  it('replays a day: the chosen moment draws through the same view, then back to live', async () => {
    wrap();
    await screen.findByTestId('site-layout-3d');
    fireEvent.click(screen.getByTestId('site-layout-replay-toggle'));
    expect(await screen.findByTestId('site-layout-replay')).toBeDefined();
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith(
        expect.stringMatching(/^\/v1\/sites\/sit_1\/layout\/replay\?date=\d{4}-\d{2}-\d{2}$/),
      );
    });
    const view = screen.getByTestId('site-layout-3d');
    await waitFor(() => {
      expect(view.getAttribute('data-replaying')).toBe('true');
    });
    // Move to 10:03: the replayed station charges at 11 kW (the live one was faulted).
    fireEvent.change(screen.getByTestId('site-layout-replay-slider'), { target: { value: '603' } });
    await waitFor(() => {
      expect(screen.getByTestId('site-layout-3d').getAttribute('data-statuses')).toContain(
        'charging:true',
      );
    });
    expect(screen.getByTestId('site-layout-3d').getAttribute('data-draw')).toBe('11');
    // No Edit Layout while replaying.
    expect(screen.queryByRole('button', { name: /sites\.layoutView\.editLayout/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /sites\.layoutView\.replayBackToLive/ }));
    expect(screen.queryByTestId('site-layout-replay')).toBeNull();
    expect(screen.getByTestId('site-layout-3d').getAttribute('data-replaying')).toBe('false');
    expect(screen.getByTestId('site-layout-3d').getAttribute('data-statuses')).toContain(
      'faulted:true',
    );
  });
});
