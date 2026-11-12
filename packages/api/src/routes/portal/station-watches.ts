// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, sql, isNull } from 'drizzle-orm';
import { db, availableEvseCountSql, inServiceEvseCountSql } from '@evtivity/database';
import {
  stationWatches,
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

// Bound the number of active watches a single driver can hold so a runaway
// client cannot accumulate unbounded rows.
const MAX_WATCHES_PER_DRIVER = 25;

const watchItem = z
  .object({
    id: z.number().int().min(1).describe('Watch record ID'),
    stationId: z.string().max(255).describe('OCPP station identity'),
    unitId: z
      .string()
      .nullable()
      .describe('The unit (charger box) watched, null for the whole station'),
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
    createdAt: z.coerce.date().describe('Timestamp when the watch was created'),
    expiresAt: z.coerce.date().describe('Timestamp when the watch auto-expires'),
  })
  .loose();

const addWatchBody = z.object({
  stationId: z.string().min(1).max(255).describe('OCPP station identifier'),
  unitId: ID_PARAMS.unitId
    .optional()
    .describe('A unit (charger box) of that station; omitted for the whole station'),
});

const removeWatchParams = z.object({
  id: z.coerce.number().int().min(1).describe('Watch record ID'),
});

const checkWatchParams = z.object({
  stationId: z.string().min(1).describe('OCPP station identifier'),
});

const checkUnitQuery = z.object({
  unitId: ID_PARAMS.unitId
    .optional()
    .describe('Check one unit (charger box) of the station; omitted for the whole station'),
});

// The row of the whole station (null unit) or of one unit: unit ids compare
// as values, and a null unit matches only a null unit.
function sameUnit(column: typeof stationWatches.unitId, unitId: string | null) {
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
          unitId: stationWatches.unitId,
          unitName: stationUnits.name,
          evseCount: sql<number>`${sql.raw(inServiceEvseCountSql('charging_stations', 'station_watches.unit_id'))}`,
          availableCount: sql<number>`${sql.raw(availableEvseCountSql('charging_stations', 'station_watches.unit_id'))}`,
          createdAt: stationWatches.createdAt,
          expiresAt: stationWatches.expiresAt,
        })
        .from(stationWatches)
        .innerJoin(chargingStations, eq(stationWatches.stationId, chargingStations.id))
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .leftJoin(stationUnits, eq(stationUnits.id, stationWatches.unitId))
        // A conformance (OCTT) station is never listed to a driver.
        .where(and(eq(stationWatches.driverId, driverId), isOperatorStation()))
        .orderBy(desc(stationWatches.createdAt), desc(stationWatches.id));

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
        querystring: zodSchema(checkUnitQuery),
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
              .loose(),
          ),
        },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { stationId } = request.params as z.infer<typeof checkWatchParams>;
      const { unitId } = request.query as z.infer<typeof checkUnitQuery>;

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
            sameUnit(stationWatches.unitId, unitId ?? null),
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
            z.object({ id: z.number().int().min(1).describe('Watch record ID') }).loose(),
          ),
          400: errorWith('The unit is not a unit of this station', [ERROR_CODES.VALIDATION_ERROR]),
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
      const { stationId, unitId } = request.body as z.infer<typeof addWatchBody>;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(and(eq(chargingStations.stationId, stationId), publicStationServed()));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Already-free stations have nothing to wait for. A disabled, offline or
      // maintained station is not free, even when its connectors report Available.
      if (unitId != null && !(await unitOfStation(station.id, unitId))) {
        await reply.status(400).send(UNIT_NOT_OF_STATION);
        return;
      }

      // A unit watch counts only the EVSEs of that unit.
      const availRows =
        unitId == null
          ? await db
              .select({
                total: sql<number>`${sql.raw(availableEvseCountSql('charging_stations'))}`,
              })
              .from(chargingStations)
              .where(eq(chargingStations.id, station.id))
          : await db
              .select({
                total: sql<number>`${sql.raw(availableEvseCountSql('charging_stations', 'station_units.id'))}`,
              })
              .from(stationUnits)
              .innerJoin(chargingStations, eq(chargingStations.id, stationUnits.stationId))
              .where(eq(stationUnits.id, unitId));
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
            sameUnit(stationWatches.unitId, unitId ?? null),
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
        .values({ driverId, stationId: station.id, unitId: unitId ?? null })
        .onConflictDoUpdate({
          target: [stationWatches.driverId, stationWatches.stationId, stationWatches.unitId],
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
