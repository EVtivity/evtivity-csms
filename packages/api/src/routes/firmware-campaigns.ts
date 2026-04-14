// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, count, isNotNull, asc, inArray } from 'drizzle-orm';
import {
  db,
  firmwareCampaigns,
  firmwareCampaignStations,
  chargingStations,
  firmwareUpdates,
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
  successResponse,
} from '../lib/response-schemas.js';
import { getPubSub } from '../lib/pubsub.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { authorize } from '../middleware/rbac.js';

const campaignItem = z.object({}).passthrough();
const campaignParams = z.object({ id: z.string().describe('Campaign ID') });

const createCampaignBody = z.object({
  name: z.string().min(1).describe('Campaign name'),
  firmwareUrl: z.string().url().describe('Firmware download URL'),
  version: z.string().optional().describe('Firmware version'),
  targetFilter: z
    .object({
      siteId: z.string().optional(),
      vendorId: z.string().optional(),
      model: z.string().optional(),
      firmwareVersion: z.string().optional(),
    })
    .optional()
    .describe('Filter to select target stations'),
});

const updateCampaignBody = z.object({
  name: z.string().min(1).optional(),
  firmwareUrl: z.string().url().optional(),
  version: z.string().optional(),
  targetFilter: z
    .object({
      siteId: z.string().optional(),
      vendorId: z.string().optional(),
      model: z.string().optional(),
      firmwareVersion: z.string().optional(),
    })
    .optional(),
});

export function firmwareCampaignRoutes(app: FastifyInstance): void {
  // Filter options for target filter dropdowns
  app.get(
    '/firmware-campaigns/filter-options',
    {
      onRequest: [authorize('settings.firmware:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get filter options for firmware campaign targeting',
        operationId: 'getFirmwareCampaignFilterOptions',
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

  // List campaigns
  app.get(
    '/firmware-campaigns',
    {
      onRequest: [authorize('settings.firmware:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List firmware campaigns',
        operationId: 'listFirmwareCampaigns',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(campaignItem) },
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
          .from(firmwareCampaigns)
          .orderBy(desc(firmwareCampaigns.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(firmwareCampaigns),
      ]);

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // Get campaign detail
  app.get(
    '/firmware-campaigns/:id',
    {
      onRequest: [authorize('settings.firmware:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get firmware campaign with station progress',
        operationId: 'getFirmwareCampaign',
        security: [{ bearerAuth: [] }],
        params: zodSchema(campaignParams),
        querystring: zodSchema(paginationQuery),
        response: { 200: itemResponse(campaignItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof campaignParams>;
      const { page = 1, limit = 20 } = request.query as { page?: number; limit?: number };
      const offset = (page - 1) * limit;

      const [campaign] = await db
        .select()
        .from(firmwareCampaigns)
        .where(eq(firmwareCampaigns.id, id));
      if (campaign == null) {
        await reply.status(404).send({ error: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' });
        return;
      }

      const [stations, [countResult], statusCounts] = await Promise.all([
        db
          .select({
            id: firmwareCampaignStations.id,
            stationId: firmwareCampaignStations.stationId,
            stationName: chargingStations.stationId,
            status: firmwareCampaignStations.status,
            errorInfo: firmwareCampaignStations.errorInfo,
            updatedAt: firmwareCampaignStations.updatedAt,
          })
          .from(firmwareCampaignStations)
          .innerJoin(chargingStations, eq(firmwareCampaignStations.stationId, chargingStations.id))
          .where(eq(firmwareCampaignStations.campaignId, id))
          .limit(limit)
          .offset(offset),
        db
          .select({ total: count() })
          .from(firmwareCampaignStations)
          .where(eq(firmwareCampaignStations.campaignId, id)),
        db
          .select({
            status: firmwareCampaignStations.status,
            count: count(),
          })
          .from(firmwareCampaignStations)
          .where(eq(firmwareCampaignStations.campaignId, id))
          .groupBy(firmwareCampaignStations.status),
      ]);

      const counts: Record<string, number> = {};
      for (const row of statusCounts) {
        counts[row.status] = row.count;
      }

      return {
        ...campaign,
        stations,
        stationsTotal: countResult?.total ?? 0,
        installedCount: counts['installed'] ?? 0,
        failedCount: counts['failed'] ?? 0,
        pendingCount: counts['pending'] ?? 0,
        downloadingCount: counts['downloading'] ?? 0,
        downloadedCount: counts['downloaded'] ?? 0,
        installingCount: counts['installing'] ?? 0,
      };
    },
  );

  // Create campaign
  app.post(
    '/firmware-campaigns',
    {
      onRequest: [authorize('settings.firmware:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Create a firmware campaign',
        operationId: 'createFirmwareCampaign',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createCampaignBody),
        response: { 201: itemResponse(campaignItem) },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createCampaignBody>;
      const userId = (request.user as { userId: string }).userId;

      const [campaign] = await db
        .insert(firmwareCampaigns)
        .values({
          name: body.name,
          firmwareUrl: body.firmwareUrl,
          version: body.version ?? null,
          targetFilter: body.targetFilter ?? null,
          createdById: userId,
        })
        .returning();

      return reply.status(201).send(campaign);
    },
  );

  // Update campaign (draft only)
  app.patch(
    '/firmware-campaigns/:id',
    {
      onRequest: [authorize('settings.firmware:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Update a draft firmware campaign',
        operationId: 'updateFirmwareCampaign',
        security: [{ bearerAuth: [] }],
        params: zodSchema(campaignParams),
        body: zodSchema(updateCampaignBody),
        response: { 200: itemResponse(campaignItem), 404: errorResponse, 409: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof campaignParams>;
      const body = request.body as z.infer<typeof updateCampaignBody>;

      const [campaign] = await db
        .select()
        .from(firmwareCampaigns)
        .where(eq(firmwareCampaigns.id, id));
      if (campaign == null) {
        await reply.status(404).send({ error: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' });
        return;
      }
      if (campaign.status !== 'draft') {
        await reply
          .status(409)
          .send({ error: 'Only draft campaigns can be updated', code: 'NOT_DRAFT' });
        return;
      }

      const [updated] = await db
        .update(firmwareCampaigns)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(firmwareCampaigns.id, id))
        .returning();

      return updated;
    },
  );

  // Delete campaign (draft only)
  app.delete(
    '/firmware-campaigns/:id',
    {
      onRequest: [authorize('settings.firmware:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Delete a draft firmware campaign',
        operationId: 'deleteFirmwareCampaign',
        security: [{ bearerAuth: [] }],
        params: zodSchema(campaignParams),
        response: { 204: { type: 'null' as const }, 404: errorResponse, 409: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof campaignParams>;

      const [campaign] = await db
        .select()
        .from(firmwareCampaigns)
        .where(eq(firmwareCampaigns.id, id));
      if (campaign == null) {
        await reply.status(404).send({ error: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' });
        return;
      }
      if (campaign.status !== 'draft') {
        await reply
          .status(409)
          .send({ error: 'Only draft campaigns can be deleted', code: 'NOT_DRAFT' });
        return;
      }

      await db.delete(firmwareCampaigns).where(eq(firmwareCampaigns.id, id));
      return reply.status(204).send();
    },
  );

  // Preview matching stations for a campaign's target filter
  app.get(
    '/firmware-campaigns/:id/matching-stations',
    {
      onRequest: [authorize('settings.firmware:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Preview stations matching the campaign target filter',
        operationId: 'listFirmwareCampaignMatchingStations',
        security: [{ bearerAuth: [] }],
        params: zodSchema(campaignParams),
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(campaignItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof campaignParams>;
      const query = request.query as z.infer<typeof paginationQuery>;
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [campaign] = await db
        .select()
        .from(firmwareCampaigns)
        .where(eq(firmwareCampaigns.id, id));
      if (campaign == null) {
        await reply.status(404).send({ error: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' });
        return;
      }

      const filter = campaign.targetFilter as Record<string, string> | null;
      const conditions = [eq(chargingStations.isOnline, true)];
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
            firmwareVersion: chargingStations.firmwareVersion,
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

  // Start campaign
  app.post(
    '/firmware-campaigns/:id/start',
    {
      onRequest: [authorize('settings.firmware:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Start a firmware campaign - dispatch UpdateFirmware to targets',
        operationId: 'startFirmwareCampaign',
        security: [{ bearerAuth: [] }],
        params: zodSchema(campaignParams),
        response: { 200: successResponse, 404: errorResponse, 409: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof campaignParams>;

      const [campaign] = await db
        .select()
        .from(firmwareCampaigns)
        .where(eq(firmwareCampaigns.id, id));
      if (campaign == null) {
        await reply.status(404).send({ error: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' });
        return;
      }
      if (campaign.status !== 'draft') {
        await reply
          .status(409)
          .send({ error: 'Campaign is not in draft state', code: 'NOT_DRAFT' });
        return;
      }

      // Resolve target stations from filter
      const filter = campaign.targetFilter as Record<string, string> | null;
      const conditions = [eq(chargingStations.isOnline, true)];
      if (filter?.siteId) conditions.push(eq(chargingStations.siteId, filter.siteId));
      if (filter?.vendorId) conditions.push(eq(chargingStations.vendorId, filter.vendorId));
      if (filter?.model) conditions.push(eq(chargingStations.model, filter.model));

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      if (accessibleSiteIds != null && accessibleSiteIds.length === 0) {
        await reply.status(409).send({ error: 'No matching stations found', code: 'NO_TARGETS' });
        return;
      }
      if (accessibleSiteIds != null)
        conditions.push(inArray(chargingStations.siteId, accessibleSiteIds));

      const targets = await db
        .select({ id: chargingStations.id, stationId: chargingStations.stationId })
        .from(chargingStations)
        .where(and(...conditions));

      if (targets.length === 0) {
        await reply.status(409).send({ error: 'No matching stations found', code: 'NO_TARGETS' });
        return;
      }

      // Insert campaign station rows
      await db.insert(firmwareCampaignStations).values(
        targets.map((t) => ({
          campaignId: id,
          stationId: t.id,
        })),
      );

      // Mark campaign as active
      await db
        .update(firmwareCampaigns)
        .set({ status: 'active', updatedAt: new Date() })
        .where(eq(firmwareCampaigns.id, id));

      // Dispatch UpdateFirmware to each station
      const pubsub = getPubSub();
      for (const target of targets) {
        const commandPayload = {
          commandId: randomUUID(),
          stationId: target.stationId,
          action: 'UpdateFirmware',
          payload: {
            requestId: Math.floor(Math.random() * 2147483647),
            firmware: {
              location: campaign.firmwareUrl,
              retrieveDateTime: new Date().toISOString(),
            },
          },
        };

        // Create firmware update record linked to campaign
        await db.insert(firmwareUpdates).values({
          stationId: target.id,
          firmwareUrl: campaign.firmwareUrl,
          requestId: commandPayload.payload.requestId,
          campaignId: id,
          initiatedAt: new Date(),
        });

        try {
          await pubsub.publish('ocpp_commands', JSON.stringify(commandPayload));
        } catch {
          // Best-effort dispatch
        }
      }

      return { success: true };
    },
  );

  // Cancel campaign
  app.post(
    '/firmware-campaigns/:id/cancel',
    {
      onRequest: [authorize('settings.firmware:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Cancel an active firmware campaign',
        operationId: 'cancelFirmwareCampaign',
        security: [{ bearerAuth: [] }],
        params: zodSchema(campaignParams),
        response: { 200: successResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof campaignParams>;

      const [campaign] = await db
        .select()
        .from(firmwareCampaigns)
        .where(eq(firmwareCampaigns.id, id));
      if (campaign == null) {
        await reply.status(404).send({ error: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' });
        return;
      }

      await db
        .update(firmwareCampaigns)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(eq(firmwareCampaigns.id, id));

      return { success: true };
    },
  );
}
