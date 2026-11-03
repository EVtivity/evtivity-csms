// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The AC panelboard on its two-post strut rack beside an AC group: a NEMA 3R
// enclosure bolted to two crossbars on two posts, each post on a base plate
// anchored to a concrete pad, the conduits running from the enclosure bottom
// down into the pad.
//
// Frame: origin at the pad center on the ground, the door faces +z, x across
// it, standing on y = 0.

import { ModelParts, boxG, cylG, roundBoxG } from './site-layout-model-kit';
import {
  NEMA3R_PANEL,
  addNema3rEnclosure,
  nema3rConduitCenters,
  type PanelLabelSpot,
} from './site-layout-model-nema3r-enclosure';
import type { PowerKit, PowerSlot } from './site-layout-model-power-slots';
import { STRUT_CHANNEL, strutChannelG } from './site-layout-model-strut';

/**
 * The rack: the enclosure top 1.87 m above the ground, so the highest breaker
 * handle stays under the 6 ft 7 in (2.0 m) of NEC 240.24(A) and 404.8(A);
 * posts of Unistrut P1000 channel (STRUT_CHANNEL) on square base plates
 * anchored to the pad. The pad (1.2 by 0.6 by 0.12 m), the post spacing and
 * the base plate size have no source.
 */
export const RACK_PANELBOARD = {
  padWM: 1.2,
  padDM: 0.6,
  padHM: 0.12,
  topM: 1.87,
  postXM: 0.35,
  postZM: -0.12,
  /** The posts stand this far above the enclosure top. */
  postOverM: 0.1,
  basePlate: { sizeM: 0.15, thickM: 0.008 },
  crossbarM: 0.8,
} as const;

export interface RackPanelboardModel {
  kit: PowerKit;
  /** Where the scene puts the textured warning label. */
  label: PanelLabelSpot;
}

/** The enclosure's back, in front of the crossbars on the posts' front faces. */
export function rackEnclosureBackZ(): number {
  return RACK_PANELBOARD.postZM + STRUT_CHANNEL.sizeM * 1.5;
}

export function createRackPanelboardKit(): RackPanelboardModel {
  const r = RACK_PANELBOARD;
  const s = STRUT_CHANNEL.sizeM;
  const p = new ModelParts<PowerSlot>();
  // The pad with chamfered top edges.
  p.add('concrete', roundBoxG(r.padWM, r.padHM, r.padDM, 0.012), { at: [0, r.padHM / 2, 0] });
  const postTop = r.topM + r.postOverM;
  const postLen = postTop - r.padHM - r.basePlate.thickM;
  for (const side of [-1, 1]) {
    const x = side * r.postXM;
    // The base plate, its four anchor nuts and two gussets.
    p.add('metal', boxG(r.basePlate.sizeM, r.basePlate.thickM, r.basePlate.sizeM), {
      at: [x, r.padHM + r.basePlate.thickM / 2, r.postZM],
    });
    const a = r.basePlate.sizeM / 2 - 0.022;
    for (const [dx, dz] of [
      [-a, -a],
      [a, -a],
      [-a, a],
      [a, a],
    ] as const) {
      p.add('metal', cylG(0.011, 0.011, 0.014, 6), {
        at: [x + dx, r.padHM + r.basePlate.thickM + 0.007, r.postZM + dz],
      });
    }
    for (const gs of [-1, 1]) {
      p.add('metal', boxG(0.005, 0.07, 0.045), {
        at: [x + gs * (s / 2 + 0.0025), r.padHM + r.basePlate.thickM + 0.035, r.postZM],
      });
    }
    // The post, slot to the front, and its end cap.
    p.add('metal', strutChannelG(postLen, 'y'), {
      at: [x, r.padHM + r.basePlate.thickM + postLen / 2, r.postZM],
    });
    p.add('trim', boxG(s + 0.003, 0.006, s + 0.003), { at: [x, postTop + 0.003, r.postZM] });
  }
  // The crossbars on the posts' front faces, slot to the front, with the bolt heads at each post.
  const bottom = r.topM - NEMA3R_PANEL.heightM;
  const barZ = r.postZM + s;
  for (const y of [r.topM - 0.15, bottom + 0.15]) {
    p.add('metal', strutChannelG(r.crossbarM, 'x'), { at: [0, y, barZ] });
    for (const side of [-1, 1]) {
      p.add('metal', cylG(0.009, 0.009, 0.008, 6), {
        at: [side * r.postXM, y, barZ + s / 2 + 0.004],
        rot: [Math.PI / 2, 0, 0],
      });
    }
  }
  const backZ = rackEnclosureBackZ();
  const label = addNema3rEnclosure(p, bottom, backZ);
  // Rigid conduit from each hub straight down into the pad, a coupling at the pad.
  for (const c of nema3rConduitCenters(backZ)) {
    const len = bottom - 0.025 - r.padHM;
    p.add('conduit', cylG(c.odM / 2, c.odM / 2, len, 12), {
      at: [c.x, r.padHM + len / 2, c.z],
    });
    p.add('conduit', cylG(c.odM / 2 + 0.006, c.odM / 2 + 0.006, 0.04, 12), {
      at: [c.x, r.padHM + 0.02, c.z],
    });
  }
  return { kit: p.kit(), label };
}
