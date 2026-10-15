// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, userTokens } from '@evtivity/database';
import { invalidatePermissionCache } from '../middleware/rbac.js';
import { invalidateSiteAccessCache } from '../lib/site-access.js';
import { announceSessionChange, bumpSessionVersion } from '../lib/operator-session.js';
import { revokeAllUserRefreshTokens } from './refresh-token.service.js';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The emailed single-use links of an operator: the password reset link and
 * the account setup link of an invitation (both `password_reset` rows).
 */
export const USER_EMAIL_LINK_TYPES = ['password_reset'] as const;

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * Revokes the open emailed links of an operator. Called when the operator is
 * deactivated or deleted and when the email changes, so a link sent before
 * can no longer set a password.
 */
export async function revokeUserEmailLinks(userId: string, executor: Executor = db): Promise<void> {
  await executor
    .update(userTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(userTokens.userId, userId),
        inArray(userTokens.type, [...USER_EMAIL_LINK_TYPES]),
        isNull(userTokens.revokedAt),
      ),
    );
}

/**
 * Applies an operator deactivation after `users.is_active` was set to false,
 * by PATCH /v1/users/:id or DELETE /v1/users/:id. Idempotent: a repeated call
 * finds nothing left to change.
 *
 * - Raises the session version, so no access token issued before works again
 *   after a reactivation.
 * - Drops the cached status, permissions and sites on every API pod and ends
 *   the user's open event streams.
 * - Revokes every refresh token and API key, and the open emailed links.
 *
 * Every step is fail-open (logged at warn): the user is already inactive, so
 * every request, refresh, API key and emailed link is refused by its own
 * status check (P9).
 */
export async function applyUserDeactivation(userId: string, ctx: { log: Logger }): Promise<void> {
  try {
    await bumpSessionVersion(userId);
  } catch (err) {
    ctx.log.warn({ err, userId }, 'Raising the session version of a deactivated user failed');
  }
  announceSessionChange(userId);
  invalidatePermissionCache(userId);
  invalidateSiteAccessCache(userId);
  try {
    await revokeAllUserRefreshTokens(userId);
    await revokeUserEmailLinks(userId);
  } catch (err) {
    ctx.log.warn({ err, userId }, 'Revoking the sessions and links of a deactivated user failed');
  }
}
