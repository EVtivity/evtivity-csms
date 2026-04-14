// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, sql, desc, and, asc } from 'drizzle-orm';
import { db } from '@evtivity/database';
import {
  chargingSessions,
  chargingStations,
  sites,
  paymentRecords,
  drivers,
  meterValues,
} from '@evtivity/database';
import { zodSchema } from '../../lib/zod-schema.js';
import { ID_PARAMS } from '../../lib/id-validation.js';
import { errorResponse, paginatedResponse, itemResponse } from '../../lib/response-schemas.js';
import { paginationQuery } from '../../lib/pagination.js';
import type { PaginatedResponse } from '../../lib/pagination.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';

const portalSessionListItem = z
  .object({
    id: z.string(),
    transactionId: z.string().nullable(),
    status: z.string(),
    startedAt: z.coerce.date(),
    endedAt: z.coerce.date().nullable(),
    energyDeliveredWh: z.coerce.number().nullable(),
    co2AvoidedKg: z.coerce.number().nullable(),
    finalCostCents: z.number().nullable(),
    currency: z.string().nullable(),
    stationName: z.string().nullable(),
    siteName: z.string().nullable(),
    siteAddress: z.string().nullable(),
    siteCity: z.string().nullable(),
    siteState: z.string().nullable(),
  })
  .passthrough();

const paymentRecordItem = z
  .object({
    id: z.number(),
    sessionId: z.string().nullable(),
    driverId: z.string().nullable(),
    status: z.string(),
    currency: z.string(),
    preAuthAmountCents: z.number().nullable(),
    capturedAmountCents: z.number().nullable(),
    stripePaymentIntentId: z.string().nullable(),
    createdAt: z.coerce.date(),
  })
  .passthrough();

const portalSessionDetail = portalSessionListItem
  .extend({
    currentCostCents: z.number().nullable(),
    meterStart: z.string().nullable(),
    meterStop: z.string().nullable(),
    stoppedReason: z.string().nullable(),
    driverId: z.string().nullable(),
    updatedAt: z.coerce.date(),
    idleStartedAt: z.coerce.date().nullable(),
    currentPowerW: z.number().nullable(),
    payment: paymentRecordItem.nullable(),
  })
  .passthrough();

const powerHistoryItem = z
  .object({
    timestamp: z.coerce.date(),
    powerW: z.number(),
  })
  .passthrough();

const energyHistoryItem = z
  .object({
    timestamp: z.coerce.date(),
    energyWh: z.number(),
  })
  .passthrough();

const sessionParams = z.object({
  id: ID_PARAMS.sessionId.describe('Charging session ID'),
});

const sessionListQuery = paginationQuery.extend({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional()
    .describe('Filter by month in YYYY-MM format'),
});

const monthlySummaryQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .describe('Month in YYYY-MM format'),
});

const monthlySummaryResponse = z
  .object({
    totalCostCents: z.number(),
    totalEnergyWh: z.number(),
    totalCo2AvoidedKg: z.number(),
    sessionCount: z.number(),
    currency: z.string().nullable(),
  })
  .passthrough();

const monthlyStatementResponse = z
  .object({
    month: z.string(),
    driverName: z.string(),
    sessions: z.array(z.object({}).passthrough()),
    totals: z.object({}).passthrough(),
  })
  .passthrough();

function monthRange(month: string): { start: string; end: string } {
  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const mon = Number(monthStr);
  const start = new Date(Date.UTC(year, mon - 1, 1)).toISOString();
  const end = new Date(Date.UTC(year, mon, 1)).toISOString();
  return { start, end };
}

export function portalSessionRoutes(app: FastifyInstance): void {
  app.get(
    '/portal/sessions',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Sessions'],
        summary: 'List charging sessions for the driver',
        operationId: 'portalListSessions',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(sessionListQuery),
        response: { 200: paginatedResponse(portalSessionListItem) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      const query = request.query as z.infer<typeof sessionListQuery>;
      const { page, limit, month } = query;
      const offset = (page - 1) * limit;

      let whereClause = sql`${chargingSessions.driverId} = ${driverId}`;
      if (month != null) {
        const { start, end } = monthRange(month);
        whereClause = sql`${chargingSessions.driverId} = ${driverId} AND ${chargingSessions.startedAt} >= ${start} AND ${chargingSessions.startedAt} < ${end}`;
      }

      const [data, countRows] = await Promise.all([
        db
          .select({
            id: chargingSessions.id,
            transactionId: chargingSessions.transactionId,
            status: chargingSessions.status,
            startedAt: chargingSessions.startedAt,
            endedAt: chargingSessions.endedAt,
            energyDeliveredWh: chargingSessions.energyDeliveredWh,
            co2AvoidedKg: chargingSessions.co2AvoidedKg,
            finalCostCents: chargingSessions.finalCostCents,
            currency: chargingSessions.currency,
            stationName: chargingStations.stationId,
            siteName: sites.name,
            siteAddress: sites.address,
            siteCity: sites.city,
            siteState: sites.state,
          })
          .from(chargingSessions)
          .leftJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
          .leftJoin(sites, eq(chargingStations.siteId, sites.id))
          .where(whereClause)
          .orderBy(desc(chargingSessions.startedAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(chargingSessions)
          .where(whereClause),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  app.get(
    '/portal/sessions/monthly-summary',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Sessions'],
        summary: 'Get monthly charging summary',
        operationId: 'portalGetMonthlySummary',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(monthlySummaryQuery),
        response: { 200: itemResponse(monthlySummaryResponse) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { month } = request.query as z.infer<typeof monthlySummaryQuery>;
      const { start, end } = monthRange(month);

      const [result] = await db
        .select({
          totalCostCents: sql<number>`COALESCE(SUM(${chargingSessions.finalCostCents}), 0)::int`,
          totalEnergyWh: sql<string>`COALESCE(SUM(${chargingSessions.energyDeliveredWh}::numeric), 0)::numeric`,
          totalCo2AvoidedKg: sql<string>`COALESCE(SUM(${chargingSessions.co2AvoidedKg}::numeric), 0)::numeric`,
          sessionCount: sql<number>`count(*)::int`,
          currency: sql<string | null>`MAX(${chargingSessions.currency})`,
        })
        .from(chargingSessions)
        .where(
          sql`${chargingSessions.driverId} = ${driverId} AND ${chargingSessions.status} = 'completed' AND ${chargingSessions.startedAt} >= ${start} AND ${chargingSessions.startedAt} < ${end}`,
        );

      return {
        totalCostCents: result?.totalCostCents ?? 0,
        totalEnergyWh: parseFloat(result?.totalEnergyWh ?? '0'),
        totalCo2AvoidedKg: parseFloat(result?.totalCo2AvoidedKg ?? '0'),
        sessionCount: result?.sessionCount ?? 0,
        currency: result?.currency ?? null,
      };
    },
  );

  app.get(
    '/portal/sessions/monthly-statement',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Sessions'],
        summary: 'Get monthly statement with itemized sessions',
        operationId: 'portalGetMonthlyStatement',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(monthlySummaryQuery),
        response: { 200: itemResponse(monthlyStatementResponse) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { month } = request.query as z.infer<typeof monthlySummaryQuery>;
      const { start, end } = monthRange(month);

      const [driver] = await db
        .select({ firstName: drivers.firstName, lastName: drivers.lastName })
        .from(drivers)
        .where(eq(drivers.id, driverId));

      const sessions = await db
        .select({
          id: chargingSessions.id,
          startedAt: chargingSessions.startedAt,
          endedAt: chargingSessions.endedAt,
          energyDeliveredWh: chargingSessions.energyDeliveredWh,
          co2AvoidedKg: chargingSessions.co2AvoidedKg,
          finalCostCents: chargingSessions.finalCostCents,
          currency: chargingSessions.currency,
          siteName: sites.name,
          siteCity: sites.city,
        })
        .from(chargingSessions)
        .leftJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(
          sql`${chargingSessions.driverId} = ${driverId} AND ${chargingSessions.status} = 'completed' AND ${chargingSessions.startedAt} >= ${start} AND ${chargingSessions.startedAt} < ${end}`,
        )
        .orderBy(desc(chargingSessions.startedAt));

      let totalCostCents = 0;
      let totalEnergyWh = 0;
      let totalCo2AvoidedKg = 0;
      for (const s of sessions) {
        totalCostCents += s.finalCostCents ?? 0;
        totalEnergyWh += Number(s.energyDeliveredWh ?? 0);
        totalCo2AvoidedKg += Number(s.co2AvoidedKg ?? 0);
      }

      return {
        month,
        driverName: driver != null ? `${driver.firstName} ${driver.lastName}` : '--',
        sessions,
        totals: {
          totalCostCents,
          totalEnergyWh,
          totalCo2AvoidedKg,
          sessionCount: sessions.length,
        },
      };
    },
  );

  app.get(
    '/portal/sessions/:id',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Sessions'],
        summary: 'Get charging session details with payment info',
        operationId: 'portalGetSession',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionParams),
        response: {
          200: itemResponse(portalSessionDetail),
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof sessionParams>;

      const [session] = await db
        .select({
          id: chargingSessions.id,
          transactionId: chargingSessions.transactionId,
          status: chargingSessions.status,
          startedAt: chargingSessions.startedAt,
          endedAt: chargingSessions.endedAt,
          energyDeliveredWh: chargingSessions.energyDeliveredWh,
          co2AvoidedKg: chargingSessions.co2AvoidedKg,
          currentCostCents: chargingSessions.currentCostCents,
          finalCostCents: chargingSessions.finalCostCents,
          currency: chargingSessions.currency,
          meterStart: chargingSessions.meterStart,
          meterStop: chargingSessions.meterStop,
          stoppedReason: chargingSessions.stoppedReason,
          stationName: chargingStations.stationId,
          siteName: sites.name,
          siteAddress: sites.address,
          siteCity: sites.city,
          siteState: sites.state,
          driverId: chargingSessions.driverId,
          updatedAt: chargingSessions.updatedAt,
          idleStartedAt: chargingSessions.idleStartedAt,
        })
        .from(chargingSessions)
        .leftJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(eq(chargingSessions.id, id));

      if (session == null) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      if (session.driverId !== driverId) {
        await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
        return;
      }

      const [payment, latestPower, latestSoc] = await Promise.all([
        db
          .select()
          .from(paymentRecords)
          .where(eq(paymentRecords.sessionId, id))
          .then((r) => r[0]),
        db
          .select({ value: meterValues.value })
          .from(meterValues)
          .where(
            and(eq(meterValues.sessionId, id), eq(meterValues.measurand, 'Power.Active.Import')),
          )
          .orderBy(desc(meterValues.timestamp))
          .limit(1)
          .then((r) => r[0]),
        db
          .select({ value: meterValues.value })
          .from(meterValues)
          .where(and(eq(meterValues.sessionId, id), eq(meterValues.measurand, 'SoC')))
          .orderBy(desc(meterValues.timestamp))
          .limit(1)
          .then((r) => r[0]),
      ]);

      return {
        ...session,
        currentPowerW: latestPower != null ? parseFloat(latestPower.value) : null,
        batteryPercent: latestSoc != null ? parseFloat(latestSoc.value) : null,
        payment: payment ?? null,
      };
    },
  );

  app.get(
    '/portal/sessions/:id/power-history',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Sessions'],
        summary: 'Get power meter value history for a session',
        operationId: 'portalGetSessionPowerHistory',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionParams),
        response: {
          200: itemResponse(z.object({ data: z.array(powerHistoryItem) }).passthrough()),
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof sessionParams>;

      const [session] = await db
        .select({ driverId: chargingSessions.driverId })
        .from(chargingSessions)
        .where(eq(chargingSessions.id, id));

      if (session == null) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      if (session.driverId !== driverId) {
        await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
        return;
      }

      const rows = await db
        .select({
          timestamp: meterValues.timestamp,
          powerW: sql<number>`${meterValues.value}::double precision`,
        })
        .from(meterValues)
        .where(and(eq(meterValues.sessionId, id), eq(meterValues.measurand, 'Power.Active.Import')))
        .orderBy(asc(meterValues.timestamp));

      return { data: rows };
    },
  );

  app.get(
    '/portal/sessions/:id/energy-history',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Sessions'],
        summary: 'Get energy meter value history for a session',
        operationId: 'portalGetSessionEnergyHistory',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionParams),
        response: {
          200: itemResponse(z.object({ data: z.array(energyHistoryItem) }).passthrough()),
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof sessionParams>;

      const [session] = await db
        .select({
          driverId: chargingSessions.driverId,
          meterStart: chargingSessions.meterStart,
        })
        .from(chargingSessions)
        .where(eq(chargingSessions.id, id));

      if (session == null) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      if (session.driverId !== driverId) {
        await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
        return;
      }

      const meterStart = session.meterStart ?? 0;

      const rows = await db
        .select({
          timestamp: meterValues.timestamp,
          energyWh: sql<number>`(${meterValues.value}::double precision - ${meterStart})`,
        })
        .from(meterValues)
        .where(
          and(
            eq(meterValues.sessionId, id),
            eq(meterValues.measurand, 'Energy.Active.Import.Register'),
          ),
        )
        .orderBy(asc(meterValues.timestamp));

      return { data: rows };
    },
  );
}
