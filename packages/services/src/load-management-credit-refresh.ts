// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { LoadAllocationHeader } from '@evtivity/database';
import {
  mightEnforceKw,
  type AppliedAllocation,
  type StoredLimit,
  type CountedLimit,
} from './load-limit-entries.js';
import type { ServiceLogger } from '@evtivity/lib';
import { allocationSendEntries } from './load-allocation-entries.js';
import type {
  AllocationResult,
  HierarchyNode,
  StationPowerInfo,
  ChargingRateUnit,
} from './load-management-model.js';
import {
  type CreditLimit,
  prepareAllocationSend,
  stationRates,
  runLimitSend,
} from './load-management-send.js';
import { LOAD_MANAGEMENT_CREDIT_RESEND_MS } from './load-management-profiles.js';

/**
 * Sends the credit profiles again whose end comes within
 * `LOAD_MANAGEMENT_CREDIT_RESEND_MS` when a newer reading carries the credit
 * further (security case 334), on a cycle that sends nothing else. Only the
 * credit profiles go, through the one send path. A reading that stopped
 * arriving gives no later end, so the credit profile ends at the station when
 * its reading goes stale, also with no worker.
 */
export async function refreshCreditProfiles(
  siteId: string,
  allocations: readonly AllocationResult[],
  applied: readonly AppliedAllocation[],
  previousById: ReadonlyMap<string, AppliedAllocation>,
  creditLimits: ReadonlyMap<string, CreditLimit>,
  creditValidToMs: number | null,
  hierarchy: HierarchyNode[],
  now: Date,
  log: ServiceLogger,
  logContext: {
    header: Omit<LoadAllocationHeader, 'kind'>;
    stations: ReadonlyMap<string, StationPowerInfo>;
  },
  storedLimits: ReadonlyMap<string, StoredLimit>,
): Promise<void> {
  if (creditValidToMs == null) return;
  const nowMs = now.getTime();
  const due = new Set<string>();
  for (const entry of applied) {
    if (entry.allocatedBaseKw == null || entry.reserved === true) continue;
    const held = previousById.get(entry.stationDbId)?.credit?.until;
    const heldMs = held != null ? Date.parse(held) : null;
    if (
      heldMs == null ||
      (heldMs - nowMs < LOAD_MANAGEMENT_CREDIT_RESEND_MS && creditValidToMs > heldMs)
    ) {
      due.add(entry.stationDbId);
    }
  }
  if (due.size === 0) return;
  const rejected = new Map<string, readonly ChargingRateUnit[]>();
  for (const a of applied) {
    if (a.rejectedUnits != null) rejected.set(a.stationDbId, a.rejectedUnits);
  }
  const previousKw = mightMap(applied, previousById, storedLimits, nowMs);
  const send = prepareAllocationSend(
    allocations.filter((a) => due.has(a.stationDbId)),
    now,
    stationRates(hierarchy, rejected),
    previousKw,
    { credit: creditLimits, creditOnly: true },
  );
  await runLimitSend({
    siteId,
    applied,
    send,
    nowMs,
    header: { ...logContext.header, kind: 'credit' },
    logEntries: allocationSendEntries(send, {
      stations: logContext.stations,
      reservedRetries: new Set(),
      refresh: true,
    }),
    holdRaises: false,
    counted: countedLimits(applied, previousById, storedLimits, nowMs, new Map()),
    log,
  });
}

/**
 * What the allocation counted each station of `applied` at: the limit it
 * might enforce before this send (`mightEnforceKw`), and whether it was a
 * reservation. The raise claim checks the locked records against it.
 */
export function countedLimits(
  applied: readonly AppliedAllocation[],
  previousById: ReadonlyMap<string, AppliedAllocation>,
  storedLimits: ReadonlyMap<string, StoredLimit>,
  nowMs: number,
  boxChecks: ReadonlyMap<string, (entry: AppliedAllocation) => boolean>,
): Map<string, CountedLimit> {
  const counted = new Map<string, CountedLimit>();
  for (const entry of applied) {
    const boxesHold = boxChecks.get(entry.stationDbId);
    counted.set(entry.stationDbId, {
      ...(boxesHold != null ? { boxesHold } : {}),
      countedKw: mightEnforceKw(previousById.get(entry.stationDbId), {
        nowMs,
        storedLimit: storedLimits.get(entry.stationDbId) ?? null,
      }),
      reserved: entry.reserved === true,
    });
  }
  return counted;
}

/** The limit each station of `applied` might enforce (`mightEnforceKw`), where known. */
export function mightMap(
  applied: readonly AppliedAllocation[],
  previousById: ReadonlyMap<string, AppliedAllocation>,
  storedLimits: ReadonlyMap<string, StoredLimit>,
  nowMs: number,
): Map<string, number> {
  const limits = new Map<string, number>();
  for (const entry of applied) {
    const kw = mightEnforceKw(previousById.get(entry.stationDbId), {
      nowMs,
      storedLimit: storedLimits.get(entry.stationDbId) ?? null,
    });
    if (kw != null) limits.set(entry.stationDbId, kw);
  }
  return limits;
}
