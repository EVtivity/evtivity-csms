// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Load management allocation strategies: the single list for the database enum
// (`load_allocation_strategy`), the API validation, the allocation service and the
// CSMS. Browser-safe, because the CSMS imports it. `departure_aware` plans charging
// by each fleet vehicle's departure (route-aware charging).
export const LOAD_ALLOCATION_STRATEGIES = [
  'equal_share',
  'priority_based',
  'departure_aware',
] as const;

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

/**
 * Kinds of transformer in a load management tree: `service`, the transformer
 * of the site's electrical service (usually utility-owned) above the
 * top-level panels; `step_down`, a dry-type unit fed from a panel breaker
 * (480 V to 208Y/120 V for Level 2 panelboards) between a panel and a
 * sub-panel.
 */
export const TRANSFORMER_KINDS = ['service', 'step_down'] as const;
export type TransformerKind = (typeof TRANSFORMER_KINDS)[number];

export const TRANSFORMER_PHASES = [1, 3] as const;

/** Nameplate kVA an operator may enter (pad-mount ratings go to 10 MVA, IEEE C57.12.34). */
export const TRANSFORMER_RATED_KVA_RANGE = { min: 1, max: 100_000 } as const;

/**
 * Standard three-phase pad-mounted transformer ratings with a secondary of
 * 700 V or less, kVA, 45 to 3750 (IEEE C57.12.34; SMU Design Guideline App.
 * 26-C, three-phase pad-mount specification, Dec 2021, 1.1: "45 to 3,750 kVA"
 * for secondaries of 700 V or less, and 2.1; ERMCO brochure Rev 12/19/25 p. 3).
 * Larger units (5000 kVA and up) have medium-voltage secondaries; the form
 * takes them as a Custom Rating. A service transformer form offers the list,
 * and the demo seed sizes each group's transformer from it.
 */
export const PAD_MOUNT_TRANSFORMER_KVA = [
  45, 75, 112.5, 150, 225, 300, 500, 750, 1000, 1500, 2000, 2500, 3000, 3750,
] as const;

/**
 * Dry-type step-down transformer ratings for EV charging, kVA (SDG&E EV
 * Charging Station Standards, Table EV-11.10: 80 C rise, 220 C insulation,
 * NEMA 3R, TP-1). A step-down transformer form offers them.
 */
export const STEP_DOWN_TRANSFORMER_KVA = [75, 112.5, 150, 225, 300, 500] as const;

/**
 * Power factor assumed to turn a transformer's kVA into the kW load management
 * measures (`Power.Active.Import`). 0.95 is the SDG&E EV Charging Station
 * Standards EV-3.10 floor for EVSE ("typically very close to 1 (>0.95)");
 * building loads can be lower, so the operator may set 0.80 to 1.00.
 */
export const TRANSFORMER_POWER_FACTOR_RANGE = { min: 0.8, max: 1, default: 0.95 } as const;

/**
 * Share of the nameplate rating load management may use, in percent. Loading
 * above nameplate is a short-time capability (IEEE C57.91, C57.96), never a
 * continuous one, so the limit stops at 100.
 */
export const TRANSFORMER_LOADING_LIMIT_RANGE = { min: 50, max: 100, default: 100 } as const;

/**
 * Continuous capacity of a transformer in kW, rounded to 1 W. Nameplate kVA is
 * a continuous rating (30 C average ambient over 24 hours), so no 80 percent
 * factor: a secondary breaker at 125 percent of full load current (NEC
 * 450.3(B)) loaded to 80 percent (215.2(A)(1)) carries the same current
 * (0.8 x 1.25 = 1). Null for an unrated transformer.
 */
export function computeTransformerCapacityKw(
  ratedKva: number | null,
  powerFactor: number,
  loadingLimitPercent: number,
): number | null {
  if (ratedKva == null) return null;
  return Math.round(ratedKva * powerFactor * loadingLimitPercent * 10) / 1000;
}
