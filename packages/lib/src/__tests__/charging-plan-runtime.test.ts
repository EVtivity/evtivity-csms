// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { planDepotCharging } from '../charging-plan.js';
import {
  checkPlanInvariants,
  mulberry32,
  randomPlanInput,
} from './helpers/charging-plan-random.js';

const RUNTIME_BUDGET_MS = 250;

// CPU time of this thread, so other test files running in parallel do not count.
function threadCpuMs(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}

describe('planDepotCharging runtime', () => {
  it('plans 200 vehicles over 48 hours within the budget', () => {
    const input = randomPlanInput(mulberry32(48200), {
      vehicles: 200,
      horizonHours: 48,
      panels: 4,
      circuitsPerPanel: 10,
      ratePeriods: 4,
    });
    expect(input.slots.length).toBeGreaterThanOrEqual(192);
    expect(Object.keys(input.nodeCapacityKw)).toHaveLength(1 + 4 * 4 + 40);

    planDepotCharging(input);
    const runs: number[] = [];
    let result = planDepotCharging(input);
    for (let i = 0; i < 3; i += 1) {
      const started = threadCpuMs();
      result = planDepotCharging(input);
      runs.push(threadCpuMs() - started);
    }
    runs.sort((a, b) => a - b);
    const median = runs[1]!;

    expect(checkPlanInvariants(input, result)).toEqual([]);
    expect(result.entries.some((e) => e.shortfallKwh > 0)).toBe(true);
    expect(median, `median ${median.toFixed(1)} ms`).toBeLessThan(RUNTIME_BUDGET_MS);
  });
});
