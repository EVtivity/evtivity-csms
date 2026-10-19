// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  eq,
  and,
  desc,
  count,
  notInArray,
  ilike,
  or,
  isNull,
  isNotNull,
  inArray,
  sql,
  lt,
} from 'drizzle-orm';
import {
  db,
  writeAudit,
  localAuthListAuditLog,
  pgErrorCode,
  PG_UNIQUE_VIOLATION,
} from '@evtivity/database';
import {
  chargingStations,
  driverTokens,
  drivers,
  stationLocalAuthVersions,
  stationLocalAuthEntries,
} from '@evtivity/database';
import { getAuditActor } from '../lib/audit-actor.js';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { paginatedResponse, itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { sendOcppCommandAndWait } from '@evtivity/services/ocpp-command';
import { ocppVersionMismatchReason } from '../lib/ocpp-version-mismatch.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { siteInScope } from '../lib/site-scope.js';
import { authorize } from '../middleware/rbac.js';

const stationIdParams = z.object({
  stationId: ID_PARAMS.stationId.describe('Charging station ID'),
});

const localAuthEntryItem = z
  .object({
    id: z.number().describe('Identifier'),
    stationId: z.string().describe('Charging station identifier'),
    driverTokenId: z
      .string()
      .nullable()
      .describe('Linked driver token ID, or null when the source token was deleted'),
    idToken: z.string().describe('RFID token value as it appears on the station'),
    tokenType: z.string().describe('OCPP token type (e.g., ISO14443, Central)'),
    authStatus: z
      .string()
      .describe('OCPP authorization status of the last push (Accepted, Blocked, Expired)'),
    addedAt: z.coerce.date().describe('Timestamp when the entry was added to the tracked list'),
    pushedAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp when the entry was last pushed to the station; null when pending'),
    createdAt: z.coerce.date().describe('Timestamp when created'),
    updatedAt: z.coerce.date().describe('Timestamp when last modified'),
    driverName: z
      .string()
      .nullable()
      .describe('Display name of the linked driver, or null when no driver is associated'),
  })
  .passthrough();

const versionInfoItem = z
  .object({
    localVersion: z.number().describe('Current CSMS-side version number for the local auth list'),
    lastSyncAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp of the most recent successful push to the station'),
    lastModifiedAt: z.coerce
      .date()
      .nullable()
      .describe(
        'Timestamp when entries were last added or removed; compare with lastSyncAt to detect unpushed changes',
      ),
    entries: z.array(localAuthEntryItem).describe('Tracked local auth entries on the current page'),
    total: z.number().describe('Total number of tracked entries'),
  })
  .passthrough();

const availableTokenItem = z
  .object({
    id: z.string().describe('Driver token identifier'),
    idToken: z.string().describe('RFID token value'),
    tokenType: z.string().describe('OCPP token type (e.g., ISO14443, Central)'),
    driverName: z.string().nullable().describe('Display name of the driver who owns the token'),
  })
  .passthrough();

const pushResponse = z
  .object({
    status: z.string().describe('OCPP push result status (typically Accepted)'),
    entriesCount: z.number().describe('Number of entries pushed to the station'),
    version: z.number().describe('New version number recorded after the push'),
  })
  .passthrough();

const mutateResponse = z
  .object({
    status: z.string().describe('Mutation outcome status'),
    count: z.number().describe('Number of entries affected by the operation'),
  })
  .passthrough();

const addTokensBody = z.object({
  tokenIds: z.array(z.string()).min(1).max(1000).describe('Driver token IDs to add'),
});

const removeEntriesBody = z.object({
  entryIds: z
    .array(z.number().int().min(1))
    .min(1)
    .max(1000)
    .describe('Local auth entry IDs to remove'),
});

const availableTokensQuery = z.object({
  search: z.string().max(255).optional().describe('Search filter for token or driver name'),
  page: z.coerce.number().int().min(1).default(1).describe('Page number (1-based)'),
  limit: z.coerce.number().int().min(1).max(200).default(50).describe('Page size, max 200'),
});

async function getStation(stationId: string) {
  const [station] = await db
    .select({
      id: chargingStations.id,
      stationId: chargingStations.stationId,
      siteId: chargingStations.siteId,
      isOnline: chargingStations.isOnline,
      ocppProtocol: chargingStations.ocppProtocol,
    })
    .from(chargingStations)
    .where(eq(chargingStations.id, stationId));
  return station;
}

async function getOrCreateVersionRow(stationId: string) {
  const [existing] = await db
    .select()
    .from(stationLocalAuthVersions)
    .where(eq(stationLocalAuthVersions.stationId, stationId));
  if (existing != null) return existing;

  const [created] = await db.insert(stationLocalAuthVersions).values({ stationId }).returning();
  if (created == null) throw new Error('Failed to create version row');
  return created;
}

type LocalAuthStatus = 'Accepted' | 'Blocked' | 'Expired';

interface PushedEntry {
  entryId: number;
  idToken: string;
  tokenType: string;
  authStatus: LocalAuthStatus;
  cacheExpiryDateTime: string | null;
}

/**
 * The status a station's local list holds for a postpaid token, the way the
 * authorize check answers it: Blocked when the token is inactive or revoked or
 * its driver is deactivated, Expired after its expiry, else Accepted.
 */
export function localAuthStatusOf(
  token: {
    isActive: boolean;
    revokedAt: Date | null;
    expiresAt: Date | null;
    driverIsActive: boolean | null;
  },
  now: Date,
): LocalAuthStatus {
  if (!token.isActive || token.revokedAt != null || token.driverIsActive === false) {
    return 'Blocked';
  }
  if (token.expiresAt != null && token.expiresAt.getTime() <= now.getTime()) return 'Expired';
  return 'Accepted';
}

/**
 * Brings a station's tracked entries in line with their tokens before a push:
 * removes entries whose token was deleted or is a prepaid card (a station
 * must check a prepaid balance online, so it never holds one locally), and
 * gives each entry the token's
 * current value, type and status, so a reactivated, renamed or expired token
 * reaches the station as it is now. Returns the entries to push, one per
 * idToken value.
 */
async function reconcileLocalAuthEntries(stationId: string, now: Date): Promise<PushedEntry[]> {
  await db
    .delete(stationLocalAuthEntries)
    .where(
      and(
        eq(stationLocalAuthEntries.stationId, stationId),
        isNull(stationLocalAuthEntries.driverTokenId),
      ),
    );
  const prepaidEntries = await db
    .select({ id: stationLocalAuthEntries.id })
    .from(stationLocalAuthEntries)
    .innerJoin(driverTokens, eq(stationLocalAuthEntries.driverTokenId, driverTokens.id))
    .where(
      and(
        eq(stationLocalAuthEntries.stationId, stationId),
        isNotNull(driverTokens.prepaidBalanceCents),
      ),
    );
  if (prepaidEntries.length > 0) {
    await db.delete(stationLocalAuthEntries).where(
      inArray(
        stationLocalAuthEntries.id,
        prepaidEntries.map((e) => e.id),
      ),
    );
  }

  const rows = await db
    .select({
      entryId: stationLocalAuthEntries.id,
      entryIdToken: stationLocalAuthEntries.idToken,
      entryTokenType: stationLocalAuthEntries.tokenType,
      entryAuthStatus: stationLocalAuthEntries.authStatus,
      idToken: driverTokens.idToken,
      tokenType: driverTokens.tokenType,
      isActive: driverTokens.isActive,
      revokedAt: driverTokens.revokedAt,
      expiresAt: driverTokens.expiresAt,
      driverIsActive: drivers.isActive,
    })
    .from(stationLocalAuthEntries)
    .innerJoin(driverTokens, eq(stationLocalAuthEntries.driverTokenId, driverTokens.id))
    .leftJoin(drivers, eq(driverTokens.driverId, drivers.id))
    .where(eq(stationLocalAuthEntries.stationId, stationId))
    .orderBy(stationLocalAuthEntries.id);

  const pushed: PushedEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const authStatus = localAuthStatusOf(row, now);
    if (
      row.entryIdToken !== row.idToken ||
      row.entryTokenType !== row.tokenType ||
      row.entryAuthStatus !== authStatus
    ) {
      try {
        await db
          .update(stationLocalAuthEntries)
          .set({ idToken: row.idToken, tokenType: row.tokenType, authStatus })
          .where(eq(stationLocalAuthEntries.id, row.entryId));
      } catch (err) {
        // Another entry of this station already has the new value (unique
        // per station and idToken): that entry carries it to the station.
        if (pgErrorCode(err) !== PG_UNIQUE_VIOLATION) throw err;
      }
    }
    if (seen.has(row.idToken)) continue;
    seen.add(row.idToken);
    pushed.push({
      entryId: row.entryId,
      idToken: row.idToken,
      tokenType: row.tokenType,
      authStatus,
      cacheExpiryDateTime:
        authStatus === 'Accepted' && row.expiresAt != null ? row.expiresAt.toISOString() : null,
    });
  }
  return pushed;
}

export function localAuthListRoutes(app: FastifyInstance): void {
  // List tracked entries + version info
  app.get(
    '/stations/:stationId/local-auth-list',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Local Auth List'],
        summary: 'List local auth list entries and version info',
        operationId: 'listLocalAuthEntries',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        querystring: zodSchema(paginationQuery),
        response: {
          200: itemResponse(versionInfoItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { stationId } = request.params as z.infer<typeof stationIdParams>;
      const query = request.query as z.infer<typeof paginationQuery>;
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const station = await getStation(stationId);
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, station.siteId)) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const versionRow = await getOrCreateVersionRow(stationId);

      const [entries, totalResult] = await Promise.all([
        db
          .select({
            id: stationLocalAuthEntries.id,
            stationId: stationLocalAuthEntries.stationId,
            driverTokenId: stationLocalAuthEntries.driverTokenId,
            idToken: stationLocalAuthEntries.idToken,
            tokenType: stationLocalAuthEntries.tokenType,
            authStatus: stationLocalAuthEntries.authStatus,
            addedAt: stationLocalAuthEntries.addedAt,
            pushedAt: stationLocalAuthEntries.pushedAt,
            createdAt: stationLocalAuthEntries.createdAt,
            updatedAt: stationLocalAuthEntries.updatedAt,
            driverFirstName: drivers.firstName,
            driverLastName: drivers.lastName,
          })
          .from(stationLocalAuthEntries)
          .leftJoin(driverTokens, eq(stationLocalAuthEntries.driverTokenId, driverTokens.id))
          .leftJoin(drivers, eq(driverTokens.driverId, drivers.id))
          .where(eq(stationLocalAuthEntries.stationId, stationId))
          .orderBy(desc(stationLocalAuthEntries.addedAt), desc(stationLocalAuthEntries.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: count() })
          .from(stationLocalAuthEntries)
          .where(eq(stationLocalAuthEntries.stationId, stationId)),
      ]);

      const data = entries.map((e) => ({
        id: e.id,
        stationId: e.stationId,
        driverTokenId: e.driverTokenId,
        idToken: e.idToken,
        tokenType: e.tokenType,
        authStatus: e.authStatus,
        addedAt: e.addedAt,
        pushedAt: e.pushedAt,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        driverName:
          e.driverFirstName != null
            ? `${e.driverFirstName} ${e.driverLastName ?? ''}`.trim()
            : null,
      }));

      return {
        localVersion: versionRow.localVersion,
        lastSyncAt: versionRow.lastSyncAt,
        lastModifiedAt: versionRow.lastModifiedAt,
        entries: data,
        total: totalResult[0]?.count ?? 0,
      };
    },
  );

  // Available tokens not already on this station's list
  app.get(
    '/stations/:stationId/local-auth-list/available-tokens',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Local Auth List'],
        summary: 'List active driver tokens not on this station local auth list',
        description:
          'Active, postpaid driver tokens that are not on the list yet. Prepaid cards are left out: a station must check their balance online.',
        operationId: 'listAvailableTokensForLocalAuth',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        querystring: zodSchema(availableTokensQuery),
        response: {
          200: paginatedResponse(availableTokenItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { stationId } = request.params as z.infer<typeof stationIdParams>;
      const query = request.query as z.infer<typeof availableTokensQuery>;

      const station = await getStation(stationId);
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, station.siteId)) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Get IDs of tokens already on the list
      const existingEntries = await db
        .select({ driverTokenId: stationLocalAuthEntries.driverTokenId })
        .from(stationLocalAuthEntries)
        .where(eq(stationLocalAuthEntries.stationId, stationId));

      const excludeIds = existingEntries
        .map((e) => e.driverTokenId)
        .filter((id): id is string => id != null);

      // Prepaid cards are checked online on every start (balance), never
      // from a local list.
      const conditions = [
        eq(driverTokens.isActive, true),
        isNull(driverTokens.prepaidBalanceCents),
      ];
      if (excludeIds.length > 0) {
        conditions.push(notInArray(driverTokens.id, excludeIds));
      }
      if (query.search != null && query.search !== '') {
        const searchPattern = `%${query.search}%`;
        const searchCondition = or(
          ilike(driverTokens.idToken, searchPattern),
          ilike(drivers.firstName, searchPattern),
          ilike(drivers.lastName, searchPattern),
        );
        if (searchCondition != null) {
          conditions.push(searchCondition);
        }
      }

      const where = and(...conditions);
      const offset = (query.page - 1) * query.limit;

      const [tokens, totalResult] = await Promise.all([
        db
          .select({
            id: driverTokens.id,
            idToken: driverTokens.idToken,
            tokenType: driverTokens.tokenType,
            driverFirstName: drivers.firstName,
            driverLastName: drivers.lastName,
          })
          .from(driverTokens)
          .leftJoin(drivers, eq(driverTokens.driverId, drivers.id))
          .where(where)
          .limit(query.limit)
          .offset(offset),
        db
          .select({ count: count() })
          .from(driverTokens)
          .leftJoin(drivers, eq(driverTokens.driverId, drivers.id))
          .where(where),
      ]);

      const data = tokens.map((t) => ({
        id: t.id,
        idToken: t.idToken,
        tokenType: t.tokenType,
        driverName:
          t.driverFirstName != null
            ? `${t.driverFirstName} ${t.driverLastName ?? ''}`.trim()
            : null,
      }));

      return { data, total: totalResult[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // Push tracked entries to station via OCPP SendLocalList Full
  app.post(
    '/stations/:stationId/local-auth-list/push',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Local Auth List'],
        summary: 'Push tracked entries to station via OCPP SendLocalList Full',
        description:
          'Reconciles tracked entries with their tokens (drops entries of deleted tokens; each entry gets the token current value, type and status: Blocked when the token or its driver is deactivated, Expired after its expiry, else Accepted with the expiry as cacheExpiryDateTime; entries of prepaid cards are dropped, since a station checks a prepaid balance online), increments the local list version, and dispatches SendLocalList(Full) to the station. On Accepted, updates lastSyncAt and stamps pushedAt on the pushed entries. Returns 400 if the station is offline, 502 on station rejection or command failure, 504 on timeout.',
        operationId: 'pushLocalAuthList',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        response: {
          200: itemResponse(pushResponse),
          400: errorWith('Station offline, or an entry OCPP 2.0.1 cannot hold', [
            ERROR_CODES.STATION_OFFLINE,
            ERROR_CODES.OCPP_VERSION_MISMATCH,
          ]),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
          502: errorWith('Push rejected or command failed', [
            ERROR_CODES.PUSH_REJECTED,
            ERROR_CODES.COMMAND_FAILED,
          ]),
          504: errorWith('Station did not respond within timeout', [ERROR_CODES.COMMAND_TIMEOUT]),
        },
      },
    },
    async (request, reply) => {
      const { stationId } = request.params as z.infer<typeof stationIdParams>;

      const station = await getStation(stationId);
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, station.siteId)) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (!station.isOnline) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      // Changes after this moment stay "unpushed" (lastModifiedAt > lastSyncAt).
      const pushStartedAt = new Date();
      const pushed = await reconcileLocalAuthEntries(stationId, pushStartedAt);

      // Atomic version reservation: read-modify-write was racy when two
      // operators clicked Push simultaneously (both computed newVersion = N+1,
      // station treated the second push as a duplicate version and ignored
      // its entries). UPDATE ... SET localVersion = localVersion + 1 RETURNING
      // claims a unique version per request, guaranteed by PostgreSQL row
      // locking. lastSyncAt moves only when the station accepts the list, so
      // a failed push keeps the unpushed-changes banner.
      await getOrCreateVersionRow(stationId);
      const [reserved] = await db
        .update(stationLocalAuthVersions)
        .set({
          localVersion: sql`${stationLocalAuthVersions.localVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(stationLocalAuthVersions.stationId, stationId))
        .returning({ localVersion: stationLocalAuthVersions.localVersion });
      const newVersion = reserved?.localVersion ?? 1;

      // Build OCPP SendLocalList payload (2.1 format; command-translation handles 1.6)
      const payload: Record<string, unknown> = {
        versionNumber: newVersion,
        updateType: 'Full',
      };

      // localAuthorizationList has minItems: 1 in OCPP schema, omit when empty
      if (pushed.length > 0) {
        payload.localAuthorizationList = pushed.map((entry) => ({
          idToken: { idToken: entry.idToken, type: entry.tokenType },
          idTokenInfo: {
            status: entry.authStatus,
            ...(entry.cacheExpiryDateTime != null
              ? { cacheExpiryDateTime: entry.cacheExpiryDateTime }
              : {}),
          },
        }));
      }

      const result = await sendOcppCommandAndWait(station.stationId, 'SendLocalList', payload);

      // Refused by the OCPP server for the station's OCPP version (a token
      // type or id OCPP 2.0.1 cannot hold): never sent.
      const refusal = ocppVersionMismatchReason(result);
      if (refusal != null) {
        await reply.status(400).send({ error: refusal, code: 'OCPP_VERSION_MISMATCH' });
        return;
      }

      if (result.error != null) {
        const isTimeout = result.timedOut === true;
        await reply.status(isTimeout ? 504 : 502).send({
          error: result.error,
          code: isTimeout ? 'COMMAND_TIMEOUT' : 'COMMAND_FAILED',
        });
        return;
      }

      const responseStatus = result.response?.['status'] as string | undefined;
      if (responseStatus !== 'Accepted') {
        await reply.status(502).send({
          error: `Station rejected push: ${responseStatus ?? 'Unknown'}`,
          code: 'PUSH_REJECTED',
        });
        return;
      }

      // The station holds this list: the sync time is the start of the push,
      // so a change made while it ran still shows as unpushed. The guard
      // keeps a newer concurrent push's time.
      await db
        .update(stationLocalAuthVersions)
        .set({ lastSyncAt: pushStartedAt, updatedAt: new Date() })
        .where(
          and(
            eq(stationLocalAuthVersions.stationId, stationId),
            or(
              isNull(stationLocalAuthVersions.lastSyncAt),
              lt(stationLocalAuthVersions.lastSyncAt, pushStartedAt),
            ),
          ),
        );

      // Mark the pushed entries; an entry added while the push ran stays pending.
      const pushedIds = pushed.map((e) => e.entryId);
      if (pushedIds.length > 0) {
        await db
          .update(stationLocalAuthEntries)
          .set({ pushedAt: pushStartedAt })
          .where(inArray(stationLocalAuthEntries.id, pushedIds));
      }

      const actor = getAuditActor(request);
      await writeAudit(
        { table: localAuthListAuditLog, idColumn: 'station_id' },
        {
          entityId: stationId,
          entityIdSnapshot: stationId,
          action: 'pushed',
          ...actor,
          notes: `Pushed ${String(pushed.length)} entries (version ${String(newVersion)})`,
        },
        db,
        request.log,
      );

      return {
        status: 'Accepted',
        entriesCount: pushed.length,
        version: newVersion,
      };
    },
  );

  // Add tokens to tracked list (DB-only, no OCPP command)
  app.post(
    '/stations/:stationId/local-auth-list/add',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Local Auth List'],
        summary: 'Add tokens to station local auth list (DB-only)',
        description:
          'Adds active, postpaid tokens. Inactive and prepaid tokens are skipped; 400 NO_VALID_TOKENS when none is left.',
        operationId: 'addLocalAuthTokens',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        body: zodSchema(addTokensBody),
        response: {
          200: itemResponse(mutateResponse),
          400: errorWith('No valid tokens', [ERROR_CODES.NO_VALID_TOKENS]),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { stationId } = request.params as z.infer<typeof stationIdParams>;
      const { tokenIds } = request.body as z.infer<typeof addTokensBody>;

      const station = await getStation(stationId);
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, station.siteId)) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Fetch only the requested tokens. The prior pattern selected every
      // active driver token in the system and JS-filtered down to the
      // small requested set, which transferred N thousand rows for an
      // operation that touches a handful.
      const requestedTokens =
        tokenIds.length === 0
          ? []
          : await db
              .select({
                id: driverTokens.id,
                idToken: driverTokens.idToken,
                tokenType: driverTokens.tokenType,
              })
              .from(driverTokens)
              .where(
                and(
                  eq(driverTokens.isActive, true),
                  isNull(driverTokens.prepaidBalanceCents),
                  inArray(driverTokens.id, tokenIds),
                ),
              );

      if (requestedTokens.length === 0) {
        await reply.status(400).send({ error: 'No valid tokens found', code: 'NO_VALID_TOKENS' });
        return;
      }

      // Insert entries (ignore conflicts for idempotency)
      for (const token of requestedTokens) {
        await db
          .insert(stationLocalAuthEntries)
          .values({
            stationId,
            driverTokenId: token.id,
            idToken: token.idToken,
            tokenType: token.tokenType,
            authStatus: 'Accepted',
          })
          .onConflictDoNothing();
      }

      // Mark list as modified
      await getOrCreateVersionRow(stationId);
      await db
        .update(stationLocalAuthVersions)
        .set({ lastModifiedAt: new Date(), updatedAt: new Date() })
        .where(eq(stationLocalAuthVersions.stationId, stationId));

      const actor = getAuditActor(request);
      await writeAudit(
        { table: localAuthListAuditLog, idColumn: 'station_id' },
        {
          entityId: stationId,
          entityIdSnapshot: stationId,
          action: 'tokens_added',
          ...actor,
          after: { tokenIds: requestedTokens.map((t) => t.id) },
        },
        db,
        request.log,
      );

      return {
        status: 'ok',
        count: requestedTokens.length,
      };
    },
  );

  // Remove entries from tracked list (DB-only, no OCPP command)
  app.post(
    '/stations/:stationId/local-auth-list/remove',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Local Auth List'],
        summary: 'Remove entries from station local auth list (DB-only)',
        operationId: 'removeLocalAuthEntries',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        body: zodSchema(removeEntriesBody),
        response: {
          200: itemResponse(mutateResponse),
          400: errorWith('No valid entries', [ERROR_CODES.NO_VALID_ENTRIES]),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { stationId } = request.params as z.infer<typeof stationIdParams>;
      const { entryIds } = request.body as z.infer<typeof removeEntriesBody>;

      const station = await getStation(stationId);
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, station.siteId)) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Fetch only the requested entries scoped to this station - the
      // prior pattern loaded every entry on the station (could be 10k+)
      // and JS-filtered for the small id set the caller asked about.
      const entriesToRemove =
        entryIds.length === 0
          ? []
          : await db
              .select({ id: stationLocalAuthEntries.id })
              .from(stationLocalAuthEntries)
              .where(
                and(
                  eq(stationLocalAuthEntries.stationId, stationId),
                  inArray(stationLocalAuthEntries.id, entryIds),
                ),
              );

      if (entriesToRemove.length === 0) {
        await reply.status(400).send({ error: 'No valid entries found', code: 'NO_VALID_ENTRIES' });
        return;
      }

      // Delete entries from tracking in a single statement instead of N.
      const removeIds = entriesToRemove.map((e) => e.id);
      await db
        .delete(stationLocalAuthEntries)
        .where(
          and(
            eq(stationLocalAuthEntries.stationId, stationId),
            inArray(stationLocalAuthEntries.id, removeIds),
          ),
        );

      // Mark list as modified
      await getOrCreateVersionRow(stationId);
      await db
        .update(stationLocalAuthVersions)
        .set({ lastModifiedAt: new Date(), updatedAt: new Date() })
        .where(eq(stationLocalAuthVersions.stationId, stationId));

      const actor = getAuditActor(request);
      await writeAudit(
        { table: localAuthListAuditLog, idColumn: 'station_id' },
        {
          entityId: stationId,
          entityIdSnapshot: stationId,
          action: 'tokens_removed',
          ...actor,
          before: { entryIds: entriesToRemove.map((e) => e.id) },
        },
        db,
        request.log,
      );

      return {
        status: 'ok',
        count: entriesToRemove.length,
      };
    },
  );
}
