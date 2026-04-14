// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, and, or, ilike, desc, sql, asc, isNotNull, inArray } from 'drizzle-orm';
import { db } from '@evtivity/database';
import {
  chargingSessions,
  chargingStations,
  sites,
  drivers,
  transactionEvents,
  paymentRecords,
  meterValues,
} from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { errorResponse, paginatedResponse, itemResponse } from '../lib/response-schemas.js';
import { getUserSiteIds } from '../lib/site-access.js';
import type { JwtPayload } from '../plugins/auth.js';
import { authorize } from '../middleware/rbac.js';

const sessionListItem = z
  .object({
    id: z.string(),
    stationId: z.string(),
    stationName: z.string().nullable(),
    siteName: z.string().nullable(),
    driverId: z.string().nullable(),
    driverName: z.string().nullable(),
    transactionId: z.string().nullable(),
    status: z.string(),
    startedAt: z.coerce.date(),
    endedAt: z.coerce.date().nullable(),
    idleStartedAt: z.coerce.date().nullable(),
    energyDeliveredWh: z.coerce.number().nullable(),
    co2AvoidedKg: z.coerce.number().nullable(),
    currentCostCents: z.number().nullable(),
    finalCostCents: z.number().nullable(),
    currency: z.string().nullable(),
    freeVend: z.boolean(),
    createdAt: z.coerce.date(),
  })
  .passthrough();

const transactionEventItem = z
  .object({
    id: z.string(),
    eventType: z.string(),
    seqNo: z.number(),
    timestamp: z.coerce.date(),
    triggerReason: z.string(),
    offline: z.boolean(),
  })
  .passthrough();

const paymentRecordItem = z
  .object({
    id: z.string(),
    status: z.string(),
    paymentSource: z.string(),
    currency: z.string(),
    preAuthAmountCents: z.number().nullable(),
    capturedAmountCents: z.number().nullable(),
    refundedAmountCents: z.number(),
    failureReason: z.string().nullable(),
  })
  .passthrough();

const sessionDetail = z
  .object({
    id: z.string(),
    stationId: z.string(),
    stationName: z.string().nullable(),
    siteName: z.string().nullable(),
    driverId: z.string().nullable(),
    driverName: z.string().nullable(),
    transactionId: z.string().nullable(),
    status: z.string(),
    startedAt: z.coerce.date(),
    endedAt: z.coerce.date().nullable(),
    idleStartedAt: z.coerce.date().nullable(),
    energyDeliveredWh: z.coerce.number().nullable(),
    co2AvoidedKg: z.coerce.number().nullable(),
    currentCostCents: z.number().nullable(),
    finalCostCents: z.number().nullable(),
    currency: z.string().nullable(),
    stoppedReason: z.string().nullable(),
    reservationId: z.string().nullable(),
    freeVend: z.boolean(),
    paymentRecord: paymentRecordItem.nullable(),
  })
  .passthrough();

const meterValueItem = z
  .object({
    id: z.number(),
    timestamp: z.coerce.date(),
    measurand: z.string().nullable(),
    value: z.string(),
    unit: z.string().nullable(),
    phase: z.string().nullable(),
    location: z.string().nullable(),
    context: z.string().nullable(),
  })
  .passthrough();

const meterValueQuery = paginationQuery.extend({
  measurand: z.string().optional().describe('Filter by measurand name'),
});

const sessionListQuery = paginationQuery.extend({
  siteId: ID_PARAMS.siteId.optional().describe('Filter by site ID'),
  stationId: ID_PARAMS.stationId.optional().describe('Filter by station ID'),
  status: z
    .enum(['active', 'completed', 'faulted', 'idling'])
    .optional()
    .describe('Filter by session status'),
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
          createdAt: chargingSessions.createdAt,
          _total: sql<number>`count(*) OVER()`.as('_total'),
        })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .leftJoin(drivers, eq(chargingSessions.driverId, drivers.id))
        .where(where)
        .orderBy(desc(chargingSessions.createdAt))
        .limit(limit)
        .offset(offset);

      const total = rows[0]?._total ?? 0;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const data = rows.map(({ _total: _t, ...rest }) => rest);

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
        response: { 200: itemResponse(sessionDetail), 404: errorResponse },
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
          paymentId: paymentRecords.id,
          paymentStatus: paymentRecords.status,
          paymentSource: paymentRecords.paymentSource,
          paymentCurrency: paymentRecords.currency,
          preAuthAmountCents: paymentRecords.preAuthAmountCents,
          capturedAmountCents: paymentRecords.capturedAmountCents,
          refundedAmountCents: paymentRecords.refundedAmountCents,
          failureReason: paymentRecords.failureReason,
        })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .leftJoin(drivers, eq(chargingSessions.driverId, drivers.id))
        .leftJoin(paymentRecords, eq(paymentRecords.sessionId, chargingSessions.id))
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
        ...session
      } = row;

      return {
        ...session,
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
        response: { 200: paginatedResponse(transactionEventItem), 404: errorResponse },
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
          .orderBy(asc(transactionEvents.seqNo))
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
        response: { 200: paginatedResponse(meterValueItem), 404: errorResponse },
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
