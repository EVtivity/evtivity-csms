// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, and, or, ilike, desc, sql, isNotNull, inArray } from 'drizzle-orm';
import { db, SESSION_END_FAILED_REASON } from '@evtivity/database';
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
  SESSION_REBILL_STATUSES,
} from '@evtivity/database';
import { PaymentProviderUnavailableError } from '@evtivity/payments';
import { zodSchema } from '../lib/zod-schema.js';
import { sessionCurrencySql } from '@evtivity/services/company-currency';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { paginatedResponse, itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { siteInScope } from '../lib/site-scope.js';
import { pendingOperationSchema, providerRefundsSchema } from '../lib/payment-provider-schemas.js';
import type { JwtPayload } from '../plugins/auth.js';
import { authorize } from '../middleware/rbac.js';
import { getAuditActor } from '../lib/audit-actor.js';
import {
  getSessionRebillState,
  rebillSession,
  SessionRebillRefusedError,
} from '../services/session-rebill.service.js';

const rebillStatusField = z
  .enum(SESSION_REBILL_STATUSES)
  .nullable()
  .describe(
    'Operator re-bill of a session the CSMS gave up ending: in_progress, billed, or manual (to be billed outside the platform); null when never re-billed',
  );

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
    electricityCostCents: z
      .number()
      .int()
      .nullable()
      .describe("Operator's wholesale electricity cost in cents (null when no rate configured)"),
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
    currency: z.string().length(3).describe('ISO 4217 currency the session is billed in'),
    freeVend: z.boolean().describe('True when site free vend mode bypassed payment'),
    billingMode: z
      .enum(['card', 'account'])
      .nullable()
      .describe(
        'How the driver session is paid, decided once at its start: card, or account (billed to the fleet on its invoice, no card charged). Null for older sessions and for roaming, free vend, prepaid, guest and anonymous sessions.',
      ),
    rebillStatus: rebillStatusField,
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
    paymentSource: z
      .string()
      .max(50)
      .describe(
        'Who started the payment: web_portal (driver), guest, prepaid, ocpp_terminal, or operator (re-bill and reservation fee charges)',
      ),
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
    pendingOperation: pendingOperationSchema,
    providerRefunds: providerRefundsSchema,
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
    electricityCostCents: z
      .number()
      .int()
      .nullable()
      .describe("Operator's wholesale electricity cost in cents (null when no rate configured)"),
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
    currency: z.string().length(3).describe('ISO 4217 currency the session is billed in'),
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
    billingMode: z
      .enum(['card', 'account'])
      .nullable()
      .describe(
        'How the driver session is paid, decided once at its start: card, or account (billed to the fleet on its invoice, no card charged). Null for older sessions and for roaming, free vend, prepaid, guest and anonymous sessions.',
      ),
    billingFleetId: z
      .string()
      .nullable()
      .describe('The fleet an account session is billed to, null otherwise'),
    billingFleetName: z
      .string()
      .nullable()
      .describe('Name of the fleet an account session is billed to, null otherwise'),
    invoiceId: z
      .string()
      .nullable()
      .describe('The invoice that bills the session, null while it is not invoiced'),
    invoiceStatus: z
      .string()
      .nullable()
      .describe(
        'Status of that invoice (issued, paid). For an account session: no invoice means unbilled, issued means invoiced, paid means paid.',
      ),
    rebillStatus: rebillStatusField,
    rebillClaimedAt: z.coerce
      .date()
      .nullable()
      .describe(
        'When the running re-bill claimed the session (rebillStatus in_progress); a claim older than 5 minutes belongs to a request that died and may be taken over',
      ),
    stationTariffId: z
      .string()
      .nullable()
      .describe(
        'OCPP 2.1 local cost calculation: the tariffId the station last reported for the transaction (transactionInfo.tariffId), null when it reported none',
      ),
    stationCostCents: z
      .number()
      .int()
      .nullable()
      .describe(
        'The cost the station last calculated (costDetails.totalCost.total, including tax when the station sent it), in cents. The session is billed at its own cost; null when the station sent no cost details',
      ),
    stationCostDifferenceCents: z
      .number()
      .int()
      .nullable()
      .describe(
        "The station's final cost minus the billed final cost, in cents, set when the session ended with station cost details",
      ),
    rebillable: z
      .boolean()
      .describe(
        'True when POST /v1/sessions/:id/rebill can bill the session now (same checks as the re-bill)',
      ),
    rebillBlockedReason: z
      .enum([
        'status',
        'already_rebilled',
        'roaming',
        'free_vend',
        'no_tariff',
        'paid',
        'in_progress',
        'payment_pending',
      ])
      .nullable()
      .describe(
        'Why the session cannot be re-billed now: a SESSION_REBILL_NOT_ELIGIBLE reason, in_progress (another request bills it), or payment_pending (an open payment, or a re-bill charge without a provider answer for 23 hours to check at the provider); null when rebillable',
      ),
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
        provider: z
          .string()
          .max(32)
          .nullable()
          .describe('Payment provider of the guest charge (stripe, simulated); null when free'),
        providerPaymentId: z
          .string()
          .max(255)
          .nullable()
          .describe('Payment identifier of the guest charge at the payment provider'),
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
    // 'idling' (status='active' AND idle_started_at IS NOT NULL) and
    // 'manual_billing' (rebill_status='manual') are virtual filter values not
    // present in the DB enum; the handler maps them.
    .enum([...sessionStatusEnum.enumValues, 'idling', 'manual_billing'] as const)
    .optional()
    .describe(
      'Filter by session status, "idling" for active and idle, or "manual_billing" for re-billed sessions left to manual billing',
    ),
});

const rebillResponse = z
  .object({
    sessionId: z.string().describe('Session identifier'),
    rebillStatus: z
      .enum(['billed', 'manual'])
      .describe(
        'billed: charged, debited, or nothing to charge; manual: bill outside the platform',
      ),
    result: z
      .enum(['charged', 'prepaid', 'account', 'no_charge', 'manual'])
      .describe(
        'charged: the default saved card was charged; prepaid: the token balance was debited; account: billed to the fleet on its invoice; no_charge: the cost is 0; manual: left to manual billing',
      ),
    manualReason: z
      .enum([
        'no_payment_method',
        'payment_failed',
        'guest',
        'no_driver',
        'prepaid_not_debited',
        'prepaid_record_exists',
      ])
      .nullable()
      .describe('Why the session is left to manual billing, null when it was billed'),
    finalCostCents: z
      .number()
      .int()
      .min(0)
      .describe('Recomputed final cost in cents, tax included, now stored on the session'),
    currency: z.string().length(3).describe('ISO 4217 currency the session is billed in'),
    endedAt: z.coerce
      .date()
      .describe('Billed end of the session: its last meter value, at most the time it was faulted'),
    paymentRecordId: z
      .number()
      .int()
      .nullable()
      .describe('Payment record of the charge or prepaid debit, null when none was written'),
    failureReason: z
      .string()
      .max(500)
      .nullable()
      .describe('Provider reason of a declined charge, null otherwise'),
  })
  .passthrough();

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
        } else if (status === 'manual_billing') {
          conditions.push(eq(chargingSessions.rebillStatus, 'manual'));
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
          electricityCostCents: chargingSessions.electricityCostCents,
          currentCostCents: chargingSessions.currentCostCents,
          finalCostCents: chargingSessions.finalCostCents,
          currency: sessionCurrencySql(),
          freeVend: chargingSessions.freeVend,
          billingMode: chargingSessions.billingMode,
          rebillStatus: chargingSessions.rebillStatus,
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
          electricityCostCents: chargingSessions.electricityCostCents,
          currentCostCents: chargingSessions.currentCostCents,
          finalCostCents: chargingSessions.finalCostCents,
          currency: sessionCurrencySql(),
          stoppedReason: chargingSessions.stoppedReason,
          reservationId: chargingSessions.reservationId,
          freeVend: chargingSessions.freeVend,
          billingMode: chargingSessions.billingMode,
          rebillStatus: chargingSessions.rebillStatus,
          billingFleetId: chargingSessions.billingFleetId,
          billingFleetName: sql<
            string | null
          >`(SELECT f.name FROM fleets f WHERE f.id = ${chargingSessions.billingFleetId})`,
          invoiceId: chargingSessions.invoiceId,
          invoiceStatus: sql<
            string | null
          >`(SELECT i.status::text FROM invoices i WHERE i.id = ${chargingSessions.invoiceId})`,
          rebillClaimedAt: chargingSessions.rebillClaimedAt,
          stationTariffId: chargingSessions.stationTariffId,
          stationCostCents: chargingSessions.stationCostCents,
          stationCostDifferenceCents: chargingSessions.stationCostDifferenceCents,
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
          pendingOperation: paymentRecords.pendingOperation,
          providerRefunds: paymentRecords.providerRefunds,
          guestSessionToken: guestSessions.sessionToken,
          guestEmail: guestSessions.guestEmail,
          guestStatus: guestSessions.status,
          guestPreAuthAmountCents: guestSessions.preAuthAmountCents,
          guestProvider: guestSessions.provider,
          guestProviderPaymentId: guestSessions.providerPaymentId,
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
      if (!siteInScope(siteIds, row.siteId)) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      // The re-bill checks run only for a session the CSMS gave up ending;
      // any other session fails the first one (status).
      const rebill =
        row.stoppedReason === SESSION_END_FAILED_REASON ? await getSessionRebillState(id) : null;

      const {
        paymentId,
        paymentStatus,
        paymentSource,
        paymentCurrency,
        preAuthAmountCents,
        capturedAmountCents,
        refundedAmountCents,
        failureReason,
        pendingOperation,
        providerRefunds,
        guestSessionToken,
        guestEmail,
        guestStatus,
        guestPreAuthAmountCents,
        guestProvider,
        guestProviderPaymentId,
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
        rebillable: rebill?.rebillable ?? false,
        rebillBlockedReason: rebill != null ? rebill.blockedReason : 'status',
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
                pendingOperation,
                providerRefunds: providerRefunds ?? [],
              }
            : null,
        guestSession:
          guestSessionToken != null
            ? {
                sessionToken: guestSessionToken,
                guestEmail: guestEmail ?? '',
                status: guestStatus ?? '',
                preAuthAmountCents: guestPreAuthAmountCents,
                provider: guestProvider,
                providerPaymentId: guestProviderPaymentId,
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
      if (!siteInScope(txSiteIds, session.siteId)) {
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
      if (!siteInScope(mvSiteIds, session.siteId)) {
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

  app.post(
    '/sessions/:id/rebill',
    {
      onRequest: [authorize('sessions:write', 'payments:write')],
      schema: {
        tags: ['Sessions'],
        summary: 'Bill a session the CSMS could not end',
        description:
          'Bills a session the CSMS gave up ending (status faulted, stopped reason EndRequestFailed: its cost was zeroed and its hold cancelled). The cost is recomputed from the stored meter values and tariff segments with the same calculator as a normal session end, at the last meter value, at most the guest cost ceiling. A driver session is charged off session on the default saved card through the provider it is saved with (idempotency key rebill_<sessionId>), a prepaid token balance is debited, and a cost of 0 charges nothing. The session becomes completed with the cost, rebillStatus billed, and the driver gets a receipt. A session that cannot be charged (no saved card, a guest, a declined card, a card that needs the cardholder authentication) becomes completed with the cost and rebillStatus manual, for billing outside the platform. Requires sessions:write and payments:write. Returns 409 SESSION_REBILL_NOT_ELIGIBLE with details.reason (status, already_rebilled, roaming, free_vend, no_tariff, paid), 409 SESSION_REBILL_PAYMENT_PENDING while the session has an open hold or an unconfirmed provider operation, 409 SESSION_REBILL_IN_PROGRESS while another request bills it, 400 PAYMENT_PROVIDER_NOT_CONFIGURED when the provider of the saved card is not configured, and 400 PAYMENT_PROVIDER_CONNECTION_FAILED when the provider could not be reached (retry after a few minutes: the same key returns the first answer).',
        operationId: 'rebillSession',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionParams),
        response: {
          200: itemResponse(rebillResponse),
          400: errorWith('Payment provider not configured or unreachable', [
            ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
            ERROR_CODES.PAYMENT_PROVIDER_CONNECTION_FAILED,
          ]),
          404: errorWith('Session not found', [ERROR_CODES.SESSION_NOT_FOUND]),
          409: errorWith('Session cannot be billed now', [
            ERROR_CODES.SESSION_REBILL_NOT_ELIGIBLE,
            ERROR_CODES.SESSION_REBILL_PAYMENT_PENDING,
            ERROR_CODES.SESSION_REBILL_IN_PROGRESS,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof sessionParams>;
      const { userId } = request.user as JwtPayload;
      try {
        return await rebillSession(id, {
          actor: getAuditActor(request),
          log: request.log,
          siteIds: await getUserSiteIds(userId),
        });
      } catch (err: unknown) {
        if (err instanceof SessionRebillRefusedError) {
          await reply.status(409).send({
            error: err.message,
            code: 'SESSION_REBILL_NOT_ELIGIBLE',
            details: { reason: err.reason },
          });
          return;
        }
        if (err instanceof PaymentProviderUnavailableError) {
          request.log.warn({ err, sessionId: id }, 'Session re-bill: payment provider unreachable');
          await reply.status(400).send({
            error: 'The payment provider could not be reached. Try again in a few minutes.',
            code: 'PAYMENT_PROVIDER_CONNECTION_FAILED',
          });
          return;
        }
        throw err;
      }
    },
  );
}
