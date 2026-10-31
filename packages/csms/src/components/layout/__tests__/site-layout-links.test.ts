// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => false }));
import { DEFAULT_LAYOUT_GRID } from '@evtivity/lib/site-layout';
import {
  loadFlows,
  loadLevel,
  loadLinks,
  PANEL_PAD_GAP_M,
  PANEL_PAD_PITCH_M,
  placePanels,
  WALL_CIRCUIT_OUT_M,
  WALL_PANEL_START_X,
  type LinkPanel,
} from '../site-layout-links';
import { FACADE_Z, lotOf, WALL_PANEL_PITCH_M } from '../site-layout-grid';
import { terminalSide, terminalsByStation } from '../layout-terminals';
import type { PaymentTerminal } from '@/components/payment-terminals/payment-terminal-types';

const circuit = (id: string, stations: string[]) => ({
  id,
  name: `Circuit ${id}`,
  breakerRatingAmps: 100,
  maxContinuousKw: 57.6,
  stations: stations.map((s) => ({ id: s, allocatedLimitKw: s === 'b' ? null : 22 })),
});

const panel = (
  id: string,
  circuits: ReturnType<typeof circuit>[],
  childPanels: LinkPanel[] = [],
) => ({
  id,
  name: `Panel ${id}`,
  breakerRatingAmps: 400,
  maxContinuousKw: 230.4,
  circuits,
  childPanels,
});

const stations = new Map([
  ['a', { x: 1.6, z: 0.9 }],
  ['b', { x: 4.8, z: 0.9 }],
  ['c', { x: 30, z: 12.5 }],
]);

const LOT = lotOf(DEFAULT_LAYOUT_GRID);
const OFFICE = lotOf({ ...DEFAULT_LAYOUT_GRID, siteType: 'office_retail' });

describe('load management panels', () => {
  it('stands one switchboard per panel on the grass left of a parking lot, a sub-panel next to its parent', () => {
    const placed = placePanels(
      [panel('p', [circuit('1', ['a'])], [panel('q', [])]), panel('r', [])],
      LOT,
    );
    expect(placed.map((p) => [p.id, p.parentId, p.mount])).toEqual([
      ['p', null, 'pad'],
      ['q', 'p', 'pad'],
      ['r', null, 'pad'],
    ]);
    expect(placed[0]?.point).toEqual({ x: -PANEL_PAD_GAP_M, z: LOT.depth / 2 });
    expect(placed[1]?.point).toEqual({
      x: -PANEL_PAD_GAP_M - PANEL_PAD_PITCH_M,
      z: LOT.depth / 2,
    });
    // Every cabinet stands off the lot (x < 0), whatever its place in the list.
    for (const p of placed) expect(p.point.x).toBeLessThan(0);
    expect(placed[0]).toMatchObject({ name: 'Panel p', amps: 400, kw: 230.4 });
  });

  it('hangs the panels of an office or retail site on the facade left of the first spot', () => {
    const placed = placePanels([panel('p', [], [panel('q', [])])], OFFICE);
    expect(placed.map((p) => p.mount)).toEqual(['wall', 'wall']);
    expect(placed.map((p) => p.point)).toEqual([
      { x: WALL_PANEL_START_X, z: FACADE_Z },
      { x: WALL_PANEL_START_X - WALL_PANEL_PITCH_M, z: FACADE_Z },
    ]);
  });

  it('places nothing without load management panels', () => {
    expect(placePanels([], LOT)).toEqual([]);
  });
});

describe('load management links', () => {
  it('runs from the panel to its circuits and each managed station, never from a transformer', () => {
    const hierarchy = [panel('p', [circuit('1', ['a', 'b'])])];
    const placed = placePanels(hierarchy, LOT);
    const links = loadLinks(hierarchy, placed, stations);
    expect(links.segments.map((s) => s.id)).toEqual(['circuit:1', 'station:a', 'station:b']);
    expect(links.segments[0]?.from).toEqual(placed[0]?.point);
    expect(links.segments[1]?.to).toEqual({ x: 1.6, z: 0.9 });
    // A station without an allocated limit gets a link but no label.
    expect(links.labels.map((l) => l.id)).toEqual(['panel:p', 'circuit:1', 'station:a']);
    expect(links.labels[0]).toMatchObject({
      name: 'Panel p',
      amps: 400,
      kw: 230.4,
      point: placed[0]?.point,
    });
    expect(links.labels[2]).toMatchObject({ kind: 'station', kw: 22, name: null });
  });

  it('links a sub-panel from its parent panel and walks its circuits', () => {
    const hierarchy = [panel('p', [circuit('1', ['a'])], [panel('q', [circuit('2', ['c'])])])];
    const placed = placePanels(hierarchy, LOT);
    const links = loadLinks(hierarchy, placed, stations);
    const feeder = links.segments.find((s) => s.id === 'panel:q');
    expect(feeder).toMatchObject({ from: placed[0]?.point, to: placed[1]?.point });
    expect(links.segments.map((s) => s.id)).toContain('station:c');
  });

  it('stands the circuit node of a wall panel out over the sidewalk', () => {
    const hierarchy = [panel('p', [circuit('1', ['a', 'b'])])];
    const links = loadLinks(hierarchy, placePanels(hierarchy, OFFICE), stations);
    const node = links.labels.find((l) => l.id === 'circuit:1');
    expect(node?.point.z).toBeCloseTo(FACADE_Z + WALL_CIRCUIT_OUT_M);
  });

  it('labels every panel, and leaves out circuits without a station on the lot', () => {
    const hierarchy = [panel('p', [circuit('1', ['zz'])])];
    const links = loadLinks(hierarchy, placePanels(hierarchy, LOT), stations);
    expect(links.segments).toEqual([]);
    expect(links.labels.map((l) => l.id)).toEqual(['panel:p']);
  });
});

describe('layout payment terminals', () => {
  const terminal = (overrides: Partial<PaymentTerminal>): PaymentTerminal =>
    ({
      id: 'pt_1',
      label: 'Reader',
      provider: 'idtech',
      serialNumber: 'SN1',
      providerDeviceId: null,
      stationId: 'sta_1',
      evseNumber: 1,
      status: 'active',
      online: true,
      hasDisplay: true,
      ...overrides,
    }) as PaymentTerminal;

  it('shows active paired terminals on their station, never inactive or unpaired ones', () => {
    const map = terminalsByStation([
      terminal({}),
      terminal({ id: 'pt_2', status: 'inactive' }),
      terminal({ id: 'pt_3', stationId: null }),
      terminal({ id: 'pt_4', label: null, evseNumber: null, hasDisplay: false, online: false }),
    ]);
    expect(map.get('sta_1')?.map((t) => t.id)).toEqual(['pt_1', 'pt_4']);
    expect(map.get('sta_1')?.[1]).toMatchObject({ name: 'SN1', hasDisplay: false, online: false });
  });

  it('puts a reader on its connector side, or in front for the whole station', () => {
    expect(terminalSide(1)).toBe(-1);
    expect(terminalSide(2)).toBe(1);
    expect(terminalSide(null)).toBe(0);
    expect(terminalSide(3)).toBe(0);
  });
});

describe('live load flows', () => {
  const hierarchy: LinkPanel[] = [
    panel('main', [circuit('c1', ['a', 'b'])], [panel('sub', [circuit('c2', ['c'])])]),
  ];
  const draw = new Map([
    ['a', 11],
    ['b', 28.8],
    ['c', 230.4],
  ]);

  it('sums the live draw up the hierarchy: circuits, sub-panels and panels', () => {
    const { loads } = loadFlows(hierarchy, (id) => draw.get(id));
    expect(loads.get('c1')).toEqual({ drawKw: 39.8, limitKw: 57.6 });
    expect(loads.get('c2')?.drawKw).toBe(230.4);
    expect(loads.get('sub')?.drawKw).toBe(230.4);
    expect(loads.get('main')?.drawKw).toBeCloseTo(270.2);
  });

  it('scales each link by its share of the limit, 0 to 1', () => {
    const { segments } = loadFlows(hierarchy, (id) => draw.get(id));
    // a: 11 of its allocated 22 kW.
    expect(segments.get('station:a')).toBe(0.5);
    // b has no allocated limit: half the circuit's 57.6 kW.
    expect(segments.get('station:b')).toBe(1);
    expect(segments.get('circuit:c1')).toBeCloseTo(39.8 / 57.6);
    // A link never shows more than full.
    expect(segments.get('circuit:c2')).toBe(1);
    expect(segments.get('panel:sub')).toBe(1);
  });

  it('shows no flow for a station that draws nothing or reports nothing', () => {
    const { segments, loads } = loadFlows(hierarchy, () => undefined);
    expect(segments.get('station:a')).toBe(0);
    expect(loads.get('main')?.drawKw).toBe(0);
  });

  it('marks a load near its limit from 80 percent and at its limit from 100 percent', () => {
    expect(loadLevel(79, 100)).toBe('normal');
    expect(loadLevel(80, 100)).toBe('near');
    expect(loadLevel(100, 100)).toBe('at');
    expect(loadLevel(120, 100)).toBe('at');
    expect(loadLevel(50, null)).toBe('normal');
  });
});
