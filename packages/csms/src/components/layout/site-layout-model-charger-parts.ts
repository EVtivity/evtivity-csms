// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The parts every charger body model shares: its material slots and the
// outline helpers (arcs, rounded rectangles, door seams). Frame: the
// charger's front faces +z, x across it, standing on y = 0.

import { ModelParts, boxG, type ModelKit, type Pt } from './site-layout-model-kit';

/** The material slots of a charger body. */
export const CHARGER_SLOTS = [
  'shell',
  'trim',
  'accent',
  'glass',
  'light',
  'metal',
  'rubber',
  /** The emergency stop head (red) and its ring (yellow). */
  'stop',
  'warn',
] as const;
export type ChargerSlot = (typeof CHARGER_SLOTS)[number];
export type ChargerKit = ModelKit<ChargerSlot>;

/** Points of a quarter circle from angle a0 to a1 around (cz, cy), radius r. */
export function arc(cz: number, cy: number, r: number, a0: number, a1: number, n: number): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [cz + Math.cos(a) * r, cy + Math.sin(a) * r] as const;
  });
}

/** A rounded rectangle outline [x, y], centered, counter clockwise. */
export function roundedRect(w: number, h: number, r: number, n = 3): Pt[] {
  const x = w / 2 - r;
  const y = h / 2 - r;
  return [
    ...arc(x, -y, r, -Math.PI / 2, 0, n),
    ...arc(x, y, r, 0, Math.PI / 2, n),
    ...arc(-x, y, r, Math.PI / 2, Math.PI, n),
    ...arc(-x, -y, r, Math.PI, Math.PI * 1.5, n),
  ];
}

/** A thin groove outline (a door seam) of w by h on a face, as four strips. */
export function seam(
  parts: ModelParts<ChargerSlot>,
  w: number,
  h: number,
  at: [number, number, number],
  onSide = false,
): void {
  const t = 0.004;
  const d = 0.003;
  const strips: Array<[number, number, number, number]> = [
    [w, t, 0, h / 2],
    [w, t, 0, -h / 2],
    [t, h, w / 2, 0],
    [t, h, -w / 2, 0],
  ];
  for (const [sw, sh, ox, oy] of strips) {
    if (onSide) {
      parts.add('trim', boxG(d, sh, sw), { at: [at[0], at[1] + oy, at[2] + ox] });
    } else {
      parts.add('trim', boxG(sw, sh, d), { at: [at[0] + ox, at[1] + oy, at[2]] });
    }
  }
}
