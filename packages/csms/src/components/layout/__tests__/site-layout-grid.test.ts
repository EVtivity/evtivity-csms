// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { bayToPosition, positionToBay } from '@evtivity/lib/site-layout';
import {
  BAY_D,
  BAY_W,
  MAX_DISTANCE_MIN,
  bayToWorld,
  clampToArea,
  editArea,
  fitFrame,
  fogRange,
  groundBays,
  maxZoomDistance,
  worldToBay,
} from '../site-layout-grid';

const area = { cols: 64, rows: 48 };

describe('site layout 3D grid', () => {
  it('maps every bay to the world and back, and to the same stored 2D position', () => {
    for (const bay of [
      { col: 0, row: 0 },
      { col: 4, row: 1 },
      { col: 37, row: 22 },
      { col: 63, row: 47 },
    ]) {
      const p = bayToWorld(bay);
      expect(worldToBay(p.x, p.z, area)).toEqual(bay);
      // Anywhere inside the bay picks it too.
      expect(worldToBay(p.x + BAY_W * 0.45, p.z + BAY_D * 0.45, area)).toEqual(bay);
      expect(worldToBay(p.x - BAY_W * 0.45, p.z - BAY_D * 0.45, area)).toEqual(bay);
      expect(positionToBay(bayToPosition(bay))).toEqual(bay);
    }
  });

  it('anchors the world at bay (0, 0), so a station never moves when the lot grows', () => {
    expect(bayToWorld({ col: 2, row: 1 })).toEqual({ x: BAY_W * 2.5, z: BAY_D + 0.9 });
  });

  it('keeps a pick or a drag inside the edit area, never on a negative bay', () => {
    expect(worldToBay(-50, -50, area)).toEqual({ col: 0, row: 0 });
    expect(worldToBay(1e6, 1e6, area)).toEqual({ col: 63, row: 47 });
    expect(clampToArea(-50, -50, area)).toEqual(bayToWorld({ col: 0, row: 0 }));
    expect(clampToArea(1e6, 1e6, area)).toEqual(bayToWorld({ col: 63, row: 47 }));
  });

  it('makes the edit area large and keeps free bays past the farthest station', () => {
    expect(editArea([])).toEqual({ cols: 64, rows: 48 });
    expect(editArea([{ col: 3, row: 1 }])).toEqual({ cols: 64, rows: 48 });
    expect(editArea([{ col: 100, row: 60 }])).toEqual({ cols: 133, rows: 93 });
  });

  it('frames the stations, not the ground, and allows a far zoom out', () => {
    const fit = fitFrame({ cols: 5, rows: 2 }, 2);
    expect(fit.target).toEqual({ x: (5 * BAY_W) / 2, y: 0.5, z: BAY_D + 0.6 });
    expect(fit.distance).toBeLessThan(40);
    expect(maxZoomDistance({ cols: 5, rows: 2 })).toBe(MAX_DISTANCE_MIN);
    // A large site gets a larger limit than its own framing.
    const big = { cols: 120, rows: 40 };
    expect(maxZoomDistance(big)).toBeGreaterThan(fitFrame(big, 0.5).distance * 2);
  });

  it('paints the ground past the fog in every direction at the zoom-out limit', () => {
    for (const frame of [
      { cols: 5, rows: 2 },
      { cols: 120, rows: 40 },
    ]) {
      const g = groundBays(frame);
      const fogFar = fogRange(maxZoomDistance(frame)).far;
      expect(-g.minCol * BAY_W).toBeGreaterThan(fogFar);
      expect(-g.minRow * BAY_D).toBeGreaterThan(fogFar);
      expect((g.maxCol - frame.cols) * BAY_W).toBeGreaterThan(fogFar);
      expect((g.maxRow - frame.rows) * BAY_D).toBeGreaterThan(fogFar);
      expect(Number.isInteger(g.minCol) && Number.isInteger(g.maxRow)).toBe(true);
    }
  });

  it('fades the ground with the camera distance, clear around the target', () => {
    const near = fogRange(20);
    expect(near.near).toBeGreaterThan(20);
    expect(near.far).toBeGreaterThan(near.near);
    expect(fogRange(200).far).toBe(near.far * 10);
  });
});
