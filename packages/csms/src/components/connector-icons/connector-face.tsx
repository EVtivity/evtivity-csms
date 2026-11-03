// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

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

function r3(v: number): number {
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

export interface ConnectorIconProps {
  /** The accessible name and title (for example "EVSE 1, CCS1, Charging"). */
  label: string;
  /** The line color (a connector status color, or currentColor). */
  color?: string | undefined;
  /** The rendered size in px (the detail and line width follow it). */
  size?: ConnectorIconSize | undefined;
  className?: string | undefined;
}

export function ConnectorFace({
  label,
  color = 'currentColor',
  size = 20,
  className,
  kind,
  geometry,
}: ConnectorIconProps & {
  /** The connector kind (data-connector, for tests and styling). */
  kind: string;
  geometry: FaceGeometry;
}): React.JSX.Element {
  const d = faceDrawing(geometry, size);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={className}
      data-testid="connector-type-icon"
      data-connector={kind}
    >
      <title>{label}</title>
      <path
        d={d.outline}
        fill="none"
        stroke={color}
        strokeWidth={d.stroke}
        strokeLinejoin="round"
      />
      {d.contacts.map((c) =>
        c.ring ? (
          <circle
            key={c.name}
            data-contact={c.name}
            cx={r3(c.cx)}
            cy={r3(c.cy)}
            r={r3(c.r)}
            fill="none"
            stroke={color}
            strokeWidth={r3(c.stroke)}
          />
        ) : (
          <circle
            key={c.name}
            data-contact={c.name}
            cx={r3(c.cx)}
            cy={r3(c.cy)}
            r={r3(c.r)}
            fill={color}
          />
        ),
      )}
    </svg>
  );
}
