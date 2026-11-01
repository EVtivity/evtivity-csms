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
    expect(screen.queryByRole('button', { name: /sites\.layoutView\.fitToView/ })).toBeNull();
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

  it('opens the power equipment read-only without sites:write, and in Edit Layout with it', async () => {
    wrap();
    await screen.findByTestId('site-layout-3d');
    // A viewer: the button and summary above the view, a read-only list in the dialog.
    fireEvent.click(screen.getByRole('button', { name: /sites\.layoutSettings\.powerEquipment/ }));
    expect(screen.getByText('sites.layoutSettings.powerEquipmentReadOnly')).toBeDefined();
    expect(screen.queryByRole('button', { name: /addTransformer/ })).toBeNull();
    cleanup();

    permissions.add('sites:write');
    wrap();
    await screen.findByTestId('site-layout-3d');
    // A writer: no read-only field outside Edit Layout; the Site Settings carry the button.
    expect(screen.queryByTestId('power-equipment')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /sites\.layoutView\.editLayout/ }));
    expect(screen.getByTestId('power-equipment')).toBeDefined();
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
    const ac = within(board).getByText('CS-AC').closest('.rounded-lg') as HTMLElement;
    const dc = within(board).getByText('CS-DC').closest('.rounded-lg') as HTMLElement;

    expect(within(ac).getByRole('img', { name: 'sites.layoutState.faulted' })).toBeDefined();
    expect(within(ac).getByTestId('connection-badge').getAttribute('data-connection')).toBe(
      'cellular',
    );
    expect(
      within(ac).getByTestId('connection-badge').querySelector('[data-bars="2"]'),
    ).not.toBeNull();
    expect(within(ac).queryByTestId('new-placement-tag')).toBeNull();
    // The AC icon is 48 px wide, the DC icon 52 px.
    expect(ac.querySelector('svg[width="48"]')).not.toBeNull();

    expect(within(dc).getByRole('img', { name: 'sites.layoutState.maintenance' })).toBeDefined();
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
    expect(dc.querySelector('svg[width="52"]')).not.toBeNull();
  });

  it('draws the building edge along the first row of an office or retail site, and none on a parking lot', async () => {
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
    expect(await within(board).findByTestId('site-layout-2d-building')).toBeDefined();
    expect(screen.getByTestId('site-layout-building-legend').textContent).toContain(
      'sites.layoutView.building',
    );
  });

  it('draws the street of a curbside site between its sides, and no outline for a side without chargers', async () => {
    const curb = {
      ...effectiveLayoutSettings(null),
      siteType: 'curbside',
      chargersLeft: 0,
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
    expect(await within(board).findByTestId('site-layout-2d-street')).toBeDefined();
    expect(within(board).queryByTestId('site-layout-2d-side-left')).toBeNull();
    expect(within(board).getByTestId('site-layout-2d-side-right')).toBeDefined();
    expect(within(board).queryByTestId('site-layout-2d-lot')).toBeNull();
    expect(within(board).queryByTestId('site-layout-2d-building')).toBeNull();
    expect(screen.getByTestId('site-layout-street-legend').textContent).toContain(
      'sites.layoutView.street',
    );
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

  it('marks the partner spot of a 2-port pedestal and the access aisle on the 2D board', async () => {
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
    const shared = await within(board).findByTestId('site-layout-2d-held-pair-sta_ped');
    expect(shared.textContent).toBe('sites.layoutView.pedestalSecondSpot');
    // Column 3, the partner of column 2.
    expect(shared.style.left).toBe('620px');
    const aisle = within(board).getByTestId('site-layout-2d-held-access-aisle');
    // The DC station in column 0 holds the accessible space; column 1 is its aisle.
    expect(aisle.style.left).toBe('220px');
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

  it('draws every station with its spots, turns one with R and saves the free positions', async () => {
    permissions.add('sites:write');
    putMock.mockResolvedValue({});
    wrap();
    const board = await screen.findByTestId('site-layout-2d');
    expect(await within(board).findByTestId('site-layout-2d-custom')).toBeDefined();
    expect(within(board).getByTestId('site-layout-2d-spots-sta_ac')).toBeDefined();
    expect(within(board).queryByTestId('site-layout-2d-lot')).toBeNull();
    expect(screen.getByTestId('site-layout-spot-legend')).toBeDefined();
    expect(screen.getByTestId('site-layout-2d-custom-hint').textContent).toBe(
      'sites.layoutView.hintEditCustom',
    );
    const chip = within(board).getByTestId('site-layout-card-sta_ac');
    fireEvent.keyDown(chip, { key: 'r' });
    fireEvent.keyDown(chip, { key: 'ArrowUp' });
    fireEvent.click(screen.getByRole('button', { name: /common\.save/ }));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalled();
    });
    expect(putMock).toHaveBeenCalledWith(
      '/v1/sites/sit_1/layout',
      expect.objectContaining({
        positions: [
          {
            stationId: 'sta_ac',
            positionX: 20,
            positionY: 20,
            freePosition: { x: 0, z: -0.5, rotationDeg: 15 },
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

  it('refuses a move onto another station and says why', async () => {
    wrap();
    const board = await screen.findByTestId('site-layout-2d');
    const chip = await within(board).findByTestId('site-layout-card-sta_dc');
    // sta_dc turned 90 degrees lies toward -x, onto the spots of sta_ac after a few steps left.
    for (let i = 0; i < 8; i++) fireEvent.keyDown(chip, { key: 'ArrowLeft' });
    expect(within(board).getByTestId('site-layout-2d-notice').textContent).toBe(
      'sites.layoutView.spotsOverlap:CS-DC',
    );
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
