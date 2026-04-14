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
): Promise<boolean> {
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');

  const rows = await client`
    SELECT id, code_hash, expires_at, used_at
    FROM mfa_challenges
    WHERE id = ${challengeId}
  `;

  const row = rows[0] as
    | {
        id: number;
        code_hash: string;
        expires_at: Date;
        used_at: Date | null;
      }
    | undefined;

  if (row == null) return false;
  if (row.used_at != null) return false;
  if (new Date() > row.expires_at) return false;
  if (row.code_hash !== codeHash) return false;

  await client`
    UPDATE mfa_challenges SET used_at = NOW() WHERE id = ${challengeId}
  `;

  return true;
}
