// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Fleet departures and weekly departure schedules (route-aware charging). Every
// write goes through @evtivity/services/departure.service, which checks the
// fleet membership of the vehicle and the caller's sites (404 outside them) and
// audits. These routes work while the fleetCharging.enabled setting is off, so
// a depot can enter schedules before the planner is switched on.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  db,
  fleets,
  DEPARTURE_STATUSES,
  DEPARTURE_TARGET_KINDS,
  type VehicleDeparture,
} from '@evtivity/database';
import { ValidationError } from '@evtivity/lib';
import type { DepartureTarget } from '@evtivity/lib/charging-plan';
import {
  cancelDeparture,
  createDeparture,
  createDepartureSchedule,
  deleteDepartureSchedule,
  updateDeparture,
  updateDepartureSchedule,
  type DepartureCtx,
  type DepartureUpdate,
  type ScheduleUpdate,
} from '@evtivity/services/departure.service';
import { DEPARTURE_IMPORT_MAX_BYTES, importDepartures } from '@evtivity/services/departure-import';
import { publishDepartureChanged } from '@evtivity/services/departure-notice.service';
import { getAuditActor } from '../lib/audit-actor.js';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import { departureScheduleListSort } from '../lib/sorts/departure-schedule-list-sort.js';
import { authorize, requestHasPermission } from '../middleware/rbac.js';
import { getUserSiteIds, isAllSiteUser } from '../lib/site-access.js';
import { errorWith, itemResponse, paginatedResponse } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import {
  departureItem,
  departureScheduleItem,
  departureView,
  depotSystemOfDeparture,
  listFleetDepartureSchedules,
  listFleetDepartures,
  scheduleView,
  withDepotSystem,
  type DepartureReader,
} from '../lib/departure-views.js';

const DEFAULT_WINDOW_MS = 7 * 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const fleetParams = z.object({ id: ID_PARAMS.fleetId.describe('Fleet ID') });
const scheduleParams = z.object({
  id: ID_PARAMS.departureScheduleId.describe('Departure schedule ID'),
});
const departureParams = z.object({ id: ID_PARAMS.departureId.describe('Departure ID') });

const targetFields = {
  targetKind: z
    .enum(DEPARTURE_TARGET_KINDS)
    .describe('energy: targetEnergyKwh from the charger; soc: targetSocPercent of the battery'),
  targetEnergyKwh: z
    .number()
    .min(0.1)
    .max(2000)
    .optional()
    .describe('Energy from the charger in kWh (0.1 to 2000), for an energy target'),
  targetSocPercent: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Minimum state of charge in percent (1 to 100), for a soc target; needs the vehicle's battery capacity",
    ),
  targetSocMaxPercent: z
    .number()
    .int()
    .min(1)
    .max(100)
    .nullable()
    .optional()
    .describe(
      'Charge further up to this state of charge (the target to 100) from capacity no departure needs, for a soc target; null for none',
    ),
};

const priorityField = z
  .number()
  .int()
  .min(1)
  .max(10)
  .describe('1 lowest to 10 highest (default 5): who charges first when power is short');

const scheduleFields = {
  daysOfWeek: z
    .array(z.number().int().min(1).max(7))
    .min(1)
    .max(7)
    .describe('ISO days of the week, 1 (Monday) to 7 (Sunday)'),
  departureTime: z
    .string()
    .regex(TIME_HHMM)
    .describe('Departure time HH:MM, local time of the site'),
  validFrom: z
    .string()
    .regex(DATE_ONLY)
    .nullable()
    .optional()
    .describe('First local date the schedule applies (YYYY-MM-DD), null for no start'),
  validTo: z
    .string()
    .regex(DATE_ONLY)
    .nullable()
    .optional()
    .describe('Last local date the schedule applies (YYYY-MM-DD), null for no end'),
  isActive: z
    .boolean()
    .optional()
    .describe('False stops new occurrences and cancels the upcoming ones (default true)'),
  notes: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .describe('Free text notes, at most 500 characters'),
};

const createScheduleBody = z.object({
  vehicleId: ID_PARAMS.vehicleId.describe('Vehicle of a driver of the fleet'),
  siteId: ID_PARAMS.siteId.describe('Site (depot) the vehicle leaves from'),
  ...scheduleFields,
  ...targetFields,
  priority: priorityField.optional(),
});

const updateScheduleBody = z.object({
  siteId: ID_PARAMS.siteId.optional().describe('Site (depot) the vehicle leaves from'),
  daysOfWeek: scheduleFields.daysOfWeek.optional(),
  departureTime: scheduleFields.departureTime.optional(),
  validFrom: scheduleFields.validFrom,
  validTo: scheduleFields.validTo,
  isActive: scheduleFields.isActive,
  notes: scheduleFields.notes,
  targetKind: targetFields.targetKind.optional(),
  targetEnergyKwh: targetFields.targetEnergyKwh,
  targetSocPercent: targetFields.targetSocPercent,
  targetSocMaxPercent: targetFields.targetSocMaxPercent,
  priority: priorityField.optional(),
});

/** The expected arrival of a departure (create and update bodies). */
const arrivalFields = {
  expectedArrivalAt: z.iso
    .datetime({ offset: true })
    .nullable()
    .optional()
    .describe(
      'When the vehicle is expected to plug in (ISO 8601), before the departure; the plan counts it from then. Null removes it.',
    ),
  expectedArrivalSocPercent: z
    .number()
    .int()
    .min(0)
    .max(100)
    .nullable()
    .optional()
    .describe(
      'State of charge expected at arrival (0 to 100), used until the vehicle reports one. Null removes it.',
    ),
};

const createDepartureBody = z.object({
  vehicleId: ID_PARAMS.vehicleId.describe('Vehicle of a driver of the fleet'),
  siteId: ID_PARAMS.siteId.describe('Site (depot) the vehicle leaves from'),
  departureAt: z.iso
    .datetime({ offset: true })
    .describe('When the vehicle must be ready (ISO 8601), 5 minutes to 30 days ahead'),
  ...targetFields,
  ...arrivalFields,
  priority: priorityField.optional(),
});

const updateDepartureBody = z.object({
  departureAt: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('When the vehicle must be ready (ISO 8601), 5 minutes to 30 days ahead'),
  targetKind: targetFields.targetKind.optional(),
  targetEnergyKwh: targetFields.targetEnergyKwh,
  targetSocPercent: targetFields.targetSocPercent,
  targetSocMaxPercent: targetFields.targetSocMaxPercent,
  ...arrivalFields,
  priority: priorityField.optional(),
});

const scheduleListQuery = paginationQuery.extend({
  siteId: ID_PARAMS.siteId.optional().describe('Only schedules of this site'),
  vehicleId: ID_PARAMS.vehicleId.optional().describe('Only schedules of this vehicle'),
  ...departureScheduleListSort.query,
});

const departureListQuery = z.object({
  page: paginationQuery.shape.page,
  limit: paginationQuery.shape.limit,
  from: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('Departures at or after this time (ISO 8601, default now)'),
  to: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('Departures before this time (ISO 8601, default 7 days after from)'),
  status: z.enum(DEPARTURE_STATUSES).optional().describe('Only departures with this status'),
  siteId: ID_PARAMS.siteId.optional().describe('Only departures of this site'),
  vehicleId: ID_PARAMS.vehicleId.optional().describe('Only departures of this vehicle'),
});

const importBody = z.object({
  csv: z
    .string()
    .min(1)
    .max(DEPARTURE_IMPORT_MAX_BYTES)
    .describe(
      'CSV text, at most 512 KB and 2000 rows. Columns: vehicle (plate, VIN or id), site (id or name), departure (ISO 8601 with an offset, or YYYY-MM-DD HH:MM local time of the site), energy_kwh or soc_percent, priority (optional), arrival (optional, the expected arrival in the departure formats) and arrival_soc_percent (optional, 0 to 100)',
    ),
});

const scheduleWriteItem = departureScheduleItem
  .extend({
    occurrencesCreated: z.number().int().describe('Upcoming departures created'),
    occurrencesUpdated: z.number().int().describe('Upcoming departures updated'),
    occurrencesRemoved: z.number().int().describe('Upcoming departures removed'),
    occurrencesCancelled: z.number().int().describe('Upcoming departures cancelled'),
  })
  .loose();

const scheduleDeleteItem = z
  .object({
    success: z.literal(true).describe('The schedule was deleted'),
    occurrencesCancelled: z
      .number()
      .int()
      .describe('Upcoming departures of the schedule that were cancelled'),
  })
  .loose();

const cancelItem = departureItem
  .extend({
    changed: z.boolean().describe('False when the departure was already cancelled'),
  })
  .loose();

const importResultItem = z
  .object({
    created: z.number().int().describe('Departures created'),
    updated: z
      .number()
      .int()
      .describe('Manual or imported departures of the same vehicle within 10 minutes that changed'),
    unchanged: z.number().int().describe('Rows that matched a departure holding the same values'),
    refused: z
      .array(
        z
          .object({
            row: z.number().int().describe('Line of the row in the file (the header is line 1)'),
            field: z
              .enum([
                'vehicle',
                'site',
                'departure',
                'energy_kwh',
                'soc_percent',
                'priority',
                'arrival',
                'arrival_soc_percent',
              ])
              .describe('The column the row was refused for'),
            reason: z
              .enum(['missing', 'not_found', 'ambiguous', 'invalid'])
              .describe('Why the row was refused'),
          })
          .loose(),
      )
      .describe('Refused rows; nothing of a refused row was written'),
  })
  .loose();

const FLEET_NOT_FOUND = { error: 'Fleet not found', code: 'FLEET_NOT_FOUND' } as const;
// The Fleet feature switch refuses every departure route while it is off (app.ts).
const FLEET_DISABLED_RESPONSE = errorWith('Fleet is disabled', [ERROR_CODES.FLEET_DISABLED]);

async function fleetExists(id: string): Promise<boolean> {
  const [row] = await db.select({ id: fleets.id }).from(fleets).where(eq(fleets.id, id));
  return row != null;
}

async function departureCtx(request: FastifyRequest): Promise<DepartureCtx> {
  const { userId } = request.user as { userId: string };
  return {
    actor: getAuditActor(request),
    siteScope: await getUserSiteIds(userId),
    log: request.log,
    // Open readiness and departure pages of those sites refresh (departure.changed).
    onChange: (change) => publishDepartureChanged(change.siteIds, request.log),
  };
}

/** A departure names the session it charges in only for a sessions:read holder. */
async function departureReader(request: FastifyRequest): Promise<DepartureReader> {
  const { userId } = request.user as { userId: string };
  const [sessionIds, integrations, allSites] = await Promise.all([
    requestHasPermission(request, 'sessions:read'),
    requestHasPermission(request, 'settings.integrations:read'),
    isAllSiteUser(userId),
  ]);
  // The name of a bus depot system only for who may list them (all-site users).
  return { sessionIds, depotSystemNames: integrations && allSites };
}

/** A departure write reply, with its bus depot system part. */
async function departureReply(
  departure: VehicleDeparture,
  request: FastifyRequest,
): Promise<Record<string, unknown>> {
  const reader = await departureReader(request);
  return withDepotSystem(
    departureView(departure, reader),
    await depotSystemOfDeparture(departure),
    reader,
  );
}

interface TargetBody {
  targetKind?: (typeof DEPARTURE_TARGET_KINDS)[number] | undefined;
  targetEnergyKwh?: number | undefined;
  targetSocPercent?: number | undefined;
  targetSocMaxPercent?: number | null | undefined;
}

/** The target a body names; undefined when it names none. */
function targetOf(body: TargetBody): DepartureTarget | undefined {
  if (body.targetKind == null) {
    if (
      body.targetEnergyKwh != null ||
      body.targetSocPercent != null ||
      body.targetSocMaxPercent != null
    ) {
      throw new ValidationError('Send targetKind with the target value', { field: 'targetKind' });
    }
    return undefined;
  }
  if (body.targetKind === 'energy') {
    if (
      body.targetEnergyKwh == null ||
      body.targetSocPercent != null ||
      body.targetSocMaxPercent != null
    ) {
      throw new ValidationError('An energy target takes targetEnergyKwh only', {
        field: 'targetEnergyKwh',
      });
    }
    return { kind: 'energy', targetKwh: body.targetEnergyKwh };
  }
  if (body.targetSocPercent == null || body.targetEnergyKwh != null) {
    throw new ValidationError('A state of charge target takes targetSocPercent only', {
      field: 'targetSocPercent',
    });
  }
  return {
    kind: 'soc',
    targetSoc: body.targetSocPercent,
    maxSoc: body.targetSocMaxPercent ?? null,
  };
}

function requiredTarget(body: TargetBody): DepartureTarget {
  const target = targetOf(body);
  if (target == null) throw new ValidationError('A target is required', { field: 'targetKind' });
  return target;
}

async function refuseMissingFleet(reply: FastifyReply, id: string): Promise<boolean> {
  if (await fleetExists(id)) return false;
  await reply.status(404).send(FLEET_NOT_FOUND);
  return true;
}

export function departureRoutes(app: FastifyInstance): void {
  app.get(
    '/fleets/:id/departure-schedules',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'List departure schedules of a fleet',
        description:
          "Weekly departure schedules of the fleet's vehicles, newest first. A user restricted to some sites sees the schedules of its sites only.",
        operationId: 'listFleetDepartureSchedules',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(scheduleListQuery),
        response: {
          403: FLEET_DISABLED_RESPONSE,
          200: paginatedResponse(departureScheduleItem),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const query = request.query as z.infer<typeof scheduleListQuery>;
      if (await refuseMissingFleet(reply, id)) return;
      const { userId } = request.user as { userId: string };
      return listFleetDepartureSchedules(id, query, await getUserSiteIds(userId));
    },
  );

  app.post(
    '/fleets/:id/departure-schedules',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Create a departure schedule',
        description:
          "A weekly departure of a fleet vehicle from a site, in the site's local time. Creates the departures of today and the next 7 days at once. The vehicle must belong to a driver of the fleet, the site must be one of the caller's sites. A day that already holds 20 scheduled departures of the vehicle gets no occurrence. Works while fleet charging is off.",
        operationId: 'createFleetDepartureSchedule',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        body: zodSchema(createScheduleBody),
        response: {
          403: FLEET_DISABLED_RESPONSE,
          201: itemResponse(scheduleWriteItem),
          400: errorWith('Validation error or vehicle not in the fleet', [
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.VEHICLE_NOT_IN_FLEET,
          ]),
          404: errorWith('Fleet or site not found', [
            ERROR_CODES.FLEET_NOT_FOUND,
            ERROR_CODES.SITE_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const body = request.body as z.infer<typeof createScheduleBody>;
      const target = requiredTarget(body);
      if (await refuseMissingFleet(reply, id)) return;
      const result = await createDepartureSchedule(
        {
          fleetId: id,
          vehicleId: body.vehicleId,
          siteId: body.siteId,
          daysOfWeek: body.daysOfWeek,
          departureTime: body.departureTime,
          target,
          ...(body.priority != null ? { priority: body.priority } : {}),
          ...(body.validFrom !== undefined ? { validFrom: body.validFrom } : {}),
          ...(body.validTo !== undefined ? { validTo: body.validTo } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
        },
        await departureCtx(request),
      );
      const { schedule, ...counts } = result;
      await reply.status(201).send({ ...scheduleView(schedule), ...counts });
    },
  );

  app.patch(
    '/departure-schedules/:id',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Update a departure schedule',
        description:
          'Changes the schedule and its upcoming departures that no person changed: a date the schedule still covers takes the new time, target, priority and site, a date it no longer covers (or a schedule turned off) is cancelled, missing dates are created.',
        operationId: 'updateDepartureSchedule',
        security: [{ bearerAuth: [] }],
        params: zodSchema(scheduleParams),
        body: zodSchema(updateScheduleBody),
        response: {
          403: FLEET_DISABLED_RESPONSE,
          200: itemResponse(scheduleWriteItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Departure schedule or site not found', [
            ERROR_CODES.DEPARTURE_SCHEDULE_NOT_FOUND,
            ERROR_CODES.SITE_NOT_FOUND,
          ]),
        },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof scheduleParams>;
      const body = request.body as z.infer<typeof updateScheduleBody>;
      const update: ScheduleUpdate = {};
      if (body.siteId !== undefined) update.siteId = body.siteId;
      if (body.daysOfWeek !== undefined) update.daysOfWeek = body.daysOfWeek;
      if (body.departureTime !== undefined) update.departureTime = body.departureTime;
      if (body.validFrom !== undefined) update.validFrom = body.validFrom;
      if (body.validTo !== undefined) update.validTo = body.validTo;
      if (body.isActive !== undefined) update.isActive = body.isActive;
      if (body.notes !== undefined) update.notes = body.notes;
      if (body.priority !== undefined) update.priority = body.priority;
      const target = targetOf(body);
      if (target != null) update.target = target;
      const { schedule, ...counts } = await updateDepartureSchedule(
        id,
        update,
        await departureCtx(request),
      );
      return { ...scheduleView(schedule), ...counts };
    },
  );

  app.delete(
    '/departure-schedules/:id',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Delete a departure schedule',
        description:
          'Deletes the schedule and cancels its upcoming departures that no person changed. Departures a person changed stay.',
        operationId: 'deleteDepartureSchedule',
        security: [{ bearerAuth: [] }],
        params: zodSchema(scheduleParams),
        response: {
          403: FLEET_DISABLED_RESPONSE,
          200: itemResponse(scheduleDeleteItem),
          404: errorWith('Departure schedule not found', [
            ERROR_CODES.DEPARTURE_SCHEDULE_NOT_FOUND,
          ]),
        },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof scheduleParams>;
      const { occurrencesCancelled } = await deleteDepartureSchedule(
        id,
        await departureCtx(request),
      );
      return { success: true as const, occurrencesCancelled };
    },
  );

  app.get(
    '/fleets/:id/departures',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'List departures of a fleet',
        description:
          "Departures of the fleet's vehicles in departure time order, from now to 7 days ahead unless from and to say otherwise. A user restricted to some sites sees the departures of its sites only.",
        operationId: 'listFleetDepartures',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(departureListQuery),
        response: {
          403: FLEET_DISABLED_RESPONSE,
          200: paginatedResponse(departureItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const query = request.query as z.infer<typeof departureListQuery>;
      const from = query.from != null ? new Date(query.from) : new Date();
      const to =
        query.to != null ? new Date(query.to) : new Date(from.getTime() + DEFAULT_WINDOW_MS);
      if (to.getTime() <= from.getTime()) {
        await reply.status(400).send({
          error: 'to must be after from',
          code: 'VALIDATION_ERROR',
          details: { field: 'to' },
        });
        return;
      }
      if (await refuseMissingFleet(reply, id)) return;
      const { userId } = request.user as { userId: string };
      return listFleetDepartures(
        id,
        {
          page: query.page,
          limit: query.limit,
          from,
          to,
          status: query.status,
          siteId: query.siteId,
          vehicleId: query.vehicleId,
        },
        await getUserSiteIds(userId),
        await departureReader(request),
      );
    },
  );

  app.post(
    '/fleets/:id/departures',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Create a departure',
        description:
          "A one-off departure of a fleet vehicle from a site, 5 minutes to 30 days ahead. The vehicle must belong to a driver of the fleet, the site must be one of the caller's sites. A vehicle holds at most 20 scheduled departures on one local day of the site (400 VALIDATION_ERROR, field departureAt). Works while fleet charging is off.",
        operationId: 'createFleetDeparture',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        body: zodSchema(createDepartureBody),
        response: {
          403: FLEET_DISABLED_RESPONSE,
          201: itemResponse(departureItem),
          400: errorWith('Validation error or vehicle not in the fleet', [
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.VEHICLE_NOT_IN_FLEET,
          ]),
          404: errorWith('Fleet or site not found', [
            ERROR_CODES.FLEET_NOT_FOUND,
            ERROR_CODES.SITE_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const body = request.body as z.infer<typeof createDepartureBody>;
      const target = requiredTarget(body);
      if (await refuseMissingFleet(reply, id)) return;
      const departure = await createDeparture(
        {
          fleetId: id,
          vehicleId: body.vehicleId,
          siteId: body.siteId,
          departureAt: new Date(body.departureAt),
          target,
          source: 'manual',
          ...(body.priority != null ? { priority: body.priority } : {}),
          ...(body.expectedArrivalAt != null
            ? { expectedArrivalAt: new Date(body.expectedArrivalAt) }
            : {}),
          ...(body.expectedArrivalSocPercent != null
            ? { expectedArrivalSocPercent: body.expectedArrivalSocPercent }
            : {}),
        },
        await departureCtx(request),
      );
      await reply.status(201).send(await departureReply(departure, request));
    },
  );

  app.patch(
    '/departures/:id',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Update a departure',
        description:
          'Changes the time, target, priority or expected arrival of a scheduled departure and marks it changed by a person, so a later schedule edit leaves it alone. A cancelled or completed departure answers 409 DEPARTURE_NOT_SCHEDULED; a departure a bus depot system requested answers 409 DEPARTURE_MANAGED_BY_DEPOT_SYSTEM while that system is enabled.',
        operationId: 'updateDeparture',
        security: [{ bearerAuth: [] }],
        params: zodSchema(departureParams),
        body: zodSchema(updateDepartureBody),
        response: {
          403: FLEET_DISABLED_RESPONSE,
          200: itemResponse(departureItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Departure not found', [ERROR_CODES.DEPARTURE_NOT_FOUND]),
          409: errorWith('Departure not scheduled, or managed by a bus depot system', [
            ERROR_CODES.DEPARTURE_NOT_SCHEDULED,
            ERROR_CODES.DEPARTURE_MANAGED_BY_DEPOT_SYSTEM,
          ]),
        },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof departureParams>;
      const body = request.body as z.infer<typeof updateDepartureBody>;
      const update: DepartureUpdate = {};
      if (body.departureAt !== undefined) update.departureAt = new Date(body.departureAt);
      if (body.priority !== undefined) update.priority = body.priority;
      if (body.expectedArrivalAt !== undefined) {
        update.expectedArrivalAt =
          body.expectedArrivalAt === null ? null : new Date(body.expectedArrivalAt);
      }
      if (body.expectedArrivalSocPercent !== undefined) {
        update.expectedArrivalSocPercent = body.expectedArrivalSocPercent;
      }
      const target = targetOf(body);
      if (target != null) update.target = target;
      const departure = await updateDeparture(id, update, await departureCtx(request));
      return departureReply(departure, request);
    },
  );

  app.post(
    '/departures/:id/cancel',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Cancel a departure',
        description:
          'Cancels a scheduled departure. Cancelled is final: a second cancel changes nothing (changed false), a completed departure answers 409 DEPARTURE_NOT_SCHEDULED, and a departure a bus depot system requested answers 409 DEPARTURE_MANAGED_BY_DEPOT_SYSTEM while that system is enabled.',
        operationId: 'cancelDeparture',
        security: [{ bearerAuth: [] }],
        params: zodSchema(departureParams),
        response: {
          403: FLEET_DISABLED_RESPONSE,
          200: itemResponse(cancelItem),
          404: errorWith('Departure not found', [ERROR_CODES.DEPARTURE_NOT_FOUND]),
          409: errorWith('Departure not scheduled, or managed by a bus depot system', [
            ERROR_CODES.DEPARTURE_NOT_SCHEDULED,
            ERROR_CODES.DEPARTURE_MANAGED_BY_DEPOT_SYSTEM,
          ]),
        },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof departureParams>;
      const { departure, changed } = await cancelDeparture(id, await departureCtx(request));
      return { ...(await departureReply(departure, request)), changed };
    },
  );

  app.post(
    '/fleets/:id/departures/import',
    {
      onRequest: [authorize('fleets:write')],
      bodyLimit: 4 * DEPARTURE_IMPORT_MAX_BYTES,
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          keyGenerator: (request: FastifyRequest) => {
            const user = request.user as { userId?: string } | undefined;
            return `departure-import:${user?.userId ?? request.ip}`;
          },
        },
      },
      schema: {
        tags: ['Fleets'],
        summary: 'Import departures from CSV',
        description:
          "Creates a departure per row. A row that matches a manual or imported departure of the same vehicle within 10 minutes updates it, so importing the same file again changes nothing. Every row is checked against the fleet and the caller's sites; a refused row is reported by its line and column only. Cell text is never evaluated as a formula. The whole file is refused (400) when it is larger than 512 KB, holds more than 2000 rows or lacks a required column. A row that would give a vehicle more than 20 scheduled departures on one local day of the site is refused (departure, invalid). Limited to 5 imports a minute per user.",
        operationId: 'importFleetDepartures',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        body: zodSchema(importBody),
        response: {
          403: FLEET_DISABLED_RESPONSE,
          200: itemResponse(importResultItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { csv } = request.body as z.infer<typeof importBody>;
      if (await refuseMissingFleet(reply, id)) return;
      return importDepartures(id, csv, await departureCtx(request));
    },
  );
}
