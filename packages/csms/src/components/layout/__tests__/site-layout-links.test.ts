// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => false }));
import { DEFAULT_LAYOUT_GRID } from '@evtivity/lib/site-layout';
import {
  EQUIPMENT_BOLLARD,
  equipmentBollards,
  facadeLinks,
  loadFlows,
  loadLevel,
  loadLinks,
  PANEL_FROM_TRANSFORMER_M,
  PANEL_PAD_PITCH_M,
  assetConnections,
  linkHierarchy,
  loadPercent,
  placeFacadePanels,
  placePanels,
  supplyLinks,
  transformerLoads,
  type LinkPanel,
} from '../site-layout-links';
import { bayToWorld, lotOf, stationBackPoint } from '../site-layout-grid';
import { terminalSide, terminalsByStation } from '../layout-terminals';
import type { PaymentTerminal } from '@/components/payment-terminals/payment-terminal-types';

const circuit = (id: string, stations: string[]) => ({
  id,
  name: `Circuit ${id}`,
  breakerRatingAmps: 100,
  maxContinuousKw: 57.6,
  stations: stations.map((s) => ({ id: s, allocatedLimitKw: s === 'b' ? null : 22 })),
});

const panel = (
  id: string,
  circuits: ReturnType<typeof circuit>[],
  childPanels: LinkPanel[] = [],
) => ({
  id,
  name: `Panel ${id}`,
  breakerRatingAmps: 400,
  maxContinuousKw: 230.4,
  circuits,
  childPanels,
});

const LOT = lotOf(DEFAULT_LAYOUT_GRID);
const ground = { minX: 0, maxX: LOT.width, minZ: 0, maxZ: LOT.depth };
const pointsOf = (map: Map<string, { x: number; z: number }>) =>
  new Map([...map].map(([id, back]) => [id, { charger: { x: back.x, z: back.z + 0.45 }, back }]));
const stations = pointsOf(
  new Map([
    ['a', { x: 1.3, z: 0.45 }],
    ['b', { x: 3.9, z: 0.45 }],
    ['c', { x: 20, z: 17.55 }],
  ]),
);

type Pt = { x: number; z: number };
const segmentsOf = (links: ReturnType<typeof loadLinks>) =>
  links.segments.flatMap((s) =>
    s.points.slice(1).map((b, i) => ({ id: s.id, flowId: s.flowId, a: s.points[i]!, b })),
  );

/** Whether two orthogonal segments cross (touching at an end or a corner does not count). */
function crosses(p: { a: Pt; b: Pt }, q: { a: Pt; b: Pt }): boolean {
  const eps = 1e-6;
  const ph = Math.abs(p.a.z - p.b.z) < eps;
  const qh = Math.abs(q.a.z - q.b.z) < eps;
  if (ph === qh) return false;
  const h = ph ? p : q;
  const v = ph ? q : p;
  const [hx0, hx1] = [Math.min(h.a.x, h.b.x), Math.max(h.a.x, h.b.x)];
  const [vz0, vz1] = [Math.min(v.a.z, v.b.z), Math.max(v.a.z, v.b.z)];
  return v.a.x > hx0 + eps && v.a.x < hx1 - eps && h.a.z > vz0 + eps && h.a.z < vz1 - eps;
}

describe('load management panels', () => {
  it('stands one switchboard per panel in a row beyond the transformer, a sub-panel next to its parent', () => {
    const transformer = { x: -4, z: 2.75 };
    const placed = placePanels(
      [panel('p', [circuit('1', ['a'])], [panel('q', [])]), panel('r', [])],
      ground,
      transformer,
    );
    expect(placed.map((p) => [p.id, p.parentId])).toEqual([
      ['p', null],
      ['q', 'p'],
      ['r', null],
    ]);
    // In line with the transformer, beyond it, one pitch apart.
    expect(placed[0]?.point).toEqual({ x: -4 - PANEL_FROM_TRANSFORMER_M, z: 2.75 });
    expect(placed[1]?.point.x).toBeCloseTo(-4 - PANEL_FROM_TRANSFORMER_M - PANEL_PAD_PITCH_M);
    for (const p of placed) expect(p.point.x).toBeLessThan(transformer.x);
    expect(placed[0]).toMatchObject({ name: 'Panel p', amps: 400, kw: 230.4 });
  });

  it('keeps 3 ft between the transformer pad and the first switchboard pad, no more', () => {
    // OPPD and Idaho Power: 3 ft clear at the sides of a pad-mounted
    // transformer; the transformer pad is 2.9 m wide, a switchboard pad 2.3 m.
    const transformer = { x: -2.5, z: 2.75 };
    const [first] = placePanels([panel('p', [circuit('1', ['a'])])], ground, transformer);
    const gap = transformer.x - 2.9 / 2 - (first!.point.x + 2.3 / 2);
    expect(gap).toBeCloseTo(0.91);
    expect(first!.model).toBe('switchboard');
  });

  it('stands AC panelboards at the row end nearest the transformer, inside the lot', () => {
    // DC next to the transformer (left), AC toward the far (right) end of the back row.
    const transformer = { x: -2.5, z: 2.75 };
    const points = pointsOf(
      new Map([
        ['dc', { x: 1.3, z: 0.45 }],
        ['ac1', { x: 22.1, z: 17.55 }],
        ['ac2', { x: 24.7, z: 17.55 }],
      ]),
    );
    const hierarchy = [
      panel(
        'main',
        [circuit('d', ['dc'])],
        [panel('lp', [circuit('1', ['ac1']), circuit('2', ['ac2'])])],
      ),
    ];
    const ac = new Set(['ac1', 'ac2']);
    const placed = placePanels(hierarchy, ground, transformer, points, ac);
    const lp = placed.find((p) => p.id === 'lp')!;
    expect(lp.model).toBe('panelboard');
    // On its row's line, inside the lot at the transformer's end, facing the lot edge.
    expect(lp.point.z).toBeCloseTo(17.55, 5);
    expect(lp.point.x).toBeGreaterThan(ground.minX);
    expect(lp.point.x).toBeLessThan(ground.minX + 1.5);
    expect(lp.turn).toBeCloseTo(-Math.PI / 2, 9);
    // Its feeder: out of the switchboard row, along the lot edge on that side
    // and in along the rack's line, crossing nothing.
    const links = loadLinks(hierarchy, placed, points, ground, transformer, ac);
    const feeder = links.segments.find((seg) => seg.id === 'panel:lp')!;
    expect(feeder.kind).toBe('panel');
    expect(Math.max(...feeder.points.map((q) => q.x))).toBeCloseTo(lp.point.x, 9);
    const segs = segmentsOf(links);
    const crossings = segs.flatMap((p, i) => segs.slice(i + 1).filter((q) => crosses(p, q)));
    expect(crossings).toEqual([]);
  });

  it('stands the racks just before their run when another group holds the row end', () => {
    // A DC charger on the AC row's own line at the transformer's end.
    const transformer = { x: -2.5, z: 2.75 };
    const points = pointsOf(
      new Map([
        ['dc', { x: 1.3, z: 17.55 }],
        ['ac1', { x: 22.1, z: 17.55 }],
        ['ac2', { x: 24.7, z: 17.55 }],
      ]),
    );
    const hierarchy = [
      panel(
        'main',
        [circuit('d', ['dc'])],
        [panel('lp', [circuit('1', ['ac1']), circuit('2', ['ac2'])])],
      ),
    ];
    const placed = placePanels(hierarchy, ground, transformer, points, new Set(['ac1', 'ac2']));
    const lp = placed.find((p) => p.id === 'lp')!;
    expect(lp.model).toBe('panelboard');
    expect(lp.point.z).toBeCloseTo(17.55, 5);
    // Next to the run's first charger, on the transformer's side of it.
    expect(lp.point.x).toBeLessThan(22.1);
    expect(22.1 - lp.point.x).toBeLessThan(1.5);
  });

  it('gives every facade run its own line, short of the stall post pads, however many', () => {
    // Two panelboards, 14 stall posts on the sidewalk (back 1.05 m behind the curb face).
    const facadeZ = -2.7;
    const posts = new Map(
      Array.from({ length: 14 }, (_, i) => {
        const x = 1.3 + 2.6 * i;
        return [`s${String(i)}`, { charger: { x, z: -0.6 }, back: { x, z: -1.05 } }] as const;
      }),
    );
    const ids = [...posts.keys()];
    const hierarchy = [
      panel(
        'a',
        ids.filter((_, i) => i % 2 === 0).map((id) => circuit(`c${id}`, [id])),
      ),
      panel(
        'b',
        ids.filter((_, i) => i % 2 === 1).map((id) => circuit(`c${id}`, [id])),
      ),
    ];
    const placed = placeFacadePanels(hierarchy, posts, new Set(ids), facadeZ, 2.6);
    expect(placed.map((p) => p.model)).toEqual(['wall', 'wall']);
    const links = facadeLinks(hierarchy, placed, posts);
    const runZs = links.segments
      .filter((seg) => seg.kind === 'circuit')
      .map((seg) => seg.points[seg.points.length - 1]!.z);
    expect(new Set(runZs.map((z) => z.toFixed(4))).size).toBe(14);
    for (const z of runZs) {
      expect(z).toBeGreaterThan(facadeZ);
      expect(z).toBeLessThan(-1.05 - 0.19);
    }
  });

  it('stands the switchboards on the side of the transformer', () => {
    const right = placePanels([panel('p', [])], ground, { x: LOT.width + 4, z: 2.75 });
    expect(right[0]?.point).toEqual({ x: LOT.width + 4 + PANEL_FROM_TRANSFORMER_M, z: 2.75 });
    // A transformer in front of the lot: the switchboards stand at the nearer row end, in line with it.
    const front = placePanels([panel('p', [])], ground, { x: 3, z: -5 });
    expect(front[0]?.point.z).toBe(-5);
    expect(front[0]?.point.x).toBeLessThan(0);
    // Without a transformer: left of the ground, beside the middle of its depth.
    const none = placePanels([panel('p', [])], ground);
    expect(none[0]?.point.z).toBe(LOT.depth / 2);
    expect(none[0]?.point.x).toBeLessThan(0);
  });

  it('stands each top-level switchboard at its own transformer, the last one taking the rest', () => {
    const left = { x: -4, z: 2.75 };
    const right = { x: LOT.width + 4, z: 10 };
    const placed = placePanels(
      [panel('bus', [], [panel('bus2', [])]), panel('truck', []), panel('extra', [])],
      ground,
      [left, right],
    );
    const at = new Map(placed.map((p) => [p.id, p.point]));
    // The first group (and its sub-panel) beside the left transformer, in line with it.
    expect(at.get('bus')).toEqual({ x: -4 - PANEL_FROM_TRANSFORMER_M, z: 2.75 });
    expect(at.get('bus2')?.z).toBe(2.75);
    // The others beside the right one.
    expect(at.get('truck')).toEqual({ x: LOT.width + 4 + PANEL_FROM_TRANSFORMER_M, z: 10 });
    expect(at.get('extra')?.x).toBeGreaterThan(at.get('truck')!.x);
    // Each transformer feeds its own switchboards.
    const links = loadLinks(
      [panel('bus', [], [panel('bus2', [])]), panel('truck', []), panel('extra', [])],
      placed,
      new Map(),
      ground,
      [left, right],
    );
    const feed = (id: string) => links.segments.find((s) => s.id === `feed:${id}`)!.points[0];
    expect(feed('bus')).toEqual({ x: -4, z: 2.75 });
    expect(feed('truck')).toEqual({ x: LOT.width + 4, z: 10 });
    expect(feed('extra')).toEqual({ x: LOT.width + 4, z: 10 });
  });

  it('places nothing without load management panels', () => {
    expect(placePanels([], ground)).toEqual([]);
  });

  it('stands each switchboard at the transformer it names, not by its index', () => {
    const left = { id: 'tfm_left', x: -4, z: 2.75 };
    const right = { id: 'tfm_right', x: LOT.width + 4, z: 10 };
    // The first top-level panel names the right transformer, the second the left one,
    // the third names none: it keeps the index rule (the last transformer takes the rest).
    const hierarchy = linkHierarchy(
      [
        {
          type: 'transformer',
          transformerKind: 'service',
          id: 'tfm_right',
          name: 'T right',
          breakerRatingAmps: 0,
          maxContinuousKw: 712.5,
          circuits: [],
          childPanels: [{ ...panel('truck', []), type: 'panel' }],
        },
        {
          type: 'transformer',
          transformerKind: 'service',
          id: 'tfm_left',
          name: 'T left',
          breakerRatingAmps: 0,
          maxContinuousKw: 285,
          circuits: [],
          childPanels: [{ ...panel('bus', []), type: 'panel' }],
        },
        { ...panel('extra', []), type: 'panel' },
      ],
      { stepDowns: true },
    );
    expect(hierarchy.map((p) => [p.id, p.transformerId ?? null])).toEqual([
      ['truck', 'tfm_right'],
      ['bus', 'tfm_left'],
      ['extra', null],
    ]);
    const placed = placePanels(hierarchy, ground, [left, right]);
    const at = new Map(placed.map((p) => [p.id, p.point]));
    expect(at.get('truck')).toEqual({ x: LOT.width + 4 + PANEL_FROM_TRANSFORMER_M, z: 10 });
    expect(at.get('bus')).toEqual({ x: -4 - PANEL_FROM_TRANSFORMER_M, z: 2.75 });
    expect(at.get('extra')?.z).toBe(10);
    // Each switchboard of a pad row names the transformer it stands at, so
    // Edit Layout drags that transformer when the switchboard is grabbed.
    const atTransformer = new Map(placed.map((p) => [p.id, p.atTransformerId]));
    expect(atTransformer.get('truck')).toBe('tfm_right');
    expect(atTransformer.get('bus')).toBe('tfm_left');
    expect(atTransformer.get('extra')).toBe('tfm_right');
    const links = loadLinks(hierarchy, placed, new Map(), ground, [left, right]);
    const feed = (id: string) => links.segments.find((s) => s.id === `feed:${id}`)!.points[0];
    expect(feed('truck')).toEqual({ x: LOT.width + 4, z: 10 });
    expect(feed('bus')).toEqual({ x: -4, z: 2.75 });
  });

  it('draws a step-down transformer next to the panelboard it feeds, fed from its switchboard', () => {
    const transformer = { id: 'tfm_svc', x: -2.5, z: 2.75 };
    const points = pointsOf(
      new Map([
        ['dc', { x: 1.3, z: 0.45 }],
        ['ac1', { x: 22.1, z: 17.55 }],
        ['ac2', { x: 24.7, z: 17.55 }],
      ]),
    );
    const lp = {
      ...panel('lp', [circuit('1', ['ac1']), circuit('2', ['ac2'])]),
      type: 'panel' as const,
    };
    const hierarchy = linkHierarchy(
      [
        {
          type: 'transformer',
          id: 'tfm_svc',
          name: 'Service',
          breakerRatingAmps: 0,
          maxContinuousKw: 712.5,
          circuits: [],
          childPanels: [
            {
              ...panel('main', [circuit('d', ['dc'])]),
              type: 'panel',
              childPanels: [
                {
                  type: 'transformer',
                  transformerKind: 'step_down',
                  id: 'tfm_sd',
                  name: 'Step-Down',
                  breakerRatingAmps: 0,
                  maxContinuousKw: 106.9,
                  circuits: [],
                  childPanels: [lp],
                },
              ],
            },
          ],
        },
      ],
      { stepDowns: true, kvaOf: (id) => (id === 'tfm_sd' ? 112.5 : null) },
    );
    const ac = new Set(['ac1', 'ac2']);
    const placed = placePanels(hierarchy, ground, transformer, points, ac);
    const sd = placed.find((p) => p.id === 'tfm_sd')!;
    const board = placed.find((p) => p.id === 'lp')!;
    expect(sd.model).toBe('dry_transformer');
    expect(sd.kva).toBe(112.5);
    expect(sd.parentId).toBe('main');
    expect(board.parentId).toBe('tfm_sd');
    // On the panelboard's rack line, the next slot toward the lot edge, turned the same way.
    expect(sd.point.z).toBeCloseTo(board.point.z, 9);
    expect(Math.abs(sd.point.x - board.point.x)).toBeCloseTo(1.6, 9);
    expect(sd.turn).toBeCloseTo(board.turn, 9);
    const links = loadLinks(hierarchy, placed, points, ground, transformer, ac);
    // The switchboard feeds the step-down transformer by the long feeder; the step-down
    // feeds the panelboard straight along their row.
    const feeder = links.segments.find((s) => s.id === 'panel:tfm_sd')!;
    expect(feeder.points[0]?.x).toBeCloseTo(placed.find((p) => p.id === 'main')!.point.x, 9);
    const short = links.segments.find((s) => s.id === 'panel:lp')!;
    expect(short.points).toHaveLength(2);
    expect(short.points.every((q) => Math.abs(q.z - board.point.z) < 1e-9)).toBe(true);
    // Its label: name, kVA and capacity, no breaker.
    const label = links.labels.find((l) => l.id === 'panel:tfm_sd')!;
    expect(label).toMatchObject({ name: 'Step-Down', amps: null, kva: 112.5, kw: 106.9 });
    const segs = segmentsOf(links);
    expect(segs.flatMap((p, i) => segs.slice(i + 1).filter((q) => crosses(p, q)))).toEqual([]);
  });

  it('leaves the step-down transformers out where the switchboard stands inside', () => {
    const hierarchy = linkHierarchy(
      [
        {
          ...panel('main', []),
          type: 'panel',
          childPanels: [
            {
              type: 'transformer',
              id: 'tfm_sd',
              name: 'Step-Down',
              breakerRatingAmps: 0,
              maxContinuousKw: 70,
              circuits: [],
              childPanels: [{ ...panel('lp', []), type: 'panel' }],
            },
          ],
        },
      ],
      { stepDowns: false },
    );
    expect(hierarchy[0]?.childPanels.map((p) => p.id)).toEqual(['lp']);
  });

  it('reads each transformer load and each asset connection from the reply', () => {
    const nodes = [
      {
        type: 'transformer' as const,
        id: 'tfm_svc',
        name: 'Service',
        breakerRatingAmps: 0,
        maxContinuousKw: 200,
        currentDrawKw: 150,
        circuits: [],
        energyAssets: [
          {
            id: 'ena_bat',
            type: 'battery' as const,
            supply: { state: 'fresh' as const, creditKw: 40 },
          },
        ],
        childPanels: [
          {
            ...panel('main', []),
            energyAssets: [
              {
                id: 'ena_pv',
                type: 'solar' as const,
                supply: { state: 'stale' as const, creditKw: 0 },
              },
            ],
          },
        ],
      },
    ];
    expect(transformerLoads(nodes).get('tfm_svc')).toEqual({ drawKw: 150, capacityKw: 200 });
    expect(loadPercent(150, 200)).toBe(75);
    expect(loadPercent(250, 200)).toBe(125);
    expect(loadPercent(10, 0)).toBeNull();
    const conns = assetConnections(nodes);
    expect(conns.get('ena_bat')).toEqual({ nodeId: 'tfm_svc', state: 'fresh', creditKw: 40 });
    expect(conns.get('ena_pv')).toEqual({ nodeId: 'main', state: 'stale', creditKw: 0 });
  });
});

describe('battery and solar links', () => {
  const conns = new Map([
    ['ena_bat', { nodeId: 'main', state: 'fresh' as const, creditKw: 40 }],
    ['ena_pv', { nodeId: 'main', state: 'stale' as const, creditKw: 0 }],
    ['ena_svc', { nodeId: 'tfm_svc', state: 'fresh' as const, creditKw: 0 }],
  ]);
  const targets = new Map([
    ['main', { x: -6, z: 2.75 }],
    ['tfm_svc', { x: -2.5, z: 2.75 }],
  ]);

  it('runs from each asset to its connection point on the ground, flowing only with supply', () => {
    const links = supplyLinks(
      [
        { id: 'ena_bat', point: { x: -4, z: -4 } },
        { id: 'ena_pv', rowZ: 13 },
        { id: 'ena_svc', point: { x: -2.5, z: 12 } },
        { id: 'ena_none', point: { x: -9, z: 0 } },
      ],
      conns,
      targets,
      ground,
    );
    expect(links.map((l) => [l.id, l.kind, l.flowing])).toEqual([
      ['supply:ena_bat', 'supply', true],
      ['supply:ena_pv', 'supply', false],
      // A fresh reading with no credit gives no supply: no flow.
      ['supply:ena_svc', 'supply', false],
    ]);
    for (const l of links) {
      // Orthogonal, from the asset to the equipment, never across the lot.
      for (let i = 1; i < l.points.length; i++) {
        const a = l.points[i - 1]!;
        const b = l.points[i]!;
        expect(Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.z - b.z) < 1e-9).toBe(true);
        const inLot = (q: Pt) =>
          q.x > ground.minX && q.x < ground.maxX && q.z > ground.minZ && q.z < ground.maxZ;
        expect(inLot({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 })).toBe(false);
      }
      expect(l.points.at(-1)).toEqual(targets.get(conns.get(l.id.slice(7))!.nodeId));
    }
    // A carport canopy's run starts at its row end on the equipment side.
    expect(links[1]?.points[0]).toEqual({ x: ground.minX - 0.8, z: 13 });
  });

  it('goes around the lot from an asset on its far side', () => {
    const [run] = supplyLinks(
      [{ id: 'ena_bat', point: { x: LOT.width + 4, z: LOT.depth / 2 } }],
      conns,
      targets,
      ground,
    );
    expect(run!.points.length).toBe(4);
    const segs = run!.points.slice(1).map((b, i) => ({ a: run!.points[i]!, b }));
    for (const s of segs) {
      const mid = { x: (s.a.x + s.b.x) / 2, z: (s.a.z + s.b.z) / 2 };
      expect(
        mid.x > ground.minX && mid.x < ground.maxX && mid.z > ground.minZ && mid.z < ground.maxZ,
      ).toBe(false);
    }
  });
});

describe('load management links', () => {
  it('runs from the transformer to the panel, along the circuit trunk and a branch to each station', () => {
    const hierarchy = [panel('p', [circuit('1', ['a', 'b'])])];
    const transformer = { x: -4, z: 9 };
    const placed = placePanels(hierarchy, ground, transformer);
    const links = loadLinks(hierarchy, placed, stations, ground, transformer);
    expect(links.segments.map((s) => s.flowId)).toEqual([
      'panel:p',
      'circuit:1',
      'circuit:1',
      'station:a',
      'station:b',
    ]);
    // The branch ends at the back of the charger.
    const branchA = links.segments.find((s) => s.id === 'station:a');
    expect(branchA?.points.at(-1)).toEqual({ x: 1.3, z: 0.45 });
    // A station without an allocated limit gets a branch but no label.
    expect(links.labels.map((l) => l.id)).toEqual(['panel:p', 'circuit:1', 'station:a']);
    expect(links.labels[0]).toMatchObject({ name: 'Panel p', amps: 400, kw: 230.4 });
    expect(links.labels[2]).toMatchObject({ kind: 'station', kw: 22, name: null });
  });

  it('keeps every run orthogonal and on the ground plan, never over a parking space diagonally', () => {
    const hierarchy = [panel('p', [circuit('1', ['a', 'b'])], [panel('q', [circuit('2', ['c'])])])];
    const placed = placePanels(hierarchy, ground, { x: -4, z: 9 });
    const links = loadLinks(hierarchy, placed, stations, ground, { x: -4, z: 9 });
    for (const seg of segmentsOf(links)) {
      const straight = Math.abs(seg.a.x - seg.b.x) < 1e-9 || Math.abs(seg.a.z - seg.b.z) < 1e-9;
      expect(straight).toBe(true);
    }
    // The trunks reach the rows along lanes outside the lot, not across it.
    const lanes = links.segments.filter(
      (s) => s.kind === 'circuit' && !s.id.includes(':row:') && !s.id.includes(':direct:'),
    );
    for (const lane of lanes) {
      const last = lane.points.at(-1)!;
      expect(last.x).toBeLessThan(0);
    }
    // A panel standing beside its own group runs straight along its row from the row end.
    for (const run of links.segments.filter((s) => s.id.includes(':direct:'))) {
      const first = run.points[0]!;
      expect(first.x < ground.minX || first.x > ground.maxX).toBe(true);
    }
    expect(links.segments.find((s) => s.id === 'panel:q')?.flowId).toBe('panel:q');
  });

  it('crosses no runs on a grid of one circuit per row', () => {
    // A 10 by 4 lot: rows 0 and 2 have their chargers at the front, 1 and 3 at the back.
    const lot4 = lotOf({ ...DEFAULT_LAYOUT_GRID, rows: 4 });
    const g4 = { minX: 0, maxX: lot4.width, minZ: 0, maxZ: lot4.depth };
    const pts = new Map<string, { charger: Pt; back: Pt }>();
    const circuits = [0, 1, 2, 3].map((row) => {
      const ids = [0, 1, 2, 3, 4].map((col) => {
        const id = `s${String(row)}${String(col)}`;
        const bay = { col: col + (row % 2) * 5, row };
        pts.set(id, { charger: bayToWorld(bay, lot4), back: stationBackPoint(bay, lot4) });
        return id;
      });
      return circuit(`r${String(row)}`, ids);
    });
    for (const transformer of [
      { x: -4, z: lot4.depth / 2 },
      { x: lot4.width + 4, z: 2.75 },
      { x: 10, z: lot4.depth + 6 },
    ]) {
      const hierarchy = [panel('main', circuits)];
      const placed = placePanels(hierarchy, g4, transformer);
      const links = loadLinks(hierarchy, placed, pts, g4, transformer);
      const segs = segmentsOf(links);
      const crossings = segs.flatMap((p, i) =>
        segs
          .slice(i + 1)
          .filter((q) => q.id !== p.id && crosses(p, q))
          .map((q) => [p.id, q.id]),
      );
      expect(crossings).toEqual([]);
      // Parallel runs keep their spacing: no two trunks share a lane or a row run.
      const laneXs = links.segments
        .filter((s) => s.kind === 'circuit' && !s.id.includes(':row:'))
        .map((s) => s.points.at(-1)!);
      expect(new Set(laneXs.map((p) => `${String(p.x)}:${String(p.z)}`)).size).toBe(laneXs.length);
    }
  });

  it('runs the feeders of back-to-back rows along their shared island, between the chargers', () => {
    const lot4 = lotOf({ ...DEFAULT_LAYOUT_GRID, rows: 4 });
    const g4 = { minX: 0, maxX: lot4.width, minZ: 0, maxZ: lot4.depth };
    const pts = new Map<string, { charger: Pt; back: Pt }>();
    const ids = [1, 2].flatMap((row) =>
      [0, 1, 2].map((col) => {
        const id = `i${String(row)}${String(col)}`;
        const bay = { col, row };
        pts.set(id, { charger: bayToWorld(bay, lot4), back: stationBackPoint(bay, lot4) });
        return id;
      }),
    );
    const hierarchy = [panel('p', [circuit('island', ids)])];
    const transformer = { x: -4, z: 2.75 };
    const links = loadLinks(
      hierarchy,
      placePanels(hierarchy, g4, transformer),
      pts,
      g4,
      transformer,
    );
    const backs = [...pts.values()].map((p) => p.back.z);
    const runs = links.segments.filter((s) => s.id.includes(':row:'));
    // One run serves both rows of the island, between their back lines.
    expect(runs).toHaveLength(1);
    const z = runs[0]!.points[0]!.z;
    expect(z).toBeGreaterThanOrEqual(Math.min(...backs));
    expect(z).toBeLessThanOrEqual(Math.max(...backs));
  });

  it('runs Lot Edge feeders along the edge rows without crossings', () => {
    const edge = lotOf({ ...DEFAULT_LAYOUT_GRID, rows: 4, chargerPlacement: 'lot_edge' });
    const ge = { minX: 0, maxX: edge.width, minZ: 0, maxZ: edge.depth };
    expect(edge.rowLengths).toEqual([10, 0, 0, 10]);
    const pts = new Map<string, { charger: Pt; back: Pt }>();
    const circuits = [0, 3].map((row) => {
      const ids = [0, 1, 2, 3].map((col) => {
        const id = `e${String(row)}${String(col)}`;
        const bay = { col: row === 0 ? 9 - col : col, row };
        pts.set(id, { charger: bayToWorld(bay, edge), back: stationBackPoint(bay, edge) });
        return id;
      });
      return circuit(`edge${String(row)}`, ids);
    });
    for (const transformer of [
      { x: edge.width + 4, z: 2.75 },
      { x: -4, z: edge.depth / 2 },
    ]) {
      const hierarchy = [panel('main', circuits)];
      const links = loadLinks(
        hierarchy,
        placePanels(hierarchy, ge, transformer),
        pts,
        ge,
        transformer,
      );
      const segs = segmentsOf(links);
      const crossings = segs.flatMap((p, i) =>
        segs.slice(i + 1).filter((q) => q.id !== p.id && crosses(p, q)),
      );
      expect(crossings).toEqual([]);
      // Each trunk runs behind its edge row: outside the lot or at its edge strip.
      const runs = links.segments.filter((sg) => sg.id.includes(':row:'));
      for (const run of runs) {
        const z = run.points[0]!.z;
        expect(z < 2 || z > edge.depth - 2).toBe(true);
      }
    }
  });

  it('crosses no runs for two circuits sharing a row, each serving its own end', () => {
    const pts = new Map<string, { charger: Pt; back: Pt }>();
    const ids = (cols: number[]) =>
      cols.map((col) => {
        const id = `c${String(col)}`;
        const bay = { col, row: 0 };
        pts.set(id, { charger: bayToWorld(bay, LOT), back: stationBackPoint(bay, LOT) });
        return id;
      });
    const hierarchy = [panel('p', [circuit('ac', ids([0, 1, 2])), circuit('dc', ids([6, 7, 8]))])];
    const transformer = { x: -4, z: LOT.depth / 2 };
    const placed = placePanels(hierarchy, ground, transformer);
    const segs = segmentsOf(loadLinks(hierarchy, placed, pts, ground, transformer));
    const crossings = segs.flatMap((p, i) => segs.slice(i + 1).filter((q) => crosses(p, q)));
    expect(crossings).toEqual([]);
  });

  it('labels every panel, and leaves out circuits without a station on the layout', () => {
    const hierarchy = [panel('p', [circuit('1', ['zz'])])];
    const links = loadLinks(hierarchy, placePanels(hierarchy, ground), stations, ground);
    expect(links.segments.map((s) => s.kind)).toEqual(['panel']);
    expect(links.labels.map((l) => l.id)).toEqual(['panel:p']);
  });
});

describe('equipment bollards (EWEB ED5-1.0800)', () => {
  // A transformer pad (2.9 by 2.5 m).
  const pad = { minX: -1.45, maxX: 1.45, minZ: -1.25, maxZ: 1.25 };

  it('lines the pad sides facing an uncurbed yard, 0.91 m out and at most 1.98 m apart', () => {
    const yard = { box: { minX: -20, maxX: 20, minZ: 4.25, maxZ: 40 }, curbed: false };
    const posts = equipmentBollards(pad, [yard]);
    expect(posts.length).toBeGreaterThanOrEqual(3);
    for (const p of posts) expect(p.z).toBeCloseTo(pad.maxZ + EQUIPMENT_BOLLARD.offsetM);
    const xs = posts.map((p) => p.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(pad.minX - EQUIPMENT_BOLLARD.offsetM);
    expect(xs.at(-1)).toBeCloseTo(pad.maxX + EQUIPMENT_BOLLARD.offsetM);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]! - xs[i - 1]!).toBeLessThanOrEqual(EQUIPMENT_BOLLARD.maxSpacingM + 1e-9);
    }
  });

  it('protects a pad closer than 5 ft to a curbed parking area, and none from 5 ft', () => {
    const near = { box: { minX: -20, maxX: 20, minZ: pad.maxZ + 1.0, maxZ: 40 }, curbed: true };
    const far = { box: { minX: -20, maxX: 20, minZ: pad.maxZ + 1.6, maxZ: 40 }, curbed: true };
    expect(equipmentBollards(pad, [near]).length).toBeGreaterThan(0);
    expect(equipmentBollards(pad, [far])).toEqual([]);
  });

  it('puts one corner bollard where an uncurbed area lies beside the pad only diagonally', () => {
    const diagonal = { box: { minX: 5, maxX: 9, minZ: 5, maxZ: 9 }, curbed: false };
    expect(equipmentBollards(pad, [diagonal])).toEqual([
      { x: pad.maxX + EQUIPMENT_BOLLARD.offsetM, z: pad.maxZ + EQUIPMENT_BOLLARD.offsetM },
    ]);
    expect(equipmentBollards(pad, [{ ...diagonal, curbed: true }])).toEqual([]);
  });

  it('guards each side that faces one of several areas (custom site aprons)', () => {
    const left = { box: { minX: -9, maxX: -2, minZ: -2, maxZ: 2 }, curbed: true };
    const right = { box: { minX: 2, maxX: 9, minZ: -2, maxZ: 2 }, curbed: true };
    const posts = equipmentBollards(pad, [left, right]);
    expect(posts.some((p) => p.x < pad.minX)).toBe(true);
    expect(posts.some((p) => p.x > pad.maxX)).toBe(true);
  });
});

describe('layout payment terminals', () => {
  const terminal = (overrides: Partial<PaymentTerminal>): PaymentTerminal =>
    ({
      id: 'pt_1',
      label: 'Reader',
      provider: 'idtech',
      serialNumber: 'SN1',
      providerDeviceId: null,
      stationId: 'sta_1',
      evseNumber: 1,
      status: 'active',
      online: true,
      hasDisplay: true,
      ...overrides,
    }) as PaymentTerminal;

  it('shows active paired terminals on their station, never inactive or unpaired ones', () => {
    const map = terminalsByStation([
      terminal({}),
      terminal({ id: 'pt_2', status: 'inactive' }),
      terminal({ id: 'pt_3', stationId: null }),
      terminal({ id: 'pt_4', label: null, evseNumber: null, hasDisplay: false, online: false }),
    ]);
    expect(map.get('sta_1')?.map((t) => t.id)).toEqual(['pt_1', 'pt_4']);
    expect(map.get('sta_1')?.[1]).toMatchObject({ name: 'SN1', hasDisplay: false, online: false });
  });

  it('puts a reader on its connector side, or in front for the whole station', () => {
    expect(terminalSide(1)).toBe(-1);
    expect(terminalSide(2)).toBe(1);
    expect(terminalSide(null)).toBe(0);
    expect(terminalSide(3)).toBe(0);
  });
});

describe('live load flows', () => {
  const hierarchy: LinkPanel[] = [
    panel('main', [circuit('c1', ['a', 'b'])], [panel('sub', [circuit('c2', ['c'])])]),
  ];
  const draw = new Map([
    ['a', 11],
    ['b', 28.8],
    ['c', 230.4],
  ]);

  it('sums the live draw up the hierarchy: circuits, sub-panels and panels', () => {
    const { loads } = loadFlows(hierarchy, (id) => draw.get(id));
    expect(loads.get('c1')).toEqual({ drawKw: 39.8, limitKw: 57.6 });
    expect(loads.get('c2')?.drawKw).toBe(230.4);
    expect(loads.get('sub')?.drawKw).toBe(230.4);
    expect(loads.get('main')?.drawKw).toBeCloseTo(270.2);
  });

  it('scales each link by its share of the limit, 0 to 1', () => {
    const { segments } = loadFlows(hierarchy, (id) => draw.get(id));
    // a: 11 of its allocated 22 kW.
    expect(segments.get('station:a')).toBe(0.5);
    // b has no allocated limit: half the circuit's 57.6 kW.
    expect(segments.get('station:b')).toBe(1);
    expect(segments.get('circuit:c1')).toBeCloseTo(39.8 / 57.6);
    // A link never shows more than full.
    expect(segments.get('circuit:c2')).toBe(1);
    expect(segments.get('panel:sub')).toBe(1);
  });

  it('shows no flow for a station that draws nothing or reports nothing', () => {
    const { segments, loads } = loadFlows(hierarchy, () => undefined);
    expect(segments.get('station:a')).toBe(0);
    expect(loads.get('main')?.drawKw).toBe(0);
  });

  it('marks a load near its limit from 80 percent and at its limit from 100 percent', () => {
    expect(loadLevel(79, 100)).toBe('normal');
    expect(loadLevel(80, 100)).toBe('near');
    expect(loadLevel(100, 100)).toBe('at');
    expect(loadLevel(120, 100)).toBe('at');
    expect(loadLevel(50, null)).toBe('normal');
  });
});
