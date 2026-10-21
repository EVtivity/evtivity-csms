// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { Sql } from 'postgres';

export interface CreateChallengeResult {
  challengeId: number;
  code: string;
}

/**
 * Codes tried against one email or SMS challenge before it is refused. The
 * count lives on the challenge row (`mfa_challenges.attempts`), so every API
 * process and a restart see the same count.
 */
export const MFA_CHALLENGE_MAX_ATTEMPTS = 5;

/**
 * The outcome of a code against a challenge: `verified` (the code matched and
 * the challenge is now used), `invalid` (a wrong code, or an unknown, used,
 * expired or foreign challenge), or `exhausted` (no tries left: request a new
 * code).
 */
export type MfaChallengeResult = 'verified' | 'invalid' | 'exhausted';

/** The SHA-256 of the destination a code is bound to (a phone number), else null. */
function destinationHash(destination: string | undefined): string | null {
  return destination == null ? null : crypto.createHash('sha256').update(destination).digest('hex');
}

/**
 * What a code is for: a sign-in step (`sign_in`), a fresh proof from a signed-in
 * session (`proof`), or setting up a method or a new phone number (`setup`).
 * A code confirms only its own purpose, and sign-in codes are capped apart from
 * the others, so a stolen session cannot spend the owner's sign-in budget.
 */
export const MFA_CHALLENGE_PURPOSES = ['sign_in', 'proof', 'setup'] as const;
export type MfaChallengePurpose = (typeof MFA_CHALLENGE_PURPOSES)[number];

export interface MfaChallengeOptions {
  userId?: string;
  driverId?: string;
  method: string;
  purpose: MfaChallengePurpose;
  /** A destination the code is bound to (a phone number); verify must name the same one. */
  destination?: string | undefined;
}

export async function createMfaChallenge(
  client: Sql,
  opts: MfaChallengeOptions,
): Promise<CreateChallengeResult> {
  const code = String(crypto.randomInt(100000, 999999));
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  // Invalidate any prior unused challenges of the same principal and purpose so
  // a resend leaves only the newest code valid. Without this an intercepted
  // first code stays usable for its full 5-minute TTL even after the user
  // requested a resend. Other purposes keep theirs: a proof sent from a
  // session never voids the owner's sign-in code.
  if (opts.userId != null) {
    await client`
      UPDATE mfa_challenges SET used_at = NOW()
      WHERE user_id = ${opts.userId} AND purpose = ${opts.purpose} AND used_at IS NULL
    `;
  }
  if (opts.driverId != null) {
    await client`
      UPDATE mfa_challenges SET used_at = NOW()
      WHERE driver_id = ${opts.driverId} AND purpose = ${opts.purpose} AND used_at IS NULL
    `;
  }

  const rows = await client`
    INSERT INTO mfa_challenges (user_id, driver_id, code_hash, method, purpose, destination_hash, expires_at)
    VALUES (${opts.userId ?? null}, ${opts.driverId ?? null}, ${codeHash}, ${opts.method}, ${opts.purpose}, ${destinationHash(opts.destination)}, ${expiresAt})
    RETURNING id
  `;

  const row = rows[0] as { id: number } | undefined;
  if (row == null) {
    throw new Error('Failed to create MFA challenge');
  }

  return { challengeId: row.id, code };
}

/**
 * At most `max` codes to one account in `windowMinutes`, counted per bucket:
 * sign-in codes apart from the codes a signed-in session asks for (proof, setup).
 */
export interface MfaSendCap {
  max: number;
  windowMinutes: number;
  /**
   * For a code bound to a destination: at most this many codes to that one
   * destination in `destinationWindowMinutes`, across accounts.
   */
  destinationMax?: number;
  destinationWindowMinutes?: number;
  /**
   * `all` (default) counts every code to the destination, the account's own
   * included: a number the account has not proven yet (method setup, phone
   * change). `other_accounts` counts only the codes other accounts sent there
   * to a number they proved (sign-in, proof): the account's own confirmed
   * number, which its per-account cap already bounds. Setup codes of other
   * accounts are left out, so an account that types someone else's number and
   * asks for setup codes cannot block that owner's sign-in and proof codes.
   */
  destinationScope?: 'all' | 'other_accounts';
}

/**
 * The cap refused a new code: seconds until the next one may go out, and the
 * newest open challenge of the same method and destination, whose code the
 * account already received.
 */
export interface MfaChallengeLimited {
  limited: true;
  retryAfterSeconds: number;
  openChallengeId: number | null;
}

export function isMfaChallengeLimited(
  result: CreateChallengeResult | MfaChallengeLimited,
): result is MfaChallengeLimited {
  return 'limited' in result;
}

/**
 * createMfaChallenge under a per-account cap. A transaction-scoped advisory
 * lock on the account serializes the count and the insert, so parallel sends
 * cannot pass the cap together.
 */
export async function createCappedMfaChallenge(
  client: Sql,
  opts: MfaChallengeOptions,
  cap: MfaSendCap,
): Promise<CreateChallengeResult | MfaChallengeLimited> {
  if (opts.userId == null && opts.driverId == null) {
    throw new Error('An MFA challenge needs a user or a driver');
  }
  const lockKey =
    opts.userId != null
      ? `mfa_send:user:${opts.userId}`
      : `mfa_send:driver:${String(opts.driverId)}`;
  const result = await client.begin(async (tx) => {
    const sql = tx as unknown as Sql;
    await sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    const signIn = opts.purpose === 'sign_in';
    const recent = await sql`
      SELECT count(*)::int AS count,
        ceil(extract(epoch FROM (min(created_at) + make_interval(mins => ${cap.windowMinutes}) - now())))::int AS retry_after
      FROM mfa_challenges
      WHERE user_id IS NOT DISTINCT FROM ${opts.userId ?? null}
        AND driver_id IS NOT DISTINCT FROM ${opts.driverId ?? null}
        AND (purpose = 'sign_in') = ${signIn}
        AND created_at > now() - make_interval(mins => ${cap.windowMinutes})
    `;
    const sent = recent[0] as { count: number; retry_after: number | null } | undefined;
    if (sent != null && sent.count >= cap.max) {
      const open = await sql`
        SELECT id FROM mfa_challenges
        WHERE user_id IS NOT DISTINCT FROM ${opts.userId ?? null}
          AND driver_id IS NOT DISTINCT FROM ${opts.driverId ?? null}
          AND method = ${opts.method}
          AND purpose = ${opts.purpose}
          AND destination_hash IS NOT DISTINCT FROM ${destinationHash(opts.destination)}
          AND used_at IS NULL
          AND expires_at > now()
          AND attempts < ${MFA_CHALLENGE_MAX_ATTEMPTS}
        ORDER BY id DESC
        LIMIT 1
      `;
      const openRow = open[0] as { id: number } | undefined;
      const limited: MfaChallengeLimited = {
        limited: true,
        retryAfterSeconds: Math.max(1, sent.retry_after ?? 1),
        openChallengeId: openRow?.id ?? null,
      };
      return limited;
    }
    const hash = destinationHash(opts.destination);
    if (hash != null && cap.destinationMax != null) {
      // Every account sending to one number takes the same lock, so parallel sends from
      // several accounts cannot pass the per-number cap together.
      const windowMinutes = cap.destinationWindowMinutes ?? cap.windowMinutes;
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`mfa_send:dest:${hash}`}))`;
      const othersOnly = cap.destinationScope === 'other_accounts';
      const toNumber = await sql`
        SELECT count(*)::int AS count,
          ceil(extract(epoch FROM (min(created_at) + make_interval(mins => ${windowMinutes}) - now())))::int AS retry_after
        FROM mfa_challenges
        WHERE destination_hash = ${hash}
          AND created_at > now() - make_interval(mins => ${windowMinutes})
          AND NOT (
            ${othersOnly}
            AND (
              purpose = 'setup'
              OR (
                user_id IS NOT DISTINCT FROM ${opts.userId ?? null}
                AND driver_id IS NOT DISTINCT FROM ${opts.driverId ?? null}
              )
            )
          )
      `;
      const sentTo = toNumber[0] as { count: number; retry_after: number | null } | undefined;
      if (sentTo != null && sentTo.count >= cap.destinationMax) {
        const limited: MfaChallengeLimited = {
          limited: true,
          retryAfterSeconds: Math.max(1, sentTo.retry_after ?? 1),
          openChallengeId: null,
        };
        return limited;
      }
    }
    return createMfaChallenge(sql, opts);
  });
  return result;
}

/**
 * Checks a code against a challenge of the principal in the MFA token, sent
 * for the method being checked: a code sent by email never confirms SMS.
 *
 * Each try is counted first by a guarded UPDATE that matches only an unused,
 * unexpired challenge of that principal with tries left, so parallel requests
 * and several API processes share one count. A matching code then marks the
 * challenge used with a second guarded UPDATE (`used_at IS NULL`), so of two
 * requests with the right code only one is verified.
 */
export async function verifyMfaChallenge(
  client: Sql,
  challengeId: number,
  code: string,
  expected: {
    userId?: string;
    driverId?: string;
    method: string;
    purpose: MfaChallengePurpose;
    destination?: string | undefined;
  },
): Promise<MfaChallengeResult> {
  // Bind the challenge to the principal in the mfaToken JWT. Without this
  // an attacker who knows victim A's password could complete A's login with
  // a code from a challenge owned by attacker B.
  if (expected.userId == null && expected.driverId == null) return 'invalid';
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');

  // Expiry is decided in SQL: on the shared client (drizzle replaces its date
  // parsers) a raw expires_at comes back as postgres text.
  const counted = await client`
    UPDATE mfa_challenges SET attempts = attempts + 1
    WHERE id = ${challengeId}
      AND used_at IS NULL
      AND expires_at > now()
      AND attempts < ${MFA_CHALLENGE_MAX_ATTEMPTS}
      AND user_id IS NOT DISTINCT FROM ${expected.userId ?? null}
      AND driver_id IS NOT DISTINCT FROM ${expected.driverId ?? null}
      AND method = ${expected.method}
      AND purpose = ${expected.purpose}
      AND destination_hash IS NOT DISTINCT FROM ${destinationHash(expected.destination)}
    RETURNING code_hash
  `;
  const row = counted[0] as { code_hash: string } | undefined;
  if (row == null) {
    const spent = await client`
      SELECT 1 FROM mfa_challenges
      WHERE id = ${challengeId}
        AND used_at IS NULL
        AND expires_at > now()
        AND attempts >= ${MFA_CHALLENGE_MAX_ATTEMPTS}
        AND user_id IS NOT DISTINCT FROM ${expected.userId ?? null}
        AND driver_id IS NOT DISTINCT FROM ${expected.driverId ?? null}
        AND method = ${expected.method}
        AND purpose = ${expected.purpose}
        AND destination_hash IS NOT DISTINCT FROM ${destinationHash(expected.destination)}
    `;
    return spent.length > 0 ? 'exhausted' : 'invalid';
  }

  // Constant-time compare so a remote attacker can't infer the SHA-256
  // hex prefix from response timing. Both are 64-char hex strings.
  const stored = Buffer.from(row.code_hash, 'hex');
  const supplied = Buffer.from(codeHash, 'hex');
  if (stored.length !== supplied.length || !crypto.timingSafeEqual(stored, supplied)) {
    return 'invalid';
  }

  const used = await client`
    UPDATE mfa_challenges SET used_at = NOW()
    WHERE id = ${challengeId} AND used_at IS NULL
    RETURNING id
  `;
  return used.length > 0 ? 'verified' : 'invalid';
}
