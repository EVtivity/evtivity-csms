// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { db, drivers } from '@evtivity/database';
import { refreshTokens } from '@evtivity/database';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { hashToken } from '../lib/token-hash.js';
import { announceDriverSessionChange } from '../lib/driver-active.js';

const REFRESH_TOKEN_BYTES = 32;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CreateRefreshTokenResult {
  rawToken: string;
  expiresAt: Date;
}

/**
 * Stores a new session refresh token that expires `lifetimeDays` from now: the operator or
 * driver refresh days of the session settings. A rotation issues a new one, so the window slides.
 */
export async function createRefreshToken(opts: {
  userId?: string;
  driverId?: string;
  deviceId?: string | undefined;
  /** 'mobile' for a driver refresh token issued to the app: its renewals keep the claim. */
  client?: 'mobile' | null;
  lifetimeDays: number;
}): Promise<CreateRefreshTokenResult> {
  const raw = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + opts.lifetimeDays * DAY_MS);

  await db.insert(refreshTokens).values({
    userId: opts.userId,
    driverId: opts.driverId,
    tokenHash,
    type: 'session',
    deviceId: opts.deviceId,
    client: opts.client ?? null,
    expiresAt,
  });

  return { rawToken: raw, expiresAt };
}

export interface ValidateRefreshTokenResult {
  userId: string | null;
  driverId: string | null;
  tokenId: number;
  /** 'mobile' when the token was issued to the mobile app. */
  client: 'mobile' | null;
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
        await endDriverSessions(row.driverId);
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
    client: row.client === 'mobile' ? 'mobile' : null,
  };
}

/**
 * The operator of a web session refresh token that would rotate now (not
 * revoked, not expired, bound to no device), without rotating it; null otherwise.
 */
export async function sessionRefreshTokenUserId(rawToken: string): Promise<string | null> {
  const [row] = await db
    .select({
      userId: refreshTokens.userId,
      deviceId: refreshTokens.deviceId,
      revokedAt: refreshTokens.revokedAt,
      expiresAt: refreshTokens.expiresAt,
    })
    .from(refreshTokens)
    .where(
      and(eq(refreshTokens.tokenHash, hashToken(rawToken)), eq(refreshTokens.type, 'session')),
    );
  if (row == null || row.revokedAt != null || row.deviceId != null) return null;
  if (row.expiresAt != null && row.expiresAt < new Date()) return null;
  return row.userId;
}

/**
 * The driver of a session refresh token that would rotate now (not revoked,
 * not expired, and bound to this device or to none, as the rotation checks),
 * without rotating it; null otherwise.
 */
export async function sessionRefreshTokenDriverId(
  rawToken: string,
  deviceId: string | undefined,
): Promise<string | null> {
  const [row] = await db
    .select({
      driverId: refreshTokens.driverId,
      deviceId: refreshTokens.deviceId,
      revokedAt: refreshTokens.revokedAt,
      expiresAt: refreshTokens.expiresAt,
    })
    .from(refreshTokens)
    .where(
      and(eq(refreshTokens.tokenHash, hashToken(rawToken)), eq(refreshTokens.type, 'session')),
    );
  if (row == null || row.revokedAt != null) return null;
  if (row.deviceId != null && row.deviceId !== deviceId) return null;
  if (row.expiresAt != null && row.expiresAt < new Date()) return null;
  return row.driverId;
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

async function revokeAllDriverRefreshTokens(driverId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.driverId, driverId), isNull(refreshTokens.revokedAt)));
}

/**
 * Ends the driver's access tokens: raises the session version, so every
 * driver access token issued before is refused at its next request, and ends
 * the driver's open portal streams on every pod. Refresh tokens stay, so
 * another device renews with its own (portal sign-out, like the operator one).
 */
export async function bumpDriverSessionVersion(driverId: string): Promise<number | null> {
  try {
    const [row] = await db
      .update(drivers)
      .set({ sessionVersion: sql`${drivers.sessionVersion} + 1` })
      .where(eq(drivers.id, driverId))
      .returning({ sessionVersion: drivers.sessionVersion });
    return row?.sessionVersion ?? null;
  } finally {
    announceDriverSessionChange(driverId);
  }
}

/**
 * Ends every session of the driver: the access tokens
 * (`bumpDriverSessionVersion`) and every refresh token. Password reset and
 * change, portal activation, deactivation, erasure and a replayed refresh
 * token call it; never revoke driver refresh tokens without it.
 */
export async function endDriverSessions(driverId: string): Promise<void> {
  await bumpDriverSessionVersion(driverId);
  await revokeAllDriverRefreshTokens(driverId);
}
