// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, or, ilike, sql, desc, inArray, ne } from 'drizzle-orm';
import {
  db,
  client,
  pgErrorCode,
  PG_UNIQUE_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
} from '@evtivity/database';
import {
  chargingStations,
  driverTokens,
  driverTokenTombstones,
  drivers,
  pncContracts,
  tokenAuditLog,
  stationLocalAuthEntries,
  stationLocalAuthVersions,
  writeAudit,
  currentAuditViaAi,
} from '@evtivity/database';
import { dispatchDriverNotification, createLogger, csvEscape, isNewOcpiToken } from '@evtivity/lib';
import { isOcppIdTokenType } from '@evtivity/lib/id-token-types';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import type { PaginationParams, PaginatedResponse } from '../lib/pagination.js';
import type { AuditActorInfo } from '../lib/audit-actor.js';
import { publishOcpiTokenPush, type OcpiTokenTombstoneRef } from '../lib/ocpi-token-push.js';

const logger = createLogger('token-service');

interface TokenListParams extends PaginationParams {
  tokenType?: string | undefined;
  status?: 'active' | 'inactive' | undefined;
}

export type TokenActor =
  | { type: 'operator'; userId: string }
  | { type: 'api_key'; apiKeyId: string; userId: string | null }
  | { type: 'driver'; driverId: string }
  | { type: 'system' };

/**
 * The token actor of a request's audit actor: an API key is recorded as the
 * key (with the user it acts for), not as that user.
 */
export function tokenActorOf(actor: AuditActorInfo): TokenActor {
  if (actor.actor === 'api_key' && actor.actorApiKeyId != null) {
    return { type: 'api_key', apiKeyId: actor.actorApiKeyId, userId: actor.actorUserId };
  }
  if (actor.actor === 'driver' && actor.actorDriverId != null) {
    return { type: 'driver', driverId: actor.actorDriverId };
  }
  if (actor.actorUserId != null) return { type: 'operator', userId: actor.actorUserId };
  return { type: 'system' };
}

const tokenSelect = {
  id: driverTokens.id,
  driverId: driverTokens.driverId,
  idToken: driverTokens.idToken,
  tokenType: driverTokens.tokenType,
  isActive: driverTokens.isActive,
  expiresAt: driverTokens.expiresAt,
  revokedAt: driverTokens.revokedAt,
  revokedReason: driverTokens.revokedReason,
  deactivatedBy: driverTokens.deactivatedBy,
  prepaidBalanceCents: driverTokens.prepaidBalanceCents,
  createdAt: driverTokens.createdAt,
  updatedAt: driverTokens.updatedAt,
  driverFirstName: drivers.firstName,
  driverLastName: drivers.lastName,
  driverEmail: drivers.email,
};

interface TokenFilters {
  search?: string | undefined;
  tokenType?: string | undefined;
  status?: 'active' | 'inactive' | undefined;
}

/** The list and the CSV export filter the same way, so an export holds what the list shows. */
function tokenWhere(filters: TokenFilters) {
  const { search, tokenType, status } = filters;
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
  if (tokenType != null && tokenType !== '') {
    conditions.push(eq(driverTokens.tokenType, tokenType));
  }
  if (status != null) {
    conditions.push(eq(driverTokens.isActive, status === 'active'));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function listTokens(
  params: TokenListParams,
): Promise<
  PaginatedResponse<typeof tokenSelect extends infer S ? { [K in keyof S]: unknown } : never>
> {
  const { page, limit } = params;
  const offset = (page - 1) * limit;
  const where = tokenWhere(params);

  const [data, countRows] = await Promise.all([
    db
      .select(tokenSelect)
      .from(driverTokens)
      .leftJoin(drivers, eq(driverTokens.driverId, drivers.id))
      .where(where)
      .orderBy(desc(driverTokens.createdAt), desc(driverTokens.id))
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

/** The driver a token is assigned to does not exist (the driver_id foreign key). */
export class TokenDriverNotFoundError extends Error {
  constructor(public readonly driverId: string) {
    super('Driver not found');
    this.name = 'TokenDriverNotFoundError';
  }
}

/** The token would be active for a deactivated driver. */
export class TokenDriverInactiveError extends Error {
  constructor(public readonly driverId: string) {
    super('Driver is inactive');
    this.name = 'TokenDriverInactiveError';
  }
}

/**
 * A driver tried to reactivate a token an operator (or the system) deactivated.
 * Only the party that blocked a card lifts the block: a driver reactivates only
 * a card the driver removed.
 */
export class TokenReactivationBlockedError extends Error {
  constructor(public readonly tokenId: string) {
    super('Token was deactivated by the operator');
    this.name = 'TokenReactivationBlockedError';
  }
}

/**
 * The token is the eMAID of a Plug and Charge contract, and the change would
 * break the contract: a new value, type or driver (the issued certificate
 * names the eMAID and the contract its driver), reactivating it after its
 * contract was revoked (revocation is final), or deleting it while its
 * contract is active (revoke the contract first). The contract service is the
 * only path for those changes (features/pnc.md).
 */
export class PncContractTokenError extends Error {
  constructor(
    public readonly tokenId: string,
    public readonly reason: 'locked_fields' | 'contract_revoked' | 'contract_active',
  ) {
    super('Token belongs to a Plug and Charge contract');
    this.name = 'PncContractTokenError';
  }
}

/** The Plug and Charge contract statuses of the given tokens, by token id. */
async function contractStatuses(
  tokenIds: string[],
  executor: TokenDb = db,
): Promise<Map<string, 'active' | 'revoked'>> {
  if (tokenIds.length === 0) return new Map();
  const rows = await executor
    .select({ tokenId: pncContracts.driverTokenId, status: pncContracts.status })
    .from(pncContracts)
    .where(inArray(pncContracts.driverTokenId, tokenIds));
  return new Map(rows.map((r) => [r.tokenId, r.status]));
}

/**
 * Maps a unique violation on (id_token, token_type) to DuplicateTokenError and
 * a foreign key violation on driver_id to TokenDriverNotFoundError, so a race
 * or an unknown driver answers 409 or 404, not 500. drizzle wraps the
 * postgres.js error (SQLSTATE on cause); pgErrorCode reads both.
 */
function mapWriteError(
  err: unknown,
  target: { idToken: string; tokenType: string; driverId?: string | null | undefined },
): Error {
  const code = pgErrorCode(err);
  if (code === PG_UNIQUE_VIOLATION)
    return new DuplicateTokenError(target.idToken, target.tokenType);
  if (code === PG_FOREIGN_KEY_VIOLATION && target.driverId != null) {
    return new TokenDriverNotFoundError(target.driverId);
  }
  return err instanceof Error ? err : new Error(String(err));
}

type TokenDb = Pick<typeof db, 'select'>;

async function tokenExists(
  idToken: string,
  tokenType: string,
  excludeId?: string,
  conn: TokenDb = db,
): Promise<boolean> {
  const conditions = [eq(driverTokens.idToken, idToken), eq(driverTokens.tokenType, tokenType)];
  if (excludeId != null) conditions.push(ne(driverTokens.id, excludeId));
  const [row] = await conn
    .select({ id: driverTokens.id })
    .from(driverTokens)
    .where(and(...conditions))
    .limit(1);
  return row != null;
}

function actorColumns(actor: TokenActor): {
  actor: 'operator' | 'api_key' | 'driver' | 'system';
  actorUserId: string | null;
  actorDriverId: string | null;
  actorApiKeyId: string | null;
} {
  if (actor.type === 'operator') {
    return {
      actor: 'operator',
      actorUserId: actor.userId,
      actorDriverId: null,
      actorApiKeyId: null,
    };
  }
  if (actor.type === 'api_key') {
    return {
      actor: 'api_key',
      actorUserId: actor.userId,
      actorDriverId: null,
      actorApiKeyId: actor.apiKeyId,
    };
  }
  if (actor.type === 'driver') {
    return {
      actor: 'driver',
      actorUserId: null,
      actorDriverId: actor.driverId,
      actorApiKeyId: null,
    };
  }
  return { actor: 'system', actorUserId: null, actorDriverId: null, actorApiKeyId: null };
}

/** The notification wording: an API key acts for the operator. */
function actorLabel(actor: TokenActor): string {
  if (actor.type === 'operator' || actor.type === 'api_key') return 'operator';
  if (actor.type === 'driver') return 'you';
  return 'system';
}

interface TokenSnapshot {
  idToken: string;
  tokenType: string;
  driverId: string | null;
  prepaidBalanceCents?: number | null;
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
  const { actor, actorUserId, actorDriverId, actorApiKeyId } = actorColumns(args.actor);
  await writeAudit(
    { table: tokenAuditLog, idColumn: 'token_id' },
    {
      entityId: args.tokenId,
      entityIdSnapshot: args.entityIdSnapshot,
      action: args.action,
      actor,
      actorUserId,
      actorDriverId,
      actorApiKeyId,
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
    await dispatchDriverNotification(
      client,
      eventType,
      driverId,
      variables,
      ALL_TEMPLATES_DIRS,
      getPubSub(),
    );
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
  } catch (err) {
    logger.warn({ err, tokenId }, 'token.changed publish failed, open token pages refresh later');
  }
}

/** Stations whose local auth list holds any of these tokens. */
async function stationsHoldingTokens(tokenIds: string[]): Promise<string[]> {
  if (tokenIds.length === 0) return [];
  const rows = await db
    .select({ stationId: stationLocalAuthEntries.stationId })
    .from(stationLocalAuthEntries)
    .where(inArray(stationLocalAuthEntries.driverTokenId, tokenIds));
  return Array.from(new Set(rows.map((r) => r.stationId)));
}

/**
 * Marks the local auth list of these stations changed, so the operator UI
 * prompts a re-push, and tells open station pages through SSE.
 */
async function markLocalAuthListsChanged(stationIds: string[]): Promise<void> {
  if (stationIds.length === 0) return;
  await db
    .update(stationLocalAuthVersions)
    .set({ lastModifiedAt: new Date() })
    .where(inArray(stationLocalAuthVersions.stationId, stationIds));
  await publishLocalAuthListChanged(stationIds);
}

async function bumpStationsHoldingTokens(tokenIds: string[]): Promise<void> {
  await markLocalAuthListsChanged(await stationsHoldingTokens(tokenIds));
}

/**
 * One `localAuthList.changed` event per station, with the station's siteId so
 * the SSE stream delivers it to operators of that site only. Fail-open (P9).
 */
async function publishLocalAuthListChanged(stationIds: string[]): Promise<void> {
  try {
    const stations = await db
      .select({ id: chargingStations.id, siteId: chargingStations.siteId })
      .from(chargingStations)
      .where(inArray(chargingStations.id, stationIds));
    const pubsub = getPubSub();
    for (const station of stations) {
      await pubsub.publish(
        'csms_events',
        JSON.stringify({
          eventType: 'localAuthList.changed',
          stationId: station.id,
          siteId: station.siteId,
        }),
      );
    }
  } catch (err) {
    logger.warn(
      { err, stationIds },
      'localAuthList.changed publish failed, open station pages refresh later',
    );
  }
}

/** An API key deactivates as the operator: only the operator can lift it. */
/**
 * Records a token value that no longer exists (deleted, or its value or type
 * changed), so OCPI partners that cached it see it invalid (OCPI cannot delete
 * a Token). Fail-open (P9): the mutation committed; the partner then keeps the
 * value until it pulls the full list again.
 */
async function tombstoneTokenValue(ref: OcpiTokenTombstoneRef): Promise<boolean> {
  try {
    await db
      .insert(driverTokenTombstones)
      .values({ idToken: ref.idToken, tokenType: ref.tokenType })
      .onConflictDoUpdate({
        target: [driverTokenTombstones.idToken, driverTokenTombstones.tokenType],
        set: { invalidatedAt: new Date() },
      });
    return true;
  } catch (err) {
    logger.warn({ err, tokenType: ref.tokenType }, 'Token tombstone insert failed');
    return false;
  }
}

function deactivatedByOf(actor: TokenActor): 'operator' | 'driver' | 'system' {
  return actor.type === 'api_key' ? 'operator' : actor.type;
}

/**
 * Refuses a token that would be active for a deactivated driver: deactivating
 * a driver deactivates the driver's tokens, and none comes back (or is added)
 * until the driver is active again. Unknown driver: TokenDriverNotFoundError.
 */
async function assertDriverActive(driverId: string, conn: TokenDb = db): Promise<void> {
  const [driver] = await conn
    .select({ isActive: drivers.isActive })
    .from(drivers)
    .where(eq(drivers.id, driverId));
  if (driver == null) throw new TokenDriverNotFoundError(driverId);
  if (!driver.isActive) throw new TokenDriverInactiveError(driverId);
}

export async function createToken(
  data: {
    driverId?: string | null | undefined;
    idToken: string;
    tokenType: string;
    expiresAt?: Date | null | undefined;
    prepaidBalanceCents?: number | null | undefined;
  },
  actor: TokenActor = { type: 'system' },
) {
  // Check for an existing row first. If it already belongs to the same driver,
  // treat this as a re-add (driver removed the card, then registered it
  // again) and reactivate the existing row rather than throwing 409. This
  // closes the "can't re-add my own card" UX trap and also means the portal
  // 409 response is reserved for genuine cross-driver collisions only. A
  // driver cannot re-add a card an operator blocked (updateToken refuses).
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
        {
          isActive: true,
          expiresAt: data.expiresAt ?? null,
          ...(data.prepaidBalanceCents !== undefined
            ? { prepaidBalanceCents: data.prepaidBalanceCents }
            : {}),
        },
        actor,
      );
      return reactivated;
    }
    throw new DuplicateTokenError(data.idToken, data.tokenType);
  }

  if (data.driverId != null) await assertDriverActive(data.driverId);

  let token: typeof driverTokens.$inferSelect | undefined;
  try {
    const inserted = await db
      .insert(driverTokens)
      .values({
        idToken: data.idToken,
        tokenType: data.tokenType,
        driverId: data.driverId ?? null,
        expiresAt: data.expiresAt ?? null,
        prepaidBalanceCents: data.prepaidBalanceCents ?? null,
      })
      .returning();
    token = inserted[0];
  } catch (err) {
    // A concurrent insert lost the TOCTOU race (unique index) or the driver
    // does not exist (foreign key): 409 or 404, not 500.
    throw mapWriteError(err, data);
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
      prepaidBalanceCents: token.prepaidBalanceCents,
    },
  });
  await notifyDriver(token.driverId, 'token.Added', {
    idToken: token.idToken,
    tokenType: token.tokenType,
    addedBy: actorLabel(actor),
  });
  await publishTokenChanged(token.id);
  await publishOcpiTokenPush({ tokenIds: [token.id] });
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
    prepaidBalanceCents?: number | null | undefined;
  },
  actor: TokenActor = { type: 'system' },
) {
  // The row is locked for the read and the write, so two concurrent toggles
  // cannot both see the old state and both audit and notify a transition.
  let changed: {
    current: {
      idToken: string;
      tokenType: string;
      driverId: string | null;
      isActive: boolean;
      expiresAt: Date | null;
      prepaidBalanceCents: number | null;
    };
    token: typeof driverTokens.$inferSelect;
  } | null;
  try {
    changed = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          idToken: driverTokens.idToken,
          tokenType: driverTokens.tokenType,
          driverId: driverTokens.driverId,
          isActive: driverTokens.isActive,
          expiresAt: driverTokens.expiresAt,
          deactivatedBy: driverTokens.deactivatedBy,
          prepaidBalanceCents: driverTokens.prepaidBalanceCents,
        })
        .from(driverTokens)
        .where(eq(driverTokens.id, id))
        .for('update');
      if (current == null) return null;

      if (
        actor.type === 'driver' &&
        data.isActive === true &&
        !current.isActive &&
        current.deactivatedBy !== 'driver'
      ) {
        throw new TokenReactivationBlockedError(id);
      }

      // A contract eMAID keeps its value, type and driver, and stays inactive
      // once its contract is revoked.
      const contractStatus =
        current.tokenType === 'eMAID' ? (await contractStatuses([id], tx)).get(id) : undefined;
      if (contractStatus != null) {
        const changes = (field: 'idToken' | 'tokenType' | 'driverId'): boolean =>
          data[field] !== undefined && data[field] !== current[field];
        if (changes('idToken') || changes('tokenType') || changes('driverId')) {
          throw new PncContractTokenError(id, 'locked_fields');
        }
        if (data.isActive === true && !current.isActive && contractStatus === 'revoked') {
          throw new PncContractTokenError(id, 'contract_revoked');
        }
      }

      // A token that ends up active, when it is reactivated or moved to
      // another driver, needs an active driver.
      const nextDriverId = data.driverId !== undefined ? data.driverId : current.driverId;
      const nextActive = data.isActive ?? current.isActive;
      const reactivating = data.isActive === true && !current.isActive;
      const reassigned = data.driverId !== undefined && data.driverId !== current.driverId;
      if (nextActive && nextDriverId != null && (reactivating || reassigned)) {
        await assertDriverActive(nextDriverId, tx);
      }

      if (data.idToken != null || data.tokenType != null) {
        const nextIdToken = data.idToken ?? current.idToken;
        const nextTokenType = data.tokenType ?? current.tokenType;
        if (
          (nextIdToken !== current.idToken || nextTokenType !== current.tokenType) &&
          (await tokenExists(nextIdToken, nextTokenType, id, tx))
        ) {
          throw new DuplicateTokenError(nextIdToken, nextTokenType);
        }
      }

      const setValues: Record<string, unknown> = { ...data, updatedAt: new Date() };
      // Stamp revokedAt and who deactivated when the token turns inactive;
      // clear all three on reactivate.
      if (data.isActive === false && current.isActive) {
        setValues['revokedAt'] = new Date();
        setValues['deactivatedBy'] = deactivatedByOf(actor);
      } else if (data.isActive === true && !current.isActive) {
        setValues['revokedAt'] = null;
        setValues['revokedReason'] = null;
        setValues['deactivatedBy'] = null;
      }

      const [token] = await tx
        .update(driverTokens)
        .set(setValues)
        .where(eq(driverTokens.id, id))
        .returning();
      return token == null ? null : { current, token };
    });
  } catch (err) {
    if (
      err instanceof DuplicateTokenError ||
      err instanceof TokenReactivationBlockedError ||
      err instanceof TokenDriverInactiveError ||
      err instanceof TokenDriverNotFoundError
    ) {
      throw err;
    }
    throw mapWriteError(err, {
      idToken: data.idToken ?? '',
      tokenType: data.tokenType ?? '',
      driverId: data.driverId,
    });
  }
  if (changed == null) return null;
  const { current, token } = changed;

  const beforeSnapshot: TokenSnapshot = {
    idToken: current.idToken,
    tokenType: current.tokenType,
    driverId: current.driverId,
    prepaidBalanceCents: current.prepaidBalanceCents,
  };
  const afterSnapshot: TokenSnapshot = {
    idToken: token.idToken,
    tokenType: token.tokenType,
    driverId: token.driverId,
    prepaidBalanceCents: token.prepaidBalanceCents,
  };

  // A station's local auth list carries the value, the type, the status and
  // the expiry: a change to any of them needs a re-push.
  // A token that becomes prepaid leaves every list at the next push (a
  // station checks a prepaid balance online), and one that stops being
  // prepaid may be added again.
  const listFieldsChanged =
    token.idToken !== current.idToken ||
    token.tokenType !== current.tokenType ||
    (token.prepaidBalanceCents == null) !== (current.prepaidBalanceCents == null) ||
    (token.expiresAt?.getTime() ?? null) !== (current.expiresAt?.getTime() ?? null);

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
    await bumpStationsHoldingTokens([token.id]);
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
    await bumpStationsHoldingTokens([token.id]);
  } else {
    await writeTokenAudit({
      tokenId: token.id,
      entityIdSnapshot: token.id,
      action: 'updated',
      actor,
      before: beforeSnapshot,
      after: afterSnapshot,
    });
    if (listFieldsChanged) await bumpStationsHoldingTokens([token.id]);
  }
  // A changed value or OCPI type is a new OCPI Token: the old one is
  // invalidated. ISO14443 to ISO15693 (both RFID) is the same OCPI Token,
  // so no tombstone would mark the live card invalid at partners.
  const tombstones: OcpiTokenTombstoneRef[] = [];
  if (isNewOcpiToken(current, token)) {
    const old = { idToken: current.idToken, tokenType: current.tokenType };
    if (await tombstoneTokenValue(old)) tombstones.push(old);
  }
  await publishTokenChanged(token.id);
  await publishOcpiTokenPush({ tokenIds: [token.id], tombstones });
  return token;
}

export async function deleteToken(id: string, actor: TokenActor = { type: 'system' }) {
  // Read the stations first: the delete sets their entries' token id to null
  // (foreign key), after which they can no longer be found. The next push
  // drops those entries, so the station stops accepting the card.
  const stationIds = await stationsHoldingTokens([id]);
  // The eMAID of an active Plug and Charge contract stays: deleting it would
  // delete the contract and its certificate records (revoke the contract first).
  const [token] = await db
    .delete(driverTokens)
    .where(
      and(
        eq(driverTokens.id, id),
        sql`NOT EXISTS (SELECT 1 FROM pnc_contracts c WHERE c.driver_token_id = ${driverTokens.id} AND c.status = 'active')`,
      ),
    )
    .returning();
  if (token == null) {
    if ((await contractStatuses([id])).get(id) === 'active') {
      throw new PncContractTokenError(id, 'contract_active');
    }
    return null;
  }
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
  await markLocalAuthListsChanged(stationIds);
  const tombstone = { idToken: token.idToken, tokenType: token.tokenType };
  const tombstoned = await tombstoneTokenValue(tombstone);
  await publishTokenChanged(token.id);
  if (tombstoned) await publishOcpiTokenPush({ tombstones: [tombstone] });
  return token;
}

export async function bulkSetActive(
  ids: string[],
  isActive: boolean,
  actor: TokenActor = { type: 'system' },
): Promise<{ updated: number }> {
  if (ids.length === 0) return { updated: 0 };
  if (isActive) {
    // No eMAID of a revoked Plug and Charge contract comes back.
    for (const [tokenId, status] of await contractStatuses(ids)) {
      if (status === 'revoked') throw new PncContractTokenError(tokenId, 'contract_revoked');
    }
    // No token comes back for a deactivated driver: refuse the batch.
    const [blocked] = await db
      .select({ driverId: drivers.id })
      .from(driverTokens)
      .innerJoin(drivers, eq(driverTokens.driverId, drivers.id))
      .where(
        and(
          inArray(driverTokens.id, ids),
          eq(driverTokens.isActive, false),
          eq(drivers.isActive, false),
        ),
      )
      .limit(1);
    if (blocked != null) throw new TokenDriverInactiveError(blocked.driverId);
  }
  const updates: Partial<typeof driverTokens.$inferInsert> = {
    isActive,
    updatedAt: new Date(),
  };
  if (isActive) {
    updates.revokedAt = null;
    updates.revokedReason = null;
    updates.deactivatedBy = null;
  } else {
    updates.revokedAt = new Date();
    updates.deactivatedBy = deactivatedByOf(actor);
  }
  // Only tokens not already in the target state: a token already inactive
  // keeps its original revokedAt and who deactivated it, and its driver gets
  // no notification for a change that did not happen.
  const updated = await db
    .update(driverTokens)
    .set(updates)
    .where(and(inArray(driverTokens.id, ids), ne(driverTokens.isActive, isActive)))
    .returning();
  if (updated.length === 0) return { updated: 0 };

  // Single bulk audit insert instead of N sequential. For 500-token deactivate
  // this turns ~500 round-trips into 1. Fail-open like writeAudit (P9): the
  // tokens are already changed.
  const { actor: actorKind, actorUserId, actorDriverId, actorApiKeyId } = actorColumns(actor);
  const action: 'activated' | 'deactivated' = isActive ? 'activated' : 'deactivated';
  try {
    await db.insert(tokenAuditLog).values(
      updated.map((t) => ({
        tokenId: t.id,
        tokenIdSnapshot: t.id,
        action,
        actor: actorKind,
        actorUserId,
        actorDriverId,
        actorApiKeyId,
        viaAi: currentAuditViaAi() ?? null,
        after: {
          idToken: t.idToken,
          tokenType: t.tokenType,
          driverId: t.driverId,
          isActive,
        },
        notes: null,
      })),
    );
  } catch (err) {
    logger.warn({ err, count: updated.length, action }, 'Bulk token audit insert failed');
  }

  // One batched bump for every station holding any of the affected tokens.
  await bumpStationsHoldingTokens(updated.map((t) => t.id));

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
  await publishOcpiTokenPush({ tokenIds: updated.map((t) => t.id) });

  return { updated: updated.length };
}

export const TOKEN_CSV_HEADER = 'idToken,tokenType,driverEmail,isActive,expiresAt';

export async function exportTokensCsv(filters: TokenFilters = {}): Promise<string> {
  const data = await db
    .select(tokenSelect)
    .from(driverTokens)
    .leftJoin(drivers, eq(driverTokens.driverId, drivers.id))
    .where(tokenWhere(filters))
    .orderBy(desc(driverTokens.createdAt), desc(driverTokens.id));

  const rows = data.map((row) => {
    const email = row.driverEmail ?? '';
    const active = row.isActive ? 'true' : 'false';
    const expires = row.expiresAt instanceof Date ? row.expiresAt.toISOString() : '';
    return `${csvEscape(row.idToken)},${csvEscape(row.tokenType)},${csvEscape(email)},${active},${csvEscape(expires)}`;
  });

  return [TOKEN_CSV_HEADER, ...rows].join('\n');
}

/** A CSV row the importer accepts; each field is checked per row so one bad row never fails the batch. */
export interface TokenImportRow {
  idToken: string;
  tokenType: string;
  driverEmail?: string | undefined;
  isActive?: boolean | undefined;
  expiresAt?: string | undefined;
}

const MAX_ID_TOKEN_LENGTH = 255;
// A loose shape check: the driver lookup decides whether the address is known.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function importTokensCsv(
  rows: TokenImportRow[],
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
    const rowLabel = `Row ${String(i + 1)}`;
    const idToken = row.idToken.trim();
    const tokenType = row.tokenType.trim();
    if (idToken === '' && tokenType === '' && (row.driverEmail ?? '').trim() === '') {
      // A blank line of the file.
      continue;
    }
    if (idToken === '' || tokenType === '') {
      errors.push(`${rowLabel}: missing idToken or tokenType`);
      continue;
    }
    if (idToken.length > MAX_ID_TOKEN_LENGTH) {
      errors.push(`${rowLabel}: idToken is longer than ${String(MAX_ID_TOKEN_LENGTH)} characters`);
      continue;
    }
    if (!isOcppIdTokenType(tokenType)) {
      errors.push(`${rowLabel}: unknown tokenType ${tokenType}`);
      continue;
    }
    const driverEmail = (row.driverEmail ?? '').trim();
    if (driverEmail !== '' && !EMAIL_SHAPE.test(driverEmail)) {
      errors.push(`${rowLabel}: invalid driverEmail`);
      continue;
    }
    const key = `${idToken}\x00${tokenType}`;
    if (seenInBatch.has(key)) {
      errors.push(
        `${rowLabel}: duplicate of an earlier row in this import (${idToken}, ${tokenType})`,
      );
      continue;
    }
    let expiresAt: Date | null = null;
    if (row.expiresAt && row.expiresAt.trim() !== '') {
      const d = new Date(row.expiresAt.trim());
      if (Number.isNaN(d.getTime())) {
        errors.push(`${rowLabel}: invalid expiresAt`);
        continue;
      }
      expiresAt = d;
    }
    seenInBatch.add(key);
    parsed.push({
      idToken,
      tokenType,
      driverEmail: driverEmail === '' ? null : driverEmail,
      isActive: row.isActive !== false,
      expiresAt,
    });
  }

  if (parsed.length === 0) {
    return { imported: 0, errors };
  }

  const deactivatedBy = deactivatedByOf(actor);
  // Single transaction:
  //   1. Resolve all driver emails (case-insensitive) and report unknown ones
  //      row by row.
  //   2. Check for existing (idToken, tokenType) collisions.
  //   3. Insert remaining rows in one statement; a row a concurrent insert
  //      took meanwhile is skipped (ON CONFLICT) and reported, not a 500.
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
      revokedAt: Date | null;
      deactivatedBy: 'operator' | 'driver' | 'system' | null;
    };
    const prepared: Prepared[] = [];

    const emails = Array.from(
      new Set(
        parsed.map((p) => p.driverEmail?.toLowerCase()).filter((e): e is string => e != null),
      ),
    );
    let emailToDriverId = new Map<string, string>();
    let inactiveDriverIds = new Set<string>();
    if (emails.length > 0) {
      const driverRows = await tx
        .select({ id: drivers.id, email: drivers.email, isActive: drivers.isActive })
        .from(drivers)
        .where(inArray(sql`lower(${drivers.email})`, emails));
      emailToDriverId = new Map(
        driverRows
          .filter((d): d is { id: string; email: string; isActive: boolean } => d.email != null)
          .map((d) => [d.email.toLowerCase(), d.id]),
      );
      inactiveDriverIds = new Set(driverRows.filter((d) => !d.isActive).map((d) => d.id));
    }

    const now = new Date();
    for (const p of parsed) {
      let driverId: string | null = null;
      if (p.driverEmail != null) {
        const found = emailToDriverId.get(p.driverEmail.toLowerCase());
        if (found == null) {
          errors.push(
            `Row for ${p.idToken} (${p.tokenType}): driver not found for email ${p.driverEmail}`,
          );
          continue;
        }
        if (p.isActive && inactiveDriverIds.has(found)) {
          errors.push(`Row for ${p.idToken} (${p.tokenType}): driver ${p.driverEmail} is inactive`);
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
        // An inactive imported card is a block by whoever imported it.
        revokedAt: p.isActive ? null : now,
        deactivatedBy: p.isActive ? null : deactivatedBy,
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

    const insertedRows = await tx
      .insert(driverTokens)
      .values(toInsert)
      .onConflictDoNothing()
      .returning({
        id: driverTokens.id,
        idToken: driverTokens.idToken,
        tokenType: driverTokens.tokenType,
        driverId: driverTokens.driverId,
      });
    const insertedKeys = new Set(insertedRows.map((t) => `${t.idToken}\x00${t.tokenType}`));
    for (const p of toInsert) {
      if (!insertedKeys.has(`${p.idToken}\x00${p.tokenType}`)) {
        errors.push(`Row for ${p.idToken} (${p.tokenType}): token already exists`);
      }
    }

    // Audit rows for the import are written inside the same transaction so a
    // crash that prevents the post-commit notification loop still leaves an
    // audit trail for the actual inserted tokens.
    if (insertedRows.length > 0) {
      const { actor: actorKind, actorUserId, actorDriverId, actorApiKeyId } = actorColumns(actor);
      await tx.insert(tokenAuditLog).values(
        insertedRows.map((t) => ({
          tokenId: t.id,
          tokenIdSnapshot: t.id,
          action: 'imported' as const,
          actor: actorKind,
          actorUserId,
          actorDriverId,
          actorApiKeyId,
          viaAi: currentAuditViaAi() ?? null,
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
    await publishOcpiTokenPush({ tokenIds: inserted.map((t) => t.id) });
  }

  return { imported: inserted.length, errors };
}
