// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A two-EVSE DC dispenser on the line between its two stalls carries the 6 m
// dual-outlet cable (`DC_PAIRED_CABLE_M`, owner decision 2026-11-10, layout
// review H2): its plugged cable reaches every port of every body in either
// stall, parked nose in or backed in, keeps to its own stall and is never
// drawn longer than its length. With the 3.6 m median cable 78 of 150 such
// routes fell short and were drawn up to 32 percent long.

import { describe, expect, it } from 'vitest';
import * as carM from '../site-layout-car';
import * as cab from '../site-layout-cable';
import * as conn from '../site-layout-connectors';
import * as cc from '../site-layout-charger-cables';
import * as rest from '../site-layout-cable-rest';
import * as surfM from '../site-layout-cable-surface';
import * as ground from '../site-layout-ground';
import * as grid from '../site-layout-grid';
import * as boll from '../site-layout-dc-bollards';
import * as gland from '../site-layout-model-cable-gland';
import * as links from '../site-layout-links';
import * as lib from '@evtivity/lib/site-layout';

describe('two-EVSE DC dispenser stall cables', () => {
  it('uses the 6 m dual-outlet cable for two EVSEs and the 3.6 m one otherwise', () => {
    expect(cc.dcDispenserCableM(2)).toBe(cc.DC_PAIRED_CABLE_M);
    expect(cc.DC_PAIRED_CABLE_M).toBe(6);
    expect(cc.dcDispenserCableM(1)).toBe(cc.DC_CABLE_M);
  });

  // One test per connector kind and EVSE: all 1280 routes in one test passed its
  // limit on a loaded CI runner with coverage on.
  it.each(
    (['ccs1', 'ccs2', 'chademo', 'nacs'] as const).flatMap((kind) =>
      ([0, 1] as const).map((evseIndex) => ({ kind, evseIndex })),
    ),
  )(
    'reach every port of every body from $kind EVSE $evseIndex, nose in or backed in, at their length',
    ({ kind, evseIndex }) => {
      const lot = grid.lotOf({ ...lib.DEFAULT_LAYOUT_GRID, siteType: 'parking_lot' });
      const W = lot.spotW;
      const surface = ground.stationGround(
        lot,
        { x: 10, z: 20, turn: 0 },
        ground.chargerPadRects('dc'),
        [],
      );
      const lengthM = cc.dcDispenserCableM(2);
      const posts = [-boll.DC_BOLLARD.x, boll.DC_BOLLARD.x].map((x) => ({
        x,
        z: boll.DC_BOLLARD.z,
        radiusM: links.EQUIPMENT_BOLLARD.radiusM,
        heightM: links.EQUIPMENT_BOLLARD.heightM,
      }));
      let cases = 0;
      const fails: string[] = [];
      // Two connectors per EVSE: the front holsters are the one-connector dispenser's.
      for (const evse of [[2, 2]] as const) {
        {
          for (const [body, profile] of Object.entries(carM.CAR_PROFILES)) {
            for (const port of cab.CAR_PORTS) {
              for (const h of conn.holsterSlots([...evse]).filter((s) => s.evse === evseIndex)) {
                const i = h.evse;
                const stallX = ((i === 0 ? -1 : 1) * W) / 2;
                const backed = cab.parksBackedIn(port);
                const frontZ = backed ? boll.DC_CAR_TAIL_M : boll.DC_CAR_FRONT_M;
                const at0 = cab.carPortInStation(profile, port, { x: 0, z: frontZ });
                const at = { ...at0, x: at0.x + stallX };
                const nose = port === 'front_center';
                const entry = conn.handleCableEntry(at, conn.plugYaw(at, stallX, nose), kind);
                const d = conn.CONNECTOR_SPECS[kind].cableDiameterM;
                const from = cc.dcGlandOut(h.side, h.backM, kind);
                const toSt0 = surfM.carToStation({ x: 0, z: frontZ }, profile.length, backed);
                const toSt = (x: number, z: number): readonly [number, number] => {
                  const [a, b] = toSt0(x, z);
                  return [a + stallX, b] as const;
                };
                const route = rest.plugRoute({
                  blocked: surfM.cableBlocked({
                    body: surfM.bodyRect(profile, toSt),
                    bodyHeightM: profile.height,
                    tires: surfM.tireFootprints(profile, toSt),
                    posts,
                    radiusM: d / 2,
                  }),
                  from,
                  plug: { lead: entry.lead, end: entry.end },
                  car: {
                    minX: stallX - profile.width / 2,
                    maxX: stallX + profile.width / 2,
                    minZ: frontZ,
                    maxZ: frontZ + profile.length,
                  },
                  nosePort: nose,
                  surface,
                  radiusM: d / 2,
                  bendM: gland.CABLE_MIN_BEND_RATIO * d,
                  lengthM,
                  bounds: { minX: stallX - W / 2, maxX: stallX + W / 2 },
                });
                const len = cab.routeLength(route.points);
                const label = `${JSON.stringify(evse)} ${kind} ${body} ${port} EVSE ${String(i + 1)} back ${String(h.backM)}: ${len.toFixed(2)} m`;
                const inStall = route.points
                  .slice(from.length)
                  .every((p) => p[0] >= stallX - W / 2 - 1e-6 && p[0] <= stallX + W / 2 + 1e-6);
                // It reaches, keeps its whole length (never drawn longer) and stays in its stall.
                if (!route.reaches || Math.abs(len - lengthM) / lengthM > 0.02 || !inStall) {
                  fails.push(
                    `${label} reaches ${String(route.reaches)} in stall ${String(inStall)}`,
                  );
                }
                cases += 1;
              }
            }
          }
        }
      }
      expect(fails).toEqual([]);
      expect(cases).toBeGreaterThan(0);
    },
    30_000,
  );
});
