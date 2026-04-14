// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, or, ilike, desc, asc, sql, gte, count, inArray } from 'drizzle-orm';
import { db, client } from '@evtivity/database';
import {
  chargingStations,
  evses,
  connectors,
  sites,
  chargingSessions,
  driverPaymentMethods,
  reservations,
  stationImages,
  settings,
} from '@evtivity/database';
import { zodSchema } from '../../lib/zod-schema.js';
import { ID_PARAMS } from '../../lib/id-validation.js';
import { getPubSub } from '../../lib/pubsub.js';
import { errorResponse, itemResponse, arrayResponse } from '../../lib/response-schemas.js';
import { getS3Config, generateDownloadUrl } from '../../services/s3.service.js';
import { sendOcppCommandAndWait, triggerAndWaitForStatus } from '../../lib/ocpp-command.js';
import { isStationCheckRateLimited } from '../../lib/rate-limiters.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';
import { getStripeConfig } from '../../services/stripe.service.js';
import { resolveTariff, isTariffFree } from '../../services/tariff.service.js';
import { dispatchDriverNotification } from '@evtivity/lib';
import { ALL_TEMPLATES_DIRS } from '../../lib/template-dirs.js';
import { isEvseInReservationBuffer } from '../../lib/reservation-buffer.js';

const portalConnectorItem = z
  .object({
    connectorId: z.number(),
    connectorType: z.string().nullable(),
    maxPowerKw: z.number().nullable(),
    maxCurrentAmps: z.number().nullable(),
    status: z.string(),
  })
  .passthrough();

const portalChargerDetail = z
  .object({
    stationId: z.string(),
    siteId: z.string().nullable(),
    model: z.string().nullable(),
    isOnline: z.boolean(),
    siteName: z.string().nullable(),
    siteAddress: z.string().nullable(),
    siteCity: z.string().nullable(),
    siteState: z.string().nullable(),
    paymentEnabled: z.boolean(),
    evse: z.object({
      evseId: z.number(),
      connectors: z.array(portalConnectorItem),
      reservationExpiresAt: z.string().nullable(),
    }),
  })
  .passthrough();

const portalEvseItem = z
  .object({
    evseId: z.number(),
    connectors: z.array(portalConnectorItem),
    reservationExpiresAt: z.string().nullable(),
  })
  .passthrough();

const portalStationDetail = z
  .object({
    stationId: z.string(),
    siteId: z.string().nullable(),
    model: z.string().nullable(),
    isOnline: z.boolean(),
    siteName: z.string().nullable(),
    siteAddress: z.string().nullable(),
    siteCity: z.string().nullable(),
    siteState: z.string().nullable(),
    siteContactName: z.string().nullable(),
    siteContactEmail: z.string().nullable(),
    siteContactPhone: z.string().nullable(),
    paymentEnabled: z.boolean(),
    evses: z.array(portalEvseItem),
  })
  .passthrough();

const portalConnectorSummary = z
  .object({
    connectorType: z.string().nullable(),
    maxPowerKw: z.number().nullable(),
    maxCurrentAmps: z.number().nullable(),
    status: z.string(),
  })
  .passthrough();

const portalChargerSearch = z
  .object({
    stationId: z.string(),
    model: z.string().nullable(),
    isOnline: z.boolean(),
    siteName: z.string().nullable(),
    evseCount: z.number(),
    availableCount: z.number(),
    connectors: z.array(portalConnectorSummary),
  })
  .passthrough();

const startChargingResponse = z.object({ chargingSessionId: z.string() }).passthrough();

const activeSessionItem = z
  .object({
    id: z.string(),
    stationId: z.string().nullable(),
    transactionId: z.string().nullable(),
    startedAt: z.coerce.date(),
    energyDeliveredWh: z.coerce.number().nullable(),
    currentCostCents: z.number().nullable(),
    currency: z.string().nullable(),
  })
  .passthrough();

const stopSessionResponse = z
  .object({ status: z.string(), chargingSessionId: z.string() })
  .passthrough();

const reservationItem = z
  .object({
    id: z.string(),
    reservationId: z.number(),
    stationOcppId: z.string(),
    status: z.string(),
    expiresAt: z.coerce.date(),
    createdAt: z.coerce.date(),
  })
  .passthrough();

const reservationCreated = z
  .object({
    id: z.string(),
    reservationId: z.number(),
    stationId: z.string(),
    driverId: z.string().nullable(),
    status: z.string(),
    expiresAt: z.coerce.date(),
    createdAt: z.coerce.date(),
  })
  .passthrough();

const cancelReservationResponse = z.object({ status: z.literal('cancelled') }).passthrough();

const sessionIdParams = z.object({
  sessionId: ID_PARAMS.sessionId.describe('Charging session ID'),
});

const reservationIdParams = z.object({
  id: ID_PARAMS.reservationId.describe('Reservation ID'),
});

const createDriverReservationBody = z.object({
  stationId: z.string().describe('OCPP station identifier'),
  evseId: z.coerce.number().int().optional().describe('EVSE ID on the station'),
  expiresAt: z.string().datetime().describe('ISO 8601 reservation expiration time'),
  startsAt: z
    .string()
    .datetime()
    .optional()
    .describe('ISO 8601 start date-time for delayed scheduling'),
});

const chargerParams = z.object({
  stationId: z.string().describe('OCPP station identifier'),
  evseId: z.coerce.number().int().describe('EVSE ID on the station'),
});

const stationIdParams = z.object({
  stationId: z.string().describe('OCPP station identifier'),
});

const portalPricingInfo = z
  .object({
    currency: z.string(),
    pricePerKwh: z.string().nullable(),
    pricePerMinute: z.string().nullable(),
    pricePerSession: z.string().nullable(),
    idleFeePricePerMinute: z.string().nullable(),
    taxRate: z.string().nullable(),
  })
  .passthrough();

const searchQuery = z.object({
  q: z.string().min(1),
});

const nearbyQuery = z.object({
  lat: z.coerce.number().min(-90).max(90).describe('Latitude'),
  lng: z.coerce.number().min(-180).max(180).describe('Longitude'),
  radius: z.coerce.number().min(1).max(200).default(50).describe('Radius in km (default 50)'),
  limit: z.coerce.number().int().min(1).max(50).default(20).describe('Max results (default 20)'),
});

const portalNearbyStation = z
  .object({
    stationId: z.string(),
    model: z.string().nullable(),
    isOnline: z.boolean(),
    siteName: z.string().nullable(),
    siteAddress: z.string().nullable(),
    siteCity: z.string().nullable(),
    distanceKm: z.number(),
    evseCount: z.number(),
    availableCount: z.number(),
    connectors: z.array(portalConnectorSummary),
  })
  .passthrough();

const startChargingBody = z.object({
  paymentMethodId: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Driver payment method ID, required when payment is enabled'),
});

export function portalChargerRoutes(app: FastifyInstance): void {
  app.get(
    '/portal/chargers/:stationId/evse/:evseId',
    {
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Get charger and EVSE details',
        operationId: 'portalGetChargerEvse',
        security: [],
        params: zodSchema(chargerParams),
        response: { 200: itemResponse(portalChargerDetail), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const params = request.params as z.infer<typeof chargerParams>;

      const [station] = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          model: chargingStations.model,
          isOnline: chargingStations.isOnline,
          isSimulator: chargingStations.isSimulator,
          siteName: sites.name,
          siteAddress: sites.address,
          siteCity: sites.city,
          siteState: sites.state,
        })
        .from(chargingStations)
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(eq(chargingStations.stationId, params.stationId));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const [evse] = await db
        .select({
          id: evses.id,
          evseId: evses.evseId,
        })
        .from(evses)
        .where(and(eq(evses.stationId, station.id), eq(evses.evseId, params.evseId)));

      if (evse == null) {
        await reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
        return;
      }

      const evseConnectors = await db
        .select({
          connectorId: connectors.connectorId,
          connectorType: connectors.connectorType,
          maxPowerKw: connectors.maxPowerKw,
          maxCurrentAmps: connectors.maxCurrentAmps,
          status: connectors.status,
        })
        .from(connectors)
        .where(eq(connectors.evseId, evse.id));

      // Look up reservation expiry when any connector is reserved
      const hasReservedConnector = evseConnectors.some((c) => c.status === 'reserved');
      let reservationExpiresAt: string | null = null;
      if (hasReservedConnector) {
        const [reservation] = await db
          .select({ expiresAt: reservations.expiresAt })
          .from(reservations)
          .where(
            and(
              eq(reservations.stationId, station.id),
              or(eq(reservations.evseId, evse.id), sql`${reservations.evseId} IS NULL`),
              eq(reservations.status, 'active'),
            ),
          )
          .orderBy(asc(reservations.expiresAt))
          .limit(1);
        if (reservation != null) {
          reservationExpiresAt = reservation.expiresAt.toISOString();
        }
      }

      const config = await getStripeConfig(station.siteId ?? null);

      return {
        stationId: station.stationId,
        siteId: station.siteId ?? null,
        model: station.model,
        isOnline: station.isOnline,
        isSimulator: station.isSimulator,
        siteName: station.siteName,
        siteAddress: station.siteAddress,
        siteCity: station.siteCity,
        siteState: station.siteState,
        paymentEnabled: config != null,
        evse: {
          evseId: evse.evseId,
          connectors: evseConnectors,
          reservationExpiresAt,
        },
      };
    },
  );

  app.get(
    '/portal/chargers/:stationId/pricing',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Get resolved pricing for a charger',
        operationId: 'portalGetChargerPricing',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationIdParams),
        response: {
          200: itemResponse(portalPricingInfo),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { stationId } = request.params as z.infer<typeof stationIdParams>;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.stationId, stationId));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const tariff = await resolveTariff(station.id, driverId);
      if (tariff == null) {
        await reply.status(404).send({ error: 'No pricing found', code: 'PRICING_NOT_FOUND' });
        return;
      }

      return {
        currency: tariff.currency,
        pricePerKwh: tariff.pricePerKwh,
        pricePerMinute: tariff.pricePerMinute,
        pricePerSession: tariff.pricePerSession,
        idleFeePricePerMinute: tariff.idleFeePricePerMinute,
        taxRate: tariff.taxRate,
      };
    },
  );

  app.get(
    '/portal/chargers/search',
    {
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Search chargers by station ID or site name',
        operationId: 'portalSearchChargers',
        security: [],
        querystring: zodSchema(searchQuery),
        response: { 200: arrayResponse(portalChargerSearch) },
      },
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
        },
      },
    },
    async (request) => {
      const { q } = request.query as z.infer<typeof searchQuery>;
      const pattern = `%${q}%`;

      const rows = await db
        .select({
          stationId: chargingStations.stationId,
          stationUuid: chargingStations.id,
          model: chargingStations.model,
          isOnline: chargingStations.isOnline,
          siteName: sites.name,
          evseCount: sql<number>`(SELECT count(*)::int FROM evses WHERE evses.station_id = ${chargingStations.id})`,
          availableCount: sql<number>`(SELECT count(*)::int FROM connectors c JOIN evses e ON c.evse_id = e.id WHERE e.station_id = ${chargingStations.id} AND c.status = 'available')`,
        })
        .from(chargingStations)
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(or(ilike(chargingStations.stationId, pattern), ilike(sites.name, pattern)))
        .limit(20);

      const stationUuids = rows.map((r) => r.stationUuid);
      const connectorRows =
        stationUuids.length > 0
          ? await db
              .select({
                stationId: evses.stationId,
                connectorType: connectors.connectorType,
                maxPowerKw: connectors.maxPowerKw,
                maxCurrentAmps: connectors.maxCurrentAmps,
                status: connectors.status,
              })
              .from(connectors)
              .innerJoin(evses, eq(connectors.evseId, evses.id))
              .where(sql`${evses.stationId} IN ${stationUuids}`)
          : [];

      const connectorsByStation = new Map<string, typeof connectorRows>();
      for (const c of connectorRows) {
        const list = connectorsByStation.get(c.stationId) ?? [];
        list.push(c);
        connectorsByStation.set(c.stationId, list);
      }

      return rows.map((r) => ({
        stationId: r.stationId,
        model: r.model,
        isOnline: r.isOnline,
        siteName: r.siteName,
        evseCount: r.evseCount,
        availableCount: r.availableCount,
        connectors: (connectorsByStation.get(r.stationUuid) ?? []).map((c) => ({
          connectorType: c.connectorType,
          maxPowerKw: c.maxPowerKw,
          maxCurrentAmps: c.maxCurrentAmps,
          status: c.status,
        })),
      }));
    },
  );

  app.get(
    '/portal/chargers/nearby',
    {
      schema: {
        tags: ['Portal Chargers'],
        summary: 'List nearby chargers by coordinates',
        operationId: 'portalListNearbyChargers',
        security: [],
        querystring: zodSchema(nearbyQuery),
        response: { 200: arrayResponse(portalNearbyStation) },
      },
    },
    async (request) => {
      const { lat, lng, radius, limit } = request.query as z.infer<typeof nearbyQuery>;

      // Use station-level coordinates when available, fall back to site
      const latExpr = sql`COALESCE(${chargingStations.latitude}, ${sites.latitude})`;
      const lngExpr = sql`COALESCE(${chargingStations.longitude}, ${sites.longitude})`;

      // Haversine distance in km
      const distanceExpr = sql<number>`(
        6371 * acos(
          LEAST(1.0, GREATEST(-1.0,
            cos(radians(${lat})) * cos(radians(CAST(${latExpr} AS double precision)))
            * cos(radians(CAST(${lngExpr} AS double precision)) - radians(${lng}))
            + sin(radians(${lat})) * sin(radians(CAST(${latExpr} AS double precision)))
          ))
        )
      )`;

      const rows = await db
        .select({
          stationId: chargingStations.stationId,
          stationUuid: chargingStations.id,
          model: chargingStations.model,
          isOnline: chargingStations.isOnline,
          siteName: sites.name,
          siteAddress: sites.address,
          siteCity: sites.city,
          distanceKm: distanceExpr,
          evseCount: sql<number>`(SELECT count(*)::int FROM evses WHERE evses.station_id = ${chargingStations.id})`,
          availableCount: sql<number>`(SELECT count(*)::int FROM connectors c JOIN evses e ON c.evse_id = e.id WHERE e.station_id = ${chargingStations.id} AND c.status = 'available')`,
        })
        .from(chargingStations)
        .innerJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(
          and(
            sql`COALESCE(${chargingStations.latitude}, ${sites.latitude}) IS NOT NULL`,
            sql`COALESCE(${chargingStations.longitude}, ${sites.longitude}) IS NOT NULL`,
            sql`${distanceExpr} <= ${radius}`,
          ),
        )
        .orderBy(sql`${distanceExpr}`)
        .limit(limit);

      const stationUuids = rows.map((r) => r.stationUuid);
      const connectorRows =
        stationUuids.length > 0
          ? await db
              .select({
                stationId: evses.stationId,
                connectorType: connectors.connectorType,
                maxPowerKw: connectors.maxPowerKw,
                maxCurrentAmps: connectors.maxCurrentAmps,
                status: connectors.status,
              })
              .from(connectors)
              .innerJoin(evses, eq(connectors.evseId, evses.id))
              .where(sql`${evses.stationId} IN ${stationUuids}`)
          : [];

      const connectorsByStation = new Map<string, typeof connectorRows>();
      for (const c of connectorRows) {
        const list = connectorsByStation.get(c.stationId) ?? [];
        list.push(c);
        connectorsByStation.set(c.stationId, list);
      }

      return rows.map((r) => ({
        stationId: r.stationId,
        model: r.model,
        isOnline: r.isOnline,
        siteName: r.siteName,
        siteAddress: r.siteAddress,
        siteCity: r.siteCity,
        distanceKm: Math.round(r.distanceKm * 10) / 10,
        evseCount: r.evseCount,
        availableCount: r.availableCount,
        connectors: (connectorsByStation.get(r.stationUuid) ?? []).map((c) => ({
          connectorType: c.connectorType,
          maxPowerKw: c.maxPowerKw,
          maxCurrentAmps: c.maxCurrentAmps,
          status: c.status,
        })),
      }));
    },
  );

  // --- Map config endpoint (registered before /:stationId to avoid route conflicts) ---

  const mapConfigResponse = z
    .object({
      apiKey: z.string(),
      defaultLat: z.number(),
      defaultLng: z.number(),
      defaultZoom: z.number(),
    })
    .passthrough();

  app.get(
    '/portal/chargers/map-config',
    {
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Get Google Maps configuration',
        operationId: 'portalGetMapConfig',
        security: [],
        response: { 200: itemResponse(mapConfigResponse) },
      },
    },
    async () => {
      const rows = await db
        .select({ key: settings.key, value: settings.value })
        .from(settings)
        .where(
          inArray(settings.key, [
            'googleMaps.apiKey',
            'googleMaps.defaultLat',
            'googleMaps.defaultLng',
            'googleMaps.defaultZoom',
          ]),
        );

      const map = new Map(rows.map((r) => [r.key, r.value as string]));

      return {
        apiKey: map.get('googleMaps.apiKey') ?? '',
        defaultLat: Number(map.get('googleMaps.defaultLat') ?? '37.7749'),
        defaultLng: Number(map.get('googleMaps.defaultLng') ?? '-122.4194'),
        defaultZoom: Number(map.get('googleMaps.defaultZoom') ?? '12'),
      };
    },
  );

  // --- Location detail endpoints (registered before /:stationId to avoid route conflicts) ---

  const siteIdParams = z.object({
    siteId: z.string().describe('Site ID'),
  });

  const portalLocationDetail = z
    .object({
      siteId: z.string(),
      name: z.string().nullable(),
      address: z.string().nullable(),
      city: z.string().nullable(),
      state: z.string().nullable(),
      postalCode: z.string().nullable(),
      latitude: z.string().nullable(),
      longitude: z.string().nullable(),
      hoursOfOperation: z.string().nullable(),
      contactName: z.string().nullable(),
      contactEmail: z.string().nullable(),
      contactPhone: z.string().nullable(),
      stationCount: z.number(),
      evseCount: z.number(),
      availableCount: z.number(),
    })
    .passthrough();

  const portalLocationImage = z
    .object({
      id: z.number(),
      stationId: z.string(),
      fileName: z.string(),
      fileSize: z.number(),
      contentType: z.string(),
      caption: z.string().nullable(),
    })
    .passthrough();

  const popularTimesQuery = z.object({
    weeks: z.coerce
      .number()
      .int()
      .min(1)
      .max(52)
      .default(4)
      .describe('Number of weeks to average over'),
  });

  const popularTimesItem = z
    .object({ dow: z.number(), hour: z.number(), avgSessions: z.number() })
    .passthrough();

  const imageIdParams = z.object({
    siteId: z.string().describe('Site ID'),
    imageId: z.coerce.number().int().describe('Image ID'),
  });

  app.get(
    '/portal/chargers/location/:siteId',
    {
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Get location detail for a site',
        operationId: 'portalGetLocationDetail',
        security: [],
        params: zodSchema(siteIdParams),
        response: { 200: itemResponse(portalLocationDetail), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { siteId } = request.params as z.infer<typeof siteIdParams>;

      const [site] = await db
        .select({
          id: sites.id,
          name: sites.name,
          address: sites.address,
          city: sites.city,
          state: sites.state,
          postalCode: sites.postalCode,
          latitude: sites.latitude,
          longitude: sites.longitude,
          hoursOfOperation: sites.hoursOfOperation,
          contactName: sites.contactName,
          contactEmail: sites.contactEmail,
          contactPhone: sites.contactPhone,
          contactIsPublic: sites.contactIsPublic,
        })
        .from(sites)
        .where(eq(sites.id, siteId));

      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const [counts] = await db
        .select({
          stationCount: sql<number>`count(DISTINCT ${chargingStations.id})::int`,
          evseCount: sql<number>`count(DISTINCT ${evses.id})::int`,
          availableCount: sql<number>`count(DISTINCT CASE WHEN ${connectors.status} = 'available' THEN ${connectors.id} END)::int`,
        })
        .from(chargingStations)
        .leftJoin(evses, eq(evses.stationId, chargingStations.id))
        .leftJoin(connectors, eq(connectors.evseId, evses.id))
        .where(eq(chargingStations.siteId, siteId));

      const isContactPublic = site.contactIsPublic;

      return {
        siteId: site.id,
        name: site.name,
        address: site.address,
        city: site.city,
        state: site.state,
        postalCode: site.postalCode,
        latitude: site.latitude,
        longitude: site.longitude,
        hoursOfOperation: site.hoursOfOperation,
        contactName: isContactPublic ? site.contactName : null,
        contactEmail: isContactPublic ? site.contactEmail : null,
        contactPhone: isContactPublic ? site.contactPhone : null,
        stationCount: counts?.stationCount ?? 0,
        evseCount: counts?.evseCount ?? 0,
        availableCount: counts?.availableCount ?? 0,
      };
    },
  );

  app.get(
    '/portal/chargers/location/:siteId/images',
    {
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Get driver-visible images for a site',
        operationId: 'portalGetLocationImages',
        security: [],
        params: zodSchema(siteIdParams),
        response: { 200: arrayResponse(portalLocationImage) },
      },
    },
    async (request) => {
      const { siteId } = request.params as z.infer<typeof siteIdParams>;

      const images = await db
        .select({
          id: stationImages.id,
          stationId: stationImages.stationId,
          fileName: stationImages.fileName,
          fileSize: stationImages.fileSize,
          contentType: stationImages.contentType,
          caption: stationImages.caption,
        })
        .from(stationImages)
        .innerJoin(chargingStations, eq(stationImages.stationId, chargingStations.id))
        .where(and(eq(chargingStations.siteId, siteId), eq(stationImages.isDriverVisible, true)))
        .orderBy(asc(stationImages.sortOrder), asc(stationImages.id));

      return images;
    },
  );

  app.get(
    '/portal/chargers/location/:siteId/images/:imageId/download-url',
    {
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Get presigned download URL for a driver-visible image',
        operationId: 'portalGetLocationImageDownloadUrl',
        security: [],
        params: zodSchema(imageIdParams),
        response: {
          200: itemResponse(z.object({ downloadUrl: z.string() }).passthrough()),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { siteId, imageId } = request.params as z.infer<typeof imageIdParams>;

      const [image] = await db
        .select({
          id: stationImages.id,
          s3Key: stationImages.s3Key,
          s3Bucket: stationImages.s3Bucket,
          isDriverVisible: stationImages.isDriverVisible,
        })
        .from(stationImages)
        .innerJoin(chargingStations, eq(stationImages.stationId, chargingStations.id))
        .where(
          and(
            eq(stationImages.id, imageId),
            eq(chargingStations.siteId, siteId),
            eq(stationImages.isDriverVisible, true),
          ),
        );

      if (image == null) {
        await reply.status(404).send({ error: 'Image not found', code: 'IMAGE_NOT_FOUND' });
        return;
      }

      const s3 = await getS3Config();
      if (s3 == null) {
        await reply.status(404).send({ error: 'S3 not configured', code: 'S3_NOT_CONFIGURED' });
        return;
      }

      const downloadUrl = await generateDownloadUrl(s3, image.s3Bucket, image.s3Key);
      return { downloadUrl };
    },
  );

  app.get(
    '/portal/chargers/location/:siteId/popular-times',
    {
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Get popular times for a site',
        operationId: 'portalGetLocationPopularTimes',
        security: [],
        params: zodSchema(siteIdParams),
        querystring: zodSchema(popularTimesQuery),
        response: { 200: arrayResponse(popularTimesItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { siteId } = request.params as z.infer<typeof siteIdParams>;
      const { weeks } = request.query as z.infer<typeof popularTimesQuery>;

      const [site] = await db
        .select({ id: sites.id, timezone: sites.timezone })
        .from(sites)
        .where(eq(sites.id, siteId));

      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const tz = site.timezone;
      const since = new Date();
      since.setDate(since.getDate() - weeks * 7);

      const stationIds = db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.siteId, siteId));

      const rows = await db
        .select({
          dow: sql<number>`extract(dow from ${chargingSessions.startedAt} at time zone ${tz})::int`,
          hour: sql<number>`extract(hour from ${chargingSessions.startedAt} at time zone ${tz})::int`,
          totalSessions: count(),
        })
        .from(chargingSessions)
        .where(
          and(
            inArray(chargingSessions.stationId, stationIds),
            gte(chargingSessions.startedAt, since),
          ),
        )
        .groupBy(sql`1`, sql`2`)
        .orderBy(sql`1`, sql`2`);

      return rows.map((r) => ({
        dow: r.dow,
        hour: r.hour,
        avgSessions: Math.round((r.totalSessions / weeks) * 10) / 10,
      }));
    },
  );

  app.get(
    '/portal/chargers/:stationId',
    {
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Get station details with all EVSEs and connectors',
        operationId: 'portalGetStationDetail',
        security: [],
        params: zodSchema(stationIdParams),
        response: { 200: itemResponse(portalStationDetail), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { stationId } = request.params as z.infer<typeof stationIdParams>;

      const [station] = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          model: chargingStations.model,
          isOnline: chargingStations.isOnline,
          isSimulator: chargingStations.isSimulator,
          siteName: sites.name,
          siteAddress: sites.address,
          siteCity: sites.city,
          siteState: sites.state,
          siteContactName: sites.contactName,
          siteContactEmail: sites.contactEmail,
          siteContactPhone: sites.contactPhone,
          siteContactIsPublic: sites.contactIsPublic,
        })
        .from(chargingStations)
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(eq(chargingStations.stationId, stationId));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const evseRows = await db
        .select({
          id: evses.id,
          evseId: evses.evseId,
          connectorId: connectors.connectorId,
          connectorType: connectors.connectorType,
          maxPowerKw: connectors.maxPowerKw,
          maxCurrentAmps: connectors.maxCurrentAmps,
          connectorStatus: connectors.status,
        })
        .from(evses)
        .leftJoin(connectors, eq(connectors.evseId, evses.id))
        .where(eq(evses.stationId, station.id))
        .orderBy(asc(evses.evseId));

      const evseMap = new Map<
        number,
        {
          evseUuid: string;
          evseId: number;
          connectors: Array<{
            connectorId: number;
            connectorType: string | null;
            maxPowerKw: number | null;
            maxCurrentAmps: number | null;
            status: string;
          }>;
        }
      >();
      for (const row of evseRows) {
        if (!evseMap.has(row.evseId)) {
          evseMap.set(row.evseId, { evseUuid: row.id, evseId: row.evseId, connectors: [] });
        }
        if (row.connectorId != null) {
          const evseEntry = evseMap.get(row.evseId);
          evseEntry?.connectors.push({
            connectorId: row.connectorId,
            connectorType: row.connectorType,
            maxPowerKw: row.maxPowerKw != null ? Number(row.maxPowerKw) : null,
            maxCurrentAmps: row.maxCurrentAmps,
            status: row.connectorStatus ?? 'unavailable',
          });
        }
      }

      // Look up reservation expiry for EVSEs with reserved connectors
      const reservedEvseUuids = Array.from(evseMap.values())
        .filter((e) => e.connectors.some((c) => c.status === 'reserved'))
        .map((e) => e.evseUuid);

      const reservationExpiryMap = new Map<string, string>();
      if (reservedEvseUuids.length > 0) {
        const activeReservations = await db
          .select({
            evseId: reservations.evseId,
            expiresAt: reservations.expiresAt,
          })
          .from(reservations)
          .where(and(eq(reservations.stationId, station.id), eq(reservations.status, 'active')))
          .orderBy(asc(reservations.expiresAt));

        for (const res of activeReservations) {
          // Station-level reservation (no evseId) applies to all reserved EVSEs
          if (res.evseId == null) {
            for (const uuid of reservedEvseUuids) {
              if (!reservationExpiryMap.has(uuid)) {
                reservationExpiryMap.set(uuid, res.expiresAt.toISOString());
              }
            }
          } else if (reservedEvseUuids.includes(res.evseId)) {
            if (!reservationExpiryMap.has(res.evseId)) {
              reservationExpiryMap.set(res.evseId, res.expiresAt.toISOString());
            }
          }
        }
      }

      const config = await getStripeConfig(station.siteId ?? null);

      const isContactPublic = station.siteContactIsPublic === true;

      return {
        stationId: station.stationId,
        siteId: station.siteId ?? null,
        model: station.model,
        isOnline: station.isOnline,
        isSimulator: station.isSimulator,
        siteName: station.siteName,
        siteAddress: station.siteAddress,
        siteCity: station.siteCity,
        siteState: station.siteState,
        siteContactName: isContactPublic ? station.siteContactName : null,
        siteContactEmail: isContactPublic ? station.siteContactEmail : null,
        siteContactPhone: isContactPublic ? station.siteContactPhone : null,
        paymentEnabled: config != null,
        evses: Array.from(evseMap.values()).map((e) => ({
          evseId: e.evseId,
          connectors: e.connectors,
          reservationExpiresAt: reservationExpiryMap.get(e.evseUuid) ?? null,
        })),
      };
    },
  );

  app.post(
    '/portal/chargers/:stationId/evse/:evseId/check-status',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Check connector status via TriggerMessage',
        operationId: 'portalCheckConnectorStatus',
        security: [{ bearerAuth: [] }],
        params: zodSchema(chargerParams),
        response: {
          200: itemResponse(
            z
              .object({
                connectorStatus: z.string().nullable(),
                error: z.string().optional(),
              })
              .passthrough(),
          ),
          404: errorResponse,
          429: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { stationId, evseId } = request.params as z.infer<typeof chargerParams>;

      // Resolve station
      const [station] = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          isOnline: chargingStations.isOnline,
          ocppProtocol: chargingStations.ocppProtocol,
        })
        .from(chargingStations)
        .where(eq(chargingStations.stationId, stationId));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      if (!station.isOnline) {
        return { connectorStatus: null, error: 'Station is offline' };
      }

      // Rate limit per station
      if (isStationCheckRateLimited(stationId)) {
        await reply
          .status(429)
          .send({ error: 'Too many status checks for this station', code: 'RATE_LIMITED' });
        return;
      }

      // Find the first connector on this EVSE
      const connectorRows = await db.execute<{ connector_id: number }>(
        sql`SELECT c.connector_id FROM connectors c
            JOIN evses e ON c.evse_id = e.id
            WHERE e.station_id = ${station.id} AND e.evse_id = ${evseId}
            ORDER BY c.connector_id ASC LIMIT 1`,
      );
      const connectorRow = connectorRows[0];
      if (connectorRow == null) {
        await reply.status(404).send({ error: 'Connector not found', code: 'CONNECTOR_NOT_FOUND' });
        return;
      }
      const connectorId = connectorRow.connector_id;

      const result = await triggerAndWaitForStatus(
        stationId,
        evseId,
        connectorId,
        station.id,
        station.ocppProtocol ?? undefined,
      );

      return { connectorStatus: result.status, error: result.error };
    },
  );

  app.post(
    '/portal/chargers/:stationId/evse/:evseId/start',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Start a charging session on a charger EVSE',
        operationId: 'portalStartCharging',
        security: [{ bearerAuth: [] }],
        params: zodSchema(chargerParams),
        body: zodSchema(startChargingBody),
        response: {
          200: itemResponse(startChargingResponse),
          400: errorResponse,
          403: errorResponse,
          404: errorResponse,
          409: errorResponse,
          500: errorResponse,
          502: errorResponse,
          504: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const params = request.params as z.infer<typeof chargerParams>;
      const body = request.body as z.infer<typeof startChargingBody>;

      // Find station
      const [station] = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          isOnline: chargingStations.isOnline,
          ocppProtocol: chargingStations.ocppProtocol,
          availability: chargingStations.availability,
          onboardingStatus: chargingStations.onboardingStatus,
        })
        .from(chargingStations)
        .where(eq(chargingStations.stationId, params.stationId));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (station.onboardingStatus !== 'accepted') {
        const code = station.onboardingStatus === 'pending' ? 'STATION_PENDING' : 'STATION_BLOCKED';
        const msg =
          station.onboardingStatus === 'pending'
            ? 'Station is pending approval'
            : 'Station is blocked';
        await reply.status(403).send({ error: msg, code });
        return;
      }

      if (!station.isOnline) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      // Check EVSE availability via connector status
      const [evse] = await db
        .select({ id: evses.id })
        .from(evses)
        .where(and(eq(evses.stationId, station.id), eq(evses.evseId, params.evseId)));

      if (evse == null) {
        await reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
        return;
      }

      const [connector] = await db
        .select({ status: connectors.status })
        .from(connectors)
        .where(eq(connectors.evseId, evse.id))
        .limit(1);

      const startableStatuses = ['available', 'occupied', 'preparing', 'ev_connected'];
      if (connector != null && !startableStatuses.includes(connector.status)) {
        await reply.status(400).send({
          error: 'Connector is not available for charging',
          code: 'CONNECTOR_NOT_AVAILABLE',
        });
        return;
      }

      // Check for existing active session for this driver
      const [existingSession] = await db
        .select({ id: chargingSessions.id })
        .from(chargingSessions)
        .where(and(eq(chargingSessions.driverId, driverId), eq(chargingSessions.status, 'active')))
        .limit(1);

      if (existingSession != null) {
        await reply.status(400).send({
          error: 'You already have an active charging session',
          code: 'SESSION_ALREADY_ACTIVE',
        });
        return;
      }

      // Block start if the EVSE has an upcoming reservation within the buffer window
      const inBuffer = await isEvseInReservationBuffer(station.id, evse.id);
      if (inBuffer) {
        await reply.status(409).send({
          error: 'This connector has an upcoming reservation and cannot start a new session',
          code: 'RESERVATION_BUFFER_ACTIVE',
        });
        return;
      }

      // Get Stripe config to determine currency; pre-auth is handled by the payment gate
      const config = await getStripeConfig(station.siteId ?? null);

      if (config != null) {
        // Check if pricing is free for this driver
        const tariff = await resolveTariff(station.id, driverId);
        const chargingIsFree = isTariffFree(tariff);

        if (!chargingIsFree) {
          // Payment is required -- validate the driver has a payment method
          if (body.paymentMethodId == null) {
            await reply.status(400).send({
              error: 'Payment method required',
              code: 'PAYMENT_METHOD_REQUIRED',
            });
            return;
          }

          // Verify payment method belongs to driver
          const [pmRow] = await db
            .select({ id: driverPaymentMethods.id })
            .from(driverPaymentMethods)
            .where(
              and(
                eq(driverPaymentMethods.id, body.paymentMethodId),
                eq(driverPaymentMethods.driverId, driverId),
              ),
            );

          if (pmRow == null) {
            await reply.status(404).send({
              error: 'Payment method not found',
              code: 'PAYMENT_METHOD_NOT_FOUND',
            });
            return;
          }
        }
      }

      // Create session first so event projection can match via remote_start_id
      const remoteStartId = Math.floor(Math.random() * 2_147_483_647);
      let transactionId: string;
      if (station.ocppProtocol === 'ocpp1.6') {
        try {
          const [row] = await db.execute<{ nextval: string }>(
            sql`SELECT nextval('ocpp16_transaction_id_seq')`,
          );
          transactionId = row?.nextval ?? String(Math.floor(Date.now() / 1000) % 2_147_483_647);
        } catch {
          transactionId = String(Math.floor(Date.now() / 1000) % 2_147_483_647);
        }
      } else {
        transactionId = crypto.randomUUID();
      }

      const sessionRows = await db
        .insert(chargingSessions)
        .values({
          stationId: station.id,
          evseId: evse.id,
          driverId,
          transactionId,
          status: 'active',
          startedAt: new Date(),
          remoteStartId,
          currency: config?.currency ?? 'USD',
        })
        .returning({ id: chargingSessions.id });

      const session = sessionRows[0];
      if (session == null) {
        await reply
          .status(500)
          .send({ error: 'Failed to create session', code: 'SESSION_CREATE_FAILED' });
        return;
      }

      // Send RequestStartTransaction and wait for station response
      const cmdResult = await sendOcppCommandAndWait(
        station.stationId,
        'RequestStartTransaction',
        {
          evseId: params.evseId,
          remoteStartId,
          idToken: { idToken: driverId, type: 'Central' },
        },
        station.ocppProtocol ?? undefined,
      );

      if (cmdResult.error != null) {
        await db
          .update(chargingSessions)
          .set({ status: 'faulted', updatedAt: new Date() })
          .where(eq(chargingSessions.id, session.id));
        void dispatchDriverNotification(
          client,
          'session.Faulted',
          driverId,
          { stationId: station.stationId, reason: 'Station did not respond' },
          ALL_TEMPLATES_DIRS,
          getPubSub(),
        );
        await reply.status(504).send({ error: 'Station did not respond', code: 'STATION_TIMEOUT' });
        return;
      }

      const cmdStatus = cmdResult.response?.['status'] as string | undefined;
      if (cmdStatus !== 'Accepted') {
        // TxInProgress recovery: station has a ghost transaction the CSMS doesn't know about
        const statusInfo = cmdResult.response?.['statusInfo'] as
          | { reasonCode?: string; additionalInfo?: string }
          | undefined;
        const isTxInProgress = statusInfo?.reasonCode === 'TxInProgress';

        if (isTxInProgress) {
          const ghostTxId =
            statusInfo.additionalInfo ??
            (cmdResult.response?.['transactionId'] as string | undefined);

          // Check if we have an active session on this EVSE in the CSMS
          const [evseActiveSession] = await db
            .select({ id: chargingSessions.id })
            .from(chargingSessions)
            .where(
              and(
                eq(chargingSessions.evseId, evse.id),
                eq(chargingSessions.status, 'active'),
                sql`${chargingSessions.id} != ${session.id}`,
              ),
            )
            .limit(1);

          if (evseActiveSession == null) {
            // No active CSMS session on this EVSE -- it is a ghost transaction
            request.log.info(
              { ghostTxId: ghostTxId ?? 'unknown', stationId: station.stationId },
              'TxInProgress recovery: ghost transaction detected',
            );

            // If we have the transaction ID, stop the ghost transaction first
            if (ghostTxId != null) {
              await sendOcppCommandAndWait(
                station.stationId,
                'RequestStopTransaction',
                { transactionId: ghostTxId },
                station.ocppProtocol ?? undefined,
              );
            }

            // Wait for the station to finish cleaning up, then retry
            await new Promise((resolve) => setTimeout(resolve, 5000));

            const retryResult = await sendOcppCommandAndWait(
              station.stationId,
              'RequestStartTransaction',
              {
                evseId: params.evseId,
                remoteStartId,
                idToken: { idToken: driverId, type: 'Central' },
              },
              station.ocppProtocol ?? undefined,
            );

            const retryStatus = retryResult.response?.['status'] as string | undefined;
            if (retryStatus === 'Accepted') {
              request.log.info(
                { stationId: station.stationId },
                'TxInProgress recovery: retry succeeded',
              );
              return { chargingSessionId: session.id };
            }
            // Retry failed, fall through to fault the session
          }
        }

        await db
          .update(chargingSessions)
          .set({ status: 'faulted', updatedAt: new Date() })
          .where(eq(chargingSessions.id, session.id));
        const reason = `Station rejected: ${cmdStatus ?? 'Unknown'}`;
        void dispatchDriverNotification(
          client,
          'session.Faulted',
          driverId,
          { stationId: station.stationId, reason },
          ALL_TEMPLATES_DIRS,
          getPubSub(),
        );
        await reply.status(502).send({
          error: `Station rejected start request: ${cmdStatus ?? 'Unknown'}`,
          code: 'START_REJECTED',
        });
        return;
      }

      return { chargingSessionId: session.id };
    },
  );

  app.get(
    '/portal/chargers/sessions/active',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Chargers'],
        summary: 'List active charging sessions for the driver',
        operationId: 'portalListActiveSessions',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(z.object({ data: z.array(activeSessionItem) }).passthrough()),
        },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;

      const sessions = await db
        .select({
          id: chargingSessions.id,
          stationId: chargingStations.stationId,
          transactionId: chargingSessions.transactionId,
          startedAt: chargingSessions.startedAt,
          energyDeliveredWh: chargingSessions.energyDeliveredWh,
          currentCostCents: chargingSessions.currentCostCents,
          currency: chargingSessions.currency,
        })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .where(and(eq(chargingSessions.driverId, driverId), eq(chargingSessions.status, 'active')));

      return { data: sessions };
    },
  );

  app.post(
    '/portal/chargers/sessions/:sessionId/stop',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Stop an active charging session',
        operationId: 'portalStopSession',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionIdParams),
        response: { 200: itemResponse(stopSessionResponse), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { sessionId } = request.params as z.infer<typeof sessionIdParams>;

      const [session] = await db
        .select({
          id: chargingSessions.id,
          transactionId: chargingSessions.transactionId,
          stationOcppId: chargingStations.stationId,
        })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .where(
          and(
            eq(chargingSessions.id, sessionId),
            eq(chargingSessions.driverId, driverId),
            eq(chargingSessions.status, 'active'),
          ),
        );

      if (session == null) {
        await reply.status(404).send({
          error: 'Active session not found',
          code: 'SESSION_NOT_FOUND',
        });
        return;
      }

      const commandId = crypto.randomUUID();
      const notification = JSON.stringify({
        commandId,
        stationId: session.stationOcppId,
        action: 'RequestStopTransaction',
        payload: {
          transactionId: session.transactionId,
        },
      });

      await getPubSub().publish('ocpp_commands', notification);

      return { status: 'stopping', chargingSessionId: session.id };
    },
  );

  // Driver reservations

  app.get(
    '/portal/reservations',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Chargers'],
        summary: 'List reservations for the driver',
        operationId: 'portalListReservations',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(z.object({ data: z.array(reservationItem) }).passthrough()) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;

      const data = await db
        .select({
          id: reservations.id,
          reservationId: reservations.reservationId,
          stationOcppId: chargingStations.stationId,
          status: reservations.status,
          expiresAt: reservations.expiresAt,
          createdAt: reservations.createdAt,
        })
        .from(reservations)
        .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
        .where(eq(reservations.driverId, driverId))
        .orderBy(desc(reservations.createdAt))
        .limit(50);

      return { data };
    },
  );

  app.post(
    '/portal/reservations',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Create a reservation on a station',
        operationId: 'portalCreateReservation',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createDriverReservationBody),
        response: {
          200: itemResponse(reservationCreated),
          400: errorResponse,
          403: errorResponse,
          404: errorResponse,
          409: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof createDriverReservationBody>;

      const [station] = await db
        .select({
          id: chargingStations.id,
          isOnline: chargingStations.isOnline,
          availability: chargingStations.availability,
          onboardingStatus: chargingStations.onboardingStatus,
        })
        .from(chargingStations)
        .where(eq(chargingStations.stationId, body.stationId));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (station.onboardingStatus !== 'accepted') {
        const code = station.onboardingStatus === 'pending' ? 'STATION_PENDING' : 'STATION_BLOCKED';
        const msg =
          station.onboardingStatus === 'pending'
            ? 'Station is pending approval'
            : 'Station is blocked';
        await reply.status(403).send({ error: msg, code });
        return;
      }

      // Skip online check for future-scheduled reservations (station may come online by startsAt)
      const hasFutureStart =
        body.startsAt != null && new Date(body.startsAt).getTime() > Date.now();
      if (!station.isOnline && !hasFutureStart) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      // Resolve evseId from OCPP integer to DB UUID
      let resolvedEvseId: string | null = null;
      if (body.evseId != null) {
        const [evse] = await db
          .select({ id: evses.id })
          .from(evses)
          .where(and(eq(evses.stationId, station.id), eq(evses.evseId, body.evseId)));

        if (evse == null) {
          await reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
          return;
        }
        resolvedEvseId = evse.id;
      }

      // Check for conflicting active or scheduled reservations
      const conflictConditions = [
        eq(reservations.stationId, station.id),
        or(eq(reservations.status, 'active'), eq(reservations.status, 'scheduled')),
        sql`${reservations.expiresAt} > NOW()`,
      ];
      if (resolvedEvseId != null) {
        conflictConditions.push(eq(reservations.evseId, resolvedEvseId));
      }
      const [conflict] = await db
        .select({ id: reservations.id })
        .from(reservations)
        .where(and(...conflictConditions))
        .limit(1);

      if (conflict != null) {
        await reply.status(409).send({
          error: 'An active reservation already exists for this station',
          code: 'RESERVATION_CONFLICT',
        });
        return;
      }

      // Generate next reservation ID atomically via sequence
      const [idRow] = await db.execute<{ next_val: string }>(
        sql`SELECT nextval('reservation_id_seq')::int AS next_val`,
      );
      const reservationId = Number(idRow?.next_val);

      // Determine if this is a future-scheduled reservation
      const isFutureScheduled =
        body.startsAt != null && new Date(body.startsAt).getTime() > Date.now();

      const [reservation] = await db
        .insert(reservations)
        .values({
          reservationId,
          stationId: station.id,
          evseId: resolvedEvseId,
          driverId,
          status: isFutureScheduled ? 'scheduled' : 'active',
          expiresAt: new Date(body.expiresAt),
          ...(body.startsAt != null ? { startsAt: new Date(body.startsAt) } : {}),
        })
        .returning();

      if (reservation == null) {
        await reply.status(500).send({
          error: 'Failed to create reservation',
          code: 'RESERVATION_CREATE_FAILED',
        });
        return;
      }

      if (isFutureScheduled) {
        // Enqueue delayed job via pub/sub bridge to the worker
        const delayMs = new Date(body.startsAt as string).getTime() - Date.now();
        await getPubSub().publish(
          'reservation_schedule',
          JSON.stringify({ reservationDbId: reservation.id, delayMs }),
        );
      } else {
        // Send ReserveNow to station immediately
        const commandId = crypto.randomUUID();
        const ocppPayload: Record<string, unknown> = {
          id: reservationId,
          expiryDateTime: body.expiresAt,
          idToken: { idToken: driverId, type: 'Central' },
        };
        if (body.evseId != null) {
          ocppPayload['evseId'] = body.evseId;
        }

        const notification = JSON.stringify({
          commandId,
          stationId: body.stationId,
          action: 'ReserveNow',
          payload: ocppPayload,
        });

        await getPubSub().publish('ocpp_commands', notification);
      }

      // Notify driver of reservation
      void dispatchDriverNotification(
        client,
        'reservation.Created',
        driverId,
        {
          reservationId,
          stationId: body.stationId,
          expiresAt: new Date(body.expiresAt).toLocaleString(),
        },
        ALL_TEMPLATES_DIRS,
        getPubSub(),
      );

      return reservation;
    },
  );

  app.delete(
    '/portal/reservations/:id',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Chargers'],
        summary: 'Cancel a reservation',
        operationId: 'portalCancelReservation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(reservationIdParams),
        response: {
          200: itemResponse(cancelReservationResponse),
          400: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof reservationIdParams>;

      const [reservation] = await db
        .select({
          id: reservations.id,
          reservationId: reservations.reservationId,
          status: reservations.status,
          stationOcppId: chargingStations.stationId,
        })
        .from(reservations)
        .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
        .where(and(eq(reservations.id, id), eq(reservations.driverId, driverId)));

      if (reservation == null) {
        await reply
          .status(404)
          .send({ error: 'Reservation not found', code: 'RESERVATION_NOT_FOUND' });
        return;
      }

      if (reservation.status !== 'active' && reservation.status !== 'scheduled') {
        await reply
          .status(400)
          .send({ error: 'Reservation is not active', code: 'RESERVATION_NOT_ACTIVE' });
        return;
      }

      // Skip OCPP CancelReservation for scheduled reservations (not yet sent to station)
      if (reservation.status === 'active') {
        const commandId = crypto.randomUUID();
        const notification = JSON.stringify({
          commandId,
          stationId: reservation.stationOcppId,
          action: 'CancelReservation',
          payload: { reservationId: reservation.reservationId },
        });

        await getPubSub().publish('ocpp_commands', notification);
      }

      await db
        .update(reservations)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(eq(reservations.id, id));

      // Notify driver of cancellation
      void dispatchDriverNotification(
        client,
        'reservation.Cancelled',
        driverId,
        {
          reservationId: reservation.reservationId,
          stationId: reservation.stationOcppId,
        },
        ALL_TEMPLATES_DIRS,
        getPubSub(),
      );

      return { status: 'cancelled' };
    },
  );
}
