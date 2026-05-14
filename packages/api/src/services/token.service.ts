// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, or, ilike, sql, desc, inArray } from 'drizzle-orm';
import { db, client } from '@evtivity/database';
import {
  driverTokens,
  drivers,
  users,
  tokenAuditLog,
  stationLocalAuthEntries,
  stationLocalAuthVersions,
  writeAudit,
} from '@evtivity/database';
import { dispatchDriverNotification, createLogger } from '@evtivity/lib';
import { getPubSub } from '../lib/pubsub.js';
import type { PaginationParams, PaginatedResponse } from '../lib/pagination.js';

const logger = createLogger('token-service');

interface TokenListParams extends PaginationParams {
  tokenType?: string | undefined;
  status?: 'active' | 'inactive' | undefined;
}

export type TokenActor =
  | { type: 'operator'; userId: string }
  | { type: 'driver'; driverId: string }
  | { type: 'system' };

const tokenSelect = {
  id: driverTokens.id,
  driverId: driverTokens.driverId,
  idToken: driverTokens.idToken,
  tokenType: driverTokens.tokenType,
  isActive: driverTokens.isActive,
  expiresAt: driverTokens.expiresAt,
  revokedAt: driverTokens.revokedAt,
  revokedReason: driverTokens.revokedReason,
  createdAt: driverTokens.createdAt,
  updatedAt: driverTokens.updatedAt,
  driverFirstName: drivers.firstName,
  driverLastName: drivers.lastName,
  driverEmail: drivers.email,
};

export async function listTokens(
  params: TokenListParams,
): Promise<
  PaginatedResponse<typeof tokenSelect extends infer S ? { [K in keyof S]: unknown } : never>
> {
  const { page, limit, search, tokenType, status } = params;
  const offset = (page - 1) * limit;

  const conditions = [];
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(driverTokens.idToken, pattern),
        ilike(drivers.firstName, pattern),
        ilike(drivers.lastName, pattern),
        ilike(drivers.email, pattern),
      ),
    );
  }
  if (tokenType != null) {
    conditions.push(eq(driverTokens.tokenType, tokenType));
  }
  if (status != null) {
    conditions.push(eq(driverTokens.isActive, status === 'active'));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [data, countRows] = await Promise.all([
    db
      .select(tokenSelect)
      .from(driverTokens)
      .leftJoin(drivers, eq(driverTokens.driverId, drivers.id))
      .where(where)
      .orderBy(desc(driverTokens.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(driverTokens)
      .leftJoin(drivers, eq(driverTokens.driverId, drivers.id))
      .where(where),
  ]);

  return { data, total: countRows[0]?.count ?? 0 };
}

export async function getToken(id: string) {
  const [token] = await db
    .select(tokenSelect)
    .from(driverTokens)
    .leftJoin(drivers, eq(driverTokens.driverId, drivers.id))
    .where(eq(driverTokens.id, id));
  return token ?? null;
}

export class DuplicateTokenError extends Error {
  constructor(
    public readonly idToken: string,
    public readonly tokenType: string,
  ) {
    super(`Token already registered`);
    this.name = 'DuplicateTokenError';
  }
}

function isUniqueViolation(err: unknown): boolean {
  // postgres-js + drizzle surface PG errors with `code` on the error object.
  // 23505 is unique_violation. Some test mocks throw plain Error so we
  // tolerate the field being absent.
  return err != null && typeof err === 'object' && 'code' in err && err.code === '23505';
}

async function tokenExists(
  idToken: string,
  tokenType: string,
  excludeId?: string,
): Promise<boolean> {
  const conditions = [eq(driverTokens.idToken, idToken), eq(driverTokens.tokenType, tokenType)];
  if (excludeId != null) conditions.push(sql`${driverTokens.id} <> ${excludeId}`);
  const [row] = await db
    .select({ id: driverTokens.id })
    .from(driverTokens)
    .where(and(...conditions))
    .limit(1);
  return row != null;
}

function actorColumns(actor: TokenActor): {
  actor: 'operator' | 'driver' | 'system';
  actorUserId: string | null;
  actorDriverId: string | null;
} {
  if (actor.type === 'operator') {
    return { actor: 'operator', actorUserId: actor.userId, actorDriverId: null };
  }
  if (actor.type === 'driver') {
    return { actor: 'driver', actorUserId: null, actorDriverId: actor.driverId };
  }
  return { actor: 'system', actorUserId: null, actorDriverId: null };
}

function actorLabel(actor: TokenActor): string {
  if (actor.type === 'operator') return 'operator';
  if (actor.type === 'driver') return 'you';
  return 'system';
}

interface TokenSnapshot {
  idToken: string;
  tokenType: string;
  driverId: string | null;
}

async function writeTokenAudit(args: {
  tokenId: string | null;
  entityIdSnapshot: string;
  action: 'created' | 'updated' | 'activated' | 'deactivated' | 'revoked' | 'deleted' | 'imported';
  actor: TokenActor;
  before?: TokenSnapshot | null;
  after?: TokenSnapshot | null;
  notes?: string | null;
}): Promise<void> {
  const { actor, actorUserId, actorDriverId } = actorColumns(args.actor);
  await writeAudit(
    { table: tokenAuditLog, idColumn: 'token_id' },
    {
      entityId: args.tokenId,
      entityIdSnapshot: args.entityIdSnapshot,
      action: args.action,
      actor,
      actorUserId,
      actorDriverId,
      before: args.before ?? null,
      after: args.after ?? null,
      notes: args.notes ?? null,
    },
    db,
    logger,
  );
}

async function notifyDriver(
  driverId: string | null,
  eventType: 'token.Added' | 'token.Removed' | 'token.Deactivated' | 'token.Reactivated',
  variables: Record<string, unknown>,
): Promise<void> {
  if (driverId == null) return;
  try {
    await dispatchDriverNotification(client, eventType, driverId, variables);
  } catch (err) {
    // Non-critical for the mutation, but operators need a signal that SMTP/
    // Twilio is misconfigured. Logged at warn so it shows up in normal log
    // aggregation without paging.
    logger.warn(
      { err, driverId, eventType },
      'Token notification dispatch failed (mutation already committed)',
    );
  }
}

// Best-effort SSE so other operators viewing Tokens/TokenDetail/AuthorizeLog
// see this mutation without a manual refresh. Decoupled from
// `localAuthList.changed` because not every token mutation affects a station
// (e.g. a token not yet pushed to any local auth list).
async function publishTokenChanged(tokenId: string | null): Promise<void> {
  try {
    const pubsub = getPubSub();
    await pubsub.publish('csms_events', JSON.stringify({ eventType: 'token.changed', tokenId }));
  } catch {
    // Non-critical
  }
}

async function bumpStationsHoldingToken(tokenId: string): Promise<void> {
  // Find every station whose pushed local auth list contains this token,
  // and mark its version dirty so the operator UI prompts a re-push.
  const rows = await db
    .select({ stationId: stationLocalAuthEntries.stationId })
    .from(stationLocalAuthEntries)
    .where(eq(stationLocalAuthEntries.driverTokenId, tokenId));
  if (rows.length === 0) return;
  const stationIds = Array.from(new Set(rows.map((r) => r.stationId)));
  await db
    .update(stationLocalAuthVersions)
    .set({ lastModifiedAt: new Date() })
    .where(inArray(stationLocalAuthVersions.stationId, stationIds));

  // Push SSE so any operator currently viewing one of these stations sees the
  // unpushed-changes banner appear without a manual refresh. Best-effort.
  try {
    const pubsub = getPubSub();
    for (const stationId of stationIds) {
      await pubsub.publish(
        'csms_events',
        JSON.stringify({ eventType: 'localAuthList.changed', stationId }),
      );
    }
  } catch {
    // Non-critical
  }
}

export async function createToken(
  data: {
    driverId?: string | null | undefined;
    idToken: string;
    tokenType: string;
    expiresAt?: Date | null | undefined;
  },
  actor: TokenActor = { type: 'system' },
) {
  // Check for an existing row first. If it already belongs to the same driver,
  // treat this as a re-add (driver removed the card, then registered it
  // again) and reactivate the existing row rather than throwing 409. This
  // closes the "can't re-add my own card" UX trap and also means the portal
  // 409 response is reserved for genuine cross-driver collisions only.
  const [existing] = await db
    .select({
      id: driverTokens.id,
      driverId: driverTokens.driverId,
      isActive: driverTokens.isActive,
    })
    .from(driverTokens)
    .where(and(eq(driverTokens.idToken, data.idToken), eq(driverTokens.tokenType, data.tokenType)))
    .limit(1);

  if (existing != null) {
    if (data.driverId != null && existing.driverId === data.driverId && !existing.isActive) {
      const reactivated = await updateToken(
        existing.id,
        { isActive: true, expiresAt: data.expiresAt ?? null },
        actor,
      );
      return reactivated;
    }
    throw new DuplicateTokenError(data.idToken, data.tokenType);
  }

  let token: typeof driverTokens.$inferSelect | undefined;
  try {
    const inserted = await db
      .insert(driverTokens)
      .values({
        idToken: data.idToken,
        tokenType: data.tokenType,
        driverId: data.driverId ?? null,
        expiresAt: data.expiresAt ?? null,
      })
      .returning();
    token = inserted[0];
  } catch (err) {
    // Concurrent insert lost the TOCTOU race: the unique index fired. Map
    // postgres 23505 (unique_violation) back to the same DuplicateTokenError
    // we already throw on the pre-check path so callers see a 409, not 500.
    if (isUniqueViolation(err)) {
      throw new DuplicateTokenError(data.idToken, data.tokenType);
    }
    throw err;
  }
  if (token == null) return null;

  await writeTokenAudit({
    tokenId: token.id,
    entityIdSnapshot: token.id,
    action: 'created',
    actor,
    after: {
      idToken: token.idToken,
      tokenType: token.tokenType,
      driverId: token.driverId,
    },
  });
  await notifyDriver(token.driverId, 'token.Added', {
    idToken: token.idToken,
    tokenType: token.tokenType,
    addedBy: actorLabel(actor),
  });
  await publishTokenChanged(token.id);
  return token;
}

export async function updateToken(
  id: string,
  data: {
    idToken?: string | undefined;
    tokenType?: string | undefined;
    driverId?: string | null | undefined;
    isActive?: boolean | undefined;
    expiresAt?: Date | null | undefined;
    revokedReason?: string | null | undefined;
  },
  actor: TokenActor = { type: 'system' },
) {
  const [current] = await db
    .select({
      id: driverTokens.id,
      idToken: driverTokens.idToken,
      tokenType: driverTokens.tokenType,
      driverId: driverTokens.driverId,
      isActive: driverTokens.isActive,
    })
    .from(driverTokens)
    .where(eq(driverTokens.id, id));
  if (current == null) return null;

  if (data.idToken != null || data.tokenType != null) {
    const nextIdToken = data.idToken ?? current.idToken;
    const nextTokenType = data.tokenType ?? current.tokenType;
    if (
      (nextIdToken !== current.idToken || nextTokenType !== current.tokenType) &&
      (await tokenExists(nextIdToken, nextTokenType, id))
    ) {
      throw new DuplicateTokenError(nextIdToken, nextTokenType);
    }
  }

  const setValues: Record<string, unknown> = { ...data, updatedAt: new Date() };
  // Stamp revokedAt when isActive flips false with a reason; clear on reactivate.
  if (data.isActive === false && current.isActive) {
    setValues['revokedAt'] = new Date();
  } else if (data.isActive === true && !current.isActive) {
    setValues['revokedAt'] = null;
    setValues['revokedReason'] = null;
  }

  const [token] = await db
    .update(driverTokens)
    .set(setValues)
    .where(eq(driverTokens.id, id))
    .returning();
  if (token == null) return null;

  const beforeSnapshot: TokenSnapshot = {
    idToken: current.idToken,
    tokenType: current.tokenType,
    driverId: current.driverId,
  };
  const afterSnapshot: TokenSnapshot = {
    idToken: token.idToken,
    tokenType: token.tokenType,
    driverId: token.driverId,
  };

  // Audit + side effects driven by what actually changed.
  if (data.isActive === false && current.isActive) {
    await writeTokenAudit({
      tokenId: token.id,
      entityIdSnapshot: token.id,
      action: 'deactivated',
      actor,
      before: beforeSnapshot,
      after: afterSnapshot,
      notes: data.revokedReason ?? null,
    });
    await notifyDriver(token.driverId, 'token.Deactivated', {
      idToken: token.idToken,
      tokenType: token.tokenType,
      reason: data.revokedReason ?? '',
    });
    await bumpStationsHoldingToken(token.id);
  } else if (data.isActive === true && !current.isActive) {
    await writeTokenAudit({
      tokenId: token.id,
      entityIdSnapshot: token.id,
      action: 'activated',
      actor,
      before: beforeSnapshot,
      after: afterSnapshot,
    });
    // Reactivation is its own template -- the driver removed (or operator
    // deactivated) this card, then it came back. Sending token.Added would
    // read as "operator added a new card" which is misleading when it's the
    // same physical card they already had.
    await notifyDriver(token.driverId, 'token.Reactivated', {
      idToken: token.idToken,
      tokenType: token.tokenType,
      reactivatedBy: actorLabel(actor),
    });
    await bumpStationsHoldingToken(token.id);
  } else {
    await writeTokenAudit({
      tokenId: token.id,
      entityIdSnapshot: token.id,
      action: 'updated',
      actor,
      before: beforeSnapshot,
      after: afterSnapshot,
    });
  }
  await publishTokenChanged(token.id);
  return token;
}

export async function deleteToken(id: string, actor: TokenActor = { type: 'system' }) {
  const [token] = await db.delete(driverTokens).where(eq(driverTokens.id, id)).returning();
  if (token == null) return null;
  await writeTokenAudit({
    tokenId: null,
    entityIdSnapshot: token.id,
    action: 'deleted',
    actor,
    before: {
      idToken: token.idToken,
      tokenType: token.tokenType,
      driverId: token.driverId,
    },
  });
  await notifyDriver(token.driverId, 'token.Removed', {
    idToken: token.idToken,
    tokenType: token.tokenType,
    removedBy: actorLabel(actor),
  });
  await publishTokenChanged(token.id);
  return token;
}

export async function bulkSetActive(
  ids: string[],
  isActive: boolean,
  actor: TokenActor = { type: 'system' },
): Promise<{ updated: number }> {
  if (ids.length === 0) return { updated: 0 };
  const updates: Record<string, unknown> = {
    isActive,
    updatedAt: new Date(),
  };
  if (isActive) {
    updates['revokedAt'] = null;
    updates['revokedReason'] = null;
  } else {
    updates['revokedAt'] = new Date();
  }
  const updated = await db
    .update(driverTokens)
    .set(updates)
    .where(inArray(driverTokens.id, ids))
    .returning();
  if (updated.length === 0) return { updated: 0 };

  // Single bulk audit insert instead of N sequential. For 500-token deactivate
  // this turns ~500 round-trips into 1.
  const { actor: actorKind, actorUserId, actorDriverId } = actorColumns(actor);
  const action: 'activated' | 'deactivated' = isActive ? 'activated' : 'deactivated';
  await db.insert(tokenAuditLog).values(
    updated.map((t) => ({
      tokenId: t.id,
      tokenIdSnapshot: t.id,
      action,
      actor: actorKind,
      actorUserId,
      actorDriverId,
      after: {
        idToken: t.idToken,
        tokenType: t.tokenType,
        driverId: t.driverId,
        isActive,
      },
      notes: null,
    })),
  );

  // One batched bump for every station holding any of the affected tokens.
  const updatedTokenIds = updated.map((t) => t.id);
  const entryRows = await db
    .select({ stationId: stationLocalAuthEntries.stationId })
    .from(stationLocalAuthEntries)
    .where(inArray(stationLocalAuthEntries.driverTokenId, updatedTokenIds));
  if (entryRows.length > 0) {
    const stationIds = Array.from(new Set(entryRows.map((r) => r.stationId)));
    await db
      .update(stationLocalAuthVersions)
      .set({ lastModifiedAt: new Date() })
      .where(inArray(stationLocalAuthVersions.stationId, stationIds));
    try {
      const pubsub = getPubSub();
      for (const stationId of stationIds) {
        await pubsub.publish(
          'csms_events',
          JSON.stringify({ eventType: 'localAuthList.changed', stationId }),
        );
      }
    } catch {
      // Non-critical
    }
  }

  // Per-driver notifications. Bulk activate flips previously-deactivated
  // rows, so the right template is token.Reactivated (NOT token.Added: the
  // card was already on the driver's account). We await Promise.allSettled
  // so a pod restart mid-response cannot drop them: the handler does not
  // return until either every notification settled or one of them threw.
  // Failures are swallowed inside notifyDriver itself (logged at warn) so
  // this does not affect the mutation outcome from the caller's perspective.
  const notifyEvent: 'token.Reactivated' | 'token.Deactivated' = isActive
    ? 'token.Reactivated'
    : 'token.Deactivated';
  const actorString = actorLabel(actor);
  await Promise.allSettled(
    updated.map((token) =>
      notifyDriver(token.driverId, notifyEvent, {
        idToken: token.idToken,
        tokenType: token.tokenType,
        ...(isActive ? { reactivatedBy: actorString } : { reason: '' }),
      }),
    ),
  );

  // Single broadcast covers the bulk: SSE subscribers invalidate the Tokens
  // list / AuthorizeLog queries once, not N times.
  await publishTokenChanged(null);

  return { updated: updated.length };
}

export async function listTokenAuditLog(
  tokenId: string,
  params: { page: number; limit: number },
): Promise<
  PaginatedResponse<{
    id: number;
    tokenId: string | null;
    idToken: string;
    tokenType: string;
    driverId: string | null;
    action: string;
    actor: string;
    actorUserId: string | null;
    actorUserName: string | null;
    actorDriverId: string | null;
    actorDriverName: string | null;
    notes: string | null;
    createdAt: Date;
  }>
> {
  const { page, limit } = params;
  const offset = (page - 1) * limit;
  const where = eq(tokenAuditLog.tokenId, tokenId);

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: tokenAuditLog.id,
        tokenId: tokenAuditLog.tokenId,
        tokenIdSnapshot: tokenAuditLog.tokenIdSnapshot,
        before: tokenAuditLog.before,
        after: tokenAuditLog.after,
        action: tokenAuditLog.action,
        actor: tokenAuditLog.actor,
        actorUserId: tokenAuditLog.actorUserId,
        actorUserName: sql<string | null>`CASE
          WHEN ${users.id} IS NOT NULL THEN
            COALESCE(
              NULLIF(TRIM(COALESCE(${users.firstName}, '') || ' ' || COALESCE(${users.lastName}, '')), ''),
              ${users.email}
            )
          ELSE NULL
        END`,
        actorDriverId: tokenAuditLog.actorDriverId,
        actorDriverName: sql<string | null>`CASE
          WHEN ${drivers.id} IS NOT NULL THEN
            COALESCE(
              NULLIF(TRIM(COALESCE(${drivers.firstName}, '') || ' ' || COALESCE(${drivers.lastName}, '')), ''),
              ${drivers.email}
            )
          ELSE NULL
        END`,
        notes: tokenAuditLog.notes,
        createdAt: tokenAuditLog.createdAt,
      })
      .from(tokenAuditLog)
      .leftJoin(users, eq(users.id, tokenAuditLog.actorUserId))
      .leftJoin(drivers, eq(drivers.id, tokenAuditLog.actorDriverId))
      .where(where)
      .orderBy(desc(tokenAuditLog.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(tokenAuditLog)
      .where(where),
  ]);

  // Project the unified JSONB shape (after/before) back to the legacy
  // per-field response so the History card on the Token detail page keeps
  // working unchanged. Prefer `after` for the snapshot (created/imported
  // rows leave `before` null); fall back to `before` for deleted rows.
  const data = rows.map((row) => {
    const snapshot = (row.after ?? row.before ?? {}) as {
      idToken?: string;
      tokenType?: string;
      driverId?: string | null;
    };
    return {
      id: row.id,
      tokenId: row.tokenId,
      idToken: snapshot.idToken ?? '',
      tokenType: snapshot.tokenType ?? '',
      driverId: snapshot.driverId ?? null,
      action: row.action,
      actor: row.actor,
      actorUserId: row.actorUserId,
      actorUserName: row.actorUserName,
      actorDriverId: row.actorDriverId,
      actorDriverName: row.actorDriverName,
      notes: row.notes,
      createdAt: row.createdAt,
    };
  });

  return { data, total: countRows[0]?.count ?? 0 };
}

export async function exportTokensCsv(search?: string): Promise<string> {
  let where = undefined;
  if (search) {
    const pattern = `%${search}%`;
    where = or(
      ilike(driverTokens.idToken, pattern),
      ilike(drivers.firstName, pattern),
      ilike(drivers.lastName, pattern),
      ilike(drivers.email, pattern),
    );
  }

  const data = await db
    .select(tokenSelect)
    .from(driverTokens)
    .leftJoin(drivers, eq(driverTokens.driverId, drivers.id))
    .where(where);

  const header = 'idToken,tokenType,driverEmail,isActive,expiresAt';
  const rows = data.map((row) => {
    const email = row.driverEmail ?? '';
    const active = row.isActive ? 'true' : 'false';
    const expires = row.expiresAt instanceof Date ? row.expiresAt.toISOString() : '';
    return `${csvEscape(row.idToken)},${csvEscape(row.tokenType)},${csvEscape(email)},${active},${csvEscape(expires)}`;
  });

  return [header, ...rows].join('\n');
}

export async function importTokensCsv(
  rows: Array<{
    idToken: string;
    tokenType: string;
    driverEmail?: string | undefined;
    isActive?: boolean | undefined;
    expiresAt?: string | undefined;
  }>,
  actor: TokenActor = { type: 'system' },
): Promise<{ imported: number; errors: string[] }> {
  // Format check + intra-batch dedup happens up front so we can present every
  // row's parse error in one response. Driver email resolution and the
  // duplicate-vs-existing check both live inside the transaction so a
  // concurrent driver delete or token insert cannot leak past us.
  const errors: string[] = [];
  const seenInBatch = new Set<string>();
  type Parsed = {
    idToken: string;
    tokenType: string;
    driverEmail: string | null;
    isActive: boolean;
    expiresAt: Date | null;
  };
  const parsed: Parsed[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row == null) continue;
    if (!row.idToken || !row.tokenType) {
      errors.push(`Row ${String(i + 1)}: missing idToken or tokenType`);
      continue;
    }
    const key = `${row.idToken}\x00${row.tokenType}`;
    if (seenInBatch.has(key)) {
      errors.push(
        `Row ${String(i + 1)}: duplicate of an earlier row in this import (${row.idToken}, ${row.tokenType})`,
      );
      continue;
    }
    let expiresAt: Date | null = null;
    if (row.expiresAt && row.expiresAt.trim() !== '') {
      const d = new Date(row.expiresAt);
      if (Number.isNaN(d.getTime())) {
        errors.push(`Row ${String(i + 1)}: invalid expiresAt`);
        continue;
      }
      expiresAt = d;
    }
    seenInBatch.add(key);
    parsed.push({
      idToken: row.idToken,
      tokenType: row.tokenType,
      driverEmail: row.driverEmail ?? null,
      isActive: row.isActive !== false,
      expiresAt,
    });
  }

  if (parsed.length === 0) {
    return { imported: 0, errors };
  }

  // Single transaction:
  //   1. Resolve all driver emails (rejects whole batch if any unknown caused by
  //      a concurrent driver delete are detected; reports row by row).
  //   2. Check for existing (idToken, tokenType) collisions.
  //   3. Insert remaining rows in one statement.
  // Any failure rolls everything back, so a process crash mid-loop cannot
  // leave half-imported rows that bypassed the audit/notification step below.
  const inserted: Array<{
    id: string;
    idToken: string;
    tokenType: string;
    driverId: string | null;
  }> = await db.transaction(async (tx) => {
    type Prepared = {
      idToken: string;
      tokenType: string;
      driverId: string | null;
      isActive: boolean;
      expiresAt: Date | null;
    };
    const prepared: Prepared[] = [];

    const emails = Array.from(
      new Set(parsed.map((p) => p.driverEmail).filter((e): e is string => e != null)),
    );
    let emailToDriverId = new Map<string, string>();
    if (emails.length > 0) {
      const driverRows = await tx
        .select({ id: drivers.id, email: drivers.email })
        .from(drivers)
        .where(inArray(drivers.email, emails));
      emailToDriverId = new Map(
        driverRows
          .filter((d): d is { id: string; email: string } => d.email != null)
          .map((d) => [d.email, d.id]),
      );
    }

    for (const p of parsed) {
      let driverId: string | null = null;
      if (p.driverEmail != null) {
        const found = emailToDriverId.get(p.driverEmail);
        if (found == null) {
          errors.push(
            `Row for ${p.idToken} (${p.tokenType}): driver not found for email ${p.driverEmail}`,
          );
          continue;
        }
        driverId = found;
      }
      prepared.push({
        idToken: p.idToken,
        tokenType: p.tokenType,
        driverId,
        isActive: p.isActive,
        expiresAt: p.expiresAt,
      });
    }

    if (prepared.length === 0) return [];

    const existing = await tx
      .select({ idToken: driverTokens.idToken, tokenType: driverTokens.tokenType })
      .from(driverTokens)
      .where(
        inArray(
          driverTokens.idToken,
          prepared.map((p) => p.idToken),
        ),
      );
    const existsKey = new Set(existing.map((e) => `${e.idToken}\x00${e.tokenType}`));
    const toInsert: Prepared[] = [];
    for (const p of prepared) {
      const key = `${p.idToken}\x00${p.tokenType}`;
      if (existsKey.has(key)) {
        errors.push(`Row for ${p.idToken} (${p.tokenType}): token already exists`);
        continue;
      }
      toInsert.push(p);
    }
    if (toInsert.length === 0) return [];

    const insertedRows = await tx.insert(driverTokens).values(toInsert).returning({
      id: driverTokens.id,
      idToken: driverTokens.idToken,
      tokenType: driverTokens.tokenType,
      driverId: driverTokens.driverId,
    });

    // Audit rows for the import are written inside the same transaction so a
    // crash that prevents the post-commit notification loop still leaves an
    // audit trail for the actual inserted tokens.
    if (insertedRows.length > 0) {
      const { actor: actorKind, actorUserId, actorDriverId } = actorColumns(actor);
      await tx.insert(tokenAuditLog).values(
        insertedRows.map((t) => ({
          tokenId: t.id,
          tokenIdSnapshot: t.id,
          action: 'imported' as const,
          actor: actorKind,
          actorUserId,
          actorDriverId,
          after: {
            idToken: t.idToken,
            tokenType: t.tokenType,
            driverId: t.driverId,
          },
          notes: null,
        })),
      );
    }

    return insertedRows;
  });

  // Notifications happen post-commit because dispatchDriverNotification can
  // make outbound HTTP/SMTP calls that we don't want to hold a DB transaction
  // open across. The audit trail above covers the case where the process
  // crashes here.
  for (const token of inserted) {
    await notifyDriver(token.driverId, 'token.Added', {
      idToken: token.idToken,
      tokenType: token.tokenType,
      addedBy: actorLabel(actor),
    });
  }

  if (inserted.length > 0) {
    await publishTokenChanged(null);
  }

  return { imported: inserted.length, errors };
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
