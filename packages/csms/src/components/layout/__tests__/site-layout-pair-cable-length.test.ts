// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A plugged cable of a dual-port AC pedestal or a two-port post between two
// stalls keeps its whole 5.79 m (`AC_CABLE_M`) inside its own stall, for
// every connector kind, body and port, in both stalls (independent review
// 2026-11-10, M1: the slack of a bow clamped into the stall was dropped).

import { describe, expect, it } from 'vitest';
import * as carM from '../site-layout-car';
import * as cab from '../site-layout-cable';
import * as conn from '../site-layout-connectors';
import * as cc from '../site-layout-charger-cables';
import * as rest from '../site-layout-cable-rest';
import * as surfM from '../site-layout-cable-surface';
import * as ground from '../site-layout-ground';
import * as grid from '../site-layout-grid';
import * as acm from '../site-layout-model-ac-pedestal';
import * as gland from '../site-layout-model-cable-gland';
import * as lib from '@evtivity/lib/site-layout';

// One test per connector kind and stall: the 240 routes ran as one test and
// passed its 5 s limit on a loaded CI runner with coverage on.
const CASES = (['type1', 'type2', 'nacs'] as const).flatMap((kind) =>
  ([0, 1] as const).map((i) => ({ kind, i })),
);

describe('dual-port AC stall cables', () => {
  it.each(CASES)('keep the whole $kind cable inside stall $i', ({ kind, i }) => {
    const lot = grid.lotOf({ ...lib.DEFAULT_LAYOUT_GRID, siteType: 'parking_lot' });
    const W = lot.spotW;
    const surface = ground.stationGround(
      lot,
      { x: 10, z: 20, turn: 0 },
      ground.chargerPadRects('ac'),
      [],
    );
    for (const [body, profile] of Object.entries(carM.CAR_PROFILES)) {
      for (const port of cab.CAR_PORTS) {
        const stallX = ((i === 0 ? -1 : 1) * W) / 2;
        const backed = cab.parksBackedIn(port);
        const frontZ = backed
          ? grid.carTailAtStop('curb', profile)
          : grid.carNoseAtStop('curb', profile);
        const at0 = cab.carPortInStation(profile, port, { x: 0, z: frontZ });
        const at = { ...at0, x: at0.x + stallX };
        const nose = port === 'front_center';
        const entry = conn.handleCableEntry(at, conn.plugYaw(at, stallX, nose), kind);
        const side = i === 0 ? -1 : 1;
        const d = conn.chargerCableDiameterM(kind, true);
        const from = cc.acGlandOut(acm.acGlandX(2, side), d);
        const car = {
          minX: stallX - profile.width / 2,
          maxX: stallX + profile.width / 2,
          minZ: frontZ,
          maxZ: frontZ + profile.length,
        };
        const toSt0 = surfM.carToStation({ x: 0, z: frontZ }, profile.length, backed);
        const toSt = (x: number, z: number) => {
          const [a, b] = toSt0(x, z);
          return [a + stallX, b] as const;
        };
        const route = rest.plugRoute({
          blocked: surfM.cableBlocked({
            body: surfM.bodyRect(profile, toSt),
            bodyHeightM: profile.height,
            tires: surfM.tireFootprints(profile, toSt),
            posts: [],
            radiusM: d / 2,
          }),
          from,
          plug: { lead: entry.lead, end: entry.end },
          car,
          nosePort: nose,
          surface,
          radiusM: d / 2,
          bendM: gland.CABLE_MIN_BEND_RATIO * d,
          lengthM: cc.AC_CABLE_M,
          bounds: { minX: stallX - W / 2, maxX: stallX + W / 2 },
        });
        const len = cab.routeLength(route.points);
        const label = `${kind} ${body} ${port} stall ${String(i + 1)}`;
        expect(route.reaches, label).toBe(true);
        expect(
          Math.abs(len - cc.AC_CABLE_M) / cc.AC_CABLE_M,
          `${label}: ${len.toFixed(2)} m`,
        ).toBeLessThanOrEqual(0.02);
        // Inside its own stall.
        for (const p of route.points.slice(from.length)) {
          expect(p[0], label).toBeGreaterThanOrEqual(stallX - W / 2 - 1e-6);
          expect(p[0], label).toBeLessThanOrEqual(stallX + W / 2 + 1e-6);
        }
      }
    }
  });
});
