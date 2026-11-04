// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Which car a charging station of the 3D site layout draws, and the shape of
// each body type. No three.js here: SiteLayout3D maps the session to a car and
// the scene builds it (site-layout-car-geometry.ts) from these profiles.

import type { CarPort } from './site-layout-cable';
import type { ConnectorKind } from './site-layout-connectors';
import type { VehicleInletKind } from './site-layout-vehicle-inlet';
import {
  DEFAULT_VEHICLE_BODY_TYPE,
  VEHICLE_BODY_TYPES,
  isVehicleBodyType,
  vehicleColorHex,
  type VehicleBodyType,
} from '@evtivity/lib/vehicle-appearance';

/** Body types drawn as large vehicles (site-layout-large-vehicle-geometry.ts), not from a car profile. */
export const LARGE_BODY_TYPES = ['box_truck', 'bus', 'semi_truck'] as const;
export type LargeBodyType = (typeof LARGE_BODY_TYPES)[number];
export type CarBodyType = Exclude<VehicleBodyType, LargeBodyType>;

export function isLargeBodyType(bodyType: VehicleBodyType): bodyType is LargeBodyType {
  return (LARGE_BODY_TYPES as readonly string[]).includes(bodyType);
}

/** The car body types, in list order. */
export const CAR_BODY_TYPES: readonly CarBodyType[] = VEHICLE_BODY_TYPES.filter(
  (b): b is CarBodyType => !isLargeBodyType(b),
);

/** The car of a charging station: its body type and its paint (a CSS hex color). */
export interface SceneCar {
  bodyType: VehicleBodyType;
  color: string;
  /** Where its charge port is (`carPortOf`, cars only); absent: front left. A rear port backs the car in. */
  port?: CarPort | undefined;
  /** Its charge inlet (`vehicleInletOf` the plug); absent: the body type's default. */
  inlet?: VehicleInletKind | undefined;
  /** The connector plugged into the inlet; absent: the inlet's own DC plug; null: none (door closed). */
  plug?: ConnectorKind | null | undefined;
}

/**
 * The car of a session's vehicle (the API picks the vehicle: the session's,
 * else the driver's only one, else the driver's most recently used one). A
 * missing vehicle or body type draws the default of the spot (`fallback`: a
 * sedan, a bus in a bus bay, a semi truck in a truck pull-through lane), a
 * missing color grey.
 */
export function sceneCar(
  vehicle: { color: string | null; bodyType: string | null } | null | undefined,
  fallback: VehicleBodyType = DEFAULT_VEHICLE_BODY_TYPE,
): SceneCar {
  return {
    bodyType: isVehicleBodyType(vehicle?.bodyType) ? vehicle.bodyType : fallback,
    color: vehicleColorHex(vehicle?.color),
  };
}

/** A point of a side profile: `u` meters back from the nose, `v` meters up from the ground. */
export type ProfilePoint = readonly [u: number, v: number];

/**
 * The side profile of a body type, in meters, from real outer dimensions of
 * a typical car of the type:
 * - `body`: the painted lower body up to the beltline (hood, fenders, doors,
 *   trunk or tailgate), from the bottom of the front bumper over the top to the
 *   bottom of the rear bumper; the scene closes it along `bottom` with wheel
 *   arches around the axles.
 * - `glass`: the greenhouse from the windshield base over the roof to the rear
 *   window base; the roof between its second and its second to last point is
 *   painted.
 * - `bed`: a pickup's open load bed (from, to along the car).
 * - `head`, `tail`: the middle of the headlights and tail lights.
 * - `portY`: the charge port height on the front left fender, where the cable
 *   connects: the center of the plug in the inlet. Derived so the door opening
 *   of every side inlet (CCS1, CCS2, NACS: `inletDoorBounds`) stays at least
 *   45 mm under the fender top at the front port (clear of the body's 0.1 m
 *   edge rounding) and above the front wheel arch (the sedan's 0.705 m; the
 *   hatchback's fender leaves 0.76 m, 7 mm into the arch corner and the
 *   rounding, filled by the inlet housing).
 */
export interface CarProfile {
  length: number;
  width: number;
  height: number;
  wheelRadius: number;
  frontAxle: number;
  rearAxle: number;
  bottom: number;
  body: readonly ProfilePoint[];
  glass: readonly ProfilePoint[];
  bed?: readonly [from: number, to: number];
  head: ProfilePoint;
  tail: ProfilePoint;
  portY: number;
}

/** How thick the painted roof is over the glass. */
export const ROOF_THICKNESS_M = 0.04;

export const CAR_PROFILES: Record<CarBodyType, CarProfile> = {
  sedan: {
    length: 4.7,
    width: 1.84,
    height: 1.45,
    wheelRadius: 0.34,
    frontAxle: 0.98,
    rearAxle: 3.8,
    bottom: 0.24,
    body: [
      [0.04, 0.3],
      [0, 0.5],
      [0.07, 0.66],
      [0.45, 0.78],
      [1.05, 0.86],
      [1.6, 0.94],
      [2.6, 0.97],
      [3.85, 0.98],
      [4.4, 0.95],
      [4.66, 0.86],
      [4.7, 0.62],
      [4.66, 0.32],
    ],
    glass: [
      [1.55, 0.93],
      [2.35, 1.38],
      [2.95, 1.41],
      [3.5, 1.38],
      [4.25, 0.96],
    ],
    head: [0.07, 0.68],
    tail: [4.67, 0.84],
    portY: 0.705,
  },
  hatchback: {
    length: 4.2,
    width: 1.8,
    height: 1.47,
    wheelRadius: 0.33,
    frontAxle: 0.86,
    rearAxle: 3.44,
    bottom: 0.24,
    body: [
      [0.04, 0.3],
      [0, 0.5],
      [0.07, 0.68],
      [0.45, 0.8],
      [0.95, 0.88],
      [1.4, 0.96],
      [2.6, 0.99],
      [3.75, 1.0],
      [4.1, 0.98],
      [4.2, 0.82],
      [4.19, 0.5],
      [4.15, 0.32],
    ],
    glass: [
      [1.35, 0.95],
      [2.1, 1.4],
      [2.9, 1.43],
      [3.75, 1.4],
      [4.1, 0.98],
    ],
    head: [0.07, 0.7],
    tail: [4.18, 0.9],
    portY: 0.76,
  },
  suv: {
    length: 4.7,
    width: 1.92,
    height: 1.72,
    wheelRadius: 0.37,
    frontAxle: 1.0,
    rearAxle: 3.85,
    bottom: 0.3,
    body: [
      [0.05, 0.38],
      [0, 0.6],
      [0.06, 0.84],
      [0.5, 0.97],
      [1.1, 1.04],
      [1.5, 1.09],
      [2.8, 1.12],
      [4.3, 1.13],
      [4.62, 1.1],
      [4.7, 0.92],
      [4.69, 0.55],
      [4.64, 0.4],
    ],
    glass: [
      [1.45, 1.08],
      [2.2, 1.62],
      [3.2, 1.67],
      [4.35, 1.64],
      [4.6, 1.12],
    ],
    head: [0.06, 0.86],
    tail: [4.66, 1.04],
    portY: 0.88,
  },
  pickup_truck: {
    length: 5.3,
    width: 2.0,
    height: 1.85,
    wheelRadius: 0.4,
    frontAxle: 1.05,
    rearAxle: 4.35,
    bottom: 0.38,
    body: [
      [0.05, 0.45],
      [0, 0.7],
      [0.04, 0.98],
      [0.6, 1.1],
      [1.25, 1.14],
      [1.65, 1.17],
      [3.2, 1.18],
      [4.4, 1.18],
      [5.2, 1.17],
      [5.28, 1.1],
      [5.3, 0.9],
      [5.29, 0.6],
      [5.24, 0.45],
    ],
    glass: [
      [1.6, 1.16],
      [2.3, 1.76],
      [2.75, 1.8],
      [3.15, 1.78],
      [3.2, 1.17],
    ],
    bed: [3.35, 5.18],
    head: [0.05, 0.98],
    tail: [5.28, 1.02],
    portY: 0.98,
  },
  van: {
    length: 4.9,
    width: 1.98,
    height: 1.95,
    wheelRadius: 0.35,
    frontAxle: 0.82,
    rearAxle: 3.9,
    bottom: 0.3,
    body: [
      [0.05, 0.38],
      [0, 0.6],
      [0.06, 0.82],
      [0.4, 0.98],
      [0.75, 1.06],
      [1.0, 1.12],
      [2.8, 1.14],
      [4.75, 1.14],
      [4.88, 1.1],
      [4.9, 0.8],
      [4.88, 0.5],
      [4.83, 0.38],
    ],
    glass: [
      [0.95, 1.1],
      [1.75, 1.84],
      [3.0, 1.91],
      [4.72, 1.89],
      [4.86, 1.16],
    ],
    head: [0.06, 0.86],
    tail: [4.88, 1.0],
    portY: 0.9,
  },
};

/** The highest point of a body type: its roof. */
export function carRoofHeight(profile: CarProfile): number {
  return Math.max(...profile.glass.map((p) => p[1])) + ROOF_THICKNESS_M;
}

/** An axle of a large vehicle: `z` meters back from the nose, dual tires on each side or one. */
export interface LargeAxle {
  z: number;
  dual: boolean;
}

/**
 * The real outer dimensions of a large vehicle, in meters (the nose at z = 0,
 * the body along +z). `port` is the charge inlet on the left side (`z` back
 * from the nose, `y` up); `roofContact` (a bus) the middle of the contact
 * rails on the roof above the front axle, where a depot pantograph comes down.
 * - Box truck: a class 6 battery electric box truck (Freightliner eM2 106,
 *   MY25 spec sheet: 391 in (9.93 m) long, 270 in (6.86 m) wheelbase, 106 in
 *   (2.69 m) bumper to back of cab, cab roof 102.5 in (2.6 m), charge inlet on
 *   the left under the cab 11 ft (3.35 m) from the nose) with a 24 ft box
 *   2.6 m wide and 13 ft (3.96 m) high; 11R22.5 tires (0.52 m radius).
 * - Bus: a 12 m low floor city bus (Mercedes eCitaro: 12.14 by 2.55 by 3.40 m,
 *   5.9 m wheelbase; Solaris Urbino 12 electric: 2.7 m front overhang), the
 *   roof batteries and air conditioner reaching the 3.4 m, 275/70R22.5 tires
 *   (0.48 m radius). The pantograph rails sit above the front axle (ABB HVC-PD
 *   manual: the front axle is under the roof rails on most buses).
 * - Semi truck: a 6x4 day cab tractor (Freightliner eCascadia MY25: 306 in
 *   (7.77 m) long, 190 in (4.83 m) wheelbase to the middle of the tandem,
 *   116 in (2.95 m) bumper to back of cab, cab roof 116.2 in (2.95 m), roof
 *   deflector 157.4 in (4.0 m), charge inlet on the left under the cab
 *   10 ft 10 in (3.3 m) from the nose) with a 53 ft (16.15 m) dry van trailer,
 *   2.6 m wide, 13 ft 6 in (4.11 m) high, its kingpin 36 in from its front on
 *   the fifth wheel ahead of the tandem, its tandem slid to 40 ft from the
 *   kingpin to the rear axle (the California limit). CharIN MCS: the inlet on
 *   the left behind the first axle (CharIN Whitepaper Megawatt Charging
 *   System, 1.0, 2022-11-24, 2.3.II: inlets 2 to 4.8 m from the front; no
 *   height is given, only that ergonomics be considered). Its center at
 *   1.18 m is derived: the highest that keeps the 0.26 m socket and its
 *   status light inside the 0.5 m charge port box between the cab and the
 *   battery fairing (top at 1.45 m), and below the 48 in (1.22 m) high reach
 *   of operable parts (2010 ADA Standards 308.2.1), above the frame rails (1.09 m).
 */
export interface LargeVehicleSpec {
  length: number;
  width: number;
  height: number;
  wheelRadius: number;
  axles: readonly LargeAxle[];
  port: { z: number; y: number };
  roofContact?: { z: number; y: number };
}

export const LARGE_VEHICLE_SPECS: Record<LargeBodyType, LargeVehicleSpec> = {
  box_truck: {
    length: 9.93,
    width: 2.6,
    height: 3.96,
    wheelRadius: 0.52,
    axles: [
      { z: 1.05, dual: false },
      { z: 7.91, dual: true },
    ],
    port: { z: 3.35, y: 1.0 },
  },
  bus: {
    length: 12.14,
    width: 2.55,
    height: 3.4,
    wheelRadius: 0.48,
    axles: [
      { z: 2.7, dual: false },
      { z: 8.6, dual: true },
    ],
    port: { z: 1.9, y: 1.05 },
    roofContact: { z: 2.7, y: 3.38 },
  },
  semi_truck: {
    length: 21.24,
    width: 2.6,
    height: 4.11,
    wheelRadius: 0.52,
    axles: [
      { z: 1.45, dual: false },
      { z: 5.62, dual: true },
      { z: 6.94, dual: true },
      { z: 16.95, dual: true },
      { z: 18.19, dual: true },
    ],
    port: { z: 3.3, y: 1.18 },
  },
};

/** The length, width and height of any body type, in meters. */
export function vehicleSize(bodyType: VehicleBodyType): {
  length: number;
  width: number;
  height: number;
} {
  if (isLargeBodyType(bodyType)) {
    const s = LARGE_VEHICLE_SPECS[bodyType];
    return { length: s.length, width: s.width, height: s.height };
  }
  const p = CAR_PROFILES[bodyType];
  return { length: p.length, width: p.width, height: p.height };
}
