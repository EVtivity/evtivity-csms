// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EV_SIGNS } from '@evtivity/lib/site-layout';
import { buildIdleChargerModel } from '../site-layout-scene-charger-model';
import {
  AC_WALL_BOX,
  WALL_BOX_SLOTS,
  createAcWallBoxKit,
  wallBoxDisplay,
  wallBoxDock,
  wallBoxGland,
  wallBoxRings,
  wallBoxWidth,
  type WallBoxSlot,
} from '../site-layout-model-wall-box';
import { EVSE_PLATE, wallBoxEvsePlate } from '../site-layout-model-evse-plate';
import {
  WALL_BOX_CABLE_M,
  WALL_BOX_HOOK,
  wallBoxChargingCable,
  wallBoxDockEntry,
  wallBoxGlandRun,
  wallBoxHookX,
  wallBoxIdleCable,
  type WallBoxPort,
} from '../site-layout-wall-box-cable';
import { WALL_BOX_BOTTOM_M, chargerModelTopM, markerY } from '../site-layout-marker';
import { CAR_PROFILES } from '../site-layout-car';
import { carPortInStation, routeLength } from '../site-layout-cable';
import { handleCableEntry, plugYaw } from '../site-layout-connectors';
import {
  SURFACE_M,
  bodyRect,
  carToStation,
  officeRowSurface,
  restHeight,
} from '../site-layout-cable-surface';
import { carNoseAtStop, wallBoxOffset } from '../site-layout-grid';
import { DUAL_WALL_SIGN, WALL_SIGN, stationSignMount } from '../site-layout-signs';
import type { Vec3 } from '../site-layout-model-kit';

const D = 0.0125;
const R = D / 2;
const wallZ = wallBoxOffset();
const surface = officeRowSurface();
const ports = [
  { ports: 2, side: -1 },
  { ports: 2, side: 1 },
] as const satisfies readonly WallBoxPort[];

function materials(): Record<WallBoxSlot, THREE.Material> {
  return Object.fromEntries(
    WALL_BOX_SLOTS.map((s) => [s, new THREE.MeshBasicMaterial()]),
  ) as unknown as Record<WallBoxSlot, THREE.Material>;
}

function dockEntry(side: -1 | 1): { lead: Vec3; end: Vec3 } {
  const e = wallBoxDockEntry({
    wallZ,
    boxBottomM: WALL_BOX_BOTTOM_M,
    kind: 'type1',
    port: { ports: 2, side },
  });
  return { lead: e.lead, end: e.end };
}

function idle(port: WallBoxPort) {
  return wallBoxIdleCable({
    wallZ,
    boxBottomM: WALL_BOX_BOTTOM_M,
    cableDiameterM: D,
    dock: dockEntry(port.side),
    sidewalkY: SURFACE_M.sidewalk,
    port,
  });
}

function segmentDistance(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number {
  // Sampled: fine enough for cables drawn every few centimeters.
  let best = Infinity;
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    for (let j = 0; j <= 4; j++) {
      const u = j / 4;
      const q = [c[0] + (d[0] - c[0]) * u, c[1] + (d[1] - c[1]) * u, c[2] + (d[2] - c[2]) * u];
      best = Math.min(best, Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!));
    }
  }
  return best;
}

describe('two-port wall box', () => {
  it('meets the 2010 ADA 307.2 protrusion limit by its bottom under 27 in, its docks in reach', () => {
    // Heights above the sidewalk the box hangs over.
    expect(WALL_BOX_BOTTOM_M - SURFACE_M.sidewalk).toBeLessThanOrEqual(27 * 0.0254);
    for (const side of [-1, 1] as const) {
      const dock = wallBoxDock(WALL_BOX_BOTTOM_M, 2, side);
      expect(dock.y - SURFACE_M.sidewalk).toBeGreaterThanOrEqual(0.381);
      expect(dock.y - SURFACE_M.sidewalk).toBeLessThanOrEqual(1.2192);
      expect(Math.sign(dock.x)).toBe(side);
    }
    // The docks one holster pitch apart.
    expect(wallBoxDock(WALL_BOX_BOTTOM_M, 2, 1).x - wallBoxDock(WALL_BOX_BOTTOM_M, 2, -1).x).toBe(
      0.25,
    );
  });

  it('builds a wider body with two glands and leaves its two rings to the scene', () => {
    const kit = createAcWallBoxKit(WALL_BOX_BOTTOM_M, D, 2);
    const group = kit.build(materials());
    expect(kit.triangles).toBeLessThan(4000);
    const body = new THREE.Box3().setFromObject(group.getObjectByName('body') as THREE.Object3D);
    expect(body.max.x - body.min.x).toBeCloseTo(wallBoxWidth(2), 3);
    expect(group.getObjectByName('light')).toBeUndefined();
    // Each gland under its own dock's half, the conduit in the middle.
    for (const side of [-1, 1] as const) {
      const g = wallBoxGland(WALL_BOX_BOTTOM_M, 2, side);
      expect(Math.sign(g.at[0])).toBe(side);
      expect(Math.abs(g.at[0]) + 0.0225).toBeLessThan(wallBoxWidth(2) / 2);
    }
  });

  it('stacks each port dock, ring and plate inside the front, clear of each other and the display', () => {
    const w = AC_WALL_BOX;
    const rings = wallBoxRings(WALL_BOX_BOTTOM_M, 2);
    const display = wallBoxDisplay(WALL_BOX_BOTTOM_M);
    const ringR = w.ring.radiusM + w.ring.tubeM * 1.6;
    const faceEdge = wallBoxWidth(2) / 2 - w.frontPlate.edgeM;
    const faceTop = WALL_BOX_BOTTOM_M + w.heightM - w.frontPlate.edgeM;
    for (const side of [-1, 1] as const) {
      const ring = rings[side === -1 ? 0 : 1];
      expect(ring).toBeDefined();
      if (ring == null) continue;
      const plate = wallBoxEvsePlate(WALL_BOX_BOTTOM_M, side);
      expect(plate.turnY).toBe(0);
      // The plate over the ring, inside the front plate, the display between the two plates.
      expect(plate.at[1] - EVSE_PLATE.heightM / 2).toBeGreaterThanOrEqual(
        ring.at[1] + ringR - 1e-3,
      );
      expect(plate.at[1] + EVSE_PLATE.heightM / 2).toBeLessThanOrEqual(faceTop + 1e-9);
      expect(Math.abs(plate.at[0]) + EVSE_PLATE.widthM / 2).toBeLessThanOrEqual(faceEdge);
      expect(Math.abs(plate.at[0]) - EVSE_PLATE.widthM / 2).toBeGreaterThan(
        w.display.widthM / 2 + 0.006,
      );
      expect(Math.abs(ring.at[0]) + ringR).toBeLessThanOrEqual(faceEdge);
      expect(Math.abs(ring.at[0]) - ringR).toBeGreaterThan(w.display.widthM / 2);
      // The ring over the dock.
      expect(ring.at[1]).toBeGreaterThan(wallBoxDock(WALL_BOX_BOTTOM_M, 2, side).y + 0.1);
    }
    expect(display.center[1]).toBeGreaterThan(rings[0]?.at[1] ?? Infinity);
  });

  it('coils each idle cable over its own hook on its own side, one piece, 7.62 m, never crossing the other', () => {
    const cables = ports.map((port) => ({ port, run: idle(port) }));
    for (const { port, run } of cables) {
      const label = `side ${String(port.side)}`;
      expect(
        Math.abs(routeLength(run.points) - WALL_BOX_CABLE_M) / WALL_BOX_CABLE_M,
        label,
      ).toBeLessThan(0.02);
      expect(run.points[0], label).toEqual(wallBoxGlandRun(wallZ, WALL_BOX_BOTTOM_M, D, port)[0]);
      expect(run.points[run.points.length - 1], label).toEqual(dockEntry(port.side).end);
      // Every point on its own half: the cable never reaches across the box middle.
      for (const p of run.points) {
        expect(p[0] * port.side, label).toBeGreaterThan(0);
        expect(p[1], label).toBeGreaterThan(restHeight(surface, p[0], p[2], R));
        expect(p[2], label).toBeGreaterThan(wallZ);
      }
      const top = Math.max(...run.points.map((p) => p[1]));
      expect(top, label).toBeCloseTo(WALL_BOX_HOOK.saddleTopY, 2);
      // The hook stands out past the box on its side.
      expect(wallBoxHookX(port) * port.side).toBeGreaterThan(wallBoxWidth(2) / 2 + 0.2);
    }
    const [a, b] = cables;
    if (a == null || b == null) return;
    let gap = Infinity;
    for (let i = 1; i < a.run.points.length; i++) {
      for (let j = 1; j < b.run.points.length; j++) {
        gap = Math.min(
          gap,
          segmentDistance(
            a.run.points[i - 1] as Vec3,
            a.run.points[i] as Vec3,
            b.run.points[j - 1] as Vec3,
            b.run.points[j] as Vec3,
          ),
        );
      }
    }
    expect(gap).toBeGreaterThan(2 * D);
  });

  it('runs a charging cable from the gland of the plugged port to the car, its length kept', () => {
    const profile = CAR_PROFILES.sedan;
    const frontZ = carNoseAtStop('wall', profile);
    for (const port of ports) {
      const at = carPortInStation(profile, 'front_left', { x: 0, z: frontZ });
      const plug = handleCableEntry(at, plugYaw(at, 0, false), 'type1');
      const run = wallBoxChargingCable({
        wallZ,
        boxBottomM: WALL_BOX_BOTTOM_M,
        cableDiameterM: D,
        plug: { lead: plug.lead, end: plug.end },
        car: bodyRect(profile, carToStation({ x: 0, z: frontZ }, profile.length, false)),
        nosePort: false,
        surface,
        port,
      });
      expect(run.reaches).toBe(true);
      expect(run.points[0]).toEqual(wallBoxGlandRun(wallZ, WALL_BOX_BOTTOM_M, D, port)[0]);
      expect(Math.abs(routeLength(run.points) - WALL_BOX_CABLE_M) / WALL_BOX_CABLE_M).toBeLessThan(
        0.02,
      );
    }
  });

  it('hangs its signs over the box, clear of both cable coils, the marker and the window sill', () => {
    const coilTop = WALL_BOX_HOOK.saddleTopY + 0.04;
    const marker = markerY(chargerModelTopM('wall'));
    for (const california of [false, true]) {
      const mount = stationSignMount({
        siteType: 'office_retail',
        onSpot: true,
        wall: true,
        freeSpots: null,
        largeSpot: false,
        california,
        wallZ,
        wallPorts: 2,
      });
      expect(mount).not.toBeNull();
      if (mount == null) continue;
      expect(mount.onWall).toBe(true);
      expect(mount.chargingOnlyBottomM).toBe(DUAL_WALL_SIGN.bottomM);
      expect(mount.chargingOnlyBottomM).toBeGreaterThan(Math.max(coilTop, marker));
      const tops = [mount.chargingOnlyBottomM + EV_SIGNS.chargingOnly.heightM];
      if (mount.towAwayBottomM != null) {
        expect(california).toBe(true);
        tops.push(mount.towAwayBottomM + EV_SIGNS.towAway.heightM);
        // Side by side, not overlapping.
        const right = mount.x + EV_SIGNS.chargingOnly.widthM / 2;
        const left = mount.x + mount.towAwayDxM - EV_SIGNS.towAway.widthM / 2;
        expect(left).toBeGreaterThan(right);
      }
      for (const top of tops) expect(top).toBeLessThan(2.25);
    }
    // A one-port box keeps its signs beside it.
    const single = stationSignMount({
      siteType: 'office_retail',
      onSpot: true,
      wall: true,
      freeSpots: null,
      largeSpot: false,
      california: true,
      wallZ,
    });
    expect(single?.x).toBe(WALL_SIGN.x);
    expect(single?.towAwayDxM).toBe(0);
  });
});

describe('per-port status lights', () => {
  function portLights(g: THREE.Object3D): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    g.traverse((o) => {
      if (o instanceof THREE.Mesh && o.userData['evseLight'] === true) out.push(o);
    });
    return out;
  }
  function plateLights(g: THREE.Object3D): THREE.MeshStandardMaterial[] {
    const out: THREE.MeshStandardMaterial[] = [];
    g.traverse((o) => {
      if (o.userData['model'] !== 'evse-plate') return;
      for (const child of o.children) {
        if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshStandardMaterial) {
          out.push(child.material);
        }
      }
    });
    return out;
  }

  it('lights each port of a dual-port pedestal and a two-port wall box in its own EVSE state', () => {
    const charging = '#22c55e';
    const faulted = '#ef4444';
    for (const model of ['ac-pedestal-dual', 'wall-box-dual'] as const) {
      const built = buildIdleChargerModel(model, {
        plateColor: '#336699',
        dark: false,
        evseColors: [charging, faulted],
      });
      built.group.updateMatrixWorld(true);
      const lights = portLights(built.group).sort(
        (a, b) =>
          a.getWorldPosition(new THREE.Vector3()).x - b.getWorldPosition(new THREE.Vector3()).x,
      );
      expect(lights, model).toHaveLength(2);
      const [left, right] = lights.map((m) => m.material as THREE.MeshStandardMaterial);
      expect(left?.color.getHexString(), model).toBe(new THREE.Color(charging).getHexString());
      expect(right?.color.getHexString(), model).toBe(new THREE.Color(faulted).getHexString());
      // The same material as its EVSE's plate light, so they pulse and blink together.
      const plates = plateLights(built.group);
      expect(plates.includes(left as THREE.MeshStandardMaterial), model).toBe(true);
      expect(plates.includes(right as THREE.MeshStandardMaterial), model).toBe(true);
      // Two plates, one per EVSE.
      let count = 0;
      built.group.traverse((o) => {
        if (o.userData['model'] === 'evse-plate') count++;
      });
      expect(count, model).toBe(2);
      built.dispose();
    }
  });

  it('keeps one station-colored light and no plate on a one-EVSE charger', () => {
    for (const model of ['ac-pedestal', 'wall-box', 'curb-post'] as const) {
      const built = buildIdleChargerModel(model, { plateColor: '#336699', dark: false });
      expect(portLights(built.group), model).toHaveLength(0);
      let plates = 0;
      built.group.traverse((o) => {
        if (o.userData['model'] === 'evse-plate') plates++;
      });
      expect(plates, model).toBe(0);
      built.dispose();
    }
  });
});
