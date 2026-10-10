// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { getEffectivePermissions } from '../middleware/rbac.js';
import { getUserSiteIds } from './site-access.js';

/**
 * A short hash of what an operator may see besides the URL: the user's sites
 * (or all sites) and the request's effective permissions (the user's
 * permissions narrowed by the API key scope). A change to the user's sites,
 * permissions or role changes the hash. Used by the HTTP response cache key
 * and by the AI assistant, which hides stored tool results produced under
 * another access (features/site-access-control.md).
 */
export function buildScopeHash(siteIds: string[] | null, permissions: string[]): string {
  const scope = JSON.stringify({
    sites: siteIds == null ? '*' : [...siteIds].sort(),
    permissions: [...permissions].sort(),
  });
  return createHash('sha256').update(scope).digest('hex').slice(0, 16);
}

/**
 * The access fingerprint of an authenticated operator request. The inputs
 * come from the site-access and permission caches, which every pod drops on
 * the cache_invalidate message of a change.
 */
export async function requestAccessScope(request: FastifyRequest, userId: string): Promise<string> {
  const [siteIds, permissions] = await Promise.all([
    getUserSiteIds(userId),
    getEffectivePermissions(request),
  ]);
  return buildScopeHash(siteIds, permissions ?? []);
}
