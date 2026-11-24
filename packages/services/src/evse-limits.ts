// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { conductorFactor } from '@evtivity/lib';
import { allocateEvseLimits } from '@evtivity/lib/evse-allocation';
import type { EvseConstraint, EvseDemand, EvseLimitStrategy } from '@evtivity/lib/evse-allocation';
import { phaseCountOf } from '@evtivity/lib/ev-phases';
import type { LoadAllocationReason } from '@evtivity/lib/load-allocation-reasons';
import type {
  EvseSessionInfo,
  LoadBalancingMode,
  PhaseLoad,
  StationPowerInfo,
  StationRate,
  UnitBudgetInfo,
} from './load-management.service.js';

/** The highest current an AC EVSE limit takes, A per phase (the tariff field's maximum). */
export const EVSE_LIMIT_MAX_A = 500;
/** The demand of an AC EVSE without a rating, A per phase (a 22 kW Type 2 point). */
const UNRATED_AC_EVSE_A = 32;

/** The limit load management gives one charging EVSE of a station. */
export interface EvseLimitResult {
  sessionId: string;
  transactionId: string;
  evseNumber: number;
  unitId: string | null;
  kind: 'ac' | 'dc';
  /** A per phase for an AC session (0.1 A steps); null for DC. */
  limitA: number | null;
  /** The limit in kW (an AC limit at the circuit voltage and the session's phases). */
  limitKw: number;
  /** Phases the AC limit counts (numberPhases); null for DC. */
  phases: number | null;
  reason: LoadAllocationReason;
  paused: boolean;
}

/**
 * How load management limits a station this cycle: per EVSE when the operator
 * chose it or an AC session has a tariff current limit, unless the station
 * refused a per-EVSE limit (then one station limit only).
 */
export function effectiveBalancingMode(station: StationPowerInfo): LoadBalancingMode {
  if (station.evseLimitsRefusedAt != null) return 'station';
  if (station.balancingMode === 'evse') return 'evse';
  const capped = (station.sessions ?? []).some(
    (s) => s.kind === 'ac' && s.tariffMaxCurrentA != null,
  );
  return capped ? 'evse' : 'station';
}

const PHASES = ['L1', 'L2', 'L3'] as const;

/**
 * Voltage factor of a unit's current: a three-phase unit follows the circuit
 * conductors; a single-phase unit draws line to neutral, or line to line on a
 * two-conductor circuit.
 */
export function unitPhaseFactor(unitPhases: number | null, circuitPhases: number): number {
  if (unitPhases != null && unitPhases >= 3) return conductorFactor(circuitPhases);
  return circuitPhases === 2 ? conductorFactor(2) : 1;
}

/** The most a unit budget lets its EVSEs draw together in kW; null when it cannot be told. */
export function unitBudgetKw(
  budget: UnitBudgetInfo,
  voltageV: number | undefined,
  circuitPhases: number,
): number | null {
  if (budget.kind === 'dc') return budget.maxPowerKw;
  if (budget.maxCurrentA == null || voltageV == null || !(voltageV > 0)) return null;
  return (budget.maxCurrentA * voltageV * unitPhaseFactor(budget.phases, circuitPhases)) / 1000;
}

function floorTenth(value: number): number {
  return Math.floor(value * 10 + 1e-6) / 10;
}

function sessionPhaseLabels(session: EvseSessionInfo, circuitPhases: number): string[] {
  const circuit = PHASES.slice(0, Math.max(1, Math.min(3, circuitPhases)));
  if (circuitPhases < 3 || phaseCountOf(session.phases) == null) return [...circuit];
  return circuit.filter((p) => session.phases?.includes(p) === true);
}

/**
 * How a station limited per EVSE on a three-phase circuit splits its
 * allocation over the phases (owner decision 3, 2026-11-24): each AC session
 * asks for its highest current (tariff limit, EVSE rating) on each phase it
 * charges on, and a phase takes the share of the station's power its demand
 * holds. Null for a balanced station (every session on all three phases, or
 * phases not known), a DC session, a station limited as a whole or a circuit
 * of fewer phases: those keep an even spread (P / 3 per phase). The cycle
 * applies it only to a station alone on its circuit (`withPhaseWeights`).
 */
export function stationPhaseWeights(station: StationPowerInfo): PhaseLoad | null {
  if (effectiveBalancingMode(station) !== 'evse') return null;
  if ((station.circuitPhases ?? 1) < 3) return null;
  const sessions = station.sessions ?? [];
  if (sessions.length === 0 || sessions.some((s) => s.kind !== 'ac')) return null;
  const voltageV = station.circuitVoltageV;
  const demand: PhaseLoad = { L1: 0, L2: 0, L3: 0 };
  for (const s of sessions) {
    const labels = sessionPhaseLabels(s, 3) as (keyof PhaseLoad)[];
    const ratingA =
      s.ratingA ??
      (s.ratingKw != null && voltageV != null && voltageV > 0
        ? (s.ratingKw * 1000) / (voltageV * labels.length)
        : UNRATED_AC_EVSE_A);
    const level = Math.min(
      s.tariffMaxCurrentA ?? Number.POSITIVE_INFINITY,
      ratingA,
      EVSE_LIMIT_MAX_A,
    );
    for (const p of labels) demand[p] += Math.max(0, level);
  }
  const total = demand.L1 + demand.L2 + demand.L3;
  if (!(total > 0)) return null;
  if (demand.L1 === demand.L2 && demand.L2 === demand.L3) return null;
  return { L1: demand.L1 / total, L2: demand.L2 / total, L3: demand.L3 / total };
}

/**
 * The watts of a station limit profile: the allocation, or for a station
 * split per phase three times its highest phase, so the station's own even
 * spread of a W or A limit (K01.FR.50) leaves that phase its share. The EVSE
 * limits hold every session within its phase share.
 */
export function stationProfileWatts(
  allocationKw: number,
  weights: PhaseLoad | null | undefined,
): number {
  if (weights == null) return Math.round(allocationKw * 1000);
  const top = Math.max(weights.L1, weights.L2, weights.L3);
  return Math.round(allocationKw * 1000 * 3 * top);
}

/**
 * Splits a station's allocation between its charging EVSEs (`allocateEvseLimits`):
 * per phase in A when every session is AC on a circuit of two or three
 * conductor phases (or the station takes A), else in one kW budget with AC
 * levels converted at the circuit voltage. Each AC session is held to its
 * tariff limit and its EVSE rating, the sessions of a unit with a budget to
 * that budget together, and each AC session gets 6 A or is paused at 0 A; a DC
 * session gets a kW share and is never paused. Empty without a circuit
 * voltage or a session: the station limit alone applies.
 */
export function computeEvseLimits(
  station: StationPowerInfo,
  allocationKw: number,
  rate: StationRate | undefined,
  strategy: EvseLimitStrategy = 'equal_share',
  phaseWeights: PhaseLoad | null = null,
): EvseLimitResult[] {
  const sessions = station.sessions ?? [];
  const voltageV = rate?.voltageV ?? station.circuitVoltageV;
  const circuitPhases = rate?.phases ?? station.circuitPhases ?? 1;
  if (sessions.length === 0 || voltageV == null || !(voltageV > 0)) return [];
  const allocation = Math.max(0, allocationKw);
  const hasDc = sessions.some((s) => s.kind === 'dc');
  const perPhase = !hasDc && (circuitPhases >= 2 || rate?.rateUnit === 'A');

  const phaseFactor = (s: EvseSessionInfo): number => {
    const count = phaseCountOf(s.phases);
    return circuitPhases >= 3 && count != null ? count : conductorFactor(circuitPhases);
  };
  const kwPerAmp = (s: EvseSessionInfo): number => (voltageV * phaseFactor(s)) / 1000;

  const weights = perPhase && circuitPhases >= 3 ? phaseWeights : null;
  const constraints: EvseConstraint[] = perPhase
    ? PHASES.slice(0, Math.max(1, Math.min(3, circuitPhases))).map((p) => ({
        id: `station:${p}`,
        capacity:
          weights != null
            ? (allocation * 1000 * weights[p]) / voltageV
            : (allocation * 1000) / (voltageV * conductorFactor(circuitPhases)),
      }))
    : [{ id: 'station:kw', capacity: allocation }];

  const budgets = new Map((station.unitBudgets ?? []).map((b) => [b.unitId, b]));
  const unitPhaseIds = (budget: UnitBudgetInfo, s: EvseSessionInfo): string[] =>
    budget.phases != null && budget.phases >= 3
      ? sessionPhaseLabels(s, circuitPhases).map((p) => `unit:${budget.unitId}:${p}`)
      : [`unit:${budget.unitId}:L1`];
  const usedUnits = new Set<string>();
  for (const s of sessions) {
    if (s.unitId != null && budgets.has(s.unitId)) usedUnits.add(s.unitId);
  }
  for (const unitId of usedUnits) {
    const budget = budgets.get(unitId);
    if (budget == null) continue;
    if (budget.kind === 'dc') {
      if (budget.maxPowerKw != null) {
        constraints.push({ id: `unit:${unitId}:kw`, capacity: budget.maxPowerKw });
      }
      continue;
    }
    if (budget.maxCurrentA == null) continue;
    const labels = budget.phases != null && budget.phases >= 3 ? PHASES : (['L1'] as const);
    for (const p of labels) {
      constraints.push({ id: `unit:${unitId}:${p}`, capacity: budget.maxCurrentA });
    }
  }
  const unitWeights = (s: EvseSessionInfo): Record<string, number> => {
    const budget = s.unitId != null ? budgets.get(s.unitId) : undefined;
    if (budget == null) return {};
    if (budget.kind === 'dc') {
      if (budget.maxPowerKw == null) return {};
      return { [`unit:${budget.unitId}:kw`]: s.kind === 'dc' ? 1 : kwPerAmp(s) };
    }
    if (budget.maxCurrentA == null) return {};
    const perLevel =
      s.kind === 'dc' ? 1000 / (voltageV * unitPhaseFactor(budget.phases, circuitPhases)) : 1;
    return Object.fromEntries(unitPhaseIds(budget, s).map((id) => [id, perLevel]));
  };

  const tariffBound = new Map<string, boolean>();
  const demands: EvseDemand[] = sessions.map((s, index) => {
    if (s.kind === 'dc') {
      const rating = s.ratingKw ?? Number.POSITIVE_INFINITY;
      return {
        key: s.sessionId,
        kind: 'dc',
        maxLevel: Math.min(rating, allocation),
        weights: { 'station:kw': 1, ...unitWeights(s) },
        priority: station.loadPriority,
        order: index,
      };
    }
    const ratingA = s.ratingA ?? (s.ratingKw != null ? s.ratingKw / kwPerAmp(s) : null);
    const tariffA = s.tariffMaxCurrentA;
    const maxLevel = Math.min(
      tariffA ?? Number.POSITIVE_INFINITY,
      ratingA ?? Number.POSITIVE_INFINITY,
      EVSE_LIMIT_MAX_A,
    );
    tariffBound.set(s.sessionId, tariffA != null && tariffA <= maxLevel);
    const weights: Record<string, number> = {
      ...(perPhase
        ? Object.fromEntries(sessionPhaseLabels(s, circuitPhases).map((p) => [`station:${p}`, 1]))
        : { 'station:kw': kwPerAmp(s) }),
      ...unitWeights(s),
    };
    return {
      key: s.sessionId,
      kind: 'ac',
      maxLevel,
      weights,
      priority: station.loadPriority,
      order: index,
    };
  });

  const limits = allocateEvseLimits({ constraints, demands, strategy });
  return sessions.map((s) => {
    const limit = limits.get(s.sessionId);
    const level = limit?.level ?? 0;
    const paused = limit?.paused === true;
    const reason: LoadAllocationReason =
      limit == null || limit.limitedBy === 'ac_min_pause'
        ? 'ac_min_pause'
        : limit.limitedBy === 'own_max'
          ? tariffBound.get(s.sessionId) === true
            ? 'tariff_limit'
            : 'connector_max'
          : limit.constraintId?.startsWith('unit:') === true
            ? 'unit_budget'
            : 'station_share';
    if (s.kind === 'dc') {
      return {
        sessionId: s.sessionId,
        transactionId: s.transactionId,
        evseNumber: s.evseNumber,
        unitId: s.unitId,
        kind: 'dc',
        limitA: null,
        limitKw: level,
        phases: null,
        reason: limit == null ? 'station_share' : reason,
        paused: false,
      };
    }
    const limitA = paused ? 0 : floorTenth(level);
    const phases = circuitPhases >= 3 ? (phaseCountOf(s.phases) ?? 3) : 1;
    return {
      sessionId: s.sessionId,
      transactionId: s.transactionId,
      evseNumber: s.evseNumber,
      unitId: s.unitId,
      kind: 'ac',
      limitA,
      limitKw: (limitA * voltageV * phaseFactor(s)) / 1000,
      phases,
      reason,
      paused,
    };
  });
}
