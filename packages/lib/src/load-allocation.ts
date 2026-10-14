// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Load management allocation strategies: the single list for the database enum
// (`load_allocation_strategy`), the API validation, the allocation service and the
// CSMS. Browser-safe, because the CSMS imports it.
export const LOAD_ALLOCATION_STRATEGIES = ['equal_share', 'priority_based'] as const;

export type LoadAllocationStrategy = (typeof LOAD_ALLOCATION_STRATEGIES)[number];

// Panel voltages the CSMS accepts. A three-phase panel takes its phase to
// neutral voltage (120 for 208Y/120, 230 for 400Y/230, 277 for 480Y/277): its
// capacity is voltage x amps per conductor phase. 208 and 480 are line to line
// voltages, so a three-phase panel refuses them: the capacity would be
// overstated by a factor of 1.73.
export const PANEL_VOLTAGES = [120, 208, 220, 230, 240, 277, 480] as const;
export const LINE_TO_LINE_ONLY_VOLTAGES: readonly number[] = [208, 480];

export function isPanelVoltageAllowed(voltageV: number, phases: number): boolean {
  if (!(PANEL_VOLTAGES as readonly number[]).includes(voltageV)) return false;
  return phases !== 3 || !LINE_TO_LINE_ONLY_VOLTAGES.includes(voltageV);
}

// NEC continuous load rule: a breaker carries at most 80% of its rating.
export const CONTINUOUS_LOAD_FACTOR = 0.8;

/**
 * Number of phase conductors a circuit uses: every panel phase when it names
 * none, else the phases it names (`L1`, `L1L2`, `L1L2L3`). A circuit on a
 * single-phase panel has one.
 */
export function circuitConductorPhases(
  phaseConnections: string | null | undefined,
  panelPhases: number,
): number {
  if (panelPhases !== 3) return 1;
  if (phaseConnections == null || phaseConnections === '') return 3;
  const count = phaseConnections.split('L').filter((p) => p !== '').length;
  return count >= 1 && count <= 3 ? count : 3;
}

/**
 * Maximum continuous power in kW of a breaker of `amps` on `phases` conductor
 * phases. `voltageV` is the voltage of a single-phase panel, or the phase to
 * neutral voltage of a three-phase one. One phase: V x A. Two phases of a
 * three-phase supply: the line to line voltage (sqrt(3) x V) x A. Three phases:
 * 3 x V x A. Then 80% for continuous load.
 */
export function computeMaxContinuousKw(amps: number, voltageV: number, phases: number): number {
  return (amps * voltageV * conductorFactor(phases) * CONTINUOUS_LOAD_FACTOR) / 1000;
}

/** W per A of phase current on `phases` conductor phases, as a multiple of V. */
export function conductorFactor(phases: number): number {
  return phases >= 3 ? 3 : phases === 2 ? Math.sqrt(3) : 1;
}
