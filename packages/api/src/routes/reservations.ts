// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  reservationCancellationFeeSchema,
  reservationCancellationFeeView,
} from '../lib/reservation-fee-view.js';
import { eq, and, or, ilike, desc, sql, count, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db, isOperatorStation } from '@evtivity/database';
import {
  reservations,
  reservationAuditLog,
  chargingStations,
  chargingSessions,
  drivers,
  driverTokens,
  evses,
  connectors,
  sites,
  ocppMessageLogs,
  users,
} from '@evtivity/database';
import { notificationMoney } from '@evtivity/lib';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { siteInScope } from '../lib/site-scope.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { paginatedResponse, itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { paymentContext } from '../lib/payments.js';
import { MaintenanceConflictError } from '@evtivity/services/maintenance-check';
import {
  cancelReservationWithStation,
  createReservation,
  dispatchReservation,
  reassignReservation,
  updateReservation,
} from '@evtivity/services/reservation.service';
import type { ReservationRow } from '@evtivity/services/reservation.service';
import { notifyReservationDriver } from '@evtivity/services/reservation-notify';
import { authorize } from '../middleware/rbac.js';
import { getAuditActor } from '../lib/audit-actor.js';

const reservationListItem = z
  .object({
    id: z.string().describe('Reservation identifier'),
    reservationId: z.number().describe('OCPP reservation id (integer) sent to the station'),
    stationId: z.string().describe('Station internal ID'),
    stationOcppId: z.string().describe('Station OCPP identity'),
    siteName: z.string().nullable().describe('Site name where the station is located'),
    evseOcppId: z
      .number()
      .nullable()
      .describe('OCPP EVSE id, null when the reservation is station-wide'),
    driverId: z
      .string()
      .nullable()
      .describe('Driver internal ID, null for operator-comp reservations'),
    driverFirstName: z.string().nullable().describe('Driver first name'),
    driverLastName: z.string().nullable().describe('Driver last name'),
    tokenId: z
      .string()
      .nullable()
      .describe('Driver token bound to this reservation, null when unbound'),
    status: z
      .string()
      .describe('Reservation status (scheduled, active, in_use, used, cancelled, expired)'),
    expiresAt: z.coerce.date().describe('Timestamp when the reservation expires automatically'),
    createdAt: z.coerce.date().describe('Timestamp the reservation was created'),
    sessionId: z
      .string()
      .nullable()
      .describe('Charging session ID that consumed this reservation, null until used'),
  })
  .passthrough();

const reservationCreatedItem = z
  .object({
    id: z.string().describe('Reservation identifier'),
    reservationId: z.number().describe('OCPP reservation id (integer) sent to the station'),
    stationId: z.string().describe('Station internal ID'),
    evseId: z
      .string()
      .nullable()
      .describe('EVSE internal ID, null when the reservation is station-wide'),
    driverId: z
      .string()
      .nullable()
      .describe('Driver internal ID associated with the reservation, null for operator-comp'),
    status: z.string().describe('Reservation status (scheduled or active depending on startsAt)'),
    expiresAt: z.coerce.date().describe('Timestamp when the reservation expires automatically'),
    createdAt: z.coerce.date().describe('Timestamp the reservation was created'),
  })
  .passthrough();

const reservationDetailItem = z
  .object({
    id: z.string().describe('Reservation identifier'),
    reservationId: z.number().describe('OCPP reservation id (integer) sent to the station'),
    stationId: z.string().describe('Station internal ID'),
    stationOcppId: z.string().describe('Station OCPP identity'),
    evseId: z
      .string()
      .nullable()
      .describe('EVSE internal ID, null when the reservation is station-wide'),
    evseOcppId: z
      .number()
      .nullable()
      .describe('OCPP EVSE id, null when the reservation is station-wide'),
    driverId: z
      .string()
      .nullable()
      .describe('Driver internal ID, null for operator-comp reservations'),
    driverFirstName: z.string().nullable().describe('Driver first name'),
    driverLastName: z.string().nullable().describe('Driver last name'),
    tokenId: z
      .string()
      .nullable()
      .describe('Driver token bound to this reservation, null when unbound'),
    tokenIdToken: z
      .string()
      .nullable()
      .describe('Bound token raw idToken value, null when no token bound'),
    tokenType: z.string().nullable().describe('Bound token type, null when no token bound'),
    status: z
      .string()
      .describe('Reservation status (scheduled, active, in_use, used, cancelled, expired)'),
    expiresAt: z.coerce.date().describe('Timestamp when the reservation expires automatically'),
    createdAt: z.coerce.date().describe('Timestamp the reservation was created'),
    updatedAt: z.coerce.date().describe('Timestamp the reservation was last updated'),
    cancelledBy: z
      .enum(['driver', 'operator', 'system'])
      .nullable()
      .describe('Actor who cancelled (driver/operator/system), null if not cancelled'),
    cancelReason: z
      .enum([
        'driver_initiated',
        'operator_manual',
        'expired_no_show',
        'station_rejected_occupied',
        'station_rejected_other',
        'station_offline_at_activation',
        'evse_in_use_at_activation',
        'station_faulted_at_activation',
        'system_cleanup',
        'station_no_response',
        'station_unavailable_during_hold',
      ])
      .nullable()
      .describe('Typed cancel reason, null if not cancelled'),
    cancelNote: z.string().max(500).nullable().describe('Operator-provided free-text note'),
    cancellationFeeCents: z
      .number()
      .int()
      .min(0)
      .describe(
        'Cancellation fee charged in cents, tax included (0 when waived or no payment method)',
      ),
    sessionId: z
      .string()
      .nullable()
      .describe('Charging session ID that consumed this reservation, null until used'),
    sessionStatus: z
      .string()
      .nullable()
      .optional()
      .describe('Status of the linked charging session, if any'),
    sessionEnergyWh: z
      .string()
      .nullable()
      .optional()
      .describe('Energy delivered by the linked session in Watt-hours'),
    sessionCostCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe('Final cost of the linked session in cents'),
    sessionStartedAt: z.coerce
      .date()
      .nullable()
      .optional()
      .describe('Timestamp the linked session started charging'),
    sessionEndedAt: z.coerce
      .date()
      .nullable()
      .optional()
      .describe('Timestamp the linked session stopped charging'),
    cancellationFee: reservationCancellationFeeSchema,
  })
  .passthrough();

const cancelReservationResponse = z
  .object({
    status: z.literal('cancelled').describe('Always "cancelled" when the request succeeds'),
    cancellationFeeChargedCents: z
      .number()
      .int()
      .min(0)
      .describe('Actual fee charged in cents, tax included (0 when waived or no payment method)'),
    feeChargeFailed: z
      .boolean()
      .optional()
      .describe(
        'True when a fee was attempted but the Stripe charge threw. Audit row shows 0; reconcile via Stripe.',
      ),
    warning: z
      .string()
      .optional()
      .describe(
        'station_cancel_failed when the station refused CancelReservation or did not answer. The reservation is cancelled; the station may still hold the EVSE until the reservation expires.',
      ),
  })
  .passthrough();

/**
 * Body shape for DELETE /v1/reservations/:id. The route schema deliberately
 * does NOT declare this as a Zod body validator (Fastify rejects empty
 * payloads on .optional() schemas, which breaks existing clients that send
 * DELETE without a body). The handler casts request.body to this shape at
 * runtime instead.
 *
 * - chargeCancellationFee: operator opt-in. Defaults to false; system and
 *   driver-initiated paths ignore this.
 * - reason: free-text note explaining why the operator cancelled.
 */
interface CancelReservationBody {
  chargeCancellationFee?: boolean;
  reason?: string;
}

const reassignReservationResponse = z
  .object({
    status: z.literal('reassigned').describe('Always "reassigned" when the request succeeds'),
    newStationOcppId: z
      .string()
      .describe('OCPP identity of the station the reservation was moved to'),
  })
  .passthrough();

const reservationCommandItem = z
  .object({
    id: z.number().describe('Internal OCPP message log ID'),
    direction: z.string().describe('Message direction (inbound or outbound relative to the CSMS)'),
    messageType: z.number().describe('OCPP message type (2 = CALL, 3 = CALLRESULT, 4 = CALLERROR)'),
    messageId: z.string().describe('OCPP message correlation ID linking CALL to RESULT/ERROR'),
    action: z
      .string()
      .nullable()
      .describe('OCPP action name (ReserveNow, CancelReservation), null on RESULT/ERROR rows'),
    payload: z.unknown().describe('Raw OCPP message payload as sent on the wire'),
    errorCode: z
      .string()
      .nullable()
      .describe('OCPP error code on CALLERROR messages, null otherwise'),
    errorDescription: z
      .string()
      .nullable()
      .describe('OCPP error description on CALLERROR messages, null otherwise'),
    createdAt: z.coerce.date().describe('Timestamp the message was logged'),
    responseTimeMs: z
      .number()
      .nullable()
      .describe(
        'Round-trip time in milliseconds for paired CALL/RESULT messages, null on the CALL row',
      ),
  })
  .passthrough();

const reservationAuditItem = z
  .object({
    id: z.number().describe('Audit row identifier'),
    reservationId: z.string().nullable().describe('Reservation ID (text), nullable for orphans'),
    action: z
      .string()
      .describe('Audit action (created, updated, cancelled, expired, used, session_failed)'),
    actor: z.string().describe('Actor kind: operator, driver, system'),
    actorUserId: z.string().nullable().describe('Operator user ID when actor=operator'),
    actorUserName: z
      .string()
      .nullable()
      .describe('Operator display name when actor=operator (first + last, or email fallback)'),
    actorDriverId: z.string().nullable().describe('Driver ID when actor=driver'),
    actorDriverName: z
      .string()
      .nullable()
      .describe('Driver display name when actor=driver (first + last, or email fallback)'),
    driverIdBefore: z.string().nullable().describe('Driver ID before the change'),
    driverIdAfter: z.string().nullable().describe('Driver ID after the change'),
    tokenIdBefore: z.string().nullable().describe('Token ID before the change'),
    tokenIdAfter: z.string().nullable().describe('Token ID after the change'),
    evseIdBefore: z.string().nullable().describe('EVSE ID before the change'),
    evseIdAfter: z.string().nullable().describe('EVSE ID after the change'),
    statusBefore: z.string().nullable().describe('Status before the change'),
    statusAfter: z.string().nullable().describe('Status after the change'),
    expiresAtBefore: z.coerce.date().nullable().describe('expiresAt before the change'),
    expiresAtAfter: z.coerce.date().nullable().describe('expiresAt after the change'),
    notes: z.string().nullable().describe('Optional free-text note'),
    createdAt: z.coerce.date().describe('Timestamp of the audit entry'),
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
  evseId: z.coerce
    .number()
    .int()
    .min(0)
    .max(2147483647)
    .optional()
    .describe('EVSE ID on the station'),
  driverId: ID_PARAMS.driverId.optional().describe('Driver ID to associate with the reservation'),
  tokenId: ID_PARAMS.driverTokenId
    .optional()
    .describe(
      'Optional driver token ID to bind to the reservation. When set, the StartTransaction handler can verify the card the driver actually taps matches.',
    ),
  expiresAt: z.string().datetime().describe('ISO 8601 expiration date-time'),
  startsAt: z.string().datetime().optional().describe('ISO 8601 start date-time'),
});

const updateReservationBody = z.object({
  driverId: ID_PARAMS.driverId.nullable().optional().describe('Driver ID'),
  evseId: z.coerce
    .number()
    .int()
    .min(0)
    .max(2147483647)
    .nullable()
    .optional()
    .describe('EVSE ID on the station'),
  expiresAt: z.string().datetime().optional().describe('ISO 8601 expiration date-time'),
  tokenId: ID_PARAMS.driverTokenId
    .nullable()
    .optional()
    .describe('Driver token ID to bind, or null to unbind. Must belong to the same driver.'),
});

/** The station fields the reservation service checks on create and reassign. */
const reservationStationColumns = {
  id: chargingStations.id,
  stationId: chargingStations.stationId,
  siteId: chargingStations.siteId,
  isOnline: chargingStations.isOnline,
  reservationsEnabled: chargingStations.reservationsEnabled,
  disabledReason: chargingStations.disabledReason,
  firmwareState: chargingStations.firmwareState,
  reportedStatus: chargingStations.reportedStatus,
};

/** Answers a maintenance conflict with its window details; false for any other error. */
async function sendMaintenanceConflict(reply: FastifyReply, err: unknown): Promise<boolean> {
  if (!(err instanceof MaintenanceConflictError)) return false;
  await reply.status(409).send({ error: err.message, code: err.code, ...err.details });
  return true;
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

      // Reservations of conformance test stations are never listed.
      const conditions: (SQL | undefined)[] = [isOperatorStation()];
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

      const where = and(...conditions);

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
            tokenId: reservations.tokenId,
            status: reservations.status,
            startsAt: reservations.startsAt,
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
          .orderBy(desc(reservations.createdAt), desc(reservations.id))
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
        response: {
          200: itemResponse(reservationDetailItem),
          404: errorWith('Reservation not found', [ERROR_CODES.RESERVATION_NOT_FOUND]),
        },
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
          tokenId: reservations.tokenId,
          tokenIdToken: driverTokens.idToken,
          tokenType: driverTokens.tokenType,
          status: reservations.status,
          startsAt: reservations.startsAt,
          expiresAt: reservations.expiresAt,
          createdAt: reservations.createdAt,
          updatedAt: reservations.updatedAt,
          cancelledBy: reservations.cancelledBy,
          cancelReason: reservations.cancelReason,
          cancelNote: reservations.cancelNote,
          cancellationFeeCents: reservations.cancellationFeeCents,
          feeTaxBasis: reservations.feeTaxBasis,
          feeTaxRate: reservations.feeTaxRate,
          feePerMinute: reservations.feePerMinute,
          feeCancellationCents: reservations.feeCancellationCents,
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
        .leftJoin(driverTokens, eq(reservations.tokenId, driverTokens.id))
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
      if (!siteInScope(siteIds, reservation.siteId)) {
        await reply
          .status(404)
          .send({ error: 'Reservation not found', code: 'RESERVATION_NOT_FOUND' });
        return;
      }

      // The fee terms columns stay internal; the response carries the priced fee.
      const { feeTaxBasis, feeTaxRate, feePerMinute, feeCancellationCents, ...detail } =
        reservation;
      return {
        ...detail,
        cancellationFee: await reservationCancellationFeeView(
          {
            status: reservation.status,
            stationId: reservation.stationId,
            driverId: reservation.driverId,
            feeTaxBasis,
            feeTaxRate,
            feePerMinute,
            feeCancellationCents,
          },
          request.log,
        ),
      };
    },
  );

  // List audit log entries for a reservation
  app.get(
    '/reservations/:id/audit',
    {
      onRequest: [authorize('reservations:read')],
      schema: {
        tags: ['Reservations'],
        summary: 'List audit log entries for a reservation',
        operationId: 'listReservationAudit',
        security: [{ bearerAuth: [] }],
        params: zodSchema(reservationIdParams),
        querystring: zodSchema(paginationQuery),
        response: {
          200: paginatedResponse(reservationAuditItem),
          404: errorWith('Reservation not found', [ERROR_CODES.RESERVATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof reservationIdParams>;
      const { page, limit } = request.query as z.infer<typeof paginationQuery>;
      const offset = (page - 1) * limit;

      // Site-access check: load the reservation's station siteId and verify
      // the operator has access. The audit log is per-reservation so this is
      // a single point of authorization.
      const [reservation] = await db
        .select({ id: reservations.id, siteId: chargingStations.siteId })
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
      if (!siteInScope(siteIds, reservation.siteId)) {
        await reply
          .status(404)
          .send({ error: 'Reservation not found', code: 'RESERVATION_NOT_FOUND' });
        return;
      }

      // The legacy per-field columns were collapsed into before/after JSONB
      // in migration 0035. Project the JSONB values back to the legacy
      // response shape so the CSMS reservation history UI keeps working
      // unchanged.
      const [rows, countRows] = await Promise.all([
        db
          .select({
            id: reservationAuditLog.id,
            reservationId: reservationAuditLog.reservationId,
            action: reservationAuditLog.action,
            actor: reservationAuditLog.actor,
            actorUserId: reservationAuditLog.actorUserId,
            actorUserName: sql<string | null>`CASE
              WHEN ${users.id} IS NOT NULL THEN
                COALESCE(
                  NULLIF(TRIM(COALESCE(${users.firstName}, '') || ' ' || COALESCE(${users.lastName}, '')), ''),
                  ${users.email}
                )
              ELSE NULL
            END`,
            actorDriverId: reservationAuditLog.actorDriverId,
            actorDriverName: sql<string | null>`CASE
              WHEN ${drivers.id} IS NOT NULL THEN
                COALESCE(
                  NULLIF(TRIM(COALESCE(${drivers.firstName}, '') || ' ' || COALESCE(${drivers.lastName}, '')), ''),
                  ${drivers.email}
                )
              ELSE NULL
            END`,
            before: reservationAuditLog.before,
            after: reservationAuditLog.after,
            notes: reservationAuditLog.notes,
            createdAt: reservationAuditLog.createdAt,
          })
          .from(reservationAuditLog)
          .leftJoin(users, eq(users.id, reservationAuditLog.actorUserId))
          .leftJoin(drivers, eq(drivers.id, reservationAuditLog.actorDriverId))
          .where(eq(reservationAuditLog.reservationId, id))
          .orderBy(desc(reservationAuditLog.createdAt), desc(reservationAuditLog.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(reservationAuditLog)
          .where(eq(reservationAuditLog.reservationId, id)),
      ]);

      const data = rows.map((row) => {
        const before = (row.before ?? {}) as {
          driverId?: string | null;
          tokenId?: string | null;
          evseId?: string | null;
          status?: string | null;
          expiresAt?: string | Date | null;
        };
        const after = (row.after ?? {}) as {
          driverId?: string | null;
          tokenId?: string | null;
          evseId?: string | null;
          status?: string | null;
          expiresAt?: string | Date | null;
        };
        const parseDate = (v: string | Date | null | undefined): Date | null => {
          if (v == null) return null;
          if (v instanceof Date) return v;
          const d = new Date(v);
          return Number.isNaN(d.getTime()) ? null : d;
        };
        return {
          id: row.id,
          reservationId: row.reservationId,
          action: row.action,
          actor: row.actor,
          actorUserId: row.actorUserId,
          actorUserName: row.actorUserName,
          actorDriverId: row.actorDriverId,
          actorDriverName: row.actorDriverName,
          driverIdBefore: before.driverId ?? null,
          driverIdAfter: after.driverId ?? null,
          tokenIdBefore: before.tokenId ?? null,
          tokenIdAfter: after.tokenId ?? null,
          evseIdBefore: before.evseId ?? null,
          evseIdAfter: after.evseId ?? null,
          statusBefore: before.status ?? null,
          statusAfter: after.status ?? null,
          expiresAtBefore: parseDate(before.expiresAt),
          expiresAtAfter: parseDate(after.expiresAt),
          notes: row.notes,
          createdAt: row.createdAt,
        };
      });

      return { data, total: countRows[0]?.count ?? 0 };
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
        response: {
          200: paginatedResponse(reservationCommandItem),
          404: errorWith('Reservation not found', [ERROR_CODES.RESERVATION_NOT_FOUND]),
        },
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
      if (!siteInScope(siteIds, reservation.siteId)) {
        await reply
          .status(404)
          .send({ error: 'Reservation not found', code: 'RESERVATION_NOT_FOUND' });
        return;
      }

      // Query OCPP message logs for ReserveNow and CancelReservation actions
      // First find CALL messages matching this reservation, then include their responses

      // Step 1: Find CALL message IDs for this reservation. The OCPP
      // reservation id is an integer that other stations can also use, so
      // only the reservation's own station is searched: a match on another
      // station would expose that station's ReserveNow (idToken included).
      const callLogs = await db
        .select({ messageId: ocppMessageLogs.messageId })
        .from(ocppMessageLogs)
        .where(
          and(
            eq(ocppMessageLogs.stationId, reservation.stationId),
            eq(ocppMessageLogs.messageType, 2),
            or(
              sql`${ocppMessageLogs.action} = 'ReserveNow'`,
              sql`${ocppMessageLogs.action} = 'CancelReservation'`,
            ),
            or(
              sql`(${ocppMessageLogs.payload} #>> '{}')::jsonb @> jsonb_build_object('id', ${reservation.reservationId}::int)`,
              sql`(${ocppMessageLogs.payload} #>> '{}')::jsonb @> jsonb_build_object('reservationId', ${reservation.reservationId}::int)`,
            ),
          ),
        );

      if (callLogs.length === 0) {
        return { data: [], total: 0 };
      }

      const callMessageIds = callLogs.map((l) => l.messageId);

      // Step 2: Fetch CALL + RESULT/ERROR messages of the same station. Message
      // ids are unique per connection only, so a reply is paired with its call
      // on (stationId, messageId).
      const conditions = and(
        eq(ocppMessageLogs.stationId, reservation.stationId),
        inArray(ocppMessageLogs.messageId, callMessageIds),
      );

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
          .orderBy(desc(ocppMessageLogs.createdAt), desc(ocppMessageLogs.id))
          .limit(limit)
          .offset(offset),
        db.select({ count: count() }).from(ocppMessageLogs).where(conditions),
      ]);

      // Compute response times by pairing CALL messages with their RESULT/ERROR responses
      const callKey = (log: { stationId: string; messageId: string }) =>
        `${log.stationId}\u0000${log.messageId}`;
      const messageIdToTime = new Map<string, Date>();
      for (const log of data) {
        if (log.messageType === 2) {
          messageIdToTime.set(callKey(log), log.createdAt);
        }
      }

      const enriched = data.map((log) => {
        let responseTimeMs: number | null = null;
        if (log.messageType === 3 || log.messageType === 4) {
          const callTime = messageIdToTime.get(callKey(log));
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
        description:
          'Creates a charging reservation and dispatches ReserveNow to the station. Future-dated reservations are persisted with status=scheduled and activated by a delayed worker job at startsAt; immediate reservations are sent to the station synchronously and carry the bound driver token. The overlap check and the insert run under a per-station lock, so of two concurrent creates for one window only one succeeds and the other gets 409 RESERVATION_CONFLICT. Returns 400 RESERVATION_REJECTED when the station answers with another status, 502 when the command cannot be sent, and 504 when the station does not answer; each of these cancels the reservation without a fee.',
        operationId: 'createReservation',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createReservationBody),
        response: {
          200: itemResponse(reservationCreatedItem),
          400: errorWith('Bad request', [
            ERROR_CODES.DRIVER_NOT_FOUND,
            ERROR_CODES.PAYMENT_METHOD_REQUIRED,
            ERROR_CODES.RESERVATION_EXPIRES_TOO_SOON,
            ERROR_CODES.RESERVATION_REJECTED,
            ERROR_CODES.RESERVATION_STARTS_IN_PAST,
            ERROR_CODES.RESERVATION_TOO_LONG,
            ERROR_CODES.RESERVATION_WINDOW_TOO_SHORT,
            ERROR_CODES.STATION_OFFLINE,
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          403: errorWith('Forbidden', [ERROR_CODES.FORBIDDEN, ERROR_CODES.RESERVATION_DISABLED]),
          404: errorWith('Resource not found', [
            ERROR_CODES.EVSE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
          409: errorWith('Conflict', [
            ERROR_CODES.EVSE_IN_USE,
            ERROR_CODES.RESERVATION_CONFLICT,
            ERROR_CODES.RESERVATION_DURING_MAINTENANCE,
            ERROR_CODES.STATION_UNAVAILABLE,
          ]),
          500: errorWith('Reservation create failed', [ERROR_CODES.RESERVATION_CREATE_FAILED]),
          502: errorWith('The command could not be sent to the station', [
            ERROR_CODES.RESERVATION_REJECTED,
          ]),
          504: errorWith('Station did not respond within timeout', [
            ERROR_CODES.RESERVATION_TIMEOUT,
          ]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createReservationBody>;

      const [station] = await db
        .select(reservationStationColumns)
        .from(chargingStations)
        .where(eq(chargingStations.stationId, body.stationId));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, station.siteId)) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // The service runs every create check and the overlap check plus the
      // insert under the station lock (G1); its AppErrors carry the status
      // and code.
      let reservation: ReservationRow;
      try {
        reservation = await createReservation({
          station,
          evseOcppId: body.evseId,
          driverId: body.driverId ?? null,
          tokenId: body.tokenId,
          startsAt: body.startsAt != null ? new Date(body.startsAt) : null,
          expiresAt: new Date(body.expiresAt),
          actor: { kind: 'operator', userId },
          logger: request.log,
        });
      } catch (err) {
        if (await sendMaintenanceConflict(reply, err)) return;
        throw err;
      }

      // A future start goes to the worker; an immediate one waits for the
      // station, and any answer but Accepted cancels the row as system.
      const outcome = await dispatchReservation(reservation, {
        stationOcppId: station.stationId,
        siteId: station.siteId,
        notifyCreated: true,
        logger: request.log,
      });
      switch (outcome.kind) {
        case 'scheduled':
        case 'accepted':
          return reservation;
        case 'rejected':
          await reply.status(400).send({
            error: `Station rejected reservation: ${outcome.status}`,
            code: 'RESERVATION_REJECTED',
          });
          return;
        case 'no_response':
          await reply.status(504).send({ error: outcome.error, code: 'RESERVATION_TIMEOUT' });
          return;
        case 'failed':
          await reply.status(502).send({ error: outcome.error, code: 'RESERVATION_REJECTED' });
          return;
      }
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
        description:
          'Updates the driver, token, EVSE, or expiration of an active or scheduled reservation. A new expiration follows the create rules. The overlap check (scheduled and station-wide reservations included) and the update run under a per-station lock with a status guard. An edit of an active reservation that changes what the station holds re-sends ReserveNow with the same id; when the station refuses (502 RESERVATION_REJECTED) or does not answer (504 RESERVATION_TIMEOUT) the reservation keeps its previous values. Returns 409 RESERVATION_CONFLICT when the new window overlaps another reservation and 409 RESERVATION_NOT_ACTIVE when the reservation ended meanwhile.',
        operationId: 'updateReservation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(reservationIdParams),
        body: zodSchema(updateReservationBody),
        response: {
          200: itemResponse(reservationDetailItem),
          400: errorWith('Bad request', [
            ERROR_CODES.DRIVER_NOT_FOUND,
            ERROR_CODES.PAYMENT_METHOD_REQUIRED,
            ERROR_CODES.RESERVATION_EXPIRES_TOO_SOON,
            ERROR_CODES.RESERVATION_NOT_ACTIVE,
            ERROR_CODES.RESERVATION_TOO_LONG,
            ERROR_CODES.RESERVATION_WINDOW_TOO_SHORT,
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          404: errorWith('Resource not found', [
            ERROR_CODES.RESERVATION_NOT_FOUND,
            ERROR_CODES.EVSE_NOT_FOUND,
          ]),
          409: errorWith('Conflict', [
            ERROR_CODES.RESERVATION_CONFLICT,
            ERROR_CODES.RESERVATION_NOT_ACTIVE,
          ]),
          502: errorWith('Station rejected the re-sent ReserveNow', [
            ERROR_CODES.RESERVATION_REJECTED,
          ]),
          504: errorWith('Station did not respond within timeout', [
            ERROR_CODES.RESERVATION_TIMEOUT,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof reservationIdParams>;
      const body = request.body as z.infer<typeof updateReservationBody>;

      const [existing] = await db
        .select({ id: reservations.id, siteId: chargingStations.siteId })
        .from(reservations)
        .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
        .where(eq(reservations.id, id));

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (existing == null || !siteInScope(siteIds, existing.siteId)) {
        await reply
          .status(404)
          .send({ error: 'Reservation not found', code: 'RESERVATION_NOT_FOUND' });
        return;
      }

      // The service validates the edit like a create, checks overlaps under
      // the station lock, guards the status, and re-sends ReserveNow for an
      // active hold (G14).
      await updateReservation({
        reservationDbId: id,
        changes: {
          driverId: body.driverId,
          evseOcppId: body.evseId,
          expiresAt: body.expiresAt != null ? new Date(body.expiresAt) : undefined,
          tokenId: body.tokenId,
        },
        actor: { kind: 'operator', userId },
        logger: request.log,
      });

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
          tokenId: reservations.tokenId,
          tokenIdToken: driverTokens.idToken,
          tokenType: driverTokens.tokenType,
          status: reservations.status,
          expiresAt: reservations.expiresAt,
          createdAt: reservations.createdAt,
          updatedAt: reservations.updatedAt,
          cancelledBy: reservations.cancelledBy,
          cancelReason: reservations.cancelReason,
          cancelNote: reservations.cancelNote,
          cancellationFeeCents: reservations.cancellationFeeCents,
          feeTaxBasis: reservations.feeTaxBasis,
          feeTaxRate: reservations.feeTaxRate,
          feePerMinute: reservations.feePerMinute,
          feeCancellationCents: reservations.feeCancellationCents,
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
        .leftJoin(driverTokens, eq(reservations.tokenId, driverTokens.id))
        .leftJoin(evses, eq(reservations.evseId, evses.id))
        .leftJoin(chargingSessions, eq(chargingSessions.reservationId, reservations.id))
        .where(eq(reservations.id, id));

      if (updated == null) return updated;
      // The fee terms columns stay internal; the response carries the priced fee.
      const { feeTaxBasis, feeTaxRate, feePerMinute, feeCancellationCents, ...detail } = updated;
      return {
        ...detail,
        cancellationFee: await reservationCancellationFeeView(
          {
            status: updated.status,
            stationId: updated.stationId,
            driverId: updated.driverId,
            feeTaxBasis,
            feeTaxRate,
            feePerMinute,
            feeCancellationCents,
          },
          request.log,
        ),
      };
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
        description:
          'Marks the reservation cancelled with actor=operator, then sends CancelReservation to the station and waits for the answer (skipped for scheduled reservations not yet pushed). When chargeCancellationFee=true and the driver has a default payment method, a fee charge is attempted and reflected in the response. Sends a reservation.Cancelled notification to the driver when this caller wins the cancellation race. When the station refuses the cancel or does not answer, the reservation stays cancelled and the response carries warning station_cancel_failed.',
        operationId: 'cancelReservation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(reservationIdParams),
        // Body schema deliberately not declared at the route level so existing
        // clients that send no payload still work. The shape is documented on
        // cancelReservationBody and parsed manually in the handler.
        response: {
          200: itemResponse(cancelReservationResponse),
          400: errorWith('Bad request', [
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.RESERVATION_NOT_ACTIVE,
          ]),
          404: errorWith('Reservation not found', [ERROR_CODES.RESERVATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof reservationIdParams>;
      const rawBody = request.body as CancelReservationBody | null;
      const chargeCancellationFee = rawBody?.chargeCancellationFee === true;
      const operatorReason = rawBody?.reason;
      // Defensive runtime validation: the route-level Zod body validator was
      // dropped to keep DELETE-without-payload working, so enforce length and
      // type checks here.
      if (operatorReason != null && typeof operatorReason !== 'string') {
        await reply
          .status(400)
          .send({ error: 'reason must be a string', code: 'VALIDATION_ERROR' });
        return;
      }
      if (operatorReason != null && operatorReason.length > 500) {
        await reply.status(400).send({
          error: 'reason cannot exceed 500 characters',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

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
      if (!siteInScope(siteIds, reservation.siteId)) {
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

      // Database first (G7): the guarded cancel flips the row (one winner,
      // which audits and may charge the fee when the operator opts in), then
      // the winner of an active hold sends CancelReservation and waits for the
      // answer. A refused or unanswered cancel is audited and returned as a
      // warning; the row stays cancelled.
      const result = await cancelReservationWithStation({
        reservationDbId: reservation.id,
        siteId: reservation.siteId,
        driverId: reservation.driverId,
        startsAt: reservation.startsAt ?? reservation.createdAt,
        createdAt: reservation.createdAt,
        actor: 'operator',
        actorUserId: userId,
        reason: 'operator_manual',
        note: operatorReason,
        chargeFee: chargeCancellationFee,
        payments: paymentContext(request.log, getAuditActor(request)),
        logger: request.log,
        stationOcppId: reservation.stationOcppId,
        reservationOcppId: reservation.reservationId,
        waitForStation: true,
      });

      // Only the caller that flipped the row notifies: a concurrent cancel
      // that won already sent its own notice.
      if (result.cancelled) {
        // The fee charged (tax included), formatted in the driver's language.
        const feeCharged = result.feeChargedCents > 0 && result.feeCurrency != null;
        void notifyReservationDriver(
          'reservation.Cancelled',
          {
            reservationDbId: reservation.id,
            reservationOcppId: reservation.reservationId,
            stationOcppId: reservation.stationOcppId,
            driverId: reservation.driverId,
          },
          {
            cancellationFeeFormatted:
              feeCharged && result.feeCurrency != null
                ? notificationMoney(result.feeChargedCents, result.feeCurrency)
                : '',
            cancellationFeeCents: result.feeChargedCents,
            currency: result.feeCurrency ?? '',
          },
          { logger: request.log },
        );
      }

      return {
        status: 'cancelled',
        cancellationFeeChargedCents: result.feeChargedCents,
        ...(result.feeChargeFailed ? { feeChargeFailed: true } : {}),
        ...(result.warning != null ? { warning: result.warning } : {}),
      };
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
        description:
          'Moves a reservation to a different station and optionally a different EVSE. The new station gets the create checks (online for an active reservation, eligibility, maintenance, EVSE, busy EVSE, overlap). For scheduled reservations the move is a guarded database update; the worker dispatches ReserveNow at startsAt. For active reservations, ReserveNow is sent to the new station first; on success the row moves under a status guard and a best-effort CancelReservation is sent to the old station. Returns 400 if the new station rejects the ReserveNow, 409 RESERVATION_CONFLICT when the window overlaps another reservation on the new station, and 409 RESERVATION_NOT_ACTIVE when the reservation ended meanwhile (the new station then gets CancelReservation).',
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
          400: errorWith('Bad request', [
            ERROR_CODES.RESERVATION_NOT_ACTIVE,
            ERROR_CODES.RESERVATION_REJECTED,
            ERROR_CODES.STATION_OFFLINE,
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          403: errorWith('Forbidden', [ERROR_CODES.FORBIDDEN, ERROR_CODES.RESERVATION_DISABLED]),
          404: errorWith('Resource not found', [
            ERROR_CODES.EVSE_NOT_FOUND,
            ERROR_CODES.RESERVATION_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
          409: errorWith('Conflict', [
            ERROR_CODES.EVSE_IN_USE,
            ERROR_CODES.RESERVATION_CONFLICT,
            ERROR_CODES.RESERVATION_DURING_MAINTENANCE,
            ERROR_CODES.RESERVATION_NOT_ACTIVE,
            ERROR_CODES.STATION_UNAVAILABLE,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof reservationIdParams>;
      const body = request.body as { newStationOcppId: string; newEvseId?: number };
      const { newStationOcppId, newEvseId } = body;

      const [reservation] = await db
        .select({ id: reservations.id, siteId: chargingStations.siteId })
        .from(reservations)
        .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
        .where(eq(reservations.id, id));

      // Site access control on the reservation's current station
      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (reservation == null || !siteInScope(siteIds, reservation.siteId)) {
        await reply
          .status(404)
          .send({ error: 'Reservation not found', code: 'RESERVATION_NOT_FOUND' });
        return;
      }

      const [newStation] = await db
        .select(reservationStationColumns)
        .from(chargingStations)
        .where(eq(chargingStations.stationId, newStationOcppId));

      // Site access control on the new station
      if (newStation == null || !siteInScope(siteIds, newStation.siteId)) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // The service checks the new station like a create, moves the row
      // under the new station's lock with a status guard, and sends
      // ReserveNow and CancelReservation for an active hold (G14).
      try {
        await reassignReservation({
          reservationDbId: id,
          newStation,
          newEvseOcppId: newEvseId,
          actor: { kind: 'operator', userId },
          logger: request.log,
        });
      } catch (err) {
        if (await sendMaintenanceConflict(reply, err)) return;
        throw err;
      }

      return { status: 'reassigned', newStationOcppId };
    },
  );
}
