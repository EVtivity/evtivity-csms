// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  FAST_MULTIPLIER,
  MAX_FRAME_SECONDS,
  PAN_SPEED_MIN,
  PITCH_SPEED,
  STEP_SECONDS,
  YAW_SPEED,
  ZOOM_SPEED,
  isZeroNudge,
  navDelta,
  navKeyOf,
  navStep,
  nudgeOrbit,
  type NavAction,
  type OrbitState,
} from '../site-layout-keyboard-nav';
import { MAX_POLAR_ANGLE, MIN_DISTANCE } from '../site-layout-grid';

const held = (...a: NavAction[]): Set<NavAction> => new Set(a);
const pan = { minX: -50, maxX: 50, minZ: -50, maxZ: 50 };

describe('navKeyOf', () => {
  it('maps WASD by physical key, so Shift or another layout keeps them', () => {
    expect(navKeyOf({ key: 'W', code: 'KeyW' })).toBe('forward');
    expect(navKeyOf({ key: 'z', code: 'KeyW' })).toBe('forward');
    expect(navKeyOf({ key: 'a', code: 'KeyA' })).toBe('left');
    expect(navKeyOf({ key: 's' })).toBe('back');
    expect(navKeyOf({ key: 'D' })).toBe('right');
  });

  it('maps the arrows, rotate, tilt, zoom and Home', () => {
    expect(navKeyOf({ key: 'ArrowUp' })).toBe('forward');
    expect(navKeyOf({ key: 'ArrowDown' })).toBe('back');
    expect(navKeyOf({ key: 'ArrowLeft' })).toBe('left');
    expect(navKeyOf({ key: 'ArrowRight' })).toBe('right');
    expect(navKeyOf({ key: 'q', code: 'KeyQ' })).toBe('turnLeft');
    expect(navKeyOf({ key: 'e', code: 'KeyE' })).toBe('turnRight');
    expect(navKeyOf({ key: 'r', code: 'KeyR' })).toBe('tiltUp');
    expect(navKeyOf({ key: 'f', code: 'KeyF' })).toBe('tiltDown');
    expect(navKeyOf({ key: '+', code: 'Equal' })).toBe('zoomIn');
    expect(navKeyOf({ key: '=', code: 'Equal' })).toBe('zoomIn');
    expect(navKeyOf({ key: '-', code: 'Minus' })).toBe('zoomOut');
    expect(navKeyOf({ key: '+', code: 'NumpadAdd' })).toBe('zoomIn');
    expect(navKeyOf({ key: 'PageUp' })).toBe('zoomIn');
    expect(navKeyOf({ key: 'PageDown' })).toBe('zoomOut');
    expect(navKeyOf({ key: 'Home' })).toBe('fit');
  });

  it('ignores other keys', () => {
    expect(navKeyOf({ key: 'Escape' })).toBeNull();
    expect(navKeyOf({ key: 'Enter' })).toBeNull();
    expect(navKeyOf({ key: 'x', code: 'KeyX' })).toBeNull();
    expect(navKeyOf({ key: 'Shift', code: 'ShiftLeft' })).toBeNull();
  });
});

describe('navDelta', () => {
  it('pans with the view distance, never slower than the minimum', () => {
    const far = navDelta(held('forward'), 0.05, { distance: 100, fast: false });
    expect(far.forward).toBeCloseTo(100 * 0.75 * 0.05);
    const near = navDelta(held('left'), 0.05, { distance: 1, fast: false });
    expect(near.right).toBeCloseTo(-PAN_SPEED_MIN * 0.05);
  });

  it('turns, tilts and zooms at their speeds', () => {
    const d = navDelta(held('turnLeft', 'tiltDown', 'zoomIn'), 0.1, { distance: 10, fast: false });
    expect(d.yaw).toBeCloseTo(YAW_SPEED * 0.1);
    expect(d.pitch).toBeCloseTo(PITCH_SPEED * 0.1);
    expect(d.zoom).toBeCloseTo(ZOOM_SPEED * 0.1);
    const r = navDelta(held('turnRight', 'tiltUp', 'zoomOut'), 0.1, { distance: 10, fast: false });
    expect(r.yaw).toBeLessThan(0);
    expect(r.pitch).toBeLessThan(0);
    expect(r.zoom).toBeLessThan(0);
  });

  it('cancels opposite keys', () => {
    expect(
      isZeroNudge(navDelta(held('forward', 'back'), 0.05, { distance: 10, fast: false })),
    ).toBe(true);
  });

  it('goes three times as far with Shift', () => {
    const slow = navDelta(held('right'), 0.05, { distance: 10, fast: false });
    const fast = navDelta(held('right'), 0.05, { distance: 10, fast: true });
    expect(fast.right).toBeCloseTo(slow.right * FAST_MULTIPLIER);
  });

  it('caps a stalled frame', () => {
    const d = navDelta(held('turnLeft'), 2, { distance: 10, fast: false });
    expect(d.yaw).toBeCloseTo(YAW_SPEED * MAX_FRAME_SECONDS);
  });

  it('takes one step per press with reduced motion', () => {
    expect(navStep('turnLeft', { distance: 10, fast: false }).yaw).toBeCloseTo(
      YAW_SPEED * STEP_SECONDS,
    );
  });
});

describe('nudgeOrbit', () => {
  const start: OrbitState = {
    target: { x: 0, y: 0.5, z: 0 },
    azimuth: 0,
    polar: 1,
    distance: 20,
  };

  it('moves forward toward where the camera looks and right to its right', () => {
    // Azimuth 0: the camera stands on +z and looks toward -z.
    const f = nudgeOrbit(
      start,
      { forward: 5, right: 2, yaw: 0, pitch: 0, zoom: 0 },
      {
        pan,
        maxDistance: 200,
      },
    );
    expect(f.target.z).toBeCloseTo(-5);
    expect(f.target.x).toBeCloseTo(2);
    expect(f.target.y).toBe(0.5);
    // Turned a quarter: the camera stands on +x and looks toward -x.
    const q = nudgeOrbit(
      { ...start, azimuth: Math.PI / 2 },
      { forward: 5, right: 0, yaw: 0, pitch: 0, zoom: 0 },
      { pan, maxDistance: 200 },
    );
    expect(q.target.x).toBeCloseTo(-5);
    expect(q.target.z).toBeCloseTo(0);
  });

  it('keeps the target in the pan box, the tilt and the distance in their limits', () => {
    const n = nudgeOrbit(
      start,
      { forward: 500, right: 0, yaw: 0.2, pitch: 5, zoom: 50 },
      {
        pan,
        maxDistance: 200,
      },
    );
    expect(n.target.z).toBe(-50);
    expect(n.azimuth).toBeCloseTo(0.2);
    expect(n.polar).toBe(MAX_POLAR_ANGLE);
    expect(n.distance).toBe(MIN_DISTANCE);
    const out = nudgeOrbit(
      start,
      { forward: 0, right: 0, yaw: 0, pitch: -5, zoom: -50 },
      {
        pan,
        maxDistance: 200,
      },
    );
    expect(out.polar).toBe(0);
    expect(out.distance).toBe(200);
  });
});
