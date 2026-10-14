// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, asc, desc, count, inArray } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { reservations, chargingStations, fleetReservations, fleets } from '@evtivity/database';
import { AppError } from '@evtivity/lib';
import { zodSchema } from '../lib/zod-schema.js';
import {
  isReservedProfileId,
  maxExternalConstraintsIdByIdentity,
} from '../lib/charging-profile-id.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import { paginatedResponse, itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { sendOcppCommandAndWait } from '@evtivity/services/ocpp-command';
import {
  cancelReservationWithStation,
  createReservation,
  dispatchReservation,
} from '@evtivity/services/reservation.service';
import type { ReservationRow, ReservationStation } from '@evtivity/services/reservation.service';
import {
  FLEET_RESERVATION_STATUSES,
  initialFleetReservationStatus,
  refreshFleetReservationStatuses,
  syncFleetReservationStatus,
} from '@evtivity/services/fleet-reservation-status';
import { getUserSiteIds } from '../lib/site-access.js';
import { authorize } from '../middleware/rbac.js';
import { siteInScope } from '../lib/site-scope.js';
import { stationInSitesSql } from '../lib/fleet-operation-scope.js';

// -- Response schemas --

const fleetReservationListItem = z
  .object({
    id: z.string().describe('Identifier'),
    fleetId: z.string().describe('Fleet identifier this reservation belongs to'),
    name: z.string().max(255).nullable().describe('Optional display name'),
    status: z
      .enum(FLEET_RESERVATION_STATUSES)
      .describe(
        'Status derived from the slots: scheduled (every live slot waits for its start), active (a slot is on its station), partial (a slot is live and another was cancelled or expired), completed (every slot ended and one was used), expired (every slot ended, none used, one expired), cancelled (every slot cancelled). completed, expired and cancelled are final.',
      ),
    startsAt: z.coerce.date().nullable().describe('Scheduled start time'),
    expiresAt: z.coerce.date().describe('Reservation expiry time'),
    createdAt: z.coerce.date().describe('Timestamp when created'),
    updatedAt: z.coerce.date().describe('Timestamp when last modified'),
    reservationCount: z
      .number()
      .int()
      .min(0)
      .describe('Number of individual reservations under this fleet reservation'),
  })
  .passthrough();

const slotResultItem = z
  .object({
    stationOcppId: z.string().max(255).describe('OCPP station identifier'),
    evseId: z.number().int().min(1).nullable().describe('EVSE ID requested for this slot'),
    reservationId: z
      .string()
      .nullable()
      .describe('Created reservation identifier, or null when rejected'),
    status: z.enum(['confirmed', 'rejected']).describe('Outcome of this slot'),
    error: z.string().max(500).nullable().describe('Error message when the slot was rejected'),
  })
  .passthrough();

const createFleetReservationResponse = z
  .object({
    id: z.string().describe('Fleet reservation identifier'),
    status: z
      .enum(['active', 'partial', 'cancelled'])
      .describe(
        'Aggregate status of the bulk operation: cancelled when no slot was confirmed, partial when some were',
      ),
    confirmed: z.number().int().min(0).describe('Number of slots confirmed by their stations'),
    failed: z.number().int().min(0).describe('Number of slots that failed or were rejected'),
    total: z.number().int().min(0).describe('Total number of slots requested'),
    results: z.array(slotResultItem).describe('Per-slot outcome details'),
  })
  .passthrough();

const cancelFleetReservationResponse = z
  .object({
    status: z
      .enum(FLEET_RESERVATION_STATUSES)
      .describe(
        'Fleet reservation status after the cancel: cancelled, or completed or expired when a slot was used or expired before, or partial while a slot is still in use',
      ),
    cancelledCount: z
      .number()
      .int()
      .min(0)
      .describe('Number of individual reservations that were cancelled'),
  })
  .passthrough();

type FleetSlotStation = ReservationStation;

// -- Request schemas --

const fleetIdParams = z.object({
  fleetId: ID_PARAMS.fleetId.describe('Fleet ID'),
});

const fleetReservationIdParams = z.object({
  id: z.string().describe('Fleet reservation ID'),
});

const createFleetReservationBody = z.object({
  name: z.string().max(255).optional().describe('Optional name for this fleet reservation'),
  slots: z
    .array(
      z.object({
        stationOcppId: z.string().min(1).max(255).describe('OCPP station identifier'),
        evseId: z.coerce.number().int().min(1).optional().describe('EVSE ID on the station'),
        driverId: ID_PARAMS.driverId.optional().describe('Driver ID'),
      }),
    )
    .min(1)
    .max(100)
    .describe('Array of reservation slots'),
  expiresAt: z.string().datetime().describe('ISO 8601 expiration date-time'),
  startsAt: z.string().datetime().optional().describe('ISO 8601 start date-time'),
  chargingProfile: z.record(z.unknown()).optional().describe('Charging profile to set on stations'),
});

export function fleetReservationRoutes(app: FastifyInstance): void {
  // POST /v1/fleets/:fleetId/reservations - Bulk create reservations
  app.post(
    '/fleets/:fleetId/reservations',
    {
      onRequest: [authorize('reservations:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Create bulk reservations for a fleet',
        description:
          "Creates one reservation per slot. Each slot runs the reservation create checks (window, length, online, eligibility, maintenance, EVSE, busy EVSE, overlap, the driver's payment method and fleet membership); a slot that fails one, or a second slot for the same EVSE and window, is rejected with its message. Future-dated slots are persisted as scheduled and activated by the worker; immediate ones dispatch ReserveNow and wait for the station, and only accepted ones get the optional charging profile. Returns the per-slot result. A slot at a station that does not exist or is outside the user's sites refuses the whole request with 404 STATION_NOT_FOUND before anything is written.",
        operationId: 'createFleetReservation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetIdParams),
        body: zodSchema(createFleetReservationBody),
        response: {
          201: itemResponse(createFleetReservationResponse),
          400: errorWith('Fleet reservation create failed', [
            ERROR_CODES.FLEET_RESERVATION_CREATE_FAILED,
          ]),
          404: errorWith('Fleet or station not found', [
            ERROR_CODES.FLEET_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { fleetId } = request.params as z.infer<typeof fleetIdParams>;
      const body = request.body as z.infer<typeof createFleetReservationBody>;
      const { userId } = request.user as { userId: string };

      // Validate fleet exists
      const [fleet] = await db.select({ id: fleets.id }).from(fleets).where(eq(fleets.id, fleetId));

      if (fleet == null) {
        await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
        return;
      }

      const siteIds = await getUserSiteIds(userId);

      // Batch-fetch all referenced stations in one query
      const slotStationOcppIds = [...new Set(body.slots.map((s) => s.stationOcppId))];
      const stationRows = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          isOnline: chargingStations.isOnline,
          reservationsEnabled: chargingStations.reservationsEnabled,
          disabledReason: chargingStations.disabledReason,
          firmwareState: chargingStations.firmwareState,
          reportedStatus: chargingStations.reportedStatus,
        })
        .from(chargingStations)
        .where(inArray(chargingStations.stationId, slotStationOcppIds));

      // A station outside the user's sites (or unsited) is left out. A slot
      // naming it, or a station that does not exist, refuses the whole
      // request with the same 404 before anything is written (no existence
      // oracle, P11).
      const stationMap = new Map(
        stationRows.filter((s) => siteInScope(siteIds, s.siteId)).map((s) => [s.stationId, s]),
      );
      if (slotStationOcppIds.some((id) => !stationMap.has(id))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Create fleet_reservations aggregate row
      const [fleetReservation] = await db
        .insert(fleetReservations)
        .values({
          fleetId,
          name: body.name ?? null,
          status: initialFleetReservationStatus(
            body.startsAt != null ? new Date(body.startsAt) : null,
          ),
          startsAt: body.startsAt != null ? new Date(body.startsAt) : null,
          expiresAt: new Date(body.expiresAt),
          chargingProfileData: body.chargingProfile ?? null,
          createdBy: userId,
        })
        .returning();

      if (fleetReservation == null) {
        await reply.status(400).send({
          error: 'Failed to create fleet reservation',
          code: 'FLEET_RESERVATION_CREATE_FAILED',
        });
        return;
      }

      type SlotResult = {
        stationOcppId: string;
        evseId: number | null;
        reservationId: string | null;
        status: 'confirmed' | 'rejected';
        error: string | null;
      };
      const rejected = (slot: (typeof body.slots)[number], error: string): SlotResult => ({
        stationOcppId: slot.stationOcppId,
        evseId: slot.evseId ?? null,
        reservationId: null,
        status: 'rejected',
        error,
      });

      // Phase 1: create each slot through the reservation service, one after
      // the other (G15): the window, length, online, eligibility, maintenance,
      // EVSE, busy EVSE, payment method, fleet membership and overlap checks
      // run per slot, and the station lock makes a second slot for the same
      // EVSE and window a conflict. A future start is scheduled.
      const startsAt = body.startsAt != null ? new Date(body.startsAt) : null;
      const expiresAt = new Date(body.expiresAt);
      const results: SlotResult[] = new Array<SlotResult>(body.slots.length);
      const created: Array<{ index: number; row: ReservationRow; station: FleetSlotStation }> = [];
      for (const [index, slot] of body.slots.entries()) {
        const station = stationMap.get(slot.stationOcppId);
        if (station == null) {
          results[index] = rejected(slot, `Station ${slot.stationOcppId} not found`);
          continue;
        }
        try {
          const row = await createReservation({
            station,
            evseOcppId: slot.evseId,
            driverId: slot.driverId ?? null,
            startsAt,
            expiresAt,
            actor: { kind: 'operator', userId },
            fleet: { fleetId, fleetReservationId: fleetReservation.id },
            auditNotes: `fleet reservation ${fleetReservation.id}`,
            logger: request.log,
          });
          created.push({ index, row, station });
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          results[index] = rejected(slot, err.message);
        }
      }

      // Phase 2: send each created slot to its station in parallel. A
      // scheduled slot is confirmed (the worker sends ReserveNow at its
      // start); an immediate one waits for the station, and any answer but
      // Accepted cancels it as system. Only accepted slots get the optional
      // charging profile.
      await Promise.all(
        created.map(async ({ index, row, station }) => {
          const slot = body.slots[index];
          if (slot == null) return;
          const outcome = await dispatchReservation(row, {
            stationOcppId: station.stationId,
            siteId: station.siteId,
            notifyCreated: false,
            logger: request.log,
          });
          if (outcome.kind === 'rejected') {
            results[index] = rejected(slot, `Station rejected reservation: ${outcome.status}`);
            return;
          }
          if (outcome.kind === 'no_response' || outcome.kind === 'failed') {
            results[index] = rejected(slot, outcome.error);
            return;
          }
          const profileId = body.chargingProfile?.['id'];
          const maxExternalId =
            outcome.kind === 'accepted' &&
            body.chargingProfile != null &&
            typeof profileId === 'number'
              ? await maxExternalConstraintsIdByIdentity(station.stationId)
              : null;
          if (
            outcome.kind === 'accepted' &&
            body.chargingProfile != null &&
            typeof profileId === 'number' &&
            maxExternalId != null &&
            isReservedProfileId(profileId, maxExternalId)
          ) {
            // K01.FR.81: the station would reject it; the reservation stands.
            request.log.warn(
              { stationId: station.stationId, profileId, maxExternalId },
              'Charging profile id is not above the station MaxExternalConstraintsId, profile not sent',
            );
          } else if (outcome.kind === 'accepted' && body.chargingProfile != null) {
            // Best effort: the reservation stands without the profile.
            const profile = await sendOcppCommandAndWait(station.stationId, 'SetChargingProfile', {
              evseId: slot.evseId ?? 0,
              chargingProfile: body.chargingProfile,
            });
            if (profile.error != null) {
              request.log.warn(
                { err: profile.error, stationId: station.stationId },
                'SetChargingProfile for the fleet reservation failed, keeping the reservation',
              );
            }
          }
          results[index] = {
            stationOcppId: station.stationId,
            evseId: slot.evseId ?? null,
            reservationId: row.id,
            status: 'confirmed',
            error: null,
          };
        }),
      );

      const confirmed = results.filter((r) => r.status === 'confirmed').length;
      const failed = results.filter((r) => r.status === 'rejected').length;

      let aggregateStatus: z.infer<typeof createFleetReservationResponse>['status'];
      if (confirmed === 0) {
        aggregateStatus = 'cancelled';
      } else if (failed === 0) {
        aggregateStatus = 'active';
      } else {
        aggregateStatus = 'partial';
      }

      // The stored booking status follows its slots (fail-open: the slots
      // are created and the response reports each one).
      await refreshFleetReservationStatuses([fleetReservation.id], request.log);

      await reply.status(201).send({
        id: fleetReservation.id,
        status: aggregateStatus,
        confirmed,
        failed,
        total: body.slots.length,
        results,
      });
    },
  );

  // GET /v1/fleets/:fleetId/reservations - List fleet reservations
  app.get(
    '/fleets/:fleetId/reservations',
    {
      onRequest: [authorize('reservations:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'List fleet reservations',
        operationId: 'listFleetReservations',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetIdParams),
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(fleetReservationListItem) },
      },
    },
    async (request) => {
      const { fleetId } = request.params as z.infer<typeof fleetIdParams>;
      const query = request.query as z.infer<typeof paginationQuery>;
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);

      // If user has site restrictions, find fleet reservations that have at least
      // one child reservation at an allowed site
      if (siteIds != null && siteIds.length === 0) return { data: [], total: 0 };

      const conditions = [eq(fleetReservations.fleetId, fleetId)];

      if (siteIds != null) {
        // Subquery: fleet reservation IDs that have at least one reservation at an allowed site
        const allowedFleetResIds = db
          .selectDistinct({ id: reservations.fleetReservationId })
          .from(reservations)
          .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
          .where(inArray(chargingStations.siteId, siteIds));

        conditions.push(inArray(fleetReservations.id, allowedFleetResIds));
      }

      const where = and(...conditions);

      const [data, totalResult] = await Promise.all([
        db
          .select({
            id: fleetReservations.id,
            fleetId: fleetReservations.fleetId,
            name: fleetReservations.name,
            status: fleetReservations.status,
            startsAt: fleetReservations.startsAt,
            expiresAt: fleetReservations.expiresAt,
            createdAt: fleetReservations.createdAt,
            updatedAt: fleetReservations.updatedAt,
            reservationCount: count(reservations.id),
          })
          .from(fleetReservations)
          // A site-restricted user counts only the reservations at its sites.
          .leftJoin(
            reservations,
            siteIds == null
              ? eq(reservations.fleetReservationId, fleetReservations.id)
              : and(
                  eq(reservations.fleetReservationId, fleetReservations.id),
                  stationInSitesSql(reservations.stationId, siteIds),
                ),
          )
          .where(where)
          .groupBy(fleetReservations.id)
          // Secondary sort on id keeps pagination stable when two
          // reservations share createdAt (otherwise rows shuffle pages).
          .orderBy(desc(fleetReservations.createdAt), asc(fleetReservations.id))
          .limit(limit)
          .offset(offset),
        db.select({ count: count() }).from(fleetReservations).where(where),
      ]);

      return { data, total: totalResult[0]?.count ?? 0 };
    },
  );

  // DELETE /v1/fleet-reservations/:id - Cancel all slots
  app.delete(
    '/fleet-reservations/:id',
    {
      onRequest: [authorize('reservations:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Cancel all reservations in a fleet reservation',
        description:
          'Cancels every reservation in the fleet booking. Active reservations get a CancelReservation dispatched to their station; scheduled reservations are cancelled DB-only. Operator-initiated and never charges cancellation fees. Returns the fleet reservation status after the cancel and the number of cancelled reservations. A user restricted to some sites gets 404 FLEET_RESERVATION_NOT_FOUND when a reservation is outside its sites or the booking has none.',
        operationId: 'cancelFleetReservation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetReservationIdParams),
        response: {
          200: itemResponse(cancelFleetReservationResponse),
          404: errorWith('Fleet reservation not found', [ERROR_CODES.FLEET_RESERVATION_NOT_FOUND]),
          400: errorWith('Fleet reservation already cancelled', [
            ERROR_CODES.FLEET_RESERVATION_ALREADY_CANCELLED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetReservationIdParams>;
      const { userId } = request.user as { userId: string };

      // Fetch fleet reservation
      const [fleetReservation] = await db
        .select({
          id: fleetReservations.id,
          status: fleetReservations.status,
        })
        .from(fleetReservations)
        .where(eq(fleetReservations.id, id));

      if (fleetReservation == null) {
        await reply.status(404).send({
          error: 'Fleet reservation not found',
          code: 'FLEET_RESERVATION_NOT_FOUND',
        });
        return;
      }

      // Verify the fleet reservation's stations belong to allowed sites. A
      // fleet reservation with no reservation at all names no site, so only
      // an all-site user may cancel it (the list hides it from the others).
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null) {
        const stationSites = await db
          .selectDistinct({ siteId: chargingStations.siteId })
          .from(reservations)
          .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
          .where(eq(reservations.fleetReservationId, id));

        if (
          stationSites.length === 0 ||
          stationSites.some((row) => !siteInScope(siteIds, row.siteId))
        ) {
          await reply.status(404).send({
            error: 'Fleet reservation not found',
            code: 'FLEET_RESERVATION_NOT_FOUND',
          });
          return;
        }
      }

      if (fleetReservation.status === 'cancelled') {
        await reply.status(400).send({
          error: 'Fleet reservation is already cancelled',
          code: 'FLEET_RESERVATION_ALREADY_CANCELLED',
        });
        return;
      }

      // Every live reservation of the fleet reservation. Pull every field the
      // cancel helper needs so each leg is an independent unit of work.
      const liveReservations = await db
        .select({
          id: reservations.id,
          reservationId: reservations.reservationId,
          stationOcppId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          driverId: reservations.driverId,
          startsAt: reservations.startsAt,
          createdAt: reservations.createdAt,
        })
        .from(reservations)
        .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
        .where(
          and(
            eq(reservations.fleetReservationId, id),
            inArray(reservations.status, ['active', 'scheduled']),
          ),
        );

      // Database first (G7): each row is cancelled, then an active hold gets
      // CancelReservation (fire-and-forget). Fleet-level cancel never charges
      // per-driver fees: the fleet operator owns the policy.
      const outcomes = await Promise.allSettled(
        liveReservations.map((reservation) =>
          cancelReservationWithStation({
            reservationDbId: reservation.id,
            siteId: reservation.siteId,
            driverId: reservation.driverId,
            startsAt: reservation.startsAt ?? reservation.createdAt,
            createdAt: reservation.createdAt,
            actor: 'operator',
            actorUserId: userId,
            reason: 'operator_manual',
            chargeFee: false,
            logger: request.log,
            stationOcppId: reservation.stationOcppId,
            reservationOcppId: reservation.reservationId,
            waitForStation: false,
          }),
        ),
      );
      for (const [i, outcome] of outcomes.entries()) {
        if (outcome.status === 'rejected') {
          request.log.error(
            { err: outcome.reason as unknown, reservationId: liveReservations[i]?.id },
            'Cancelling a fleet reservation slot failed',
          );
        }
      }

      // Each slot cancel already refreshed the booking; this covers a booking
      // without a live slot and returns the stored status.
      const status = (await syncFleetReservationStatus(id)) ?? 'cancelled';

      return { status, cancelledCount: liveReservations.length };
    },
  );
}
