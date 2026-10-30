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
      terminals: Array<{ id: string; side: number; hasDisplay: boolean; online: boolean | null }>;
    }>,
    lot: { cols: 0, rows: 0 },
    transformers: [] as Array<{ id: string; x: number; z: number }>,
    links: { segments: [] as unknown[], labels: [] as Array<{ id: string }> },
    logo: undefined as string | null | undefined,
    editing: false,
    fits: 0,
    active: true,
    throwOnCreate: false,
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
          currentDrawKw={() => 96.5}
          allocatedLimitKw={() => 120}
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
  createScene.mockImplementation((_container: HTMLElement, _opts: unknown, cb: SceneCallbacks) => {
    if (scene.throwOnCreate) throw new Error('Error creating WebGL context');
    scene.callbacks = cb;
    return {
      setLayout: (layout: {
        stations: typeof scene.stations;
        lot: { cols: number; rows: number };
        transformers: typeof scene.transformers;
        links: typeof scene.links;
      }) => {
        scene.stations = layout.stations;
        scene.lot = layout.lot;
        scene.transformers = layout.transformers;
        scene.links = layout.links;
      },
      setLogo: (url: string | null) => {
        scene.logo = url;
      },
      transformerLabelPoint: () => ({ x: 300, y: 60, depth: 0.6, visible: true }),
      linkLabelPoint: () => ({ x: 500, y: 200, depth: 0.7, visible: true }),
      setTheme: setThemeMock,
      setEditing: (e: boolean) => {
        scene.editing = e;
      },
      setSelected: vi.fn(),
      fit: () => {
        scene.fits += 1;
      },
      labelPoint: () => ({ x: 100, y: 100, depth: 0.5, visible: true }),
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
    expect(scene.links.segments).toHaveLength(3);
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
});
