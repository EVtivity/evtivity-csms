// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { SceneCallbacks } from '../site-layout-scene-types';

const { getMock, permissions, scene, createScene, setThemeMock, mockLanguage } = vi.hoisted(() => {
  const sceneState = {
    callbacks: null as SceneCallbacks | null,
    stations: [] as Array<{
      id: string;
      bay: { col: number; row: number };
      lightColor: string;
      prop: string | null;
      virtualSign?: string | null;
      glow: boolean;
      blinking: boolean;
      wall: boolean;
      terminals: Array<{ id: string; side: number; hasDisplay: boolean; online: boolean | null }>;
    }>,
    lot: { cols: 0, rows: 0 },
    transformers: [] as Array<{ id: string; x: number; z: number }>,
    batteries: [] as Array<{ id: string; x: number; z: number }>,
    solar: [] as Array<{ id: string; row: number }>,
    panels: [] as Array<{ id: string; x: number; z: number; mount: string }>,
    links: { segments: [] as unknown[], labels: [] as Array<{ id: string }> },
    california: false as boolean | undefined,
    logo: undefined as string | null | undefined,
    editing: false,
    fits: 0,
    active: true,
    throwOnCreate: false,
    flow: new Map<string, number>() as ReadonlyMap<string, number>,
    focused: [] as string[],
    nudges: [] as Array<{
      forward: number;
      right: number;
      yaw: number;
      pitch: number;
      zoom: number;
    }>,
    pointDistance: 20,
    // Up close: every badge at its full size.
    pxPerMeter: 1000,
    // Each station's marker point, apart from the others (assigned on first use).
    markerXs: new Map<string, number>(),
  };
  return {
    getMock: vi.fn(),
    permissions: new Set<string>(),
    scene: sceneState,
    createScene: vi.fn(),
    setThemeMock: vi.fn(),
    mockLanguage: { current: 'en' },
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> | string) =>
      mockLanguage.current !== 'en'
        ? `${mockLanguage.current}:${key}`
        : typeof opts === 'object' && 'id' in opts
          ? [key, opts['id'], opts['state']]
              .filter((part): part is string | number => typeof part !== 'object' && part != null)
              .map((part) => String(part))
              .join(':')
          : key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/lib/auth', () => ({
  useHasPermission: (permission: string) => permissions.has(permission),
  // The live OCPP window reads the user's time zone.
  useAuth: (select: (state: { user: { timezone: string } }) => unknown) =>
    select({ user: { timezone: 'UTC' } }),
}));

// WebGL does not exist in jsdom: the scene is a stub that records what it is given.
vi.mock('../site-layout-scene', () => ({
  createSiteScene: createScene,
}));

import {
  effectiveLayoutSettings,
  placePowerEquipment,
  type PlacedLayoutSettings,
} from '@evtivity/lib/site-layout';
import SiteLayout3D, { linkLabelText, stationBays } from '../SiteLayout3D';
import {
  resolveCssColor,
  stationStateColor,
  stationStateTextColor,
} from '@/lib/station-display-state';
import type { LayoutStation } from '../StationCard';
import type { LayoutTerminal } from '../layout-terminals';
import type { LinkPanel } from '../site-layout-links';
import { FACADE_Z, depotStationPlacement, lotOf } from '../site-layout-grid';
import type { LayoutInsight } from '../site-layout-data';

const connector = (overrides: Record<string, unknown> = {}) => ({
  connectorId: 1,
  connectorType: 'CCS2',
  maxPowerKw: 150,
  status: 'available',
  isPluggedIn: false,
  energyDeliveredWh: null,
  ...overrides,
});

function station(overrides: Partial<LayoutStation> = {}): LayoutStation {
  return {
    id: 'sta_1',
    stationId: 'CS-1',
    model: 'Terra 184',
    status: 'charging',
    statusReason: null,
    isOnline: true,
    securityProfile: 1,
    positionX: 20,
    positionY: 20,
    placed: true,
    chargingKind: 'dc',
    cellular: false,
    inMaintenance: false,
    displayMessage: null,
    evses: [
      {
        evseId: 1,
        status: 'charging',
        connectors: [
          connector({ status: 'charging', isPluggedIn: true, energyDeliveredWh: 18400 }),
          connector({
            connectorId: 2,
            connectorType: 'CHAdeMO',
            maxPowerKw: 50,
            status: 'reserved',
          }),
        ],
      },
    ],
    ...overrides,
  };
}

// The default lot with one service transformer of the site at its default place.
const SETTINGS: PlacedLayoutSettings = placePowerEquipment(effectiveLayoutSettings(null), {
  transformers: [
    {
      id: 'tx-1',
      kind: 'service',
      name: 'Utility Transformer',
      ratedKva: null,
      maxContinuousKw: null,
    },
  ],
  energyAssets: [],
});

function renderView(
  stations: LayoutStation[],
  props: Partial<{
    editing: boolean;
    onMove: () => void;
    onTransformerMove: () => void;
    onFreeMove: (...args: unknown[]) => void;
    onSolarMove: (...args: unknown[]) => void;
    onUnavailable: () => void;
    settings: PlacedLayoutSettings;
    terminals: Map<string, LayoutTerminal[]>;
    hierarchy: LinkPanel[] | null;
    loadManaged: boolean;
    logoUrl: string | null;
    insights: Map<string, LayoutInsight[]>;
    replaying: boolean;
    drawKw: (id: string) => number | undefined;
    fullScreenFooter: React.ReactNode;
    onFullScreenChange: (on: boolean) => void;
    california: boolean;
    liveOcppSiteId: string;
  }> = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onMove = props.onMove ?? vi.fn();
  const onTransformerMove = props.onTransformerMove ?? vi.fn();
  const onUnavailable = props.onUnavailable ?? vi.fn();
  const element = () => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SiteLayout3D
          stations={stations}
          settings={props.settings ?? SETTINGS}
          terminals={props.terminals ?? new Map()}
          hierarchy={props.hierarchy ?? null}
          loadManaged={props.loadManaged ?? true}
          logoUrl={props.logoUrl ?? null}
          {...(props.california != null ? { california: props.california } : {})}
          editing={props.editing ?? false}
          fitKey={0}
          currentDrawKw={props.drawKw ?? (() => 96.5)}
          allocatedLimitKw={() => 120}
          insights={props.insights}
          replaying={props.replaying ?? false}
          fullScreenFooter={props.fullScreenFooter}
          onFullScreenChange={props.onFullScreenChange}
          liveOcppSiteId={props.liveOcppSiteId}
          onMove={onMove}
          onTransformerMove={onTransformerMove}
          onFreeMove={props.onFreeMove}
          onSolarMove={props.onSolarMove}
          onUnavailable={onUnavailable}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const utils = render(element());
  return { ...utils, element, onMove, onTransformerMove, onUnavailable };
}

beforeEach(() => {
  mockLanguage.current = 'en';
  scene.callbacks = null;
  scene.stations = [];
  scene.editing = false;
  scene.fits = 0;
  scene.flow = new Map();
  scene.focused = [];
  scene.nudges = [];
  scene.pointDistance = 20;
  scene.pxPerMeter = 1000;
  scene.markerXs = new Map();
  createScene.mockImplementation((_container: HTMLElement, _opts: unknown, cb: SceneCallbacks) => {
    if (scene.throwOnCreate) throw new Error('Error creating WebGL context');
    scene.callbacks = cb;
    return {
      setLayout: (layout: {
        stations: typeof scene.stations;
        lot: { cols: number; rows: number };
        transformers: typeof scene.transformers;
        batteries: typeof scene.batteries;
        solar: typeof scene.solar;
        panels: typeof scene.panels;
        links: typeof scene.links;
        california?: boolean;
      }) => {
        scene.stations = layout.stations;
        scene.lot = layout.lot;
        scene.transformers = layout.transformers;
        scene.batteries = layout.batteries;
        scene.solar = layout.solar;
        scene.panels = layout.panels;
        scene.links = layout.links;
        scene.california = layout.california;
      },
      setLogo: (url: string | null) => {
        scene.logo = url;
      },
      transformerLabelPoint: () => ({ x: 300, y: 60, depth: 0.6, distance: 20, visible: true }),
      linkLabelPoint: () => ({ x: 500, y: 200, depth: 0.7, distance: 20, visible: true }),
      virtualSignPoint: () => ({ x: 240, y: 140, depth: 0.5, distance: 20, visible: true }),
      setLinkFlow: (flow: ReadonlyMap<string, number>) => {
        scene.flow = flow;
      },
      focus: (id: string) => {
        scene.focused.push(id);
      },
      nudgeCamera: (n: {
        forward: number;
        right: number;
        yaw: number;
        pitch: number;
        zoom: number;
      }) => {
        scene.nudges.push(n);
      },
      viewDistance: () => 10,
      energyLabelPoint: () => ({ x: 400, y: 80, depth: 0.6, distance: 20, visible: true }),
      avatarPoint: () => ({
        x: 120,
        y: 160,
        depth: 0.4,
        distance: scene.pointDistance,
        pxPerMeter: scene.pxPerMeter,
        visible: true,
      }),
      setTheme: setThemeMock,
      setEditing: (e: boolean) => {
        scene.editing = e;
      },
      setSelected: vi.fn(),
      setSelectedSolar: vi.fn(),
      fit: () => {
        scene.fits += 1;
      },
      labelPoint: (id: string) => {
        if (!scene.markerXs.has(id)) scene.markerXs.set(id, 100 + 60 * scene.markerXs.size);
        return {
          x: scene.markerXs.get(id) ?? 100,
          y: 100,
          depth: 0.5,
          distance: scene.pointDistance,
          pxPerMeter: scene.pxPerMeter,
          visible: true,
        };
      },
      setActive: (a: boolean) => {
        scene.active = a;
      },
      dispose: vi.fn(),
    };
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  permissions.clear();
  scene.throwOnCreate = false;
  vi.clearAllMocks();
});

describe('SiteLayout3D', () => {
  it('maps stored px positions to bays of the 2D grid, never two stations in one bay', () => {
    const bays = stationBays(
      [
        station({ id: 'a', positionX: 20, positionY: 20 }),
        station({ id: 'b', positionX: 420, positionY: 160 }),
        station({ id: 'c', positionX: 30, positionY: 25 }),
        // Past the last column of the lot: it stays on the grass beside it.
        station({ id: 'd', positionX: 2420, positionY: 20 }),
      ],
      SETTINGS,
    );
    expect(bays.get('a')).toEqual({ col: 0, row: 0 });
    expect(bays.get('b')).toEqual({ col: 2, row: 1 });
    expect(bays.get('c')).not.toEqual({ col: 0, row: 0 });
    expect(bays.get('d')).toEqual({ col: 12, row: 0 });
  });

  it('builds the scene with each station, its bay and its state light, and fits the view', () => {
    renderView([
      station(),
      station({ id: 'sta_2', stationId: 'CS-2', status: 'faulted', positionX: 220 }),
    ]);
    expect(scene.stations.map((s) => s.id)).toEqual(['sta_1', 'sta_2']);
    expect(scene.stations[1]?.bay).toEqual({ col: 1, row: 0 });
    // A reserved connector outranks charging; a faulted station shows the faulted color.
    expect(scene.stations[0]?.lightColor).toBe('#f97316');
    expect(scene.stations[1]?.lightColor).toBe('#ef4444');
    expect(scene.fits).toBe(1);
    expect(scene.lot).toMatchObject({ cols: 10, rows: 2 });
    // The default lot has one transformer on the grass and no links without load management.
    expect(scene.transformers).toHaveLength(1);
    expect(scene.links.segments).toEqual([]);
    // A reservation stands no physical sign in the spot: a virtual sign floats over it.
    // Both stations have a connector plugged in, so a car stands in each (also faulted).
    expect(scene.stations.map((s) => s.prop)).toEqual(['car', 'car']);
    expect(scene.stations.map((s) => s.virtualSign)).toEqual(['reserved', null]);
    // The sign faces get their texts in the viewer's language.
    expect(setThemeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        signs: {
          chargingOnly: 'sites.layoutSigns.chargingOnly',
          towAway: 'sites.layoutSigns.towAway',
          reserved: 'sites.layoutSigns.reserved',
          maintenance: 'sites.layoutSigns.maintenance',
          rfidTap: 'sites.layoutSigns.rfidTap',
        },
      }),
    );
  });

  it('paints the charger plates in the AC and DC colors of the company branding', async () => {
    getMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/v1/portal/branding'
          ? { chargerColorAc: '#112233', chargerColorDc: '#ff8800' }
          : {},
      ),
    );
    renderView([station()]);
    // The brand default until the branding loads, then the company's own colors.
    expect(setThemeMock).toHaveBeenCalledWith(
      expect.objectContaining({ plateColors: { ac: '#2563eb', dc: '#2563eb' } }),
    );
    await waitFor(() => {
      expect(setThemeMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ plateColors: { ac: '#112233', dc: '#ff8800' } }),
      );
    });
    getMock.mockReset();
  });

  it('redraws the sign faces when the language changes', () => {
    const view = renderView([station()]);
    setThemeMock.mockClear();
    mockLanguage.current = 'ko';
    view.rerender(view.element());
    const themes = setThemeMock.mock.calls.map((c) => c[0] as { signs: { chargingOnly: string } });
    expect(themes.at(-1)?.signs.chargingOnly).toBe('ko:sites.layoutSigns.chargingOnly');
  });

  it('shows the time window of a virtual status sign only while it is hovered', () => {
    renderView([
      station({
        status: 'reserved',
        reservation: { startsAt: null, endsAt: '2026-11-01T15:00:00Z' },
      }),
    ]);
    const tip = screen.getByTestId('site-layout-3d-virtual-sign-sta_1');
    expect(tip.getAttribute('role')).toBe('tooltip');
    expect(tip.textContent).toBe('sites.layoutSigns.reservedUntil:CS-1');
    act(() => {
      scene.callbacks?.onFrame();
    });
    expect(tip.style.visibility).toBe('hidden');
    act(() => {
      scene.callbacks?.onEquipmentHover?.('virtual:sta_1');
      scene.callbacks?.onFrame();
    });
    expect(tip.style.visibility).toBe('visible');
  });

  it('gives a charging station a car and a station in maintenance a cone', () => {
    renderView([
      station({
        evses: [{ evseId: 1, status: 'charging', connectors: [connector({ status: 'charging' })] }],
      }),
      station({ id: 'sta_2', stationId: 'CS-2', inMaintenance: true, positionX: 220, evses: [] }),
      station({ id: 'sta_3', stationId: 'CS-3', status: 'available', positionX: 420, evses: [] }),
    ]);
    expect(scene.stations.map((s) => s.prop)).toEqual(['car', 'cone', null]);
  });

  it('keeps the car of a plugged connector after a fault, on every EVSE that has one', () => {
    renderView([
      station({
        status: 'faulted',
        evses: [
          {
            evseId: 1,
            status: 'faulted',
            connectors: [connector({ status: 'faulted', isPluggedIn: true })],
          },
        ],
      }),
      station({
        id: 'sta_2',
        stationId: 'CS-2',
        status: 'available',
        positionX: 220,
        evses: [
          {
            evseId: 1,
            status: 'suspended_ev',
            connectors: [connector({ status: 'suspended_ev', isPluggedIn: true })],
          },
        ],
      }),
      station({
        id: 'sta_3',
        stationId: 'CS-3',
        status: 'available',
        positionX: 420,
        evses: [{ evseId: 1, status: 'available', connectors: [connector({})] }],
      }),
    ]);
    expect(scene.stations.map((s) => s.prop)).toEqual(['car', 'car', null]);
  });

  it('shows every station as a state marker without a name or state label, and the ID and state on hover', () => {
    renderView([
      station({
        cellular: true,
        connectionType: 'cellular',
        signal: { bars: 3, dbm: -78 },
        placed: false,
      }),
    ]);
    const box = screen.getByTestId('site-layout-3d-station-sta_1');
    // No station name or state text on the layout: the marker in the state color only.
    expect(box.textContent).toBe('');
    expect(screen.queryByTestId('station-state-text')).toBeNull();
    expect(box.querySelector('[data-testid="connection-badge"]')).toBeNull();
    expect(box.querySelector('[data-testid="new-placement-tag"]')).toBeNull();
    const marker = screen.getByTestId('site-layout-3d-marker-sta_1');
    expect(marker.getAttribute('data-state')).toBe('reserved');
    // The icon on a solid white round background, no border or ring; 24 px up close.
    expect(marker.style.borderColor).toBe('');
    expect(marker.className).toContain('bg-white');
    expect(marker.className).not.toContain('bg-card');
    expect(marker.className).toContain('rounded-full');
    expect(marker.className).not.toMatch(/\bborder\b|border-2|(?<!:)\bring-[0-9]\b|bg-transparent/);
    expect(marker.className).toContain('h-6 w-6');
    expect(marker.querySelector('svg')).not.toBeNull();
    expect(stationStateTextColor('reserved')).toContain('#f97316');
    act(() => {
      scene.callbacks?.onFrame();
    });
    expect(box.style.visibility).toBe('visible');
    // A mouse over the marker shows the ID, the state and the connection with its signal bars.
    expect(screen.queryByTestId('site-layout-3d-tooltip')).toBeNull();
    fireEvent.pointerEnter(marker, { pointerType: 'mouse' });
    const tip = screen.getByTestId('site-layout-3d-tooltip');
    expect(tip.textContent).toContain('CS-1·sites.layoutState.reserved');
    const badge = tip.querySelector('[data-testid="connection-badge"]');
    expect(badge?.getAttribute('data-connection')).toBe('cellular');
    expect(badge?.querySelector('[data-bars="3"]')).not.toBeNull();
    fireEvent.pointerLeave(marker, { pointerType: 'mouse' });
    expect(screen.queryByTestId('site-layout-3d-tooltip')).toBeNull();
    // A touch shows no tooltip.
    fireEvent.pointerEnter(marker, { pointerType: 'touch' });
    expect(screen.queryByTestId('site-layout-3d-tooltip')).toBeNull();
    // The marker opens the details, also from the keyboard; its name holds the state.
    const chip = screen.getByRole('button', {
      name: 'sites.layoutView.stateDetailsLabel:CS-1:sites.layoutState.reserved',
    });
    expect(chip).toBe(marker);
    chip.focus();
    fireEvent.click(chip);
    const popup = screen.getByTestId('station-layout-popup');
    // Focus moves into the popup, and back to the marker when Escape closes it.
    expect(popup.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('station-layout-popup')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it('shows the tooltip for the station under a mouse pointer in the scene', () => {
    renderView([station(), station({ id: 'sta_2', stationId: 'CS-2', status: 'faulted' })]);
    act(() => {
      scene.callbacks?.onHover?.('sta_2');
    });
    expect(screen.getByTestId('site-layout-3d-tooltip').textContent).toContain(
      'CS-2·sites.layoutState.faulted',
    );
    act(() => {
      scene.callbacks?.onHover?.(null);
    });
    expect(screen.queryByTestId('site-layout-3d-tooltip')).toBeNull();
  });

  it('opens the popup with the station details on a click', () => {
    renderView([
      station({
        status: 'faulted',
        statusReason: 'station_faulted',
        inMaintenance: true,
        connectionType: 'wifi_or_wired',
        ocppVersion: '2.1',
      }),
    ]);
    act(() => {
      scene.callbacks?.onPick('sta_1');
    });
    const popup = screen.getByTestId('station-layout-popup');
    expect(popup.textContent).toContain('CS-1');
    expect(popup.textContent).toContain('Terra 184');
    expect(popup.textContent).toContain('sites.layoutView.dcFast');
    expect(popup.textContent).toContain('status.faulted');
    expect(popup.textContent).toContain('stations.statusReason.station_faulted');
    expect(popup.textContent).toContain('96.5 / 150 kW');
    expect(popup.textContent).toContain('sites.layoutView.allocatedLimit');
    expect(popup.textContent).toContain('dataPlan.plans.wifi_or_wired');
    expect(popup.textContent).toContain('stations.ocppProtocol2.1');
    expect(popup.textContent).toContain('sites.layoutView.evse:1');
    expect(popup.querySelector('[data-status="charging"]')).not.toBeNull();
    expect(popup.querySelector('[data-status="reserved"]')).not.toBeNull();
    const link = screen.getByRole('link', { name: 'sites.layoutView.openStation' });
    expect(link.getAttribute('href')).toBe('/stations/sta_1');
    // Only the branding (the charger plate colors, a query the layout page shares) is read.
    expect(getMock.mock.calls.filter((c) => c[0] !== '/v1/portal/branding')).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    expect(screen.queryByTestId('station-layout-popup')).toBeNull();
  });

  it('shows the reported network type, signal bars and OCPP version from the layout reply, no extra request', () => {
    renderView([
      station({
        cellular: true,
        connectionType: 'cellular',
        networkType: 'LTE-M',
        signal: { bars: 3, dbm: -78 },
        ocppVersion: '2.0.1',
      }),
    ]);
    act(() => {
      scene.callbacks?.onPick('sta_1');
    });
    const popup = screen.getByTestId('station-layout-popup');
    expect(within(popup).getByTestId('layout-connection').textContent).toContain('LTE-M');
    expect(within(popup).getByTestId('layout-signal').textContent).toBe('-78 dBm');
    expect(within(popup).getByTestId('layout-ocpp-version').textContent).toBe('2.0.1');
    // Only the branding (the charger plate colors, a query the layout page shares) is read.
    expect(getMock.mock.calls.filter((c) => c[0] !== '/v1/portal/branding')).toEqual([]);
  });

  it('shows the data plan without signal bars when no strength is known, and none for a wired station', () => {
    renderView([
      station({ cellular: true, connectionType: 'cellular', signal: null, ocppVersion: null }),
      station({
        id: 'sta_2',
        stationId: 'CS-2',
        positionX: 220,
        connectionType: 'wifi_or_wired',
        // A wired station never shows a signal, even when one is sent.
        signal: { bars: 4, dbm: -60 },
      }),
    ]);
    act(() => {
      scene.callbacks?.onPick('sta_1');
    });
    let popup = screen.getByTestId('station-layout-popup');
    expect(within(popup).getByTestId('layout-connection').textContent).toContain(
      'dataPlan.plans.cellular',
    );
    expect(within(popup).queryByTestId('layout-signal')).toBeNull();
    expect(within(popup).queryByTestId('layout-ocpp-version')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    act(() => {
      scene.callbacks?.onPick('sta_2');
    });
    popup = screen.getByTestId('station-layout-popup');
    expect(within(popup).getByTestId('layout-connection').textContent).toContain(
      'dataPlan.plans.wifi_or_wired',
    );
    expect(within(popup).queryByTestId('layout-signal')).toBeNull();
  });

  it('shows the edit hint in edit mode and drops a dragged station on the nearest free bay', () => {
    const onMove = vi.fn();
    renderView(
      [station({ positionX: 620 }), station({ id: 'sta_2', stationId: 'CS-2', positionX: 220 })],
      { editing: true, onMove },
    );
    expect(scene.editing).toBe(true);
    expect(screen.getByText('sites.layoutView.hintEdit')).toBeDefined();
    // The bay of the other station is taken: the nearest free bay, (0, 0), wins.
    expect(scene.callbacks?.isBayTaken({ col: 1, row: 0 }, 'sta_1')).toBe(true);
    act(() => {
      scene.callbacks?.onDrop('sta_1', { col: 1, row: 0 });
    });
    expect(onMove).toHaveBeenLastCalledWith('sta_1', 20, 20);
    act(() => {
      scene.callbacks?.onDrop('sta_1', { col: 3, row: 1 });
    });
    expect(onMove).toHaveBeenLastCalledWith('sta_1', 620, 160);
    // A drop past the lot lands on its last spot.
    act(() => {
      scene.callbacks?.onDrop('sta_1', { col: 40, row: 30 });
    });
    expect(onMove).toHaveBeenLastCalledWith('sta_1', 1820, 160);
    // Clicks open no popup in edit mode.
    act(() => {
      scene.callbacks?.onPick('sta_1');
    });
    expect(screen.queryByTestId('station-layout-popup')).toBeNull();
  });

  it('keeps a dragged transformer on the grass and reports where it was dropped', () => {
    const onTransformerMove = vi.fn();
    renderView([station()], { editing: true, onTransformerMove });
    // A point in the middle of the lot moves to the nearest lot side.
    const snapped = scene.callbacks?.snapTransformer({ x: 16, z: 1 });
    expect(snapped).toEqual({ x: 16, z: -2.5 });
    act(() => {
      scene.callbacks?.onTransformerDrop('tx-1', { x: 40, z: 3 });
    });
    expect(onTransformerMove).toHaveBeenCalledWith('tx-1', 40, 3);
  });

  it('labels a transformer with its name and rated kVA', () => {
    renderView([station()], {
      settings: {
        ...SETTINGS,
        transformers: [
          {
            id: 'tx-9',
            name: 'Main Feed',
            ratedKva: 2500,
            kind: 'service' as const,
            maxContinuousKw: null,
            x: 40,
            z: 3,
          },
        ],
      },
    });
    expect(screen.getByTestId('site-layout-3d-transformer-tx-9').textContent).toContain(
      'Main Feed',
    );
    expect(screen.getByTestId('site-layout-3d-transformer-tx-9').textContent).toContain(
      '2,500 kVA',
    );
  });

  it('shows a power equipment label only while its equipment is hovered or tapped', () => {
    const hierarchy: LinkPanel[] = [
      {
        id: 'p1',
        name: 'Main Panel',
        breakerRatingAmps: 400,
        maxContinuousKw: 230.4,
        childPanels: [],
        circuits: [
          {
            id: 'c1',
            name: 'Circuit 1',
            breakerRatingAmps: 200,
            maxContinuousKw: 115.2,
            stations: [{ id: 'sta_1', allocatedLimitKw: 50 }],
          },
        ],
      },
    ];
    renderView([station()], {
      hierarchy,
      settings: {
        ...SETTINGS,
        transformers: [
          {
            id: 'tx-9',
            name: 'Main Feed',
            ratedKva: 2500,
            kind: 'service' as const,
            maxContinuousKw: null,
            x: 40,
            z: 3,
          },
        ],
      },
    });
    const panel = screen.getByTestId('site-layout-3d-link-panel:p1');
    const circuit = screen.getByTestId('site-layout-3d-link-circuit:c1');
    const transformer = screen.getByTestId('site-layout-3d-transformer-tx-9');
    act(() => {
      scene.callbacks?.onFrame();
    });
    // Nothing always on.
    for (const el of [panel, circuit, transformer]) expect(el.style.visibility).toBe('hidden');
    act(() => {
      scene.callbacks?.onEquipmentHover?.('circuit:c1');
      scene.callbacks?.onFrame();
    });
    expect(circuit.style.visibility).toBe('visible');
    expect(panel.style.visibility).toBe('hidden');
    act(() => {
      scene.callbacks?.onEquipmentHover?.('transformer:tx-9');
      scene.callbacks?.onFrame();
    });
    expect(transformer.style.visibility).toBe('visible');
    expect(circuit.style.visibility).toBe('hidden');
    act(() => {
      scene.callbacks?.onEquipmentHover?.(null);
      scene.callbacks?.onFrame();
    });
    expect(transformer.style.visibility).toBe('hidden');
  });

  it('passes the California tow-away sign rule to the scene only for a California site', () => {
    renderView([station()]);
    expect(scene.california).toBe(false);
    cleanup();
    renderView([station()], { california: true });
    expect(scene.california).toBe(true);
  });

  it('draws load management links with labels only while the site is load managed', () => {
    const hierarchy: LinkPanel[] = [
      {
        id: 'p1',
        name: 'Main Panel',
        breakerRatingAmps: 400,
        maxContinuousKw: 230.4,
        childPanels: [],
        circuits: [
          {
            id: 'c1',
            name: 'Circuit 1',
            breakerRatingAmps: 200,
            maxContinuousKw: 115.2,
            stations: [{ id: 'sta_1', allocatedLimitKw: 50 }],
          },
        ],
      },
    ];
    renderView([station()], { hierarchy });
    // Cable runs on the ground: the transformer's service cable into the panel,
    // the circuit's trunk and its row run, and the branch to the station.
    expect([
      ...new Set((scene.links.segments as Array<{ flowId: string }>).map((s) => s.flowId)),
    ]).toEqual(['panel:p1', 'circuit:c1', 'station:sta_1']);
    expect(scene.panels).toEqual([expect.objectContaining({ id: 'p1' })]);
    expect(screen.getByTestId('site-layout-3d-link-panel:p1').textContent).toBe(
      'Main Panel · 400 A · 230.4 kW',
    );
    expect(screen.getByTestId('site-layout-3d-link-station:sta_1').textContent).toBe('50.0 kW');
    expect(
      linkLabelText({
        id: 'x',
        kind: 'circuit',
        point: { x: 0, z: 0 },
        name: 'C',
        amps: 32,
        kw: null,
      }),
    ).toBe('C · 32 A');
  });

  it('shows the panels without links while load management is off', () => {
    const hierarchy: LinkPanel[] = [
      {
        id: 'p1',
        name: 'Main Panel',
        breakerRatingAmps: 400,
        maxContinuousKw: 230.4,
        childPanels: [],
        circuits: [
          {
            id: 'c1',
            name: 'Circuit 1',
            breakerRatingAmps: 200,
            maxContinuousKw: 115.2,
            stations: [{ id: 'sta_1', allocatedLimitKw: 50 }],
          },
        ],
      },
    ];
    renderView([station()], { hierarchy, loadManaged: false, drawKw: () => 85 });
    // The equipment stands; no cable run, no glow, no flow.
    expect(scene.panels).toEqual([expect.objectContaining({ id: 'p1' })]);
    expect(scene.links.segments).toEqual([]);
    // Its hover label names it and its rating only, no live power.
    expect(screen.getByTestId('site-layout-3d-link-panel:p1').textContent).toBe(
      'Main Panel · 400 A',
    );
    expect(screen.queryByTestId('panel-load-bar')).toBeNull();
    expect(screen.queryByTestId('site-layout-3d-link-circuit:c1')).toBeNull();
    expect(screen.queryByTestId('site-layout-3d-link-station:sta_1')).toBeNull();
  });

  it('shows no panel and no link without the panels (no load management permission)', () => {
    renderView([station()], { hierarchy: null });
    expect(scene.panels).toEqual([]);
    expect(scene.links.segments).toEqual([]);
  });

  it('shows an office or retail site with wall boxes and its AC panelboard on the facade, no transformers', () => {
    const hierarchy: LinkPanel[] = [
      {
        id: 'p1',
        name: 'Retail Panel',
        breakerRatingAmps: 200,
        maxContinuousKw: 57.6,
        childPanels: [],
        circuits: [
          {
            id: 'c1',
            name: 'Level 2',
            breakerRatingAmps: 100,
            maxContinuousKw: 28.8,
            stations: [{ id: 'sta_ac', allocatedLimitKw: 11 }],
          },
        ],
      },
    ];
    renderView(
      [
        station({ id: 'sta_ac', stationId: 'CS-AC', chargingKind: 'ac' }),
        station({ id: 'sta_dc', stationId: 'CS-DC', positionX: 220 }),
        station({ id: 'sta_back', stationId: 'CS-B', chargingKind: 'ac', positionY: 160 }),
      ],
      {
        hierarchy,
        settings: {
          ...SETTINGS,
          siteType: 'office_retail',
          chargers: 2,
          mounting: 'wall',
          transformers: [
            {
              id: 'tx-9',
              name: 'Kept',
              ratedKva: 500,
              kind: 'service' as const,
              maxContinuousKw: null,
              x: 40,
              z: 3,
            },
          ],
        },
      },
    );
    expect(scene.lot).toMatchObject({ siteType: 'office_retail' });
    // The stored transformer stays in the settings but is not shown.
    expect(scene.transformers).toEqual([]);
    expect(screen.queryByTestId('site-layout-3d-transformer-tx-9')).toBeNull();
    // An AC charger of the row hangs on the facade; DC and a station off the row stand at the curb.
    expect(scene.stations.map((s) => [s.id, s.wall])).toEqual([
      ['sta_ac', true],
      ['sta_dc', false],
      ['sta_back', false],
    ]);
    // The AC panelboard hangs on the facade half a stall left of its wall box,
    // with a run along the foot of the facade and a branch up to the box.
    expect(scene.panels).toEqual([{ id: 'p1', x: 0, z: FACADE_Z, model: 'wall', turn: 0 }]);
    expect(scene.links.segments).toMatchObject([
      { id: 'circuit:c1:sta_ac' },
      { id: 'station:sta_ac' },
    ]);
  });

  it('stands every charger of a stall-mounted office or retail row on a post', () => {
    renderView([station({ id: 'sta_ac', stationId: 'CS-AC', chargingKind: 'ac' })], {
      settings: { ...SETTINGS, siteType: 'office_retail', chargers: 4, mounting: 'stall' },
    });
    expect(scene.lot).toMatchObject({ siteType: 'office_retail', mounting: 'stall', rows: 1 });
    expect(scene.stations[0]?.wall).toBe(false);
  });

  it('shows a curbside street with chargers on both curbs and nothing else', () => {
    renderView(
      [
        station({ id: 'sta_l', stationId: 'CS-L', chargingKind: 'ac' }),
        station({ id: 'sta_r', stationId: 'CS-R', chargingKind: 'ac', positionY: 160 }),
      ],
      {
        settings: {
          ...SETTINGS,
          siteType: 'curbside',
          chargersLeft: 4,
          chargersRight: 4,
          energyAssets: [
            { id: 'bat-1', type: 'battery', name: 'Battery', capacityKwh: 100, x: 4, z: -6 },
          ],
        },
      },
    );
    expect(scene.lot).toMatchObject({ siteType: 'curbside', rowLengths: [4, 4] });
    expect(scene.stations.map((s) => [s.id, s.bay, s.wall])).toEqual([
      ['sta_l', { col: 0, row: 0 }, false],
      ['sta_r', { col: 0, row: 1 }, false],
    ]);
    expect(scene.transformers).toEqual([]);
    expect(scene.batteries).toEqual([]);
    expect(scene.solar).toEqual([]);
    expect(scene.panels).toEqual([]);
  });

  it('shows transformers on a parking lot', () => {
    renderView([station()], { settings: { ...SETTINGS, siteType: 'parking_lot' } });
    expect(scene.transformers).toHaveLength(1);
    expect(scene.stations[0]?.wall).toBe(false);
  });

  it('lights the charging glow only on a charging station', () => {
    renderView([
      station({
        evses: [{ evseId: 1, status: 'charging', connectors: [connector({ status: 'charging' })] }],
      }),
      station({ id: 'sta_2', stationId: 'CS-2', status: 'available', positionX: 220, evses: [] }),
      station({ id: 'sta_3', stationId: 'CS-3', isOnline: false, positionX: 420, evses: [] }),
    ]);
    expect(scene.stations.map((s) => s.glow)).toEqual([true, false, false]);
  });

  it('pauses the scene while the browser tab is hidden', () => {
    renderView([station()]);
    expect(scene.active).toBe(true);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(scene.active).toBe(false);
    visibility.mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(scene.active).toBe(true);
    visibility.mockRestore();
  });

  it('puts a paired payment terminal on its connector side and lists it in the popup', () => {
    const terminals = new Map<string, LayoutTerminal[]>([
      [
        'sta_1',
        [
          {
            id: 'pt_1',
            name: 'VP6825 Bay 1',
            stationId: 'sta_1',
            evseNumber: 1,
            hasDisplay: true,
            online: true,
          },
          {
            id: 'pt_2',
            name: 'VP7200',
            stationId: 'sta_1',
            evseNumber: null,
            hasDisplay: false,
            online: false,
          },
        ],
      ],
    ]);
    renderView([station(), station({ id: 'sta_2', stationId: 'CS-2', positionX: 220 })], {
      terminals,
    });
    expect(scene.stations[0]?.terminals).toEqual([
      { id: 'pt_1', side: -1, hasDisplay: true, online: true },
      { id: 'pt_2', side: 0, hasDisplay: false, online: false },
    ]);
    expect(scene.stations[1]?.terminals).toEqual([]);
    act(() => {
      scene.callbacks?.onPick('sta_1');
    });
    const list = screen.getByRole('list', { name: 'sites.layoutView.paymentTerminals' });
    expect(list.textContent).toContain('VP6825 Bay 1');
    expect(list.textContent).toContain('status.online');
    expect(list.textContent).toContain('status.offline');
  });

  it('hands the company logo to the scene', () => {
    renderView([station()], { logoUrl: 'data:image/png;base64,AAAA' });
    expect(scene.logo).toBe('data:image/png;base64,AAAA');
  });

  it('tells the parent when the browser refuses a WebGL context', () => {
    scene.throwOnCreate = true;
    const { onUnavailable } = renderView([station()]);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('blinks the red status light of a faulted station only, with no beacon', () => {
    renderView([
      station(),
      station({ id: 'sta_2', stationId: 'CS-2', status: 'faulted', positionX: 220 }),
    ]);
    expect(scene.stations.map((s) => s.blinking)).toEqual([false, true]);
    // The faulted light takes the faulted state color, not the available one.
    const [available, faulted] = scene.stations;
    expect(faulted?.lightColor).toBe(resolveCssColor(stationStateColor('faulted')));
    expect(faulted?.lightColor).not.toBe(available?.lightColor);
    expect(scene.stations.some((s) => 'beacon' in s)).toBe(false);
  });

  it('feeds the live power to the links and shows each panel draw against its limit', () => {
    const hierarchy: LinkPanel[] = [
      {
        id: 'p1',
        name: 'Main Panel',
        breakerRatingAmps: 400,
        maxContinuousKw: 100,
        childPanels: [],
        circuits: [
          {
            id: 'c1',
            name: 'Circuit 1',
            breakerRatingAmps: 200,
            maxContinuousKw: 100,
            stations: [{ id: 'sta_1', allocatedLimitKw: 100 }],
          },
        ],
      },
    ];
    const { unmount } = renderView([station()], { hierarchy, drawKw: () => 85 });
    expect(scene.flow.get('station:sta_1')).toBeCloseTo(0.85);
    expect(scene.flow.get('circuit:c1')).toBeCloseTo(0.85);
    const bar = screen.getByTestId('panel-load-bar');
    expect(bar.getAttribute('data-level')).toBe('near');
    expect(bar.getAttribute('aria-valuenow')).toBe('85');
    unmount();
    renderView([station()], { hierarchy, drawKw: () => 120 });
    expect(screen.getByTestId('panel-load-bar').getAttribute('data-level')).toBe('at');
  });

  it('marks a station with an open AI insight with a link to it, never while replaying', () => {
    const insights = new Map([
      ['sta_1', [{ id: 'ins_1', headline: 'CS-1 keeps faulting', path: '/ai/insights/ins_1' }]],
    ]);
    const { unmount } = renderView([station()], { insights });
    const marker = screen.getByTestId('site-layout-3d-insight-sta_1');
    expect(marker.getAttribute('href')).toBe('/ai/insights/ins_1');
    unmount();
    renderView([station()], { insights, replaying: true });
    expect(screen.queryByTestId('site-layout-3d-insight-sta_1')).toBeNull();
  });

  it('counts faulted, offline and charging stations and turns to the next one of a state', () => {
    renderView([
      station(),
      station({ id: 'sta_2', stationId: 'CS-2', status: 'faulted', positionX: 220 }),
      station({ id: 'sta_3', stationId: 'CS-3', status: 'faulted', positionX: 420, evses: [] }),
      station({
        id: 'sta_4',
        stationId: 'CS-4',
        isOnline: false,
        status: 'available',
        positionX: 620,
        evses: [],
      }),
    ]);
    const summary = screen.getByTestId('site-layout-summary');
    expect(summary.textContent).toContain('2 sites.layoutState.faulted');
    expect(summary.textContent).toContain('1 sites.layoutState.offline');
    fireEvent.click(screen.getByTestId('site-layout-summary-faulted'));
    expect(scene.focused).toEqual(['sta_2']);
    expect(screen.getByTestId('station-layout-popup')).toBeTruthy();
    fireEvent.click(screen.getByTestId('site-layout-summary-faulted'));
    expect(scene.focused).toEqual(['sta_2', 'sta_3']);
  });

  it('opens the Live OCPP Commands window under the summary, filtered to a clicked station', async () => {
    getMock.mockResolvedValue({ data: [] });
    permissions.add('stations:read');
    renderView([station(), station({ id: 'sta_2', stationId: 'CS-2', status: 'faulted' })], {
      liveOcppSiteId: 'sit_aaaaaaaaaaaa',
    });
    expect(screen.queryByTestId('live-ocpp-window')).toBeNull();
    fireEvent.click(screen.getByTestId('live-ocpp-toggle'));
    expect(screen.getByTestId('live-ocpp-window')).toBeTruthy();
    await waitFor(() => {
      expect(String(getMock.mock.lastCall?.[0])).toContain(
        '/v1/sites/sit_aaaaaaaaaaaa/ocpp-messages',
      );
    });
    fireEvent.click(screen.getByTestId('site-layout-3d-marker-sta_2'));
    await waitFor(() => {
      expect(String(getMock.mock.lastCall?.[0])).toContain('stationId=sta_2');
    });
    fireEvent.click(screen.getByTestId('live-ocpp-close'));
    expect(screen.queryByTestId('live-ocpp-window')).toBeNull();
    permissions.delete('stations:read');
  });

  it('shows no Live OCPP Commands button without stations:read, while editing or without a site', () => {
    renderView([station()], { liveOcppSiteId: 'sit_aaaaaaaaaaaa' });
    expect(screen.queryByTestId('live-ocpp-toggle')).toBeNull();
    cleanup();
    permissions.add('stations:read');
    renderView([station()]);
    expect(screen.queryByTestId('live-ocpp-toggle')).toBeNull();
    cleanup();
    renderView([station()], { liveOcppSiteId: 'sit_aaaaaaaaaaaa', editing: true });
    expect(screen.queryByTestId('live-ocpp-toggle')).toBeNull();
    permissions.delete('stations:read');
  });

  it('makes the stage focusable with the keys in its name and a Keyboard help', () => {
    renderView([station()]);
    const stage = screen.getByTestId('site-layout-3d');
    expect(stage.tabIndex).toBe(0);
    expect(stage.getAttribute('aria-label')).toBe('sites.layoutView.keyboard.stageLabel');
    const help = screen.getByTestId('site-layout-keyboard-help');
    expect(stage.getAttribute('aria-describedby')).toBe(help.id);
    expect(help.className).toContain('sr-only');
    const toggle = screen.getByTestId('site-layout-keyboard-toggle');
    expect(toggle.getAttribute('aria-label')).toBe('sites.layoutView.keyboard.button');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(help.className).not.toContain('sr-only');
    expect(help.textContent).toContain('sites.layoutView.keyboard.moveKeys');
  });

  it('names the touch gestures in the hint on a touch screen', () => {
    renderView([station()]);
    expect(screen.getByText('sites.layoutView.hint')).toBeDefined();
    cleanup();
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)' }));
    renderView([station()]);
    expect(screen.getByText('sites.layoutView.hintTouch')).toBeDefined();
    expect(screen.getByTestId('site-layout-keyboard-help').textContent).toContain(
      'sites.layoutView.keyboard.pointerPanKeys',
    );
  });

  it('navigates only while the stage has the focus: arrows, Home', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    renderView([station()]);
    const stage = screen.getByTestId('site-layout-3d');
    const fitsBefore = scene.fits;
    fireEvent.keyDown(stage, { key: 'ArrowLeft' });
    expect(scene.nudges).toHaveLength(1);
    expect(scene.nudges[0]?.right).toBeLessThan(0);
    fireEvent.keyDown(stage, { key: 'Home' });
    expect(scene.fits).toBe(fitsBefore + 1);
    // A key from a button on the stage (the list toggle) is not navigation.
    fireEvent.keyDown(screen.getByTestId('site-layout-list-toggle'), { key: 'w', code: 'KeyW' });
    expect(scene.nudges).toHaveLength(1);
  });

  it('lists every station for the keyboard and focuses the one chosen', () => {
    renderView([station(), station({ id: 'sta_2', stationId: 'CS-2', positionX: 220 })]);
    expect(screen.queryByTestId('site-layout-station-list')).toBeNull();
    fireEvent.click(screen.getByTestId('site-layout-list-toggle'));
    expect(screen.getByTestId('site-layout-station-list').querySelectorAll('button')).toHaveLength(
      2,
    );
    fireEvent.click(screen.getByTestId('site-layout-list-sta_2'));
    expect(scene.focused).toEqual(['sta_2']);
    expect(screen.getByTestId('station-layout-popup')).toBeTruthy();
    expect(screen.getByTestId('site-layout-list-sta_2').getAttribute('aria-current')).toBe('true');
  });

  const chargingStation = (session: LayoutStation['session']) =>
    station({
      evses: [
        {
          evseId: 1,
          status: 'charging',
          connectors: [
            connector({ status: 'charging', isPluggedIn: true, energyDeliveredWh: 18400 }),
          ],
        },
      ],
      session,
    });

  it('floats the driver avatar over a charging car and opens the session popup', () => {
    renderView([
      chargingStation({
        id: 'ses_1',
        startedAt: new Date(Date.now() - 65 * 60_000).toISOString(),
        energyDeliveredWh: 18400,
        currentCostCents: 1234,
        currency: 'USD',
        driver: {
          id: 'drv_1',
          name: 'Jane Doe',
          avatar: { kind: 'generated', style: 'avataaars', seed: 'jane', options: {} },
        },
      }),
    ]);
    act(() => {
      scene.callbacks?.onFrame();
    });
    const button = screen.getByTestId('site-layout-3d-avatar-sta_1').querySelector('button');
    expect(button).not.toBeNull();
    // The avatar picture on a solid white round background: no border or ring.
    expect(button?.className).toContain('bg-white');
    expect(button?.className).toContain('h-7 w-7');
    expect(button?.className).not.toMatch(/\bborder\b|(?<!:)\bring-[0-9]\b|shadow-md|bg-card/);
    if (button != null) fireEvent.click(button);
    const popup = screen.getByTestId('session-layout-popup');
    expect(popup.textContent).toContain('Jane Doe');
    expect(screen.getByTestId('session-popup-energy').textContent).toContain('18.4');
    expect(screen.getByTestId('session-popup-cost').textContent).toContain('12.34');
    const links = [...popup.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/stations/sta_1', '/sessions/ses_1', '/drivers/drv_1']);
  });

  it('shows a session without the driver when drivers may not be read', () => {
    renderView([
      chargingStation({
        id: 'ses_1',
        startedAt: new Date().toISOString(),
        energyDeliveredWh: 100,
        currentCostCents: null,
        currency: 'USD',
        driver: null,
      }),
    ]);
    const button = screen.getByTestId('site-layout-3d-avatar-sta_1').querySelector('button');
    if (button != null) fireEvent.click(button);
    const popup = screen.getByTestId('session-layout-popup');
    expect(popup.querySelector('img')).toBeNull();
    expect([...popup.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      '/stations/sta_1',
      '/sessions/ses_1',
    ]);
  });

  it('shows only a plain marker without session data, live and while replaying', () => {
    const { unmount } = renderView([chargingStation(null)]);
    const marker = screen.getByTestId('site-layout-3d-avatar-sta_1');
    expect(marker.querySelector('button')).toBeNull();
    expect(marker.querySelector('img')).toBeNull();
    unmount();
    // A replayed moment draws the avatar marker the same way (the replay carries the session as live).
    renderView([chargingStation(null)], { replaying: true });
    const replayed = screen.getByTestId('site-layout-3d-avatar-sta_1');
    expect(replayed.querySelector('button')).toBeNull();
    expect(screen.getByText('sites.layoutView.hintReplay')).toBeTruthy();
  });

  it('scales the badges with the camera distance within the clamp, avatars hidden when crowded', () => {
    const session = {
      id: 'ses_1',
      startedAt: new Date(Date.now() - 65 * 60_000).toISOString(),
      energyDeliveredWh: 18400,
      currentCostCents: 1234,
      currency: 'USD',
      driver: { id: 'drv_1', name: 'Jane Doe', avatar: null },
    };
    renderView([chargingStation(session)]);
    const marker = screen.getByTestId('site-layout-3d-station-sta_1');
    const avatar = screen.getByTestId('site-layout-3d-avatar-sta_1');
    // Up close: full size (24 and 28 px), pinned at the bottom center.
    act(() => {
      scene.callbacks?.onFrame();
    });
    expect(marker.style.scale).toBe('1');
    expect(marker.style.transformOrigin).toBe('50% 100%');
    expect(avatar.style.scale).toBe('1');
    expect(avatar.style.visibility).toBe('visible');
    // Farther: the world size (0.9 m at 20 px per meter is 18 px of 24).
    scene.pxPerMeter = 20;
    act(() => {
      scene.callbacks?.onFrame();
    });
    expect(Number(marker.style.scale)).toBeCloseTo(18 / 24, 5);
    // Far: never under the readable minimum, 14 px for a marker, 16 px for an avatar.
    scene.pxPerMeter = 2;
    act(() => {
      scene.callbacks?.onFrame();
    });
    expect(Number(marker.style.scale)).toBeCloseTo(14 / 24, 5);
    expect(Number(avatar.style.scale)).toBeCloseTo(16 / 28, 5);
  });

  it('drops the driver avatars and keeps the state markers when markers overlap', () => {
    const session = {
      id: 'ses_1',
      startedAt: new Date(Date.now() - 65 * 60_000).toISOString(),
      energyDeliveredWh: 18400,
      currentCostCents: 1234,
      currency: 'USD',
      driver: { id: 'drv_1', name: 'Jane Doe', avatar: null },
    };
    renderView([
      chargingStation(session),
      station({ id: 'sta_2', stationId: 'CS-2', positionX: 220 }),
    ]);
    // jsdom lays nothing out: every badge measures 24 px here.
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(24);
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(24);
    // Both markers at one point: they overlap.
    scene.markerXs.set('sta_1', 100);
    scene.markerXs.set('sta_2', 104);
    act(() => {
      scene.callbacks?.onFrame();
    });
    expect(screen.getByTestId('site-layout-3d-station-sta_1').style.visibility).toBe('visible');
    expect(screen.getByTestId('site-layout-3d-station-sta_2').style.visibility).toBe('visible');
    expect(screen.getByTestId('site-layout-3d-avatar-sta_1').style.visibility).toBe('hidden');
    // Apart again: the avatar returns.
    scene.markerXs.set('sta_2', 400);
    act(() => {
      scene.callbacks?.onFrame();
    });
    expect(screen.getByTestId('site-layout-3d-avatar-sta_1').style.visibility).toBe('visible');
    width.mockRestore();
    height.mockRestore();
  });

  describe('depot departure labels', () => {
    const DEPOT_SITE: PlacedLayoutSettings = {
      ...SETTINGS,
      siteType: 'depot',
      busBays: 2,
      truckLanes: 1,
    };
    const departure = (
      planned: boolean,
    ): NonNullable<NonNullable<LayoutStation['session']>['departure']> => ({
      id: 'vdp_1',
      departureAt: '2026-11-03T13:30:00.000Z',
      timezone: 'America/Los_Angeles',
      readiness: planned ? 'at_risk' : null,
      reason: planned ? 'site_capacity' : null,
      targetKwh: 120,
      targetSocPercent: null,
      deliveredKwh: 45,
      shortfallKwh: planned ? 32 : null,
      predictedReadyAt: planned ? '2026-11-03T13:40:00.000Z' : null,
    });
    const withDeparture = (planned: boolean) =>
      chargingStation({
        id: 'ses_1',
        startedAt: new Date().toISOString(),
        energyDeliveredWh: 100,
        currentCostCents: null,
        currency: 'USD',
        driver: null,
        departure: departure(planned),
      });

    it('shows only the departure time while the depot plan does not run', () => {
      renderView([withDeparture(false)], { settings: DEPOT_SITE });
      const label = screen.getByTestId('site-layout-3d-departure-sta_1');
      expect(label.textContent).toBe('sites.layoutView.departs');
      const button = screen.getByTestId('site-layout-3d-avatar-sta_1').querySelector('button');
      if (button != null) fireEvent.click(button);
      expect(screen.getByTestId('session-popup-departure').textContent).toMatch(/5:30/);
      expect(screen.queryByTestId('session-popup-predicted-ready')).toBeNull();
      expect(screen.queryByTestId('session-popup-reason')).toBeNull();
    });

    it('adds the readiness in its state color while the plan runs', () => {
      renderView([withDeparture(true)], { settings: DEPOT_SITE });
      const state = screen.getByTestId('site-layout-3d-departure-state-sta_1');
      expect(state.textContent).toBe('sites.layoutView.atRiskShort');
      // The contrast-checked station state text color of maintenance (warning).
      expect(state.getAttribute('style')).toContain(stationStateTextColor('maintenance'));
      const button = screen.getByTestId('site-layout-3d-avatar-sta_1').querySelector('button');
      if (button != null) fireEvent.click(button);
      expect(screen.getByTestId('session-popup-predicted-ready').textContent).toMatch(/5:40/);
      expect(screen.getByTestId('session-popup-reason').textContent).toBe(
        'fleets.departures.reasons.site_capacity',
      );
    });

    it('shows no departure label on a site that is not a depot', () => {
      renderView([withDeparture(true)]);
      expect(screen.queryByTestId('site-layout-3d-departure-sta_1')).toBeNull();
    });
  });

  it('shows the state marker of every station on a large site, far ones too', () => {
    const many = Array.from({ length: 45 }, (_, i) =>
      station({
        id: `s${String(i)}`,
        stationId: `CS-${String(i)}`,
        positionX: 20 + (i % 12) * 200,
        positionY: 20 + Math.floor(i / 12) * 140,
      }),
    );
    scene.pointDistance = 200;
    renderView(many);
    act(() => {
      scene.callbacks?.onFrame();
    });
    for (const s of many) {
      expect(screen.getByTestId(`site-layout-3d-station-${s.id}`).style.visibility).toBe('visible');
    }
  });

  it('shows batteries and solar canopies on a parking lot only, with labels', () => {
    const energy = {
      ...SETTINGS,
      energyAssets: [
        {
          id: 'bat-1',
          type: 'battery' as const,
          name: 'Main Battery',
          capacityKwh: 1000,
          x: 4,
          z: -6,
        },
        { id: 'pv-1', type: 'solar' as const, name: 'Canopy', capacityKwp: 180, row: 1 },
      ],
    };
    const { unmount } = renderView([station()], { settings: energy });
    expect(scene.batteries).toEqual([{ id: 'bat-1', x: 4, z: -6 }]);
    expect(scene.solar).toEqual([{ id: 'pv-1', row: 1 }]);
    expect(screen.getByTestId('site-layout-3d-energy-bat-1').textContent).toBe(
      'Main Battery· 1,000 kWh',
    );
    expect(screen.getByTestId('site-layout-3d-energy-pv-1').textContent).toBe('Canopy· 180 kWp');
    unmount();
    renderView([station()], { settings: { ...energy, siteType: 'office_retail' } });
    expect(scene.batteries).toEqual([]);
    expect(scene.solar).toEqual([]);
    expect(screen.queryByTestId('site-layout-3d-energy-bat-1')).toBeNull();
    expect(screen.queryByTestId('site-layout-3d-energy-pv-1')).toBeNull();
  });

  it('fills the window when the browser has no element full screen, with the footer and a fit button, and leaves on Escape', () => {
    const onFullScreenChange = vi.fn();
    renderView([station()], {
      fullScreenFooter: <div data-testid="replay-footer">Replay</div>,
      onFullScreenChange,
    });
    const stage = screen.getByTestId('site-layout-3d');
    expect(stage.getAttribute('data-full-screen')).toBe('off');
    expect(screen.queryByTestId('replay-footer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'sites.layoutView.fullScreen' }));
    expect(stage.getAttribute('data-full-screen')).toBe('overlay');
    expect(stage.className).toContain('fixed');
    expect(screen.getByTestId('replay-footer')).toBeTruthy();
    expect(onFullScreenChange).toHaveBeenLastCalledWith(true);
    const fits = scene.fits;
    fireEvent.click(screen.getByTestId('site-layout-full-screen-fit'));
    expect(scene.fits).toBe(fits + 1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(stage.getAttribute('data-full-screen')).toBe('off');
    expect(onFullScreenChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId('site-layout-full-screen-fit')).toBeNull();
  });

  it('puts the stage itself in full screen where the browser can, and follows the browser leaving it', async () => {
    const stageEl = (): HTMLElement => screen.getByTestId('site-layout-3d');
    let current: Element | null = null;
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => current,
    });
    const exitFullscreen = vi.fn(() => {
      current = null;
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    });
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: exitFullscreen,
    });
    const enterFullScreen = (el: Element): Promise<void> => {
      current = el;
      return Promise.resolve();
    };
    const request = vi.fn(function (this: HTMLElement) {
      return enterFullScreen(this);
    });
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: request,
    });
    try {
      renderView([station()]);
      fireEvent.click(screen.getByRole('button', { name: 'sites.layoutView.fullScreen' }));
      await waitFor(() => {
        expect(stageEl().getAttribute('data-full-screen')).toBe('native');
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(current).toBe(stageEl());
      fireEvent.click(screen.getByRole('button', { name: 'sites.layoutView.exitFullScreen' }));
      expect(exitFullscreen).toHaveBeenCalledTimes(1);
      expect(stageEl().getAttribute('data-full-screen')).toBe('off');
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).requestFullscreen;
      Reflect.deleteProperty(document, 'fullscreenEnabled');
      Reflect.deleteProperty(document, 'fullscreenElement');
      Reflect.deleteProperty(document, 'exitFullscreen');
    }
  });

  describe('custom site', () => {
    const CUSTOM: PlacedLayoutSettings = {
      ...SETTINGS,
      siteType: 'custom',
      energyAssets: [
        {
          id: 'pv-1',
          type: 'solar',
          name: 'Canopy',
          capacityKwp: 50,
          row: 0,
          x: -20,
          z: 0,
          rotationDeg: 0,
        },
      ],
    };
    const twoEvses = (id: string, free: { x: number; z: number; rotationDeg: number }) =>
      station({
        id,
        stationId: `CS-${id}`,
        freePosition: free,
        evses: [
          { evseId: 1, status: 'available', connectors: [connector()] },
          {
            evseId: 2,
            status: 'charging',
            connectors: [connector({ status: 'charging', isPluggedIn: true })],
          },
        ],
      });

    it('stands every station at its free position with its spots, the car in the charging spot', () => {
      renderView(
        [
          twoEvses('a', { x: 0, z: 0, rotationDeg: 0 }),
          station({ id: 'b', stationId: 'CS-b', freePosition: { x: 10, z: 2, rotationDeg: 45 } }),
        ],
        { settings: CUSTOM },
      );
      const [a, b] = scene.stations as unknown as Array<{
        free: unknown;
        spots: number;
        carOffsetX: number;
      }>;
      expect(a).toMatchObject({ free: { x: 0, z: 0, rotationDeg: 0 }, spots: 2, carOffsetX: 1.3 });
      expect(b).toMatchObject({ free: { x: 10, z: 2, rotationDeg: 45 }, spots: 1, carOffsetX: 0 });
      // The solar canopy stands freely, sized from its peak power.
      expect(scene.solar[0]).toMatchObject({
        id: 'pv-1',
        free: { x: -20, z: 0, rotationDeg: 0, lengthM: 41.6, depthM: 6 },
      });
    });

    it("refuses a move onto another station's spots with a notice and saves a free one", () => {
      const onFreeMove = vi.fn();
      renderView(
        [
          twoEvses('a', { x: 0, z: 0, rotationDeg: 0 }),
          twoEvses('b', { x: 10, z: 0, rotationDeg: 0 }),
        ],
        { settings: CUSTOM, editing: true, onFreeMove },
      );
      expect(screen.getByText('sites.layoutView.hintEditCustom')).toBeDefined();
      const state = scene.callbacks?.freeDropState?.('a', { x: 8, z: 0, rotationDeg: 0 });
      expect(state?.blocked).toBe(true);
      // Level with b: an alignment guide along z.
      expect(state?.guides).toEqual([{ axis: 'z', from: { x: 10, z: 0 }, to: { x: 8, z: 0 } }]);
      act(() => {
        scene.callbacks?.onFreeDrop?.('a', { x: 8, z: 0, rotationDeg: 0 });
      });
      expect(onFreeMove).not.toHaveBeenCalled();
      expect(screen.getByTestId('site-layout-3d-notice').textContent).toBe(
        'sites.layoutView.spotsOverlap:CS-a',
      );
      act(() => {
        scene.callbacks?.onFreeDrop?.('a', { x: -3.2, z: 4.1, rotationDeg: 30.04 });
      });
      expect(onFreeMove).toHaveBeenCalledWith('a', { x: -3, z: 4, rotationDeg: 30 });
    });

    it('moves the selected station with the arrow keys and turns it with R', () => {
      const onFreeMove = vi.fn();
      renderView([twoEvses('a', { x: 0, z: 0, rotationDeg: 0 })], {
        settings: CUSTOM,
        editing: true,
        onFreeMove,
      });
      act(() => {
        scene.callbacks?.onFrame();
      });
      // In Edit Layout the chip selects the station (keyboard access).
      const chip = screen.getByRole('button', {
        name: 'sites.layoutView.stateDetailsLabel:CS-a:sites.layoutState.charging',
      });
      fireEvent.focus(chip);
      fireEvent.keyDown(chip, { key: 'ArrowRight' });
      expect(onFreeMove).toHaveBeenLastCalledWith('a', { x: 0.5, z: 0, rotationDeg: 0 });
      fireEvent.keyDown(chip, { key: 'r' });
      expect(onFreeMove).toHaveBeenLastCalledWith('a', { x: 0, z: 0, rotationDeg: 15 });
      fireEvent.keyDown(chip, { key: 'R', shiftKey: true });
      expect(onFreeMove).toHaveBeenLastCalledWith('a', { x: 0, z: 0, rotationDeg: 1 });
      // No popup in edit mode.
      expect(screen.queryByTestId('station-layout-popup')).toBeNull();
      // The arrows and R stay with the station; W and F still move the camera.
      expect(scene.nudges).toHaveLength(0);
    });

    it('keeps W, F and the zoom keys on the camera while a station is selected', () => {
      vi.stubGlobal('matchMedia', () => ({ matches: true }));
      const onFreeMove = vi.fn();
      renderView([twoEvses('a', { x: 0, z: 0, rotationDeg: 0 })], {
        settings: CUSTOM,
        editing: true,
        onFreeMove,
      });
      act(() => {
        scene.callbacks?.onFrame();
      });
      const chip = screen.getByRole('button', {
        name: 'sites.layoutView.stateDetailsLabel:CS-a:sites.layoutState.charging',
      });
      fireEvent.focus(chip);
      fireEvent.keyDown(chip, { key: 'ArrowUp' });
      fireEvent.keyDown(chip, { key: 'r', code: 'KeyR' });
      expect(scene.nudges).toHaveLength(0);
      fireEvent.keyDown(chip, { key: 'w', code: 'KeyW' });
      fireEvent.keyDown(chip, { key: 'f', code: 'KeyF' });
      fireEvent.keyDown(chip, { key: 'PageUp' });
      expect(scene.nudges.map((n) => [n.forward > 0, n.pitch > 0, n.zoom > 0])).toEqual([
        [true, false, false],
        [false, true, false],
        [false, false, true],
      ]);
    });

    it('moves and turns a selected solar canopy', () => {
      const onSolarMove = vi.fn();
      renderView([twoEvses('a', { x: 0, z: 0, rotationDeg: 0 })], {
        settings: CUSTOM,
        editing: true,
        onSolarMove,
      });
      act(() => {
        scene.callbacks?.onSolarDrop?.('pv-1', { x: -22.3, z: 1.2 });
      });
      expect(onSolarMove).toHaveBeenLastCalledWith('pv-1', { x: -22.5, z: 1, rotationDeg: 0 });
      act(() => {
        scene.callbacks?.onSolarPick?.('pv-1');
      });
      fireEvent.keyDown(screen.getByTestId('site-layout-3d'), { key: 'r' });
      expect(onSolarMove).toHaveBeenLastCalledWith('pv-1', { x: -20, z: 0, rotationDeg: 15 });
    });

    it('shows the screen text of the layout reply on the charger screen', () => {
      renderView(
        [
          station({
            freePosition: { x: 0, z: 0, rotationDeg: 0 },
            displayMessage: '<b>Idle fees</b> apply after 15 minutes',
          }),
          station({
            id: 'sta_2',
            stationId: 'CS-2',
            freePosition: { x: 10, z: 0, rotationDeg: 0 },
          }),
          station({
            id: 'sta_3',
            stationId: 'CS-3',
            freePosition: { x: 20, z: 0, rotationDeg: 0 },
            displayMessage: 'Old message',
            screenMessage: { text: 'Welcome to Acme', source: 'default_welcome' },
          }),
        ],
        { settings: CUSTOM },
      );
      const [first, second, third] = scene.stations as unknown as Array<{
        message: string | null;
      }>;
      // Plain text is made when the screen is drawn (`screenTextPlan`).
      expect(first?.message).toBe('<b>Idle fees</b> apply after 15 minutes');
      expect(second?.message).toBeNull();
      expect(third?.message).toBe('Welcome to Acme');
    });

    it('shows the magnified screen while a charger screen is hovered', () => {
      renderView(
        [
          station({
            freePosition: { x: 0, z: 0, rotationDeg: 0 },
            screenMessage: { text: 'Plug in to start', source: 'station_message_template' },
          }),
        ],
        { settings: CUSTOM },
      );
      act(() => {
        scene.callbacks?.onEquipmentHover?.('screen:ac57in:sta_1');
      });
      fireEvent.pointerMove(screen.getByTestId('site-layout-3d'), { clientX: 40, clientY: 50 });
      const zoom = screen.getByTestId('screen-message-zoom');
      expect(zoom.textContent).toContain('CS-1');
      expect(zoom.textContent).toContain('Plug in to start');
      act(() => {
        scene.callbacks?.onEquipmentHover?.(null);
      });
      expect(screen.queryByTestId('screen-message-zoom')).toBeNull();
    });
  });

  it('never hides a state marker for another one at the same screen point', () => {
    // jsdom has no layout: give every marker a size, so two at one point would collide.
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(24);
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(24);
    renderView([
      station(),
      station({ id: 'sta_2', stationId: 'CS-2', status: 'faulted' }),
      station({ id: 'sta_3', stationId: 'CS-3' }),
    ]);
    act(() => {
      scene.callbacks?.onFrame();
    });
    for (const id of ['sta_1', 'sta_2', 'sta_3']) {
      expect(screen.getByTestId(`site-layout-3d-station-${id}`).style.visibility).toBe('visible');
    }
    width.mockRestore();
    height.mockRestore();
  });

  describe('depot site', () => {
    const DEPOT: PlacedLayoutSettings = {
      ...SETTINGS,
      siteType: 'depot',
      busBays: 2,
      truckLanes: 1,
    };
    const one = (type: string) =>
      [
        {
          evseId: 1,
          status: 'charging',
          connectors: [connector({ connectorType: type, status: 'charging', isPluggedIn: true })],
        },
      ] satisfies LayoutStation['evses'];
    const session = (bodyType: string | null): LayoutStation['session'] => ({
      id: 'ses_1',
      startedAt: new Date().toISOString(),
      energyDeliveredWh: 1000,
      currentCostCents: 100,
      currency: 'USD',
      driver: null,
      vehicle: bodyType != null ? { color: 'white', bodyType } : null,
    });

    it('stands each station in its bay or lane with the charger of its connectors and a vehicle that fits', () => {
      renderView(
        [
          station({
            id: 'bus',
            stationId: 'CS-bus',
            positionX: 20,
            positionY: 20,
            evses: one('OppCharge'),
            // A car never stands in a bus bay: the default bus is drawn.
            session: session('sedan'),
          }),
          station({
            id: 'truck',
            stationId: 'CS-truck',
            positionX: 20,
            positionY: 160,
            evses: one('cMCS'),
            session: session('box_truck'),
          }),
        ],
        { settings: DEPOT },
      );
      const [bus, truck] = scene.stations as unknown as Array<{
        free: { spotType?: string; rotationDeg: number };
        spots: number;
        charger: string;
        car: { bodyType: string };
      }>;
      expect(bus).toMatchObject({
        free: { spotType: 'bus_bay', rotationDeg: 0 },
        spots: 1,
        charger: 'pantograph_down',
        car: { bodyType: 'bus' },
      });
      expect(truck).toMatchObject({
        free: { spotType: 'truck_pull_through' },
        spots: 1,
        charger: 'truck_mcs',
        car: { bodyType: 'box_truck' },
      });
    });

    it('moves a depot station by slot, not freely', () => {
      const onMove = vi.fn();
      renderView([station({ id: 'bus', positionX: 20, positionY: 20 })], {
        settings: DEPOT,
        editing: true,
        onMove,
      });
      // The truck lane (row 1) is free: a drop there moves the station to slot (0, 1).
      act(() => {
        scene.callbacks?.onDrop('bus', { col: 0, row: 1 });
      });
      expect(onMove).toHaveBeenCalledWith('bus', 20, 160);
    });
  });
});

describe('SiteLayout3D stations with units', () => {
  // The discussion 59 setup: an OCPP 1.6 ABL eM4 master and extenders, 2 AC EVSEs per box.
  const type2 = (status = 'available', isPluggedIn = false) =>
    connector({ connectorType: 'Type2', maxPowerKw: 22, status, isPluggedIn });
  const evseSession = (id: string, color: string) => ({
    id,
    startedAt: '2026-11-11T08:00:00Z',
    energyDeliveredWh: 500,
    currentCostCents: null,
    currency: 'EUR',
    driver: null,
    vehicle: { color, bodyType: null },
  });
  const em4 = (boxes = 3): LayoutStation =>
    station({
      id: 'sta_em4',
      stationId: 'ABL-EM4',
      model: 'eM4 Twin',
      status: 'charging',
      chargingKind: 'ac',
      positionX: 20,
      positionY: 20,
      evses: Array.from({ length: boxes * 2 }, (_, i) => ({
        evseId: i + 1,
        status: 'available',
        unitId: `unt_${String(Math.floor(i / 2) + 1)}`,
        connectors: [type2()],
      })),
      units: Array.from({ length: boxes }, (_, i) => ({
        id: `unt_${String(i + 1)}`,
        name: `Box ${String(i + 1)}`,
        evseIds: [2 * i + 1, 2 * i + 2],
      })),
    });

  it('draws a station without units exactly as before: one charger, no unit id (D3)', () => {
    const plain = station({ units: [] });
    renderView([plain]);
    expect(scene.stations.map((s) => s.id)).toEqual(['sta_1']);
    expect(scene.stations[0]?.bay).toEqual({ col: 0, row: 0 });
  });

  it('draws one dual-port pedestal per unit in one run, each with its own stalls and state', () => {
    const units = em4();
    // Box 2 charges on its second EVSE; the others are free.
    units.evses[3] = {
      evseId: 4,
      unitId: 'unt_2',
      status: 'charging',
      session: evseSession('ses_b', 'red'),
      connectors: [type2('charging', true)],
    };
    renderView([units]);
    expect(scene.stations.map((s) => s.id)).toEqual(['sta_em4', 'sta_em4#u2', 'sta_em4#u3']);
    expect(scene.stations.map((s) => s.bay)).toEqual([
      { col: 0, row: 0 },
      { col: 2, row: 0 },
      { col: 4, row: 0 },
    ]);
    const drawn = scene.stations as unknown as Array<{
      stalls?: Array<{ x: number }>;
      prop: string | null;
      kind: string;
      stallCars?: Array<{ color: string } | null>;
      lightColor: string;
    }>;
    // Each box stands on the line between its two spots: two stalls each.
    expect(drawn.map((s) => s.stalls?.length)).toEqual([2, 2, 2]);
    expect(drawn.map((s) => s.kind)).toEqual(['ac', 'ac', 'ac']);
    // Each box is one dual-port AC charger: two ports of one connector each (the
    // dual-port pedestal model, `ports === 2` in the charger model), never single-port.
    expect(
      (scene.stations as unknown as Array<{ evseConnectors?: number[] }>).map(
        (s) => s.evseConnectors,
      ),
    ).toEqual([
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
    // Each box carries its number plate: its place in the unit order, never read from the name.
    expect(
      (scene.stations as unknown as Array<{ unitPlate?: { number: number } }>).map(
        (s) => s.unitPlate?.number,
      ),
    ).toEqual([1, 2, 3]);
    expect(screen.getByTestId('site-layout-3d-unit-plate-sta_em4#u2').textContent).toBe(
      'layout.units.plateLabel',
    );
    expect(drawn.map((s) => s.prop)).toEqual([null, 'car', null]);
    expect(drawn[1]?.lightColor).toBe(resolveCssColor(stationStateColor('charging')));
    expect(drawn[0]?.lightColor).toBe(resolveCssColor(stationStateColor('available')));
  });

  it('opens the popup of a unit with only its EVSEs and links to the station', () => {
    renderView([em4()]);
    act(() => {
      scene.callbacks?.onPick('sta_em4#u2');
    });
    const popup = screen.getByTestId('station-layout-popup');
    expect(screen.getByTestId('layout-popup-title').textContent).toBe('layout.units.chargerName');
    expect(popup.textContent).toContain('sites.layoutView.evse:3');
    expect(popup.textContent).toContain('sites.layoutView.evse:4');
    expect(popup.textContent).not.toContain('sites.layoutView.evse:1');
    const link = screen.getByRole('link', { name: 'sites.layoutView.openStation' });
    expect(link.getAttribute('href')).toBe('/stations/sta_em4');
  });

  it('moves the whole station when one unit charger is dropped', () => {
    const onMove = vi.fn();
    renderView([em4(), station({ id: 'sta_2', stationId: 'CS-2', positionX: 1820 })], {
      editing: true,
      onMove,
    });
    // The run of the station is its own: its spots are not taken for its units.
    expect(scene.callbacks?.isBayTaken({ col: 3, row: 0 }, 'sta_em4#u2')).toBe(false);
    act(() => {
      // Box 2 dropped on spot 4 of row 1: the run starts two spots before it.
      scene.callbacks?.onDrop('sta_em4#u2', { col: 4, row: 1 });
    });
    expect(onMove).toHaveBeenLastCalledWith('sta_em4', 420, 160);
  });

  it('puts a paired reader only on the unit of its EVSE, at that port', () => {
    const terminals = new Map<string, LayoutTerminal[]>([
      [
        'sta_em4',
        [
          {
            id: 'pt_4',
            name: 'Reader Box 2',
            stationId: 'sta_em4',
            evseNumber: 4,
            hasDisplay: true,
            online: true,
          },
        ],
      ],
    ]);
    renderView([em4()], { terminals });
    expect(scene.stations.map((s) => s.terminals.map((x) => [x.id, x.side]))).toEqual([
      [],
      [['pt_4', 1]],
      [],
    ]);
  });

  it('gives each unit its own bus bay at a depot and its own curb post on a street, numbered', () => {
    const ccs = (status = 'available', isPluggedIn = false) =>
      connector({ connectorType: 'CCS1', maxPowerKw: 150, status, isPluggedIn });
    const busUnits = station({
      id: 'sta_bus',
      stationId: 'BUS-1',
      chargingKind: 'dc',
      positionX: 20,
      positionY: 20,
      evses: [1, 2, 3].map((evseId) => ({
        evseId,
        status: 'available',
        unitId: `unt_${String(evseId)}`,
        connectors: [ccs()],
      })),
      units: [1, 2, 3].map((n) => ({
        id: `unt_${String(n)}`,
        name: `Box ${String(n)}`,
        evseIds: [n],
      })),
    });
    const depot = placePowerEquipment(
      effectiveLayoutSettings({
        siteType: 'depot',
        spotsPerRow: 1,
        rows: 1,
        facingDeg: 0,
        busBays: 6,
        truckLanes: 0,
        transformers: [],
      }),
      { transformers: [], energyAssets: [] },
    );
    renderView([busUnits], { settings: depot });
    expect(scene.stations.map((s) => [s.id, s.bay.col, s.bay.row])).toEqual([
      ['sta_bus', 0, 0],
      ['sta_bus#u2', 1, 0],
      ['sta_bus#u3', 2, 0],
    ]);
    expect(
      (scene.stations as unknown as Array<{ unitPlate?: { number: number } }>).map(
        (s) => s.unitPlate?.number,
      ),
    ).toEqual([1, 2, 3]);
    cleanup();

    const curbUnits = station({
      ...busUnits,
      id: 'sta_curb',
      stationId: 'CURB-1',
      chargingKind: 'ac',
      evses: [1, 2, 3].map((evseId) => ({
        evseId,
        status: 'available',
        unitId: `unt_${String(evseId)}`,
        connectors: [type2()],
      })),
    });
    const street = placePowerEquipment(
      effectiveLayoutSettings({
        siteType: 'curbside',
        spotsPerRow: 10,
        rows: 2,
        facingDeg: 0,
        chargersLeft: 6,
        chargersRight: 2,
        transformers: [],
      }),
      { transformers: [], energyAssets: [] },
    );
    renderView(
      [
        curbUnits,
        station({
          id: 'sta_plain',
          stationId: 'PLAIN',
          positionX: 20,
          positionY: 160,
          chargingKind: 'ac',
          evses: [{ evseId: 1, status: 'available', connectors: [type2()] }],
        }),
      ],
      { settings: street },
    );
    expect(scene.stations.map((s) => [s.id, s.bay.col, s.bay.row])).toEqual([
      ['sta_curb', 0, 0],
      ['sta_curb#u2', 1, 0],
      ['sta_curb#u3', 2, 0],
      // A station without units keeps its one post (D3).
      ['sta_plain', 0, 1],
    ]);
  });

  it('runs the station circuit on to every unit charger', () => {
    const hierarchy: LinkPanel[] = [
      {
        id: 'pnl_1',
        name: 'Panel 1',
        breakerRatingAmps: 225,
        maxContinuousKw: 60,
        childPanels: [],
        circuits: [
          {
            id: 'cir_1',
            name: 'eM4',
            breakerRatingAmps: 100,
            maxContinuousKw: 50,
            stations: [{ id: 'sta_em4', allocatedLimitKw: 44 }],
          },
        ],
      },
    ];
    renderView([em4()], { hierarchy, loadManaged: true });
    const ids = JSON.stringify(scene.links.segments);
    expect(ids).toContain('sta_em4#u2');
    expect(ids).toContain('sta_em4#u3');
  });
});

describe('SiteLayout3D car at its session EVSE', () => {
  // Owner decision 2026-11-12: each charging car, its driver avatar and its cable go to
  // the stall of its own session's EVSE; the first plugged stall only when it is unknown.
  const RED = '#b3262e';
  const BLUE = '#2f5d9e';
  const session = (id: string, color: string, evseId: number | null) => ({
    id,
    startedAt: '2026-11-12T08:00:00Z',
    energyDeliveredWh: 500,
    currentCostCents: null,
    currency: 'EUR',
    evseId,
    driver: null,
    vehicle: { color, bodyType: null },
  });
  type Drawn = {
    stalls?: Array<{ x: number }>;
    stallCars?: Array<{ color: string } | null>;
    pluggedSlot?: { evse: number; connector: number };
    carOffsetX?: number;
  };
  const dual = (kind: 'ac' | 'dc', plugged: [boolean, boolean], evseId: number | null) => {
    const plug = (on: boolean, n: number) =>
      kind === 'ac'
        ? connector({
            connectorType: 'Type2',
            maxPowerKw: 22,
            status: on ? 'charging' : 'available',
            isPluggedIn: on,
            connectorId: 1,
            energyDeliveredWh: on ? 1000 * n : null,
          })
        : connector({ status: on ? 'charging' : 'available', isPluggedIn: on });
    return station({
      id: `sta_${kind}`,
      stationId: `DUAL-${kind}`,
      chargingKind: kind,
      session: session('ses_home', 'red', evseId),
      evses: [1, 2].map((n) => ({
        evseId: n,
        status: plugged[n - 1] ? 'charging' : 'available',
        session:
          n === 2 && evseId === 2
            ? session('ses_home', 'red', 2)
            : plugged[n - 1]
              ? session(`ses_${String(n)}`, 'blue', n)
              : null,
        connectors: [plug(plugged[n - 1] === true, n)],
      })),
    });
  };

  for (const kind of ['ac', 'dc'] as const) {
    it(`parks the car of EVSE 2 charging alone at the EVSE 2 stall of a ${kind.toUpperCase()} charger`, () => {
      renderView([dual(kind, [false, true], 2)]);
      const s = scene.stations[0] as unknown as Drawn;
      expect(s.stalls).toHaveLength(2);
      expect(s.stallCars?.map((c) => c?.color ?? null)).toEqual([null, RED]);
      // The cable plugs EVSE 2 and the avatar and the car offset follow its stall.
      expect(s.pluggedSlot?.evse).toBe(1);
      expect(s.carOffsetX).toBe(s.stalls?.[1]?.x);
    });

    it(`keeps each car at its own EVSE when both charge, the station session on EVSE 2 (${kind})`, () => {
      renderView([dual(kind, [true, true], 2)]);
      const s = scene.stations[0] as unknown as Drawn;
      expect(s.stallCars?.map((c) => c?.color ?? null)).toEqual([BLUE, RED]);
      expect(s.pluggedSlot?.evse).toBe(1);
      expect(s.carOffsetX).toBe(s.stalls?.[1]?.x);
    });
  }

  it('uses the first plugged stall while the station has not named the session EVSE', () => {
    const s0 = dual('ac', [true, true], null);
    renderView([{ ...s0, evses: s0.evses.map((e) => ({ ...e, session: null })) }]);
    const s = scene.stations[0] as unknown as Drawn;
    expect(s.pluggedSlot?.evse).toBe(0);
    expect(s.stallCars?.[0]?.color).toBe(RED);
  });
});

describe('SiteLayout3D dual-outlet depot bus charger', () => {
  // Owner decision 2026-11-12: a plug-in bus station of two EVSEs draws one dispenser
  // between two adjacent bays, a bus per outlet; a pantograph keeps one bay.
  const depotSettings = () =>
    placePowerEquipment(
      effectiveLayoutSettings({
        siteType: 'depot',
        spotsPerRow: 1,
        rows: 1,
        facingDeg: 0,
        busBays: 6,
        truckLanes: 0,
        transformers: [],
      }),
      { transformers: [], energyAssets: [] },
    );
  const ccs = (on: boolean) =>
    connector({ connectorType: 'CCS1', status: on ? 'charging' : 'available', isPluggedIn: on });
  const busSession = (id: string, evseId: number) => ({
    id,
    startedAt: '2026-11-12T08:00:00Z',
    energyDeliveredWh: 500,
    currentCostCents: null,
    currency: 'EUR',
    evseId,
    driver: null,
    vehicle: { color: 'red', bodyType: 'bus' },
  });
  const dualBus = (plugged: [boolean, boolean], connectorType = 'CCS1') =>
    station({
      id: 'sta_bus2',
      stationId: 'BUS-DUAL',
      chargingKind: 'dc',
      positionX: 20,
      positionY: 20,
      session: plugged[1] ? busSession('ses_b', 2) : null,
      evses: [1, 2].map((evseId) => ({
        evseId,
        status: plugged[evseId - 1] ? 'charging' : 'available',
        session: plugged[evseId - 1] ? busSession(`ses_${String(evseId)}`, evseId) : null,
        connectors: [{ ...ccs(plugged[evseId - 1] === true), connectorType }],
      })),
    });
  type Drawn = {
    spots?: number;
    free?: { x: number };
    charger?: string;
    stallCars?: Array<{ bodyType: string } | null>;
    pluggedSlot?: { evse: number };
  };

  it('stands between two bays with a bus per outlet, the session bus at its own outlet', () => {
    const settings = depotSettings();
    renderView([dualBus([false, true])], { settings });
    const s = scene.stations[0] as unknown as Drawn;
    expect(s.charger).toBe('bus_dispenser');
    expect(s.spots).toBe(2);
    // Bays 0 and 1 are 4.3 m wide: the dispenser stands on the line between them.
    const bay0 = depotStationPlacement({ col: 0, row: 0 }, lotOf(settings));
    expect(s.free?.x).toBeCloseTo(bay0.x + 2.15, 5);
    expect(s.stallCars?.map((c) => c?.bodyType ?? null)).toEqual([null, 'bus']);
    expect(s.pluggedSlot?.evse).toBe(1);
    cleanup();

    renderView([dualBus([true, true])], { settings });
    const both = scene.stations[0] as unknown as Drawn;
    expect(both.stallCars?.map((c) => c?.bodyType ?? null)).toEqual(['bus', 'bus']);
  });

  it('keeps one bay for a one-EVSE bus charger and a pantograph of two EVSEs, and when the next bay is taken', () => {
    const settings = depotSettings();
    const one = station({
      id: 'sta_one',
      stationId: 'BUS-ONE',
      chargingKind: 'dc',
      positionX: 220,
      positionY: 20,
      session: null,
      evses: [{ evseId: 1, status: 'available', connectors: [ccs(false)] }],
    });
    const pantograph = {
      ...dualBus([false, false], 'OppCharge'),
      id: 'sta_pan',
      stationId: 'PAN',
      positionX: 820,
    };
    renderView([dualBus([false, false]), one, pantograph], { settings });
    const drawn = scene.stations as unknown as Array<Drawn & { id: string }>;
    // The dual charger's next bay holds BUS-ONE: it serves its own bay (stored positions stay valid).
    expect(drawn.map((d) => [d.id, d.spots])).toEqual([
      ['sta_bus2', 1],
      ['sta_one', 1],
      ['sta_pan', 1],
    ]);
  });
});

describe('SiteLayout3D two-port curb post', () => {
  // Owner decision 2026-11-12: an AC station of two EVSEs at a street stands on the line
  // between two parallel spots, EVSE 1's car on its left, EVSE 2's on its right.
  const streetSettings = () =>
    placePowerEquipment(
      effectiveLayoutSettings({
        siteType: 'curbside',
        spotsPerRow: 8,
        rows: 2,
        facingDeg: 0,
        chargersLeft: 8,
        chargersRight: 0,
        transformers: [],
      }),
      { transformers: [], energyAssets: [] },
    );
  const j1772 = (on: boolean) =>
    connector({
      connectorType: 'Type1',
      maxPowerKw: 7,
      status: on ? 'charging' : 'available',
      isPluggedIn: on,
    });
  const post = (id: string, col: number, plugged: [boolean, boolean]) =>
    station({
      id,
      stationId: id.toUpperCase(),
      chargingKind: 'ac',
      positionX: 20 + 200 * col,
      positionY: 20,
      session: null,
      evses: [1, 2].map((evseId) => ({
        evseId,
        status: plugged[evseId - 1] ? 'charging' : 'available',
        connectors: [j1772(plugged[evseId - 1] === true)],
      })),
    });
  type Drawn = {
    id: string;
    curbPair?: boolean;
    stalls?: Array<{ x: number; width: number }>;
    shiftX?: number;
    stallCars?: Array<object | null>;
  };

  it('stands between its two spots with a car per port, and on one spot when the next is taken', () => {
    const settings = streetSettings();
    renderView(
      [
        post('sta_pair', 0, [true, true]),
        post('sta_full', 4, [false, true]),
        post('sta_next', 5, [false, false]),
      ],
      {
        settings,
      },
    );
    const drawn = scene.stations as unknown as Drawn[];
    const pair = drawn.find((d) => d.id === 'sta_pair');
    expect(pair?.curbPair).toBe(true);
    // The left curb runs +x: the post moves 6 m less 0.6 m onto the line between its spots.
    expect(pair?.shiftX).toBeCloseTo(5.4, 5);
    expect(pair?.stalls?.map((st) => st.x)).toEqual([-3, 3]);
    expect(pair?.stallCars?.map((c) => c != null)).toEqual([true, true]);
    // Its next spot holds sta_next: it serves its own spot (stored positions stay valid).
    const full = drawn.find((d) => d.id === 'sta_full');
    expect(full?.curbPair).toBeUndefined();
  });
});
