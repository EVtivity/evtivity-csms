// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db, ocpiExternalLocations } from '@evtivity/database';
import { zodSchema } from '../../lib/zod-schema.js';
import { errorResponse, arrayResponse } from '../../lib/response-schemas.js';

const roamingChargerItem = z
  .object({
    id: z.number(),
    partnerId: z.string(),
    countryCode: z.string(),
    partyId: z.string(),
    locationId: z.string(),
    name: z.string().nullable(),
    address: z.string().nullable(),
    city: z.string().nullable(),
    latitude: z.string().nullable(),
    longitude: z.string().nullable(),
    evseCount: z.number(),
  })
  .passthrough();

const searchQuery = z.object({
  q: z.string().min(1).optional().describe('Text search by location name'),
  lat: z.coerce.number().optional().describe('Latitude for geo search'),
  lng: z.coerce.number().optional().describe('Longitude for geo search'),
  radius: z.coerce.number().min(1).default(50).describe('Search radius in km (default 50)'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Max results to return (default 20)'),
});

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
          // Text-based search by location name
          const pattern = `%${query.q}%`;
          rows = await db
            .select()
            .from(ocpiExternalLocations)
            .where(sql`${ocpiExternalLocations.name} ILIKE ${pattern}`)
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

          rows = await db
            .select()
            .from(ocpiExternalLocations)
            .where(
              sql`${ocpiExternalLocations.latitude} IS NOT NULL
                AND ${ocpiExternalLocations.longitude} IS NOT NULL
                AND CAST(${ocpiExternalLocations.latitude} AS double precision) BETWEEN ${minLat} AND ${maxLat}
                AND CAST(${ocpiExternalLocations.longitude} AS double precision) BETWEEN ${minLng} AND ${maxLng}`,
            )
            .limit(limit);
        } else {
          // Return recent locations
          rows = await db
            .select()
            .from(ocpiExternalLocations)
            .orderBy(sql`${ocpiExternalLocations.updatedAt} DESC`)
            .limit(limit);
        }
      } catch {
        // OCPI tables may not exist when roaming is disabled
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
        response: { 404: errorResponse, 501: errorResponse },
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
      } catch {
        // OCPI tables may not exist when roaming is disabled
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
