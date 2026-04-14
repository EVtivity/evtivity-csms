// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, count, isNotNull, asc, inArray } from 'drizzle-orm';
import {
  db,
  chargingProfileTemplates,
  chargingProfilePushes,
  chargingProfilePushStations,
  chargingStations,
  sites,
  vendors,
} from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { errorResponse, paginatedResponse, itemResponse } from '../lib/response-schemas.js';
import { processChargingProfilePush } from '../lib/charging-profile-push.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { authorize } from '../middleware/rbac.js';

const templateItem = z.object({}).passthrough();
const templateParams = z.object({ id: z.string().describe('Template ID') });

const targetFilterSchema = z
  .object({
    siteId: z.string().optional(),
    vendorId: z.string().optional(),
    model: z.string().optional(),
  })
  .optional()
  .nullable();

const schedulePeriodSchema = z.object({
  startPeriod: z.number(),
  limit: z.number(),
  numberPhases: z.number().optional(),
});

const createTemplateBody = z.object({
  name: z.string().min(1).describe('Template name'),
  description: z.string().optional().describe('Template description'),
  ocppVersion: z.enum(['2.1', '1.6']).default('2.1').describe('OCPP version'),
  profileId: z.number().int().default(100).describe('OCPP charging profile ID'),
  profilePurpose: z
    .string()
    .refine((v) => v !== 'TxProfile' && v !== 'ChargingStationExternalConstraints', {
      message: 'TxProfile and ChargingStationExternalConstraints are not allowed',
    })
    .describe('Charging profile purpose'),
  profileKind: z.enum(['Absolute', 'Recurring']).describe('Charging profile kind'),
  recurrencyKind: z.string().optional().describe('Recurrency kind (required if Recurring)'),
  stackLevel: z.number().int().min(0).default(0).describe('Stack level'),
  evseId: z.number().int().min(0).default(0).describe('EVSE ID (0 for station-wide)'),
  chargingRateUnit: z.enum(['W', 'A']).default('W').describe('Charging rate unit'),
  schedulePeriods: z
    .array(schedulePeriodSchema)
    .min(1, 'At least one schedule period is required')
    .describe('Charging schedule periods'),
  startSchedule: z.string().datetime().optional().describe('Schedule start time (ISO 8601)'),
  duration: z.number().int().optional().describe('Schedule duration in seconds'),
  validFrom: z.string().datetime().optional().describe('Profile validity start (ISO 8601)'),
  validTo: z.string().datetime().optional().describe('Profile validity end (ISO 8601)'),
  targetFilter: targetFilterSchema.describe('Filter to select target stations'),
});

const updateTemplateBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  ocppVersion: z.enum(['2.1', '1.6']).optional(),
  profileId: z.number().int().optional(),
  profilePurpose: z
    .string()
    .refine((v) => v !== 'TxProfile' && v !== 'ChargingStationExternalConstraints', {
      message: 'TxProfile and ChargingStationExternalConstraints are not allowed',
    })
    .optional(),
  profileKind: z.enum(['Absolute', 'Recurring']).optional(),
  recurrencyKind: z.string().optional().nullable(),
  stackLevel: z.number().int().min(0).optional(),
  evseId: z.number().int().min(0).optional(),
  chargingRateUnit: z.enum(['W', 'A']).optional(),
  schedulePeriods: z.array(schedulePeriodSchema).min(1).optional(),
  startSchedule: z.string().datetime().optional().nullable(),
  duration: z.number().int().optional().nullable(),
  validFrom: z.string().datetime().optional().nullable(),
  validTo: z.string().datetime().optional().nullable(),
  targetFilter: targetFilterSchema,
});

export function smartChargingRoutes(app: FastifyInstance): void {
  // Filter options for target filter dropdowns
  app.get(
    '/smart-charging/filter-options',
    {
      onRequest: [authorize('smartCharging:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get filter options for smart charging template targeting',
        operationId: 'getSmartChargingFilterOptions',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(z.object({}).passthrough()) },
      },
    },
    async (request) => {
      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);

      const siteQuery = db.select({ id: sites.id, name: sites.name }).from(sites);
      const [siteRows, vendorRows, modelRows] = await Promise.all([
        accessibleSiteIds != null
          ? siteQuery.where(inArray(sites.id, accessibleSiteIds)).orderBy(asc(sites.name))
          : siteQuery.orderBy(asc(sites.name)),
        db.select({ id: vendors.id, name: vendors.name }).from(vendors).orderBy(asc(vendors.name)),
        db
          .selectDistinct({ model: chargingStations.model })
          .from(chargingStations)
          .where(isNotNull(chargingStations.model))
          .orderBy(asc(chargingStations.model)),
      ]);

      return {
        sites: siteRows,
        vendors: vendorRows,
        models: modelRows.map((r) => r.model as string),
      };
    },
  );

  // List templates
  app.get(
    '/smart-charging/templates',
    {
      onRequest: [authorize('smartCharging:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List charging profile templates',
        operationId: 'listChargingProfileTemplates',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(templateItem) },
      },
    },
    async (request) => {
      const query = request.query as z.infer<typeof paginationQuery>;
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [data, countResult] = await Promise.all([
        db
          .select()
          .from(chargingProfileTemplates)
          .orderBy(desc(chargingProfileTemplates.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(chargingProfileTemplates),
      ]);

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // Get template
  app.get(
    '/smart-charging/templates/:id',
    {
      onRequest: [authorize('smartCharging:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get charging profile template',
        operationId: 'getChargingProfileTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        response: { 200: itemResponse(templateItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;

      const [template] = await db
        .select()
        .from(chargingProfileTemplates)
        .where(eq(chargingProfileTemplates.id, id));
      if (template == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      return template;
    },
  );

  // Create template
  app.post(
    '/smart-charging/templates',
    {
      onRequest: [authorize('smartCharging:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Create a charging profile template',
        operationId: 'createChargingProfileTemplate',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createTemplateBody),
        response: { 201: itemResponse(templateItem), 400: errorResponse },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createTemplateBody>;

      // Validate excluded purposes
      if (
        body.profilePurpose === 'TxProfile' ||
        body.profilePurpose === 'ChargingStationExternalConstraints'
      ) {
        await reply.status(400).send({
          error: 'TxProfile and ChargingStationExternalConstraints are not allowed',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      // Validate recurrencyKind requirement
      if (body.profileKind === 'Recurring' && !body.recurrencyKind) {
        await reply.status(400).send({
          error: 'recurrencyKind is required when profileKind is Recurring',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      const [template] = await db
        .insert(chargingProfileTemplates)
        .values({
          name: body.name,
          description: body.description ?? null,
          ocppVersion: body.ocppVersion,
          profileId: body.profileId,
          profilePurpose: body.profilePurpose,
          profileKind: body.profileKind,
          recurrencyKind: body.recurrencyKind ?? null,
          stackLevel: body.stackLevel,
          evseId: body.evseId,
          chargingRateUnit: body.chargingRateUnit,
          schedulePeriods: body.schedulePeriods,
          startSchedule: body.startSchedule ? new Date(body.startSchedule) : null,
          duration: body.duration ?? null,
          validFrom: body.validFrom ? new Date(body.validFrom) : null,
          validTo: body.validTo ? new Date(body.validTo) : null,
          targetFilter: body.targetFilter ?? null,
        })
        .returning();

      return reply.status(201).send(template);
    },
  );

  // Update template
  app.patch(
    '/smart-charging/templates/:id',
    {
      onRequest: [authorize('smartCharging:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Update a charging profile template',
        operationId: 'updateChargingProfileTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        body: zodSchema(updateTemplateBody),
        response: { 200: itemResponse(templateItem), 400: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;
      const body = request.body as z.infer<typeof updateTemplateBody>;

      const [existing] = await db
        .select()
        .from(chargingProfileTemplates)
        .where(eq(chargingProfileTemplates.id, id));
      if (existing == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      // Validate recurrencyKind requirement on the resulting state
      const effectiveKind = body.profileKind ?? existing.profileKind;
      const effectiveRecurrency =
        body.recurrencyKind !== undefined ? body.recurrencyKind : existing.recurrencyKind;
      if (effectiveKind === 'Recurring' && !effectiveRecurrency) {
        await reply.status(400).send({
          error: 'recurrencyKind is required when profileKind is Recurring',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      // Build update object, converting datetime strings to Date objects
      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) updateData.name = body.name;
      if (body.description !== undefined) updateData.description = body.description;
      if (body.ocppVersion !== undefined) updateData.ocppVersion = body.ocppVersion;
      if (body.profileId !== undefined) updateData.profileId = body.profileId;
      if (body.profilePurpose !== undefined) updateData.profilePurpose = body.profilePurpose;
      if (body.profileKind !== undefined) updateData.profileKind = body.profileKind;
      if (body.recurrencyKind !== undefined) updateData.recurrencyKind = body.recurrencyKind;
      if (body.stackLevel !== undefined) updateData.stackLevel = body.stackLevel;
      if (body.evseId !== undefined) updateData.evseId = body.evseId;
      if (body.chargingRateUnit !== undefined) updateData.chargingRateUnit = body.chargingRateUnit;
      if (body.schedulePeriods !== undefined) updateData.schedulePeriods = body.schedulePeriods;
      if (body.startSchedule !== undefined)
        updateData.startSchedule = body.startSchedule ? new Date(body.startSchedule) : null;
      if (body.duration !== undefined) updateData.duration = body.duration;
      if (body.validFrom !== undefined)
        updateData.validFrom = body.validFrom ? new Date(body.validFrom) : null;
      if (body.validTo !== undefined)
        updateData.validTo = body.validTo ? new Date(body.validTo) : null;
      if (body.targetFilter !== undefined) updateData.targetFilter = body.targetFilter;

      const [updated] = await db
        .update(chargingProfileTemplates)
        .set(updateData)
        .where(eq(chargingProfileTemplates.id, id))
        .returning();

      return updated;
    },
  );

  // Duplicate template
  app.post(
    '/smart-charging/templates/:id/duplicate',
    {
      onRequest: [authorize('smartCharging:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Duplicate a charging profile template',
        operationId: 'duplicateChargingProfileTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        response: { 201: itemResponse(templateItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;

      const [original] = await db
        .select()
        .from(chargingProfileTemplates)
        .where(eq(chargingProfileTemplates.id, id));
      if (original == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      const [duplicate] = await db
        .insert(chargingProfileTemplates)
        .values({
          name: `${original.name} (Copy)`,
          description: original.description,
          ocppVersion: original.ocppVersion,
          profileId: original.profileId,
          profilePurpose: original.profilePurpose,
          profileKind: original.profileKind,
          recurrencyKind: original.recurrencyKind,
          stackLevel: original.stackLevel,
          evseId: original.evseId,
          chargingRateUnit: original.chargingRateUnit,
          schedulePeriods: original.schedulePeriods,
          startSchedule: original.startSchedule,
          duration: original.duration,
          validFrom: original.validFrom,
          validTo: original.validTo,
          targetFilter: original.targetFilter,
        })
        .returning();

      return reply.status(201).send(duplicate);
    },
  );

  // Delete template
  app.delete(
    '/smart-charging/templates/:id',
    {
      onRequest: [authorize('smartCharging:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Delete a charging profile template',
        operationId: 'deleteChargingProfileTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        response: { 204: { type: 'null' as const }, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;

      const [existing] = await db
        .select({ id: chargingProfileTemplates.id })
        .from(chargingProfileTemplates)
        .where(eq(chargingProfileTemplates.id, id));
      if (existing == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      await db.delete(chargingProfileTemplates).where(eq(chargingProfileTemplates.id, id));
      return reply.status(204).send();
    },
  );

  // Preview matching stations
  app.get(
    '/smart-charging/templates/:id/matching-stations',
    {
      onRequest: [authorize('smartCharging:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Preview stations matching the template target filter',
        operationId: 'listChargingProfileMatchingStations',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(templateItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;
      const query = request.query as z.infer<typeof paginationQuery>;
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [template] = await db
        .select()
        .from(chargingProfileTemplates)
        .where(eq(chargingProfileTemplates.id, id));
      if (template == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      const ocppVersion = template.ocppVersion;
      const expectedProtocol = `ocpp${ocppVersion}`;

      const filter = template.targetFilter as Record<string, string> | null;
      const conditions = [
        eq(chargingStations.isOnline, true),
        eq(chargingStations.ocppProtocol, expectedProtocol),
      ];
      if (filter?.siteId) conditions.push(eq(chargingStations.siteId, filter.siteId));
      if (filter?.vendorId) conditions.push(eq(chargingStations.vendorId, filter.vendorId));
      if (filter?.model) conditions.push(eq(chargingStations.model, filter.model));

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      if (accessibleSiteIds != null && accessibleSiteIds.length === 0)
        return { data: [], total: 0 };
      if (accessibleSiteIds != null)
        conditions.push(inArray(chargingStations.siteId, accessibleSiteIds));

      const whereClause = and(...conditions);

      const [data, countResult] = await Promise.all([
        db
          .select({
            id: chargingStations.id,
            stationId: chargingStations.stationId,
            model: chargingStations.model,
            siteName: sites.name,
            vendorName: vendors.name,
          })
          .from(chargingStations)
          .leftJoin(sites, eq(chargingStations.siteId, sites.id))
          .leftJoin(vendors, eq(chargingStations.vendorId, vendors.id))
          .where(whereClause)
          .orderBy(asc(chargingStations.stationId))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(chargingStations).where(whereClause),
      ]);

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // Push to matching stations
  app.post(
    '/smart-charging/templates/:id/push',
    {
      onRequest: [authorize('smartCharging:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Push charging profile template to matching stations via SetChargingProfile',
        operationId: 'pushChargingProfileTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        response: {
          200: itemResponse(z.object({ success: z.boolean(), pushId: z.string() }).passthrough()),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;

      const [template] = await db
        .select()
        .from(chargingProfileTemplates)
        .where(eq(chargingProfileTemplates.id, id));
      if (template == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      const schedulePeriods = template.schedulePeriods as unknown[];
      if (schedulePeriods.length === 0) {
        return { success: true, pushId: '' };
      }

      const ocppVersion = template.ocppVersion;
      const expectedProtocol = `ocpp${ocppVersion}`;

      // Resolve target stations from filter
      const filter = template.targetFilter as Record<string, string> | null;
      const conditions = [
        eq(chargingStations.isOnline, true),
        eq(chargingStations.ocppProtocol, expectedProtocol),
      ];
      if (filter?.siteId) conditions.push(eq(chargingStations.siteId, filter.siteId));
      if (filter?.vendorId) conditions.push(eq(chargingStations.vendorId, filter.vendorId));
      if (filter?.model) conditions.push(eq(chargingStations.model, filter.model));

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      if (accessibleSiteIds != null && accessibleSiteIds.length === 0) {
        return { success: true, pushId: '' };
      }
      if (accessibleSiteIds != null)
        conditions.push(inArray(chargingStations.siteId, accessibleSiteIds));

      const targetStations = await db
        .select({ id: chargingStations.id, stationId: chargingStations.stationId })
        .from(chargingStations)
        .where(and(...conditions));

      if (targetStations.length === 0) {
        return { success: true, pushId: '' };
      }

      // Create push record
      const [push] = await db
        .insert(chargingProfilePushes)
        .values({
          templateId: id,
          status: 'active',
          stationCount: targetStations.length,
        })
        .returning();

      const pushId = push?.id ?? '';

      // Insert push station rows
      await db.insert(chargingProfilePushStations).values(
        targetStations.map((s) => ({
          pushId,
          stationId: s.id,
          status: 'pending' as const,
        })),
      );

      // Process in background
      void processChargingProfilePush(pushId, targetStations, template, ocppVersion);

      return { success: true, pushId };
    },
  );

  // Push history for a template
  app.get(
    '/smart-charging/templates/:id/pushes',
    {
      onRequest: [authorize('smartCharging:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List push history for a charging profile template',
        operationId: 'listChargingProfilePushes',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(z.object({}).passthrough()), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;
      const query = request.query as z.infer<typeof paginationQuery>;
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [template] = await db
        .select({ id: chargingProfileTemplates.id })
        .from(chargingProfileTemplates)
        .where(eq(chargingProfileTemplates.id, id));
      if (template == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      const [pushes, countResult] = await Promise.all([
        db
          .select()
          .from(chargingProfilePushes)
          .where(eq(chargingProfilePushes.templateId, id))
          .orderBy(desc(chargingProfilePushes.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ total: count() })
          .from(chargingProfilePushes)
          .where(eq(chargingProfilePushes.templateId, id)),
      ]);

      // Get status counts for each push
      const data = await Promise.all(
        pushes.map(async (push) => {
          const statusCounts = await db
            .select({
              status: chargingProfilePushStations.status,
              count: count(),
            })
            .from(chargingProfilePushStations)
            .where(eq(chargingProfilePushStations.pushId, push.id))
            .groupBy(chargingProfilePushStations.status);

          const counts: Record<string, number> = {
            pendingCount: 0,
            acceptedCount: 0,
            rejectedCount: 0,
            failedCount: 0,
          };
          for (const row of statusCounts) {
            counts[`${row.status}Count`] = row.count;
          }

          return { ...push, ...counts };
        }),
      );

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // Push detail with per-station results
  app.get(
    '/smart-charging/pushes/:pushId',
    {
      onRequest: [authorize('smartCharging:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get charging profile push detail with per-station results',
        operationId: 'getChargingProfilePushDetail',
        security: [{ bearerAuth: [] }],
        params: zodSchema(z.object({ pushId: z.string().describe('Push ID') })),
        querystring: zodSchema(paginationQuery),
        response: { 200: itemResponse(z.object({}).passthrough()), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { pushId } = request.params as { pushId: string };
      const query = request.query as z.infer<typeof paginationQuery>;
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [push] = await db
        .select()
        .from(chargingProfilePushes)
        .where(eq(chargingProfilePushes.id, pushId));
      if (push == null) {
        await reply.status(404).send({ error: 'Push not found', code: 'PUSH_NOT_FOUND' });
        return;
      }

      // Get status counts
      const statusCounts = await db
        .select({
          status: chargingProfilePushStations.status,
          count: count(),
        })
        .from(chargingProfilePushStations)
        .where(eq(chargingProfilePushStations.pushId, pushId))
        .groupBy(chargingProfilePushStations.status);

      const counts: Record<string, number> = {
        acceptedCount: 0,
        rejectedCount: 0,
        failedCount: 0,
        pendingCount: 0,
      };
      for (const row of statusCounts) {
        counts[`${row.status}Count`] = row.count;
      }

      const stationRows = await db
        .select({
          id: chargingProfilePushStations.id,
          stationId: chargingProfilePushStations.stationId,
          stationName: chargingStations.stationId,
          status: chargingProfilePushStations.status,
          errorInfo: chargingProfilePushStations.errorInfo,
          updatedAt: chargingProfilePushStations.updatedAt,
        })
        .from(chargingProfilePushStations)
        .innerJoin(chargingStations, eq(chargingProfilePushStations.stationId, chargingStations.id))
        .where(eq(chargingProfilePushStations.pushId, pushId))
        .orderBy(asc(chargingStations.stationId))
        .limit(limit)
        .offset(offset);

      return { ...push, ...counts, stations: stationRows, stationsTotal: push.stationCount };
    },
  );
}
