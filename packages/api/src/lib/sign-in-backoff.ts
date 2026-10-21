// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  client,
  db,
  driverAuditLog,
  drivers,
  users,
  writeAudit,
  userAuditLog,
} from '@evtivity/database';
import {
  createCappedMfaChallenge,
  dispatchSystemNotification,
  isMfaChallengeLimited,
  type CreateChallengeResult,
  type MfaChallengeLimited,
  type MfaChallengePurpose,
} from '@evtivity/lib';
import type { MfaAccount } from '../services/mfa-factor.service.js';
import { mfaCodeDestination, mfaCodeRecipient, type MfaContact } from './mfa-contact.js';
import { authRequestOrigin } from './auth-audit.js';

/**
 * Per-account backoff for operator and driver sign-ins, on top of the per-IP
 * route rate limits, which do not stop guesses at one account spread over
 * many addresses.
 *
 * - SIGN_IN_FREE_FAILURES: failures in a row before the first lock. Five
 *   leaves room for typos and a caps-lock key.
 * - SIGN_IN_BASE_LOCK_SECONDS, doubled for every further failure: 30 s, 60 s,
 *   2 min, ... up to SIGN_IN_MAX_LOCK_SECONDS. The cap of 15 minutes keeps
 *   an attacker who fails on purpose from locking the owner out for long,
 *   and still holds a guesser to a few attempts an hour.
 *
 * The same rule applies to password sign-ins and to MFA codes after the
 * password step, each with its own counter on `users` and on `drivers`. A
 * success resets it. While locked, a password sign-in answers as for a wrong
 * password (no account state leaks); an MFA code answers 429 `MFA_LOCKED`,
 * since that caller already proved the password. Every check takes its try with
 * `takeSignInAttempt` before it runs, so the lock holds for parallel requests.
 */
export const SIGN_IN_FREE_FAILURES = 5;
export const SIGN_IN_BASE_LOCK_SECONDS = 30;
export const SIGN_IN_MAX_LOCK_SECONDS = 15 * 60;

/**
 * The counter a try counts on: `password` and `mfa` for sign-in, `proof` for the
 * factor proofs a signed-in session sends (adding a factor, replacing recovery
 * codes), so a stolen session that guesses wrong cannot keep the owner's sign-in
 * locked.
 */
export type SignInFactor = 'password' | 'mfa' | 'proof';

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

function lockValues(count: AnyPgColumn, until: AnyPgColumn): { count: SQL; until: SQL } {
  const next = sql`${count} + 1`;
  const lockSeconds = sql`LEAST(${SIGN_IN_BASE_LOCK_SECONDS} * POWER(2, LEAST(${next} - ${SIGN_IN_FREE_FAILURES}, 20)), ${SIGN_IN_MAX_LOCK_SECONDS})`;
  return {
    count: next,
    until: sql`CASE WHEN ${next} >= ${SIGN_IN_FREE_FAILURES} THEN now() + make_interval(secs => ${lockSeconds}) ELSE ${until} END`,
  };
}

/** The lock times of an account, or null for an unknown one. */
export async function signInLocks(account: MfaAccount): Promise<{
  loginLockedUntil: Date | null;
  mfaLockedUntil: Date | null;
  proofLockedUntil: Date | null;
} | null> {
  if ('userId' in account) {
    const [row] = await db
      .select({
        loginLockedUntil: users.loginLockedUntil,
        mfaLockedUntil: users.mfaLockedUntil,
        proofLockedUntil: users.proofLockedUntil,
      })
      .from(users)
      .where(eq(users.id, account.userId));
    return row ?? null;
  }
  const [row] = await db
    .select({
      loginLockedUntil: drivers.loginLockedUntil,
      mfaLockedUntil: drivers.mfaLockedUntil,
      proofLockedUntil: drivers.proofLockedUntil,
    })
    .from(drivers)
    .where(eq(drivers.id, account.driverId));
  return row ?? null;
}

/** The count and lock columns of a factor on `users`. */
function userCounter(factor: SignInFactor): { count: AnyPgColumn; until: AnyPgColumn } {
  if (factor === 'password')
    return { count: users.failedLoginCount, until: users.loginLockedUntil };
  if (factor === 'mfa') return { count: users.mfaFailedCount, until: users.mfaLockedUntil };
  return { count: users.proofFailedCount, until: users.proofLockedUntil };
}

/** The count and lock columns of a factor on `drivers`. */
function driverCounter(factor: SignInFactor): { count: AnyPgColumn; until: AnyPgColumn } {
  if (factor === 'password') {
    return { count: drivers.failedLoginCount, until: drivers.loginLockedUntil };
  }
  if (factor === 'mfa') return { count: drivers.mfaFailedCount, until: drivers.mfaLockedUntil };
  return { count: drivers.proofFailedCount, until: drivers.proofLockedUntil };
}

/** The row values that set a factor's count and lock (the same keys on both tables). */
function counterValues(
  factor: SignInFactor,
  count: SQL | number,
  until: SQL | null,
):
  | { failedLoginCount: SQL | number; loginLockedUntil: SQL | null }
  | { mfaFailedCount: SQL | number; mfaLockedUntil: SQL | null }
  | { proofFailedCount: SQL | number; proofLockedUntil: SQL | null } {
  if (factor === 'password') return { failedLoginCount: count, loginLockedUntil: until };
  if (factor === 'mfa') return { mfaFailedCount: count, mfaLockedUntil: until };
  return { proofFailedCount: count, proofLockedUntil: until };
}

/**
 * Counts a failure in one UPDATE that matches only an account the factor's lock
 * does not hold, and returns the new count and lock time; no row means locked.
 */
async function countFailure(
  account: MfaAccount,
  factor: SignInFactor,
): Promise<{ count: number; until: Date | null } | undefined> {
  if ('userId' in account) {
    const { count, until } = userCounter(factor);
    const v = lockValues(count, until);
    const [row] = await db
      .update(users)
      .set(counterValues(factor, v.count, v.until))
      .where(and(eq(users.id, account.userId), notLocked(until)))
      .returning({ count, until });
    return row;
  }
  const { count, until } = driverCounter(factor);
  const v = lockValues(count, until);
  const [row] = await db
    .update(drivers)
    .set(counterValues(factor, v.count, v.until))
    .where(and(eq(drivers.id, account.driverId), notLocked(until)))
    .returning({ count, until });
  return row;
}

function notLocked(until: AnyPgColumn): SQL {
  return sql`(${until} IS NULL OR ${until} <= now())`;
}

async function auditLock(
  request: FastifyRequest,
  account: MfaAccount,
  factor: SignInFactor,
  row: { count: number; until: Date | null },
): Promise<Date | null> {
  if (row.count < SIGN_IN_FREE_FAILURES || row.until == null) return null;

  const accountId = 'userId' in account ? account.userId : account.driverId;
  const audit =
    'userId' in account
      ? { table: userAuditLog, idColumn: 'user_id' as const }
      : { table: driverAuditLog, idColumn: 'driver_id' as const };
  await writeAudit(
    audit,
    {
      entityId: accountId,
      entityIdSnapshot: accountId,
      action: 'account_locked',
      actor: 'system',
      actorLabel: 'login',
      after: {
        factor,
        failures: row.count,
        lockedUntil: row.until.toISOString(),
        ...authRequestOrigin(request),
      },
      notes:
        factor === 'password'
          ? 'Password sign-in locked'
          : factor === 'mfa'
            ? 'MFA code entry locked'
            : 'Factor proofs of the signed-in session locked',
    },
    db,
    request.log,
  );
  return row.until;
}

/** One try of a factor: granted (and already counted as a failure), or refused while locked. */
export type SignInAttempt =
  | {
      granted: true;
      account: MfaAccount;
      factor: SignInFactor;
      failures: number;
      lockedUntil: Date | null;
    }
  | { granted: false; lockedUntil: Date | null };

/**
 * Takes one try of a factor before it is checked. One UPDATE both checks the lock
 * and counts the try as a failure, so parallel tries can never pass the lock: of N
 * parallel wrong guesses past the free failures only the ones the count allows are
 * checked. A success clears the count (`clearSignInFailures`); a failure only needs
 * `recordAttemptFailure` for the audit of the lock it set.
 */
export async function takeSignInAttempt(
  account: MfaAccount,
  factor: SignInFactor,
): Promise<SignInAttempt> {
  const row = await countFailure(account, factor);
  if (row != null) {
    return { granted: true, account, factor, failures: row.count, lockedUntil: row.until };
  }
  const locks = await signInLocks(account);
  const until =
    factor === 'password'
      ? locks?.loginLockedUntil
      : factor === 'mfa'
        ? locks?.mfaLockedUntil
        : locks?.proofLockedUntil;
  return { granted: false, lockedUntil: until ?? null };
}

/** Records a failed granted try: audits the lock its count set. Returns that lock time, or null. */
export async function recordAttemptFailure(
  request: FastifyRequest,
  attempt: Extract<SignInAttempt, { granted: true }>,
): Promise<Date | null> {
  return auditLock(request, attempt.account, attempt.factor, {
    count: attempt.failures,
    until: attempt.lockedUntil,
  });
}

/** Resets the failure count and lock of a factor after a success. */
export async function clearSignInFailures(
  account: MfaAccount,
  factor: SignInFactor,
): Promise<void> {
  if ('userId' in account) {
    const { count, until } = userCounter(factor);
    await db
      .update(users)
      .set(counterValues(factor, 0, null))
      .where(and(eq(users.id, account.userId), or(gt(count, 0), sql`${until} IS NOT NULL`)));
    return;
  }
  const { count, until } = driverCounter(factor);
  await db
    .update(drivers)
    .set(counterValues(factor, 0, null))
    .where(and(eq(drivers.id, account.driverId), or(gt(count, 0), sql`${until} IS NOT NULL`)));
}

/**
 * Cap on MFA codes sent by email or SMS to one operator or driver (sign-in,
 * resend, setup, factor proof, recovery code regenerate, phone change): at most
 * MFA_RESEND_MAX in MFA_RESEND_WINDOW_MINUTES. Five codes in 15
 * minutes covers a slow mailbox or a lost SMS and stops the routes from
 * flooding an inbox or phone.
 */
export const MFA_RESEND_WINDOW_MINUTES = 15;
export const MFA_RESEND_MAX = 5;

/** What a code is for and where an SMS code goes (see `createAccountMfaChallenge`). */
export interface AccountChallengeOptions {
  purpose: MfaChallengePurpose;
  /** The phone number an SMS code goes to: the code is bound to it and the per-number cap applies. */
  destination?: string | undefined;
  /**
   * The destination is the account's confirmed SMS number (sign-in, proof): the
   * per-number cap counts only the codes other accounts sent there, since the
   * per-account cap already bounds the account's own.
   */
  destinationProven?: boolean;
}

/**
 * Creates an email or SMS code challenge for the account under the resend cap,
 * counted and inserted under a per-account lock so parallel sends cannot pass
 * it. Sign-in codes and a signed-in session's codes (proof, setup) are capped
 * apart. `destination` binds the code to a phone number and applies the
 * per-number cap across accounts.
 */
export async function createAccountMfaChallenge(
  account: MfaAccount,
  method: string,
  opts: AccountChallengeOptions,
): Promise<CreateChallengeResult | MfaChallengeLimited> {
  return createCappedMfaChallenge(
    client,
    {
      ...account,
      method,
      purpose: opts.purpose,
      ...(opts.destination != null ? { destination: opts.destination } : {}),
    },
    {
      max: MFA_RESEND_MAX,
      windowMinutes: MFA_RESEND_WINDOW_MINUTES,
      destinationMax: MFA_DESTINATION_MAX,
      destinationWindowMinutes: MFA_DESTINATION_WINDOW_MINUTES,
      destinationScope: opts.destinationProven === true ? 'other_accounts' : 'all',
    },
  );
}

/**
 * SMS codes to one phone number: at most MFA_DESTINATION_MAX in
 * MFA_DESTINATION_WINDOW_MINUTES, counting every account for a number not yet
 * proven (setup, phone change) and the other accounts for an account's own
 * confirmed number (sign-in, proof). Three an hour covers a retyped or lost code
 * and keeps the routes from texting one number over and over (SMS pumping
 * through many accounts).
 */
export const MFA_DESTINATION_MAX = 3;
export const MFA_DESTINATION_WINDOW_MINUTES = 60;

/**
 * Sends the code of a sign-in's email or SMS step under the resend cap and
 * returns its challenge id. Over the cap no new code goes out: the newest open
 * challenge of the method stands (its code was already sent), else none.
 */
export async function sendSignInMfaCode(
  account: MfaAccount,
  method: string,
  contact: MfaContact,
  templatesDir: string | string[],
): Promise<number | undefined> {
  const challenge = await createAccountMfaChallenge(account, method, {
    purpose: 'sign_in',
    destination: mfaCodeDestination(method, contact),
    destinationProven: true,
  });
  if (isMfaChallengeLimited(challenge)) return challenge.openChallengeId ?? undefined;
  await dispatchSystemNotification(
    client,
    'mfa.VerificationCode',
    mfaCodeRecipient(method, contact),
    { code: challenge.code },
    templatesDir,
  );
  return challenge.challengeId;
}

/** The 429 reply of a code the resend cap refused. */
export async function sendMfaResendLimited(
  reply: FastifyReply,
  retryAfterSeconds: number,
): Promise<void> {
  void reply.header('Retry-After', String(retryAfterSeconds));
  await reply.status(429).send({
    error: 'Too many codes sent. Try again later.',
    code: 'MFA_RESEND_LIMITED',
    retryAfterSeconds,
  });
}

/**
 * TOTP replay guard for operators and drivers: stores the time step of an
 * accepted code only when it is later than the last accepted one, in one
 * guarded UPDATE. False for a replayed code, an earlier one, or the same code
 * in two parallel requests.
 */
export async function acceptTotpStep(account: MfaAccount, step: number): Promise<boolean> {
  if ('userId' in account) {
    const [accepted] = await db
      .update(users)
      .set({ totpLastStep: step })
      .where(
        and(
          eq(users.id, account.userId),
          or(isNull(users.totpLastStep), lt(users.totpLastStep, step)),
        ),
      )
      .returning({ id: users.id });
    return accepted != null;
  }
  const [accepted] = await db
    .update(drivers)
    .set({ totpLastStep: step })
    .where(
      and(
        eq(drivers.id, account.driverId),
        or(isNull(drivers.totpLastStep), lt(drivers.totpLastStep, step)),
      ),
    )
    .returning({ id: drivers.id });
  return accepted != null;
}
