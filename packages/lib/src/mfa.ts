// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { Sql } from 'postgres';

export interface CreateChallengeResult {
  challengeId: number;
  code: string;
}

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

export async function verifyMfaChallenge(
  client: Sql,
  challengeId: number,
  code: string,
  expected: { userId?: string; driverId?: string },
): Promise<boolean> {
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');

  const rows = await client`
    SELECT id, code_hash, expires_at, used_at, user_id, driver_id
    FROM mfa_challenges
    WHERE id = ${challengeId}
  `;

  const row = rows[0] as
    | {
        id: number;
        code_hash: string;
        expires_at: Date;
        used_at: Date | null;
        user_id: string | null;
        driver_id: string | null;
      }
    | undefined;

  if (row == null) return false;
  if (row.used_at != null) return false;
  if (new Date() > row.expires_at) return false;
  // Bind the challenge to the principal in the mfaToken JWT. Without this
  // an attacker who knows victim A's password can complete login as A by
  // submitting their own MFA code from a challenge owned by attacker B:
  // verifyMfaChallenge would return true for any unused/unexpired row that
  // matches the supplied code, and the handler then issues a session JWT
  // for the userId carried in the mfaToken.
  if (expected.userId != null && row.user_id !== expected.userId) return false;
  if (expected.driverId != null && row.driver_id !== expected.driverId) return false;
  if (expected.userId == null && expected.driverId == null) return false;
  // Constant-time compare so a remote attacker can't infer the SHA-256
  // hex prefix from response timing. Both inputs are guaranteed to be
  // 64-char hex strings (server-generated hash on insert; we just
  // hashed the user-supplied code above), so byteLength always matches.
  const stored = Buffer.from(row.code_hash, 'hex');
  const supplied = Buffer.from(codeHash, 'hex');
  if (stored.length !== supplied.length) return false;
  if (!crypto.timingSafeEqual(stored, supplied)) return false;

  await client`
    UPDATE mfa_challenges SET used_at = NOW() WHERE id = ${challengeId}
  `;

  return true;
}
