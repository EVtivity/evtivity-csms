// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { CAR_PROFILES, type CarBodyType } from '../site-layout-car';
import { CAR_PORTS, carPortInStation, parksBackedIn, routeLength } from '../site-layout-cable';
import { handleCableEntry, plugYaw } from '../site-layout-connectors';
import {
  SURFACE_M,
  bodyRect,
  cableBlocked,
  carToStation,
  officeRowSurface,
  pointsInFootprints,
  restHeight,
  tireFootprints,
} from '../site-layout-cable-surface';
import { carNoseAtStop, carTailAtStop, wallBoxOffset, wheelStopNearZ } from '../site-layout-grid';
import {
  COIL_GROUND_CLEARANCE_M,
  WALL_BOX_CABLE_M,
  WALL_BOX_HOOK,
  wallBoxChargingCable,
  wallBoxCoilPlace,
  wallBoxGlandRun,
  wallBoxDockEntry,
  wallBoxIdleCable,
} from '../site-layout-wall-box-cable';
import { AC_WALL_BOX, wallBoxDisplay } from '../site-layout-model-wall-box';
import { WALL_BOX_BOTTOM_M } from '../site-layout-marker';
import { WHEEL_STOP } from '@evtivity/lib/site-layout';
import type { Vec3 } from '../site-layout-model-kit';

const D = 0.0125;
const R = D / 2;
const wallZ = wallBoxOffset();
const surface = officeRowSurface();

function dockEntry(): { lead: Vec3; end: Vec3 } {
  // The handle in the front middle dock, angled down along the face.
  const e = wallBoxDockEntry({ wallZ, boxBottomM: WALL_BOX_BOTTOM_M, kind: 'type1' });
  return { lead: e.lead, end: e.end };
}

function maxGap(points: readonly Vec3[]): number {
  let gap = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1] as Vec3;
    const b = points[i] as Vec3;
    gap = Math.max(gap, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  return gap;
}

describe('wall box cable', () => {
  it('is one piece from the gland over the hanger in four turns into the front dock, 7.62 m long', () => {
    const dock = dockEntry();
    const idle = wallBoxIdleCable({
      wallZ,
      boxBottomM: WALL_BOX_BOTTOM_M,
      cableDiameterM: D,
      dock,
      sidewalkY: SURFACE_M.sidewalk,
    });
    expect(idle.turns).toBe(WALL_BOX_HOOK.turns);
    expect(Math.abs(routeLength(idle.points) - WALL_BOX_CABLE_M) / WALL_BOX_CABLE_M).toBeLessThan(
      0.02,
    );
    // One piece: it starts at the gland run and ends in the docked handle, no gap between points.
    const gland = wallBoxGlandRun(wallZ, WALL_BOX_BOTTOM_M, D);
    expect(idle.points[0]).toEqual(gland[0]);
    expect(idle.points[idle.points.length - 1]).toEqual(dock.end);
    expect(maxGap(idle.points)).toBeLessThan(0.12);
    // The turns rest on the saddle: the highest point is the saddle top (cable center).
    const top = Math.max(...idle.points.map((p) => p[1]));
    expect(top).toBeCloseTo(WALL_BOX_HOOK.saddleTopY, 2);
    // Never touching the ground: every point clears the sidewalk by the clearance.
    for (const p of idle.points) {
      expect(p[1]).toBeGreaterThan(restHeight(surface, p[0], p[2], R));
      expect(p[2]).toBeGreaterThan(wallZ);
    }
    expect(idle.bottomY).toBeGreaterThanOrEqual(
      SURFACE_M.sidewalk + R + COIL_GROUND_CLEARANCE_M - 1e-6,
    );
  });

  it('keeps the coil clear of the display, the status ring and the conduit', () => {
    const idle = wallBoxIdleCable({
      wallZ,
      boxBottomM: WALL_BOX_BOTTOM_M,
      cableDiameterM: D,
      dock: dockEntry(),
      sidewalkY: SURFACE_M.sidewalk,
    });
    const display = wallBoxDisplay(WALL_BOX_BOTTOM_M);
    const ringY = WALL_BOX_BOTTOM_M + AC_WALL_BOX.ring.centerFromBottomM;
    for (const p of idle.points) {
      // Over the box front (|x| within its half width) the cable stays below the ring.
      if (Math.abs(p[0]) < AC_WALL_BOX.widthM / 2) {
        expect(p[1]).toBeLessThan(ringY - AC_WALL_BOX.ring.radiusM - 0.01);
        expect(p[1]).toBeLessThan(display.center[1]);
      }
      const inConduit =
        Math.abs(p[0] - AC_WALL_BOX.conduit.x) < 0.03 &&
        p[1] < WALL_BOX_BOTTOM_M &&
        p[2] < wallZ + 0.04;
      expect(inConduit).toBe(false);
    }
    // The coil hangs right of the box, its turns' plane in front of the wall.
    const place = wallBoxCoilPlace(wallZ, D);
    expect(place.center[0] - 0.12).toBeGreaterThan(
      AC_WALL_BOX.widthM / 2 + AC_WALL_BOX.plate.marginM,
    );
  });

  it('comes off the hanger to every port of every car body, keeps its length, on the ground clear of the car', () => {
    for (const body of Object.keys(CAR_PROFILES) as CarBodyType[]) {
      const profile = CAR_PROFILES[body];
      for (const port of CAR_PORTS) {
        const backed = parksBackedIn(port);
        const frontZ = backed ? carTailAtStop('wall', profile) : carNoseAtStop('wall', profile);
        const at = carPortInStation(profile, port, { x: 0, z: frontZ });
        const nose = port === 'front_center';
        const plug = handleCableEntry(at, plugYaw(at, 0, nose), 'type1');
        const toCar = carToStation({ x: 0, z: frontZ }, profile.length, backed);
        const car = bodyRect(profile, toCar);
        const run = wallBoxChargingCable({
          wallZ,
          boxBottomM: WALL_BOX_BOTTOM_M,
          cableDiameterM: D,
          plug: { lead: plug.lead, end: plug.end },
          car,
          nosePort: nose,
          surface,
          blocked: cableBlocked({
            body: car,
            bodyHeightM: profile.height,
            tires: tireFootprints(profile, toCar),
            posts: [],
            radiusM: R,
          }),
        });
        const label = `${body} ${port}`;
        expect(run.reaches, label).toBe(true);
        expect(
          Math.abs(routeLength(run.points) - WALL_BOX_CABLE_M) / WALL_BOX_CABLE_M,
          label,
        ).toBeLessThan(0.02);
        expect(maxGap(run.points), label).toBeLessThan(0.4);
        // One piece: from the gland to the handle in the port.
        expect(run.points[0], label).toEqual(wallBoxGlandRun(wallZ, WALL_BOX_BOTTOM_M, D)[0]);
        expect(run.points[run.points.length - 1], label).toEqual(plug.end);
        for (const p of run.points) {
          expect(p[1], label).toBeGreaterThanOrEqual(restHeight(surface, p[0], p[2], R) - 1e-9);
        }
        const climb = run.points.slice(0, -3);
        expect(pointsInFootprints(climb, tireFootprints(profile, toCar)), label).toEqual([]);
        expect(pointsInFootprints(climb, [car], 0.3), label).toEqual([]);
        const stopNear = wheelStopNearZ('wall');
        const onStop = run.points.filter(
          (p) =>
            Math.abs(p[0]) <= WHEEL_STOP.lengthM / 2 &&
            p[2] >= stopNear &&
            p[2] <= stopNear + WHEEL_STOP.depthM &&
            p[1] < WHEEL_STOP.heightM + R,
        );
        expect(onStop, label).toEqual([]);
      }
    }
  });
});
