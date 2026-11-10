// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  DOUBLE_TAP_MS,
  DOUBLE_TAP_PX,
  FOCUS_EASE_MS,
  FOCUS_FILL,
  MAX_TARGET_Y,
  cameraEaseAt,
  easeOutCubic,
  focusDistance,
  isDoubleTap,
  zoomTowardPoint,
} from '../site-layout-camera-nav';
import { CAMERA_FOV, MIN_DISTANCE } from '../site-layout-grid';
import type { OrbitState } from '../site-layout-keyboard-nav';

const pan = { minX: -100, maxX: 100, minZ: -100, maxZ: 100 };
const limits = { pan, maxDistance: 300 };
const state: OrbitState = {
  target: { x: 0, y: 0.5, z: 0 },
  azimuth: 0.4,
  polar: 1,
  distance: 40,
};

/** The camera position of an orbit (three.js Spherical: y up, theta from +z). */
function cameraOf(o: OrbitState): { x: number; y: number; z: number } {
  return {
    x: o.target.x + o.distance * Math.sin(o.polar) * Math.sin(o.azimuth),
    y: o.target.y + o.distance * Math.cos(o.polar),
    z: o.target.z + o.distance * Math.sin(o.polar) * Math.cos(o.azimuth),
  };
}

describe('zoomTowardPoint', () => {
  it('keeps the point under the pointer: the camera, the point and the old camera ray line up', () => {
    const point = { x: 12, y: 1.2, z: -8 };
    const next = zoomTowardPoint(state, point, 0.5, limits);
    const k = next.distance / state.distance;
    expect(k).toBeCloseTo(Math.exp(-0.5));
    // A homothety around the point: both the target and the camera move toward it by k.
    const before = cameraOf(state);
    const after = cameraOf(next);
    expect(after.x).toBeCloseTo(point.x + (before.x - point.x) * k);
    expect(after.y).toBeCloseTo(point.y + (before.y - point.y) * k);
    expect(after.z).toBeCloseTo(point.z + (before.z - point.z) * k);
    expect(next.azimuth).toBe(state.azimuth);
    expect(next.polar).toBe(state.polar);
  });

  it('moves the orbit center to the point over many steps, never nearer than MIN_DISTANCE', () => {
    let o = state;
    const point = { x: 5, y: 1.47, z: 3 };
    for (let i = 0; i < 60; i++) o = zoomTowardPoint(o, point, 0.3, limits);
    expect(o.distance).toBe(MIN_DISTANCE);
    // The center closes in by the same factor as the distance (40 m to 1 m): within 1/40 of the gap.
    expect(Math.abs(o.target.x - 5)).toBeLessThanOrEqual(5 / 40 + 1e-9);
    expect(Math.abs(o.target.y - 1.47)).toBeLessThanOrEqual(1 / 40 + 1e-9);
  });

  it('keeps the center in the pan box, above the ground and under MAX_TARGET_Y', () => {
    const out = zoomTowardPoint(state, { x: 500, y: 50, z: 500 }, 3, limits);
    expect(out.target.x).toBe(pan.maxX);
    expect(out.target.z).toBe(pan.maxZ);
    expect(out.target.y).toBeLessThanOrEqual(MAX_TARGET_Y);
    const low = zoomTowardPoint(
      { ...state, target: { x: 0, y: 0, z: 0 } },
      { x: 0, y: 3, z: 0 },
      -2,
      limits,
    );
    expect(low.target.y).toBe(0);
    expect(low.distance).toBeCloseTo(40 * Math.exp(2));
  });

  it('stops at the zoom-out limit', () => {
    expect(zoomTowardPoint(state, state.target, -10, limits).distance).toBe(300);
  });
});

describe('focusDistance', () => {
  it('frames an object at FOCUS_FILL of the view height, only ever easing in', () => {
    const fit = 2.079 / FOCUS_FILL / (2 * Math.tan((CAMERA_FOV * Math.PI) / 360));
    expect(focusDistance(2.079, 80, CAMERA_FOV)).toBeCloseTo(fit);
    // Already closer: the distance stays.
    expect(focusDistance(2.079, 3, CAMERA_FOV)).toBe(3);
    expect(focusDistance(0.01, 80, CAMERA_FOV)).toBe(MIN_DISTANCE);
    expect(focusDistance(Number.NaN, 80, CAMERA_FOV)).toBeGreaterThanOrEqual(MIN_DISTANCE);
  });
});

describe('cameraEaseAt', () => {
  const to: OrbitState = { target: { x: 10, y: 1, z: 4 }, azimuth: -3, polar: 1.2, distance: 6 };
  const ease = { from: { ...state, azimuth: 3 }, to, startMs: 1000, durationMs: FOCUS_EASE_MS };

  it('starts where the camera is and ends at the target in FOCUS_EASE_MS', () => {
    expect(FOCUS_EASE_MS).toBe(300);
    expect(cameraEaseAt(ease, 1000).state.distance).toBe(40);
    const end = cameraEaseAt(ease, 1000 + FOCUS_EASE_MS);
    expect(end.done).toBe(true);
    expect(end.state.target).toEqual(to.target);
    expect(end.state.distance).toBe(6);
    expect(cameraEaseAt(ease, 1150).done).toBe(false);
  });

  it('turns the short way round', () => {
    // From 3 to -3 rad is 0.28 rad across the back, not 6 rad the long way.
    const mid = cameraEaseAt(ease, 1150).state.azimuth;
    expect(Math.abs(mid - 3)).toBeLessThan(0.3);
  });

  it('eases out: past half way at the middle, monotonic, clamped', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(2)).toBe(1);
    expect(easeOutCubic(-1)).toBe(0);
  });
});

describe('isDoubleTap', () => {
  it('needs two taps within DOUBLE_TAP_MS and DOUBLE_TAP_PX', () => {
    const first = { x: 100, y: 100, timeMs: 0 };
    expect(isDoubleTap(null, first)).toBe(false);
    expect(isDoubleTap(first, { x: 110, y: 105, timeMs: 200 })).toBe(true);
    expect(isDoubleTap(first, { x: 100, y: 100, timeMs: DOUBLE_TAP_MS + 1 })).toBe(false);
    expect(isDoubleTap(first, { x: 100 + DOUBLE_TAP_PX + 1, y: 100, timeMs: 100 })).toBe(false);
  });
});
