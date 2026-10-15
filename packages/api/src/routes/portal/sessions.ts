// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, sql, desc, and, asc } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  db,
  getCompanyCurrency,
  inOperatorStation,
  isAutochargeEnabledForStation,
  writeAudit,
  sessionAuditLog,
} from '@evtivity/database';
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
import { parseZodRequest, zodSchema } from '../../lib/zod-schema.js';
import * as vehicleService from '../../services/vehicle.service.js';
import {
  replyVehicleServiceError,
  sessionVehicleCaptureItem,
  vehicleClaimBody,
} from '../../lib/vehicle-response.js';
import { inCompanyCurrency, sessionCurrencySql } from '@evtivity/services/company-currency';
import { isValidTimezone, storedSessionCostTax } from '@evtivity/lib';
import { sessionLimitReached } from '../../lib/session-limit.js';
import { ID_PARAMS } from '../../lib/id-validation.js';
import { getAuditActor } from '../../lib/audit-actor.js';
import { paginatedResponse, itemResponse, errorWith } from '../../lib/response-schemas.js';
import { ERROR_CODES } from '../../lib/error-codes.generated.js';
import { paginationQuery } from '../../lib/pagination.js';
import type { PaginatedResponse } from '../../lib/pagination.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';
import {
  billedToFleetSql,
  sessionAccountBillingColumns,
  sessionAccountBillingSchema,
  withAccountBilling,
} from '../../lib/portal-billing.js';

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
    finalCostCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Final session cost in cents, including tax'),
    taxCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe(
        'Tax contained in the cost, in cents, as stored with it (exact per tariff segment). Above 0 when the cost includes tax; null for a session without a stored split',
      ),
    currency: z.string().length(3).describe('ISO 4217 currency code the session was billed in'),
    stationName: z.string().max(255).nullable().describe('OCPP station identity (display name)'),
    siteName: z.string().max(255).nullable().describe('Site name'),
    siteAddress: z.string().max(500).nullable().describe('Street address'),
    siteCity: z.string().max(100).nullable().describe('City'),
    siteState: z.string().max(100).nullable().describe('State or region'),
    reservationId: z
      .string()
      .nullable()
      .describe('Reservation ID this session was started from, if any'),
    accountBilling: sessionAccountBillingSchema
      .nullable()
      .describe(
        'Set when the session is billed to a fleet (charge on account): the billing state and the fleet. Null for a session paid by card or not billed',
      ),
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
      .describe(
        'Who started the payment: web_portal (driver), guest, prepaid, ocpp_terminal, or operator (re-bill and reservation fee charges)',
      ),
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
    netCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe(
        'Cost (finalCostCents, else currentCostCents) without the tax it contains, in cents. Null when taxCents is null',
      ),
    taxCents: z
      .number()
      .int()
      .min(1)
      .nullable()
      .describe(
        'Tax contained in the cost (finalCostCents, else currentCostCents) in cents, split per tax rate as billed. Null when the cost contains no tax, or when tariffs with different tax rates applied and the split is not known yet',
      ),
    taxRate: z
      .string()
      .nullable()
      .describe(
        'Tax rate of taxCents as a decimal (e.g. 0.19). Null without taxCents or when tariffs with different tax rates applied',
      ),
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
    limitReached: z
      .enum(['cost', 'energy', 'time'])
      .nullable()
      .optional()
      .describe(
        'Transaction limit the station reported reaching (cost: the hold or prepaid amount, energy, time); it then suspends charging. Null when none',
      ),
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
        vin: z.string().nullable().describe('VIN stored on the vehicle'),
        evccid: z.string().nullable().describe('EVCCID (MAC address) stored on the vehicle'),
        autochargeEnabled: z.boolean().describe('Autocharge is on for the vehicle'),
        efficiencyMiPerKwh: z
          .number()
          .min(0)
          .describe('Resolved efficiency for this vehicle make/model (mi/kWh)'),
      })
      .passthrough()
      .nullable()
      .describe('Vehicle linked to this session for distance estimation'),
    vehicleCapture: sessionVehicleCaptureItem,
    autocharge: z
      .boolean()
      .describe('The session was started by an Autocharge vehicle (charge by plugging in)'),
    autochargeAvailable: z
      .boolean()
      .describe(
        "Autocharge is on at the session's site, so the driver can use the captured vehicle id for plug-in charging",
      ),
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

// The regex pins both format and month range, so requests like ?month=9999-99
// or ?month=2024-13 are rejected at validation time instead of silently
// producing nonsense date boundaries via Date.UTC overflow. It is a regex, not
// a refine, because Ajv validates the JSON Schema and refines are dropped.
const monthString = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const sessionListQuery = paginationQuery.extend({
  month: monthString
    .optional()
    .describe("Filter by month in YYYY-MM format, in the driver's timezone"),
});

const monthlySummaryQuery = z.object({
  month: monthString.describe("Month in YYYY-MM format, in the driver's timezone"),
});

const monthlySummaryResponse = z
  .object({
    totalCostCents: z
      .number()
      .int()
      .min(0)
      .describe(
        'Total cost of completed sessions in the month, in cents. Sums only sessions billed in the company currency, and leaves out sessions invoiced to a fleet.',
      ),
    totalEnergyWh: z.number().min(0).describe('Total energy delivered across the month in Wh'),
    totalCo2AvoidedKg: z.number().describe('Total CO2 avoided across the month in kg'),
    sessionCount: z.number().int().min(0).describe('Number of completed sessions in the month'),
    currency: z.string().length(3).describe('Company currency (ISO 4217) of totalCostCents'),
  })
  .passthrough();

const monthlyStatementSessionItem = z
  .object({
    id: z.string().describe('Charging session ID'),
    startedAt: z.coerce.date().nullable().describe('Session start timestamp'),
    endedAt: z.coerce.date().nullable().describe('Session end timestamp'),
    energyDeliveredWh: z.coerce.number().min(0).nullable().describe('Energy delivered in Wh'),
    co2AvoidedKg: z.coerce.number().nullable().describe('Estimated CO2 avoided in kg'),
    finalCostCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Final session cost in cents, including tax'),
    taxCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe(
        'Tax contained in finalCostCents, in cents, as stored with it. Above 0 when the cost includes tax',
      ),
    currency: z.string().length(3).describe('Currency code (ISO 4217) the session was billed in'),
    siteName: z
      .string()
      .max(255)
      .nullable()
      .describe('Name of the site the session happened at (else the station site)'),
    siteCity: z.string().max(100).nullable().describe('Site city'),
    accountBilling: sessionAccountBillingSchema
      .nullable()
      .describe(
        'Set when the session is billed to a fleet (charge on account). A session invoiced to the fleet (invoicedTo fleet) is not in totalCostCents',
      ),
  })
  .passthrough();

const monthlyStatementTotals = z
  .object({
    totalCostCents: z
      .number()
      .int()
      .min(0)
      .describe(
        'Total cost of the statement sessions the driver pays, in cents. Sums only sessions billed in the company currency, and leaves out sessions invoiced to a fleet.',
      ),
    currency: z.string().length(3).describe('Company currency (ISO 4217) of totalCostCents'),
    totalEnergyWh: z.number().min(0).describe('Total energy delivered across the statement in Wh'),
    totalCo2AvoidedKg: z.number().describe('Total CO2 avoided across the statement in kg'),
    sessionCount: z.number().int().min(0).describe('Number of completed sessions in the statement'),
    otherCurrencySessionCount: z
      .number()
      .int()
      .min(0)
      .describe(
        'Sessions billed in a currency other than the company currency (an earlier one), left out of totalCostCents',
      ),
    fleetBilledSessionCount: z
      .number()
      .int()
      .min(0)
      .describe('Sessions invoiced to a fleet, left out of totalCostCents'),
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

/**
 * The driver's timezone, in which a month starts and ends for the driver
 * (owner decision 2026-10-14). The column is required; a value Postgres would
 * not know falls back to UTC.
 */
async function driverTimezone(driverId: string): Promise<string> {
  const [row] = await db
    .select({ timezone: drivers.timezone })
    .from(drivers)
    .where(eq(drivers.id, driverId));
  const tz = row?.timezone;
  return tz != null && isValidTimezone(tz) ? tz : 'UTC';
}

/**
 * Sessions started in `month` (YYYY-MM) as the driver's calendar shows it:
 * from local midnight on the first day to local midnight on the first day of
 * the next month, in the driver's timezone.
 */
function startedInMonth(month: string, timezone: string): SQL {
  const firstDay = `${month}-01`;
  return sql`${chargingSessions.startedAt} >= (${firstDay}::date::timestamp AT TIME ZONE ${timezone})
    AND ${chargingSessions.startedAt} < ((${firstDay}::date + interval '1 month')::timestamp AT TIME ZONE ${timezone})`;
}

/**
 * The site of a session: the site it happened at, else (a row from before the
 * site history, or a deleted site) the station's current site.
 */
const sessionSiteJoin = sql`${sites.id} = COALESCE(${chargingSessions.siteId}, ${chargingStations.siteId})`;

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

      // Sessions at conformance (OCTT) stations are never listed.
      let whereClause = sql`${chargingSessions.driverId} = ${driverId} AND ${inOperatorStation(chargingSessions.stationId)}`;
      if (month != null) {
        const timezone = await driverTimezone(driverId);
        whereClause = sql`${whereClause} AND ${startedInMonth(month, timezone)}`;
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
            taxCents: chargingSessions.taxCents,
            currency: sessionCurrencySql(),
            stationName: chargingStations.stationId,
            siteName: sites.name,
            siteAddress: sites.address,
            siteCity: sites.city,
            siteState: sites.state,
            reservationId: chargingSessions.reservationId,
            ...sessionAccountBillingColumns(),
          })
          .from(chargingSessions)
          .leftJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
          .leftJoin(sites, sessionSiteJoin)
          .where(whereClause)
          .orderBy(desc(chargingSessions.createdAt), desc(chargingSessions.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(chargingSessions)
          .where(whereClause),
      ]);

      const items = data.map(withAccountBilling);
      return { data: items, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof items)[number]
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
      const timezone = await driverTimezone(driverId);

      const currency = await getCompanyCurrency();
      const [totals] = await db
        .select({
          // A session billed to a fleet is not the driver's to pay (owner
          // decision 2026-10-14), so its cost stays out of the driver's total.
          totalCostCents: sql<number>`COALESCE(SUM(${chargingSessions.finalCostCents}) FILTER (WHERE ${inCompanyCurrency(chargingSessions.currency, currency)} AND NOT ${billedToFleetSql()}), 0)::int`,
          totalEnergyWh: sql<string>`COALESCE(SUM(${chargingSessions.energyDeliveredWh}::numeric), 0)::numeric`,
          totalCo2AvoidedKg: sql<string>`COALESCE(SUM(${chargingSessions.co2AvoidedKg}::numeric), 0)::numeric`,
          sessionCount: sql<number>`count(*)::int`,
        })
        .from(chargingSessions)
        .where(
          sql`${chargingSessions.driverId} = ${driverId} AND ${chargingSessions.status} = 'completed' AND ${startedInMonth(month, timezone)} AND ${inOperatorStation(chargingSessions.stationId)}`,
        );

      return {
        totalCostCents: totals?.totalCostCents ?? 0,
        totalEnergyWh: parseFloat(totals?.totalEnergyWh ?? '0'),
        totalCo2AvoidedKg: parseFloat(totals?.totalCo2AvoidedKg ?? '0'),
        sessionCount: totals?.sessionCount ?? 0,
        currency,
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

      const [driver] = await db
        .select({
          firstName: drivers.firstName,
          lastName: drivers.lastName,
          timezone: drivers.timezone,
        })
        .from(drivers)
        .where(eq(drivers.id, driverId));
      const timezone =
        driver?.timezone != null && isValidTimezone(driver.timezone) ? driver.timezone : 'UTC';

      const companyCurrency = await getCompanyCurrency();
      const sessions = await db
        .select({
          id: chargingSessions.id,
          startedAt: chargingSessions.startedAt,
          endedAt: chargingSessions.endedAt,
          energyDeliveredWh: chargingSessions.energyDeliveredWh,
          co2AvoidedKg: chargingSessions.co2AvoidedKg,
          finalCostCents: chargingSessions.finalCostCents,
          taxCents: chargingSessions.taxCents,
          currency: sessionCurrencySql(),
          siteName: sites.name,
          siteCity: sites.city,
          ...sessionAccountBillingColumns(),
        })
        .from(chargingSessions)
        .leftJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .leftJoin(sites, sessionSiteJoin)
        .where(
          sql`${chargingSessions.driverId} = ${driverId} AND ${chargingSessions.status} = 'completed' AND ${startedInMonth(month, timezone)} AND ${inOperatorStation(chargingSessions.stationId)}`,
        )
        .orderBy(desc(chargingSessions.startedAt), desc(chargingSessions.id));

      // The cost total holds what the driver pays in the company currency. A
      // session billed to a fleet is listed as billed to it and left out
      // (owner decision 2026-10-14); a session billed in an earlier currency
      // is left out and counted, so the statement can say so (currency.md).
      const items = sessions.map(withAccountBilling);
      let totalCostCents = 0;
      let totalEnergyWh = 0;
      let totalCo2AvoidedKg = 0;
      let otherCurrencySessionCount = 0;
      let fleetBilledSessionCount = 0;
      for (const s of items) {
        if (s.accountBilling?.invoicedTo === 'fleet') fleetBilledSessionCount += 1;
        else if (s.currency !== companyCurrency) otherCurrencySessionCount += 1;
        else totalCostCents += s.finalCostCents ?? 0;
        totalEnergyWh += Number(s.energyDeliveredWh ?? 0);
        totalCo2AvoidedKg += Number(s.co2AvoidedKg ?? 0);
      }

      return {
        month,
        driverName: driver != null ? `${driver.firstName} ${driver.lastName}` : '--',
        sessions: items,
        totals: {
          totalCostCents,
          currency: companyCurrency,
          totalEnergyWh,
          totalCo2AvoidedKg,
          sessionCount: items.length,
          otherCurrencySessionCount,
          fleetBilledSessionCount,
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
          costBreakdown: chargingSessions.costBreakdown,
          currency: sessionCurrencySql(),
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
          vehicleVin: vehicles.vin,
          vehicleEvccid: vehicles.evccid,
          vehicleAutochargeEnabled: vehicles.autochargeEnabled,
          vehicleIdValue: chargingSessions.vehicleIdValue,
          vehicleIdType: chargingSessions.vehicleIdType,
          vehicleIdSource: chargingSessions.vehicleIdSource,
          autocharge: chargingSessions.autocharge,
          ocppStationId: chargingStations.stationId,
          ...sessionAccountBillingColumns(),
        })
        .from(chargingSessions)
        .leftJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .leftJoin(sites, sessionSiteJoin)
        .leftJoin(driverTokens, eq(chargingSessions.tokenId, driverTokens.id))
        .leftJoin(vehicles, eq(chargingSessions.vehicleId, vehicles.id))
        // Another driver's session answers 404 like an unknown one, so a
        // session id does not reveal that the session exists.
        .where(and(eq(chargingSessions.id, id), eq(chargingSessions.driverId, driverId)));

      if (session == null) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      const [payment, latestPower, latestSoc, vehicleEfficiency] = await Promise.all([
        // Only return display-safe fields. The full payment_records row
        // contains the provider ids (provider_payment_id, provider_customer_id,
        // provider_payment_method_id) which the portal does not need;
        // surfacing them is the same
        // defense-in-depth issue the payment-methods list was just fixed for.
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
        vehicleVin,
        vehicleEvccid,
        vehicleAutochargeEnabled,
        vehicleIdValue,
        vehicleIdType,
        vehicleIdSource,
        ocppStationId,
        autocharge,
        costBreakdown,
        ...sessionRest
      } = withAccountBilling(session);
      const vehicleCapture =
        vehicleIdValue != null && vehicleIdType != null && vehicleIdSource != null
          ? { value: vehicleIdValue, type: vehicleIdType, source: vehicleIdSource }
          : null;
      const autochargeAvailable =
        vehicleCapture != null && ocppStationId != null
          ? await isAutochargeEnabledForStation(ocppStationId)
          : false;
      const costTax = storedSessionCostTax({
        costCents: session.finalCostCents ?? session.currentCostCents,
        costBreakdown,
      });
      return {
        ...sessionRest,
        limitReached: await sessionLimitReached(id),
        currentPowerW: latestPower != null ? parseFloat(latestPower.value) : null,
        batteryPercent: latestSoc != null ? parseFloat(latestSoc.value) : null,
        payment: payment ?? null,
        netCents: costTax?.netCents ?? null,
        taxCents: costTax?.taxCents ?? null,
        taxRate: costTax?.taxRate ?? null,
        token: tokenIdToken != null ? { idToken: tokenIdToken, tokenType: tokenType ?? '' } : null,
        vehicle:
          vehicleId != null
            ? {
                id: vehicleId,
                make: vehicleMake,
                model: vehicleModel,
                year: vehicleYear,
                vin: vehicleVin ?? null,
                evccid: vehicleEvccid ?? null,
                autochargeEnabled: vehicleAutochargeEnabled === true,
                efficiencyMiPerKwh:
                  vehicleEfficiency != null
                    ? Number(vehicleEfficiency.efficiencyMiPerKwh)
                    : DEFAULT_EFFICIENCY,
              }
            : null,
        vehicleCapture,
        autocharge,
        autochargeAvailable,
      };
    },
  );

  // "Use This Vehicle for Plug-In Charging": the vehicle id the charger sent
  // for the driver's own session goes on a new or existing vehicle of the
  // driver, with Autocharge on by default (vehicle.service.ts). Another
  // driver's session answers like a missing one.
  app.post(
    '/portal/sessions/:id/vehicle-claim',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Sessions'],
        summary: 'Use the vehicle id the charger sent for this session on a vehicle',
        operationId: 'portalClaimSessionVehicleId',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionParams),
        body: zodSchema(vehicleClaimBody),
        response: {
          200: itemResponse(
            z
              .object({
                vehicleId: z.string().describe('Vehicle that now holds the id'),
                created: z.boolean().describe('A new vehicle was created'),
                autochargeEnabled: z.boolean().describe('Autocharge is on for the vehicle'),
              })
              .passthrough(),
          ),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          403: errorWith('Blocked by the operator', [ERROR_CODES.VEHICLE_BLOCKED_BY_OPERATOR]),
          404: errorWith('Not found', [
            ERROR_CODES.SESSION_NOT_FOUND,
            ERROR_CODES.VEHICLE_NOT_FOUND,
            ERROR_CODES.DRIVER_NOT_FOUND,
          ]),
          409: errorWith('No vehicle id or the id is in use', [
            ERROR_CODES.SESSION_NO_VEHICLE_ID,
            ERROR_CODES.VEHICLE_ID_IN_USE,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof sessionParams>;
      const body = parseZodRequest(vehicleClaimBody, request.body);
      try {
        const result = await vehicleService.claimSessionVehicleId(
          {
            sessionId: id,
            driverId,
            target:
              body.vehicleId != null
                ? { vehicleId: body.vehicleId }
                : { vehicle: body.vehicle ?? { make: '', model: '' } },
            enableAutocharge: body.enableAutocharge,
          },
          getAuditActor(request),
          request.log,
        );
        return {
          vehicleId: result.vehicle.id,
          created: result.created,
          autochargeEnabled: result.vehicle.autochargeEnabled,
        };
      } catch (err) {
        if (await replyVehicleServiceError(reply, err)) return;
        throw err;
      }
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
        .select({ driverId: chargingSessions.driverId, vehicleId: chargingSessions.vehicleId })
        .from(chargingSessions)
        // Another driver's session answers 404 like an unknown one, so a
        // session id does not reveal that the session exists.
        .where(and(eq(chargingSessions.id, id), eq(chargingSessions.driverId, driverId)));

      if (session == null) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }
      if (vehicleId != null) {
        const [vehicle] = await db
          .select({ driverId: vehicles.driverId })
          .from(vehicles)
          .where(eq(vehicles.id, vehicleId));
        // Another driver's vehicle answers 404 like an unknown one.
        if (vehicle?.driverId !== driverId) {
          await reply.status(404).send({ error: 'Vehicle not found', code: 'VEHICLE_NOT_FOUND' });
          return;
        }
      }

      await db
        .update(chargingSessions)
        .set({ vehicleId, updatedAt: new Date() })
        .where(and(eq(chargingSessions.id, id), eq(chargingSessions.driverId, driverId)));

      if ((session.vehicleId ?? null) !== vehicleId) {
        await writeAudit(
          { table: sessionAuditLog, idColumn: 'session_id' },
          {
            entityId: id,
            entityIdSnapshot: id,
            action: 'vehicle_changed',
            ...getAuditActor(request),
            before: { vehicleId: session.vehicleId ?? null },
            after: { vehicleId },
          },
          db,
          request.log,
        );
      }

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
        // Another driver's session answers 404 like an unknown one, so a
        // session id does not reveal that the session exists.
        .where(and(eq(chargingSessions.id, id), eq(chargingSessions.driverId, driverId)));

      if (session == null) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
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
        // Another driver's session answers 404 like an unknown one, so a
        // session id does not reveal that the session exists.
        .where(and(eq(chargingSessions.id, id), eq(chargingSessions.driverId, driverId)));

      if (session == null) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      const meterStart = session.meterStart ?? 0;

      const rows = await db
        .select({
          timestamp: meterValues.timestamp,
          // Energy registers are stored in the station's unit (Wh or kWh); meterStart is Wh.
          energyWh: sql<number>`(CASE WHEN ${meterValues.unit} = 'kWh' THEN ${meterValues.value}::double precision * 1000 ELSE ${meterValues.value}::double precision END - ${meterStart})`,
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
