// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SQL } from 'drizzle-orm';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { chargingSessions, db, userFleetAssignments, users } from '@evtivity/database';
import type { UserAccessScope } from '@evtivity/lib/user-access-scope';

/**
 * What a CSMS user reaches: its sites (all sites or its assigned sites, see
 * site-access.ts) or only the fleets assigned to it. A fleet user has no
 * sites and reaches only the routes that declare `config.fleetScope`.
 */
export type UserAccess = { kind: 'sites' } | { kind: 'fleets'; fleetIds: string[] };

const cache = new Map<string, { access: UserAccess; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

/**
 * The access scope of a user, cached 60 s per user and dropped with the site
 * access cache. A missing user reads as sites: its site list is empty
 * (getUserSiteIds), so it reaches nothing either way.
 */
export async function getUserAccessScope(userId: string): Promise<UserAccess> {
  const cached = cache.get(userId);
  if (cached != null && cached.expiresAt > Date.now()) return cached.access;

  const [user] = await db
    .select({ accessScope: users.accessScope })
    .from(users)
    .where(eq(users.id, userId));

  let access: UserAccess;
  if (user?.accessScope === 'fleets') {
    const rows = await db
      .select({ fleetId: userFleetAssignments.fleetId })
      .from(userFleetAssignments)
      .where(eq(userFleetAssignments.userId, userId));
    access = { kind: 'fleets', fleetIds: rows.map((r) => r.fleetId).sort() };
  } else {
    access = { kind: 'sites' };
  }
  cache.set(userId, { access, expiresAt: Date.now() + CACHE_TTL_MS });
  return access;
}

/** Drop the cached access scope of a user in this process only. */
export function clearFleetScopeCacheLocal(userId: string): void {
  cache.delete(userId);
}

/** Whether the user reaches only its assigned fleets. */
export async function isFleetUser(userId: string): Promise<boolean> {
  return (await getUserAccessScope(userId)).kind === 'fleets';
}

/** Whether a fleet is within the scope: always for a site scope, else an assigned fleet. */
export function fleetInScope(access: UserAccess, fleetId: string): boolean {
  return access.kind === 'sites' || access.fleetIds.includes(fleetId);
}

/** The scope and fleet ids the user payloads (GET /users/me, sign-in replies) carry. */
export async function userAccessFields(
  userId: string,
): Promise<{ accessScope: UserAccessScope; fleetIds: string[] }> {
  const access = await getUserAccessScope(userId);
  return access.kind === 'fleets'
    ? { accessScope: 'fleets', fleetIds: access.fleetIds }
    : { accessScope: 'sites', fleetIds: [] };
}

/**
 * Guard for the fleet routes open to fleet users: a fleet user reaches only
 * its assigned fleets, every other fleet answers 404 FLEET_NOT_FOUND like an
 * unknown one. Operators pass unchanged. Returns false after the reply was sent.
 */
export async function requireFleetAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  fleetId: string,
): Promise<boolean> {
  const { userId } = request.user as { userId: string };
  if (fleetInScope(await getUserAccessScope(userId), fleetId)) return true;
  await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
  return false;
}

/**
 * The sessions a fleet user sees: billed to one of its fleets on account and
 * not passed on to a member, at every site. No fleet matches nothing.
 */
export function fleetPaidSessionCondition(fleetIds: readonly string[]): SQL {
  if (fleetIds.length === 0) return sql`false`;
  return and(
    eq(chargingSessions.billingMode, 'account'),
    inArray(chargingSessions.billingFleetId, [...fleetIds]),
    eq(chargingSessions.memberBilled, false),
  ) as SQL;
}
