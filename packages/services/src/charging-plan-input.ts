// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Departure-aware allocation of a depot site: builds the planner input from the
// site's panel and circuit tree, binds departures to the sessions charging for
// them, plans when the stored plan is stale, writes the plan and the readiness
// of every departure (writeSitePlan), and turns the current slot of the plan
// into fixed allocations for the load management cycle.

import {
  type DepartureReadinessWrite,
  type PlanDepartureRow,
  type PlanSessionRow,
} from '@evtivity/database';
import { resolveElectricityRate } from '@evtivity/lib';
import type { ElectricityRatePeriod } from '@evtivity/lib';
import { mightEnforceKw } from './load-limit-entries.js';
import {
  buildPlanSlots,
  neededEnergyKwh,
  withStationIssue,
  SOC_FRESH_MINUTES,
  type DepartureReadinessResult,
  type NeededEnergyInput,
  type PlanInput,
  type PlanResult,
  type PlanSlot,
  type PlanVehicleInput,
} from '@evtivity/lib/charging-plan';
import { acSessionKwAt, stationDemandLimitKw } from './load-management-allocation.js';
import { type HierarchyNode, type StationPowerInfo } from './load-management-model.js';
import { type AppliedAllocation } from './load-limit-entries.js';
import { type PlanMeasureState } from './charging-plan-measurement.js';
import type { DepartureBinding } from './charging-plan-binding.js';
import {
  buildPlanNodes,
  UNPLANNED_HOLD_SLOTS,
  PLAN_SITE_NODE,
  holdNodeId,
  UNLIMITED_KW,
  type PlanNodes,
} from './charging-plan-nodes.js';
import type { StoredPlanEntry } from './charging-plan-stored.js';

/**
 * The most an AC session may draw under its tariff current limit, kW at its
 * station's circuit and its phases; null without a limit (or for DC).
 */
export function sessionTariffCapKw(
  station: StationPowerInfo | null | undefined,
  sessionId: string,
): number | null {
  if (station == null) return null;
  const session = station.sessions?.find((s) => s.sessionId === sessionId);
  if (session == null || session.kind !== 'ac' || session.tariffMaxCurrentA == null) return null;
  return acSessionKwAt(station, session.phases, session.tariffMaxCurrentA);
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
            sessionTariffCapKw(station, session.id),
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
      // What the station might enforce now (its limit record), not the allocation wanted.
      const last = previousById.get(stationDbId);
      const might = last != null ? mightEnforceKw(last, { nowMs: Date.now() }) : null;
      if (last != null && last.reserved !== true) candidates.push(might ?? station.maxPowerKw);
      candidates.push(station.currentDrawKw);
    }
    let kw = Math.max(0, ...candidates);
    const limitKw = stationDemandLimitKw(station);
    if (limitKw > 0) kw = Math.min(kw, limitKw);
    for (const use of path) {
      holdKw.set(use.nodeId, (holdKw.get(use.nodeId) ?? 0) + kw * use.weight);
    }
  }
  return holdKw;
}

export function round(value: number, digits: number): number {
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
