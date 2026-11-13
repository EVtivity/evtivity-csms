// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The connector handles and cables of the 3D layout, without three.js (owner
// rule 2026-11-02: each connector reads as its real type, in the holster and
// plugged into the vehicle). Face outlines, contact layouts and handle sizes
// come from the standard or manufacturer drawings cited at each spec; every
// value is in the site layout standards table.

import {
  CCS1_CONTACTS,
  CCS1_DC_Y,
  CCS2_CONTACTS,
  CCS2_DC_Y,
  J1772_CONTACTS,
  TYPE2_CONTACTS,
  connectorKindOf,
  type ConnectorContact,
  type ConnectorKind,
} from '@evtivity/lib/connector-faces';

// The kinds, the kind of a station type and the contact layouts live with the
// face pictograms in @evtivity/lib/connector-faces (one geometry source for
// the CSMS 3D handles and 2D cards and the portal plug-in animation).
export { connectorKindOf, type ConnectorContact, type ConnectorKind };

/**
 * The thickest AC charging cable the layout draws: 16.1 mm, the thickest
 * OLFLEX CHARGE AC cable (5G6+1x0.5, LAPP data sheet, EN 50620 and IEC
 * 62893-3, March 2025). An AC charger's J3400 cable is an AC cable, so it is
 * drawn at most this thick; the 25 mm J3400 cable of `CONNECTOR_SPECS` is the
 * DC one.
 */
export const AC_CABLE_MAX_DIAMETER_M = 0.0161;

/** The cable diameter of connector `kind` on a charger of that current: an AC cable at most `AC_CABLE_MAX_DIAMETER_M`. */
export function chargerCableDiameterM(kind: ConnectorKind, ac: boolean): number {
  const d = CONNECTOR_SPECS[kind].cableDiameterM;
  return ac ? Math.min(d, AC_CABLE_MAX_DIAMETER_M) : d;
}

/** Whether the kind carries DC power (the thicker cable, the DC pin block). */
export function isDcConnectorKind(kind: ConnectorKind): boolean {
  return (
    kind === 'ccs1' || kind === 'ccs2' || kind === 'chademo' || kind === 'nacs' || kind === 'mcs'
  );
}

/**
 * The shape of a connector handle, in meters, looking at its plug face (x
 * right, y up, the face at the origin facing +z):
 * - `face`: `round` (a circle `faceWidthM` across, cut flat at
 *   `flatTopRatio` of its height above the center when set, with a key tab
 *   `keyTab` at the bottom when set) or `tapered` (a flat top with rounded
 *   corners narrowing to a round bottom of `bottomRatio` of the half width:
 *   NACS and MCS);
 * - the shroud wall `lipM` thick around the dark face inserts and their
 *   contact openings;
 * - a combo plug's DC lobe under the AC face: a horizontal oval
 *   `dcBlockWidthM` by `dcBlockHeightM` centered `dcCenterYM` below the AC
 *   center, joined to the circle by a neck `neckWidthM` wide;
 * - the head `headLengthM` deep, the grip `gripLengthM` long at
 *   `gripAngleDeg` from vertical, the latch, the strain relief boot and the
 *   cable's outer diameter.
 */
export interface ConnectorSpec {
  face: 'round' | 'tapered';
  faceWidthM: number;
  faceHeightM: number;
  flatTopRatio: number | null;
  keyTab: { widthM: number; radiusM: number } | null;
  bottomRatio: number;
  lipM: number;
  dcBlockWidthM: number;
  dcBlockHeightM: number;
  dcCenterYM: number;
  neckWidthM: number;
  contacts: readonly ConnectorContact[];
  headLengthM: number;
  gripLengthM: number;
  gripDiameterM: number;
  gripAngleDeg: number;
  latch: 'thumb' | 'lever' | 'button' | 'none';
  bootLengthM: number;
  cableDiameterM: number;
}

// SAE J1772 (OCT2012) sheets A-2 and C-2 (p.43, p.51): L1 and L2/N 15.7 mm
// apart and 6.8 mm above the center, CP and PP 21.3 mm apart and 5.6 mm
// below, PE 10.8 mm below; the connector's socket openings 3.9 mm (power),
// 3.1 mm (PE) and 1.8 mm (CP, PP), detail K.

export const CONNECTOR_SPECS: Record<ConnectorKind, ConnectorSpec> = {
  // SAE J1772: the 43.8 mm round nose with an 8 mm key tab at the bottom out
  // to R25.2 (J1772 sheet A-2, p.43), the thumb latch with its hook over the
  // top, a 170 mm long handle and a 12.5 mm cable (Amphenol EXCEL MATE CC
  // catalog p.21).
  type1: {
    face: 'round',
    faceWidthM: 0.0438,
    faceHeightM: 0.0438,
    flatTopRatio: null,
    keyTab: { widthM: 0.008, radiusM: 0.0252 },
    bottomRatio: 0,
    lipM: 0.0035,
    dcBlockWidthM: 0,
    dcBlockHeightM: 0,
    dcCenterYM: 0,
    neckWidthM: 0,
    contacts: J1772_CONTACTS,
    headLengthM: 0.06,
    gripLengthM: 0.1,
    gripDiameterM: 0.038,
    gripAngleDeg: 58,
    latch: 'thumb',
    bootLengthM: 0.045,
    cableDiameterM: 0.0125,
  },
  // IEC 62196-2 Type 2: the round face with the flat top (the flat's height
  // is not published: drawn from the drawing's look), 63 mm insert face in a
  // 70 mm body, no latch on the plug (the inlet locks it), a 201 to 216 mm
  // long handle (Phoenix Contact p.6, Amphenol p.10); cable 16 mm (Mennekes
  // 36213, 32 A three phase).
  type2: {
    face: 'round',
    faceWidthM: 0.063,
    faceHeightM: 0.063,
    flatTopRatio: 0.31,
    keyTab: null,
    bottomRatio: 0,
    lipM: 0.0035,
    dcBlockWidthM: 0,
    dcBlockHeightM: 0,
    dcCenterYM: 0,
    neckWidthM: 0,
    contacts: TYPE2_CONTACTS,
    headLengthM: 0.075,
    gripLengthM: 0.11,
    gripDiameterM: 0.042,
    gripAngleDeg: 55,
    latch: 'none',
    bootLengthM: 0.05,
    cableDiameterM: 0.016,
  },
  // CCS1: the J1772 nose over the oval DC lobe 59 mm wide, joined by the
  // 8 mm key neck, the DC pins 8 mm, 26 mm apart, their center 42 mm below
  // the AC center (J1772 sheets C-2 and C-3, p.51-52); the plug fills only
  // PE, CP and PP of the AC face (Wikipedia, Combined Charging System,
  // secondary); a 269 mm long, 67 mm wide handle with the release button on
  // top (Amphenol p.24); 200 A cable 35.3 mm (Phoenix Contact 1387212,
  // secondary). The lobe height and the DC opening (pin plus 1 mm) are not
  // published.
  ccs1: {
    face: 'round',
    faceWidthM: 0.0438,
    faceHeightM: 0.0438,
    flatTopRatio: null,
    keyTab: null,
    bottomRatio: 0,
    lipM: 0.0035,
    dcBlockWidthM: 0.059,
    dcBlockHeightM: 0.034,
    dcCenterYM: CCS1_DC_Y,
    neckWidthM: 0.008,
    contacts: CCS1_CONTACTS,
    headLengthM: 0.09,
    gripLengthM: 0.12,
    gripDiameterM: 0.048,
    gripAngleDeg: 52,
    latch: 'thumb',
    bootLengthM: 0.08,
    cableDiameterM: 0.0353,
  },
  // CCS2 (IEC 62196-3 FF): the Type 2 face with CP, PP and PE only
  // (Wikipedia, Combined Charging System, secondary) over the DC lobe 60 mm
  // wide, a 267 mm long, 70 mm wide handle (Amphenol p.16-17), DC pins 8 mm
  // (TE 114-94467 p.4). Not published, drawn as CCS1: the 26 mm pin pitch,
  // the lobe height, the gap under the AC circle and the neck. 200 A cable
  // 28.1 mm (RS Components, secondary).
  ccs2: {
    face: 'round',
    faceWidthM: 0.063,
    faceHeightM: 0.063,
    flatTopRatio: 0.31,
    keyTab: null,
    bottomRatio: 0,
    lipM: 0.0035,
    dcBlockWidthM: 0.06,
    dcBlockHeightM: 0.034,
    dcCenterYM: CCS2_DC_Y,
    neckWidthM: 0.008,
    contacts: CCS2_CONTACTS,
    headLengthM: 0.09,
    gripLengthM: 0.12,
    gripDiameterM: 0.048,
    gripAngleDeg: 52,
    latch: 'none',
    bootLengthM: 0.08,
    cableDiameterM: 0.0281,
  },
  // CHAdeMO: the 70 mm face in an 86 mm body (Fujikura, CHAdeMO
  // Association connector status p.6; the JE handle is 81 mm wide), two 9 mm
  // DC pins side by side in the lower half and the eight 1.5 mm control
  // contacts in the upper half (TE 114-94574 p.4 and Wikipedia CHAdeMO, the
  // positions within each half are drawn, not published), the locking lever
  // on top at the rear (Sumitomo, SEI Technical Review 84 p.29-31; the JE
  // handle uses a release button instead), a 270 mm long handle and a 25.9 mm
  // cable for 35 mm2 (JE / Obara datasheet p.1).
  chademo: {
    face: 'round',
    faceWidthM: 0.086,
    faceHeightM: 0.086,
    flatTopRatio: null,
    keyTab: null,
    bottomRatio: 0,
    lipM: 0.008,
    dcBlockWidthM: 0,
    dcBlockHeightM: 0,
    dcCenterYM: 0,
    neckWidthM: 0,
    contacts: [
      { x: -0.0125, y: -0.011, d: 0.01, role: 'dc' },
      { x: 0.0125, y: -0.011, d: 0.01, role: 'dc' },
      ...[-1.05, -0.75, -0.45, -0.15, 0.15, 0.45, 0.75, 1.05].map(
        (a): ConnectorContact => ({
          x: Math.sin(a) * 0.022,
          y: Math.cos(a) * 0.022 - 0.004,
          d: 0.0025,
          role: a === -1.05 ? 'ground' : 'signal',
        }),
      ),
    ],
    headLengthM: 0.16,
    gripLengthM: 0.12,
    gripDiameterM: 0.05,
    gripAngleDeg: 40,
    latch: 'lever',
    bootLengthM: 0.08,
    cableDiameterM: 0.0259,
  },
  // NACS (Tesla TS-0023666 p.12-20, SAE J3400): a flat-topped face 41 mm
  // wide narrowing to its bottom, about 43 mm high (scaled from p.13), the
  // two power sockets (9.6 mm openings) at the top 21.5 mm apart, PE (4.2 mm
  // opening) at the bottom center and CP and PP (2.2 mm openings) at the
  // bottom 17 mm apart, 16.52 and 15.92 mm below the power axes; a 224 mm
  // long DC handle with the button on top (Amphenol NACS catalog p.31 and
  // p.33). Cable: no source.
  nacs: {
    face: 'tapered',
    faceWidthM: 0.041,
    faceHeightM: 0.043,
    flatTopRatio: null,
    keyTab: null,
    bottomRatio: 0.85,
    lipM: 0.0035,
    dcBlockWidthM: 0,
    dcBlockHeightM: 0,
    dcCenterYM: 0,
    neckWidthM: 0,
    contacts: [
      { x: -0.01075, y: 0.0075, d: 0.0096, role: 'power' },
      { x: 0.01075, y: 0.0075, d: 0.0096, role: 'power' },
      { x: 0, y: 0.0075 - 0.01652, d: 0.0042, role: 'ground' },
      { x: -0.0085, y: 0.0075 - 0.01592, d: 0.0022, role: 'signal' },
      { x: 0.0085, y: 0.0075 - 0.01592, d: 0.0022, role: 'signal' },
    ],
    headLengthM: 0.07,
    gripLengthM: 0.11,
    gripDiameterM: 0.04,
    gripAngleDeg: 74,
    latch: 'button',
    bootLengthM: 0.055,
    cableDiameterM: 0.025,
  },
  // MCS (CharIN Ruggedized MCS white paper v1.3 p.11-13, CHAdeMO Ultra-ChaoJi
  // coupler report p.4): a rounded triangle pointing down, 116 by 102 mm, DC+
  // and DC- at the top, PE (8 mm) at the bottom center and the four signal
  // contacts in a 2 by 2 cluster in the middle, the lever on top at the rear,
  // a 395 to 400 mm long handle 121 to 125 mm wide (Yonggui MCS
  // specification p.5, Amphenol p.18). DC opening diameter estimated from
  // the Amphenol drawing; signal diameters and the cable have no source.
  mcs: {
    face: 'tapered',
    faceWidthM: 0.116,
    faceHeightM: 0.102,
    flatTopRatio: null,
    keyTab: null,
    bottomRatio: 0.45,
    lipM: 0.008,
    dcBlockWidthM: 0,
    dcBlockHeightM: 0,
    dcCenterYM: 0,
    neckWidthM: 0,
    contacts: [
      { x: -0.027, y: 0.016, d: 0.022, role: 'dc' },
      { x: 0.027, y: 0.016, d: 0.022, role: 'dc' },
      { x: 0, y: -0.03, d: 0.009, role: 'ground' },
      { x: -0.006, y: 0.004, d: 0.004, role: 'signal' },
      { x: 0.006, y: 0.004, d: 0.004, role: 'signal' },
      { x: -0.006, y: -0.008, d: 0.004, role: 'signal' },
      { x: 0.006, y: -0.008, d: 0.004, role: 'signal' },
    ],
    headLengthM: 0.16,
    gripLengthM: 0.2,
    gripDiameterM: 0.07,
    gripAngleDeg: 45,
    latch: 'lever',
    bootLengthM: 0.1,
    cableDiameterM: 0.08,
  },
};

/** The height of a face's top edge above its center (the flat of a flat-topped face). */
export function faceTopY(spec: ConnectorSpec): number {
  const h = spec.faceHeightM / 2;
  return spec.flatTopRatio == null ? h : Math.min(h, spec.faceHeightM * spec.flatTopRatio);
}

/**
 * The outline of a plug face (`ConnectorSpec.face` and its DC lobe), counter
 * clockwise, grown outward by `grow` meters (a negative grow shrinks it: the
 * insert inside the shroud wall; a positive one the holster cup).
 */
export function faceOutline(spec: ConnectorSpec, grow = 0): Array<[number, number]> {
  const w = spec.faceWidthM / 2 + grow;
  const h = spec.faceHeightM / 2 + grow;
  const pts: Array<[number, number]> = [];
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n: number): void => {
    for (let i = 0; i <= n; i += 1) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  };
  if (spec.face === 'tapered') {
    // Rounded top corners, straight sides tangent to the round bottom.
    const rt = w * 0.25;
    const rb = (spec.faceWidthM / 2) * spec.bottomRatio + grow;
    const cb = { x: 0, y: -h + rb };
    const ct = { x: w - rt, y: h - rt };
    // The outer tangent of the right corner circle and the bottom circle: its
    // outward normal at angle t touches both, so (cb - ct) . n = rt - rb.
    const phi = Math.atan2(cb.y - ct.y, cb.x - ct.x);
    const t = phi + Math.acos((rt - rb) / Math.hypot(cb.x - ct.x, cb.y - ct.y));
    arc(ct.x, ct.y, rt, t, Math.PI / 2, 6);
    arc(-ct.x, ct.y, rt, Math.PI / 2, Math.PI - t, 6);
    arc(cb.x, cb.y, rb, Math.PI - t, Math.PI * 2 + t, 12);
    return dedupe(pts);
  }
  const r = w;
  const flatY = spec.flatTopRatio == null ? Infinity : spec.faceHeightM * spec.flatTopRatio + grow;
  // The circle from the right edge of the bottom key tab or neck over the top to its left edge.
  const neck = spec.dcBlockHeightM > 0 ? spec.neckWidthM : (spec.keyTab?.widthM ?? 0);
  const half = Math.min(neck / 2 + grow, r * 0.9);
  const start = neck > 0 ? -Math.acos(half / r) : -Math.PI / 2;
  const end = neck > 0 ? Math.PI - start : Math.PI * 1.5;
  const n = spec.dcBlockHeightM > 0 ? 16 : 20;
  for (let i = 0; i <= n; i += 1) {
    const t = start + ((end - start) * i) / n;
    pts.push([Math.cos(t) * r, Math.min(Math.sin(t) * r, flatY)]);
  }
  if (neck <= 0) {
    pts.pop();
    return dedupe(pts);
  }
  if (spec.dcBlockHeightM <= 0) {
    // The key tab: straight sides down to its radius.
    const bottom = -((spec.keyTab?.radiusM ?? r) + grow);
    pts.push([-half, bottom], [half, bottom]);
    return dedupe(pts);
  }
  // The neck down to the DC lobe, a horizontal oval, and back up.
  const b = spec.dcBlockHeightM / 2 + grow;
  const a = spec.dcBlockWidthM / 2 + grow;
  const yc = spec.dcCenterYM;
  pts.push([-half, yc + b]);
  arc(-a + b, yc, b, Math.PI / 2, Math.PI * 1.5, 5);
  arc(a - b, yc, b, -Math.PI / 2, Math.PI / 2, 5);
  pts.push([half, yc + b]);
  return dedupe(pts);
}

/**
 * The dark face inserts inside the shroud wall: the face outline shrunk by
 * the wall, as one outline, or the AC circle and the DC oval of a combo plug
 * apart (the neck and the key tab carry no insert).
 */
export function insertOutlines(spec: ConnectorSpec): Array<Array<[number, number]>> {
  if (spec.face === 'tapered') return [faceOutline(spec, -spec.lipM)];
  const plain: ConnectorSpec = { ...spec, keyTab: null, dcBlockHeightM: 0, neckWidthM: 0 };
  const ac = faceOutline(plain, -spec.lipM);
  if (spec.dcBlockHeightM <= 0) return [ac];
  const b = spec.dcBlockHeightM / 2 - spec.lipM;
  const a = spec.dcBlockWidthM / 2 - spec.lipM;
  const dc: Array<[number, number]> = [];
  for (const [cx, a0] of [
    [a - b, -Math.PI / 2],
    [-a + b, Math.PI / 2],
  ] as const) {
    for (let i = 0; i <= 5; i += 1) {
      const t = a0 + (Math.PI * i) / 5;
      dc.push([cx + Math.cos(t) * b, spec.dcCenterYM + Math.sin(t) * b]);
    }
  }
  return [ac, dc];
}

function dedupe(pts: Array<[number, number]>): Array<[number, number]> {
  return pts.filter((p, i) => {
    const q = pts[(i + pts.length - 1) % pts.length];
    return q == null || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6;
  });
}

/** The lowest point of a plug face (the DC lobe of a combo plug). */
export function faceBottomY(spec: ConnectorSpec): number {
  if (spec.dcBlockHeightM > 0) return spec.dcCenterYM - spec.dcBlockHeightM / 2;
  return -(spec.keyTab?.radiusM ?? spec.faceHeightM / 2);
}

/** The grip of a handle in its side frame (u along +z, v up): from the back of the head, `gripAngleDeg` from vertical, down and back to the boot. */
export function gripAxis(kind: ConnectorKind): {
  start: { u: number; v: number };
  end: { u: number; v: number };
  dir: { u: number; v: number };
} {
  const spec = CONNECTOR_SPECS[kind];
  const angle = (spec.gripAngleDeg * Math.PI) / 180;
  const dir = { u: -Math.sin(angle), v: -Math.cos(angle) };
  const top = faceTopY(spec);
  const cy = (top + faceBottomY(spec)) / 2;
  const start = { u: -spec.headLengthM * 0.9, v: cy + (top - cy) * 0.35 };
  const end = {
    u: start.u + dir.u * spec.gripLengthM,
    v: start.v + dir.v * spec.gripLengthM,
  };
  return { start, end, dir };
}

/** The holster cup a handle's nose seats in: clearance around the face outline, wall, depth, plate. */
export const HOLSTER = { clearanceM: 0.0015, wallM: 0.005, cupDepthM: 0.04, plateM: 0.01 };

/** From the charger surface to the holster cup mouth. */
export const HOLSTER_DEPTH_M = HOLSTER.cupDepthM + HOLSTER.plateM;

/** How far the plug face sits inside the cup mouth. */
export const HOLSTER_SEAT_M = HOLSTER.cupDepthM - 0.006;

/**
 * A holster on a charger surface: its plate against the surface at `mount`,
 * the cup mouth `HOLSTER_DEPTH_M` out along its axis, and the handle seated
 * nose first with its face `HOLSTER_SEAT_M` inside the mouth, turned to face
 * back into the cup. The axis is `facing` (a unit vector on the ground plane)
 * tipped `noseUp` radians down, so the handle's face points that much up
 * into the cup (a wall box dock, `wallBoxHolsterMount`); 0 keeps it level.
 * The handle and the holster turn by `handleYaw` and `holsterYaw` about the
 * vertical, then by `handleTilt` and `holsterTilt` about their own lateral
 * axis (three.js Euler order `YXZ`).
 */
export function holsterPose(
  mount: { x: number; y: number; z: number },
  facing: { x: number; z: number },
  noseUp = 0,
): {
  mouth: { x: number; y: number; z: number };
  holsterYaw: number;
  holsterTilt: number;
  handle: { x: number; y: number; z: number };
  handleYaw: number;
  handleTilt: number;
  noseUp: number;
} {
  const c = {
    x: facing.x * Math.cos(noseUp),
    y: -Math.sin(noseUp),
    z: facing.z * Math.cos(noseUp),
  };
  const mouth = {
    x: mount.x + c.x * HOLSTER_DEPTH_M,
    y: mount.y + c.y * HOLSTER_DEPTH_M,
    z: mount.z + c.z * HOLSTER_DEPTH_M,
  };
  const inset = HOLSTER_DEPTH_M - HOLSTER_SEAT_M;
  return {
    mouth,
    holsterYaw: Math.atan2(facing.x, facing.z),
    holsterTilt: noseUp,
    handle: { x: mount.x + c.x * inset, y: mount.y + c.y * inset, z: mount.z + c.z * inset },
    handleYaw: Math.atan2(-facing.x, -facing.z),
    handleTilt: -noseUp,
    noseUp,
  };
}

/**
 * A point of a handle's side frame (`y` up, `z` along its face) in the scene
 * frame of a handle at `at` turned `yaw` about the vertical and its face
 * tipped `noseUp` radians up (`holsterPose`).
 */
export function handleFramePoint(
  at: { x: number; y: number; z: number },
  yaw: number,
  local: { y: number; z: number },
  noseUp = 0,
): [number, number, number] {
  const y = local.y * Math.cos(noseUp) + local.z * Math.sin(noseUp);
  const z = -local.y * Math.sin(noseUp) + local.z * Math.cos(noseUp);
  return [at.x + Math.sin(yaw) * z, at.y + y, at.z + Math.cos(yaw) * z];
}

/** The thickest cable of a set of connectors (the cable a unit draws to a vehicle). */
export function cableRadiusOf(kinds: readonly ConnectorKind[]): number {
  if (kinds.length === 0) return CONNECTOR_SPECS.type1.cableDiameterM / 2;
  return Math.max(...kinds.map((k) => CONNECTOR_SPECS[k].cableDiameterM)) / 2;
}

/**
 * A holster of one charger unit: which EVSE and connector it holds, the side
 * of the unit (-1 left, +1 right) and how far back along that side wall it
 * sits from the front holster. All holsters of a unit hang at one height
 * (multi-connector dispensers put them side by side, never one near the
 * ground). Two EVSEs: the first on the left, the second on the right, a
 * second connector of an EVSE `HOLSTER_PITCH_M` behind its first
 * (`CHARGER_PORT_LIMITS`). One EVSE: its connectors left, right, then the
 * second pair behind them.
 */
export interface HolsterSlot {
  evse: number;
  connector: number;
  side: -1 | 1;
  backM: number;
}

/**
 * The pitch of two holsters side by side on one wall, derived: the widest
 * handle head (the 86 mm CHAdeMO face plus its 15 mm shell each side,
 * 0.116 m) plus a 0.1 m hand's width to grip one handle beside the other,
 * plus the two 15 mm holster plate margins, 0.246 m, rounded up to 0.25 m.
 */
export const HOLSTER_PITCH_M = 0.25;

export function holsterSlots(evseConnectors: readonly number[]): HolsterSlot[] {
  if (evseConnectors.length >= 2) {
    return evseConnectors.slice(0, 2).flatMap((n, evse) =>
      Array.from({ length: Math.max(1, n) }, (_, connector) => ({
        evse,
        connector,
        side: evse === 0 ? -1 : 1,
        backM: connector * HOLSTER_PITCH_M,
      })),
    );
  }
  const n = Math.max(1, evseConnectors[0] ?? 1);
  return Array.from({ length: n }, (_, k) => ({
    evse: 0,
    connector: k,
    side: k % 2 === 0 ? -1 : 1,
    backM: k >= 2 ? HOLSTER_PITCH_M : 0,
  }));
}

/**
 * The pose of a connector plugged into a car's port: at the port with its
 * plug face into the car, `yaw` the turn about the vertical axis that points
 * the handle's +z axis (its face) into the port: +x for a port on the car's
 * left (-x) side, -x on the right, +z for a nose port.
 */
export function plugYaw(port: { x: number }, carX: number, nosePort: boolean): number {
  if (nosePort) return 0;
  return port.x < carX ? Math.PI / 2 : -Math.PI / 2;
}

/**
 * Where the cable starts, in the handle's frame (the plug face at the origin
 * facing +z): inside the strain relief boot, a quarter of its length short of
 * its tip, so the cable end never shows past the boot whatever way it leaves.
 */
export function handleCableEndLocal(kind: ConnectorKind): { y: number; z: number } {
  const { end, dir } = gripAxis(kind);
  const boot = CONNECTOR_SPECS[kind].bootLengthM * 0.75;
  return { y: end.v + dir.v * boot, z: end.u + dir.u * boot };
}

/** The tip of the strain relief boot, in the handle's frame: the end of the grip plus the boot length along the grip. */
export function bootTipLocal(kind: ConnectorKind): { y: number; z: number } {
  const { end, dir } = gripAxis(kind);
  const boot = CONNECTOR_SPECS[kind].bootLengthM;
  return { y: end.v + dir.v * boot, z: end.u + dir.u * boot };
}

/** How far out of the boot, along its axis, a cable runs straight before it bends away. */
export const CABLE_LEAD_M = 0.05;

/**
 * Where a handle's cable runs in, in the scene frame of a handle at `at`
 * turned `yaw`: `lead` on the boot axis `CABLE_LEAD_M` out of the boot tip,
 * then `end` inside the boot (`handleCableEndLocal`). A cable route through
 * `lead` to `end` enters the boot straight along its axis, so no gap shows
 * between the cable and the handle from any side.
 */
export interface CableEntry {
  end: [number, number, number];
  lead: [number, number, number];
}

export function handleCableEntry(
  at: { x: number; y: number; z: number },
  yaw: number,
  kind: ConnectorKind,
  noseUp = 0,
): CableEntry {
  const tip = bootTipLocal(kind);
  const { dir } = gripAxis(kind);
  const lead = { y: tip.y + dir.v * CABLE_LEAD_M, z: tip.z + dir.u * CABLE_LEAD_M };
  return {
    end: plugCableEnd(at, yaw, kind, noseUp),
    lead: handleFramePoint(at, yaw, lead, noseUp),
  };
}

/** A cable route that ends at a handle: its last point replaced by the way in through the boot. */
export function cableIntoHandle(
  route: ReadonlyArray<readonly [number, number, number]>,
  entry: CableEntry,
): Array<[number, number, number]> {
  return [
    ...route.slice(0, -1).map((p): [number, number, number] => [p[0], p[1], p[2]]),
    entry.lead,
    entry.end,
  ];
}

/** Where the cable leaves a handle placed at `at`, turned `yaw` and its face tipped `noseUp` up (its face toward +z turned by them). */
export function plugCableEnd(
  at: { x: number; y: number; z: number },
  yaw: number,
  kind: ConnectorKind,
  noseUp = 0,
): [number, number, number] {
  return handleFramePoint(at, yaw, handleCableEndLocal(kind), noseUp);
}
