// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { acMinimumKw, allocateEvseLimits, AC_MIN_CURRENT_A } from '../evse-allocation.js';

function box(id: string, a: number): { id: string; capacity: number }[] {
  return ['L1', 'L2', 'L3'].map((p) => ({ id: `${id}:${p}`, capacity: a }));
}

function w3(unit: string): Record<string, number> {
  return { [`${unit}:L1`]: 1, [`${unit}:L2`]: 1, [`${unit}:L3`]: 1 };
}

describe('allocateEvseLimits', () => {
  it('splits a 32 A box between two three-phase sessions equally', () => {
    const r = allocateEvseLimits({
      constraints: box('unit1', 32),
      demands: [
        { key: 'e1', kind: 'ac', maxLevel: 32, weights: w3('unit1'), priority: 5, order: 1 },
        { key: 'e2', kind: 'ac', maxLevel: 32, weights: w3('unit1'), priority: 5, order: 2 },
      ],
    });
    expect(r.get('e1')?.level).toBe(16);
    expect(r.get('e2')?.level).toBe(16);
    expect(r.get('e1')).toMatchObject({ limitedBy: 'constraint', paused: false });
  });

  it('gives the surplus of a tariff-capped session to the other one (6 A and 26 A)', () => {
    const r = allocateEvseLimits({
      constraints: box('unit1', 32),
      demands: [
        { key: 'e1', kind: 'ac', maxLevel: 6, weights: w3('unit1'), priority: 5, order: 1 },
        { key: 'e2', kind: 'ac', maxLevel: 32, weights: w3('unit1'), priority: 5, order: 2 },
      ],
    });
    expect(r.get('e1')?.level).toBe(6);
    expect(r.get('e2')?.level).toBe(26);
    expect(r.get('e1')?.limitedBy).toBe('own_max');
    expect(r.get('e2')?.constraintId).toBe('unit1:L1');
  });

  it('lets a single-phase session on L1 leave L2 and L3 to the three-phase one', () => {
    const r = allocateEvseLimits({
      constraints: box('unit1', 32),
      demands: [
        { key: 'e1', kind: 'ac', maxLevel: 32, weights: { 'unit1:L1': 1 }, priority: 5, order: 1 },
        { key: 'e2', kind: 'ac', maxLevel: 32, weights: w3('unit1'), priority: 5, order: 2 },
      ],
    });
    expect(r.get('e1')?.level).toBe(16);
    expect(r.get('e2')?.level).toBe(16);
  });

  it('pauses the lowest priority AC session at 0 A below 6 A', () => {
    const r = allocateEvseLimits({
      constraints: box('unit1', 10),
      demands: [
        { key: 'hi', kind: 'ac', maxLevel: 32, weights: w3('unit1'), priority: 7, order: 1 },
        { key: 'lo', kind: 'ac', maxLevel: 32, weights: w3('unit1'), priority: 3, order: 2 },
      ],
    });
    expect(r.get('lo')).toMatchObject({ level: 0, paused: true, limitedBy: 'ac_min_pause' });
    expect(r.get('hi')?.level).toBe(10);
  });

  it('pauses the later session first at equal priority', () => {
    const r = allocateEvseLimits({
      constraints: box('unit1', 10),
      demands: [
        { key: 'early', kind: 'ac', maxLevel: 32, weights: w3('unit1'), priority: 5, order: 1 },
        { key: 'late', kind: 'ac', maxLevel: 32, weights: w3('unit1'), priority: 5, order: 2 },
      ],
    });
    expect(r.get('late')?.paused).toBe(true);
    expect(r.get('early')?.level).toBe(10);
  });

  it('pauses every AC session when even one cannot get 6 A', () => {
    const r = allocateEvseLimits({
      constraints: box('unit1', 4),
      demands: [
        { key: 'a', kind: 'ac', maxLevel: 32, weights: w3('unit1'), priority: 5, order: 1 },
        { key: 'b', kind: 'ac', maxLevel: 32, weights: w3('unit1'), priority: 5, order: 2 },
      ],
    });
    expect(r.get('a')?.paused).toBe(true);
    expect(r.get('b')?.paused).toBe(true);
  });

  it('shares a DC kW budget without a floor and never pauses DC', () => {
    const r = allocateEvseLimits({
      constraints: [{ id: 'unit2:kw', capacity: 3 }],
      demands: [
        { key: 'd1', kind: 'dc', maxLevel: 50, weights: { 'unit2:kw': 1 }, priority: 5, order: 1 },
        { key: 'd2', kind: 'dc', maxLevel: 50, weights: { 'unit2:kw': 1 }, priority: 1, order: 2 },
      ],
    });
    expect(r.get('d1')?.level).toBe(1.5);
    expect(r.get('d2')).toMatchObject({ level: 1.5, paused: false });
  });

  it('serves higher priority groups first under priority_based', () => {
    const r = allocateEvseLimits({
      strategy: 'priority_based',
      constraints: box('unit1', 32),
      demands: [
        { key: 'hi', kind: 'ac', maxLevel: 20, weights: w3('unit1'), priority: 9, order: 2 },
        { key: 'lo', kind: 'ac', maxLevel: 32, weights: w3('unit1'), priority: 1, order: 1 },
      ],
    });
    expect(r.get('hi')?.level).toBe(20);
    expect(r.get('lo')?.level).toBe(12);
  });

  it('returns an empty map without demands', () => {
    expect(allocateEvseLimits({ constraints: box('u', 32), demands: [] }).size).toBe(0);
  });

  it('never exceeds a constraint and never leaves an AC session between 0 and 6 A', () => {
    let seed = 42;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 500; i += 1) {
      const cap = 6 + Math.floor(rand() * 60);
      const n = 1 + Math.floor(rand() * 4);
      const strategy = rand() < 0.5 ? ('equal_share' as const) : ('priority_based' as const);
      const demands = Array.from({ length: n }, (_, k) => ({
        key: `e${String(k)}`,
        kind: 'ac' as const,
        maxLevel: 6 + Math.floor(rand() * 26),
        weights: rand() < 0.3 ? { 'u:L1': 1 } : w3('u'),
        priority: 1 + Math.floor(rand() * 10),
        order: k,
      }));
      const r = allocateEvseLimits({ constraints: box('u', cap), demands, strategy });
      for (const p of ['L1', 'L2', 'L3']) {
        const used = demands.reduce(
          (s, d) =>
            s +
            (r.get(d.key)?.level ?? 0) *
              ((d.weights as Partial<Record<string, number>>)[`u:${p}`] ?? 0),
          0,
        );
        expect(used).toBeLessThanOrEqual(cap + 1e-9);
      }
      for (const d of demands) {
        const lvl = r.get(d.key)?.level;
        expect(lvl).toBeDefined();
        expect(lvl === 0 || (lvl ?? 0) >= AC_MIN_CURRENT_A - 1e-9).toBe(true);
        expect(lvl ?? 0).toBeLessThanOrEqual(d.maxLevel + 1e-9);
      }
    }
  });
});

describe('acMinimumKw', () => {
  it('gives 6 A on one, two (line to line) and three conductor phases', () => {
    expect(acMinimumKw(230, 1)).toBeCloseTo(1.38, 9);
    expect(acMinimumKw(208, 2)).toBeCloseTo((6 * 208 * Math.sqrt(3)) / 1000, 9);
    expect(acMinimumKw(230, 3)).toBeCloseTo(4.14, 9);
  });

  it('gives every AC session its 6 A before a DC session takes the rest (review C3)', () => {
    // A 5.888 kW W limit shared by a DC session (kW) and a one-phase AC session (A):
    // filled at one level, the DC session would leave the AC one 4.79 A and pause it.
    const kwPerA = 0.23;
    const r = allocateEvseLimits({
      constraints: [{ id: 'station:kw', capacity: 5.888 }],
      demands: [
        {
          key: 'dc',
          kind: 'dc',
          maxLevel: 20,
          weights: { 'station:kw': 1 },
          priority: 5,
          order: 1,
        },
        {
          key: 'ac',
          kind: 'ac',
          maxLevel: 16,
          weights: { 'station:kw': kwPerA },
          priority: 5,
          order: 2,
        },
      ],
    });
    expect(r.get('ac')?.paused).toBe(false);
    expect(r.get('ac')?.level ?? 0).toBeGreaterThanOrEqual(AC_MIN_CURRENT_A - 1e-9);
    expect((r.get('dc')?.level ?? 0) + (r.get('ac')?.level ?? 0) * kwPerA).toBeCloseTo(5.888, 6);
    // Floors that do not fit pause the later AC session, never a DC one.
    const tight = allocateEvseLimits({
      constraints: [{ id: 'station:kw', capacity: 2 }],
      demands: [
        {
          key: 'a1',
          kind: 'ac',
          maxLevel: 16,
          weights: { 'station:kw': kwPerA },
          priority: 5,
          order: 1,
        },
        {
          key: 'a2',
          kind: 'ac',
          maxLevel: 16,
          weights: { 'station:kw': kwPerA },
          priority: 5,
          order: 2,
        },
      ],
    });
    expect(tight.get('a2')?.paused).toBe(true);
    expect(tight.get('a1')?.level ?? 0).toBeGreaterThanOrEqual(AC_MIN_CURRENT_A - 1e-9);
  });
});
