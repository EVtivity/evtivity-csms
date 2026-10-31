// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { SceneCallbacks } from '../site-layout-scene';

const { getMock, permissions, scene, createScene, setThemeMock } = vi.hoisted(() => {
  const sceneState = {
    callbacks: null as SceneCallbacks | null,
    stations: [] as Array<{
      id: string;
      bay: { col: number; row: number };
      lightColor: string;
      prop: string | null;
      glow: boolean;
      beacon: boolean;
      wall: boolean;
      terminals: Array<{ id: string; side: number; hasDisplay: boolean; online: boolean | null }>;
    }>,
    lot: { cols: 0, rows: 0 },
    transformers: [] as Array<{ id: string; x: number; z: number }>,
    batteries: [] as Array<{ id: string; x: number; z: number }>,
    solar: [] as Array<{ id: string; row: number }>,
    panels: [] as Array<{ id: string; x: number; z: number; mount: string }>,
    links: { segments: [] as unknown[], labels: [] as Array<{ id: string }> },
    logo: undefined as string | null | undefined,
    editing: false,
    fits: 0,
    active: true,
    throwOnCreate: false,
    flow: new Map<string, number>() as ReadonlyMap<string, number>,
    focused: [] as string[],
    pointDistance: 20,
  };
  return {
    getMock: vi.fn(),
    permissions: new Set<string>(),
    scene: sceneState,
    createScene: vi.fn(),
    setThemeMock: vi.fn(),
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> | string) =>
      typeof opts === 'object' && 'id' in opts
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
}));

// WebGL does not exist in jsdom: the scene is a stub that records what it is given.
vi.mock('../site-layout-scene', () => ({
  createSiteScene: createScene,
}));

import { effectiveLayoutSettings, type SiteLayoutSettings } from '@evtivity/lib/site-layout';
import SiteLayout3D, { linkLabelText, stationBays } from '../SiteLayout3D';
import { stationStateTextColor } from '@/lib/station-display-state';
import type { LayoutStation } from '../StationCard';
import type { LayoutTerminal } from '../layout-terminals';
import type { LinkPanel } from '../site-layout-links';
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

const SETTINGS = effectiveLayoutSettings(null);

function renderView(
  stations: LayoutStation[],
  props: Partial<{
    editing: boolean;
    onMove: () => void;
    onTransformerMove: () => void;
    onUnavailable: () => void;
    settings: SiteLayoutSettings;
    terminals: Map<string, LayoutTerminal[]>;
    hierarchy: LinkPanel[] | null;
    logoUrl: string | null;
    insights: Map<string, LayoutInsight[]>;
    replaying: boolean;
    drawKw: (id: string) => number | undefined;
  }> = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onMove = props.onMove ?? vi.fn();
  const onTransformerMove = props.onTransformerMove ?? vi.fn();
  const onUnavailable = props.onUnavailable ?? vi.fn();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SiteLayout3D
          stations={stations}
          settings={props.settings ?? SETTINGS}
          terminals={props.terminals ?? new Map()}
          hierarchy={props.hierarchy ?? null}
          logoUrl={props.logoUrl ?? null}
          editing={props.editing ?? false}
          fitKey={0}
          currentDrawKw={props.drawKw ?? (() => 96.5)}
          allocatedLimitKw={() => 120}
          insights={props.insights}
          replaying={props.replaying ?? false}
          onMove={onMove}
          onTransformerMove={onTransformerMove}
          onUnavailable={onUnavailable}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, onMove, onTransformerMove, onUnavailable };
}

beforeEach(() => {
  scene.callbacks = null;
  scene.stations = [];
  scene.editing = false;
  scene.fits = 0;
  scene.flow = new Map();
  scene.focused = [];
  scene.pointDistance = 20;
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
      }) => {
        scene.stations = layout.stations;
        scene.lot = layout.lot;
        scene.transformers = layout.transformers;
        scene.batteries = layout.batteries;
        scene.solar = layout.solar;
        scene.panels = layout.panels;
        scene.links = layout.links;
      },
      setLogo: (url: string | null) => {
        scene.logo = url;
      },
      transformerLabelPoint: () => ({ x: 300, y: 60, depth: 0.6, distance: 20, visible: true }),
      linkLabelPoint: () => ({ x: 500, y: 200, depth: 0.7, distance: 20, visible: true }),
      setLinkFlow: (flow: ReadonlyMap<string, number>) => {
        scene.flow = flow;
      },
      focus: (id: string) => {
        scene.focused.push(id);
      },
      viewDistance: () => 10,
      energyLabelPoint: () => ({ x: 400, y: 80, depth: 0.6, distance: 20, visible: true }),
      avatarPoint: () => ({
        x: 120,
        y: 160,
        depth: 0.4,
        distance: scene.pointDistance,
        visible: true,
      }),
      setTheme: setThemeMock,
      setEditing: (e: boolean) => {
        scene.editing = e;
      },
      setSelected: vi.fn(),
      fit: () => {
        scene.fits += 1;
      },
      labelPoint: () => ({
        x: 100,
        y: 100,
        depth: 0.5,
        distance: scene.pointDistance,
        visible: true,
      }),
      setActive: (a: boolean) => {
        scene.active = a;
      },
      dispose: vi.fn(),
    };
  });
});

afterEach(() => {
  cleanup();
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
    // The bay prop follows the label state; the sign shows the translated word.
    expect(scene.stations.map((s) => s.prop)).toEqual(['reservedSign', null]);
    expect(setThemeMock).toHaveBeenCalledWith(
      expect.objectContaining({ reservedLabel: 'sites.layoutState.reserved' }),
    );
  });

  it('gives a charging station a car and a station in maintenance a cone', () => {
    renderView([
      station({
        evses: [{ evseId: 1, status: 'charging', connectors: [connector({ status: 'charging' })] }],
      }),
      station({ id: 'sta_2', stationId: 'CS-2', inMaintenance: true, positionX: 220 }),
      station({ id: 'sta_3', stationId: 'CS-3', status: 'available', positionX: 420, evses: [] }),
    ]);
    expect(scene.stations.map((s) => s.prop)).toEqual(['car', 'cone', null]);
  });

  it('labels every station with its ID and state text in the state color, and the 4G badge, never a New tag', () => {
    renderView([station({ cellular: true, placed: false })]);
    const label = screen.getByTestId('site-layout-3d-label-sta_1');
    // The state follows the ID inside the chip: "CS-1 · Reserved".
    expect(label.textContent).toContain('CS-1·sites.layoutState.reserved');
    const state = screen.getByTestId('station-state-text');
    expect(state.getAttribute('data-state')).toBe('reserved');
    expect(state.textContent).toBe('sites.layoutState.reserved');
    expect(stationStateTextColor('reserved')).toContain('#f97316');
    // No separate state badge: the chip and the 4G badge only.
    expect(label.querySelector('[data-testid="station-state-badge"]')).toBeNull();
    expect(label.querySelectorAll('[role="img"]')).toHaveLength(0);
    expect(label.querySelector('[data-testid="cellular-badge"]')).not.toBeNull();
    expect(label.querySelector('[data-testid="new-placement-tag"]')).toBeNull();
    // The chip opens the details, also from the keyboard; its name holds the state.
    // Labels stay hidden until the first frame places them; the stub scene renders none.
    act(() => {
      scene.callbacks?.onFrame();
    });
    const chip = screen.getByRole('button', {
      name: 'sites.layoutView.stateDetailsLabel:CS-1:sites.layoutState.reserved',
    });
    expect(chip.contains(state)).toBe(true);
    chip.focus();
    fireEvent.click(chip);
    const popup = screen.getByTestId('station-layout-popup');
    // Focus moves into the popup, and back to the chip when Escape closes it.
    expect(popup.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('station-layout-popup')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it('opens the popup with the station details on a click', () => {
    renderView([
      station({ status: 'faulted', statusReason: 'station_faulted', inMaintenance: true }),
    ]);
    act(() => {
      scene.callbacks?.onPick('sta_1');
    });
    const popup = screen.getByTestId('station-layout-popup');
    expect(popup.textContent).toContain('CS-1');
    expect(popup.textContent).toContain('Terra 184');
    expect(popup.textContent).toContain('sites.layoutView.dcFast');
    expect(popup.textContent).toContain('sites.layoutState.faulted');
    expect(popup.textContent).toContain('stations.statusReason.station_faulted');
    expect(popup.textContent).toContain('96.5 / 150 kW');
    expect(popup.textContent).toContain('sites.layoutView.allocatedLimit');
    expect(popup.textContent).toContain('sites.layoutView.connectionWired');
    expect(popup.textContent).toContain('sites.layoutView.evse:1');
    expect(popup.querySelector('[data-status="charging"]')).not.toBeNull();
    expect(popup.querySelector('[data-status="reserved"]')).not.toBeNull();
    const link = screen.getByRole('link', { name: 'sites.layoutView.openStation' });
    expect(link.getAttribute('href')).toBe('/stations/sta_1');
    expect(getMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    expect(screen.queryByTestId('station-layout-popup')).toBeNull();
  });

  it('reads the signal of a cellular station only when its popup opens and stations may be read', async () => {
    permissions.add('stations:read');
    getMock.mockResolvedValue({
      station: {
        dataLinks: [
          { signal: { value: -71, unit: 'dBm', inferred: false, dbm: -71, grade: 'good' } },
        ],
      },
    });
    renderView([station({ cellular: true })]);
    expect(getMock).not.toHaveBeenCalled();
    act(() => {
      scene.callbacks?.onPick('sta_1');
    });
    const popup = screen.getByTestId('station-layout-popup');
    expect(popup.textContent).toContain('sites.layoutView.connectionCellular');
    await waitFor(() => {
      expect(popup.textContent).toContain('stations.sim.station.grade.good (-71 dBm)');
    });
    expect(getMock).toHaveBeenCalledWith('/v1/stations/sta_1/sim');
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
        transformers: [{ id: 'tx-9', name: 'Main Feed', ratedKva: 2500, x: 40, z: 3 }],
      },
    });
    expect(screen.getByTestId('site-layout-3d-transformer-tx-9').textContent).toContain(
      'Main Feed',
    );
    expect(screen.getByTestId('site-layout-3d-transformer-tx-9').textContent).toContain(
      '2,500 kVA',
    );
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
    // Panel to circuit, circuit to station: no link starts at a transformer.
    expect(scene.links.segments).toHaveLength(2);
    expect(scene.panels).toEqual([expect.objectContaining({ id: 'p1', mount: 'pad' })]);
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

  it('shows no panel and no link without load management', () => {
    renderView([station()], { hierarchy: null });
    expect(scene.panels).toEqual([]);
    expect(scene.links.segments).toEqual([]);
  });

  it('shows an office or retail site with wall boxes and wall panels, and no transformers', () => {
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
          transformers: [{ id: 'tx-9', name: 'Kept', ratedKva: 500, x: 40, z: 3 }],
        },
      },
    );
    expect(scene.lot).toMatchObject({ siteType: 'office_retail' });
    // The stored transformer stays in the settings but is not shown.
    expect(scene.transformers).toEqual([]);
    expect(screen.queryByTestId('site-layout-3d-transformer-tx-9')).toBeNull();
    // An AC charger of the first row hangs on the facade; DC and the second row stand at the curb.
    expect(scene.stations.map((s) => [s.id, s.wall])).toEqual([
      ['sta_ac', true],
      ['sta_dc', false],
      ['sta_back', false],
    ]);
    expect(scene.panels).toEqual([expect.objectContaining({ id: 'p1', mount: 'wall' })]);
    expect(screen.getByTestId('site-layout-3d-link-panel:p1').textContent).toBe(
      'Retail Panel · 200 A · 57.6 kW',
    );
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

  it('puts a beacon on a faulted station only', () => {
    renderView([
      station(),
      station({ id: 'sta_2', stationId: 'CS-2', status: 'faulted', positionX: 220 }),
    ]);
    expect(scene.stations.map((s) => s.beacon)).toEqual([false, true]);
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

  it('shows only a plain marker without session data, and none while replaying', () => {
    const { unmount } = renderView([chargingStation(null)]);
    const marker = screen.getByTestId('site-layout-3d-avatar-sta_1');
    expect(marker.querySelector('button')).toBeNull();
    expect(marker.querySelector('img')).toBeNull();
    unmount();
    renderView([chargingStation(null)], { replaying: true });
    expect(screen.queryByTestId('site-layout-3d-avatar-sta_1')).toBeNull();
    expect(screen.getByText('sites.layoutView.hintReplay')).toBeTruthy();
  });

  it('hides far station labels on a large site', () => {
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
    expect(screen.getByTestId('site-layout-3d-label-s0').style.visibility).toBe('hidden');
  });

  it('shows batteries on both site types and solar canopies on a parking lot only, with labels', () => {
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
        { id: 'pv-1', type: 'solar' as const, name: null, capacityKwp: 180, row: 1 },
      ],
    };
    const { unmount } = renderView([station()], { settings: energy });
    expect(scene.batteries).toEqual([{ id: 'bat-1', x: 4, z: -6 }]);
    expect(scene.solar).toEqual([{ id: 'pv-1', row: 1 }]);
    expect(screen.getByTestId('site-layout-3d-energy-bat-1').textContent).toBe(
      'Main Battery· 1,000 kWh',
    );
    expect(screen.getByTestId('site-layout-3d-energy-pv-1').textContent).toBe(
      'sites.layoutView.solarCanopy· 180 kWp',
    );
    unmount();
    renderView([station()], { settings: { ...energy, siteType: 'office_retail' } });
    expect(scene.batteries).toHaveLength(1);
    expect(scene.solar).toEqual([]);
    expect(screen.queryByTestId('site-layout-3d-energy-pv-1')).toBeNull();
  });
});
