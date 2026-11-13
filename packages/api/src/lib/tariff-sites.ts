// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Site availability of tariffs (owner decisions 2026-11-13, D-B): a tariff of
// a driver or fleet pricing group may apply at selected sites only. The sites
// live in tariff_sites, written only by the tariff routes in the tariff's
// transaction. A group with a Selected Sites tariff must not be a station or
// site group or the default group, and the reverse: both writes take the
// group's advisory lock, so a tariff write and an assignment never race.

import type { FastifyRequest } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  db,
  pricingGroups,
  pricingGroupSites,
  pricingGroupStations,
  sites,
  tariffSites,
  tariffs,
} from '@evtivity/database';
import { getUserSiteIds } from './site-access.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

/** Serializes the scope checks of one pricing group (tariff writes and assignments). */
export async function lockPricingGroupScope(tx: Executor, groupId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`pricing_group_scope:${groupId}`}))`,
  );
}

/** Why a group cannot hold Selected Sites tariffs: it prices stations or sites, or every station. */
export async function groupBlocksSiteAvailability(tx: Executor, groupId: string): Promise<boolean> {
  const [group] = await tx
    .select({ isDefault: pricingGroups.isDefault })
    .from(pricingGroups)
    .where(eq(pricingGroups.id, groupId));
  if (group?.isDefault === true) return true;
  const [station] = await tx
    .select({ id: pricingGroupStations.id })
    .from(pricingGroupStations)
    .where(eq(pricingGroupStations.pricingGroupId, groupId))
    .limit(1);
  if (station != null) return true;
  const [site] = await tx
    .select({ id: pricingGroupSites.id })
    .from(pricingGroupSites)
    .where(eq(pricingGroupSites.pricingGroupId, groupId))
    .limit(1);
  return site != null;
}

/** True when the group holds a Selected Sites tariff (active or not). */
export async function groupHasSiteLimitedTariffs(tx: Executor, groupId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: tariffs.id })
    .from(tariffs)
    .where(and(eq(tariffs.pricingGroupId, groupId), eq(tariffs.siteScope, 'selected')))
    .limit(1);
  return row != null;
}

/** The group holds a Selected Sites tariff: it cannot price a station or site (D-B). */
export class SiteLimitedGroupError extends Error {
  constructor() {
    super('pricing group has site-limited tariffs');
  }
}

export const SITE_LIMITED_GROUP_REPLY = {
  error:
    'This pricing group has tariffs limited to selected sites and cannot be assigned to a station or site',
  code: 'PRICING_GROUP_HAS_SITE_LIMITED_TARIFFS',
} as const;

/**
 * Runs a station or site pricing assignment in a transaction under the
 * group's scope lock, after checking the group holds no Selected Sites
 * tariff (throws SiteLimitedGroupError).
 */
export async function assignToStationOrSite<T>(
  groupId: string,
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockPricingGroupScope(tx, groupId);
    if (await groupHasSiteLimitedTariffs(tx, groupId)) throw new SiteLimitedGroupError();
    return run(tx);
  });
}

/** The ids of `siteIds` that name no site. */
export async function unknownSiteIds(tx: Executor, siteIds: readonly string[]): Promise<string[]> {
  if (siteIds.length === 0) return [];
  const rows = await tx
    .select({ id: sites.id })
    .from(sites)
    .where(inArray(sites.id, [...siteIds]));
  const known = new Set(rows.map((r) => r.id));
  return siteIds.filter((id) => !known.has(id));
}

/** Replaces the site list of a tariff (null: All Sites, no rows). */
export async function writeTariffSites(
  tx: Executor,
  tariffId: string,
  siteIds: readonly string[] | null,
): Promise<void> {
  await tx.delete(tariffSites).where(eq(tariffSites.tariffId, tariffId));
  if (siteIds == null || siteIds.length === 0) return;
  await tx
    .insert(tariffSites)
    .values([...new Set(siteIds)].map((siteId) => ({ tariffId, siteId })))
    .onConflictDoNothing();
}

/** The site ids of each tariff (sorted), for the tariffs given. */
export async function loadTariffSiteIds(
  tx: Executor,
  tariffIds: readonly string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (tariffIds.length === 0) return result;
  const rows = await tx
    .select({ tariffId: tariffSites.tariffId, siteId: tariffSites.siteId })
    .from(tariffSites)
    .where(inArray(tariffSites.tariffId, [...tariffIds]));
  for (const r of rows) {
    const list = result.get(r.tariffId) ?? [];
    list.push(r.siteId);
    result.set(r.tariffId, list);
  }
  for (const list of result.values()) list.sort();
  return result;
}

/** A tariff row with its sites, as the audit rows store it. */
export function tariffWithSites<T extends { id: string; siteScope: string }>(
  row: T,
  siteIds: readonly string[] | null | undefined,
): T & { siteIds: string[] | null } {
  return { ...row, siteIds: row.siteScope === 'selected' ? [...(siteIds ?? [])].sort() : null };
}

/**
 * Tariff rows as a reader sees them: `siteIds` (null for All Sites), and for
 * a site-restricted reader only the selected sites it may see, with
 * `otherSiteCount` counting the rest (site isolation, P11: another site's id
 * never leaks through a company-wide pricing read).
 */
export async function tariffViews<T extends { id: string; siteScope: string }>(
  request: FastifyRequest,
  rows: readonly T[],
): Promise<Array<T & { siteIds: string[] | null; otherSiteCount: number }>> {
  const siteMap = await loadTariffSiteIds(
    db,
    rows.filter((r) => r.siteScope === 'selected').map((r) => r.id),
  );
  const { userId } = request.user as { userId: string };
  const visible = await getUserSiteIds(userId);
  return rows.map((r) => {
    if (r.siteScope !== 'selected') return { ...r, siteIds: null, otherSiteCount: 0 };
    const all = siteMap.get(r.id) ?? [];
    if (visible == null) return { ...r, siteIds: all, otherSiteCount: 0 };
    const shown = all.filter((s) => visible.includes(s));
    return { ...r, siteIds: shown, otherSiteCount: all.length - shown.length };
  });
}
