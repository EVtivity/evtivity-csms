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
  driverTokens,
  meterValues,
  vehicles,
  vehicleEfficiencyLookup,
} from '@evtivity/database';
import { zodSchema } from '../../lib/zod-schema.js';
import { ID_PARAMS } from '../../lib/id-validation.js';
import { paginatedResponse, itemResponse, errorWith } from '../../lib/response-schemas.js';
import { ERROR_CODES } from '../../lib/error-codes.generated.js';
import { paginationQuery } from '../../lib/pagination.js';
import type { PaginatedResponse } from '../../lib/pagination.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';

const portalSessionListItem = z
  .object({
    id: z.string().describe('Charging session ID (nanoid prefixed with ses_)'),
    transactionId: z.string().nullable().describe('OCPP transaction ID assigned by the station'),
    status: z
      .string()
      .max(50)
      .describe('Session status (active, completed, failed, faulted, etc.)'),
    startedAt: z.coerce.date().describe('Session start timestamp'),
    endedAt: z.coerce.date().nullable().describe('Session end timestamp, null when active'),
    energyDeliveredWh: z.coerce
      .number()
      .min(0)
      .nullable()
      .describe('Energy delivered in Watt-hours'),
    co2AvoidedKg: z.coerce.number().nullable().describe('CO2 avoided vs gasoline in kg'),
    finalCostCents: z.number().int().min(0).nullable().describe('Final session cost in cents'),
    currency: z.string().length(3).nullable().describe('ISO 4217 currency code'),
    stationName: z.string().max(255).nullable().describe('OCPP station identity (display name)'),
    siteName: z.string().max(255).nullable().describe('Site name'),
    siteAddress: z.string().max(500).nullable().describe('Street address'),
    siteCity: z.string().max(100).nullable().describe('City'),
    siteState: z.string().max(100).nullable().describe('State or region'),
    reservationId: z
      .string()
      .nullable()
      .describe('Reservation ID this session was started from, if any'),
  })
  .passthrough();

const paymentRecordItem = z
  .object({
    id: z.number().int().min(1).describe('Payment record ID'),
    status: z
      .string()
      .max(50)
      .describe(
        'Payment status (pending, authorized, captured, partially_refunded, refunded, failed)',
      ),
    currency: z.string().length(3).describe('ISO 4217 currency code'),
    preAuthAmountCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Pre-authorized amount in cents'),
    capturedAmountCents: z.number().int().min(0).nullable().describe('Captured amount in cents'),
    refundedAmountCents: z.number().int().min(0).describe('Refunded amount in cents'),
    paymentSource: z
      .string()
      .max(20)
      .describe('Source channel (web_portal, guest, terminal, etc.)'),
    failureReason: z
      .string()
      .max(500)
      .nullable()
      .describe('Failure reason if the payment did not capture'),
    createdAt: z.coerce.date().describe('Timestamp the payment record was created'),
    updatedAt: z.coerce.date().describe('Timestamp the payment record was last updated'),
  })
  .passthrough();

const portalSessionDetail = portalSessionListItem
  .extend({
    currentCostCents: z.number().int().min(0).nullable().describe('Running cost in cents'),
    meterStart: z.string().nullable().describe('Meter reading at session start in Wh'),
    meterStop: z.string().nullable().describe('Meter reading at session end in Wh'),
    stoppedReason: z
      .string()
      .max(100)
      .nullable()
      .describe('Reason the session ended (Local, Remote, EVDisconnected, etc.)'),
    driverId: z.string().nullable().describe('Driver ID that owns the session'),
    updatedAt: z.coerce.date().describe('Last time the session row was updated'),
    idleStartedAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp the EV stopped drawing power, used to bill idle fees'),
    currentPowerW: z
      .number()
      .min(0)
      .nullable()
      .describe('Most recent active power reading in Watts'),
    payment: paymentRecordItem.nullable().describe('Linked payment record, if any'),
    token: z
      .object({
        idToken: z.string().describe('RFID UID or token identifier transmitted by the station'),
        tokenType: z.string().describe('OCPP IdToken type (e.g. ISO14443, Central, eMAID)'),
      })
      .passthrough()
      .nullable()
      .describe('RFID/token used to authorize this session, null when not from a registered token'),
    vehicle: z
      .object({
        id: z.string().describe('Vehicle ID'),
        make: z.string().nullable().describe('Vehicle make'),
        model: z.string().nullable().describe('Vehicle model'),
        year: z.string().nullable().describe('Vehicle year'),
        efficiencyMiPerKwh: z
          .number()
          .min(0)
          .describe('Resolved efficiency for this vehicle make/model (mi/kWh)'),
      })
      .passthrough()
      .nullable()
      .describe('Vehicle linked to this session for distance estimation'),
  })
  .passthrough();

const powerHistoryItem = z
  .object({
    timestamp: z.coerce.date().describe('Meter sample timestamp'),
    powerW: z.number().min(0).describe('Active power in Watts'),
  })
  .passthrough();

const energyHistoryItem = z
  .object({
    timestamp: z.coerce.date().describe('Meter sample timestamp'),
    energyWh: z
      .number()
      .min(0)
      .describe('Cumulative energy delivered in Watt-hours since session start'),
  })
  .passthrough();

const sessionParams = z.object({
  id: ID_PARAMS.sessionId.describe('Charging session ID'),
});

// The regex pins format. The refine pins range so requests like ?month=9999-99
// or ?month=2024-13 are rejected at validation time instead of silently
// producing nonsense date boundaries via Date.UTC overflow.
const monthString = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .refine(
    (s) => {
      const m = Number(s.slice(5, 7));
      return m >= 1 && m <= 12;
    },
    { message: 'Month must be 01-12' },
  );

const sessionListQuery = paginationQuery.extend({
  month: monthString.optional().describe('Filter by month in YYYY-MM format'),
});

const monthlySummaryQuery = z.object({
  month: monthString.describe('Month in YYYY-MM format'),
});

const monthlySummaryResponse = z
  .object({
    totalCostCents: z
      .number()
      .int()
      .min(0)
      .describe(
        'Total cost across the month in cents. When the driver charged in more than one currency this month, this is the sum within the most-used currency only — see costBreakdown for the per-currency split.',
      ),
    totalEnergyWh: z.number().min(0).describe('Total energy delivered across the month in Wh'),
    totalCo2AvoidedKg: z.number().describe('Total CO2 avoided across the month in kg'),
    sessionCount: z.number().int().min(0).describe('Number of completed sessions in the month'),
    currency: z
      .string()
      .length(3)
      .nullable()
      .describe(
        'ISO 4217 currency code matching totalCostCents (the most-used currency this month, or null if no sessions had a currency).',
      ),
    costBreakdown: z
      .array(
        z
          .object({
            currency: z.string().length(3).describe('ISO 4217 currency code'),
            totalCostCents: z
              .number()
              .int()
              .min(0)
              .describe('Sum of finalCostCents in this currency'),
            sessionCount: z.number().int().min(0).describe('Number of sessions in this currency'),
          })
          .passthrough(),
      )
      .describe('Per-currency split of the month, sorted by sessionCount descending.'),
  })
  .passthrough();

const monthlyStatementSessionItem = z
  .object({
    id: z.string().describe('Charging session ID'),
    startedAt: z.coerce.date().nullable().describe('Session start timestamp'),
    endedAt: z.coerce.date().nullable().describe('Session end timestamp'),
    energyDeliveredWh: z.coerce.number().min(0).nullable().describe('Energy delivered in Wh'),
    co2AvoidedKg: z.coerce.number().nullable().describe('Estimated CO2 avoided in kg'),
    finalCostCents: z.number().int().min(0).nullable().describe('Final session cost in cents'),
    currency: z.string().length(3).nullable().describe('Currency code (ISO 4217)'),
    siteName: z.string().max(255).nullable().describe('Site name for the station'),
    siteCity: z.string().max(100).nullable().describe('Site city'),
  })
  .passthrough();

const monthlyStatementCostBreakdownItem = z
  .object({
    currency: z.string().length(3).describe('Currency code (ISO 4217)'),
    totalCostCents: z.number().int().min(0).describe('Total cost in this currency'),
    sessionCount: z.number().int().min(0).describe('Sessions in this currency'),
  })
  .passthrough();

const monthlyStatementTotals = z
  .object({
    totalCostCents: z.number().int().min(0).describe('Total cost in the primary currency in cents'),
    currency: z.string().length(3).nullable().describe('Primary currency for totalCostCents'),
    costBreakdown: z
      .array(monthlyStatementCostBreakdownItem)
      .describe('Per-currency cost split when sessions cross currencies'),
    totalEnergyWh: z.number().min(0).describe('Total energy delivered across the statement in Wh'),
    totalCo2AvoidedKg: z.number().describe('Total CO2 avoided across the statement in kg'),
    sessionCount: z.number().int().min(0).describe('Number of completed sessions in the statement'),
  })
  .passthrough();

const monthlyStatementResponse = z
  .object({
    month: z.string().describe('Statement month in YYYY-MM format'),
    driverName: z.string().describe('Driver display name'),
    sessions: z.array(monthlyStatementSessionItem).describe('Itemized session list for the month'),
    totals: monthlyStatementTotals.describe('Aggregated totals for the statement'),
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
            reservationId: chargingSessions.reservationId,
          })
          .from(chargingSessions)
          .leftJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
          .leftJoin(sites, eq(chargingStations.siteId, sites.id))
          .where(whereClause)
          .orderBy(desc(chargingSessions.createdAt), desc(chargingSessions.id))
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

      // Aggregate energy and CO2 globally (currency-independent) and split the
      // cost by currency. Summing finalCostCents across mixed currencies would
      // produce a nonsense total (e.g. 50 USD + 30 EUR = "80") and rendering
      // it under any single currency symbol misleads the driver about what
      // they actually paid. Most drivers charge in one currency so the
      // breakdown is a single-entry array; cross-border drivers see each
      // currency separately.
      const [totals] = await db
        .select({
          totalEnergyWh: sql<string>`COALESCE(SUM(${chargingSessions.energyDeliveredWh}::numeric), 0)::numeric`,
          totalCo2AvoidedKg: sql<string>`COALESCE(SUM(${chargingSessions.co2AvoidedKg}::numeric), 0)::numeric`,
        })
        .from(chargingSessions)
        .where(
          sql`${chargingSessions.driverId} = ${driverId} AND ${chargingSessions.status} = 'completed' AND ${chargingSessions.startedAt} >= ${start} AND ${chargingSessions.startedAt} < ${end}`,
        );

      const breakdownRows = await db
        .select({
          currency: chargingSessions.currency,
          totalCostCents: sql<number>`COALESCE(SUM(${chargingSessions.finalCostCents}), 0)::int`,
          sessionCount: sql<number>`count(*)::int`,
        })
        .from(chargingSessions)
        .where(
          sql`${chargingSessions.driverId} = ${driverId} AND ${chargingSessions.status} = 'completed' AND ${chargingSessions.startedAt} >= ${start} AND ${chargingSessions.startedAt} < ${end}`,
        )
        .groupBy(chargingSessions.currency);

      const costBreakdown = breakdownRows
        .filter(
          (r): r is { currency: string; totalCostCents: number; sessionCount: number } =>
            r.currency != null,
        )
        .sort((a, b) => b.sessionCount - a.sessionCount);

      const primary = costBreakdown[0];
      const totalSessionCount = breakdownRows.reduce((acc, r) => acc + r.sessionCount, 0);

      return {
        totalCostCents: primary?.totalCostCents ?? 0,
        totalEnergyWh: parseFloat(totals?.totalEnergyWh ?? '0'),
        totalCo2AvoidedKg: parseFloat(totals?.totalCo2AvoidedKg ?? '0'),
        sessionCount: totalSessionCount,
        currency: primary?.currency ?? null,
        costBreakdown,
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

      // Group cost by currency so cross-currency drivers don't see a nonsense
      // mixed-currency sum (mirrors monthly-summary). Primary currency = the
      // one with the most sessions; totalCostCents reports that currency only.
      const costByCurrency = new Map<string, { totalCostCents: number; sessionCount: number }>();
      let totalEnergyWh = 0;
      let totalCo2AvoidedKg = 0;
      for (const s of sessions) {
        totalEnergyWh += Number(s.energyDeliveredWh ?? 0);
        totalCo2AvoidedKg += Number(s.co2AvoidedKg ?? 0);
        if (s.currency != null) {
          const entry = costByCurrency.get(s.currency) ?? { totalCostCents: 0, sessionCount: 0 };
          entry.totalCostCents += s.finalCostCents ?? 0;
          entry.sessionCount += 1;
          costByCurrency.set(s.currency, entry);
        }
      }
      const costBreakdown = Array.from(costByCurrency.entries())
        .map(([currency, v]) => ({ currency, ...v }))
        .sort((a, b) => b.sessionCount - a.sessionCount);
      const primary = costBreakdown[0];

      return {
        month,
        driverName: driver != null ? `${driver.firstName} ${driver.lastName}` : '--',
        sessions,
        totals: {
          totalCostCents: primary?.totalCostCents ?? 0,
          currency: primary?.currency ?? null,
          costBreakdown,
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
          403: errorWith('Forbidden', [ERROR_CODES.FORBIDDEN]),
          404: errorWith('Session not found', [ERROR_CODES.SESSION_NOT_FOUND]),
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
          reservationId: chargingSessions.reservationId,
          tokenIdToken: driverTokens.idToken,
          tokenType: driverTokens.tokenType,
          vehicleId: chargingSessions.vehicleId,
          vehicleMake: vehicles.make,
          vehicleModel: vehicles.model,
          vehicleYear: vehicles.year,
        })
        .from(chargingSessions)
        .leftJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .leftJoin(driverTokens, eq(chargingSessions.tokenId, driverTokens.id))
        .leftJoin(vehicles, eq(chargingSessions.vehicleId, vehicles.id))
        .where(eq(chargingSessions.id, id));

      if (session == null) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      if (session.driverId !== driverId) {
        await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
        return;
      }

      const [payment, latestPower, latestSoc, vehicleEfficiency] = await Promise.all([
        // Only return display-safe fields. The full payment_records row
        // contains stripe_customer_id, stripe_payment_method_id, and
        // stripe_payment_intent_id which the portal does not need; surfacing
        // them is the same defense-in-depth issue the payment-methods list
        // was just fixed for.
        db
          .select({
            id: paymentRecords.id,
            status: paymentRecords.status,
            currency: paymentRecords.currency,
            preAuthAmountCents: paymentRecords.preAuthAmountCents,
            capturedAmountCents: paymentRecords.capturedAmountCents,
            refundedAmountCents: paymentRecords.refundedAmountCents,
            paymentSource: paymentRecords.paymentSource,
            failureReason: paymentRecords.failureReason,
            createdAt: paymentRecords.createdAt,
            updatedAt: paymentRecords.updatedAt,
          })
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
        session.vehicleId != null && session.vehicleMake != null && session.vehicleModel != null
          ? db
              .select({ efficiencyMiPerKwh: vehicleEfficiencyLookup.efficiencyMiPerKwh })
              .from(vehicleEfficiencyLookup)
              .where(
                and(
                  sql`LOWER(${vehicleEfficiencyLookup.make}) = LOWER(${session.vehicleMake})`,
                  sql`LOWER(${vehicleEfficiencyLookup.model}) = LOWER(${session.vehicleModel})`,
                ),
              )
              .limit(1)
              .then((r) => r[0])
          : Promise.resolve(undefined),
      ]);

      const DEFAULT_EFFICIENCY = 3.5;
      const {
        tokenIdToken,
        tokenType,
        vehicleId,
        vehicleMake,
        vehicleModel,
        vehicleYear,
        ...sessionRest
      } = session;
      return {
        ...sessionRest,
        currentPowerW: latestPower != null ? parseFloat(latestPower.value) : null,
        batteryPercent: latestSoc != null ? parseFloat(latestSoc.value) : null,
        payment: payment ?? null,
        token: tokenIdToken != null ? { idToken: tokenIdToken, tokenType: tokenType ?? '' } : null,
        vehicle:
          vehicleId != null
            ? {
                id: vehicleId,
                make: vehicleMake,
                model: vehicleModel,
                year: vehicleYear,
                efficiencyMiPerKwh:
                  vehicleEfficiency != null
                    ? Number(vehicleEfficiency.efficiencyMiPerKwh)
                    : DEFAULT_EFFICIENCY,
              }
            : null,
      };
    },
  );

  app.patch(
    '/portal/sessions/:id/vehicle',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Sessions'],
        summary: 'Set or clear the vehicle linked to a session',
        operationId: 'portalSetSessionVehicle',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionParams),
        body: zodSchema(
          z.object({
            vehicleId: ID_PARAMS.vehicleId
              .nullable()
              .describe('Vehicle ID to link, or null to unlink'),
          }),
        ),
        response: {
          200: itemResponse(
            z
              .object({
                vehicleId: z.string().nullable().describe('Linked vehicle ID after update'),
              })
              .passthrough(),
          ),
          403: errorWith('Forbidden', [ERROR_CODES.FORBIDDEN]),
          404: errorWith('Not found', [
            ERROR_CODES.SESSION_NOT_FOUND,
            ERROR_CODES.VEHICLE_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof sessionParams>;
      const { vehicleId } = request.body as { vehicleId: string | null };

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

      if (vehicleId != null) {
        const [vehicle] = await db
          .select({ driverId: vehicles.driverId })
          .from(vehicles)
          .where(eq(vehicles.id, vehicleId));
        if (vehicle == null) {
          await reply.status(404).send({ error: 'Vehicle not found', code: 'VEHICLE_NOT_FOUND' });
          return;
        }
        if (vehicle.driverId !== driverId) {
          await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
          return;
        }
      }

      await db
        .update(chargingSessions)
        .set({ vehicleId, updatedAt: new Date() })
        .where(eq(chargingSessions.id, id));

      return { vehicleId };
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
          200: itemResponse(
            z
              .object({
                data: z.array(powerHistoryItem).describe('Time-ordered power samples'),
              })
              .passthrough(),
          ),
          403: errorWith('Forbidden', [ERROR_CODES.FORBIDDEN]),
          404: errorWith('Session not found', [ERROR_CODES.SESSION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof sessionParams>;

      const [session] = await db
        .select({
          driverId: chargingSessions.driverId,
          startedAt: chargingSessions.startedAt,
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

      const rows = await db
        .select({
          timestamp: meterValues.timestamp,
          powerW: sql<number>`${meterValues.value}::double precision`,
        })
        .from(meterValues)
        .where(and(eq(meterValues.sessionId, id), eq(meterValues.measurand, 'Power.Active.Import')))
        .orderBy(asc(meterValues.timestamp));

      // Prepend a synthetic 0-point at session start so the chart renders as
      // soon as the first MeterValue arrives (one real + one synthetic = 2
      // points, the chart's render threshold). Stations typically send the
      // first MeterValue ~30s after start; without this, the chart waits for
      // a second MeterValue (~60s), which feels broken on the portal.
      if (session.startedAt != null) {
        return { data: [{ timestamp: session.startedAt, powerW: 0 }, ...rows] };
      }

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
          200: itemResponse(
            z
              .object({
                data: z.array(energyHistoryItem).describe('Time-ordered cumulative energy samples'),
              })
              .passthrough(),
          ),
          403: errorWith('Forbidden', [ERROR_CODES.FORBIDDEN]),
          404: errorWith('Session not found', [ERROR_CODES.SESSION_NOT_FOUND]),
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
          startedAt: chargingSessions.startedAt,
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

      // Prepend a synthetic 0-point at session start (delta from meterStart is
      // 0 by definition). Same rationale as power-history: chart renders after
      // the first real MeterValue instead of waiting for the second.
      if (session.startedAt != null) {
        return { data: [{ timestamp: session.startedAt, energyWh: 0 }, ...rows] };
      }

      return { data: rows };
    },
  );
}
