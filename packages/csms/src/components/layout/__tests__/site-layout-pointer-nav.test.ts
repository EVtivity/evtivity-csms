// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  GESTURE_GAP_MS,
  MOUSE_ZOOM_PER_PX,
  PINCH_ZOOM_PER_PX,
  WHEEL_LINE_PX,
  gestureZoom,
  metersPerPixel,
  wheelNudge,
  wheelSource,
  type WheelLike,
} from '../site-layout-pointer-nav';

const wheel = (w: Partial<WheelLike>): WheelLike => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  timeStamp: 1000,
  ...w,
});

describe('wheelSource', () => {
  it('reads a ctrl wheel as a pinch', () => {
    expect(wheelSource(wheel({ ctrlKey: true, deltaY: 3.5 }))).toBe('pinch');
    expect(wheelSource(wheel({ ctrlKey: true, deltaY: 100 }))).toBe('pinch');
  });

  it('reads line and page deltas as a mouse wheel (Firefox)', () => {
    expect(wheelSource(wheel({ deltaMode: 1, deltaY: 3 }))).toBe('mouse');
    expect(wheelSource(wheel({ deltaMode: 2, deltaY: 1 }))).toBe('mouse');
  });

  it('reads a horizontal or fractional delta as a trackpad', () => {
    expect(wheelSource(wheel({ deltaX: 4, deltaY: 2 }))).toBe('trackpad');
    expect(wheelSource(wheel({ deltaY: 7.25 }))).toBe('trackpad');
  });

  it('uses wheelDeltaY when the browser has it', () => {
    // A trackpad in Chrome and Safari: wheelDeltaY is -3 times deltaY.
    expect(wheelSource(wheel({ deltaY: 40, wheelDeltaY: -120 }))).toBe('trackpad');
    expect(wheelSource(wheel({ deltaY: 6, wheelDeltaY: -18 }))).toBe('trackpad');
    // A mouse notch: a multiple of 120 that is not -3 times deltaY.
    expect(wheelSource(wheel({ deltaY: 100, wheelDeltaY: -120 }))).toBe('mouse');
    expect(wheelSource(wheel({ deltaY: 4, wheelDeltaY: -240 }))).toBe('mouse');
  });

  it('reads a whole notch-sized pixel delta as a mouse wheel, a small one as a trackpad', () => {
    expect(wheelSource(wheel({ deltaY: 100 }))).toBe('mouse');
    expect(wheelSource(wheel({ deltaY: -53 }))).toBe('mouse');
    expect(wheelSource(wheel({ deltaY: 12 }))).toBe('trackpad');
  });

  it('keeps a trackpad gesture a trackpad through its momentum', () => {
    const last = { source: 'trackpad' as const, timeStamp: 1000 };
    expect(wheelSource(wheel({ deltaY: 120, timeStamp: 1050 }), last)).toBe('trackpad');
    expect(wheelSource(wheel({ deltaY: 120, timeStamp: 1000 + GESTURE_GAP_MS }), last)).toBe(
      'mouse',
    );
    expect(wheelSource(wheel({ deltaY: 120, ctrlKey: true, timeStamp: 1050 }), last)).toBe('pinch');
  });
});

describe('wheelNudge', () => {
  const view = { distance: 50, stageHeightPx: 600 };

  it('zooms with a mouse wheel and a pinch, closer for a negative deltaY', () => {
    expect(wheelNudge(wheel({ deltaY: -100 }), 'mouse', view).zoom).toBeCloseTo(
      100 * MOUSE_ZOOM_PER_PX,
    );
    expect(wheelNudge(wheel({ deltaY: 3, deltaMode: 1 }), 'mouse', view).zoom).toBeCloseTo(
      -3 * WHEEL_LINE_PX * MOUSE_ZOOM_PER_PX,
    );
    const pinch = wheelNudge(wheel({ deltaY: -5, ctrlKey: true }), 'pinch', view);
    expect(pinch.zoom).toBeCloseTo(5 * PINCH_ZOOM_PER_PX);
    expect(pinch.forward).toBe(0);
  });

  it('pans a trackpad swipe like a map, scaled to the ground under the view', () => {
    const m = metersPerPixel(50, 600);
    const n = wheelNudge(wheel({ deltaX: 20, deltaY: 30 }), 'trackpad', view);
    expect(n.forward).toBeCloseTo(-30 * m);
    expect(n.right).toBeCloseTo(20 * m);
    expect(n.zoom).toBe(0);
  });

  it('scales the pan with the view distance and moves nothing without a size', () => {
    expect(metersPerPixel(100, 600)).toBeCloseTo(metersPerPixel(50, 600) * 2);
    expect(metersPerPixel(50, 0)).toBe(0);
  });
});

describe('gestureZoom', () => {
  it('zooms by the scale ratio of a Safari pinch', () => {
    expect(gestureZoom(1, 2)).toBeCloseTo(Math.log(2));
    expect(gestureZoom(2, 1)).toBeCloseTo(-Math.log(2));
    expect(gestureZoom(0, 1)).toBe(0);
  });
});
