// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, inArray } from 'drizzle-orm';
import type postgres from 'postgres';
import { isLoadAllocationReason } from '@evtivity/lib/load-allocation-reasons';
import type { LoadAllocationReason } from '@evtivity/lib/load-allocation-reasons';
import { db } from '../config.js';
import { loadAllocationEntries, loadAllocationLog } from '../schema/load-management.js';
import { siteLoadManagement } from '../schema/load-management.js';
import { stationUnits } from '../schema/assets.js';
import { currentLoadManagementFence } from './load-management-fence.js';

export type LoadAllocationLogKind = 'change' | 'refresh' | 'credit';
export type LoadAllocationReply = 'accepted' | 'rejected' | 'not_sent';

export interface LoadAllocationHeader {
  kind: LoadAllocationLogKind;
  siteLimitKw: number;
  totalDrawKw: number;
  availableKw: number;
  supplyCreditKw: number;
  strategy: string;
}

/** One limit sent: a station limit (scope station) or one EVSE's TxProfile (scope evse). */
export interface LoadAllocationEntryInput {
  stationId: string;
  stationOcppId: string;
  unitId: string | null;
  evseNumber: number | null;
  scope: 'station' | 'evse';
  mode: 'station' | 'evse';
  limitKw: number;
  limitA: number | null;
  phases: number | null;
  rateUnit: 'A' | 'W';
  reason: LoadAllocationReason;
  sessionId: string | null;
  tariffId: string | null;
  tariffMaxCurrentA: number | null;
  profileId: number;
  stackLevel: number;
  purpose: string;
  commandId: string;
  refresh: boolean;
}

const INSERT_CHUNK = 1000;

function decimal(value: number | null, digits: number): string | null {
  return value == null || !Number.isFinite(value) ? null : value.toFixed(digits);
}

/**
 * Stores the allocations the cycle is about to send and logs every limit of
 * the send. The claim locks the `site_load_management` row (load management
 * still on) and builds the stored allocations from it (`mergeLocked`), so a
 * station reply stored after the cycle read the row is kept. The log is not
 * critical: its header and entries go in a savepoint, and a failed write (or
 * an entry with an unknown reason) goes to `onLogFailure` while the claim
 * commits, so the limits still go out. Returns false when the site was turned
 * off (nothing is written). A send without entries writes no log row.
 * `appliedAt` left out keeps the stored time (a credit profile resend); null
 * clears it, so a send whose raises are still to go out is sent again by the
 * next cycle unless the raise claim completes it.
 */
export async function claimAndLogAllocations(input: {
  siteId: string;
  applied: unknown;
  mergeLocked?: (locked: unknown) => unknown;
  appliedAt?: Date | null;
  header: LoadAllocationHeader;
  entries: readonly LoadAllocationEntryInput[];
  onLogFailure?: (err: unknown) => void;
}): Promise<boolean> {
  // A cycle whose lock lease was lost, or that a newer lock holder replaced,
  // claims nothing, so its older allocation never goes out after the new one.
  const fence = currentLoadManagementFence(input.siteId);
  if (fence?.signal?.aborted === true) return false;
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ appliedAllocations: siteLoadManagement.appliedAllocations })
      .from(siteLoadManagement)
      .where(
        and(
          eq(siteLoadManagement.siteId, input.siteId),
          eq(siteLoadManagement.isEnabled, true),
          ...(fence != null ? [eq(siteLoadManagement.cycleFence, fence.fence)] : []),
        ),
      )
      .for('update');
    if (locked == null) return false;
    const applied =
      input.mergeLocked != null ? input.mergeLocked(locked.appliedAllocations) : input.applied;
    await tx
      .update(siteLoadManagement)
      .set({
        appliedAllocations: applied,
        ...(input.appliedAt !== undefined ? { appliedAt: input.appliedAt } : {}),
      })
      .where(eq(siteLoadManagement.siteId, input.siteId));
    if (input.entries.length === 0) return true;
    try {
      await tx.transaction(async (logTx) => {
        await insertAllocationLog(logTx, input.siteId, input.header, input.entries);
      });
    } catch (err: unknown) {
      input.onLogFailure?.(err);
    }
    return true;
  });
}

type LogTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function insertAllocationLog(
  tx: LogTransaction,
  siteId: string,
  header: LoadAllocationHeader,
  entries: readonly LoadAllocationEntryInput[],
): Promise<void> {
  for (const entry of entries) {
    if (!isLoadAllocationReason(entry.reason)) {
      throw new Error(`Unknown load allocation reason: ${String(entry.reason)}`);
    }
  }
  const unitIds = [
    ...new Set(entries.map((e) => e.unitId).filter((id): id is string => id != null)),
  ];
  const unitNames = new Map<string, string>();
  if (unitIds.length > 0) {
    const rows = await tx
      .select({ id: stationUnits.id, name: stationUnits.name })
      .from(stationUnits)
      .where(inArray(stationUnits.id, unitIds));
    for (const row of rows) unitNames.set(row.id, row.name);
  }

  const [log] = await tx
    .insert(loadAllocationLog)
    .values({
      siteId,
      kind: header.kind,
      siteLimitKw: String(header.siteLimitKw),
      totalDrawKw: String(header.totalDrawKw),
      availableKw: String(header.availableKw),
      supplyCreditKw: String(header.supplyCreditKw),
      strategy: header.strategy,
    })
    .returning({ id: loadAllocationLog.id, createdAt: loadAllocationLog.createdAt });
  if (log == null) throw new Error('Load allocation log insert returned no row');
  for (let i = 0; i < entries.length; i += INSERT_CHUNK) {
    await tx.insert(loadAllocationEntries).values(
      entries.slice(i, i + INSERT_CHUNK).map((e) => ({
        logId: log.id,
        createdAt: log.createdAt,
        siteId,
        stationId: e.stationId,
        stationOcppId: e.stationOcppId,
        unitId: e.unitId,
        unitName: e.unitId != null ? (unitNames.get(e.unitId) ?? null) : null,
        evseNumber: e.evseNumber,
        scope: e.scope,
        mode: e.mode,
        limitKw: decimal(e.limitKw, 3) ?? '0',
        limitA: decimal(e.limitA, 1),
        phases: e.phases,
        rateUnit: e.rateUnit,
        reason: e.reason,
        sessionId: e.sessionId,
        tariffId: e.tariffId,
        tariffMaxCurrentA: decimal(e.tariffMaxCurrentA, 1),
        profileId: e.profileId,
        stackLevel: e.stackLevel,
        purpose: e.purpose,
        commandId: e.commandId,
        refresh: e.refresh,
      })),
    );
  }
}

/**
 * Stores a station's reply on the entry of the command it answers. Only an
 * entry of that station without a reply changes, so a reply never moves an
 * entry back and another station's event cannot touch it. Returns the rows
 * changed.
 */
export async function recordAllocationEntryReply(
  sql: postgres.Sql,
  stationUuid: string,
  commandId: string,
  reply: LoadAllocationReply,
): Promise<number> {
  const result = await sql`
    UPDATE load_allocation_entries
    SET reply = ${reply}, replied_at = now()
    WHERE command_id = ${commandId}
      AND station_id = ${stationUuid}
      AND reply IS NULL
  `;
  return result.count;
}
