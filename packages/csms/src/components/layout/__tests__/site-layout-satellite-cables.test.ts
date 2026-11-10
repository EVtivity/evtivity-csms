// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { CABLE_HOOK, CABLE_TURN_PITCH } from '../site-layout-model-cable-hook';
import { describe, expect, it } from 'vitest';
import { CHARGER_PORT_LIMITS } from '@evtivity/lib/site-layout';
import { DC_CABLE_M, routeLength } from '../site-layout-charger-cables';
import { CONNECTOR_SPECS, holsterPose, type ConnectorKind } from '../site-layout-connectors';
import { dispenserHolsters } from '../site-layout-grid';
import type { Vec3 } from '../site-layout-model-kit';
import { SPLIT_SATELLITE } from '../site-layout-model-split-satellite';
import {
  SATELLITE_HANGER,
  SATELLITE_SIDE_X,
  satelliteCoilPlace,
  satelliteGland,
  satelliteHookSpec,
  satelliteHolster,
  satelliteHolsterCable,
  satelliteHolsterEntry,
} from '../site-layout-satellite-cables';

const KINDS: ConnectorKind[] = ['ccs1', 'ccs2', 'chademo', 'nacs'];

/** A satellite carries one or two cables, one on each side (`CHARGER_PORT_LIMITS.dc.satelliteConnectors`). */
const SATELLITE_COUNTS = Array.from(
  { length: CHARGER_PORT_LIMITS.dc.satelliteConnectors },
  (_, k) => k + 1,
);

interface Cable {
  side: -1 | 1;
  backM: number;
  kind: ConnectorKind;
  route: Vec3[];
}

/** Every idle cable of a satellite with `count` holsters of `kind`, as the scene lays them out. */
function satelliteCables(count: number, kind: ConnectorKind): Cable[] {
  const holsters = dispenserHolsters(count);
  return holsters.map((h) => {
    return {
      side: h.side,
      backM: h.backM,
      kind,
      route: satelliteHolsterCable(h.side, kind, h.backM),
    };
  });
}

function segmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const [abx, aby, abz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const [apx, apy, apz] = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const len = abx * abx + aby * aby + abz * abz;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / len));
  return Math.hypot(apx - abx * t, apy - aby * t, apz - abz * t);
}

/** The closest approach of two polylines (vertex to segment, both ways). */
function routeGap(a: readonly Vec3[], b: readonly Vec3[]): number {
  let gap = Infinity;
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    for (const p of from) {
      for (let i = 1; i < to.length; i++) {
        const s = to[i - 1];
        const e = to[i];
        if (s != null && e != null) gap = Math.min(gap, segmentDistance(p, s, e));
      }
    }
  }
  return gap;
}

describe('split system satellite cables', () => {
  it('runs every idle cable unbroken from its gland over its side peg into its handle', () => {
    for (const kind of KINDS) {
      for (const count of SATELLITE_COUNTS) {
        const holsters = dispenserHolsters(count);
        holsters.forEach((h, k) => {
          const route = satelliteHolsterCable(h.side, kind, h.backM);
          const label = `${kind} ${String(count)} cables, holster ${String(k)}`;
          const gland = satelliteGland(h.side);
          const first = route[0];
          const last = route[route.length - 1];
          if (first == null || last == null) throw new Error('empty route');
          expect(
            Math.hypot(first[0] - gland.at[0], first[1] - gland.at[1], first[2] - gland.at[2]),
            label,
          ).toBeLessThan(0.05);
          expect(last, label).toEqual(satelliteHolsterEntry(h.side, h.backM, kind).end);
          // The cable length is the DC dispenser class median, within 10 percent.
          expect(Math.abs(routeLength(route) - DC_CABLE_M) / DC_CABLE_M, label).toBeLessThan(0.1);
          // It goes over the saddle top of its own place on the peg (on a hanger, never loose).
          const place = satelliteCoilPlace(h.side, kind);
          const top: Vec3 = [place.center[0], place.center[1] + place.r1, place.center[2]];
          expect(
            Math.min(...route.map((p) => Math.hypot(p[0] - top[0], p[1] - top[1], p[2] - top[2]))),
            label,
          ).toBeLessThan(0.03);
          // No point inside the satellite body, and the loops stay off the ground.
          const d = CONNECTOR_SPECS[kind].cableDiameterM;
          for (const p of route.slice(2, -2)) {
            const inside =
              Math.abs(p[0]) < SATELLITE_SIDE_X - 0.005 &&
              Math.abs(p[2]) < SPLIT_SATELLITE.depthM / 2 - 0.005 &&
              p[1] < SPLIT_SATELLITE.heightM;
            expect(inside, `${label} ${p.join(',')}`).toBe(false);
            expect(p[1], label).toBeGreaterThan(SPLIT_SATELLITE.basePlate.thickM + d / 2 + 0.09);
          }
        });
      }
    }
  });

  it('keeps every cable clear of the others and of the other handles', () => {
    for (const kind of KINDS) {
      for (const count of [2]) {
        const cables = satelliteCables(count, kind);
        const r = CONNECTOR_SPECS[kind].cableDiameterM / 2;
        cables.forEach((a, i) => {
          cables.forEach((b, j) => {
            if (j <= i) return;
            expect(
              routeGap(a.route, b.route),
              `${kind} ${String(count)}: ${String(i)}-${String(j)}`,
            ).toBeGreaterThan(2 * r);
          });
          // A handle is about 0.05 m thick: no other cable comes within its half and the cable radius.
          for (const b of cables) {
            if (b === a) continue;
            const [x, y, z] = satelliteHolster(b.side, b.backM);
            const pose = holsterPose({ x, y, z }, { x: b.side, z: 0 });
            const lead = satelliteHolsterEntry(b.side, b.backM, b.kind).lead;
            const mouth: Vec3 = [pose.mouth.x, pose.mouth.y, pose.mouth.z];
            const near = Math.min(...a.route.map((p) => segmentDistance(p, mouth, lead)));
            expect(
              near,
              `${kind} ${String(count)}: cable ${String(i)} by a handle`,
            ).toBeGreaterThan(r + 0.025);
          }
        });
      }
    }
  });

  it('mounts each side hook on the side wall within reach, clear of the holster rail', () => {
    for (const kind of KINDS) {
      const spec = satelliteHookSpec(kind);
      const place = satelliteCoilPlace(1, kind);
      // The cable's top over the hook inside the 0.38 to 1.22 m reach range of the 2010 ADA Standards 308.
      const top = place.center[1] + place.r1;
      expect(top).toBeGreaterThan(0.38);
      expect(top).toBeLessThanOrEqual(1.22);
      // The hook's rose (0.05 m across) stays on the 0.3 m deep wall and behind the rail.
      const hd = SPLIT_SATELLITE.depthM / 2;
      expect(SATELLITE_HANGER.zM - CABLE_HOOK.roseRadiusM).toBeGreaterThanOrEqual(-hd);
      expect(SATELLITE_HANGER.zM + CABLE_HOOK.roseRadiusM).toBeLessThan(
        SPLIT_SATELLITE.rail.zM - SPLIT_SATELLITE.rail.depthM / 2,
      );
      // The cable's turns fit on the hook's throat.
      const turnsEnd =
        place.center[0] +
        (SATELLITE_HANGER.turnsPerCable - 0.5) *
          CABLE_TURN_PITCH *
          CONNECTOR_SPECS[kind].cableDiameterM;
      expect(turnsEnd).toBeLessThan(SATELLITE_SIDE_X + CABLE_HOOK.roseThicknessM + spec.throatM);
    }
  });
});
