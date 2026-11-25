// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { conductorFactor } from '@evtivity/lib';
import { evseDefaultMightKw, evseMightKw, type AppliedAllocation } from './load-limit-entries.js';
import {
  acSessionFloorKw,
  effectiveBalancingMode,
  deliveredShare,
  unitBudgetKw,
  unitContinuousA,
  unitContinuousKw,
  unitPhaseFactor,
} from './evse-limits.js';
import type { EvseLimitResult } from './evse-limits.js';
import { evseLimitRateUnit } from './evse-limit-profiles.js';
import type { AppliedEvseLimit, EvseDefaultValue } from './evse-limit-profiles.js';
import type { StationPowerInfo, UnitBudgetInfo } from './load-management-model.js';
import type { StationRate } from './load-management-profiles.js';

/** The defaults and the station-wide cap of one station's unit boxes for a cycle (`unitBoxPlan`). */
export interface UnitBoxPlan {
  /** The TxDefaultProfile of every EVSE of a box with a budget (a station limited per EVSE only). */
  defaults: EvseDefaultValue[];
  /** The most the station limit may be (the smallest box that may pass its budget), kW; null: none. */
  capKw: number | null;
  /**
   * The least any box that may pass its budget delivers to its sessions (held
   * by a cap or by its defaults), kW at 80 percent of its budget on the phases
   * those sessions charge on (`boxDeliveredKw`).
   */
  capBoxKw: number | null;
  /**
   * False when a box that may pass its budget cannot carry the 6 A floors of
   * its own sessions (`boxDeliveredKw`), or the boxes together cannot carry the
   * station's own minimum while every session charges in one: the station stops.
   */
  carriesMinimum: boolean;
  /** A box whose EVSEs together could pass its budget is held by its defaults alone. */
  heldByDefaults: boolean;
}

/** The per-phase A of a TxProfile record of `kw` (an AC box), the single-phase worst case when unknown. */
function evseLimitUnits(limit: AppliedEvseLimit, kw: number, voltageV: number): number {
  if (limit.kind === 'dc') return kw;
  if (limit.limitA != null && limit.limitKw > 0) return (kw * limit.limitA) / limit.limitKw;
  return (kw * 1000) / voltageV;
}

/**
 * What one unit box may carry with the records `entry` holds and this
 * cycle's values (`limits`, `defaults`): over its EVSEs the higher of what
 * the session's TxProfile and the EVSE's TxDefaultProfile might hold, each
 * at most the EVSE rating; a record unknown, refused or never sent counts at
 * the rating. A per phase for an AC box (every EVSE on one phase, the worst
 * case), kW for a DC box.
 */
export function unitBoxLoad(
  station: StationPowerInfo,
  budget: UnitBudgetInfo,
  entry: AppliedAllocation | undefined,
  limits: readonly EvseLimitResult[],
  defaults: readonly EvseDefaultValue[],
  voltageV: number,
): number {
  let load = 0;
  for (const evse of station.unitEvses ?? []) {
    if (evse.unitId !== budget.unitId) continue;
    const rating =
      budget.kind === 'dc' ? (evse.ratingKw ?? Number.POSITIVE_INFINITY) : evse.ratingA;
    const session = (station.sessions ?? []).find((s) => s.evseNumber === evse.evseNumber);
    let tx = 0;
    if (session != null) {
      const stored = entry?.evses?.find((e) => e.transactionId === session.transactionId);
      const might = stored != null ? evseMightKw(stored) : null;
      if (stored == null || might == null) tx = rating;
      else {
        const sent = limits.find((l) => l.transactionId === session.transactionId);
        const sentUnits =
          sent == null ? 0 : budget.kind === 'dc' ? sent.limitKw : (sent.limitA ?? rating);
        tx = Math.max(evseLimitUnits(stored, might, voltageV), sentUnits);
      }
    }
    const held = entry?.evseDefaults?.find((d) => d.evseNumber === evse.evseNumber);
    const heldMight = held != null ? evseDefaultMightKw(held) : null;
    const value = defaults.find((d) => d.evseNumber === evse.evseNumber);
    const toUnits = (kw: number): number => (budget.kind === 'dc' ? kw : (kw * 1000) / voltageV);
    const def =
      heldMight == null
        ? rating
        : Math.max(toUnits(heldMight), value != null ? toUnits(value.limitKw) : 0);
    load += Math.min(rating, Math.max(tx, def));
  }
  return load;
}

/**
 * The unit box defaults and cap of one station (I2, second round decision b).
 * A station limited per EVSE gets a TxDefaultProfile on every EVSE of a box
 * with a budget, at 80 percent of the budget: an EVSE with a session its
 * session's EVSE limit, the free EVSEs an even share of what the sessions
 * leave. Any station is sent at most a box budget as its station limit while
 * that box may carry more than its budget (`unitBoxLoad`): the cycle the
 * defaults first go out, while one is not accepted or was refused, a station
 * limited as a whole, and one that refused per-EVSE limits.
 */
export function unitBoxPlan(
  station: StationPowerInfo,
  entry: AppliedAllocation | undefined,
  limits: readonly EvseLimitResult[],
  rate: StationRate | undefined,
  options: { sendDefaults: boolean },
): UnitBoxPlan {
  const voltageV = rate?.voltageV ?? station.circuitVoltageV ?? 230;
  const perEvse = options.sendDefaults && effectiveBalancingMode(station) === 'evse';
  const defaults: EvseDefaultValue[] = [];
  let capKw: number | null = null;
  let capBoxKw: number | null = null;
  let carriesMinimum = true;
  let boxedKw = 0;
  const boxedEvses = new Set<number>();
  let heldByDefaults = false;
  for (const budget of station.unitBudgets ?? []) {
    const budgetUnits = budget.kind === 'dc' ? unitContinuousKw(budget) : unitContinuousA(budget);
    if (budgetUnits == null) continue;
    const evses = (station.unitEvses ?? []).filter((e) => e.unitId === budget.unitId);
    if (evses.length === 0) continue;
    const boxDefaults: EvseDefaultValue[] = [];
    if (perEvse) {
      const busy = new Map<number, number>();
      for (const evse of evses) {
        const session = (station.sessions ?? []).find((s) => s.evseNumber === evse.evseNumber);
        if (session == null) continue;
        const limit = limits.find((l) => l.transactionId === session.transactionId);
        const rating = budget.kind === 'dc' ? (evse.ratingKw ?? budgetUnits) : evse.ratingA;
        const value =
          limit == null
            ? Math.min(rating, budgetUnits)
            : budget.kind === 'dc'
              ? limit.limitKw
              : (limit.limitA ?? Math.min(rating, budgetUnits));
        busy.set(evse.evseNumber, value);
      }
      const free = evses.length - busy.size;
      const left = budgetUnits - [...busy.values()].reduce((sum, v) => sum + v, 0);
      const share = free > 0 ? Math.max(0, left / free) : 0;
      for (const evse of evses) {
        const units = busy.get(evse.evseNumber) ?? share;
        boxDefaults.push(
          budget.kind === 'dc'
            ? {
                evseNumber: evse.evseNumber,
                unitId: budget.unitId,
                kind: 'dc',
                limitA: null,
                limitKw: units,
                rateUnit: 'W',
              }
            : {
                evseNumber: evse.evseNumber,
                unitId: budget.unitId,
                kind: 'ac',
                limitA: units,
                limitKw: (units * voltageV) / 1000,
                rateUnit: evseLimitRateUnit(station, 'ac'),
              },
        );
      }
      defaults.push(...boxDefaults);
    }
    const ratings = evses.reduce(
      (sum, e) =>
        sum + (budget.kind === 'dc' ? (e.ratingKw ?? Number.POSITIVE_INFINITY) : e.ratingA),
      0,
    );
    if (ratings <= budgetUnits + 1e-9) continue;
    const boxKw = boxDeliveredKw(
      budget,
      station,
      evses,
      voltageV,
      rate?.phases ?? station.circuitPhases ?? 1,
    );
    if (boxKw != null && (capBoxKw == null || boxKw < capBoxKw)) capBoxKw = boxKw;
    if (boxKw != null) {
      const numbers = new Set(evses.map((e) => e.evseNumber));
      const boxSessions = (station.sessions ?? []).filter((s) => numbers.has(s.evseNumber));
      // A station limited per EVSE pauses single sessions of the box at 0 A, so
      // the box needs only its largest session's floor; one limited as a whole all.
      const floors = boxSessions.map((s) => acSessionFloorKw({ ...station, sessions: [s] }, true));
      const needKw =
        effectiveBalancingMode(station) === 'evse'
          ? Math.max(0, ...floors)
          : acSessionFloorKw({ ...station, sessions: boxSessions }, true);
      if (boxKw < needKw - 1e-6) carriesMinimum = false;
      boxedKw += boxKw;
      for (const n of numbers) boxedEvses.add(n);
    }
    if (unitBoxLoad(station, budget, entry, limits, boxDefaults, voltageV) <= budgetUnits + 1e-9) {
      heldByDefaults = true;
      continue;
    }
    const kw = unitBoxKw(budget, station, rate);
    if (kw != null && (capKw == null || kw < capKw)) capKw = kw;
  }
  // The own minimum is the station's: only boxes holding every session bound it.
  const sessions = station.sessions ?? [];
  const own = Math.max(0, station.minPowerKw);
  const ownKw = station.maxPowerKw > 0 ? Math.min(own, station.maxPowerKw) : own;
  if (
    sessions.length > 0 &&
    sessions.every((s) => boxedEvses.has(s.evseNumber)) &&
    boxedKw < ownKw - 1e-6
  ) {
    carriesMinimum = false;
  }
  return {
    defaults,
    capKw,
    capBoxKw,
    carriesMinimum,
    heldByDefaults: heldByDefaults && capKw == null,
  };
}

/**
 * What a unit box delivers to the sessions on it, kW at 80 percent of its
 * budget: a three-phase box gives each phase its budget, so its sessions get
 * it only on the phases they charge on (two single-phase cars on L1 share one
 * phase's budget), each session at its smallest share of a phase it charges
 * on; with the wiring unknown, sessions overlap from L1. A box without a session
 * counts on all its phases.
 */
function boxDeliveredKw(
  budget: UnitBudgetInfo,
  station: StationPowerInfo,
  evses: ReadonlyArray<{ evseNumber: number }>,
  voltageV: number,
  circuitPhases: number,
): number | null {
  const kw = unitBudgetKw(budget, voltageV, circuitPhases);
  if (kw == null || budget.kind === 'dc' || unitPhaseFactor(budget.phases, circuitPhases) !== 3) {
    return kw;
  }
  const numbers = new Set(evses.map((e) => e.evseNumber));
  const sessions = (station.sessions ?? []).filter((s) => numbers.has(s.evseNumber));
  if (sessions.length === 0) return kw;
  return kw * deliveredShare(sessions, circuitPhases);
}

/**
 * One unit box in the station's limit terms, kW at 80 percent of its budget.
 * An A limit bounds every phase current, so the box budget is the station's A
 * limit, in kW at the station's phases (a single-phase box on a three-phase
 * station too); a W limit bounds the total only, so an AC box takes its
 * single-phase worst case (budget x circuit voltage).
 */
export function unitBoxKw(
  budget: UnitBudgetInfo,
  station: StationPowerInfo,
  rate: StationRate | undefined,
): number | null {
  const voltageV = rate?.voltageV ?? station.circuitVoltageV;
  const phases = rate?.phases ?? station.circuitPhases ?? 1;
  if (budget.kind === 'dc') return unitBudgetKw(budget, voltageV, phases);
  const amps = unitContinuousA(budget);
  if (amps == null || voltageV == null || !(voltageV > 0)) return null;
  if ((rate?.rateUnit ?? station.rateUnit) === 'W') return (amps * voltageV) / 1000;
  return (amps * voltageV * conductorFactor(phases)) / 1000;
}
