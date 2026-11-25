// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, inArray } from 'drizzle-orm';
import { db, chargingProfiles } from '@evtivity/database';
import {
  creditMayHold,
  limitReservations,
  mightEnforceInWatts,
  mightEnforceKw,
  retryStationIds,
  type AppliedAllocation,
  type AppliedCredit,
  type StoredLimit,
} from './load-limit-entries.js';
import type { LoadAllocationStrategy, ServiceLogger } from '@evtivity/lib';
import { createLogger } from '@evtivity/lib';
import { profiledLimit, UNKNOWN_LIMIT, type LimitRecord } from '@evtivity/lib/load-limit-state';
import type { EvseLimitResult } from './evse-limits.js';
import { stationProfileWatts } from './evse-limits.js';
import type { AppliedEvseLimit, EvseDefaultValue } from './evse-limit-profiles.js';
import {
  type HierarchyNode,
  type StationPowerInfo,
  type AllocationResult,
  EPSILON_KW,
  type PhaseLoad,
} from './load-management-model.js';
import { withoutAssetReadings, splitCreditLimits } from './load-management-credit-split.js';
import {
  computeHierarchicalAllocation,
  stationStopKw,
  withSendRateUnits,
  boxCappedKw,
  stationSplitWeights,
} from './load-management-allocation.js';
import {
  type StationRate,
  profileLimitKw,
  profileRateUnit,
  isLoadManagementProfile,
  isLoadManagementCreditProfile,
  loadManagementCreditProfileId,
} from './load-management-profiles.js';
import type { EnergyAssetsKnowledge } from './load-management-energy-assets.js';
import { selectSessionPhases, siteEvseLimits } from './load-management-phase-selection.js';
import { stationRates } from './load-management-send.js';
import { startAllowances } from './load-management-allowances.js';
import { departureAwareOrEqualShare } from './load-management-plan-bridge.js';
import { unitBoxPlan } from './load-management-unit-boxes.js';
import { getSitePowerStatus } from './load-management-site-status.js';
import { buildSiteHierarchyWithAssets } from './load-management-hierarchy.js';

const logger = createLogger('load-management');

function managedStations(nodes: readonly HierarchyNode[], into: StationPowerInfo[]): void {
  for (const node of nodes) {
    into.push(...node.stations);
    managedStations(node.children, into);
  }
}

/**
 * The limits sent to the stations counted at their reservation (an
 * unconfirmed, refused or unknown limit). Each is fitted alone: it takes part
 * at its reservation as a cap, every other reserved station stays at its
 * reservation (it may not apply what it is sent, which is why it is reserved)
 * and every other station at the higher of what this cycle gives it and the
 * limit it might enforce now (`committedKw`). A retry goes out unordered (a
 * reserved station's limit is not awaited), so it never rests on a cut of the
 * same cycle, which may not land: two reserved stations fitted together, or a
 * retry fitted on another station's unconfirmed cut, put both shares on one
 * circuit when the other kept its old limit (found by the property test). Room
 * a cut frees reaches the retry in the next cycle, once the cut is confirmed.
 * Computed on the tree without battery and solar readings, since the limit
 * goes out without readings.
 */
export function reservedStationLimitsKw(
  roots: readonly HierarchyNode[],
  strategy: LoadAllocationStrategy,
  reservedKw: ReadonlyMap<string, number>,
  allocations: readonly AllocationResult[],
  stationDbIds: readonly string[],
  committedKw: ReadonlyMap<string, number> = new Map(),
): Map<string, number> {
  const limits = new Map<string, number>();
  const ids = stationDbIds.filter((id) => (reservedKw.get(id) ?? 0) > 0);
  for (const id of stationDbIds) limits.set(id, 0);
  if (ids.length === 0) return limits;
  const base = withoutAssetReadings(roots);
  for (const id of ids) {
    const tree = structuredClone(base);
    const found: { station: StationPowerInfo | null } = { station: null };
    const walk = (nodes: HierarchyNode[]): void => {
      for (const node of nodes) {
        node.stations = node.stations.map((station) => {
          if (station.id !== id) return station;
          const retried: StationPowerInfo = {
            ...station,
            isOnline: true,
            hasActiveSession: true,
            minPowerKw: station.hasActiveSession ? station.minPowerKw : 0,
          };
          found.station = retried;
          return retried;
        });
        walk(node.children);
      }
    };
    walk(tree);
    const retried = found.station;
    if (retried == null) continue;
    const fixed = new Map(reservedKw);
    fixed.delete(id);
    for (const [other, kw] of committedKw) {
      if (other !== id && !reservedKw.has(other)) fixed.set(other, kw);
    }
    for (const allocation of allocations) {
      const other = allocation.stationDbId;
      if (other !== id && !reservedKw.has(other)) {
        fixed.set(other, Math.max(allocation.allocatedKw, committedKw.get(other) ?? 0));
      }
    }
    const reservation = reservedKw.get(id) ?? 0;
    const result = computeHierarchicalAllocation(tree, strategy, fixed, {
      kw: new Map([[id, reservation]]),
    }).find((a) => a.stationDbId === id);
    const limit = Math.max(0, Math.min(reservation, result?.allocatedKw ?? 0));
    // A retry held below the station's minimum (by its reservation) pauses it instead.
    limits.set(id, limit < stationStopKw(retried) - EPSILON_KW ? 0 : limit);
  }
  return limits;
}

/**
 * The stored accepted load management profiles of stations without an entry
 * (`charging_profiles`, source csms_set), as the records a first entry starts
 * from: the stack level 1 limit as a profiled record in the unit it was sent
 * in, and a credit profile (stack level 2) that may still hold as the credit
 * record until its `validTo`, so the credit path replaces or ends it.
 */
export async function storedLimitsOf(
  stations: readonly StationPowerInfo[],
  rates: ReadonlyMap<string, StationRate>,
  nowMs: number = Date.now(),
): Promise<Map<string, StoredLimit>> {
  const result = new Map<string, StoredLimit>();
  if (stations.length === 0) return result;
  const byId = new Map(stations.map((s) => [s.id, s]));
  const rows = await db
    .select({ stationId: chargingProfiles.stationId, profileData: chargingProfiles.profileData })
    .from(chargingProfiles)
    .where(
      and(
        inArray(chargingProfiles.stationId, [...byId.keys()]),
        eq(chargingProfiles.source, 'csms_set'),
      ),
    );
  const bases = new Map<string, LimitRecord>();
  const credits = new Map<string, AppliedCredit>();
  for (const row of rows) {
    const station = byId.get(row.stationId);
    const data = row.profileData as Record<string, unknown> | null;
    if (station == null || data == null) continue;
    const id = data['id'] ?? data['chargingProfileId'];
    const kw = profileLimitKw(data, rates.get(row.stationId));
    if (kw == null) continue;
    const watts = profileRateUnit(data) !== 'A';
    if (isLoadManagementProfile(data) && id === station.profileId) {
      bases.set(row.stationId, profiledLimit(kw, watts));
      continue;
    }
    const validTo = data['validTo'];
    if (
      isLoadManagementCreditProfile(data) &&
      id === loadManagementCreditProfileId(station.profileId) &&
      typeof validTo === 'string' &&
      creditMayHold(validTo, nowMs)
    ) {
      credits.set(row.stationId, { limit: profiledLimit(kw, watts), until: validTo });
    }
  }
  for (const stationId of new Set([...bases.keys(), ...credits.keys()])) {
    const credit = credits.get(stationId);
    // A credit profile alone: the stack level 1 limit is not known.
    result.set(stationId, {
      limit: bases.get(stationId) ?? UNKNOWN_LIMIT,
      ...(credit != null ? { credit } : {}),
    });
  }
  return result;
}

/** What `allocateSite` returns: the allocation of one cycle. */
export interface SiteAllocation {
  hierarchy: HierarchyNode[];
  managed: StationPowerInfo[];
  reservedKw: Map<string, number>;
  allocations: AllocationResult[];
  /**
   * The limit without readings of each station whose allocation rests on a
   * fresh battery or solar reading (`splitCreditLimits`, security case 334).
   */
  baseKw: Map<string, number>;
  /** End of the credit limits, ms; null without one. */
  creditValidToMs: number | null;
  /**
   * The limit of each charging EVSE of the managed stations limited per EVSE
   * (`effectiveBalancingMode`), by station database id, split from the
   * station's allocation.
   */
  evseLimits: Map<string, EvseLimitResult[]>;
  /** The unit box TxDefaultProfiles of each station limited per EVSE (`unitBoxPlan`). */
  evseDefaults: Map<string, EvseDefaultValue[]>;
  /**
   * Stations sent above a unit box budget because their box defaults hold the
   * box: the raise claim checks the stored records again with this.
   */
  boxChecks: Map<string, (entry: AppliedAllocation) => boolean>;
  /** The retry limit of each reserved online station, fitted with the other reserved ones. */
  retries: AllocationResult[];
  /** The stored accepted profile of each managed station without an entry. */
  storedLimits: Map<string, StoredLimit>;
  /** Energy assets were not read and are not known: the send holds every raise. */
  holdRaises: boolean;
}

/**
 * The allocation of one cycle over a site tree already read: reservations,
 * held EVSE limits, phase selection, start allowances, the allocation, the
 * credit split, the per-phase weights, the retries and the EVSE limits.
 * `storedLimits` is the stored accepted profile of each managed station
 * without an entry. Reads the database only for a departure-aware site.
 */
/**
 * An allocation held to the station's unit boxes: at most the box cap (`capKw`),
 * or 0 when its boxes cannot carry its minimum (`UnitBoxPlan.carriesMinimum`).
 */
export function holdToBoxes(
  a: AllocationResult,
  station: StationPowerInfo | undefined,
  capKw: number | undefined,
  carries: boolean,
): AllocationResult {
  // The cap holds what the station is sent: a limit split per phase goes out
  // at three times its busiest share.
  const sentKw = stationProfileWatts(a.allocatedKw, a.phaseWeights) / 1000;
  if (carries && (capKw == null || sentKw <= capKw + EPSILON_KW)) return a;
  // Never above the allocation the hierarchy counted, nor the box cap.
  const capped =
    capKw == null ? a.allocatedKw : station != null ? boxCappedKw(station, capKw) : capKw;
  const kw = carries ? Math.min(a.allocatedKw, capped) : 0;
  // Sent as is (no per-phase split, which would send it above the box again).
  const held: AllocationResult = { ...a, allocatedKw: kw, limitedBy: 'unit_budget' };
  delete held.phaseWeights;
  return held;
}

export async function allocateSite(input: {
  siteId: string;
  strategy: LoadAllocationStrategy;
  hierarchy: HierarchyNode[];
  stations: StationPowerInfo[];
  previous: readonly AppliedAllocation[] | null;
  storedLimits: Map<string, StoredLimit>;
  energyAssets: EnergyAssetsKnowledge;
  nowMs: number;
  replan?: boolean;
  log?: ServiceLogger;
}): Promise<SiteAllocation> {
  const { siteId, strategy, hierarchy, previous, storedLimits, nowMs } = input;
  const managed: StationPowerInfo[] = [];
  managedStations(hierarchy, managed);
  withSendRateUnits(managed, previous);
  const previousEntries = new Map((previous ?? []).map((a) => [a.stationDbId, a]));
  for (const station of managed) {
    station.heldWattLimit = mightEnforceInWatts(previousEntries.get(station.id), {
      nowMs,
      storedLimit: storedLimits.get(station.id) ?? null,
    });
  }
  const reservedKw = limitReservations(managed, previous, { nowMs, storedLimits });
  withHeldEvseLimits(managed, previous);
  selectSessionPhases(hierarchy, nowMs);
  // Idle stations hold their start allowance, as far as it fits after the
  // active sessions: counted as fixed load, so the first session of any of
  // them starts inside the budget. It goes out with no end, so it never rests
  // on a battery or solar credit, which ends with its reading.
  const rates = stationRates(hierarchy);
  // An idle station's allowance is held to its unit boxes before it counts as
  // fixed load, so the others never leave room for power it is not sent.
  const byStation = new Map(managed.map((s) => [s.id, s]));
  const allowances = startAllowances(
    withoutAssetReadings(hierarchy),
    strategy,
    managed,
    reservedKw,
    rates,
  ).map((a) => {
    const station = byStation.get(a.stationDbId);
    if (station == null) return a;
    const plan = unitBoxPlan(station, previousEntries.get(station.id), [], rates.get(station.id), {
      sendDefaults: false,
    });
    return holdToBoxes(a, station, plan.capKw ?? undefined, plan.carriesMinimum);
  });
  const fixedKw = new Map(reservedKw);
  for (const a of allowances) fixedKw.set(a.stationDbId, a.allocatedKw);
  let allocations: AllocationResult[] = [];
  if (hierarchy.length > 0) {
    allocations =
      strategy === 'departure_aware'
        ? await departureAwareOrEqualShare(siteId, input.stations, hierarchy, fixedKw, previous, {
            replan: input.replan === true,
            log: input.log ?? logger,
            nowMs,
          })
        : computeHierarchicalAllocation(hierarchy, strategy, fixedKw);
  }
  const split = splitCreditLimits(hierarchy, strategy, fixedKw, allocations, managed, nowMs);
  // The depot plan checks its slots per phase evenly, so its stations keep the even spread.
  const weighted =
    strategy === 'departure_aware'
      ? split.allocations
      : withPhaseWeights(split.allocations, hierarchy);
  const allocated = [...weighted, ...allowances];
  // A reserved online station is sent a retry limit that fits whatever the
  // other stations still enforce, whether or not this cycle's cuts land.
  const retryIds = retryStationIds(managed, previous, nowMs, storedLimits);
  const previousById = new Map((previous ?? []).map((a) => [a.stationDbId, a]));
  const committedKw = new Map<string, number>();
  for (const station of managed) {
    if (reservedKw.has(station.id)) continue;
    const kw = mightEnforceKw(previousById.get(station.id), {
      nowMs,
      storedLimit: storedLimits.get(station.id) ?? null,
    });
    if (kw != null) committedKw.set(station.id, kw);
  }
  const retryLimits = reservedStationLimitsKw(
    hierarchy,
    strategy,
    reservedKw,
    allocated,
    retryIds,
    committedKw,
  );
  const byId = new Map(managed.map((s) => [s.id, s]));
  const retries: AllocationResult[] = retryIds.map((id) => ({
    stationId: byId.get(id)?.stationId ?? id,
    stationDbId: id,
    allocatedKw: retryLimits.get(id) ?? 0,
    currentDrawKw: byId.get(id)?.currentDrawKw ?? 0,
  }));
  const evseLimits = siteEvseLimits(managed, weighted, rates, strategy);
  const boxCaps = new Map<string, number>();
  const boxShort = new Set<string>();
  const evseDefaults = new Map<string, EvseDefaultValue[]>();
  const boxChecks = new Map<string, (entry: AppliedAllocation) => boolean>();
  for (const station of managed) {
    const limits = evseLimits.get(station.id) ?? [];
    const rate = rates.get(station.id);
    // A reserved station is sent no defaults: it keeps the ones it holds.
    const sendDefaults = station.isOnline && !reservedKw.has(station.id);
    const plan = unitBoxPlan(station, previousById.get(station.id), limits, rate, { sendDefaults });
    if (plan.capKw != null) boxCaps.set(station.id, plan.capKw);
    if (!plan.carriesMinimum) boxShort.add(station.id);
    if (plan.defaults.length > 0) evseDefaults.set(station.id, plan.defaults);
    if (plan.heldByDefaults) {
      boxChecks.set(
        station.id,
        (entry) => unitBoxPlan(station, entry, limits, rate, { sendDefaults }).capKw == null,
      );
    }
  }
  const capped = (list: AllocationResult[]): AllocationResult[] =>
    list.map((a) =>
      holdToBoxes(
        a,
        byId.get(a.stationDbId),
        boxCaps.get(a.stationDbId),
        !boxShort.has(a.stationDbId),
      ),
    );
  const baseKw = new Map(split.baseKw);
  for (const [id, kw] of baseKw) {
    const cap = boxCaps.get(id);
    if (cap != null && kw > cap) baseKw.set(id, cap);
  }
  return {
    hierarchy,
    managed,
    reservedKw,
    allocations: capped(allocated),
    baseKw,
    creditValidToMs: split.validToMs,
    evseLimits,
    evseDefaults,
    boxChecks,
    retries: capped(retries),
    storedLimits,
    holdRaises: input.energyAssets === 'unknown',
  };
}

/**
 * Current allocation of a site: its power status, its hierarchy, the power
 * kept for offline stations and for stations with an unconfirmed limit, and
 * the allocations of the others.
 *
 * A `departure_aware` site with fleet charging on follows its depot plan
 * (`departureAwareAllocation`); with it off, or when planning fails, it shares
 * power equally. `replan` (the cycle only) lets the planner bind sessions and
 * write a new plan; without it the stored plan is only read.
 */
export async function computeSiteAllocation(
  siteId: string,
  strategy: LoadAllocationStrategy,
  previous: readonly AppliedAllocation[] | null,
  options: {
    replan?: boolean;
    log?: ServiceLogger;
    nowMs?: number;
    /** ENERGY_ASSETS_ALLOW_SIMULATED of the calling process. */
    allowSimulatedEnergyAssets?: boolean;
  } = {},
): Promise<SiteAllocation & { status: { totalDrawKw: number; stations: StationPowerInfo[] } }> {
  const nowMs = options.nowMs ?? Date.now();
  const status = await getSitePowerStatus(siteId);
  const { roots: hierarchy, energyAssets } = await buildSiteHierarchyWithAssets(
    siteId,
    status.stations,
    {
      ...(options.nowMs != null ? { nowMs: options.nowMs } : {}),
      ...(options.log != null ? { log: options.log } : {}),
      allowSimulatedEnergyAssets: options.allowSimulatedEnergyAssets === true,
    },
  );
  const managed: StationPowerInfo[] = [];
  managedStations(hierarchy, managed);
  // A station without an entry holds what its stored accepted profile holds
  // (one read per cycle); a failed read leaves those stations unknown.
  const withEntry = new Set((previous ?? []).map((a) => a.stationDbId));
  const withoutEntry = managed.filter((s) => !withEntry.has(s.id));
  let storedLimits = new Map<string, StoredLimit>();
  if (withoutEntry.length > 0) {
    try {
      storedLimits = await storedLimitsOf(withoutEntry, stationRates(hierarchy), nowMs);
    } catch (err: unknown) {
      (options.log ?? logger).warn(
        { err, siteId },
        'Stored station limits not read, those stations count as unlimited',
      );
    }
  }
  const allocation = await allocateSite({
    siteId,
    strategy,
    hierarchy,
    stations: status.stations,
    previous,
    storedLimits,
    energyAssets,
    nowMs,
    replan: options.replan === true,
    ...(options.log != null ? { log: options.log } : {}),
  });
  return { status, ...allocation };
}

/** Marks the allocations of the stations split per phase with their phase shares. */
export function withPhaseWeights(
  allocations: readonly AllocationResult[],
  hierarchy: readonly HierarchyNode[],
): AllocationResult[] {
  const weightsById = new Map<string, PhaseLoad>();
  const visit = (node: HierarchyNode): void => {
    const [lone] = node.stations;
    if (lone != null) {
      const weights = stationSplitWeights(node, lone);
      if (weights != null) weightsById.set(lone.id, weights);
    }
    for (const child of node.children) visit(child);
  };
  for (const root of hierarchy) visit(root);
  return allocations.map((a) => {
    const weights = weightsById.get(a.stationDbId);
    return weights != null ? { ...a, phaseWeights: weights } : a;
  });
}

/**
 * Marks each session with the EVSE limit last sent for it (`heldLimitKw`)
 * and the phase it was sent to charge on (`phaseToUse`, since when, and
 * whether the station refused or did not follow it).
 */
function withHeldEvseLimits(
  managed: StationPowerInfo[],
  previous: readonly AppliedAllocation[] | null,
): void {
  const held = new Map<string, AppliedEvseLimit>();
  for (const entry of previous ?? []) {
    for (const e of entry.evses ?? []) held.set(e.sessionId, e);
  }
  for (const station of managed) {
    if (station.sessions == null) continue;
    station.sessions = station.sessions.map((s) => {
      const e = held.get(s.sessionId);
      return {
        ...s,
        heldLimitKw: e?.limitKw ?? null,
        heldLimitA: e?.rateUnit === 'A' ? e.limitA : null,
        phaseToUse: e?.phaseToUse ?? null,
        phaseToUseSinceMs: e?.phaseToUseSinceMs ?? null,
        phaseToUseRefused: e?.phaseToUseRefused === true,
      };
    });
  }
}
