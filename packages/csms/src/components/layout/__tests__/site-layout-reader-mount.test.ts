// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { READER_INTERFACE_ABOVE_MOUNT_M, READER_REACH_M, readerMount } from '../site-layout-grid';

describe('card reader mount', () => {
  it('keeps every card interface within the 15 to 48 in reach range', () => {
    expect(READER_REACH_M.min).toBeCloseTo(0.381, 3);
    expect(READER_REACH_M.max).toBeCloseTo(1.219, 3);
    for (const kind of ['dc', 'ac'] as const) {
      for (const wall of [false, true]) {
        for (const side of [-1, 0, 1] as const) {
          const at = readerMount(kind, wall, side, 0, 0.12);
          const interfaceY = at.y + READER_INTERFACE_ABOVE_MOUNT_M;
          expect(interfaceY, `${kind} ${String(wall)} ${String(side)}`).toBeGreaterThanOrEqual(
            READER_REACH_M.min,
          );
          expect(interfaceY).toBeLessThanOrEqual(READER_REACH_M.max);
        }
      }
    }
  });

  it('mounts on the front of a DC dispenser under its connector side, and beside an AC wall box', () => {
    expect(readerMount('dc', false, -1, 0, 0)).toEqual({ x: -0.17, y: 0.92, z: 0.35 });
    expect(readerMount('dc', false, 0, 0, 0)).toEqual({ x: -0, y: 0.72, z: 0.35 });
    // A second station-wide reader stands beside the first.
    expect(readerMount('dc', false, 0, 1, 0).x).toBeCloseTo(-0.16);
    // On the facade itself: the reader model stands off it on its own bracket.
    expect(readerMount('ac', true, 0, 0, 0.12)).toEqual({ x: -0.34, y: 1.12, z: 0.12 });
    // On the pedestal column front, the second EVSE's above the first's.
    expect(readerMount('ac', false, 1, 0, 0)).toEqual({ x: 0, y: 0.94, z: 0.09 });
    expect(readerMount('ac', false, -1, 0, 0).y).toBeLessThan(readerMount('ac', false, 1, 0, 0).y);
  });
});
