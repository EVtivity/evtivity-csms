// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The demo sites' electrical trees routed on their layouts (the 3D cable
// runs): every run orthogonal, and no run crossing another on the regular
// sites. The demo sites come from a JSON copy of the database package's demo
// plan (the CSMS cannot import it); a database test keeps the copy equal to
// the plan (seed-demo-layout-fixture.test.ts).

import { describe, it, expect } from 'vitest';
import {
  STANDARD_DIMENSIONS,
  TRANSFORMER_CLEARANCE_M,
  effectiveLayoutSettings,
  placePowerEquipment,
  freeSpotCount,
  freeStationsBox,
  freeToSite,
  type FreePlacement,
  type LayoutPowerEquipment,
  type PlacedLayoutSettings,
  type SiteLayoutSettings,
} from '@evtivity/lib/site-layout';
import demoSites from './fixtures/demo-layout-sites.json';
import {
  FACADE_Z,
  STATION_BACK_OFFSET,
  depotStationPlacement,
  freeBackPoint,
  depotLinkGround,
  lotOf,
  parkingRowGaps,
  stationBackPoint,
  stationBackShift,
  wallMounted,
  type Box,
  type Point,
} from '../site-layout-grid';
import {
  equipmentPadBox,
  facadeLinks,
  loadLinks,
  placeFacadePanels,
  placePanels,
  linkHierarchy,
  type HierarchyLinkNode,
  type LinkPanel,
  type LinkStationPoint,
  type LoadLinks,
  type PanelPlacement,
} from '../site-layout-links';

interface DemoSite {
  id: string;
  name: string;
  settings: SiteLayoutSettings;
  powerEquipment: LayoutPowerEquipment;
  panels: Array<{
    id: string;
    parentPanelId: string | null;
    /** The transformer it names (`panels.transformer_id`): a service or a step-down unit. */
    transformerId: string | null;
    name: string;
    breakerRatingAmps: number;
    maxContinuousKw: number;
    circuits: Array<{
      id: string;
      name: string;
      breakerRatingAmps: number;
      maxContinuousKw: number;
    }>;
  }>;
  stations: Array<{
    id: string;
    kind: 'ac' | 'dc';
    col: number;
    row: number;
    circuitId: string;
    free: FreePlacement | null;
    evses: number;
  }>;
}

const SITES = (demoSites as unknown as { sites: DemoSite[] }).sites;

/** A demo site's effective settings with its power equipment rows at their positions, as the layout draws them. */
function placedOf(site: DemoSite): PlacedLayoutSettings {
  return placePowerEquipment(
    effectiveLayoutSettings(site.settings, [], site.stations.length),
    site.powerEquipment,
  );
}

/**
 * The demo site's load management hierarchy as `GET /v1/sites/:id/load-management`
 * answers it (each service transformer a root above the switchboard that
 * names it, each step-down unit between its switchboard and its panelboard),
 * turned into the 3D view's panels by `linkHierarchy`, as the view does.
 */
function hierarchyOf(site: DemoSite): LinkPanel[] {
  const info = new Map(site.powerEquipment.transformers.map((t) => [t.id, t]));
  const transformerNode = (id: string, children: HierarchyLinkNode[]): HierarchyLinkNode => ({
    type: 'transformer',
    transformerKind: info.get(id)!.kind,
    id,
    name: info.get(id)!.name,
    breakerRatingAmps: 0,
    maxContinuousKw: info.get(id)!.maxContinuousKw ?? 0,
    circuits: [],
    childPanels: children,
  });
  const build = (parentId: string | null): HierarchyLinkNode[] => {
    const nodes = site.panels
      .filter((p) => p.parentPanelId === parentId)
      .map((p) => ({
        transformerId: p.transformerId,
        node: {
          type: 'panel' as const,
          id: p.id,
          name: p.name,
          breakerRatingAmps: p.breakerRatingAmps,
          maxContinuousKw: p.maxContinuousKw,
          circuits: p.circuits.map((c) => ({
            id: c.id,
            name: c.name,
            breakerRatingAmps: c.breakerRatingAmps,
            maxContinuousKw: c.maxContinuousKw,
            stations: site.stations
              .filter((s) => s.circuitId === c.id)
              .map((s) => ({ id: s.id, allocatedLimitKw: null })),
          })),
          childPanels: build(p.id),
        },
      }));
    const out: HierarchyLinkNode[] = [];
    const byTransformer = new Map<string, HierarchyLinkNode>();
    for (const { transformerId, node } of nodes) {
      if (transformerId == null || !info.has(transformerId)) {
        out.push(node);
        continue;
      }
      const tx = byTransformer.get(transformerId);
      if (tx != null) tx.childPanels.push(node);
      else {
        const created = transformerNode(transformerId, [node]);
        byTransformer.set(transformerId, created);
        out.push(created);
      }
    }
    return out;
  };
  return linkHierarchy(build(null), {
    stepDowns: site.settings.siteType !== 'office_retail',
    kvaOf: (id) => info.get(id)?.ratedKva ?? null,
  });
}

/** The station ids a panel (or a step-down unit, by its transformer id) feeds. */
function subtree(site: DemoSite, id: string): string[] {
  const panel = site.panels.find((p) => p.id === id);
  if (panel == null) {
    return site.panels
      .filter((p) => p.transformerId === id && p.parentPanelId != null)
      .flatMap((p) => subtree(site, p.id));
  }
  const own = panel.circuits.flatMap((c) =>
    site.stations.filter((st) => st.circuitId === c.id).map((st) => st.id),
  );
  return [
    ...own,
    ...site.panels.filter((p) => p.parentPanelId === id).flatMap((p) => subtree(site, p.id)),
  ];
}

/** The cable runs of a demo site as the 3D view routes them. */
function demoLinks(site: DemoSite): LoadLinks {
  return demoTree(site).links;
}

/** The panels, the station points, the ground and the cable runs of a demo site. */
function demoTree(site: DemoSite): {
  links: LoadLinks;
  panels: PanelPlacement[];
  points: Map<string, LinkStationPoint>;
  ground: Box;
} {
  const settings = placedOf(site);
  const lot = lotOf(settings);
  const points = new Map<string, LinkStationPoint>();
  let ground: Box;
  if (settings.siteType === 'custom') {
    const places = site.stations.map((s) => ({
      placement: s.free!,
      spots: freeSpotCount(s.evses),
    }));
    for (const s of site.stations) {
      points.set(s.id, { charger: freeToSite(s.free!, 0, 0), back: freeBackPoint(s.free!) });
    }
    ground = freeStationsBox(places)!;
  } else if (settings.siteType === 'depot') {
    for (const s of site.stations) {
      const p = depotStationPlacement({ col: s.col, row: s.row }, lot);
      points.set(s.id, { charger: freeToSite(p, 0, 0), back: freeBackPoint(p) });
    }
    ground = depotLinkGround(lot.depot!);
  } else {
    for (const s of site.stations) {
      const bay = { col: s.col, row: s.row };
      if (wallMounted(bay, lot, s.kind)) {
        // A wall box: its cable comes up the facade.
        const x = stationBackPoint(bay, lot).x;
        points.set(s.id, { charger: { x, z: FACADE_Z + 0.1 }, back: { x, z: FACADE_Z } });
        continue;
      }
      // An AC pedestal stands behind the stall head line.
      const shift = stationBackShift(bay, lot, s.kind, false);
      points.set(s.id, {
        charger: stationBackPoint(bay, lot, shift - STATION_BACK_OFFSET),
        back: stationBackPoint(bay, lot, shift),
      });
    }
    ground = { minX: 0, maxX: lot.width, minZ: 0, maxZ: lot.depth };
  }
  const hierarchy = hierarchyOf(site);
  const ac = new Set(site.stations.filter((s) => s.kind === 'ac').map((s) => s.id));
  if (settings.siteType === 'office_retail') {
    const wall = placeFacadePanels(hierarchy, points, ac, FACADE_Z, lot.spotW);
    return { links: facadeLinks(hierarchy, wall, points), panels: wall, points, ground };
  }
  const panels = placePanels(
    hierarchy,
    ground,
    settings.transformers,
    points,
    ac,
    equipmentPadsOf(site),
  );
  const links = loadLinks(
    hierarchy,
    panels,
    points,
    ground,
    settings.transformers,
    ac,
    equipmentPadsOf(site),
  );
  return { links, panels, points, ground };
}

/** The transformer and battery pads of a demo site. */
function equipmentPadsOf(site: DemoSite): Box[] {
  const settings = placedOf(site);
  return [
    ...settings.transformers.map((t) => equipmentPadBox(t, 'transformer')),
    ...settings.energyAssets.flatMap((a) =>
      a.type === 'battery' ? [equipmentPadBox(a, 'battery')] : [],
    ),
  ];
}

function segmentsOf(links: LoadLinks): Array<{ id: string; a: Point; b: Point }> {
  return links.segments.flatMap((s) =>
    s.points.slice(1).map((b, i) => ({ id: s.id, a: s.points[i]!, b })),
  );
}

function crosses(p: { a: Point; b: Point }, q: { a: Point; b: Point }): boolean {
  const eps = 1e-6;
  const ph = Math.abs(p.a.z - p.b.z) < eps;
  const qh = Math.abs(q.a.z - q.b.z) < eps;
  if (ph === qh) return false;
  const h = ph ? p : q;
  const v = ph ? q : p;
  const hx0 = Math.min(h.a.x, h.b.x);
  const hx1 = Math.max(h.a.x, h.b.x);
  const vz0 = Math.min(v.a.z, v.b.z);
  const vz1 = Math.max(v.a.z, v.b.z);
  return v.a.x > hx0 + eps && v.a.x < hx1 - eps && h.a.z > vz0 + eps && h.a.z < vz1 - eps;
}

const drawn = SITES;

describe('demo electrical trees on the 3D layout', () => {
  it('draws the trees of the parking lots, the custom site and the depot', () => {
    expect(drawn.map((s) => s.settings.siteType)).toEqual([
      'parking_lot',
      'office_retail',
      'office_retail',
      'custom',
      'depot',
      'parking_lot',
      // Parkhaus Lindenhof: the master with extenders.
      'parking_lot',
    ]);
  });

  for (const site of drawn) {
    it(`routes ${site.name} as orthogonal runs with a branch to every charger`, () => {
      const links = demoLinks(site);
      for (const seg of segmentsOf(links)) {
        const straight = Math.abs(seg.a.x - seg.b.x) < 1e-9 || Math.abs(seg.a.z - seg.b.z) < 1e-9;
        expect(straight, seg.id).toBe(true);
      }
      for (const s of site.stations) {
        expect(links.segments.some((seg) => seg.id === `station:${s.id}`)).toBe(true);
      }
    });
  }

  it('stands the equipment pad at the lot edge next to the DC group it feeds', () => {
    for (const site of drawn.filter((s) => s.settings.siteType === 'parking_lot')) {
      const settings = placedOf(site);
      const lot = lotOf(settings);
      const t = settings.transformers[0]!;
      // The pad (2.9 m along the lot edge's normal) from the lot edge: at
      // least the 3 ft utility side clearance, and under the 5 ft at which
      // EWEB no longer asks for bollards (so they guard it).
      const padGap = Math.max(-t.x, t.x - lot.width) - 2.9 / 2;
      expect(padGap, site.name).toBeGreaterThanOrEqual(0.91);
      expect(padGap, site.name).toBeLessThan(1.52);
      // Beside the first DC spot: within the clearance plus one spot of a DC
      // charger (an AC-only site: beside the AC group it feeds).
      const hasDc = site.stations.some((s) => s.kind === 'dc');
      const nearestDc = Math.min(
        ...site.stations
          .filter((s) => !hasDc || s.kind === 'dc')
          .map((s) => {
            const p = stationBackPoint({ col: s.col, row: s.row }, lot, -STATION_BACK_OFFSET);
            return Math.hypot(p.x - t.x, p.z - t.z);
          }),
      );
      expect(nearestDc, site.name).toBeLessThanOrEqual(
        TRANSFORMER_CLEARANCE_M + STANDARD_DIMENSIONS.spotWidthM,
      );
    }
  });

  it('stands each AC panelboard on the island or curb strip at the row end nearest the pad', () => {
    for (const site of drawn.filter((s) => s.settings.siteType === 'parking_lot')) {
      const { panels, points, ground, links } = demoTree(site);
      const settings = placedOf(site);
      const lot = lotOf(settings);
      const t = settings.transformers[0]!;
      const islands = parkingRowGaps(lot).filter((g) => g.kind === 'island');
      const aisles = parkingRowGaps(lot).filter((g) => g.kind === 'aisle');
      for (const panel of panels.filter((p) => p.model === 'panelboard')) {
        const label = `${site.name} ${panel.name}`;
        const fed = site.panels
          .find((p) => p.id === panel.id)!
          .circuits.flatMap((c) => site.stations.filter((st) => st.circuitId === c.id));
        const backs = fed.map((st) => points.get(st.id)!.back);
        // On the line of one of its rows (an island's middle or an edge row's curb line).
        expect(
          Math.min(...backs.map((b) => Math.abs(b.z - panel.point.z))),
          label,
        ).toBeLessThanOrEqual(1.2);
        // Inside the lot at the row end on the transformer's side, never past
        // the edge on the grass: the rack row's first item at the end (its
        // step-down transformer, when one feeds it), the panelboard next to it.
        const nearEdge = t.x < (ground.minX + ground.maxX) / 2 ? ground.minX : ground.maxX;
        expect(panel.point.x, label).toBeGreaterThan(ground.minX);
        expect(panel.point.x, label).toBeLessThan(ground.maxX);
        const stepDownId = site.panels.find((p) => p.id === panel.id)!.transformerId;
        const stepDown = panels.find((p) => p.model === 'dry_transformer' && p.id === stepDownId);
        const lead = stepDown ?? panel;
        expect(Math.abs(lead.point.x - nearEdge), label).toBeLessThanOrEqual(1.5);
        if (stepDown != null) {
          expect(stepDown.point.z, label).toBeCloseTo(panel.point.z, 6);
          expect(
            Math.hypot(stepDown.point.x - panel.point.x, stepDown.point.z - panel.point.z),
            label,
          ).toBeLessThanOrEqual(3);
        }
        // On an island (between its curbs) or on the curb strip behind a lot edge row.
        const onIsland = islands.some(
          (g) => panel.point.z > g.minZ + 0.6 && panel.point.z < g.maxZ - 0.6,
        );
        const onCurbStrip = panel.point.z < ground.minZ || panel.point.z > ground.maxZ;
        expect(onIsland || onCurbStrip, label).toBe(true);
        // Its feeder takes the shortest real route: along the near lot edge and
        // in along the row's line, crossing at most one drive aisle inside the lot.
        const feeder = links.segments.find((seg) => seg.id === `panel:${panel.id}`)!;
        let crossed = 0;
        for (let i = 1; i < feeder.points.length; i++) {
          const a = feeder.points[i - 1]!;
          const c = feeder.points[i]!;
          const inside = (q: Point) => q.x > ground.minX + 1e-6 && q.x < ground.maxX - 1e-6;
          if (!inside(a) && !inside(c) && Math.abs(a.x - c.x) < 1e-9) continue;
          crossed += aisles.filter(
            (g) => Math.min(a.z, c.z) < g.minZ && Math.max(a.z, c.z) > g.maxZ && inside(a),
          ).length;
        }
        expect(crossed, label).toBeLessThanOrEqual(1);
        // Never longer than along the near edge to the row and in to the rack.
        let length = 0;
        for (let i = 1; i < feeder.points.length; i++) {
          const a = feeder.points[i - 1]!;
          const c = feeder.points[i]!;
          length += Math.abs(a.x - c.x) + Math.abs(a.z - c.z);
        }
        expect(length, label).toBeLessThanOrEqual(
          Math.abs(panel.point.z - t.z) + Math.abs(panel.point.x - t.x) + 12,
        );
      }
    }
  });

  it('stands each depot transformer behind the yard next to the group it feeds', () => {
    for (const site of drawn.filter((s) => s.settings.siteType === 'depot')) {
      const { points } = demoTree(site);
      const settings = placedOf(site);
      const depot = lotOf(settings).depot!;
      for (const t of settings.transformers) {
        // Behind the yard edge of its area (not beside the yard across a road), the
        // cited clearance from it.
        const inBusArea = depot.busHead != null && t.x <= depot.busHead.maxX + 1;
        const back = inBusArea
          ? Math.min(...depot.outline.map((p) => p.z).filter((z) => z >= depot.busHead!.minZ - 1))
          : depot.yard.minZ;
        expect(back - t.z, t.name).toBeGreaterThanOrEqual(TRANSFORMER_CLEARANCE_M - 1e-9);
        const nearest = Math.min(
          ...[...points.values()].map((p) => Math.hypot(p.charger.x - t.x, p.charger.z - t.z)),
        );
        expect(nearest, t.name).toBeLessThanOrEqual(10);
      }
    }
  });

  it('stands each switchboard at the transformer it names (panels.transformer_id)', () => {
    // Sites with more than one transformer: link every top-level panel to the
    // transformer the index rule would not give it (the order reversed); the
    // service cable must start at the named transformer.
    const multi = drawn.filter((s) => placedOf(s).transformers.length > 1);
    expect(multi.length).toBeGreaterThan(0);
    for (const site of multi) {
      const settings = placedOf(site);
      const { points, ground } = demoTree(site);
      const tx = [...settings.transformers].reverse();
      const roots = hierarchyOf(site).map((root, j) => ({
        ...root,
        transformerId: tx[Math.min(j, tx.length - 1)]?.id ?? null,
      }));
      const ac = new Set(site.stations.filter((s) => s.kind === 'ac').map((s) => s.id));
      const panels = placePanels(roots, ground, settings.transformers, points, ac);
      const links = loadLinks(roots, panels, points, ground, settings.transformers, ac);
      for (const root of roots) {
        const named = settings.transformers.find((t) => t.id === root.transformerId)!;
        const feed = links.segments.find((s) => s.id === `feed:${root.id}`);
        expect(feed?.points[0], `${site.name} ${root.name}`).toEqual({ x: named.x, z: named.z });
      }
    }
  });

  it('keeps every cable run within the lot plus its row ends', () => {
    // A run follows row ends, curbs and islands: never longer than once along
    // and once across the ground plus the equipment pad's reach (25 m).
    for (const site of drawn) {
      const { links, ground } = demoTree(site);
      const limit = ground.maxX - ground.minX + (ground.maxZ - ground.minZ) + 25;
      for (const seg of links.segments) {
        let length = 0;
        for (let i = 1; i < seg.points.length; i++) {
          const a = seg.points[i - 1]!;
          const b = seg.points[i]!;
          length += Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
        }
        expect(length, `${site.name} ${seg.id}`).toBeLessThanOrEqual(limit);
      }
    }
  });

  it('stands every equipment item next to the chargers it feeds, closer than any other group', () => {
    // Hard rule (owner 2026-11-01): transformers, switchboards and panelboards
    // stand by the group they feed, never across the lot or out on the grass.
    // Bounds: a transformer pad 2.5 m from the lot edge plus a spot and the
    // switchboard row beside it (10 m); a switchboard 3.51 m beyond its
    // transformer plus the cable lanes (14 m); a panelboard rack on the island
    // or curb strip at its row end nearest the pad, up to three stall widths
    // (8.1 m) and the end curb from its run (9 m), or on the facade beside
    // its group.
    const BOUND = {
      transformer: 10,
      switchboard: 14,
      panelboard: 9,
      wall: 8,
      cabinet: 14,
      // A step-down transformer stands beside the panelboard it feeds.
      dry_transformer: 9,
    } as const;
    const report: string[] = [];
    for (const site of drawn) {
      const { panels, points } = demoTree(site);
      const settings = placedOf(site);
      const items: Array<{ name: string; kind: keyof typeof BOUND; at: Point; feeds: string[] }> =
        panels.map((p) => ({
          name: p.name,
          kind: p.model,
          at: p.point,
          feeds: subtree(site, p.id),
        }));
      // Each transformer stands at the tree of the switchboard that names it.
      const roots = site.panels.filter((p) => p.parentPanelId == null);
      if (settings.siteType !== 'office_retail' && settings.siteType !== 'curbside') {
        for (const t of settings.transformers) {
          const mine = roots.filter((r) => r.transformerId === t.id);
          const feeds = mine.flatMap((r) => subtree(site, r.id));
          if (feeds.length > 0) items.push({ name: t.name, kind: 'transformer', at: t, feeds });
        }
      }
      for (const item of items) {
        const dist = (id: string): number => {
          const p = points.get(id);
          return p == null
            ? Infinity
            : Math.hypot(p.charger.x - item.at.x, p.charger.z - item.at.z);
        };
        const own = Math.min(...item.feeds.map(dist));
        const others = site.stations
          .filter((st) => !item.feeds.includes(st.id))
          .map((st) => dist(st.id));
        const other = others.length > 0 ? Math.min(...others) : Infinity;
        report.push(
          `${site.name} ${item.kind} ${item.name}: own ${own.toFixed(1)} other ${other.toFixed(1)}`,
        );
        expect(own, `${site.name} ${item.name}`).toBeLessThanOrEqual(BOUND[item.kind]);
        expect(own, `${site.name} ${item.name} (another group nearer)`).toBeLessThanOrEqual(
          other + 1e-6,
        );
      }
    }
    expect(report.length).toBeGreaterThan(0);
  });

  it('runs no circuit, branch or panelboard feeder through a transformer or battery pad', () => {
    const inside = (p: Point, b: Box) =>
      p.x > b.minX + 1e-6 && p.x < b.maxX - 1e-6 && p.z > b.minZ + 1e-6 && p.z < b.maxZ - 1e-6;
    // An orthogonal leg enters a box when it overlaps its interior.
    const enters = (a: Point, c: Point, b: Box) =>
      Math.max(a.x, c.x) > b.minX + 1e-6 &&
      Math.min(a.x, c.x) < b.maxX - 1e-6 &&
      Math.max(a.z, c.z) > b.minZ + 1e-6 &&
      Math.min(a.z, c.z) < b.maxZ - 1e-6;
    for (const site of drawn.filter((s) => s.settings.siteType !== 'office_retail')) {
      const pads = equipmentPadsOf(site);
      const links = demoLinks(site);
      for (const seg of links.segments) {
        // The service cables from a transformer start inside its pad.
        if (seg.id.startsWith('feed:')) continue;
        for (let i = 1; i < seg.points.length; i++) {
          const a = seg.points[i - 1]!;
          const c = seg.points[i]!;
          for (const b of pads) {
            if (inside(a, b) || inside(c, b)) continue;
            expect(enters(a, c, b), `${site.name} ${seg.id}`).toBe(false);
          }
        }
      }
    }
  });

  it('crosses no runs on the parking lots and the depot', () => {
    for (const site of drawn.filter((s) => s.settings.siteType !== 'custom')) {
      const segs = segmentsOf(demoLinks(site));
      const crossings = segs.flatMap((p, i) =>
        segs
          .slice(i + 1)
          .filter((q) => q.id !== p.id && crosses(p, q))
          .map((q) => `${p.id} x ${q.id}`),
      );
      expect(crossings, site.name).toEqual([]);
    }
  });
});
