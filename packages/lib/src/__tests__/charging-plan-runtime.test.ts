// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, inject, it } from 'vitest';
import { planDepotCharging, type PlanInput } from '../charging-plan.js';
import {
  checkPlanInvariants,
  mulberry32,
  randomPlanInput,
} from './helpers/charging-plan-random.js';

declare module 'vitest' {
  export interface ProvidedContext {
    coverageRun: boolean;
  }
}

const RUNTIME_BUDGET_MS = 250;
// Twice the vehicles may take at most this many times as long. The repair pass
// grows a little below the square of the fleet (about 3.6 times per doubling),
// so the bound passes it and fails a cubic blowup (8 times).
const SCALE_FACTOR = 2;
const MAX_SCALE_RATIO = 6;

// CPU time of this thread, so other test files running in parallel do not count.
function threadCpuMs(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}

function depotInput(vehicles: number): PlanInput {
  return randomPlanInput(mulberry32(48200), {
    vehicles,
    horizonHours: 48,
    panels: 4,
    circuitsPerPanel: 10,
    ratePeriods: 4,
  });
}

// Median CPU time of three runs after one warm-up run.
function medianCpuMs(input: PlanInput): number {
  planDepotCharging(input);
  const runs: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const started = threadCpuMs();
    planDepotCharging(input);
    runs.push(threadCpuMs() - started);
  }
  runs.sort((a, b) => a - b);
  return runs[1] ?? Number.POSITIVE_INFINITY;
}

describe('planDepotCharging runtime', () => {
  it('plans 200 vehicles over 48 hours with every invariant holding', () => {
    const input = depotInput(200);
    expect(input.slots.length).toBeGreaterThanOrEqual(192);
    expect(Object.keys(input.nodeCapacityKw)).toHaveLength(1 + 4 * 4 + 40);
    const result = planDepotCharging(input);
    expect(checkPlanInvariants(input, result)).toEqual([]);
    expect(result.entries.some((e) => e.shortfallKwh > 0)).toBe(true);
  });

  // Coverage instrumentation slows the planner several times over, so the
  // absolute budget is checked only on uninstrumented code.
  it.skipIf(inject('coverageRun'))('plans 200 vehicles over 48 hours within the budget', () => {
    const median = medianCpuMs(depotInput(200));
    expect(median, `median ${median.toFixed(1)} ms`).toBeLessThan(RUNTIME_BUDGET_MS);
  });

  it('grows about linearly with the number of vehicles', () => {
    const small = medianCpuMs(depotInput(200 / SCALE_FACTOR));
    const large = medianCpuMs(depotInput(200));
    expect(
      large,
      `200 vehicles ${large.toFixed(1)} ms, ${String(200 / SCALE_FACTOR)} vehicles ${small.toFixed(1)} ms`,
    ).toBeLessThan(MAX_SCALE_RATIO * Math.max(small, 1));
  });
});
