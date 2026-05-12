// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, sql, count, inArray } from 'drizzle-orm';
import { db } from '@evtivity/database';
import {
  reservations,
  chargingStations,
  evses,
  fleetReservations,
  fleets,
  writeReservationAudit,
} from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import { paginatedResponse, itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { sendOcppCommandAndWait } from '../lib/ocpp-command.js';
import { applyReservationCancellation } from '../lib/reservation-cancel.js';
import { assertReservationsAllowed } from '../lib/reservation-eligibility.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { authorize } from '../middleware/rbac.js';

// -- Response schemas --

const fleetReservationListItem = z
  .object({
    id: z.string().describe('Identifier'),
    fleetId: z.string().describe('Fleet identifier this reservation belongs to'),
    name: z.string().max(255).nullable().describe('Optional display name'),
    status: z
      .enum(['active', 'partial', 'failed', 'cancelled', 'expired'])
      .describe('Aggregate status across all slots'),
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
      .enum(['active', 'partial', 'failed'])
      .describe('Aggregate status of the bulk operation'),
    confirmed: z.number().int().min(0).describe('Number of slots confirmed by their stations'),
    failed: z.number().int().min(0).describe('Number of slots that failed or were rejected'),
    total: z.number().int().min(0).describe('Total number of slots requested'),
    results: z.array(slotResultItem).describe('Per-slot outcome details'),
  })
  .passthrough();

const cancelFleetReservationResponse = z
  .object({
    status: z.literal('cancelled').describe('Resulting status'),
    cancelledCount: z
      .number()
      .int()
      .min(0)
      .describe('Number of individual reservations that were cancelled'),
  })
  .passthrough();

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
          'Allocates reservations across the supplied station/EVSE list and creates one reservation per fleet driver. Future-dated reservations are persisted as scheduled and activated by the worker; immediate reservations dispatch ReserveNow synchronously. Returns the per-driver allocation result with success/failure status for each.',
        operationId: 'createFleetReservation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetIdParams),
        body: zodSchema(createFleetReservationBody),
        response: {
          201: itemResponse(createFleetReservationResponse),
          400: errorWith('Fleet reservation create failed', [
            ERROR_CODES.FLEET_RESERVATION_CREATE_FAILED,
          ]),
          404: errorWith('Resource not found', [
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

      // Verify all referenced stations belong to sites the user has access to
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null) {
        const stationOcppIds = body.slots.map((s) => s.stationOcppId);
        const stations = await db
          .select({ stationId: chargingStations.stationId, siteId: chargingStations.siteId })
          .from(chargingStations)
          .where(inArray(chargingStations.stationId, stationOcppIds));

        for (const station of stations) {
          if (station.siteId != null && !siteIds.includes(station.siteId)) {
            await reply.status(404).send({
              error: `Station ${station.stationId} not found`,
              code: 'STATION_NOT_FOUND',
            });
            return;
          }
        }
      }

      // Create fleet_reservations aggregate row
      const [fleetReservation] = await db
        .insert(fleetReservations)
        .values({
          fleetId,
          name: body.name ?? null,
          status: 'active',
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

      // Pre-allocate reservation IDs atomically via sequence
      const idRows = await db.execute<{ next_val: string }>(
        sql`SELECT nextval('reservation_id_seq')::int AS next_val FROM generate_series(1, ${body.slots.length})`,
      );
      const reservationIds = idRows.map((r) => Number(r.next_val));

      // Batch-fetch all referenced stations in one query
      const slotStationOcppIds = [...new Set(body.slots.map((s) => s.stationOcppId))];
      const stationRows = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          isOnline: chargingStations.isOnline,
          reservationsEnabled: chargingStations.reservationsEnabled,
        })
        .from(chargingStations)
        .where(inArray(chargingStations.stationId, slotStationOcppIds));

      const stationMap = new Map(stationRows.map((s) => [s.stationId, s]));

      // Batch-fetch all referenced EVSEs in one query
      const stationUuids = stationRows.map((s) => s.id);
      const evseRows =
        stationUuids.length > 0
          ? await db
              .select({ id: evses.id, stationId: evses.stationId, evseId: evses.evseId })
              .from(evses)
              .where(inArray(evses.stationId, stationUuids))
          : [];

      const evseMap = new Map(evseRows.map((e) => [`${e.stationId}:${String(e.evseId)}`, e.id]));

      // Phase 1: Validate all slots and prepare reservation values
      type ValidatedSlot = {
        slot: (typeof body.slots)[number];
        reservationId: number;
        stationId: string;
        stationOcppId: string;
        siteId: string | null;
        resolvedEvseId: string | null;
        evseId: number | undefined;
        driverId: string | undefined;
      };

      const validatedSlots: ValidatedSlot[] = [];
      const validationErrors: { index: number; error: string }[] = [];

      for (let i = 0; i < body.slots.length; i++) {
        const slot = body.slots[i];
        if (slot == null) continue;
        const reservationId = reservationIds[i] ?? 0;
        const station = stationMap.get(slot.stationOcppId);

        if (station == null) {
          validationErrors.push({ index: i, error: `Station ${slot.stationOcppId} not found` });
          continue;
        }
        if (!station.isOnline) {
          validationErrors.push({ index: i, error: `Station ${slot.stationOcppId} is offline` });
          continue;
        }
        try {
          await assertReservationsAllowed(station);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Reservations not allowed';
          validationErrors.push({ index: i, error: msg });
          continue;
        }

        let resolvedEvseId: string | null = null;
        if (slot.evseId != null) {
          const evseUuid = evseMap.get(`${station.id}:${String(slot.evseId)}`);
          if (evseUuid == null) {
            validationErrors.push({
              index: i,
              error: `EVSE ${String(slot.evseId)} not found on station ${slot.stationOcppId}`,
            });
            continue;
          }
          resolvedEvseId = evseUuid;
        }

        validatedSlots.push({
          slot,
          reservationId,
          stationId: station.id,
          stationOcppId: station.stationId,
          siteId: station.siteId,
          resolvedEvseId,
          evseId: slot.evseId,
          driverId: slot.driverId,
        });
      }

      // Phase 2: Insert all reservation rows in a single transaction
      const insertedReservations =
        validatedSlots.length > 0
          ? await db.transaction(async (tx) => {
              const inserted = await tx
                .insert(reservations)
                .values(
                  validatedSlots.map((v) => ({
                    reservationId: v.reservationId,
                    stationId: v.stationId,
                    evseId: v.resolvedEvseId,
                    driverId: v.driverId ?? null,
                    status: 'active' as const,
                    startsAt: body.startsAt != null ? new Date(body.startsAt) : null,
                    expiresAt: new Date(body.expiresAt),
                    fleetReservationId: fleetReservation.id,
                  })),
                )
                .returning();
              // Bulk audit: one `created` row per inserted reservation. Inside
              // the same transaction so a rollback removes audit entries too.
              for (const r of inserted) {
                await writeReservationAudit(
                  {
                    reservationId: r.id,
                    action: 'created',
                    actor: 'operator',
                    actorUserId: userId,
                    driverIdAfter: r.driverId,
                    evseIdAfter: r.evseId,
                    statusAfter: r.status,
                    expiresAtAfter: r.expiresAt,
                    notes: `fleet reservation ${fleetReservation.id}`,
                  },
                  tx,
                  request.log,
                );
              }
              return inserted;
            })
          : [];

      // Phase 3: Send OCPP commands in parallel (outside transaction)
      const slotResults = await Promise.allSettled(
        validatedSlots.map(async (validated, i) => {
          const reservation = insertedReservations[i];
          if (reservation == null) {
            throw new Error(`Failed to insert reservation for station ${validated.stationOcppId}`);
          }

          const ocppPayload: Record<string, unknown> = {
            id: validated.reservationId,
            expiryDateTime: body.expiresAt,
            idToken: { idToken: validated.driverId ?? 'operator', type: 'Central' },
          };
          if (validated.evseId != null) {
            ocppPayload['evseId'] = validated.evseId;
          }

          const result = await sendOcppCommandAndWait(
            validated.stationOcppId,
            'ReserveNow',
            ocppPayload,
          );

          if (result.error != null) {
            // System rollback: command did not reach the station or timed out.
            await applyReservationCancellation({
              reservationDbId: reservation.id,
              siteId: validated.siteId,
              driverId: validated.driverId ?? null,
              startsAt: reservation.startsAt ?? reservation.createdAt,
              createdAt: reservation.createdAt,
              actor: 'system',
              reason: 'station_rejected_other',
              chargeFee: false,
              logger: request.log,
            });
            throw new Error(result.error);
          }

          const responseStatus = result.response?.['status'] as string | undefined;
          if (responseStatus != null && responseStatus !== 'Accepted') {
            // Station replied non-Accepted. Map Occupied to its dedicated
            // enum value so the metadata audit can distinguish it from other
            // station-rejection reasons.
            await applyReservationCancellation({
              reservationDbId: reservation.id,
              siteId: validated.siteId,
              driverId: validated.driverId ?? null,
              startsAt: reservation.startsAt ?? reservation.createdAt,
              createdAt: reservation.createdAt,
              actor: 'system',
              reason:
                responseStatus === 'Occupied'
                  ? 'station_rejected_occupied'
                  : 'station_rejected_other',
              chargeFee: false,
              logger: request.log,
            });
            throw new Error(`Station rejected reservation: ${responseStatus}`);
          }

          // If chargingProfile provided, send SetChargingProfile (best effort)
          if (body.chargingProfile != null) {
            try {
              await sendOcppCommandAndWait(validated.stationOcppId, 'SetChargingProfile', {
                evseId: validated.evseId ?? 0,
                chargingProfile: body.chargingProfile,
              });
            } catch {
              // Best effort: non-fatal
            }
          }

          return {
            stationOcppId: validated.stationOcppId,
            evseId: validated.evseId ?? null,
            reservationId: reservation.id,
            status: 'confirmed' as const,
            error: null,
          };
        }),
      );

      // Collect results: merge validation errors and OCPP results
      const results: Array<{
        stationOcppId: string;
        evseId: number | null;
        reservationId: string | null;
        status: 'confirmed' | 'rejected';
        error: string | null;
      }> = [];

      // Add validation-rejected slots first
      for (const ve of validationErrors) {
        const slot = body.slots[ve.index];
        results.push({
          stationOcppId: slot?.stationOcppId ?? '',
          evseId: slot?.evseId ?? null,
          reservationId: null,
          status: 'rejected',
          error: ve.error,
        });
      }

      // Add OCPP results
      for (let i = 0; i < slotResults.length; i++) {
        const result = slotResults[i];
        const validated = validatedSlots[i];
        if (result == null || validated == null) continue;
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          results.push({
            stationOcppId: validated.stationOcppId,
            evseId: validated.evseId ?? null,
            reservationId: null,
            status: 'rejected',
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      }

      const confirmed = results.filter((r) => r.status === 'confirmed').length;
      const failed = results.filter((r) => r.status === 'rejected').length;

      // Determine fleet reservation status
      let aggregateStatus: string;
      if (confirmed === 0) {
        aggregateStatus = 'cancelled';
      } else if (failed === 0) {
        aggregateStatus = 'active';
      } else {
        aggregateStatus = 'partial';
      }

      // Update fleet_reservations status
      await db
        .update(fleetReservations)
        .set({ status: aggregateStatus, updatedAt: new Date() })
        .where(eq(fleetReservations.id, fleetReservation.id));

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
          .leftJoin(reservations, eq(reservations.fleetReservationId, fleetReservations.id))
          .where(where)
          .groupBy(fleetReservations.id)
          .orderBy(desc(fleetReservations.createdAt))
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
          'Cancels every reservation in the fleet booking. Active reservations get a CancelReservation dispatched to their station; scheduled reservations are cancelled DB-only. Operator-initiated and never charges cancellation fees. Returns counts of cancelled and skipped reservations.',
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

      // Verify the fleet reservation's stations belong to allowed sites
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null) {
        const stationSites = await db
          .selectDistinct({ siteId: chargingStations.siteId })
          .from(reservations)
          .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
          .where(eq(reservations.fleetReservationId, id));

        for (const row of stationSites) {
          if (row.siteId != null && !siteIds.includes(row.siteId)) {
            await reply.status(404).send({
              error: 'Fleet reservation not found',
              code: 'FLEET_RESERVATION_NOT_FOUND',
            });
            return;
          }
        }
      }

      if (fleetReservation.status === 'cancelled') {
        await reply.status(400).send({
          error: 'Fleet reservation is already cancelled',
          code: 'FLEET_RESERVATION_ALREADY_CANCELLED',
        });
        return;
      }

      // Query all active individual reservations for this fleet reservation.
      // Pull every field the cancel helper needs so each leg is an
      // independent unit of work.
      const activeReservations = await db
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
          and(eq(reservations.fleetReservationId, id), inArray(reservations.status, ['active'])),
        );

      // Cancel each reservation in parallel (best effort). Fleet-level cancel
      // never charges per-driver fees -- the fleet operator owns the policy.
      await Promise.allSettled(
        activeReservations.map(async (reservation) => {
          // Send CancelReservation to station (best effort)
          try {
            await sendOcppCommandAndWait(reservation.stationOcppId, 'CancelReservation', {
              reservationId: reservation.reservationId,
            });
          } catch {
            // Best effort
          }

          await applyReservationCancellation({
            reservationDbId: reservation.id,
            siteId: reservation.siteId,
            driverId: reservation.driverId,
            startsAt: reservation.startsAt ?? reservation.createdAt,
            createdAt: reservation.createdAt,
            actor: 'operator',
            reason: 'operator_manual',
            chargeFee: false,
            logger: request.log,
          });
        }),
      );

      // Update fleet reservation status
      await db
        .update(fleetReservations)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(eq(fleetReservations.id, id));

      return { status: 'cancelled' as const, cancelledCount: activeReservations.length };
    },
  );
}
