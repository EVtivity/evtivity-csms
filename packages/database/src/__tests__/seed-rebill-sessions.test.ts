// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { REBILL_DEMO_TRANSACTIONS, rebillDemoScenarios } from '../seed-rebill-sessions.js';

describe('rebillDemoScenarios', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  const { faulted, manual } = rebillDemoScenarios(now);

  it('keys each session by a fixed transaction id', () => {
    expect(faulted.transactionId).toBe(REBILL_DEMO_TRANSACTIONS.faulted);
    expect(manual.transactionId).toBe(REBILL_DEMO_TRANSACTIONS.manual);
  });

  it('meters an hour of charging before the fault, all in the past', () => {
    for (const plan of [faulted, manual]) {
      const first = plan.readings[0];
      const last = plan.readings[plan.readings.length - 1];
      expect(first?.at).toEqual(plan.startedAt);
      expect(first?.registerWh).toBe(plan.meterStartWh);
      expect(last!.at.getTime() - plan.startedAt.getTime()).toBe(60 * 60_000);
      expect(plan.faultedAt.getTime()).toBeGreaterThan(last!.at.getTime());
      expect(plan.faultedAt.getTime()).toBeLessThan(now.getTime());
    }
    expect(faulted.readings.at(-1)!.registerWh - faulted.meterStartWh).toBe(18_000);
    expect(manual.readings.at(-1)!.registerWh - manual.meterStartWh).toBe(24_000);
  });
});
