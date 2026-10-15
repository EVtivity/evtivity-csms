// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  circuitConductorPhases,
  computeMaxContinuousKw,
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
