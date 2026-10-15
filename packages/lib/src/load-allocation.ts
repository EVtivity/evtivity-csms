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

/**
 * Whether a circuit may run at `circuitVoltageV` instead of its panel
 * voltage: a 120 V branch of a 240 V split-phase panel, for example. Only on a
 * single-phase panel (a circuit of a three-phase panel takes its voltage from
 * its phase connections) and never above the panel voltage.
 */
export function isCircuitVoltageAllowed(
  circuitVoltageV: number,
  panelVoltageV: number,
  panelPhases: number,
): boolean {
  return (
    panelPhases !== 3 &&
    (PANEL_VOLTAGES as readonly number[]).includes(circuitVoltageV) &&
    circuitVoltageV <= panelVoltageV
  );
}

/**
 * Voltage a circuit runs at: its own voltage when set and allowed on its
 * panel (`isCircuitVoltageAllowed`), else the panel voltage. Capacity (kW)
 * and limits in A use it.
 */
export function effectiveCircuitVoltageV(
  circuitVoltageV: number | null | undefined,
  panelVoltageV: number,
  panelPhases: number,
): number {
  return circuitVoltageV != null &&
    isCircuitVoltageAllowed(circuitVoltageV, panelVoltageV, panelPhases)
    ? circuitVoltageV
    : panelVoltageV;
}

/**
 * Phases of a three-phase parent panel that feed a single-phase sub-panel:
 * one phase (line to neutral) or two (line to line). Null means unknown: the
 * sub-panel's load then counts in full on every phase of the parent.
 */
export const SUB_PANEL_PHASE_CONNECTIONS = ['L1', 'L2', 'L3', 'L1L2', 'L1L3', 'L2L3'] as const;

export type SubPanelPhaseConnection = (typeof SUB_PANEL_PHASE_CONNECTIONS)[number];

/** A panel may name its feeding phases only as a single-phase sub-panel of a three-phase panel. */
export function isSubPanelPhaseConnectionAllowed(
  panelPhases: number,
  parentPhases: number | null | undefined,
): boolean {
  return panelPhases === 1 && parentPhases === 3;
}
