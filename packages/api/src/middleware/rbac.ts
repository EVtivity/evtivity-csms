// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { userPermissions } from '@evtivity/database';
import { createLogger, hasPermission } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

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
 * The permissions a request acts with: the user's permissions, intersected
 * with the API key's scope when the request uses an API key. Null for a
 * token without a userId (driver tokens). Call after authentication.
 */
export async function getEffectivePermissions(request: FastifyRequest): Promise<string[] | null> {
  const user = request.user;
  if (!('userId' in user)) return null;

  const perms = await getUserPermissions(user.userId);

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

export function authorize(...requiredPermissions: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const app = request.server;
    await app.authenticate(request, reply);
    if (reply.sent) return;

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
