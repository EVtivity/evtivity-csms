// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Departure-aware depot charging planner: pure, no database. The worker builds a
// PlanInput from the site tree, the rates and the planned departures, and stores
// the result. Departures may come from operators, schedules, imports or an
// external depot management system: all of them reduce to a needed energy in kWh.

export const PLAN_SLOT_MINUTES = 15;
export const PLAN_HORIZON_HOURS = 48;
export const BUFFER_PENALTY_PER_KWH = 1_000_000;
const SLOT_MS = PLAN_SLOT_MINUTES * 60_000;
const HOUR_MS = 3_600_000;

export interface PlanSlot {
  startMs: number;
  endMs: number;
  hours: number;
}

/** Slots from now to the latest departure, at most 48 hours; the first ends at the next quarter hour. */
export function buildPlanSlots(nowMs: number, lastDepartureMs: number): PlanSlot[] {
  const endMs = Math.min(lastDepartureMs, nowMs + PLAN_HORIZON_HOURS * HOUR_MS);
  const slots: PlanSlot[] = [];
  let start = nowMs;
  while (start < endMs) {
    const end = Math.min(endMs, (Math.floor(start / SLOT_MS) + 1) * SLOT_MS);
    slots.push({ startMs: start, endMs: end, hours: (end - start) / HOUR_MS });
    start = end;
  }
  return slots;
}

export interface PlanNodeUse {
  nodeId: string;
  /** kW counted on this node per kW the vehicle draws (phase share, leg weight). */
  weight: number;
}

export interface PlanVehicleInput {
  departureId: string;
  departureMs: number;
  /** 1 lowest to 10 highest. */
  priority: number;
  neededKwh: number;
  maxKw: number;
  /** Lowest power the charger can hold without pausing; 0 when any power works. */
  minKw: number;
  /**
   * When the vehicle can start drawing power. `nowMs` (or earlier) means plugged in.
   * A later time is an expected arrival; with no arrival known, pass `departureMs`
   * so the vehicle gets no power but still receives a readiness.
   */
  availableFromMs: number;
  path: PlanNodeUse[];
  /**
   * Energy to charge on top of `neededKwh` (up to a maximum target) from
   * headroom no departure needs, outside the buffer. It never counts for
   * readiness and never takes power from another vehicle's need.
   */
  extraKwh?: number;
  /**
   * Charge as soon as possible from arrival (an ad hoc request): earliest slots
   * first, ahead of timed vehicles of the same priority, no buffer. The caller
   * passes the horizon end as `departureMs`.
   */
  adHoc?: boolean;
  /**
   * Fixed load the vehicle draws besides charging (preconditioning), kW per
   * slot, counted on its path nodes before anything is planned.
   */
  auxKw?: number[];
}

export interface PlanInput {
  nowMs: number;
  bufferMinutes: number;
  slots: PlanSlot[];
  pricePerKwh: number[];
  /** Headroom per node and slot after fixed loads, in kW. A missing node has no headroom. */
  nodeCapacityKw: Record<string, number[]>;
  /** The node whose planned load is smoothed (the site root). */
  rootNodeId: string;
  vehicles: PlanVehicleInput[];
}

/** What the plan alone decides. */
export type PlanEntryState = 'ready' | 'on_track' | 'at_risk' | 'cannot_meet';

/** What is stored on the departure (`vehicle_departures.readiness`). */
export type DepartureReadiness = PlanEntryState | 'waiting_for_vehicle';

export type DepartureReadinessReason =
  | 'site_capacity'
  | 'not_plugged_in'
  | 'late_arrival'
  | 'charger_not_following'
  | 'profile_rejected'
  | 'station_offline'
  | 'vehicle_power'
  | 'unknown_soc';

export interface PlanEntry {
  departureId: string;
  /** kW per slot, drawn over the part of the slot inside the vehicle's window. */
  powerKw: number[];
  plannedKwh: number;
  shortfallKwh: number;
  /** When the planned energy reaches the need; null while there is a shortfall. */
  predictedReadyMs: number | null;
  /** Energy planned on top of the need (the top-up to a maximum target). */
  extraPlannedKwh: number;
  /** When the planned energy reaches the need plus the extra; null when it does not. */
  predictedMaxReadyMs: number | null;
  /** Null for a departed entry. */
  state: PlanEntryState | null;
  /**
   * The departure time is at or before now. Nothing is planned and readiness is
   * null, so no notice fires; the departure close job completes it.
   */
  departed: boolean;
  /**
   * The departure is after the last slot. The plan covers the horizon only, so
   * `shortfallKwh` is what the horizon leaves; cannot meet is decided from the
   * vehicle's own power over the whole time to departure, else it stays on track.
   */
  beyondHorizon: boolean;
  /** Energy the vehicle could take with the whole path to itself, from its window start to departure. */
  aloneKwh: number;
  /** False when `availableFromMs` is after now. */
  pluggedIn: boolean;
  /** Energy the vehicle could take alone if plugged in now, until departure minus the buffer. */
  pluggedNowKwh: number;
  /** Null for a departed entry: the service keeps the stored readiness. */
  readiness: DepartureReadiness | null;
  readinessReason: DepartureReadinessReason | null;
}

export interface PlanResult {
  entries: PlanEntry[];
  nodeLoadKw: Record<string, number[]>;
  costPerKwhWeighted: number;
}

const EPS = 1e-9;
const KWH_EPS = 1e-6;
const READY_TOLERANCE_MS = 1000;
const REPAIR_PASSES = 3;
const MAX_REPAIR_RESTARTS = 4;
const FILL_ITERATIONS = 50;

interface PathUse {
  load: Float64Array;
  cap: Float64Array;
  weight: number;
}

interface VehicleState {
  v: PlanVehicleInput;
  need: number;
  hours: Float64Array;
  windowSlots: number[];
  groups: number[][];
  byCost: number[];
  power: Float64Array;
  inBuffer: Uint8Array;
  path: PathUse[];
  loads: Set<Float64Array>;
  departed: boolean;
  beyondHorizon: boolean;
}

interface Planner {
  input: PlanInput;
  n: number;
  loads: Map<string, Float64Array>;
  caps: Map<string, Float64Array>;
  root: Float64Array;
  price: Float64Array;
}

type FillMode = 'cost' | 'earliest';

function at(values: Float64Array, index: number): number {
  return values[index] ?? 0;
}

function overlapHours(slot: PlanSlot, fromMs: number, toMs: number): number {
  const from = Math.max(slot.startMs, fromMs);
  const to = Math.min(slot.endMs, toMs);
  return to > from ? (to - from) / HOUR_MS : 0;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

function nodeArrays(planner: Planner, nodeId: string): { load: Float64Array; cap: Float64Array } {
  let load = planner.loads.get(nodeId);
  if (load == null) {
    load = new Float64Array(planner.n);
    planner.loads.set(nodeId, load);
  }
  let cap = planner.caps.get(nodeId);
  if (cap == null) {
    cap = new Float64Array(planner.n);
    planner.caps.set(nodeId, cap);
  }
  return { load, cap };
}

function createPlanner(input: PlanInput): Planner {
  const n = input.slots.length;
  const price = new Float64Array(n);
  for (let s = 0; s < n; s += 1) price[s] = finiteOr(input.pricePerKwh[s], 0);
  const planner: Planner = {
    input,
    n,
    loads: new Map(),
    caps: new Map(),
    root: new Float64Array(n),
    price,
  };
  for (const [nodeId, values] of Object.entries(input.nodeCapacityKw)) {
    const cap = new Float64Array(n);
    for (let s = 0; s < n; s += 1) cap[s] = Math.max(0, finiteOr(values[s], 0));
    planner.caps.set(nodeId, cap);
    planner.loads.set(nodeId, new Float64Array(n));
  }
  planner.root = nodeArrays(planner, input.rootNodeId).load;
  return planner;
}

function bufferMs(input: PlanInput): number {
  return Math.max(0, finiteOr(input.bufferMinutes, 0)) * 60_000;
}

/** Bad numbers never reach the planner: they plan nothing rather than NaN power. */
function sanitizeVehicle(input: PlanInput, v: PlanVehicleInput): PlanVehicleInput {
  const departureMs = finiteOr(v.departureMs, input.nowMs);
  return {
    departureId: v.departureId,
    departureMs,
    priority: finiteOr(v.priority, 1),
    neededKwh: Math.max(0, finiteOr(v.neededKwh, 0)),
    maxKw: Math.max(0, finiteOr(v.maxKw, 0)),
    minKw: Math.max(0, finiteOr(v.minKw, 0)),
    availableFromMs: finiteOr(v.availableFromMs, departureMs),
    path: v.path,
    extraKwh: Math.max(0, finiteOr(v.extraKwh, 0)),
    adHoc: v.adHoc === true,
    auxKw: (v.auxKw ?? []).map((kw) => Math.max(0, finiteOr(kw, 0))),
  };
}

/** No buffer for an ad hoc vehicle: it has no departure to finish before. */
function vehicleBufferMs(input: PlanInput, v: PlanVehicleInput): number {
  return v.adHoc === true ? 0 : bufferMs(input);
}

/** One entry per node, weights of a node listed twice summed; unusable weights dropped. */
function mergedPath(planner: Planner, path: PlanNodeUse[]): PathUse[] {
  const weights = new Map<string, number>();
  for (const use of path) {
    if (!(use.weight > 0) || !Number.isFinite(use.weight)) continue;
    weights.set(use.nodeId, (weights.get(use.nodeId) ?? 0) + use.weight);
  }
  return [...weights].map(([nodeId, weight]) => ({ ...nodeArrays(planner, nodeId), weight }));
}

function createVehicleState(planner: Planner, raw: PlanVehicleInput): VehicleState {
  const { input, n } = planner;
  const v = sanitizeVehicle(input, raw);
  const fromMs = Math.max(input.nowMs, v.availableFromMs);
  const bufferStartMs = v.departureMs - vehicleBufferMs(input, v);
  const hours = new Float64Array(n);
  const cost = new Float64Array(n);
  const inBuffer = new Uint8Array(n);
  const windowSlots: number[] = [];
  input.slots.forEach((slot, s) => {
    const h = overlapHours(slot, fromMs, v.departureMs);
    if (h <= 0) return;
    hours[s] = h;
    windowSlots.push(s);
    // A slot that reaches into the buffer counts as a buffer slot, so energy
    // planned outside the buffer is always ready before it starts.
    const windowEnd = Math.min(slot.endMs, v.departureMs);
    if (windowEnd > bufferStartMs) inBuffer[s] = 1;
    cost[s] = at(planner.price, s) + (inBuffer[s] === 1 ? BUFFER_PENALTY_PER_KWH : 0);
  });
  const lastSlot = input.slots[input.slots.length - 1];
  const horizonEndMs = lastSlot?.endMs ?? input.nowMs;
  const byCost = [...windowSlots].sort((a, b) => at(cost, a) - at(cost, b) || a - b);
  const groups: number[][] = [];
  let groupCost = Number.NaN;
  for (const s of byCost) {
    const last = groups[groups.length - 1];
    if (last != null && at(cost, s) === groupCost) last.push(s);
    else {
      groups.push([s]);
      groupCost = at(cost, s);
    }
  }
  const path = mergedPath(planner, v.path);
  return {
    v,
    need: v.neededKwh,
    hours,
    windowSlots,
    groups,
    byCost,
    power: new Float64Array(n),
    inBuffer,
    path,
    loads: new Set(path.map((use) => use.load)),
    departed: v.departureMs <= input.nowMs,
    beyondHorizon: v.departureMs > horizonEndMs,
  };
}

function headroomKw(st: VehicleState, s: number): number {
  // No usable node means the planner cannot see the vehicle's limits: plan nothing.
  if (st.path.length === 0) return 0;
  let room = st.v.maxKw - at(st.power, s);
  for (const use of st.path) {
    const r = (at(use.cap, s) - at(use.load, s)) / use.weight;
    if (r < room) room = r;
  }
  return room > 0 ? room : 0;
}

function addPower(st: VehicleState, s: number, kw: number): void {
  st.power[s] = at(st.power, s) + kw;
  for (const use of st.path) use.load[s] = at(use.load, s) + kw * use.weight;
}

function clearPower(st: VehicleState, s: number): void {
  const kw = at(st.power, s);
  for (const use of st.path) use.load[s] = at(use.load, s) - kw * use.weight;
  st.power[s] = 0;
}

function plannedEnergy(st: VehicleState): number {
  let sum = 0;
  for (const s of st.windowSlots) sum += at(st.power, s) * at(st.hours, s);
  return sum;
}

/** Fills `energyKwh` into `slots`, least loaded root slots first, up to each slot's headroom. */
function fillSlots(planner: Planner, st: VehicleState, slots: number[], energyKwh: number): number {
  const m = slots.length;
  const caps = new Float64Array(m);
  const hours = new Float64Array(m);
  const base = new Float64Array(m);
  let maxEnergy = 0;
  let lo = Infinity;
  let hi = 0;
  slots.forEach((s, i) => {
    caps[i] = headroomKw(st, s);
    hours[i] = at(st.hours, s);
    base[i] = at(planner.root, s);
    maxEnergy += at(caps, i) * at(hours, i);
    lo = Math.min(lo, at(base, i));
    hi = Math.max(hi, at(base, i) + at(caps, i));
  });
  if (maxEnergy <= energyKwh) {
    slots.forEach((s, i) => {
      if (at(caps, i) > EPS) addPower(st, s, at(caps, i));
    });
    return maxEnergy;
  }
  const energyAt = (level: number): number => {
    let energy = 0;
    for (let i = 0; i < m; i += 1) {
      const a = level - at(base, i);
      if (a > 0) energy += Math.min(a, at(caps, i)) * at(hours, i);
    }
    return energy;
  };
  for (let it = 0; it < FILL_ITERATIONS; it += 1) {
    const mid = (lo + hi) / 2;
    if (energyAt(mid) < energyKwh) lo = mid;
    else hi = mid;
  }
  const energy = energyAt(hi);
  const scale = energy > energyKwh ? energyKwh / energy : 1;
  slots.forEach((s, i) => {
    const kw = Math.min(Math.max(0, hi - at(base, i)), at(caps, i)) * scale;
    if (kw > EPS) addPower(st, s, kw);
  });
  return energy * scale;
}

function fillEnergy(
  planner: Planner,
  st: VehicleState,
  mode: FillMode,
  excluded: Uint8Array | null,
  energyKwh: number,
): void {
  let left = energyKwh;
  if (mode === 'cost') {
    for (const group of st.groups) {
      if (left <= KWH_EPS) return;
      const slots = excluded == null ? group : group.filter((s) => excluded[s] === 0);
      if (slots.length > 0) left -= fillSlots(planner, st, slots, left);
    }
    return;
  }
  for (const s of st.windowSlots) {
    if (left <= KWH_EPS) return;
    if (excluded?.[s] === 1) continue;
    const kw = Math.min(headroomKw(st, s), left / at(st.hours, s));
    if (kw > EPS) {
      addPower(st, s, kw);
      left -= kw * at(st.hours, s);
    }
  }
}

/** Drops slots below the charger minimum, smallest first, and refills their energy elsewhere. */
function enforceMinPower(planner: Planner, st: VehicleState, mode: FillMode): void {
  const minKw = st.v.minKw;
  if (!(minKw > EPS)) return;
  const excluded = new Uint8Array(planner.n);
  for (;;) {
    let worst = -1;
    let worstKw = 0;
    for (const s of st.windowSlots) {
      const p = at(st.power, s);
      if (p <= EPS || p >= minKw - EPS) continue;
      // Ties drop the later slot, so the energy stays early.
      if (worst < 0 || p < worstKw - EPS || p <= worstKw + EPS) {
        worst = s;
        worstKw = p;
      }
    }
    if (worst < 0) return;
    const energy = worstKw * at(st.hours, worst);
    clearPower(st, worst);
    excluded[worst] = 1;
    fillEnergy(planner, st, mode, excluded, energy);
  }
}

/** Moves `x` kWh of U from slot s to slot t, unless a minimum power forbids it. */
function moveEnergy(U: VehicleState, s: number, t: number, wantKwh: number): number | null {
  const pu = at(U.power, s);
  const hsU = at(U.hours, s);
  const spareKwh = headroomKw(U, t) * at(U.hours, t);
  if (spareKwh <= KWH_EPS) return null;
  const full = pu * hsU;
  let x = Math.min(full, wantKwh, spareKwh);
  const rest = pu - x / hsU;
  if (rest > EPS && rest < U.v.minKw - EPS) {
    if (full > spareKwh) return null;
    x = full;
  }
  const addT = x / at(U.hours, t);
  if (at(U.power, t) <= EPS && addT < U.v.minKw - EPS) return null;
  if (x >= full - KWH_EPS) clearPower(U, s);
  else addPower(U, s, -x / hsU);
  addPower(U, t, addT);
  return addT;
}

/**
 * Moves energy of an earlier vehicle of the class out of a slot where a later,
 * short vehicle is held back by a shared node, into another slot of its own window.
 */
function repairClass(ordered: VehicleState[]): void {
  for (let pass = 0; pass < REPAIR_PASSES; pass += 1) {
    let improved = false;
    // Slots where each earlier vehicle had room at the start of this pass; room only
    // shrinks while the pass moves energy into them, so a stale entry is re-checked.
    const spareSlots = new Map<VehicleState, number[]>();
    const spareOf = (U: VehicleState): number[] => {
      let slots = spareSlots.get(U);
      if (slots == null) {
        slots = U.byCost.filter((t) => headroomKw(U, t) > EPS);
        spareSlots.set(U, slots);
      }
      return slots;
    };
    for (const [vi, V] of ordered.entries()) {
      let short = V.need - plannedEnergy(V);
      if (short <= KWH_EPS) continue;
      for (const s of V.windowSlots) {
        if (short <= KWH_EPS) break;
        const hsV = at(V.hours, s);
        let limit: Float64Array | null = null;
        let restarts = 0;
        for (let ui = 0; ui < vi && short > KWH_EPS; ui += 1) {
          const ownRoom = V.v.maxKw - at(V.power, s);
          const bottleneck = bottleneckLoad(V, s, ownRoom);
          if (bottleneck == null) break;
          // A move can shift the limit to another node, which earlier vehicles
          // skipped above may share: look at them again.
          if (limit != null && bottleneck !== limit && restarts < MAX_REPAIR_RESTARTS) {
            restarts += 1;
            limit = bottleneck;
            ui = -1;
            continue;
          }
          limit = bottleneck;
          const U = ordered[ui];
          if (U?.loads.has(bottleneck) !== true) continue;
          const pu = at(U.power, s);
          if (pu <= EPS || at(U.hours, s) <= 0) continue;
          for (const t of spareOf(U)) {
            if (t === s) continue;
            const addT = moveEnergy(U, s, t, Math.min(short, ownRoom * hsV));
            if (addT == null) continue;
            const gain = Math.min(headroomKw(V, s), short / hsV);
            if (gain <= EPS || (at(V.power, s) <= EPS && gain < V.v.minKw - EPS)) {
              addPower(U, t, -addT);
              addPower(U, s, pu - at(U.power, s));
              continue;
            }
            addPower(V, s, gain);
            short -= gain * hsV;
            improved = true;
            break;
          }
        }
      }
    }
    if (!improved) return;
  }
}

/** The node that holds the vehicle below its own room at a slot, or null when none does. */
function bottleneckLoad(st: VehicleState, s: number, ownRoom: number): Float64Array | null {
  if (ownRoom <= EPS) return null;
  let room = ownRoom - EPS;
  let tightest: Float64Array | null = null;
  for (const use of st.path) {
    const r = (at(use.cap, s) - at(use.load, s)) / use.weight;
    if (r < room) {
      room = r;
      tightest = use.load;
    }
  }
  return tightest;
}

interface Snapshot {
  loads: Map<string, Float64Array>;
  powers: Float64Array[];
}

function snapshot(planner: Planner, states: VehicleState[]): Snapshot {
  const loads = new Map<string, Float64Array>();
  for (const [id, arr] of planner.loads) loads.set(id, arr.slice());
  return { loads, powers: states.map((st) => st.power.slice()) };
}

function restore(planner: Planner, states: VehicleState[], snap: Snapshot): void {
  for (const [id, arr] of snap.loads) planner.loads.get(id)?.set(arr);
  states.forEach((st, i) => {
    const power = snap.powers[i];
    if (power != null) st.power.set(power);
  });
}

export interface ClassScore {
  shortfall: number;
  bufferKwh: number;
  cost: number;
}

function classScore(planner: Planner, states: VehicleState[]): ClassScore {
  let shortfall = 0;
  let bufferKwh = 0;
  let cost = 0;
  for (const st of states) {
    shortfall += Math.max(0, st.need - plannedEnergy(st));
    for (const s of st.windowSlots) {
      const e = at(st.power, s) * at(st.hours, s);
      cost += at(planner.price, s) * e;
      if (st.inBuffer[s] === 1) bufferKwh += e;
    }
  }
  return { shortfall, bufferKwh, cost };
}

/** Which plan of a class wins: less shortfall, then less energy in the buffer, then lower cost. */
export function isBetterClassScore(candidate: ClassScore, current: ClassScore): boolean {
  if (Math.abs(candidate.shortfall - current.shortfall) > KWH_EPS) {
    return candidate.shortfall < current.shortfall;
  }
  if (Math.abs(candidate.bufferKwh - current.bufferKwh) > KWH_EPS) {
    return candidate.bufferKwh < current.bufferKwh;
  }
  return candidate.cost < current.cost - KWH_EPS;
}

function byDeadline(a: VehicleState, b: VehicleState): number {
  // Ad hoc vehicles charge first in their class (VDV 463 adHocCharging).
  if (a.v.adHoc !== b.v.adHoc) return a.v.adHoc === true ? -1 : 1;
  if (a.v.departureMs !== b.v.departureMs) return a.v.departureMs - b.v.departureMs;
  if (a.need !== b.need) return b.need - a.need;
  if (a.v.departureId === b.v.departureId) return 0;
  return a.v.departureId < b.v.departureId ? -1 : 1;
}

function planClass(planner: Planner, ordered: VehicleState[], mode: FillMode): void {
  for (const st of ordered) {
    // An ad hoc vehicle always takes its earliest slots: it charges from arrival.
    const own: FillMode = st.v.adHoc === true ? 'earliest' : mode;
    fillEnergy(planner, st, own, null, st.need);
    enforceMinPower(planner, st, own);
  }
  repairClass(ordered);
}

/** Fixed preconditioning load of each vehicle on its path nodes, before planning. */
function addAuxLoads(planner: Planner, states: VehicleState[]): void {
  for (const st of states) {
    const aux = st.v.auxKw ?? [];
    for (let s = 0; s < planner.n; s += 1) {
      const kw = aux[s] ?? 0;
      if (kw <= EPS) continue;
      for (const use of st.path) use.load[s] = at(use.load, s) + kw * use.weight;
    }
  }
}

/**
 * The top-up to the maximum targets: after every class is planned, each
 * vehicle (highest priority first, earliest deadline inside a priority) takes
 * its extra energy from the headroom left, outside its buffer, cheapest slots
 * first. A slot the top-up alone would hold below the vehicle's minimum power
 * stays empty, so no minimum is broken and no planned need moves.
 */
function planTopUps(planner: Planner, states: VehicleState[]): void {
  const ordered = [...states]
    .filter((st) => !st.departed && (st.v.extraKwh ?? 0) > KWH_EPS)
    .sort((a, b) => b.v.priority - a.v.priority || byDeadline(a, b));
  for (const st of ordered) {
    const before = st.power.slice();
    const excluded = new Uint8Array(planner.n);
    for (const s of st.windowSlots) if (st.inBuffer[s] === 1) excluded[s] = 1;
    fillEnergy(
      planner,
      st,
      st.v.adHoc === true ? 'earliest' : 'cost',
      excluded,
      st.v.extraKwh ?? 0,
    );
    const minKw = st.v.minKw;
    if (!(minKw > EPS)) continue;
    for (const s of st.windowSlots) {
      const was = at(before, s);
      const now = at(st.power, s);
      if (was <= EPS && now > EPS && now < minKw - EPS) clearPower(st, s);
    }
  }
}

/** Energy the vehicle could take alone over [fromMs, toMs): its own max, or also the path headroom. */
function aloneEnergy(
  planner: Planner,
  st: VehicleState,
  fromMs: number,
  toMs: number,
  withPath: boolean,
): number {
  let sum = 0;
  const { slots, nowMs } = planner.input;
  if (withPath && st.path.length === 0) return 0;
  slots.forEach((slot, s) => {
    const h = overlapHours(slot, Math.max(fromMs, nowMs), toMs);
    if (h <= 0) return;
    let rate = Math.max(0, st.v.maxKw);
    if (withPath) {
      for (const use of st.path) rate = Math.min(rate, at(use.cap, s) / use.weight);
    }
    sum += rate * h;
  });
  return sum;
}

/** Energy at the vehicle's own maximum over [fromMs, toMs), not limited to the horizon. */
function vehicleOnlyEnergy(
  planner: Planner,
  st: VehicleState,
  fromMs: number,
  toMs: number,
): number {
  const from = Math.max(fromMs, planner.input.nowMs);
  return toMs > from ? (st.v.maxKw * (toMs - from)) / HOUR_MS : 0;
}

function capacityReason(
  planner: Planner,
  st: VehicleState,
  fromMs: number,
): DepartureReadinessReason {
  return vehicleOnlyEnergy(planner, st, fromMs, st.v.departureMs) < st.need - KWH_EPS
    ? 'vehicle_power'
    : 'site_capacity';
}

function predictReadyMs(planner: Planner, st: VehicleState, target = st.need): number | null {
  const { input } = planner;
  let cum = 0;
  for (const s of st.windowSlots) {
    const p = at(st.power, s);
    const e = p * at(st.hours, s);
    const slot = input.slots[s];
    if (slot != null && e > 0 && cum + e >= target - KWH_EPS) {
      const start = Math.max(slot.startMs, st.v.availableFromMs, input.nowMs);
      const end = Math.min(slot.endMs, st.v.departureMs);
      return Math.min(end, start + (Math.max(0, target - cum) / p) * HOUR_MS);
    }
    cum += e;
  }
  return null;
}

function toEntry(planner: Planner, st: VehicleState): PlanEntry {
  const { input } = planner;
  const v = st.v;
  const bufferStartMs = v.departureMs - vehicleBufferMs(input, v);
  const planned = plannedEnergy(st);
  const shortfall = st.need - planned > KWH_EPS ? st.need - planned : 0;
  const pluggedIn = v.availableFromMs <= input.nowMs;
  const extraPlanned = Math.max(0, planned - st.need);
  const extraWanted = v.extraKwh ?? 0;
  const common = {
    departureId: v.departureId,
    powerKw: Array.from(st.power),
    plannedKwh: planned,
    shortfallKwh: shortfall,
    extraPlannedKwh: extraPlanned,
    pluggedIn,
    departed: st.departed,
    beyondHorizon: st.beyondHorizon,
  };
  if (st.departed) {
    return {
      ...common,
      predictedReadyMs: null,
      predictedMaxReadyMs: null,
      state: null,
      aloneKwh: 0,
      pluggedNowKwh: 0,
      readiness: null,
      readinessReason: null,
    };
  }

  const nothingNeeded = st.need <= KWH_EPS;
  const noPath = st.path.length === 0;
  let predictedReadyMs: number | null = null;
  if (nothingNeeded) predictedReadyMs = input.nowMs;
  else if (shortfall === 0) predictedReadyMs = predictReadyMs(planner, st);

  // Beyond the horizon the site capacity is unknown, so only the vehicle's own
  // power can prove a departure out of reach.
  const meets = (fromMs: number, toMs: number): boolean =>
    !noPath &&
    (st.beyondHorizon
      ? vehicleOnlyEnergy(planner, st, fromMs, toMs)
      : aloneEnergy(planner, st, fromMs, toMs, true)) >=
      st.need - KWH_EPS;

  const aloneKwh = aloneEnergy(planner, st, v.availableFromMs, v.departureMs, true);
  let state: PlanEntryState;
  if (nothingNeeded) state = 'ready';
  else if (shortfall > 0) {
    if (!meets(v.availableFromMs, v.departureMs)) state = 'cannot_meet';
    else state = st.beyondHorizon ? 'on_track' : 'at_risk';
  } else if (predictedReadyMs != null && predictedReadyMs <= bufferStartMs + READY_TOLERANCE_MS) {
    state = 'on_track';
  } else state = 'at_risk';

  const reasonFrom = (fromMs: number): DepartureReadinessReason =>
    noPath ? 'site_capacity' : capacityReason(planner, st, fromMs);
  let readiness: DepartureReadiness = state;
  let readinessReason: DepartureReadinessReason | null = null;
  if (state === 'ready') {
    readinessReason = null;
  } else if (pluggedIn) {
    // At risk only because it finishes inside the buffer names no cause.
    if (state === 'at_risk' && shortfall > 0) readinessReason = 'site_capacity';
    else if (state === 'cannot_meet') readinessReason = reasonFrom(input.nowMs);
  } else if (meets(input.nowMs, bufferStartMs)) {
    // An arrival before departure is a known arrival time; departure itself means unknown.
    if (v.availableFromMs < v.departureMs && state !== 'on_track') {
      readiness = 'at_risk';
      readinessReason = 'late_arrival';
    } else {
      readiness = 'waiting_for_vehicle';
    }
  } else if (!meets(input.nowMs, v.departureMs)) {
    readiness = 'cannot_meet';
    readinessReason = reasonFrom(input.nowMs);
  } else {
    readiness = 'at_risk';
    readinessReason = 'not_plugged_in';
  }

  let predictedMaxReadyMs: number | null = predictedReadyMs;
  if (extraWanted > KWH_EPS) {
    predictedMaxReadyMs =
      shortfall === 0 && extraPlanned >= extraWanted - KWH_EPS
        ? predictReadyMs(planner, st, st.need + extraWanted)
        : null;
  }

  return {
    ...common,
    predictedReadyMs,
    predictedMaxReadyMs,
    state,
    aloneKwh,
    pluggedNowKwh: aloneEnergy(planner, st, input.nowMs, bufferStartMs, true),
    readiness,
    readinessReason,
  };
}

/**
 * Plans every departure of a site: priority classes first, earliest deadline
 * inside a class, cheapest and least loaded slots first, never above a limit.
 *
 * `readiness` is what the departure stores. The planner derives it from the plan
 * and from `availableFromMs` (after now means not plugged in). The caller adds what
 * the planner cannot see: station problems through `withStationIssue`, and reason
 * `unknown_soc` from `neededEnergyKwh` when the planner gives no other reason.
 * A departed entry has null state and readiness: keep the stored values and let
 * the close job complete it. A beyond-horizon entry is never at risk from the plan.
 */
export function planDepotCharging(input: PlanInput): PlanResult {
  const planner = createPlanner(input);
  const states = input.vehicles.map((v) => createVehicleState(planner, v));
  addAuxLoads(planner, states);
  const priorities = [...new Set(states.map((st) => st.v.priority))].sort((a, b) => b - a);
  for (const priority of priorities) {
    const ordered = states.filter((st) => st.v.priority === priority).sort(byDeadline);
    const before = snapshot(planner, ordered);
    planClass(planner, ordered, 'cost');
    const costScore = classScore(planner, ordered);
    if (costScore.shortfall <= KWH_EPS) continue;
    const costPlan = snapshot(planner, ordered);
    restore(planner, ordered, before);
    planClass(planner, ordered, 'earliest');
    if (!isBetterClassScore(classScore(planner, ordered), costScore)) {
      restore(planner, ordered, costPlan);
    }
  }
  planTopUps(planner, states);

  const entries = states.map((st) => toEntry(planner, st));
  let energy = 0;
  let spend = 0;
  for (const st of states) {
    for (const s of st.windowSlots) {
      const e = at(st.power, s) * at(st.hours, s);
      energy += e;
      spend += at(planner.price, s) * e;
    }
  }
  const nodeLoadKw: Record<string, number[]> = {};
  for (const [id, arr] of planner.loads) nodeLoadKw[id] = Array.from(arr);
  return { entries, nodeLoadKw, costPerKwhWeighted: energy > KWH_EPS ? spend / energy : 0 };
}

export interface DepartureReadinessResult {
  readiness: DepartureReadiness | null;
  readinessReason: DepartureReadinessReason | null;
}

/**
 * A station problem makes a departure at risk, but never hides ready or cannot
 * meet, and never gives a departed entry (null readiness) a readiness.
 */
export function withStationIssue(
  current: DepartureReadinessResult,
  reason: 'charger_not_following' | 'profile_rejected' | 'station_offline',
): DepartureReadinessResult {
  if (
    current.readiness == null ||
    current.readiness === 'ready' ||
    current.readiness === 'cannot_meet'
  ) {
    return current;
  }
  return { readiness: 'at_risk', readinessReason: reason };
}

/** A SoC reading older than this counts as unknown. */
export const SOC_FRESH_MINUTES = 10;

/**
 * What a departure asks for, from any source (operator, schedule, import or an
 * external depot management system): energy from the charger in kWh, or a SoC.
 */
export type DepartureTarget =
  | { kind: 'energy'; targetKwh: number }
  | {
      kind: 'soc';
      /** The minimum SoC the departure needs. */
      targetSoc: number;
      /** Charge further up to this SoC from spare capacity (null or absent: no more). */
      maxSoc?: number | null;
    };

export type NeededEnergyInput = DepartureTarget & {
  /** Energy the bound session delivered so far, in kWh. */
  deliveredKwh: number;
  soc?: number | null;
  /** When the SoC was read. Without it and `nowMs`, or older than ten minutes, the SoC counts as unknown. */
  socMeasuredAtMs?: number | null;
  nowMs?: number;
  capacityKwh?: number | null;
};

export type NeededEnergy =
  | { kwh: number; reason: 'unknown_soc' | null }
  | { kwh: null; reason: 'unknown_capacity' };

function roundKwh(kwh: number): number {
  return Math.max(0, Math.round(kwh * 1e6) / 1e6);
}

function freshSoc(input: NeededEnergyInput): number | null {
  const soc = input.soc;
  if (soc == null || !Number.isFinite(soc)) return null;
  const readAt = input.socMeasuredAtMs;
  const now = input.nowMs;
  // A reading without its time cannot be shown to be fresh.
  if (readAt == null || now == null || !Number.isFinite(readAt) || !Number.isFinite(now)) {
    return null;
  }
  if (now - readAt > SOC_FRESH_MINUTES * 60_000) return null;
  return Math.min(100, Math.max(0, soc));
}

/** Energy still needed for a departure, in kWh (the four rules of the planner). */
export function neededEnergyKwh(input: NeededEnergyInput): NeededEnergy {
  const delivered = Math.max(0, finiteOr(input.deliveredKwh, 0));
  const soc = freshSoc(input);
  const capacity =
    input.capacityKwh != null && input.capacityKwh > 0 && Number.isFinite(input.capacityKwh)
      ? input.capacityKwh
      : null;

  if (input.kind === 'energy') {
    let kwh = Math.max(0, finiteOr(input.targetKwh, 0) - delivered);
    if (soc != null && capacity != null) kwh = Math.min(kwh, ((100 - soc) * capacity) / 100);
    return { kwh: roundKwh(kwh), reason: null };
  }

  if (capacity == null) return { kwh: null, reason: 'unknown_capacity' };
  const target = Math.min(100, Math.max(0, finiteOr(input.targetSoc, 0)));
  if (soc != null) return { kwh: roundKwh(((target - soc) * capacity) / 100), reason: null };
  return { kwh: roundKwh((target * capacity) / 100 - delivered), reason: 'unknown_soc' };
}
