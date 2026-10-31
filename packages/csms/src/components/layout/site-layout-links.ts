// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The load management panels and links of the 3D site layout, without
// three.js. One panel model per load management panel, placed automatically
// (`placePanels`, no stored positions): on a parking lot a row of switchboard
// cabinets on pads on the grass left of the lot, on an office or retail site a panel
// on the building facade left of the first spot. Links run from a panel to its
// circuits and child panels, and from a circuit to each of its stations on
// the lot. Transformers are not part of it (they are informational). Points
// are lot coordinates in meters (site-layout-grid.ts).

import { FACADE_Z, WALL_PANEL_PITCH_M, type Lot, type Point } from './site-layout-grid';

export interface LinkStation {
  id: string;
  allocatedLimitKw: number | null;
}

export interface LinkCircuit {
  id: string;
  name: string;
  breakerRatingAmps: number;
  maxContinuousKw: number;
  stations: LinkStation[];
}

export interface LinkPanel {
  id: string;
  name: string;
  breakerRatingAmps: number;
  maxContinuousKw: number;
  circuits: LinkCircuit[];
  childPanels: LinkPanel[];
}

export type LinkKind = 'panel' | 'circuit' | 'station';

export interface LinkSegment {
  id: string;
  kind: LinkKind;
  from: Point;
  to: Point;
}

export interface LinkLabel {
  id: string;
  kind: LinkKind;
  point: Point;
  /** Name (panels and circuits only). */
  name: string | null;
  /** Breaker rating in A (panels and circuits). */
  amps: number | null;
  /** Maximum output in kW: the panel or circuit limit, or the station's allocated limit. */
  kw: number | null;
}

export interface LoadLinks {
  segments: LinkSegment[];
  labels: LinkLabel[];
}

/** How a panel model stands: a switchboard cabinet on a pad, or a panel on the facade. */
export type PanelMount = 'pad' | 'wall';

export interface PanelPlacement {
  id: string;
  /** The panel it hangs under, or null for a top-level panel. */
  parentId: string | null;
  name: string;
  amps: number;
  kw: number;
  point: Point;
  mount: PanelMount;
}

/** The first switchboard cabinet stands this far left of the lot (its center), in meters. */
export const PANEL_PAD_GAP_M = 4.5;
/** Distance between two switchboard cabinets in their row, in meters. */
export const PANEL_PAD_PITCH_M = 2.8;

/** The first wall panel, left of the lot (its center), in meters. */
export const WALL_PANEL_START_X = -1.6;
/**
 * The circuit nodes of wall panels stand this far out from the facade, over
 * the sidewalk, so the links to the wall boxes fan out instead of running
 * along the wall on top of each other, in meters.
 */
export const WALL_CIRCUIT_OUT_M = 1.6;

/** Every panel of the hierarchy, each parent followed by its child panels (depth first). */
function flatten(
  panels: readonly LinkPanel[],
  parentId: string | null,
): Array<{ panel: LinkPanel; parentId: string | null }> {
  return panels.flatMap((panel) => [{ panel, parentId }, ...flatten(panel.childPanels, panel.id)]);
}

/**
 * Where each panel model stands, in hierarchy order (a sub-panel right after
 * its parent, so it stands next to it). Parking lot: a row of switchboard
 * cabinets on the grass left of the lot, beside the middle of its depth, the
 * first PANEL_PAD_GAP_M from it, one every PANEL_PAD_PITCH_M further left,
 * their doors toward the front.
 * Office or retail: panels on the facade left of the first spot, one every
 * WALL_PANEL_PITCH_M to the left.
 */
export function placePanels(hierarchy: readonly LinkPanel[], lot: Lot): PanelPlacement[] {
  return flatten(hierarchy, null).map(({ panel, parentId }, i) => ({
    id: panel.id,
    parentId,
    name: panel.name,
    amps: panel.breakerRatingAmps,
    kw: panel.maxContinuousKw,
    ...(lot.siteType === 'office_retail'
      ? {
          point: { x: WALL_PANEL_START_X - i * WALL_PANEL_PITCH_M, z: FACADE_Z },
          mount: 'wall' as const,
        }
      : {
          point: { x: -PANEL_PAD_GAP_M - i * PANEL_PAD_PITCH_M, z: lot.depth / 2 },
          mount: 'pad' as const,
        }),
  }));
}

function centroid(points: readonly Point[]): Point {
  const n = points.length;
  return {
    x: points.reduce((s, p) => s + p.x, 0) / n,
    z: points.reduce((s, p) => s + p.z, 0) / n,
  };
}

function between(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

/**
 * The links of a load management hierarchy, from the panel models
 * (`placePanels`): every panel gets its label (name, breaker, limit); a child
 * panel is linked from its parent; a circuit node stands half way from its
 * panel to the middle of its stations on the lot (for a wall panel, out over
 * the sidewalk), and links to each of them.
 * Circuits without a station on the lot are left out. `stations` holds the
 * point each station's link ends at (stationBackPoint).
 */
export function loadLinks(
  hierarchy: readonly LinkPanel[],
  panels: readonly PanelPlacement[],
  stations: ReadonlyMap<string, Point>,
): LoadLinks {
  const segments: LinkSegment[] = [];
  const labels: LinkLabel[] = [];
  const at = new Map(panels.map((p) => [p.id, p.point]));
  const onWall = new Set(panels.filter((p) => p.mount === 'wall').map((p) => p.id));

  for (const { panel, parentId } of flatten(hierarchy, null)) {
    const node = at.get(panel.id);
    if (node == null) continue;
    labels.push({
      id: `panel:${panel.id}`,
      kind: 'panel',
      point: node,
      name: panel.name,
      amps: panel.breakerRatingAmps,
      kw: panel.maxContinuousKw,
    });
    const parent = parentId != null ? at.get(parentId) : undefined;
    if (parent != null) {
      segments.push({ id: `panel:${panel.id}`, kind: 'panel', from: parent, to: node });
    }
    for (const circuit of panel.circuits) {
      const own = circuit.stations.flatMap((s) => {
        const p = stations.get(s.id);
        return p != null ? [{ s, p }] : [];
      });
      if (own.length === 0) continue;
      const mid = between(node, centroid(own.map((o) => o.p)), 0.5);
      const cNode = onWall.has(panel.id) ? { x: mid.x, z: FACADE_Z + WALL_CIRCUIT_OUT_M } : mid;
      segments.push({ id: `circuit:${circuit.id}`, kind: 'circuit', from: node, to: cNode });
      labels.push({
        id: `circuit:${circuit.id}`,
        kind: 'circuit',
        point: cNode,
        name: circuit.name,
        amps: circuit.breakerRatingAmps,
        kw: circuit.maxContinuousKw,
      });
      for (const { s, p } of own) {
        segments.push({ id: `station:${s.id}`, kind: 'station', from: cNode, to: p });
        if (s.allocatedLimitKw != null) {
          labels.push({
            id: `station:${s.id}`,
            kind: 'station',
            point: between(cNode, p, 0.55),
            name: null,
            amps: null,
            kw: s.allocatedLimitKw,
          });
        }
      }
    }
  }
  return { segments, labels };
}

/** How full a panel or circuit is, by its live draw against its limit. */
export type LoadLevel = 'normal' | 'near' | 'at';

/** A panel or circuit counts as near its limit from this share of it. */
export const NEAR_LIMIT_SHARE = 0.8;

export function loadLevel(drawKw: number, limitKw: number | null): LoadLevel {
  if (limitKw == null || limitKw <= 0) return 'normal';
  const ratio = drawKw / limitKw;
  if (ratio >= 1) return 'at';
  if (ratio >= NEAR_LIMIT_SHARE) return 'near';
  return 'normal';
}

export interface FlowLoad {
  /** The live draw flowing through it now, in kW. */
  drawKw: number;
  /** Its limit in kW (a panel or circuit limit, a station's allocated limit), or null. */
  limitKw: number | null;
}

export interface LoadFlows {
  /**
   * The flow of each link segment (`LinkSegment.id`), 0 to 1: the draw
   * through it against its limit. A station link without an allocated limit
   * uses its circuit's limit shared by the circuit's stations.
   */
  segments: Map<string, number>;
  /** The live draw and limit of each panel (panel id) and circuit (circuit id). */
  loads: Map<string, FlowLoad>;
}

function flowShare(load: FlowLoad): number {
  if (load.limitKw == null || load.limitKw <= 0) return load.drawKw > 0 ? 0.5 : 0;
  return Math.min(1, Math.max(0, load.drawKw / load.limitKw));
}

/**
 * The live power on the load management links: a station link carries the
 * station's draw now, a circuit link the sum of its stations, a panel link
 * (parent to sub-panel) everything under the sub-panel. `drawKw` is the live
 * draw by station id (the load management reply the layout already polls).
 */
export function loadFlows(
  hierarchy: readonly LinkPanel[],
  drawKw: (stationId: string) => number | undefined,
): LoadFlows {
  const segments = new Map<string, number>();
  const loads = new Map<string, FlowLoad>();

  function visit(panel: LinkPanel): number {
    let total = 0;
    for (const circuit of panel.circuits) {
      let circuitDraw = 0;
      const perStation =
        circuit.stations.length > 0 ? circuit.maxContinuousKw / circuit.stations.length : null;
      for (const s of circuit.stations) {
        const kw = Math.max(0, drawKw(s.id) ?? 0);
        circuitDraw += kw;
        segments.set(
          `station:${s.id}`,
          flowShare({ drawKw: kw, limitKw: s.allocatedLimitKw ?? perStation }),
        );
      }
      const load = { drawKw: circuitDraw, limitKw: circuit.maxContinuousKw };
      loads.set(circuit.id, load);
      segments.set(`circuit:${circuit.id}`, flowShare(load));
      total += circuitDraw;
    }
    for (const child of panel.childPanels) total += visit(child);
    const load = { drawKw: total, limitKw: panel.maxContinuousKw };
    loads.set(panel.id, load);
    segments.set(`panel:${panel.id}`, flowShare(load));
    return total;
  }

  for (const panel of hierarchy) visit(panel);
  return { segments, loads };
}
