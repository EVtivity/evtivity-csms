// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { userPermissions } from '@evtivity/database';
import { hasPermission } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

const permissionCache = new Map<string, { permissions: string[]; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

async function getUserPermissions(userId: string): Promise<string[]> {
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
    .catch(() => {
      // Best-effort; the local cache still expires via TTL on other pods.
    });
}

/**
 * The permissions a request acts with: the user's permissions, intersected
 * with the API key's scope when the request uses an API key. Null for a
 * token without a userId (driver tokens). Call after authentication.
 */
async function getEffectivePermissions(request: FastifyRequest): Promise<string[] | null> {
  const user = request.user;
  if (!('userId' in user)) return null;

  const perms = await getUserPermissions(user.userId);

  // If API key has scoped permissions, intersect with user permissions
  const apiKeyPerms =
    'apiKeyPermissions' in user
      ? (user as { apiKeyPermissions?: string[] }).apiKeyPermissions
      : undefined;
  return apiKeyPerms != null ? perms.filter((p) => apiKeyPerms.includes(p)) : perms;
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
