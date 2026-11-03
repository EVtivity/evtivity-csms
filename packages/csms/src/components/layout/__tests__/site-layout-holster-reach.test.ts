// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { READER_REACH_M, dispenserHolsters } from '../site-layout-grid';
import { HOLSTER_PITCH_M, holsterSlots } from '../site-layout-connectors';
import { AC_PEDESTAL } from '../site-layout-model-ac-pedestal';
import { DC_DISPENSER, DC_HOLSTER } from '../site-layout-model-dc-dispenser';
import { wallBoxDock } from '../site-layout-model-wall-box';
import { WALL_BOX_BOTTOM_M } from '../site-layout-marker';

// Every holster of every charger model within the 15 to 48 in (0.38 to 1.22 m)
// unobstructed reach range of the 2010 ADA Standards 308.2 and 308.3, and two
// holsters on one face at the same height (within 0.1 m), side by side.
const REACH = READER_REACH_M;

function heightsByFace(slots: ReadonlyArray<{ side: number; y: number }>): Map<number, number[]> {
  const faces = new Map<number, number[]>();
  for (const s of slots) faces.set(s.side, [...(faces.get(s.side) ?? []), s.y]);
  return faces;
}

describe('holster reach and height', () => {
  it('keeps every DC holster within reach, side by side at one height on each wall', () => {
    for (const evse of [[1], [2], [3], [4], [1, 1], [2, 2]]) {
      const slots = holsterSlots(evse).map((h) => ({
        side: h.side,
        y: DC_HOLSTER.y,
        z: DC_HOLSTER.z - h.backM,
      }));
      for (const s of slots) {
        expect(s.y).toBeGreaterThanOrEqual(REACH.min);
        expect(s.y).toBeLessThanOrEqual(REACH.max);
        // On the side wall, between its front and back.
        expect(s.z).toBeLessThanOrEqual(DC_DISPENSER.frontZ);
        expect(s.z).toBeGreaterThanOrEqual(DC_DISPENSER.frontZ - DC_DISPENSER.depthM);
      }
      for (const ys of heightsByFace(slots).values()) {
        expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(0.1);
      }
    }
  });

  it('spaces two holsters on one wall by the handle width and a hand', () => {
    expect(HOLSTER_PITCH_M).toBeGreaterThanOrEqual(0.116 + 0.1);
    for (const n of [3, 4]) {
      const backs = dispenserHolsters(n).map((h) => h.backM);
      expect(Math.max(...backs)).toBeCloseTo(HOLSTER_PITCH_M, 6);
    }
  });

  it('keeps the AC pedestal and wall box holsters within reach', () => {
    for (const y of [AC_PEDESTAL.holsterY, wallBoxDock(WALL_BOX_BOTTOM_M).y]) {
      expect(y).toBeGreaterThanOrEqual(REACH.min);
      expect(y).toBeLessThanOrEqual(REACH.max);
    }
  });
});
