// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { stationWatches, chargingStations, sites, evses, connectors } from '@evtivity/database';
import { zodSchema } from '../../lib/zod-schema.js';
import {
  successResponse,
  arrayResponse,
  itemResponse,
  errorWith,
} from '../../lib/response-schemas.js';
import { ERROR_CODES } from '../../lib/error-codes.generated.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';

// Bound the number of active watches a single driver can hold so a runaway
// client cannot accumulate unbounded rows.
const MAX_WATCHES_PER_DRIVER = 25;

const watchItem = z
  .object({
    id: z.number().int().min(1).describe('Watch record ID'),
    stationId: z.string().max(255).describe('OCPP station identity'),
    siteName: z.string().max(255).nullable().describe('Site name'),
    siteAddress: z.string().max(500).nullable().describe('Street address'),
    siteCity: z.string().max(100).nullable().describe('City'),
    siteState: z.string().max(100).nullable().describe('State or region'),
    isOnline: z.boolean().describe('Whether the station is currently online'),
    evseCount: z.number().int().min(0).describe('Total EVSEs at this station'),
    availableCount: z.number().int().min(0).describe('Number of available EVSEs at this station'),
    createdAt: z.coerce.date().describe('Timestamp when the watch was created'),
    expiresAt: z.coerce.date().describe('Timestamp when the watch auto-expires'),
  })
  .passthrough();

const addWatchBody = z.object({
  stationId: z.string().min(1).max(255).describe('OCPP station identifier'),
});

const removeWatchParams = z.object({
  id: z.coerce.number().int().min(1).describe('Watch record ID'),
});

const checkWatchParams = z.object({
  stationId: z.string().min(1).describe('OCPP station identifier'),
});

export function portalStationWatchRoutes(app: FastifyInstance): void {
  // List watches
  app.get(
    '/portal/station-watches',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'List watched stations',
        operationId: 'portalListStationWatches',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(watchItem) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;

      const rows = await db
        .select({
          id: stationWatches.id,
          stationOcppId: chargingStations.stationId,
          stationUuid: chargingStations.id,
          siteName: sites.name,
          siteAddress: sites.address,
          siteCity: sites.city,
          siteState: sites.state,
          isOnline: chargingStations.isOnline,
          createdAt: stationWatches.createdAt,
          expiresAt: stationWatches.expiresAt,
        })
        .from(stationWatches)
        .innerJoin(chargingStations, eq(stationWatches.stationId, chargingStations.id))
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(eq(stationWatches.driverId, driverId))
        .orderBy(desc(stationWatches.createdAt), desc(stationWatches.id));

      const stationUuids = rows.map((r) => r.stationUuid);
      let evseCounts: Array<{ stationId: string; total: number; available: number }> = [];
      if (stationUuids.length > 0) {
        evseCounts = await db
          .select({
            stationId: evses.stationId,
            total: sql<number>`count(DISTINCT ${evses.id})::int`,
            available: sql<number>`count(DISTINCT ${evses.id}) FILTER (WHERE ${connectors.status} = 'available')::int`,
          })
          .from(evses)
          .leftJoin(connectors, eq(connectors.evseId, evses.id))
          .where(inArray(evses.stationId, stationUuids))
          .groupBy(evses.stationId);
      }

      const countMap = new Map(evseCounts.map((e) => [e.stationId, e]));

      return rows.map((r) => {
        const counts = countMap.get(r.stationUuid);
        return {
          id: r.id,
          stationId: r.stationOcppId,
          siteName: r.siteName,
          siteAddress: r.siteAddress,
          siteCity: r.siteCity,
          siteState: r.siteState,
          isOnline: r.isOnline,
          evseCount: counts?.total ?? 0,
          availableCount: counts?.available ?? 0,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
        };
      });
    },
  );

  // Check if a station is being watched
  app.get(
    '/portal/station-watches/check/:stationId',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Check if a station is being watched',
        operationId: 'portalCheckStationWatch',
        security: [{ bearerAuth: [] }],
        params: zodSchema(checkWatchParams),
        response: {
          200: itemResponse(
            z
              .object({
                isWatching: z.boolean().describe('Whether the driver is watching this station'),
                watchId: z
                  .number()
                  .int()
                  .min(1)
                  .nullable()
                  .describe('Watch record ID when isWatching is true, otherwise null'),
              })
              .passthrough(),
          ),
        },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { stationId } = request.params as z.infer<typeof checkWatchParams>;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.stationId, stationId));

      if (station == null) {
        return { isWatching: false, watchId: null };
      }

      const [watch] = await db
        .select({ id: stationWatches.id })
        .from(stationWatches)
        .where(
          and(
            eq(stationWatches.driverId, driverId),
            eq(stationWatches.stationId, station.id),
            sql`${stationWatches.expiresAt} > now()`,
          ),
        );

      return { isWatching: watch != null, watchId: watch?.id ?? null };
    },
  );

  // Start watching
  app.post(
    '/portal/station-watches',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Start watching a station for availability',
        operationId: 'portalAddStationWatch',
        security: [{ bearerAuth: [] }],
        body: zodSchema(addWatchBody),
        response: {
          201: itemResponse(
            z.object({ id: z.number().int().min(1).describe('Watch record ID') }).passthrough(),
          ),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
          409: errorWith('Cannot watch this station', [
            ERROR_CODES.STATION_ALREADY_AVAILABLE,
            ERROR_CODES.TOO_MANY_WATCHES,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { stationId } = request.body as z.infer<typeof addWatchBody>;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.stationId, stationId));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Already-free stations have nothing to wait for.
      const availRows = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(connectors)
        .innerJoin(evses, eq(connectors.evseId, evses.id))
        .where(and(eq(evses.stationId, station.id), sql`${connectors.status} = 'available'`));
      if ((availRows[0]?.total ?? 0) > 0) {
        await reply.status(409).send({
          error: 'Station already has an available connector',
          code: 'STATION_ALREADY_AVAILABLE',
        });
        return;
      }

      // Return the existing watch when already ACTIVELY watching (idempotent
      // re-tap, does not consume the cap). An expired-but-unpruned row is not
      // treated as active here; the upsert below re-arms it.
      const [existing] = await db
        .select({ id: stationWatches.id })
        .from(stationWatches)
        .where(
          and(
            eq(stationWatches.driverId, driverId),
            eq(stationWatches.stationId, station.id),
            sql`${stationWatches.expiresAt} > now()`,
          ),
        );
      if (existing != null) {
        void reply.status(201);
        return { id: existing.id };
      }

      const countRows = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(stationWatches)
        .where(
          and(eq(stationWatches.driverId, driverId), sql`${stationWatches.expiresAt} > now()`),
        );
      if ((countRows[0]?.total ?? 0) >= MAX_WATCHES_PER_DRIVER) {
        await reply
          .status(409)
          .send({ error: 'You are watching too many stations', code: 'TOO_MANY_WATCHES' });
        return;
      }

      // Upsert so a re-watch after a prior (possibly expired, not-yet-pruned)
      // watch re-arms the row instead of returning a dead expired id or hitting
      // the (driver_id, station_id) unique constraint.
      const [row] = await db
        .insert(stationWatches)
        .values({ driverId, stationId: station.id })
        .onConflictDoUpdate({
          target: [stationWatches.driverId, stationWatches.stationId],
          set: { expiresAt: sql`now() + interval '24 hours'`, createdAt: sql`now()` },
        })
        .returning({ id: stationWatches.id });

      void reply.status(201);
      return { id: row?.id ?? 0 };
    },
  );

  // Stop watching
  app.delete(
    '/portal/station-watches/:id',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Stop watching a station',
        operationId: 'portalRemoveStationWatch',
        security: [{ bearerAuth: [] }],
        params: zodSchema(removeWatchParams),
        response: {
          200: successResponse,
          404: errorWith('Watch not found', [ERROR_CODES.STATION_WATCH_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof removeWatchParams>;

      const [watch] = await db
        .select({ id: stationWatches.id })
        .from(stationWatches)
        .where(and(eq(stationWatches.id, id), eq(stationWatches.driverId, driverId)));

      if (watch == null) {
        await reply.status(404).send({ error: 'Watch not found', code: 'STATION_WATCH_NOT_FOUND' });
        return;
      }

      await db.delete(stationWatches).where(eq(stationWatches.id, id));

      return { success: true };
    },
  );
}
