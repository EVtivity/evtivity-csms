// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, or, ilike, desc, sql, count, inArray } from 'drizzle-orm';
import { db, client } from '@evtivity/database';
import {
  reservations,
  chargingStations,
  chargingSessions,
  drivers,
  evses,
  connectors,
  sites,
  ocppMessageLogs,
  getReservationSettings,
} from '@evtivity/database';
import { dispatchDriverNotification } from '@evtivity/lib';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import { getPubSub } from '../lib/pubsub.js';
import { sendOcppCommandAndWait } from '../lib/ocpp-command.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { ALL_TEMPLATES_DIRS } from '../lib/template-dirs.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { errorResponse, paginatedResponse, itemResponse } from '../lib/response-schemas.js';
import { chargeReservationCancellationFee } from '../lib/reservation-fees.js';
import { assertReservationsAllowed } from '../lib/reservation-eligibility.js';
import { authorize } from '../middleware/rbac.js';

const reservationListItem = z
  .object({
    id: z.string(),
    reservationId: z.number(),
    stationId: z.string(),
    stationOcppId: z.string(),
    siteName: z.string().nullable(),
    evseOcppId: z.number().nullable(),
    driverId: z.string().nullable(),
    driverFirstName: z.string().nullable(),
    driverLastName: z.string().nullable(),
    status: z.string(),
    expiresAt: z.coerce.date(),
    createdAt: z.coerce.date(),
    sessionId: z.string().nullable(),
  })
  .passthrough();

const reservationCreatedItem = z
  .object({
    id: z.string(),
    reservationId: z.number(),
    stationId: z.string(),
    evseId: z.string().nullable(),
    driverId: z.string().nullable(),
    status: z.string(),
    expiresAt: z.coerce.date(),
    createdAt: z.coerce.date(),
  })
  .passthrough();

const reservationDetailItem = z
  .object({
    id: z.string(),
    reservationId: z.number(),
    stationId: z.string(),
    stationOcppId: z.string(),
    evseId: z.string().nullable(),
    evseOcppId: z.number().nullable(),
    driverId: z.string().nullable(),
    driverFirstName: z.string().nullable(),
    driverLastName: z.string().nullable(),
    status: z.string(),
    expiresAt: z.coerce.date(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    sessionId: z.string().nullable(),
    sessionStatus: z.string().nullable().optional(),
    sessionEnergyWh: z.string().nullable().optional(),
    sessionCostCents: z.number().nullable().optional(),
    sessionStartedAt: z.coerce.date().nullable().optional(),
    sessionEndedAt: z.coerce.date().nullable().optional(),
  })
  .passthrough();

const cancelReservationResponse = z
  .object({ status: z.literal('cancelled'), warning: z.string().optional() })
  .passthrough();

const reassignReservationResponse = z
  .object({ status: z.literal('reassigned'), newStationOcppId: z.string() })
  .passthrough();

const reservationCommandItem = z
  .object({
    id: z.number(),
    direction: z.string(),
    messageType: z.number(),
    messageId: z.string(),
    action: z.string().nullable(),
    payload: z.unknown(),
    errorCode: z.string().nullable(),
    errorDescription: z.string().nullable(),
    createdAt: z.coerce.date(),
    responseTimeMs: z.number().nullable(),
  })
  .passthrough();

const reservationIdParams = z.object({ id: ID_PARAMS.reservationId.describe('Reservation ID') });

const listReservationsQuery = paginationQuery.extend({
  status: z
    .enum(['scheduled', 'active', 'in_use', 'used', 'cancelled', 'expired'])
    .optional()
    .describe('Filter by reservation status'),
  stationId: ID_PARAMS.stationId.optional().describe('Filter by station ID'),
  siteId: ID_PARAMS.siteId.optional().describe('Filter by site ID'),
});

const createReservationBody = z.object({
  stationId: z.string().describe('OCPP station identifier string'),
  evseId: z.coerce.number().int().optional().describe('EVSE ID on the station'),
  driverId: ID_PARAMS.driverId.optional().describe('Driver ID to associate with the reservation'),
  expiresAt: z.string().datetime().describe('ISO 8601 expiration date-time'),
  startsAt: z.string().datetime().optional().describe('ISO 8601 start date-time'),
});

const updateReservationBody = z.object({
  driverId: ID_PARAMS.driverId.nullable().optional().describe('Driver ID'),
  evseId: z.coerce.number().int().nullable().optional().describe('EVSE ID on the station'),
  expiresAt: z.string().datetime().optional().describe('ISO 8601 expiration date-time'),
});

async function getNextReservationId(): Promise<number> {
  const [row] = await db.execute<{ next_val: string }>(
    sql`SELECT nextval('reservation_id_seq')::int AS next_val`,
  );
  return Number(row?.next_val);
}

export function reservationRoutes(app: FastifyInstance): void {
  // List all reservations (operator)
  app.get(
    '/reservations',
    {
      onRequest: [authorize('reservations:read')],
      schema: {
        tags: ['Reservations'],
        summary: 'List all reservations',
        operationId: 'listReservations',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(listReservationsQuery),
        response: { 200: paginatedResponse(reservationListItem) },
      },
    },
    async (request) => {
      const query = request.query as z.infer<typeof listReservationsQuery>;
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const conditions = [];
      if (query.search != null && query.search !== '') {
        const pattern = `%${query.search}%`;
        conditions.push(
          or(
            ilike(reservations.id, pattern),
            ilike(chargingStations.stationId, pattern),
            ilike(drivers.firstName, pattern),
            ilike(drivers.lastName, pattern),
          ),
        );
      }
      if (query.status != null) {
        conditions.push(eq(reservations.status, query.status));
      }
      if (query.stationId != null) {
        conditions.push(eq(reservations.stationId, query.stationId));
      }
      if (query.siteId != null) {
        conditions.push(eq(chargingStations.siteId, query.siteId));
      }

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) return { data: [], total: 0 };
      if (siteIds != null) conditions.push(inArray(chargingStations.siteId, siteIds));

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [data, totalResult] = await Promise.all([
        db
          .select({
            id: reservations.id,
            reservationId: reservations.reservationId,
            stationId: reservations.stationId,
            stationOcppId: chargingStations.stationId,
            siteName: sites.name,
            evseOcppId: evses.evseId,
            driverId: reservations.driverId,
            driverFirstName: drivers.firstName,
            driverLastName: drivers.lastName,
            status: reservations.status,
            expiresAt: reservations.expiresAt,
            createdAt: reservations.createdAt,
            sessionId: chargingSessions.id,
          })
          .from(reservations)
          .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
          .leftJoin(sites, eq(chargingStations.siteId, sites.id))
          .leftJoin(drivers, eq(reservations.driverId, drivers.id))
          .leftJoin(evses, eq(reservations.evseId, evses.id))
          .leftJoin(chargingSessions, eq(chargingSessions.reservationId, reservations.id))
          .where(where)
          .orderBy(desc(reservations.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: count() })
          .from(reservations)
          .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
          .leftJoin(drivers, eq(reservations.driverId, drivers.id))
          .where(where),
      ]);

      return { data, total: totalResult[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // Get single reservation (operator)
  app.get(
    '/reservations/:id',
    {
      onRequest: [authorize('reservations:read')],
      schema: {
        tags: ['Reservations'],
        summary: 'Get a single reservation by ID',
        operationId: 'getReservation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(reservationIdParams),
        response: { 200: itemResponse(reservationDetailItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof reservationIdParams>;

      const [reservation] = await db
        .select({
          id: reservations.id,
          reservationId: reservations.reservationId,
          stationId: reservations.stationId,
          stationOcppId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          siteName: sites.name,
          evseId: reservations.evseId,
          evseOcppId: evses.evseId,
          connectorType: connectors.connectorType,
          connectorMaxPowerKw: connectors.maxPowerKw,
          driverId: reservations.driverId,
          driverFirstName: drivers.firstName,
          driverLastName: drivers.lastName,
          status: reservations.status,
          startsAt: reservations.startsAt,
          expiresAt: reservations.expiresAt,
          createdAt: reservations.createdAt,
          updatedAt: reservations.updatedAt,
          sessionId: chargingSessions.id,
          sessionStatus: chargingSessions.status,
          sessionEnergyWh: chargingSessions.energyDeliveredWh,
          sessionCostCents: chargingSessions.finalCostCents,
          sessionStartedAt: chargingSessions.startedAt,
          sessionEndedAt: chargingSessions.endedAt,
        })
        .from(reservations)
        .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .leftJoin(drivers, eq(reservations.driverId, drivers.id))
        .leftJoin(evses, eq(reservations.evseId, evses.id))
        .leftJoin(connectors, eq(connectors.evseId, evses.id))
        .leftJoin(chargingSessions, eq(chargingSessions.reservationId, reservations.id))
        .where(eq(reservations.id, id));

      if (reservation == null) {
        await reply
          .status(404)
          .send({ error: 'Reservation not found', code: 'RESERVATION_NOT_FOUND' });
        return;
      }

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && reservation.siteId != null && !siteIds.includes(reservation.siteId)) {
        await reply
          .status(404)
          .send({ error: 'Reservation not found', code: 'RESERVATION_NOT_FOUND' });
        return;
      }

      return reservation;
    },
  );

  // List OCPP commands for a reservation
  app.get(
    '/reservations/:id/commands',
    {
      onRequest: [authorize('reservations:read')],
      schema: {
        tags: ['Reservations'],
        summary: 'List OCPP commands for a reservation',
        operationId: 'listReservationCommands',
        security: [{ bearerAuth: [] }],
        params: zodSchema(reservationIdParams),
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(reservationCommandItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof reservationIdParams>;
      const query = request.query as z.infer<typeof paginationQuery>;
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      // Fetch reservation to get stationId and reservationId
      const [reservation] = await db
        .select({
          stationId: reservations.stationId,
          reservationId: reservations.reservationId,
          siteId: chargingStations.siteId,
        })
        .from(reservations)
        .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
        .where(eq(reservations.id, id));

      if (reservation == null) {
        await reply
          .status(404)
          .send({ error: 'Reservation not found', code: 'RESERVATION_NOT_FOUND' });
        return;
      }

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && reservation.siteId != null && !siteIds.includes(reservation.siteId)) {
        await reply
          .status(404)
          .send({ error: 'Reservation not found', code: 'RESERVATION_NOT_FOUND' });
        return;
      }

      // Query OCPP message logs for ReserveNow and CancelReservation actions
      // First find CALL messages matching this reservation, then include their responses

      // Step 1: Find CALL message IDs for this reservation (across ALL stations)
      const callLogs = await db
        .select({ messageId: ocppMessageLogs.messageId })
        .from(ocppMessageLogs)
        .where(
          and(
            eq(ocppMessageLogs.messageType, 2),
            or(
              sql`${ocppMessageLogs.action} = 'ReserveNow'`,
              sql`${ocppMessageLogs.action} = 'CancelReservation'`,
            ),
            or(
              sql`(${ocppMessageLogs.payload} #>> '{}')::jsonb @> ${JSON.stringify({ id: reservation.reservationId })}::jsonb`,
              sql`(${ocppMessageLogs.payload} #>> '{}')::jsonb @> ${JSON.stringify({ reservationId: reservation.reservationId })}::jsonb`,
            ),
          ),
        );

      if (callLogs.length === 0) {
        return { data: [], total: 0 };
      }

      const callMessageIds = callLogs.map((l) => l.messageId);

      // Step 2: Fetch CALL + RESULT/ERROR messages matching those messageIds (across ALL stations)
      const conditions = inArray(ocppMessageLogs.messageId, callMessageIds);

      const [data, totalResult] = await Promise.all([
        db
          .select({
            id: ocppMessageLogs.id,
            stationId: ocppMessageLogs.stationId,
            stationOcppId: chargingStations.stationId,
            direction: ocppMessageLogs.direction,
            messageType: ocppMessageLogs.messageType,
            messageId: ocppMessageLogs.messageId,
            action: ocppMessageLogs.action,
            payload: ocppMessageLogs.payload,
            errorCode: ocppMessageLogs.errorCode,
            errorDescription: ocppMessageLogs.errorDescription,
            createdAt: ocppMessageLogs.createdAt,
          })
          .from(ocppMessageLogs)
          .leftJoin(chargingStations, eq(ocppMessageLogs.stationId, chargingStations.id))
          .where(conditions)
          .orderBy(desc(ocppMessageLogs.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ count: count() }).from(ocppMessageLogs).where(conditions),
      ]);

      // Compute response times by pairing CALL messages with their RESULT/ERROR responses
      const messageIdToTime = new Map<string, Date>();
      for (const log of data) {
        if (log.messageType === 2) {
          messageIdToTime.set(log.messageId, log.createdAt);
        }
      }

      const enriched = data.map((log) => {
        let responseTimeMs: number | null = null;
        if (log.messageType === 3 || log.messageType === 4) {
          const callTime = messageIdToTime.get(log.messageId);
          if (callTime != null) {
            responseTimeMs = log.createdAt.getTime() - callTime.getTime();
          }
        }
        return { ...log, responseTimeMs };
      });

      return { data: enriched, total: totalResult[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof enriched)[number]
      >;
    },
  );

  // Create reservation (operator)
  app.post(
    '/reservations',
    {
      onRequest: [authorize('reservations:write')],
      schema: {
        tags: ['Reservations'],
        summary: 'Create a reservation and send ReserveNow to station',
        operationId: 'createReservation',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createReservationBody),
        response: {
          200: itemResponse(reservationCreatedItem),
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
      const body = request.body as z.infer<typeof createReservationBody>;

      // Find station by OCPP stationId string
      const [station] = await db
        .select({
          id: chargingStations.id,
          siteId: chargingStations.siteId,
          isOnline: chargingStations.isOnline,
          reservationsEnabled: chargingStations.reservationsEnabled,
        })
        .from(chargingStations)
        .where(eq(chargingStations.stationId, body.stationId));

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

      // Skip online check for future-scheduled reservations (station may come online by startsAt)
      const hasFutureStart =
        body.startsAt != null && new Date(body.startsAt).getTime() > Date.now();
      if (!station.isOnline && !hasFutureStart) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      // Check system-wide, station-level, and site-level reservation eligibility
      try {
        await assertReservationsAllowed(station);
      } catch (err) {
        const e = err as { statusCode?: number; code?: string; message?: string };
        await reply
          .status((e.statusCode ?? 500) as 400)
          .send({ error: e.message ?? 'Reservations not allowed', code: e.code });
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

      const reservationId = await getNextReservationId();

      // Determine if this is a future-scheduled reservation
      const isFutureScheduled =
        body.startsAt != null && new Date(body.startsAt).getTime() > Date.now();

      // Insert reservation row
      const [reservation] = await db
        .insert(reservations)
        .values({
          reservationId,
          stationId: station.id,
          evseId: resolvedEvseId,
          driverId: body.driverId ?? null,
          status: isFutureScheduled ? 'scheduled' : 'active',
          expiresAt: new Date(body.expiresAt),
          ...(body.startsAt != null ? { startsAt: new Date(body.startsAt) } : {}),
        })
        .returning();

      if (reservation == null) {
        await reply
          .status(500)
          .send({ error: 'Failed to create reservation', code: 'RESERVATION_CREATE_FAILED' });
        return;
      }

      if (isFutureScheduled) {
        // Enqueue delayed job via pub/sub bridge to the worker
        const delayMs = new Date(body.startsAt as string).getTime() - Date.now();
        await getPubSub().publish(
          'reservation_schedule',
          JSON.stringify({ reservationDbId: reservation.id, delayMs }),
        );

        // Notify driver of scheduled reservation
        if (reservation.driverId != null) {
          void dispatchDriverNotification(
            client,
            'reservation.Created',
            reservation.driverId,
            {
              reservationId: reservation.reservationId,
              stationId: body.stationId,
              expiresAt: new Date(body.expiresAt).toLocaleString(),
            },
            ALL_TEMPLATES_DIRS,
            getPubSub(),
          );
        }

        return reservation;
      }

      // Send ReserveNow to station immediately
      const ocppPayload: Record<string, unknown> = {
        id: reservationId,
        expiryDateTime: body.expiresAt,
        idToken: { idToken: body.driverId ?? 'operator', type: 'Central' },
      };
      if (body.evseId != null) {
        ocppPayload['evseId'] = body.evseId;
      }

      const result = await sendOcppCommandAndWait(body.stationId, 'ReserveNow', ocppPayload);

      if (result.error != null) {
        // Station rejected or timed out: cancel the reservation
        await db
          .update(reservations)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(eq(reservations.id, reservation.id));

        const isTimeout = result.error.includes('No response within');
        await reply.status(isTimeout ? 504 : 502).send({
          error: result.error,
          code: isTimeout ? 'RESERVATION_TIMEOUT' : 'RESERVATION_REJECTED',
        });
        return;
      }

      // Check station response status
      const responseStatus = result.response?.['status'] as string | undefined;
      if (responseStatus != null && responseStatus !== 'Accepted') {
        await db
          .update(reservations)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(eq(reservations.id, reservation.id));

        await reply.status(400).send({
          error: `Station rejected reservation: ${responseStatus}`,
          code: 'RESERVATION_REJECTED',
        });
        return;
      }

      // Notify driver of confirmed reservation
      if (reservation.driverId != null) {
        void dispatchDriverNotification(
          client,
          'reservation.Created',
          reservation.driverId,
          {
            reservationId: reservation.reservationId,
            stationId: body.stationId,
            expiresAt: new Date(body.expiresAt).toLocaleString(),
          },
          ALL_TEMPLATES_DIRS,
          getPubSub(),
        );
      }

      return reservation;
    },
  );

  // Update reservation (operator)
  app.patch(
    '/reservations/:id',
    {
      onRequest: [authorize('reservations:write')],
      schema: {
        tags: ['Reservations'],
        summary: 'Update an active reservation',
        operationId: 'updateReservation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(reservationIdParams),
        body: zodSchema(updateReservationBody),
        response: {
          200: itemResponse(reservationDetailItem),
          400: errorResponse,
          404: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof reservationIdParams>;
      const body = request.body as z.infer<typeof updateReservationBody>;

      // Fetch current reservation
      const [existing] = await db
        .select({
          id: reservations.id,
          stationId: reservations.stationId,
          evseId: reservations.evseId,
          status: reservations.status,
          expiresAt: reservations.expiresAt,
        })
        .from(reservations)
        .where(eq(reservations.id, id));

      if (existing == null) {
        await reply
          .status(404)
          .send({ error: 'Reservation not found', code: 'RESERVATION_NOT_FOUND' });
        return;
      }

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null) {
        const [station] = await db
          .select({ siteId: chargingStations.siteId })
          .from(chargingStations)
          .where(eq(chargingStations.id, existing.stationId));
        if (station?.siteId != null && !siteIds.includes(station.siteId)) {
          await reply
            .status(404)
            .send({ error: 'Reservation not found', code: 'RESERVATION_NOT_FOUND' });
          return;
        }
      }

      if (existing.status !== 'active' && existing.status !== 'scheduled') {
        await reply
          .status(400)
          .send({ error: 'Reservation is not active', code: 'RESERVATION_NOT_ACTIVE' });
        return;
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };

      // Handle driverId
      if (body.driverId !== undefined) {
        updates['driverId'] = body.driverId;
      }

      // Handle evseId resolution
      let resolvedEvseId = existing.evseId;
      if (body.evseId !== undefined) {
        if (body.evseId === null) {
          resolvedEvseId = null;
          updates['evseId'] = null;
        } else {
          const [evse] = await db
            .select({ id: evses.id })
            .from(evses)
            .where(and(eq(evses.stationId, existing.stationId), eq(evses.evseId, body.evseId)));

          if (evse == null) {
            await reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
            return;
          }
          resolvedEvseId = evse.id;
          updates['evseId'] = evse.id;
        }
      }

      // Handle expiresAt
      if (body.expiresAt !== undefined) {
        updates['expiresAt'] = new Date(body.expiresAt);
      }

      // Conflict check if evseId or expiresAt changed
      const evseChanged = body.evseId !== undefined;
      const expiresChanged = body.expiresAt !== undefined;
      if (evseChanged || expiresChanged) {
        const conflictConditions = [
          eq(reservations.stationId, existing.stationId),
          eq(reservations.status, 'active'),
          sql`${reservations.expiresAt} > NOW()`,
          sql`${reservations.id} != ${id}`,
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
      }

      // Apply update
      await db.update(reservations).set(updates).where(eq(reservations.id, id));

      // Re-fetch with joins for response
      const [updated] = await db
        .select({
          id: reservations.id,
          reservationId: reservations.reservationId,
          stationId: reservations.stationId,
          stationOcppId: chargingStations.stationId,
          evseId: reservations.evseId,
          evseOcppId: evses.evseId,
          driverId: reservations.driverId,
          driverFirstName: drivers.firstName,
          driverLastName: drivers.lastName,
          status: reservations.status,
          expiresAt: reservations.expiresAt,
          createdAt: reservations.createdAt,
          updatedAt: reservations.updatedAt,
          sessionId: chargingSessions.id,
          sessionStatus: chargingSessions.status,
          sessionEnergyWh: chargingSessions.energyDeliveredWh,
          sessionCostCents: chargingSessions.finalCostCents,
          sessionStartedAt: chargingSessions.startedAt,
          sessionEndedAt: chargingSessions.endedAt,
        })
        .from(reservations)
        .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
        .leftJoin(drivers, eq(reservations.driverId, drivers.id))
        .leftJoin(evses, eq(reservations.evseId, evses.id))
        .leftJoin(chargingSessions, eq(chargingSessions.reservationId, reservations.id))
        .where(eq(reservations.id, id));

      return updated;
    },
  );

  // Cancel reservation (operator)
  app.delete(
    '/reservations/:id',
    {
      onRequest: [authorize('reservations:write')],
      schema: {
        tags: ['Reservations'],
        summary: 'Cancel an active reservation',
        operationId: 'cancelReservation',
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
      const { id } = request.params as z.infer<typeof reservationIdParams>;

      const [reservation] = await db
        .select({
          id: reservations.id,
          reservationId: reservations.reservationId,
          status: reservations.status,
          stationOcppId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          driverId: reservations.driverId,
          startsAt: reservations.startsAt,
          createdAt: reservations.createdAt,
        })
        .from(reservations)
        .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
        .where(eq(reservations.id, id));

      if (reservation == null) {
        await reply
          .status(404)
          .send({ error: 'Reservation not found', code: 'RESERVATION_NOT_FOUND' });
        return;
      }

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && reservation.siteId != null && !siteIds.includes(reservation.siteId)) {
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

      const isScheduled = reservation.status === 'scheduled';

      const reservationConfig = await getReservationSettings();

      let cancellationFeeChargedCents = 0;
      if (
        reservationConfig.cancellationFeeCents > 0 &&
        reservationConfig.cancellationWindowMinutes > 0 &&
        reservation.driverId != null
      ) {
        const referenceTime = reservation.startsAt ?? reservation.createdAt;
        const minutesUntilStart = Math.floor((referenceTime.getTime() - Date.now()) / 60_000);

        if (minutesUntilStart < reservationConfig.cancellationWindowMinutes) {
          try {
            await chargeReservationCancellationFee(
              reservation.driverId,
              reservation.siteId,
              reservationConfig.cancellationFeeCents,
              reservation.id,
            );
            cancellationFeeChargedCents = reservationConfig.cancellationFeeCents;
          } catch (err) {
            request.log.error(
              { err, reservationId: reservation.id },
              'cancellation fee charge failed',
            );
            // Non-fatal: proceed with cancellation even if fee fails
          }
        }
      }

      // Skip OCPP CancelReservation for scheduled reservations (not yet sent to station)
      let result: { error?: string } = {};
      if (!isScheduled) {
        result = await sendOcppCommandAndWait(reservation.stationOcppId, 'CancelReservation', {
          reservationId: reservation.reservationId,
        });
      }

      // Update status regardless of station response
      await db
        .update(reservations)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(eq(reservations.id, id));

      // Notify driver of cancellation
      if (reservation.driverId != null) {
        const cancellationFeeFormatted =
          cancellationFeeChargedCents > 0
            ? `$${(cancellationFeeChargedCents / 100).toFixed(2)}`
            : '';
        void dispatchDriverNotification(
          client,
          'reservation.Cancelled',
          reservation.driverId,
          {
            reservationId: reservation.reservationId,
            stationId: reservation.stationOcppId,
            cancellationFeeFormatted,
          },
          ALL_TEMPLATES_DIRS,
          getPubSub(),
        );
      }

      if (result.error != null) {
        return { status: 'cancelled', warning: result.error };
      }

      return { status: 'cancelled' };
    },
  );

  // Reassign reservation (operator)
  app.post(
    '/reservations/:id/reassign',
    {
      onRequest: [authorize('reservations:write')],
      schema: {
        tags: ['Reservations'],
        summary: 'Move an active reservation to a different station',
        operationId: 'reassignReservation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(reservationIdParams),
        body: zodSchema(
          z.object({
            newStationOcppId: z.string().describe('OCPP station identifier of the new station'),
            newEvseId: z.number().int().min(1).optional().describe('EVSE ID on the new station'),
          }),
        ),
        response: {
          200: itemResponse(reassignReservationResponse),
          400: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof reservationIdParams>;
      const body = request.body as { newStationOcppId: string; newEvseId?: number };
      const { newStationOcppId, newEvseId } = body;

      // 1. Fetch current reservation (with old station OCPP ID)
      const [reservation] = await db
        .select({
          id: reservations.id,
          reservationId: reservations.reservationId,
          stationId: reservations.stationId,
          stationOcppId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          evseId: reservations.evseId,
          driverId: reservations.driverId,
          expiresAt: reservations.expiresAt,
          status: reservations.status,
        })
        .from(reservations)
        .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
        .where(eq(reservations.id, id));

      if (reservation == null) {
        await reply
          .status(404)
          .send({ error: 'Reservation not found', code: 'RESERVATION_NOT_FOUND' });
        return;
      }

      // Site access control on old reservation's station
      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && reservation.siteId != null && !siteIds.includes(reservation.siteId)) {
        await reply
          .status(404)
          .send({ error: 'Reservation not found', code: 'RESERVATION_NOT_FOUND' });
        return;
      }

      // 2. Validate reservation is active
      if (reservation.status !== 'active') {
        await reply
          .status(400)
          .send({ error: 'Reservation is not active', code: 'RESERVATION_NOT_ACTIVE' });
        return;
      }

      // 3. Find new station by OCPP ID
      const [newStation] = await db
        .select({
          id: chargingStations.id,
          siteId: chargingStations.siteId,
          isOnline: chargingStations.isOnline,
          reservationsEnabled: chargingStations.reservationsEnabled,
        })
        .from(chargingStations)
        .where(eq(chargingStations.stationId, newStationOcppId));

      if (newStation == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Site access control on new station
      if (siteIds != null && newStation.siteId != null && !siteIds.includes(newStation.siteId)) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // 4. Check new station is online
      if (!newStation.isOnline) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      // 5. Check reservation eligibility on new station
      try {
        await assertReservationsAllowed(newStation);
      } catch (err) {
        const e = err as { statusCode?: number; code?: string; message?: string };
        await reply
          .status((e.statusCode ?? 500) as 400)
          .send({ error: e.message ?? 'Reservations not allowed', code: e.code });
        return;
      }

      // 6. Resolve newEvseId integer to DB UUID if provided
      let resolvedNewEvseId: string | null = null;
      if (newEvseId != null) {
        const [evse] = await db
          .select({ id: evses.id })
          .from(evses)
          .where(and(eq(evses.stationId, newStation.id), eq(evses.evseId, newEvseId)));

        if (evse == null) {
          await reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
          return;
        }
        resolvedNewEvseId = evse.id;
      }

      // 7. Send ReserveNow to new station FIRST
      const ocppPayload: Record<string, unknown> = {
        id: reservation.reservationId,
        expiryDateTime: reservation.expiresAt.toISOString(),
        idToken: { idToken: reservation.driverId ?? 'operator', type: 'Central' },
      };
      if (newEvseId != null) {
        ocppPayload['evseId'] = newEvseId;
      }

      const result = await sendOcppCommandAndWait(newStationOcppId, 'ReserveNow', ocppPayload);

      if (result.error != null) {
        await reply.status(400).send({
          error: result.error,
          code: 'RESERVATION_REJECTED',
        });
        return;
      }

      const responseStatus = result.response?.['status'] as string | undefined;
      if (responseStatus != null && responseStatus !== 'Accepted') {
        await reply.status(400).send({
          error: `Station rejected reservation: ${responseStatus}`,
          code: 'RESERVATION_REJECTED',
        });
        return;
      }

      // 8. Update reservation row with new station and evse BEFORE cancelling old
      await db
        .update(reservations)
        .set({
          stationId: newStation.id,
          evseId: resolvedNewEvseId,
          updatedAt: new Date(),
        })
        .where(eq(reservations.id, id));

      // 9. Cancel on old station (best effort, after DB update)
      try {
        await sendOcppCommandAndWait(reservation.stationOcppId, 'CancelReservation', {
          reservationId: reservation.reservationId,
        });
      } catch (err) {
        request.log.warn(
          { err, reservationId: reservation.id, stationOcppId: reservation.stationOcppId },
          'CancelReservation to old station failed during reassign (continuing)',
        );
      }

      // 10. Return success
      return { status: 'reassigned', newStationOcppId };
    },
  );
}
