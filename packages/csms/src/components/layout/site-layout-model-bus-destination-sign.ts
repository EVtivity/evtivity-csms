// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The destination signs of the 3D layout city bus: the front sign above the
// windscreen, the side sign in the first window behind the front door and
// the route number in the rear window. Each is a dark housing with a lit
// LED panel set in it and a top sun visor lip on the front one. Built in the
// bus frame (nose at z = 0, body along +z, doors on the right at +x).

import type { CarMaterials } from './site-layout-car-geometry';
import { ModelParts, boxG, roundBoxG, type ModelKit } from './site-layout-model-kit';

type Slot = keyof CarMaterials;

/**
 * Sizes after the common LED destination sign (Hanover and Mobitec front
 * signs for 2.55 m buses: about 1.9 m by 0.25 m of display; side signs about
 * 1.0 by 0.2 m; rear route numbers about 0.4 by 0.2 m). Derived: each housing
 * is the display plus a 40 mm border; the panel sits 8 mm into its housing.
 */
export const BUS_DESTINATION_SIGN = {
  front: { widthM: 1.9, heightM: 0.25, y: 2.9 },
  /** Between the first two window pillars behind the front door. */
  side: { lengthM: 1.0, heightM: 0.2, y: 2.35, z: 2.3 },
  rear: { widthM: 0.4, heightM: 0.2, y: 2.6 },
  borderM: 0.04,
  depthM: 0.05,
} as const;

export interface BusDestinationSignInput {
  length: number;
  width: number;
  /** Where the raked front face is at the front sign's height. */
  frontFaceZ: number;
}

export function createBusDestinationSignKit(input: BusDestinationSignInput): ModelKit<Slot> {
  const s = BUS_DESTINATION_SIGN;
  const b = s.borderM;
  const parts = new ModelParts<Slot>();
  // Front: the housing proud of the front face, the panel, a visor lip above.
  const f = s.front;
  parts.add('trim', roundBoxG(f.widthM + 2 * b, f.heightM + 2 * b, s.depthM, 0.02), {
    at: [0, f.y, input.frontFaceZ - s.depthM / 2 + 0.01],
  });
  parts.add('headlight', boxG(f.widthM, f.heightM, 0.01), {
    at: [0, f.y, input.frontFaceZ - s.depthM + 0.018],
  });
  parts.add('trim', boxG(f.widthM + 2 * b, 0.02, 0.08), {
    at: [0, f.y + f.heightM / 2 + b, input.frontFaceZ - 0.04],
  });
  // Side, on the door side: flat against the window band.
  const sd = s.side;
  const x = input.width / 2 + 0.02;
  parts.add('trim', boxG(0.02, sd.heightM + 2 * b, sd.lengthM + 2 * b), { at: [x, sd.y, sd.z] });
  parts.add('headlight', boxG(0.01, sd.heightM, sd.lengthM), { at: [x + 0.012, sd.y, sd.z] });
  // Rear route number, inside the rear window.
  const r = s.rear;
  parts.add('trim', boxG(r.widthM + 2 * b, r.heightM + 2 * b, 0.02), {
    at: [0, r.y, input.length + 0.012],
  });
  parts.add('headlight', boxG(r.widthM, r.heightM, 0.01), { at: [0, r.y, input.length + 0.024] });
  return parts.kit();
}
