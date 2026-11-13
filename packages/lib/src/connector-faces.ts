// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The connector face pictograms, without React: the kinds, the contact
// layouts of the standards (shared with the CSMS 3D handles), the face
// outlines and the drawing rules. The CSMS 2D charger cards and the portal
// plug-in animation both draw from here (owner decisions 2026-11-02,
// 2026-11-03 and 2026-11-12).

/** The connector types the layout draws. */
export type ConnectorKind = 'type1' | 'type2' | 'ccs1' | 'ccs2' | 'chademo' | 'nacs' | 'mcs';

/**
 * The station connector type spellings (OCPP 1.6, 2.x and CSMS) of each kind,
 * compared lowercase with everything but letters and digits removed.
 */
export const CONNECTOR_KIND_ALIASES: Readonly<Record<string, ConnectorKind>> = {
  ctype1: 'type1',
  type1: 'type1',
  j1772: 'type1',
  stype1: 'type1',
  ctype2: 'type2',
  type2: 'type2',
  stype2: 'type2',
  cccs1: 'ccs1',
  ccs1: 'ccs1',
  combo1: 'ccs1',
  cccs2: 'ccs2',
  ccs2: 'ccs2',
  combo2: 'ccs2',
  chademo: 'chademo',
  cg105: 'chademo',
  nacs: 'nacs',
  tesla: 'nacs',
  ctesla: 'nacs',
  j3400: 'nacs',
  mcs: 'mcs',
  cmcs: 'mcs',
};

/** The connector kind a station connector type names (OCPP 1.6, 2.x and CSMS spellings); null when it names none. */
export function knownConnectorKind(type: string | null | undefined): ConnectorKind | null {
  const t = (type ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return Object.hasOwn(CONNECTOR_KIND_ALIASES, t) ? (CONNECTOR_KIND_ALIASES[t] ?? null) : null;
}

/** The connector kind of a station connector type (OCPP 1.6, 2.x and CSMS spellings), by the charging kind when unknown. */
export function connectorKindOf(type: string | null | undefined, dc: boolean): ConnectorKind {
  return knownConnectorKind(type) ?? (dc ? 'ccs1' : 'type1');
}

/** A contact opening of a plug face: its center from the face center (x right, y up, looking at the face) and its diameter. */
export interface ConnectorContact {
  x: number;
  y: number;
  d: number;
  role: 'power' | 'ground' | 'signal' | 'dc';
}

export const J1772_CONTACTS: ConnectorContact[] = [
  { x: -0.00785, y: 0.0068, d: 0.0039, role: 'power' },
  { x: 0.00785, y: 0.0068, d: 0.0039, role: 'power' },
  { x: 0, y: -0.0108, d: 0.0031, role: 'ground' },
  { x: -0.01065, y: -0.0056, d: 0.0018, role: 'signal' },
  { x: 0.01065, y: -0.0056, d: 0.0018, role: 'signal' },
];
// IEC 62196-2 Type 2 (Phoenix Contact EV-T2G3C datasheet p.7): CP and PP
// small at the top by the flat, N, PE and L1 across the middle, L3 and L2 at
// the bottom; power and PE pins 6 mm, CP and PP 3 mm (eeNews Europe,
// secondary). The pitch is not published: drawn to fill the 63 mm insert
// face as on the drawing.
export const TYPE2_CONTACTS: ConnectorContact[] = [
  { x: -0.0075, y: 0.0125, d: 0.004, role: 'signal' },
  { x: 0.0075, y: 0.0125, d: 0.004, role: 'signal' },
  { x: -0.0155, y: 0, d: 0.007, role: 'power' },
  { x: 0, y: 0, d: 0.007, role: 'ground' },
  { x: 0.0155, y: 0, d: 0.007, role: 'power' },
  { x: -0.009, y: -0.0145, d: 0.007, role: 'power' },
  { x: 0.009, y: -0.0145, d: 0.007, role: 'power' },
];

// The CCS1 DC center 42 mm below the AC center (J1772 sheet C-2, p.51).
export const CCS1_DC_Y = -0.042;
// CCS2: not published; the CCS1 gap between the AC circle and the DC lobe kept.
export const CCS2_DC_Y = -(0.0315 + (0.042 - 0.0219 - 0.017) + 0.017);

/** The CCS1 plug contacts: PE, PP and CP of the J1772 face, then DC+ and DC-. */
export const CCS1_CONTACTS: readonly ConnectorContact[] = [
  ...J1772_CONTACTS.filter((c) => c.role !== 'power'),
  { x: -0.013, y: CCS1_DC_Y, d: 0.009, role: 'dc' },
  { x: 0.013, y: CCS1_DC_Y, d: 0.009, role: 'dc' },
];

/** The CCS2 plug contacts: CP, PP and PE of the Type 2 face, then DC+ and DC-. */
export const CCS2_CONTACTS: readonly ConnectorContact[] = [
  ...TYPE2_CONTACTS.filter((c) => c.role !== 'power'),
  { x: -0.013, y: CCS2_DC_Y, d: 0.009, role: 'dc' },
  { x: 0.013, y: CCS2_DC_Y, d: 0.009, role: 'dc' },
];

// The frame every connector face pictogram of the 2D site layout card shares
// (owner decisions 2026-11-02 and 2026-11-03): the face outline at true
// proportions, its contacts at their measured centers, all in one color with
// the inside left open so the card background shows through. Each type's
// measurements (millimeters, origin at the face center, y down) live in its
// own file with their sources; this module scales them into the 16 by 16 view.
//
// Size rules: at 16 and 20 px only the outline and the power and earth
// contacts show, as solid dots (the signal contacts cannot resolve); from
// 24 px the power and earth contacts are rings and the signal contacts dots.
// Small sizes use a heavier line, and the outline reads heavier than the
// contacts. Every contact keeps its measured center, drawn small enough to
// keep clear space to every other stroke (`faceDrawing`).

/** A point of a face outline, in millimeters (y down). */
export type FacePoint = readonly [number, number];

export interface FaceContact {
  /** The contact's name in its standard (L1, PE, CP, DC+ and so on). */
  name: string;
  /** Center, in millimeters from the face center (y down). */
  x: number;
  y: number;
  /** The diameter drawn at most: the contact's socket opening, in millimeters. */
  d: number;
  /** Power and earth contacts always show; signal contacts from 24 px. */
  role: 'power' | 'earth' | 'signal';
  /** A signal contact drawn as a ring rather than a dot (where large enough). */
  ring?: boolean | undefined;
}

export interface FaceGeometry {
  /** The face outline, a closed polygon in millimeters (y down). */
  outline: readonly FacePoint[];
  contacts: readonly FaceContact[];
}

/** The rendered sizes the pictograms are tuned for, in px. */
export type ConnectorIconSize = 16 | 20 | 24 | 48;

const VIEW = 16;
const MARGIN = 1;
/** The outline stroke at each size, in view units (16 units across): heavier when small. */
export const FACE_STROKE: Record<ConnectorIconSize, number> = {
  16: 1.25,
  20: 1.15,
  24: 1.0,
  48: 0.7,
};
/** The smallest dot radius drawn, in view units. */
const MIN_DOT_R = 0.35;
/** A power or earth contact is drawn at least this many times the size of a signal contact. */
export const POWER_TO_SIGNAL = 1.6;
/** The contact ring line, as a share of the outline line (the outline reads heavier). */
const CONTACT_STROKE_SHARE = 0.65;

/** Points of an arc around (cx, cy), radius r, from angle a0 to a1 (radians, y down). */
export function arcPoints(
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  steps = 24,
): FacePoint[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / steps;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as const;
  });
}

/** The convex hull of some circles (a rounded polygon: each corner the arc of its circle). */
export function hullOfCircles(
  circles: ReadonlyArray<{ x: number; y: number; r: number }>,
  steps = 96,
): FacePoint[] {
  const pts: Array<[number, number]> = [];
  for (const c of circles) {
    for (let i = 0; i < steps; i++) {
      const a = (2 * Math.PI * i) / steps;
      pts.push([c.x + Math.cos(a) * c.r, c.y + Math.sin(a) * c.r]);
    }
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: FacePoint, a: FacePoint, b: FacePoint): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Array<[number, number]>): FacePoint[] => {
    const out: FacePoint[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2] ?? p, out[out.length - 1] ?? p, p) <= 0) {
        out.pop();
      }
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half([...pts].reverse())];
}

export interface FaceTransform {
  /** View units per millimeter. */
  scale: number;
  x: (mm: number) => number;
  y: (mm: number) => number;
}

/** How a geometry maps into the view: millimeters to view units, the outline centered. */
export function faceTransform(g: FaceGeometry): FaceTransform {
  const xs = g.outline.map((p) => p[0]);
  const ys = g.outline.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const scale = (VIEW - 2 * MARGIN) / Math.max(maxX - minX, maxY - minY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    scale,
    x: (mm) => VIEW / 2 + (mm - cx) * scale,
    y: (mm) => VIEW / 2 + (mm - cy) * scale,
  };
}

export function r3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function polygon(points: readonly FacePoint[], t: FaceTransform): string {
  const path = points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${String(r3(t.x(x)))} ${String(r3(t.y(y)))}`)
    .join('');
  return `${path}Z`;
}

/** The distance from a point to a closed polyline. */
export function distanceToOutline(
  x: number,
  y: number,
  points: ReadonlyArray<readonly [number, number]>,
): number {
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a == null || b == null) continue;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = dx * dx + dy * dy;
    const u = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len));
    best = Math.min(best, Math.hypot(x - (a[0] + u * dx), y - (a[1] + u * dy)));
  }
  return best;
}

export interface DrawnContact {
  name: string;
  cx: number;
  cy: number;
  /** The circle radius; a ring's outer edge is `r + stroke / 2`, a dot's is `r`. */
  r: number;
  ring: boolean;
  stroke: number;
  /** The outer edge radius (the ring's outer stroke edge, or the dot). */
  edge: number;
}

export interface DrawnFace {
  outline: string;
  /** The face outline, in view units (for the spacing checks). */
  outlinePoints: Array<readonly [number, number]>;
  /** The outline line width, and the contact ring line width (lighter). */
  stroke: number;
  contactStroke: number;
  /** The clear space kept between any two strokes: a contact stroke, at least 1 device px. */
  gap: number;
  contacts: DrawnContact[];
}

/**
 * What a face draws at a size. Every contact keeps its measured center and
 * is drawn at most its measured size, less where it would come within `gap`
 * of the outline's stroke or another contact (two contacts too close shrink
 * together, in proportion). Signal contacts (from 24 px) are at most the
 * smallest power or earth contact over `POWER_TO_SIGNAL`, and are left out
 * where that leaves them too small to draw.
 */
export function faceDrawing(g: FaceGeometry, size: ConnectorIconSize): DrawnFace {
  const t = faceTransform(g);
  const stroke = FACE_STROKE[size];
  const contactStroke = stroke * CONTACT_STROKE_SHARE;
  const gap = Math.max(contactStroke, VIEW / size);
  const small = size < 24;
  const outlinePoints = g.outline.map(([x, y]) => [t.x(x), t.y(y)] as const);
  type Sized = { c: FaceContact; x: number; y: number; e: number };
  const sized = (c: FaceContact): Sized => {
    const x = t.x(c.x);
    const y = t.y(c.y);
    const room = distanceToOutline(x, y, outlinePoints) - stroke / 2 - gap;
    return { c, x, y, e: Math.max(0, Math.min((c.d / 2) * t.scale, room)) };
  };
  // Shrinks every pair of `list` that comes within the gap, in proportion,
  // and each of `list` that comes within the gap of a fixed one.
  const separate = (list: Sized[], fixed: readonly Sized[] = []): void => {
    for (let pass = 0; pass < 24; pass++) {
      let changed = false;
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (a == null) continue;
        for (const f of fixed) {
          const limit = Math.hypot(a.x - f.x, a.y - f.y) - gap - f.e;
          if (a.e > limit + 1e-9) {
            a.e = Math.max(0, limit);
            changed = true;
          }
        }
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j];
          if (b == null) continue;
          const room = Math.hypot(a.x - b.x, a.y - b.y) - gap;
          if (a.e + b.e > room + 1e-9) {
            const k = Math.max(0, room) / (a.e + b.e);
            a.e *= k;
            b.e *= k;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
  };
  const power = g.contacts.filter((c) => c.role !== 'signal').map(sized);
  separate(power);
  let signals: Sized[] = [];
  if (!small && power.length > 0) {
    const cap = Math.min(...power.map((p) => p.e)) / POWER_TO_SIGNAL;
    signals = g.contacts
      .filter((c) => c.role === 'signal')
      .map(sized)
      .map((sg) => ({ ...sg, e: Math.min(sg.e, cap) }));
    separate(signals, power);
    signals = signals.filter((sg) => sg.e >= MIN_DOT_R);
  }
  const contacts: DrawnContact[] = [...power, ...signals].map(({ c, x, y, e }) => {
    // A ring needs room for its hole: power and earth from 1.5 line widths, a
    // signal contact drawn as a ring from 1.2.
    const ring =
      !small &&
      (c.role !== 'signal'
        ? e >= 1.5 * contactStroke
        : c.ring === true && e >= 1.2 * contactStroke);
    return ring
      ? {
          name: c.name,
          cx: x,
          cy: y,
          r: e - contactStroke / 2,
          ring,
          stroke: contactStroke,
          edge: e,
        }
      : { name: c.name, cx: x, cy: y, r: e, ring: false, stroke: 0, edge: e };
  });
  return {
    outline: polygon(g.outline, t),
    outlinePoints,
    stroke,
    contactStroke,
    gap,
    contacts,
  };
}

/** Contact `index` of a spec in pictogram millimeters: x as is, y pointing down. */
export function specContactMm(
  contacts: readonly ConnectorContact[],
  index: number,
): { x: number; y: number } {
  const c = contacts[index];
  if (c == null) throw new Error(`No contact ${String(index)} in the connector spec`);
  // Round to 0.01 mm so the numbers read as the cited ones.
  return { x: Math.round(c.x * 100000) / 100, y: Math.round(-c.y * 100000) / 100 };
}

// SAE J1772 (Type 1, IEC 62196-2 standard sheet 2-I), seen looking into the
// socket, oriented as the reference drawing: the round 43.8 mm face (J1772
// sheet A-2) with its key tab on the rim at the bottom, the L1 and N power
// contacts above, PE below the middle and the PP and CP signal contacts
// beside it. Every contact center comes from CONNECTOR_SPECS.type1, the one
// geometry source the 3D handle shares (SAE J1772 OCT2012 sheets A-2 and C-2);
// the sizes are the contact insulators, measured off the Wikimedia Commons
// face drawing "J1772 connector.svg" (CC BY-SA 4.0) scaled to the 43.8 mm
// face. EN 17186:2019 identifies it as an AC connector. Here y points down.
//
// | Contact | x mm   | y mm | d mm | Role   |
// | ------- | ------ | ---- | ---- | ------ |
// | L1      | -7.85  | -6.8 | 13.9 | power  |
// | N       | 7.85   | -6.8 | 13.9 | power  |
// | PE      | 0      | 10.8 | 13.9 | earth  |
// | PP      | -10.65 | 5.6  | 10   | signal |
// | CP      | 10.65  | 5.6  | 10   | signal |
// Outline: circle r 21.9, key tab 8.3 wide, 3.0 below the rim.

const TYPE1_J1772 = J1772_CONTACTS;
const TYPE1_R = 21.9;
const TYPE1_TAB_HALF = 4.15;
const TYPE1_TAB_BOTTOM = TYPE1_R + 3;
const TYPE1_TAB_ROOT = Math.sqrt(TYPE1_R * TYPE1_R - TYPE1_TAB_HALF * TYPE1_TAB_HALF);
// From the tab's left root over the top round to its right root (y down).
const TYPE1_START = Math.atan2(TYPE1_TAB_ROOT, -TYPE1_TAB_HALF);
const TYPE1_END = Math.atan2(TYPE1_TAB_ROOT, TYPE1_TAB_HALF) + 2 * Math.PI;

export const TYPE1_FACE: FaceGeometry = {
  outline: [
    ...arcPoints(0, 0, TYPE1_R, TYPE1_START, TYPE1_END, 48),
    [TYPE1_TAB_HALF, TYPE1_TAB_BOTTOM],
    [-TYPE1_TAB_HALF, TYPE1_TAB_BOTTOM],
  ],
  contacts: [
    { name: 'L1', ...specContactMm(TYPE1_J1772, 0), d: 13.9, role: 'power' },
    { name: 'N', ...specContactMm(TYPE1_J1772, 1), d: 13.9, role: 'power' },
    { name: 'PE', ...specContactMm(TYPE1_J1772, 2), d: 13.9, role: 'earth' },
    { name: 'PP', ...specContactMm(TYPE1_J1772, 3), d: 10, role: 'signal' },
    { name: 'CP', ...specContactMm(TYPE1_J1772, 4), d: 10, role: 'signal' },
  ],
};

// IEC 62196-2 Type 2 (standard sheet 2-IIa), the face seen from the front:
// the round 70 mm body cut flat across the top, PP and CP in the top row,
// L1, PE and N across the middle, L2 and L3 below (layout as in the
// Phoenix Contact EV-T2G3C drawing behind CONNECTOR_SPECS.type2). Centers
// and insulator sizes measured off the Wikimedia Commons drawing "Stecker-Typ
// 2 Belegung.svg" (public domain) scaled to the 70 mm body. EN 17186:2019
// identifies it as an AC connector.
//
// | Contact | x mm  | y mm  | d mm | Role   |
// | ------- | ----- | ----- | ---- | ------ |
// | PP      | -10.5 | -17.7 | 12.3 | signal |
// | CP      | 10.5  | -17.7 | 12.3 | signal |
// | L1      | -20.2 | -3.9  | 15.3 | power  |
// | PE      | 0     | -3.9  | 15.3 | earth  |
// | N       | 20.2  | -3.9  | 15.3 | power  |
// | L2      | -10.5 | 13.3  | 15.3 | power  |
// | L3      | 10.5  | 13.3  | 15.3 | power  |
// Outline: circle r 35, cut flat at y -29.5.

const TYPE2_R = 35;
const TYPE2_FLAT_Y = -29.5;
const TYPE2_FLAT_HALF = Math.sqrt(TYPE2_R * TYPE2_R - TYPE2_FLAT_Y * TYPE2_FLAT_Y);

export const TYPE2_FACE: FaceGeometry = {
  outline: arcPoints(
    0,
    0,
    TYPE2_R,
    Math.atan2(TYPE2_FLAT_Y, TYPE2_FLAT_HALF),
    Math.atan2(TYPE2_FLAT_Y, -TYPE2_FLAT_HALF) + 2 * Math.PI,
    48,
  ),
  contacts: [
    { name: 'PP', x: -10.5, y: -17.7, d: 12.3, role: 'signal' },
    { name: 'CP', x: 10.5, y: -17.7, d: 12.3, role: 'signal' },
    { name: 'L1', x: -20.2, y: -3.9, d: 15.3, role: 'power' },
    { name: 'PE', x: 0, y: -3.9, d: 15.3, role: 'earth' },
    { name: 'N', x: 20.2, y: -3.9, d: 15.3, role: 'power' },
    { name: 'L2', x: -10.5, y: 13.3, d: 15.3, role: 'power' },
    { name: 'L3', x: 10.5, y: 13.3, d: 15.3, role: 'power' },
  ],
};

// CCS1 (IEC 62196-3 configuration EE, SAE J1772 sheets C-2 and C-3), the
// vehicle inlet seen from the front: one continuous outline, the 43.8 mm
// J1772 face above flowing through a short waist into the DC section about
// as wide below. Every contact center comes from CONNECTOR_SPECS, the one
// geometry source the 3D handles share (SAE J1772 OCT2012 sheets A-2 and C-2:
// L1 and N 15.7 mm apart 6.8 mm above the center, CP and PP 21.3 mm apart
// 5.6 mm below, PE 10.8 mm below, the DC pins 26 mm apart 42 mm below). The
// insulator sizes are measured off the Wikimedia Commons drawing
// "J1772 (CCS1).svg" (CC BY-SA 4.0) scaled to the 43.8 mm face. EN 17186:2019
// identifies it as a DC connector. Here y points down.
//
// | Contact | x mm   | y mm | d mm | Role   |
// | ------- | ------ | ---- | ---- | ------ |
// | L1      | -7.85  | -6.8 | 11   | power  |
// | N       | 7.85   | -6.8 | 11   | power  |
// | PE      | 0      | 10.8 | 11   | earth  |
// | PP      | -10.65 | 5.6  | 9    | signal |
// | CP      | 10.65  | 5.6  | 9    | signal |
// | DC+     | -13    | 42   | 15.4 | power  |
// | DC-     | 13     | 42   | 15.4 | power  |
// Outline: AC circle r 21.9, waist 20 wide, DC section 51 by 25 centered on the DC pins.

const CCS1_R = 21.9;
const CCS1_WAIST = 10;
const CCS1_WAIST_Y = Math.sqrt(CCS1_R * CCS1_R - CCS1_WAIST * CCS1_WAIST);
const CCS1_AC = J1772_CONTACTS;
const CCS1_CCS = CCS1_CONTACTS;
const CCS1_L1 = specContactMm(CCS1_AC, 0);
const CCS1_N = specContactMm(CCS1_AC, 1);
const CCS1_PE = specContactMm(CCS1_CCS, 0);
const CCS1_PP = specContactMm(CCS1_CCS, 1);
const CCS1_CP = specContactMm(CCS1_CCS, 2);
const CCS1_DC_PLUS = specContactMm(CCS1_CCS, 3);
const CCS1_DC_MINUS = specContactMm(CCS1_CCS, 4);
const CCS1_FACE_DC_Y = CCS1_DC_PLUS.y;
const CCS1_DC_R = 12.5;
const CCS1_DC_HALF = CCS1_DC_MINUS.x;

export const CCS1_FACE: FaceGeometry = {
  outline: [
    ...arcPoints(
      0,
      0,
      CCS1_R,
      Math.atan2(CCS1_WAIST_Y, CCS1_WAIST),
      Math.atan2(CCS1_WAIST_Y, -CCS1_WAIST) - 2 * Math.PI,
      48,
    ),
    [-CCS1_WAIST, CCS1_FACE_DC_Y - CCS1_DC_R],
    ...arcPoints(-CCS1_DC_HALF, CCS1_FACE_DC_Y, CCS1_DC_R, 1.5 * Math.PI, 0.5 * Math.PI, 16),
    ...arcPoints(CCS1_DC_HALF, CCS1_FACE_DC_Y, CCS1_DC_R, 0.5 * Math.PI, -0.5 * Math.PI, 16),
    [CCS1_WAIST, CCS1_FACE_DC_Y - CCS1_DC_R],
  ],
  contacts: [
    { name: 'L1', ...CCS1_L1, d: 11, role: 'power' },
    { name: 'N', ...CCS1_N, d: 11, role: 'power' },
    { name: 'PE', ...CCS1_PE, d: 11, role: 'earth' },
    { name: 'PP', ...CCS1_PP, d: 9, role: 'signal' },
    { name: 'CP', ...CCS1_CP, d: 9, role: 'signal' },
    { name: 'DC+', ...CCS1_DC_PLUS, d: 15.4, role: 'power' },
    { name: 'DC-', ...CCS1_DC_MINUS, d: 15.4, role: 'power' },
  ],
};

// CCS2 (IEC 62196-3 configuration FF), the connector seen from the front:
// one continuous outline, the flat-topped Type 2 face above with CP, PP and
// PE (the DC connector carries no AC power contacts) flowing through a short
// waist into the DC section about as wide below, with its two large DC
// contacts. Centers and insulator sizes measured off the Wikimedia Commons
// drawing "IEC 62196 Type 2 (M, DC, CCS Combo 2).svg" (CC BY-SA 4.0) scaled
// to the 63 mm Type 2 face. EN 17186:2019 identifies it as a DC connector.
//
// | Contact | x mm  | y mm  | d mm | Role   |
// | ------- | ----- | ----- | ---- | ------ |
// | CP      | -8.3  | -10.5 | 10   | signal |
// | PP      | 8.3   | -10.5 | 10   | signal |
// | PE      | 0     | 0     | 13.4 | earth  |
// | DC+     | -15.1 | 56.6  | 26   | power  |
// | DC-     | 15.1  | 56.6  | 26   | power  |
// Outline: AC circle r 31.5 cut flat at y -20.1, waist 24 wide, DC section
// 65.5 by 35 centered at y 56.6.

const CCS2_R = 31.5;
const CCS2_FLAT_Y = -20.1;
const CCS2_FLAT_HALF = Math.sqrt(CCS2_R * CCS2_R - CCS2_FLAT_Y * CCS2_FLAT_Y);
const CCS2_WAIST = 12;
const CCS2_WAIST_Y = Math.sqrt(CCS2_R * CCS2_R - CCS2_WAIST * CCS2_WAIST);
const CCS2_FACE_DC_Y = 56.6;
const CCS2_DC_R = 17.5;
const CCS2_DC_HALF = 65.5 / 2 - CCS2_DC_R;

export const CCS2_FACE: FaceGeometry = {
  outline: [
    ...arcPoints(
      0,
      0,
      CCS2_R,
      Math.atan2(CCS2_WAIST_Y, CCS2_WAIST),
      Math.atan2(CCS2_FLAT_Y, CCS2_FLAT_HALF),
      16,
    ),
    ...arcPoints(
      0,
      0,
      CCS2_R,
      Math.atan2(CCS2_FLAT_Y, -CCS2_FLAT_HALF),
      Math.atan2(CCS2_WAIST_Y, -CCS2_WAIST) - 2 * Math.PI,
      16,
    ),
    [-CCS2_WAIST, CCS2_FACE_DC_Y - CCS2_DC_R],
    ...arcPoints(-CCS2_DC_HALF, CCS2_FACE_DC_Y, CCS2_DC_R, 1.5 * Math.PI, 0.5 * Math.PI, 16),
    ...arcPoints(CCS2_DC_HALF, CCS2_FACE_DC_Y, CCS2_DC_R, 0.5 * Math.PI, -0.5 * Math.PI, 16),
    [CCS2_WAIST, CCS2_FACE_DC_Y - CCS2_DC_R],
  ],
  contacts: [
    { name: 'CP', x: -8.3, y: -10.5, d: 10, role: 'signal' },
    { name: 'PP', x: 8.3, y: -10.5, d: 10, role: 'signal' },
    { name: 'PE', x: 0, y: 0, d: 13.4, role: 'earth' },
    { name: 'DC+', x: -15.1, y: 56.6, d: 26, role: 'power' },
    { name: 'DC-', x: 15.1, y: 56.6, d: 26, role: 'power' },
  ],
};

// CHAdeMO (IEC 62196-3 configuration AA, the CHAdeMO Association connector
// documents behind CONNECTOR_SPECS.chademo), a simplified pictogram of the
// face seen from the front (owner decision 2026-11-03): the large round
// 82 mm shell, the two large DC contacts side by side low in the face and a
// small arc of signal contacts above them, so nothing overlaps. The DC
// centers 31 mm apart and the shell size as measured off the Wikimedia
// Commons drawing "CHAdeMO connector.svg" (CC BY-SA 4.0) scaled to the 70 mm
// face; the insert ring and the two signal islands of the drawing are left
// out. EN 17186:2019 identifies it as a DC connector.
//
// | Contact | x mm  | y mm  | d mm | Role   |
// | ------- | ----- | ----- | ---- | ------ |
// | DC+     | -15.6 | 8.0   | 30.0 | power  |
// | DC-     | 15.6  | 8.0   | 30.0 | power  |
// | FG      | -20.8 | -12.0 | 5.0  | signal |
// | SS1     | -12.0 | -20.8 | 5.0  | signal |
// | DCP     | 0.0   | -24.0 | 5.0  | signal |
// | PP      | 12.0  | -20.8 | 5.0  | signal |
// | SS2     | 20.8  | -12.0 | 5.0  | signal |
// Outline: shell circle r 41.

export const CHADEMO_FACE: FaceGeometry = {
  outline: arcPoints(0, 0, 41, 0, 2 * Math.PI, 64),
  contacts: [
    { name: 'DC+', x: -15.6, y: 8.0, d: 30.0, role: 'power' },
    { name: 'DC-', x: 15.6, y: 8.0, d: 30.0, role: 'power' },
    { name: 'FG', x: -20.8, y: -12.0, d: 5.0, role: 'signal' },
    { name: 'SS1', x: -12.0, y: -20.8, d: 5.0, role: 'signal' },
    { name: 'DCP', x: 0.0, y: -24.0, d: 5.0, role: 'signal' },
    { name: 'PP', x: 12.0, y: -20.8, d: 5.0, role: 'signal' },
    { name: 'SS2', x: 20.8, y: -12.0, d: 5.0, role: 'signal' },
  ],
};

// NACS (SAE J3400, Tesla NACS specification TS-0023666 p.12-20, as
// CONNECTOR_SPECS.nacs), the connector seen from the front, as the reference
// drawing: a rounded, bean-like face 41 mm wide with convex curved sides,
// wide at the top where the two large shared AC and DC power sockets sit and
// round at the bottom, the PP, G (protective earth) and CP contacts as three
// small rings in a row near the bottom. Centers and sizes measured off the
// Wikimedia Commons drawing "NACS pinout annotated.svg" (CC BY-SA 4.0) scaled
// to the 41 mm face width.
//
// | Contact | x mm  | y mm | d mm | Role   |
// | ------- | ----- | ---- | ---- | ------ |
// | L1/DC+  | 10.8  | -6.6 | 11.5 | power  |
// | L2/DC-  | -10.8 | -6.6 | 11.5 | power  |
// | G       | 0     | 10.6 | 5.2  | earth  |
// | PP      | -8.6  | 10.6 | 5.0  | signal |
// | CP      | 8.6   | 10.6 | 5.0  | signal |
// Outline: a rounded oval 41 wide and 35.8 high (`beanOutline`), narrowing
// to 80 percent of its width at the bottom.

const NACS_HALF_W = 20.5;
const NACS_HALF_H = 17.9;
/** How square the oval is (1 an ellipse; lower rounds the corners less). */
const NACS_EXPONENT = 0.8;
/** The share of the width the face keeps at its bottom. */
const NACS_BOTTOM_WIDTH = 0.8;

/** A convex rounded oval, wider at the top: every side a curve, no corner. */
function beanOutlineNacs(steps = 96): FacePoint[] {
  return Array.from({ length: steps }, (_, i) => {
    const t = (2 * Math.PI * i) / steps;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const y = NACS_HALF_H * Math.sign(s) * Math.abs(s) ** NACS_EXPONENT;
    // y down: positive y is the bottom, where the face narrows.
    const taper = 1 - (1 - NACS_BOTTOM_WIDTH) * ((y / NACS_HALF_H + 1) / 2);
    return [NACS_HALF_W * taper * Math.sign(c) * Math.abs(c) ** NACS_EXPONENT, y] as const;
  });
}

export const NACS_FACE: FaceGeometry = {
  outline: beanOutlineNacs(),
  contacts: [
    { name: 'L1/DC+', x: 10.8, y: -6.6, d: 11.5, role: 'power' },
    { name: 'L2/DC-', x: -10.8, y: -6.6, d: 11.5, role: 'power' },
    { name: 'G', x: 0, y: 10.6, d: 5.2, role: 'earth' },
    { name: 'PP', x: -8.6, y: 10.6, d: 5, role: 'signal', ring: true },
    { name: 'CP', x: 8.6, y: 10.6, d: 5, role: 'signal', ring: true },
  ],
};

// MCS (SAE J3271, IEC 63379, CharIN MCS white paper v1.3 p.11-13, as
// CONNECTOR_SPECS.mcs), the connector seen from the front: a smooth rounded
// body 116 mm wide, wider at the top, with generous fillets (owner decision
// 2026-11-03: no sharp triangle corners), DC+ and DC- large at the top, the
// communication contact pair between them (drawn as one), CP and PP below
// and PE at the bottom. Centers and sizes measured off the Wikimedia Commons
// drawing "Megawatt Charging System Schematic Plug Design.svg" (CC BY-SA
// 4.0) scaled to the 116 mm width. EN 17186:2019 identifies DC connectors in
// a square frame.
//
// | Contact | x mm  | y mm  | d mm | Role   |
// | ------- | ----- | ----- | ---- | ------ |
// | DC+     | -30.7 | -24.9 | 44   | power  |
// | DC-     | 30.7  | -24.9 | 44   | power  |
// | COMM    | 0     | 0.6   | 10   | signal |
// | CP      | -19.1 | 12.8  | 14   | signal |
// | PP      | 19.1  | 12.8  | 14   | signal |
// | PE      | 0     | 32.5  | 25.5 | earth  |
// Outline: the hull of the top round corners (r 24 at x 34, y -30.5) and
// the round bottom (r 32 at y 22.5): 116 wide, 109 high.

export const MCS_FACE: FaceGeometry = {
  outline: hullOfCircles([
    { x: -34, y: -30.5, r: 24 },
    { x: 34, y: -30.5, r: 24 },
    { x: 0, y: 22.5, r: 32 },
  ]),
  contacts: [
    { name: 'DC+', x: -30.7, y: -24.9, d: 44, role: 'power' },
    { name: 'DC-', x: 30.7, y: -24.9, d: 44, role: 'power' },
    { name: 'COMM', x: 0, y: 0.6, d: 10, role: 'signal' },
    { name: 'CP', x: -19.1, y: 12.8, d: 14, role: 'signal' },
    { name: 'PP', x: 19.1, y: 12.8, d: 14, role: 'signal' },
    { name: 'PE', x: 0, y: 32.5, d: 25.5, role: 'earth' },
  ],
};

/** The face of each connector kind. */
export const CONNECTOR_FACES: Record<ConnectorKind, FaceGeometry> = {
  type1: TYPE1_FACE,
  type2: TYPE2_FACE,
  ccs1: CCS1_FACE,
  ccs2: CCS2_FACE,
  chademo: CHADEMO_FACE,
  nacs: NACS_FACE,
  mcs: MCS_FACE,
};
