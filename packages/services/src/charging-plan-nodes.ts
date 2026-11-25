// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Departure-aware allocation of a depot site: builds the planner input from the
// site's panel and circuit tree, binds departures to the sessions charging for
// them, plans when the stored plan is stale, writes the plan and the readiness
// of every departure (writeSitePlan), and turns the current slot of the plan
// into fixed allocations for the load management cycle.

import { circuitConductorPhases } from '@evtivity/lib';
import { acMinimumKw } from '@evtivity/lib/evse-allocation';
import {
  PLAN_HORIZON_HOURS,
  PLAN_SLOT_MINUTES,
  type PlanNodeUse,
} from '@evtivity/lib/charging-plan';
import {
  ALL_PHASES,
  circuitPhaseShare,
  legWeight,
  mapsThroughStepDown,
  nodeCapacityKw as busCapacityKw,
  stepDownPrimaryPhases,
  subPanelPhaseShare,
} from './load-management-phases.js';
import { fixedLoadKw, fixedPhaseLoad, weightedFixedKw } from './load-management-allocation.js';
import {
  type HierarchyNode,
  type PhaseLoad,
  type StationPowerInfo,
} from './load-management-model.js';

/** The virtual node every vehicle's power flows through; its load is the one smoothed. */
export const PLAN_SITE_NODE = 'site';

/** Departures this far ahead get a readiness; sessions bind within the planner horizon. */
export const PLAN_READINESS_AHEAD_MS = 7 * 86_400_000;

/** Planner runs above this log a warning. */
export const PLAN_RUNTIME_BUDGET_MS = 250;

/** Slots that hold the current allocation of the unplanned sessions as fixed load. */
export const UNPLANNED_HOLD_SLOTS = 2;

export const SLOT_MS = PLAN_SLOT_MINUTES * 60_000;

export const HORIZON_MS = PLAN_HORIZON_HOURS * 3_600_000;

export const CUT_TOLERANCE_KW = 0.01;

/** Capacity of a hold node after the hold slots: no limit of its own. */
export const UNLIMITED_KW = 1_000_000;

/** The node that keeps a planned session on a reserved station at 0 for the hold slots. */
export function holdNodeId(stationDbId: string): string {
  return `hold:${stationDbId}`;
}

export function panelNodeId(panelId: string): string {
  return `panel:${panelId}`;
}

export function phaseNodeId(panelId: string, phase: string): string {
  return `panel:${panelId}:${phase}`;
}

export function transformerNodeId(transformerId: string): string {
  return `transformer:${transformerId}`;
}

export function transformerPhaseNodeId(transformerId: string, phase: string): string {
  return `transformer:${transformerId}:${phase}`;
}

/** The planner node of a panel or a transformer. */
function busNodeId(node: HierarchyNode): string {
  return node.type === 'transformer' ? transformerNodeId(node.id) : panelNodeId(node.id);
}

/** The planner node of one phase of a three-phase panel or transformer. */
function busPhaseNodeId(node: HierarchyNode, phase: string): string {
  return node.type === 'transformer'
    ? transformerPhaseNodeId(node.id, phase)
    : phaseNodeId(node.id, phase);
}

export function circuitNodeId(circuitId: string): string {
  return `circuit:${circuitId}`;
}

export interface PlanNodes {
  /**
   * Headroom per planner node after the fixed loads, in kW, from the grid
   * only: the later slots (owner decision D10, no supply forecast). The fixed
   * loads hold the battery loads (`supplyLoadKw`).
   */
  headroomKw: Map<string, number>;
  /**
   * Headroom of slot 0, in kW: `headroomKw` plus the live battery and solar
   * credit (`nodeCapacityKw`, `supplyPhaseCreditKw`), as the cycle allocates now.
   */
  liveHeadroomKw: Map<string, number>;
  /** Per station database id: the nodes its power flows through and the weight on each. */
  paths: Map<string, PlanNodeUse[]>;
  /** Per station database id: its circuit node. */
  circuitOf: Map<string, string>;
  /** Per station database id: 6 A on its circuit's voltage and conductor phases, in kW. */
  acMinKw: Map<string, number>;
}

function stationsUnder(node: HierarchyNode): StationPowerInfo[] {
  return [...node.stations, ...node.children.flatMap(stationsUnder)];
}

/**
 * The weight of each station below `node` on each of `node`'s phases, as the
 * cycle counts phase load: a circuit by its share of its own panel's phases, a
 * single-phase sub-panel that names its feeding phases by its share, a
 * three-phase step-down transformer by the delta-wye mapping of its secondary
 * phases (`stepDownPrimaryPhases`, owner decision D16), anything else 1:1.
 */
function phaseWeightsUnder(node: HierarchyNode): Map<string, PhaseLoad> {
  const weights = new Map<string, PhaseLoad>();
  const addTo = (stationId: string, load: PhaseLoad): void => {
    const current = weights.get(stationId) ?? { L1: 0, L2: 0, L3: 0 };
    for (const phase of ALL_PHASES) current[phase] += load[phase];
    weights.set(stationId, current);
  };
  const on = (phases: readonly string[], share: number): PhaseLoad => ({
    L1: phases.includes('L1') ? share : 0,
    L2: phases.includes('L2') ? share : 0,
    L3: phases.includes('L3') ? share : 0,
  });
  for (const child of node.children) {
    if (mapsThroughStepDown(node, child)) {
      for (const [stationId, secondary] of phaseWeightsUnder(child)) {
        addTo(stationId, stepDownPrimaryPhases(secondary));
      }
    } else if (child.type === 'circuit') {
      const { phases, share } = circuitPhaseShare(child.phaseConnections, node.phases);
      for (const station of child.stations) addTo(station.id, on(phases, share));
    } else if (node.phases === 3 && child.phases !== 3 && child.phaseConnections != null) {
      const { phases, share } = subPanelPhaseShare(node, child);
      for (const station of stationsUnder(child)) addTo(station.id, on(phases, share));
    } else {
      for (const [stationId, load] of phaseWeightsUnder(child)) addTo(stationId, load);
    }
  }
  return weights;
}

/**
 * The planner nodes of a site tree: every circuit, every panel and every
 * transformer (service and step-down), and every phase of a three-phase one,
 * with the headroom the load management cycle would leave after `reservedKw`,
 * the unmanaged loads, the battery loads and the reserved local generation,
 * and the path of each station with the same weights the cycle uses (the
 * circuit at 1, each panel or transformer above it at the leg weight, each
 * phase at its phase share, through a step-down transformer by D16). Slot 0
 * also gets the live battery and solar credit (`liveHeadroomKw`), the later
 * slots the grid only (owner decision D10).
 */
export function buildPlanNodes(
  roots: readonly HierarchyNode[],
  reservedKw: ReadonlyMap<string, number>,
): PlanNodes {
  const headroomKw = new Map<string, number>();
  const liveHeadroomKw = new Map<string, number>();
  const paths = new Map<string, PlanNodeUse[]>();
  const circuitOf = new Map<string, string>();
  const acMinKw = new Map<string, number>();
  const add = (stationDbId: string, nodeId: string, weight: number): void => {
    if (weight <= 0) return;
    const list = paths.get(stationDbId) ?? [];
    list.push({ nodeId, weight });
    paths.set(stationDbId, list);
  };

  const visitPanel = (panel: HierarchyNode, ancestors: HierarchyNode[]): void => {
    const busId = busNodeId(panel);
    const fixedKw = weightedFixedKw(panel, reservedKw);
    headroomKw.set(busId, Math.max(0, panel.maxContinuousKw - panel.safetyMarginKw - fixedKw));
    liveHeadroomKw.set(busId, Math.max(0, busCapacityKw(panel) - fixedKw));
    if (panel.phases === 3 && panel.perPhaseCapacityKw != null) {
      const fixed: PhaseLoad = { L1: 0, L2: 0, L3: 0 };
      fixedPhaseLoad(panel, reservedKw, fixed);
      for (const phase of ALL_PHASES) {
        const grid = panel.perPhaseCapacityKw - panel.safetyMarginKw / 3 - fixed[phase];
        const phaseId = busPhaseNodeId(panel, phase);
        headroomKw.set(phaseId, Math.max(0, grid));
        liveHeadroomKw.set(phaseId, Math.max(0, grid + (panel.supplyPhaseCreditKw?.[phase] ?? 0)));
      }
      for (const [stationId, load] of phaseWeightsUnder(panel)) {
        for (const phase of ALL_PHASES) add(stationId, busPhaseNodeId(panel, phase), load[phase]);
      }
    }
    const chain = [panel, ...ancestors];
    for (const child of panel.children) {
      if (child.type !== 'circuit') {
        visitPanel(child, chain);
        continue;
      }
      const circuitHeadroom = Math.max(0, child.maxContinuousKw - fixedLoadKw(child, reservedKw));
      headroomKw.set(circuitNodeId(child.id), circuitHeadroom);
      liveHeadroomKw.set(circuitNodeId(child.id), circuitHeadroom);
      // A panel above counts the circuit at the leg weight of its own panel.
      const weight = legWeight(panel, child);
      const conductors = circuitConductorPhases(child.phaseConnections, child.phases);
      const sixAmpKw = acMinimumKw(child.voltageV, conductors);
      for (const station of child.stations) {
        circuitOf.set(station.id, circuitNodeId(child.id));
        acMinKw.set(station.id, sixAmpKw);
        add(station.id, circuitNodeId(child.id), 1);
        for (const node of chain) add(station.id, busNodeId(node), weight);
      }
    }
  };

  let siteKw = 0;
  let liveSiteKw = 0;
  for (const root of roots) {
    visitPanel(root, []);
    siteKw += headroomKw.get(busNodeId(root)) ?? 0;
    liveSiteKw += liveHeadroomKw.get(busNodeId(root)) ?? 0;
  }
  headroomKw.set(PLAN_SITE_NODE, siteKw);
  liveHeadroomKw.set(PLAN_SITE_NODE, liveSiteKw);
  for (const list of paths.values()) list.push({ nodeId: PLAN_SITE_NODE, weight: 1 });
  return { headroomKw, liveHeadroomKw, paths, circuitOf, acMinKw };
}
