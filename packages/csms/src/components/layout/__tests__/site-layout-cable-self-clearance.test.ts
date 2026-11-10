// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// No idle cable passes through itself (owner decision 2026-11-10, layout
// review H1): two parts of one cable far apart along it (more than six
// diameters) never come closer than one cable diameter, center to center, on
// the smooth curve the scene draws. Adjacent turns on a J hook sit at the
// 1.05 D pitch (`CABLE_TURN_PITCH`), so they pass. Every charger type,
// connector kind and port.

import { describe, expect, it } from 'vitest';
import { CHARGER_PORT_LIMITS } from '@evtivity/lib/site-layout';
import * as THREE from 'three';
import {
  acHolsterCable,
  acHolsterEntry,
  dcDispenserCableM,
  dcHolsterCable,
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

const DC_KINDS: ConnectorKind[] = ['ccs1', 'ccs2', 'chademo', 'nacs'];
const AC_KINDS: ConnectorKind[] = ['type1', 'type2', 'nacs'];
const SATELLITE_COUNTS = Array.from(
  { length: CHARGER_PORT_LIMITS.dc.satelliteConnectors },
  (_, k) => k + 1,
);

/**
 * The closest approach of two parts of `route` more than six diameters apart
 * along it, on the CatmullRom curve the scene draws (`site-layout-scene-cables.ts`).
 */
export function selfClearance(route: readonly Vec3[], d: number): { min: number; at: string } {
  const pts = new THREE.CatmullRomCurve3(route.map((p) => new THREE.Vector3(...p))).getPoints(700);
  const s: number[] = [0];
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[i - 1];
    s.push((s[i - 1] ?? 0) + (a != null && b != null ? a.distanceTo(b) : 0));
  }
  let min = Infinity;
  let at = '';
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    if (p == null) continue;
    for (let j = i + 1; j < pts.length; j += 1) {
      if ((s[j] ?? 0) - (s[i] ?? 0) < 6 * d) continue;
      const q = pts[j];
      if (q == null) continue;
      const dist = p.distanceTo(q);
      if (dist < min) {
        min = dist;
        at = `s ${(s[i] ?? 0).toFixed(2)} and ${(s[j] ?? 0).toFixed(2)} at ${p
          .toArray()
          .map((v) => v.toFixed(3))
          .join(',')}`;
      }
    }
  }
  return { min, at };
}

/** The cases of `fails` that pass through themselves, one line each. */
function clearOf(fails: string[]): (route: readonly Vec3[], d: number, label: string) => void {
  return (route, d, label) => {
    const { min, at } = selfClearance(route, d);
    if (min < d) {
      fails.push(`${label}: ${(min * 1000).toFixed(1)} mm on ${(d * 1000).toFixed(1)} mm, ${at}`);
    }
  };
}

describe('no idle cable passes through itself', () => {
  it('DC dispenser, one and two EVSEs, every cable count and kind', () => {
    const fails: string[] = [];
    const expectClear = clearOf(fails);
    for (const evse of [[1], [2], [3], [1, 1], [2, 2]]) {
      for (const kind of DC_KINDS) {
        const d = CONNECTOR_SPECS[kind].cableDiameterM;
        for (const h of holsterSlots(evse)) {
          expectClear(
            // A two-EVSE dispenser's 6 m dual-outlet cable (`dcDispenserCableM`).
            dcHolsterCable(h.side, h.backM, kind, undefined, dcDispenserCableM(evse.length)),
            d,
            `DC ${JSON.stringify(evse)} ${kind} side ${String(h.side)} back ${String(h.backM)}`,
          );
        }
      }
    }
    expect(fails).toEqual([]);
  });

  it('split satellite, every holster count and kind', () => {
    const fails: string[] = [];
    const expectClear = clearOf(fails);
    for (const kind of DC_KINDS) {
      const d = CONNECTOR_SPECS[kind].cableDiameterM;
      // A satellite carries one or two cables (`CHARGER_PORT_LIMITS.dc.satelliteConnectors`).
      for (const count of SATELLITE_COUNTS) {
        const holsters = dispenserHolsters(count);
        holsters.forEach((h, k) => {
          expectClear(
            satelliteHolsterCable(h.side, kind, h.backM),
            d,
            `satellite ${kind} ${String(count)} holster ${String(k)}`,
          );
        });
      }
    }
    expect(fails).toEqual([]);
  });

  it('wall box, one and two ports, every kind', () => {
    const fails: string[] = [];
    const expectClear = clearOf(fails);
    for (const kind of AC_KINDS) {
      // The scene draws an AC cable at most 16.1 mm thick (`chargerCableDiameterM`).
      const d = chargerCableDiameterM(kind, true);
      const ports: Array<{ ports: 1 | 2; side: -1 | 1 }> = [
        { ports: 1, side: 1 },
        { ports: 2, side: -1 },
        { ports: 2, side: 1 },
      ];
      for (const port of ports) {
        const e = wallBoxDockEntry({ wallZ: 0, boxBottomM: WALL_BOX_BOTTOM_M, kind, port });
        const w = wallBoxIdleCable({
          wallZ: 0,
          boxBottomM: WALL_BOX_BOTTOM_M,
          cableDiameterM: d,
          dock: { lead: e.lead, end: e.end },
          sidewalkY: SURFACE_M.sidewalk,
          port,
        });
        expectClear(w.points, d, `wall box ${kind} ${String(port.ports)} ${String(port.side)}`);
      }
    }
    expect(fails).toEqual([]);
  });

  it('AC pedestal (one and two ports) and curb post, every kind', () => {
    const fails: string[] = [];
    const expectClear = clearOf(fails);
    for (const kind of AC_KINDS) {
      const d = chargerCableDiameterM(kind, true);
      for (const ports of [1, 2] as const) {
        for (const side of acHookSides(ports)) {
          expectClear(
            acHolsterCable(acGlandX(ports, side), side, d, acHolsterEntry(side, kind)),
            d,
            `AC ${kind} ports ${String(ports)} side ${String(side)}`,
          );
        }
      }
    }
    expect(fails).toEqual([]);
  });
});
