// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { type AppliedAllocation } from './load-limit-entries.js';
import type { LoadAllocationStrategy, ServiceLogger } from '@evtivity/lib';
import type { EvseLimitResult } from './evse-limits.js';
import type { StationPowerInfo, HierarchyNode, AllocationResult } from './load-management-model.js';
import { computeHierarchicalAllocation } from './load-management-allocation.js';

/**
 * The sessions whose TxProfile the depot plan owns (`planOwnedSessionIds`),
 * so the cycle sends them no EVSE limit (the plan profile has the same id).
 * Empty when nothing per EVSE is due; null when the plan could not be read:
 * no EVSE limit goes out this cycle and the station limit holds.
 */
export async function planOwnedSessions(
  siteId: string,
  strategy: LoadAllocationStrategy,
  due: boolean,
  log: ServiceLogger,
): Promise<Set<string> | null> {
  if (!due) return new Set();
  try {
    // Loaded on use: the planner module imports this one.
    const { planOwnedSessionIds } = await import('./charging-plan-dispatch.js');
    return await planOwnedSessionIds(siteId, strategy);
  } catch (err: unknown) {
    log.warn({ err, siteId }, 'Depot plan not read, no EVSE limit sent this cycle');
    return null;
  }
}

export async function departureAwareOrEqualShare(
  siteId: string,
  stations: StationPowerInfo[],
  hierarchy: HierarchyNode[],
  reservedKw: Map<string, number>,
  previous: readonly AppliedAllocation[] | null,
  options: { replan: boolean; log: ServiceLogger; nowMs?: number },
): Promise<AllocationResult[]> {
  try {
    // Loaded on use: the planner module imports this one.
    const { departureAwareAllocation } = await import('./charging-plan.service.js');
    const planned = await departureAwareAllocation({
      siteId,
      hierarchy,
      stations,
      reservedKw,
      previous,
      replan: options.replan,
      log: options.log,
      ...(options.nowMs != null ? { nowMs: options.nowMs } : {}),
    });
    if (planned != null) return planned;
  } catch (err: unknown) {
    options.log.error({ err, siteId }, 'Depot charging plan failed, sharing power equally');
  }
  return computeHierarchicalAllocation(hierarchy, 'equal_share', reservedKw);
}

/**
 * The depot plan's TxProfiles of a departure-aware site, sent after its
 * station limits. Fail-open: the station limit holds each station meanwhile,
 * and the next cycle sends what was not sent.
 */
export async function dispatchPlanProfilesAfterLimits(
  siteId: string,
  hierarchy: HierarchyNode[],
  stations: StationPowerInfo[],
  reservedKw: Map<string, number>,
  previous: readonly AppliedAllocation[] | null,
  log: ServiceLogger,
  evseLimits: ReadonlyMap<string, readonly EvseLimitResult[]>,
): Promise<void> {
  try {
    // Loaded on use: the planner module imports this one.
    const { dispatchDepotPlanProfiles } = await import('./charging-plan-dispatch.js');
    await dispatchDepotPlanProfiles({
      siteId,
      hierarchy,
      stations,
      reservedKw,
      previous,
      log,
      evseLimits,
    });
  } catch (err: unknown) {
    log.warn({ err, siteId }, 'Depot plan profiles not sent, the station limits hold');
  }
}

/**
 * A site that no longer follows a depot plan (another strategy) clears the
 * plan TxProfiles its stations may still hold. Fail-open: the next cycle tries
 * again, and a TxProfile ends with its transaction anyway.
 */
export async function clearPlanProfilesOffPlan(
  siteId: string,
  stations: StationPowerInfo[],
  log: ServiceLogger,
): Promise<void> {
  try {
    const { clearDepotPlanProfiles } = await import('./charging-plan-dispatch.js');
    await clearDepotPlanProfiles({ siteId, stations, log });
  } catch (err: unknown) {
    log.warn({ err, siteId }, 'Depot plan profiles not cleared, the next cycle tries again');
  }
}

/**
 * Load management turned off at a site: clears the plan TxProfiles its
 * stations may still hold. Fail-open: a TxProfile ends with its transaction.
 */
export async function clearPlanProfilesOnDisable(
  siteId: string,
  log: ServiceLogger,
): Promise<void> {
  try {
    const { clearSitePlanProfiles } = await import('./charging-plan-dispatch.js');
    await clearSitePlanProfiles(siteId, log);
  } catch (err: unknown) {
    log.warn(
      { err, siteId },
      'Depot plan profiles not cleared after load management was turned off',
    );
  }
}
