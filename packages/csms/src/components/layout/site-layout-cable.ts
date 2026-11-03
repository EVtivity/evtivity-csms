// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The charging cable between a charger and a vehicle in the 3D layout,
// without three.js: when its connector delivers energy the cable carries a
// flowing green light from the charger to the vehicle (owner rule
// 2026-11-02: it reads as electric flow). The color is the CSMS charging
// state color, so the flow matches the station marker and the legend.

import { STATUS_COLORS } from '@/lib/chart-theme';

/** Connector statuses where energy flows through the cable. */
const FLOWING_STATUSES: ReadonlySet<string> = new Set(['charging', 'discharging']);

/**
 * The flowing light on a charging cable (owner request 2026-11-02: clearly
 * visible): a bright core tube in a lightened charging green around the
 * cable, a wide soft halo in the charging state color, and pulses about
 * 0.3 m long every `pitchM` moving toward the vehicle. The core is at least
 * 18 mm in radius (1.6 times a cable's), so a pulse spans more than a pixel
 * at 20 m; the halo is 50 mm.
 */
export const CHARGE_FLOW = {
  color: STATUS_COLORS.charging ?? '#22c55e',
  /** The core's color: the charging green lightened (Tailwind green 300). */
  coreColor: '#86efac',
  /** Meters a pulse travels per second toward the vehicle. */
  speedMps: 1.2,
  /** Meters between two pulses. */
  pitchM: 0.9,
  /** The core tube: its radius over the cable's, and its least radius. */
  coreScale: 1.6,
  coreMinM: 0.018,
  /** The halo tube's radius and opacity. */
  haloM: 0.05,
  haloOpacity: 0.45,
} as const;

/** The core light tube's radius around a cable of radius `cableRadiusM`. */
export function chargeFlowCoreRadius(cableRadiusM: number): number {
  return Math.max(cableRadiusM * CHARGE_FLOW.coreScale, CHARGE_FLOW.coreMinM);
}

/**
 * The pulse along one pitch of the flow texture, as [position, alpha] stops:
 * dim (0.03) to 0.35, rising to full by 0.55, full to 0.85, dim again by the
 * end, so each pulse is about a third of the 0.9 m pitch.
 */
export const CHARGE_FLOW_STOPS: ReadonlyArray<readonly [number, number]> = [
  [0, 0.03],
  [0.35, 0.03],
  [0.55, 1],
  [0.85, 1],
  [1, 0.03],
];

/** Whether energy flows through a connector of this status. */
export function connectorFlows(status: string | null | undefined): boolean {
  return status != null && FLOWING_STATUSES.has(status);
}

/** Whether any connector of an EVSE delivers energy now. */
export function evseFlows(evse: { connectors: ReadonlyArray<{ status: string }> }): boolean {
  return evse.connectors.some((c) => connectorFlows(c.status));
}

/** The pulses along a cable `lengthM` long: the texture repeat along the cable. */
export function chargeFlowRepeat(lengthM: number): number {
  return Math.max(1, lengthM / CHARGE_FLOW.pitchM);
}

/**
 * The texture offset of the flow at `time` seconds, moving the pulses from
 * the charger end toward the vehicle; null (reduced motion) keeps them still.
 */
export function chargeFlowOffset(time: number | null): number {
  if (time == null) return 0;
  return -((time * CHARGE_FLOW.speedMps) / CHARGE_FLOW.pitchM);
}

// Where the charge port of a car is (owner rule 2026-11-02): per car, stable,
// one of the real positions. US Access Board, Design Recommendations for
// Accessible Electric Vehicle Charging Stations (2022), "inlet placement
// varies across make and model of EVs": Tesla Model S, 3, X and Y driver side
// rear, Nissan Leaf and Ford E-Transit front, VW ID.4 passenger side rear
// (https://www.access-board.gov/tad/ev/), Chevrolet Bolt driver side front (the same table). A car
// whose port is at the rear backs into the spot, the ideal the same guide
// shows (Figure B1, the inlet close to the charger), so the cable reaches.

export const CAR_PORTS = [
  'front_left',
  'front_right',
  'rear_left',
  'rear_right',
  'front_center',
] as const;
export type CarPort = (typeof CAR_PORTS)[number];

/** How often each position is drawn, out of 10 (no market share source: a spread that shows every position). */
const CAR_PORT_WEIGHTS: ReadonlyArray<readonly [CarPort, number]> = [
  ['front_left', 3],
  ['front_right', 1],
  ['rear_left', 3],
  ['rear_right', 2],
  ['front_center', 1],
];

/** How far a side port sits from the nose (front) or the tail (rear), in meters. */
export const CAR_PORT_INSET_M = 0.62;

/** FNV-1a 32-bit hash of a string (stable across sessions and browsers). */
function hash32(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The charge port of the car of a session (or station), the same on every frame and reload. */
export function carPortOf(key: string): CarPort {
  const total = CAR_PORT_WEIGHTS.reduce((n, [, w]) => n + w, 0);
  let pick = hash32(key) % total;
  for (const [port, weight] of CAR_PORT_WEIGHTS) {
    if (pick < weight) return port;
    pick -= weight;
  }
  return 'front_left';
}

/** A car with its port at the rear backs into the spot (its tail toward the charger). */
export function parksBackedIn(port: CarPort | null | undefined): boolean {
  return port === 'rear_left' || port === 'rear_right';
}

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** What the port position needs of a car profile. */
export interface CarPortProfile {
  length: number;
  width: number;
  portY: number;
  head: readonly [number, number];
}

/**
 * The port in the car's own frame (nose at z = 0, the body along +z, its left
 * side at -x): a side port `CAR_PORT_INSET_M` from the nose or the tail at the
 * profile's port height, or the nose port just above the headlight line.
 */
export function carPortLocal(profile: CarPortProfile, port: CarPort): Point3 {
  if (port === 'front_center') return { x: 0, y: profile.head[1] + 0.08, z: -0.005 };
  const side = port.endsWith('left') ? -1 : 1;
  return {
    x: side * (profile.width / 2 + 0.005),
    y: profile.portY,
    z: port.startsWith('front') ? CAR_PORT_INSET_M : profile.length - CAR_PORT_INSET_M,
  };
}

/**
 * The port in the station's frame for a car at `x` across the station whose
 * end toward the charger is at `z`: its nose (nose in) or, backed in, its
 * tail (the car turned a half turn).
 */
export function carPortInStation(
  profile: CarPortProfile,
  port: CarPort,
  at: { x: number; z: number },
): Point3 {
  const l = carPortLocal(profile, port);
  if (!parksBackedIn(port)) return { x: at.x + l.x, y: l.y, z: at.z + l.z };
  return { x: at.x - l.x, y: l.y, z: at.z + profile.length - l.z };
}

/** The length of a polyline through the control points, in meters (the cable is at least this long). */
export function routeLength(points: ReadonlyArray<readonly [number, number, number]>): number {
  let n = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a == null || b == null) continue;
    n += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return n;
}
