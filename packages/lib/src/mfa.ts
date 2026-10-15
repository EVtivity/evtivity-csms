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

export async function createMfaChallenge(
  client: Sql,
  opts: { userId?: string; driverId?: string; method: string },
): Promise<CreateChallengeResult> {
  const code = String(crypto.randomInt(100000, 999999));
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  // Invalidate any prior unused challenges for the same principal so a
  // resend leaves only the newest code valid. Without this an intercepted
  // first code stays usable for its full 5-minute TTL even after the user
  // requested a resend, narrowing the attacker's window only by their
  // own request cadence.
  if (opts.userId != null) {
    await client`
      UPDATE mfa_challenges SET used_at = NOW()
      WHERE user_id = ${opts.userId} AND used_at IS NULL
    `;
  }
  if (opts.driverId != null) {
    await client`
      UPDATE mfa_challenges SET used_at = NOW()
      WHERE driver_id = ${opts.driverId} AND used_at IS NULL
    `;
  }

  const rows = await client`
    INSERT INTO mfa_challenges (user_id, driver_id, code_hash, method, expires_at)
    VALUES (${opts.userId ?? null}, ${opts.driverId ?? null}, ${codeHash}, ${opts.method}, ${expiresAt})
    RETURNING id
  `;

  const row = rows[0] as { id: number } | undefined;
  if (row == null) {
    throw new Error('Failed to create MFA challenge');
  }

  return { challengeId: row.id, code };
}

/**
 * Checks a code against a challenge of the principal in the MFA token.
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
  expected: { userId?: string; driverId?: string },
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
