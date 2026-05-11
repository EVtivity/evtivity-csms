// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, count, isNotNull, asc, inArray } from 'drizzle-orm';
import {
  db,
  configTemplates,
  configTemplatePushes,
  configTemplatePushStations,
  chargingStations,
  stationConfigurations,
  sites,
  vendors,
} from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import {
  errorResponse,
  paginatedResponse,
  itemResponse,
  arrayResponse,
} from '../lib/response-schemas.js';
import { processConfigPush } from '../lib/config-push.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { authorize } from '../middleware/rbac.js';

const templateVariableSchema = z
  .object({
    component: z.string().describe('OCPP component name'),
    variable: z.string().describe('OCPP variable name'),
    value: z.string().describe('Variable value to set'),
  })
  .passthrough();

const targetFilterResponseSchema = z
  .object({
    siteId: z.string().optional(),
    vendorId: z.string().optional(),
    model: z.string().optional(),
    stationId: z.string().optional(),
  })
  .passthrough();

const templateItem = z
  .object({
    id: z.string().describe('Template ID'),
    name: z.string().describe('Template name'),
    description: z.string().nullable().describe('Template description'),
    variables: z.array(templateVariableSchema).describe('Variable definitions'),
    ocppVersion: z.string().describe('OCPP version (1.6 or 2.1)'),
    targetFilter: targetFilterResponseSchema.nullable().describe('Target station filter'),
    stationId: z
      .string()
      .nullable()
      .describe('Station ID when template is auto-created for a single station'),
    createdAt: z.string().describe('ISO timestamp when template was created'),
    updatedAt: z.string().describe('ISO timestamp when template was last updated'),
    matchingStationsCount: z
      .number()
      .optional()
      .describe('Count of stations matching the target filter (list endpoint only)'),
  })
  .passthrough();

const filterOptionSiteSchema = z
  .object({
    id: z.string().describe('Site ID'),
    name: z.string().describe('Site name'),
  })
  .passthrough();

const filterOptionVendorSchema = z
  .object({
    id: z.string().describe('Vendor ID'),
    name: z.string().describe('Vendor name'),
  })
  .passthrough();

const filterOptionStationSchema = z
  .object({
    id: z.string().describe('Station UUID'),
    stationId: z.string().describe('Human-readable station identifier'),
  })
  .passthrough();

const filterOptionsItem = z
  .object({
    sites: z.array(filterOptionSiteSchema).describe('Available sites for filtering'),
    vendors: z.array(filterOptionVendorSchema).describe('Available vendors for filtering'),
    models: z.array(z.string()).describe('Available station models for filtering'),
    stations: z.array(filterOptionStationSchema).describe('Available stations for filtering'),
  })
  .passthrough();

const matchingStationItem = z
  .object({
    id: z.string().describe('Station UUID'),
    stationId: z.string().describe('Human-readable station identifier'),
    model: z.string().nullable().describe('Station model'),
    isOnline: z.boolean().describe('Whether the station is currently connected'),
    siteName: z.string().nullable().describe('Site name'),
    vendorName: z.string().nullable().describe('Vendor name'),
  })
  .passthrough();

const configDriftItem = z
  .object({
    component: z.string().describe('OCPP component name'),
    variable: z.string().describe('OCPP variable name'),
    expectedValue: z.string().describe('Value the template expects for the variable'),
    actualValue: z.string().nullable().describe('Value currently set on the station'),
    hasDrift: z.boolean().describe('Whether the actual value differs from the expected value'),
  })
  .passthrough();

const pushItem = z
  .object({
    id: z.string().describe('Push ID'),
    templateId: z.string().describe('Source config template ID'),
    status: z.string().describe('Push status (active or completed)'),
    stationCount: z.number().describe('Total number of target stations'),
    createdAt: z.string().describe('ISO timestamp when push was created'),
    updatedAt: z.string().describe('ISO timestamp when push was last updated'),
    pendingCount: z.number().describe('Stations still pending'),
    acceptedCount: z.number().describe('Stations that accepted the configuration'),
    rejectedCount: z.number().describe('Stations that rejected the configuration'),
    failedCount: z.number().describe('Stations where the push failed'),
  })
  .passthrough();

const pushStationItem = z
  .object({
    id: z.number().describe('Push station row ID'),
    stationId: z.string().describe('Station UUID'),
    stationName: z.string().describe('Human-readable station identifier'),
    status: z.string().describe('Per-station push status'),
    errorInfo: z.string().nullable().describe('Error details when status is rejected or failed'),
    updatedAt: z.string().describe('ISO timestamp when this row was last updated'),
  })
  .passthrough();

const pushDetailItem = z
  .object({
    id: z.string().describe('Push ID'),
    templateId: z.string().describe('Source config template ID'),
    status: z.string().describe('Push status (active or completed)'),
    stationCount: z.number().describe('Total number of target stations'),
    createdAt: z.string().describe('ISO timestamp when push was created'),
    updatedAt: z.string().describe('ISO timestamp when push was last updated'),
    pendingCount: z.number().describe('Stations still pending'),
    acceptedCount: z.number().describe('Stations that accepted the configuration'),
    rejectedCount: z.number().describe('Stations that rejected the configuration'),
    failedCount: z.number().describe('Stations where the push failed'),
    stations: z.array(pushStationItem).describe('Paginated per-station results'),
    stationsTotal: z.number().describe('Total number of stations in this push'),
  })
  .passthrough();

const templateParams = z.object({ id: z.string().describe('Template ID') });

const targetFilterSchema = z
  .object({
    siteId: z.string().optional(),
    vendorId: z.string().optional(),
    model: z.string().optional(),
    stationId: z.string().optional(),
  })
  .optional()
  .nullable();

const filterOptionsQuery = z.object({
  siteId: z.string().optional().describe('Filter stations by site'),
  vendorId: z.string().optional().describe('Filter stations by vendor'),
  model: z.string().optional().describe('Filter stations by model'),
});

const createTemplateBody = z.object({
  name: z.string().min(1).max(255).describe('Template name'),
  description: z.string().max(1000).optional().describe('Template description'),
  ocppVersion: z.enum(['2.1', '1.6']).default('2.1').describe('OCPP version for this template'),
  variables: z
    .array(
      z.object({
        // OCPP 1.6 has no Component concept - empty string is valid for 1.6 templates
        component: z.string().max(100),
        variable: z.string().min(1).max(100),
        value: z.string().max(2500),
      }),
    )
    .min(1)
    .max(500)
    .describe('Variable definitions to set on target stations'),
  targetFilter: targetFilterSchema.describe('Filter to select target stations'),
});

const updateTemplateBody = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  ocppVersion: z.enum(['2.1', '1.6']).optional().describe('OCPP version for this template'),
  variables: z
    .array(
      z.object({
        // OCPP 1.6 has no Component concept - empty string is valid for 1.6 templates
        component: z.string().max(100),
        variable: z.string().min(1).max(100),
        value: z.string().max(2500),
      }),
    )
    .min(1)
    .max(500)
    .optional(),
  targetFilter: targetFilterSchema,
});

export function configTemplateRoutes(app: FastifyInstance): void {
  // Filter options for target filter dropdowns
  app.get(
    '/config-templates/filter-options',
    {
      onRequest: [authorize('settings.stationConfig:read')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Get filter options for config template targeting',
        operationId: 'getConfigTemplateFilterOptions',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(filterOptionsQuery),
        response: { 200: itemResponse(filterOptionsItem) },
      },
    },
    async (request) => {
      const query = request.query as z.infer<typeof filterOptionsQuery>;
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

      const stationConds = [];
      if (query.siteId) stationConds.push(eq(chargingStations.siteId, query.siteId));
      if (query.vendorId) stationConds.push(eq(chargingStations.vendorId, query.vendorId));
      if (query.model) stationConds.push(eq(chargingStations.model, query.model));
      if (accessibleSiteIds != null && accessibleSiteIds.length > 0) {
        stationConds.push(inArray(chargingStations.siteId, accessibleSiteIds));
      }

      const stationRows =
        accessibleSiteIds != null && accessibleSiteIds.length === 0
          ? []
          : await db
              .select({ id: chargingStations.id, stationId: chargingStations.stationId })
              .from(chargingStations)
              .where(stationConds.length > 0 ? and(...stationConds) : undefined)
              .orderBy(asc(chargingStations.stationId))
              .limit(500);

      return {
        sites: siteRows,
        vendors: vendorRows,
        models: modelRows.map((r) => r.model as string),
        stations: stationRows,
      };
    },
  );

  // List templates
  app.get(
    '/config-templates',
    {
      onRequest: [authorize('settings.stationConfig:read')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'List configuration templates',
        operationId: 'listConfigTemplates',
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

      const [rows, countResult] = await Promise.all([
        db
          .select()
          .from(configTemplates)
          .orderBy(desc(configTemplates.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(configTemplates),
      ]);

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);

      const data = await Promise.all(
        rows.map(async (template) => {
          const filter = template.targetFilter as Record<string, string> | null;
          const conds = [eq(chargingStations.ocppProtocol, `ocpp${template.ocppVersion}`)];
          if (filter?.siteId) conds.push(eq(chargingStations.siteId, filter.siteId));
          if (filter?.vendorId) conds.push(eq(chargingStations.vendorId, filter.vendorId));
          if (filter?.model) conds.push(eq(chargingStations.model, filter.model));
          if (filter?.stationId) conds.push(eq(chargingStations.id, filter.stationId));
          if (accessibleSiteIds != null) {
            if (accessibleSiteIds.length === 0) return { ...template, matchingStationsCount: 0 };
            conds.push(inArray(chargingStations.siteId, accessibleSiteIds));
          }
          const [r] = await db
            .select({ total: count() })
            .from(chargingStations)
            .where(and(...conds));
          return { ...template, matchingStationsCount: r?.total ?? 0 };
        }),
      );

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // Get template
  app.get(
    '/config-templates/:id',
    {
      onRequest: [authorize('settings.stationConfig:read')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Get configuration template',
        operationId: 'getConfigTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        response: { 200: itemResponse(templateItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;

      const [template] = await db.select().from(configTemplates).where(eq(configTemplates.id, id));
      if (template == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      return template;
    },
  );

  // Create template
  app.post(
    '/config-templates',
    {
      onRequest: [authorize('settings.stationConfig:write')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Create a configuration template',
        operationId: 'createConfigTemplate',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createTemplateBody),
        response: { 201: itemResponse(templateItem) },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createTemplateBody>;

      const [template] = await db
        .insert(configTemplates)
        .values({
          name: body.name,
          description: body.description ?? null,
          ocppVersion: body.ocppVersion,
          variables: body.variables,
          targetFilter: body.targetFilter ?? null,
        })
        .returning();

      return reply.status(201).send(template);
    },
  );

  // Update template
  app.patch(
    '/config-templates/:id',
    {
      onRequest: [authorize('settings.stationConfig:write')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Update a configuration template',
        operationId: 'updateConfigTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        body: zodSchema(updateTemplateBody),
        response: { 200: itemResponse(templateItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;
      const body = request.body as z.infer<typeof updateTemplateBody>;

      const [existing] = await db
        .select({ id: configTemplates.id })
        .from(configTemplates)
        .where(eq(configTemplates.id, id));
      if (existing == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      const [updated] = await db
        .update(configTemplates)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(configTemplates.id, id))
        .returning();

      return updated;
    },
  );

  // Duplicate template
  app.post(
    '/config-templates/:id/duplicate',
    {
      onRequest: [authorize('settings.stationConfig:write')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Duplicate a configuration template',
        operationId: 'duplicateConfigTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        response: { 201: itemResponse(templateItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;

      const [original] = await db.select().from(configTemplates).where(eq(configTemplates.id, id));
      if (original == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      const [duplicate] = await db
        .insert(configTemplates)
        .values({
          name: `${original.name} (Copy)`,
          description: original.description,
          ocppVersion: original.ocppVersion,
          variables: original.variables,
          targetFilter: original.targetFilter,
        })
        .returning();

      return reply.status(201).send(duplicate);
    },
  );

  // Delete template
  app.delete(
    '/config-templates/:id',
    {
      onRequest: [authorize('settings.stationConfig:write')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Delete a configuration template',
        operationId: 'deleteConfigTemplate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        response: { 204: { type: 'null' as const }, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;

      const [existing] = await db
        .select({ id: configTemplates.id })
        .from(configTemplates)
        .where(eq(configTemplates.id, id));
      if (existing == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      await db.delete(configTemplates).where(eq(configTemplates.id, id));
      return reply.status(204).send();
    },
  );

  const matchingStationsQuery = paginationQuery.extend({
    status: z.enum(['online', 'offline']).optional().describe('Filter by online status'),
  });

  // Preview matching stations for a template's target filter
  app.get(
    '/config-templates/:id/matching-stations',
    {
      onRequest: [authorize('settings.stationConfig:read')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Preview stations matching the template target filter',
        operationId: 'listConfigTemplateMatchingStations',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        querystring: zodSchema(matchingStationsQuery),
        response: { 200: paginatedResponse(matchingStationItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;
      const query = request.query as z.infer<typeof matchingStationsQuery>;
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [template] = await db.select().from(configTemplates).where(eq(configTemplates.id, id));
      if (template == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      const ocppVersion = template.ocppVersion;
      const expectedProtocol = `ocpp${ocppVersion}`;

      const filter = template.targetFilter as Record<string, string> | null;
      // Show all stations matching the filter (online + offline) so this list
      // agrees with the matchingStationsCount shown on the templates list page.
      // The push endpoint applies its own isOnline check separately.
      const conditions = [eq(chargingStations.ocppProtocol, expectedProtocol)];
      if (filter?.siteId) conditions.push(eq(chargingStations.siteId, filter.siteId));
      if (filter?.vendorId) conditions.push(eq(chargingStations.vendorId, filter.vendorId));
      if (filter?.model) conditions.push(eq(chargingStations.model, filter.model));
      if (filter?.stationId) conditions.push(eq(chargingStations.id, filter.stationId));
      if (query.status === 'online') conditions.push(eq(chargingStations.isOnline, true));
      if (query.status === 'offline') conditions.push(eq(chargingStations.isOnline, false));

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
            isOnline: chargingStations.isOnline,
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

  // Push config to matching stations (tracked)
  app.post(
    '/config-templates/:id/push',
    {
      onRequest: [authorize('settings.stationConfig:write')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Push configuration template variables to matching stations via SetVariables',
        description:
          'Resolves online stations matching the template target filter and dispatches SetVariables (OCPP 2.1) or ChangeConfiguration (OCPP 1.6) for every variable. Creates a config_template_pushes row plus one config_template_push_stations row per target. Per-variable results stream back asynchronously. Returns the pushId so the caller can poll progress.',
        operationId: 'pushConfigTemplate',
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

      const [template] = await db.select().from(configTemplates).where(eq(configTemplates.id, id));
      if (template == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      const variables = template.variables as Array<{
        component: string;
        variable: string;
        value: string;
      }>;
      if (variables.length === 0) {
        return { success: true, pushId: '' };
      }

      const ocppVersion = template.ocppVersion;
      const expectedProtocol = `ocpp${ocppVersion}`;

      // Resolve target stations from filter, filtered by OCPP protocol
      const filter = template.targetFilter as Record<string, string> | null;
      const conditions = [
        eq(chargingStations.isOnline, true),
        eq(chargingStations.ocppProtocol, expectedProtocol),
      ];
      if (filter?.siteId) conditions.push(eq(chargingStations.siteId, filter.siteId));
      if (filter?.vendorId) conditions.push(eq(chargingStations.vendorId, filter.vendorId));
      if (filter?.model) conditions.push(eq(chargingStations.model, filter.model));
      if (filter?.stationId) conditions.push(eq(chargingStations.id, filter.stationId));

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
        .insert(configTemplatePushes)
        .values({
          templateId: id,
          status: 'active',
          stationCount: targetStations.length,
        })
        .returning();

      const pushId = push?.id ?? '';

      // Insert push station rows
      await db.insert(configTemplatePushStations).values(
        targetStations.map((s) => ({
          pushId,
          stationId: s.id,
          status: 'pending' as const,
        })),
      );

      // Process in background
      void processConfigPush(pushId, targetStations, variables, ocppVersion);

      return { success: true, pushId };
    },
  );

  // Push history for a template
  app.get(
    '/config-templates/:id/pushes',
    {
      onRequest: [authorize('settings.stationConfig:read')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'List push history for a configuration template',
        operationId: 'listConfigTemplatePushes',
        security: [{ bearerAuth: [] }],
        params: zodSchema(templateParams),
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(pushItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof templateParams>;
      const query = request.query as z.infer<typeof paginationQuery>;
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [template] = await db
        .select({ id: configTemplates.id })
        .from(configTemplates)
        .where(eq(configTemplates.id, id));
      if (template == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      const [pushes, countResult] = await Promise.all([
        db
          .select()
          .from(configTemplatePushes)
          .where(eq(configTemplatePushes.templateId, id))
          .orderBy(desc(configTemplatePushes.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ total: count() })
          .from(configTemplatePushes)
          .where(eq(configTemplatePushes.templateId, id)),
      ]);

      // Batch-fetch status counts for all pushes in one query
      const pushIds = pushes.map((p) => p.id);
      const allStatusCounts =
        pushIds.length > 0
          ? await db
              .select({
                pushId: configTemplatePushStations.pushId,
                status: configTemplatePushStations.status,
                count: count(),
              })
              .from(configTemplatePushStations)
              .where(inArray(configTemplatePushStations.pushId, pushIds))
              .groupBy(configTemplatePushStations.pushId, configTemplatePushStations.status)
          : [];

      // Group counts by pushId
      const countsByPush = new Map<string, Record<string, number>>();
      for (const row of allStatusCounts) {
        if (!countsByPush.has(row.pushId)) {
          countsByPush.set(row.pushId, {
            pendingCount: 0,
            acceptedCount: 0,
            rejectedCount: 0,
            failedCount: 0,
          });
        }
        const counts = countsByPush.get(row.pushId);
        if (counts != null) {
          counts[`${row.status}Count`] = row.count;
        }
      }

      const data = pushes.map((push) => {
        const counts = countsByPush.get(push.id) ?? {
          pendingCount: 0,
          acceptedCount: 0,
          rejectedCount: 0,
          failedCount: 0,
        };
        return { ...push, ...counts };
      });

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // Push detail with per-station results (paginated)
  app.get(
    '/config-template-pushes/:pushId',
    {
      onRequest: [authorize('settings.stationConfig:read')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Get config template push detail with per-station results',
        operationId: 'getConfigTemplatePushDetail',
        security: [{ bearerAuth: [] }],
        params: zodSchema(z.object({ pushId: z.string().describe('Push ID') })),
        querystring: zodSchema(paginationQuery),
        response: { 200: itemResponse(pushDetailItem), 404: errorResponse },
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
        .from(configTemplatePushes)
        .where(eq(configTemplatePushes.id, pushId));
      if (push == null) {
        await reply.status(404).send({ error: 'Push not found', code: 'PUSH_NOT_FOUND' });
        return;
      }

      // Get status counts
      const statusCounts = await db
        .select({
          status: configTemplatePushStations.status,
          count: count(),
        })
        .from(configTemplatePushStations)
        .where(eq(configTemplatePushStations.pushId, pushId))
        .groupBy(configTemplatePushStations.status);

      const counts: Record<string, number> = {
        acceptedCount: 0,
        rejectedCount: 0,
        failedCount: 0,
        pendingCount: 0,
      };
      for (const row of statusCounts) {
        counts[`${row.status}Count`] = row.count;
      }

      const stations = await db
        .select({
          id: configTemplatePushStations.id,
          stationId: configTemplatePushStations.stationId,
          stationName: chargingStations.stationId,
          status: configTemplatePushStations.status,
          errorInfo: configTemplatePushStations.errorInfo,
          updatedAt: configTemplatePushStations.updatedAt,
        })
        .from(configTemplatePushStations)
        .innerJoin(chargingStations, eq(configTemplatePushStations.stationId, chargingStations.id))
        .where(eq(configTemplatePushStations.pushId, pushId))
        .orderBy(asc(chargingStations.stationId))
        .limit(limit)
        .offset(offset);

      return { ...push, ...counts, stations, stationsTotal: push.stationCount };
    },
  );

  // Config drift detection for a station
  app.get(
    '/stations/:id/config-drift',
    {
      onRequest: [authorize('settings.stationConfig:read')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Compare station variables against matching config templates',
        operationId: 'getStationConfigDrift',
        security: [{ bearerAuth: [] }],
        params: zodSchema(z.object({ id: z.string().describe('Station ID') })),
        response: { 200: arrayResponse(configDriftItem) },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };

      // Get station details for filter matching
      const [station] = await db
        .select({
          id: chargingStations.id,
          siteId: chargingStations.siteId,
          vendorId: chargingStations.vendorId,
          model: chargingStations.model,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) return [];

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      if (
        accessibleSiteIds != null &&
        station.siteId != null &&
        !accessibleSiteIds.includes(station.siteId)
      ) {
        return [];
      }

      // Get all templates
      const templates = await db.select().from(configTemplates);

      // Find templates whose targetFilter matches this station
      const matchingTemplates = templates.filter((t) => {
        const filter = t.targetFilter as Record<string, string> | null;
        if (filter == null) return true; // No filter = all stations
        if (filter.siteId && filter.siteId !== station.siteId) return false;
        if (filter.vendorId && filter.vendorId !== station.vendorId) return false;
        if (filter.model && filter.model !== station.model) return false;
        if (filter.stationId && filter.stationId !== station.id) return false;
        return true;
      });

      if (matchingTemplates.length === 0) return [];

      // Get actual station variables
      const actualVars = await db
        .select()
        .from(stationConfigurations)
        .where(eq(stationConfigurations.stationId, id));

      const drifts = [];
      for (const template of matchingTemplates) {
        const variables = template.variables as Array<{
          component: string;
          variable: string;
          value: string;
        }>;

        for (const expected of variables) {
          const actual = actualVars.find(
            (v) => v.component === expected.component && v.variable === expected.variable,
          );
          const actualValue = actual?.value ?? null;
          if (actualValue !== expected.value) {
            drifts.push({
              component: expected.component,
              variable: expected.variable,
              expectedValue: expected.value,
              actualValue,
              hasDrift: true,
            });
          }
        }
      }

      return drifts;
    },
  );
}
