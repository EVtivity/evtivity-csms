// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, count, notInArray, ilike, or, isNull, inArray } from 'drizzle-orm';
import { db, writeAudit, localAuthListAuditLog } from '@evtivity/database';
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
import { sendOcppCommandAndWait } from '../lib/ocpp-command.js';
import { getUserSiteIds } from '../lib/site-access.js';
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
      .describe(
        'OCPP authorization status pushed to the station (Accepted, Blocked, Expired, Invalid, ConcurrentTx)',
      ),
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
      if (siteIds != null && station.siteId != null && !siteIds.includes(station.siteId)) {
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
          .orderBy(desc(stationLocalAuthEntries.addedAt))
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
      if (siteIds != null && station.siteId != null && !siteIds.includes(station.siteId)) {
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

      const conditions = [eq(driverTokens.isActive, true)];
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
          'Reconciles tracked entries (drops orphans, blocks deactivated tokens), increments the local list version, and dispatches SendLocalList(Full) to the station. On Accepted, updates lastSyncAt and stamps pushedAt on every entry. Returns 400 if the station is offline and 502 on station rejection or timeout.',
        operationId: 'pushLocalAuthList',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        response: {
          200: itemResponse(pushResponse),
          400: errorWith('Station offline', [ERROR_CODES.STATION_OFFLINE]),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
          502: errorWith('Push rejected', [ERROR_CODES.PUSH_REJECTED]),
          504: errorWith('Station did not respond within timeout', [ERROR_CODES.STATION_TIMEOUT]),
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
      if (siteIds != null && station.siteId != null && !siteIds.includes(station.siteId)) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (!station.isOnline) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      // Reconcile entries before push
      // 1. Remove entries where the backing token was deleted (FK set null)
      await db
        .delete(stationLocalAuthEntries)
        .where(
          and(
            eq(stationLocalAuthEntries.stationId, stationId),
            isNull(stationLocalAuthEntries.driverTokenId),
          ),
        );

      // 2. Block entries where the backing token was deactivated
      const entriesWithTokens = await db
        .select({
          entryId: stationLocalAuthEntries.id,
          isActive: driverTokens.isActive,
        })
        .from(stationLocalAuthEntries)
        .innerJoin(driverTokens, eq(stationLocalAuthEntries.driverTokenId, driverTokens.id))
        .where(eq(stationLocalAuthEntries.stationId, stationId));

      const deactivatedEntryIds = entriesWithTokens
        .filter((e) => !e.isActive)
        .map((e) => e.entryId);

      if (deactivatedEntryIds.length > 0) {
        await db
          .update(stationLocalAuthEntries)
          .set({ authStatus: 'Blocked' })
          .where(inArray(stationLocalAuthEntries.id, deactivatedEntryIds));
      }

      // Fetch reconciled entries for this station
      const trackedEntries = await db
        .select({
          idToken: stationLocalAuthEntries.idToken,
          tokenType: stationLocalAuthEntries.tokenType,
          authStatus: stationLocalAuthEntries.authStatus,
        })
        .from(stationLocalAuthEntries)
        .where(eq(stationLocalAuthEntries.stationId, stationId));

      const versionRow = await getOrCreateVersionRow(stationId);
      const newVersion = versionRow.localVersion + 1;

      // Build OCPP SendLocalList payload (2.1 format; command-translation handles 1.6)
      const payload: Record<string, unknown> = {
        versionNumber: newVersion,
        updateType: 'Full',
      };

      // localAuthorizationList has minItems: 1 in OCPP schema, omit when empty
      if (trackedEntries.length > 0) {
        payload.localAuthorizationList = trackedEntries.map((entry) => ({
          idToken: { idToken: entry.idToken, type: entry.tokenType },
          idTokenInfo: { status: entry.authStatus },
        }));
      }

      const result = await sendOcppCommandAndWait(
        station.stationId,
        'SendLocalList',
        payload,
        station.ocppProtocol ?? undefined,
      );

      if (result.error != null) {
        const isTimeout = result.error.includes('No response within');
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

      // Update version and last sync time
      await db
        .update(stationLocalAuthVersions)
        .set({
          localVersion: newVersion,
          lastSyncAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(stationLocalAuthVersions.stationId, stationId));

      // Mark all entries as pushed
      await db
        .update(stationLocalAuthEntries)
        .set({ pushedAt: new Date() })
        .where(eq(stationLocalAuthEntries.stationId, stationId));

      const actor = getAuditActor(request);
      await writeAudit(
        { table: localAuthListAuditLog, idColumn: 'station_id' },
        {
          entityId: stationId,
          entityIdSnapshot: stationId,
          action: 'pushed',
          ...actor,
          notes: `Pushed ${String(trackedEntries.length)} entries (version ${String(newVersion)})`,
        },
        db,
        request.log,
      );

      return {
        status: 'Accepted',
        entriesCount: trackedEntries.length,
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
      if (siteIds != null && station.siteId != null && !siteIds.includes(station.siteId)) {
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
              .where(and(eq(driverTokens.isActive, true), inArray(driverTokens.id, tokenIds)));

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
      if (siteIds != null && station.siteId != null && !siteIds.includes(station.siteId)) {
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
