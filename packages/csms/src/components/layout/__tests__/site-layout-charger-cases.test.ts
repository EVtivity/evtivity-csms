// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The two charger cases of the site layout (owner rule 2026-11-12):
// A, two EVSEs of one connector each that charge at once: two ports, an
// EVSE number plate and an own status light each, up to two vehicles, each on
// its own EVSE's cable.
// B, one EVSE with several connectors, one in use at a time: every connector
// holstered, no plate, one light, at most one vehicle, only the plugged
// connector's holster empty.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { holsterSlots } from '../site-layout-connectors';
import { slotInUse } from '../site-layout-scene-station-slots';
import type { SceneStation } from '../site-layout-scene-types';
import { drawnEvseConnectors, stationPlugs, type PlugEvse } from '../site-layout-station-plugs';
import { buildIdleChargerModel, type IdleChargerModel } from '../site-layout-scene-charger-model';
import { freeCarStalls } from '../site-layout-free';

const evse = (...plugged: boolean[]): PlugEvse => ({
  connectors: plugged.map((isPluggedIn) => ({ isPluggedIn })),
});

/** A scene station as the layout builds it from the plugs (`SiteLayout3D`). */
function sceneOf(
  kind: 'ac' | 'dc',
  evses: PlugEvse[],
  stallCount: number,
  carShown = evses.some((e) => e.connectors.some((c) => c.isPluggedIn)),
): { s: SceneStation; cars: number } {
  const drawn = drawnEvseConnectors(kind, evses, false);
  const plugs = stationPlugs({
    evses,
    drawn,
    stallCount,
    carShown,
    carOf: (i) => `car-${String(i)}`,
  });
  const s: SceneStation = {
    id: 'sta_1',
    kind,
    bay: { col: 0, row: 0 },
    lightColor: '#00ff00',
    lit: true,
    pulsing: false,
    glow: false,
    wall: false,
    prop: carShown ? 'car' : null,
    terminals: [],
    blinking: false,
    evseConnectors: drawn,
    pluggedSlot: { evse: plugs.firstPlugged, connector: plugs.plugged[plugs.firstPlugged] ?? 0 },
    stallPlugged: plugs.plugged,
    ...(plugs.stallCars != null
      ? { stallCars: plugs.stallCars.map((c) => (c == null ? null : { color: c })) }
      : {}),
  } as SceneStation;
  const cars = plugs.stallCars != null ? plugs.stallCars.filter((c) => c != null).length : 1;
  return { s, cars: carShown ? cars : 0 };
}

/** The holsters left empty (their handle in a vehicle), as `evse:connector`. */
function emptyHolsters(s: SceneStation): string[] {
  return holsterSlots(s.evseConnectors ?? [1])
    .filter((h) => slotInUse(s, h.evse, h.connector))
    .map((h) => `${String(h.evse)}:${String(h.connector)}`);
}

describe('case A: two EVSEs of one connector each', () => {
  it('puts a vehicle on each EVSE that reports a cable, each through its own holster', () => {
    for (const kind of ['ac', 'dc'] as const) {
      const both = sceneOf(kind, [evse(true), evse(true)], 2);
      expect(both.cars, kind).toBe(2);
      expect(emptyHolsters(both.s), kind).toEqual(['0:0', '1:0']);
      // Only the second EVSE has a cable in: one vehicle, in its own stall.
      const second = sceneOf(kind, [evse(false), evse(true)], 2);
      expect(second.cars, kind).toBe(1);
      expect(second.s.stallCars?.[0], kind).toBeNull();
      expect(emptyHolsters(second.s), kind).toEqual(['1:0']);
      // Nothing plugged: no vehicle, every handle seated.
      const idle = sceneOf(kind, [evse(false), evse(false)], 2);
      expect(idle.cars, kind).toBe(0);
      expect(emptyHolsters(idle.s), kind).toEqual([]);
    }
  });

  it('draws the second vehicle of a unit charger from its own EVSE session, never the first twice', () => {
    const plugs = stationPlugs({
      evses: [evse(true), evse(true)],
      drawn: [1, 1],
      stallCount: 2,
      carShown: true,
      carOf: (i) => `evse-${String(i)}`,
    });
    expect(plugs.stallCars).toEqual(['evse-0', 'evse-1']);
  });

  it('gives a custom site charger one stall per car spot, EVSE 1 on the left, none for bus bays', () => {
    const at = { x: 0, z: 0, rotationDeg: 0 };
    const two = freeCarStalls({ placement: at, spots: 2 });
    expect(two?.map((st) => st.x)).toEqual([-1.3, 1.3]);
    // The same places the one vehicle of the earlier rule took (`freePropOffset`).
    expect(two?.every((st) => st.width > 2)).toBe(true);
    expect(freeCarStalls({ placement: at, spots: 1 })).toBeNull();
    expect(freeCarStalls({ placement: { ...at, spotType: 'bus_bay' }, spots: 2 })).toBeNull();
    // Both EVSEs of a custom site's dual-outlet dispenser charging: two vehicles.
    expect(sceneOf('dc', [evse(true), evse(true)], two?.length ?? 0).cars).toBe(2);
  });

  it('keeps one vehicle at a charger that serves one stall', () => {
    const one = sceneOf('dc', [evse(true), evse(true)], 1);
    expect(one.s.stallCars).toBeUndefined();
    expect(one.cars).toBe(1);
    expect(emptyHolsters(one.s)).toEqual(['0:0']);
  });

  it('gives a two-EVSE dispenser with CCS1 and CHAdeMO per EVSE one empty holster per vehicle', () => {
    // EVSE 1 on its CHAdeMO, EVSE 2 on its CCS1.
    const s = sceneOf('dc', [evse(false, true), evse(true, false)], 2);
    expect(s.cars).toBe(2);
    expect(emptyHolsters(s.s)).toEqual(['0:1', '1:0']);
    // Holsters grouped by EVSE: EVSE 1 left, EVSE 2 right, each pair front to back.
    expect(holsterSlots([2, 2]).map((h) => [h.evse, h.side, h.backM])).toEqual([
      [0, -1, 0],
      [0, -1, 0.25],
      [1, 1, 0],
      [1, 1, 0.25],
    ]);
  });
});

describe('case B: one EVSE with several connectors', () => {
  it('holsters every connector and empties only the plugged one, one vehicle at most', () => {
    // CCS1 and CHAdeMO, CHAdeMO in use.
    const cc = sceneOf('dc', [evse(false, true)], 1);
    expect(cc.s.evseConnectors).toEqual([2]);
    expect(cc.cars).toBe(1);
    expect(emptyHolsters(cc.s)).toEqual(['0:1']);
    // A triple outlet (CCS1, CHAdeMO, AC Type 2), the AC one in use.
    const tri = sceneOf('dc', [evse(false, false, true)], 1);
    expect(tri.s.evseConnectors).toEqual([3]);
    expect(holsterSlots([3])).toHaveLength(3);
    expect(emptyHolsters(tri.s)).toEqual(['0:2']);
    // Nothing plugged: all three seated.
    expect(emptyHolsters(sceneOf('dc', [evse(false, false, false)], 1).s)).toEqual([]);
  });

  it('plugs an undrawn connector through the last drawn holster of its EVSE', () => {
    // An AC EVSE with two J1772 connectors draws one: the second in use empties that one holster.
    const ac = sceneOf('ac', [evse(false, true)], 1);
    expect(ac.s.evseConnectors).toEqual([1]);
    expect(emptyHolsters(ac.s)).toEqual(['0:0']);
    // A two-EVSE dispenser draws two connectors per EVSE: a third in use plugs through the second.
    const dc = sceneOf('dc', [evse(false, false, true), evse(false)], 2);
    expect(dc.s.evseConnectors).toEqual([2, 1]);
    expect(emptyHolsters(dc.s)).toEqual(['0:1']);
  });

  it('plugs an undrawn EVSE through the last drawn EVSE', () => {
    // An AC station with three EVSEs draws two: the third with a cable in shows in the second stall.
    const third = sceneOf('ac', [evse(false), evse(false), evse(true)], 2);
    expect(third.s.evseConnectors).toEqual([1, 1]);
    expect(third.cars).toBe(1);
    expect(third.s.stallCars?.[1]).not.toBeNull();
    expect(emptyHolsters(third.s)).toEqual(['1:0']);
  });
});

function plateLights(
  model: IdleChargerModel,
  colors: string[],
): {
  plates: number;
  plateColors: string[];
  portLights: string[];
} {
  const built = buildIdleChargerModel(model, {
    plateColor: '#336699',
    dark: false,
    evseColors: colors,
  });
  const plates: THREE.Object3D[] = [];
  const portLights: string[] = [];
  built.group.traverse((o) => {
    if (o.userData['model'] === 'evse-plate') plates.push(o);
    if (o.userData['evseLight'] === true && o instanceof THREE.Mesh) {
      portLights.push((o.material as THREE.MeshStandardMaterial).color.getHexString());
    }
  });
  const plateColors = plates.map((p) => {
    let hex = '';
    p.traverse((o) => {
      if (
        o instanceof THREE.Mesh &&
        o.material instanceof THREE.MeshStandardMaterial &&
        o.material.emissiveIntensity > 0.5
      ) {
        hex = o.material.color.getHexString();
      }
    });
    return hex;
  });
  built.dispose();
  return { plates: plates.length, plateColors, portLights };
}

describe('EVSE plates and status lights', () => {
  const colors = ['#00aa00', '#aa0000'];

  it('gives each EVSE of a two-EVSE charger its own plate and light in its own state color', () => {
    for (const model of ['dc-dispenser-dual', 'dc-dispenser-dual-four'] as const) {
      const r = plateLights(model, colors);
      expect(r.plates, model).toBe(2);
      expect(r.plateColors, model).toEqual(['00aa00', 'aa0000']);
    }
    // The AC pedestal and the wall box also light each port in its EVSE's color.
    for (const model of ['ac-pedestal-dual', 'wall-box-dual'] as const) {
      const r = plateLights(model, colors);
      expect(r.plates, model).toBe(2);
      expect(r.plateColors, model).toEqual(['00aa00', 'aa0000']);
      expect(r.portLights, model).toEqual(['00aa00', 'aa0000']);
    }
  });

  it('puts no plate on a charger with one EVSE, whatever its connector count', () => {
    for (const model of ['dc-dispenser', 'ac-pedestal', 'curb-post', 'wall-box'] as const) {
      const r = plateLights(model, ['#00aa00']);
      expect(r.plates, model).toBe(0);
      expect(r.portLights, model).toEqual([]);
    }
  });
});
