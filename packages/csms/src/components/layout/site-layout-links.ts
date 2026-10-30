// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The load management links of the 3D site layout, without three.js: from a
// transformer to each panel, from a panel to its circuits (and child panels),
// and from a circuit to each managed station on the lot. Points are lot
// coordinates in meters (site-layout-grid.ts).

import type { Point } from './site-layout-grid';

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

export interface LinkTransformer extends Point {
  ratedKva: number | null;
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

/** Stations of a panel on the lot, its circuits and child panels included. */
function panelStations(panel: LinkPanel, stations: ReadonlyMap<string, Point>): Point[] {
  const out: Point[] = [];
  for (const c of panel.circuits) {
    for (const s of c.stations) {
      const p = stations.get(s.id);
      if (p != null) out.push(p);
    }
  }
  for (const child of panel.childPanels) out.push(...panelStations(child, stations));
  return out;
}

/**
 * The links of a load management hierarchy. Each top-level panel is fed by
 * the transformer with the highest rated kVA (the nearest among equal ones); panels and circuits without a station
 * on the lot are left out. A node stands part of the way from its feeder to
 * the middle of its stations, so the tree fans out toward the chargers.
 */
export function loadLinks(
  hierarchy: readonly LinkPanel[],
  transformers: readonly LinkTransformer[],
  stations: ReadonlyMap<string, Point>,
): LoadLinks {
  const segments: LinkSegment[] = [];
  const labels: LinkLabel[] = [];
  if (transformers.length === 0) return { segments, labels };

  function walkPanel(panel: LinkPanel, feeder: Point): void {
    const points = panelStations(panel, stations);
    if (points.length === 0) return;
    const node = between(feeder, centroid(points), 0.45);
    segments.push({ id: `panel:${panel.id}`, kind: 'panel', from: feeder, to: node });
    labels.push({
      id: `panel:${panel.id}`,
      kind: 'panel',
      point: node,
      name: panel.name,
      amps: panel.breakerRatingAmps,
      kw: panel.maxContinuousKw,
    });
    for (const circuit of panel.circuits) {
      const own = circuit.stations.flatMap((s) => {
        const p = stations.get(s.id);
        return p != null ? [{ s, p }] : [];
      });
      if (own.length === 0) continue;
      const cNode = between(node, centroid(own.map((o) => o.p)), 0.5);
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
    for (const child of panel.childPanels) walkPanel(child, node);
  }

  for (const panel of hierarchy) {
    const points = panelStations(panel, stations);
    if (points.length === 0) continue;
    const middle = centroid(points);
    // The largest transformer feeds the panels (the utility service, not a
    // solar tie-in); among equal ones, the nearest.
    const kva = (t: LinkTransformer): number => t.ratedKva ?? 0;
    let feeder = transformers[0] as LinkTransformer;
    let best = Infinity;
    for (const t of transformers) {
      const d = (t.x - middle.x) ** 2 + (t.z - middle.z) ** 2;
      if (kva(t) > kva(feeder) || (kva(t) === kva(feeder) && d < best)) {
        best = d;
        feeder = t;
      }
    }
    walkPanel(panel, { x: feeder.x, z: feeder.z });
  }
  return { segments, labels };
}
