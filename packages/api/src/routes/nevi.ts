// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, gte, lte, desc, count, sql, inArray } from 'drizzle-orm';
import { db, neviStationData, neviExcludedDowntime, chargingStations } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import {
  errorResponse,
  successResponse,
  paginatedResponse,
  itemResponse,
} from '../lib/response-schemas.js';
import { authorize } from '../middleware/rbac.js';
import { getUserSiteIds } from '../lib/site-access.js';

const neviStationDataItem = z.object({}).passthrough();
const neviStationDataList = z.object({ data: z.array(z.object({}).passthrough()) }).passthrough();
const neviExcludedDowntimeItem = z.object({}).passthrough();

const upsertStationDataBody = z.object({
  operatorName: z.string().max(255).optional(),
  operatorAddress: z.string().max(500).optional(),
  operatorPhone: z.string().max(50).optional(),
  operatorEmail: z.string().max(255).optional(),
  installationCost: z.string().optional().describe('Installation cost as a decimal string'),
  gridConnectionCost: z.string().optional().describe('Grid connection cost as a decimal string'),
  maintenanceCostAnnual: z
    .string()
    .optional()
    .describe('Annual maintenance cost as a decimal string'),
  maintenanceCostYear: z.number().int().optional().describe('Year the maintenance cost applies to'),
  derCapacityKw: z.string().optional().describe('Distributed energy resource capacity in kW'),
  derCapacityKwh: z.string().optional().describe('Distributed energy resource capacity in kWh'),
  derType: z
    .string()
    .max(100)
    .optional()
    .describe('Type of distributed energy resource (e.g. solar, battery)'),
  programParticipation: z
    .array(z.string())
    .optional()
    .describe('List of NEVI program names the station participates in'),
});

const createExcludedDowntimeBody = z.object({
  stationId: ID_PARAMS.stationId.describe('Station ID'),
  evseId: z.number().int().describe('EVSE ID on the station'),
  reason: z
    .enum([
      'utility_outage',
      'vandalism',
      'natural_disaster',
      'scheduled_maintenance',
      'vehicle_caused',
    ])
    .describe('Reason for the excluded downtime'),
  startedAt: z.string().describe('ISO 8601 date-time when downtime started'),
  endedAt: z.string().optional().describe('ISO 8601 date-time when downtime ended'),
  notes: z.string().max(1000).optional(),
});

const updateExcludedDowntimeBody = createExcludedDowntimeBody.partial();

const excludedDowntimeQuery = paginationQuery.extend({
  stationId: ID_PARAMS.stationId.optional().describe('Filter by station ID'),
  from: z.string().optional().describe('ISO 8601 date-time lower bound for startedAt'),
  to: z.string().optional().describe('ISO 8601 date-time upper bound for startedAt'),
});

export function neviRoutes(app: FastifyInstance): void {
  // List NEVI station data
  app.get(
    '/nevi/station-data',
    {
      onRequest: [authorize('reports:read')],
      schema: {
        tags: ['NEVI'],
        summary: 'List NEVI station data for all stations',
        operationId: 'listNeviStationData',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(neviStationDataList) },
      },
    },
    async (request) => {
      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) return { data: [] };

      const conditions = [];
      if (siteIds != null) {
        conditions.push(inArray(chargingStations.siteId, siteIds));
      }

      const rows = await db
        .select({
          id: neviStationData.id,
          stationId: neviStationData.stationId,
          stationName: chargingStations.stationId,
          operatorName: neviStationData.operatorName,
          operatorAddress: neviStationData.operatorAddress,
          operatorPhone: neviStationData.operatorPhone,
          operatorEmail: neviStationData.operatorEmail,
          installationCost: neviStationData.installationCost,
          gridConnectionCost: neviStationData.gridConnectionCost,
          maintenanceCostAnnual: neviStationData.maintenanceCostAnnual,
          maintenanceCostYear: neviStationData.maintenanceCostYear,
          derCapacityKw: neviStationData.derCapacityKw,
          derCapacityKwh: neviStationData.derCapacityKwh,
          derType: neviStationData.derType,
          programParticipation: neviStationData.programParticipation,
          createdAt: neviStationData.createdAt,
          updatedAt: neviStationData.updatedAt,
        })
        .from(neviStationData)
        .innerJoin(chargingStations, eq(neviStationData.stationId, chargingStations.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(chargingStations.stationId);

      return { data: rows };
    },
  );

  // Upsert NEVI station data
  app.put(
    '/nevi/station-data/:stationId',
    {
      onRequest: [authorize('reports:write')],
      schema: {
        tags: ['NEVI'],
        summary: 'Create or update NEVI data for a station',
        operationId: 'upsertNeviStationData',
        security: [{ bearerAuth: [] }],
        body: zodSchema(upsertStationDataBody),
        response: { 200: itemResponse(neviStationDataItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { stationId } = request.params as { stationId: string };
      const body = request.body as z.infer<typeof upsertStationDataBody>;

      const [station] = await db
        .select({ id: chargingStations.id, siteId: chargingStations.siteId })
        .from(chargingStations)
        .where(eq(chargingStations.id, stationId));

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

      const values = {
        stationId,
        operatorName: body.operatorName ?? null,
        operatorAddress: body.operatorAddress ?? null,
        operatorPhone: body.operatorPhone ?? null,
        operatorEmail: body.operatorEmail ?? null,
        installationCost: body.installationCost ?? null,
        gridConnectionCost: body.gridConnectionCost ?? null,
        maintenanceCostAnnual: body.maintenanceCostAnnual ?? null,
        maintenanceCostYear: body.maintenanceCostYear ?? null,
        derCapacityKw: body.derCapacityKw ?? null,
        derCapacityKwh: body.derCapacityKwh ?? null,
        derType: body.derType ?? null,
        programParticipation: body.programParticipation ?? null,
        updatedAt: sql`now()`,
      };

      const [row] = await db
        .insert(neviStationData)
        .values(values)
        .onConflictDoUpdate({
          target: neviStationData.stationId,
          set: values,
        })
        .returning();

      return row;
    },
  );

  // List excluded downtime
  app.get(
    '/nevi/excluded-downtime',
    {
      onRequest: [authorize('reports:read')],
      schema: {
        tags: ['NEVI'],
        summary: 'List excluded downtime records',
        operationId: 'listNeviExcludedDowntime',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(excludedDowntimeQuery),
        response: { 200: paginatedResponse(neviExcludedDowntimeItem) },
      },
    },
    async (request) => {
      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) return { data: [], total: 0 };

      const query = request.query as z.infer<typeof excludedDowntimeQuery>;
      const { page, limit, stationId, from, to } = query;
      const offset = (page - 1) * limit;

      const conditions = [];
      if (stationId) {
        conditions.push(eq(neviExcludedDowntime.stationId, stationId));
      }
      if (from) {
        conditions.push(gte(neviExcludedDowntime.startedAt, new Date(from)));
      }
      if (to) {
        conditions.push(lte(neviExcludedDowntime.startedAt, new Date(to)));
      }
      if (siteIds != null) {
        conditions.push(inArray(chargingStations.siteId, siteIds));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [dataResult, countResult] = await Promise.all([
        db
          .select({
            id: neviExcludedDowntime.id,
            stationId: neviExcludedDowntime.stationId,
            stationName: chargingStations.stationId,
            evseId: neviExcludedDowntime.evseId,
            reason: neviExcludedDowntime.reason,
            startedAt: neviExcludedDowntime.startedAt,
            endedAt: neviExcludedDowntime.endedAt,
            notes: neviExcludedDowntime.notes,
            createdAt: neviExcludedDowntime.createdAt,
          })
          .from(neviExcludedDowntime)
          .innerJoin(chargingStations, eq(neviExcludedDowntime.stationId, chargingStations.id))
          .where(whereClause)
          .orderBy(desc(neviExcludedDowntime.startedAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: count() })
          .from(neviExcludedDowntime)
          .innerJoin(chargingStations, eq(neviExcludedDowntime.stationId, chargingStations.id))
          .where(whereClause),
      ]);

      return {
        data: dataResult,
        total: countResult[0]?.count ?? 0,
      } satisfies PaginatedResponse<(typeof dataResult)[number]>;
    },
  );

  // Create excluded downtime
  app.post(
    '/nevi/excluded-downtime',
    {
      onRequest: [authorize('reports:write')],
      schema: {
        tags: ['NEVI'],
        summary: 'Create an excluded downtime record',
        operationId: 'createNeviExcludedDowntime',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createExcludedDowntimeBody),
        response: { 200: itemResponse(neviExcludedDowntimeItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createExcludedDowntimeBody>;
      const user = request.user as { userId: string };

      const [station] = await db
        .select({ siteId: chargingStations.siteId })
        .from(chargingStations)
        .where(eq(chargingStations.id, body.stationId));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const siteIds = await getUserSiteIds(user.userId);
      if (siteIds != null && station.siteId != null && !siteIds.includes(station.siteId)) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const [row] = await db
        .insert(neviExcludedDowntime)
        .values({
          stationId: body.stationId,
          evseId: body.evseId,
          reason: body.reason,
          startedAt: new Date(body.startedAt),
          endedAt: body.endedAt ? new Date(body.endedAt) : null,
          notes: body.notes ?? null,
          createdById: user.userId,
        })
        .returning();

      return row;
    },
  );

  // Update excluded downtime
  app.patch(
    '/nevi/excluded-downtime/:id',
    {
      onRequest: [authorize('reports:write')],
      schema: {
        tags: ['NEVI'],
        summary: 'Update an excluded downtime record',
        operationId: 'updateNeviExcludedDowntime',
        security: [{ bearerAuth: [] }],
        body: zodSchema(updateExcludedDowntimeBody),
        response: { 200: itemResponse(neviExcludedDowntimeItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const body = request.body as z.infer<typeof updateExcludedDowntimeBody>;

      const [existing] = await db
        .select({
          id: neviExcludedDowntime.id,
          stationId: neviExcludedDowntime.stationId,
          siteId: chargingStations.siteId,
        })
        .from(neviExcludedDowntime)
        .innerJoin(chargingStations, eq(neviExcludedDowntime.stationId, chargingStations.id))
        .where(eq(neviExcludedDowntime.id, id));

      if (existing == null) {
        await reply.status(404).send({
          error: 'Excluded downtime record not found',
          code: 'DOWNTIME_NOT_FOUND',
        });
        return;
      }

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && existing.siteId != null && !siteIds.includes(existing.siteId)) {
        await reply.status(404).send({
          error: 'Excluded downtime record not found',
          code: 'DOWNTIME_NOT_FOUND',
        });
        return;
      }

      const updates: Record<string, unknown> = { updatedAt: sql`now()` };
      if (body.stationId != null) updates['stationId'] = body.stationId;
      if (body.evseId != null) updates['evseId'] = body.evseId;
      if (body.reason != null) updates['reason'] = body.reason;
      if (body.startedAt != null) updates['startedAt'] = new Date(body.startedAt);
      if (body.endedAt !== undefined)
        updates['endedAt'] = body.endedAt ? new Date(body.endedAt) : null;
      if (body.notes !== undefined) updates['notes'] = body.notes ?? null;

      const [updated] = await db
        .update(neviExcludedDowntime)
        .set(updates)
        .where(eq(neviExcludedDowntime.id, id))
        .returning();

      return updated;
    },
  );

  // Delete excluded downtime
  app.delete(
    '/nevi/excluded-downtime/:id',
    {
      onRequest: [authorize('reports:write')],
      schema: {
        tags: ['NEVI'],
        summary: 'Delete an excluded downtime record',
        operationId: 'deleteNeviExcludedDowntime',
        security: [{ bearerAuth: [] }],
        response: { 200: successResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };

      const [existing] = await db
        .select({
          id: neviExcludedDowntime.id,
          siteId: chargingStations.siteId,
        })
        .from(neviExcludedDowntime)
        .innerJoin(chargingStations, eq(neviExcludedDowntime.stationId, chargingStations.id))
        .where(eq(neviExcludedDowntime.id, id));

      if (existing == null) {
        await reply.status(404).send({
          error: 'Excluded downtime record not found',
          code: 'DOWNTIME_NOT_FOUND',
        });
        return;
      }

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && existing.siteId != null && !siteIds.includes(existing.siteId)) {
        await reply.status(404).send({
          error: 'Excluded downtime record not found',
          code: 'DOWNTIME_NOT_FOUND',
        });
        return;
      }

      await db.delete(neviExcludedDowntime).where(eq(neviExcludedDowntime.id, id));
      return { success: true };
    },
  );
}
