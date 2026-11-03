// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Map-style wheel input of the 3D site layout: a two-finger trackpad swipe
// pans along the ground, a pinch zooms, a mouse wheel zooms. No DOM here;
// the moves go to the scene as a CameraNudge, with the keyboard's clamps.

import { CAMERA_FOV } from './site-layout-grid';
import type { CameraNudge } from './site-layout-keyboard-nav';

export type WheelSource = 'mouse' | 'trackpad' | 'pinch';

/** The fields of a WheelEvent the heuristic reads (`wheelDeltaY` is non-standard: Chrome and Safari). */
export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  timeStamp: number;
  wheelDeltaY?: number | undefined;
}

/** Pixels per line and per page for wheel deltas not given in pixels. */
export const WHEEL_LINE_PX = 16;
export const WHEEL_PAGE_PX = 800;
/** A pixel delta this large in one event, an integer, reads as a mouse wheel notch. */
export const MOUSE_NOTCH_MIN_PX = 50;
/** Events closer than this keep the trackpad source of the gesture (momentum scrolling). */
export const GESTURE_GAP_MS = 150;
/** Zoom per pixel of mouse wheel: one 100 px notch is about 14 percent closer. */
export const MOUSE_ZOOM_PER_PX = 0.0015;
/** Zoom per pixel of a pinch (ctrlKey wheel); pinch deltas are small. */
export const PINCH_ZOOM_PER_PX = 0.01;

/**
 * Tells a mouse wheel from a trackpad, in this order:
 * 1. ctrlKey: a trackpad pinch (browsers send pinch as a ctrl wheel; Ctrl plus a mouse wheel zooms too).
 * 2. A trackpad event within GESTURE_GAP_MS of the last one keeps the trackpad (momentum).
 * 3. deltaMode line or page: a mouse wheel (Firefox mouse wheels count lines).
 * 4. Any deltaX: a trackpad (a mouse wheel scrolls one axis).
 * 5. wheelDeltaY present: a trackpad sends exactly -3 times deltaY, a mouse a multiple of 120.
 * 6. A fractional deltaY: a trackpad (mouse notches are whole pixels).
 * 7. A whole deltaY of at least MOUSE_NOTCH_MIN_PX: a mouse notch; smaller: a trackpad.
 */
export function wheelSource(
  e: WheelLike,
  last?: { source: WheelSource; timeStamp: number } | null,
): WheelSource {
  if (e.ctrlKey) return 'pinch';
  if (
    last != null &&
    last.source === 'trackpad' &&
    e.timeStamp - last.timeStamp >= 0 &&
    e.timeStamp - last.timeStamp < GESTURE_GAP_MS
  )
    return 'trackpad';
  if (e.deltaMode !== 0) return 'mouse';
  if (e.deltaX !== 0) return 'trackpad';
  if (e.wheelDeltaY != null && e.wheelDeltaY !== 0) {
    if (e.wheelDeltaY === -3 * e.deltaY) return 'trackpad';
    return e.wheelDeltaY % 120 === 0 ? 'mouse' : 'trackpad';
  }
  if (!Number.isInteger(e.deltaY)) return 'trackpad';
  return Math.abs(e.deltaY) >= MOUSE_NOTCH_MIN_PX ? 'mouse' : 'trackpad';
}

function pixels(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return delta * WHEEL_LINE_PX;
  if (deltaMode === 2) return delta * WHEEL_PAGE_PX;
  return delta;
}

/** Meters of ground per screen pixel at the target, from the view distance and the stage height. */
export function metersPerPixel(distance: number, stageHeightPx: number): number {
  if (!(distance > 0) || !(stageHeightPx > 0)) return 0;
  return (2 * distance * Math.tan((CAMERA_FOV * Math.PI) / 360)) / stageHeightPx;
}

const ZERO: CameraNudge = { forward: 0, right: 0, yaw: 0, pitch: 0, zoom: 0 };

/**
 * The camera move of one wheel event. A trackpad swipe moves the ground with
 * the fingers, like a map: scrolling down (deltaY > 0) moves back, right
 * (deltaX > 0) moves right. A pinch or a mouse wheel zooms: deltaY < 0 comes closer.
 */
export function wheelNudge(
  e: WheelLike,
  source: WheelSource,
  view: { distance: number; stageHeightPx: number },
): CameraNudge {
  const dy = pixels(e.deltaY, e.deltaMode);
  if (source === 'pinch') return { ...ZERO, zoom: -dy * PINCH_ZOOM_PER_PX };
  if (source === 'mouse') return { ...ZERO, zoom: -dy * MOUSE_ZOOM_PER_PX };
  const m = metersPerPixel(view.distance, view.stageHeightPx);
  return { ...ZERO, forward: -dy * m, right: pixels(e.deltaX, e.deltaMode) * m };
}

/** Safari's trackpad pinch (gesturechange scale): the zoom between two scales. */
export function gestureZoom(previousScale: number, scale: number): number {
  if (!(previousScale > 0) || !(scale > 0)) return 0;
  return Math.log(scale / previousScale);
}
