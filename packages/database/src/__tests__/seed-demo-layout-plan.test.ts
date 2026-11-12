// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { layoutEquipmentRowId } from '../lib/layout-equipment-id.js';
import {
  CHARGER_PORT_LIMITS,
  accessibleChargingSpace,
  bayInLayout,
  bayToPosition,
  modelsAccessibleSpace,
  chargerMountingOf,
  groupedSpotOrder,
  depotLayout,
  depotStationKind,
  freeSpotCount,
  overlappingFreeStations,
  snapFreePlacement,
  usesFreePositions,
  effectiveLayoutSettings,
  layoutCapacity,
  layoutRowLengths,
  sameLayoutSettings,
  siteTypeOf,
  freeSlotsFor,
  positionToBay,
  sharesSpotPair,
  spotPairPartner,
  stationSpanCount,
} from '@evtivity/lib/site-layout';
import { freePlacementSchema, siteLayoutSettingsSchema } from '@evtivity/lib/site-layout-schema';
import {
  DEPOT_BODY_TYPE_BATTERY,
  LAYOUT_DEMO,
  LAYOUT_DEMO_PREVIOUS_SETTINGS,
  LAKESIDE_WALL_PAIR_PORTS,
  demoLayoutPositions,
  type DemoLayoutSettings,
  LEVEL_2_AMPS,
  TERRA_184_INPUT_AMPS,
  HVC_450PD_INPUT_AMPS,
  HVC_C_150_INPUT_AMPS,
  HVC360_INPUT_AMPS,
  HVC360_INPUT_KVA,
  HVC_450PD_INPUT_KVA,
  HVC_C_150_INPUT_KVA,
  dcInputAmps,
  evseBreakerAmps,
  LINDENHOF_BOX_AMPS,
  serviceTransformerKva,
} from '../seed-demo-layout-plan.js';
import type { LayoutDemoPanel, LayoutDemoSite } from '../seed-demo-layout-plan.js';
import { DEMO_MODEL_BODY_TYPES } from '../seed-demo-vehicles.js';

const [harbor, lakeside, riverside, maple, willow, depot, patroon] = LAYOUT_DEMO.sites;
const allStations = LAYOUT_DEMO.sites.flatMap((s) => s.stations);
/** The energy assets of a demo plan, with their names and ratings. */
const assetsOf = (s: DemoLayoutSettings) => s.energyAssets ?? [];
/** Whether two demo plans of a site store the same layout settings (positions by row id). */
const same = (siteId: string, a: DemoLayoutSettings, b: DemoLayoutSettings): boolean =>
  sameLayoutSettings(demoLayoutPositions(siteId, a), demoLayoutPositions(siteId, b));

describe('site layout demo plan', () => {
  it('makes Harbor Point a parking lot of DC fast chargers with its transformers', () => {
    expect(siteTypeOf(harbor!.settings)).toBe('parking_lot');
    expect(new Set(harbor!.stations.map((s) => s.kind))).toEqual(new Set(['dc']));
    expect(harbor!.settings.transformers.length).toBeGreaterThan(0);
    // Lot Edge: every station stands in the front or the back edge row.
    expect(harbor!.settings.chargerPlacement).toBe('lot_edge');
    for (const s of harbor!.stations) {
      expect(bayInLayout({ col: s.col, row: s.row }, harbor!.settings)).toBe(true);
    }
    // One battery on the grass and one solar canopy over the front edge row
    // (row 0), so its columns stand past the lot edge, never at a drive aisle.
    const assets = assetsOf(harbor!.settings);
    expect(assets.map((a) => a.type).sort()).toEqual(['battery', 'solar']);
    expect(assets.find((a) => a.type === 'solar')).toMatchObject({ row: 0 });
    const stored = demoLayoutPositions(harbor!.id, harbor!.settings);
    const effective = effectiveLayoutSettings(stored);
    expect(effective.energyAssets).toEqual(stored.energyAssets);
  });

  it('makes Lakeside Retail Park an office or retail site of AC chargers along the building, no transformers', () => {
    expect(siteTypeOf(lakeside!.settings)).toBe('office_retail');
    expect(new Set(lakeside!.stations.map((s) => s.kind))).toEqual(new Set(['ac']));
    expect(lakeside!.settings.transformers).toEqual([]);
    // Every charger stands in the row along the building (wall boxes), 12 positions.
    expect(new Set(lakeside!.stations.map((s) => s.row))).toEqual(new Set([0]));
    expect(lakeside!.settings.chargers).toBe(12);
    expect(chargerMountingOf(lakeside!.settings)).toBe('wall');
  });

  it('gives Lakeside one two-port wall box on the line between two spots, the run continuous', () => {
    const pairs = lakeside!.stations.filter((s) => (s.evses ?? 1) >= 2);
    expect(pairs.map((s) => s.stationId)).toEqual(['CS-3019']);
    expect(pairs[0]?.evses).toBe(LAKESIDE_WALL_PAIR_PORTS);
    const pair = pairs[0]!;
    expect(sharesSpotPair({ charging: 'ac', ports: pair.evses ?? 1 }, lakeside!.settings)).toBe(
      true,
    );
    expect(spotPairPartner({ col: pair.col, row: pair.row }, lakeside!.settings)).toEqual({
      col: pair.col + 1,
      row: 0,
    });
    // The held spots form one run with no charger-free spot inside it.
    const held = lakeside!.stations
      .flatMap((s) => ((s.evses ?? 1) >= 2 ? [s.col, s.col + 1] : [s.col]))
      .sort((a, b) => a - b);
    expect(new Set(held).size).toBe(held.length);
    expect(held.at(-1)! - held[0]!).toBe(held.length - 1);
    // The box after it moves on from where the plan before stood it.
    const next = lakeside!.stations.find((s) => s.stationId === 'CS-3020');
    expect(next?.before).toEqual({ col: 9, row: 0 });
    expect(next?.col).toBe(10);
  });

  it('makes Riverside Medical Offices an office or retail site with posts at the spots', () => {
    expect(siteTypeOf(riverside!.settings)).toBe('office_retail');
    expect(chargerMountingOf(riverside!.settings)).toBe('stall');
    expect(new Set(riverside!.stations.map((s) => s.kind))).toEqual(new Set(['ac']));
  });

  it('makes Maple Street a curbside site with AC posts on both curbs', () => {
    expect(siteTypeOf(maple!.settings)).toBe('curbside');
    // Five spots on the left curb: the last two hold the two-port post (owner decision 2026-11-12).
    expect(layoutRowLengths(maple!.settings)).toEqual([5, 4]);
    expect(maple!.stations.find((s) => s.col === 3 && s.row === 0)?.evses).toBe(2);
    expect(new Set(maple!.stations.map((s) => s.kind))).toEqual(new Set(['ac']));
    expect(new Set(maple!.stations.map((s) => s.row))).toEqual(new Set([0, 1]));
  });

  it('makes Willow Creek a custom site of stations placed freely along a curve, no spot shared', () => {
    expect(siteTypeOf(willow!.settings)).toBe('custom');
    expect(usesFreePositions(willow!.settings)).toBe(true);
    // DC chargers with two EVSEs (two spots each) and AC pedestals with one.
    expect(new Set(willow!.stations.map((s) => s.kind))).toEqual(new Set(['ac', 'dc']));
    const free = willow!.stations.map((s) => {
      expect(s.free).toBeDefined();
      expect(freePlacementSchema.safeParse(s.free).success).toBe(true);
      // Stored as an operator would place it: positions on the 0.5 m grid.
      expect(snapFreePlacement(s.free!, { freeRotation: true })).toEqual(s.free);
      return { key: s.id, placement: s.free!, spots: freeSpotCount(s.kind === 'dc' ? 2 : 1) };
    });
    expect(overlappingFreeStations(free)).toEqual([]);
    // Irregular: the curve turns every station its own way; the row under the canopy is straight.
    expect(new Set(free.map((f) => f.placement.rotationDeg)).size).toBe(free.length - 3);
    // A transformer, a battery and a free-standing solar canopy, and one display message.
    expect(willow!.settings.transformers).toHaveLength(1);
    const assets = assetsOf(willow!.settings);
    // Its back edge (and column line) 2 m behind the pedestals at z -24.
    expect(assets.find((a) => a.type === 'solar')).toMatchObject({ x: 4.5, z: -23 });
    expect(willow!.stations.filter((s) => s.message != null)).toHaveLength(1);
    expect(willow!.stations.find((s) => s.message != null)?.kind).toBe('dc');
    // The canopy stands over the row of three AC pedestals.
    expect(free.filter((f) => f.placement.z === -24 && f.placement.rotationDeg === 0)).toHaveLength(
      4,
    );
    // AC and DC grouped along the curve (by grid slot, the order they stand in):
    // the DC chargers first, nearest the transformer, then the AC pedestals.
    const byCol = [...willow!.stations].sort((a, b) => a.col - b.col).map((s) => s.kind);
    expect(byCol).toEqual(['dc', 'dc', 'dc', 'ac', 'ac', 'ac', 'ac', 'ac']);
    const tx = willow!.settings.transformers[0]!;
    const dist = (s: { free?: { x: number; z: number } | undefined }) =>
      Math.hypot(s.free!.x - tx.x, s.free!.z - tx.z);
    const dcFar = Math.max(...willow!.stations.filter((s) => s.kind === 'dc').map(dist));
    const acNear = Math.min(...willow!.stations.filter((s) => s.kind === 'ac').map(dist));
    expect(dcFar).toBeLessThan(acNear);
    // A rerun swaps them only from the earlier plan's positions: every earlier
    // position is a position of this plan, so the swap leaves no spot shared.
    const before = willow!.stations.flatMap((s) => (s.before != null ? [s.before.free] : []));
    expect(before).toHaveLength(4);
    for (const b of before) {
      expect(willow!.stations.some((s) => JSON.stringify(s.free) === JSON.stringify(b))).toBe(true);
    }
  });

  it('makes Northgate Fleet Depot a depot of bus bays and truck pull-through lanes, one station each', () => {
    expect(depot!.name).toBe('Northgate Fleet Depot');
    expect(siteTypeOf(depot!.settings)).toBe('depot');
    expect(
      siteLayoutSettingsSchema.safeParse(demoLayoutPositions(depot!.id, depot!.settings)).success,
    ).toBe(true);
    // Six bus bays (one free) and three truck lanes.
    expect(layoutRowLengths(depot!.settings)).toEqual([6, 3]);
    const inRow = (row: number) => depot!.stations.filter((s) => s.row === row);
    // Depot pantograph poles (OppCharge) and plug-in dispensers in the bus bays,
    // megawatt (cMCS) and box truck dispensers in the truck lanes.
    expect(inRow(0).filter((s) => s.connectorType === 'OppCharge')).toHaveLength(3);
    expect(inRow(0).filter((s) => s.connectorType === 'CCS1')).toHaveLength(2);
    expect(inRow(1).filter((s) => s.connectorType === 'cMCS')).toHaveLength(2);
    expect(inRow(1)).toHaveLength(3);
    // Each station has its own bay or lane, and its connectors give it the area it is in.
    for (const s of depot!.stations) {
      expect(bayInLayout({ col: s.col, row: s.row }, depot!.settings)).toBe(true);
      const kind = depotStationKind([
        { connectorType: s.connectorType ?? null, maxPowerKw: s.maxPowerKw ?? null },
      ]);
      expect(kind === 'truck').toBe(s.connectorType === 'cMCS');
      // A depot charges DC only: every station takes a bay or lane.
      expect(kind).not.toBeNull();
      expect(s.kind).toBe('dc');
      expect(s.free).toBeUndefined();
    }
    const slots = new Set(depot!.stations.map((s) => `${String(s.col)}:${String(s.row)}`));
    expect(slots.size).toBe(depot!.stations.length);
    expect(new Set(depot!.stations.map((s) => s.kind))).toEqual(new Set(['dc']));
    // A transformer and a battery on the grass outside the yard, two switchboards
    // (one under the other) and a message on a pole.
    // Outside the paved yard's edge (its outline steps back between the bus and truck areas).
    const outline = depotLayout(depot!.settings).outline;
    const outside = (p: { x: number; z: number }) => {
      let inside = false;
      for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
        const a = outline[i]!;
        const b = outline[j]!;
        if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) {
          inside = !inside;
        }
      }
      return !inside;
    };
    // One equipment pad per charger group: a transformer for the buses, one for the trucks.
    expect(depot!.settings.transformers.map((t) => t.name)).toEqual([
      'Bus Charging Transformer',
      'Truck Charging Transformer',
    ]);
    expect(depot!.settings.transformers.every(outside)).toBe(true);
    const assets = assetsOf(depot!.settings);
    expect(assets.map((a) => a.type)).toEqual(['battery']);
    expect(assets.every((a) => a.type === 'battery' && outside(a))).toBe(true);
    // Stored on the grass already: the effective settings do not move them.
    const stored = demoLayoutPositions(depot!.id, depot!.settings);
    const effective = effectiveLayoutSettings(stored);
    expect(effective.transformers).toEqual(stored.transformers);
    expect(effective.energyAssets).toEqual(stored.energyAssets);
    expect(depot!.panels).toHaveLength(2);
    expect(depot!.stations.filter((s) => s.message != null)).toHaveLength(1);
    // A rerun converts the custom site an earlier plan seeded, the depot with one
    // substation, the depot with the 3000 kVA truck transformer and the depot with
    // its equipment out on the grass.
    expect(LAYOUT_DEMO_PREVIOUS_SETTINGS[depot!.id]?.map((p) => siteTypeOf(p))).toEqual([
      'custom',
      'depot',
      'depot',
      'depot',
    ]);
    // Two standard pad-mount units (2500 and 3000 kVA), each feeding its group's switchboard.
    expect(depot!.settings.transformers.map((t) => t.ratedKva)).toEqual([2500, 3000]);
    // The bus unit carries its cabinets' input: 3 HVC 450PD, an HVC-C 150 and the HVC360.
    const busKva = 3 * HVC_450PD_INPUT_KVA + HVC_C_150_INPUT_KVA + HVC360_INPUT_KVA;
    expect(busKva).toBe(2091);
    expect(depot!.settings.transformers[0]?.ratedKva).toBe(serviceTransformerKva(busKva));
    expect(depot!.settings.transformers.map((t) => t.feeds)).toEqual([
      'pnl_demolayout08',
      'pnl_demolayout09',
    ]);
  });

  it('gives the depot fleet one bus, semi truck or box truck per driver, charging at the depot', () => {
    const fleet = LAYOUT_DEMO.fleet;
    expect(fleet.siteId).toBe(depot!.id);
    const bodyTypes = fleet.drivers.map((d) => d.vehicle.bodyType);
    expect(bodyTypes.filter((b) => b === 'bus')).toHaveLength(6);
    expect(bodyTypes.filter((b) => b === 'semi_truck')).toHaveLength(4);
    expect(bodyTypes.filter((b) => b === 'box_truck')).toHaveLength(2);
    for (const d of fleet.drivers) {
      // Demo addresses (reserved example domain), the body type of the model.
      expect(d.email).toMatch(/@northgate-fleet\.example$/);
      expect(DEMO_MODEL_BODY_TYPES[d.vehicle.model]).toBe(d.vehicle.bodyType);
      expect(d.id).toMatch(/^drv_demo/);
    }
    // Fixed ids, each unique.
    for (const key of ['id', 'email', 'idToken'] as const) {
      expect(new Set(fleet.drivers.map((d) => d[key])).size).toBe(fleet.drivers.length);
    }
    expect(new Set(fleet.drivers.map((d) => d.vehicle.color)).size).toBeGreaterThanOrEqual(6);
  });

  it('uses ids in the format the detail routes accept (prefix and 12 lowercase characters)', () => {
    const fleet = LAYOUT_DEMO.fleet;
    const routeId = (prefix: string) => new RegExp(`^${prefix}_[a-z0-9]{12}$`);
    expect(fleet.id).toMatch(routeId('flt'));
    for (const d of fleet.drivers) {
      expect(d.id).toMatch(routeId('drv'));
      expect(d.vehicle.id).toMatch(routeId('veh'));
      expect(`dtk_demodepot${d.id.slice(-3)}`).toMatch(routeId('dtk'));
    }
    for (const site of LAYOUT_DEMO.sites) {
      expect(site.id).toMatch(routeId('sit'));
      for (const station of site.stations) expect(station.id).toMatch(routeId('sta'));
    }
  });

  it('gives every depot vehicle its battery data and a weekday departure, one of them tight', () => {
    const fleet = LAYOUT_DEMO.fleet;
    expect(fleet.loadStrategy).toBe('departure_aware');
    const times = (bodyType: string) =>
      new Set(
        fleet.drivers
          .filter((d) => d.vehicle.bodyType === bodyType)
          .map((d) => d.departure.departureTime),
      );
    expect(times('bus')).toEqual(new Set(['05:30', '06:15']));
    expect(times('semi_truck')).toEqual(new Set(['04:00']));
    expect(times('box_truck')).toEqual(new Set(['07:00']));
    const BUFFER_HOURS = 0.5;
    const hoursNeeded: number[] = [];
    for (const d of fleet.drivers) {
      const v = d.vehicle;
      // Within the database CHECKs of vehicles and of departure schedules.
      expect(v.batteryCapacityKwh).toBeGreaterThanOrEqual(1);
      expect(v.batteryCapacityKwh).toBeLessThanOrEqual(2000);
      expect(v.maxChargePowerKw).toBeGreaterThanOrEqual(1);
      expect(v.maxChargePowerKw).toBeLessThanOrEqual(3750);
      expect(v.batteryCapacityKwh).toBe(DEPOT_BODY_TYPE_BATTERY[v.bodyType]?.batteryCapacityKwh);
      expect(d.departure.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
      expect(d.departure.departureTime).toMatch(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
      expect(d.departure.targetEnergyKwh).toBeGreaterThan(0);
      expect(d.departure.targetEnergyKwh).toBeLessThanOrEqual(v.batteryCapacityKwh);
      expect(d.departure.priority).toBeGreaterThanOrEqual(1);
      expect(d.departure.priority).toBeLessThanOrEqual(10);
      hoursNeeded.push(d.departure.targetEnergyKwh / v.maxChargePowerKw + BUFFER_HOURS);
    }
    // One vehicle needs about two hours at its own maximum before departure,
    // so the demo shows At Risk; every other one is ready in under 1.8.
    expect(hoursNeeded.filter((h) => h >= 2)).toHaveLength(1);
    expect(hoursNeeded.filter((h) => h < 1.8)).toHaveLength(fleet.drivers.length - 1);
    // Bus batteries are New Flyer Xcelsior CHARGE NG options, their day inside
    // what evaluated transit fleets use (85 to 189 kWh).
    for (const d of fleet.drivers.filter((x) => x.vehicle.bodyType === 'bus')) {
      if (d.vehicle.make === 'New Flyer')
        expect([440, 550, 660]).toContain(d.vehicle.batteryCapacityKwh);
      expect(d.departure.targetEnergyKwh).toBeGreaterThanOrEqual(85);
      expect(d.departure.targetEnergyKwh).toBeLessThanOrEqual(189);
    }
  });

  it('has valid settings, every station on its own spot inside the lot, on a circuit of its site', () => {
    for (const site of LAYOUT_DEMO.sites) {
      expect(
        siteLayoutSettingsSchema.safeParse(demoLayoutPositions(site.id, site.settings)).success,
      ).toBe(true);
      expect(site.stations.length).toBeLessThanOrEqual(layoutCapacity(site.settings));
      const spots = new Set(site.stations.map((s) => `${String(s.col)}:${String(s.row)}`));
      expect(spots.size).toBe(site.stations.length);
      for (const s of site.stations) {
        expect(bayInLayout({ col: s.col, row: s.row }, site.settings)).toBe(true);
      }
      const circuits = new Set(site.panels.flatMap((p) => p.circuits.map((c) => c.id)));
      for (const s of site.stations) expect(circuits.has(s.circuitId)).toBe(true);
      // A sub-panel hangs under a panel of the same site.
      const panels = new Set(site.panels.map((p) => p.id));
      for (const p of site.panels) {
        if (p.parentPanelId != null) expect(panels.has(p.parentPanelId)).toBe(true);
      }
    }
    expect(new Set(allStations.map((s) => s.id)).size).toBe(allStations.length);
  });

  it('keeps the state variety: maintenance, offline and cellular stations', () => {
    expect(harbor!.stations.some((s) => s.maintenance === true)).toBe(true);
    expect(allStations.some((s) => s.offline === true)).toBe(true);
    expect(harbor!.stations.some((s) => s.cellular === true)).toBe(true);
    expect(lakeside!.stations.some((s) => s.cellular === true)).toBe(true);
    // The faulted station runs no simulator, so its fault and insight stay.
    const faulted = allStations.filter((s) => s.faulted === true);
    expect(faulted).toHaveLength(1);
    expect(faulted[0]?.offline).toBe(true);
    expect(LAYOUT_DEMO.faultInsightId).toMatch(/^ain_[a-z0-9]{12}$/);
  });

  it('puts the card readers on DC chargers', () => {
    for (const t of LAYOUT_DEMO.terminals) {
      expect(allStations.find((s) => s.id === t.stationId)?.kind).toBe('dc');
    }
  });

  it('moves every station of the earlier plan away from the other site, and replaces only its own earlier settings', () => {
    for (const site of LAYOUT_DEMO.sites) {
      for (const s of site.stations) {
        if (s.movedFrom != null) expect(s.movedFrom.siteId).not.toBe(site.id);
      }
      const previous = LAYOUT_DEMO_PREVIOUS_SETTINGS[site.id] ?? [];
      for (const p of previous) expect(same(site.id, p, site.settings)).toBe(false);
    }
    // The two sites of the earlier plans have their earlier settings listed.
    expect(LAYOUT_DEMO_PREVIOUS_SETTINGS[harbor!.id]?.length).toBeGreaterThan(0);
    expect(LAYOUT_DEMO_PREVIOUS_SETTINGS[lakeside!.id]?.length).toBe(2);
    // Lakeside's plan before charger counts (stored with the sizes) is replaced too.
    const storedBefore = {
      siteType: 'office_retail',
      spotsPerRow: 12,
      rows: 1,
      spotWidthM: 2.8,
      spotDepthM: 5.5,
      laneWidthM: 6,
      facingDeg: 90,
      transformers: [],
      energyAssets: [],
    } as unknown as DemoLayoutSettings;
    expect(
      (LAYOUT_DEMO_PREVIOUS_SETTINGS[lakeside!.id] ?? []).some((p) =>
        same(lakeside!.id, p, storedBefore),
      ),
    ).toBe(true);
    // Harbor Point's plan with six spots a row, before the DC dispensers stood
    // on spot pairs, is replaced too.
    const sixSpots: DemoLayoutSettings = { ...harbor!.settings, spotsPerRow: 6 };
    expect(
      (LAYOUT_DEMO_PREVIOUS_SETTINGS[harbor!.id] ?? []).some((p) => same(harbor!.id, p, sixSpots)),
    ).toBe(true);
    // Harbor Point's plans before the battery and the solar canopy and before
    // Lot Edge (a 2 by 6 lot with every row charging) are replaced too.
    // The equipment 14 m out on the grass, before the pad moved to the lot edge.
    const farEquipment: DemoLayoutSettings = {
      ...sixSpots,
      transformers: [
        { id: 'tx-1', name: 'Utility Transformer', ratedKva: 2500, x: -14, z: 2.5 },
        { id: 'tx-2', name: 'Solar Carport Tie-In', ratedKva: 750, x: -14, z: 16 },
      ],
      energyAssets: assetsOf(harbor!.settings).map((a) =>
        a.type === 'battery' ? { ...a, x: 25, z: 4 } : a,
      ),
    };
    expect(
      (LAYOUT_DEMO_PREVIOUS_SETTINGS[harbor!.id] ?? []).some((p) =>
        same(harbor!.id, p, farEquipment),
      ),
    ).toBe(true);
    const middleCarport: DemoLayoutSettings = {
      ...farEquipment,
      energyAssets: assetsOf(farEquipment).map((a) => (a.type === 'solar' ? { ...a, row: 1 } : a)),
    };
    // The Lot Edge plan with the solar carport over the middle row.
    expect(
      (LAYOUT_DEMO_PREVIOUS_SETTINGS[harbor!.id] ?? []).some((p) =>
        same(harbor!.id, p, middleCarport),
      ),
    ).toBe(true);
    const beforeEdge: DemoLayoutSettings = { ...middleCarport, rows: 2 };
    delete beforeEdge.chargerPlacement;
    expect(
      (LAYOUT_DEMO_PREVIOUS_SETTINGS[harbor!.id] ?? []).some((p) =>
        same(harbor!.id, p, beforeEdge),
      ),
    ).toBe(true);
    const beforeAssets = { ...beforeEdge };
    delete beforeAssets.energyAssets;
    expect(
      (LAYOUT_DEMO_PREVIOUS_SETTINGS[harbor!.id] ?? []).some((p) =>
        same(harbor!.id, p, beforeAssets),
      ),
    ).toBe(true);
    // Willow Creek's canopy with its column line inside the head of the spots.
    // (and the battery at the far end of the stations, before it moved onto the equipment pad).
    // (and the transformer far from the DC group, before it moved next to it).
    const willowBefore: DemoLayoutSettings = {
      ...willow!.settings,
      transformers: willow!.settings.transformers.map((t) => ({ ...t, x: -30, z: -26 })),
      energyAssets: assetsOf(willow!.settings).map((a) =>
        a.type === 'solar' ? { ...a, z: -22 } : { ...a, x: 30, z: -24 },
      ),
    };
    expect(
      (LAYOUT_DEMO_PREVIOUS_SETTINGS[willow!.id] ?? []).some((p) =>
        same(willow!.id, p, willowBefore),
      ),
    ).toBe(true);
  });

  it('makes Patroon Creek a parking lot with islands, DC next to the transformer and AC in the far rows', () => {
    const s = patroon!.settings;
    expect(patroon!.name).toBe('Patroon Creek Charging Plaza');
    expect(siteLayoutSettingsSchema.safeParse(demoLayoutPositions(patroon!.id, s)).success).toBe(
      true,
    );
    expect(s).toMatchObject({ siteType: 'parking_lot', rows: 4, chargerPlacement: 'islands' });
    const dc = patroon!.stations.filter((st) => st.kind === 'dc');
    const ac = patroon!.stations.filter((st) => st.kind === 'ac');
    expect(dc).toHaveLength(4);
    expect(ac).toHaveLength(8);
    // The spots the placement gives each group, from the transformer outward and the far end
    // inward: every DC dispenser (two EVSEs) on a spot pair (owner decision 2026-11-09).
    expect(dc.every((st) => sharesSpotPair({ charging: 'dc', ports: st.evses ?? 2 }, s))).toBe(
      true,
    );
    // The whole first row, next to the transformer.
    expect(dc.map((st) => ({ col: st.col, row: st.row }))).toEqual(
      [0, 2, 4, 6].map((col) => ({ col, row: 0 })),
    );
    // A rerun moves each DC dispenser from its single spot of the plan before.
    expect(dc.map((st) => st.before && { col: st.before.col, row: st.before.row })).toEqual(
      groupedSpotOrder(s, 'dc').slice(0, 4),
    );
    // Dual-port Level 2 pedestals: two ports each, standing on the line
    // between their spot and the partner spot, in the slots placement gives them.
    expect(ac.every((st) => st.evses === 2)).toBe(true);
    expect(ac.every((st) => sharesSpotPair({ charging: 'ac', ports: st.evses }, s))).toBe(true);
    // Every unit within CHARGER_PORT_LIMITS; two DC dispensers at the most cables
    // (two EVSEs of a CCS1 and a CHAdeMO), the AC pedestals at the most ports.
    for (const st of patroon!.stations) {
      const limit = CHARGER_PORT_LIMITS[st.kind];
      const evses = st.evses ?? (st.kind === 'dc' ? 2 : 1);
      const perEvse = 1 + (st.extraConnectorTypes?.length ?? 0);
      expect(evses).toBeLessThanOrEqual(limit.evses);
      expect(perEvse).toBeLessThanOrEqual(limit.connectorsPerEvse);
      expect(evses * perEvse).toBeLessThanOrEqual(limit.cables);
    }
    const fourCables = dc.filter((st) => st.extraConnectorTypes?.includes('CHAdeMO') === true);
    expect(fourCables.map((st) => st.stationId)).toEqual(['CS-3050', 'CS-3051']);
    expect(ac.every((st) => (st.evses ?? 1) === CHARGER_PORT_LIMITS.ac.evses)).toBe(true);
    expect(ac.map((st) => ({ col: st.col, row: st.row }))).toEqual(
      freeSlotsFor(
        ac.map(() => ({ charging: 'ac' as const, depot: null, ports: 2 })),
        dc.map((st) => ({
          ...bayToPosition({ col: st.col, row: st.row }),
          charging: 'dc' as const,
          pair: true,
        })),
        s,
      ).map(positionToBay),
    );
    // No pedestal shares the first row with the DC group.
    expect(ac.some((st) => st.row === 0)).toBe(false);
    const held = new Set<string>();
    for (const st of patroon!.stations) {
      const spots = [{ col: st.col, row: st.row }];
      {
        const partner = spotPairPartner({ col: st.col, row: st.row }, s);
        expect(partner, st.stationId).not.toBeNull();
        spots.push(partner!);
      }
      for (const b of spots) {
        const key = `${String(b.col)}:${String(b.row)}`;
        expect(held.has(key), `${st.stationId} ${key}`).toBe(false);
        held.add(key);
      }
    }
    // A rerun moves each pedestal from its spot of the plan before (after the single-spot DC group).
    expect(ac.map((st) => st.before && { col: st.before.col, row: st.before.row })).toEqual(
      freeSlotsFor(
        ac.map(() => ({ charging: 'ac' as const, depot: null, ports: 2 })),
        groupedSpotOrder(s, 'dc')
          .slice(0, 4)
          .map((b) => ({ ...bayToPosition(b), charging: 'dc' as const })),
        s,
      ).map(positionToBay),
    );
    // Never interleaved along a row: at most one change of kind per row.
    for (let row = 0; row < s.rows; row++) {
      const kinds = patroon!.stations
        .filter((st) => st.row === row)
        .sort((a, b) => a.col - b.col)
        .map((st) => st.kind);
      const changes = kinds.filter((k, i) => i > 0 && k !== kinds[i - 1]).length;
      expect(changes, `row ${String(row)}`).toBeLessThanOrEqual(1);
    }
    for (const st of patroon!.stations) {
      expect(bayInLayout({ col: st.col, row: st.row }, s)).toBe(true);
    }
  });

  it('stands every charger group of a grid demo site in one continuous run, the access aisle at its end', () => {
    for (const site of LAYOUT_DEMO.sites) {
      const settings = site.settings;
      if (usesFreePositions(settings) || siteTypeOf(settings) === 'depot') continue;
      const rows = new Map<number, Map<number, 'ac' | 'dc'>>();
      const placed = site.stations.map((st) => {
        // The seed gives a DC station two EVSEs, an AC station one, unless the plan says.
        const pair = sharesSpotPair(
          { charging: st.kind, ports: st.evses ?? (st.kind === 'dc' ? 2 : 1) },
          settings,
        );
        const row = rows.get(st.row) ?? new Map<number, 'ac' | 'dc'>();
        row.set(st.col, st.kind);
        const partner = pair ? spotPairPartner({ col: st.col, row: st.row }, settings) : null;
        if (partner != null) row.set(partner.col, st.kind);
        rows.set(st.row, row);
        return {
          ...bayToPosition({ col: st.col, row: st.row }),
          charging: st.kind,
          pair,
        };
      });
      for (const [row, cols] of rows) {
        for (const kind of ['ac', 'dc'] as const) {
          const own = [...cols].filter(([, k]) => k === kind).map(([c]) => c);
          if (own.length === 0) continue;
          const lo = Math.min(...own);
          const hi = Math.max(...own);
          expect(hi - lo + 1, `${site.name} row ${String(row)} ${kind}`).toBe(own.length);
        }
      }
      const access = accessibleChargingSpace(placed, settings);
      if (access == null) continue;
      const row = rows.get(access.aisle.row) ?? new Map<number, 'ac' | 'dc'>();
      // The run of the space's own charging kind (a row can hold the end of each group).
      const kind = row.get(access.stall.col);
      const cols = [...row].filter(([, k]) => k === kind).map(([c]) => c);
      // The aisle lies just past the run, never inside it.
      expect(row.has(access.aisle.col), site.name).toBe(false);
      expect(
        access.aisle.col === Math.max(...cols) + 1 || access.aisle.col === Math.min(...cols) - 1,
        site.name,
      ).toBe(true);
    }
  });

  describe('electrical trees as an engineer designs them', () => {
    /** The continuous current a station draws from its panel, per phase it uses, in A. */
    const loadAmps = (site: LayoutDemoSite, stationId: string): number => {
      const st = site.stations.find((s) => s.id === stationId)!;
      // A master with extenders: every box at 32 A three-phase on the station's one circuit.
      if (st.units != null) return st.units.length * LINDENHOF_BOX_AMPS;
      if (st.kind === 'ac') return LEVEL_2_AMPS;
      // The depot bus cabinets use their datasheet input (ABB HVC 450PD and HVC-C 150).
      const datasheet: Record<string, number> = {
        sta_demolayout42: HVC_450PD_INPUT_AMPS,
        sta_demolayout43: HVC_450PD_INPUT_AMPS,
        sta_demolayout44: HVC_450PD_INPUT_AMPS,
        sta_demolayout45: HVC_C_150_INPUT_AMPS,
        sta_demolayout46: HVC360_INPUT_AMPS,
      };
      const own = datasheet[stationId];
      if (own != null) return own;
      // The demo DC chargers without their own power are ABB Terra 184 (datasheet input).
      return st.maxPowerKw == null ? TERRA_184_INPUT_AMPS : dcInputAmps(st.maxPowerKw);
    };
    const circuitOf = (site: LayoutDemoSite, circuitId: string) =>
      site.panels
        .flatMap((p) => p.circuits.map((c) => ({ panel: p, circuit: c })))
        .find((x) => x.circuit.id === circuitId)!;

    it('gives every charger its own circuit, sized at 125 percent of its load', () => {
      // The depot bus cabinets: 510 kVA is 613.4 A (800 A), 170 kVA 204.5 A (300 A).
      expect(HVC_450PD_INPUT_AMPS).toBeCloseTo(613.4, 1);
      expect(HVC_C_150_INPUT_AMPS).toBeCloseTo(204.5, 1);
      expect(evseBreakerAmps(HVC_450PD_INPUT_AMPS)).toBe(800);
      expect(evseBreakerAmps(HVC_C_150_INPUT_AMPS)).toBe(300);
      // The HVC360 cabinet of the dual-outlet bus charger: 470 A takes 600 A.
      expect(evseBreakerAmps(HVC360_INPUT_AMPS)).toBe(600);
      expect(evseBreakerAmps(32)).toBe(40);
      expect(evseBreakerAmps(48)).toBe(60);
      expect(evseBreakerAmps(230)).toBe(300);
      for (const site of LAYOUT_DEMO.sites) {
        const circuits = site.stations.map((s) => s.circuitId);
        expect(new Set(circuits).size, site.name).toBe(circuits.length);
        for (const st of site.stations) {
          const { circuit } = circuitOf(site, st.circuitId);
          expect(circuit.breakerRatingAmps).toBeGreaterThanOrEqual(1.25 * loadAmps(site, st.id));
          // The next standard rating, not a larger one than needed.
          expect(circuit.breakerRatingAmps).toBe(evseBreakerAmps(loadAmps(site, st.id)));
        }
        // No circuit is left without its charger.
        for (const p of site.panels) {
          for (const c of p.circuits) expect(circuits, c.id).toContain(c.id);
        }
      }
    });

    it('feeds DC chargers from switchboard breakers and AC chargers from panelboards', () => {
      for (const site of LAYOUT_DEMO.sites) {
        for (const st of site.stations) {
          const { panel, circuit } = circuitOf(site, st.circuitId);
          if (st.units != null) {
            // A 400Y/230 V distribution board (Germany), the station on one three-phase feeder.
            expect(panel.name, st.stationId).toMatch(/Distribution Board/);
            expect(panel.voltageV).toBe(230);
            expect(circuit.phaseConnections).toBeNull();
          } else if (st.kind === 'dc') {
            expect(panel.name, st.stationId).toMatch(/Switchboard/);
            expect(panel.voltageV).toBe(277);
            expect(circuit.phaseConnections).toBeNull();
          } else {
            expect(panel.name, st.stationId).toMatch(/^Panelboard /);
            expect(panel.voltageV).toBe(120);
            expect(panel.breakerRatingAmps).toBeLessThanOrEqual(400);
            // A 2-pole 208 V circuit.
            expect(circuit.phaseConnections).toMatch(/^L\dL\d$/);
          }
        }
        // A depot charges DC only, and a site never mixes AC into a switchboard.
        if (siteTypeOf(site.settings) === 'depot') {
          expect(site.stations.every((st) => st.kind === 'dc')).toBe(true);
        }
      }
    });

    it('seeds Parkhaus Lindenhof: one 1.6 master with 8 boxes of 2 Type 2 EVSEs in one row', () => {
      const site = LAYOUT_DEMO.sites.find((s) => s.id === 'sit_demogarage01');
      expect(site).toMatchObject({
        name: 'Parkhaus Lindenhof',
        address: 'Lindenhofstraße 12',
        city: 'Freiburg im Breisgau',
        postalCode: '79098',
        country: 'DE',
        timezone: 'Europe/Berlin',
      });
      const station = site?.stations[0];
      expect(station).toMatchObject({
        id: 'sta_demounits001',
        stationId: 'EM4-MASTER-01',
        model: 'AC Master with Extenders',
        ocppProtocol: 'ocpp1.6',
        evses: 16,
        connectorType: 'Type2',
        maxPowerKw: 22,
      });
      expect(station?.units?.map((u) => [u.name, u.evseIds])).toEqual(
        Array.from({ length: 8 }, (_, i) => [`Box ${String(i + 1)}`, [2 * i + 1, 2 * i + 2]]),
      );
      // 8 dual-port boxes: a run of 16 spots in a row of 18, a free spot beside it.
      const kind = {
        charging: 'ac' as const,
        depot: null,
        ports: 16,
        units: (station?.units ?? []).map(() => ({ charging: 'ac' as const, ports: 2 })),
      };
      const settings = site?.settings;
      expect(settings != null ? stationSpanCount(kind, settings) : 0).toBe(16);
      expect((station?.col ?? 0) + 16).toBeLessThan(settings?.spotsPerRow ?? 0);
      // 8 boxes at 400 V x 32 A three-phase (22.2 kVA each): 177.4 kVA on 225 kVA.
      const connectedKva = (8 * Math.sqrt(3) * 400 * LINDENHOF_BOX_AMPS) / 1000;
      expect(settings?.transformers[0]?.ratedKva).toBe(serviceTransformerKva(connectedKva));
    });

    it('loads no panel past its continuous rating, per phase, or past its 42 spaces', () => {
      const vLineToLine = (p: LayoutDemoPanel): number => Math.round(p.voltageV * Math.sqrt(3));
      for (const site of LAYOUT_DEMO.sites) {
        /** The current a panel's own circuits and its sub-panels draw on each phase, in A at its voltage. */
        const phaseLoad = (panel: LayoutDemoPanel): [number, number, number] => {
          const load: [number, number, number] = [0, 0, 0];
          for (const c of panel.circuits) {
            const st = site.stations.find((s) => s.circuitId === c.id)!;
            const amps = loadAmps(site, st.id);
            const phases = c.phaseConnections == null ? 'L1L2L3' : c.phaseConnections;
            for (const [i, name] of ['L1', 'L2', 'L3'].entries()) {
              if (phases.includes(name)) load[i as 0 | 1 | 2] += amps;
            }
          }
          for (const child of site.panels.filter((p) => p.parentPanelId === panel.id)) {
            const sub = phaseLoad(child);
            // A child at another voltage (behind a transformer) draws the same power.
            const ratio = vLineToLine(child) / vLineToLine(panel);
            for (const i of [0, 1, 2] as const) load[i] += sub[i] * ratio;
          }
          return load;
        };
        for (const panel of site.panels) {
          const worst = Math.max(...phaseLoad(panel));
          expect(worst, `${site.name} ${panel.name}`).toBeLessThanOrEqual(
            0.8 * panel.breakerRatingAmps + 1e-6,
          );
          if (panel.name.startsWith('Panelboard')) {
            const spaces = panel.circuits.reduce(
              (n, c) => n + (c.phaseConnections == null ? 3 : c.phaseConnections.length / 2),
              0,
            );
            expect(spaces).toBeLessThanOrEqual(42);
          }
        }
      }
    });

    it('splits many AC chargers over several panelboards in the order they stand', () => {
      const boards = lakeside!.panels.filter((p) => p.name.startsWith('Panelboard'));
      expect(boards.length).toBeGreaterThanOrEqual(2);
      // Each panelboard feeds a run of neighbors, never every other station (a
      // two-port wall box holds its spot and the partner spot).
      for (const board of boards) {
        const fed = lakeside!.stations
          .filter((st) => board.circuits.some((c) => c.id === st.circuitId))
          .sort((a, b) => a.col - b.col);
        const held = fed.reduce((n, st) => n + ((st.evses ?? 1) >= 2 ? 2 : 1), 0);
        const last = fed.at(-1)!;
        expect(last.col + ((last.evses ?? 1) >= 2 ? 1 : 0) - fed[0]!.col).toBe(held - 1);
      }
      // Maple: one panelboard per curb.
      const mapleBoards = maple!.panels.filter((p) => p.name.startsWith('Panelboard'));
      for (const board of mapleBoards) {
        const rows = new Set(
          maple!.stations
            .filter((st) => board.circuits.some((c) => c.id === st.circuitId))
            .map((st) => st.row),
        );
        expect(rows.size).toBe(1);
      }
    });
  });

  describe('card readers in whole groups', () => {
    const readerStations = new Set(LAYOUT_DEMO.terminals.map((t) => t.stationId));

    it('puts a reader on every DC fast charger of a public site and none on AC or the depot', () => {
      for (const site of [harbor!, willow!, patroon!]) {
        for (const st of site.stations.filter((s) => s.kind === 'dc')) {
          expect(readerStations.has(st.id), st.stationId).toBe(true);
        }
      }
      for (const st of allStations.filter((s) => s.kind === 'ac')) {
        expect(readerStations.has(st.id), st.stationId).toBe(false);
      }
      for (const st of depot!.stations) expect(readerStations.has(st.id)).toBe(false);
    });

    it('gives each charger one reader on its own device', () => {
      const ids = LAYOUT_DEMO.terminals.map((t) => t.providerDeviceId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(readerStations.size).toBe(LAYOUT_DEMO.terminals.length);
    });

    it('gives every demo parking lot and office or retail row an accessible charging space', () => {
      const sites = LAYOUT_DEMO.sites.filter((s) => modelsAccessibleSpace(s.settings));
      expect(sites.length).toBeGreaterThan(0);
      for (const site of sites) {
        const placed = site.stations.map((st) => ({
          ...bayToPosition({ col: st.col, row: st.row }),
          charging: st.kind,
        }));
        expect(accessibleChargingSpace(placed, site.settings), site.name).not.toBeNull();
      }
    });

    it('pairs every reader to the whole dispenser, so no EVSE of it lacks card payment', () => {
      for (const t of LAYOUT_DEMO.terminals) expect(t.evseNumber, t.providerDeviceId).toBeNull();
    });
  });
});

describe('demo layout positions', () => {
  it('stores each demo transformer and energy asset by the id the migration gives its row, with its position only', () => {
    const stored = demoLayoutPositions(harbor!.id, harbor!.settings);
    const md5 = (text: string) => createHash('md5').update(text).digest('hex').slice(0, 12);
    expect(stored.transformers).toEqual(
      harbor!.settings.transformers.map((t) => ({
        id: `tfm_${md5(`${harbor!.id}:${t.id}`)}`,
        x: t.x,
        z: t.z,
      })),
    );
    expect(stored.transformers[0]?.id).toBe(layoutEquipmentRowId('tfm', harbor!.id, 'tx-1'));
    for (const a of stored.energyAssets ?? []) {
      expect(a.id).toMatch(/^ena_[0-9a-f]{12}$/);
      expect(Object.keys(a).every((k) => ['id', 'x', 'z', 'row', 'rotationDeg'].includes(k))).toBe(
        true,
      );
    }
    expect(siteLayoutSettingsSchema.safeParse(stored).success).toBe(true);
  });
});
