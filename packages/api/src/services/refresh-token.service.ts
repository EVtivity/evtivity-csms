// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { db } from '@evtivity/database';
import { refreshTokens } from '@evtivity/database';
import { eq, and, isNull } from 'drizzle-orm';
import { hashToken } from '../lib/token-hash.js';

const REFRESH_TOKEN_BYTES = 32;
const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface CreateRefreshTokenResult {
  rawToken: string;
  expiresAt: Date;
}

export async function createRefreshToken(opts: {
  userId?: string;
  driverId?: string;
  deviceId?: string | undefined;
}): Promise<CreateRefreshTokenResult> {
  const raw = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS);

  await db.insert(refreshTokens).values({
    userId: opts.userId,
    driverId: opts.driverId,
    tokenHash,
    type: 'session',
    deviceId: opts.deviceId,
    expiresAt,
  });

  return { rawToken: raw, expiresAt };
}

export interface ValidateRefreshTokenResult {
  userId: string | null;
  driverId: string | null;
  tokenId: number;
}

// Grace window for distinguishing legitimate concurrent rotation (two
// browser tabs hitting /refresh simultaneously) from a theft replay
// (attacker presenting a token that was rotated long ago). Within the
// window, presenting a revoked token is silently 401'd; outside it, we
// treat it as theft evidence and revoke every other session for the
// affected principal so neither party stays logged in without re-auth.
const ROTATION_GRACE_MS = 30 * 1000;

export async function validateAndRotateRefreshToken(
  rawToken: string,
  opts?: { deviceId?: string | undefined },
): Promise<ValidateRefreshTokenResult | null> {
  const tokenHash = hashToken(rawToken);

  const [row] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));

  if (row == null) return null;

  // Device-bound tokens (mobile) only validate when presented from the same
  // device. Web tokens have a null device_id and skip this check, so web is
  // unaffected. A mismatch is treated as invalid (the caller returns 401).
  if (row.deviceId != null && row.deviceId !== opts?.deviceId) {
    return null;
  }

  // OAuth 2.0 refresh-token-rotation theft detection: a revoked token
  // presented after the grace window is strong evidence that someone
  // replayed a stolen cookie. Revoke every active session refresh token
  // for the principal so attacker and victim are both forced through
  // re-auth; the legitimate owner can recover via password, the attacker
  // cannot.
  if (row.revokedAt != null) {
    const ageMs = Date.now() - row.revokedAt.getTime();
    if (ageMs > ROTATION_GRACE_MS) {
      if (row.userId != null) {
        await revokeAllUserSessions(row.userId);
      }
      if (row.driverId != null) {
        await revokeAllDriverRefreshTokens(row.driverId);
      }
    }
    return null;
  }

  // Check expiry (null expiresAt = non-expiring)
  if (row.expiresAt != null && row.expiresAt < new Date()) {
    // Expired - revoke it
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.id, row.id));
    return null;
  }

  // Atomic rotation: only one of two concurrent callers can win the CAS
  // transition from revoked_at=NULL to revoked_at=NOW(). If two refresh
  // requests arrive with the same token, the loser sees an empty
  // returning() array and gets null back, which the route turns into 401.
  // Without this guard both callers could succeed and we'd mint two new
  // refresh-token pairs from one revoked source -- a stolen-token replay
  // would silently produce parallel sessions instead of surfacing as 401.
  const updated = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.id, row.id), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });

  if (updated.length === 0) return null;

  return {
    userId: row.userId,
    driverId: row.driverId,
    tokenId: row.id,
  };
}

export async function revokeRefreshToken(rawToken: string): Promise<void> {
  const tokenHash = hashToken(rawToken);
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)));
}

/**
 * Revoke ONLY session refresh tokens for a user, leaving API keys intact.
 * Use this on security events that invalidate sessions (password change,
 * role change, MFA enable/disable) but should not affect long-lived API
 * keys -- those are separately-managed credentials with their own
 * lifecycle and re-derive permissions from the user on every request.
 */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.userId, userId),
        eq(refreshTokens.type, 'session'),
        isNull(refreshTokens.revokedAt),
      ),
    );
}

/**
 * Revoke ALL refresh tokens for a user, including API keys. Use only when
 * the user account itself is being invalidated (deactivation or delete).
 */
export async function revokeAllUserRefreshTokens(userId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

export async function revokeAllDriverRefreshTokens(driverId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.driverId, driverId), isNull(refreshTokens.revokedAt)));
}
