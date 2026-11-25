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
  listPlanDepartures,
  listPlanSessions,
  markSitePlanStale,
  patchSitePlanEntries,
  writeSitePlan,
  type DepartureReadinessWrite,
  type PlanSessionRow,
  type StoredSitePlan,
} from '@evtivity/database';
import type { ServiceLogger } from '@evtivity/lib';
import { afterSitePlanWrite } from './departure-notice.service.js';
import { planDepotCharging, withStationIssue } from '@evtivity/lib/charging-plan';
import {
  computeHierarchicalAllocation,
  stationDemandLimitKw,
} from './load-management-allocation.js';
import {
  type PlannedAllocationInput,
  type AllocationResult,
  type HierarchyNode,
  type StationPowerInfo,
} from './load-management-model.js';
import { limitSettlesOnReplies, type AppliedAllocation } from './load-limit-entries.js';
import {
  PROFILE_SETTLE_MS,
  evaluatePlanMeasurement,
  type PlanMeasureEvent,
  type PlanMeasureState,
} from './charging-plan-measurement.js';
import {
  type StoredPlanEntry,
  type PlanProfileState,
  currentSlotStartMs,
  plannedEntries,
  snapToMinimum,
  type PlannedStations,
  plannedStations,
  parseStoredEntries,
  storedSlotIndex,
  planNeedsRun,
  plannedStationCut,
} from './charging-plan-stored.js';
import {
  plannedSessionDrawKw,
  buildPlanInput,
  storedPlanEntries,
  round,
  readinessWrites,
} from './charging-plan-input.js';
import {
  PLAN_READINESS_AHEAD_MS,
  PLAN_RUNTIME_BUDGET_MS,
  PLAN_SITE_NODE,
} from './charging-plan-nodes.js';
import { bindDepartures } from './charging-plan-binding.js';

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
  // An online station reserved only until its replies (a limit still unknown,
  // or sent and awaiting its answer) takes its own reservation out of the
  // headroom: the plan made now is provisional, and the cycle after the replies
  // plans again on the confirmed limits. A reservation that lasts (an offline
  // station, a refused or lost limit) is planned around as it is.
  const online = new Set(ctx.stations.filter((st) => st.isOnline).map((st) => st.id));
  const previousById = new Map((ctx.previous ?? []).map((p) => [p.stationDbId, p]));
  const settling = (id: string): boolean => {
    if (!ctx.reservedKw.has(id) || !online.has(id)) return false;
    return limitSettlesOnReplies(previousById.get(id));
  };
  if (entries.some((e) => settling(e.stationDbId))) {
    await markSitePlanStale(ctx.siteId, 'limits_unconfirmed', ctx.log);
  }
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
  const maxById = new Map(ctx.stations.map((s) => [s.id, stationDemandLimitKw(s)]));
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
