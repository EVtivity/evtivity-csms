// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { db } from '@evtivity/database';
import { refreshTokens } from '@evtivity/database';
import { eq, and, isNull, desc } from 'drizzle-orm';

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

const API_KEY_BYTES = 32;

export interface CreateApiKeyResult {
  id: number;
  rawToken: string;
  name: string;
  expiresAt: Date | null;
  createdAt: Date;
}

export async function createApiKey(opts: {
  userId: string;
  name: string;
  expiresAt?: Date | null;
  permissions?: string[] | null;
}): Promise<CreateApiKeyResult> {
  const raw = crypto.randomBytes(API_KEY_BYTES).toString('hex');
  const tokenHash = hashToken(raw);

  const rows = await db
    .insert(refreshTokens)
    .values({
      userId: opts.userId,
      tokenHash,
      type: 'api_key',
      name: opts.name,
      expiresAt: opts.expiresAt ?? null,
      permissions: opts.permissions ?? null,
      tokenSuffix: raw.slice(-8),
    })
    .returning({ id: refreshTokens.id, createdAt: refreshTokens.createdAt });

  const row = rows[0];
  if (!row) {
    throw new Error('Failed to insert API key');
  }

  return {
    id: row.id,
    rawToken: raw,
    name: opts.name,
    expiresAt: opts.expiresAt ?? null,
    createdAt: row.createdAt,
  };
}

export interface ApiKeyRow {
  id: number;
  name: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  permissions: unknown;
  tokenSuffix: string | null;
}

export async function listApiKeys(userId: string): Promise<ApiKeyRow[]> {
  return db
    .select({
      id: refreshTokens.id,
      name: refreshTokens.name,
      createdAt: refreshTokens.createdAt,
      expiresAt: refreshTokens.expiresAt,
      lastUsedAt: refreshTokens.lastUsedAt,
      permissions: refreshTokens.permissions,
      tokenSuffix: refreshTokens.tokenSuffix,
    })
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.userId, userId),
        eq(refreshTokens.type, 'api_key'),
        isNull(refreshTokens.revokedAt),
      ),
    )
    .orderBy(desc(refreshTokens.createdAt));
}

export async function revokeApiKey(id: number, userId: string): Promise<boolean> {
  const result = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.id, id),
        eq(refreshTokens.userId, userId),
        eq(refreshTokens.type, 'api_key'),
        isNull(refreshTokens.revokedAt),
      ),
    )
    .returning({ id: refreshTokens.id });

  return result.length > 0;
}

export async function updateApiKeyLastUsed(tokenHash: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.tokenHash, tokenHash),
        eq(refreshTokens.type, 'api_key'),
        isNull(refreshTokens.revokedAt),
      ),
    );
}
