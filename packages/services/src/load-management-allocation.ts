// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { type AppliedAllocation } from './load-limit-entries.js';
import type { LoadAllocationStrategy } from '@evtivity/lib';
import { conductorFactor } from '@evtivity/lib';
import {
  acSessionFloorKw,
  effectiveBalancingMode,
  sessionPhaseLabels,
  sessionShareOfAllocation,
  stationPhaseWeights,
  unitBudgetKw,
} from './evse-limits.js';
import { AC_MIN_CURRENT_A } from '@evtivity/lib/evse-allocation';
import { phaseCountOf } from '@evtivity/lib/ev-phases';
import type { LoadAllocationReason } from '@evtivity/lib/load-allocation-reasons';
import {
  type StationPowerInfo,
  type EvseSessionInfo,
  EPSILON_KW,
  type AllocationResult,
  type HierarchyNode,
  type PhaseLoad,
  type PlannedAllocationInput,
} from './load-management-model.js';
import {
  ownFixedKw,
  ALL_PHASES,
  panelOwnPhaseShare,
  mapsThroughStepDown,
  stepDownPrimaryPhases,
  circuitPhaseShare,
  subPanelPhaseShare,
  getCircuitPhases,
  legWeight,
  nodeCapacityKw,
  STEP_DOWN_SECONDARY_OF,
} from './load-management-phases.js';
import { sendRateUnit } from './load-management-rate-units.js';

/**
 * Order in which stations keep power: higher `loadPriority` first, then the
 * earlier departure, then the input order. The last one stops first when the
 * minimums do not fit.
 */
function byPriority(stations: readonly StationPowerInfo[]): StationPowerInfo[] {
  return stations
    .map((station, index) => ({ station, index }))
    .sort((a, b) => {
      if (b.station.loadPriority !== a.station.loadPriority) {
        return b.station.loadPriority - a.station.loadPriority;
      }
      const ad = a.station.departureTime;
      const bd = b.station.departureTime;
      if (ad != null && bd != null && ad.getTime() !== bd.getTime()) {
        return ad.getTime() - bd.getTime();
      }
      if (ad != null && bd == null) return -1;
      if (bd != null && ad == null) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.station);
}

/**
 * Power in kW one AC session draws at `amps` per phase on the station's
 * circuit: the session's own phases on a three-phase circuit (unknown counts
 * on all of them), else the circuit's conductors. Null without a circuit.
 */
export function acSessionKwAt(
  station: Pick<StationPowerInfo, 'circuitVoltageV' | 'circuitPhases'>,
  phases: string | null,
  amps: number,
): number | null {
  const voltageV = station.circuitVoltageV;
  if (voltageV == null || !(voltageV > 0)) return null;
  const circuitPhases = station.circuitPhases ?? 1;
  const sessionPhases = phaseCountOf(phases);
  const factor =
    circuitPhases >= 3 && sessionPhases != null ? sessionPhases : conductorFactor(circuitPhases);
  return (amps * voltageV * factor) / 1000;
}

/**
 * The most a station's sessions can draw under their tariff current limits and
 * unit budgets: the sum over its sessions of the EVSE rating (else the station
 * maximum), held to the tariff limit of an AC session, with the sessions of a
 * unit with a budget held to that budget together. Undefined while no session
 * has a limit or a budgeted unit, so such a station allocates as before.
 */
export function sessionCapKw(station: StationPowerInfo): number | undefined {
  const sessions = station.sessions ?? [];
  const budgets = new Map((station.unitBudgets ?? []).map((b) => [b.unitId, b]));
  const inBudget = (s: EvseSessionInfo): boolean => s.unitId != null && budgets.has(s.unitId);
  if (!sessions.some((s) => (s.kind === 'ac' && s.tariffMaxCurrentA != null) || inBudget(s))) {
    return undefined;
  }
  let total = 0;
  const unitTotals = new Map<string, number>();
  for (const session of sessions) {
    const rating =
      session.ratingKw ?? (station.maxPowerKw > 0 ? station.maxPowerKw : Number.POSITIVE_INFINITY);
    let kw = rating;
    if (session.kind === 'ac' && session.tariffMaxCurrentA != null) {
      const capKw = acSessionKwAt(station, session.phases, session.tariffMaxCurrentA);
      if (capKw != null) kw = Math.min(kw, capKw);
    }
    if (session.unitId != null && budgets.has(session.unitId)) {
      unitTotals.set(session.unitId, (unitTotals.get(session.unitId) ?? 0) + kw);
    } else {
      total += kw;
    }
  }
  for (const [unitId, unitKw] of unitTotals) {
    const budget = budgets.get(unitId);
    const capKw =
      budget == null
        ? null
        : unitBudgetKw(budget, station.circuitVoltageV, station.circuitPhases ?? 1);
    total += capKw == null ? unitKw : Math.min(unitKw, capKw);
  }
  return Number.isFinite(total) ? total : undefined;
}

/** The most a station takes: its maximum power, held to its sessions' tariff limits. */
export function stationDemandLimitKw(station: StationPowerInfo): number {
  const cap = sessionCapKw(station);
  const max = station.maxPowerKw > 0 ? station.maxPowerKw : Number.POSITIVE_INFINITY;
  const limit = cap != null ? Math.min(max, cap) : max;
  return Number.isFinite(limit) ? limit : 0;
}

// The upper bound of a station in the equal share: its demand limit, else
// (unknown maximum, no capped session) the equal share.
function stationHiKw(station: StationPowerInfo, unknownCap: number): number {
  const limit = stationDemandLimitKw(station);
  return limit > 0 ? limit : unknownCap;
}

/**
 * A station held to a unit box: the box cap (`capKw`, in the station's limit
 * terms; a W cap of a box is its single-phase worst case), or 0 when that cap
 * cannot reach the station's minimum as the station counts it.
 */
export function boxCappedKw(station: StationPowerInfo, capKw: number): number {
  return capKw < stationStopKw(station) - EPSILON_KW ? 0 : capKw;
}

/**
 * A station's minimum: its own minimum (never above its known maximum) and
 * 6 A for each AC session, so a session is never left between 0 and its floor.
 * A limit spread evenly reaches the sessions only on their phases; one split
 * per phase (`phaseSplit`) reaches them whole. The cuts keep it while it fits.
 */
export function stationMinKw(station: StationPowerInfo): number {
  const split = splitFloorKw(station, station.sessions ?? []);
  return Math.max(ownMinimumKw(station), split ?? acSessionFloorKw(station, countsInFull(station)));
}

/**
 * The floor of a station split per phase: phase p gets its weight of the
 * allocation, so it needs 6 A for each of `sessions` on it divided by that
 * weight. Null when the station is not split.
 */
function splitFloorKw(
  station: StationPowerInfo,
  sessions: readonly EvseSessionInfo[],
): number | null {
  if (station.phaseSplit !== true) return null;
  const voltageV = station.circuitVoltageV;
  const weights = stationPhaseWeights(withPendingPhases(station));
  const ac = sessions.filter((s) => s.kind === 'ac');
  if (weights == null || voltageV == null || !(voltageV > 0) || ac.length === 0) return null;
  const pending = withPendingPhases({ ...station, sessions: ac }).sessions ?? [];
  const onPhase: PhaseLoad = { L1: 0, L2: 0, L3: 0 };
  for (const s of pending) {
    for (const p of sessionPhaseLabels(s, 3) as (keyof PhaseLoad)[]) onPhase[p] += 1;
  }
  let floor = 0;
  for (const p of ALL_PHASES) {
    if (onPhase[p] === 0) continue;
    if (!(weights[p] > 0)) return Number.POSITIVE_INFINITY;
    floor = Math.max(floor, (AC_MIN_CURRENT_A * voltageV * onPhase[p]) / 1000 / weights[p]);
  }
  return floor;
}

/**
 * The least a station may be given before it stops: its minimum, except that
 * a station limited per EVSE pauses single sessions at 0 A (D1), so it runs
 * while its largest session's floor fits.
 */
export function stationStopKw(station: StationPowerInfo): number {
  if (effectiveBalancingMode(station) !== 'evse') return stationMinKw(station);
  const inFull = countsInFull(station);
  return Math.max(
    ownMinimumKw(station),
    0,
    ...(station.sessions ?? []).map(
      (s) => splitFloorKw(station, [s]) ?? acSessionFloorKw({ ...station, sessions: [s] }, inFull),
    ),
  );
}

function countsInFull(station: StationPowerInfo): boolean {
  return (
    station.phaseSplit === true ||
    wattLimitPhaseLoad(station) != null ||
    singlePhaseChargerLoad(station) != null
  );
}

// The station's own minimum as the allocation counts it: an even spread
// reaches the sessions only on their phases.
function ownMinimumKw(station: StationPowerInfo): number {
  const own = Math.max(0, station.minPowerKw);
  const share = sessionShareOfAllocation(station, countsInFull(station));
  const needed = share > 0 ? own / share : own;
  return station.maxPowerKw > 0 ? Math.min(needed, station.maxPowerKw) : needed;
}

/**
 * The minimum each admitted station is held at: its stop floor, raised
 * toward its minimum by one factor as far as `availableKw` allows.
 */
function heldMinimums(
  stations: readonly StationPowerInfo[],
  availableKw: number,
): Map<string, number> {
  const stop = stations.map(stationStopKw);
  const full = stations.map((st, i) => Math.max(stationMinKw(st), stop[i] ?? 0));
  const base = stop.reduce((sum, v) => sum + v, 0);
  const extra = full.reduce((sum, v, i) => sum + v - (stop[i] ?? 0), 0);
  const factor = extra > 0 ? Math.min(1, Math.max(0, availableKw - base) / extra) : 1;
  return new Map(
    stations.map((st, i) => [st.id, (stop[i] ?? 0) + ((full[i] ?? 0) - (stop[i] ?? 0)) * factor]),
  );
}

/**
 * Water-filling: the level L with sum(clamp(L, lo, hi)) = budget, each item
 * getting clamp(L, lo, hi). Assumes sum(lo) <= budget.
 */
function waterFill(items: ReadonlyArray<{ lo: number; hi: number }>, budget: number): number[] {
  const totalHi = items.reduce((sum, i) => sum + i.hi, 0);
  if (totalHi <= budget) return items.map((i) => i.hi);
  const used = (level: number): number =>
    items.reduce((sum, i) => sum + Math.min(i.hi, Math.max(i.lo, level)), 0);
  // f(level) is piecewise linear between the item bounds: find the segment
  // that reaches the budget and solve on it, exactly.
  const points = [...new Set(items.flatMap((i) => [i.lo, i.hi]))].sort((a, b) => a - b);
  let level = points[0] ?? 0;
  for (let k = 0; k < points.length - 1; k++) {
    const start = points[k] ?? 0;
    const end = points[k + 1] ?? start;
    if (used(end) >= budget) {
      const slope = items.filter((i) => i.lo <= start && i.hi >= end).length;
      level = slope > 0 ? start + (budget - used(start)) / slope : start;
      break;
    }
  }
  return items.map((i) => Math.min(i.hi, Math.max(i.lo, level)));
}

/**
 * Stations whose minimums fit in `availableKw`, in priority order. The rest
 * stop (limit 0), lowest priority first.
 */
function admitByMinimum(
  stations: readonly StationPowerInfo[],
  availableKw: number,
): { admitted: StationPowerInfo[]; stopped: StationPowerInfo[] } {
  const admitted: StationPowerInfo[] = [];
  const stopped: StationPowerInfo[] = [];
  let minTotal = 0;
  for (const station of byPriority(stations)) {
    const min = stationStopKw(station);
    if (minTotal + min <= availableKw + EPSILON_KW) {
      admitted.push(station);
      minTotal += min;
    } else {
      stopped.push(station);
    }
  }
  return { admitted, stopped };
}

export function toResult(
  station: StationPowerInfo,
  allocatedKw: number,
  limitedBy?: LoadAllocationReason,
): AllocationResult {
  return {
    stationId: station.stationId,
    stationDbId: station.id,
    allocatedKw,
    currentDrawKw: station.currentDrawKw,
    ...(limitedBy != null ? { limitedBy } : {}),
  };
}

/**
 * What holds a station at its demand limit: its own maximum, or its sessions'
 * tariff current limits, or a unit budget when the budgets hold it lower.
 */
export function demandLimitReason(station: StationPowerInfo): LoadAllocationReason {
  const max = station.maxPowerKw > 0 ? station.maxPowerKw : Number.POSITIVE_INFINITY;
  const cap = sessionCapKw(station);
  if (cap == null || cap >= max - EPSILON_KW) return 'station_max';
  const tariffOnly = sessionCapKw({ ...station, unitBudgets: [] });
  return tariffOnly != null && tariffOnly <= cap + EPSILON_KW ? 'tariff_limit' : 'unit_budget';
}

// A station's share of a circuit: held by its demand limit when it got all of
// it, else by the circuit's capacity.
function shareReason(station: StationPowerInfo, kw: number, hi: number): LoadAllocationReason {
  return stationDemandLimitKw(station) > 0 && kw >= hi - EPSILON_KW
    ? demandLimitReason(station)
    : 'circuit_limit';
}

/**
 * Distribute available power equally among active online stations within a
 * circuit. Each station gets at least its minimum and at most its maximum
 * (a station of unknown maximum is capped at its equal share); the surplus of
 * capped stations goes to the others. When the minimums do not fit, the
 * lowest priority stations stop (allocation 0).
 */
export function computeEqualShareAllocation(
  stations: StationPowerInfo[],
  availableKw: number,
): AllocationResult[] {
  const active = stations.filter((s) => s.hasActiveSession && s.isOnline);
  if (active.length === 0) return [];
  const available = Math.max(0, availableKw);
  const { admitted, stopped } = admitByMinimum(active, available);
  const unknownCap = admitted.length > 0 ? available / admitted.length : 0;
  const held = heldMinimums(admitted, available);
  const bounds = admitted.map((s) => {
    const lo = held.get(s.id) ?? 0;
    return { lo, hi: Math.max(lo, stationHiKw(s, unknownCap)) };
  });
  const levels = waterFill(bounds, available);
  return [
    ...admitted.map((s, i) => {
      const kw = levels[i] ?? 0;
      return toResult(s, kw, shareReason(s, kw, bounds[i]?.hi ?? 0));
    }),
    ...stopped.map((s) => toResult(s, 0, 'min_power_stop')),
  ];
}

/**
 * Distribute available power by priority among active online stations. Every
 * admitted station first gets its minimum; higher priority groups then take
 * the rest first, equal share within a group (secondary order: earlier
 * departure). When the minimums do not fit, the lowest priority stations stop.
 */
export function computePriorityAllocation(
  stations: StationPowerInfo[],
  availableKw: number,
): AllocationResult[] {
  const active = stations.filter((s) => s.hasActiveSession && s.isOnline);
  if (active.length === 0) return [];
  const available = Math.max(0, availableKw);
  const { admitted, stopped } = admitByMinimum(active, available);

  const held = heldMinimums(admitted, available);
  const allocated = new Map(admitted.map((s) => [s.id, held.get(s.id) ?? 0]));
  const hiById = new Map<string, number>();
  let remaining = available - [...allocated.values()].reduce((sum, v) => sum + v, 0);

  const priorityGroups = new Map<number, StationPowerInfo[]>();
  for (const station of admitted) {
    const group = priorityGroups.get(station.loadPriority) ?? [];
    group.push(station);
    priorityGroups.set(station.loadPriority, group);
  }
  for (const priority of [...priorityGroups.keys()].sort((a, b) => b - a)) {
    const group = priorityGroups.get(priority) ?? [];
    const groupMin = group.reduce((sum, s) => sum + (allocated.get(s.id) ?? 0), 0);
    const budget = Math.max(0, remaining) + groupMin;
    const unknownCap = budget / group.length;
    const bounds = group.map((s) => {
      const lo = held.get(s.id) ?? 0;
      return { lo, hi: Math.max(lo, stationHiKw(s, unknownCap)) };
    });
    const levels = waterFill(bounds, budget);
    group.forEach((s, i) => {
      allocated.set(s.id, levels[i] ?? 0);
      hiById.set(s.id, bounds[i]?.hi ?? 0);
    });
    remaining = budget - levels.reduce((sum, v) => sum + v, 0);
  }

  return [
    ...admitted.map((s) => {
      const kw = allocated.get(s.id) ?? 0;
      return toResult(s, kw, shareReason(s, kw, hiById.get(s.id) ?? 0));
    }),
    ...stopped.map((s) => toResult(s, 0, 'min_power_stop')),
  ];
}

/**
 * Bring the allocations of `entries` down to `targetKw` in total. Above their
 * minimums they shrink proportionally; when the minimums alone exceed the
 * target, the lowest priority stations stop first (allocation 0). With no
 * minimums this is a proportional scale. A cut station takes `reason`, a
 * stopped one `min_power_stop`.
 */
export function reduceAllocations(
  entries: ReadonlyArray<{ station: StationPowerInfo; alloc: AllocationResult }>,
  targetKw: number,
  reason: LoadAllocationReason = 'circuit_limit',
  weightOf: (station: StationPowerInfo) => number = () => 1,
): void {
  const target = Math.max(0, targetKw);
  const live = entries.filter((e) => e.alloc.allocatedKw > 0 && weightOf(e.station) > 0);
  // In the node's terms: each station loads it by its weight per kW of its
  // allocation (on a phase node: the share of the allocation that phase carries).
  const loadOf = (e: { station: StationPowerInfo; alloc: AllocationResult }): number =>
    e.alloc.allocatedKw * weightOf(e.station);
  // Two floors: the station's minimum, kept while the minimums fit, and the
  // floor below which it stops (`stationStopKw`).
  const fullOf = (e: { station: StationPowerInfo; alloc: AllocationResult }): number =>
    Math.min(stationMinKw(e.station), e.alloc.allocatedKw);
  const stopOf = (e: { station: StationPowerInfo; alloc: AllocationResult }): number =>
    Math.min(stationStopKw(e.station), fullOf(e));
  let total = live.reduce((sum, e) => sum + loadOf(e), 0);
  if (total <= target + EPSILON_KW) return;

  const keep = new Set(live);
  let stopTotal = live.reduce((sum, e) => sum + stopOf(e) * weightOf(e.station), 0);
  const order = byPriority(live.map((e) => e.station));
  for (let i = order.length - 1; i >= 0 && stopTotal > target + EPSILON_KW; i--) {
    const entry = live.find((e) => e.station === order[i]);
    // Stopping a station with no floor frees no minimum: the cut below takes its share.
    if (entry == null || stopOf(entry) * weightOf(entry.station) <= EPSILON_KW) continue;
    stopTotal -= stopOf(entry) * weightOf(entry.station);
    total -= loadOf(entry);
    entry.alloc.allocatedKw = 0;
    entry.alloc.limitedBy = 'min_power_stop';
    keep.delete(entry);
  }
  if (total <= target + EPSILON_KW) return;

  const kept = [...keep];
  const fullTotal = kept.reduce((sum, e) => sum + fullOf(e) * weightOf(e.station), 0);
  if (fullTotal > target + EPSILON_KW) {
    // The minimums do not all fit: every station from its stop floor toward its minimum.
    const span = fullTotal - stopTotal;
    const factor = span > 0 ? Math.max(0, target - stopTotal) / span : 0;
    for (const e of kept) {
      const stop = stopOf(e);
      const kw = stop + (fullOf(e) - stop) * factor;
      if (kw < e.alloc.allocatedKw - EPSILON_KW) e.alloc.limitedBy = reason;
      e.alloc.allocatedKw = kw;
    }
    return;
  }
  const mins = kept.map(fullOf);
  const extra = total - kept.reduce((sum, e, i) => sum + (mins[i] ?? 0) * weightOf(e.station), 0);
  const factor = extra > 0 ? Math.max(0, target - (total - extra)) / extra : 0;
  kept.forEach((e, i) => {
    const min = mins[i] ?? 0;
    const kw = min + (e.alloc.allocatedKw - min) * factor;
    if (kw < e.alloc.allocatedKw - EPSILON_KW) e.alloc.limitedBy = reason;
    e.alloc.allocatedKw = kw;
  });
}

/**
 * Load that the allocation cannot change, in kW: the unmanaged loads of the
 * node and of every node below it, plus the reservation of each offline
 * station that still has an active session (it keeps charging at the limit it
 * last received, so its power is not free for the others).
 */
export function fixedLoadKw(node: HierarchyNode, reservedKw: ReadonlyMap<string, number>): number {
  let fixed = ownFixedKw(node);
  for (const station of node.stations) {
    fixed += reservedKw.get(station.id) ?? 0;
  }
  for (const child of node.children) {
    fixed += fixedLoadKw(child, reservedKw);
  }
  return fixed;
}

// Fixed load per phase below a three-phase panel. A circuit's fixed load is
// shared over the phases it uses like its station load (circuitPhaseShare).
// A three-phase battery's load is spread like the panel's own load, a
// single-phase one counts in full on every phase; a step-down transformer's
// secondary phases map onto the panel's phases (`stepDownPrimaryPhases`).
/**
 * How a single-phase charger on a three-phase circuit loads the phases: in
 * full on the circuit phase it is wired to, in full on every phase when that
 * is not known. Null for every other station (it loads its circuit's share).
 */
export function singlePhaseChargerLoad(station: StationPowerInfo): PhaseLoad | null {
  if (station.singlePhaseOnThreePhase !== true) return null;
  const phase = station.supplyPanelPhase ?? null;
  if (phase == null) return { L1: 1, L2: 1, L3: 1 };
  return { L1: phase === 'L1' ? 1 : 0, L2: phase === 'L2' ? 1 : 0, L3: phase === 'L3' ? 1 : 0 };
}

/**
 * How one kW of a station limit in W loads the phases of a three-phase
 * circuit: in full on every phase, for a station with an AC EVSE
 * (`hasAcEvse`; a DC-only station spreads it evenly). A W limit bounds the total power only, so
 * a single-phase car, one that starts on a free EVSE before the next cycle
 * included, may draw all of it on any phase. A station counts so while it is
 * sent W (a W-only station, `chargingRateUnitFor`) and while it may still
 * enforce a W limit (`heldWattLimit`), whatever unit its next limit goes out
 * in. Null for a station limited in A and on a circuit of fewer than three
 * phases.
 */
export function wattLimitPhaseLoad(station: StationPowerInfo): PhaseLoad | null {
  const watts = station.rateUnit === 'W' || station.heldWattLimit === true;
  if (!watts || (station.circuitPhases ?? 1) < 3) return null;
  // A DC charger's rectifier draws its power evenly from the three phases.
  if (station.hasAcEvse === false) return null;
  return { L1: 1, L2: 1, L3: 1 };
}

/**
 * The station as the phase accounting counts it: a session still measured on
 * its own phase after a phase choice counts on that phase and the chosen one
 * until the car moves.
 */
export function withPendingPhases(station: StationPowerInfo): StationPowerInfo {
  const sessions = station.sessions;
  if (sessions == null || !sessions.some((s) => s.pendingPhases != null)) return station;
  return {
    ...station,
    sessions: sessions.map((s) => {
      if (s.pendingPhases == null || s.phases == null) return s;
      const both = ALL_PHASES.filter(
        (p) => s.phases?.includes(p) === true || s.pendingPhases?.includes(p) === true,
      ).join('');
      return { ...s, phases: both };
    }),
  };
}

/**
 * The fixed load of `node` on each phase. Each station of `reservedKw` counts
 * in the unit it holds: a single-phase charger and a W limit in full on every
 * phase they might use (`singlePhaseChargerLoad`, `wattLimitPhaseLoad`), an A
 * limit at its circuit's share. A station split per phase counts at its
 * circuit's share too: its limit was sent at three times its busiest share.
 */
export function fixedPhaseLoad(
  node: HierarchyNode,
  reservedKw: ReadonlyMap<string, number>,
  into: PhaseLoad,
): void {
  const single = node.supplySinglePhaseLoadKw ?? 0;
  const spread = node.unmanagedLoadKw + (node.supplyLoadKw ?? 0) - single;
  if (spread > 0 || single > 0) {
    for (const phase of ALL_PHASES) {
      into[phase] += spread * panelOwnPhaseShare(node.phases) + single;
    }
  }
  for (const child of node.children) {
    if (mapsThroughStepDown(node, child)) {
      const secondary: PhaseLoad = { L1: 0, L2: 0, L3: 0 };
      fixedPhaseLoad(child, reservedKw, secondary);
      const primary = stepDownPrimaryPhases(secondary);
      for (const phase of ALL_PHASES) into[phase] += primary[phase];
    } else if (child.type === 'circuit') {
      const { phases, share } = circuitPhaseShare(child.phaseConnections, node.phases);
      let fixed = fixedLoadKw(child, reservedKw);
      for (const station of child.stations) {
        const kw = reservedKw.get(station.id);
        if (kw == null || phases.length !== 3) continue;
        const load = singlePhaseChargerLoad(station) ?? wattLimitPhaseLoad(station);
        if (load == null) continue;
        fixed -= kw;
        for (const phase of ALL_PHASES) into[phase] += kw * load[phase];
      }
      for (const phase of phases) into[phase] += fixed * share;
    } else if (node.phases === 3 && child.phases !== 3 && child.phaseConnections != null) {
      // A single-phase sub-panel that names its feeding phases loads only those.
      const { phases, share } = subPanelPhaseShare(node, child);
      const fixed = fixedLoadKw(child, reservedKw);
      for (const phase of phases) into[phase] += fixed * share;
    } else {
      fixedPhaseLoad(child, reservedKw, into);
    }
  }
}

/**
 * The per-phase split of a station alone on a three-phase circuit
 * (`stationPhaseWeights`), null when it keeps the even spread. The one test of
 * "split per phase" for the allocation and the send (`withPhaseWeights`). A
 * station limited in W is never split: its limit counts in full on every
 * phase (`wattLimitPhaseLoad`), so a split would only raise it.
 */
export function stationSplitWeights(
  circuit: HierarchyNode,
  station: StationPowerInfo,
): PhaseLoad | null {
  if (station.rateUnit === 'W') return null;
  if (circuit.type !== 'circuit' || circuit.stations.length !== 1) return null;
  if (getCircuitPhases(circuit.phaseConnections).length !== 3) return null;
  return stationPhaseWeights(withPendingPhases(station));
}

/** Marks every station whose limit is split per phase (`stationSplitWeights`). */
function markPhaseSplitStations(nodes: readonly HierarchyNode[]): void {
  for (const node of nodes) {
    for (const station of node.stations) {
      station.phaseSplit = stationSplitWeights(node, station) != null;
    }
    markPhaseSplitStations(node.children);
  }
}

/**
 * Sets each station's `rateUnit` to the unit it is sent its limit in, so the
 * phase accounting counts the limit the station holds: A once it accepted an
 * A limit (`acceptedUnits` of its record), then `sendRateUnit` with the units
 * it refused (after a refused W limit the station is sent and holds A).
 */
export function withSendRateUnits(
  stations: StationPowerInfo[],
  previous: readonly AppliedAllocation[] | null,
): void {
  const byId = new Map((previous ?? []).map((a) => [a.stationDbId, a]));
  for (const station of stations) {
    const entry = byId.get(station.id);
    if (entry == null) continue;
    if (entry.acceptedUnits?.includes('A') === true) station.rateUnit = 'A';
    const units = entry.rejectedUnits ?? [];
    if (units.length > 0) station.rateUnit = sendRateUnit(station, units);
  }
}

/**
 * Fixed load of a panel for its capacity check, in kW at the panel voltage:
 * like `fixedLoadKw`, with each circuit weighted by `legWeight`.
 */
export function weightedFixedKw(
  node: HierarchyNode,
  reservedKw: ReadonlyMap<string, number>,
): number {
  let fixed = ownFixedKw(node);
  for (const station of node.stations) {
    fixed += reservedKw.get(station.id) ?? 0;
  }
  for (const child of node.children) {
    fixed +=
      child.type === 'circuit'
        ? fixedLoadKw(child, reservedKw) * legWeight(node, child)
        : weightedFixedKw(child, reservedKw);
  }
  return fixed;
}

/**
 * Compute hierarchical allocation respecting panel and circuit constraints.
 *
 * Algorithm:
 * 1. For each leaf circuit: allocate among active online stations using the
 *    strategy, within the circuit capacity minus its fixed load (unmanaged
 *    loads and the reservations of offline stations).
 * 2. For each panel (bottom-up): the stations get at most the panel capacity
 *    minus the safety margin and every fixed load below the panel (its own
 *    unmanaged loads, those of its circuits and sub-panels, and the
 *    reservations). Above that, scale all station allocations down
 *    proportionally. On a three-phase panel, then scale the circuits of each
 *    overloaded phase.
 * 3. Return final per-station allocations, never negative.
 *
 * `reservedKw` maps a station database id to the power kept for it while it
 * is offline with an active session.
 *
 * `planned` (departure-aware sites): `kw` maps a station to the power the depot
 * plan gives its planned sessions in the current slot, capped at the station
 * maximum. Such a station gets that power first; the other stations of the
 * circuit share what is left, and a planned station in `sharing` (it also has
 * an unplanned session) takes part in that share on top of its planned power.
 * `minKw` raises the planned station's minimum (the 6 A floor of its AC
 * sessions), so the panel and phase limits, which cut everything alike, never
 * cut a planned session below it: they stop the station instead.
 */
export function computeHierarchicalAllocation(
  roots: HierarchyNode[],
  strategy: LoadAllocationStrategy,
  reservedKw: ReadonlyMap<string, number> = new Map(),
  planned: PlannedAllocationInput = {},
): AllocationResult[] {
  markPhaseSplitStations(roots);
  const plannedKw = planned.kw ?? new Map<string, number>();
  const sharingPlanned = planned.sharing ?? new Set<string>();
  const plannedMinKw = planned.minKw ?? new Map<string, number>();
  // Mutable map: stationDbId -> allocatedKw
  const allocationMap = new Map<string, AllocationResult>();
  // Planned stations as the reductions see them: their minimum raised.
  const effective = new Map<string, StationPowerInfo>();
  const effectiveStation = (station: StationPowerInfo): StationPowerInfo =>
    effective.get(station.id) ?? station;
  // The phase shares of a station split per phase: only a station alone on a
  // three-phase circuit, so its circuit's phases are its own.
  const splitWeights = (circuit: HierarchyNode, station: StationPowerInfo): PhaseLoad | null =>
    stationSplitWeights(circuit, effectiveStation(station));
  // What one kW of a station's allocation puts on each phase of its
  // three-phase circuit: a station split per phase its busiest share on every
  // phase (one limit for all phases, K01.FR.51), a single-phase charger its
  // full power on its phase, and a W station limit its whole power on every
  // phase (`wattLimitPhaseLoad`). Null: its circuit's share (P / 3).
  const phaseMultipliers = (
    circuit: HierarchyNode,
    station: StationPowerInfo,
  ): PhaseLoad | null => {
    const single = singlePhaseChargerLoad(station);
    if (single != null) return single;
    const weights = splitWeights(circuit, station);
    if (weights != null) {
      const top = Math.max(weights.L1, weights.L2, weights.L3);
      return { L1: top, L2: top, L3: top };
    }
    return wattLimitPhaseLoad(station);
  };

  // Pass 1: Allocate within each circuit
  function allocateCircuit(circuit: HierarchyNode): void {
    const capacity = Math.max(0, circuit.maxContinuousKw - fixedLoadKw(circuit, reservedKw));
    // A station with a reservation (offline, or a limit it has not accepted)
    // is a fixed load and gets no allocation.
    const allocatable = circuit.stations.filter((s) => !reservedKw.has(s.id));
    const plannedStations = allocatable.filter(
      (s) => plannedKw.has(s.id) && s.isOnline && s.hasActiveSession,
    );
    const plannedIds = new Set(plannedStations.map((s) => s.id));
    const plannedEntries = plannedStations.map((station) => {
      const raised = {
        ...station,
        minPowerKw: Math.max(station.minPowerKw, plannedMinKw.get(station.id) ?? 0),
      };
      effective.set(station.id, raised);
      const kw = Math.max(0, plannedKw.get(station.id) ?? 0);
      return {
        station: raised,
        alloc: toResult(
          station,
          station.maxPowerKw > 0 ? Math.min(kw, station.maxPowerKw) : kw,
          'depot_plan',
        ),
      };
    });
    // A plan read before a capacity change can ask for more than the circuit holds.
    reduceAllocations(plannedEntries, capacity);
    const plannedTotal = plannedEntries.reduce((sum, e) => sum + e.alloc.allocatedKw, 0);
    const available = Math.max(0, capacity - plannedTotal);
    const plannedPartKw = new Map(plannedEntries.map((e) => [e.station.id, e.alloc.allocatedKw]));

    const sharers: StationPowerInfo[] = [];
    for (const station of allocatable) {
      if (!plannedIds.has(station.id)) {
        sharers.push(station);
        continue;
      }
      if (!sharingPlanned.has(station.id)) continue;
      const plannedPart = plannedPartKw.get(station.id) ?? 0;
      if (station.maxPowerKw <= 0) {
        sharers.push({ ...station, minPowerKw: 0 });
      } else if (station.maxPowerKw - plannedPart > EPSILON_KW) {
        sharers.push({ ...station, maxPowerKw: station.maxPowerKw - plannedPart, minPowerKw: 0 });
      }
    }
    const circuitAllocations =
      strategy === 'priority_based'
        ? computePriorityAllocation(sharers, available)
        : computeEqualShareAllocation(sharers, available);

    for (const entry of plannedEntries) {
      allocationMap.set(entry.station.id, entry.alloc);
    }
    for (const alloc of circuitAllocations) {
      const plannedAlloc = allocationMap.get(alloc.stationDbId);
      if (plannedAlloc != null && plannedIds.has(alloc.stationDbId)) {
        plannedAlloc.allocatedKw += alloc.allocatedKw;
      } else {
        allocationMap.set(alloc.stationDbId, alloc);
      }
    }
    // On a three-phase circuit each phase stays within a third of it, its
    // breaker per phase: a station split per phase, a single-phase charger or
    // a reserved station's W limit puts more than a third of its power on one
    // phase.
    const threePhase =
      circuit.phaseConnections != null
        ? getCircuitPhases(circuit.phaseConnections).length === 3
        : circuit.phases === 3;
    if (threePhase) {
      const fixedPhases: PhaseLoad = { L1: 0, L2: 0, L3: 0 };
      fixedPhaseLoad(
        {
          ...circuit,
          type: 'panel',
          children: [circuit],
          unmanagedLoadKw: 0,
          supplyLoadKw: 0,
          supplySinglePhaseLoadKw: 0,
        },
        reservedKw,
        fixedPhases,
      );
      for (const phase of ALL_PHASES) {
        const limit = Math.max(0, circuit.maxContinuousKw / 3 - fixedPhases[phase]);
        const weights = new Map<string, number>();
        for (let attempt = 0; attempt < 10; attempt++) {
          let load = 0;
          const entries: Array<{ station: StationPowerInfo; alloc: AllocationResult }> = [];
          for (const st of circuit.stations) {
            const alloc = allocationMap.get(st.id);
            if (alloc == null) continue;
            const m = phaseMultipliers(circuit, st)?.[phase] ?? 1 / 3;
            if (m <= 0) continue;
            load += alloc.allocatedKw * m;
            const station = effectiveStation(st);
            weights.set(station.id, m);
            entries.push({ station, alloc });
          }
          if (load <= limit + 1e-9 || load <= 0) break;
          reduceAllocations(entries, limit, 'circuit_limit', (st) => weights.get(st.id) ?? 0);
        }
      }
    }
  }

  // What a station may draw on its allocation: a station split per phase is
  // sent three times its busiest phase share (its station limit applies to
  // every phase, K01.FR.51), so it counts at that limit.
  function heldAllocationKw(
    circuit: HierarchyNode,
    station: StationPowerInfo,
    allocatedKw: number,
  ): number {
    const weights = circuit.type === 'circuit' ? splitWeights(circuit, station) : null;
    if (weights == null) return allocatedKw;
    return allocatedKw * 3 * Math.max(weights.L1, weights.L2, weights.L3);
  }

  // Station allocations below a panel, in kW at the panel voltage: each
  // circuit weighted by `legWeight` (1 unless it runs below the voltage of
  // its single-phase panel).
  function stationAllocatedKw(node: HierarchyNode): number {
    let total = 0;
    for (const station of node.stations) {
      total += heldAllocationKw(node, station, allocationMap.get(station.id)?.allocatedKw ?? 0);
    }
    for (const child of node.children) {
      total += stationAllocatedKw(child) * legWeight(node, child);
    }
    return total;
  }

  // Pass 2: Enforce panel constraints bottom-up
  function enforcePanel(panel: HierarchyNode): void {
    for (const child of panel.children) {
      if (child.type === 'circuit') {
        allocateCircuit(child);
      } else {
        enforcePanel(child);
      }
    }

    // A panel or a transformer: its capacity plus any supply credit
    // (`nodeCapacityKw`), less every fixed load below it.
    const panelAvailable = Math.max(0, nodeCapacityKw(panel) - weightedFixedKw(panel, reservedKw));
    const nodeReason: LoadAllocationReason =
      panel.type === 'transformer' ? 'transformer_limit' : 'panel_limit';
    // Without lower-voltage circuits the weighted demand is the plain total
    // and one cut fits. With them, a cut changes the mix, so measure again.
    for (let attempt = 0; attempt < 10; attempt++) {
      const stationDemand = stationAllocatedKw(panel);
      if (stationDemand <= panelAvailable + EPSILON_KW || stationDemand <= 0) break;
      const entries = entriesUnder(panel, null);
      const total = entries.reduce((sum, e) => sum + e.alloc.allocatedKw, 0);
      reduceAllocations(entries, (total * panelAvailable) / stationDemand, nodeReason);
    }

    // For three-phase panels, check per-phase constraints on the scaled
    // allocations. Each phase is measured again after the previous phase's
    // scaling, so a circuit on two overloaded phases is not cut twice.
    if (panel.phases === 3 && panel.perPhaseCapacityKw != null) {
      const fixedPhases: PhaseLoad = { L1: 0, L2: 0, L3: 0 };
      fixedPhaseLoad(panel, reservedKw, fixedPhases);
      for (const phase of ['L1', 'L2', 'L3'] as const) {
        const perPhaseLimit = Math.max(
          0,
          panel.perPhaseCapacityKw -
            panel.safetyMarginKw / 3 -
            fixedPhases[phase] +
            (panel.supplyPhaseCreditKw?.[phase] ?? 0),
        );
        // Reduce only the circuits on this overloaded phase. A circuit on two
        // or three phases loads this one with part of its power, so measure
        // again until the phase fits (stopping a station changes the mix).
        // Each station's load on this phase per kW of its allocation, as the
        // phase accounting counts it (it does not depend on the allocations).
        const weights = new Map<string, number>();
        const weightOn = (station: StationPowerInfo): number => {
          const known = weights.get(station.id);
          if (known != null) return known;
          const one = new Map([[station.id, { allocatedKw: 1 } as AllocationResult]]);
          const load: PhaseLoad = { L1: 0, L2: 0, L3: 0 };
          computePhaseAllocations(panel, load, one);
          weights.set(station.id, load[phase]);
          return load[phase];
        };
        for (let attempt = 0; attempt < 10; attempt++) {
          const phaseAllocated: PhaseLoad = { L1: 0, L2: 0, L3: 0 };
          computePhaseAllocations(panel, phaseAllocated, allocationMap);
          if (phaseAllocated[phase] <= perPhaseLimit + 1e-9 || phaseAllocated[phase] <= 0) break;
          reduceAllocations(entriesUnder(panel, phase), perPhaseLimit, nodeReason, weightOn);
        }
      }
    }
  }

  // The allocated stations under a node, only those on circuits using
  // `phase` when one is given.
  function entriesUnder(
    node: HierarchyNode,
    phase: 'L1' | 'L2' | 'L3' | null,
    allocMap: ReadonlyMap<string, AllocationResult> = allocationMap,
  ): Array<{ station: StationPowerInfo; alloc: AllocationResult }> {
    const result: Array<{ station: StationPowerInfo; alloc: AllocationResult }> = [];
    for (const child of node.children) {
      if (phase != null && mapsThroughStepDown(node, child)) {
        // A primary phase carries two secondary phases of a step-down unit.
        const seen = new Set<string>();
        for (const secondary of STEP_DOWN_SECONDARY_OF[phase]) {
          for (const entry of entriesUnder(child, secondary, allocMap)) {
            if (seen.has(entry.alloc.stationDbId)) continue;
            seen.add(entry.alloc.stationDbId);
            result.push(entry);
          }
        }
      } else if (child.type === 'circuit') {
        if (
          phase != null &&
          !circuitPhaseShare(child.phaseConnections, node.phases).phases.includes(phase)
        ) {
          continue;
        }
        for (const station of child.stations) {
          const alloc = allocMap.get(station.id);
          if (alloc == null) continue;
          // A station split per phase loads every phase at its busiest share,
          // so it is cut for every phase; a single-phase charger only for its own.
          const m = phase != null && node.phases === 3 ? phaseMultipliers(child, station) : null;
          if (m != null && phase != null && m[phase] <= 0) continue;
          result.push({ station: effectiveStation(station), alloc });
        }
      } else {
        // A single-phase sub-panel that names its feeding phases loads only those.
        if (
          phase != null &&
          node.phases === 3 &&
          child.phases !== 3 &&
          !subPanelPhaseShare(node, child).phases.includes(phase)
        ) {
          continue;
        }
        result.push(...entriesUnder(child, phase, allocMap));
      }
    }
    return result;
  }

  // Compute per-phase allocated power from circuits under a panel
  function computePhaseAllocations(
    node: HierarchyNode,
    phaseAllocated: PhaseLoad,
    allocMap: Map<string, AllocationResult>,
  ): void {
    for (const child of node.children) {
      if (mapsThroughStepDown(node, child)) {
        const secondary: PhaseLoad = { L1: 0, L2: 0, L3: 0 };
        computePhaseAllocations(child, secondary, allocMap);
        const primary = stepDownPrimaryPhases(secondary);
        for (const phase of ALL_PHASES) phaseAllocated[phase] += primary[phase];
      } else if (child.type === 'circuit') {
        const { phases, share } = circuitPhaseShare(child.phaseConnections, node.phases);
        let circuitTotal = 0;
        for (const station of child.stations) {
          const alloc = allocMap.get(station.id);
          if (alloc == null) continue;
          // A station split per phase is sent one limit for every phase at its
          // busiest share (a station limit carries no per-phase values,
          // K01.FR.143), so it loads every phase at that share.
          const m = phases.length === 3 ? phaseMultipliers(child, station) : null;
          if (m != null) {
            for (const phase of ALL_PHASES) phaseAllocated[phase] += alloc.allocatedKw * m[phase];
          } else {
            circuitTotal += alloc.allocatedKw;
          }
        }
        for (const phase of phases) {
          phaseAllocated[phase] += circuitTotal * share;
        }
      } else if (node.phases === 3 && child.phases !== 3 && child.phaseConnections != null) {
        // A single-phase sub-panel that names its feeding phases loads only those.
        const { phases, share } = subPanelPhaseShare(node, child);
        let subTotal = 0;
        for (const entry of entriesUnder(child, null, allocMap))
          subTotal += entry.alloc.allocatedKw;
        for (const phase of phases) phaseAllocated[phase] += subTotal * share;
      } else {
        computePhaseAllocations(child, phaseAllocated, allocMap);
      }
    }
  }

  // Process all root panels
  for (const root of roots) {
    enforcePanel(root);
  }

  return [...allocationMap.values()].map((a) => ({
    ...a,
    allocatedKw: Math.max(0, a.allocatedKw),
  }));
}

/**
 * Site capacity for the allocation log: `siteLimitKw` is the capacity of the
 * roots (service transformers where they exist, else top-level panels) after
 * their safety margin plus their supply credit (`nodeCapacityKw`),
 * `availableKw` what is left of it for the managed stations after every fixed
 * load, and `supplyCreditKw` the battery and solar credit the tree used (each
 * asset once, where some node took it).
 */
export function summarizeSiteCapacity(
  roots: HierarchyNode[],
  reservedKw: ReadonlyMap<string, number>,
): { siteLimitKw: number; availableKw: number; supplyCreditKw: number } {
  let siteLimitKw = 0;
  let availableKw = 0;
  for (const root of roots) {
    const capacity = Math.max(0, nodeCapacityKw(root));
    siteLimitKw += capacity;
    availableKw += Math.max(0, capacity - fixedLoadKw(root, reservedKw));
  }
  let supplyCreditKw = 0;
  const walk = (nodes: readonly HierarchyNode[]): void => {
    for (const node of nodes) {
      for (const asset of node.energyAssets ?? []) {
        if (asset.creditApplied) supplyCreditKw += asset.creditKw;
      }
      walk(node.children);
    }
  };
  walk(roots);
  return { siteLimitKw, availableKw, supplyCreditKw };
}
