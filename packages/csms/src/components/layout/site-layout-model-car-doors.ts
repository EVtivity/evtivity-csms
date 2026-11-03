// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The door details of a 3D layout car: the panel gaps of the doors (and the
// van's sliding door, the tailgate or trunk lid), flush door handles in their
// pockets, the bright belt molding and the dark window surround of the side
// glass, and the open charge port door with its outline. Built in the car's
// frame (nose at z = 0, body along +z, left side at -x) and merged per
// material slot; the car kit adds `kit.build(materials)` to its assembly.

import type { CarPort, Point3 } from './site-layout-cable';
import type { CarBodyType, CarProfile, ProfilePoint } from './site-layout-car';
import type { CarMaterials } from './site-layout-car-geometry';
import { ModelParts, boxG, frontProfileG, roundBoxG, type ModelKit } from './site-layout-model-kit';

type Slot = keyof CarMaterials;

/**
 * Sizes after common passenger car practice (no one maker): panel gaps
 * 4 to 6 mm (we draw 8 mm so they read at 3 m), a flush or pull handle
 * about 160 by 30 mm in a 190 by 50 mm pocket, its top about 90 mm below the
 * beltline; a charge port door about 200 mm square (Tesla Model 3 and
 * Y owner's manuals show a port door of about 190 by 170 mm on the rear left).
 */
export const CAR_DOOR_DETAIL = {
  gapM: 0.008,
  gapDepthM: 0.006,
  handle: { lengthM: 0.16, heightM: 0.032, standM: 0.022, belowBeltM: 0.09 },
  pocket: { lengthM: 0.19, heightM: 0.05 },
  beltMolding: { widthM: 0.02, heightM: 0.018 },
  portDoor: { sizeM: 0.2, thicknessM: 0.012, outlineOuterM: 0.26, outlineInnerM: 0.22 },
} as const;

export interface CarDoorDetailInput {
  bodyType: CarBodyType;
  profile: CarProfile;
  /** The greenhouse edge (half width) at height v. */
  edgeAt: (v: number) => number;
  /** Where along the car the B pillar stands. */
  bPillarU: number;
  chargePort: CarPort;
  port: Point3;
}

/** The top of the lower body at u: the highest profile segment over it. */
export function bodyTopAt(profile: CarProfile, u: number): number {
  let top = profile.bottom;
  for (let i = 1; i < profile.body.length; i += 1) {
    const a = profile.body[i - 1];
    const b = profile.body[i];
    if (a == null || b == null || b[0] <= a[0] || u < a[0] || u > b[0]) continue;
    top = Math.max(top, a[1] + ((b[1] - a[1]) * (u - a[0])) / (b[0] - a[0]));
  }
  return top;
}

/** The door shut lines along one side and where its handles are. */
export interface CarDoorSide {
  side: -1 | 1;
  seams: number[];
  handles: number[];
  /** A sliding door's track groove: from, to along the car. */
  track?: readonly [number, number];
}

export function carDoorLayout(input: CarDoorDetailInput): CarDoorSide[] {
  const p = input.profile;
  const g = p.glass;
  const windshieldBase = g[0] ?? [1.5, 1];
  const rearBase = g[g.length - 1] ?? [4.2, 1];
  const front = Math.max(p.frontAxle + p.wheelRadius + 0.1, windshieldBase[0] - 0.1);
  if (input.bodyType === 'van') {
    // A cab door about 1.05 m long, then a sliding door on the right.
    const cabEnd = windshieldBase[0] + 1.05;
    const slideEnd = cabEnd + 1.3;
    return [
      { side: -1, seams: [front, cabEnd], handles: [cabEnd - 0.2] },
      {
        side: 1,
        seams: [front, cabEnd, slideEnd],
        handles: [cabEnd - 0.2, cabEnd + 0.2],
        track: [slideEnd, rearBase[0] - 0.25],
      },
    ];
  }
  const rearEnd =
    input.bodyType === 'pickup_truck'
      ? rearBase[0] - 0.03
      : Math.min(p.rearAxle - p.wheelRadius - 0.12, rearBase[0] - 0.05);
  return ([-1, 1] as const).map((side) => ({
    side,
    seams: [front, input.bPillarU, rearEnd],
    handles: [input.bPillarU - 0.22, rearEnd - 0.2],
  }));
}

export function createCarDoorDetailKit(input: CarDoorDetailInput): ModelKit<Slot> {
  const d = CAR_DOOR_DETAIL;
  const p = input.profile;
  const half = p.width / 2;
  const parts = new ModelParts<Slot>();
  const sill = p.bottom + 0.1;
  for (const s of carDoorLayout(input)) {
    const x = s.side * (half + 0.001);
    for (const u of s.seams) {
      const top = bodyTopAt(p, u) - 0.05;
      parts.add('trim', boxG(d.gapDepthM, top - sill, d.gapM), { at: [x, (top + sill) / 2, u] });
    }
    // The bottom shut line along the sill, under all the doors of the side.
    const first = Math.min(...s.seams);
    const last = Math.max(...s.seams);
    parts.add('trim', boxG(d.gapDepthM, d.gapM, last - first), {
      at: [x, sill, (first + last) / 2],
    });
    for (const u of s.handles) {
      const y = bodyTopAt(p, u) - d.handle.belowBeltM;
      parts.add('trim', roundBoxG(0.004, d.pocket.heightM, d.pocket.lengthM, 0.012), {
        at: [s.side * (half + 0.002), y, u],
      });
      parts.add('rim', roundBoxG(d.handle.standM, d.handle.heightM, d.handle.lengthM, 0.012), {
        at: [s.side * (half + 0.008), y, u],
      });
    }
    if (s.track != null) {
      const [from, to] = s.track;
      const y = bodyTopAt(p, to) - 0.06;
      parts.add('trim', boxG(0.012, 0.02, to - from), { at: [x, y, (from + to) / 2] });
    }
  }
  addWindowTrim(parts, input);
  addTailSeams(parts, input);
  addPortDoor(parts, input);
  return parts.kit();
}

/** A strip from a to b (profile points) at the greenhouse edge, `out` meters outside it. */
function edgeStrip(
  parts: ModelParts<Slot>,
  slot: Slot,
  input: CarDoorDetailInput,
  a: ProfilePoint,
  b: ProfilePoint,
  size: readonly [number, number],
  out: number,
  dy: number,
): void {
  const du = b[0] - a[0];
  const dv = b[1] - a[1];
  const length = Math.hypot(du, dv);
  if (length < 0.05) return;
  const mid: ProfilePoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  for (const side of [-1, 1]) {
    parts.add(slot, boxG(size[0], size[1], length), {
      at: [side * (input.edgeAt(mid[1]) + out), mid[1] + dy, mid[0]],
      rot: [-Math.atan2(dv, du), 0, 0],
    });
  }
}

/** The bright belt molding along the bottom of the side glass and the dark surround along its top. */
function addWindowTrim(parts: ModelParts<Slot>, input: CarDoorDetailInput): void {
  const g = input.profile.glass;
  const a = g[0];
  const b = g[g.length - 1];
  if (a == null || b == null) return;
  const m = CAR_DOOR_DETAIL.beltMolding;
  edgeStrip(
    parts,
    'rim',
    input,
    [a[0] + 0.08, a[1]],
    [b[0] - 0.08, b[1]],
    [m.widthM, m.heightM],
    0.008,
    0.012,
  );
  for (let i = 2; i < g.length - 1; i += 1) {
    const from = g[i - 1];
    const to = g[i];
    if (from == null || to == null) continue;
    edgeStrip(parts, 'trim', input, from, to, [0.012, 0.035], 0.004, -0.03);
  }
}

/** The trunk lid or hatch shut line across the back, or a pickup's tailgate edges and handle. */
function addTailSeams(parts: ModelParts<Slot>, input: CarDoorDetailInput): void {
  const p = input.profile;
  const d = CAR_DOOR_DETAIL;
  const z = p.tail[0] + 0.003;
  if (input.bodyType === 'pickup_truck') {
    const top = bodyTopAt(p, p.length - 0.2) - 0.04;
    const bottom = p.bottom + 0.2;
    for (const side of [-1, 1]) {
      parts.add('trim', boxG(d.gapM, top - bottom, d.gapDepthM), {
        at: [side * (p.width / 2 - 0.08), (top + bottom) / 2, z + 0.02],
      });
    }
    parts.add('rim', roundBoxG(0.2, 0.05, 0.02, 0.01), { at: [0, top - 0.08, z + 0.025] });
    return;
  }
  parts.add('trim', boxG(p.width * 0.72, d.gapM, d.gapDepthM), { at: [0, p.tail[1] - 0.12, z] });
  if (input.bodyType === 'van') {
    // The split of the two rear doors.
    const top = bodyTopAt(p, p.length - 0.15) - 0.04;
    const bottom = p.tail[1] - 0.12;
    parts.add('trim', boxG(d.gapM, top - bottom, d.gapDepthM), { at: [0, (top + bottom) / 2, z] });
  }
}

/** The charge port: a dark outline around the socket and the open door on its hinge. */
function addPortDoor(parts: ModelParts<Slot>, input: CarDoorDetailInput): void {
  const d = CAR_DOOR_DETAIL.portDoor;
  const o = d.outlineOuterM / 2;
  const i = d.outlineInnerM / 2;
  const square = (r: number, c: number) =>
    [
      [-r + c, -r],
      [r - c, -r],
      [r, -r + c],
      [r, r - c],
      [r - c, r],
      [-r + c, r],
      [-r, r - c],
      [-r, -r + c],
    ] as const;
  const outline = (): ReturnType<typeof frontProfileG> =>
    frontProfileG(square(o, 0.03), 0.008, 0, [[...square(i, 0.025)].reverse()]);
  const { port } = input;
  if (input.chargePort === 'front_center') {
    parts.add('trim', outline(), { at: [port.x, port.y + 0.02, port.z - 0.006] });
    parts.add('paint', roundBoxG(d.sizeM, d.thicknessM, d.sizeM, 0.03), {
      at: [port.x, port.y + 0.02 + o + 0.01, port.z - d.sizeM / 2 - 0.006],
    });
    return;
  }
  const side = Math.sign(port.x) || -1;
  // The door swings away from the charger: a front port opens toward the rear.
  const away = input.chargePort.startsWith('front') ? 1 : -1;
  parts.add('trim', outline(), {
    at: [port.x + side * 0.002, port.y + 0.02, port.z],
    rot: [0, Math.PI / 2, 0],
  });
  parts.add('paint', roundBoxG(d.sizeM, d.sizeM, d.thicknessM, 0.03), {
    at: [port.x + side * (d.sizeM / 2 + 0.01), port.y + 0.02, port.z + away * (o + 0.006)],
  });
  parts.add('trim', boxG(0.02, 0.06, 0.012), {
    at: [port.x + side * 0.008, port.y + 0.02, port.z + away * o],
  });
}
