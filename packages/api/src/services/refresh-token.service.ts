// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { db } from '@evtivity/database';
import { refreshTokens } from '@evtivity/database';
import { eq, and, isNull } from 'drizzle-orm';

const REFRESH_TOKEN_BYTES = 32;
const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export interface CreateRefreshTokenResult {
  rawToken: string;
  expiresAt: Date;
}

export async function createRefreshToken(opts: {
  userId?: string;
  driverId?: string;
}): Promise<CreateRefreshTokenResult> {
  const raw = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS);

  await db.insert(refreshTokens).values({
    userId: opts.userId,
    driverId: opts.driverId,
    tokenHash,
    type: 'session',
    expiresAt,
  });

  return { rawToken: raw, expiresAt };
}

export interface ValidateRefreshTokenResult {
  userId: string | null;
  driverId: string | null;
  tokenId: number;
}

export async function validateAndRotateRefreshToken(
  rawToken: string,
): Promise<ValidateRefreshTokenResult | null> {
  const tokenHash = hashToken(rawToken);

  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)));

  if (row == null) return null;

  // Check expiry (null expiresAt = non-expiring)
  if (row.expiresAt != null && row.expiresAt < new Date()) {
    // Expired - revoke it
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.id, row.id));
    return null;
  }

  // Revoke old token (rotation)
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));

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
