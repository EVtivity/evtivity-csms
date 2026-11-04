// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from '../config.js';
import {
  depotSystemRefusedRequests,
  depotSystemSites,
  depotSystems,
} from '../schema/depot-systems.js';
import { sites } from '../schema/assets.js';

// The only writer of depot_systems, depot_system_sites and
// depot_system_refused_requests (guard test depot-system-writer-guard.test.ts):
// the bus depot interface (VDV 463). No rules and no audit here; the depot
// system service decides and audits. Functions take the caller's transaction.

export type DepotSystem = typeof depotSystems.$inferSelect;
export type NewDepotSystem = Omit<
  typeof depotSystems.$inferInsert,
  | 'id'
  | 'failedAuthCount'
  | 'authLockedUntil'
  | 'lastConnectedAt'
  | 'lastBootAt'
  | 'lastMessageAt'
  | 'createdAt'
  | 'updatedAt'
>;
export type DepotSystemChanges = Partial<
  Pick<
    DepotSystem,
    | 'name'
    | 'systemType'
    | 'isEnabled'
    | 'infoIntervalSeconds'
    | 'requestTimeoutSeconds'
    | 'maxRetries'
    | 'keepaliveTimeoutSeconds'
    | 'passwordHash'
  >
>;
export type DepotSystemDb = Pick<
  typeof db,
  'select' | 'insert' | 'update' | 'delete' | 'execute' | 'transaction'
>;
export type DepotSystemRefusal = typeof depotSystemRefusedRequests.$inferSelect;

export async function listDepotSystems(tx: DepotSystemDb = db): Promise<DepotSystem[]> {
  return tx.select().from(depotSystems).orderBy(asc(depotSystems.name), asc(depotSystems.id));
}

export async function getDepotSystem(
  id: string,
  tx: DepotSystemDb = db,
  options: { forUpdate?: boolean } = {},
): Promise<DepotSystem | null> {
  const query = tx.select().from(depotSystems).where(eq(depotSystems.id, id));
  const [row] = options.forUpdate === true ? await query.for('update') : await query;
  return row ?? null;
}

export async function getDepotSystemByPresystemId(
  presystemId: string,
  tx: DepotSystemDb = db,
): Promise<DepotSystem | null> {
  const [row] = await tx
    .select()
    .from(depotSystems)
    .where(eq(depotSystems.presystemId, presystemId));
  return row ?? null;
}

export async function insertDepotSystem(
  values: NewDepotSystem,
  tx: DepotSystemDb = db,
): Promise<DepotSystem> {
  const [row] = await tx.insert(depotSystems).values(values).returning();
  if (row == null) throw new Error('Depot system insert returned no row');
  return row;
}

export async function updateDepotSystem(
  id: string,
  changes: DepotSystemChanges,
  tx: DepotSystemDb = db,
): Promise<DepotSystem | null> {
  const [row] = await tx
    .update(depotSystems)
    .set({ ...changes, updatedAt: sql`now()` })
    .where(eq(depotSystems.id, id))
    .returning();
  return row ?? null;
}

export async function deleteDepotSystem(
  id: string,
  tx: DepotSystemDb = db,
): Promise<DepotSystem | null> {
  const [row] = await tx.delete(depotSystems).where(eq(depotSystems.id, id)).returning();
  return row ?? null;
}

/** The site ids of a depot system. */
export async function depotSystemSiteIds(id: string, tx: DepotSystemDb = db): Promise<string[]> {
  const rows = await tx
    .select({ siteId: depotSystemSites.siteId })
    .from(depotSystemSites)
    .where(eq(depotSystemSites.depotSystemId, id))
    .orderBy(asc(depotSystemSites.siteId));
  return rows.map((r) => r.siteId);
}

/** Site ids per depot system, for a list. */
export async function depotSystemSiteIdMap(
  ids: string[],
  tx: DepotSystemDb = db,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return out;
  const rows = await tx
    .select({ id: depotSystemSites.depotSystemId, siteId: depotSystemSites.siteId })
    .from(depotSystemSites)
    .where(inArray(depotSystemSites.depotSystemId, ids))
    .orderBy(asc(depotSystemSites.siteId));
  for (const row of rows) out.get(row.id)?.push(row.siteId);
  return out;
}

/** Replaces the sites of a depot system. */
export async function setDepotSystemSites(
  id: string,
  siteIds: string[],
  tx: DepotSystemDb = db,
): Promise<void> {
  await tx
    .delete(depotSystemSites)
    .where(
      and(
        eq(depotSystemSites.depotSystemId, id),
        siteIds.length > 0 ? notInArray(depotSystemSites.siteId, siteIds) : undefined,
      ),
    );
  if (siteIds.length === 0) return;
  await tx
    .insert(depotSystemSites)
    .values(siteIds.map((siteId) => ({ depotSystemId: id, siteId })))
    .onConflictDoNothing();
}

/** Sites by id with their layout settings, to check which are bus depots. */
export async function depotSiteCandidates(
  siteIds: string[],
  tx: DepotSystemDb = db,
): Promise<Array<{ id: string; name: string; layoutSettings: unknown }>> {
  if (siteIds.length === 0) return [];
  return tx
    .select({ id: sites.id, name: sites.name, layoutSettings: sites.layoutSettings })
    .from(sites)
    .where(inArray(sites.id, siteIds));
}

/**
 * Counts a failed sign-in against the system-wide ceiling and locks the system
 * for `lockMs` once the count reaches `threshold`; one guarded update, so
 * parallel guesses all count. True when this failure started the lock. The
 * lock holds back only addresses with failures of their own: the server
 * still checks an address without failures (lockout is no denial of service).
 */
export async function recordDepotSystemAuthFailure(
  id: string,
  threshold: number,
  lockMs: number,
  tx: DepotSystemDb = db,
): Promise<boolean> {
  const rows = (await tx.execute(sql`UPDATE depot_systems SET
      failed_auth_count = CASE WHEN failed_auth_count + 1 >= ${threshold} THEN 0 ELSE failed_auth_count + 1 END,
      auth_locked_until = CASE WHEN failed_auth_count + 1 >= ${threshold}
        THEN now() + make_interval(secs => ${Math.round(lockMs / 1000)}) ELSE auth_locked_until END
    WHERE id = ${id}
    RETURNING failed_auth_count = 0 AS locked`)) as unknown as Array<{ locked: boolean }>;
  return rows[0]?.locked === true;
}

export async function recordDepotSystemConnected(
  id: string,
  tx: DepotSystemDb = db,
): Promise<void> {
  await tx
    .update(depotSystems)
    .set({ failedAuthCount: 0, lastConnectedAt: sql`now()` })
    .where(eq(depotSystems.id, id));
}

export async function recordDepotSystemBoot(id: string, tx: DepotSystemDb = db): Promise<void> {
  await tx
    .update(depotSystems)
    .set({ lastBootAt: sql`now()` })
    .where(eq(depotSystems.id, id));
}

export async function recordDepotSystemMessage(id: string, tx: DepotSystemDb = db): Promise<void> {
  await tx
    .update(depotSystems)
    .set({ lastMessageAt: sql`now()` })
    .where(eq(depotSystems.id, id));
}

export async function listDepotSystemRefusals(
  id: string,
  tx: DepotSystemDb = db,
): Promise<DepotSystemRefusal[]> {
  return tx
    .select()
    .from(depotSystemRefusedRequests)
    .where(eq(depotSystemRefusedRequests.depotSystemId, id))
    .orderBy(asc(depotSystemRefusedRequests.externalRequestId));
}

/** When a refusal notice of the system was last claimed, or null. */
export async function lastDepotSystemRefusalNoticeAt(
  id: string,
  tx: DepotSystemDb = db,
): Promise<Date | null> {
  const [row] = await tx
    .select({ at: sql<Date | string | null>`max(${depotSystemRefusedRequests.notifiedAt})` })
    .from(depotSystemRefusedRequests)
    .where(eq(depotSystemRefusedRequests.depotSystemId, id));
  return row?.at == null ? null : new Date(row.at);
}

/**
 * Stores the refusals of the last list: refusals of request ids that applied
 * or left the list go away, a refusal with the same reason keeps its time and
 * notice mark, a new reason is a new refusal. Returns the refusals no notice
 * was claimed for yet (the caller notifies and marks them).
 */
export async function replaceDepotSystemRefusals(
  id: string,
  refusals: Array<{ externalRequestId: string; vehicleRef: string | null; reason: string }>,
  tx: DepotSystemDb = db,
): Promise<DepotSystemRefusal[]> {
  const keep = refusals.map((r) => r.externalRequestId);
  await tx
    .delete(depotSystemRefusedRequests)
    .where(
      and(
        eq(depotSystemRefusedRequests.depotSystemId, id),
        keep.length > 0
          ? notInArray(depotSystemRefusedRequests.externalRequestId, keep)
          : undefined,
      ),
    );
  if (refusals.length === 0) return [];
  await tx
    .insert(depotSystemRefusedRequests)
    .values(refusals.map((r) => ({ depotSystemId: id, ...r })))
    .onConflictDoUpdate({
      target: [
        depotSystemRefusedRequests.depotSystemId,
        depotSystemRefusedRequests.externalRequestId,
      ],
      set: {
        vehicleRef: sql`excluded.vehicle_ref`,
        reason: sql`excluded.reason`,
        refusedAt: sql`CASE WHEN ${depotSystemRefusedRequests.reason} = excluded.reason THEN ${depotSystemRefusedRequests.refusedAt} ELSE now() END`,
        notifiedAt: sql`CASE WHEN ${depotSystemRefusedRequests.reason} = excluded.reason THEN ${depotSystemRefusedRequests.notifiedAt} ELSE NULL END`,
      },
    });
  return tx
    .update(depotSystemRefusedRequests)
    .set({ notifiedAt: sql`now()` })
    .where(
      and(
        eq(depotSystemRefusedRequests.depotSystemId, id),
        sql`${depotSystemRefusedRequests.notifiedAt} IS NULL`,
      ),
    )
    .returning();
}
