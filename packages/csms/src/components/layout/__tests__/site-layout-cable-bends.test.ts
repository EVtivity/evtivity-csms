// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The natural bend of every idle charger cable (owner decision 2026-11-09):
// no kink anywhere from its gland to its handle, every charger type.

import { describe, expect, it } from 'vitest';
import {
  circumradius,
  dubinsJoin,
  filletPolyline,
  relaxCableBends,
  tightestBend,
} from '../site-layout-cable-relax';
import {
  acHolsterCable,
  acHolsterEntry,
  dcDispenserCableM,
  dcHolsterCable,
  routeLength,
} from '../site-layout-charger-cables';
import {
  CONNECTOR_SPECS,
  chargerCableDiameterM,
  holsterSlots,
  type ConnectorKind,
} from '../site-layout-connectors';
import { acGlandX, acHookSides } from '../site-layout-model-ac-pedestal';
import { satelliteHolsterCable } from '../site-layout-satellite-cables';
import { dispenserHolsters } from '../site-layout-grid';
import { wallBoxDockEntry, wallBoxIdleCable } from '../site-layout-wall-box-cable';
import { WALL_BOX_BOTTOM_M } from '../site-layout-marker';
import { SURFACE_M } from '../site-layout-cable-surface';
import type { Vec3 } from '../site-layout-model-kit';

/**
 * The tightest bend a drawn cable may take between its gland run and the boot
 * of its handle: 1.9 cable diameters, under the 4 to 5 D fixed minimum of the
 * cable makers (`CABLE_REST_BEND_RATIO`) only where a cable turns close by a
 * body (an AC cable round its column, a satellite cable at its hook), never
 * a fold. Most of every route bends at its cable's bend or wider.
 */
const NO_KINK_RATIO = 1.9;

/** The tightest vertex bend of a route, past its gland run (4 points) and before the boot (3). */
function routeBend(route: readonly Vec3[]): number {
  return tightestBend(route, 4, route.length - 4);
}

describe('cable bends', () => {
  it('bends every DC dispenser cable no tighter than 1.9 diameters', () => {
    for (const evse of [[1], [2], [3], [4], [1, 1], [2, 2]]) {
      for (const kind of ['ccs1', 'ccs2', 'chademo', 'nacs'] as ConnectorKind[]) {
        const d = CONNECTOR_SPECS[kind].cableDiameterM;
        for (const h of holsterSlots(evse)) {
          const route = dcHolsterCable(
            h.side,
            h.backM,
            kind,
            undefined,
            dcDispenserCableM(evse.length),
          );
          expect(routeBend(route), `${JSON.stringify(evse)} ${kind}`).toBeGreaterThan(
            NO_KINK_RATIO * d,
          );
        }
      }
    }
  });

  it('bends every AC pedestal and curb post cable no tighter than 1.9 diameters', () => {
    for (const kind of ['type1', 'type2', 'nacs'] as ConnectorKind[]) {
      const d = chargerCableDiameterM(kind, true);
      for (const ports of [1, 2] as const) {
        for (const side of acHookSides(ports)) {
          const route = acHolsterCable(acGlandX(ports, side), side, d, acHolsterEntry(side, kind));
          expect(routeBend(route), `${kind} ${String(ports)} ${String(side)}`).toBeGreaterThan(
            NO_KINK_RATIO * d,
          );
        }
      }
    }
  });

  it('bends the wall box cable and every satellite cable no tighter than 1.9 diameters', () => {
    const d = CONNECTOR_SPECS.type1.cableDiameterM;
    const e = wallBoxDockEntry({ wallZ: 0, boxBottomM: WALL_BOX_BOTTOM_M, kind: 'type1' });
    const wall = wallBoxIdleCable({
      wallZ: 0,
      boxBottomM: WALL_BOX_BOTTOM_M,
      cableDiameterM: d,
      dock: { lead: e.lead, end: e.end },
      sidewalkY: SURFACE_M.sidewalk,
    });
    expect(routeBend(wall.points)).toBeGreaterThan(NO_KINK_RATIO * d);
    for (const kind of ['ccs1', 'ccs2', 'chademo', 'nacs'] as ConnectorKind[]) {
      const dd = CONNECTOR_SPECS[kind].cableDiameterM;
      for (const count of [1, 2]) {
        const holsters = dispenserHolsters(count);
        holsters.forEach((h, k) => {
          const route = satelliteHolsterCable(h.side, kind, h.backM);
          expect(routeBend(route), `${kind} ${String(count)} ${String(k)}`).toBeGreaterThan(
            NO_KINK_RATIO * dd,
          );
        });
      }
    }
  });
});

describe('cable bend helpers', () => {
  it('measures the bend through three points', () => {
    expect(circumradius([1, 0, 0], [0, 1, 0], [-1, 0, 0])).toBeCloseTo(1, 9);
    expect(circumradius([0, 0, 0], [1, 0, 0], [2, 0, 0])).toBe(Infinity);
  });

  it('relaxes a corner until it bends no tighter than asked, the held points kept', () => {
    const corner: Vec3[] = [];
    for (let i = 0; i <= 10; i += 1) corner.push([i * 0.05, 0, 0]);
    for (let i = 1; i <= 10; i += 1) corner.push([0.5, i * 0.05, 0]);
    const relaxed = relaxCableBends(corner, {
      minRadiusM: 0.05,
      fixed: (i) => i < 3 || i > corner.length - 4,
      passes: 400,
    });
    expect(tightestBend(relaxed, 3, relaxed.length - 4)).toBeGreaterThan(0.04);
    expect(relaxed[0]).toEqual(corner[0]);
    expect(relaxed[relaxed.length - 1]).toEqual(corner[corner.length - 1]);
  });

  it('rounds every corner of a polyline on the radius asked', () => {
    const path = filletPolyline(
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
      ],
      0.2,
      8,
    );
    // The arc points are 0.2 from the arc's center (0.8, 0.2).
    const arc = path.slice(1, -1);
    for (const p of arc) expect(Math.hypot(p[0] - 0.8, p[1] - 0.2)).toBeCloseTo(0.2, 6);
    expect(tightestBend(path)).toBeGreaterThan(0.19);
  });

  it('joins two headings by arcs no tighter than its radius (Dubins)', () => {
    const p0: Vec3 = [0, 1, 0];
    const p1: Vec3 = [0.6, 1, 0];
    // Down out of one point, up into the other: a U of radius 0.2 under them.
    const u = dubinsJoin(p0, [0, -1, 0], p1, [0, 1, 0], 0.2, 0.02);
    expect(u[0]).toEqual(p0);
    const last = u[u.length - 1];
    expect(last?.[0]).toBeCloseTo(0.6, 6);
    expect(last?.[1]).toBeCloseTo(1, 6);
    expect(Math.min(...u.map((p) => p[1]))).toBeLessThan(0.81);
    expect(tightestBend(u)).toBeGreaterThan(0.19);
    expect(routeLength(u)).toBeLessThan(0.6 + Math.PI * 0.2 + 0.3);
  });
});
