// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  PAD_MOUNT_TRANSFORMER_KVA,
  STEP_DOWN_TRANSFORMER_KVA,
  computeMaxContinuousKw,
} from '@evtivity/lib/load-allocation';
import {
  DUAL_PORT_SHARED_AMPS,
  GROUP_MAX_KW,
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
import { seedAllowsSimulatedEnergyAssets } from '../seed-demo-layout.js';
import { STATION_MODELS, STATION_MODELS_16 } from '../seed-station-defs.js';
import {
  KEMPOWER_C502P200_FUSE_AMPS,
  LAYOUT_DEMO,
  LEVEL_2_AMPS,
  STEP_DOWN_MAX_OCPD_AMPS,
  dcInputAmps,
  demoStepDowns,
  serviceTransformerKva,
  stepDownTransformerKva,
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
    expect(PAD_MOUNT_TRANSFORMER_KVA as readonly number[], at).toContain(group.transformerKva);
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
      // Its step-down transformer: an EV-11.10 rating covering its load and its main.
      expect(STEP_DOWN_TRANSFORMER_KVA as readonly number[], at).toContain(p.stepDownKva);
      expect(p.stepDownKva, at).toBeGreaterThanOrEqual(p.loadKw);
      expect(
        STEP_DOWN_MAX_OCPD_AMPS[p.stepDownKva as (typeof STEP_DOWN_TRANSFORMER_KVA)[number]],
        at,
      ).toBeGreaterThanOrEqual(p.amps);
      expect(p.stepDownKva, at).toBe(stepDownTransformerKva(p.loadKw, p.amps));
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
      // Each transformer feeds one switchboard and carries its load; every
      // 480Y/277 V switchboard has its transformer (208Y/120 V building and
      // street services have none).
      const roots = site.panels.filter((p) => p.parentPanelId == null);
      for (const t of site.settings.transformers) {
        const fed = roots.find((p) => p.id === t.feeds);
        expect(fed, `${site.name} ${t.name}`).toBeDefined();
        expect(loadOf(fed!.id), `${site.name} ${t.name}`).toBeLessThanOrEqual(t.ratedKva);
        expect(PAD_MOUNT_TRANSFORMER_KVA as readonly number[]).toContain(t.ratedKva);
      }
      for (const root of roots.filter((p) => p.voltageV === V480)) {
        expect(
          site.settings.transformers.filter((t) => t.feeds === root.id),
          `${site.name} ${root.name}`,
        ).toHaveLength(1);
      }
      // Every 208Y/120 V panelboard under a 480Y/277 V switchboard has its step-down unit.
      const stepDowns = demoStepDowns(site);
      const fedBoards = site.panels.filter(
        (p) =>
          p.voltageV === V208 &&
          site.panels.find((q) => q.id === p.parentPanelId)?.voltageV === V480,
      );
      expect(stepDowns.map((t) => t.panelId).sort(), site.name).toEqual(
        fedBoards.map((p) => p.id).sort(),
      );
      for (const t of stepDowns) {
        expect(loadOf(t.panelId), `${site.name} ${t.name}`).toBeLessThanOrEqual(t.ratedKva);
      }
    }
  });

  it('rates the demo transformers from the connected kVA, compared without a power factor', () => {
    // Connected kVA (research 2026-11-03): Terra 184 sqrt(3) x 480 x 230 =
    // 191.2 kVA, Level 2 208 x 32 = 6.66 kVA, ABB HVC 450PD 510 kVA, HVC-C
    // 150 170 kVA and HVC360 (NA) 391 kVA (datasheets), other DC kW / (0.96 x 0.96).
    const terra = (Math.sqrt(3) * 480 * 230) / 1000;
    const l2 = (208 * 32) / 1000;
    const truck = (2 * 1000 + 240) / (0.96 * 0.96);
    expect(serviceTransformerKva(11 * terra)).toBe(2500);
    expect(serviceTransformerKva(4 * terra + 8 * l2)).toBe(1000);
    expect(serviceTransformerKva(3 * terra + 5 * l2)).toBe(750);
    // The depot bus group: 3 HVC 450PD, one HVC-C 150 and the dual-outlet charger's HVC360.
    expect(serviceTransformerKva(3 * 510 + 170 + 391)).toBe(2500);
    // The truck group's 2431 kVA would take 2500 kVA at 97 percent; the plan keeps headroom at 3000.
    expect(serviceTransformerKva(truck)).toBe(2500);
    const rated = (siteId: string) =>
      LAYOUT_DEMO.sites.find((s) => s.id === siteId)!.settings.transformers.map((t) => t.ratedKva);
    expect(rated('sit_demolayout01')).toEqual([2500]);
    expect(rated('sit_demolayout07')).toEqual([1000]);
    expect(rated('sit_demolayout05')).toEqual([750]);
    expect(rated('sit_demolayout06')).toEqual([2500, 3000]);
    // A load at a rating's kVA fits it: no division by 0.95 first.
    expect(serviceTransformerKva(750)).toBe(750);
    // The standard low-voltage list ends at 3750 kVA (SMU App. 26-C 1.1).
    expect(serviceTransformerKva(3750)).toBe(3750);
    expect(() => serviceTransformerKva(3751)).toThrow();
  });

  it('sizes each step-down transformer from the SDG&E Table EV-11.10 list', () => {
    // A 225 A panelboard takes 75 kVA (250 A), a 400 A one 112.5 kVA (400 A), or 150 kVA past 112.5 kVA.
    expect(stepDownTransformerKva(26.6, 225)).toBe(75);
    expect(stepDownTransformerKva(80, 225)).toBe(112.5);
    expect(stepDownTransformerKva(26.6, 400)).toBe(112.5);
    expect(stepDownTransformerKva(115.3, 400)).toBe(150);
    expect(() => stepDownTransformerKva(501, 225)).toThrow();
    const units = (siteId: string) =>
      demoStepDowns(LAYOUT_DEMO.sites.find((s) => s.id === siteId)!).map((t) => t.ratedKva);
    // Patroon Creek LP-1 and LP-2 (4 pedestals each, 26.6 kVA), Willow Creek LP-1 (5, 33.3 kVA).
    expect(units('sit_demolayout07')).toEqual([75, 75]);
    expect(units('sit_demolayout05')).toEqual([75]);
    for (const site of ['sit_demolayout01', 'sit_demolayout02', 'sit_demolayout06']) {
      expect(units(site), site).toEqual([]);
    }
  });

  it('stores simulated telemetry only where ENERGY_ASSETS_ALLOW_SIMULATED allows it', () => {
    expect(seedAllowsSimulatedEnergyAssets({ ENERGY_ASSETS_ALLOW_SIMULATED: 'true' })).toBe(true);
    expect(
      seedAllowsSimulatedEnergyAssets({ ENERGY_ASSETS_ALLOW_SIMULATED: 'false', NODE_ENV: 'test' }),
    ).toBe(false);
    expect(seedAllowsSimulatedEnergyAssets({ NODE_ENV: 'development' })).toBe(true);
    expect(seedAllowsSimulatedEnergyAssets({ NODE_ENV: 'production' })).toBe(false);
    expect(seedAllowsSimulatedEnergyAssets({})).toBe(false);
  });
});
