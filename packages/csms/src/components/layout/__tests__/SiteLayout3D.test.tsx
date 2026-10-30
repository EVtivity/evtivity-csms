// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { SceneCallbacks } from '../site-layout-scene';

const { getMock, permissions, scene, createScene } = vi.hoisted(() => {
  const sceneState = {
    callbacks: null as SceneCallbacks | null,
    stations: [] as Array<{ id: string; bay: { col: number; row: number }; lightColor: string }>,
    frame: { cols: 0, rows: 0 },
    area: { cols: 0, rows: 0 },
    editing: false,
    fits: 0,
    throwOnCreate: false,
  };
  return {
    getMock: vi.fn(),
    permissions: new Set<string>(),
    scene: sceneState,
    createScene: vi.fn(),
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> | string) =>
      typeof opts === 'object' && 'id' in opts ? `${key}:${String(opts['id'])}` : key,
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

import SiteLayout3D, { stationBays } from '../SiteLayout3D';
import type { LayoutStation } from '../StationCard';

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

function renderView(
  stations: LayoutStation[],
  props: Partial<{ editing: boolean; onMove: () => void; onUnavailable: () => void }> = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onMove = props.onMove ?? vi.fn();
  const onUnavailable = props.onUnavailable ?? vi.fn();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SiteLayout3D
          stations={stations}
          editing={props.editing ?? false}
          fitKey={0}
          currentDrawKw={() => 96.5}
          onMove={onMove}
          onUnavailable={onUnavailable}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, onMove, onUnavailable };
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
      setStations: (
        s: typeof scene.stations,
        frame: { cols: number; rows: number },
        area: { cols: number; rows: number },
      ) => {
        scene.stations = s;
        scene.frame = frame;
        scene.area = area;
      },
      setTheme: vi.fn(),
      setEditing: (e: boolean) => {
        scene.editing = e;
      },
      setSelected: vi.fn(),
      fit: () => {
        scene.fits += 1;
      },
      labelPoint: () => ({ x: 100, y: 100, depth: 0.5, visible: true }),
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
    const { bays, cols, rows, area } = stationBays([
      station({ id: 'a', positionX: 20, positionY: 20 }),
      station({ id: 'b', positionX: 420, positionY: 160 }),
      station({ id: 'c', positionX: 30, positionY: 25 }),
    ]);
    expect(bays.get('a')).toEqual({ col: 0, row: 0 });
    expect(bays.get('b')).toEqual({ col: 2, row: 1 });
    expect(bays.get('c')).not.toEqual({ col: 0, row: 0 });
    expect(cols).toBe(5);
    expect(rows).toBe(3);
    // Stations may be dropped far past the framed lot.
    expect(area).toEqual({ cols: 64, rows: 48 });
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
    expect(scene.frame).toEqual({ cols: 5, rows: 2 });
    expect(scene.area).toEqual({ cols: 64, rows: 48 });
  });

  it('labels every station with its ID, a round state badge and the 4G badge, never a New tag', () => {
    renderView([station({ cellular: true, placed: false })]);
    const label = screen.getByTestId('site-layout-3d-label-sta_1');
    expect(label.textContent).toContain('CS-1');
    // A circle as tall as the chip button, with the plain glyph and the state label.
    const badge = screen.getByTestId('station-state-badge');
    expect(badge.getAttribute('data-state')).toBe('reserved');
    expect(badge.getAttribute('aria-label')).toBe('sites.layoutState.reserved');
    expect(badge.className).toContain('h-6');
    expect(badge.className).toContain('w-6');
    expect(badge.className).toContain('rounded-full');
    expect(label.querySelectorAll('[role="img"]')).toHaveLength(1);
    expect(label.querySelector('[data-testid="cellular-badge"]')).not.toBeNull();
    expect(label.querySelector('[data-testid="new-placement-tag"]')).toBeNull();
    // The ID button opens the details, also from the keyboard.
    // Labels stay hidden until the first frame places them; the stub scene renders none.
    act(() => {
      scene.callbacks?.onFrame();
    });
    fireEvent.click(screen.getByRole('button', { name: 'sites.layoutView.detailsLabel:CS-1' }));
    expect(screen.getByTestId('station-layout-popup')).toBeDefined();
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
    // Any bay of the larger edit grid, far past the framed lot.
    act(() => {
      scene.callbacks?.onDrop('sta_1', { col: 40, row: 30 });
    });
    expect(onMove).toHaveBeenLastCalledWith('sta_1', 8020, 4220);
    // Clicks open no popup in edit mode.
    act(() => {
      scene.callbacks?.onPick('sta_1');
    });
    expect(screen.queryByTestId('station-layout-popup')).toBeNull();
  });

  it('tells the parent when the browser refuses a WebGL context', () => {
    scene.throwOnCreate = true;
    const { onUnavailable } = renderView([station()]);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });
});
