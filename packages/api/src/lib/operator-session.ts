// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { db, getSessionLifetimes, getSsoConfig, users } from '@evtivity/database';
import { invalidateUserActiveCache } from './user-active.js';
import { isSecureRequest, setAuthCookies } from './auth-cookies.js';
import {
  createRefreshToken,
  revokeAllUserRefreshTokens,
  revokeAllUserSessions,
} from '../services/refresh-token.service.js';

const DAY_SECONDS = 24 * 60 * 60;

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The user fields an operator access token is signed from. */
export interface OperatorTokenUser {
  id: string;
  roleId: string;
  sessionVersion: number;
  /**
   * Unix seconds of the SSO sign-in that issues this session: set by the SSO
   * callback only, so a renewal drops it (`ssoAt` claim, the SSO proof).
   */
  ssoAuthAt?: number;
}

/**
 * Signs an operator access token valid for `expiresInSeconds`. It carries the user's session
 * version (`sv`): `operatorTokenRejection` refuses it once the version moves on (logout,
 * password, MFA, role or permission change, deactivation). A token without `sv` counts as 0.
 */
export function signOperatorAccessToken(
  app: FastifyInstance,
  user: OperatorTokenUser,
  expiresInSeconds: number,
): string {
  return app.jwt.sign(
    {
      userId: user.id,
      roleId: user.roleId,
      sv: user.sessionVersion,
      ...(user.ssoAuthAt != null ? { ssoAt: user.ssoAuthAt } : {}),
    },
    { expiresIn: expiresInSeconds },
  );
}

/**
 * Issues a CSMS session with the operator lifetimes of the session settings: a signed access
 * token at the user's session version, a new refresh token, and the auth cookies. Every
 * operator sign-in, refresh, SSO and MFA path goes through it. Returns the access token
 * (login responses still carry it).
 */
export async function issueOperatorSession(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  user: OperatorTokenUser,
): Promise<string> {
  const lifetimes = await getSessionLifetimes();
  const accessSeconds = lifetimes.operatorAccessMinutes * 60;
  const token = signOperatorAccessToken(app, user, accessSeconds);
  const refresh = await createRefreshToken({
    userId: user.id,
    lifetimeDays: lifetimes.operatorRefreshDays,
  });
  setAuthCookies('csms', reply, token, refresh.rawToken, isSecureRequest(request), {
    accessSeconds,
    refreshSeconds: lifetimes.operatorRefreshDays * DAY_SECONDS,
  });
  return token;
}

/**
 * Raises the user's session version, so every access token issued before is
 * refused. Run it inside the transaction of the change that ends the
 * sessions, then call `announceSessionChange` after the commit.
 */
export async function bumpSessionVersion(
  userId: string,
  executor: Executor = db,
): Promise<number | null> {
  const [row] = await executor
    .update(users)
    .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
    .where(eq(users.id, userId))
    .returning({ sessionVersion: users.sessionVersion });
  return row?.sessionVersion ?? null;
}

/**
 * Drops the user's cached status and session version on every API pod and
 * ends the user's open event streams (`cache_invalidate`, kind `active`).
 */
export function announceSessionChange(userId: string): void {
  invalidateUserActiveCache(userId);
}

/**
 * Ends every session of the user: raises the session version (access
 * tokens), revokes the refresh tokens, and announces the change. API keys are
 * revoked too with `apiKeys: true` (deactivation, delete, a reset by link or
 * by an admin); a voluntary password or MFA change keeps them.
 */
export async function endUserSessions(
  userId: string,
  opts: { apiKeys: boolean },
): Promise<number | null> {
  const version = await bumpSessionVersion(userId);
  if (opts.apiKeys) await revokeAllUserRefreshTokens(userId);
  else await revokeAllUserSessions(userId);
  announceSessionChange(userId);
  return version;
}

/**
 * Whether password sign-in, reset and change are closed for the account: an
 * SSO account (auto-provisioned by a SAML sign-in) while SSO is enabled.
 * Callers answer as for a wrong password or an unknown email.
 */
export async function passwordAuthBlocked(user: { authSource: string }): Promise<boolean> {
  if (user.authSource !== 'sso') return false;
  return (await getSsoConfig()) != null;
}

/** Whether the user signs in with SSO only (an SSO account while SSO is enabled). */
export async function ssoManagedUser(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ authSource: users.authSource })
    .from(users)
    .where(eq(users.id, userId));
  return row != null && (await passwordAuthBlocked(row));
}
