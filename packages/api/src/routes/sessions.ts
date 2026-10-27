// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, and, or, ilike, desc, sql, isNotNull, inArray, type SQL } from 'drizzle-orm';
import { db, SESSION_END_FAILED_REASON, writeAudit } from '@evtivity/database';
import {
  chargingSessions,
  chargingStations,
  sites,
  drivers,
  driverTokens,
  pncContracts,
  vehicles,
  transactionEvents,
  transactionEventTypeEnum,
  paymentRecords,
  paymentStatusEnum,
  meterValues,
  guestSessions,
  sessionStatusEnum,
  SESSION_REBILL_STATUSES,
  getCompanyCurrency,
  inOperatorStation,
  sessionAuditLog,
} from '@evtivity/database';
import { sessionCostMissing } from '@evtivity/services/electricity-cost.service';
import { PaymentProviderUnavailableError } from '@evtivity/payments';
import { sessionCurrencySql } from '@evtivity/services/company-currency';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { paginatedResponse, itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { PNC_TOKEN_TYPE } from '../lib/pnc-session-sql.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { siteInScope } from '../lib/site-scope.js';
import { containsPattern } from '../lib/like-pattern.js';
import { pendingOperationSchema, providerRefundsSchema } from '../lib/payment-provider-schemas.js';
import { activePaymentProvider } from '../lib/payments.js';
import { NO_PAYMENT_REASONS, noPaymentReason } from '../lib/session-no-payment-reason.js';
import type { JwtPayload } from '../plugins/auth.js';
import { authorize } from '../middleware/rbac.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { requestSessionEnd } from '../lib/session-end.js';
import {
  getSessionRebillState,
  rebillSession,
  SessionRebillRefusedError,
} from '../services/session-rebill.service.js';
import {
  moveSessionsBilling,
  sessionBillingMoveError,
} from '../services/session-billing-recipient.service.js';
import { normalizeMacAddress } from '@evtivity/lib/vehicle-id';
import * as vehicleService from '../services/vehicle.service.js';
import { parseZodRequest, zodSchema } from '../lib/zod-schema.js';
import {
  replyVehicleServiceError,
  sessionVehicleCaptureItem,
  vehicleClaimBody,
} from '../lib/vehicle-response.js';

/** The display name of a session's linked vehicle (year make model, else the plate). */
const vehicleNameSql = sql<
  string | null
>`NULLIF(coalesce(NULLIF(concat_ws(' ', ${vehicles.year}, ${vehicles.make}, ${vehicles.model}), ''), ${vehicles.licensePlate}), '')`;

/** The captured vehicle id of a session row, or null. */
function sessionVehicleCapture(row: {
  vehicleIdValue: string | null;
  vehicleIdType: string | null;
  vehicleIdSource: string | null;
}): { value: string; type: string; source: string } | null {
  return row.vehicleIdValue != null && row.vehicleIdType != null && row.vehicleIdSource != null
    ? { value: row.vehicleIdValue, type: row.vehicleIdType, source: row.vehicleIdSource }
    : null;
}

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
    vehicleId: z.string().nullable().describe('Vehicle linked to the session'),
    vehicleName: z
      .string()
      .nullable()
      .describe('Linked vehicle: year, make and model, else its license plate'),
    vehicleCapture: sessionVehicleCaptureItem,
    autocharge: z
      .boolean()
      .describe('The session was authorized by an Autocharge vehicle (charge by plugging in)'),
    createdAt: z.coerce.date().describe('Timestamp the session row was created in the CSMS'),
  })
  .loose();

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
  .loose();

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
  .loose();

const sessionDetail = z
  .object({
    id: z.string().describe('Session identifier'),
    stationId: z.string().describe('Station internal ID'),
    stationName: z.string().nullable().describe('Station OCPP identity (display name)'),
    evseId: z
      .number()
      .int()
      .nullable()
      .describe(
        'OCPP EVSE number of the session (the stop-active-session path), null when unknown',
      ),
    stationOnline: z
      .boolean()
      .describe(
        'True when the station is connected now. An active session of an offline station can be ended in the CSMS (POST /v1/sessions/{id}/end)',
      ),
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
    memberBilled: z
      .boolean()
      .optional()
      .describe(
        "An account session of a fleet that invoices each driver: billed on the driver's own member invoice, not the fleet invoice. Decided once at its start",
      ),
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
        'no_energy',
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
        pncContract: z
          .object({
            id: z.number().int().describe('Plug and Charge contract ID'),
            pcid: z.string().describe('Provisioning certificate ID of the vehicle'),
            status: z.enum(['active', 'revoked']).describe('Contract status now'),
          })
          .loose()
          .nullable()
          .describe(
            'Plug and Charge contract whose eMAID authorized the session (ISO 15118), null otherwise',
          ),
      })
      .loose()
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
        licensePlate: z.string().nullable().describe('Vehicle license plate'),
        autochargeEnabled: z.boolean().describe('Autocharge is on for the vehicle'),
      })
      .loose()
      .nullable()
      .describe('Vehicle linked to this session, null when no vehicle is associated'),
    vehicleCapture: sessionVehicleCaptureItem,
    autocharge: z
      .boolean()
      .describe('The session was authorized by an Autocharge vehicle (charge by plugging in)'),
    metadata: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe(
        'Session metadata jsonb. May include reservationTokenMismatch when reservation.token_id did not match the session token.',
      ),
    paymentRecord: paymentRecordItem
      .nullable()
      .describe('Linked payment record, null when no payment was taken'),
    noPaymentReason: z
      .enum(NO_PAYMENT_REASONS)
      .nullable()
      .describe(
        'Why the session has no payment record, null when it has one: free_vend (free vend), roaming (billed by the eMSP through OCPI), account_credit_limit (fleet credit limit refused the start), account_billed (fleet or member invoice), guest (paid through the guest session), anonymous (no driver or guest checkout), no_payment_method and payment_failed (stopped by the payment check), pending (still running), no_cost (nothing to charge), payments_off (no payment provider active now), prepaid_not_debited (prepaid balance debit not recorded), not_held (no hold was placed at the start)',
      ),
    guestSession: z
      .object({
        sessionToken: z
          .string()
          .describe('Opaque token used by the guest portal to view this session'),
        guestEmail: z.email().describe('Email address provided by the guest at checkout'),
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
      .loose()
      .nullable()
      .describe('Guest session details, null when the session was started by a registered driver'),
  })
  .loose();

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
  .loose();

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
  costMissing: z
    .enum(['true', 'false'])
    .optional()
    .describe(
      'true: only billed sessions in the company currency that delivered energy and have no electricity cost (left out of profit). POST /v1/sites/{id}/electricity-cost/recalculate fills them from the site rates',
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
      .enum(['charged', 'prepaid', 'account', 'roaming', 'no_charge', 'manual'])
      .describe(
        'charged: the default saved card was charged; prepaid: the token balance was debited; account: billed to the fleet on its invoice; roaming: billed to the roaming partner with a CDR, no payment here; no_charge: the cost is 0; manual: left to manual billing',
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
  .loose();

const sessionParams = z.object({
  id: ID_PARAMS.sessionId.describe('Session ID'),
});

const billingRecipientBody = z.object({
  recipient: z
    .enum(['fleet', 'member'])
    .describe(
      "Who the session is invoiced to: 'fleet' (the fleet invoice) or 'member' (the driver's member invoice)",
    ),
});

const billingRecipientResponse = z
  .object({
    sessionId: z.string().describe('Session ID'),
    recipient: z.enum(['fleet', 'member']).describe('Who the session is invoiced to now'),
    memberBilled: z.boolean().describe("True when the session goes on the driver's member invoice"),
    moved: z.boolean().describe('False when the session was already billed to the recipient'),
  })
  .loose();

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
      const { page, limit, search, siteId, stationId, status, costMissing } =
        request.query as z.infer<typeof sessionListQuery>;
      const offset = (page - 1) * limit;

      const { userId } = request.user as JwtPayload;
      const accessibleSiteIds = await getUserSiteIds(userId);
      if (accessibleSiteIds != null && accessibleSiteIds.length === 0) {
        return { data: [], total: 0 };
      }

      // Sessions are scoped and filtered by the site they happened at
      // (charging_sessions.site_id), not the station's current site: a station
      // moved to another site leaves its earlier sessions at the old site. A
      // session without a site is visible to all-site users only. Sessions of
      // conformance (OCTT) stations are never listed.
      const conditions: (SQL | undefined)[] = [inOperatorStation(chargingSessions.stationId)];
      if (accessibleSiteIds != null) {
        conditions.push(inArray(chargingSessions.siteId, accessibleSiteIds));
      }
      if (search) {
        // The search text is literal: % and _ are not wildcards.
        const pattern = containsPattern(search);
        conditions.push(
          or(
            ilike(chargingSessions.id, pattern),
            ilike(chargingSessions.transactionId, pattern),
            ilike(chargingStations.stationId, pattern),
            ilike(drivers.firstName, pattern),
            ilike(drivers.lastName, pattern),
            ilike(chargingSessions.vehicleIdValue, pattern),
            // A MAC address typed with separators matches its stored form.
            ...(normalizeMacAddress(search) != null
              ? [eq(chargingSessions.vehicleIdValue, normalizeMacAddress(search) ?? '')]
              : []),
          ),
        );
      }
      if (siteId != null) {
        conditions.push(eq(chargingSessions.siteId, siteId));
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
      if (costMissing === 'true') {
        conditions.push(sessionCostMissing(await getCompanyCurrency()));
      }

      const where = and(...conditions);

      // The total comes from its own count query: a count(*) OVER() on the
      // page query has no row to read it from past the last page (total 0),
      // and the count needs only the joins the conditions use.
      let countQuery = db
        .select({ count: sql<number>`count(*)::int` })
        .from(chargingSessions)
        .$dynamic();
      if (search) {
        countQuery = countQuery
          .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
          .leftJoin(drivers, eq(chargingSessions.driverId, drivers.id));
      }
      const pageQuery = db
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
          vehicleId: chargingSessions.vehicleId,
          vehicleName: vehicleNameSql,
          vehicleIdValue: chargingSessions.vehicleIdValue,
          vehicleIdType: chargingSessions.vehicleIdType,
          vehicleIdSource: chargingSessions.vehicleIdSource,
          autocharge: chargingSessions.autocharge,
          createdAt: chargingSessions.createdAt,
        })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .leftJoin(sites, eq(chargingSessions.siteId, sites.id))
        .leftJoin(drivers, eq(chargingSessions.driverId, drivers.id))
        .leftJoin(vehicles, eq(chargingSessions.vehicleId, vehicles.id))
        .leftJoin(guestSessions, eq(guestSessions.chargingSessionId, chargingSessions.id))
        .where(where)
        .orderBy(desc(chargingSessions.createdAt), desc(chargingSessions.id))
        .limit(limit)
        .offset(offset);

      const [rows, countRows] = await Promise.all([pageQuery, countQuery.where(where)]);
      const total = countRows[0]?.count ?? 0;
      const data = rows.map(
        ({ guestSessionToken, vehicleIdValue, vehicleIdType, vehicleIdSource, ...rest }) => {
          return {
            ...rest,
            vehicleCapture: sessionVehicleCapture({
              vehicleIdValue,
              vehicleIdType,
              vehicleIdSource,
            }),
            isGuestSession: guestSessionToken != null,
          };
        },
      );

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
          evseId: sql<
            number | null
          >`(SELECT e.evse_id FROM evses e WHERE e.id = ${chargingSessions.evseId})`,
          stationOnline: chargingStations.isOnline,
          // The site the session happened at (charging_sessions.site_id).
          siteName: sites.name,
          siteId: chargingSessions.siteId,
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
          memberBilled: chargingSessions.memberBilled,
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
          tokenPrepaid: sql<boolean>`${driverTokens.prepaidBalanceCents} IS NOT NULL`,
          isRoaming: chargingSessions.isRoaming,
          vehicleId: vehicles.id,
          vehicleMake: vehicles.make,
          vehicleModel: vehicles.model,
          vehicleYear: vehicles.year,
          vehicleLicensePlate: vehicles.licensePlate,
          vehicleAutochargeEnabled: vehicles.autochargeEnabled,
          vehicleIdValue: chargingSessions.vehicleIdValue,
          vehicleIdType: chargingSessions.vehicleIdType,
          vehicleIdSource: chargingSessions.vehicleIdSource,
          autocharge: chargingSessions.autocharge,
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
        .leftJoin(sites, eq(chargingSessions.siteId, sites.id))
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
        tokenPrepaid,
        isRoaming,
        vehicleId,
        vehicleMake,
        vehicleModel,
        vehicleYear,
        vehicleLicensePlate,
        vehicleAutochargeEnabled,
        vehicleIdValue,
        vehicleIdType,
        vehicleIdSource,
        ...session
      } = row;

      const reason = await noPaymentReason(
        {
          hasPaymentRecord: paymentId != null,
          status: session.status,
          freeVend: session.freeVend,
          isRoaming,
          billingMode: session.billingMode,
          stoppedReason: session.stoppedReason,
          guestSession: guestSessionToken != null,
          driverId: session.driverId,
          prepaidToken: tokenPrepaid,
          finalCostCents: session.finalCostCents,
          currentCostCents: session.currentCostCents,
        },
        async () => {
          try {
            return (await activePaymentProvider(request.log)) == null;
          } catch (err) {
            // fail-open: the reason is informational; an unreadable payment
            // setting must not fail the session page.
            request.log.warn({ err, sessionId: id }, 'Payment provider check failed');
            return false;
          }
        },
      );

      // A Plug and Charge session: the contract whose eMAID authorized it.
      const [pncContract] =
        tokenId != null && tokenType === PNC_TOKEN_TYPE
          ? await db
              .select({ id: pncContracts.id, pcid: pncContracts.pcid, status: pncContracts.status })
              .from(pncContracts)
              .where(eq(pncContracts.driverTokenId, tokenId))
              .limit(1)
          : [];

      return {
        ...session,
        rebillable: rebill?.rebillable ?? false,
        rebillBlockedReason: rebill != null ? rebill.blockedReason : 'status',
        token:
          tokenId != null
            ? {
                id: tokenId,
                idToken: tokenIdToken ?? '',
                tokenType: tokenType ?? '',
                pncContract: pncContract ?? null,
              }
            : null,
        vehicle:
          vehicleId != null
            ? {
                id: vehicleId,
                make: vehicleMake,
                model: vehicleModel,
                year: vehicleYear,
                licensePlate: vehicleLicensePlate ?? null,
                autochargeEnabled: vehicleAutochargeEnabled ?? false,
              }
            : null,
        vehicleCapture: sessionVehicleCapture({ vehicleIdValue, vehicleIdType, vehicleIdSource }),
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
        noPaymentReason: reason,
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

  // "Use This Vehicle for Plug-In Charging" for the session's driver: the
  // vehicle id the charger sent goes on a new or existing vehicle of that
  // driver (vehicle.service.ts).
  app.post(
    '/sessions/:id/vehicle-claim',
    {
      onRequest: [authorize('drivers:write')],
      schema: {
        tags: ['Sessions'],
        summary: "Store the session's captured vehicle id on a vehicle of the session's driver",
        operationId: 'claimSessionVehicleId',
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
              .loose(),
          ),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
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
      const { id } = request.params as z.infer<typeof sessionParams>;
      const body = parseZodRequest(vehicleClaimBody, request.body);
      const [row] = await db
        .select({ driverId: chargingSessions.driverId, siteId: chargingSessions.siteId })
        .from(chargingSessions)
        .where(eq(chargingSessions.id, id));
      const { userId } = request.user as JwtPayload;
      if (row == null || !siteInScope(await getUserSiteIds(userId), row.siteId)) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }
      if (row.driverId == null) {
        // Only the session's driver can own the id: a session without one has none.
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }
      try {
        const result = await vehicleService.claimSessionVehicleId(
          {
            sessionId: id,
            driverId: row.driverId,
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
        .select({ id: chargingSessions.id, siteId: chargingSessions.siteId })
        .from(chargingSessions)
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
          // seq_no and id break ties between events with the same timestamp,
          // so a row never moves between pages.
          .orderBy(
            desc(transactionEvents.timestamp),
            desc(transactionEvents.seqNo),
            desc(transactionEvents.id),
          )
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
        .select({ id: chargingSessions.id, siteId: chargingSessions.siteId })
        .from(chargingSessions)
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
          // id breaks ties between readings with the same timestamp (one
          // MeterValues message holds several measurands), so a row never
          // moves between pages.
          .orderBy(desc(meterValues.timestamp), desc(meterValues.id))
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

  // "End Session" for an active session of an offline station: the CSMS ends
  // it without the station, through the same end the OCPP server runs for a
  // ghost session (completed at its last metered energy, final cost,
  // settlement, receipt). An online station is stopped with the EVSE stop.
  app.post(
    '/sessions/:id/end',
    {
      onRequest: [authorize('sessions:write')],
      schema: {
        tags: ['Sessions'],
        summary: 'End an active session of an offline station without the station',
        description:
          "Ends an active session whose station is offline, without the station: the OCPP server ends it the normal way, as completed at its last metered energy with its final cost, payment settlement and receipt (stopped reason OperatorEnded). The request is recorded on the session first, so it completes even if the OCPP server is restarting. A TransactionEvent Ended the station sends after it reconnects is recorded on the session only: it does not reopen, reprice or bill the session again. Returns 404 SESSION_NOT_FOUND for an unknown session or one at a site outside the caller's access, 409 SESSION_NOT_ACTIVE when the session is not active, and 409 STATION_ONLINE when the station is connected (stop it with POST /v1/stations/{id}/evses/{evseId}/stop-active-session).",
        operationId: 'endSession',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionParams),
        response: {
          200: itemResponse(
            z
              .object({
                sessionId: z.string().describe('Session whose end was requested'),
                transactionId: z.string().nullable().describe('OCPP transaction id of the session'),
              })
              .loose(),
          ),
          404: errorWith('Session not found', [ERROR_CODES.SESSION_NOT_FOUND]),
          409: errorWith('Session not active or station online', [
            ERROR_CODES.SESSION_NOT_ACTIVE,
            ERROR_CODES.STATION_ONLINE,
          ]),
        },
      },
      // The end changes the session lists and detail.
      config: { invalidatesCacheTags: ['sessions'] },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof sessionParams>;
      const { userId } = request.user as JwtPayload;
      const [row] = await db
        .select({
          siteId: chargingSessions.siteId,
          status: chargingSessions.status,
          transactionId: chargingSessions.transactionId,
          stationOnline: chargingStations.isOnline,
        })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .where(eq(chargingSessions.id, id));
      if (row == null || !siteInScope(await getUserSiteIds(userId), row.siteId)) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }
      if (row.status !== 'active') {
        await reply
          .status(409)
          .send({ error: 'The session is not active', code: 'SESSION_NOT_ACTIVE' });
        return;
      }
      if (row.stationOnline) {
        await reply.status(409).send({
          error: 'The station is online; stop the session at the station instead',
          code: 'STATION_ONLINE',
        });
        return;
      }
      // Recorded on the session before the publish (P4); only an active
      // session is requested (P5).
      const requested = await requestSessionEnd(id, 'OperatorEnded', request.log);
      if (!requested) {
        await reply
          .status(409)
          .send({ error: 'The session is not active', code: 'SESSION_NOT_ACTIVE' });
        return;
      }
      await writeAudit(
        { table: sessionAuditLog, idColumn: 'session_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'stopped_by_csms',
          ...getAuditActor(request),
          before: { status: 'active' },
          after: {
            action: 'EndSession',
            transactionId: row.transactionId,
            stationOnline: false,
            endRequestReason: 'OperatorEnded',
          },
          notes: 'Operator ended the session without the offline station',
        },
        db,
        request.log,
      );
      return { sessionId: id, transactionId: row.transactionId };
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
          'Bills a session the CSMS gave up ending (status faulted, stopped reason EndRequestFailed: its cost was zeroed and its hold cancelled). The cost is recomputed from the stored meter values and tariff segments with the same calculator as a normal session end, at the last meter value, at most the guest cost ceiling. A driver session is charged off session on the default saved card through the provider it is saved with (idempotency key rebill_<sessionId>), a prepaid token balance is debited, and a cost of 0 charges nothing. The session becomes completed with the cost, rebillStatus billed, and the driver gets a receipt. A session that cannot be charged (no saved card, a guest, a declined card, a card that needs the cardholder authentication) becomes completed with the cost and rebillStatus manual, for billing outside the platform. Requires sessions:write and payments:write. A roaming session that delivered energy is completed without a payment and billed to the roaming partner with a CDR (result roaming). Returns 409 SESSION_REBILL_NOT_ELIGIBLE with details.reason (status, already_rebilled, no_energy (a roaming session that delivered no energy), free_vend, no_tariff, paid), 409 SESSION_REBILL_PAYMENT_PENDING while the session has an open hold or an unconfirmed provider operation, 409 SESSION_REBILL_IN_PROGRESS while another request bills it, 400 PAYMENT_PROVIDER_NOT_CONFIGURED when the provider of the saved card is not configured, and 400 PAYMENT_PROVIDER_CONNECTION_FAILED when the provider could not be reached (retry after a few minutes: the same key returns the first answer).',
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

  app.patch(
    '/sessions/:id/billing-recipient',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Sessions'],
        summary: "Move a session between the fleet invoice and the member's invoice",
        description:
          "Moves an unbilled session billed on account to a fleet between the fleet invoice (recipient fleet) and the driver's own member invoice (recipient member). Allowed only while the session is on no invoice (a session of an issued invoice is released by crediting the invoice first: 409 SESSION_ALREADY_INVOICED), the driver is still a member of the fleet (409 DRIVER_NOT_FLEET_MEMBER) and the fleet bills on account (409 FLEET_ACCOUNT_BILLING_OFF). A session not billed on account (card, prepaid, roaming, or paid by card) answers 409 SESSION_NOT_ON_ACCOUNT. A session already billed to the recipient answers 200 with moved false and writes nothing. A move is audited on the session (billing_reassigned, recipient before and after). A user restricted to some sites gets 404 SESSION_NOT_FOUND: account invoices span every site.",
        operationId: 'moveSessionBillingRecipient',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionParams),
        body: zodSchema(billingRecipientBody),
        response: {
          200: itemResponse(billingRecipientResponse),
          404: errorWith('Session not found', [ERROR_CODES.SESSION_NOT_FOUND]),
          409: errorWith('The session cannot move', [
            ERROR_CODES.SESSION_NOT_ON_ACCOUNT,
            ERROR_CODES.SESSION_ALREADY_INVOICED,
            ERROR_CODES.FLEET_ACCOUNT_BILLING_OFF,
            ERROR_CODES.DRIVER_NOT_FLEET_MEMBER,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof sessionParams>;
      const { recipient } = request.body as z.infer<typeof billingRecipientBody>;
      const { userId } = request.user as JwtPayload;
      if ((await getUserSiteIds(userId)) != null) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }
      const [move] = await moveSessionsBilling([id], recipient, {
        actor: getAuditActor(request),
        log: request.log,
      });
      const outcome = move?.outcome ?? 'not_found';
      const refusal = sessionBillingMoveError(outcome);
      if (refusal != null) throw refusal;
      return {
        sessionId: id,
        recipient,
        memberBilled: recipient === 'member',
        moved: outcome === 'moved',
      };
    },
  );
}
