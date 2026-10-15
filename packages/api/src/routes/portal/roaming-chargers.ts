// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db, ocpiExternalLocations, ocpiPartners } from '@evtivity/database';
import { zodSchema } from '../../lib/zod-schema.js';
import { arrayResponse, errorWith } from '../../lib/response-schemas.js';
import { ERROR_CODES } from '../../lib/error-codes.generated.js';

const roamingChargerItem = z
  .object({
    id: z.number().int().min(1).describe('Internal record ID for the cached external location'),
    partnerId: z.string().describe('OCPI partner identifier'),
    countryCode: z.string().length(2).describe('ISO 3166-1 alpha-2 country code'),
    partyId: z.string().max(3).describe('OCPI party id (3-char)'),
    locationId: z.string().max(36).describe('OCPI location_id assigned by the partner CPO'),
    name: z.string().max(255).nullable().describe('Location display name'),
    address: z.string().max(500).nullable().describe('Street address'),
    city: z.string().max(100).nullable().describe('City'),
    latitude: z.string().nullable().describe('Latitude in decimal degrees (string)'),
    longitude: z.string().nullable().describe('Longitude in decimal degrees (string)'),
    evseCount: z.number().int().min(0).describe('Number of EVSEs at this roaming location'),
  })
  .passthrough();

const searchQuery = z.object({
  q: z.string().min(1).max(255).optional().describe('Text search by location name'),
  lat: z.coerce.number().min(-90).max(90).optional().describe('Latitude for geo search'),
  lng: z.coerce.number().min(-180).max(180).optional().describe('Longitude for geo search'),
  radius: z.coerce
    .number()
    .min(1)
    .max(500)
    .default(50)
    .describe('Search radius in km (default 50)'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Max results to return (default 20)'),
});

// OCPI GeoLocation patterns (OCPI 2.3.0 8.4.16). The stored values come from
// partners; a value that does not match is never cast, so one malformed row
// cannot fail the geo search.
const LATITUDE_SQL_PATTERN = '^-?[0-9]{1,2}\\.[0-9]{5,7}$';
const LONGITUDE_SQL_PATTERN = '^-?[0-9]{1,3}\\.[0-9]{5,7}$';

/** Escape the ILIKE wildcards and the escape character itself (backslash). */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Locations drivers may see: from a connected partner, and not marked
// publish = false by the CPO (OCPI 8.3.1: such a location is shown only to
// the drivers of the listed publish_allowed_to tokens, which the portal
// cannot match).
const visibleLocation: SQL = and(
  eq(ocpiPartners.status, 'connected'),
  sql`(${ocpiExternalLocations.locationData} ->> 'publish') IS DISTINCT FROM 'false'`,
) as SQL;

function visibleLocations() {
  return db
    .select(getTableColumns(ocpiExternalLocations))
    .from(ocpiExternalLocations)
    .innerJoin(ocpiPartners, eq(ocpiPartners.id, ocpiExternalLocations.partnerId));
}

interface RoamingChargerResult {
  id: number;
  partnerId: string;
  countryCode: string;
  partyId: string;
  locationId: string;
  name: string | null;
  address: string | null;
  city: string | null;
  latitude: string | null;
  longitude: string | null;
  evseCount: number;
}

export function portalRoamingChargerRoutes(app: FastifyInstance): void {
  // GET /portal/chargers/roaming - search external (partner network) locations
  app.get(
    '/portal/chargers/roaming',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Roaming'],
        summary: 'Search roaming chargers from partner networks',
        operationId: 'portalSearchRoamingChargers',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(searchQuery),
        response: { 200: arrayResponse(roamingChargerItem) },
      },
    },
    async (request) => {
      const query = request.query as z.infer<typeof searchQuery>;
      const limit = query.limit;

      let rows;

      try {
        if (query.q != null && query.q.length >= 2) {
          // Text-based search by location name; the driver's text is matched
          // literally (% and _ are not wildcards).
          const pattern = `%${escapeLikePattern(query.q)}%`;
          rows = await visibleLocations()
            .where(and(visibleLocation, sql`${ocpiExternalLocations.name} ILIKE ${pattern}`))
            .limit(limit);
        } else if (query.lat != null && query.lng != null) {
          // Geo-based search using approximate distance (Haversine simplified)
          const lat = query.lat;
          const lng = query.lng;
          const radiusKm = query.radius;

          // Filter by bounding box first, then sort by approximate distance
          const latDelta = radiusKm / 111.0;
          const lngDelta = radiusKm / (111.0 * Math.cos((lat * Math.PI) / 180));

          const minLat = lat - latDelta;
          const maxLat = lat + latDelta;
          const minLng = lng - lngDelta;
          const maxLng = lng + lngDelta;

          // CASE casts only values that match the OCPI pattern (PostgreSQL does
          // not promise to evaluate AND conditions left to right).
          rows = await visibleLocations()
            .where(
              and(
                visibleLocation,
                sql`CASE WHEN ${ocpiExternalLocations.latitude} ~ ${LATITUDE_SQL_PATTERN}
                  THEN CAST(${ocpiExternalLocations.latitude} AS double precision) END
                  BETWEEN ${minLat} AND ${maxLat}`,
                sql`CASE WHEN ${ocpiExternalLocations.longitude} ~ ${LONGITUDE_SQL_PATTERN}
                  THEN CAST(${ocpiExternalLocations.longitude} AS double precision) END
                  BETWEEN ${minLng} AND ${maxLng}`,
              ),
            )
            .limit(limit);
        } else {
          // Return recent locations
          rows = await visibleLocations()
            .where(visibleLocation)
            .orderBy(sql`${ocpiExternalLocations.updatedAt} DESC`)
            .limit(limit);
        }
      } catch (err) {
        request.log.warn({ err }, 'Roaming location search failed, returning no results');
        return [];
      }

      const results: RoamingChargerResult[] = rows.map((row) => {
        const locationData = row.locationData as Record<string, unknown>;
        return {
          id: row.id,
          partnerId: row.partnerId,
          countryCode: row.countryCode,
          partyId: row.partyId,
          locationId: row.locationId,
          name: row.name,
          address: (locationData['address'] as string | null) ?? null,
          city: (locationData['city'] as string | null) ?? null,
          latitude: row.latitude,
          longitude: row.longitude,
          evseCount: Number(row.evseCount),
        };
      });

      return results;
    },
  );

  // POST /portal/chargers/roaming/start - initiate remote start on external station
  app.post(
    '/portal/chargers/roaming/start',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Roaming'],
        summary: 'Start a remote charging session on an external station',
        operationId: 'portalStartRoamingSession',
        security: [{ bearerAuth: [] }],
        body: zodSchema(
          z.object({
            locationId: z.string().describe('External location UUID'),
            evseUid: z.string().optional().describe('OCPI EVSE UID'),
            connectorId: z.string().optional().describe('OCPI connector ID'),
          }),
        ),
        response: {
          404: errorWith('Location not found', [ERROR_CODES.LOCATION_NOT_FOUND]),
          501: errorWith('Not implemented', [ERROR_CODES.NOT_IMPLEMENTED]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        locationId: string;
        evseUid?: string;
        connectorId?: string;
      };

      // Look up the external location
      let location;
      try {
        [location] = await db
          .select()
          .from(ocpiExternalLocations)
          .where(sql`${ocpiExternalLocations.id} = ${body.locationId}`)
          .limit(1);
      } catch (err) {
        request.log.warn(
          { err, locationId: body.locationId },
          'Roaming location lookup failed, answering not found',
        );
      }

      if (location == null) {
        await reply.status(404).send({
          error: 'Location not found',
          code: 'LOCATION_NOT_FOUND',
        });
        return;
      }

      // Remote start on external stations requires OCPI Commands module (Phase 4)
      // For now, return a message indicating the feature is pending
      await reply.status(501).send({
        error: 'Remote start on partner networks requires the OCPI Commands module',
        code: 'NOT_IMPLEMENTED',
      });
    },
  );
}
