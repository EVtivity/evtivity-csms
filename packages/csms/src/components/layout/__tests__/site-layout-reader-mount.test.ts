// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  READER_INTERFACE_ABOVE_MOUNT_M,
  READER_REACH_M,
  WALL_READER,
  readerMount,
  wallBoxOffset,
} from '../site-layout-grid';
import {
  READER_SCENE_SCALE,
  READER_SLOTS,
  type ReaderSlot,
} from '../site-layout-model-reader-parts';
import { createScreenReaderKit } from '../site-layout-model-reader-screen';
import { createContactlessReaderKit } from '../site-layout-model-reader-contactless';
import { AC_WALL_BOX, wallBoxWidth } from '../site-layout-model-wall-box';
import { WALL_BOX_BOTTOM_M } from '../site-layout-marker';
import { WALL_BOX_HOOK, wallBoxHookX } from '../site-layout-wall-box-cable';
import { DUAL_WALL_SIGN, WALL_SIGN } from '../site-layout-signs';
import { SURFACE_M } from '../site-layout-cable-surface';

/** A reader model at `at` in the charger frame, at the scene scale, as the scene places it. */
function readerBox(screen: boolean, at: { x: number; y: number; z: number }): THREE.Box3 {
  const m = new THREE.MeshBasicMaterial();
  const mats = Object.fromEntries(READER_SLOTS.map((k) => [k, m])) as unknown as Record<
    ReaderSlot,
    THREE.Material
  >;
  const g = (screen ? createScreenReaderKit() : createContactlessReaderKit()).build(mats);
  g.position.set(at.x, at.y, at.z);
  g.scale.setScalar(READER_SCENE_SCALE);
  g.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(g);
}

describe('card reader mount', () => {
  it('keeps every card interface within the 15 to 48 in reach range', () => {
    expect(READER_REACH_M.min).toBeCloseTo(0.381, 3);
    expect(READER_REACH_M.max).toBeCloseTo(1.219, 3);
    for (const kind of ['dc', 'ac'] as const) {
      for (const wall of [false, true]) {
        for (const side of [-1, 0, 1] as const) {
          const at = readerMount(kind, wall, side, 0, 0.12, 2);
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
    // On the facade above the box: the reader model stands off it on its own bracket.
    expect(readerMount('ac', true, 0, 0, 0.12)).toEqual({ x: -0, y: 1.14, z: 0.12 });
    expect(readerMount('ac', true, 1, 0, 0.12, 2)).toEqual({ x: 0.125, y: 1.14, z: 0.12 });
    // On the pedestal column front, the second EVSE's above the first's.
    expect(readerMount('ac', false, 1, 0, 0)).toEqual({ x: 0, y: 0.94, z: 0.09 });
    expect(readerMount('ac', false, -1, 0, 0).y).toBeLessThan(readerMount('ac', false, 1, 0, 0).y);
  });

  it('mounts a wall box reader above the box, clear of the coils and signs, its interface in reach', () => {
    const w = wallBoxOffset();
    const boxTop = WALL_BOX_BOTTOM_M + AC_WALL_BOX.heightM + AC_WALL_BOX.plate.marginM;
    for (const ports of [1, 2] as const) {
      for (const side of [-1, 0, 1] as const) {
        for (const index of [0, 1]) {
          for (const screen of [true, false]) {
            const label = `${String(ports)} ${String(side)} ${String(index)} ${String(screen)}`;
            const at = readerMount('ac', true, side, index, w, ports, side === 0 ? 2 : 1);
            const box = readerBox(screen, at);
            // Above the sidewalk the box hangs over (ADA heights count from the walking surface).
            const interfaceY = at.y + READER_INTERFACE_ABOVE_MOUNT_M - SURFACE_M.sidewalk;
            expect(interfaceY, label).toBeGreaterThanOrEqual(READER_REACH_M.min);
            expect(interfaceY, label).toBeLessThanOrEqual(READER_REACH_M.max);
            // Above the box, its mounting plate included.
            expect(box.min.y, label).toBeGreaterThan(boxTop + 0.01);
            // Within the 4 in protrusion limit of 2010 ADA 307.2 off the wall.
            expect(box.max.z - w, label).toBeLessThanOrEqual(4 * 0.0254);
            // Clear of the hook and its turns on each side (the turns' inner edge).
            for (const hookSide of ports === 2 ? ([-1, 1] as const) : ([1] as const)) {
              const hookX = wallBoxHookX({ ports, side: hookSide });
              const inner = Math.abs(hookX) - WALL_BOX_HOOK.bottomRadiusM;
              if (hookSide === 1) expect(box.max.x, label).toBeLessThan(inner);
              else expect(box.min.x, label).toBeGreaterThan(-inner);
            }
            // Under the signs over a two-port box, clear of the one-port box's sign beside it.
            if (ports === 2) expect(box.max.y, label).toBeLessThan(DUAL_WALL_SIGN.bottomM);
            else expect(box.min.x, label).toBeGreaterThan(WALL_SIGN.x + 0.23);
          }
        }
      }
    }
    expect(WALL_READER.mountY).toBeGreaterThan(boxTop);
    expect(wallBoxWidth(2) / 2).toBeGreaterThan(WALL_READER.pitchM);
  });
});
