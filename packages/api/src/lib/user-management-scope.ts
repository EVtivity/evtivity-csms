// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';
import type { SQL } from 'drizzle-orm';
import { and, eq, exists, notExists, notInArray, sql } from 'drizzle-orm';
import { db, users, userPermissions, userSiteAssignments } from '@evtivity/database';
import { isSubsetOf, permissionCatalog } from '@evtivity/lib';
import { getEffectivePermissions } from '../middleware/rbac.js';
import { getUserSiteIds } from './site-access.js';

/**
 * User management scope (owner decision 2026-10-09). An operator with access
 * to every site manages every user. A site-restricted operator manages only
 * users with at least one site whose sites are all within the operator's own
 * sites: users with all-site access and users without any site are invisible
 * to it (404), it assigns only its own sites
 * and never grants all-site access. Every operator grants only permissions
 * it holds (canGrantPermissions).
 */
export interface UserManagementActor {
  userId: string;
  /** null: the actor has access to every site. */
  siteIds: string[] | null;
}

export async function getUserManagementActor(
  request: FastifyRequest,
): Promise<UserManagementActor> {
  const { userId } = request.user as { userId: string };
  return { userId, siteIds: await getUserSiteIds(userId) };
}

/**
 * The users a site-restricted actor may see: not all-site users, at least
 * one site assignment, and no site assignment outside the actor's sites.
 * Undefined (no filter) for an all-site actor.
 */
export function manageableUsersCondition(actorSiteIds: string[] | null): SQL | undefined {
  if (actorSiteIds == null) return undefined;
  const anyAssignment = db
    .select({ one: sql`1` })
    .from(userSiteAssignments)
    .where(eq(userSiteAssignments.userId, users.id));
  const foreignAssignment = db
    .select({ one: sql`1` })
    .from(userSiteAssignments)
    .where(
      and(
        eq(userSiteAssignments.userId, users.id),
        actorSiteIds.length > 0 ? notInArray(userSiteAssignments.siteId, actorSiteIds) : undefined,
      ),
    );
  return and(
    eq(users.hasAllSiteAccess, false),
    exists(anyAssignment),
    notExists(foreignAssignment),
  );
}

/**
 * Whether the actor may see and manage the target user. True for an all-site
 * actor without a lookup (the route answers its own 404 for a missing user).
 * False for a missing target and, for a site-restricted actor, for a target
 * without any site (no site of the actor's), so the caller answers the same
 * 404.
 */
export async function canManageUser(
  actor: UserManagementActor,
  targetUserId: string,
): Promise<boolean> {
  if (actor.siteIds == null) return true;
  const [target] = await db
    .select({ hasAllSiteAccess: users.hasAllSiteAccess })
    .from(users)
    .where(eq(users.id, targetUserId));
  if (target == null || target.hasAllSiteAccess) return false;
  const assignments = await db
    .select({ siteId: userSiteAssignments.siteId })
    .from(userSiteAssignments)
    .where(eq(userSiteAssignments.userId, targetUserId));
  if (assignments.length === 0) return false;
  const allowed = new Set(actor.siteIds);
  return assignments.every((a) => allowed.has(a.siteId));
}

/**
 * Whether the request may grant these permissions (directly or through a
 * role's defaults). Every actor, all-site or site-restricted, grants only
 * permissions it holds itself, with its API key scope when the request uses
 * one: no one can grant more than it holds.
 */
export async function canGrantPermissions(
  request: FastifyRequest,
  permissions: string[],
): Promise<boolean> {
  const own = (await getEffectivePermissions(request)) ?? [];
  return isSubsetOf(permissions, own);
}

/**
 * Whether the request may change the target's account: reset its password,
 * resend its invite, deactivate or delete it, or change its role, permissions,
 * site access or MFA phone (owner decision 2026-10-09). On top of the site
 * scope (`canManageUser`), the target's permissions must all be held by the
 * request (API key scope included), for every actor: no one takes over or
 * locks out a user with more permissions than itself. False answers the
 * route's 404 USER_NOT_FOUND.
 */
export async function canAdministerUser(
  request: FastifyRequest,
  actor: UserManagementActor,
  targetUserId: string,
): Promise<boolean> {
  if (!(await canManageUser(actor, targetUserId))) return false;
  const rows = await db
    .select({ permission: userPermissions.permission })
    .from(userPermissions)
    .where(eq(userPermissions.userId, targetUserId));
  return canGrantPermissions(
    request,
    rows.map((r) => r.permission),
  );
}

/** The permissions a user gets when assigned this role. */
export function roleDefaultPermissions(roleName: string | null | undefined): string[] {
  return permissionCatalog.defaultsFor(roleName ?? undefined);
}
