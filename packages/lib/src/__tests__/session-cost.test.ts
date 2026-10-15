// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { isUnchargedSession, sessionDisplayCostCents } from '../session-cost.js';

describe('sessionDisplayCostCents', () => {
  it('shows the running cost of an active session', () => {
    expect(
      sessionDisplayCostCents({ status: 'active', currentCostCents: 120, finalCostCents: null }),
    ).toBe(120);
    expect(sessionDisplayCostCents({ status: 'active', currentCostCents: null })).toBeNull();
  });

  it('shows the final cost of a completed session, null when never priced', () => {
    expect(
      sessionDisplayCostCents({ status: 'completed', finalCostCents: 450, currentCostCents: 400 }),
    ).toBe(450);
    expect(
      sessionDisplayCostCents({ status: 'completed', finalCostCents: null, currentCostCents: 400 }),
    ).toBeNull();
  });

  it('shows a faulted or failed session at its final cost, 0 when none is stored', () => {
    expect(
      sessionDisplayCostCents({ status: 'faulted', finalCostCents: null, currentCostCents: 300 }),
    ).toBe(0);
    expect(sessionDisplayCostCents({ status: 'failed', finalCostCents: 0 })).toBe(0);
    // A re-billed faulted session keeps the cost the operator billed.
    expect(sessionDisplayCostCents({ status: 'faulted', finalCostCents: 980 })).toBe(980);
  });
});

describe('isUnchargedSession', () => {
  it('is true only for a faulted or failed session that costs nothing', () => {
    expect(isUnchargedSession({ status: 'faulted', finalCostCents: null })).toBe(true);
    expect(isUnchargedSession({ status: 'failed', finalCostCents: 0 })).toBe(true);
    expect(isUnchargedSession({ status: 'faulted', finalCostCents: 980 })).toBe(false);
    expect(isUnchargedSession({ status: 'completed', finalCostCents: 0 })).toBe(false);
  });
});
