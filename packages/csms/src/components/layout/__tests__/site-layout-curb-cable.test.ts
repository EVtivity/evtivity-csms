// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { CAR_PROFILES, type CarBodyType } from '../site-layout-car';
import { CAR_PORTS, carPortOf, routeLength } from '../site-layout-cable';
import { handleCableEntry } from '../site-layout-connectors';
import { acGlandOut } from '../site-layout-charger-cables';
import {
  bodyRect,
  curbsideSurface,
  pointsInFootprints,
  restHeight,
  tireFootprints,
} from '../site-layout-cable-surface';
import {
  CURB_FACE_Z,
  CURB_POST_CABLE_M,
  TRAVEL_LANE_Z,
  curbChargingRoute,
  curbPortOf,
  parallelPlace,
  parallelPort,
} from '../site-layout-curb-cable';
import { CURB_POST_IN_M } from '../site-layout-grid';
import { STANDARD_DIMENSIONS } from '@evtivity/lib/site-layout';
import type { Vec3 } from '../site-layout-model-kit';

const D = 0.0125;
const R = D / 2;
const surface = curbsideSurface();

describe('curbside car and cable', () => {
  it('draws every port position for a spread of sessions, a curbside car every one but rear left', () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => carPortOf(`ses_${String(i)}`)));
    expect([...seen].sort()).toEqual([...CAR_PORTS].sort());
    const curb = new Set([...seen].map(curbPortOf));
    expect([...curb].sort()).toEqual(['front_center', 'front_right', 'rear_right']);
  });

  it('parks every car inside its spot, the right side 0.3 m from the curb, clear of the travel lane', () => {
    for (const body of Object.keys(CAR_PROFILES) as CarBodyType[]) {
      const profile = CAR_PROFILES[body];
      for (const port of CAR_PORTS) {
        const place = parallelPlace(profile, port);
        const rect = bodyRect(profile, place.toStation);
        expect(rect.minZ, `${body} ${port}`).toBeCloseTo(CURB_FACE_Z + 0.15, 6);
        expect(rect.maxZ, `${body} ${port}`).toBeLessThan(TRAVEL_LANE_Z);
        expect(rect.minX).toBeGreaterThanOrEqual(-CURB_POST_IN_M);
        expect(rect.maxX).toBeLessThanOrEqual(
          -CURB_POST_IN_M + STANDARD_DIMENSIONS.parallelSpotLengthM,
        );
      }
    }
  });

  it('reaches every curbside port of every body within the cable, on the ground, clear of the tires, the body and the travel lane', () => {
    for (const body of Object.keys(CAR_PROFILES) as CarBodyType[]) {
      const profile = CAR_PROFILES[body];
      // Every port a curbside car draws (a rear street side port mirrored to the curb side).
      for (const port of new Set(CAR_PORTS.map(curbPortOf))) {
        const label = `${body} ${port}`;
        const place = parallelPlace(profile, port);
        const pp = parallelPort(profile, port, place);
        const entry = handleCableEntry(pp.at, pp.yaw, 'type1');
        const route = curbChargingRoute({
          from: acGlandOut(0, D),
          plug: { lead: entry.lead, end: entry.end },
          port,
          place,
          surface,
          cableDiameterM: D,
        });
        const pts = route;
        expect(routeLength(pts), label).toBeLessThanOrEqual(CURB_POST_CABLE_M);
        expect(pts[pts.length - 1], label).toEqual(entry.end);
        for (const p of pts) {
          expect(p[1], label).toBeGreaterThanOrEqual(restHeight(surface, p[0], p[2], R) - 1e-9);
        }
        // The cable stays out of the travel lane (the plugged handle's boot is the last three points).
        for (const p of pts.slice(0, -3)) expect(p[2] + R, label).toBeLessThan(TRAVEL_LANE_Z);
        const approach = pts.slice(0, -4);
        expect(
          pointsInFootprints(approach, tireFootprints(profile, place.toStation)),
          label,
        ).toEqual([]);
        // Never on the street side of the car's curb facing side: alongside the car every
        // point stays curb side of that plane, ahead of the nose no farther out than the nose port.
        const rect = bodyRect(profile, place.toStation);
        const streetSide = pts
          .slice(0, -3)
          .filter(
            (p: Vec3) =>
              (p[0] >= rect.minX - 0.1 && p[0] <= rect.maxX && p[2] > rect.minZ - R) ||
              p[2] > place.centerZ + 0.01,
          );
        expect(streetSide, label).toEqual([]);
      }
    }
  });
});
