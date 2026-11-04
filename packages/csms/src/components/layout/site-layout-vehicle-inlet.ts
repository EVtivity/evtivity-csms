// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The charge inlet of a 3D layout vehicle, without three.js: which inlet a
// vehicle has for the plug it takes, the openings of that inlet (the mirror of
// the plug faces of site-layout-connectors.ts), which openings the plug fills,
// and the sizes of the inlet face, its door and the parts around it. The
// geometry is built in site-layout-model-vehicle-inlet.ts. Every value is in
// the site layout standards table.
//
// The inlet frame is the plugged handle's frame (`plugYaw`): the plug face at
// the origin facing +z (into the vehicle), x right and y up looking at the
// face from outside, the body surface `INLET.seatM` outward of the face
// (z = -seatM), everything visible further out (more negative z).

import {
  CONNECTOR_SPECS,
  faceOutline,
  type ConnectorContact,
  type ConnectorKind,
} from './site-layout-connectors';

/**
 * The inlet kinds a vehicle carries. A car takes the plug of its inlet family
 * (owner decision 2026-11-03, after how cars are built):
 * - `ccs1`: the CCS Combo 1 inlet, the J1772 AC opening over the two DC pin
 *   openings (SAE J1772 sheets C-2 and C-3). A Type 1 AC plug fills the upper
 *   part and leaves the DC openings bare; a CCS1 plug fills both. Most North
 *   American EVs have CCS1 or NACS, so a plain Type 1 inlet (an older AC-only
 *   car) is not drawn.
 * - `ccs2`: the CCS Combo 2 inlet (IEC 62196-3 configuration FF), the Type 2
 *   opening over the DC openings, filled by a Type 2 or a CCS2 plug the same way.
 * - `nacs`: the SAE J3400 inlet, one opening for AC and DC alike.
 * - `chademo_type1`, `chademo_type2`: a CHAdeMO car has two inlets side by
 *   side, the CHAdeMO inlet and a Type 1 (North America, Japan) or Type 2
 *   (Europe) AC inlet (Nissan Leaf ZE0 and ZE1, Mitsubishi Outlander PHEV);
 *   the CHAdeMO plug goes into the CHAdeMO inlet, the AC inlet keeps its cap.
 * - `mcs`: the Megawatt Charging System inlet of a heavy truck (SAE J3271,
 *   CharIN MCS).
 */
export type VehicleInletKind = 'ccs1' | 'ccs2' | 'nacs' | 'chademo_type1' | 'chademo_type2' | 'mcs';

export const VEHICLE_INLET_KINDS: readonly VehicleInletKind[] = [
  'ccs1',
  'ccs2',
  'nacs',
  'chademo_type1',
  'chademo_type2',
  'mcs',
];

/**
 * The inlet of the vehicle that takes a plug of `plug`. Both plugs of a combo
 * family give the same inlet (a Type 1 and a CCS1 plug: `ccs1`), so a car
 * never changes its inlet between an AC and a DC session. A CHAdeMO car's AC
 * inlet is Type 2 where the station offers a Type 2 or CCS2 connector (a
 * European site), else Type 1.
 */
export function vehicleInletOf(
  plug: ConnectorKind,
  stationKinds: readonly ConnectorKind[] = [],
): VehicleInletKind {
  switch (plug) {
    case 'type1':
    case 'ccs1':
      return 'ccs1';
    case 'type2':
    case 'ccs2':
      return 'ccs2';
    case 'nacs':
      return 'nacs';
    case 'mcs':
      return 'mcs';
    case 'chademo':
      return stationKinds.some((k) => k === 'type2' || k === 'ccs2')
        ? 'chademo_type2'
        : 'chademo_type1';
  }
}

/** The plug a vehicle of an inlet takes when nothing else is known (its DC plug). */
export function defaultPlugOf(inlet: VehicleInletKind): ConnectorKind {
  if (inlet === 'chademo_type1' || inlet === 'chademo_type2') return 'chademo';
  return inlet;
}

/** Whether a plug fits an inlet (a plug of the inlet's family). */
export function plugFitsInlet(inlet: VehicleInletKind, plug: ConnectorKind): boolean {
  if (inlet === 'chademo_type1' || inlet === 'chademo_type2') return plug === 'chademo';
  return vehicleInletOf(plug) === inlet;
}

/**
 * Sizes, in meters, derived where no source gives them:
 * - `seatM`: the plug face 6 mm under the body surface, so with the 8 mm inlet
 *   face and the 6 mm receptacle rims in front of the surface the plug's nose
 *   is 20 mm inside the inlet: a third of the shortest plug head (the 60 mm
 *   J1772 head), so the head and grip stay in view.
 * - `clearanceM`: the plug nose to the receptacle wall, the holster's 1.5 mm.
 * - `wallM`: the receptacle rim wall 4 mm, `rimDepthM` 6 mm out of the face.
 * - `faceM`: the inlet face 8 mm thick in front of the body.
 * - `marginM`: the inlet face 6 mm past the outermost rim. The CCS1 face is
 *   then 80 by 104 mm, inside the 108 by 151.2 mm mounting flange of a CCS1
 *   inlet (Phoenix Contact CHARX T1HBI12, 1360828) that the body panel covers;
 *   the CCS2 face 86 by 111 mm inside the 108 by 140.25 mm CCS2 flange
 *   (CHARX T2HBI, 1211212); the NACS face 64 by 66 mm inside the 80 by 80 mm
 *   NACS flange (EV West Tesla charge port data sheet).
 * - `doorMarginM`: the charge port door 4 mm past the inlet face each side,
 *   `doorThicknessM` 8 mm, a 3 mm dark shut line around the door opening.
 * - `companionGapM`: the 12 mm between the two inlets of a CHAdeMO car.
 */
export const INLET = {
  seatM: 0.006,
  clearanceM: 0.0015,
  wallM: 0.004,
  rimDepthM: 0.006,
  faceM: 0.008,
  marginM: 0.006,
  doorMarginM: 0.004,
  doorThicknessM: 0.008,
  shutLineM: 0.003,
  companionGapM: 0.012,
} as const;

/** One opening of an inlet: its outline in the inlet frame, its pins and whether a cap closes it. */
export interface InletOpening {
  /** `ac`, `dc` (the DC part of a combo inlet) or `whole` (a one-opening inlet). */
  part: 'ac' | 'dc' | 'whole';
  /** The plug outline this opening takes (the receptacle wall is this, grown by the clearance). */
  outline: Array<[number, number]>;
  /** The inlet's pins, one per contact of the plug it takes. */
  contacts: ConnectorContact[];
  /** The AC inlet of a CHAdeMO car: closed by its rubber cap. */
  capped: boolean;
}

function translate(points: ReadonlyArray<readonly [number, number]>, dx: number, dy: number) {
  return points.map(([x, y]) => [x + dx, y + dy] as [number, number]);
}

/** A horizontal oval `w` by `h` centered at y = cy, grown by `grow`, counter clockwise. */
export function ovalOutline(w: number, h: number, cy: number, grow = 0): Array<[number, number]> {
  const b = h / 2 + grow;
  const a = w / 2 + grow;
  const out: Array<[number, number]> = [];
  for (const [cx, a0] of [
    [a - b, -Math.PI / 2],
    [-a + b, Math.PI / 2],
  ] as const) {
    for (let i = 0; i <= 5; i += 1) {
      const t = a0 + (Math.PI * i) / 5;
      out.push([cx + Math.cos(t) * b, cy + Math.sin(t) * b]);
    }
  }
  return out;
}

/** The half width of an outline (its widest point from x = 0). */
function halfWidth(points: ReadonlyArray<readonly [number, number]>): number {
  return Math.max(...points.map(([x]) => Math.abs(x)));
}

/**
 * The openings of an inlet. `companionSide` is the side (in the inlet frame's
 * x) the AC inlet of a CHAdeMO car stands on: toward the middle of the car.
 */
export function inletOpenings(kind: VehicleInletKind, companionSide: -1 | 1 = 1): InletOpening[] {
  if (kind === 'ccs1' || kind === 'ccs2') {
    const ac = kind === 'ccs1' ? CONNECTOR_SPECS.type1 : CONNECTOR_SPECS.type2;
    const combo = CONNECTOR_SPECS[kind];
    return [
      { part: 'ac', outline: faceOutline(ac), contacts: [...ac.contacts], capped: false },
      {
        part: 'dc',
        outline: ovalOutline(combo.dcBlockWidthM, combo.dcBlockHeightM, combo.dcCenterYM),
        contacts: combo.contacts.filter((c) => c.role === 'dc'),
        capped: false,
      },
    ];
  }
  if (kind === 'chademo_type1' || kind === 'chademo_type2') {
    const main = CONNECTOR_SPECS.chademo;
    const ac = kind === 'chademo_type1' ? CONNECTOR_SPECS.type1 : CONNECTOR_SPECS.type2;
    const ring = INLET.clearanceM + INLET.wallM;
    const mainOutline = faceOutline(main);
    const acOutline = faceOutline(ac);
    const dx =
      companionSide *
      (halfWidth(mainOutline) + halfWidth(acOutline) + 2 * ring + INLET.companionGapM);
    return [
      { part: 'whole', outline: mainOutline, contacts: [...main.contacts], capped: false },
      {
        part: 'ac',
        outline: translate(acOutline, dx, 0),
        contacts: ac.contacts.map((c) => ({ ...c, x: c.x + dx })),
        capped: true,
      },
    ];
  }
  const spec = CONNECTOR_SPECS[kind];
  return [
    { part: 'whole', outline: faceOutline(spec), contacts: [...spec.contacts], capped: false },
  ];
}

/** Which openings a plug fills: a combo plug both parts, an AC plug the AC part, else the first. */
export function occupiedOpenings(kind: VehicleInletKind, plug: ConnectorKind | null): boolean[] {
  const openings = inletOpenings(kind);
  if (plug == null) return openings.map(() => false);
  if (kind === 'ccs1' || kind === 'ccs2') {
    const combo = plug === 'ccs1' || plug === 'ccs2';
    return openings.map((o) => combo || o.part === 'ac');
  }
  return openings.map((_, i) => i === 0);
}

/**
 * The outline the plug's face must lie in: the receptacle of the filled
 * openings, grown by the clearance (a combo plug: the combo face of the inlet,
 * neck included, as the combo inlet takes the whole plug).
 */
export function seatOutlines(
  kind: VehicleInletKind,
  plug: ConnectorKind,
): Array<Array<[number, number]>> {
  if ((kind === 'ccs1' || kind === 'ccs2') && (plug === 'ccs1' || plug === 'ccs2')) {
    return [faceOutline(CONNECTOR_SPECS[kind], INLET.clearanceM)];
  }
  const openings = inletOpenings(kind);
  const filled = occupiedOpenings(kind, plug);
  return openings
    .filter((_, i) => filled[i] === true)
    .map((o) => grownOutline(o.outline, INLET.clearanceM));
}

/** An outline grown outward by `grow` along its vertex normals (a convex-enough outline). */
export function grownOutline(
  points: ReadonlyArray<readonly [number, number]>,
  grow: number,
): Array<[number, number]> {
  const n = points.length;
  return points.map((p, i) => {
    const prev = points[(i + n - 1) % n] ?? p;
    const next = points[(i + 1) % n] ?? p;
    // The outward normal of a counter clockwise outline: the edge direction turned right.
    const e1 = norm(p[0] - prev[0], p[1] - prev[1]);
    const e2 = norm(next[0] - p[0], next[1] - p[1]);
    const nx = e1[1] + e2[1];
    const ny = -e1[0] - e2[0];
    const len = Math.hypot(nx, ny) || 1;
    // Keep the offset `grow` from both edges at a corner (miter, capped at 2x).
    const cos = Math.max(0.5, (nx / len) * e1[1] + (ny / len) * -e1[0]);
    const k = grow / cos;
    return [p[0] + (nx / len) * k, p[1] + (ny / len) * k] as [number, number];
  });
}

function norm(x: number, y: number): [number, number] {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}

export interface Bounds2 {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function boundsOf(lists: ReadonlyArray<ReadonlyArray<readonly [number, number]>>): Bounds2 {
  const pts = lists.flat();
  return {
    minX: Math.min(...pts.map((p) => p[0])),
    maxX: Math.max(...pts.map((p) => p[0])),
    minY: Math.min(...pts.map((p) => p[1])),
    maxY: Math.max(...pts.map((p) => p[1])),
  };
}

export function growBounds(b: Bounds2, d: number): Bounds2 {
  return { minX: b.minX - d, maxX: b.maxX + d, minY: b.minY - d, maxY: b.maxY + d };
}

/** The inlet face: around every receptacle rim, `INLET.marginM` past it. */
export function inletFaceBounds(kind: VehicleInletKind, companionSide: -1 | 1 = 1): Bounds2 {
  const ring = INLET.clearanceM + INLET.wallM;
  return growBounds(
    boundsOf(inletOpenings(kind, companionSide).map((o) => grownOutline(o.outline, ring))),
    INLET.marginM,
  );
}

/** The charge port door (and the opening it closes): the inlet face, `INLET.doorMarginM` past it. */
export function inletDoorBounds(kind: VehicleInletKind, companionSide: -1 | 1 = 1): Bounds2 {
  return growBounds(inletFaceBounds(kind, companionSide), INLET.doorMarginM);
}

/** How high the door opening reaches above the plug center, over every car inlet (cars never carry MCS). */
export function carInletTopAboveM(): number {
  return Math.max(
    ...VEHICLE_INLET_KINDS.filter((k) => k !== 'mcs').map(
      (k) => inletDoorBounds(k).maxY + INLET.shutLineM,
    ),
  );
}

/**
 * The open door, derived: it swings 90 degrees out on a hinge along one edge
 * of the opening, so it stands square to the body beside the plug. Any wider
 * swing needs no more room, and at 90 degrees the door is clear of the plug
 * head whenever the opening is wider than the head (`inletDoorBounds`
 * contains every receptacle, the head is the plug face plus its shell). Side
 * doors hinge on the edge toward the middle of the car (they open away from
 * the charger), a nose door on its top edge (it lifts like a lid).
 */
export const INLET_DOOR_OPEN_DEG = 90;

/** Whether every point of the plug face lies inside the seat outlines of the inlet. */
export function plugSeated(kind: VehicleInletKind, plug: ConnectorKind): boolean {
  const seats = seatOutlines(kind, plug);
  return faceOutline(CONNECTOR_SPECS[plug]).every(([x, y]) =>
    seats.some((s) => insideOrOn(s, x, y)),
  );
}

function insideOrOn(poly: ReadonlyArray<readonly [number, number]>, x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i] ?? [0, 0];
    const [xj, yj] = poly[j] ?? [0, 0];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
