// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, or, ilike, desc, sql, count, inArray, gt } from 'drizzle-orm';
import { db, client } from '@evtivity/database';
import {
  reservations,
  reservationAuditLog,
  chargingStations,
  chargingSessions,
  drivers,
  driverPaymentMethods,
  driverTokens,
  evses,
  connectors,
  sites,
  ocppMessageLogs,
  users,
  getReservationSettings,
  writeReservationAudit,
  reservationDiffChanged,
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
import { paginatedResponse, itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { applyReservationCancellation } from '../lib/reservation-cancel.js';
import { assertReservationsAllowed } from '../lib/reservation-eligibility.js';
import { assertNoMaintenanceConflict, MaintenanceConflictError } from '../lib/maintenance-check.js';
import { authorize } from '../middleware/rbac.js';

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
        'system_cleanup',
      ])
      .nullable()
      .describe('Typed cancel reason, null if not cancelled'),
    cancelNote: z.string().max(500).nullable().describe('Operator-provided free-text note'),
    cancellationFeeCents: z
      .number()
      .int()
      .min(0)
      .describe('Cancellation fee charged in cents (0 when waived or no payment method)'),
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
  })
  .passthrough();

const cancelReservationResponse = z
  .object({
    status: z.literal('cancelled').describe('Always "cancelled" when the request succeeds'),
    cancellationFeeChargedCents: z
      .number()
      .int()
      .min(0)
      .describe('Actual fee charged in cents (0 when waived or no payment method)'),
    feeChargeFailed: z
      .boolean()
      .optional()
      .describe(
        'True when a fee was attempted but the Stripe charge threw. Audit row shows 0; reconcile via Stripe.',
      ),
    warning: z
      .string()
      .optional()
      .describe('Non-fatal warning message (e.g. station OCPP CancelReservation timed out)'),
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
  evseId: z.coerce.number().int().optional().describe('EVSE ID on the station'),
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
  evseId: z.coerce.number().int().nullable().optional().describe('EVSE ID on the station'),
  expiresAt: z.string().datetime().optional().describe('ISO 8601 expiration date-time'),
  tokenId: ID_PARAMS.driverTokenId
    .nullable()
    .optional()
    .describe('Driver token ID to bind, or null to unbind. Must belong to the same driver.'),
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
      if (siteIds != null && reservation.siteId != null && !siteIds.includes(reservation.siteId)) {
        await reply
          .status(404)
          .send({ error: 'Reservation not found', code: 'RESERVATION_NOT_FOUND' });
        return;
      }

      return reservation;
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
      if (siteIds != null && reservation.siteId != null && !siteIds.includes(reservation.siteId)) {
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
              sql`(${ocppMessageLogs.payload} #>> '{}')::jsonb @> jsonb_build_object('id', ${reservation.reservationId}::int)`,
              sql`(${ocppMessageLogs.payload} #>> '{}')::jsonb @> jsonb_build_object('reservationId', ${reservation.reservationId}::int)`,
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
          .orderBy(desc(ocppMessageLogs.createdAt), desc(ocppMessageLogs.id))
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
        description:
          'Creates a charging reservation and dispatches ReserveNow to the station. Future-dated reservations are persisted with status=scheduled and activated by a delayed worker job at startsAt; immediate reservations are sent to the station synchronously. Returns 409 if another active reservation conflicts with the requested EVSE/time window. Returns 502/504 when the station rejects or times out on the synchronous ReserveNow call.',
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
          403: errorWith('Forbidden', [ERROR_CODES.FORBIDDEN]),
          404: errorWith('Resource not found', [
            ERROR_CODES.EVSE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
          409: errorWith('Conflict', [
            ERROR_CODES.EVSE_IN_USE,
            ERROR_CODES.RESERVATION_CONFLICT,
            ERROR_CODES.RESERVATION_DURING_MAINTENANCE,
          ]),
          500: errorWith('Reservation create failed', [ERROR_CODES.RESERVATION_CREATE_FAILED]),
          502: errorWith('Station rejected the command', [ERROR_CODES.RESERVATION_REJECTED]),
          504: errorWith('Station did not respond within timeout', [
            ERROR_CODES.RESERVATION_TIMEOUT,
          ]),
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

      const reservationStart = body.startsAt != null ? new Date(body.startsAt) : new Date();
      const reservationEnd = new Date(body.expiresAt);
      try {
        await assertNoMaintenanceConflict(station.id, reservationStart, reservationEnd);
      } catch (err) {
        if (err instanceof MaintenanceConflictError) {
          await reply.status(409).send({
            error: err.message,
            code: err.code,
            ...err.details,
          });
          return;
        }
        throw err;
      }

      // Window validation. datetime-local inputs only have minute precision,
      // so a "now"-ish click can produce expiresAt seconds in the past once it
      // hits the API. Stations parse this and fire their expiry timer at 0ms,
      // sending StatusNotification(Available) back immediately -- the
      // reservation looks "expired" the moment it's created. Require at least
      // 60s of runway, and that startsAt < expiresAt.
      const MIN_DURATION_MS = 60_000;
      const expiresAtTime = new Date(body.expiresAt).getTime();
      const startsAtTime = body.startsAt != null ? new Date(body.startsAt).getTime() : Date.now();
      if (expiresAtTime - startsAtTime < MIN_DURATION_MS) {
        await reply.status(400).send({
          error: 'Reservation must end at least 60 seconds after it starts',
          code: 'RESERVATION_WINDOW_TOO_SHORT',
        });
        return;
      }
      // Reject explicit startsAt in the past (beyond the 60s slack). The slack
      // covers form-submit drift where a "now"-ish startsAt rolls slightly past
      // by the time the request lands at the API.
      if (body.startsAt != null && startsAtTime < Date.now() - MIN_DURATION_MS) {
        await reply.status(400).send({
          error: 'Reservation start time cannot be in the past',
          code: 'RESERVATION_STARTS_IN_PAST',
        });
        return;
      }
      if (expiresAtTime - Date.now() < MIN_DURATION_MS) {
        await reply.status(400).send({
          error: 'Reservation must end at least 60 seconds in the future',
          code: 'RESERVATION_EXPIRES_TOO_SOON',
        });
        return;
      }
      // System-wide cap on how long a single reservation can run. Stops
      // operators / drivers from blocking a connector indefinitely.
      const reservationCfgForLimit = await getReservationSettings();
      const maxDurationMs = reservationCfgForLimit.maxHours * 60 * 60 * 1000;
      if (maxDurationMs > 0 && expiresAtTime - startsAtTime > maxDurationMs) {
        await reply.status(400).send({
          error: `Reservation cannot exceed ${String(reservationCfgForLimit.maxHours)} hours`,
          code: 'RESERVATION_TOO_LONG',
        });
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

      const newStart = body.startsAt != null ? new Date(body.startsAt) : new Date();
      const newEnd = new Date(body.expiresAt);

      // If the reservation starts within `reservation.activeSessionCheckHours`
      // of "now", reject when the targeted EVSE (or any EVSE on the station
      // for station-wide reservations) has a connector in any non-Available
      // state. OCPP ReserveNow requires the connector to be Available; a
      // cable plugged in with no active transaction (status `occupied` /
      // `ev_connected` / `finishing`) still trips the station's Occupied
      // reply, so checking only the active session table misses that case
      // and the worker's blind dispatch then triggers a confusing
      // "cancelled" notification at activation time. Reservations scheduled
      // far enough in the future are allowed; the worker re-validates the
      // connector state at activation and decides whether to send
      // ReserveNow, link to a same-driver session, or cancel up front with
      // a clearer reason. Setting reservation.activeSessionCheckHours = 0
      // disables the check.
      const activeSessionCheckMs = reservationCfgForLimit.activeSessionCheckHours * 60 * 60 * 1000;
      const startsAtTimeMs = newStart.getTime();
      if (activeSessionCheckMs > 0 && startsAtTimeMs - Date.now() < activeSessionCheckMs) {
        const connectorConditions = [
          eq(evses.stationId, station.id),
          sql`${connectors.status} <> 'available'`,
        ];
        if (resolvedEvseId != null) {
          connectorConditions.push(eq(evses.id, resolvedEvseId));
        }
        const [busyConnector] = await db
          .select({ status: connectors.status })
          .from(connectors)
          .innerJoin(evses, eq(connectors.evseId, evses.id))
          .where(and(...connectorConditions))
          .limit(1);
        if (busyConnector != null) {
          await reply.status(409).send({
            error:
              resolvedEvseId != null
                ? `EVSE is not available (connector status: ${busyConnector.status})`
                : `Station has no available connector (status: ${busyConnector.status})`,
            code: 'EVSE_IN_USE',
          });
          return;
        }
      }

      // Check for conflicting active or scheduled reservations whose time
      // window OVERLAPS the requested one. Two windows [aStart, aEnd] and
      // [bStart, bEnd] overlap iff aStart < bEnd AND bStart < aEnd. The
      // existing reservation's start defaults to its createdAt when there's
      // no explicit startsAt (the holder reserved for "now"). The new
      // reservation's start defaults to NOW() when the caller did not pass
      // startsAt. Without time-overlap math the check would block any
      // future reservation just because some other future window exists on
      // the same EVSE.
      const conflictConditions = [
        eq(reservations.stationId, station.id),
        or(eq(reservations.status, 'active'), eq(reservations.status, 'scheduled')),
        // existingStart < newEnd. The left side is a raw SQL fragment so
        // Drizzle has no column type to drive Date serialization; pass an
        // ISO string explicitly to avoid postgres-js binding a Date as a
        // generic parameter.
        sql`COALESCE(${reservations.startsAt}, ${reservations.createdAt}) < ${newEnd.toISOString()}`,
        // existing.expiresAt > newStart
        gt(reservations.expiresAt, newStart),
      ];
      if (resolvedEvseId != null) {
        // EVSE-specific request: only conflict with same EVSE OR with
        // station-level reservations (evseId IS NULL applies to all EVSEs).
        conflictConditions.push(
          or(eq(reservations.evseId, resolvedEvseId), sql`${reservations.evseId} IS NULL`),
        );
      }
      // Station-level request (resolvedEvseId is null) conflicts with any
      // reservation on this station regardless of EVSE -- no extra
      // condition needed.
      const [conflict] = await db
        .select({ id: reservations.id })
        .from(reservations)
        .where(and(...conflictConditions))
        .limit(1);

      if (conflict != null) {
        await reply.status(409).send({
          error: 'A reservation already exists for this connector during the requested window',
          code: 'RESERVATION_CONFLICT',
        });
        return;
      }

      // Validate driverId references a real row before INSERT so we surface a
      // 400 instead of letting Postgres raise an FK violation (which the
      // generic error handler would mask as "Internal server error").
      if (body.driverId != null) {
        const [driverRow] = await db
          .select({ id: drivers.id })
          .from(drivers)
          .where(eq(drivers.id, body.driverId));
        if (driverRow == null) {
          await reply.status(400).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
          return;
        }

        // Require a default payment method for driver-attached reservations.
        // The reservation may incur a no-show holding fee or a cancellation
        // fee, both of which need a card on file. Operator-comp reservations
        // (no driver) skip this check.
        const [pm] = await db
          .select({ id: driverPaymentMethods.id })
          .from(driverPaymentMethods)
          .where(
            and(
              eq(driverPaymentMethods.driverId, body.driverId),
              eq(driverPaymentMethods.isDefault, true),
            ),
          )
          .limit(1);
        if (pm == null) {
          await reply.status(400).send({
            error: 'Driver has no default payment method',
            code: 'PAYMENT_METHOD_REQUIRED',
          });
          return;
        }
      }

      const reservationId = await getNextReservationId();

      // Determine if this is a future-scheduled reservation
      const isFutureScheduled =
        body.startsAt != null && new Date(body.startsAt).getTime() > Date.now();

      // Validate the optional tokenId belongs to the same driver. Without
      // this check an operator could bind the reservation to anyone's card.
      let resolvedTokenId: string | null = null;
      if (body.tokenId != null) {
        if (body.driverId == null) {
          await reply.status(400).send({
            error: 'tokenId requires driverId',
            code: 'VALIDATION_ERROR',
          });
          return;
        }
        const [tokenRow] = await db
          .select({ id: driverTokens.id, driverId: driverTokens.driverId })
          .from(driverTokens)
          .where(eq(driverTokens.id, body.tokenId))
          .limit(1);
        if (tokenRow == null || tokenRow.driverId !== body.driverId) {
          await reply.status(400).send({
            error: 'tokenId does not belong to driver',
            code: 'VALIDATION_ERROR',
          });
          return;
        }
        resolvedTokenId = tokenRow.id;
      }

      // Insert reservation row. Wrap in try/catch so unexpected DB errors
      // (e.g. unique-constraint races on reservation_id) bubble back as a
      // structured 500 with the actual message instead of the generic
      // "Internal server error" from the global Fastify handler.
      let reservation: typeof reservations.$inferSelect | undefined;
      try {
        const inserted = await db
          .insert(reservations)
          .values({
            reservationId,
            stationId: station.id,
            evseId: resolvedEvseId,
            driverId: body.driverId ?? null,
            tokenId: resolvedTokenId,
            status: isFutureScheduled ? 'scheduled' : 'active',
            expiresAt: new Date(body.expiresAt),
            ...(body.startsAt != null ? { startsAt: new Date(body.startsAt) } : {}),
          })
          .returning();
        reservation = inserted[0];
      } catch (err) {
        request.log.error(
          { err, stationId: body.stationId, driverId: body.driverId },
          'Reservation INSERT failed',
        );
        const message = err instanceof Error ? err.message : 'Failed to create reservation';
        await reply.status(500).send({ error: message, code: 'RESERVATION_CREATE_FAILED' });
        return;
      }

      if (reservation == null) {
        await reply
          .status(500)
          .send({ error: 'Failed to create reservation', code: 'RESERVATION_CREATE_FAILED' });
        return;
      }

      await writeReservationAudit(
        {
          reservationId: reservation.id,
          action: 'created',
          actor: 'operator',
          actorUserId: userId,
          driverIdAfter: reservation.driverId,
          tokenIdAfter: reservation.tokenId,
          evseIdAfter: reservation.evseId,
          statusAfter: reservation.status,
          expiresAtAfter: reservation.expiresAt,
        },
        undefined,
        request.log,
      );

      // Tell the CSMS so the Reservations page reloads for other operators.
      void getPubSub()
        .publish(
          'csms_events',
          JSON.stringify({
            eventType: 'reservation.changed',
            stationId: null,
            siteId: station.siteId ?? null,
            sessionId: null,
          }),
        )
        .catch(() => {
          /* best-effort */
        });

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
        // Station rejected or timed out: roll back through the helper so the
        // audit row carries actor=system + reason. System path never charges.
        const rollback = await applyReservationCancellation({
          reservationDbId: reservation.id,
          siteId: station.siteId,
          driverId: reservation.driverId,
          startsAt: reservation.startsAt ?? reservation.createdAt,
          createdAt: reservation.createdAt,
          actor: 'system',
          reason: 'station_rejected_other',
          chargeFee: false,
          logger: request.log,
        });

        // Tell the driver their reservation was killed. The command.ReserveNow
        // projection also tries to dispatch on rejection, but its UPDATE will
        // see no row when this route's UPDATE has already won the race -- so
        // we must dispatch here when we won, and skip when we didn't.
        if (rollback.cancelled && reservation.driverId != null) {
          void dispatchDriverNotification(
            client,
            'reservation.Cancelled',
            reservation.driverId,
            {
              reservationId: reservation.reservationId,
              stationId: body.stationId,
              cancellationFeeFormatted: '',
            },
            ALL_TEMPLATES_DIRS,
            getPubSub(),
          );
        }

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
        const rollback = await applyReservationCancellation({
          reservationDbId: reservation.id,
          siteId: station.siteId,
          driverId: reservation.driverId,
          startsAt: reservation.startsAt ?? reservation.createdAt,
          createdAt: reservation.createdAt,
          actor: 'system',
          reason:
            responseStatus === 'Occupied' ? 'station_rejected_occupied' : 'station_rejected_other',
          chargeFee: false,
          logger: request.log,
        });

        // Same race rationale as above: the command.ReserveNow projection
        // would otherwise miss the dispatch when this UPDATE wins.
        if (rollback.cancelled && reservation.driverId != null) {
          void dispatchDriverNotification(
            client,
            'reservation.Cancelled',
            reservation.driverId,
            {
              reservationId: reservation.reservationId,
              stationId: body.stationId,
              cancellationFeeFormatted: '',
            },
            ALL_TEMPLATES_DIRS,
            getPubSub(),
          );
        }

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
        description:
          'Updates the driver, EVSE, or expiration on an active or scheduled reservation. Does not re-send ReserveNow; the row is mutated in place and the worker (for scheduled) or the existing station-side reservation continues. Returns 409 if the new EVSE/time window conflicts with another reservation on the station.',
        operationId: 'updateReservation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(reservationIdParams),
        body: zodSchema(updateReservationBody),
        response: {
          200: itemResponse(reservationDetailItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Resource not found', [
            ERROR_CODES.RESERVATION_NOT_FOUND,
            ERROR_CODES.EVSE_NOT_FOUND,
          ]),
          409: errorWith('Reservation conflict', [ERROR_CODES.RESERVATION_CONFLICT]),
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
          driverId: reservations.driverId,
          tokenId: reservations.tokenId,
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

      // Handle driverId. If the driver changes and the caller did NOT supply
      // an explicit new tokenId, clear the existing tokenId to prevent a
      // cross-driver leak (an old reservation token still pointing at the
      // previous owner). Caller can re-bind a new token via the same PATCH.
      if (body.driverId !== undefined) {
        updates['driverId'] = body.driverId;
        const driverChanged = body.driverId !== existing.driverId;
        if (driverChanged && body.tokenId === undefined && existing.tokenId != null) {
          updates['tokenId'] = null;
        }
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

      // Handle tokenId: validate that the token belongs to the reservation's
      // driver. Allow null to unbind. body.driverId takes precedence as the
      // new driver if it was just changed in this same PATCH.
      if (body.tokenId !== undefined) {
        if (body.tokenId === null) {
          updates['tokenId'] = null;
        } else {
          const targetDriverId = body.driverId !== undefined ? body.driverId : existing.driverId;
          if (targetDriverId == null) {
            await reply.status(400).send({
              error: 'tokenId requires driverId',
              code: 'VALIDATION_ERROR',
            });
            return;
          }
          const [tokenRow] = await db
            .select({ id: driverTokens.id, driverId: driverTokens.driverId })
            .from(driverTokens)
            .where(eq(driverTokens.id, body.tokenId))
            .limit(1);
          if (tokenRow == null || tokenRow.driverId !== targetDriverId) {
            await reply.status(400).send({
              error: 'tokenId does not belong to driver',
              code: 'VALIDATION_ERROR',
            });
            return;
          }
          updates['tokenId'] = tokenRow.id;
        }
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

      // Audit the diff. Skip the row entirely when no audited field actually
      // changed -- a PATCH that only bumps updatedAt is noise.
      const newDriverId =
        'driverId' in updates ? (updates['driverId'] as string | null) : existing.driverId;
      const newTokenId =
        'tokenId' in updates ? (updates['tokenId'] as string | null) : existing.tokenId;
      const newEvseId =
        'evseId' in updates ? (updates['evseId'] as string | null) : existing.evseId;
      const newExpiresAt =
        'expiresAt' in updates ? (updates['expiresAt'] as Date) : existing.expiresAt;
      const changed = reservationDiffChanged(
        {
          driverId: existing.driverId,
          tokenId: existing.tokenId,
          evseId: existing.evseId,
          expiresAt: existing.expiresAt,
        },
        {
          driverId: newDriverId,
          tokenId: newTokenId,
          evseId: newEvseId,
          expiresAt: newExpiresAt,
        },
      );
      if (changed) {
        await writeReservationAudit(
          {
            reservationId: id,
            action: 'updated',
            actor: 'operator',
            actorUserId: userId,
            driverIdBefore: existing.driverId,
            driverIdAfter: newDriverId,
            tokenIdBefore: existing.tokenId,
            tokenIdAfter: newTokenId,
            evseIdBefore: existing.evseId,
            evseIdAfter: newEvseId,
            statusBefore: existing.status,
            statusAfter: existing.status,
            expiresAtBefore: existing.expiresAt,
            expiresAtAfter: newExpiresAt,
          },
          undefined,
          request.log,
        );
      }

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
        description:
          'Dispatches CancelReservation to the station (skipped for scheduled reservations not yet pushed) and marks the reservation cancelled with actor=operator. When chargeCancellationFee=true and the driver has a default payment method, a fee charge is attempted via Stripe and reflected in the response. Sends a reservation.Cancelled notification to the driver when this caller wins the cancellation race. Returns warning text instead of an error when the OCPP CancelReservation call times out.',
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

      // Skip OCPP CancelReservation for scheduled reservations (not yet sent to station)
      let result: { error?: string } = {};
      if (!isScheduled) {
        result = await sendOcppCommandAndWait(reservation.stationOcppId, 'CancelReservation', {
          reservationId: reservation.reservationId,
        });
      }

      // Apply the cancellation. The helper writes actor/reason metadata,
      // optionally charges the fee (gated by chargeCancellationFee), and
      // marks the row cancelled in one place. We pass actor='operator' here;
      // the helper guarantees system paths can never charge.
      const { feeChargedCents, cancelled, feeChargeFailed } = await applyReservationCancellation({
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
        logger: request.log,
      });

      // Only notify the driver when this caller actually flipped the row.
      // A concurrent cancel (driver/system) winning the race already sent its
      // own notification; firing another would deliver a misleading
      // "feeFormatted: ''" message and double-notify.
      if (cancelled && reservation.driverId != null) {
        const cancellationFeeFormatted =
          feeChargedCents > 0 ? `$${(feeChargedCents / 100).toFixed(2)}` : '';
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
        return {
          status: 'cancelled',
          cancellationFeeChargedCents: feeChargedCents,
          ...(feeChargeFailed ? { feeChargeFailed: true } : {}),
          warning: result.error,
        };
      }

      return {
        status: 'cancelled',
        cancellationFeeChargedCents: feeChargedCents,
        ...(feeChargeFailed ? { feeChargeFailed: true } : {}),
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
          'Moves a reservation to a different station and optionally a different EVSE. For scheduled reservations the move is a pure DB update; the worker dispatches ReserveNow at startsAt. For active reservations, ReserveNow is sent to the new station first; on success the row is updated and a best-effort CancelReservation is sent to the old station. Returns 400 if the new station rejects the ReserveNow.',
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
            ERROR_CODES.RESERVATION_REJECTED,
            ERROR_CODES.STATION_OFFLINE,
          ]),
          403: errorWith('Forbidden', [ERROR_CODES.FORBIDDEN]),
          404: errorWith('Resource not found', [
            ERROR_CODES.EVSE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
          409: errorWith('Conflict', [ERROR_CODES.RESERVATION_DURING_MAINTENANCE]),
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
          startsAt: reservations.startsAt,
          expiresAt: reservations.expiresAt,
          createdAt: reservations.createdAt,
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

      // 2. Validate reservation is active or scheduled. Scheduled reservations
      // have no station-side ReserveNow yet (worker fires it at startsAt), so
      // reassign for those is a pure DB update -- the worker will later target
      // the updated station.
      if (reservation.status !== 'active' && reservation.status !== 'scheduled') {
        await reply
          .status(400)
          .send({ error: 'Reservation is not active', code: 'RESERVATION_NOT_ACTIVE' });
        return;
      }
      const isScheduled = reservation.status === 'scheduled';

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

      // 4. Online check applies only to active reassign. Scheduled reassign
      // mirrors the create-reservation behavior: the new station has time to
      // come online before startsAt.
      if (!isScheduled && !newStation.isOnline) {
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

      // 5b. Maintenance check on the NEW station for the reservation's window.
      try {
        await assertNoMaintenanceConflict(
          newStation.id,
          reservation.startsAt ?? reservation.createdAt,
          reservation.expiresAt,
        );
      } catch (err) {
        if (err instanceof MaintenanceConflictError) {
          await reply.status(409).send({
            error: err.message,
            code: err.code,
            ...err.details,
          });
          return;
        }
        throw err;
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

      // 7. Scheduled reassign: pure DB update, no OCPP calls.
      // The worker activation handler will send ReserveNow to the updated
      // station at startsAt.
      if (isScheduled) {
        await db
          .update(reservations)
          .set({
            stationId: newStation.id,
            evseId: resolvedNewEvseId,
            updatedAt: new Date(),
          })
          .where(eq(reservations.id, id));
        await writeReservationAudit(
          {
            reservationId: id,
            action: 'updated',
            actor: 'operator',
            actorUserId: userId,
            evseIdBefore: reservation.evseId,
            evseIdAfter: resolvedNewEvseId,
            notes: `reassigned to station ${newStationOcppId} (was ${reservation.stationOcppId})`,
          },
          undefined,
          request.log,
        );
        return { status: 'reassigned', newStationOcppId };
      }

      // 8. Active reassign: send ReserveNow to new station FIRST
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

      // 9. Update reservation row with new station and evse BEFORE cancelling old
      await db
        .update(reservations)
        .set({
          stationId: newStation.id,
          evseId: resolvedNewEvseId,
          updatedAt: new Date(),
        })
        .where(eq(reservations.id, id));
      await writeReservationAudit(
        {
          reservationId: id,
          action: 'updated',
          actor: 'operator',
          actorUserId: userId,
          evseIdBefore: reservation.evseId,
          evseIdAfter: resolvedNewEvseId,
          notes: `reassigned to station ${newStationOcppId} (was ${reservation.stationOcppId})`,
        },
        undefined,
        request.log,
      );

      // 10. Cancel on old station (best effort, after DB update)
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

      return { status: 'reassigned', newStationOcppId };
    },
  );
}
