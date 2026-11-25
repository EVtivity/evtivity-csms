// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The independent station model of the load management property test: what a
// charging station holds (its charging profiles, composed by the OCPP stacking
// rules) and the most its cars can draw under them, per panel phase. Nothing
// here reads a CSMS record or a service function: the checks compare the CSMS
// against this model.

export type Phase = 'L1' | 'L2' | 'L3';
export const PHASES: readonly Phase[] = ['L1', 'L2', 'L3'];
export type PhaseKw = Record<Phase, number>;

export const PHASE_VOLTAGE_V = 230;

export interface ModelProfile {
  id: number;
  purpose: string;
  stackLevel: number;
  /** 0: the whole station. */
  evseId: number;
  transactionId?: string;
  unit: 'A' | 'W';
  limit: number;
  validToMs?: number;
}

export interface ModelEvse {
  number: number;
  kind: 'ac' | 'dc';
  /** AC: the most current per phase; DC: the power. */
  ratingA: number;
  ratingKw: number;
  /** The rating the CSMS has for the EVSE's connector; null: unrated. */
  reportedKw: number | null;
  unitId: string | null;
  /** The panel phase each EVSE phase is wired to (index 0 is EVSE phase 1). */
  wiring: readonly Phase[];
}

export interface ModelCar {
  sessionId: string;
  transactionId: string;
  startedAtMs: number;
  phases: 1 | 3;
  maxA: number;
  /** The EVSE phase (1 to 3) a single-phase car charges on. */
  evsePhase: 1 | 2 | 3;
  /** A phase the car was sent and moves to at `atMs`; null: it stays. */
  switchTo: { phase: 1 | 2 | 3; atMs: number } | null;
  /** The car does not follow a phase choice. */
  refusesSwitch: boolean;
}

export interface ModelUnit {
  id: string;
  /** The box fuse, A per phase. */
  budgetA: number;
  phases: 1 | 3;
}

export interface ModelStation {
  id: string;
  ocppId: string;
  protocol: 'ocpp1.6' | 'ocpp2.0.1' | 'ocpp2.1';
  reportedUnits: Array<'A' | 'W'>;
  maxStackLevel: number | null;
  circuit: 'three' | 'single';
  /** A single-phase charger on the three-phase circuit (2.x reports it). */
  singlePhaseCharger: boolean;
  /** The CSMS knows the wiring (circuit rotation or reported PhaseRotation). */
  wiringKnown: boolean;
  phaseSwitching: boolean;
  balancing: 'station' | 'evse';
  loadPriority: number;
  evses: ModelEvse[];
  units: ModelUnit[];
  profiles: ModelProfile[];
  cars: Map<number, ModelCar>;
  online: boolean;
  /** Raised on every disconnect: a CALL sent on an earlier connection never runs. */
  connection: number;
  /** The station's `load_min_power_kw` (0: none). */
  minPowerKw: number;
}

/** The OCPP composite: the highest stack level of a purpose that is valid now. */
function top(profiles: readonly ModelProfile[], nowMs: number): ModelProfile | null {
  let best: ModelProfile | null = null;
  for (const p of profiles) {
    if (p.validToMs != null && p.validToMs <= nowMs) continue;
    if (best == null || p.stackLevel > best.stackLevel) best = p;
  }
  return best;
}

/** The station limit in force (ChargingStationMaxProfile, highest stack level). */
export function stationLimit(station: ModelStation, nowMs: number): ModelProfile | null {
  return top(
    station.profiles.filter((p) => p.purpose === 'ChargingStationMaxProfile' && p.evseId === 0),
    nowMs,
  );
}

/** Local generation the station may draw on top of every limit (K27). */
function localGenerationKw(station: ModelStation, nowMs: number): number {
  const p = top(
    station.profiles.filter((x) => x.purpose === 'LocalGeneration'),
    nowMs,
  );
  if (p == null) return 0;
  return p.unit === 'W' ? p.limit / 1000 : (p.limit * PHASE_VOLTAGE_V * 3) / 1000;
}

/** The panel phases an EVSE's car draws on. */
export function carPanelPhases(station: ModelStation, evse: ModelEvse, car: ModelCar): Phase[] {
  if (station.circuit === 'single') return ['L2'];
  if (evse.kind === 'dc') return [...PHASES];
  if (station.singlePhaseCharger) return [evse.wiring[0] ?? 'L1'];
  if (car.phases === 3) return [...evse.wiring];
  return [evse.wiring[car.evsePhase - 1] ?? 'L1'];
}

/** The transaction level limit of an EVSE (PriorityCharging, TxProfile, TxDefaultProfile). */
function txLimit(
  station: ModelStation,
  evse: ModelEvse,
  car: ModelCar,
  nowMs: number,
): ModelProfile | null {
  const forEvse = (p: ModelProfile): boolean => p.evseId === 0 || p.evseId === evse.number;
  const priority = top(
    station.profiles.filter(
      (p) =>
        p.purpose === 'PriorityCharging' && p.transactionId === car.transactionId && forEvse(p),
    ),
    nowMs,
  );
  if (priority != null) return priority;
  const tx = top(
    station.profiles.filter(
      (p) => p.purpose === 'TxProfile' && p.transactionId === car.transactionId,
    ),
    nowMs,
  );
  if (tx != null) return tx;
  const own = top(
    station.profiles.filter((p) => p.purpose === 'TxDefaultProfile' && p.evseId === evse.number),
    nowMs,
  );
  return (
    own ??
    top(
      station.profiles.filter((p) => p.purpose === 'TxDefaultProfile' && p.evseId === 0),
      nowMs,
    )
  );
}

/** The most current per phase an EVSE's car can draw under its EVSE limits, A. */
export function evseCapA(
  station: ModelStation,
  evse: ModelEvse,
  car: ModelCar,
  nowMs: number,
): number {
  const phases = carPanelPhases(station, evse, car);
  const ratingA =
    evse.kind === 'dc'
      ? (evse.ratingKw * 1000) / (PHASE_VOLTAGE_V * 3)
      : Math.min(evse.ratingA, car.maxA);
  const tx = txLimit(station, evse, car, nowMs);
  if (tx == null) return ratingA;
  const txA = tx.unit === 'A' ? tx.limit : tx.limit / (PHASE_VOLTAGE_V * phases.length);
  return Math.max(0, Math.min(ratingA, txA));
}

interface Draw {
  phases: Phase[];
  capA: number;
  unitId: string | null;
}

function draws(station: ModelStation, nowMs: number): Draw[] {
  const result: Draw[] = [];
  if (!station.online && station.cars.size === 0) return result;
  for (const evse of station.evses) {
    const car = station.cars.get(evse.number);
    if (car == null) continue;
    result.push({
      phases: carPanelPhases(station, evse, car),
      capA: evseCapA(station, evse, car, nowMs),
      unitId: evse.unitId,
    });
  }
  return result;
}

/**
 * The most the station's cars can draw on panel phase `phase` together, kW,
 * however the station shares its limit among them.
 */
export function maxPhaseKw(station: ModelStation, phase: Phase, nowMs: number): number {
  const list = draws(station, nowMs).filter((d) => d.phases.includes(phase));
  const limit = stationLimit(station, nowMs);
  const extra = localGenerationKw(station, nowMs);
  const open = list.reduce((sum, d) => sum + d.capA, 0);
  if (limit == null) return (open * PHASE_VOLTAGE_V) / 1000 + extra;
  if (limit.unit === 'A') return (Math.min(open, limit.limit) * PHASE_VOLTAGE_V) / 1000 + extra;
  // A W limit bounds the total: a car on fewer phases puts more of it on this one.
  let budgetA = limit.limit / PHASE_VOLTAGE_V;
  let taken = 0;
  for (const d of [...list].sort((a, b) => a.phases.length - b.phases.length)) {
    const x = Math.max(0, Math.min(d.capA, budgetA / d.phases.length));
    budgetA -= x * d.phases.length;
    taken += x;
  }
  return (taken * PHASE_VOLTAGE_V) / 1000 + extra;
}

/** The most the station's cars can draw in all, kW. */
export function maxTotalKw(station: ModelStation, nowMs: number): number {
  const list = draws(station, nowMs);
  const limit = stationLimit(station, nowMs);
  const extra = localGenerationKw(station, nowMs);
  const open = list.reduce((sum, d) => sum + d.capA * d.phases.length, 0);
  if (limit == null) return (open * PHASE_VOLTAGE_V) / 1000 + extra;
  if (limit.unit === 'W')
    return Math.min((open * PHASE_VOLTAGE_V) / 1000, limit.limit / 1000) + extra;
  let totalA = 0;
  for (const phase of PHASES) {
    const onPhase = list.filter((d) => d.phases.includes(phase)).reduce((s, d) => s + d.capA, 0);
    totalA += Math.min(onPhase, limit.limit);
  }
  return (totalA * PHASE_VOLTAGE_V) / 1000 + extra;
}

/** The most current a unit box carries on `phase`, A. */
export function maxUnitPhaseA(
  station: ModelStation,
  unitId: string,
  phase: Phase,
  nowMs: number,
): number {
  const onUnit = draws(station, nowMs).filter(
    (d) => d.unitId === unitId && d.phases.includes(phase),
  );
  const sum = onUnit.reduce((s, d) => s + d.capA, 0);
  const limit = stationLimit(station, nowMs);
  if (limit == null) return sum;
  if (limit.unit === 'A') return Math.min(sum, limit.limit);
  let budgetA = limit.limit / PHASE_VOLTAGE_V;
  let taken = 0;
  for (const d of [...onUnit].sort((a, b) => a.phases.length - b.phases.length)) {
    const x = Math.max(0, Math.min(d.capA, budgetA / d.phases.length));
    budgetA -= x * d.phases.length;
    taken += x;
  }
  return taken;
}

/** What the station enforces as its limit, kW in the CSMS terms (null: none). */
export function enforcedStationKw(station: ModelStation, nowMs: number): number | null {
  const limit = stationLimit(station, nowMs);
  if (limit == null) return null;
  const phases = station.circuit === 'single' || station.singlePhaseCharger ? 1 : 3;
  const kw =
    limit.unit === 'W' ? limit.limit / 1000 : (limit.limit * PHASE_VOLTAGE_V * phases) / 1000;
  return kw + localGenerationKw(station, nowMs);
}

/** Applies an accepted SetChargingProfile: the same id, or the same slot, is replaced. */
export function applyProfile(station: ModelStation, profile: ModelProfile): void {
  station.profiles = station.profiles.filter(
    (p) =>
      p.id !== profile.id &&
      !(
        p.purpose === profile.purpose &&
        p.stackLevel === profile.stackLevel &&
        p.evseId === profile.evseId &&
        p.transactionId === profile.transactionId
      ),
  );
  station.profiles.push(profile);
}

/** Applies an accepted ClearChargingProfile; true when it removed a profile. */
export function applyClear(
  station: ModelStation,
  criteria: {
    id: number | null;
    purpose: string | null;
    stackLevel: number | null;
    evseId: number | null;
  },
): boolean {
  const before = station.profiles.length;
  station.profiles = station.profiles.filter((p) => {
    // A station keeps local generation on any clear (K10.FR.06).
    if (p.purpose === 'LocalGeneration') return true;
    if (criteria.id != null) return p.id !== criteria.id;
    const match =
      (criteria.purpose == null || criteria.purpose === p.purpose) &&
      (criteria.stackLevel == null || criteria.stackLevel === p.stackLevel) &&
      (criteria.evseId == null || criteria.evseId === p.evseId);
    return !match;
  });
  return station.profiles.length !== before;
}

/** A copy of a station whose profiles and cars a check may change. */
export function cloneStation(station: ModelStation): ModelStation {
  return {
    ...station,
    profiles: station.profiles.map((p) => ({ ...p })),
    cars: new Map([...station.cars].map(([n, c]) => [n, { ...c }])),
  };
}

/**
 * Car fills of the worst case: a new car (no TxProfile, 32 A) on every EVSE,
 * three-phase, or single-phase on the EVSE phase wired to one grid phase.
 * A car that is there may leave and another start before the next cycle, so
 * every EVSE counts a new car.
 */
export const WORST_FILLS: ReadonlyArray<{ phases: 1 | 3; grid: Phase | null }> = [
  { phases: 3, grid: null },
  { phases: 1, grid: 'L1' },
  { phases: 1, grid: 'L2' },
  { phases: 1, grid: 'L3' },
];

export function withNewCars(
  station: ModelStation,
  fill: { phases: 1 | 3; grid: Phase | null },
  startedAtMs: number,
): ModelStation {
  const copy = cloneStation(station);
  copy.online = true;
  for (const evse of copy.evses) {
    const onGrid = fill.grid == null ? 0 : Math.max(0, evse.wiring.indexOf(fill.grid));
    copy.cars.set(evse.number, {
      sessionId: `worst-${station.id}-${String(evse.number)}`,
      transactionId: `worst-${station.id}-${String(evse.number)}`,
      startedAtMs,
      phases: evse.kind === 'dc' ? 3 : fill.phases,
      maxA: 32,
      evsePhase: (onGrid + 1) as 1 | 2 | 3,
      switchTo: null,
      refusesSwitch: true,
    });
  }
  return copy;
}

/**
 * What each car draws now, the station sharing its limit evenly (one level of
 * current for every car, capped by each car): per EVSE number, A per phase and kW.
 */
export function actualDraws(
  station: ModelStation,
  nowMs: number,
): Map<number, { a: number; kw: number; phases: Phase[] }> {
  const items: Array<{ evse: number; phases: Phase[]; capA: number }> = [];
  for (const evse of station.evses) {
    const car = station.cars.get(evse.number);
    if (car == null) continue;
    items.push({
      evse: evse.number,
      phases: carPanelPhases(station, evse, car),
      capA: evseCapA(station, evse, car, nowMs),
    });
  }
  const limit = stationLimit(station, nowMs);
  const at = (level: number): number[] => items.map((i) => Math.min(i.capA, level));
  const fits = (level: number): boolean => {
    if (limit == null) return true;
    const x = at(level);
    if (limit.unit === 'W') {
      const used = items.reduce((s, i, k) => s + (x[k] ?? 0) * i.phases.length, 0);
      return used * PHASE_VOLTAGE_V <= limit.limit + 1e-9;
    }
    return PHASES.every(
      (p) =>
        items.reduce((s, i, k) => s + (i.phases.includes(p) ? (x[k] ?? 0) : 0), 0) <=
        limit.limit + 1e-9,
    );
  };
  let lo = 0;
  let hi = Math.max(0, ...items.map((i) => i.capA));
  if (!fits(hi)) {
    for (let step = 0; step < 50; step += 1) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    hi = lo;
  }
  const levels = at(hi);
  const result = new Map<number, { a: number; kw: number; phases: Phase[] }>();
  items.forEach((i, k) => {
    const a = levels[k] ?? 0;
    result.set(i.evse, { a, kw: (a * PHASE_VOLTAGE_V * i.phases.length) / 1000, phases: i.phases });
  });
  return result;
}
