// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Departure-aware allocation of a depot site: builds the planner input from the
// site's panel and circuit tree, binds departures to the sessions charging for
// them, plans when the stored plan is stale, writes the plan and the readiness
// of every departure (writeSitePlan), and turns the current slot of the plan
// into fixed allocations for the load management cycle.

import {
  bindDepartureSessions,
  getElectricityRatePeriodsForSite,
  getSitePlan,
  getSitePlanSettings,
  isFleetChargingEnabled,
  isOperatorStation,
  listPlanDepartures,
  listPlanSessions,
  markSitePlanStale,
  patchSitePlanEntries,
  writeSitePlan,
  db,
  chargingStations,
  evChargingNeeds,
  stationConfigurations,
  type DepartureReadinessWrite,
  type PlanDepartureRow,
  type PlanSessionRow,
  type StoredSitePlan,
} from '@evtivity/database';
import { and, eq, inArray } from 'drizzle-orm';
import {
  circuitConductorPhases,
  conductorFactor,
  publishOcppCommand,
  resolveElectricityRate,
} from '@evtivity/lib';
import type { ElectricityRatePeriod, PubSubClient, ServiceLogger } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { isOcpp21 } from '@evtivity/lib/ocpp-version';
import { afterSitePlanWrite } from './departure-notice.service.js';
import {
  buildPlanSlots,
  neededEnergyKwh,
  planDepotCharging,
  withStationIssue,
  PLAN_HORIZON_HOURS,
  PLAN_SLOT_MINUTES,
  SOC_FRESH_MINUTES,
  type DepartureReadinessResult,
  type NeededEnergyInput,
  type PlanInput,
  type PlanNodeUse,
  type PlanResult,
  type PlanSlot,
  type PlanVehicleInput,
} from '@evtivity/lib/charging-plan';
import {
  ALL_PHASES,
  circuitPhaseShare,
  computeHierarchicalAllocation,
  stationRates,
  type ChargingRateUnit,
  type PlannedAllocationInput,
  type StationRate,
  fixedLoadKw,
  fixedPhaseLoad,
  legWeight,
  mapsThroughStepDown,
  nodeCapacityKw as busCapacityKw,
  stepDownPrimaryPhases,
  subPanelPhaseShare,
  weightedFixedKw,
  type AllocationResult,
  type AppliedAllocation,
  type HierarchyNode,
  type PhaseLoad,
  type StationPowerInfo,
} from './load-management.service.js';
import {
  DEFAULT_PLAN_MAX_PERIODS,
  buildChargingPlanProfile,
  planProfileHash,
  type PlanProfilePayload,
} from './charging-plan-profile.js';
import {
  PROFILE_SETTLE_MS,
  evaluatePlanMeasurement,
  parseMeasureState,
  type PlanMeasureEvent,
  type PlanMeasureState,
} from './charging-plan-measurement.js';

/** The virtual node every vehicle's power flows through; its load is the one smoothed. */
export const PLAN_SITE_NODE = 'site';
/** Departures this far ahead get a readiness; sessions bind within the planner horizon. */
export const PLAN_READINESS_AHEAD_MS = 7 * 86_400_000;
/** Planner runs above this log a warning. */
export const PLAN_RUNTIME_BUDGET_MS = 250;
/** Slots that hold the current allocation of the unplanned sessions as fixed load. */
const UNPLANNED_HOLD_SLOTS = 2;
const SLOT_MS = PLAN_SLOT_MINUTES * 60_000;
const HORIZON_MS = PLAN_HORIZON_HOURS * 3_600_000;
const CUT_TOLERANCE_KW = 0.01;
/** The lowest current an AC charger offers before the EV pauses (IEC 61851-1). */
export const AC_MIN_CURRENT_A = 6;
/** Capacity of a hold node after the hold slots: no limit of its own. */
const UNLIMITED_KW = 1_000_000;

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
      const sixAmpKw = (AC_MIN_CURRENT_A * child.voltageV * conductorFactor(conductors)) / 1000;
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

export interface DepartureBinding {
  /** Departure id to the active session charging for it. */
  sessions: Map<string, PlanSessionRow>;
  /** Bindings to store (`vehicle_departures.session_id`); null unbinds. */
  writes: Array<{ departureId: string; sessionId: string | null }>;
}

/**
 * Binds departures to active sessions: a departure keeps an active session it
 * is bound to while that session still charges the departure's vehicle, and is
 * unbound when the session's vehicle changed; a session whose vehicle has a
 * scheduled departure at the site
 * within the planner horizon binds to the earliest one. `departures` are in
 * departure order.
 */
export function bindDepartures(
  departures: readonly PlanDepartureRow[],
  sessions: readonly PlanSessionRow[],
  nowMs: number,
): DepartureBinding {
  const active = new Map(sessions.map((s) => [s.id, s]));
  const bound = new Map<string, PlanSessionRow>();
  const taken = new Set<string>();
  const writes: DepartureBinding['writes'] = [];
  // An ad hoc departure (no time) never departs: it lasts until its session ends.
  const departureMs = (d: PlanDepartureRow): number =>
    d.departureAt != null ? d.departureAt.getTime() : Number.POSITIVE_INFINITY;
  for (const d of departures) {
    if (d.sessionId == null) continue;
    if (d.held === true) {
      // A terminated request keeps its session, whatever its vehicle, at zero
      // power; the binding is not written (the row is cancelled).
      const held = active.get(d.sessionId);
      if (held != null && !taken.has(held.id)) {
        bound.set(d.id, held);
        taken.add(held.id);
      }
      continue;
    }
    if (departureMs(d) <= nowMs) continue;
    const session = active.get(d.sessionId);
    if (session == null) continue;
    if (session.vehicleId !== d.vehicleId || taken.has(session.id)) {
      writes.push({ departureId: d.id, sessionId: null });
      continue;
    }
    bound.set(d.id, session);
    taken.add(session.id);
  }
  for (const session of sessions) {
    if (session.vehicleId == null || taken.has(session.id)) continue;
    const departure = departures.find((d) => {
      const at = departureMs(d);
      return (
        d.held !== true &&
        d.vehicleId === session.vehicleId &&
        !bound.has(d.id) &&
        at > nowMs &&
        (d.departureAt == null || at <= nowMs + HORIZON_MS)
      );
    });
    if (departure == null) continue;
    bound.set(departure.id, session);
    taken.add(session.id);
    writes.push({ departureId: departure.id, sessionId: session.id });
  }
  return { sessions: bound, writes };
}

/** The start of the slot `nowMs` falls in. */
export function currentSlotStartMs(nowMs: number): number {
  return Math.floor(nowMs / SLOT_MS) * SLOT_MS;
}

/**
 * The stored plan is missing, marked stale, or planned before the current
 * slot. The plan's first slot starts at the worker time it planned at, so the
 * comparison never mixes the database clock with the worker clock; a plan
 * without slots falls back to its computed time.
 */
export function planNeedsRun(stored: StoredSitePlan | null, nowMs: number): boolean {
  if (stored == null || stored.plan == null || stored.staleAt != null) return true;
  const first = Array.isArray(stored.slotStarts) ? (stored.slotStarts as unknown[])[0] : undefined;
  const plannedAtMs = typeof first === 'string' ? Date.parse(first) : Number.NaN;
  const at = Number.isFinite(plannedAtMs) ? plannedAtMs : stored.computedAt.getTime();
  return at < currentSlotStartMs(nowMs);
}

/** One planned departure as stored in `site_charging_plans.plan`. */
export interface StoredPlanEntry {
  departureId: string;
  vehicleId: string;
  sessionId: string;
  stationDbId: string;
  evseDbId: string | null;
  /** The lowest power the session holds without pausing (0: any power). */
  minKw: number;
  powerKw: number[];
  /** Preconditioning load per slot in kW, added to the profile limit (absent: none). */
  auxKw?: number[];
  /** Slots of the battery preconditioning window (OCPP 2.1 preconditioningRequest). */
  preconditioning?: boolean[];
  /** The TxProfile last sent for the session and the station's answer. */
  profile?: PlanProfileState;
  /** Measured draw against the plan: taper cap, charger not following, slot energy. */
  measure?: PlanMeasureState;
  /**
   * The session left the plan while the station may still hold its TxProfile:
   * kept only until the dispatcher has cleared that profile, never planned.
   */
  left?: boolean;
}

/** The entries the plan charges (not the ones kept only to clear a profile). */
export function plannedEntries(entries: readonly StoredPlanEntry[]): StoredPlanEntry[] {
  return entries.filter((entry) => entry.left !== true);
}

/** The plan TxProfile last sent for a session, as stored in its plan entry. */
export interface PlanProfileState {
  /** The TxProfile id (`chargingNeedsProfileId`). */
  id: number;
  hash: string;
  /** Start of the plan slot it was sent in: at most one send per slot. */
  slotStartMs: number;
  /**
   * `not_sent`: no answer or a send failure, sent again at the next slot.
   * `cleared`: a ClearChargingProfile went out after the session left the plan.
   */
  state: PlanProfileStateName;
  sentAt: string;
  repliedAt?: string;
  rejectedAt?: string;
  /** Units the station refused for this session's profile: the next send uses the other one. */
  rejectedUnits?: ChargingRateUnit[];
  clearedAt?: string;
}

export type PlanProfileStateName = 'sent' | 'accepted' | 'rejected' | 'not_sent' | 'cleared';
const PLAN_PROFILE_STATES: readonly PlanProfileStateName[] = [
  'sent',
  'accepted',
  'rejected',
  'not_sent',
  'cleared',
];

function parseProfileState(value: unknown): PlanProfileState | undefined {
  if (value == null || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const state = v['state'];
  if (
    typeof v['id'] !== 'number' ||
    typeof v['hash'] !== 'string' ||
    typeof v['slotStartMs'] !== 'number' ||
    typeof v['sentAt'] !== 'string' ||
    !PLAN_PROFILE_STATES.includes(state as PlanProfileStateName)
  ) {
    return undefined;
  }
  const units = Array.isArray(v['rejectedUnits'])
    ? (v['rejectedUnits'] as unknown[]).filter((u): u is ChargingRateUnit => u === 'A' || u === 'W')
    : [];
  return {
    id: v['id'],
    hash: v['hash'],
    slotStartMs: v['slotStartMs'],
    state: state as PlanProfileStateName,
    sentAt: v['sentAt'],
    ...(typeof v['repliedAt'] === 'string' ? { repliedAt: v['repliedAt'] } : {}),
    ...(typeof v['rejectedAt'] === 'string' ? { rejectedAt: v['rejectedAt'] } : {}),
    ...(units.length > 0 ? { rejectedUnits: units } : {}),
    ...(typeof v['clearedAt'] === 'string' ? { clearedAt: v['clearedAt'] } : {}),
  };
}

function parseStoredEntries(value: unknown): StoredPlanEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: StoredPlanEntry[] = [];
  for (const item of value as unknown[]) {
    if (item == null || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (
      typeof e['departureId'] !== 'string' ||
      typeof e['sessionId'] !== 'string' ||
      typeof e['stationDbId'] !== 'string' ||
      !Array.isArray(e['powerKw'])
    ) {
      continue;
    }
    entries.push({
      departureId: e['departureId'],
      vehicleId: typeof e['vehicleId'] === 'string' ? e['vehicleId'] : '',
      sessionId: e['sessionId'],
      stationDbId: e['stationDbId'],
      evseDbId: typeof e['evseDbId'] === 'string' ? e['evseDbId'] : null,
      minKw:
        typeof e['minKw'] === 'number' && Number.isFinite(e['minKw']) ? Math.max(0, e['minKw']) : 0,
      powerKw: (e['powerKw'] as unknown[]).map((v) =>
        typeof v === 'number' && Number.isFinite(v) ? v : 0,
      ),
    });
    const profile = parseProfileState(e['profile']);
    const measure = parseMeasureState(e['measure']);
    const last = entries[entries.length - 1];
    if (Array.isArray(e['auxKw']) && last != null) {
      last.auxKw = (e['auxKw'] as unknown[]).map((v) =>
        typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0,
      );
    }
    if (Array.isArray(e['preconditioning']) && last != null) {
      last.preconditioning = (e['preconditioning'] as unknown[]).map((v) => v === true);
    }
    if (profile != null && last != null) last.profile = profile;
    if (measure != null && last != null) last.measure = measure;
    if (e['left'] === true && last != null) last.left = true;
  }
  return entries;
}

/** Index of the stored slot `nowMs` falls in, or -1 when the plan does not cover it. */
export function storedSlotIndex(slotStarts: unknown, nowMs: number): number {
  if (!Array.isArray(slotStarts) || slotStarts.length === 0) return -1;
  const starts = (slotStarts as unknown[]).map((v) =>
    typeof v === 'string' ? Date.parse(v) : Number.NaN,
  );
  let index = -1;
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i] ?? Number.NaN;
    if (!Number.isFinite(start) || start > nowMs) break;
    index = i;
  }
  // The last slot ends at the next quarter hour at the latest.
  if (index === starts.length - 1 && nowMs >= currentSlotStartMs(starts[index] ?? 0) + SLOT_MS) {
    return -1;
  }
  return index;
}

export interface PlannedStations {
  /** Planned kW of the current slot per station database id. */
  plannedKw: Map<string, number>;
  /** Planned stations that also hold an unplanned session. */
  sharing: Set<string>;
  /** The minimum of the planned sessions that get power, per station. */
  minKw: Map<string, number>;
}

/** A slot power between 0 and the session minimum is not one a charger holds: 0 or the minimum. */
export function snapToMinimum(kw: number, minKw: number): number {
  if (!(kw > 0)) return 0;
  if (minKw <= 0 || kw >= minKw) return kw;
  return kw >= minKw / 2 ? minKw : 0;
}

/** The current slot of a set of planned entries, summed per station, for sessions still active. */
export function plannedStations(
  entries: readonly StoredPlanEntry[],
  slotIndex: number,
  sessions: readonly PlanSessionRow[],
): PlannedStations {
  const active = new Map(sessions.map((s) => [s.id, s]));
  const plannedKw = new Map<string, number>();
  const minKw = new Map<string, number>();
  const plannedSessions = new Set<string>();
  for (const entry of plannedEntries(entries)) {
    const session = active.get(entry.sessionId);
    if (session == null || session.stationDbId !== entry.stationDbId) continue;
    const kw = snapToMinimum(slotIndex >= 0 ? (entry.powerKw[slotIndex] ?? 0) : 0, entry.minKw);
    plannedKw.set(entry.stationDbId, (plannedKw.get(entry.stationDbId) ?? 0) + kw);
    if (kw > 0) minKw.set(entry.stationDbId, (minKw.get(entry.stationDbId) ?? 0) + entry.minKw);
    plannedSessions.add(session.id);
  }
  const sharing = new Set<string>();
  for (const session of sessions) {
    if (plannedKw.has(session.stationDbId) && !plannedSessions.has(session.id)) {
      sharing.add(session.stationDbId);
    }
  }
  return { plannedKw, sharing, minKw };
}

/** A planned station that the panel or phase limits cut below its planned power. */
export function plannedStationCut(
  allocations: readonly AllocationResult[],
  plannedKw: ReadonlyMap<string, number>,
): boolean {
  const byId = new Map(allocations.map((a) => [a.stationDbId, a.allocatedKw]));
  for (const [stationDbId, kw] of plannedKw) {
    const allocated = byId.get(stationDbId);
    if (allocated != null && allocated < kw - CUT_TOLERANCE_KW) return true;
  }
  return false;
}

function positiveMin(values: ReadonlyArray<number | null | undefined>): number | null {
  const usable = values.filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
  return usable.length > 0 ? Math.min(...usable) : null;
}

function neededInput(
  d: PlanDepartureRow,
  session: PlanSessionRow | null,
  nowMs: number,
  targetSoc: number = d.targetSocPercent ?? 0,
): NeededEnergyInput {
  const reading = {
    deliveredKwh: session != null ? session.energyDeliveredWh / 1000 : 0,
    soc: session?.lastSocPercent ?? null,
    socMeasuredAtMs: session?.lastSocAt?.getTime() ?? null,
    nowMs,
    capacityKwh: d.batteryCapacityKwh,
  };
  if (d.targetKind !== 'soc')
    return { kind: 'energy', targetKwh: d.targetEnergyKwh ?? 0, ...reading };
  const fresh =
    reading.soc != null &&
    reading.socMeasuredAtMs != null &&
    nowMs - reading.socMeasuredAtMs <= SOC_FRESH_MINUTES * 60_000;
  const capacity = d.batteryCapacityKwh;
  // Without a fresh reading, the SoC the depot system expects at arrival tells
  // the energy the battery takes; the session's delivered energy counts against it.
  if (!fresh && d.expectedArrivalSocPercent != null && capacity != null && capacity > 0) {
    const kwh = Math.max(0, ((targetSoc - d.expectedArrivalSocPercent) * capacity) / 100);
    return { kind: 'energy', ...reading, soc: null, targetKwh: kwh };
  }
  return { kind: 'soc', targetSoc, ...reading };
}

/** Plan time of a departure: an ad hoc one plans to the ad hoc horizon. */
export const AD_HOC_PLAN_MS = 24 * 3_600_000;

function planDepartureMs(d: PlanDepartureRow, nowMs: number): number {
  return d.departureAt != null ? d.departureAt.getTime() : nowMs + AD_HOC_PLAN_MS;
}

/** kW the preconditioning of a departure draws in each slot (the slot's average). */
export function preconditioningAuxKw(
  d: PlanDepartureRow,
  slots: readonly PlanSlot[],
  nowMs: number,
): number[] | undefined {
  const p = d.preconditioning;
  if (p == null) return undefined;
  const endMs = planDepartureMs(d, nowMs);
  const windows: Array<{ fromMs: number; toMs: number; kw: number }> = [];
  if (p.hvacStartAt != null && p.hvacKw != null && p.hvacKw > 0) {
    windows.push({ fromMs: p.hvacStartAt.getTime(), toMs: endMs, kw: p.hvacKw });
  }
  if (p.systemStartAt != null && p.systemKw != null && p.systemKw > 0) {
    windows.push({ fromMs: p.systemStartAt.getTime(), toMs: endMs, kw: p.systemKw });
  }
  const automatic = automaticPreconditioningWindow(d, nowMs);
  const autoKw = d.preconditioningPowerKw;
  if (automatic != null && autoKw != null && autoKw > 0) windows.push({ ...automatic, kw: autoKw });
  if (windows.length === 0) return undefined;
  return slots.map((slot) => {
    const span = slot.endMs - slot.startMs;
    if (span <= 0) return 0;
    let kw = 0;
    for (const w of windows) {
      const overlap = Math.min(slot.endMs, w.toMs) - Math.max(slot.startMs, w.fromMs);
      if (overlap > 0) kw += (w.kw * overlap) / span;
    }
    return round(kw, 3);
  });
}

/**
 * The automatic preconditioning window: from the requested start (else the
 * vehicle's preconditioning minutes before the finish) to the requested finish
 * (else the departure). Null without automatic preconditioning.
 */
export function automaticPreconditioningWindow(
  d: PlanDepartureRow,
  nowMs: number,
): { fromMs: number; toMs: number } | null {
  const p = d.preconditioning;
  if (p == null || p.climate == null) return null;
  const toMs = p.finishAt?.getTime() ?? planDepartureMs(d, nowMs);
  const minutes = d.preconditioningMinutes ?? 30;
  const fromMs = p.startAt?.getTime() ?? toMs - minutes * 60_000;
  return toMs > fromMs ? { fromMs, toMs } : null;
}

export interface PlanBuildInput {
  nowMs: number;
  bufferMinutes: number;
  timezone: string;
  ratePeriods: ElectricityRatePeriod[];
  hierarchy: readonly HierarchyNode[];
  /** Every station of the site (managed or not). */
  stations: readonly StationPowerInfo[];
  reservedKw: ReadonlyMap<string, number>;
  /** The allocations last sent, for the power of the unplanned sessions. */
  previous: readonly AppliedAllocation[] | null;
  departures: readonly PlanDepartureRow[];
  sessions: readonly PlanSessionRow[];
  binding: DepartureBinding;
  /** The measurement state per session id: a taper cap lowers its maximum. */
  measures?: ReadonlyMap<string, PlanMeasureState>;
}

export interface PlanDepartureContext {
  departure: PlanDepartureRow;
  session: PlanSessionRow | null;
  station: StationPowerInfo | null;
  unknownSoc: boolean;
  /** The session's minimum power in the plan (0 for a waiting vehicle). */
  minKw: number;
  /** A reserved station holds the session at its last limit for the hold slots. */
  stationIssue: 'station_offline' | 'charger_not_following' | null;
}

export interface PlanBuild {
  input: PlanInput;
  /** The departures the planner got, in input order. */
  departures: PlanDepartureContext[];
}

/**
 * The planner input of a site. A departure whose session is bound is plugged in
 * on its station's path; one without a session gets the site node alone and no
 * window (available from its departure), so it still gets a readiness. A SoC
 * target whose vehicle has no battery capacity is left out.
 */
export function buildPlanInput(build: PlanBuildInput): PlanBuild {
  const { nowMs } = build;
  const stationById = new Map(build.stations.map((s) => [s.id, s]));
  const pluggedSessions = new Set<string>();
  const plannedPerStation = new Map<string, number>();
  for (const session of build.binding.sessions.values()) {
    pluggedSessions.add(session.id);
    plannedPerStation.set(
      session.stationDbId,
      (plannedPerStation.get(session.stationDbId) ?? 0) + 1,
    );
  }

  // Reservations stay fixed load, also on a station with a planned session:
  // the cycle keeps reserving it, so a plan without it would be cut every cycle.
  const nodes = buildPlanNodes(build.hierarchy, build.reservedKw);

  const lastDepartureMs = build.departures.reduce(
    (max, d) => (d.held === true ? max : Math.max(max, planDepartureMs(d, nowMs))),
    nowMs,
  );
  const slots: PlanSlot[] = buildPlanSlots(nowMs, lastDepartureMs);

  const holdKw = unplannedHoldKw(build, nodes, pluggedSessions);
  const nodeCapacityKw: Record<string, number[]> = {};
  for (const [nodeId, headroom] of nodes.headroomKw) {
    const hold = holdKw.get(nodeId) ?? 0;
    // Slot 0 has the live battery and solar credit, later slots the grid only (D10).
    const live = nodes.liveHeadroomKw.get(nodeId) ?? headroom;
    nodeCapacityKw[nodeId] = slots.map((_, s) => {
      const slotHeadroom = s === 0 ? live : headroom;
      return Math.max(0, s < UNPLANNED_HOLD_SLOTS ? slotHeadroom - hold : slotHeadroom);
    });
  }

  const pricePerKwh = slots.map((slot) => {
    const period = resolveElectricityRate(
      build.ratePeriods,
      new Date(slot.startMs),
      build.timezone,
    );
    const rate = period != null ? Number(period.ratePerKwh) : 0;
    return Number.isFinite(rate) ? rate : 0;
  });

  const siteKw = nodes.headroomKw.get(PLAN_SITE_NODE) ?? 0;
  const largestStationKw = positiveMin([Math.max(0, ...build.stations.map((s) => s.maxPowerKw))]);
  const vehicles: PlanVehicleInput[] = [];
  const departures: PlanDepartureContext[] = [];
  for (const d of build.departures) {
    const session = build.binding.sessions.get(d.id) ?? null;
    // A terminated request is held at zero power while its session lasts.
    if (d.held === true && session == null) continue;
    const needed =
      d.held === true ? { kwh: 0, reason: null } : neededEnergyKwh(neededInput(d, session, nowMs));
    if (needed.kwh == null) continue;
    let extraKwh = 0;
    if (d.held !== true && d.targetKind === 'soc' && d.targetSocMaxPercent != null) {
      const atMax = neededEnergyKwh(neededInput(d, session, nowMs, d.targetSocMaxPercent));
      if (atMax.kwh != null) extraKwh = Math.max(0, atMax.kwh - needed.kwh);
    }
    const station = session != null ? (stationById.get(session.stationDbId) ?? null) : null;
    // Before the vehicle plugs in, a depot system's charging point reserves its path.
    const requestedStation =
      session == null && d.requestedStationDbId != null
        ? (stationById.get(d.requestedStationDbId) ?? null)
        : null;
    const pathStation = station ?? requestedStation;
    const stationPath = pathStation != null ? nodes.paths.get(pathStation.id) : undefined;
    let path = stationPath ?? [{ nodeId: PLAN_SITE_NODE, weight: 1 }];
    const plugged = session != null;
    let maxKw =
      (plugged
        ? positiveMin([
            d.maxChargePowerKw,
            session.evseMaxKw,
            station != null && station.maxPowerKw > 0 ? station.maxPowerKw : null,
          ])
        : requestedStation != null
          ? positiveMin([
              d.maxChargePowerKw,
              requestedStation.maxPowerKw > 0 ? requestedStation.maxPowerKw : null,
            ])
          : positiveMin([d.maxChargePowerKw, largestStationKw])) ??
      positiveMin([d.maxChargePowerKw, siteKw]) ??
      0;
    const taperCapKw = plugged ? build.measures?.get(session.id)?.taperCapKw : undefined;
    if (taperCapKw != null && taperCapKw > 0 && taperCapKw < maxKw) maxKw = taperCapKw;
    let minKw = 0;
    let stationIssue: PlanDepartureContext['stationIssue'] = null;
    if (plugged && station != null) {
      // The station minimum is the station's, shared by its planned sessions;
      // an AC session never gets less than 6 A, or the EV pauses.
      const stationShare =
        Math.max(0, station.minPowerKw) / Math.max(1, plannedPerStation.get(station.id) ?? 1);
      const acMin = session.acCharging ? (nodes.acMinKw.get(station.id) ?? 0) : 0;
      minKw = Math.min(maxKw, Math.max(stationShare, acMin));
      if (build.reservedKw.has(station.id)) {
        stationIssue = station.isOnline ? 'charger_not_following' : 'station_offline';
        // Its reservation already holds its power for the hold slots.
        const holdId = holdNodeId(station.id);
        nodeCapacityKw[holdId] = slots.map((_, s) => (s < UNPLANNED_HOLD_SLOTS ? 0 : UNLIMITED_KW));
        path = [...path, { nodeId: holdId, weight: 1 }];
      }
    }
    const departureMs = planDepartureMs(d, nowMs);
    // Unplugged: available from the expected arrival when known, else no window.
    const arrivalMs = d.expectedArrivalAt?.getTime();
    const availableFromMs = plugged
      ? nowMs
      : arrivalMs != null && arrivalMs < departureMs
        ? arrivalMs
        : departureMs;
    const auxKw = d.held === true ? undefined : preconditioningAuxKw(d, slots, nowMs);
    vehicles.push({
      departureId: d.id,
      departureMs,
      priority: d.held === true ? 10 : d.priority,
      neededKwh: needed.kwh,
      maxKw: d.held === true ? 0 : maxKw,
      minKw: d.held === true ? 0 : minKw,
      availableFromMs,
      path,
      ...(extraKwh > 0 ? { extraKwh } : {}),
      ...(d.adHoc === true ? { adHoc: true } : {}),
      ...(auxKw != null ? { auxKw } : {}),
    });
    departures.push({
      departure: d,
      session,
      station,
      unknownSoc: needed.reason === 'unknown_soc',
      minKw,
      stationIssue,
    });
  }

  return {
    input: {
      nowMs,
      bufferMinutes: build.bufferMinutes,
      slots,
      pricePerKwh,
      nodeCapacityKw,
      rootNodeId: PLAN_SITE_NODE,
      vehicles,
    },
    departures,
  };
}

/**
 * Load the unplanned sessions hold on each node for the first slots: per
 * station the highest of its last sent allocation, its measured draw, its
 * minimum, and the equal share of its circuit's headroom its unplanned sessions
 * would get (so a session that just started is never planned at 0), capped at
 * the station maximum. A station that also holds planned sessions counts only
 * the share and minimum of its unplanned ones.
 */
export function unplannedHoldKw(
  build: Pick<PlanBuildInput, 'stations' | 'sessions' | 'previous' | 'reservedKw'>,
  nodes: PlanNodes,
  pluggedSessions: ReadonlySet<string>,
): Map<string, number> {
  const stationById = new Map(build.stations.map((s) => [s.id, s]));
  const previousById = new Map((build.previous ?? []).map((a) => [a.stationDbId, a]));
  const unplanned = new Map<string, number>();
  const planned = new Set<string>();
  const sessionsPerCircuit = new Map<string, number>();
  for (const session of build.sessions) {
    if (build.reservedKw.has(session.stationDbId)) continue;
    const circuit = nodes.circuitOf.get(session.stationDbId);
    if (circuit != null)
      sessionsPerCircuit.set(circuit, (sessionsPerCircuit.get(circuit) ?? 0) + 1);
    if (pluggedSessions.has(session.id)) planned.add(session.stationDbId);
    else unplanned.set(session.stationDbId, (unplanned.get(session.stationDbId) ?? 0) + 1);
  }
  const holdKw = new Map<string, number>();
  for (const [stationDbId, count] of unplanned) {
    const station = stationById.get(stationDbId);
    const path = nodes.paths.get(stationDbId);
    const circuit = nodes.circuitOf.get(stationDbId);
    if (station == null || path == null || circuit == null) continue;
    const perSession =
      (nodes.headroomKw.get(circuit) ?? 0) / Math.max(1, sessionsPerCircuit.get(circuit) ?? 1);
    const candidates = [perSession * count, Math.max(0, station.minPowerKw)];
    if (!planned.has(stationDbId)) {
      const last = previousById.get(stationDbId);
      if (last != null && last.reserved !== true) candidates.push(last.allocatedKw);
      candidates.push(station.currentDrawKw);
    }
    let kw = Math.max(0, ...candidates);
    if (station.maxPowerKw > 0) kw = Math.min(kw, station.maxPowerKw);
    for (const use of path) {
      holdKw.set(use.nodeId, (holdKw.get(use.nodeId) ?? 0) + kw * use.weight);
    }
  }
  return holdKw;
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** What each departure stores, with the station problems the planner cannot see. */
export function readinessWrites(build: PlanBuild, result: PlanResult): DepartureReadinessWrite[] {
  return result.entries.map((entry, i) => {
    const context = build.departures[i];
    let readiness: DepartureReadinessResult = {
      readiness: entry.readiness,
      readinessReason: entry.readinessReason,
    };
    if (context?.stationIssue != null) {
      readiness = withStationIssue(readiness, context.stationIssue);
    } else if (context?.station != null && !context.station.isOnline) {
      readiness = withStationIssue(readiness, 'station_offline');
    }
    if (
      context?.unknownSoc === true &&
      readiness.readinessReason == null &&
      readiness.readiness != null &&
      readiness.readiness !== 'ready'
    ) {
      readiness = { ...readiness, readinessReason: 'unknown_soc' };
    }
    return {
      departureId: entry.departureId,
      readiness: readiness.readiness,
      readinessReason: readiness.readinessReason,
      plannedKwh: entry.plannedKwh,
      deliveredKwh:
        context?.session != null ? round(context.session.energyDeliveredWh / 1000, 3) : null,
      shortfallKwh: entry.shortfallKwh,
      predictedReadyAt: entry.predictedReadyMs != null ? new Date(entry.predictedReadyMs) : null,
      predictedMaxReadyAt:
        context?.departure.targetSocMaxPercent != null && entry.predictedMaxReadyMs != null
          ? new Date(entry.predictedMaxReadyMs)
          : null,
    };
  });
}

/** The plugged-in departures of a plan, as stored. */
export function storedPlanEntries(build: PlanBuild, result: PlanResult): StoredPlanEntry[] {
  const entries: StoredPlanEntry[] = [];
  result.entries.forEach((entry, i) => {
    const context = build.departures[i];
    if (context?.session == null) return;
    const aux = build.input.vehicles[i]?.auxKw;
    const window = batteryPreconditioningWindow(context.departure, build.input.nowMs);
    const flags =
      window != null
        ? build.input.slots.map((slot) => slot.endMs > window.fromMs && slot.startMs < window.toMs)
        : null;
    entries.push({
      departureId: entry.departureId,
      vehicleId: context.departure.vehicleId,
      sessionId: context.session.id,
      stationDbId: context.session.stationDbId,
      evseDbId: context.session.evseDbId,
      minKw: round(context.minKw, 3),
      powerKw: entry.powerKw.map((kw) => round(kw, 3)),
      ...(aux != null && aux.some((kw) => kw > 0) ? { auxKw: aux.map((kw) => round(kw, 3)) } : {}),
      ...(flags?.some((f) => f) === true ? { preconditioning: flags } : {}),
    });
  });
  return entries;
}

/**
 * The window the EV conditions its battery in: the automatic window, else the
 * manual system preconditioning (24 V, compressed air, traction battery) from
 * its start to the departure.
 */
export function batteryPreconditioningWindow(
  d: PlanDepartureRow,
  nowMs: number,
): { fromMs: number; toMs: number } | null {
  if (d.held === true) return null;
  const automatic = automaticPreconditioningWindow(d, nowMs);
  if (automatic != null) return automatic;
  const start = d.preconditioning?.systemStartAt;
  if (start == null) return null;
  const toMs = planDepartureMs(d, nowMs);
  return toMs > start.getTime() ? { fromMs: start.getTime(), toMs } : null;
}

/**
 * The draw of a planned session: its EVSE's latest reading, else the station's
 * when the session is the only active one there. Null when nothing measured it.
 */
export function plannedSessionDrawKw(
  station: StationPowerInfo,
  session: PlanSessionRow,
  activeOnStation: number,
): number | null {
  const evseKw = session.evseDbId != null ? station.evseDrawKw?.[session.evseDbId] : undefined;
  if (evseKw != null) return evseKw;
  if (activeOnStation === 1 && station.drawMeasured === true) return station.currentDrawKw;
  return null;
}

export interface PlanMeasurementInput {
  entries: readonly StoredPlanEntry[];
  /** Index of the stored slot that holds now (-1: none). */
  slotIndex: number;
  sessions: readonly PlanSessionRow[];
  stations: readonly StationPowerInfo[];
  /** Stations the cycle reserves (offline, limit not confirmed): not measured. */
  reservedKw: ReadonlyMap<string, number>;
  nowMs: number;
}

export interface PlanMeasurementResult {
  /** The state of every measured session. */
  measures: Map<string, PlanMeasureState>;
  /** The sessions whose state changed. */
  changed: Array<{ sessionId: string; state: PlanMeasureState }>;
  events: Array<{
    sessionId: string;
    stationDbId: string;
    event: PlanMeasureEvent;
    drawKw: number | null;
    limitKw: number;
  }>;
}

/**
 * The station accepted the session's profile at least `PROFILE_SETTLE_MS` ago,
 * so its draw answers the planned limit.
 */
export function profileSettled(profile: PlanProfileState | undefined, nowMs: number): boolean {
  if (profile?.state !== 'accepted' || profile.repliedAt == null) return false;
  const repliedMs = Date.parse(profile.repliedAt);
  return Number.isFinite(repliedMs) && nowMs - repliedMs >= PROFILE_SETTLE_MS;
}

/** One cycle of measurement over the planned sessions of a site. */
export function measurePlannedSessions(input: PlanMeasurementInput): PlanMeasurementResult {
  const result: PlanMeasurementResult = { measures: new Map(), changed: [], events: [] };
  if (input.slotIndex < 0) return result;
  const stationById = new Map(input.stations.map((st) => [st.id, st]));
  const sessionById = new Map(input.sessions.map((se) => [se.id, se]));
  const activeOnStation = new Map<string, number>();
  for (const se of input.sessions) {
    activeOnStation.set(se.stationDbId, (activeOnStation.get(se.stationDbId) ?? 0) + 1);
  }
  const slotStartMs = currentSlotStartMs(input.nowMs);
  for (const entry of plannedEntries(input.entries)) {
    const session = sessionById.get(entry.sessionId);
    const station = stationById.get(entry.stationDbId);
    if (session == null || station == null || session.stationDbId !== entry.stationDbId) continue;
    if (!station.isOnline || input.reservedKw.has(station.id)) continue;
    const limitKw = snapToMinimum(entry.powerKw[input.slotIndex] ?? 0, entry.minKw);
    const drawKw = plannedSessionDrawKw(station, session, activeOnStation.get(station.id) ?? 0);
    const outcome = evaluatePlanMeasurement(
      entry.measure,
      {
        limitKw,
        drawKw,
        energyWh: session.energyDeliveredWh,
        slotStartMs,
        minKw: entry.minKw,
        profileSettled: profileSettled(entry.profile, input.nowMs),
      },
      input.nowMs,
    );
    result.measures.set(entry.sessionId, outcome.state);
    if (outcome.changed) result.changed.push({ sessionId: entry.sessionId, state: outcome.state });
    for (const event of outcome.events) {
      result.events.push({
        sessionId: entry.sessionId,
        stationDbId: entry.stationDbId,
        event,
        drawKw,
        limitKw,
      });
    }
  }
  return result;
}

/**
 * The reservations the planner works with: the cycle's, plus the measured draw
 * of each session that does not follow its limit, held as fixed load on its
 * station until it follows again.
 */
export function withNotFollowingDraws(
  reservedKw: ReadonlyMap<string, number>,
  entries: readonly StoredPlanEntry[],
  measures: ReadonlyMap<string, PlanMeasureState>,
): Map<string, number> {
  const next = new Map(reservedKw);
  const drawByStation = new Map<string, number>();
  for (const entry of plannedEntries(entries)) {
    const kw = (measures.get(entry.sessionId) ?? entry.measure)?.notFollowingKw;
    if (kw == null || kw <= 0) continue;
    drawByStation.set(entry.stationDbId, (drawByStation.get(entry.stationDbId) ?? 0) + kw);
  }
  for (const [stationDbId, kw] of drawByStation) {
    next.set(stationDbId, Math.max(next.get(stationDbId) ?? 0, kw));
  }
  return next;
}

export interface DepartureAwareContext {
  siteId: string;
  hierarchy: HierarchyNode[];
  /** Every station of the site. */
  stations: StationPowerInfo[];
  reservedKw: Map<string, number>;
  previous: readonly AppliedAllocation[] | null;
  /** True for the load management cycle: bind, plan and write. False only reads the stored plan. */
  replan: boolean;
  log: ServiceLogger;
  nowMs?: number;
}

function planTrigger(
  stored: StoredSitePlan | null,
  bound: boolean,
  measured: PlanMeasureEvent | undefined,
): string {
  if (stored?.staleAt != null && stored.trigger != null) return stored.trigger;
  if (stored == null || stored.plan == null) return 'initial';
  if (bound) return 'session_bound';
  return measured ?? 'slot_boundary';
}

/**
 * The planned stations of a departure-aware site for the current slot. In the
 * cycle (`replan`), binds new sessions to their departures, and when the stored
 * plan is stale or older than the current slot, plans again and writes the plan
 * and the readiness of every listed departure. Throws on a read or write
 * failure; the caller falls back to equal share for the cycle.
 */
export async function departureAwarePlan(ctx: DepartureAwareContext): Promise<PlannedStations> {
  const nowMs = ctx.nowMs ?? Date.now();
  const [sessions, departures, settings, stored] = await Promise.all([
    listPlanSessions(ctx.stations.map((s) => s.id)),
    listPlanDepartures(ctx.siteId, new Date(nowMs + PLAN_READINESS_AHEAD_MS)),
    getSitePlanSettings(ctx.siteId),
    getSitePlan(ctx.siteId),
  ]);
  const binding = bindDepartures(departures, sessions, nowMs);
  if (!ctx.replan || settings == null) {
    return plannedStations(
      parseStoredEntries(stored?.plan),
      storedSlotIndex(stored?.slotStarts, nowMs),
      sessions,
    );
  }
  if (binding.writes.length > 0) await bindDepartureSessions(ctx.siteId, binding.writes);
  const storedEntries = parseStoredEntries(stored?.plan);
  const storedIndex = storedSlotIndex(stored?.slotStarts, nowMs);
  const measured = measurePlannedSessions({
    entries: storedEntries,
    slotIndex: storedIndex,
    sessions,
    stations: ctx.stations,
    reservedKw: ctx.reservedKw,
    nowMs,
  });
  logMeasureEvents(ctx, measured);
  const measuredTrigger = measured.events[0]?.event;
  if (binding.writes.length === 0 && measuredTrigger == null && !planNeedsRun(stored, nowMs)) {
    if (measured.changed.length > 0) {
      await patchSitePlanEntries(
        ctx.siteId,
        measured.changed.map((c) => ({ sessionId: c.sessionId, patch: { measure: c.state } })),
      );
    }
    return plannedStations(storedEntries, storedIndex, sessions);
  }

  const ratePeriods = await getElectricityRatePeriodsForSite(ctx.siteId);
  const build = buildPlanInput({
    nowMs,
    bufferMinutes: settings.bufferMinutes,
    timezone: settings.timezone,
    ratePeriods,
    hierarchy: ctx.hierarchy,
    stations: ctx.stations,
    reservedKw: withNotFollowingDraws(ctx.reservedKw, storedEntries, measured.measures),
    previous: ctx.previous,
    departures,
    sessions,
    binding,
    measures: measured.measures,
  });
  const started = performance.now();
  const result = planDepotCharging(build.input);
  const runtimeMs = Math.round(performance.now() - started);
  if (runtimeMs > PLAN_RUNTIME_BUDGET_MS) {
    ctx.log.warn(
      { siteId: ctx.siteId, runtimeMs, vehicles: build.input.vehicles.length },
      'Depot charging plan took longer than its budget',
    );
  }
  const previousBySession = new Map(storedEntries.map((e) => [e.sessionId, e] as const));
  // The writer takes each profile from the row it locks (a reply stored while
  // this plan ran wins); the copy here only serves the readiness below.
  const entries = storedPlanEntries(build, result).map((entry) => {
    const previous = previousBySession.get(entry.sessionId);
    const profile = previous?.profile;
    const measure = measured.measures.get(entry.sessionId) ?? previous?.measure;
    return {
      ...entry,
      ...(profile != null ? { profile } : {}),
      ...(measure != null ? { measure } : {}),
    };
  });
  const written = await writeSitePlan(
    ctx.siteId,
    {
      staleAtRead: stored?.staleAt ?? null,
      trigger: planTrigger(stored, binding.writes.length > 0, measuredTrigger),
      slotStarts: build.input.slots.map((slot) => new Date(slot.startMs).toISOString()),
      plan: entries,
      siteLoadKw: (result.nodeLoadKw[PLAN_SITE_NODE] ?? []).map((kw) => round(kw, 3)),
      capacityKw: (build.input.nodeCapacityKw[PLAN_SITE_NODE] ?? []).map((kw) => round(kw, 3)),
      pricePerKwh: build.input.pricePerKwh,
      runtimeMs,
    },
    withRejectedProfiles(readinessWrites(build, result), entries),
  );
  afterSitePlanWrite(ctx.siteId, written, ctx.log);
  return plannedStations(entries, 0, sessions);
}

function logMeasureEvents(ctx: DepartureAwareContext, measured: PlanMeasurementResult): void {
  for (const e of measured.events) {
    const fields = {
      siteId: ctx.siteId,
      stationDbId: e.stationDbId,
      sessionId: e.sessionId,
      drawKw: e.drawKw,
      limitKw: e.limitKw,
    };
    if (e.event === 'charger_not_following') {
      ctx.log.warn(
        fields,
        'Charger draws more than its plan limit; holding its draw as fixed load',
      );
    } else {
      ctx.log.info({ ...fields, event: e.event }, 'Depot plan measurement changed the plan');
    }
  }
}

/** A departure whose station refused its plan profile is at risk (station limit only). */
export function withRejectedProfiles(
  writes: DepartureReadinessWrite[],
  entries: readonly StoredPlanEntry[],
): DepartureReadinessWrite[] {
  const rejected = new Set(
    entries.filter((e) => e.profile?.state === 'rejected').map((e) => e.departureId),
  );
  if (rejected.size === 0) return writes;
  return writes.map((write) => {
    if (!rejected.has(write.departureId)) return write;
    if (
      write.readinessReason === 'station_offline' ||
      write.readinessReason === 'charger_not_following'
    ) {
      return write;
    }
    const next = withStationIssue(
      { readiness: write.readiness, readinessReason: write.readinessReason },
      'profile_rejected',
    );
    return { ...write, ...next };
  });
}

/** A rejected plan profile is sent again after this long, not every cycle. */
export const PLAN_PROFILE_RETRY_MS = 3_600_000;

/** The plan slots from `index` on, rebuilt from the stored slot starts. */
export function storedSlots(slotStarts: unknown, index: number): PlanSlot[] {
  if (!Array.isArray(slotStarts) || index < 0) return [];
  const starts = (slotStarts as unknown[])
    .map((v) => (typeof v === 'string' ? Date.parse(v) : Number.NaN))
    .filter((v) => Number.isFinite(v));
  const slots: PlanSlot[] = [];
  for (let i = index; i < starts.length; i += 1) {
    const startMs = starts[i] ?? 0;
    const endMs = starts[i + 1] ?? currentSlotStartMs(startMs) + SLOT_MS;
    slots.push({ startMs, endMs, hours: (endMs - startMs) / 3_600_000 });
  }
  return slots;
}

/** One plan profile to send. */
export interface PlanProfileSend {
  sessionId: string;
  stationOcppId: string;
  payload: PlanProfilePayload;
  profile: PlanProfileState;
  previous: PlanProfileState | null;
}

export interface PlanProfileSendInput {
  entries: readonly StoredPlanEntry[];
  sessions: readonly PlanSessionRow[];
  stations: readonly StationPowerInfo[];
  reservedKw: ReadonlyMap<string, number>;
  rates: ReadonlyMap<string, StationRate>;
  /** Period bound per station, and per `stationDbId:evseNumber` the EV's maxScheduleTuples. */
  stationMaxPeriods: ReadonlyMap<string, number>;
  evseMaxTuples: ReadonlyMap<string, number>;
  /** The plan slots from the current one on. */
  slots: readonly PlanSlot[];
  /** Index of the current slot in the stored plan. */
  slotIndex: number;
  nowMs: number;
  /** Phases the EV of each session charges on, when known (charging needs or measured). */
  sessionPhases?: ReadonlyMap<string, number>;
  /** Stations on OCPP 2.1, which take the preconditioningRequest of a period. */
  ocpp21Stations?: ReadonlySet<string>;
}

/**
 * Whether a session's profile may be sent this slot, before its content is
 * known: never sent, a new slot, a cleared profile wanted again, or a refusal
 * more than an hour old. The hash check comes after.
 */
export function profileMaySend(
  previous: PlanProfileState | null,
  slotStartMs: number,
  nowMs: number,
): boolean {
  if (previous == null || previous.state === 'cleared') return true;
  if (previous.state === 'rejected') {
    const rejectedAt = previous.rejectedAt != null ? Date.parse(previous.rejectedAt) : 0;
    return nowMs - rejectedAt >= PLAN_PROFILE_RETRY_MS;
  }
  return previous.slotStartMs !== slotStartMs;
}

/** The planned sessions a cycle could send a profile to (station online, not reserved, may send). */
function sendCandidates(
  input: Pick<PlanProfileSendInput, 'entries' | 'sessions' | 'stations' | 'reservedKw' | 'nowMs'>,
  slotStartMs: number,
): Array<{ entry: StoredPlanEntry; session: PlanSessionRow; station: StationPowerInfo }> {
  const active = new Map(input.sessions.map((s) => [s.id, s]));
  const stationById = new Map(input.stations.map((s) => [s.id, s]));
  const out: Array<{ entry: StoredPlanEntry; session: PlanSessionRow; station: StationPowerInfo }> =
    [];
  for (const entry of plannedEntries(input.entries)) {
    const session = active.get(entry.sessionId);
    const station = stationById.get(entry.stationDbId);
    if (session == null || session.stationDbId !== entry.stationDbId) continue;
    if (station == null || !station.isOnline || input.reservedKw.has(station.id)) continue;
    if (session.evseNumber == null) continue;
    if (!profileMaySend(entry.profile ?? null, slotStartMs, input.nowMs)) continue;
    out.push({ entry, session, station });
  }
  return out;
}

/**
 * The rate of a session's profile: the station's, in the other unit when the
 * station refused this unit for the session (W falls back to A, which needs
 * the circuit), with the EV's phases when it charges on fewer than the circuit.
 */
export function planProfileRate(
  rate: StationRate | undefined,
  rejectedUnits: readonly ChargingRateUnit[] | undefined,
  evPhases: number | undefined,
): { rate: StationRate | undefined; numberPhases: number | undefined } {
  if (rate == null) return { rate: undefined, numberPhases: undefined };
  let unit = rate.rateUnit;
  const refused = rejectedUnits ?? [];
  if (refused.includes(unit)) {
    const other: ChargingRateUnit = unit === 'W' ? 'A' : 'W';
    if (!refused.includes(other)) unit = other;
  }
  let phases = rate.phases;
  let numberPhases: number | undefined;
  if (unit === 'A' && evPhases != null && evPhases >= 1 && evPhases < rate.phases) {
    phases = evPhases;
    numberPhases = evPhases;
  }
  return { rate: { ...rate, rateUnit: unit, phases }, numberPhases };
}

/**
 * The plan profiles a cycle sends: for each planned session still active on
 * an online station without a reservation, its profile from the current slot
 * on, unless it was already sent in this slot, the station holds the same
 * profile, or the station refused one less than an hour ago.
 */
export function planProfileSends(input: PlanProfileSendInput): PlanProfileSend[] {
  const slotStartMs = input.slots[0]?.startMs;
  if (slotStartMs == null) return [];
  const sends: PlanProfileSend[] = [];
  for (const { entry, session, station } of sendCandidates(input, slotStartMs)) {
    if (session.evseNumber == null) continue;
    const previous = entry.profile ?? null;
    const tuples = input.evseMaxTuples.get(`${station.id}:${String(session.evseNumber)}`);
    const maxPeriods = Math.min(
      input.stationMaxPeriods.get(station.id) ?? DEFAULT_PLAN_MAX_PERIODS,
      tuples != null && tuples > 0 ? tuples : Number.POSITIVE_INFINITY,
    );
    // The limit holds the planned charging power plus the preconditioning load.
    const aux = entry.auxKw?.slice(input.slotIndex) ?? [];
    const powerKw = entry.powerKw
      .slice(input.slotIndex)
      .map((kw, i) => snapToMinimum(kw, entry.minKw) + (aux[i] ?? 0));
    const preconditioning =
      input.ocpp21Stations?.has(station.id) === true
        ? entry.preconditioning?.slice(input.slotIndex)
        : undefined;
    const { rate, numberPhases } = planProfileRate(
      input.rates.get(station.id),
      previous?.rejectedUnits,
      input.sessionPhases?.get(session.id),
    );
    const payload = buildChargingPlanProfile({
      stationOcppId: station.stationId,
      evseId: session.evseNumber,
      transactionId: session.transactionId,
      slots: input.slots,
      powerKw,
      rate,
      maxPeriods,
      now: new Date(input.nowMs),
      ...(numberPhases != null ? { numberPhases } : {}),
      ...(preconditioning != null ? { preconditioning } : {}),
    });
    const hash = planProfileHash(payload);
    if (
      previous != null &&
      (previous.state === 'sent' || previous.state === 'accepted') &&
      previous.hash === hash
    ) {
      continue;
    }
    sends.push({
      sessionId: session.id,
      stationOcppId: station.stationId,
      payload,
      previous,
      profile: {
        id: payload.chargingProfile.id,
        hash,
        slotStartMs,
        state: 'sent',
        sentAt: new Date(input.nowMs).toISOString(),
        ...(previous?.rejectedUnits != null ? { rejectedUnits: previous.rejectedUnits } : {}),
      },
    });
  }
  return sends;
}

const PERIOD_BOUND_VARIABLES = ['PeriodsPerSchedule', 'ChargingScheduleMaxPeriods'];

/** Phases an EV asks for in its charging needs (`requestedEnergyTransfer`). */
export function phasesOfEnergyTransfer(transfer: string | null | undefined): number | undefined {
  if (transfer == null) return undefined;
  if (transfer.includes('single_phase')) return 1;
  if (transfer.includes('two_phase')) return 2;
  if (transfer.includes('three_phase')) return 3;
  return undefined;
}

/** A phase counts as drawing above this share of the busiest one (and at least 0.2 kW). */
const MEASURED_PHASE_SHARE = 0.25;

/** Phases a station draws on, from its latest per-phase readings, when it charges one session. */
export function measuredPhases(station: StationPowerInfo): number | undefined {
  const load = station.phasePowerKw;
  if (load == null) return undefined;
  const values = [load.L1, load.L2, load.L3];
  const busiest = Math.max(...values);
  if (!(busiest >= 1)) return undefined;
  return values.filter((kw) => kw >= Math.max(0.2, busiest * MEASURED_PHASE_SHARE)).length;
}

export interface PlanProfileInputs {
  stations: Map<string, number>;
  /** Per `stationDbId:evseNumber`, the EV's maxScheduleTuples of the current session. */
  evses: Map<string, number>;
  /** Phases per session id. */
  phases: Map<string, number>;
  /** Stations that speak OCPP 2.1. */
  ocpp21: Set<string>;
}

/**
 * What each profile depends on beyond the plan: the period bound each station
 * reported (2.x SmartChargingCtrlr.PeriodsPerSchedule, 1.6
 * ChargingScheduleMaxPeriods), and the charging needs of the EV of each
 * session (its maxScheduleTuples and phases), only needs stored since that
 * session started, so an earlier EV's needs never shape the profile. Phases
 * fall back to the station's per-phase readings when the session is alone on
 * the station.
 */
export async function readPlanProfileInputs(
  stations: readonly StationPowerInfo[],
  sessions: readonly PlanSessionRow[],
): Promise<PlanProfileInputs> {
  const inputs: PlanProfileInputs = {
    stations: new Map(),
    evses: new Map(),
    phases: new Map(),
    ocpp21: new Set(),
  };
  const stationDbIds = [...new Set(sessions.map((se) => se.stationDbId))];
  if (stationDbIds.length === 0) return inputs;
  const [configRows, needsRows, protocolRows] = await Promise.all([
    db
      .select({
        stationId: stationConfigurations.stationId,
        value: stationConfigurations.value,
      })
      .from(stationConfigurations)
      .where(
        and(
          inArray(stationConfigurations.stationId, stationDbIds),
          inArray(stationConfigurations.variable, PERIOD_BOUND_VARIABLES),
          eq(stationConfigurations.attributeType, 'Actual'),
        ),
      ),
    db
      .select({
        stationId: evChargingNeeds.stationId,
        evseId: evChargingNeeds.evseId,
        maxScheduleTuples: evChargingNeeds.maxScheduleTuples,
        requestedEnergyTransfer: evChargingNeeds.requestedEnergyTransfer,
        updatedAt: evChargingNeeds.updatedAt,
      })
      .from(evChargingNeeds)
      .where(inArray(evChargingNeeds.stationId, stationDbIds)),
    db
      .select({ id: chargingStations.id, protocol: chargingStations.ocppProtocol })
      .from(chargingStations)
      .where(inArray(chargingStations.id, stationDbIds)),
  ]);
  for (const row of protocolRows) {
    if (isOcpp21(row.protocol)) inputs.ocpp21.add(row.id);
  }
  for (const row of configRows) {
    const bound = Number(row.value);
    if (Number.isInteger(bound) && bound > 0) {
      inputs.stations.set(
        row.stationId,
        Math.min(inputs.stations.get(row.stationId) ?? bound, bound),
      );
    }
  }
  const sessionByEvse = new Map<string, PlanSessionRow>();
  for (const se of sessions) {
    if (se.evseNumber != null) sessionByEvse.set(`${se.stationDbId}:${String(se.evseNumber)}`, se);
  }
  for (const row of needsRows) {
    const key = `${row.stationId}:${String(row.evseId)}`;
    const session = sessionByEvse.get(key);
    if (session == null) continue;
    const startedAt = session.startedAt;
    if (startedAt != null && row.updatedAt.getTime() < startedAt.getTime()) continue;
    if (row.maxScheduleTuples != null && row.maxScheduleTuples > 0) {
      inputs.evses.set(key, row.maxScheduleTuples);
    }
    const phases = phasesOfEnergyTransfer(row.requestedEnergyTransfer);
    if (phases != null) inputs.phases.set(session.id, phases);
  }
  const activeOnStation = new Map<string, number>();
  for (const se of sessions) {
    activeOnStation.set(se.stationDbId, (activeOnStation.get(se.stationDbId) ?? 0) + 1);
  }
  const stationById = new Map(stations.map((st) => [st.id, st]));
  for (const se of sessions) {
    if (inputs.phases.has(se.id) || activeOnStation.get(se.stationDbId) !== 1) continue;
    const station = stationById.get(se.stationDbId);
    const phases = station != null ? measuredPhases(station) : undefined;
    if (phases != null) inputs.phases.set(se.id, phases);
  }
  return inputs;
}

export interface PlanDispatchContext {
  siteId: string;
  hierarchy: HierarchyNode[];
  /** Every station of the site. */
  stations: StationPowerInfo[];
  reservedKw: ReadonlyMap<string, number>;
  /** The allocations last sent: the units each station rejected. */
  previous: readonly AppliedAllocation[] | null;
  log: ServiceLogger;
  nowMs?: number;
  pubsub?: PubSubClient;
}

/** A profile the station may still hold (not cleared, and once sent). */
function liveProfile(profile: PlanProfileState | undefined): profile is PlanProfileState {
  return profile != null && profile.state !== 'cleared' && profile.state !== 'not_sent';
}

/**
 * Clears the TxProfiles of the given plan entries once: each entry is marked
 * `cleared` first (P4), then a ClearChargingProfile by the profile id goes out
 * (queued for an offline station, like every clear). A session that already
 * ended needs no clear: its TxProfile ended with the transaction. A failed
 * publish puts the state back, so the next cycle clears again.
 */
async function clearPlanProfiles(
  siteId: string,
  entries: readonly StoredPlanEntry[],
  sessions: readonly PlanSessionRow[],
  stations: ReadonlyMap<string, string>,
  log: ServiceLogger,
  pubsub: PubSubClient,
  nowMs: number,
): Promise<number> {
  const due = entries.filter((e) => liveProfile(e.profile));
  if (due.length === 0) return 0;
  const active = new Set(sessions.map((se) => se.id));
  const clearedAt = new Date(nowMs).toISOString();
  await patchSitePlanEntries(
    siteId,
    due.map((e) => ({
      sessionId: e.sessionId,
      patch: { profile: { ...e.profile, state: 'cleared', clearedAt } },
    })),
  );
  let cleared = 0;
  const failed: StoredPlanEntry[] = [];
  for (const entry of due) {
    const stationOcppId = stations.get(entry.stationDbId);
    if (!active.has(entry.sessionId) || stationOcppId == null || entry.profile == null) continue;
    try {
      await publishOcppCommand(pubsub, {
        stationId: stationOcppId,
        action: 'ClearChargingProfile',
        payload: { chargingProfileId: entry.profile.id },
      });
      cleared += 1;
    } catch (err: unknown) {
      log.warn(
        { err, siteId, stationId: stationOcppId, sessionId: entry.sessionId },
        'Plan profile not cleared, the next cycle clears it again',
      );
      failed.push(entry);
    }
  }
  if (failed.length > 0) {
    try {
      await patchSitePlanEntries(
        siteId,
        failed.map((e) => ({
          sessionId: e.sessionId,
          patch: { profile: e.profile as unknown as Record<string, unknown> },
        })),
      );
    } catch (err: unknown) {
      log.warn({ err, siteId }, 'Plan profile state not restored after a failed clear');
    }
  }
  return cleared;
}

export interface PlanClearContext {
  siteId: string;
  stations: StationPowerInfo[];
  log: ServiceLogger;
  nowMs?: number;
  pubsub?: PubSubClient;
}

/**
 * Clears every plan TxProfile of a site that no longer follows its plan
 * (strategy changed, fleet charging off). Returns the number of clears sent.
 */
export async function clearDepotPlanProfiles(ctx: PlanClearContext): Promise<number> {
  const stored = await getSitePlan(ctx.siteId);
  const entries = parseStoredEntries(stored?.plan);
  if (!entries.some((e) => liveProfile(e.profile))) return 0;
  const sessions = await listPlanSessions(ctx.stations.map((st) => st.id));
  return clearPlanProfiles(
    ctx.siteId,
    entries,
    sessions,
    new Map(ctx.stations.map((st) => [st.id, st.stationId])),
    ctx.log,
    ctx.pubsub ?? getPubSub(),
    ctx.nowMs ?? Date.now(),
  );
}

/**
 * Clears every live plan TxProfile of a site whose load management was turned
 * off: no cycle runs for it any more, so nothing else would. Returns the number
 * of clears sent.
 */
export async function clearSitePlanProfiles(
  siteId: string,
  log: ServiceLogger,
  options: { pubsub?: PubSubClient; nowMs?: number } = {},
): Promise<number> {
  const stored = await getSitePlan(siteId);
  const entries = parseStoredEntries(stored?.plan);
  const due = entries.filter((e) => liveProfile(e.profile));
  if (due.length === 0) return 0;
  const stationDbIds = [...new Set(due.map((e) => e.stationDbId))];
  const [stations, sessions] = await Promise.all([
    db
      .select({ id: chargingStations.id, stationId: chargingStations.stationId })
      .from(chargingStations)
      .where(and(inArray(chargingStations.id, stationDbIds), isOperatorStation())),
    listPlanSessions(stationDbIds),
  ]);
  return clearPlanProfiles(
    siteId,
    entries,
    sessions,
    new Map(stations.map((st) => [st.id, st.stationId])),
    log,
    options.pubsub ?? getPubSub(),
    options.nowMs ?? Date.now(),
  );
}

/**
 * Sends the plan profiles of a departure-aware site after its station
 * limits: the station limit stays the ceiling (a station that refuses the
 * profile is held by its limit, the sum of its planned sessions). The sent
 * state is stored in the plan before each publish, and put back when the
 * publish fails, so the next cycle sends it again. Sessions that left the plan
 * get their profile cleared; with fleet charging off every profile is cleared.
 * Returns the number of profiles sent.
 */
export async function dispatchDepotPlanProfiles(ctx: PlanDispatchContext): Promise<number> {
  const nowMs = ctx.nowMs ?? Date.now();
  const pubsub = ctx.pubsub ?? getPubSub();
  if (!(await isFleetChargingEnabled())) {
    await clearDepotPlanProfiles({ ...ctx, nowMs, pubsub });
    return 0;
  }
  const stationIds = ctx.stations.map((s) => s.id);
  const [stored, sessions] = await Promise.all([
    getSitePlan(ctx.siteId),
    listPlanSessions(stationIds),
  ]);
  if (stored == null) return 0;
  const entries = parseStoredEntries(stored.plan);
  const left = entries.filter((e) => e.left === true);
  if (left.length > 0) {
    await clearPlanProfiles(
      ctx.siteId,
      left,
      sessions,
      new Map(ctx.stations.map((st) => [st.id, st.stationId])),
      ctx.log,
      pubsub,
      nowMs,
    );
  }
  const slotIndex = storedSlotIndex(stored.slotStarts, nowMs);
  const slots = storedSlots(stored.slotStarts, slotIndex);
  const slotStartMs = slots[0]?.startMs;
  if (slotStartMs == null || entries.length === 0) return 0;
  // Nothing due this slot: no profile reads at all.
  if (
    sendCandidates(
      { entries, sessions, stations: ctx.stations, reservedKw: ctx.reservedKw, nowMs },
      slotStartMs,
    ).length === 0
  ) {
    return 0;
  }
  const rejected = new Map<string, readonly ChargingRateUnit[]>();
  for (const a of ctx.previous ?? []) {
    if (a.rejectedUnits != null) rejected.set(a.stationDbId, a.rejectedUnits);
  }
  const inputs = await readPlanProfileInputs(ctx.stations, sessions);
  const sends = planProfileSends({
    entries,
    sessions,
    stations: ctx.stations,
    reservedKw: ctx.reservedKw,
    rates: stationRates(ctx.hierarchy, rejected),
    stationMaxPeriods: inputs.stations,
    evseMaxTuples: inputs.evses,
    sessionPhases: inputs.phases,
    ocpp21Stations: inputs.ocpp21,
    slots,
    slotIndex,
    nowMs,
  });
  if (sends.length === 0) return 0;
  await patchSitePlanEntries(
    ctx.siteId,
    sends.map((send) => ({
      sessionId: send.sessionId,
      patch: { profile: send.profile as unknown as Record<string, unknown> },
    })),
  );
  let sent = 0;
  const failed: PlanProfileSend[] = [];
  for (const send of sends) {
    try {
      await publishOcppCommand(pubsub, {
        stationId: send.stationOcppId,
        action: 'SetChargingProfile',
        payload: send.payload as unknown as Record<string, unknown>,
        noQueue: true,
      });
      sent += 1;
    } catch (err: unknown) {
      ctx.log.warn(
        { err, siteId: ctx.siteId, stationId: send.stationOcppId, sessionId: send.sessionId },
        'Plan profile not sent, the next cycle sends it again',
      );
      failed.push(send);
    }
  }
  if (failed.length > 0) {
    try {
      await patchSitePlanEntries(
        ctx.siteId,
        failed.map((send) => ({
          sessionId: send.sessionId,
          patch: {
            profile:
              send.previous != null ? (send.previous as unknown as Record<string, unknown>) : null,
          },
        })),
      );
    } catch (err: unknown) {
      ctx.log.warn(
        { err, siteId: ctx.siteId },
        'Plan profile state not restored after a failed send',
      );
    }
  }
  return sent;
}

/**
 * The allocation of a departure-aware site, or null when fleet charging is off
 * (the caller shares power equally). Planned stations get their slot power, the
 * rest share what is left, and the panel and phase limits cut everything. A cut
 * of a planned station marks the plan stale, so the next cycle plans with the
 * new headroom.
 */
export async function departureAwareAllocation(
  ctx: DepartureAwareContext,
): Promise<AllocationResult[] | null> {
  if (!(await isFleetChargingEnabled())) return null;
  const planned = await departureAwarePlan(ctx);
  // A plan never asks a station for more than it can take (the cycle caps it too).
  const maxById = new Map(ctx.stations.map((s) => [s.id, s.maxPowerKw]));
  const kw = new Map(
    [...planned.plannedKw].map(([id, value]) => {
      const max = maxById.get(id) ?? 0;
      return [id, max > 0 ? Math.min(value, max) : value] as const;
    }),
  );
  const input: PlannedAllocationInput = {
    kw,
    sharing: planned.sharing,
    minKw: planned.minKw,
  };
  const allocations = computeHierarchicalAllocation(
    ctx.hierarchy,
    'departure_aware',
    ctx.reservedKw,
    input,
  );
  if (ctx.replan && plannedStationCut(allocations, kw)) {
    await markSitePlanStale(ctx.siteId, 'capacity_reduced', ctx.log);
  }
  return allocations;
}
