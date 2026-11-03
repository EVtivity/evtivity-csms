// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The high voltage warning label of the site power equipment (pad-mount
// transformer, switchboard, battery), built as geometry so it reads without a
// texture: a yellow plate with a black signal word band, the ISO 7010 W012
// electricity triangle (black border, yellow field) and the black arrow bolt.
// ANSI Z535.4 safety signs use this layout (signal word panel over the
// symbol); NEMA 260 is the pad-mounted equipment warning label.
//
// Frame: the label faces +z, centered on the origin in x and y, its back on
// z = 0, `widthM` wide, 1.2 times as tall.

import { ModelParts, boxG, frontProfileG, type Placement, type Pt } from './site-layout-model-kit';

/** The label proportions (ANSI Z535.4 landscape label, signal word band on top). */
export const WARNING_SIGN = {
  heightRatio: 1.2,
  /** The signal word band, a share of the height. */
  bandRatio: 0.22,
  plateThickM: 0.003,
  inkM: 0.0012,
} as const;

/**
 * Adds a warning label to `p`: the plate in slot `sign` (safety yellow), the
 * band, triangle border and bolt in slot `ink` (black), at placement `at`.
 */
export function addWarningSign<S extends string>(
  p: ModelParts<S>,
  sign: S,
  ink: S,
  widthM: number,
  at: Placement = {},
): void {
  const s = WARNING_SIGN;
  const w = widthM;
  const h = w * s.heightRatio;
  const local = new ModelParts<S>();
  local.add(sign, boxG(w, h, s.plateThickM), { at: [0, 0, s.plateThickM / 2] });
  const front = s.plateThickM + s.inkM / 2;
  const band = h * s.bandRatio;
  local.add(ink, boxG(w * 0.92, band * 0.8, s.inkM), { at: [0, h / 2 - band / 2, front] });
  // The triangle under the band: a border ring with the yellow field showing.
  const field = h - band;
  const cy = -h / 2 + field / 2;
  const side = Math.min(w * 0.8, field * 0.95);
  const th = (side * Math.sqrt(3)) / 2;
  const tri = (sz: number): Pt[] => {
    const t = (sz * Math.sqrt(3)) / 2;
    return [
      [-sz / 2, cy - th / 2 + (th - t) / 3],
      [sz / 2, cy - th / 2 + (th - t) / 3],
      [0, cy - th / 2 + (th - t) / 3 + t],
    ];
  };
  const inner = tri(side * 0.74).reverse();
  local.add(ink, frontProfileG(tri(side), s.inkM, 0, [inner]), { at: [0, 0, front] });
  // The arrow bolt in the field (ISO 7010 W012).
  const k = side * 0.32;
  const by = cy - th * 0.08;
  const bolt: Pt[] = [
    [0.1 * k, by + 0.62 * k],
    [-0.28 * k, by - 0.02 * k],
    [-0.02 * k, by - 0.02 * k],
    [-0.16 * k, by - 0.6 * k],
    [0.3 * k, by + 0.12 * k],
    [0.04 * k, by + 0.12 * k],
    [0.24 * k, by + 0.62 * k],
  ];
  local.add(ink, frontProfileG(bolt, s.inkM), { at: [0, 0, front] });
  p.addAll(local, at);
}
