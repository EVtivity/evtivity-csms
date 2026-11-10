// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { SURFACE_M } from '../site-layout-cable-surface';
import * as THREE from 'three';
import {
  AC_CABLE_M,
  AC_HOOK_TOP_M,
  acCoilPlace,
  acHolsterCable,
  acHolsterEntry,
  catenaryPoints,
  dcGlandOut,
  dcHolsterCable,
  dcDispenserCableM,
  dcHolsterEntry,
  routeLength,
} from '../site-layout-charger-cables';
import { AC_PEDESTAL, acGland, acGlandX, acHookSides } from '../site-layout-model-ac-pedestal';
import {
  CONNECTOR_SPECS,
  chargerCableDiameterM,
  holsterSlots,
  type ConnectorKind,
} from '../site-layout-connectors';
import { cableGlandSize } from '../site-layout-model-cable-gland';
import { DC_DISPENSER, DC_SIDE_VENTS, dcGland } from '../site-layout-model-dc-dispenser';
import type { Vec3 } from '../site-layout-model-kit';

const DC_KINDS: ConnectorKind[] = ['ccs1', 'ccs2', 'chademo', 'nacs'];

/** The smooth curve the scene draws through a route, sampled densely. */
function sample(route: readonly Vec3[]): THREE.Vector3[] {
  const curve = new THREE.CatmullRomCurve3(route.map((p) => new THREE.Vector3(...p)));
  return curve.getPoints(240);
}

function dcLayouts(): Array<{
  name: string;
  cables: Array<{ kind: ConnectorKind; route: Vec3[] }>;
}> {
  const layouts: Array<number[]> = [[1], [2], [3], [4], [1, 1], [2, 2]];
  return layouts.flatMap((evse) =>
    DC_KINDS.map((kind) => ({
      name: `${JSON.stringify(evse)} ${kind}`,
      cables: holsterSlots(evse).map((h) => ({
        kind,
        // A two-EVSE dispenser carries the 6 m dual-outlet cable (`dcDispenserCableM`).
        route: dcHolsterCable(h.side, h.backM, kind, undefined, dcDispenserCableM(evse.length)),
      })),
    })),
  );
}

describe('DC holstered cable routes', () => {
  const d = DC_DISPENSER;
  const back = d.frontZ - d.depthM;

  // One test per dispenser layout: all layouts in one test came close to the
  // 5 s limit on a loaded CI runner with coverage on.
  it.each(dcLayouts().map((layout) => [layout.name, layout] as const))(
    'hangs every cable of %s above the ground and outside the body',
    (_name, layout) => {
      for (const { kind, route } of layout.cables) {
        const r = CONNECTOR_SPECS[kind].cableDiameterM / 2;
        // Past the gland the cable keeps a cable diameter off the body; the
        // last two points run into the handle in its holster, outside the wall.
        const pts = sample(route.slice(3, -2));
        for (const p of pts) {
          // On or above the pad (a long loop rests on it), never sunk into it.
          expect(p.y, layout.name).toBeGreaterThanOrEqual(SURFACE_M.paving + r + 0.01 - 0.002);
          const inside =
            Math.abs(p.x) < d.widthM / 2 + r &&
            p.y < d.heightM + r &&
            p.z > back - r &&
            p.z < d.frontZ + r;
          expect(
            inside,
            `${layout.name} ${p
              .toArray()
              .map((v) => v.toFixed(3))
              .join(',')}`,
          ).toBe(false);
        }
      }
    },
  );

  it('puts every gland on plain wall, clear of the vents', () => {
    for (const side of [-1, 1] as const) {
      for (const drop of [0, 0.25]) {
        const g = dcGland(side, drop);
        const reach = cableGlandSize(0.08).nutM / 2 + 0.02;
        for (const v of DC_SIDE_VENTS) {
          const hit =
            g.at[1] > v.yMin - reach &&
            g.at[1] < v.yMax + reach &&
            g.at[2] > v.zMin - reach &&
            g.at[2] < v.zMax + reach;
          expect(hit).toBe(false);
        }
      }
    }
  });

  it('never runs a cable into or across a vent grille', () => {
    for (const layout of dcLayouts()) {
      for (const { kind, route } of layout.cables) {
        const dia = CONNECTOR_SPECS[kind].cableDiameterM;
        for (const p of sample(route)) {
          for (const v of DC_SIDE_VENTS) {
            const onVent =
              // Seen from the side: no cable crosses a vent, in front of it or on it.
              Math.abs(p.x) > 0 &&
              p.y > v.yMin - dia &&
              p.y < v.yMax + dia &&
              p.z > v.zMin - dia &&
              p.z < v.zMax + dia;
            expect(onVent, layout.name).toBe(false);
          }
        }
      }
    }
  });

  it('keeps the cables of one dispenser apart (a cable diameter between them)', () => {
    for (const layout of dcLayouts()) {
      const sampled = layout.cables.map((c) => ({
        pts: sample(c.route.slice(0, -2)),
        dia: CONNECTOR_SPECS[c.kind].cableDiameterM,
      }));
      for (let i = 0; i < sampled.length; i++) {
        for (let j = i + 1; j < sampled.length; j++) {
          const a = sampled[i];
          const b = sampled[j];
          if (a == null || b == null) continue;
          let min = Infinity;
          for (const p of a.pts) for (const q of b.pts) min = Math.min(min, p.distanceTo(q));
          expect(min, `${layout.name} ${String(i)}-${String(j)}`).toBeGreaterThan(
            (a.dia + b.dia) / 2 + Math.min(a.dia, b.dia),
          );
        }
      }
    }
  });
});

describe('catenary loop', () => {
  it('passes both ends and reaches the chosen lowest point', () => {
    const pts = catenaryPoints([0, 1.2, 0], [0.4, 0.9, 0.3], 0.4, 40);
    const first = pts[0] ?? [0, 0, 0];
    const last = pts[pts.length - 1] ?? [0, 0, 0];
    expect(first[1]).toBeCloseTo(1.2, 4);
    expect(last[1]).toBeCloseTo(0.9, 4);
    expect(Math.min(...pts.map((p) => p[1]))).toBeCloseTo(0.4, 2);
    // A hanging cable is longer than the straight line between its ends.
    expect(routeLength(pts)).toBeGreaterThan(Math.hypot(0.4, 0.3, 0.3));
  });
});

// Every cable runs unbroken from its anchor (a gland, or a coil whose cable
// comes from a gland over a hook) to its handle: no free ends (owner rule 2026-11-02).
describe('cable continuity, every charger model', () => {
  const near = (a: Vec3, b: Vec3, tol: number): boolean =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol;

  it('runs every DC cable from inside its gland to inside its handle, idle and plugged', () => {
    for (const evse of [[1], [2], [3], [4], [1, 1], [2, 2]]) {
      for (const h of holsterSlots(evse)) {
        const g = dcGland(h.side, h.backM);
        for (const route of [
          dcHolsterCable(h.side, h.backM, 'ccs1'),
          dcGlandOut(h.side, h.backM, 'ccs1'),
        ]) {
          const first = route[0] ?? [0, 0, 0];
          // Inside the gland: 10 mm behind its mouth on the axis.
          expect(near(first, [g.at[0] - g.axis[0] * 0.01, g.at[1], g.at[2]], 1e-6)).toBe(true);
        }
        const idle = dcHolsterCable(h.side, h.backM, 'ccs1');
        const entry = dcHolsterEntry(h.side, h.backM, 'ccs1');
        expect(idle[idle.length - 1]).toEqual(entry.end);
      }
    }
  });

  it('loops every AC pedestal and curb post cable over its J hook, one piece from gland to handle', () => {
    for (const kind of ['type1', 'type2', 'nacs'] as const) {
      const d = chargerCableDiameterM(kind, true);
      for (const ports of [1, 2] as const) {
        for (const side of acHookSides(ports)) {
          const label = `${kind} ${String(ports)} ${String(side)}`;
          const glandX = acGlandX(ports, side);
          const entry = acHolsterEntry(side, kind);
          const route = acHolsterCable(glandX, side, d, entry);
          const g = acGland(glandX);
          // From inside its gland to inside its handle, at the cited 5.79 m.
          expect(near(route[0] ?? [0, 0, 0], [g.at[0], g.at[1] + 0.01, g.at[2]], 1e-6), label).toBe(
            true,
          );
          expect(route[route.length - 1], label).toEqual(entry.end);
          expect(Math.abs(routeLength(route) - AC_CABLE_M) / AC_CABLE_M, label).toBeLessThan(0.01);
          // Its turns rest on the hook's rod: no point above the cable's top over it under the head.
          const place = acCoilPlace(side, d);
          const coil = route.filter((p) => p[1] < AC_HOOK_TOP_M + d + 0.001);
          expect(coil.length, label).toBeGreaterThan(0);
          const top = Math.max(
            ...route
              .filter((p) => Math.abs(p[0] - place.center[0]) < 0.03 && p[1] < 0.9)
              .map((p) => p[1]),
          );
          expect(top, label).toBeCloseTo(place.center[1] + place.r1, 2);
          // Every point clears the pad (0.08 m) by 0.1 m, and stays out of the
          // column and the head (the first point is inside the gland).
          for (const p of route.slice(1)) {
            expect(p[1] - d / 2 - 0.08, label).toBeGreaterThan(0.1 - 1e-6);
            const inColumn =
              Math.abs(p[0]) < AC_PEDESTAL.post.widthM / 2 + d / 2 &&
              Math.abs(p[2]) < AC_PEDESTAL.post.depthM / 2 + d / 2 &&
              p[1] < AC_PEDESTAL.head.bottomM;
            expect(inColumn, label).toBe(false);
          }
          // The handle stays in the ADA 308 reach range (15 to 48 in).
          expect(entry.end[1], label).toBeGreaterThan(15 * 0.0254);
          expect(entry.end[1], label).toBeLessThan(48 * 0.0254);
        }
      }
    }
  });
});

// A two-EVSE dispenser with four cables, its EVSEs carrying different
// connector kinds (independent review 2026-11-10, I1): the two idle cables on
// one side never touch, for every mix.
describe('four-cable DC dispenser with mixed connector kinds', () => {
  it('keeps the two idle cables of each side apart', () => {
    const mixes: Array<[ConnectorKind, ConnectorKind]> = [
      ['ccs1', 'chademo'],
      ['ccs2', 'chademo'],
      ['chademo', 'ccs1'],
      ['nacs', 'ccs1'],
    ];
    for (const [k0, k1] of mixes) {
      const cables = holsterSlots([2, 2]).map((h) => {
        const kind = h.connector === 0 ? k0 : k1;
        const route = dcHolsterCable(h.side, h.backM, kind);
        const curve = new THREE.CatmullRomCurve3(
          route.slice(0, -2).map((p) => new THREE.Vector3(...p)),
        );
        return { side: h.side, pts: curve.getPoints(240), d: CONNECTOR_SPECS[kind].cableDiameterM };
      });
      for (let i = 0; i < cables.length; i += 1) {
        for (let j = i + 1; j < cables.length; j += 1) {
          const a = cables[i];
          const b = cables[j];
          if (a == null || b == null || a.side !== b.side) continue;
          let min = Infinity;
          for (const p of a.pts) for (const q of b.pts) min = Math.min(min, p.distanceTo(q));
          expect(min, `${k0}/${k1} side ${String(a.side)}`).toBeGreaterThan((a.d + b.d) / 2);
        }
      }
    }
  });
});
