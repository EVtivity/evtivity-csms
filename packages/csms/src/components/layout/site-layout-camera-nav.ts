// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Map-app navigation of the 3D site layout camera, without three.js (owner
// decision 2026-11-09: natural and simple, nothing extra). The wheel and a
// pinch zoom toward the point under the pointer, and the orbit center follows
// it; a double click or double tap on a charger or equipment eases the camera
// in and makes it the orbit center. The conventions of common map apps:
// Mapbox GL JS `ScrollZoomHandler` zooms "around" the point under the mouse
// and `DoubleClickZoomHandler` zooms in at the clicked point; Google Maps
// zooms in at the point double clicked or double tapped.

import { clampTarget, MAX_POLAR_ANGLE, MIN_DISTANCE, type Box } from './site-layout-grid';
import type { OrbitState } from './site-layout-keyboard-nav';

/** The highest the orbit center may rise, in meters: above the tallest model (the pantograph pole, 5.41 m). */
export const MAX_TARGET_Y = 6;

/**
 * How long the camera eases to a double clicked object, in milliseconds
 * (owner decision 2026-11-09: about 300 ms; MapLibre GL JS 5.24 `easeTo`
 * defaults to 500 ms, src/ui/camera.ts). None with `prefers-reduced-motion`
 * (WCAG 2.2, 2.3.3 Animation from Interactions).
 */
export const FOCUS_EASE_MS = 300;

/** Two taps count as a double tap within this time and distance (derived design values, near a browser's double tap). */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 24;

/** How much of the view's height a double clicked object fills (it then stands with room around it). */
export const FOCUS_FILL = 0.6;

export interface CameraNavLimits {
  pan: Box;
  maxDistance: number;
  minDistance?: number;
}

/**
 * The orbit after zooming by `zoom` (positive: closer, the distance times
 * exp(-zoom)) toward `point`, the 3D point under the pointer: the orbit
 * center moves toward the point by the same factor, so the point stays under
 * the pointer and the camera keeps its angles. The center stays in the pan
 * box and between the ground and `MAX_TARGET_Y`; the distance between the
 * zoom limits. The eye height floor stays with the scene's frame loop.
 */
export function zoomTowardPoint(
  state: OrbitState,
  point: { x: number; y: number; z: number },
  zoom: number,
  limits: CameraNavLimits,
): OrbitState {
  const minDistance = limits.minDistance ?? MIN_DISTANCE;
  const maxDistance = Math.max(minDistance, limits.maxDistance);
  const distance = Math.min(maxDistance, Math.max(minDistance, state.distance * Math.exp(-zoom)));
  const k = state.distance > 0 ? distance / state.distance : 1;
  const x = point.x + (state.target.x - point.x) * k;
  const z = point.z + (state.target.z - point.z) * k;
  const y = point.y + (state.target.y - point.y) * k;
  const t = clampTarget(x, z, limits.pan);
  return {
    target: { x: t.x, y: Math.min(MAX_TARGET_Y, Math.max(0, y)), z: t.z },
    azimuth: state.azimuth,
    polar: Math.min(MAX_POLAR_ANGLE, state.polar),
    distance,
  };
}

/**
 * The view distance that frames an object `heightM` tall at `FOCUS_FILL` of
 * the view's height (`fovDeg` vertical field of view), never further than
 * the current distance (a double click only eases in) and never nearer than
 * `MIN_DISTANCE`.
 */
export function focusDistance(heightM: number, currentDistance: number, fovDeg: number): number {
  const h = Number.isFinite(heightM) && heightM > 0 ? heightM : 1;
  const fit = h / FOCUS_FILL / (2 * Math.tan((fovDeg * Math.PI) / 360));
  const current = Number.isFinite(currentDistance) && currentDistance > 0 ? currentDistance : fit;
  return Math.max(MIN_DISTANCE, Math.min(current, fit));
}

/** Ease out cubic, from 0 to 1 (fast first, settling at the end). */
export function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) ** 3;
}

export interface CameraEase {
  from: OrbitState;
  to: OrbitState;
  startMs: number;
  durationMs: number;
}

/** The orbit `nowMs` into an ease, and whether it has ended (the azimuth takes the short way round). */
export function cameraEaseAt(
  ease: CameraEase,
  nowMs: number,
): { state: OrbitState; done: boolean } {
  const raw = ease.durationMs <= 0 ? 1 : (nowMs - ease.startMs) / ease.durationMs;
  const k = easeOutCubic(raw);
  const lerp = (a: number, b: number): number => a + (b - a) * k;
  let turn = ease.to.azimuth - ease.from.azimuth;
  turn = Math.atan2(Math.sin(turn), Math.cos(turn));
  return {
    state: {
      target: {
        x: lerp(ease.from.target.x, ease.to.target.x),
        y: lerp(ease.from.target.y, ease.to.target.y),
        z: lerp(ease.from.target.z, ease.to.target.z),
      },
      azimuth: ease.from.azimuth + turn * k,
      polar: lerp(ease.from.polar, ease.to.polar),
      distance: lerp(ease.from.distance, ease.to.distance),
    },
    done: raw >= 1,
  };
}

/** Whether a tap at (`x`, `y`) at `timeMs` completes a double tap with the last tap. */
export function isDoubleTap(
  last: { x: number; y: number; timeMs: number } | null,
  tap: { x: number; y: number; timeMs: number },
): boolean {
  if (last == null) return false;
  const dt = tap.timeMs - last.timeMs;
  return (
    dt >= 0 && dt <= DOUBLE_TAP_MS && Math.hypot(tap.x - last.x, tap.y - last.y) <= DOUBLE_TAP_PX
  );
}
