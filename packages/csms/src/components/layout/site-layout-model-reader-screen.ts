// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A generic unattended card reader with a screen: a landscape housing with a black
// bezel around a lit 4.3 in color touchscreen, the contactless landing zone
// with its indicator and four status LEDs beside the screen, and the chip
// card slot under it, on the shared bracket.
//
// Frame: see `site-layout-model-reader-parts.ts` (host surface z = 0, faces
// +z, origin at the mount point, the screen centered at y = READER_INTERFACE_Y_M).

import { ModelParts, boxG, frontProfileG, roundBoxG } from './site-layout-model-kit';
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
 * Typical of the class, for example the ID TECH VP6825 datasheet (June
 * 2025) and the Nayax Onyx and UX430 readers: 132 by 88 mm front, 4.3 in color
 * touch display (16:9 active area 95 by 54 mm). Derived, not in the sheet:
 * depth 40 mm = bezel 4 + display stack 6 + card path 4 + contact head and
 * board 16 + back wall and connector 10; the contactless zone fills the
 * 132 - 9 - 95 = 28 mm strip right of the screen (center 14 mm in); the chip
 * slot is an ID-1 card's short edge (53.98 mm, ISO/IEC 7810) plus 3 mm each
 * side, 60 mm, in a lip on the bottom edge.
 */
export const SCREEN_READER = {
  widthM: 0.132,
  heightM: 0.088,
  depthM: 0.04,
  cornerM: 0.008,
  bezelM: 0.004,
  screen: { widthM: 0.095, heightM: 0.054, fromLeftM: 0.009 },
  /** The contactless zone: its center from the right edge, and the indicator size. */
  zone: { fromRightM: 0.014, markM: 0.012 },
  /** The chip slot in the bottom edge. */
  chipSlot: { widthM: 0.06, gapM: 0.0012, lipM: 0.008 },
} as const;

/** The center of the screen window on the bezel face, in the reader's own frame (unscaled). */
export function screenReaderScreenCenter(): { x: number; y: number; z: number } {
  const v = SCREEN_READER;
  return {
    x: -v.widthM / 2 + v.screen.fromLeftM + v.screen.widthM / 2,
    y: READER_INTERFACE_Y_M,
    z: READER_BRACKET.standoffM + v.depthM,
  };
}

/** The screen reader on its bracket. */
export function createScreenReaderKit(): ReaderKit {
  const v = SCREEN_READER;
  const p = new ModelParts<ReaderSlot>();
  const y = READER_INTERFACE_Y_M;
  const back = READER_BRACKET.standoffM;
  addReaderBracket(p, y);
  // The housing, its front edge rounded.
  const housingD = v.depthM - v.bezelM;
  p.add('body', roundBoxG(v.widthM, v.heightM, housingD, v.cornerM * 0.6), {
    at: [0, y, back + housingD / 2],
  });
  // The bezel with the screen window cut out.
  const sx0 = -v.widthM / 2 + v.screen.fromLeftM;
  const sx = sx0 + v.screen.widthM / 2;
  const hw = v.screen.widthM / 2;
  const hh = v.screen.heightM / 2;
  const window = [
    [sx - hw, -hh],
    [sx - hw, hh],
    [sx + hw, hh],
    [sx + hw, -hh],
  ] as const;
  const front = back + v.depthM;
  p.add(
    'bezel',
    frontProfileG(roundRectPts(v.widthM - 0.002, v.heightM - 0.002, v.cornerM), v.bezelM, 0.0008, [
      window,
    ]),
    { at: [0, y, front - v.bezelM / 2] },
  );
  // The lit screen, set just behind the bezel face, its cover glass flush.
  p.add('screen', boxG(v.screen.widthM, v.screen.heightM, 0.0015), {
    at: [sx, y, front - v.bezelM + 0.0012],
  });
  // The contactless zone right of the screen, its indicator and the LEDs above it.
  const zx = v.widthM / 2 - v.zone.fromRightM;
  addContactlessMark(p, [zx, y - 0.006, front + 0.0003], v.zone.markM);
  addLedRow(p, [zx, y + 0.026, front + 0.0003], 4, 0.0055);
  // The chip slot: a lip under the bottom edge, the card slit along its front
  // face and the throat going up into the housing from its underside.
  const cs = v.chipSlot;
  const bottom = y - v.heightM / 2;
  const lipD = 0.02;
  const lipZ = front - lipD / 2 - 0.002;
  p.add('body', roundBoxG(cs.widthM + 0.012, cs.lipM, lipD, 0.002), {
    at: [0, bottom - cs.lipM / 2 + 0.001, lipZ],
  });
  p.add('slot', boxG(cs.widthM, cs.gapM * 2, 0.001), {
    at: [0, bottom - cs.lipM / 2 + 0.001, lipZ + lipD / 2 + 0.0002],
  });
  p.add('slot', boxG(cs.widthM, 0.0008, lipD - 0.006), {
    at: [0, bottom - cs.lipM + 0.0007, lipZ],
  });
  return p.kit();
}
