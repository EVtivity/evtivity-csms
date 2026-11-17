// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, isFleetEnabled } from '@evtivity/database';
import { userPermissions } from '@evtivity/database';
import { createLogger, fleetUserPermissionsOutside, hasPermission } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { getUserAccessScope, isFleetUser } from '../lib/fleet-scope.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * The route is open to fleet users (access scope `fleets`) and checks the
     * fleet itself. Every other route answers them route-not-found.
     */
    fleetScope?: boolean;
    /**
     * A fleet-scope route about the caller's own account (its API keys): it
     * stays open to a fleet user that has no fleet left.
     */
    fleetSelfService?: boolean;
  }
}

const permissionCache = new Map<string, { permissions: string[]; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

/** The user's permissions (`user_permissions`), cached 60 s per user. */
export async function getUserPermissions(userId: string): Promise<string[]> {
  const cached = permissionCache.get(userId);
  if (cached != null && cached.expiresAt > Date.now()) {
    return cached.permissions;
  }

  const rows = await db
    .select({ permission: userPermissions.permission })
    .from(userPermissions)
    .where(eq(userPermissions.userId, userId));

  const permissions = rows.map((r) => r.permission);
  permissionCache.set(userId, { permissions, expiresAt: Date.now() + CACHE_TTL_MS });
  return permissions;
}

/** Clear the in-process cache only. Called by the pub/sub listener so a
 *  broadcast invalidation does not re-publish and storm the channel. */
export function clearPermissionCacheLocal(userId: string): void {
  permissionCache.delete(userId);
}

/** Clear cached permissions for a user AND broadcast to other API pods so
 *  their local caches drop the entry too. Without the broadcast a multi-pod
 *  Helm deployment serves stale permissions on the pods that did not handle
 *  the mutating request, for up to CACHE_TTL_MS. */
export function invalidatePermissionCache(userId: string): void {
  clearPermissionCacheLocal(userId);
  void getPubSub()
    .publish('cache_invalidate', JSON.stringify({ kind: 'permission', userId }))
    .catch((err: unknown) => {
      // fail-open: the local cache still expires via TTL on other pods (P9).
      createLogger('rbac').warn({ err, userId }, 'cache_invalidate publish for permissions failed');
    });
}

/**
 * The permissions a fleet user keeps: only those of the fleet user list,
 * whatever its stored rows hold.
 */
export function withinFleetUserCeiling(permissions: readonly string[]): string[] {
  const outside = new Set(fleetUserPermissionsOutside(permissions));
  return permissions.filter((p) => !outside.has(p));
}

/**
 * The permissions a request acts with: the user's permissions, intersected
 * with the API key's scope when the request uses an API key. A fleet user
 * keeps only the fleet user permissions, even with stale rows. Null for a
 * token without a userId (driver tokens). Call after authentication.
 */
export async function getEffectivePermissions(request: FastifyRequest): Promise<string[] | null> {
  const user = request.user;
  if (!('userId' in user)) return null;

  const stored = await getUserPermissions(user.userId);
  const perms = (await isFleetUser(user.userId)) ? withinFleetUserCeiling(stored) : stored;

  // If API key has scoped permissions, intersect with user permissions
  const apiKeyPerms =
    'apiKeyPermissions' in user
      ? (user as { apiKeyPermissions?: string[] }).apiKeyPermissions
      : undefined;
  // Each key permission the user holds stays, write implying read: a key
  // scoped to `x:read` keeps it for a user who holds `x:write`.
  return apiKeyPerms != null ? apiKeyPerms.filter((p) => hasPermission(perms, p)) : perms;
}

/**
 * Whether an authenticated request holds a permission, with the same rules as
 * `authorize()` (API key scoping, write implies read). For routes that answer
 * every caller with the route permission but include some fields only for
 * callers with a further permission.
 */
export async function requestHasPermission(
  request: FastifyRequest,
  permission: string,
): Promise<boolean> {
  const effectivePerms = await getEffectivePermissions(request);
  return effectivePerms != null && hasPermission(effectivePerms, permission);
}

/** What a fleet user gets on every route while the Fleets feature is off. */
export const FLEET_USER_FLEETS_OFF = {
  error: 'Fleet management is turned off. Contact your operator.',
  code: 'FLEET_DISABLED',
} as const;

/** What a fleet user with no assigned fleet gets on the fleet routes. */
export const FLEET_USER_NO_FLEETS = {
  error: 'No fleets are assigned to you. Contact your operator.',
  code: 'FLEET_USER_NO_FLEETS',
} as const;

/**
 * True after refusing a fleet user: while the Fleets feature is off every
 * route answers 403 FLEET_DISABLED (the CSMS then shows a page saying so);
 * while it is on, a route not open to fleet users answers route-not-found, so
 * its existence does not show, as for the operator log lists, and a fleet
 * user with no assigned fleet gets 403 FLEET_USER_NO_FLEETS on the fleet routes.
 */
async function refuseFleetUser(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const user = request.user as { userId?: unknown };
  if (typeof user.userId !== 'string') return false;
  const access = await getUserAccessScope(user.userId);
  if (access.kind !== 'fleets') return false;
  if (!(await isFleetEnabled())) {
    await reply.status(403).send(FLEET_USER_FLEETS_OFF);
    return true;
  }
  const { fleetScope, fleetSelfService } = request.routeOptions.config;
  if (fleetScope === true) {
    if (access.fleetIds.length > 0 || fleetSelfService === true) return false;
    await reply.status(403).send(FLEET_USER_NO_FLEETS);
    return true;
  }
  reply.callNotFound();
  return true;
}

export function authorize(...requiredPermissions: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const app = request.server;
    await app.authenticate(request, reply);
    if (reply.sent) return;

    if (await refuseFleetUser(request, reply)) return;

    if (requiredPermissions.length === 0) return;

    const effectivePerms = await getEffectivePermissions(request);
    if (effectivePerms == null) {
      await reply
        .status(403)
        .send({ error: 'Insufficient permissions', code: 'INSUFFICIENT_PERMISSIONS' });
      return;
    }

    for (const required of requiredPermissions) {
      if (!hasPermission(effectivePerms, required)) {
        await reply
          .status(403)
          .send({ error: 'Insufficient permissions', code: 'INSUFFICIENT_PERMISSIONS' });
        return;
      }
    }
  };
}

/**
 * Guard for the routes on the caller's own account (`/v1/users/me/*`): any
 * signed-in operator, no permission needed. API keys are refused (403
 * `SESSION_REQUIRED`) unless `allowApiKey` is set: a key must never read the
 * personal AI keys or change the password, MFA, phone or profile of the user
 * who created it. Reads of the profile, permissions, MFA status and
 * notification preferences allow API keys.
 */
export function selfService(opts: { allowApiKey?: boolean } = {}) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const app = request.server;
    await app.authenticate(request, reply);
    if (reply.sent) return;
    const user = request.user as { userId?: unknown; isApiKey?: unknown };
    if (typeof user.userId !== 'string') {
      await reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }
    if (user.isApiKey === true && opts.allowApiKey !== true) {
      await reply.status(403).send({
        error: 'This route needs a signed-in session, not an API key',
        code: 'SESSION_REQUIRED',
      });
    }
  };
}
