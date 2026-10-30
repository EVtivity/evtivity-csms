// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { DEFAULT_LAYOUT_GRID, bayToPosition, positionToBay } from '@evtivity/lib/site-layout';
import {
  BAY_STATION_Z,
  CAMERA_FOV,
  MAX_DISTANCE_MIN,
  MAX_POLAR_ANGLE,
  MIN_DISTANCE,
  STATION_BACK_OFFSET,
  bayToWorld,
  bayTurn,
  chargersAtBack,
  clampTarget,
  clampToLot,
  fitFrame,
  fogRange,
  frontCamera,
  groundBox,
  logoFit,
  lotOf,
  maxZoomDistance,
  panBox,
  rotateBox,
  sceneBox,
  stationBackPoint,
  stationProp,
  worldToBay,
} from '../site-layout-grid';

const lot = lotOf(DEFAULT_LAYOUT_GRID);

describe('site layout 3D lot', () => {
  it('takes the default lot of 2 rows of 10 spots with a lane between the rows', () => {
    expect(lot).toMatchObject({ cols: 10, rows: 2, spotW: 3.2, spotD: 5.6, lane: 6, pitch: 11.6 });
    expect(lot.width).toBeCloseTo(32);
    expect(lot.depth).toBeCloseTo(17.2);
    expect(lot.facing).toBe(-0);
  });

  it('maps every spot to the lot and back, and to the same stored 2D position', () => {
    for (const bay of [
      { col: 0, row: 0 },
      { col: 4, row: 1 },
      { col: 9, row: 1 },
    ]) {
      const p = bayToWorld(bay, lot);
      expect(worldToBay(p.x, p.z, lot)).toEqual(bay);
      // Anywhere in the spot, from its front edge to its back edge.
      const z0 = lot.pitch * bay.row;
      expect(worldToBay(p.x + lot.spotW * 0.45, z0 + 0.05, lot)).toEqual(bay);
      expect(worldToBay(p.x - lot.spotW * 0.45, z0 + lot.spotD - 0.05, lot)).toEqual(bay);
      expect(positionToBay(bayToPosition(bay))).toEqual(bay);
    }
  });

  it('spaces the rows by the spot depth plus the lane', () => {
    const wide = lotOf({ ...DEFAULT_LAYOUT_GRID, spotWidthM: 4, spotDepthM: 6, laneWidthM: 8 });
    expect(bayToWorld({ col: 2, row: 0 }, wide)).toEqual({ x: 10, z: BAY_STATION_Z });
    // Row 1 is turned: its chargers stand at its back edge, 14 + 6 m.
    expect(bayToWorld({ col: 2, row: 1 }, wide)).toEqual({ x: 10, z: 20 - BAY_STATION_Z });
  });

  it('puts the chargers of both rows of the default lot at the outer edges, bays opening onto the lane', () => {
    const row0 = bayToWorld({ col: 3, row: 0 }, lot);
    const row1 = bayToWorld({ col: 3, row: 1 }, lot);
    // Row 0 at the front edge (z 0), row 1 at the back edge (the lot depth).
    expect(row0.z).toBeCloseTo(BAY_STATION_Z);
    expect(row1.z).toBeCloseTo(lot.depth - BAY_STATION_Z);
    // Row 0 faces +z, row 1 is turned to face -z: both face the lane between them.
    expect(bayTurn({ col: 3, row: 0 }, lot)).toBe(0);
    expect(bayTurn({ col: 3, row: 1 }, lot)).toBeCloseTo(Math.PI);
    const laneMid = lot.spotD + lot.lane / 2;
    expect(Math.sign(laneMid - row0.z)).toBe(Math.cos(bayTurn({ col: 3, row: 0 }, lot)));
    expect(Math.sign(laneMid - row1.z)).toBeCloseTo(Math.cos(bayTurn({ col: 3, row: 1 }, lot)));
  });

  it('pairs rows around the lanes in a lot of more than two rows', () => {
    expect([0].map((r) => chargersAtBack(r, 1))).toEqual([false]);
    expect([0, 1].map((r) => chargersAtBack(r, 2))).toEqual([false, true]);
    // An odd last row opens onto the lane before it: chargers at the back edge of the lot.
    expect([0, 1, 2].map((r) => chargersAtBack(r, 3))).toEqual([false, true, true]);
    expect([0, 1, 2, 3].map((r) => chargersAtBack(r, 4))).toEqual([false, true, false, true]);
    expect([0, 1, 2, 3, 4].map((r) => chargersAtBack(r, 5))).toEqual([
      false,
      true,
      false,
      true,
      true,
    ]);
    // A station on the grass below the lot keeps the unturned model.
    expect(chargersAtBack(3, 3)).toBe(false);
    const three = lotOf({ ...DEFAULT_LAYOUT_GRID, rows: 3 });
    expect(bayToWorld({ col: 0, row: 0 }, three).z).toBeCloseTo(BAY_STATION_Z);
    expect(bayToWorld({ col: 0, row: 2 }, three).z).toBeCloseTo(three.depth - BAY_STATION_Z);
    // Every station maps back to its own spot, turned or not.
    for (const row of [0, 1, 2]) {
      const p = bayToWorld({ col: 5, row }, three);
      expect(worldToBay(p.x, p.z, three)).toEqual({ col: 5, row });
    }
  });

  it('keeps the row arrangement under every facing (the facing turns the whole lot)', () => {
    for (const facingDeg of [0, 90, 180, 270] as const) {
      const turned = lotOf({ ...DEFAULT_LAYOUT_GRID, facingDeg });
      expect(bayToWorld({ col: 1, row: 1 }, turned)).toEqual(bayToWorld({ col: 1, row: 1 }, lot));
      expect(bayTurn({ col: 1, row: 1 }, turned)).toBeCloseTo(Math.PI);
    }
  });

  it('ends a load management link behind the charger, on the curb side of its row', () => {
    const front = stationBackPoint({ col: 2, row: 0 }, lot);
    const back = stationBackPoint({ col: 2, row: 1 }, lot);
    expect(front.z).toBeCloseTo(BAY_STATION_Z - STATION_BACK_OFFSET);
    expect(back.z).toBeCloseTo(lot.depth - BAY_STATION_Z + STATION_BACK_OFFSET);
    expect(back.x).toBeCloseTo(bayToWorld({ col: 2, row: 1 }, lot).x);
  });

  it('keeps a pick or a drag inside the lot', () => {
    expect(worldToBay(-50, -50, lot)).toEqual({ col: 0, row: 0 });
    expect(worldToBay(1e6, 1e6, lot)).toEqual({ col: 9, row: 1 });
    expect(clampToLot(-50, -50, lot)).toEqual(bayToWorld({ col: 0, row: 0 }, lot));
    expect(clampToLot(1e6, 1e6, lot)).toEqual(bayToWorld({ col: 9, row: 1 }, lot));
  });

  it('turns the lot by the facing (clockwise from above)', () => {
    expect(lotOf({ ...DEFAULT_LAYOUT_GRID, facingDeg: 90 }).facing).toBeCloseTo(-Math.PI / 2);
    const box = { minX: 0, maxX: 10, minZ: 0, maxZ: 4 };
    const turned = rotateBox(box, Math.PI / 2);
    expect(turned.minX).toBeCloseTo(0);
    expect(turned.maxX).toBeCloseTo(4);
    expect(turned.minZ).toBeCloseTo(-10);
    expect(turned.maxZ).toBeCloseTo(0);
  });

  it('frames the lot and everything outside it', () => {
    expect(sceneBox(lot, [])).toEqual({ minX: 0, maxX: lot.width, minZ: 0, maxZ: lot.depth });
    const withTransformer = sceneBox(lot, [{ x: 40, z: 3 }]);
    expect(withTransformer.maxX).toBe(42);
    const fit = fitFrame(withTransformer, 2);
    expect(fit.target.x).toBe(21);
    expect(fit.distance).toBeLessThan(80);
    expect(maxZoomDistance(withTransformer)).toBeGreaterThanOrEqual(MAX_DISTANCE_MIN);
  });

  it('paints the grass under the whole view at every zoom, wherever the camera looks', () => {
    const frame = sceneBox(lot, []);
    const pan = panBox(frame);
    const g = groundBox(frame, pan);
    for (const distance of [MIN_DISTANCE, 60, maxZoomDistance(frame)]) {
      const reach = distance + fogRange(distance).far;
      for (const target of [clampTarget(-1e6, -1e6, pan), clampTarget(1e6, 1e6, pan)]) {
        expect(target.x - reach).toBeGreaterThan(g.minX);
        expect(target.x + reach).toBeLessThan(g.maxX);
        expect(target.z - reach).toBeGreaterThan(g.minZ);
        expect(target.z + reach).toBeLessThan(g.maxZ);
      }
    }
  });

  it('fades the ground with the camera distance, clear around the target', () => {
    const near = fogRange(20);
    expect(near.near).toBeGreaterThan(20);
    expect(fogRange(200).far).toBe(near.far * 10);
  });

  it('keeps the top edge of the view below the horizon at the lowest orbit, so no sky shows', () => {
    const topRay = MAX_POLAR_ANGLE + (CAMERA_FOV / 2) * (Math.PI / 180);
    expect(topRay).toBeLessThan(Math.PI / 2);
  });

  it('puts a car in a charging spot, a Reserved sign in a reserved one and a cone in maintenance', () => {
    expect(stationProp('charging')).toBe('car');
    expect(stationProp('reserved')).toBe('reservedSign');
    expect(stationProp('maintenance')).toBe('cone');
    for (const state of ['faulted', 'unavailable', 'offline', 'available', 'online'] as const) {
      expect(stationProp(state)).toBeNull();
    }
  });

  it('fits a logo inside the back panel with padding, never stretched', () => {
    const panel = { width: 0.62, height: 0.62 };
    const wide = logoFit(panel, { width: 400, height: 100 }, 0.04);
    expect(wide.width).toBeCloseTo(0.54);
    expect(wide.height).toBeCloseTo(0.135);
    const tall = logoFit(panel, { width: 100, height: 300 }, 0.04);
    expect(tall.height).toBeCloseTo(0.54);
    expect(tall.width / tall.height).toBeCloseTo(1 / 3);
    expect(logoFit(panel, { width: 0, height: 0 }, 0.04)).toEqual({ width: 0, height: 0 });
  });

  it('puts the front camera in front of the chargers, turned with the facing, above the lowest orbit', () => {
    const box = { minX: 0, maxX: 30, minZ: 0, maxZ: 20 };
    for (const facing of [0, Math.PI / 2, Math.PI, -Math.PI / 4]) {
      const { target, position } = frontCamera(box, facing, 16 / 9);
      // The camera stands along the lot's own +z (the chargers' front), turned by the facing.
      const dx = position.x - target.x;
      const dz = position.z - target.z;
      const along = dx * Math.sin(facing) + dz * Math.cos(facing);
      const across = dx * Math.cos(facing) - dz * Math.sin(facing);
      expect(along).toBeGreaterThan(0);
      expect(Math.abs(across)).toBeLessThan(along * 0.1);
      const polar = Math.atan2(Math.hypot(dx, dz), position.y - target.y);
      expect(polar).toBeLessThan(MAX_POLAR_ANGLE);
      expect(polar).toBeGreaterThan((55 * Math.PI) / 180);
    }
    // Unturned, it frames like Fit to View.
    expect(frontCamera(box, 0, 1).target).toEqual(fitFrame(box, 1).target);
  });
});
