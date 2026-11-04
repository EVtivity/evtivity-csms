// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { CAR_PROFILES, type CarBodyType } from '../site-layout-car';
import {
  CAR_PORTS,
  carPortInStation,
  parksBackedIn,
  routeLength,
  type CarPort,
} from '../site-layout-cable';
import { CONNECTOR_SPECS, handleCableEntry, plugYaw } from '../site-layout-connectors';
import { AC_CABLE_M, DC_CABLE_M, acGlandOut, dcGlandOut } from '../site-layout-charger-cables';
import { plugRoute } from '../site-layout-cable-rest';
import {
  bodyRect,
  cableBlocked,
  carToStation,
  pointsInFootprints,
  restHeight,
  tireFootprints,
  type CarToStation,
} from '../site-layout-cable-surface';
import { chargerPadRects, stationGround } from '../site-layout-ground';
import { carNoseAtStop, carTailAtStop, lotOf } from '../site-layout-grid';
import { DEFAULT_LAYOUT_GRID } from '@evtivity/lib/site-layout';
import { CABLE_MIN_BEND_RATIO } from '../site-layout-model-cable-gland';
import { DC_BOLLARD, DC_CAR_FRONT_M, DC_CAR_TAIL_M } from '../site-layout-dc-bollards';
import { EQUIPMENT_BOLLARD } from '../site-layout-links';
import type { Vec3 } from '../site-layout-model-kit';

const lot = lotOf({ ...DEFAULT_LAYOUT_GRID, siteType: 'parking_lot' });

interface Case {
  label: string;
  points: Vec3[];
  reaches: boolean;
  toStation: CarToStation;
  profile: (typeof CAR_PROFILES)[CarBodyType];
  radius: number;
  surface: ReturnType<typeof stationGround>;
  kind: 'dc' | 'ac';
}

function cases(): Case[] {
  const out: Case[] = [];
  for (const kind of ['dc', 'ac'] as const) {
    const surface = stationGround(lot, { x: 10, z: 20, turn: 0 }, chargerPadRects(kind), []);
    for (const body of Object.keys(CAR_PROFILES) as CarBodyType[]) {
      const profile = CAR_PROFILES[body];
      for (const port of CAR_PORTS as readonly CarPort[]) {
        const backed = parksBackedIn(port);
        const frontZ =
          kind === 'dc'
            ? backed
              ? DC_CAR_TAIL_M
              : DC_CAR_FRONT_M
            : backed
              ? carTailAtStop('curb', profile)
              : carNoseAtStop('curb', profile);
        const at = carPortInStation(profile, port, { x: 0, z: frontZ });
        const nose = port === 'front_center';
        const connector = kind === 'dc' ? 'ccs1' : 'type1';
        const entry = handleCableEntry(at, plugYaw(at, 0, nose), connector);
        const side = at.x > 0.001 ? 1 : -1;
        const d = CONNECTOR_SPECS[connector].cableDiameterM;
        const from = kind === 'dc' ? dcGlandOut(side, 0, connector) : acGlandOut(0, d);
        const car = {
          minX: -profile.width / 2,
          maxX: profile.width / 2,
          minZ: frontZ,
          maxZ: frontZ + profile.length,
        };
        const toStationEarly = carToStation({ x: 0, z: frontZ }, profile.length, backed);
        const posts =
          kind === 'dc'
            ? [-DC_BOLLARD.x, DC_BOLLARD.x].map((x) => ({
                x,
                z: DC_BOLLARD.z,
                radiusM: EQUIPMENT_BOLLARD.radiusM,
                heightM: EQUIPMENT_BOLLARD.heightM,
              }))
            : [];
        const route = plugRoute({
          blocked: cableBlocked({
            body: bodyRect(profile, toStationEarly),
            bodyHeightM: profile.height,
            tires: tireFootprints(profile, toStationEarly),
            posts,
            radiusM: d / 2,
          }),
          from,
          plug: { lead: entry.lead, end: entry.end },
          car,
          nosePort: nose,
          surface,
          radiusM: d / 2,
          bendM: CABLE_MIN_BEND_RATIO * d,
          lengthM: kind === 'dc' ? DC_CABLE_M : AC_CABLE_M,
        });
        const toStation: CarToStation = backed
          ? (x, z) => [-x, frontZ + profile.length - z] as const
          : (x, z) => [x, frontZ + z] as const;
        out.push({
          label: `${kind} ${body} ${port}`,
          points: route.points,
          reaches: route.reaches,
          toStation,
          profile,
          radius: d / 2,
          surface,
          kind,
        });
      }
    }
  }
  return out;
}

describe('plugged charger cables', () => {
  it('reaches every port of every body, each cable at its length (DC 3.6 m, AC 5.79 m)', () => {
    for (const c of cases()) {
      expect(c.reaches, c.label).toBe(true);
      const length = c.kind === 'dc' ? DC_CABLE_M : AC_CABLE_M;
      expect(Math.abs(routeLength(c.points) - length) / length, c.label).toBeLessThan(0.02);
    }
  });

  it('rests every point on the ground or above it, outside every tire and the car body', () => {
    for (const c of cases()) {
      for (const p of c.points) {
        expect(p[1], c.label).toBeGreaterThanOrEqual(
          restHeight(c.surface, p[0], p[2], c.radius) - 1e-9,
        );
      }
      // The handle's boot (the last three points) meets the port on the body.
      const run = c.points.slice(0, -3);
      expect(pointsInFootprints(run, tireFootprints(c.profile, c.toStation)), c.label).toEqual([]);
      const body = bodyRect(c.profile, c.toStation);
      const inside = run.filter(
        (p) =>
          p[0] > body.minX - c.radius &&
          p[0] < body.maxX + c.radius &&
          p[2] > body.minZ - c.radius &&
          p[2] < body.maxZ + c.radius &&
          p[1] < 1.2,
      );
      expect(inside, c.label).toEqual([]);
      // Clear of the DC dispenser's bollards.
      if (c.kind === 'dc') {
        for (const bx of [-DC_BOLLARD.x, DC_BOLLARD.x]) {
          const hit = c.points.filter(
            (p) =>
              Math.hypot(p[0] - bx, p[2] - DC_BOLLARD.z) < EQUIPMENT_BOLLARD.radiusM + c.radius &&
              p[1] < EQUIPMENT_BOLLARD.heightM + c.radius,
          );
          expect(hit, c.label).toEqual([]);
        }
      }
    }
  });
});
