// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A generic contactless card reader with no screen: a square module with a
// satin landing zone carrying the contactless indicator and four status
// LEDs along its top, set in a black mounting bezel on the shared bracket.
//
// Frame: see `site-layout-model-reader-parts.ts` (host surface z = 0, faces
// +z, origin at the mount point, the landing zone centered at y =
// READER_INTERFACE_Y_M).

import { ModelParts, frontProfileG, roundBoxG } from './site-layout-model-kit';
import {
  READER_BRACKET,
  READER_INTERFACE_Y_M,
  addContactlessMark,
  addLedRow,
  addReaderBracket,
  roundRectPts,
  type ReaderKit,
  type ReaderSlot,
} from './site-layout-model-reader-parts';

/**
 * Typical of the class, for example the ID TECH VP7200 datasheet (v01.23)
 * and the Nayax VPOS Touch module: module 68 by 68 by 11.5 mm, no display.
 * Derived: the bezel is the module plus 9 mm a side (an M3 fastener's 6 mm
 * head plus 3 mm edge), 86 mm; the enclosure behind it is the module depth
 * plus 6.5 mm for the cable connector, 18 mm; the indicator a third of the
 * module, 22 mm (EMVCo asks at least 10 mm).
 */
export const CONTACTLESS_READER = {
  module: { sizeM: 0.068, depthM: 0.0115, cornerM: 0.006 },
  bezel: { sizeM: 0.086, depthM: 0.006, cornerM: 0.01 },
  /** The enclosure behind the bezel. */
  enclosure: { sizeM: 0.08, depthM: 0.018 },
  markM: 0.022,
} as const;

/** The contactless reader on its bracket. */
export function createContactlessReaderKit(): ReaderKit {
  const v = CONTACTLESS_READER;
  const p = new ModelParts<ReaderSlot>();
  const y = READER_INTERFACE_Y_M;
  const back = READER_BRACKET.standoffM;
  addReaderBracket(p, y);
  p.add('body', roundBoxG(v.enclosure.sizeM, v.enclosure.sizeM, v.enclosure.depthM, 0.006), {
    at: [0, y, back + v.enclosure.depthM / 2],
  });
  // The bezel frame around the module opening.
  const bz = back + v.enclosure.depthM;
  const m = v.module.sizeM / 2;
  const opening = [
    [-m, -m],
    [-m, m],
    [m, m],
    [m, -m],
  ] as const;
  p.add(
    'bezel',
    frontProfileG(
      roundRectPts(v.bezel.sizeM, v.bezel.sizeM, v.bezel.cornerM),
      v.bezel.depthM,
      0.001,
      [opening],
    ),
    { at: [0, y, bz + v.bezel.depthM / 2] },
  );
  // The module standing 2 mm proud of the bezel: the landing zone face.
  const face = bz + v.bezel.depthM + 0.002;
  p.add('zone', roundBoxG(v.module.sizeM - 0.001, v.module.sizeM - 0.001, v.module.depthM, 0.003), {
    at: [0, y, face - v.module.depthM / 2],
  });
  addContactlessMark(p, [0.002, y - 0.004, face + 0.0003], v.markM, 0.001);
  addLedRow(p, [0, y + m - 0.008, face + 0.0003], 4, 0.009, 0.002);
  return p.kit();
}
