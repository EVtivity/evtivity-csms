// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Departure-aware allocation of a depot site: builds the planner input from the
// site's panel and circuit tree, binds departures to the sessions charging for
// them, plans when the stored plan is stale, writes the plan and the readiness
// of every departure (writeSitePlan), and turns the current slot of the plan
// into fixed allocations for the load management cycle.

import {
  getSitePlan,
  isFleetChargingEnabled,
  isOperatorStation,
  listPlanSessions,
  patchSitePlanEntries,
  db,
  chargingStations,
  type PlanSessionRow,
} from '@evtivity/database';
import { and, inArray } from 'drizzle-orm';
import { publishOcppCommand } from '@evtivity/lib';
import type { LoadAllocationStrategy, PubSubClient, ServiceLogger } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import type { EvseLimitResult } from './evse-limits.js';
import { stationRates } from './load-management-send.js';
import {
  type ChargingRateUnit,
  type HierarchyNode,
  type StationPowerInfo,
} from './load-management-model.js';
import { type AppliedAllocation } from './load-limit-entries.js';
import { sessionTariffCapKw } from './charging-plan-input.js';
import {
  type PlanProfileState,
  type StoredPlanEntry,
  parseStoredEntries,
  storedSlotIndex,
} from './charging-plan-stored.js';
import {
  storedSlots,
  sendCandidates,
  readPlanProfileInputs,
  planProfileSends,
  type PlanProfileSend,
} from './charging-plan-profile-sends.js';

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
  /** This cycle's EVSE limits of the stations limited per EVSE, by station database id. */
  evseLimits?: ReadonlyMap<string, readonly EvseLimitResult[]>;
}

/**
 * The most each charging session of the site may draw in its plan profile:
 * its tariff limit, and on a station limited per EVSE the EVSE limit held by
 * the session's own maximum (its tariff or its connector rating). A limit set
 * by the station's share is left out: the plan already splits the station.
 */
export function planSessionCapsKw(
  stations: readonly StationPowerInfo[],
  evseLimits: ReadonlyMap<string, readonly EvseLimitResult[]> = new Map(),
): Map<string, number> {
  const caps = new Map<string, number>();
  const lower = (sessionId: string, kw: number | null): void => {
    if (kw == null || !Number.isFinite(kw) || kw < 0) return;
    const held = caps.get(sessionId);
    caps.set(sessionId, held != null ? Math.min(held, kw) : kw);
  };
  for (const station of stations) {
    for (const session of station.sessions ?? []) {
      lower(session.sessionId, sessionTariffCapKw(station, session.sessionId));
    }
    for (const limit of evseLimits.get(station.id) ?? []) {
      if (limit.reason === 'tariff_limit' || limit.reason === 'connector_max') {
        lower(limit.sessionId, limit.limitKw);
      }
    }
  }
  return caps;
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
 * The sessions whose TxProfile the depot plan owns: on a departure-aware site
 * with fleet charging on, every planned session; on any site, a session whose
 * station may still hold its plan profile (its clear is still due, and a
 * profile sent with the same id would be cleared with it).
 */
export async function planOwnedSessionIds(
  siteId: string,
  strategy: LoadAllocationStrategy,
): Promise<Set<string>> {
  const stored = await getSitePlan(siteId);
  const entries = parseStoredEntries(stored?.plan);
  if (entries.length === 0) return new Set();
  const planning = strategy === 'departure_aware' && (await isFleetChargingEnabled());
  return new Set(
    entries
      .filter((e) => (planning && e.left !== true) || liveProfile(e.profile))
      .map((e) => e.sessionId),
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
    sessionCapKw: planSessionCapsKw(ctx.stations, ctx.evseLimits),
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
