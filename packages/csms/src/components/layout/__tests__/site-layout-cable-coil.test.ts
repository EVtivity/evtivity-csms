// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// An idle cable looped over its hook: it keeps its length by the turns and
// the drop it hangs at, comes onto the hook from the side or from above
// (bending level first), and never hangs below the floor.

import { describe, expect, it } from 'vitest';
import {
  SELF_CLEARANCE_MIN_RATIO,
  bottomRadiusSteps,
  cableGap,
  cableSelfClearance,
  clearCoilCable,
  coilBottomRadius,
  coilCable,
  type CoilPlace,
} from '../site-layout-cable-coil';

type Vec3 = readonly [number, number, number];

const D = 0.02;
// A hook 1 m up on a face looking +z, its turns hanging across x.
const place: CoilPlace = { center: [0, 1, 0.1], u: [1, 0, 0], axis: [0, 0, 1], r1: 0.06 };
const handle = { lead: [-0.25, 0.95, 0.1] as Vec3, end: [-0.25, 1.05, 0.1] as Vec3 };
// A gland run under the hook, beside it.
const sideEntry: Vec3[] = [
  [0.3, 0.4, 0.1],
  [0.3, 0.5, 0.1],
];

function length(points: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (a == null || b == null) continue;
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return total;
}

const base = {
  entry: sideEntry,
  place,
  cableDiameterM: D,
  handle,
  floorY: 0.15,
};

describe('coilCable', () => {
  it('hangs the first turn count whose drop takes the cable length, keeping the length', () => {
    const probe = coilCable({ ...base, lengthM: 100 });
    expect(probe.fits).toBe(false);
    const three = probe.ranges.find((r) => r.turns === 3);
    expect(three).toBeDefined();
    if (three == null) return;
    const lengthM = (three.shortestM + three.longestM) / 2;
    const coil = coilCable({ ...base, lengthM });
    expect(coil.fits).toBe(true);
    expect(coil.turns).toBe(3);
    expect(length(coil.points)).toBeCloseTo(lengthM, 2);
    // Above the floor, from the gland run to the handle.
    expect(coil.bottomY).toBeGreaterThanOrEqual(base.floorY - 1e-6);
    expect(coil.points[0]).toEqual(sideEntry[0]);
    expect(coil.points.at(-1)).toEqual(handle.end);
  });

  it('takes the fewest turns at the shortest drop for a cable too short for its hook', () => {
    const coil = coilCable({ ...base, lengthM: 0.1 });
    expect(coil.fits).toBe(false);
    expect(coil.turns).toBe(1);
    expect(coil.bottomY).toBeCloseTo(place.center[1] - 0.05 - Math.max(0.12, place.r1));
  });

  it('tries no turn count when the hook hangs too low for any drop above the floor', () => {
    const coil = coilCable({ ...base, floorY: 0.95, lengthM: 3 });
    expect(coil.ranges).toEqual([]);
    expect(coil.fits).toBe(false);
    expect(coil.turns).toBe(1);
  });

  it('bends a cable coming straight down from a gland above level before it reaches the hook', () => {
    const entry: Vec3[] = [
      [0.4, 1.6, 0.1],
      [0.4, 1.4, 0.1],
    ];
    const probe = coilCable({ ...base, entry, lengthM: 100, entryHeading: [0, -1, 0] });
    const first = probe.ranges[0];
    if (first == null) throw new Error('no range');
    const lengthM = (first.shortestM + first.longestM) / 2;
    const coil = coilCable({ ...base, entry, lengthM, entryHeading: [0, -1, 0] });
    expect(coil.fits).toBe(true);
    // Past the gland run the cable first runs level toward the hook (toward -x), never back up.
    const afterGland = coil.points.slice(1, 6);
    for (let i = 1; i < afterGland.length; i += 1) {
      const a = afterGland[i - 1];
      const b = afterGland[i];
      if (a == null || b == null) continue;
      expect(b[1]).toBeLessThanOrEqual(a[1] + 1e-9);
    }
    expect(coil.points.slice(1, 10).some((p) => p[0] < 0.4 - 1e-3)).toBe(true);
  });

  it('comes onto the hook top when asked, also from a level gland run beside it', () => {
    const levelRun: Vec3[] = [
      [0.5, 1.3, 0.1],
      [0.4, 1.3, 0.1],
    ];
    const coil = coilCable({ ...base, entry: levelRun, enterFrom: 'top', lengthM: 100 });
    // A level run goes on level: its next point keeps the run's height.
    expect(coil.points[2]?.[1]).toBeCloseTo(1.3, 2);
    expect(coil.ranges.length).toBeGreaterThan(0);
    const highest = Math.max(...coil.points.map((p) => p[1]));
    expect(highest).toBeGreaterThan(place.center[1]);
  });
});

describe('clearance helpers', () => {
  it('measures the gap between two cables center to center', () => {
    const a: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
    ];
    const b: Vec3[] = [
      [0.5, 0.1, 0],
      [0.5, 0.5, 0],
    ];
    expect(cableGap(a, b)).toBeCloseTo(0.1, 3);
  });

  it('measures how close a cable comes to itself only between parts six diameters apart along it', () => {
    // A hairpin: two legs 0.05 m apart, joined far below the near points.
    const pin: Vec3[] = [
      [0, 1, 0],
      [0, 0, 0],
      [0.05, 0, 0],
      [0.05, 1, 0],
    ];
    expect(cableSelfClearance(pin, D)).toBeCloseTo(0.05, 3);
    // A straight cable never comes near itself.
    expect(
      cableSelfClearance(
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
        D,
      ),
    ).toBeGreaterThan(6 * D - 1e-6);
  });

  it('opens a turn bottom to six diameters, at least 0.12 m, and steps radii by 3 cm', () => {
    expect(coilBottomRadius(0.01)).toBe(0.12);
    expect(coilBottomRadius(0.03)).toBeCloseTo(0.18);
    expect(bottomRadiusSteps(0.12, 0.2)).toEqual([0.12, 0.15, 0.18]);
  });
});

describe('clearCoilCable', () => {
  it('picks, of the bottom radii tried, a coil that keeps its length', () => {
    const probe = coilCable({ ...base, lengthM: 100 });
    const three = probe.ranges.find((r) => r.turns === 3);
    if (three == null) throw new Error('no range');
    const lengthM = (three.shortestM + three.longestM) / 2;
    const radii = bottomRadiusSteps(0.12, 0.3);
    const coil = clearCoilCable({ ...base, lengthM }, radii);
    expect(Math.abs(length(coil.points) - lengthM)).toBeLessThan(0.02);
    const candidates = radii.map((r) => coilCable({ ...base, lengthM, bottomRadiusM: r }));
    expect(candidates.some((c) => length(c.points) === length(coil.points))).toBe(true);
  });

  it('returns the first coil that passes every check', () => {
    // A real pedestal-like hook clear of its handle: the gland run straight under it.
    const roomy = {
      ...base,
      entry: [
        [0.0, 0.3, 0.1],
        [0.0, 0.45, 0.1],
      ] as Vec3[],
      handle: { lead: [-0.6, 0.9, 0.1] as Vec3, end: [-0.6, 1.0, 0.1] as Vec3 },
    };
    const probe = coilCable({ ...roomy, lengthM: 100 });
    const passing = probe.ranges
      .map((r) => {
        const lengthM = (r.shortestM + r.longestM) / 2;
        const c = coilCable({ ...roomy, lengthM });
        return { lengthM, ok: cableSelfClearance(c.points, D) >= SELF_CLEARANCE_MIN_RATIO * D };
      })
      .find((x) => x.ok);
    expect(passing).toBeDefined();
    if (passing == null) return;
    const coil = clearCoilCable({ ...roomy, lengthM: passing.lengthM }, [0.12], [0], 0);
    expect(cableSelfClearance(coil.points, D)).toBeGreaterThanOrEqual(SELF_CLEARANCE_MIN_RATIO * D);
  });

  it('falls back to the best coil when none passes, and to the default coil without radii', () => {
    const tooShort = clearCoilCable({ ...base, lengthM: 0.1 }, [0.12, 0.15]);
    expect(tooShort.fits).toBe(false);
    const none = clearCoilCable({ ...base, lengthM: 0.1 }, []);
    expect(none.turns).toBe(coilCable({ ...base, lengthM: 0.1 }).turns);
  });
});
