// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { db, mfaChallenges, users, writeAudit, userAuditLog } from '@evtivity/database';
import { authRequestOrigin } from './auth-audit.js';

/**
 * Per-account backoff for operator sign-ins, on top of the per-IP route rate
 * limits, which do not stop guesses at one account spread over many
 * addresses.
 *
 * - SIGN_IN_FREE_FAILURES: failures in a row before the first lock. Five
 *   leaves room for typos and a caps-lock key.
 * - SIGN_IN_BASE_LOCK_SECONDS, doubled for every further failure: 30 s, 60 s,
 *   2 min, ... up to SIGN_IN_MAX_LOCK_SECONDS. The cap of 15 minutes keeps
 *   an attacker who fails on purpose from locking the owner out for long,
 *   and still holds a guesser to a few attempts an hour.
 *
 * The same rule applies to password sign-ins and to MFA codes after the
 * password step, each with its own counter on `users`. A success resets it.
 * While locked, a password sign-in answers as for a wrong password (no
 * account state leaks); an MFA code answers 429 `MFA_LOCKED`, since that
 * caller already proved the password.
 */
export const SIGN_IN_FREE_FAILURES = 5;
export const SIGN_IN_BASE_LOCK_SECONDS = 30;
export const SIGN_IN_MAX_LOCK_SECONDS = 15 * 60;

export type SignInFactor = 'password' | 'mfa';

/** Lock length in seconds after this many failures in a row (0: no lock). */
export function lockSecondsAfter(failures: number): number {
  if (failures < SIGN_IN_FREE_FAILURES) return 0;
  const doublings = Math.min(failures - SIGN_IN_FREE_FAILURES, 20);
  return Math.min(SIGN_IN_BASE_LOCK_SECONDS * 2 ** doublings, SIGN_IN_MAX_LOCK_SECONDS);
}

/** Whether a lock time is still in the future. */
export function isLocked(lockedUntil: Date | null | undefined, now = new Date()): boolean {
  return lockedUntil != null && lockedUntil.getTime() > now.getTime();
}

/** Seconds until the lock ends, at least 1. */
export function secondsUntil(lockedUntil: Date, now = new Date()): number {
  return Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000));
}

function columns(factor: SignInFactor) {
  return factor === 'password'
    ? { count: users.failedLoginCount, until: users.loginLockedUntil }
    : { count: users.mfaFailedCount, until: users.mfaLockedUntil };
}

/**
 * Counts a failed sign-in in one guarded UPDATE (parallel failures all
 * count) and sets the lock when the count reaches the threshold. A lock is
 * audited on the user (`account_locked`). Returns the new lock time, or null.
 */
export async function recordSignInFailure(
  request: FastifyRequest,
  userId: string,
  factor: SignInFactor,
): Promise<Date | null> {
  const col = columns(factor);
  const next = sql`${col.count} + 1`;
  const lockSeconds = sql`LEAST(${SIGN_IN_BASE_LOCK_SECONDS} * POWER(2, LEAST(${next} - ${SIGN_IN_FREE_FAILURES}, 20)), ${SIGN_IN_MAX_LOCK_SECONDS})`;
  const values =
    factor === 'password'
      ? {
          failedLoginCount: next,
          loginLockedUntil: sql`CASE WHEN ${next} >= ${SIGN_IN_FREE_FAILURES} THEN now() + make_interval(secs => ${lockSeconds}) ELSE ${col.until} END`,
        }
      : {
          mfaFailedCount: next,
          mfaLockedUntil: sql`CASE WHEN ${next} >= ${SIGN_IN_FREE_FAILURES} THEN now() + make_interval(secs => ${lockSeconds}) ELSE ${col.until} END`,
        };
  const [row] = await db
    .update(users)
    .set(values)
    .where(eq(users.id, userId))
    .returning({ count: col.count, until: col.until });
  if (row == null || row.count < SIGN_IN_FREE_FAILURES || row.until == null) return null;

  await writeAudit(
    { table: userAuditLog, idColumn: 'user_id' },
    {
      entityId: userId,
      entityIdSnapshot: userId,
      action: 'account_locked',
      actor: 'system',
      actorLabel: 'login',
      after: {
        factor,
        failures: row.count,
        lockedUntil: row.until.toISOString(),
        ...authRequestOrigin(request),
      },
      notes: factor === 'password' ? 'Password sign-in locked' : 'MFA code entry locked',
    },
    db,
    request.log,
  );
  return row.until;
}

/** Resets the failure count and lock of a factor after a success. */
export async function clearSignInFailures(userId: string, factor: SignInFactor): Promise<void> {
  const col = columns(factor);
  const values =
    factor === 'password'
      ? { failedLoginCount: 0, loginLockedUntil: null }
      : { mfaFailedCount: 0, mfaLockedUntil: null };
  await db
    .update(users)
    .set(values)
    .where(and(eq(users.id, userId), or(gt(col.count, 0), sql`${col.until} IS NOT NULL`)));
}

/**
 * Cap on operator MFA codes sent by email or SMS (`POST /v1/auth/mfa/resend`):
 * at most MFA_RESEND_MAX in MFA_RESEND_WINDOW_MINUTES, the sign-in's own code
 * included. Five codes in 15 minutes covers a slow mailbox or a lost SMS and
 * stops the route from flooding a user's inbox or phone.
 */
export const MFA_RESEND_WINDOW_MINUTES = 15;
export const MFA_RESEND_MAX = 5;

/** Seconds until the user may get another MFA code, or null when it may now. */
export async function mfaResendRetryAfter(userId: string): Promise<number | null> {
  const [sent] = await db
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<string | null>`min(${mfaChallenges.createdAt})::text`,
    })
    .from(mfaChallenges)
    .where(
      and(
        eq(mfaChallenges.userId, userId),
        sql`${mfaChallenges.createdAt} > now() - make_interval(mins => ${MFA_RESEND_WINDOW_MINUTES})`,
      ),
    );
  if (sent == null || sent.count < MFA_RESEND_MAX) return null;
  const oldest = sent.oldest != null ? new Date(sent.oldest).getTime() : Date.now();
  return Math.max(1, Math.ceil((oldest + MFA_RESEND_WINDOW_MINUTES * 60_000 - Date.now()) / 1000));
}

/**
 * TOTP replay guard: stores the time step of an accepted code only when it is
 * later than the last accepted one, in one guarded UPDATE. False for a
 * replayed code, an earlier one, or the same code in two parallel requests.
 */
export async function acceptTotpStep(userId: string, step: number): Promise<boolean> {
  const [accepted] = await db
    .update(users)
    .set({ totpLastStep: step })
    .where(and(eq(users.id, userId), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))))
    .returning({ id: users.id });
  return accepted != null;
}
