// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { computeMaxContinuousKw } from '@evtivity/lib/load-allocation';
import {
  DUAL_PORT_SHARED_AMPS,
  GROUP_MAX_KW,
  PAD_MOUNT_KVA,
  PANELBOARD_SPACES,
  V208,
  V480,
  groupTransformerPoints,
  planSitePower,
  plannedAcCircuit,
  plannedDcCircuit,
  plannedGroup,
  stationLoadKw,
  type PlannedGroup,
  type PowerStation,
} from '../seed-site-power-plan.js';
import { isEarlierBaseTree } from '../seed-site-power.js';
import { STATION_MODELS, STATION_MODELS_16 } from '../seed-station-defs.js';
import {
  KEMPOWER_C502P200_FUSE_AMPS,
  LAYOUT_DEMO,
  LEVEL_2_AMPS,
  dcInputAmps,
} from '../seed-demo-layout-plan.js';

/** A deterministic stand-in for the base seed's random picks. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const DC_TYPES = new Set(['CCS1', 'CCS2', 'CHAdeMO']);

/** A base seed site: `count` stations of the seed's models, on a lot of 10 spots a row. */
function baseSite(count: number, seed: number): PowerStation[] {
  const rand = lcg(seed);
  return Array.from({ length: count }, (_, i) => {
    const models = rand() < 0.5 ? STATION_MODELS : STATION_MODELS_16;
    const m = models[Math.floor(rand() * models.length)]!;
    const dc = DC_TYPES.has(m.type) && m.power > 22;
    return {
      id: `sta_${String(i)}`,
      kind: dc ? ('dc' as const) : ('ac' as const),
      kw: m.power,
      ports: 1 + Math.floor(rand() * 3),
      portAmps: m.amps,
      spot: { x: (i % 10) * 2.7, z: Math.floor(i / 10) * 8 },
    };
  });
}

function expectWithinRatings(groups: readonly PlannedGroup[], name: string): void {
  for (const [g, group] of groups.entries()) {
    const at = `${name} group ${String(g + 1)}`;
    // The transformer is a standard rating at least the group's connected load.
    expect(PAD_MOUNT_KVA as readonly number[], at).toContain(group.transformerKva);
    expect(group.transformerKva, at).toBeGreaterThanOrEqual(group.loadKw);
    // The switchboard carries it at 80 percent of its main.
    expect(group.loadKw, at).toBeLessThanOrEqual(
      computeMaxContinuousKw(group.switchboardAmps, V480, 3) + 1e-6,
    );
    expect(group.loadKw, at).toBeLessThanOrEqual(GROUP_MAX_KW);
    for (const c of group.dc) {
      // Each DC charger on its own breaker of at least 125 percent of its input.
      expect(c.breakerAmps, at).toBeGreaterThanOrEqual(
        (c.loadKw / (Math.sqrt(3) * 0.48)) * 1.25 - 1,
      );
    }
    for (const p of group.panelboards) {
      expect([225, 400], at).toContain(p.amps);
      expect(p.loadKw, at).toBeLessThanOrEqual(computeMaxContinuousKw(p.amps, V208, 3) + 1e-6);
      expect(p.spaces, at).toBeLessThanOrEqual(PANELBOARD_SPACES);
      expect(p.spaces, at).toBe(2 * p.circuits.length);
    }
    const sum =
      group.dc.reduce((n, c) => n + c.loadKw, 0) +
      group.panelboards.reduce((n, p) => n + p.loadKw, 0);
    expect(sum, at).toBeCloseTo(group.loadKw, 1);
  }
}

describe('demo site power plan', () => {
  it('sizes every base seed site of 1 to 127 stations within every rating', () => {
    for (const count of [1, 5, 40, 82, 100, 127]) {
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const stations = baseSite(count, seed);
        const groups = planSitePower(stations);
        expectWithinRatings(groups, `${String(count)} stations, seed ${String(seed)}`);
        // Every station on exactly one circuit.
        const fed = groups.flatMap((g) => [
          ...g.dc.map((c) => c.stationId),
          ...g.panelboards.flatMap((p) => p.circuits.map((c) => c.stationId)),
        ]);
        expect(new Set(fed).size).toBe(count);
        expect(fed).toHaveLength(count);
        // As few groups as the 4000 A ceiling allows (within one of the bound).
        const total = stations.reduce((n, s) => n + stationLoadKw(s), 0);
        expect(groups.length).toBeLessThanOrEqual(Math.ceil(total / (GROUP_MAX_KW * 0.95)) + 1);
      }
    }
  });

  it('splits a large site into several transformer and switchboard groups', () => {
    const stations = baseSite(127, 11);
    const groups = planSitePower(stations);
    const total = stations.reduce((n, s) => n + stationLoadKw(s), 0);
    expect(total).toBeGreaterThan(GROUP_MAX_KW);
    expect(groups.length).toBeGreaterThan(1);
    // Each group a contiguous band of rows: its stations stand together.
    const zOf = new Map(stations.map((s) => [s.id, s.spot.z]));
    for (let g = 1; g < groups.length; g++) {
      const prevMax = Math.max(...groups[g - 1]!.stationIds.map((id) => zOf.get(id)!));
      const min = Math.min(...groups[g]!.stationIds.map((id) => zOf.get(id)!));
      expect(min).toBeGreaterThanOrEqual(prevMax);
    }
    // One transformer per group at the lot edge, level with its group, apart from the next.
    const spots = new Map(stations.map((s) => [s.id, s.spot]));
    const points = groupTransformerPoints(groups, spots, { width: 27, depth: 104 }, 2.5);
    expect(points).toHaveLength(groups.length);
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.z - points[i - 1]!.z).toBeGreaterThanOrEqual(6);
      expect(points[i]!.x).toBe(29.5);
    }
  });

  it('sizes an AC Level 2 port at 6.66 kW (32 A at 208 V) and a DC charger by its input', () => {
    const ac: PowerStation = {
      id: 'a',
      kind: 'ac',
      kw: 7,
      ports: 1,
      portAmps: 32,
      spot: { x: 0, z: 0 },
    };
    expect(stationLoadKw(ac)).toBeCloseTo(6.66, 2);
    const dc: PowerStation = { ...ac, kind: 'dc', kw: 180, portAmps: 0 };
    expect(stationLoadKw(dc)).toBeCloseTo((Math.sqrt(3) * 480 * dcInputAmps(180)) / 1000, 1);
  });

  it('puts a dual-port AC pedestal on one 2-pole 40 A circuit with power sharing', () => {
    const pedestal: PowerStation = {
      id: 'p',
      kind: 'ac',
      kw: 7,
      ports: 2,
      portAmps: 32,
      spot: { x: 0, z: 0 },
    };
    const circuit = plannedAcCircuit(pedestal, 0);
    // 32 A shared by both ports (not 2 x 32 = 64 A on an 80 A breaker).
    expect(circuit.breakerAmps).toBe(40);
    expect(circuit.loadKw).toBeCloseTo((208 * DUAL_PORT_SHARED_AMPS) / 1000, 2);
    // Ports above 32 A share the same circuit too; a single port keeps its own current.
    expect(plannedAcCircuit({ ...pedestal, portAmps: 48 }, 0).breakerAmps).toBe(40);
    expect(plannedAcCircuit({ ...pedestal, ports: 1, portAmps: 48 }, 0).breakerAmps).toBe(60);
    // Panel loading counts each pedestal once at 32 A: 21 pedestals load
    // 140 kW, past the 115 kW a 400 A panelboard carries continuously, so two.
    const many = Array.from({ length: 21 }, (_, i) => ({ ...pedestal, id: `p${String(i)}` }));
    const group = plannedGroup(many);
    expect(group.loadKw).toBeCloseTo(21 * 6.66, 1);
    expect(group.panelboards).toHaveLength(2);
    for (const board of group.panelboards) {
      expect(board.spaces).toBeLessThanOrEqual(42);
      expect(board.loadKw).toBeLessThanOrEqual(board.maxContinuousKw);
      expect(board.circuits.every((c) => c.breakerAmps === 40)).toBe(true);
    }
  });

  it('sizes the DC models with a datasheet input by that input, the others by 0.96 and 0.96', () => {
    const base: PowerStation = {
      id: 'k',
      kind: 'dc',
      kw: 200,
      ports: 4,
      portAmps: 300,
      spot: { x: 0, z: 0 },
    };
    // Kempower C502P200 continuous: 278 A at 480 V (231 kVA), 400 A recommended fuse.
    const kempower = plannedDcCircuit({ ...base, model: 'C-Series Satellites' });
    expect(kempower.breakerAmps).toBe(KEMPOWER_C502P200_FUSE_AMPS);
    expect(kempower.loadKw).toBeCloseTo((Math.sqrt(3) * 480 * 278) / 1000, 1);
    expect(kempower.loadKw).toBeCloseTo(231, 0);
    // ABB Terra 184: 230 A and a 300 A breaker.
    const terra = plannedDcCircuit({ ...base, kw: 180, ports: 2, model: 'Terra 184' });
    expect(terra.breakerAmps).toBe(300);
    expect(terra.loadKw).toBeCloseTo((Math.sqrt(3) * 480 * 230) / 1000, 1);
    // A model without a datasheet value.
    const other = plannedDcCircuit({ ...base, kw: 150, ports: 2, model: 'Series 6' });
    expect(other.loadKw).toBeCloseTo((Math.sqrt(3) * 480 * dcInputAmps(150)) / 1000, 1);
  });

  it('recognizes only the untouched tree of the earlier base seed', () => {
    const panel = {
      name: 'Main Panel C',
      breakerRatingAmps: 150,
      voltageV: 240,
      parentPanelId: null,
    };
    const circuits = [
      { name: 'Circuit 1', breakerRatingAmps: 40 },
      { name: 'Circuit 2', breakerRatingAmps: 50 },
    ];
    expect(isEarlierBaseTree([panel], circuits)).toBe(true);
    // An operator's rename, rating, second panel or own circuit keeps the tree.
    expect(isEarlierBaseTree([{ ...panel, name: 'Garage Panel' }], circuits)).toBe(false);
    expect(isEarlierBaseTree([{ ...panel, breakerRatingAmps: 400 }], circuits)).toBe(false);
    expect(isEarlierBaseTree([panel, { ...panel, name: 'Main Panel D' }], circuits)).toBe(false);
    expect(
      isEarlierBaseTree([panel], [...circuits, { name: 'Circuit 3', breakerRatingAmps: 40 }]),
    ).toBe(false);
    expect(isEarlierBaseTree([], [])).toBe(false);
  });
});

describe('site layout demo power equipment', () => {
  it('keeps every transformer and panel of every demo site within its rating', () => {
    for (const site of LAYOUT_DEMO.sites) {
      const stationLoad = (s: (typeof site.stations)[number]): number =>
        s.kind === 'dc'
          ? (Math.sqrt(3) * 480 * dcInputAmps(s.maxPowerKw ?? 150)) / 1000
          : // A Level 2 station, also a dual-port pedestal sharing one circuit: 32 A at 208 V.
            (208 * LEVEL_2_AMPS) / 1000;
      const loadOf = (panelId: string): number => {
        const panel = site.panels.find((p) => p.id === panelId)!;
        const own = panel.circuits.reduce(
          (n, c) =>
            n +
            site.stations
              .filter((s) => s.circuitId === c.id)
              .reduce((m, s) => m + stationLoad(s), 0),
          0,
        );
        const children = site.panels
          .filter((p) => p.parentPanelId === panelId)
          .reduce((n, p) => n + loadOf(p.id), 0);
        return own + children;
      };
      for (const panel of site.panels) {
        expect(loadOf(panel.id), `${site.name} ${panel.name}`).toBeLessThanOrEqual(
          panel.maxContinuousKw + 1e-6,
        );
        // Spaces: a DC breaker of a switchboard is 3-pole, a Level 2 breaker 2-pole.
        if (panel.voltageV === V208) {
          expect(panel.circuits.length * 2, `${site.name} ${panel.name}`).toBeLessThanOrEqual(
            PANELBOARD_SPACES,
          );
        }
      }
      // The j-th top-level panel stands at the j-th transformer, the last one takes the rest.
      const roots = site.panels.filter((p) => p.parentPanelId == null);
      const transformers = site.settings.transformers;
      transformers.forEach((t, j) => {
        const fed = roots.filter((_, i) => Math.min(i, transformers.length - 1) === j);
        const load = fed.reduce((n, p) => n + loadOf(p.id), 0);
        if (t.ratedKva != null) {
          expect(load, `${site.name} ${t.name ?? t.id}`).toBeLessThanOrEqual(t.ratedKva);
        }
      });
    }
  });
});
