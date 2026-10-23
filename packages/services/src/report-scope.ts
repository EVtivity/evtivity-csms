// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { db, users, userPermissions, userSiteAssignments } from '@evtivity/database';
import { hasPermission } from '@evtivity/lib';

/**
 * The sites a report covers. null: every site, unsited stations included (an
 * all-site user). An array: only stations whose site is in it; unsited stations
 * are left out, and an empty array covers nothing.
 */
export type ReportSiteScope = readonly string[] | null;

/** The sites both scopes cover. null (all sites) is the identity. */
export function intersectSiteScopes(a: ReportSiteScope, b: ReportSiteScope): string[] | null {
  if (a == null) return b == null ? null : [...new Set(b)];
  if (b == null) return [...new Set(a)];
  const allowed = new Set(b);
  return [...new Set(a.filter((id) => allowed.has(id)))];
}

function textArray(ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]`;
}

/**
 * Condition on a station's site id: the station is in the scope. Undefined
 * for an all-site scope (no condition). A null site id never matches a
 * restricted scope, and an empty scope matches nothing.
 */
export function stationSiteInScope(
  siteIdColumn: AnyColumn | SQL,
  scope: ReportSiteScope,
): SQL | undefined {
  if (scope == null) return undefined;
  if (scope.length === 0) return sql`false`;
  return sql`${siteIdColumn} = ANY(${textArray(scope)})`;
}

/**
 * Condition on a stored `site_scope` column: the row is visible to a user with
 * `userScope`. Undefined for an all-site user (sees every row). A restricted
 * user sees only rows with a non-empty scope inside their sites; rows without
 * a scope (all sites, or stored before scopes existed) and rows with an empty
 * scope are hidden from them.
 */
export function siteScopeVisibleTo(
  scopeColumn: AnyColumn | SQL,
  userScope: ReportSiteScope,
): SQL | undefined {
  if (userScope == null) return undefined;
  // An empty scope (a report of a user with no site) is contained in every
  // scope: it shows to all-site users only.
  return sql`(${scopeColumn} IS NOT NULL AND cardinality(${scopeColumn}) > 0 AND ${scopeColumn} <@ ${textArray(userScope)})`;
}

/**
 * A user's current site scope, read from the database (the worker cannot use
 * the API's cached getUserSiteIds): null with all-site access, else their site
 * assignments. An unknown user covers nothing.
 */
export async function userSiteScope(userId: string): Promise<string[] | null> {
  const [user] = await db
    .select({ hasAllSiteAccess: users.hasAllSiteAccess })
    .from(users)
    .where(eq(users.id, userId));
  if (user == null) return [];
  if (user.hasAllSiteAccess) return null;
  const rows = await db
    .select({ siteId: userSiteAssignments.siteId })
    .from(userSiteAssignments)
    .where(eq(userSiteAssignments.userId, userId));
  return rows.map((row) => row.siteId);
}

/**
 * The columns a user may see in a report: driver identity
 * with drivers:read, money with payments:read. An unknown user or none (a
 * report without a requester) sees neither (fail closed).
 */
export async function reportColumnAccess(
  userId: string | null,
): Promise<{ driverData: boolean; money: boolean }> {
  if (userId == null) return { driverData: false, money: false };
  const rows = await db
    .select({ permission: userPermissions.permission })
    .from(userPermissions)
    .where(eq(userPermissions.userId, userId));
  const permissions = rows.map((row) => row.permission);
  return {
    driverData: hasPermission(permissions, 'drivers:read'),
    money: hasPermission(permissions, 'payments:read'),
  };
}

/** Why a scheduled report does not run: its creator can no longer read reports. */
export type ScheduleSkipReason =
  | 'no_creator'
  | 'creator_missing'
  | 'creator_inactive'
  | 'creator_lacks_reports_read'
  | 'creator_lacks_report_permission';

/**
 * Whether a schedule's creator may still receive the report: an active user
 * holding reports:read and the report type's own permissions
 * (`requiredPermissions`, for example payments:read for revenue). A schedule
 * runs with its creator's access, so a schedule without a creator, or one
 * whose creator was deactivated or lost a needed permission, does not run.
 * Null when it may run.
 */
export async function scheduleSkipReason(
  createdById: string | null,
  requiredPermissions: readonly string[] = [],
): Promise<ScheduleSkipReason | null> {
  if (createdById == null) return 'no_creator';
  const [user] = await db
    .select({ isActive: users.isActive })
    .from(users)
    .where(eq(users.id, createdById));
  if (user == null) return 'creator_missing';
  if (!user.isActive) return 'creator_inactive';
  const rows = await db
    .select({ permission: userPermissions.permission })
    .from(userPermissions)
    .where(eq(userPermissions.userId, createdById));
  const permissions = rows.map((row) => row.permission);
  if (!hasPermission(permissions, 'reports:read')) return 'creator_lacks_reports_read';
  return requiredPermissions.every((p) => hasPermission(permissions, p))
    ? null
    : 'creator_lacks_report_permission';
}

/**
 * The scope a scheduled run covers: the schedule's stored scope narrowed to
 * its creator's current sites, so a creator who lost a site no longer gets it
 * in the report. Call after scheduleSkipReason allowed the run.
 */
export async function scheduleRunScope(
  scheduleScope: ReportSiteScope,
  createdById: string,
): Promise<string[] | null> {
  return intersectSiteScopes(scheduleScope, await userSiteScope(createdById));
}
