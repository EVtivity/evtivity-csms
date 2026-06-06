// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, inArray, gt, gte, isNull, lt, or, sql } from 'drizzle-orm';
import Handlebars from 'handlebars';
import {
  db,
  client,
  maintenanceEvents,
  maintenanceEventStations,
  chargingStations,
  chargingSessions,
  reservations,
  drivers,
  sites,
} from '@evtivity/database';
import { AppError } from '@evtivity/lib';
import { zodSchema } from '../lib/zod-schema.js';
import { paginationQuery } from '../lib/pagination.js';
import {
  itemResponse,
  paginatedResponse,
  arrayResponse,
  errorWith,
} from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { authorize } from '../middleware/rbac.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { buildDerivedStatusSubquery } from '../lib/station-derived-status.js';
import {
  createEvent,
  cancelEvent,
  updateEvent,
  addStationsToMaintenance,
  removeStationsFromMaintenance,
} from '../services/maintenance.service.js';

const siteIdParams = z.object({
  siteId: z.string().describe('Site ID (e.g., sit_...)'),
});

const eventIdParams = z.object({
  siteId: z.string().describe('Site ID'),
  id: z.string().describe('Maintenance event ID'),
});

const maintenanceItem = z
  .object({
    id: z.string().describe('Event ID'),
    siteId: z.string().describe('Site ID'),
    eventType: z.enum(['immediate', 'one_off']).describe('Event type'),
    status: z
      .enum(['scheduled', 'active', 'completed', 'cancelled'])
      .describe('Current event status'),
    plannedStartAt: z.coerce.date().describe('Planned start timestamp'),
    plannedEndAt: z.coerce.date().describe('Planned end timestamp'),
    startedAt: z.coerce.date().nullable().describe('Actual start timestamp'),
    endedAt: z.coerce.date().nullable().describe('Actual end timestamp'),
    affectedStationIds: z
      .array(z.string())
      .nullable()
      .describe('Affected station IDs; null = entire site'),
    activeSessionPolicy: z.enum(['ignore', 'stop_graceful']).describe('Active session policy'),
    customMessage: z.string().nullable().describe('Custom display message'),
    reason: z.string().nullable().describe('Reason'),
    reservationsCancelledCount: z.number().int().describe('Reservations cancelled snapshot count'),
    sessionsStoppedCount: z.number().int().describe('Sessions stopped snapshot count'),
    createdByUserId: z.string().nullable().describe('Operator who created the event'),
    createdAt: z.coerce.date().describe('Created at'),
    updatedAt: z.coerce.date().describe('Updated at'),
    rollout: z
      .object({
        offline: z
          .object({
            accepted: z
              .number()
              .int()
              .describe(
                'Stations whose latest take-offline command (initial run or add) was accepted',
              ),
            total: z.number().int().describe('Distinct stations commanded offline'),
          })
          .passthrough()
          .nullable()
          .describe('Net take-offline outcome; null until the first run records results'),
        reasserted: z
          .object({
            accepted: z
              .number()
              .int()
              .describe('Reconnected stations whose latest re-assert command was accepted'),
            total: z
              .number()
              .int()
              .describe('Distinct stations re-commanded offline after reconnecting mid-window'),
          })
          .passthrough()
          .nullable()
          .describe('Net re-assert outcome; null when no station reconnected mid-window'),
        restored: z
          .object({
            accepted: z
              .number()
              .int()
              .describe('Stations whose latest restore command was accepted'),
            total: z.number().int().describe('Distinct stations commanded back into service'),
          })
          .passthrough()
          .nullable()
          .describe('Net restore outcome; null until a release run records results'),
      })
      .passthrough()
      .optional()
      .describe(
        'Per-station net fan-out outcome, aggregated by the latest command per station per direction (list endpoint only)',
      ),
  })
  .passthrough();

const fanoutStationItem = z
  .object({
    id: z.number().int().describe('Tracking row ID'),
    eventId: z.string().describe('Maintenance event ID'),
    stationId: z.string().nullable().describe('Station DB ID (null when station was deleted)'),
    stationIdSnapshot: z.string().describe('Station DB ID snapshot preserved across deletes'),
    stationOcppId: z.string().describe('Station OCPP identity (e.g. CS-0001)'),
    phase: z.string().describe('Fan-out phase that produced this row'),
    command: z.string().describe('OCPP command sent (e.g. ChangeAvailability(Inoperative))'),
    commandStatus: z
      .string()
      .describe('Command outcome: accepted, rejected, scheduled, offline, or failed'),
    error: z.string().nullable().describe('Error detail when the command did not succeed'),
    statusBefore: z
      .string()
      .nullable()
      .describe('Derived station status captured before the fan-out'),
    statusAfter: z
      .string()
      .nullable()
      .describe('Derived station status captured after the fan-out completed'),
    currentStatus: z
      .string()
      .nullable()
      .describe('Live derived station status right now (null when the station was deleted)'),
    createdAt: z.coerce.date().describe('When the fan-out recorded this row'),
  })
  .passthrough();

const fanoutStationsQuery = paginationQuery.extend({
  phase: z.string().max(20).optional().describe('Filter by fan-out phase'),
});

const listQuery = paginationQuery.extend({
  status: z
    .enum(['scheduled', 'active', 'completed', 'cancelled'])
    .optional()
    .describe('Filter by status'),
});

const createBody = z.object({
  eventType: z.enum(['immediate', 'one_off']).describe('Event type'),
  plannedStartAt: z.coerce.date().describe('Planned start (ignored for immediate)'),
  plannedEndAt: z.coerce.date().describe('Planned end'),
  affectedStationIds: z
    .array(z.string())
    .nullable()
    .optional()
    .describe('Affected station IDs; null/empty = entire site'),
  activeSessionPolicy: z.enum(['ignore', 'stop_graceful']).default('ignore'),
  customMessage: z.string().max(2000).nullable().optional(),
  reason: z.string().max(500).nullable().optional(),
});

const patchBody = z.object({
  plannedStartAt: z.coerce.date().optional(),
  plannedEndAt: z.coerce.date().optional(),
  affectedStationIds: z.array(z.string()).nullable().optional(),
  activeSessionPolicy: z.enum(['ignore', 'stop_graceful']).optional(),
  customMessage: z.string().max(2000).nullable().optional(),
  reason: z.string().max(500).nullable().optional(),
});

const statusSummary = z
  .object({
    current: maintenanceItem.nullable(),
    upcoming: z.array(maintenanceItem),
  })
  .passthrough();

const stationPreviewQuery = z.object({
  startAt: z.coerce.date().describe('Planned start'),
  endAt: z.coerce.date().describe('Planned end'),
});

const stationPreviewItem = z
  .object({
    id: z.string(),
    stationId: z.string(),
    model: z.string().nullable(),
    status: z
      .string()
      .describe(
        'Derived station status from connector statuses (charging/reserved/faulted/unknown/available/unavailable), matching the station list',
      ),
    isOnline: z.boolean(),
    hasActiveSession: z.boolean(),
    activeSession: z
      .object({
        id: z.string(),
        transactionId: z.string().nullable(),
        driverName: z.string().nullable(),
      })
      .passthrough()
      .nullable(),
    upcomingReservationCount: z.number().int(),
    upcomingReservations: z.array(
      z
        .object({
          id: z.string(),
          startsAt: z.coerce.date().nullable(),
          endsAt: z.coerce.date().nullable(),
          driverName: z.string().nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const previewMessageBody = z.object({
  template: z.string().max(2000).optional(),
  siteName: z.string().max(255).default('My Site'),
  endTime: z.coerce.date().optional(),
  durationMinutes: z.number().int().optional(),
  reason: z.string().max(500).optional(),
});

interface RolloutCount {
  accepted: number;
  total: number;
}

interface RolloutSummary {
  offline: RolloutCount | null;
  reasserted: RolloutCount | null;
  restored: RolloutCount | null;
}

// Net per-station fan-out outcome for the rollout columns. Runs overlap per
// station (a re-assert retries a station the enter run failed), so per-run
// counts mislead; the truthful number is each station's LATEST command outcome
// per bucket (initial offline, reassert, restore).
async function loadRolloutSummaries(eventIds: string[]): Promise<Map<string, RolloutSummary>> {
  const summaries = new Map<string, RolloutSummary>();
  if (eventIds.length === 0) return summaries;
  // postgres-js client (not drizzle sql) because the array must travel as a
  // single Postgres array param for = ANY(); drizzle's template expands
  // arrays into scalar params and breaks the query.
  const agg = (await client`
    SELECT event_id, bucket, count(*)::int AS total,
           count(*) FILTER (WHERE command_status = 'accepted')::int AS accepted
    FROM (
      SELECT DISTINCT ON (
          event_id, station_id_snapshot,
          CASE
            WHEN phase = 'reassert' THEN 'reasserted'
            WHEN command LIKE '%Inoperative%' THEN 'offline'
            ELSE 'restored'
          END
        )
        event_id,
        CASE
          WHEN phase = 'reassert' THEN 'reasserted'
          WHEN command LIKE '%Inoperative%' THEN 'offline'
          ELSE 'restored'
        END AS bucket,
        command_status
      FROM maintenance_event_stations
      WHERE event_id = ANY(${eventIds})
      ORDER BY
        event_id, station_id_snapshot,
        CASE
          WHEN phase = 'reassert' THEN 'reasserted'
          WHEN command LIKE '%Inoperative%' THEN 'offline'
          ELSE 'restored'
        END,
        created_at DESC, id DESC
    ) latest
    GROUP BY event_id, bucket
  `) as unknown as Array<{
    event_id: string;
    bucket: 'offline' | 'reasserted' | 'restored';
    total: number;
    accepted: number;
  }>;
  for (const row of agg) {
    const entry = summaries.get(row.event_id) ?? {
      offline: null,
      reasserted: null,
      restored: null,
    };
    entry[row.bucket] = { accepted: row.accepted, total: row.total };
    summaries.set(row.event_id, entry);
  }
  return summaries;
}

async function checkSiteAccess(siteId: string, userId: string): Promise<boolean> {
  const siteIds = await getUserSiteIds(userId);
  if (siteIds == null) return true;
  return siteIds.includes(siteId);
}

async function eventBelongsToSite(eventId: string, siteId: string): Promise<boolean> {
  const [row] = await db
    .select({ siteId: maintenanceEvents.siteId })
    .from(maintenanceEvents)
    .where(eq(maintenanceEvents.id, eventId));
  return row != null && row.siteId === siteId;
}

async function getCompanyName(): Promise<string> {
  const rows = await client`SELECT value FROM settings WHERE key='company.name' LIMIT 1`;
  const v: unknown = rows[0]?.['value'];
  return typeof v === 'string' ? v : 'EVtivity';
}

async function getDefaultMessageTemplate(): Promise<string> {
  const rows =
    await client`SELECT value FROM settings WHERE key='maintenance.defaultMessageTemplate' LIMIT 1`;
  const v: unknown = rows[0]?.['value'];
  return typeof v === 'string' ? v : 'Site under maintenance until {{endTime}}.';
}

export function maintenanceRoutes(app: FastifyInstance): void {
  app.get(
    '/sites/:siteId/maintenance/events',
    {
      onRequest: [authorize('maintenance:read')],
      schema: {
        tags: ['Maintenance'],
        summary: 'List maintenance events for a site',
        operationId: 'listSiteMaintenanceEvents',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParams),
        querystring: zodSchema(listQuery),
        response: {
          200: paginatedResponse(maintenanceItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { siteId } = request.params as z.infer<typeof siteIdParams>;
      const q = request.query as z.infer<typeof listQuery>;
      const { userId } = request.user as { userId: string };
      if (!(await checkSiteAccess(siteId, userId))) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const conditions = [eq(maintenanceEvents.siteId, siteId)];
      if (q.status != null) conditions.push(eq(maintenanceEvents.status, q.status));
      const offset = (q.page - 1) * q.limit;
      const [data, totalRow] = await Promise.all([
        db
          .select()
          .from(maintenanceEvents)
          .where(and(...conditions))
          .orderBy(desc(maintenanceEvents.plannedStartAt))
          .limit(q.limit)
          .offset(offset),
        db
          .select({ c: sql<number>`count(*)` })
          .from(maintenanceEvents)
          .where(and(...conditions)),
      ]);
      const rolloutByEvent = await loadRolloutSummaries(data.map((e) => e.id));
      return {
        data: data.map((e) => ({
          ...e,
          rollout: rolloutByEvent.get(e.id) ?? { offline: null, reasserted: null, restored: null },
        })),
        total: totalRow[0]?.c ?? 0,
      };
    },
  );

  app.get(
    '/sites/:siteId/maintenance/events/:id/stations',
    {
      onRequest: [authorize('maintenance:read')],
      schema: {
        tags: ['Maintenance'],
        summary: 'Per-station fan-out results for a maintenance event',
        description:
          'Lists the OCPP command outcome recorded for every station in every fan-out phase of the event (enter, exit, cancel, add, remove-stations, reassert), including the derived station status before and after each run.',
        operationId: 'listMaintenanceEventStations',
        security: [{ bearerAuth: [] }],
        params: zodSchema(eventIdParams),
        querystring: zodSchema(fanoutStationsQuery),
        response: {
          200: paginatedResponse(fanoutStationItem),
          404: errorWith('Not found', [
            ERROR_CODES.SITE_NOT_FOUND,
            ERROR_CODES.MAINTENANCE_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { siteId, id } = request.params as z.infer<typeof eventIdParams>;
      const q = request.query as z.infer<typeof fanoutStationsQuery>;
      const { userId } = request.user as { userId: string };
      if (!(await checkSiteAccess(siteId, userId))) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      if (!(await eventBelongsToSite(id, siteId))) {
        await reply
          .status(404)
          .send({ error: 'Maintenance event not found', code: 'MAINTENANCE_NOT_FOUND' });
        return;
      }
      const conditions = [eq(maintenanceEventStations.eventId, id)];
      if (q.phase != null) conditions.push(eq(maintenanceEventStations.phase, q.phase));
      const offset = (q.page - 1) * q.limit;
      // currentStatus is the live derived status: the stored statusAfter is a
      // snapshot taken shortly after the fan-out and can lag the station's
      // StatusNotification, so the live value is the ground truth the UI shows
      // alongside it.
      const [data, totalRow] = await Promise.all([
        db
          .select({
            id: maintenanceEventStations.id,
            eventId: maintenanceEventStations.eventId,
            stationId: maintenanceEventStations.stationId,
            stationIdSnapshot: maintenanceEventStations.stationIdSnapshot,
            stationOcppId: maintenanceEventStations.stationOcppId,
            phase: maintenanceEventStations.phase,
            command: maintenanceEventStations.command,
            commandStatus: maintenanceEventStations.commandStatus,
            error: maintenanceEventStations.error,
            statusBefore: maintenanceEventStations.statusBefore,
            statusAfter: maintenanceEventStations.statusAfter,
            currentStatus: sql<
              string | null
            >`CASE WHEN ${chargingStations.id} IS NULL THEN NULL ELSE ${buildDerivedStatusSubquery(chargingStations.id)} END`,
            createdAt: maintenanceEventStations.createdAt,
          })
          .from(maintenanceEventStations)
          .leftJoin(chargingStations, eq(chargingStations.id, maintenanceEventStations.stationId))
          .where(and(...conditions))
          .orderBy(desc(maintenanceEventStations.createdAt), desc(maintenanceEventStations.id))
          .limit(q.limit)
          .offset(offset),
        db
          .select({ c: sql<number>`count(*)` })
          .from(maintenanceEventStations)
          .where(and(...conditions)),
      ]);
      return { data, total: totalRow[0]?.c ?? 0 };
    },
  );

  app.post(
    '/sites/:siteId/maintenance/events',
    {
      onRequest: [authorize('maintenance:write')],
      schema: {
        tags: ['Maintenance'],
        summary: 'Create a maintenance event',
        operationId: 'createSiteMaintenanceEvent',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParams),
        body: zodSchema(createBody),
        response: {
          200: itemResponse(maintenanceItem),
          400: errorWith('Bad request', [
            ERROR_CODES.MAINTENANCE_INVALID_RANGE,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
          409: errorWith('Conflict', [ERROR_CODES.MAINTENANCE_OVERLAPS_EXISTING]),
        },
      },
    },
    async (request, reply) => {
      const { siteId } = request.params as z.infer<typeof siteIdParams>;
      const body = request.body as z.infer<typeof createBody>;
      const { userId } = request.user as { userId: string };
      if (!(await checkSiteAccess(siteId, userId))) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const [siteRow] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, siteId));
      if (siteRow == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      if (body.affectedStationIds != null && body.affectedStationIds.length > 0) {
        const ownedStations = await db
          .select({ id: chargingStations.id })
          .from(chargingStations)
          .where(
            and(
              eq(chargingStations.siteId, siteId),
              inArray(chargingStations.id, body.affectedStationIds),
            ),
          );
        if (ownedStations.length !== body.affectedStationIds.length) {
          await reply.status(400).send({
            error: 'One or more affectedStationIds do not belong to this site',
            code: 'STATION_NOT_FOUND',
          });
          return;
        }
      }

      // Fastify validates request bodies against JSON Schema derived from the
      // Zod schema, which strips `coerce` semantics — datetimes arrive as
      // strings, not Dates. Coerce manually here before handing off.
      const plannedStartAt =
        body.eventType === 'immediate' ? new Date() : new Date(body.plannedStartAt);
      const plannedEndAt = new Date(body.plannedEndAt);
      try {
        const created = await createEvent(
          {
            siteId,
            eventType: body.eventType,
            plannedStartAt,
            plannedEndAt,
            affectedStationIds: body.affectedStationIds ?? null,
            activeSessionPolicy: body.activeSessionPolicy,
            customMessage: body.customMessage ?? null,
            reason: body.reason ?? null,
            actor: { type: 'operator', userId },
            logger: request.log,
          },
          { detachSideEffects: true },
        );
        return created;
      } catch (err) {
        if (err instanceof AppError) {
          if (err.statusCode === 400) {
            await reply.status(400).send({ error: err.message, code: err.code });
            return;
          }
          if (err.statusCode === 404) {
            await reply.status(404).send({ error: err.message, code: err.code });
            return;
          }
          if (err.statusCode === 409) {
            await reply.status(409).send({ error: err.message, code: err.code });
            return;
          }
        }
        throw err;
      }
    },
  );

  app.get(
    '/sites/:siteId/maintenance/events/:id',
    {
      onRequest: [authorize('maintenance:read')],
      schema: {
        tags: ['Maintenance'],
        summary: 'Get a maintenance event by ID',
        operationId: 'getSiteMaintenanceEvent',
        security: [{ bearerAuth: [] }],
        params: zodSchema(eventIdParams),
        response: {
          200: itemResponse(maintenanceItem),
          404: errorWith('Not found', [
            ERROR_CODES.SITE_NOT_FOUND,
            ERROR_CODES.MAINTENANCE_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { siteId, id } = request.params as z.infer<typeof eventIdParams>;
      const { userId } = request.user as { userId: string };
      if (!(await checkSiteAccess(siteId, userId))) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const [row] = await db
        .select()
        .from(maintenanceEvents)
        .where(and(eq(maintenanceEvents.id, id), eq(maintenanceEvents.siteId, siteId)));
      if (row == null) {
        await reply
          .status(404)
          .send({ error: 'Maintenance event not found', code: 'MAINTENANCE_NOT_FOUND' });
        return;
      }
      return row;
    },
  );

  app.patch(
    '/sites/:siteId/maintenance/events/:id',
    {
      onRequest: [authorize('maintenance:write')],
      schema: {
        tags: ['Maintenance'],
        summary: 'Edit a scheduled or active maintenance event',
        operationId: 'updateSiteMaintenanceEvent',
        security: [{ bearerAuth: [] }],
        params: zodSchema(eventIdParams),
        body: zodSchema(patchBody),
        response: {
          200: itemResponse(maintenanceItem),
          400: errorWith('Bad request', [
            ERROR_CODES.MAINTENANCE_INVALID_RANGE,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
          404: errorWith('Not found', [
            ERROR_CODES.SITE_NOT_FOUND,
            ERROR_CODES.MAINTENANCE_NOT_FOUND,
          ]),
          409: errorWith('Conflict', [
            ERROR_CODES.MAINTENANCE_ALREADY_ACTIVE,
            ERROR_CODES.MAINTENANCE_OVERLAPS_EXISTING,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { siteId, id } = request.params as z.infer<typeof eventIdParams>;
      const body = request.body as z.infer<typeof patchBody>;
      const { userId } = request.user as { userId: string };
      if (!(await checkSiteAccess(siteId, userId))) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      // Verify the event belongs to the requested site BEFORE handing off to
      // the service; the service is keyed by event id only and would otherwise
      // silently let an operator from siteA edit siteB's event by guessing id.
      if (!(await eventBelongsToSite(id, siteId))) {
        await reply
          .status(404)
          .send({ error: 'Maintenance event not found', code: 'MAINTENANCE_NOT_FOUND' });
        return;
      }

      if (body.affectedStationIds != null && body.affectedStationIds.length > 0) {
        const ownedStations = await db
          .select({ id: chargingStations.id })
          .from(chargingStations)
          .where(
            and(
              eq(chargingStations.siteId, siteId),
              inArray(chargingStations.id, body.affectedStationIds),
            ),
          );
        if (ownedStations.length !== body.affectedStationIds.length) {
          await reply.status(400).send({
            error: 'One or more affectedStationIds do not belong to this site',
            code: 'STATION_NOT_FOUND',
          });
          return;
        }
      }

      try {
        return await updateEvent(
          id,
          {
            ...(body.plannedStartAt !== undefined
              ? { plannedStartAt: new Date(body.plannedStartAt) }
              : {}),
            ...(body.plannedEndAt !== undefined
              ? { plannedEndAt: new Date(body.plannedEndAt) }
              : {}),
            ...(body.affectedStationIds !== undefined
              ? { affectedStationIds: body.affectedStationIds }
              : {}),
            ...(body.activeSessionPolicy !== undefined
              ? { activeSessionPolicy: body.activeSessionPolicy }
              : {}),
            ...(body.customMessage !== undefined ? { customMessage: body.customMessage } : {}),
            ...(body.reason !== undefined ? { reason: body.reason } : {}),
          },
          { type: 'operator', userId },
          request.log,
        );
      } catch (err) {
        if (err instanceof AppError) {
          if (err.statusCode === 400) {
            await reply.status(400).send({ error: err.message, code: err.code });
            return;
          }
          if (err.statusCode === 404) {
            await reply.status(404).send({ error: err.message, code: err.code });
            return;
          }
          if (err.statusCode === 409) {
            await reply.status(409).send({ error: err.message, code: err.code });
            return;
          }
        }
        throw err;
      }
    },
  );

  app.post(
    '/sites/:siteId/maintenance/events/:id/cancel',
    {
      onRequest: [authorize('maintenance:write')],
      schema: {
        tags: ['Maintenance'],
        summary: 'Cancel a scheduled or active maintenance event',
        operationId: 'cancelSiteMaintenanceEvent',
        security: [{ bearerAuth: [] }],
        params: zodSchema(eventIdParams),
        response: {
          200: itemResponse(maintenanceItem),
          404: errorWith('Not found', [
            ERROR_CODES.SITE_NOT_FOUND,
            ERROR_CODES.MAINTENANCE_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { siteId, id } = request.params as z.infer<typeof eventIdParams>;
      const { userId } = request.user as { userId: string };
      if (!(await checkSiteAccess(siteId, userId))) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      if (!(await eventBelongsToSite(id, siteId))) {
        await reply
          .status(404)
          .send({ error: 'Maintenance event not found', code: 'MAINTENANCE_NOT_FOUND' });
        return;
      }
      try {
        return await cancelEvent(id, { type: 'operator', userId }, request.log, {
          detachSideEffects: true,
        });
      } catch (err) {
        if (err instanceof AppError && err.statusCode === 404) {
          await reply.status(404).send({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
    },
  );

  app.post(
    '/sites/:siteId/maintenance/events/:id/add-stations',
    {
      onRequest: [authorize('maintenance:write')],
      schema: {
        tags: ['Maintenance'],
        summary: 'Add one or more stations to a scheduled or active event',
        operationId: 'addMaintenanceStations',
        security: [{ bearerAuth: [] }],
        params: zodSchema(eventIdParams),
        body: zodSchema(
          z.object({
            stationIds: z
              .array(z.string())
              .min(1)
              .describe('Internal station IDs to add to the event'),
          }),
        ),
        response: {
          200: itemResponse(maintenanceItem),
          400: errorWith('Bad request', [ERROR_CODES.STATION_NOT_FOUND]),
          404: errorWith('Not found', [
            ERROR_CODES.SITE_NOT_FOUND,
            ERROR_CODES.MAINTENANCE_NOT_FOUND,
          ]),
          409: errorWith('Conflict', [ERROR_CODES.MAINTENANCE_ALREADY_ACTIVE]),
        },
      },
    },
    async (request, reply) => {
      const { siteId, id } = request.params as z.infer<typeof eventIdParams>;
      const body = request.body as { stationIds: string[] };
      const { userId } = request.user as { userId: string };
      if (!(await checkSiteAccess(siteId, userId))) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      if (!(await eventBelongsToSite(id, siteId))) {
        await reply
          .status(404)
          .send({ error: 'Maintenance event not found', code: 'MAINTENANCE_NOT_FOUND' });
        return;
      }
      try {
        return await addStationsToMaintenance(
          id,
          body.stationIds,
          { type: 'operator', userId },
          request.log,
          { detachSideEffects: true },
        );
      } catch (err) {
        if (err instanceof AppError) {
          if (err.statusCode === 400) {
            await reply.status(400).send({ error: err.message, code: err.code });
            return;
          }
          if (err.statusCode === 404) {
            await reply.status(404).send({ error: err.message, code: err.code });
            return;
          }
          if (err.statusCode === 409) {
            await reply.status(409).send({ error: err.message, code: err.code });
            return;
          }
        }
        throw err;
      }
    },
  );

  app.post(
    '/sites/:siteId/maintenance/events/:id/remove-stations',
    {
      onRequest: [authorize('maintenance:write')],
      schema: {
        tags: ['Maintenance'],
        summary: 'Remove one or more stations from a scheduled or active event',
        operationId: 'removeMaintenanceStations',
        security: [{ bearerAuth: [] }],
        params: zodSchema(eventIdParams),
        body: zodSchema(
          z.object({
            stationIds: z
              .array(z.string())
              .min(1)
              .describe('Internal station IDs to remove from the event'),
          }),
        ),
        response: {
          200: itemResponse(maintenanceItem),
          400: errorWith('Bad request', [ERROR_CODES.MAINTENANCE_INVALID_RANGE]),
          404: errorWith('Not found', [
            ERROR_CODES.SITE_NOT_FOUND,
            ERROR_CODES.MAINTENANCE_NOT_FOUND,
          ]),
          409: errorWith('Conflict', [ERROR_CODES.MAINTENANCE_ALREADY_ACTIVE]),
        },
      },
    },
    async (request, reply) => {
      const { siteId, id } = request.params as z.infer<typeof eventIdParams>;
      const body = request.body as { stationIds: string[] };
      const { userId } = request.user as { userId: string };
      if (!(await checkSiteAccess(siteId, userId))) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      if (!(await eventBelongsToSite(id, siteId))) {
        await reply
          .status(404)
          .send({ error: 'Maintenance event not found', code: 'MAINTENANCE_NOT_FOUND' });
        return;
      }
      try {
        return await removeStationsFromMaintenance(
          id,
          body.stationIds,
          { type: 'operator', userId },
          request.log,
          { detachSideEffects: true },
        );
      } catch (err) {
        if (err instanceof AppError) {
          if (err.statusCode === 400) {
            await reply.status(400).send({ error: err.message, code: err.code });
            return;
          }
          if (err.statusCode === 404) {
            await reply.status(404).send({ error: err.message, code: err.code });
            return;
          }
          if (err.statusCode === 409) {
            await reply.status(409).send({ error: err.message, code: err.code });
            return;
          }
        }
        throw err;
      }
    },
  );

  app.get(
    '/sites/:siteId/maintenance/status',
    {
      onRequest: [authorize('maintenance:read')],
      schema: {
        tags: ['Maintenance'],
        summary: 'Current and upcoming maintenance for a site',
        operationId: 'getSiteMaintenanceStatus',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParams),
        response: {
          200: itemResponse(statusSummary),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { siteId } = request.params as z.infer<typeof siteIdParams>;
      const { userId } = request.user as { userId: string };
      if (!(await checkSiteAccess(siteId, userId))) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const now = new Date();
      const [currentRows, upcomingRows] = await Promise.all([
        db
          .select()
          .from(maintenanceEvents)
          .where(
            and(
              eq(maintenanceEvents.siteId, siteId),
              eq(maintenanceEvents.status, 'active'),
              lt(maintenanceEvents.plannedStartAt, now),
              gt(maintenanceEvents.plannedEndAt, now),
            ),
          )
          .limit(1),
        db
          .select()
          .from(maintenanceEvents)
          .where(
            and(
              eq(maintenanceEvents.siteId, siteId),
              eq(maintenanceEvents.status, 'scheduled'),
              gte(maintenanceEvents.plannedStartAt, now),
            ),
          )
          .orderBy(maintenanceEvents.plannedStartAt)
          .limit(20),
      ]);
      const current = currentRows[0] ?? null;
      // Rollout summary lets the UI show a rolling-out indicator while the
      // worker fan-out is still commanding stations (no offline results yet).
      const rollout =
        current != null
          ? ((await loadRolloutSummaries([current.id])).get(current.id) ?? {
              offline: null,
              reasserted: null,
              restored: null,
            })
          : null;
      return {
        current: current != null ? { ...current, rollout } : null,
        upcoming: upcomingRows,
      };
    },
  );

  app.get(
    '/sites/:siteId/maintenance/station-preview',
    {
      onRequest: [authorize('maintenance:read')],
      schema: {
        tags: ['Maintenance'],
        summary: 'Preview station impact for a proposed maintenance window',
        operationId: 'getSiteMaintenanceStationPreview',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParams),
        querystring: zodSchema(stationPreviewQuery),
        response: {
          200: arrayResponse(stationPreviewItem),
          400: errorWith('Bad request', [ERROR_CODES.MAINTENANCE_INVALID_RANGE]),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { siteId } = request.params as z.infer<typeof siteIdParams>;
      const rawQ = request.query as { startAt: string; endAt: string };
      const q = { startAt: new Date(rawQ.startAt), endAt: new Date(rawQ.endAt) };
      const { userId } = request.user as { userId: string };
      if (!(await checkSiteAccess(siteId, userId))) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      if (q.endAt.getTime() <= q.startAt.getTime()) {
        await reply
          .status(400)
          .send({ error: 'End must be after start', code: 'MAINTENANCE_INVALID_RANGE' });
        return;
      }

      const stationRows = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          model: chargingStations.model,
          status: buildDerivedStatusSubquery(chargingStations.id),
          isOnline: chargingStations.isOnline,
        })
        .from(chargingStations)
        .where(eq(chargingStations.siteId, siteId));

      if (stationRows.length === 0) return [];
      const stationDbIds = stationRows.map((s) => s.id);

      const [activeSessions, overlapReservations] = await Promise.all([
        db
          .select({
            id: chargingSessions.id,
            stationDbId: chargingSessions.stationId,
            transactionId: chargingSessions.transactionId,
            driverId: chargingSessions.driverId,
          })
          .from(chargingSessions)
          .where(
            and(
              inArray(chargingSessions.stationId, stationDbIds),
              eq(chargingSessions.status, 'active'),
            ),
          ),
        db
          .select({
            id: reservations.id,
            stationDbId: reservations.stationId,
            startsAt: reservations.startsAt,
            expiresAt: reservations.expiresAt,
            driverId: reservations.driverId,
          })
          .from(reservations)
          .where(
            and(
              inArray(reservations.stationId, stationDbIds),
              inArray(reservations.status, ['scheduled', 'active', 'in_use']),
              or(isNull(reservations.startsAt), lt(reservations.startsAt, q.endAt)),
              gt(reservations.expiresAt, q.startAt),
            ),
          ),
      ]);

      const driverIds = new Set<string>();
      for (const s of activeSessions) {
        if (s.driverId != null) driverIds.add(s.driverId);
      }
      for (const r of overlapReservations) {
        if (r.driverId != null) driverIds.add(r.driverId);
      }
      const driverNameById = new Map<string, string>();
      if (driverIds.size > 0) {
        const driverRows = await db
          .select({
            id: drivers.id,
            firstName: drivers.firstName,
            lastName: drivers.lastName,
          })
          .from(drivers)
          .where(inArray(drivers.id, Array.from(driverIds)));
        for (const d of driverRows) {
          const name = `${d.firstName} ${d.lastName}`.trim();
          driverNameById.set(d.id, name);
        }
      }

      return stationRows.map((s) => {
        const session = activeSessions.find((a) => a.stationDbId === s.id) ?? null;
        const resForStation = overlapReservations.filter((r) => r.stationDbId === s.id);
        return {
          id: s.id,
          stationId: s.stationId,
          model: s.model,
          status: s.status,
          isOnline: s.isOnline,
          hasActiveSession: session != null,
          activeSession:
            session == null
              ? null
              : {
                  id: session.id,
                  transactionId: session.transactionId,
                  driverName:
                    session.driverId != null
                      ? (driverNameById.get(session.driverId) ?? null)
                      : null,
                },
          upcomingReservationCount: resForStation.length,
          upcomingReservations: resForStation.map((r) => ({
            id: r.id,
            startsAt: r.startsAt,
            endsAt: r.expiresAt,
            driverName: r.driverId != null ? (driverNameById.get(r.driverId) ?? null) : null,
          })),
        };
      });
    },
  );
}

export function maintenancePreviewRoutes(app: FastifyInstance): void {
  app.post(
    '/maintenance/preview-message',
    {
      onRequest: [authorize('maintenance:read')],
      schema: {
        tags: ['Maintenance'],
        summary: 'Render the maintenance display message with sample variables',
        operationId: 'previewMaintenanceMessage',
        security: [{ bearerAuth: [] }],
        body: zodSchema(previewMessageBody),
        response: {
          200: itemResponse(
            z.object({ rendered: z.string().describe('Rendered message text') }).passthrough(),
          ),
        },
      },
    },
    async (request) => {
      const body = request.body as z.infer<typeof previewMessageBody>;
      const tpl = body.template ?? (await getDefaultMessageTemplate());
      const compiled = Handlebars.compile(tpl, { noEscape: true });
      const endTime =
        body.endTime != null ? new Date(body.endTime) : new Date(Date.now() + 60 * 60 * 1000);
      const durationMinutes =
        body.durationMinutes ?? Math.round((endTime.getTime() - Date.now()) / 60_000);
      const rendered = compiled({
        companyName: await getCompanyName(),
        siteName: body.siteName,
        endTime: endTime.toISOString(),
        durationMinutes,
        reason: body.reason ?? '',
      });
      return { rendered };
    },
  );
}
