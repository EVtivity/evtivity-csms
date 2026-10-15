// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, desc, eq, gte, inArray, lte, notExists, notInArray, or, sql } from 'drizzle-orm';
import { db, driverTokens, driverTokenTombstones } from '@evtivity/database';
import { OCPI_TOKEN_TYPE_BY_DRIVER_TYPE } from '@evtivity/lib';
import type { SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { EmspTokenRow } from '../transformers/token.transformer.js';

// Internal token-type markers that have no OCPI meaning. NoAuthorization is
// the free-vend / auto-start marker and Central is the CSMS-issued internal
// token; neither represents a physical card a partner CPO could authorize.
export const INTERNAL_TOKEN_TYPES = ['NoAuthorization', 'Central'];

/** The OCPI Token type of a driver token type column, in SQL (same map as ocpiTokenTypeOf). */
function ocpiTypeSql(column: AnyPgColumn): SQL {
  const cases = Object.entries(OCPI_TOKEN_TYPE_BY_DRIVER_TYPE).map(
    ([driverType, ocpiType]) => sql`WHEN ${driverType} THEN ${ocpiType}`,
  );
  return sql`(CASE ${column} ${sql.join(cases, sql` `)} ELSE 'RFID' END)`;
}

/**
 * A tombstone is replaced when a published live token has its uid and OCPI
 * type: OCPI identifies a Token by uid and type (12.4.2), so a card changed
 * from ISO14443 to ISO15693 (both RFID) is the same Token, still valid.
 */
function replacedByLiveToken(): SQL | undefined {
  return and(
    eq(driverTokens.idToken, driverTokenTombstones.idToken),
    notInArray(driverTokens.tokenType, INTERNAL_TOKEN_TYPES),
    sql`${ocpiTypeSql(driverTokens.tokenType)} = ${ocpiTypeSql(driverTokenTombstones.tokenType)}`,
  );
}

/**
 * Our driver tokens as the eMSP Tokens sender serves them (OCPI 12.2.2): the
 * live tokens plus the tombstones of deleted or renamed token values (OCPI
 * cannot delete a Token, so they are served as valid = false) that no live
 * token replaced, newest last_updated first.
 */
export async function listEmspTokens(params: {
  offset: number;
  limit: number;
  dateFrom: Date | null;
  dateTo: Date | null;
}): Promise<{ rows: EmspTokenRow[]; total: number }> {
  const { offset, limit, dateFrom, dateTo } = params;
  const liveWhere = and(
    notInArray(driverTokens.tokenType, INTERNAL_TOKEN_TYPES),
    dateFrom != null ? gte(driverTokens.updatedAt, dateFrom) : undefined,
    dateTo != null ? lte(driverTokens.updatedAt, dateTo) : undefined,
  );
  const deadWhere = and(
    notInArray(driverTokenTombstones.tokenType, INTERNAL_TOKEN_TYPES),
    dateFrom != null ? gte(driverTokenTombstones.invalidatedAt, dateFrom) : undefined,
    dateTo != null ? lte(driverTokenTombstones.invalidatedAt, dateTo) : undefined,
    notExists(
      db
        .select({ one: sql`1` })
        .from(driverTokens)
        .where(replacedByLiveToken()),
    ),
  );

  const live = db
    .select({
      idToken: driverTokens.idToken,
      tokenType: driverTokens.tokenType,
      isActive: driverTokens.isActive,
      expiresAt: driverTokens.expiresAt,
      revokedAt: driverTokens.revokedAt,
      updatedAt: driverTokens.updatedAt,
      tombstone: sql<boolean>`false`.as('tombstone'),
    })
    .from(driverTokens)
    .where(liveWhere);
  const dead = db
    .select({
      idToken: driverTokenTombstones.idToken,
      tokenType: driverTokenTombstones.tokenType,
      isActive: sql<boolean>`false`.as('is_active'),
      expiresAt: sql<Date | null>`null::timestamptz`.as('expires_at'),
      revokedAt: driverTokenTombstones.invalidatedAt,
      updatedAt: driverTokenTombstones.invalidatedAt,
      tombstone: sql<boolean>`true`.as('tombstone'),
    })
    .from(driverTokenTombstones)
    .where(deadWhere);

  const [rows, liveCount, deadCount] = await Promise.all([
    live
      .unionAll(dead)
      .orderBy(desc(sql`updated_at`), sql`id_token`)
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(driverTokens)
      .where(liveWhere),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(driverTokenTombstones)
      .where(deadWhere),
  ]);

  return {
    rows: rows.map(toRow),
    total: (liveCount[0]?.count ?? 0) + (deadCount[0]?.count ?? 0),
  };
}

/** The live tokens with these ids (internal types left out), for a push. */
export async function loadEmspTokens(tokenIds: readonly string[]): Promise<EmspTokenRow[]> {
  if (tokenIds.length === 0) return [];
  const rows = await db
    .select({
      idToken: driverTokens.idToken,
      tokenType: driverTokens.tokenType,
      isActive: driverTokens.isActive,
      expiresAt: driverTokens.expiresAt,
      revokedAt: driverTokens.revokedAt,
      updatedAt: driverTokens.updatedAt,
    })
    .from(driverTokens)
    .where(
      and(
        inArray(driverTokens.id, [...tokenIds]),
        notInArray(driverTokens.tokenType, INTERNAL_TOKEN_TYPES),
      ),
    );
  return rows.map((r) => ({ ...r, tombstone: false }));
}

/**
 * The tombstones of these token values that no live token replaced
 * (internal types left out), for a push.
 */
export async function loadEmspTombstones(
  refs: ReadonlyArray<{ idToken: string; tokenType: string }>,
): Promise<EmspTokenRow[]> {
  const wanted = refs.filter((r) => !INTERNAL_TOKEN_TYPES.includes(r.tokenType));
  if (wanted.length === 0) return [];
  const rows = await db
    .select({
      idToken: driverTokenTombstones.idToken,
      tokenType: driverTokenTombstones.tokenType,
      invalidatedAt: driverTokenTombstones.invalidatedAt,
    })
    .from(driverTokenTombstones)
    .where(
      and(
        or(
          ...wanted.map((r) =>
            and(
              eq(driverTokenTombstones.idToken, r.idToken),
              eq(driverTokenTombstones.tokenType, r.tokenType),
            ),
          ),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(driverTokens)
            .where(replacedByLiveToken()),
        ),
      ),
    );
  return rows.map((r) => ({
    idToken: r.idToken,
    tokenType: r.tokenType,
    isActive: false,
    expiresAt: null,
    revokedAt: r.invalidatedAt,
    updatedAt: r.invalidatedAt,
    tombstone: true,
  }));
}

function toRow(r: {
  idToken: string;
  tokenType: string;
  isActive: boolean;
  expiresAt: Date | string | null;
  revokedAt: Date | string | null;
  updatedAt: Date | string;
  tombstone: boolean;
}): EmspTokenRow {
  const date = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
  return {
    idToken: r.idToken,
    tokenType: r.tokenType,
    isActive: r.isActive,
    expiresAt: r.expiresAt == null ? null : date(r.expiresAt),
    revokedAt: r.revokedAt == null ? null : date(r.revokedAt),
    updatedAt: date(r.updatedAt),
    tombstone: r.tombstone,
  };
}
