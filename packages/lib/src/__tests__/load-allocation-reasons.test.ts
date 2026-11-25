// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { LOAD_ALLOCATION_REASONS, isLoadAllocationReason } from '../load-allocation-reasons.js';

describe('load allocation reasons', () => {
  it('lists what may set a limit', () => {
    expect(LOAD_ALLOCATION_REASONS).toEqual([
      'tariff_limit',
      'unit_budget',
      'station_share',
      'circuit_limit',
      'panel_limit',
      'transformer_limit',
      'ac_min_pause',
      'min_power_stop',
      'depot_plan',
      'station_max',
      'connector_max',
      'reserved',
      'idle_allowance',
      'measured_draw',
    ]);
  });

  it('tells a known reason from any other text', () => {
    expect(isLoadAllocationReason('panel_limit')).toBe(true);
    expect(isLoadAllocationReason('x')).toBe(false);
    expect(isLoadAllocationReason('')).toBe(false);
  });
});
