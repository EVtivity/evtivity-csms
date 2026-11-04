// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  circuitConductorPhases,
  computeMaxContinuousKw,
  computeTransformerCapacityKw,
  PAD_MOUNT_TRANSFORMER_KVA,
  STEP_DOWN_TRANSFORMER_KVA,
  TRANSFORMER_KINDS,
  TRANSFORMER_LOADING_LIMIT_RANGE,
  TRANSFORMER_PHASES,
  TRANSFORMER_POWER_FACTOR_RANGE,
  TRANSFORMER_RATED_KVA_RANGE,
  effectiveCircuitVoltageV,
  isCircuitVoltageAllowed,
  isPanelVoltageAllowed,
  isSubPanelPhaseConnectionAllowed,
} from '../load-allocation.js';

describe('computeMaxContinuousKw', () => {
  it('uses V x A for one phase', () => {
    expect(computeMaxContinuousKw(40, 240, 1)).toBeCloseTo(7.68);
  });

  it('uses 3 x V x A for three phases', () => {
    expect(computeMaxContinuousKw(32, 230, 3)).toBeCloseTo(17.664);
  });

  it('uses the line to line voltage for a two-pole circuit of a three-phase supply', () => {
    // 208Y/120: a two-pole 40 A circuit is 208 V x 40 A, not 2 x 120 V x 40 A.
    expect(computeMaxContinuousKw(40, 120, 2)).toBeCloseTo((Math.sqrt(3) * 120 * 40 * 0.8) / 1000);
  });
});

describe('circuitConductorPhases', () => {
  it('counts the named phases on a three-phase panel', () => {
    expect(circuitConductorPhases('L1', 3)).toBe(1);
    expect(circuitConductorPhases('L2L3', 3)).toBe(2);
    expect(circuitConductorPhases('L1L2L3', 3)).toBe(3);
  });

  it('inherits every panel phase when the circuit names none', () => {
    expect(circuitConductorPhases(null, 3)).toBe(3);
    expect(circuitConductorPhases(null, 1)).toBe(1);
  });

  it('is one on a single-phase panel whatever the circuit names', () => {
    expect(circuitConductorPhases('L1L2L3', 1)).toBe(1);
  });
});

describe('isPanelVoltageAllowed', () => {
  it('accepts phase to neutral voltages for three-phase panels', () => {
    expect(isPanelVoltageAllowed(120, 3)).toBe(true);
    expect(isPanelVoltageAllowed(230, 3)).toBe(true);
    expect(isPanelVoltageAllowed(277, 3)).toBe(true);
  });

  it('refuses line to line voltages for three-phase panels', () => {
    expect(isPanelVoltageAllowed(208, 3)).toBe(false);
    expect(isPanelVoltageAllowed(480, 3)).toBe(false);
  });

  it('accepts 208 and 480 for single-phase panels and refuses unknown voltages', () => {
    expect(isPanelVoltageAllowed(208, 1)).toBe(true);
    expect(isPanelVoltageAllowed(480, 1)).toBe(true);
    expect(isPanelVoltageAllowed(110, 1)).toBe(false);
  });
});

describe('circuit voltage', () => {
  it('allows a lower voltage on a single-phase panel', () => {
    expect(isCircuitVoltageAllowed(120, 240, 1)).toBe(true);
    expect(isCircuitVoltageAllowed(240, 240, 1)).toBe(true);
  });

  it('refuses a voltage above the panel, an unknown voltage and a three-phase panel', () => {
    expect(isCircuitVoltageAllowed(277, 240, 1)).toBe(false);
    expect(isCircuitVoltageAllowed(110, 240, 1)).toBe(false);
    expect(isCircuitVoltageAllowed(120, 230, 3)).toBe(false);
  });

  it('falls back to the panel voltage when unset or not allowed', () => {
    expect(effectiveCircuitVoltageV(120, 240, 1)).toBe(120);
    expect(effectiveCircuitVoltageV(null, 240, 1)).toBe(240);
    expect(effectiveCircuitVoltageV(120, 230, 3)).toBe(230);
    expect(effectiveCircuitVoltageV(277, 240, 1)).toBe(240);
  });

  it('gives a 20 A 120 V branch 1.92 kW', () => {
    expect(computeMaxContinuousKw(20, effectiveCircuitVoltageV(120, 240, 1), 1)).toBeCloseTo(1.92);
  });
});

describe('sub-panel phase connections', () => {
  it('apply only to a single-phase sub-panel of a three-phase panel', () => {
    expect(isSubPanelPhaseConnectionAllowed(1, 3)).toBe(true);
    expect(isSubPanelPhaseConnectionAllowed(3, 3)).toBe(false);
    expect(isSubPanelPhaseConnectionAllowed(1, 1)).toBe(false);
    expect(isSubPanelPhaseConnectionAllowed(1, null)).toBe(false);
  });
});

describe('standard transformer ratings', () => {
  it('lists the pad-mount ratings 45 to 3750 kVA (secondaries of 700 V or less) and the dry-type step-down ratings 75 to 500 kVA, ascending', () => {
    for (const list of [PAD_MOUNT_TRANSFORMER_KVA, STEP_DOWN_TRANSFORMER_KVA]) {
      expect([...list].sort((a, b) => a - b)).toEqual([...list]);
      for (const kva of list) {
        expect(kva).toBeGreaterThanOrEqual(TRANSFORMER_RATED_KVA_RANGE.min);
        expect(kva).toBeLessThanOrEqual(TRANSFORMER_RATED_KVA_RANGE.max);
      }
    }
    expect(PAD_MOUNT_TRANSFORMER_KVA[0]).toBe(45);
    expect(PAD_MOUNT_TRANSFORMER_KVA.at(-1)).toBe(3750);
    expect([...STEP_DOWN_TRANSFORMER_KVA]).toEqual([75, 112.5, 150, 225, 300, 500]);
  });
});

describe('computeTransformerCapacityKw', () => {
  it('rates a transformer at kVA x power factor x loading limit, no 80 percent', () => {
    expect(computeTransformerCapacityKw(1000, 0.95, 100)).toBe(950);
    expect(computeTransformerCapacityKw(75, 1, 80)).toBe(60);
    expect(computeTransformerCapacityKw(112.5, 0.95, 100)).toBeCloseTo(106.875, 3);
    expect(computeTransformerCapacityKw(null, 0.95, 100)).toBeNull();
  });

  it('keeps the operator ranges in one place', () => {
    expect(TRANSFORMER_POWER_FACTOR_RANGE).toEqual({ min: 0.8, max: 1, default: 0.95 });
    expect(TRANSFORMER_LOADING_LIMIT_RANGE).toEqual({ min: 50, max: 100, default: 100 });
    expect(TRANSFORMER_RATED_KVA_RANGE).toEqual({ min: 1, max: 100_000 });
    expect(TRANSFORMER_KINDS).toEqual(['service', 'step_down']);
    expect(TRANSFORMER_PHASES).toEqual([1, 3]);
  });
});
