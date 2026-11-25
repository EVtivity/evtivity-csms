// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { conductorFactor } from '@evtivity/lib';
import type { Phase, HierarchyNode, PhaseLoad } from './load-management-model.js';

export const ALL_PHASES: readonly Phase[] = ['L1', 'L2', 'L3'];

/**
 * The phases of a three-phase panel a circuit is connected to, from its
 * phaseConnections value (none: all three).
 */
export function getCircuitPhases(phaseConnections: string | null): Phase[] {
  if (phaseConnections == null || phaseConnections === 'L1L2L3') return ['L1', 'L2', 'L3'];
  const map: Record<string, Array<'L1' | 'L2' | 'L3'>> = {
    L1: ['L1'],
    L2: ['L2'],
    L3: ['L3'],
    L1L2: ['L1', 'L2'],
    L1L3: ['L1', 'L3'],
    L2L3: ['L2', 'L3'],
    L1L2L3: ['L1', 'L2', 'L3'],
  };
  return map[phaseConnections] ?? ['L1', 'L2', 'L3'];
}

/**
 * The phases a circuit loads below a three-phase panel, and the share of its
 * power each of them carries. Phase loads are in kW as phase current x phase
 * to neutral voltage, the unit of `perPhaseCapacityKw`. The current on each
 * conductor is P / (V x 1, sqrt(3) or 3) for 1, 2 or 3 conductor phases
 * (`conductorFactor`), so each phase carries P / conductorFactor(n): all of it
 * on one phase, P / sqrt(3) (not P / 2) on each of two phases, P / 3 on each of
 * three.
 *
 * `panelPhases` is the circuit's own panel. A circuit of a single-phase
 * sub-panel below a three-phase panel is counted with all of its power on
 * every phase: the CSMS does not know which phase feeds the sub-panel.
 */
export function circuitPhaseShare(
  phaseConnections: string | null,
  panelPhases: number,
): { phases: readonly Phase[]; share: number } {
  if (panelPhases !== 3) return { phases: ALL_PHASES, share: 1 };
  const phases = getCircuitPhases(phaseConnections);
  return { phases, share: 1 / conductorFactor(phases.length) };
}

/**
 * Share of a panel's own (unmanaged) load on each phase: balanced on a
 * three-phase panel, all of it on every phase for a single-phase sub-panel.
 */
export function panelOwnPhaseShare(panelPhases: number): number {
  return panelPhases === 3 ? 1 / 3 : 1;
}

/**
 * The phases of a three-phase `parent` a single-phase sub-panel loads, and the
 * share of its power each carries. Without phase connections (or below a
 * single-phase parent): all of it on every phase (conservative). With them:
 * the phase current x the parent's phase to neutral voltage, P x Vparent /
 * Vsub on each named phase, never less than the circuit rule
 * (1 / conductorFactor(n)), so a sub-panel voltage entered too high does not
 * hide load.
 */
export function subPanelPhaseShare(
  parent: HierarchyNode,
  child: HierarchyNode,
): { phases: readonly Phase[]; share: number } {
  if (parent.phases !== 3 || child.phases === 3 || child.phaseConnections == null) {
    return { phases: ALL_PHASES, share: 1 };
  }
  const phases = getCircuitPhases(child.phaseConnections);
  if (phases.length === 3) return { phases: ALL_PHASES, share: 1 };
  // A transformer of unknown secondary voltage has voltageV 0: full share.
  const byVoltage =
    child.voltageV > 0 && parent.voltageV > 0 ? parent.voltageV / child.voltageV : 1;
  return { phases, share: Math.min(1, Math.max(1 / conductorFactor(phases.length), byVoltage)) };
}

/**
 * Weight of a child's load in its single-phase panel's capacity check. A
 * circuit below the panel voltage (a 120 V branch of a 240 V split-phase
 * panel) draws its current from one leg, so P kW at 120 V loads that leg like
 * 2P kW at 240 V: weight Vpanel / Vcircuit. Every other child: 1. The
 * capacity (kW at the panel voltage) then bounds the current of each leg even
 * when every lower-voltage circuit sits on the same leg.
 */
export function legWeight(parent: HierarchyNode, child: HierarchyNode): number {
  if (parent.phases === 3 || child.type !== 'circuit') return 1;
  return child.voltageV > 0 && child.voltageV < parent.voltageV
    ? parent.voltageV / child.voltageV
    : 1;
}

/**
 * Whether `child` is a three-phase step-down transformer below a three-phase
 * `parent`: its secondary phase loads map onto the parent's phases through
 * `stepDownPrimaryPhases` (owner decision D16). A three-phase sub-panel
 * directly below a three-phase panel keeps the 1:1 mapping.
 */
export function mapsThroughStepDown(parent: HierarchyNode, child: HierarchyNode): boolean {
  return child.type === 'transformer' && parent.phases === 3 && child.phases === 3;
}

/**
 * Per-phase load on the primary of a three-phase delta-wye step-down
 * transformer from the load on its secondary phases (derived, D16). A
 * secondary line to neutral load on phase a sits across one delta winding, so
 * it draws on two primary lines: in the per-phase unit of the hierarchy
 * (phase current x phase to neutral voltage) that is P / sqrt(3) on each of
 * them, the two-phase rule of `circuitPhaseShare`. Secondary L1, L2, L3 load
 * primary L1L2, L2L3, L3L1. A balanced load P counts 2 / (3 sqrt 3) = 0.385 P
 * on each primary phase instead of P / 3 (up to 15 percent high, the safe side).
 */
export function stepDownPrimaryPhases(secondary: PhaseLoad): PhaseLoad {
  const k = 1 / Math.sqrt(3);
  return {
    L1: (secondary.L1 + secondary.L3) * k,
    L2: (secondary.L1 + secondary.L2) * k,
    L3: (secondary.L2 + secondary.L3) * k,
  };
}

// The secondary phases of a step-down transformer that load each primary
// phase (the inverse of `stepDownPrimaryPhases`).
export const STEP_DOWN_SECONDARY_OF: Record<Phase, readonly Phase[]> = {
  L1: ['L1', 'L3'],
  L2: ['L1', 'L2'],
  L3: ['L2', 'L3'],
};

/**
 * Load of the node itself that no allocation can change, kW: its unmanaged
 * loads and the load of the batteries connected at it.
 */
export function ownFixedKw(node: HierarchyNode): number {
  return node.unmanagedLoadKw + (node.supplyLoadKw ?? 0) + (node.localGenerationKw ?? 0);
}

/**
 * Most a node can carry for what it feeds, kW: its capacity after the safety
 * margin plus its supply credit, and never more than its own loads plus what
 * its children can carry (a credit never raises a node past the limits of the
 * nodes below it). A circuit: its capacity.
 */
function feedCapacityKw(node: HierarchyNode): number {
  if (node.type === 'circuit') return node.maxContinuousKw;
  const own = node.maxContinuousKw - node.safetyMarginKw + (node.supplyCreditKw ?? 0);
  const fed = node.children.reduce((sum, child) => sum + feedCapacityKw(child), ownFixedKw(node));
  return Math.min(own, fed);
}

/**
 * Capacity of a panel or transformer for its stations and fixed loads, kW:
 * its capacity after the safety margin plus its supply credit, the credited
 * part never above what its children can carry (`feedCapacityKw`). Without a
 * credit: the capacity after the margin, unchanged.
 */
export function nodeCapacityKw(node: HierarchyNode): number {
  const base = node.maxContinuousKw - node.safetyMarginKw;
  const credit = node.supplyCreditKw ?? 0;
  if (credit <= 0) return base;
  const fed = node.children.reduce((sum, child) => sum + feedCapacityKw(child), ownFixedKw(node));
  return Math.min(base + credit, Math.max(base, fed));
}
