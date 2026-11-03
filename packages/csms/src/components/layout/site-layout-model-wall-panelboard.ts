// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The AC panelboard on a building facade (an office or retail site): the
// NEMA 3R enclosure bolted to the wall, its conduits strapped to the wall
// down to the ground.
//
// Frame: origin on the facade at the ground under the enclosure center, the
// wall in the plane z = 0, the door faces +z, standing on y = 0.

import { ModelParts, boxG, polyTubeG, torusG } from './site-layout-model-kit';
import {
  NEMA3R_PANEL,
  addNema3rEnclosure,
  nema3rConduitCenters,
  type PanelLabelSpot,
} from './site-layout-model-nema3r-enclosure';
import type { PowerKit, PowerSlot } from './site-layout-model-power-slots';

/**
 * The enclosure hangs over a sidewalk, a circulation path: an object deeper
 * than 4 in with its leading edge more than 27 in (0.686 m) above the ground
 * breaks the protrusion limit of the 2010 ADA Standards 307.2
 * (https://www.access-board.gov/ada/chapter/ch03/), so its bottom stands at
 * 0.68 m and its top at 1.65 m. Rigid conduit is strapped within 3 ft
 * (0.9 m) of the box (NEC 344.30(A)); the strap below that has no source.
 */
export const WALL_PANELBOARD = {
  bottomM: 0.68,
  topM: 0.68 + NEMA3R_PANEL.heightM,
  /** The flanges stand off the wall by their thickness. */
  backZ: NEMA3R_PANEL.flange.thickM,
  strapYs: [0.42, 0.12],
} as const;

export interface WallPanelboardModel {
  kit: PowerKit;
  /** Where the scene puts the textured warning label. */
  label: PanelLabelSpot;
}

export function createWallPanelboardKit(): WallPanelboardModel {
  const w = WALL_PANELBOARD;
  const p = new ModelParts<PowerSlot>();
  const label = addNema3rEnclosure(p, w.bottomM, w.backZ);
  for (const c of nema3rConduitCenters(w.backZ)) {
    const r = c.odM / 2;
    // Derived: the hub line stands c.z off the wall; an offset of two 45 degree
    // bends, starting 0.04 m below the hub, brings the conduit onto the wall (its
    // side 4 mm off it, the strap thickness plus 1 mm), then it runs to grade.
    const runZ = r + 0.004;
    const hubBottom = w.bottomM - 0.025;
    const bendTop = hubBottom - 0.04;
    const bendBottom = bendTop - (c.z - runZ);
    p.add(
      'conduit',
      polyTubeG(
        [
          [c.x, hubBottom, c.z],
          [c.x, bendTop, c.z],
          [c.x, bendBottom, runZ],
          [c.x, 0, runZ],
        ],
        r,
        10,
      ),
    );
    // One-hole straps screwed to the wall.
    for (const y of w.strapYs) {
      p.add('metal', torusG(r + 0.002, 0.003, 4, 10, Math.PI), {
        at: [c.x, y, runZ],
        rot: [Math.PI / 2, 0, 0],
      });
      p.add('metal', boxG(0.02, 0.025, 0.003), { at: [c.x + r + 0.012, y, 0.0015] });
    }
    // The grout patch where it enters the ground, against the wall.
    const patchD = runZ + r + 0.03;
    p.add('concrete', boxG(2 * r + 0.06, 0.02, patchD), { at: [c.x, 0.01, patchD / 2] });
  }
  return { kit: p.kit(), label };
}
