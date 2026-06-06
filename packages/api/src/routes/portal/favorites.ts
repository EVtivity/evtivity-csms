// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { db } from '@evtivity/database';
import {
  driverFavoriteStations,
  chargingStations,
  sites,
  evses,
  connectors,
} from '@evtivity/database';
import { zodSchema } from '../../lib/zod-schema.js';
import {
  successResponse,
  arrayResponse,
  itemResponse,
  errorWith,
} from '../../lib/response-schemas.js';
import { ERROR_CODES } from '../../lib/error-codes.generated.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';

const favoriteItem = z
  .object({
    id: z.number().int().min(1).describe('Favorite record ID'),
    stationId: z.string().max(255).describe('OCPP station identity'),
    siteName: z.string().max(255).nullable().describe('Site name'),
    siteAddress: z.string().max(500).nullable().describe('Street address'),
    siteCity: z.string().max(100).nullable().describe('City'),
    siteState: z.string().max(100).nullable().describe('State or region'),
    isOnline: z.boolean().describe('Whether the station is currently online'),
    evseCount: z.number().int().min(0).describe('Total EVSEs at this station'),
    availableCount: z.number().int().min(0).describe('Number of available EVSEs at this station'),
    createdAt: z.coerce.date().describe('Timestamp when the station was favorited'),
  })
  .passthrough();

const addFavoriteBody = z.object({
  stationId: z.string().min(1).max(255).describe('OCPP station identifier'),
});

const removeFavoriteParams = z.object({
  id: z.coerce.number().int().min(1).describe('Favorite record ID'),
});

const checkFavoriteParams = z.object({
  stationId: z.string().min(1).describe('OCPP station identifier'),
});

export function portalFavoriteRoutes(app: FastifyInstance): void {
  // List favorites
  app.get(
    '/portal/favorites',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'List favorite stations',
        operationId: 'portalListFavorites',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(favoriteItem) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;

      const rows = await db
        .select({
          id: driverFavoriteStations.id,
          stationOcppId: chargingStations.stationId,
          stationUuid: chargingStations.id,
          siteName: sites.name,
          siteAddress: sites.address,
          siteCity: sites.city,
          siteState: sites.state,
          isOnline: chargingStations.isOnline,
          createdAt: driverFavoriteStations.createdAt,
        })
        .from(driverFavoriteStations)
        .innerJoin(chargingStations, eq(driverFavoriteStations.stationId, chargingStations.id))
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(eq(driverFavoriteStations.driverId, driverId))
        .orderBy(desc(driverFavoriteStations.createdAt), desc(driverFavoriteStations.id));

      // Batch fetch EVSE counts
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
        };
      });
    },
  );

  // Check if a station is favorited
  app.get(
    '/portal/favorites/check/:stationId',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Check if a station is favorited',
        operationId: 'portalCheckFavorite',
        security: [{ bearerAuth: [] }],
        params: zodSchema(checkFavoriteParams),
        response: {
          200: itemResponse(
            z
              .object({
                isFavorite: z.boolean().describe('Whether the station is in the driver favorites'),
                favoriteId: z
                  .number()
                  .int()
                  .min(1)
                  .nullable()
                  .describe('Favorite record ID when isFavorite is true, otherwise null'),
              })
              .passthrough(),
          ),
        },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { stationId } = request.params as z.infer<typeof checkFavoriteParams>;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.stationId, stationId));

      if (station == null) {
        return { isFavorite: false, favoriteId: null };
      }

      const [fav] = await db
        .select({ id: driverFavoriteStations.id })
        .from(driverFavoriteStations)
        .where(
          and(
            eq(driverFavoriteStations.driverId, driverId),
            eq(driverFavoriteStations.stationId, station.id),
          ),
        );

      return {
        isFavorite: fav != null,
        favoriteId: fav?.id ?? null,
      };
    },
  );

  // Add favorite
  app.post(
    '/portal/favorites',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Add a station to favorites',
        operationId: 'portalAddFavorite',
        security: [{ bearerAuth: [] }],
        body: zodSchema(addFavoriteBody),
        response: {
          201: itemResponse(
            z
              .object({
                id: z.number().int().min(1).describe('Newly created favorite record ID'),
              })
              .passthrough(),
          ),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
          409: errorWith('Already favorited', [ERROR_CODES.ALREADY_FAVORITED]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { stationId } = request.body as z.infer<typeof addFavoriteBody>;

      // Resolve OCPP station ID to UUID
      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.stationId, stationId));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Check for duplicate
      const [existing] = await db
        .select({ id: driverFavoriteStations.id })
        .from(driverFavoriteStations)
        .where(
          and(
            eq(driverFavoriteStations.driverId, driverId),
            eq(driverFavoriteStations.stationId, station.id),
          ),
        );

      if (existing != null) {
        await reply.status(409).send({ error: 'Already favorited', code: 'ALREADY_FAVORITED' });
        return;
      }

      const [row] = await db
        .insert(driverFavoriteStations)
        .values({ driverId, stationId: station.id })
        .returning({ id: driverFavoriteStations.id });

      void reply.status(201);
      return { id: row?.id ?? 0 };
    },
  );

  // Remove favorite
  app.delete(
    '/portal/favorites/:id',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Remove a station from favorites',
        operationId: 'portalRemoveFavorite',
        security: [{ bearerAuth: [] }],
        params: zodSchema(removeFavoriteParams),
        response: {
          200: successResponse,
          404: errorWith('Favorite not found', [ERROR_CODES.FAVORITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof removeFavoriteParams>;

      const [fav] = await db
        .select({ id: driverFavoriteStations.id })
        .from(driverFavoriteStations)
        .where(
          and(eq(driverFavoriteStations.id, id), eq(driverFavoriteStations.driverId, driverId)),
        );

      if (fav == null) {
        await reply.status(404).send({ error: 'Favorite not found', code: 'FAVORITE_NOT_FOUND' });
        return;
      }

      await db.delete(driverFavoriteStations).where(eq(driverFavoriteStations.id, id));

      return { success: true };
    },
  );
}
