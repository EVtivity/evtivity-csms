// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { conductorFactor } from '@evtivity/lib';
import { CONTINUOUS_LOAD_FACTOR } from '@evtivity/lib/load-allocation';
import { AC_MIN_CURRENT_A, acMinimumKw, allocateEvseLimits } from '@evtivity/lib/evse-allocation';
import type { EvseConstraint, EvseDemand, EvseLimitStrategy } from '@evtivity/lib/evse-allocation';
import { phaseCountOf } from '@evtivity/lib/ev-phases';
import type { LoadAllocationReason } from '@evtivity/lib/load-allocation-reasons';
import type {
  EvseSessionInfo,
  LoadBalancingMode,
  PhaseLoad,
  StationPowerInfo,
  UnitBudgetInfo,
} from './load-management-model.js';
import type { StationRate } from './load-management-profiles.js';

/** The highest current an AC EVSE limit takes, A per phase (the tariff field's maximum). */
export const EVSE_LIMIT_MAX_A = 500;
/** The demand of an AC EVSE without a rating, A per phase (a 22 kW Type 2 point). */
export const UNRATED_AC_EVSE_A = 32;
/** A session's draw counts toward its demand only once it has charged this long. */
export const EVSE_DEMAND_SETTLE_MS = 60_000;
/** A draw below this share of the limit it holds caps the session's demand. */
export const EVSE_DEMAND_LOW_SHARE = 0.8;
/** A capped session keeps its cap while it draws below this share of it. */
export const EVSE_DEMAND_KEEP_SHARE = 0.95;
/** Without measured current, a measured-draw cap is lifted once in every period to probe. */
export const EVSE_DEMAND_PROBE_PERIOD_MS = 10 * 60_000;
/** How long each probe lifts the cap: long enough for two meter readings at a 60 s interval. */
export const EVSE_DEMAND_PROBE_MS = 2 * 60_000;

/**
 * The measured current and the current limit of a session, A per phase, when
 * the station reports `Current.Import` per phase and the EVSE limit went in A.
 * Current does not depend on the supply voltage or the power factor, so the
 * cap compares it when it is known.
 */
export interface MeasuredCurrent {
  /** The highest measured phase current of the EVSE, A. */
  drawA?: number | null;
  /** The EVSE limit last sent in A per phase. */
  heldLimitA?: number | null;
}

/**
 * Whether the measured-draw cap is lifted at `nowMs` to probe the car: the
 * last `EVSE_DEMAND_PROBE_MS` of every `EVSE_DEMAND_PROBE_PERIOD_MS` after the
 * settle time, counted from the session start, so every worker agrees without
 * stored state. A real power draw read against a limit in kW at the nominal
 * voltage reads low at a lower supply voltage or power factor (220 V and PF
 * 0.99 on a 230 V limit read 94.7 percent), so without measured current the
 * keep rule alone could hold a car at its cap for good.
 */
export function measuredDemandProbing(startedAtMs: number, nowMs: number): boolean {
  const elapsed = nowMs - startedAtMs - EVSE_DEMAND_SETTLE_MS;
  if (elapsed < 0) return false;
  return (
    elapsed % EVSE_DEMAND_PROBE_PERIOD_MS >= EVSE_DEMAND_PROBE_PERIOD_MS - EVSE_DEMAND_PROBE_MS
  );
}

/**
 * The demand cap a session's measured draw sets, in kW (the plan measurement's
 * rule, owner finding M3): once the session has charged `EVSE_DEMAND_SETTLE_MS`
 * and holds an EVSE limit, a draw under 80 percent of that limit caps its
 * demand at the draw plus 10 percent (at least 1 kW above the draw), so the
 * power it does not use goes to the others. A session already held at such a
 * cap keeps it while it draws under 95 percent of it, and loses it once it
 * draws at the cap, so it is raised again. With measured current both shares
 * compare current against the current limit; without it the cap is lifted
 * during each probe window (`measuredDemandProbing`). Null: no cap.
 */
export function measuredDemandCapKw(
  session: EvseSessionInfo & MeasuredCurrent,
  nowMs: number,
): number | null {
  const draw = session.drawKw;
  const held = session.heldLimitKw;
  if (draw == null || held == null || !(held > 0) || !(draw >= 0)) return null;
  const startedAtMs = session.startedAt.getTime();
  if (nowMs - startedAtMs < EVSE_DEMAND_SETTLE_MS) return null;
  const cap = Math.max(draw * 1.1, draw + 1);
  const drawA = session.drawA;
  const heldA = session.heldLimitA;
  if (drawA != null && heldA != null && heldA > 0 && drawA >= 0) {
    if (drawA < heldA * EVSE_DEMAND_LOW_SHARE) return cap;
    if (held <= cap * 1.05 && drawA < heldA * EVSE_DEMAND_KEEP_SHARE) return Math.min(cap, held);
    return null;
  }
  if (measuredDemandProbing(startedAtMs, nowMs)) return null;
  if (draw < held * EVSE_DEMAND_LOW_SHARE) return cap;
  if (held <= cap * 1.05 && draw < held * EVSE_DEMAND_KEEP_SHARE) return Math.min(cap, held);
  return null;
}

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
  /** The EVSE phase (1 to 3) the single-phase car is sent to use; null: none (K01.FR.19, K01.FR.20). */
  phaseToUse?: number | null;
  /** When `phaseToUse` was first sent for the session, ms. */
  phaseToUseSinceMs?: number | null;
  /** The station refused or did not follow a phase choice for the session. */
  phaseToUseRefused?: boolean;
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

/**
 * A unit budget is the rating of the box's fuse or breaker: load management
 * holds a continuous load to 80 percent of it, like a circuit (NEC 625.41,
 * 210.19 and 210.20; owner decision 2026-11-24).
 */
export function unitContinuousA(budget: UnitBudgetInfo): number | null {
  return budget.maxCurrentA == null ? null : budget.maxCurrentA * CONTINUOUS_LOAD_FACTOR;
}

/** The continuous kW of a DC unit budget (80 percent of its rating). */
export function unitContinuousKw(budget: UnitBudgetInfo): number | null {
  return budget.maxPowerKw == null ? null : budget.maxPowerKw * CONTINUOUS_LOAD_FACTOR;
}

/** The most a unit budget lets its EVSEs draw together in kW; null when it cannot be told. */
export function unitBudgetKw(
  budget: UnitBudgetInfo,
  voltageV: number | undefined,
  circuitPhases: number,
): number | null {
  if (budget.kind === 'dc') return unitContinuousKw(budget);
  const amps = unitContinuousA(budget);
  if (amps == null || voltageV == null || !(voltageV > 0)) return null;
  return (amps * voltageV * unitPhaseFactor(budget.phases, circuitPhases)) / 1000;
}

function floorTenth(value: number): number {
  return Math.floor(value * 10 + 1e-6) / 10;
}

/** The phases a session charges on: its known phases, else every phase of the circuit. */
export function sessionPhaseLabels(session: EvseSessionInfo, circuitPhases: number): string[] {
  const circuit = PHASES.slice(0, Math.max(1, Math.min(3, circuitPhases)));
  if (circuitPhases < 3 || phaseCountOf(session.phases) == null) return [...circuit];
  return circuit.filter((p) => session.phases?.includes(p) === true);
}

/**
 * How much of a station's allocation its sessions can receive: an allocation
 * spread evenly over a three-phase circuit reaches the sessions only on the
 * phases they charge on (a one-phase car gets a third), shared on a phase
 * they share (`deliveredShare`). 1 when the limit
 * counts in full on every phase, on a circuit of fewer than three phases, or
 * with a DC session.
 */
export function sessionShareOfAllocation(
  station: Pick<StationPowerInfo, 'sessions' | 'circuitPhases'>,
  countedInFull = false,
): number {
  const sessions = station.sessions ?? [];
  const circuitPhases = station.circuitPhases ?? 1;
  if (countedInFull || circuitPhases < 3 || sessions.length === 0) return 1;
  if (sessions.some((s) => s.kind !== 'ac')) return 1;
  return deliveredShare(sessions, circuitPhases);
}

/**
 * The share of a limit spread evenly over three phases that its sessions
 * receive: the station shares each phase evenly between the sessions on it,
 * and a car draws the same current on each of its phases, so each session
 * gets its smallest share. Sessions known only by their phase count (wiring
 * not aligned) are placed from L1, where they overlap the most.
 */
export function deliveredShare(
  sessions: readonly EvseSessionInfo[],
  circuitPhases: number,
): number {
  if (sessions.length === 0) return 1;
  const aligned = sessions.every((s) => phaseCountOf(s.phases) != null);
  const phasesOf = (s: EvseSessionInfo): string[] => {
    if (aligned) return sessionPhaseLabels(s, circuitPhases);
    const count = phaseCountOf(s.phases) ?? phaseCountOf(s.measuredPhases ?? null) ?? 3;
    return PHASES.slice(0, Math.min(3, count));
  };
  const onPhase = new Map<string, number>();
  for (const s of sessions) for (const p of phasesOf(s)) onPhase.set(p, (onPhase.get(p) ?? 0) + 1);
  let share = 0;
  for (const s of sessions) {
    const phases = phasesOf(s);
    share += Math.min(...phases.map((p) => 1 / (onPhase.get(p) ?? 1))) * phases.length;
  }
  return Math.min(1, share / 3);
}

/**
 * The kW a station must be given so each of its AC sessions gets 6 A on the
 * phases it charges on, counted the way the hierarchy counts the station; its
 * DC sessions share the limit at the same current. A
 * limit counted in full on every phase (a W limit, a single-phase charger)
 * needs each session's own 6 A power. Otherwise on a three-phase circuit the
 * allocation spreads evenly over the phases, so it is three times the busiest
 * phase's floor; else 6 A per session on the circuit's conductors. 0 without
 * an AC session or a circuit voltage.
 */
export function acSessionFloorKw(
  station: Pick<StationPowerInfo, 'sessions' | 'circuitVoltageV' | 'circuitPhases'>,
  countedInFull = false,
): number {
  const voltageV = station.circuitVoltageV;
  const sessions = station.sessions ?? [];
  const ac = sessions.filter((s) => s.kind === 'ac');
  if (ac.length === 0 || voltageV == null || !(voltageV > 0)) return 0;
  // The station shares one limit between all its sessions, a DC session too
  // (its rectifier draws on every phase), so each needs 6 A for the AC ones
  // to reach theirs.
  const dc = sessions.filter((s) => s.kind !== 'ac');
  const circuitPhases = station.circuitPhases ?? 1;
  const dcPhases = (s: EvseSessionInfo): number => sessionPhaseLabels(s, circuitPhases).length;
  const dcFullKw = dc.reduce(
    (sum, s) => sum + (AC_MIN_CURRENT_A * voltageV * dcPhases(s)) / 1000,
    0,
  );
  if (countedInFull) {
    // Only the phase count matters here: the measured count when the phases
    // could not be aligned to the panel, else all the circuit's phases.
    const count = (s: EvseSessionInfo): number =>
      circuitPhases < 3
        ? sessionPhaseLabels(s, circuitPhases).length
        : (phaseCountOf(s.phases) ?? phaseCountOf(s.measuredPhases ?? null) ?? circuitPhases);
    return (
      ac.reduce((sum, s) => sum + (AC_MIN_CURRENT_A * voltageV * count(s)) / 1000, 0) + dcFullKw
    );
  }
  if (circuitPhases < 3) {
    return (ac.length + dc.length) * acMinimumKw(voltageV, circuitPhases);
  }
  const perPhase = new Map<string, number>();
  for (const s of sessions) {
    for (const p of sessionPhaseLabels(s, circuitPhases)) {
      perPhase.set(p, (perPhase.get(p) ?? 0) + AC_MIN_CURRENT_A);
    }
  }
  return (3 * Math.max(0, ...perPhase.values()) * voltageV) / 1000;
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
  // Rounded down (a limit is never sent above the allocation), past float noise:
  // 3.68 kW is 3680 W, not 3679.
  if (weights == null) return Math.floor(allocationKw * 1000 + 1e-6);
  const top = Math.max(weights.L1, weights.L2, weights.L3);
  return Math.floor(allocationKw * 1000 * 3 * top + 1e-6);
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
  nowMs: number = Date.now(),
): EvseLimitResult[] {
  const sessions = station.sessions ?? [];
  const voltageV = rate?.voltageV ?? station.circuitVoltageV;
  const circuitPhases = rate?.phases ?? station.circuitPhases ?? 1;
  if (sessions.length === 0 || voltageV == null || !(voltageV > 0)) return [];
  const allocation = Math.max(0, allocationKw);
  const hasDc = sessions.some((s) => s.kind === 'dc');
  const perPhase = !hasDc && (circuitPhases >= 2 || rate?.rateUnit === 'A');

  // The phases a session charges on: aligned to the panel, else as the station measured them.
  const phaseCount = (s: EvseSessionInfo): number | null =>
    phaseCountOf(s.phases) ?? phaseCountOf(s.measuredPhases ?? null);
  const phaseFactor = (s: EvseSessionInfo): number => {
    const count = phaseCount(s);
    return circuitPhases >= 3 && count != null ? count : conductorFactor(circuitPhases);
  };
  // An AC limit goes out in W when the station takes W only (K01.FR.50). A W
  // limit for a session of unknown phases may all land on one phase, so each
  // phase and box counts the whole of it (the single-phase worst case).
  const units = station.supportedRateUnits ?? [];
  const acInW = units.length > 0 && !units.includes('A');
  const worstCase = (s: EvseSessionInfo): number =>
    acInW && circuitPhases >= 3 && phaseCount(s) == null ? conductorFactor(circuitPhases) : 1;
  const kwPerAmp = (s: EvseSessionInfo): number => (voltageV * phaseFactor(s)) / 1000;

  const weights = perPhase && circuitPhases >= 3 ? phaseWeights : null;
  // A W limit on a three-phase circuit is counted in full on every phase (it
  // bounds the total only), so any one phase may carry all of it.
  const inFull = circuitPhases >= 3 && (station.rateUnit === 'W' || station.heldWattLimit === true);
  const constraints: EvseConstraint[] = perPhase
    ? PHASES.slice(0, Math.max(1, Math.min(3, circuitPhases))).map((p) => ({
        id: `station:${p}`,
        capacity: inFull
          ? (allocation * 1000) / voltageV
          : weights != null
            ? (allocation * 1000 * weights[p]) / voltageV
            : (allocation * 1000) / (voltageV * conductorFactor(circuitPhases)),
      }))
    : [{ id: 'station:kw', capacity: allocation }];
  // The W limit still bounds the total, so the sessions together stay within it.
  if (perPhase && inFull) constraints.push({ id: 'station:kw', capacity: allocation });

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
      const kw = unitContinuousKw(budget);
      if (kw != null) constraints.push({ id: `unit:${unitId}:kw`, capacity: kw });
      continue;
    }
    const amps = unitContinuousA(budget);
    if (amps == null) continue;
    const labels = budget.phases != null && budget.phases >= 3 ? PHASES : (['L1'] as const);
    for (const p of labels) {
      constraints.push({ id: `unit:${unitId}:${p}`, capacity: amps });
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
      s.kind === 'dc'
        ? 1000 / (voltageV * unitPhaseFactor(budget.phases, circuitPhases))
        : worstCase(s);
    return Object.fromEntries(unitPhaseIds(budget, s).map((id) => [id, perLevel]));
  };

  const tariffBound = new Map<string, boolean>();
  const drawBound = new Map<string, boolean>();
  const demands: EvseDemand[] = sessions.map((s, index) => {
    const drawCapKw = measuredDemandCapKw(s, nowMs);
    if (s.kind === 'dc') {
      const rating = s.ratingKw ?? Number.POSITIVE_INFINITY;
      const level = Math.min(rating, allocation);
      drawBound.set(s.sessionId, drawCapKw != null && drawCapKw < level);
      return {
        key: s.sessionId,
        kind: 'dc',
        maxLevel: drawCapKw != null ? Math.min(level, drawCapKw) : level,
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
    // Never below 6 A: the minimum share of an AC session stays its to take.
    const drawCapA = drawCapKw != null ? Math.max(6, drawCapKw / kwPerAmp(s)) : null;
    drawBound.set(s.sessionId, drawCapA != null && drawCapA < maxLevel);
    const weights: Record<string, number> = {
      ...(perPhase
        ? Object.fromEntries(
            sessionPhaseLabels(s, circuitPhases).map((p) => [`station:${p}`, worstCase(s)]),
          )
        : { 'station:kw': kwPerAmp(s) }),
      ...(perPhase && inFull ? { 'station:kw': kwPerAmp(s) } : {}),
      ...unitWeights(s),
    };
    return {
      key: s.sessionId,
      kind: 'ac',
      maxLevel: drawCapA != null ? Math.min(maxLevel, drawCapA) : maxLevel,
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
          ? drawBound.get(s.sessionId) === true
            ? 'measured_draw'
            : tariffBound.get(s.sessionId) === true
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
    const phases = circuitPhases >= 3 ? (phaseCount(s) ?? 3) : 1;
    // phaseToUse only with numberPhases 1 (K01.FR.19).
    const phaseToUse = phases === 1 && s.phaseToUse != null ? s.phaseToUse : null;
    return {
      ...(phaseToUse != null ? { phaseToUse, phaseToUseSinceMs: s.phaseToUseSinceMs ?? null } : {}),
      ...(s.phaseToUseRefused === true ? { phaseToUseRefused: true } : {}),
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
