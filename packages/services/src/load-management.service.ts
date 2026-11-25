// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and } from 'drizzle-orm';
import { db, siteLoadManagement, client, writeLoadManagementRecords } from '@evtivity/database';
import type { LoadAllocationHeader } from '@evtivity/database';
import {
  baseMightKw,
  CREDIT_CLOCK_MARGIN_MS,
  creditBoundUnknown,
  creditReplacementEnd,
  creditMayHold,
  stationLimitRecord,
  parseAppliedAllocations,
  hasUnconfirmedLimit,
  withExpiredConfirmationWaits,
  stationCredit,
  type AppliedAllocation,
  type AppliedCredit,
} from './load-limit-entries.js';
import type { LoadAllocationStrategy, ServiceLogger } from '@evtivity/lib';
import {
  appliedEvseLimit,
  evseDefaultCommands,
  evseDefaultReleases,
  evseLimitCommands,
  evseLimitReleases,
} from './evse-limit-profiles.js';
import type { AppliedEvseDefault, AppliedEvseLimit } from './evse-limit-profiles.js';
import { allocationSendEntries } from './load-allocation-entries.js';
import { type SiteAllocation, computeSiteAllocation } from './load-management-site-allocation.js';
import type { StationPowerInfo, ChargingRateUnit } from './load-management-model.js';
import {
  planOwnedSessions,
  dispatchPlanProfilesAfterLimits,
  clearPlanProfilesOffPlan,
} from './load-management-plan-bridge.js';
import {
  clearLoadManagementProfiles,
  LOAD_MANAGEMENT_CUT_CONFIRM_MS,
  LOAD_MANAGEMENT_CYCLE_MS,
  type CreditLimit,
  allocationKey,
  prepareAllocationSend,
  stationRates,
  runLimitSend,
} from './load-management-send.js';
import { LOAD_MANAGEMENT_REFRESH_MS, takesCreditProfile } from './load-management-profiles.js';
import { summarizeSiteCapacity } from './load-management-allocation.js';
import {
  refreshCreditProfiles,
  mightMap,
  countedLimits,
} from './load-management-credit-refresh.js';

/** A site row of the cycle: its id, strategy and stored records. */
export interface LoadManagementSiteRow {
  siteId: string;
  strategy: LoadAllocationStrategy;
  appliedAllocations: unknown;
  appliedAt: Date | null;
}

/**
 * What the cycle of one site reads and does outside its records: the
 * allocation over the site tree, the depot plan's sessions, the profile
 * clears, the plan profiles, whether load management is still on, and the
 * time. `siteCycleSources` gives the ones of a running worker.
 */
export interface SiteCycleSources {
  allocate: (
    previous: readonly AppliedAllocation[] | null,
  ) => Promise<SiteAllocation & { status: { totalDrawKw: number; stations: StationPowerInfo[] } }>;
  planOwnedSessions: (due: boolean) => Promise<Set<string> | null>;
  clearProfiles: (stationIds: string[]) => Promise<boolean>;
  planProfiles: (
    allocation: SiteAllocation & { status: { totalDrawKw: number; stations: StationPowerInfo[] } },
    previous: readonly AppliedAllocation[] | null,
  ) => Promise<void>;
  isEnabled: () => Promise<boolean>;
  now: () => Date;
}

export function siteCycleSources(
  site: LoadManagementSiteRow,
  log: ServiceLogger,
  allowSimulatedEnergyAssets: boolean,
): SiteCycleSources {
  return {
    allocate: (previous) =>
      computeSiteAllocation(site.siteId, site.strategy, previous, {
        replan: true,
        log,
        allowSimulatedEnergyAssets,
      }),
    planOwnedSessions: (due) => planOwnedSessions(site.siteId, site.strategy, due, log),
    clearProfiles: (stationIds) => clearLoadManagementProfiles(stationIds, log),
    planProfiles: (allocation, previous) =>
      site.strategy === 'departure_aware'
        ? dispatchPlanProfilesAfterLimits(
            site.siteId,
            allocation.hierarchy,
            allocation.status.stations,
            allocation.reservedKw,
            previous,
            log,
            allocation.evseLimits,
          )
        : clearPlanProfilesOffPlan(site.siteId, allocation.status.stations, log),
    isEnabled: async () => {
      const [state] = await db
        .select({ isEnabled: siteLoadManagement.isEnabled })
        .from(siteLoadManagement)
        .where(eq(siteLoadManagement.siteId, site.siteId));
      return state?.isEnabled === true;
    },
    now: () => new Date(),
  };
}

/**
 * One load management cycle of one site: the allocation, the records each
 * station keeps, the send (or the credit refresh on a cycle that changes
 * nothing), the clears of the stations no longer managed. Throws on a
 * failure the caller counts as a failed site. Returns the allocation log
 * writes that failed.
 */
export async function runSiteLoadManagement(
  site: LoadManagementSiteRow,
  log: ServiceLogger,
  sources: SiteCycleSources,
): Promise<{ logFailures: number }> {
  let logFailures = 0;
  const now = sources.now();
  const nowMs = now.getTime();
  const sinceSendMs = site.appliedAt == null ? null : nowMs - site.appliedAt.getTime();
  // A record still awaiting a reply after the last send's confirmation wait is
  // lost: the station is reserved and sent its retry this cycle.
  const stored = parseAppliedAllocations(site.appliedAllocations);
  const previous =
    stored == null
      ? null
      : withExpiredConfirmationWaits(
          stored,
          sinceSendMs == null || sinceSendMs >= LOAD_MANAGEMENT_CUT_CONFIRM_MS,
        );
  const allocation = await sources.allocate(previous);
  const {
    status,
    hierarchy,
    managed,
    reservedKw,
    allocations,
    baseKw,
    creditValidToMs,
    evseLimits,
    evseDefaults,
    boxChecks,
    retries,
    storedLimits,
    holdRaises,
  } = allocation;

  const previousById = new Map((previous ?? []).map((a) => [a.stationDbId, a]));
  const stationById = new Map(managed.map((s) => [s.id, s]));
  const creditValidTo = creditValidToMs != null ? new Date(creditValidToMs) : null;
  // Per-EVSE limits (TxProfiles) and the clears of the ones no longer due.
  const previousEvses = new Map(
    (previous ?? []).filter((a) => a.evses != null).map((a) => [a.stationDbId, a.evses ?? []]),
  );
  const planOwned = await sources.planOwnedSessions(evseLimits.size > 0 || previousEvses.size > 0);
  const evseCommands =
    planOwned == null ? [] : evseLimitCommands(evseLimits, stationById, previousEvses, planOwned);
  // A reserved station keeps the EVSE limits it holds: they still hold its
  // boxes while its station limit is unconfirmed or it is offline.
  const evseReleases =
    planOwned == null
      ? []
      : evseLimitReleases(
          new Map([...previousEvses].filter(([stationDbId]) => !reservedKw.has(stationDbId))),
          evseCommands,
          stationById,
          planOwned,
        );
  // The unit box TxDefaultProfiles, and the clears of the ones no longer due;
  // a reserved station keeps the defaults it holds.
  const previousDefaults = new Map(
    (previous ?? [])
      .filter((a) => a.evseDefaults != null)
      .map((a) => [a.stationDbId, a.evseDefaults ?? []]),
  );
  const defaultCommands = evseDefaultCommands(evseDefaults, stationById, previousDefaults);
  const defaultReleases = evseDefaultReleases(
    new Map([...previousDefaults].filter(([stationDbId]) => !reservedKw.has(stationDbId))),
    defaultCommands,
    stationById,
  );
  const defaultsByStation = new Map<string, AppliedEvseDefault[]>();
  for (const command of defaultCommands) {
    const list = defaultsByStation.get(command.stationDbId) ?? [];
    list.push({ ...command.value });
    defaultsByStation.set(command.stationDbId, list);
  }
  const evsesByStation = new Map<string, AppliedEvseLimit[]>();
  for (const command of evseCommands) {
    const list = evsesByStation.get(command.stationDbId) ?? [];
    list.push(appliedEvseLimit(command.limit, command.rateUnit));
    evsesByStation.set(command.stationDbId, list);
  }
  // Each station keeps its state record (and refusals, credit, EVSE
  // records); the cycle writes only the allocation. The records change
  // through the send transitions of the claims.
  // The credit profile the station may still hold: its entry's, or the stored
  // one a station without an entry starts from.
  // A station that takes no stack level 2 profile refuses a credit profile
  // (K01), so it cannot hold one and has no unknown credit to replace (review M2).
  const takesNoCredit = new Set(managed.filter((s) => !takesCreditProfile(s)).map((s) => s.id));
  const heldCreditOf = (stationDbId: string): AppliedCredit | undefined => {
    const credit = stationCredit(
      previousById.get(stationDbId),
      storedLimits.get(stationDbId) ?? null,
    );
    return credit != null && takesNoCredit.has(stationDbId) && creditBoundUnknown(credit)
      ? undefined
      : credit;
  };
  const carriedCredit = (stationDbId: string): AppliedCredit | undefined => {
    const credit = heldCreditOf(stationDbId);
    return credit != null && creditMayHold(credit.until, nowMs) ? credit : undefined;
  };
  const carriedCreditField = (stationDbId: string): { credit?: AppliedCredit } => {
    const credit = carriedCredit(stationDbId);
    return credit != null ? { credit } : {};
  };
  const carried = (stationDbId: string): Partial<AppliedAllocation> => {
    const prev = previousById.get(stationDbId);
    return {
      limit: stationLimitRecord(prev, storedLimits.get(stationDbId) ?? null),
      ...(prev?.rejectedUnits != null ? { rejectedUnits: prev.rejectedUnits } : {}),
      ...(prev?.acceptedUnits != null ? { acceptedUnits: prev.acceptedUnits } : {}),
      ...carriedCreditField(stationDbId),
    };
  };
  const applied: AppliedAllocation[] = [
    ...allocations.map((a) => {
      const base = baseKw.get(a.stationDbId);
      const evseEntries = evsesByStation.get(a.stationDbId);
      const defaultEntries = defaultsByStation.get(a.stationDbId);
      return {
        stationId: a.stationId,
        stationDbId: a.stationDbId,
        allocatedKw: a.allocatedKw,
        ...(base != null ? { allocatedBaseKw: base } : {}),
        ...carried(a.stationDbId),
        ...(evseEntries != null ? { evses: evseEntries } : {}),
        ...(defaultEntries != null ? { evseDefaults: defaultEntries } : {}),
        ...(a.phaseWeights != null ? { phaseWeights: a.phaseWeights } : {}),
      } as AppliedAllocation;
    }),
    ...[...reservedKw].map(([stationDbId, allocatedKw]) => {
      const heldEvses = previousEvses.get(stationDbId);
      const heldDefaults = previousDefaults.get(stationDbId);
      return {
        stationId: stationById.get(stationDbId)?.stationId ?? stationDbId,
        stationDbId,
        allocatedKw,
        reserved: true,
        ...carried(stationDbId),
        ...(heldEvses != null && heldEvses.length > 0 ? { evses: [...heldEvses] } : {}),
        ...(heldDefaults != null && heldDefaults.length > 0
          ? { evseDefaults: [...heldDefaults] }
          : {}),
      } as AppliedAllocation;
    }),
  ];

  // The credit profile of each station that gets one this send: its
  // credit limit until the readings end, or (a credit profile it may
  // still hold, no credit now) its limit until that profile ends, so a
  // lower limit replaces it at once (security case 334).
  // A station that may hold a credit profile nothing records (no record, a
  // boot) is sent its replacement too, reserved stations included.
  const creditLimits = new Map<string, CreditLimit>();
  for (const a of [...allocations, ...retries]) {
    const prev = previousById.get(a.stationDbId);
    const base = baseKw.get(a.stationDbId);
    const heldCredit = heldCreditOf(a.stationDbId);
    // A held credit profile of no known bound: replaced with one that outlasts it.
    // The replacement's end is fixed at its first send (any credit profile sent
    // before ends sooner), so a resend after a refusal never moves it out, and
    // none is sent within a cycle of that end: the record then ends by itself.
    const heldUnknown = heldCredit != null && creditBoundUnknown(heldCredit);
    const replacementEnd =
      heldCredit != null ? creditReplacementEnd(heldCredit, nowMs, LOAD_MANAGEMENT_CYCLE_MS) : null;
    // A credit profile that may still hold, clock margin included, is replaced
    // at the new limit, so ending it is a cut the raises wait for. A profile
    // already past its end gets a replacement that ends after the margin.
    const heldUntil =
      heldCredit != null && !heldUnknown && creditMayHold(heldCredit.until, nowMs)
        ? new Date(
            Math.max(Date.parse(heldCredit.until), nowMs + CREDIT_CLOCK_MARGIN_MS),
          ).toISOString()
        : null;
    const validTo =
      base != null && creditValidTo != null
        ? creditValidTo
        : heldUnknown
          ? replacementEnd
          : heldUntil != null
            ? new Date(heldUntil)
            : null;
    if (validTo == null) continue;
    const previousBaseKw = baseMightKw(prev, storedLimits.get(a.stationDbId) ?? null);
    creditLimits.set(a.stationDbId, {
      baseKw: base ?? a.allocatedKw,
      ...(previousBaseKw != null ? { previousBaseKw } : {}),
      validTo,
    });
  }

  // Stations that had a limit and are no longer managed (unassigned from
  // their circuit, moved to another site): remove the limit.
  const managedIds = new Set(managed.map((s) => s.id));
  const released = (previous ?? []).filter((a) => !managedIds.has(a.stationDbId));

  const changed = previous == null || allocationKey(applied) !== allocationKey(previous);
  // An online station with a limit not confirmed (reserved, awaiting or lost)
  // is sent its limits every cycle until it answers, once the last send's
  // confirmation wait has passed, so a call still in flight is not sent twice.
  const unconfirmed =
    retries.length > 0 ||
    managed.some((s) => s.isOnline && hasUnconfirmedLimit(previousById.get(s.id)));
  const due =
    sinceSendMs == null ||
    sinceSendMs >= LOAD_MANAGEMENT_REFRESH_MS ||
    (unconfirmed && sinceSendMs >= LOAD_MANAGEMENT_CUT_CONFIRM_MS);
  const header: Omit<LoadAllocationHeader, 'kind'> = {
    ...summarizeSiteCapacity(hierarchy, reservedKw),
    totalDrawKw: status.totalDrawKw,
    strategy: site.strategy,
  };
  const planProfiles = (): Promise<void> => sources.planProfiles(allocation, previous);
  if (!changed && !due && released.length === 0) {
    await refreshCreditProfiles(
      site.siteId,
      allocations,
      applied,
      previousById,
      creditLimits,
      creditValidToMs,
      hierarchy,
      now,
      log,
      { header, stations: stationById },
      storedLimits,
    );
    await planProfiles();
    return { logFailures };
  }

  // A reserved online station is sent its retry limit (fitted with the
  // other reserved stations in the allocation pass), in a unit it has not
  // rejected: once it accepts, the next cycle allocates it like the others.
  const rejected = new Map<string, readonly ChargingRateUnit[]>();
  for (const a of applied) {
    if (a.rejectedUnits != null) rejected.set(a.stationDbId, a.rejectedUnits);
  }
  const toSend = [...allocations, ...retries];
  // What each station might enforce, so cuts go out before raises.
  const previousKw = mightMap(applied, previousById, storedLimits, nowMs);
  const send = prepareAllocationSend(toSend, now, stationRates(hierarchy, rejected), previousKw, {
    credit: creditLimits,
    evse: evseCommands,
    evseReleases,
    evseDefaults: defaultCommands,
    defaultReleases,
    reserved: new Set(retries.map((r) => r.stationDbId)),
  });

  // The stations no longer managed stay listed until their clear went out.
  const entriesToStore = [...applied, ...released];
  const { claimed, outcome } = await runLimitSend({
    siteId: site.siteId,
    applied: entriesToStore,
    send,
    nowMs,
    appliedAt: now,
    header: { ...header, kind: changed ? 'change' : 'refresh' },
    logEntries: allocationSendEntries(send, {
      stations: stationById,
      reservedRetries: new Set(retries.map((r) => r.stationDbId)),
      refresh: !changed,
    }),
    holdRaises,
    counted: countedLimits(applied, previousById, storedLimits, nowMs, boxChecks),
    log,
    onLogFailure: (err) => {
      logFailures += 1;
      log.warn(
        { err, siteId: site.siteId },
        'Load allocation log write failed, the limits go out unlogged',
      );
    },
  });
  if (!claimed || outcome == null) return { logFailures };
  const cleared =
    released.length === 0 ? true : await sources.clearProfiles(released.map((a) => a.stationId));
  if (cleared && released.length > 0) {
    const releasedIds = new Set(released.map((a) => a.stationDbId));
    try {
      await writeLoadManagementRecords(client, site.siteId, (locked) =>
        (parseAppliedAllocations(locked) ?? []).filter((e) => !releasedIds.has(e.stationDbId)),
      );
    } catch (err: unknown) {
      log.warn(
        { err, siteId: site.siteId },
        'Released stations not removed, kept for the next cycle',
      );
    }
  } else if (!cleared) {
    try {
      await writeLoadManagementRecords(
        client,
        site.siteId,
        (locked) => parseAppliedAllocations(locked) ?? [],
        {
          nullAppliedAt: true,
        },
      );
    } catch (err: unknown) {
      log.warn({ err, siteId: site.siteId }, 'Load management resend not scheduled');
    }
  }

  // Turned off while this cycle sent: the clear of the PUT can reach a
  // station before this cycle's limit, which would then stay. Clear the
  // stations just sent again.
  if (toSend.length > 0) {
    if (!(await sources.isEnabled())) {
      await sources.clearProfiles(toSend.map((a) => a.stationId));
      log.info(
        { siteId: site.siteId, stationCount: toSend.length },
        'Load management turned off during the cycle, limits cleared again',
      );
      return { logFailures };
    }
  }

  // The station limits went out first: the plan profiles stay under them.
  await planProfiles();

  log.info(
    {
      siteId: site.siteId,
      strategy: site.strategy,
      totalDrawKw: status.totalDrawKw,
      stationCount: allocations.length,
      reservedCount: reservedKw.size,
      retryCount: retries.length,
      releasedCount: released.length,
      changed,
    },
    changed ? 'Load management cycle applied' : 'Load management allocations refreshed',
  );
  return { logFailures };
}

export async function runLoadManagementCycle(
  log: ServiceLogger,
  targetSiteId?: string,
  options: {
    /** ENERGY_ASSETS_ALLOW_SIMULATED of the worker (owner decision D13). */
    allowSimulatedEnergyAssets?: boolean;
  } = {},
): Promise<{ failedSites: number; logFailures: number }> {
  let failedSites = 0;
  let logFailures = 0;
  const conditions = [eq(siteLoadManagement.isEnabled, true)];
  if (targetSiteId != null) {
    conditions.push(eq(siteLoadManagement.siteId, targetSiteId));
  }
  const enabledSites = await db
    .select({
      siteId: siteLoadManagement.siteId,
      strategy: siteLoadManagement.strategy,
      appliedAllocations: siteLoadManagement.appliedAllocations,
      appliedAt: siteLoadManagement.appliedAt,
    })
    .from(siteLoadManagement)
    .where(and(...conditions));

  for (const site of enabledSites) {
    try {
      const result = await runSiteLoadManagement(
        site,
        log,
        siteCycleSources(site, log, options.allowSimulatedEnergyAssets === true),
      );
      logFailures += result.logFailures;
    } catch (err: unknown) {
      failedSites += 1;
      log.error({ err, siteId: site.siteId }, 'Load management cycle failed');
    }
  }
  return { failedSites, logFailures };
}
