// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { LoadAllocationStrategy } from '@evtivity/lib';
import { circuitConductorPhases } from '@evtivity/lib';
import { computeEvseLimits, effectiveBalancingMode } from './evse-limits.js';
import type { EvseLimitResult } from './evse-limits.js';
import { phaseCountOf } from '@evtivity/lib/ev-phases';
import type { EvPhases } from '@evtivity/lib/ev-phases';
import { componentPhaseOn, phasesThroughRotation } from '@evtivity/lib/phase-rotation';
import type {
  HierarchyNode,
  StationPowerInfo,
  Phase,
  AllocationResult,
} from './load-management-model.js';
import { ALL_PHASES } from './load-management-phases.js';
import type { StationRate } from './load-management-profiles.js';
import { withPendingPhases } from './load-management-allocation.js';

/** A session that has been sent a phase follows it after this long, or keeps its own. */
export const PHASE_TO_USE_SETTLE_MS = 60_000;

/** Another phase is taken only with at least this much more headroom, kW (else the choice stays). */
export const PHASE_SELECTION_MARGIN_KW = 1.5;

/** ...and at least this share of the phase capacity more. */
export const PHASE_SELECTION_MARGIN_SHARE = 0.1;

/**
 * Phase selection (OCPP 2.x K01.FR.19, K01.FR.20, K01.FR.46): a single-phase
 * car on a three-phase charger whose EVSE reports
 * SmartChargingCtrlr.ACPhaseSwitchingSupported, limited per EVSE on a
 * three-phase circuit with a known phase rotation, is sent the phase of the
 * nearest three-phase panel above it with the most headroom (its capacity per
 * phase less the measured load, the car's own draw taken off its phase now).
 * The choice stays for the session unless another phase has clearly more
 * headroom (`PHASE_SELECTION_MARGIN_KW`, `PHASE_SELECTION_MARGIN_SHARE`). The
 * session is counted on that phase, and also on the phase it is measured on
 * until the car moves (`pendingPhases`); `phaseToUse` is the EVSE's phase
 * wired to it. A station that refused a choice, or still measures the car on
 * another phase `PHASE_TO_USE_SETTLE_MS` after it, keeps the measured phase
 * for the session (`phaseToUseRefused`).
 */
export function selectSessionPhases(roots: readonly HierarchyNode[], nowMs: number): void {
  const visit = (node: HierarchyNode, panel: HierarchyNode | null): void => {
    const threePhasePanel =
      node.type !== 'circuit' && node.phases === 3 && node.perPhaseCapacityKw != null
        ? node
        : panel;
    if (
      node.type === 'circuit' &&
      threePhasePanel != null &&
      circuitConductorPhases(node.phaseConnections, node.phases) === 3
    ) {
      for (const station of node.stations) selectStationPhases(station, threePhasePanel, nowMs);
    }
    for (const child of node.children) visit(child, threePhasePanel);
  };
  for (const root of roots) visit(root, null);
}

function selectStationPhases(station: StationPowerInfo, panel: HierarchyNode, nowMs: number): void {
  if (
    !station.isOnline ||
    station.singlePhaseOnThreePhase === true ||
    (station.circuitPhases ?? 1) < 3 ||
    effectiveBalancingMode(station) !== 'evse' ||
    station.sessions == null
  ) {
    return;
  }
  station.sessions = station.sessions.map((s) => {
    const cleared = { ...s, phaseToUse: null, phaseToUseSinceMs: null, pendingPhases: null };
    if (s.kind !== 'ac' || s.phaseSwitching !== true || s.rotation == null) return cleared;
    if (s.phaseToUseRefused === true) return cleared;
    const measured = s.measuredPhases;
    if (measured == null || phaseCountOf(measured) !== 1) return cleared;
    // A choice the car still does not follow after the settle time: keep its own phase.
    if (
      s.phaseToUse != null &&
      s.phaseToUseSinceMs != null &&
      nowMs - s.phaseToUseSinceMs >= PHASE_TO_USE_SETTLE_MS &&
      measured !== `L${String(s.phaseToUse)}`
    ) {
      return { ...cleared, phaseToUseRefused: true };
    }
    const capacity = panel.perPhaseCapacityKw ?? 0;
    const load = panel.phaseLoad ?? { L1: 0, L2: 0, L3: 0 };
    const own = phasesThroughRotation(measured as EvPhases, s.rotation) as Phase;
    const headroom = (p: Phase): number =>
      capacity - load[p] + (p === own ? Math.max(0, s.drawKw ?? 0) : 0);
    let best: Phase = ALL_PHASES.reduce((a, b) => (headroom(b) > headroom(a) ? b : a));
    const held =
      s.phaseToUse != null
        ? (phasesThroughRotation(`L${String(s.phaseToUse)}` as EvPhases, s.rotation) as Phase)
        : null;
    const margin = Math.max(PHASE_SELECTION_MARGIN_KW, capacity * PHASE_SELECTION_MARGIN_SHARE);
    if (held != null && headroom(best) - headroom(held) < margin) best = held;
    const phaseToUse = componentPhaseOn(s.rotation, best);
    if (phaseToUse == null) return cleared;
    return {
      ...s,
      phases: best,
      pendingPhases: own === best ? null : own,
      phaseToUse,
      phaseToUseSinceMs: s.phaseToUse === phaseToUse ? (s.phaseToUseSinceMs ?? nowMs) : nowMs,
    };
  });
}

/** The per-EVSE limits of the managed stations limited per EVSE this cycle. */
export function siteEvseLimits(
  managed: readonly StationPowerInfo[],
  allocations: readonly AllocationResult[],
  rates: ReadonlyMap<string, StationRate>,
  strategy: LoadAllocationStrategy,
): Map<string, EvseLimitResult[]> {
  const byStation = new Map(allocations.map((a) => [a.stationDbId, a]));
  const result = new Map<string, EvseLimitResult[]>();
  for (const station of managed) {
    if (!station.isOnline || effectiveBalancingMode(station) !== 'evse') continue;
    const allocation = byStation.get(station.id);
    if (allocation == null) continue;
    const rate = rates.get(station.id);
    const counted = withPendingPhases(station);
    const limits = computeEvseLimits(
      counted,
      allocation.allocatedKw,
      rate,
      strategy === 'priority_based' ? 'priority_based' : 'equal_share',
      allocation.phaseWeights ?? null,
    );
    const sent =
      counted === station ? limits : limits.map((l) => withChosenPhase(l, station, rate));
    if (sent.length > 0) result.set(station.id, sent);
  }
  return result;
}

/**
 * The EVSE limit of a session counted on its own and its chosen phase
 * (`withPendingPhases`) as it is sent: one phase, the chosen one.
 */
function withChosenPhase(
  limit: EvseLimitResult,
  station: StationPowerInfo,
  rate: StationRate | undefined,
): EvseLimitResult {
  const session = station.sessions?.find((s) => s.sessionId === limit.sessionId);
  if (session?.pendingPhases == null || limit.kind !== 'ac' || limit.limitA == null) return limit;
  const voltageV = rate?.voltageV ?? station.circuitVoltageV ?? 0;
  return {
    ...limit,
    phases: 1,
    limitKw: (limit.limitA * voltageV) / 1000,
    ...(session.phaseToUse != null
      ? { phaseToUse: session.phaseToUse, phaseToUseSinceMs: session.phaseToUseSinceMs ?? null }
      : {}),
  };
}
