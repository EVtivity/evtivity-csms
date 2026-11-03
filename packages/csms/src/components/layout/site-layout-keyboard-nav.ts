// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Keyboard navigation of the 3D site layout: which key does what, and how far
// the held keys move the camera in a frame. No three.js and no DOM here.

import { clampTarget, MAX_POLAR_ANGLE, MIN_DISTANCE, type Box } from './site-layout-grid';

/** A camera move a held key makes. */
export type NavAction =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'turnLeft'
  | 'turnRight'
  | 'tiltUp'
  | 'tiltDown'
  | 'zoomIn'
  | 'zoomOut';

/** A navigation key: a camera move, or Fit to View (Home). */
export type NavKey = NavAction | 'fit';

/**
 * One camera move, applied by the scene with its usual clamps (the pan box,
 * the polar limits, MIN_DISTANCE and the zoom-out limit, the eye height floor).
 * - `forward`, `right`: meters along the ground, relative to the camera heading
 *   (forward is where the camera looks, flattened onto the ground).
 * - `yaw`: radians around the target; positive turns the heading left
 *   (the azimuth, `Spherical.theta` of the camera offset, grows).
 * - `pitch`: radians of polar angle; positive lowers the camera toward eye level.
 * - `zoom`: natural log of the distance ratio; positive comes closer
 *   (new distance = distance * exp(-zoom)).
 */
export interface CameraNudge {
  forward: number;
  right: number;
  yaw: number;
  pitch: number;
  zoom: number;
}

/** Pan speed while a move key is held: this share of the view distance per second. */
export const PAN_SPEED_PER_DISTANCE = 0.75;
/** The slowest pan, in meters per second (close to the ground). */
export const PAN_SPEED_MIN = 2;
/** Turn speed around the target, radians per second (90 degrees). */
export const YAW_SPEED = Math.PI / 2;
/** Tilt speed, radians per second (45 degrees). */
export const PITCH_SPEED = Math.PI / 4;
/** Zoom speed, natural log of the distance ratio per second (about 3.3 times a second). */
export const ZOOM_SPEED = 1.2;
/** Holding Shift moves this many times faster. */
export const FAST_MULTIPLIER = 3;
/** The longest frame counted, in seconds, so a stalled frame never jumps the camera. */
export const MAX_FRAME_SECONDS = 0.1;
/** With reduced motion each key press moves as far as this many seconds of holding. */
export const STEP_SECONDS = 0.2;

const CODE_ACTIONS: Readonly<Record<string, NavKey>> = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  KeyQ: 'turnLeft',
  KeyE: 'turnRight',
  KeyR: 'tiltUp',
  KeyF: 'tiltDown',
  NumpadAdd: 'zoomIn',
  NumpadSubtract: 'zoomOut',
};

const KEY_ACTIONS: Readonly<Record<string, NavKey>> = {
  w: 'forward',
  s: 'back',
  a: 'left',
  d: 'right',
  q: 'turnLeft',
  e: 'turnRight',
  r: 'tiltUp',
  f: 'tiltDown',
  ArrowUp: 'forward',
  ArrowDown: 'back',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  '+': 'zoomIn',
  '=': 'zoomIn',
  '-': 'zoomOut',
  _: 'zoomOut',
  PageUp: 'zoomIn',
  PageDown: 'zoomOut',
  Home: 'fit',
};

/**
 * The navigation key of a keyboard event, or null. Letters go by their
 * physical position (`code`), so W, A, S, D sit together on any layout.
 */
export function navKeyOf(e: { key: string; code?: string }): NavKey | null {
  const byCode = e.code != null && e.code !== '' ? CODE_ACTIONS[e.code] : undefined;
  if (byCode != null) return byCode;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return KEY_ACTIONS[key] ?? null;
}

function axis(held: ReadonlySet<NavAction>, plus: NavAction, minus: NavAction): number {
  return (held.has(plus) ? 1 : 0) - (held.has(minus) ? 1 : 0);
}

/**
 * The camera move of the held keys over `seconds` (capped at MAX_FRAME_SECONDS
 * unless `step`). Opposite keys cancel. The pan speed follows the view distance,
 * so a key moves as useful a distance far away as close up.
 */
export function navDelta(
  held: ReadonlySet<NavAction>,
  seconds: number,
  view: { distance: number; fast: boolean; step?: boolean },
): CameraNudge {
  const dt = view.step === true ? seconds : Math.min(Math.max(seconds, 0), MAX_FRAME_SECONDS);
  const k = dt * (view.fast ? FAST_MULTIPLIER : 1);
  const distance = Number.isFinite(view.distance) && view.distance > 0 ? view.distance : 0;
  const pan = Math.max(PAN_SPEED_MIN, distance * PAN_SPEED_PER_DISTANCE) * k;
  return {
    forward: axis(held, 'forward', 'back') * pan,
    right: axis(held, 'right', 'left') * pan,
    yaw: axis(held, 'turnLeft', 'turnRight') * YAW_SPEED * k,
    pitch: axis(held, 'tiltDown', 'tiltUp') * PITCH_SPEED * k,
    zoom: axis(held, 'zoomIn', 'zoomOut') * ZOOM_SPEED * k,
  };
}

/** The move of one key press with reduced motion. */
export function navStep(action: NavAction, view: { distance: number; fast: boolean }): CameraNudge {
  return navDelta(new Set([action]), STEP_SECONDS, { ...view, step: true });
}

export function isZeroNudge(n: CameraNudge): boolean {
  return n.forward === 0 && n.right === 0 && n.yaw === 0 && n.pitch === 0 && n.zoom === 0;
}

/** The orbit camera: the point it looks at and where it stands around it. */
export interface OrbitState {
  target: { x: number; y: number; z: number };
  /** `Spherical.theta` of the camera offset from the target, radians. */
  azimuth: number;
  /** `Spherical.phi`, radians from straight down onto the target. */
  polar: number;
  distance: number;
}

export interface OrbitLimits {
  pan: Box;
  maxDistance: number;
  minDistance?: number;
  minPolar?: number;
  maxPolar?: number;
}

/**
 * The orbit after a nudge, inside the limits: the target in the pan box, the
 * polar angle up to MAX_POLAR_ANGLE, the distance from MIN_DISTANCE to the
 * zoom-out limit. The eye height floor stays with the scene's frame loop.
 */
export function nudgeOrbit(state: OrbitState, n: CameraNudge, limits: OrbitLimits): OrbitState {
  const sin = Math.sin(state.azimuth);
  const cos = Math.cos(state.azimuth);
  // The camera looks from its offset toward the target: forward is minus the offset on the ground.
  const x = state.target.x - sin * n.forward + cos * n.right;
  const z = state.target.z - cos * n.forward - sin * n.right;
  const t = clampTarget(x, z, limits.pan);
  const minPolar = limits.minPolar ?? 0;
  const maxPolar = limits.maxPolar ?? MAX_POLAR_ANGLE;
  const minDistance = limits.minDistance ?? MIN_DISTANCE;
  const maxDistance = Math.max(minDistance, limits.maxDistance);
  return {
    target: { x: t.x, y: state.target.y, z: t.z },
    azimuth: state.azimuth + n.yaw,
    polar: Math.min(maxPolar, Math.max(minPolar, state.polar + n.pitch)),
    distance: Math.min(maxDistance, Math.max(minDistance, state.distance * Math.exp(-n.zoom))),
  };
}
