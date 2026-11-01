// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The load management panels and links of the 3D site layout, without
// three.js. One model per load management panel, placed automatically
// (`placePanels`, no stored positions): a row of switchboard cabinets on pads
// on the grass beside the site's transformer, 3 ft from its pad, so the
// transformer, the switchboards and their feeders share one equipment pad at
// the lot edge next to the DC chargers they feed, as real sites build them;
// the AC panelboards on racks on the island or curb strip at the end of
// their row nearest the equipment pad, inside the lot, so their feeders are
// the shortest (ChargePoint Express 280 site design guide: minimize conduit
// and trenching). An office or retail site hangs its AC panelboards on the building
// facade (`placeFacadePanels`, `facadeLinks`); its own switchboard stays
// inside. A parking lot, a depot, a custom site and an office or retail site
// draw them (`showsLoadPanels`).
//
// The links are cable runs on the ground, the way they go in conduit or
// trenches (`loadLinks`): a service cable from the transformer to each
// top-level switchboard, a feeder from a switchboard to each sub-panel (to a
// panelboard rack along the near lot edge and in along its row's line,
// `feederLinks`), and
// one trunk per circuit, each on its own route (AC and DC circuits never share
// a run): out of the switchboard, along a corridor beside the switchboard row,
// down its own lane on the grass along the lot edge, then along the row of its
// stations behind the chargers (the island or curb line), with a short branch
// to each charger. Every run is orthogonal, never crosses a parking space,
// and keeps LINK_SPACING_M from the runs beside it; lanes and corridors are
// ordered so the runs do not cross where the layout allows it.
//
// The routing works in a frame mirrored so the equipment stands at the left
// end of the rows (`panelFrame`), then mirrors every point back.
// Points are lot coordinates in meters (site-layout-grid.ts).

import type { Box, Point } from './site-layout-grid';

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

/** A cable run on the ground: an orthogonal polyline. */
export interface LinkSegment {
  /** Unique per run. */
  id: string;
  /**
   * The load it carries (`loadFlows` segment id): `panel:<id>` for the cable
   * into a panel, `circuit:<id>` for every run of a circuit's trunk,
   * `station:<id>` for a station's branch.
   */
  flowId: string;
  kind: LinkKind;
  /** At least two points; consecutive points share x or z. */
  points: Point[];
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

export interface PanelPlacement {
  id: string;
  /** The panel it hangs under, or null for a top-level panel. */
  parentId: string | null;
  name: string;
  amps: number;
  kw: number;
  point: Point;
  /**
   * The model: a free-standing switchboard on the equipment pad, a
   * panelboard on a rack beside the AC group it feeds (`placePanels`), or a
   * panelboard on the building facade of an office or retail site
   * (`placeFacadePanels`).
   */
  model: 'switchboard' | 'panelboard' | 'wall' | 'cabinet';
  /**
   * The turn of the model about the vertical axis, in radians (0: its front
   * faces +z): a panelboard rack at a row end faces the lot edge, so its
   * working space lies along the island or curb strip, not in a stall.
   */
  turn: number;
}

/** The id prefix of a DC split system's power cabinet in the routed hierarchy (`withSplitCabinets`). */
export const CABINET_PREFIX = 'cabinet:';

/** The cable end of a split system's dispenser `n` (2 and up; the first is the station's own point). */
export function splitDispenserId(stationId: string, n: number): string {
  return `${stationId}#${String(n)}`;
}

/**
 * The hierarchy as the 3D view routes it with DC split systems
 * (`splitDispenserCount`, `SPLIT_SYSTEM`): the circuit of a split system
 * feeds its power cabinet, a panel of its own (id `cabinet:<station id>`,
 * the circuit's breaker and limit, so load management and the demo trees
 * count the cabinet's rating once, not per dispenser), which stands beside
 * the switchboards on the equipment pad and feeds each dispenser
 * (`splitDispenserId`) on one run along its row. Other circuits stay as
 * they are.
 */
export function withSplitCabinets(
  hierarchy: readonly LinkPanel[],
  splits: ReadonlyMap<string, number>,
): LinkPanel[] {
  if (splits.size === 0) return [...hierarchy];
  const walk = (panel: LinkPanel): LinkPanel => {
    const keep: LinkCircuit[] = [];
    const cabinets: LinkPanel[] = [];
    for (const circuit of panel.circuits) {
      const split = circuit.stations.find((st) => (splits.get(st.id) ?? 1) > 1);
      if (split == null || circuit.stations.length !== 1) {
        keep.push(circuit);
        continue;
      }
      const n = splits.get(split.id) ?? 1;
      cabinets.push({
        id: `${CABINET_PREFIX}${split.id}`,
        name: circuit.name,
        breakerRatingAmps: circuit.breakerRatingAmps,
        maxContinuousKw: circuit.maxContinuousKw,
        circuits: [
          {
            ...circuit,
            stations: [
              split,
              ...Array.from({ length: n - 1 }, (_, i) => ({
                id: splitDispenserId(split.id, i + 2),
                allocatedLimitKw: null,
              })),
            ],
          },
        ],
        childPanels: [],
      });
    }
    return {
      ...panel,
      circuits: keep,
      childPanels: [...panel.childPanels.map(walk), ...cabinets],
    };
  };
  return hierarchy.map(walk);
}

/** Where a station's cables end: its charger and the back of it (the side away from its spot). */
export interface LinkStationPoint {
  charger: Point;
  back: Point;
}

/** Distance between two switchboard cabinets in their row, in meters (a 2.3 m pad and a gap). */
export const PANEL_PAD_PITCH_M = 2.8;
/** Distance between two parallel cable runs, in meters. */
export const LINK_SPACING_M = 0.3;
/** The first lane runs this far outside the ground's edge, in meters (the grass strip past the curb). */
export const LANE_START_M = 0.8;
/** The corridors beside the switchboard row start this far from its line, in meters (clear of the pads). */
export const CORRIDOR_GAP_M = 1.65;
/** A trunk along a row runs at least this far behind the back of the chargers, in meters. */
export const TRUNK_BEHIND_M = 0.35;
/**
 * The first switchboard stands this far beyond the transformer's center, in
 * meters: half the transformer pad (2.9 m), the 3 ft (0.91 m) a utility keeps
 * clear at the sides of a pad-mounted transformer (Omaha Public Power
 * District, "Padmount transformers": "at least 10 feet of clearance in front
 * of the transformer (the side that is padlocked)" and three feet on two
 * sides, https://www.oppd.com/residential/customer-service/padmount-transformers;
 * Idaho Power, Construction Clearance Requirements: 10 ft in front of the
 * doors, 3 ft at the back,
 * https://www.idahopower.com/accounts-service/construction-remodeling/construction-clearance-requirements/),
 * and half the switchboard pad (2.3 m). The transformer's doors and the
 * switchboard fronts face the same way (+z), so the 10 ft in front of the
 * doors and the switchboards' NEC 110.26(A)(1) working space (3 to 4 ft,
 * read in IAEI Magazine, "Working Space for Electrical Equipment", July 2013,
 * https://iaeimagazine.org/2013/julyaugust-2013/working-space-for-electrical-equipment/)
 * stay open; the cables beside them run underground.
 */
export const PANEL_FROM_TRANSFORMER_M = 2.9 / 2 + 0.91 + 2.3 / 2;
/** The first switchboard keeps at least this far from the outermost lane, in meters. */
const PANEL_FROM_LANES_M = 1.5;
/** Without a transformer the equipment stands this far outside the ground's edge. */
const DEFAULT_EQUIPMENT_GAP_M = 4;
/** Rows of stations closer than this in z share one row line, in meters. */
const ROW_TOLERANCE_M = 0.3;
/** The two back lines of chargers standing back to back on an island lie at most this far apart, in meters. */
const ISLAND_MERGE_M = 1.2;
/**
 * Distance between two panelboard racks in their row, in meters: a 1.2 m
 * rack pad and a gap (no source; the NEMA 3R enclosure of a 225 A, 42 space
 * panelboard is 20 in (0.51 m) wide, Schneider Electric NQ442L2C data sheet,
 * https://cdn.shopify.com/s/files/1/0571/5899/2039/files/NQ442L2C_document.pdf).
 */
export const PANELBOARD_PITCH_M = 1.6;
/** Half the 1.2 m pad of a panelboard rack, in meters. */
const RACK_HALF_M = 0.6;
/**
 * Half the rack pad across its face, in meters: a rack at a row end on the
 * island or curb strip is turned to face the lot edge, so its 0.6 m pad side
 * runs along the row.
 */
const RACK_TURNED_HALF_M = 0.3;
/**
 * The first rack at a row end stands this far inside the lot edge, in meters
 * (its center): the 0.15 m island end curb, half the turned pad and 0.3 m
 * between them (no source; it keeps the pad on the island or curb strip).
 */
const RACK_INSET_M = 0.15 + 0.3 + RACK_TURNED_HALF_M;
/**
 * The racks at a row end keep at least this far from the nearest charger on
 * their line, in meters (no source: the pedestal base and room to reach its
 * back; with less room the panelboards stand on the equipment pad instead).
 */
const RACK_CHARGER_CLEAR_M = 0.6;
/**
 * A charger of another group this close (in z) to a rack row's line, between
 * the row end and the rack's own run, would stand nearer the rack than its own
 * group: the racks then stand just before their run instead (no source; about
 * one stall depth).
 */
const INTERVENE_BAND_M = 6;
/** A feeder to a remote panel row runs this far outside every other run, in meters. */
const FEEDER_OUTSIDE_M = 1.0;

/** Every panel of the hierarchy, each parent followed by its child panels (depth first). */
function flatten(
  panels: readonly LinkPanel[],
  parentId: string | null,
): Array<{ panel: LinkPanel; parentId: string | null }> {
  return panels.flatMap((panel) => [{ panel, parentId }, ...flatten(panel.childPanels, panel.id)]);
}

type Side = 'left' | 'right';

/**
 * The routing frame: the end of the rows the equipment stands at (the side
 * of the ground's middle the transformer is on, left without one; feeders
 * reach the rows from their ends, the way trenches follow row ends and
 * islands) and the mirror that brings it to the left. A mirror keeps runs
 * orthogonal and crossings as they are.
 */
export interface PanelFrame {
  side: Side;
  /** Site point to frame point. */
  to: (p: Point) => Point;
  /** Frame point to site point. */
  from: (p: Point) => Point;
  /** The ground in the frame. */
  ground: Box;
  /** The transformer in the frame (a virtual one left of the ground beside its middle without one). */
  transformer: Point;
}

export function panelFrame(ground: Box, transformer?: Point | null): PanelFrame {
  const side: Side =
    transformer != null && transformer.x > (ground.minX + ground.maxX) / 2 ? 'right' : 'left';
  const flip = side === 'right' ? -1 : 1;
  const to = (p: Point): Point => ({ x: flip * p.x + 0, z: p.z });
  const g: Box =
    side === 'right'
      ? { minX: -ground.maxX, maxX: -ground.minX, minZ: ground.minZ, maxZ: ground.maxZ }
      : { ...ground };
  const t =
    transformer != null
      ? to(transformer)
      : { x: g.minX - DEFAULT_EQUIPMENT_GAP_M, z: (g.minZ + g.maxZ) / 2 };
  return { side, to, from: to, ground: g, transformer: t };
}

/** The transformers of a site: none, one or several. */
type Transformers = Point | readonly Point[] | null | undefined;

function transformerList(transformers: Transformers): readonly Point[] {
  if (transformers == null) return [];
  return 'x' in transformers ? [transformers] : transformers;
}

/**
 * The equipment groups of a site: the j-th top-level panel and everything
 * under it stand at the j-th transformer, the last transformer taking the
 * rest (a large site with an equipment pad per charger group, such as a depot
 * with one transformer and switchboard for its buses and one for its trucks);
 * without a transformer, all of them stand left of the ground.
 */
function equipmentGroups(
  hierarchy: readonly LinkPanel[],
  transformers: Transformers,
): Array<{ roots: LinkPanel[]; transformer: Point | null }> {
  const list = transformerList(transformers);
  if (list.length <= 1) return [{ roots: [...hierarchy], transformer: list[0] ?? null }];
  const groups = list.map((transformer) => ({ roots: [] as LinkPanel[], transformer }));
  hierarchy.forEach((root, j) => {
    groups[Math.min(j, groups.length - 1)]?.roots.push(root);
  });
  return groups.filter((g) => g.roots.length > 0);
}

/** A routing group: panels in one row of pads at `frame.transformer.z`, their circuits on its lanes. */
interface PanelGroup {
  frame: PanelFrame;
  /** The panels in the row, in hierarchy order, each with the panel it hangs under. */
  flat: Array<{ panel: LinkPanel; parentId: string | null }>;
  model: PanelPlacement['model'];
  /** A row of group panels beside the stations they feed, away from the switchboard row. */
  remote: boolean;
  /** The first pad's x in the frame; the others follow outward. */
  firstX: number;
  pitch: number;
}

/**
 * Whether a panel can stand apart from the switchboard row, beside the
 * group it feeds: it hangs under another panel, has no sub-panels, and every
 * station of its circuits is on the layout (an AC panelboard or a DC
 * distribution switchboard of one charger group).
 */
function isGroupPanel(
  panel: LinkPanel,
  parentId: string | null,
  stations: ReadonlyMap<string, LinkStationPoint>,
): boolean {
  if (parentId == null || panel.childPanels.length > 0 || panel.circuits.length === 0) return false;
  const ids = panel.circuits.flatMap((c) => c.stations.map((st) => st.id));
  return ids.length > 0 && ids.every((id) => stations.has(id));
}

/**
 * A group panel stays in the switchboard row while its main row line lies
 * this close to the row (in z) at the transformer's end, in meters: its
 * circuits then run straight out of the equipment pad (no source; one stall
 * depth and a cable lane).
 */
const NEAR_PAD_M = 8;

/**
 * The routing groups of a site. Per equipment group (`equipmentGroups`): the
 * transformer's row of switchboards, and every group panel
 * (`isGroupPanel`: an AC panelboard or a DC distribution switchboard) whose
 * stations stand away from it in a row of its own beside them (owner rule
 * 2026-11-01: every equipment item next to the group it feeds), on the row
 * line that holds most of them (an island's middle or an edge row's curb
 * line). An AC panelboard stands on a rack (`panelboard`) on the island or
 * curb strip at the row end nearest the equipment pad, inside the lot
 * (ChargePoint Express 280 site design guide, Planning: minimize conduit and
 * trenching), or just before its run where another group's chargers hold
 * that end (a custom site's free rows); a DC distribution switchboard stands
 * as a cabinet just past the lot edge at the end its stations lie nearer (by
 * their mean). A panel beside the equipment pad (an AC panelboard with a
 * charger within NEAR_PAD_M of the transformer, a DC switchboard whose row
 * lies by it), or an AC panelboard with no room at either spot, stays in the
 * switchboard row on the pad. Their branch
 * circuits of the rack's own row run straight along the row
 * (`directRuns`), their feeders from the switchboard row (`feederLinks`).
 */
function panelGroups(
  hierarchy: readonly LinkPanel[],
  ground: Box,
  transformers: Transformers,
  stations: ReadonlyMap<string, LinkStationPoint>,
  acStations: ReadonlySet<string>,
  pads: readonly Box[] = [],
): PanelGroup[] {
  const out: PanelGroup[] = [];
  const mid = (ground.minX + ground.maxX) / 2;
  for (const g of equipmentGroups(hierarchy, transformers)) {
    const frame = panelFrame(ground, g.transformer);
    const flat = flatten(g.roots, null);
    const isAc = (panel: LinkPanel): boolean =>
      panel.circuits.every((c) => c.stations.every((st) => acStations.has(st.id)));
    const placeOf = (panel: LinkPanel): { side: Side; frame: PanelFrame; lineZ: number } | null => {
      const ids = panel.circuits.flatMap((c) => c.stations.map((st) => st.id));
      const xs = ids.flatMap((id) => {
        const p = stations.get(id);
        return p != null ? [p.charger.x] : [];
      });
      const mean = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
      // An AC panelboard stands at the row end nearest the equipment pad (the
      // transformer's end), so its feeder is the shortest; a DC group
      // switchboard at the end its stations lie nearer.
      const side: Side = isAc(panel)
        ? frame.side
        : Math.abs(mean - mid) < 1e-6
          ? frame.side
          : mean > mid
            ? 'right'
            : 'left';
      const end = panelFrame(ground, {
        x: side === 'right' ? ground.maxX + 1 : ground.minX - 1,
        z: (ground.minZ + ground.maxZ) / 2,
      });
      const members = panel.circuits.flatMap((c) =>
        c.stations.flatMap((station) => {
          const p = stations.get(station.id);
          return p != null
            ? [{ station, point: { charger: end.to(p.charger), back: end.to(p.back) } }]
            : [];
        }),
      );
      const main = rowsOf(members).reduce<Row | null>(
        (m, r) => (m == null || r.members.length > m.members.length ? r : m),
        null,
      );
      if (main == null) return null;
      // Beside the equipment pad: it stays in the switchboard row there (an AC
      // panelboard when one of its chargers stands that close to the
      // transformer, a DC switchboard when its row lies by the pad).
      if (side === frame.side) {
        const t = frame.transformer;
        const near = isAc(panel)
          ? Math.min(
              ...members.map((m) => Math.hypot(m.point.charger.x - t.x, m.point.charger.z - t.z)),
            ) <= NEAR_PAD_M
          : Math.abs(main.lineZ - t.z) <= NEAR_PAD_M;
        if (near) return null;
      }
      return { side, frame: end, lineZ: main.lineZ };
    };
    const away = new Map<LinkPanel, { side: Side; frame: PanelFrame; lineZ: number }>();
    for (const { panel, parentId } of flat) {
      if (!isGroupPanel(panel, parentId, stations)) continue;
      const place = placeOf(panel);
      if (place != null) away.set(panel, place);
    }
    // One row of racks or cabinets per row end and line (lines closer than an
    // island's two back lines are one line), AC and DC apart.
    const rowsAt = new Map<
      string,
      { side: Side; frame: PanelFrame; lineZ: number; ac: boolean; list: typeof flat }
    >();
    for (const entry of flat) {
      const place = away.get(entry.panel);
      if (place == null) continue;
      const ac = isAc(entry.panel);
      const existing = [...rowsAt.values()].find(
        (r) =>
          r.side === place.side && r.ac === ac && Math.abs(r.lineZ - place.lineZ) <= ISLAND_MERGE_M,
      );
      if (existing != null) existing.list.push(entry);
      else
        rowsAt.set(`${place.side}:${String(place.lineZ)}:${String(ac)}`, {
          ...place,
          ac,
          list: [entry],
        });
    }
    const remoteRows: PanelGroup[] = [];
    for (const row of [...rowsAt.values()].sort((a, b) => a.lineZ - b.lineZ)) {
      const end = row.frame;
      // Pads in this frame: a rack row never stands on one, and its feeder,
      // which reaches the racks along their line from outside, never crosses one.
      const endPads = pads.map((b) => {
        const p = end.to({ x: b.minX, z: b.minZ });
        const q = end.to({ x: b.maxX, z: b.maxZ });
        return {
          minX: Math.min(p.x, q.x),
          maxX: Math.max(p.x, q.x),
          minZ: Math.min(p.z, q.z),
          maxZ: Math.max(p.z, q.z),
        };
      });
      const circuits = row.list.reduce((n, e) => n + e.panel.circuits.length, 0);
      if (row.ac) {
        // On the island or the curb strip at the row end nearest the
        // equipment pad, inside the lot, the racks from the end curb inward;
        // where another group's chargers stand between that end and the run
        // (a custom site's free rows), just before the run's first charger.
        // Either spot keeps clear of every charger on the line, and the
        // feeder comes in along the line from the lot edge, never across a
        // pad. No room at either: the racks stand in the switchboard row on
        // the equipment pad, next to the transformer.
        const own = new Set(
          row.list.flatMap((e) => e.panel.circuits.flatMap((c) => c.stations.map((st) => st.id))),
        );
        const nearLine = (z: number): boolean =>
          Math.abs(z - row.lineZ) <= ISLAND_MERGE_M + RACK_HALF_M;
        const points = [...stations.entries()].map(([id, p]) => ({
          own: own.has(id),
          c: end.to(p.charger),
          k: end.to(p.back),
        }));
        const ownXs = points
          .filter((p) => p.own && (nearLine(p.c.z) || nearLine(p.k.z)))
          .map((p) => Math.min(p.c.x, p.k.x));
        const runStart = ownXs.length > 0 ? Math.min(...ownXs) : end.ground.minX;
        const span = (row.list.length - 1) * PANELBOARD_PITCH_M;
        const fits = (firstX: number, rowEnd: boolean): boolean => {
          const lastX = firstX + span;
          const clear = RACK_TURNED_HALF_M + RACK_CHARGER_CLEAR_M;
          return (
            !points.some(
              (p) =>
                ((nearLine(p.c.z) || nearLine(p.k.z)) &&
                  Math.max(p.c.x, p.k.x) > firstX - clear + 1e-6 &&
                  Math.min(p.c.x, p.k.x) < lastX + clear - 1e-6) ||
                // Another group's charger between the row end and the run.
                (rowEnd &&
                  !p.own &&
                  Math.abs(p.c.z - row.lineZ) <= INTERVENE_BAND_M &&
                  p.c.x > firstX &&
                  p.c.x < runStart),
            ) &&
            // Never on a pad.
            !endPads.some(
              (b) =>
                b.minX < lastX + RACK_TURNED_HALF_M &&
                b.maxX > firstX - RACK_TURNED_HALF_M &&
                b.minZ < row.lineZ + RACK_HALF_M &&
                b.maxZ > row.lineZ - RACK_HALF_M,
            )
          );
        };
        const atRowEnd = end.ground.minX + RACK_INSET_M;
        const atRun = runStart - RACK_TURNED_HALF_M - RACK_CHARGER_CLEAR_M - span;
        const firstX = fits(atRowEnd, true)
          ? atRowEnd
          : atRun > atRowEnd && fits(atRun, false)
            ? atRun
            : null;
        const blocked = firstX == null;
        if (blocked) {
          for (const e of row.list) away.delete(e.panel);
          continue;
        }
        remoteRows.push({
          frame: { ...end, transformer: { x: end.transformer.x, z: row.lineZ } },
          flat: row.list,
          model: 'panelboard',
          remote: true,
          firstX,
          // Inward, away from the lot edge.
          pitch: -PANELBOARD_PITCH_M,
        });
        continue;
      }
      let lineZ = row.lineZ;
      const hit = endPads.find(
        (b) =>
          b.minX < end.ground.minX &&
          b.minZ < lineZ + RACK_HALF_M + LINK_SPACING_M &&
          b.maxZ > lineZ - RACK_HALF_M - LINK_SPACING_M,
      );
      if (hit != null) {
        // A pad at the row end: the cabinets stand just beside it, toward the lot's middle.
        const toMiddle = (end.ground.minZ + end.ground.maxZ) / 2 >= lineZ ? 1 : -1;
        lineZ =
          toMiddle > 0
            ? hit.maxZ + RACK_HALF_M + LINK_SPACING_M
            : hit.minZ - RACK_HALF_M - LINK_SPACING_M;
      }
      const rowFrame: PanelFrame = { ...end, transformer: { x: end.transformer.x, z: lineZ } };
      const edge = rowFrame.ground.minX - LANE_START_M - (circuits - 1) * LINK_SPACING_M;
      remoteRows.push({
        frame: rowFrame,
        flat: row.list,
        model: 'switchboard',
        remote: true,
        firstX: edge - PANEL_FROM_LANES_M,
        pitch: PANEL_PAD_PITCH_M,
      });
    }
    const pad = flat.filter((e) => !away.has(e.panel));
    const padCircuits = Math.max(
      1,
      pad.reduce((n, e) => n + e.panel.circuits.length, 0),
    );
    const laneEdge = frame.ground.minX - LANE_START_M - (padCircuits - 1) * LINK_SPACING_M;
    out.push({
      frame,
      flat: pad,
      model: 'switchboard',
      remote: false,
      firstX: Math.min(
        frame.transformer.x - PANEL_FROM_TRANSFORMER_M,
        laneEdge - PANEL_FROM_LANES_M,
      ),
      pitch: PANEL_PAD_PITCH_M,
    });
    out.push(...remoteRows);
  }
  return out;
}

/**
 * Where each panel model stands, in hierarchy order within its row (a
 * sub-panel right after its parent, so it stands next to it). Each top-level
 * panel's subtree stands at its transformer (`equipmentGroups`): a row of
 * switchboard cabinets on the grass at the transformer's end of the rows
 * (`panelFrame`), in line with the transformer, the first
 * PANEL_FROM_TRANSFORMER_M beyond it (and outside the cable lanes along the
 * ground's edge), one every PANEL_PAD_PITCH_M further out. An AC panelboard
 * whose stations stand away from the pad stands on a rack on the island or
 * curb strip at their row end nearest the pad, turned to face the lot edge
 * (`panelGroups`). `ground` is the lot of a parking lot, the
 * yard of a depot, or the box around a custom site's stations' spots;
 * `stations` and `acStations` (the AC stations' ids) place the panelboards.
 */
export function placePanels(
  hierarchy: readonly LinkPanel[],
  ground: Box,
  transformers?: Transformers,
  stations: ReadonlyMap<string, LinkStationPoint> = new Map(),
  acStations: ReadonlySet<string> = new Set(),
  /** The equipment pads (transformers, batteries) a panelboard rack keeps off. */
  pads: readonly Box[] = [],
): PanelPlacement[] {
  return panelGroups(hierarchy, ground, transformers, stations, acStations, pads).flatMap((g) =>
    g.flat.map(({ panel, parentId }, i) => ({
      id: panel.id,
      parentId,
      name: panel.name,
      amps: panel.breakerRatingAmps,
      kw: panel.maxContinuousKw,
      point: g.frame.from({ x: g.firstX - i * g.pitch, z: g.frame.transformer.z }),
      // A split system's power cabinet keeps its own model wherever its row stands.
      model: panel.id.startsWith(CABINET_PREFIX) ? 'cabinet' : g.model,
      // A rack at a row end faces the lot edge (-x in its frame).
      turn:
        g.remote && g.model === 'panelboard'
          ? (g.frame.side === 'left' ? -1 : 1) * (Math.PI / 2)
          : 0,
    })),
  );
}

interface Row {
  /** The back points' line: the outermost in `dirBack`, the middle of an island. */
  lineZ: number;
  /** +1 when the backs of the chargers face +z, -1 when they face -z, 0 on an island (both). */
  dirBack: 1 | -1 | 0;
  /** The lowest and highest back point (the island's two back lines). */
  lo: number;
  hi: number;
  members: Array<{ station: LinkStation; point: LinkStationPoint }>;
  /** The farthest station along x. */
  xmax: number;
}

/**
 * Back lines that share one run: within ROW_TOLERANCE_M, or the two back
 * lines of an island (a row whose chargers face -z right after one whose
 * chargers face +z, within ISLAND_MERGE_M), whose chargers stand back to
 * back with the conduit between them.
 */
function sharesRun(prev: { z: number; dir: number }, cur: { z: number; dir: number }): boolean {
  const gap = cur.z - prev.z;
  if (gap <= ROW_TOLERANCE_M + 1e-6) return true;
  return prev.dir >= 0 && cur.dir <= 0 && prev.dir !== cur.dir && gap <= ISLAND_MERGE_M;
}

/** Groups items by their back line (`sharesRun`), in z order. */
function groupByLine<T>(items: readonly T[], line: (t: T) => { z: number; dir: number }): T[][] {
  const sorted = [...items].sort((a, b) => line(a).z - line(b).z);
  const groups: T[][] = [];
  for (const item of sorted) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (last != null && prev != null && sharesRun(line(prev), line(item))) last.push(item);
    else groups.push([item]);
  }
  return groups;
}

const dirOf = (m: Row['members'][number]): number => Math.sign(m.point.back.z - m.point.charger.z);

/** Stations of one circuit grouped into rows by the z of their backs (frame points). */
function rowsOf(members: Row['members']): Row[] {
  return groupByLine(members, (m) => ({ z: m.point.back.z, dir: dirOf(m) })).map((g) => {
    const dirs = new Set(g.map(dirOf).filter((d) => d !== 0));
    const zs = g.map((m) => m.point.back.z);
    const lo = Math.min(...zs);
    const hi = Math.max(...zs);
    const dirBack: 1 | -1 | 0 = dirs.size > 1 ? 0 : dirs.has(-1) ? -1 : 1;
    return {
      lineZ: dirBack === 0 ? (lo + hi) / 2 : dirBack > 0 ? hi : lo,
      dirBack,
      lo,
      hi,
      members: g,
      xmax: Math.max(...g.map((m) => m.point.back.x)),
    };
  });
}

interface Trunk {
  circuit: LinkCircuit;
  panelIndex: number;
  panelX: number;
  /** +1: its rows lie past the switchboard row in +z; -1: in -z. */
  dir: 1 | -1;
  rows: Row[];
  /** How far its farthest row lies from the switchboard row. */
  reach: number;
  rank: number;
  lane: number;
  corridor: number;
  stub: number;
  /** The z of its run along each row (by row index). */
  runZ: number[];
}

/**
 * The cable runs of a load management hierarchy on the ground, from the
 * panel models (`placePanels`) and the points of each station on the layout
 * (`stations`, its charger and its back). Circuits without a station on the
 * layout are left out. Every panel gets its label (name, breaker, limit), a
 * circuit its label where its trunk turns onto the row nearest the
 * switchboards, a station with an allocated limit its label on its branch.
 */
export function loadLinks(
  hierarchy: readonly LinkPanel[],
  panels: readonly PanelPlacement[],
  stations: ReadonlyMap<string, LinkStationPoint>,
  ground: Box,
  transformers?: Transformers,
  acStations: ReadonlySet<string> = new Set(),
  /** The equipment pads (transformers, batteries) the feeders keep outside of. */
  pads: readonly Box[] = [],
): LoadLinks {
  const out: LoadLinks = { segments: [], labels: [] };
  const groups = panelGroups(hierarchy, ground, transformers, stations, acStations, pads);
  for (const g of groups) {
    const links = groupLinks(g, panels, stations);
    out.segments.push(...links.segments);
    out.labels.push(...links.labels);
  }
  out.segments.push(...feederLinks(groups, panels, out.segments, pads));
  return out;
}

/**
 * The feeders of the remote panel rows (`panelGroups`), each from its parent
 * switchboard by the shortest real route: along the switchboard row's trench
 * past its last pad, along the lot edge at the switchboard row's own end
 * outside every other run, and in along the rack's line (an AC rack on its
 * island or curb strip: no aisle crossed inside the lot). A DC switchboard
 * row at the other end gets its feeder around the lot. The feeders of one
 * switchboard row run nearest row first, each further one LINK_SPACING_M
 * outside the one before, so they never cross each other or any other run.
 */
function feederLinks(
  groups: readonly PanelGroup[],
  panels: readonly PanelPlacement[],
  others: readonly LinkSegment[],
  pads: readonly Box[],
): LinkSegment[] {
  const at = new Map(panels.map((p) => [p.id, p.point]));
  // Every run point and every pad corner: the feeder passes outside all of them.
  const points = [
    ...others.flatMap((s) => s.points),
    ...pads.flatMap((b) => [
      { x: b.minX, z: b.minZ },
      { x: b.maxX, z: b.maxZ },
    ]),
  ];
  const out: LinkSegment[] = [];
  const homeOf = (remote: PanelGroup): PanelGroup | undefined =>
    groups.find(
      (g) => !g.remote && remote.flat.some((r) => g.flat.some((h) => h.panel.id === r.parentId)),
    );
  // The feeders of one switchboard row at its own end, nearest row first: each
  // further one runs LINK_SPACING_M outside the one before, so the nearer
  // feeder's turn in toward its rack never meets the farther one.
  const reach = (g: PanelGroup): number => {
    const home = homeOf(g);
    return home == null ? 0 : Math.abs(g.frame.transformer.z - home.frame.transformer.z);
  };
  const remotes = groups.filter((g) => g.remote).sort((a, b) => reach(a) - reach(b));
  const taken = new Map<PanelGroup, number>();
  for (const remote of remotes) {
    const home = homeOf(remote);
    if (home == null) continue;
    const before = taken.get(home) ?? 0;
    taken.set(home, before + remote.flat.length);
    const zs = [...points.map((p) => p.z), ...panels.map((p) => p.point.z)];
    const xs = [...points.map((p) => p.x), ...panels.map((p) => p.point.x)];
    const front = Math.min(...zs) - FEEDER_OUTSIDE_M;
    const back = Math.max(...zs) + FEEDER_OUTSIDE_M;
    const homeZ = home.frame.transformer.z;
    const farZ = remote.frame.transformer.z;
    // Along the lot edge on the switchboard row's side, then down the far
    // row ends to the rack: every feeder of a site takes the same curb strip
    // and the row ends its panelboards stand at (both edges are equally long
    // between the two ends; the home side needs no turn around the
    // switchboard row). The other edge when that route would pass through an
    // equipment pad.
    const homeFront = Math.abs(homeZ - front) <= Math.abs(back - homeZ);
    // The outermost pad of each row, in site x (beyond it nothing of the row runs).
    const outer = (g: PanelGroup): number =>
      g.frame.from({ x: g.firstX - (g.flat.length - 1) * g.pitch - FEEDER_OUTSIDE_M, z: 0 }).x;
    const homeDir = Math.sign(outer(home) - home.frame.from({ x: home.firstX, z: 0 }).x);
    const farDir = Math.sign(outer(remote) - remote.frame.from({ x: remote.firstX, z: 0 }).x);
    // Outside everything on each side of the site.
    const beyond = (dir: number, rowOut: number): number =>
      dir < 0
        ? Math.min(rowOut, Math.min(...xs) - FEEDER_OUTSIDE_M)
        : Math.max(rowOut, Math.max(...xs) + FEEDER_OUTSIDE_M);
    const homeOut = beyond(homeDir, outer(home));
    const farOut = beyond(farDir, outer(remote));
    remote.flat.forEach(({ panel, parentId }, k) => {
      const node = at.get(panel.id);
      const parent = parentId != null ? at.get(parentId) : undefined;
      if (node == null || parent == null) return;
      const step = (before + k) * LINK_SPACING_M;
      const x0 = homeOut + homeDir * step;
      const x1 = farOut + farDir * step;
      const route = (viaFront: boolean): Point[] => {
        const edgeZ = viaFront ? front - step : back + step;
        return [
          { x: parent.x, z: homeZ },
          { x: x0, z: homeZ },
          { x: x0, z: edgeZ },
          { x: x1, z: edgeZ },
          { x: x1, z: farZ },
          { x: node.x, z: farZ },
        ];
      };
      // At the switchboard row's own end (every AC rack): straight along that
      // end, outside every other run, to the rack's line, then in along it.
      const sameEnd = home.frame.side === remote.frame.side;
      const xs0 = x0;
      // In along the rack's line, else (an equipment pad on that line) along
      // the first line toward the switchboard row that passes no pad, then
      // along the racks' end to the rack.
      const alongAt = (z: number): Point[] =>
        Math.abs(z - farZ) < 1e-9
          ? [
              { x: parent.x, z: homeZ },
              { x: xs0, z: homeZ },
              { x: xs0, z: farZ },
              { x: node.x, z: farZ },
            ]
          : [
              { x: parent.x, z: homeZ },
              { x: xs0, z: homeZ },
              { x: xs0, z },
              { x: node.x, z },
              { x: node.x, z: farZ },
            ];
      const toward = Math.sign(homeZ - farZ);
      const tries = Math.floor(Math.abs(homeZ - farZ) / LINK_SPACING_M);
      let along = alongAt(farZ);
      for (let j = 1; j <= tries && pads.some((pad) => polylineHitsBox(along, pad)); j++) {
        along = alongAt(farZ + toward * j * LINK_SPACING_M);
      }
      const first = sameEnd ? along : route(homeFront);
      out.push({
        id: `panel:${panel.id}`,
        flowId: `panel:${panel.id}`,
        kind: 'panel',
        points:
          !sameEnd && pads.some((pad) => polylineHitsBox(first, pad)) ? route(!homeFront) : first,
      });
    });
  }
  return out;
}

/** Whether an orthogonal polyline passes through the inside of a box. */
function polylineHitsBox(points: readonly Point[], box: Box): boolean {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a == null || b == null) continue;
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minZ = Math.min(a.z, b.z);
    const maxZ = Math.max(a.z, b.z);
    if (minX < box.maxX && maxX > box.minX && minZ < box.maxZ && maxZ > box.minZ) return true;
  }
  return false;
}

/** The cable runs of one routing group (its row of panels, its transformer). */
function groupLinks(
  group: PanelGroup,
  panels: readonly PanelPlacement[],
  stations: ReadonlyMap<string, LinkStationPoint>,
): LoadLinks {
  const segments: LinkSegment[] = [];
  const labels: LinkLabel[] = [];
  const frame = group.frame;
  const back = (points: Point[]): Point[] => points.map(frame.from);
  const at = new Map(panels.map((p) => [p.id, frame.to(p.point)]));
  const flat = group.flat;
  const pz = frame.transformer.z;

  // Panel labels, the transformer's service cables and the sub-panel feeders:
  // one trench along the switchboard row (the transformer stands in line with
  // it), so these runs only touch the circuits' stubs where they leave a
  // switchboard and never cross them.
  for (const { panel, parentId } of flat) {
    const node = at.get(panel.id);
    if (node == null) continue;
    labels.push({
      id: `panel:${panel.id}`,
      kind: 'panel',
      point: frame.from(node),
      name: panel.name,
      amps: panel.breakerRatingAmps,
      kw: panel.maxContinuousKw,
    });
    const parent = parentId != null ? at.get(parentId) : undefined;
    const sameRow = parentId != null && flat.some((e) => e.panel.id === parentId);
    if (parentId == null) {
      segments.push({
        id: `feed:${panel.id}`,
        flowId: `panel:${panel.id}`,
        kind: 'panel',
        points: back([
          { x: frame.transformer.x, z: pz },
          { x: node.x, z: pz },
        ]),
      });
    } else if (parent != null && sameRow) {
      segments.push({
        id: `panel:${panel.id}`,
        flowId: `panel:${panel.id}`,
        kind: 'panel',
        points: back([
          { x: parent.x, z: pz },
          { x: node.x, z: pz },
        ]),
      });
    }
  }

  // One trunk per circuit and direction. A panelboard rack at a row end
  // feeds the stations of its own row line straight along the row (`direct`),
  // the others through the lanes at the row ends like a switchboard.
  const trunks: Trunk[] = [];
  const direct: Array<{ circuit: LinkCircuit; panelIndex: number; panelX: number; row: Row }> = [];
  flat.forEach(({ panel }, panelIndex) => {
    const node = at.get(panel.id);
    if (node == null) return;
    for (const circuit of panel.circuits) {
      const members = circuit.stations.flatMap((station) => {
        const p = stations.get(station.id);
        return p != null
          ? [{ station, point: { charger: frame.to(p.charger), back: frame.to(p.back) } }]
          : [];
      });
      if (members.length === 0) continue;
      const onLine = (r: Row): boolean => group.remote && Math.abs(r.lineZ - pz) <= ISLAND_MERGE_M;
      for (const row of rowsOf(members).filter(onLine)) {
        direct.push({ circuit, panelIndex, panelX: node.x, row });
      }
      for (const dir of [1, -1] as const) {
        const rows = rowsOf(members).filter(
          (r) => !onLine(r) && (dir > 0 ? r.lineZ >= pz : r.lineZ < pz),
        );
        if (rows.length === 0) continue;
        trunks.push({
          circuit,
          panelIndex,
          panelX: node.x,
          dir,
          rows,
          reach: Math.max(...rows.map((r) => Math.abs(r.lineZ - pz))),
          rank: 0,
          lane: 0,
          corridor: 0,
          stub: 0,
          runZ: [],
        });
      }
    }
  });

  for (const dir of [1, -1] as const) {
    const group = trunks.filter((t) => t.dir === dir);
    // Nearer rows take the lanes nearer the ground and the corridors nearer
    // the switchboard row, so a run never crosses a lane further in. On a
    // shared farthest row the trunk ending sooner runs nearer the chargers.
    group.sort((a, b) => {
      if (Math.abs(a.reach - b.reach) > ROW_TOLERANCE_M) return a.reach - b.reach;
      const topA = a.rows.reduce((m, r) =>
        Math.abs(r.lineZ - pz) > Math.abs(m.lineZ - pz) ? r : m,
      );
      const topB = b.rows.reduce((m, r) =>
        Math.abs(r.lineZ - pz) > Math.abs(m.lineZ - pz) ? r : m,
      );
      const nearerFirst = topA.dirBack === dir ? 1 : -1;
      return nearerFirst * (topA.xmax - topB.xmax) || a.panelIndex - b.panelIndex;
    });
    group.forEach((t, rank) => {
      t.rank = rank;
    });
  }

  // The runs along each row line: behind the chargers, LINK_SPACING_M apart,
  // a lower rank nearer the switchboard side. On an island (chargers back to
  // back) the runs share the strip between the two back lines.
  const entries = trunks.flatMap((trunk) =>
    trunk.rows.map((row, index) => ({ trunk, row, index })),
  );
  const shared = groupByLine(entries, (e) => ({
    z: e.row.dirBack === 0 ? e.row.lo : e.row.lineZ,
    dir: e.row.dirBack,
  }));
  for (const list of shared) {
    const first = list[0];
    if (first == null) continue;
    const dirs = new Set(list.map((l) => l.row.dirBack));
    const island = dirs.has(0) || (dirs.has(1) && dirs.has(-1));
    let slots: number[];
    if (island) {
      const lo = Math.min(...list.map((l) => l.row.lo));
      const hi = Math.max(...list.map((l) => l.row.hi));
      slots = list.map((_, j) => lo + ((j + 1) * (hi - lo)) / (list.length + 1));
    } else {
      const dirBack = first.row.dirBack >= 0 ? 1 : -1;
      const base =
        dirBack > 0
          ? Math.max(...list.map((l) => l.row.lineZ))
          : Math.min(...list.map((l) => l.row.lineZ));
      slots = list.map((_, j) => base + dirBack * (TRUNK_BEHIND_M + j * LINK_SPACING_M));
    }
    const base = first.row.lineZ;
    if (island) {
      // The runs of the stations behind the lower back line run lowest, those
      // behind the upper one highest, so no branch crosses another run. On
      // each line the run of the station nearest the lanes (the shortest run)
      // lies nearest the line, so the other stations' branches never pass it.
      slots.sort((a, b) => a - b);
      const nearest = (a: (typeof list)[number], b: (typeof list)[number]): number =>
        a.row.xmax - b.row.xmax || a.trunk.rank - b.trunk.rank;
      const lower = list.filter((l) => l.row.dirBack > 0).sort(nearest);
      const middle = list
        .filter((l) => l.row.dirBack === 0)
        .sort((a, b) => a.trunk.rank - b.trunk.rank);
      const upper = list.filter((l) => l.row.dirBack < 0).sort(nearest);
      [...lower, ...middle, ...upper.reverse()].forEach((l, j) => {
        l.trunk.runZ[l.index] = slots[j] ?? base;
      });
      continue;
    }
    slots.sort((a, b) => first.trunk.dir * (a - b));
    [...list]
      .sort((a, b) => a.trunk.rank - b.trunk.rank)
      .forEach((l, j) => {
        l.trunk.runZ[l.index] = slots[j] ?? base;
      });
  }

  // Lanes, corridors and stubs by the actual run farthest from the
  // switchboard row (an island can put a shorter trunk on the outer run): a
  // run never crosses a lane further in. A later rank leaves its switchboard
  // further from the ground, so its stub never crosses an earlier corridor of
  // the same switchboard.
  for (const dir of [1, -1] as const) {
    const farRun = (t: Trunk): number =>
      Math.max(...t.rows.map((r, i) => Math.abs((t.runZ[i] ?? r.lineZ) - pz)));
    const group = trunks
      .filter((t) => t.dir === dir)
      .sort((a, b) => farRun(a) - farRun(b) || a.rank - b.rank);
    group.forEach((t, rank) => {
      t.rank = rank;
      t.lane = frame.ground.minX - LANE_START_M - rank * LINK_SPACING_M;
      t.corridor = pz + dir * (CORRIDOR_GAP_M + rank * LINK_SPACING_M);
    });
    const byPanel = new Map<number, Trunk[]>();
    for (const t of group) byPanel.set(t.panelIndex, [...(byPanel.get(t.panelIndex) ?? []), t]);
    for (const list of byPanel.values()) {
      const step = list.length > 1 ? Math.min(LINK_SPACING_M, 1.6 / (list.length - 1)) : 0;
      list.forEach((t, q) => {
        t.stub = t.panelX + ((list.length - 1) / 2 - q) * step;
      });
    }
  }

  for (const t of trunks) {
    const id = `circuit:${t.circuit.id}`;
    const runs = t.rows.map((row, i) => ({ row, z: t.runZ[i] ?? row.lineZ }));
    const far = runs.reduce((m, r) => (Math.abs(r.z - pz) > Math.abs(m.z - pz) ? r : m));
    const near = runs.reduce((m, r) => (Math.abs(r.z - pz) < Math.abs(m.z - pz) ? r : m));
    const suffix = t.dir > 0 ? '' : ':down';
    segments.push({
      id: `${id}${suffix}`,
      flowId: id,
      kind: 'circuit',
      points: back([
        { x: t.stub, z: pz },
        { x: t.stub, z: t.corridor },
        { x: t.lane, z: t.corridor },
        { x: t.lane, z: far.z },
      ]),
    });
    // A row between the switchboard row and the corridor: the lane runs back to it too.
    const behind = runs.filter(
      (r) => Math.sign(r.z - t.corridor) === -Math.sign(far.z - t.corridor),
    );
    if (behind.length > 0) {
      const z = behind.reduce(
        (m, r) => (Math.abs(r.z - t.corridor) > Math.abs(m - t.corridor) ? r.z : m),
        t.corridor,
      );
      segments.push({
        id: `${id}${suffix}:back`,
        flowId: id,
        kind: 'circuit',
        points: back([
          { x: t.lane, z: t.corridor },
          { x: t.lane, z },
        ]),
      });
    }
    if (!labels.some((l) => l.id === id)) {
      labels.push({
        id,
        kind: 'circuit',
        point: frame.from({ x: t.lane, z: near.z }),
        name: t.circuit.name,
        amps: t.circuit.breakerRatingAmps,
        kw: t.circuit.maxContinuousKw,
      });
    }
    runs.forEach(({ row, z }, i) => {
      segments.push({
        id: `${id}${suffix}:row:${String(i)}`,
        flowId: id,
        kind: 'circuit',
        points: back([
          { x: t.lane, z },
          { x: row.xmax, z },
        ]),
      });
      for (const { station, point } of row.members) {
        const branch = [
          { x: point.back.x, z },
          { x: point.back.x, z: point.back.z },
        ];
        segments.push({
          id: `station:${station.id}`,
          flowId: `station:${station.id}`,
          kind: 'station',
          points: back(branch),
        });
        if (station.allocatedLimitKw != null) {
          labels.push({
            id: `station:${station.id}`,
            kind: 'station',
            point: frame.from({ x: point.back.x, z: (z + point.back.z) / 2 }),
            name: null,
            amps: null,
            kw: station.allocatedLimitKw,
          });
        }
      }
    });
  }
  segments.push(...directRuns(direct, frame, labels));
  return { segments, labels };
}

/**
 * The runs of a panelboard rack's circuits along its own row line: out of the
 * rack and straight along the row behind the chargers (an edge row: behind
 * its back line, `TRUNK_BEHIND_M` and one spacing apart; an island: spread
 * between its two back lines), with a branch to each charger. The shortest
 * run lies nearest the back line and leaves the rack nearest the lot, so a
 * run never crosses another rack stub (frame points).
 */
function directRuns(
  direct: ReadonlyArray<{ circuit: LinkCircuit; panelIndex: number; panelX: number; row: Row }>,
  frame: PanelFrame,
  labels: LinkLabel[],
): LinkSegment[] {
  const out: LinkSegment[] = [];
  if (direct.length === 0) return out;
  const pz = frame.transformer.z;
  const back = (points: Point[]): Point[] => points.map(frame.from);
  const lo = Math.min(...direct.map((d) => d.row.lo));
  const hi = Math.max(...direct.map((d) => d.row.hi));
  const island = direct.some((d) => d.row.dirBack === 0) || hi - lo > ROW_TOLERANCE_M;
  const byX = (a: (typeof direct)[number], b: (typeof direct)[number]): number =>
    a.row.xmax - b.row.xmax || a.panelIndex - b.panelIndex;
  // The run of each entry. An edge row: behind its back line, the shortest run
  // nearest the line, so no branch passes a run that ends before it. An
  // island: spread between its two back lines, the stations of each line's
  // shortest run nearest that line (as `groupLinks` does).
  let order: Array<(typeof direct)[number]>;
  if (island) {
    const lower = direct.filter((d) => d.row.dirBack > 0).sort(byX);
    const middle = direct.filter((d) => d.row.dirBack === 0).sort(byX);
    const upper = direct.filter((d) => d.row.dirBack < 0).sort(byX);
    order = [...lower, ...middle, ...upper.reverse()];
  } else {
    order = [...direct].sort(byX);
  }
  const dirBack = order[0]?.row.dirBack === -1 ? -1 : 1;
  const slotted = order.map((d, j) => ({
    d,
    z: island
      ? lo + ((j + 1) * (hi - lo)) / (order.length + 1)
      : (dirBack > 0 ? hi : lo) + dirBack * (TRUNK_BEHIND_M + j * LINK_SPACING_M),
  }));
  // The stubs of a rack: the run nearest the rack line leaves nearest the lot,
  // so a run never passes another stub of its rack.
  const stubs = new Map<(typeof direct)[number], number>();
  const racks = new Set(direct.map((d) => d.panelIndex));
  for (const rack of racks) {
    slotted
      .filter((e) => e.d.panelIndex === rack)
      .sort((a, b) => Math.abs(a.z - pz) - Math.abs(b.z - pz))
      .forEach((e, q) => stubs.set(e.d, e.d.panelX + 0.4 - q * LINK_SPACING_M));
  }
  slotted.forEach(({ d, z }, j) => {
    const stub = stubs.get(d) ?? d.panelX;
    const id = `circuit:${d.circuit.id}`;
    out.push({
      id: `${id}:direct:${String(j)}`,
      flowId: id,
      kind: 'circuit',
      points: back([
        { x: stub, z: pz },
        { x: stub, z },
        { x: d.row.xmax, z },
      ]),
    });
    if (!labels.some((l) => l.id === id)) {
      labels.push({
        id,
        kind: 'circuit',
        point: frame.from({ x: stub, z }),
        name: d.circuit.name,
        amps: d.circuit.breakerRatingAmps,
        kw: d.circuit.maxContinuousKw,
      });
    }
    for (const { station, point } of d.row.members) {
      out.push({
        id: `station:${station.id}`,
        flowId: `station:${station.id}`,
        kind: 'station',
        points: back([
          { x: point.back.x, z },
          { x: point.back.x, z: point.back.z },
        ]),
      });
      if (station.allocatedLimitKw != null) {
        labels.push({
          id: `station:${station.id}`,
          kind: 'station',
          point: frame.from({ x: point.back.x, z: (z + point.back.z) / 2 }),
          name: null,
          amps: null,
          kw: station.allocatedLimitKw,
        });
      }
    }
  });
  return out;
}

/**
 * Protective bollards around pad-mounted equipment exposed to traffic: Eugene
 * Water & Electric Board, Distribution Design Standard ED5-1.0800 Rev 1
 * (approved 2013-06-03), "Bollard Placement Requirements for Padmounted
 * Equipment", https://www.eweb.org/documents/contractor-developer/electric-standards/ED510800.pdf,
 * used as one utility's representative standard (utilities differ):
 *
 * - Page 1: "No bollards are required when 3' min distance behind curb is met
 *   and traffic direction is as shown" (traffic passing alongside the curb);
 *   "bollards are required as shown in alleys without curbs when exposed to
 *   traffic", 3 ft (0.91 m) min from the pad, 6 ft 6 in (1.98 m) max apart.
 * - Page 2: a pad facing a parking area stands 5 ft (1.52 m) min from it;
 *   "bollards are required as shown in parking areas without parking strip
 *   stops or curbs"; bollards "are required ... when padmount equipment is
 *   exposed to backing trucks".
 * - Page 3: a curbed island in commercial truck traffic needs "a minimum of
 *   (1) bollard for visual deterrent" (note 2.4).
 * - Page 4: section 2.1 (bollards on the sides exposed to traffic), 2.2
 *   (interim bollards beyond 6 ft 6 in), reference D (EC5-9.2600, 6.625 in
 *   (0.168 m) OD galvanized steel post).
 *
 * The layout cannot tell the traffic direction along a curb, so a curbed side
 * counts as facing a parking area: bollards when the pad stands closer than
 * 5 ft to it (the page 2 distance), none from 5 ft. A side without a curb (a
 * depot yard, the open lane ends of a truck pull-through) gets bollards at any
 * distance (pages 1 and 2). No layout puts equipment on a curbed island in
 * truck traffic (page 3). The visible height (0.9 m) has no source; it
 * matches the charger bollards of the scene.
 */
export const EQUIPMENT_BOLLARD = {
  offsetM: 0.91,
  maxSpacingM: 1.98,
  radiusM: 0.084,
  heightM: 0.9,
  /** A curbed parking area this close or closer to a pad side needs bollards (5 ft, page 2). */
  curbedClearM: 1.52,
} as const;

/** The concrete pads of the transformer (2.9 by 2.5 m) and battery (4.0 by 2.0 m) models, x by z. */
export const EQUIPMENT_PAD_SIZE = {
  transformer: { w: 2.9, d: 2.5 },
  battery: { w: 4.0, d: 2.0 },
} as const;

/** The pad of a transformer or battery model centered on `p`. */
export function equipmentPadBox(p: Point, kind: keyof typeof EQUIPMENT_PAD_SIZE): Box {
  const { w, d } = EQUIPMENT_PAD_SIZE[kind];
  return { minX: p.x - w / 2, maxX: p.x + w / 2, minZ: p.z - d / 2, maxZ: p.z + d / 2 };
}

/** A paved area equipment keeps clear of, and whether a curb bounds it. */
export interface EquipmentGround {
  box: Box;
  curbed: boolean;
}

/**
 * Where the bollards of one equipment pad stand (`EQUIPMENT_BOLLARD`): a line
 * along each pad side facing a paved area (one lying wholly beyond that side
 * and overlapping the side's span), EQUIPMENT_BOLLARD.offsetM out from the pad
 * and running past both corners, evenly spaced at most maxSpacingM apart. A
 * curbed area counts only within curbedClearM of the side; an area without a
 * curb at any distance. An uncurbed area beside the pad only diagonally gets
 * one corner bollard (page 1, the corner where vehicles turn).
 */
export function equipmentBollards(pad: Box, grounds: readonly EquipmentGround[]): Point[] {
  const off = EQUIPMENT_BOLLARD.offsetM;
  const xs: [number, number] = [pad.minX - off, pad.maxX + off];
  const zs: [number, number] = [pad.minZ - off, pad.maxZ + off];
  const sides = { right: false, left: false, back: false, front: false };
  const corners: Point[] = [];
  for (const { box: g, curbed } of grounds) {
    const spanX = g.minX < pad.maxX && g.maxX > pad.minX;
    const spanZ = g.minZ < pad.maxZ && g.maxZ > pad.minZ;
    const near = (gap: number): boolean => !curbed || gap < EQUIPMENT_BOLLARD.curbedClearM;
    if (spanZ && g.minX >= pad.maxX && near(g.minX - pad.maxX)) sides.right = true;
    if (spanZ && g.maxX <= pad.minX && near(pad.minX - g.maxX)) sides.left = true;
    if (spanX && g.minZ >= pad.maxZ && near(g.minZ - pad.maxZ)) sides.back = true;
    if (spanX && g.maxZ <= pad.minZ && near(pad.minZ - g.maxZ)) sides.front = true;
    if (!curbed && !spanX && !spanZ) {
      corners.push({
        x: g.minX >= pad.maxX ? xs[1] : xs[0],
        z: g.minZ >= pad.maxZ ? zs[1] : zs[0],
      });
    }
  }
  const lines: Array<[Point, Point]> = [];
  if (sides.right)
    lines.push([
      { x: xs[1], z: zs[0] },
      { x: xs[1], z: zs[1] },
    ]);
  if (sides.left)
    lines.push([
      { x: xs[0], z: zs[0] },
      { x: xs[0], z: zs[1] },
    ]);
  if (sides.back)
    lines.push([
      { x: xs[0], z: zs[1] },
      { x: xs[1], z: zs[1] },
    ]);
  if (sides.front)
    lines.push([
      { x: xs[0], z: zs[0] },
      { x: xs[1], z: zs[0] },
    ]);
  const out: Point[] = [];
  const add = (p: Point): void => {
    if (!out.some((o) => Math.abs(o.x - p.x) < 1e-6 && Math.abs(o.z - p.z) < 1e-6)) out.push(p);
  };
  for (const [a, b] of lines) {
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const gaps = Math.max(1, Math.ceil(length / EQUIPMENT_BOLLARD.maxSpacingM - 1e-9));
    for (let i = 0; i <= gaps; i++) {
      add({ x: a.x + ((b.x - a.x) * i) / gaps, z: a.z + ((b.z - a.z) * i) / gaps });
    }
  }
  for (const c of corners) add(c);
  return out;
}

/** The runs along a facade lie this far apart, in meters (no source; visual spacing on the sidewalk). */
const FACADE_RUN_SPACING_M = 0.15;
/** The first run along a facade lies this far out from the wall, in meters (no source). */
const FACADE_RUN_FROM_WALL_M = 0.12;
/**
 * How far the facade runs may spread across the sidewalk, in meters: from
 * the first run to 0.2 m short of the pad of a stall post behind the curb
 * (the 2.4 m sidewalk, its 0.3 m curb, the post 0.6 m behind the curb face
 * with its pad 0.45 m deep behind the post).
 */
const FACADE_RUN_ROOM_M = 2.4 + 0.3 - 0.6 - 0.45 - FACADE_RUN_FROM_WALL_M - 0.2;

/**
 * The AC panelboards of an office or retail site, on the building facade
 * (`facadeZ`, lot z): every panel whose circuits feed only AC stations on the
 * layout, at the left end of its stations (half a stall left of the first,
 * on the stall line, between two wall boxes), its front to the lot. The
 * building's own switchboard and any panel feeding a DC charger stand
 * inside the building and are not drawn.
 */
export function placeFacadePanels(
  hierarchy: readonly LinkPanel[],
  stations: ReadonlyMap<string, LinkStationPoint>,
  acStations: ReadonlySet<string>,
  facadeZ: number,
  stallWidthM: number,
): PanelPlacement[] {
  return flatten(hierarchy, null).flatMap(({ panel, parentId }) => {
    if (panel.childPanels.length > 0 || panel.circuits.length === 0) return [];
    const ids = panel.circuits.flatMap((c) => c.stations.map((st) => st.id));
    if (ids.length === 0 || !ids.every((id) => acStations.has(id) && stations.has(id))) return [];
    const minX = Math.min(...ids.map((id) => stations.get(id)?.charger.x ?? Infinity));
    return [
      {
        id: panel.id,
        parentId,
        name: panel.name,
        amps: panel.breakerRatingAmps,
        kw: panel.maxContinuousKw,
        point: { x: minX - stallWidthM / 2, z: facadeZ },
        model: 'wall' as const,
        turn: 0,
      },
    ];
  });
}

/**
 * The cable runs of the facade panelboards (`placeFacadePanels`): one run
 * per circuit along the foot of the facade from its panelboard to its
 * station, FACADE_RUN_SPACING_M apart, and a short branch to the station (up
 * to a wall box, across the sidewalk to a stall post). The runs are ordered
 * so no branch crosses another run: a branch toward the wall takes the runs
 * of the nearer stations nearer the wall, a branch toward the curb those of
 * the farther stations.
 */
export function facadeLinks(
  hierarchy: readonly LinkPanel[],
  panels: readonly PanelPlacement[],
  stations: ReadonlyMap<string, LinkStationPoint>,
): LoadLinks {
  const segments: LinkSegment[] = [];
  const labels: LinkLabel[] = [];
  const byId = new Map(flatten(hierarchy, null).map(({ panel }) => [panel.id, panel]));
  // Every run has its own line along the facade, numbered across all the
  // panelboards, so no two runs share one; past the room on the sidewalk
  // (behind the stall post pads, FACADE_RUN_ROOM_M) the lines close up.
  const runCount = panels.reduce(
    (n, p) =>
      n +
      (byId
        .get(p.id)
        ?.circuits.reduce((m, c) => m + c.stations.filter((st) => stations.has(st.id)).length, 0) ??
        0),
    0,
  );
  const spacing = Math.min(FACADE_RUN_SPACING_M, FACADE_RUN_ROOM_M / Math.max(1, runCount - 1));
  let line = 0;
  for (const placed of panels) {
    const panel = byId.get(placed.id);
    if (panel == null) continue;
    labels.push({
      id: `panel:${panel.id}`,
      kind: 'panel',
      point: placed.point,
      name: panel.name,
      amps: panel.breakerRatingAmps,
      kw: panel.maxContinuousKw,
    });
    const wallZ = placed.point.z;
    const items = panel.circuits.flatMap((circuit) =>
      circuit.stations.flatMap((station) => {
        const point = stations.get(station.id);
        return point != null ? [{ circuit, station, point }] : [];
      }),
    );
    const towardWall = items.every((i) => i.point.back.z <= wallZ + FACADE_RUN_FROM_WALL_M);
    const reach = (i: (typeof items)[number]) => Math.abs(i.point.back.x - placed.point.x);
    items.sort((a, b) => (towardWall ? reach(a) - reach(b) : reach(b) - reach(a)));
    items.forEach(({ circuit, station, point }) => {
      const z = wallZ + FACADE_RUN_FROM_WALL_M + line * spacing;
      line++;
      const id = `circuit:${circuit.id}`;
      segments.push({
        id: `${id}:${station.id}`,
        flowId: id,
        kind: 'circuit',
        points: [
          { x: placed.point.x, z: wallZ },
          { x: placed.point.x, z },
          { x: point.back.x, z },
        ],
      });
      segments.push({
        id: `station:${station.id}`,
        flowId: `station:${station.id}`,
        kind: 'station',
        points: [
          { x: point.back.x, z },
          { x: point.back.x, z: point.back.z },
        ],
      });
      if (!labels.some((l) => l.id === id)) {
        labels.push({
          id,
          kind: 'circuit',
          point: { x: (placed.point.x + point.back.x) / 2, z },
          name: circuit.name,
          amps: circuit.breakerRatingAmps,
          kw: circuit.maxContinuousKw,
        });
      }
      if (station.allocatedLimitKw != null) {
        labels.push({
          id: `station:${station.id}`,
          kind: 'station',
          point: { x: point.back.x, z: (z + point.back.z) / 2 },
          name: null,
          amps: null,
          kw: station.allocatedLimitKw,
        });
      }
    });
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
