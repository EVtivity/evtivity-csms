// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, sql, isNull } from 'drizzle-orm';
import { db, availableEvseCountSql, inServiceEvseCountSql } from '@evtivity/database';
import {
  driverFavoriteStations,
  chargingStations,
  sites,
  stationUnits,
  isOperatorStation,
} from '@evtivity/database';
import { publicStationServed } from '../../lib/public-station.js';
import { zodSchema } from '../../lib/zod-schema.js';
import {
  successResponse,
  arrayResponse,
  itemResponse,
  errorWith,
} from '../../lib/response-schemas.js';
import { ERROR_CODES } from '../../lib/error-codes.generated.js';
import { ID_PARAMS } from '../../lib/id-validation.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';

const favoriteItem = z
  .object({
    id: z.number().int().min(1).describe('Favorite record ID'),
    stationId: z.string().max(255).describe('OCPP station identity'),
    unitId: z
      .string()
      .nullable()
      .describe('The unit (charger box) favorited, null for the whole station'),
    unitName: z.string().nullable().describe('Name of that unit, null for the whole station'),
    siteName: z.string().max(255).nullable().describe('Site name'),
    siteAddress: z.string().max(500).nullable().describe('Street address'),
    siteCity: z.string().max(100).nullable().describe('City'),
    siteState: z.string().max(100).nullable().describe('State or region'),
    isOnline: z.boolean().describe('Whether the station is currently online'),
    evseCount: z
      .number()
      .int()
      .min(0)
      .describe('EVSEs in service at this station, or at the unit for a unit'),
    availableCount: z
      .number()
      .int()
      .min(0)
      .describe(
        'Number of EVSEs a driver can use now: 0 when the station is offline, disabled, installing firmware, faulted at station level, or under maintenance; a reserved EVSE is not counted',
      ),
    createdAt: z.coerce.date().describe('Timestamp when the station was favorited'),
  })
  .loose();

const addFavoriteBody = z.object({
  stationId: z.string().min(1).max(255).describe('OCPP station identifier'),
  unitId: ID_PARAMS.unitId
    .optional()
    .describe('A unit (charger box) of that station; omitted for the whole station'),
});

const removeFavoriteParams = z.object({
  id: z.coerce.number().int().min(1).describe('Favorite record ID'),
});

const checkFavoriteParams = z.object({
  stationId: z.string().min(1).describe('OCPP station identifier'),
});

const checkUnitQuery = z.object({
  unitId: ID_PARAMS.unitId
    .optional()
    .describe('Check one unit (charger box) of the station; omitted for the whole station'),
});

// The row of the whole station (null unit) or of one unit: unit ids compare
// as values, and a null unit matches only a null unit.
function sameUnit(column: typeof driverFavoriteStations.unitId, unitId: string | null) {
  return unitId == null ? isNull(column) : eq(column, unitId);
}

// A unit sent with a station must be a unit of that station. The reply never
// names the other station: an unknown unit and another station's unit answer alike.
async function unitOfStation(stationUuid: string, unitId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: stationUnits.id })
    .from(stationUnits)
    .where(and(eq(stationUnits.id, unitId), eq(stationUnits.stationId, stationUuid)));
  return row != null;
}

const UNIT_NOT_OF_STATION = {
  error: 'The unit is not a unit of this station',
  code: 'VALIDATION_ERROR',
} as const;

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
          unitId: driverFavoriteStations.unitId,
          unitName: stationUnits.name,
          evseCount: sql<number>`${sql.raw(inServiceEvseCountSql('charging_stations', 'driver_favorite_stations.unit_id'))}`,
          availableCount: sql<number>`${sql.raw(availableEvseCountSql('charging_stations', 'driver_favorite_stations.unit_id'))}`,
          createdAt: driverFavoriteStations.createdAt,
        })
        .from(driverFavoriteStations)
        .innerJoin(chargingStations, eq(driverFavoriteStations.stationId, chargingStations.id))
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .leftJoin(stationUnits, eq(stationUnits.id, driverFavoriteStations.unitId))
        // A conformance (OCTT) station is never listed to a driver.
        .where(and(eq(driverFavoriteStations.driverId, driverId), isOperatorStation()))
        .orderBy(desc(driverFavoriteStations.createdAt), desc(driverFavoriteStations.id));

      // Batch fetch EVSE counts
      return rows.map((r) => {
        return {
          id: r.id,
          stationId: r.stationOcppId,
          unitId: r.unitId,
          unitName: r.unitName,
          siteName: r.siteName,
          siteAddress: r.siteAddress,
          siteCity: r.siteCity,
          siteState: r.siteState,
          isOnline: r.isOnline,
          evseCount: r.evseCount,
          availableCount: r.availableCount,
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
        querystring: zodSchema(checkUnitQuery),
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
              .loose(),
          ),
        },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { stationId } = request.params as z.infer<typeof checkFavoriteParams>;
      const { unitId } = request.query as z.infer<typeof checkUnitQuery>;

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
            sameUnit(driverFavoriteStations.unitId, unitId ?? null),
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
              .loose(),
          ),
          400: errorWith('The unit is not a unit of this station', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
          409: errorWith('Already favorited', [ERROR_CODES.ALREADY_FAVORITED]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { stationId, unitId } = request.body as z.infer<typeof addFavoriteBody>;

      // Resolve OCPP station ID to UUID
      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(and(eq(chargingStations.stationId, stationId), publicStationServed()));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      if (unitId != null && !(await unitOfStation(station.id, unitId))) {
        await reply.status(400).send(UNIT_NOT_OF_STATION);
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
            sameUnit(driverFavoriteStations.unitId, unitId ?? null),
          ),
        );

      if (existing != null) {
        await reply.status(409).send({ error: 'Already favorited', code: 'ALREADY_FAVORITED' });
        return;
      }

      const [row] = await db
        .insert(driverFavoriteStations)
        .values({ driverId, stationId: station.id, unitId: unitId ?? null })
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
