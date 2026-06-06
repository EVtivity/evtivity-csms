// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, and, or, ilike, desc, sql, isNotNull, inArray } from 'drizzle-orm';
import { db } from '@evtivity/database';
import {
  chargingSessions,
  chargingStations,
  sites,
  drivers,
  driverTokens,
  vehicles,
  transactionEvents,
  transactionEventTypeEnum,
  paymentRecords,
  paymentStatusEnum,
  meterValues,
  guestSessions,
  sessionStatusEnum,
} from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { paginatedResponse, itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { getUserSiteIds } from '../lib/site-access.js';
import type { JwtPayload } from '../plugins/auth.js';
import { authorize } from '../middleware/rbac.js';

const sessionListItem = z
  .object({
    id: z.string().describe('Session identifier'),
    stationId: z.string().describe('Station internal ID'),
    stationName: z.string().nullable().describe('Station OCPP identity (display name)'),
    siteName: z.string().nullable().describe('Site name where the station is located'),
    driverId: z.string().nullable().describe('Driver internal ID, null for guest sessions'),
    driverName: z
      .string()
      .nullable()
      .describe('Full driver name (first + last), null for guest sessions'),
    transactionId: z.string().nullable().describe('OCPP transaction id reported by the station'),
    status: z.enum(sessionStatusEnum.enumValues).describe('Session lifecycle state'),
    startedAt: z.coerce.date().describe('Timestamp when charging started'),
    endedAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp when charging stopped (null if active)'),
    idleStartedAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp when the session became idle (null if not idle)'),
    energyDeliveredWh: z.coerce
      .number()
      .min(0)
      .nullable()
      .describe('Total energy delivered in Watt-hours'),
    co2AvoidedKg: z.coerce.number().nullable().describe('CO2 avoided vs gasoline in kg'),
    currentCostCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Running cost in cents (active sessions)'),
    finalCostCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Final cost in cents (completed sessions)'),
    currency: z.string().length(3).nullable().describe('ISO 4217 currency code'),
    freeVend: z.boolean().describe('True when site free vend mode bypassed payment'),
    isGuestSession: z
      .boolean()
      .describe('True when this is a guest (non-registered driver) session'),
    createdAt: z.coerce.date().describe('Timestamp the session row was created in the CSMS'),
  })
  .passthrough();

const transactionEventItem = z
  .object({
    id: z.string().describe('Transaction event identifier'),
    eventType: z
      .enum(transactionEventTypeEnum.enumValues)
      .describe('OCPP transaction event type (Started, Updated, Ended)'),
    seqNo: z.number().int().min(0).describe('Sequence number from the station'),
    timestamp: z.coerce.date().describe('Timestamp the event occurred at the station'),
    triggerReason: z.string().max(50).describe('OCPP trigger that caused this event'),
    offline: z.boolean().describe('True when the event was queued offline by the station'),
  })
  .passthrough();

const paymentRecordItem = z
  .object({
    id: z.string().describe('Payment record identifier'),
    status: z.enum(paymentStatusEnum.enumValues).describe('Payment lifecycle status'),
    paymentSource: z.string().max(50).describe('Payment source (e.g. stripe, card_on_file, guest)'),
    currency: z.string().length(3).describe('ISO 4217 currency code'),
    preAuthAmountCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Pre-authorized hold amount in cents'),
    capturedAmountCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Amount captured from the payment method in cents'),
    refundedAmountCents: z
      .number()
      .int()
      .min(0)
      .describe('Amount refunded back to the driver in cents'),
    failureReason: z
      .string()
      .max(500)
      .nullable()
      .describe('Failure description from the payment processor, null on success'),
  })
  .passthrough();

const sessionDetail = z
  .object({
    id: z.string().describe('Session identifier'),
    stationId: z.string().describe('Station internal ID'),
    stationName: z.string().nullable().describe('Station OCPP identity (display name)'),
    siteName: z.string().nullable().describe('Site name where the station is located'),
    driverId: z.string().nullable().describe('Driver internal ID, null for guest sessions'),
    driverName: z
      .string()
      .nullable()
      .describe('Full driver name (first + last), null for guest sessions'),
    transactionId: z.string().nullable().describe('OCPP transaction id reported by the station'),
    status: z.enum(sessionStatusEnum.enumValues).describe('Session lifecycle state'),
    startedAt: z.coerce.date().describe('Timestamp when charging started'),
    endedAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp when charging stopped (null if active)'),
    idleStartedAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp when the session became idle (null if not idle)'),
    energyDeliveredWh: z.coerce
      .number()
      .min(0)
      .nullable()
      .describe('Total energy delivered in Watt-hours'),
    co2AvoidedKg: z.coerce.number().nullable().describe('CO2 avoided vs gasoline in kg'),
    currentCostCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Running cost in cents (active sessions)'),
    finalCostCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Final cost in cents (completed sessions)'),
    currency: z.string().length(3).nullable().describe('ISO 4217 currency code'),
    stoppedReason: z
      .string()
      .max(100)
      .nullable()
      .describe('OCPP reason the session ended (e.g. EVDisconnected, Local, Remote)'),
    reservationId: z
      .string()
      .nullable()
      .describe('Reservation ID linked to the session, null if no reservation'),
    freeVend: z.boolean().describe('True when site free vend mode bypassed payment'),
    token: z
      .object({
        id: z.string().describe('Driver token ID (nanoid prefixed dtk_)'),
        idToken: z.string().describe('RFID UID or token identifier transmitted by the station'),
        tokenType: z.string().describe('OCPP IdToken type (e.g. ISO14443, Central, eMAID)'),
      })
      .passthrough()
      .nullable()
      .describe(
        'Driver token used to authorize this session, null when no registered token was matched',
      ),
    vehicle: z
      .object({
        id: z.string().describe('Vehicle ID (nanoid prefixed veh_)'),
        make: z.string().nullable().describe('Vehicle make'),
        model: z.string().nullable().describe('Vehicle model'),
        year: z.string().nullable().describe('Vehicle year'),
      })
      .passthrough()
      .nullable()
      .describe('Vehicle linked to this session, null when no vehicle is associated'),
    metadata: z
      .record(z.unknown())
      .nullable()
      .describe(
        'Session metadata jsonb. May include reservationTokenMismatch when reservation.token_id did not match the session token.',
      ),
    paymentRecord: paymentRecordItem
      .nullable()
      .describe('Linked payment record, null when no payment was taken'),
    guestSession: z
      .object({
        sessionToken: z
          .string()
          .describe('Opaque token used by the guest portal to view this session'),
        guestEmail: z.string().email().describe('Email address provided by the guest at checkout'),
        status: z.string().max(50).describe('Guest session status (active, completed, expired)'),
        preAuthAmountCents: z
          .number()
          .int()
          .min(0)
          .nullable()
          .describe('Pre-authorized hold on the guest payment method in cents'),
        stripePaymentIntentId: z
          .string()
          .nullable()
          .describe('Stripe PaymentIntent ID for the guest charge'),
        expiresAt: z.coerce.date().describe('Timestamp when the guest session token expires'),
        createdAt: z.coerce.date().describe('Timestamp the guest session was created'),
      })
      .passthrough()
      .nullable()
      .describe('Guest session details, null when the session was started by a registered driver'),
  })
  .passthrough();

const meterValueItem = z
  .object({
    id: z.number().int().min(1).describe('Internal meter value identifier'),
    timestamp: z.coerce.date().describe('Timestamp the meter reading was sampled at the station'),
    measurand: z
      .string()
      .max(50)
      .nullable()
      .describe('OCPP measurand (e.g. Energy.Active.Import.Register, Power.Active.Import)'),
    value: z.string().max(100).describe('Sampled value as a numeric string'),
    unit: z.string().max(20).nullable().describe('Unit of the sampled value (Wh, W, A, V, etc.)'),
    phase: z
      .string()
      .max(20)
      .nullable()
      .describe('Electrical phase the value applies to (L1, L2, L3, N, L1-N, etc.)'),
    location: z
      .string()
      .max(20)
      .nullable()
      .describe('Sampling location (Body, Cable, EV, Inlet, Outlet)'),
    context: z
      .string()
      .max(50)
      .nullable()
      .describe('OCPP reading context (e.g. Sample.Periodic, Transaction.Begin, Transaction.End)'),
  })
  .passthrough();

const meterValueQuery = paginationQuery.extend({
  measurand: z.string().max(50).optional().describe('Filter by measurand name'),
});

const sessionListQuery = paginationQuery.extend({
  siteId: ID_PARAMS.siteId.optional().describe('Filter by site ID'),
  stationId: ID_PARAMS.stationId.optional().describe('Filter by station ID'),
  status: z
    // 'idling' is a virtual filter value (status='active' AND idle_started_at IS NOT NULL)
    // not present in the DB enum; the handler maps it.
    .enum([...sessionStatusEnum.enumValues, 'idling'] as const)
    .optional()
    .describe('Filter by session status (or "idling" for active+idle)'),
});

const sessionParams = z.object({
  id: ID_PARAMS.sessionId.describe('Session ID'),
});

export function sessionRoutes(app: FastifyInstance): void {
  app.get(
    '/sessions',
    {
      onRequest: [authorize('sessions:read')],
      schema: {
        tags: ['Sessions'],
        summary: 'List charging sessions',
        operationId: 'listSessions',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(sessionListQuery),
        response: { 200: paginatedResponse(sessionListItem) },
      },
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
          keyGenerator: (request: FastifyRequest) => {
            const user = request.user as { userId?: string } | undefined;
            return user?.userId ?? request.ip;
          },
        },
      },
    },
    async (request) => {
      const { page, limit, search, siteId, stationId, status } = request.query as z.infer<
        typeof sessionListQuery
      >;
      const offset = (page - 1) * limit;

      const { userId } = request.user as JwtPayload;
      const accessibleSiteIds = await getUserSiteIds(userId);
      if (accessibleSiteIds != null && accessibleSiteIds.length === 0) {
        return { data: [], total: 0 };
      }

      const conditions = [];
      if (accessibleSiteIds != null) {
        conditions.push(inArray(chargingStations.siteId, accessibleSiteIds));
      }
      if (search) {
        const pattern = `%${search}%`;
        conditions.push(
          or(
            ilike(chargingSessions.id, pattern),
            ilike(chargingSessions.transactionId, pattern),
            ilike(chargingStations.stationId, pattern),
            ilike(drivers.firstName, pattern),
            ilike(drivers.lastName, pattern),
          ),
        );
      }
      if (siteId != null) {
        conditions.push(eq(chargingStations.siteId, siteId));
      }
      if (stationId != null) {
        conditions.push(eq(chargingSessions.stationId, stationId));
      }
      if (status != null) {
        if (status === 'idling') {
          conditions.push(eq(chargingSessions.status, 'active'));
          conditions.push(isNotNull(chargingSessions.idleStartedAt));
        } else {
          conditions.push(eq(chargingSessions.status, status));
        }
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      // Single query with count(*) OVER() window function to get total alongside data,
      // eliminating a separate count round-trip.
      const rows = await db
        .select({
          id: chargingSessions.id,
          stationId: chargingSessions.stationId,
          stationName: chargingStations.stationId,
          siteName: sites.name,
          driverId: chargingSessions.driverId,
          driverName: sql<
            string | null
          >`CASE WHEN ${drivers.firstName} IS NOT NULL THEN COALESCE(${drivers.firstName}, '') || ' ' || COALESCE(${drivers.lastName}, '') ELSE NULL END`,
          transactionId: chargingSessions.transactionId,
          status: chargingSessions.status,
          startedAt: chargingSessions.startedAt,
          endedAt: chargingSessions.endedAt,
          idleStartedAt: chargingSessions.idleStartedAt,
          energyDeliveredWh: chargingSessions.energyDeliveredWh,
          co2AvoidedKg: chargingSessions.co2AvoidedKg,
          currentCostCents: chargingSessions.currentCostCents,
          finalCostCents: chargingSessions.finalCostCents,
          currency: chargingSessions.currency,
          freeVend: chargingSessions.freeVend,
          guestSessionToken: guestSessions.sessionToken,
          createdAt: chargingSessions.createdAt,
          _total: sql<number>`count(*) OVER()`.as('_total'),
        })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .leftJoin(drivers, eq(chargingSessions.driverId, drivers.id))
        .leftJoin(guestSessions, eq(guestSessions.chargingSessionId, chargingSessions.id))
        .where(where)
        .orderBy(desc(chargingSessions.createdAt), desc(chargingSessions.id))
        .limit(limit)
        .offset(offset);

      const total = rows[0]?._total ?? 0;
      const data = rows.map(({ _total, guestSessionToken, ...rest }) => {
        void _total;
        return {
          ...rest,
          isGuestSession: guestSessionToken != null,
        };
      });

      return { data, total } satisfies PaginatedResponse<(typeof data)[number]>;
    },
  );

  app.get(
    '/sessions/:id',
    {
      onRequest: [authorize('sessions:read')],
      schema: {
        tags: ['Sessions'],
        summary: 'Get charging session details',
        operationId: 'getSession',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionParams),
        response: {
          200: itemResponse(sessionDetail),
          404: errorWith('Session not found', [ERROR_CODES.SESSION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof sessionParams>;

      const [row] = await db
        .select({
          id: chargingSessions.id,
          stationId: chargingSessions.stationId,
          stationName: chargingStations.stationId,
          siteName: sites.name,
          siteId: chargingStations.siteId,
          driverId: chargingSessions.driverId,
          driverName: sql<
            string | null
          >`CASE WHEN ${drivers.firstName} IS NOT NULL THEN COALESCE(${drivers.firstName}, '') || ' ' || COALESCE(${drivers.lastName}, '') ELSE NULL END`,
          transactionId: chargingSessions.transactionId,
          status: chargingSessions.status,
          startedAt: chargingSessions.startedAt,
          endedAt: chargingSessions.endedAt,
          idleStartedAt: chargingSessions.idleStartedAt,
          energyDeliveredWh: chargingSessions.energyDeliveredWh,
          co2AvoidedKg: chargingSessions.co2AvoidedKg,
          currentCostCents: chargingSessions.currentCostCents,
          finalCostCents: chargingSessions.finalCostCents,
          currency: chargingSessions.currency,
          stoppedReason: chargingSessions.stoppedReason,
          reservationId: chargingSessions.reservationId,
          freeVend: chargingSessions.freeVend,
          tokenId: driverTokens.id,
          tokenIdToken: driverTokens.idToken,
          tokenType: driverTokens.tokenType,
          vehicleId: vehicles.id,
          vehicleMake: vehicles.make,
          vehicleModel: vehicles.model,
          vehicleYear: vehicles.year,
          metadata: chargingSessions.metadata,
          paymentId: paymentRecords.id,
          paymentStatus: paymentRecords.status,
          paymentSource: paymentRecords.paymentSource,
          paymentCurrency: paymentRecords.currency,
          preAuthAmountCents: paymentRecords.preAuthAmountCents,
          capturedAmountCents: paymentRecords.capturedAmountCents,
          refundedAmountCents: paymentRecords.refundedAmountCents,
          failureReason: paymentRecords.failureReason,
          guestSessionToken: guestSessions.sessionToken,
          guestEmail: guestSessions.guestEmail,
          guestStatus: guestSessions.status,
          guestPreAuthAmountCents: guestSessions.preAuthAmountCents,
          guestStripePaymentIntentId: guestSessions.stripePaymentIntentId,
          guestExpiresAt: guestSessions.expiresAt,
          guestCreatedAt: guestSessions.createdAt,
        })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .leftJoin(drivers, eq(chargingSessions.driverId, drivers.id))
        .leftJoin(driverTokens, eq(chargingSessions.tokenId, driverTokens.id))
        .leftJoin(vehicles, eq(chargingSessions.vehicleId, vehicles.id))
        .leftJoin(paymentRecords, eq(paymentRecords.sessionId, chargingSessions.id))
        .leftJoin(guestSessions, eq(guestSessions.chargingSessionId, chargingSessions.id))
        .where(eq(chargingSessions.id, id));

      if (row == null) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && row.siteId != null && !siteIds.includes(row.siteId)) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      const {
        paymentId,
        paymentStatus,
        paymentSource,
        paymentCurrency,
        preAuthAmountCents,
        capturedAmountCents,
        refundedAmountCents,
        failureReason,
        guestSessionToken,
        guestEmail,
        guestStatus,
        guestPreAuthAmountCents,
        guestStripePaymentIntentId,
        guestExpiresAt,
        guestCreatedAt,
        tokenId,
        tokenIdToken,
        tokenType,
        vehicleId,
        vehicleMake,
        vehicleModel,
        vehicleYear,
        ...session
      } = row;

      return {
        ...session,
        token:
          tokenId != null
            ? { id: tokenId, idToken: tokenIdToken ?? '', tokenType: tokenType ?? '' }
            : null,
        vehicle:
          vehicleId != null
            ? { id: vehicleId, make: vehicleMake, model: vehicleModel, year: vehicleYear }
            : null,
        paymentRecord:
          paymentId != null
            ? {
                id: paymentId,
                status: paymentStatus ?? '',
                paymentSource: paymentSource ?? '',
                currency: paymentCurrency ?? '',
                preAuthAmountCents,
                capturedAmountCents,
                refundedAmountCents: refundedAmountCents ?? 0,
                failureReason,
              }
            : null,
        guestSession:
          guestSessionToken != null
            ? {
                sessionToken: guestSessionToken,
                guestEmail: guestEmail ?? '',
                status: guestStatus ?? '',
                preAuthAmountCents: guestPreAuthAmountCents,
                stripePaymentIntentId: guestStripePaymentIntentId,
                expiresAt: guestExpiresAt as Date,
                createdAt: guestCreatedAt as Date,
              }
            : null,
      };
    },
  );

  // Paginated transaction events
  app.get(
    '/sessions/:id/transaction-events',
    {
      onRequest: [authorize('sessions:read')],
      schema: {
        tags: ['Sessions'],
        summary: 'List transaction events for a charging session',
        operationId: 'listSessionTransactionEvents',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionParams),
        querystring: zodSchema(paginationQuery),
        response: {
          200: paginatedResponse(transactionEventItem),
          404: errorWith('Session not found', [ERROR_CODES.SESSION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof sessionParams>;
      const { page, limit } = request.query as { page: number; limit: number };
      const offset = (page - 1) * limit;

      const [session] = await db
        .select({ id: chargingSessions.id, siteId: chargingStations.siteId })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .where(eq(chargingSessions.id, id))
        .limit(1);

      if (session == null) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      const { userId } = request.user as JwtPayload;
      const txSiteIds = await getUserSiteIds(userId);
      if (txSiteIds != null && session.siteId != null && !txSiteIds.includes(session.siteId)) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      const [data, countRows] = await Promise.all([
        db
          .select({
            id: transactionEvents.id,
            eventType: transactionEvents.eventType,
            seqNo: transactionEvents.seqNo,
            timestamp: transactionEvents.timestamp,
            triggerReason: transactionEvents.triggerReason,
            offline: transactionEvents.offline,
          })
          .from(transactionEvents)
          .where(eq(transactionEvents.sessionId, id))
          .orderBy(desc(transactionEvents.timestamp))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(transactionEvents)
          .where(eq(transactionEvents.sessionId, id)),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[0]
      >;
    },
  );

  app.get(
    '/sessions/:id/meter-values',
    {
      onRequest: [authorize('sessions:read')],
      schema: {
        tags: ['Sessions'],
        summary: 'List meter values for a charging session',
        operationId: 'listSessionMeterValues',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionParams),
        querystring: zodSchema(meterValueQuery),
        response: {
          200: paginatedResponse(meterValueItem),
          404: errorWith('Session not found', [ERROR_CODES.SESSION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof sessionParams>;
      const { page, limit, measurand } = request.query as z.infer<typeof meterValueQuery>;
      const offset = (page - 1) * limit;

      const [session] = await db
        .select({ id: chargingSessions.id, siteId: chargingStations.siteId })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .where(eq(chargingSessions.id, id))
        .limit(1);

      if (session == null) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      const { userId } = request.user as JwtPayload;
      const mvSiteIds = await getUserSiteIds(userId);
      if (mvSiteIds != null && session.siteId != null && !mvSiteIds.includes(session.siteId)) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      const conditions = [eq(meterValues.sessionId, id)];
      if (measurand != null) {
        conditions.push(eq(meterValues.measurand, measurand));
      }
      const where = and(...conditions);

      const [data, countRows] = await Promise.all([
        db
          .select({
            id: meterValues.id,
            timestamp: meterValues.timestamp,
            measurand: meterValues.measurand,
            value: meterValues.value,
            unit: meterValues.unit,
            phase: meterValues.phase,
            location: meterValues.location,
            context: meterValues.context,
          })
          .from(meterValues)
          .where(where)
          .orderBy(desc(meterValues.timestamp))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(meterValues)
          .where(where),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );
}
