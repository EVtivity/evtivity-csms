// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, count, isNotNull, asc, inArray } from 'drizzle-orm';
import {
  db,
  firmwareCampaigns,
  firmwareCampaignStations,
  firmwareCampaignStatusEnum,
  firmwareUpdates,
  chargingStations,
  sites,
  vendors,
  writeAudit,
  firmwareCampaignAuditLog,
} from '@evtivity/database';
import { getAuditActor } from '../lib/audit-actor.js';
import { zodSchema } from '../lib/zod-schema.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import {
  errorResponse,
  paginatedResponse,
  itemResponse,
  successResponse,
  errorWith,
} from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { getPubSub } from '../lib/pubsub.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { authorize } from '../middleware/rbac.js';

const campaignItem = z
  .object({
    id: z.string().describe('Campaign ID'),
    name: z.string().describe('Campaign name'),
    firmwareUrl: z.string().describe('Firmware download URL'),
    version: z.string().nullable().describe('Firmware version'),
    status: z.enum(firmwareCampaignStatusEnum.enumValues).describe('Campaign status'),
    targetFilter: z.record(z.unknown()).nullable().describe('Filter selecting target stations'),
    createdById: z.string().nullable().describe('User ID that created the campaign'),
    createdAt: z.string().describe('Row creation timestamp'),
    updatedAt: z.string().describe('Row last update timestamp'),
  })
  .passthrough();

const fwMatchingStationItem = z
  .object({
    id: z.string().describe('Station UUID'),
    stationId: z.string().describe('Human-readable station identifier'),
    model: z.string().nullable().describe('Station model'),
    firmwareVersion: z.string().nullable().describe('Currently installed firmware version'),
    isOnline: z.boolean().describe('Whether the station is currently connected'),
    siteName: z.string().nullable().describe('Site name'),
    vendorName: z.string().nullable().describe('Vendor name'),
  })
  .passthrough();

const filterOptionsResponse = z
  .object({
    sites: z
      .array(
        z
          .object({
            id: z.string().describe('Site identifier'),
            name: z.string().describe('Site display name'),
          })
          .passthrough(),
      )
      .describe('Sites available for targeting'),
    vendors: z
      .array(
        z
          .object({
            id: z.string().describe('Vendor identifier'),
            name: z.string().describe('Vendor display name'),
          })
          .passthrough(),
      )
      .describe('Vendors available for targeting'),
    models: z.array(z.string()).describe('Distinct station models available for targeting'),
    stations: z
      .array(
        z
          .object({
            id: z.string().describe('Station UUID'),
            stationId: z.string().describe('Human-readable station identifier'),
          })
          .passthrough(),
      )
      .describe('Stations matching the current filter'),
  })
  .passthrough();

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
      stationId: z.string().optional(),
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
      stationId: z.string().optional(),
      firmwareVersion: z.string().optional(),
    })
    .nullable()
    .optional(),
});

const fwFilterOptionsQuery = z.object({
  siteId: z.string().optional().describe('Filter stations by site'),
  vendorId: z.string().optional().describe('Filter stations by vendor'),
  model: z.string().optional().describe('Filter stations by model'),
});

export function firmwareCampaignRoutes(app: FastifyInstance): void {
  // Filter options for target filter dropdowns
  app.get(
    '/firmware-campaigns/filter-options',
    {
      onRequest: [authorize('settings.firmware:read')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Get filter options for firmware campaign targeting',
        operationId: 'getFirmwareCampaignFilterOptions',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(fwFilterOptionsQuery),
        response: { 200: itemResponse(filterOptionsResponse) },
      },
    },
    async (request) => {
      const query = request.query as z.infer<typeof fwFilterOptionsQuery>;
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

  // List campaigns
  app.get(
    '/firmware-campaigns',
    {
      onRequest: [authorize('settings.firmware:read')],
      schema: {
        tags: ['Fleet Operations'],
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
        tags: ['Fleet Operations'],
        summary: 'Get firmware campaign with station progress',
        operationId: 'getFirmwareCampaign',
        security: [{ bearerAuth: [] }],
        params: zodSchema(campaignParams),
        querystring: zodSchema(paginationQuery),
        response: {
          200: itemResponse(campaignItem),
          404: errorWith('Campaign not found', [ERROR_CODES.CAMPAIGN_NOT_FOUND]),
        },
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
        tags: ['Fleet Operations'],
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

      if (campaign != null) {
        const actor = getAuditActor(request);
        await writeAudit(
          { table: firmwareCampaignAuditLog, idColumn: 'campaign_id' },
          {
            entityId: campaign.id,
            entityIdSnapshot: campaign.id,
            action: 'created',
            ...actor,
            after: campaign,
          },
          db,
          request.log,
        );
      }

      return reply.status(201).send(campaign);
    },
  );

  // Update campaign (draft only)
  app.patch(
    '/firmware-campaigns/:id',
    {
      onRequest: [authorize('settings.firmware:write')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Update a draft firmware campaign',
        operationId: 'updateFirmwareCampaign',
        security: [{ bearerAuth: [] }],
        params: zodSchema(campaignParams),
        body: zodSchema(updateCampaignBody),
        response: {
          200: itemResponse(campaignItem),
          404: errorWith('Campaign not found', [ERROR_CODES.CAMPAIGN_NOT_FOUND]),
          409: errorResponse,
        },
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

      if (updated != null) {
        const actor = getAuditActor(request);
        await writeAudit(
          { table: firmwareCampaignAuditLog, idColumn: 'campaign_id' },
          {
            entityId: updated.id,
            entityIdSnapshot: updated.id,
            action: 'updated',
            ...actor,
            before: campaign,
            after: updated,
          },
          db,
          request.log,
        );
      }

      return updated;
    },
  );

  // Delete campaign (draft only)
  app.delete(
    '/firmware-campaigns/:id',
    {
      onRequest: [authorize('settings.firmware:write')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Delete a draft firmware campaign',
        operationId: 'deleteFirmwareCampaign',
        security: [{ bearerAuth: [] }],
        params: zodSchema(campaignParams),
        response: {
          204: { type: 'null' as const },
          404: errorWith('Campaign not found', [ERROR_CODES.CAMPAIGN_NOT_FOUND]),
          409: errorResponse,
        },
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

      const actor = getAuditActor(request);
      await writeAudit(
        { table: firmwareCampaignAuditLog, idColumn: 'campaign_id' },
        {
          entityId: null,
          entityIdSnapshot: id,
          action: 'deleted',
          ...actor,
          before: campaign,
        },
        db,
        request.log,
      );

      return reply.status(204).send();
    },
  );

  const fwMatchingStationsQuery = paginationQuery.extend({
    status: z.enum(['online', 'offline']).optional().describe('Filter by online status'),
  });

  // Preview matching stations for a campaign's target filter
  app.get(
    '/firmware-campaigns/:id/matching-stations',
    {
      onRequest: [authorize('settings.firmware:read')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Preview stations matching the campaign target filter',
        operationId: 'listFirmwareCampaignMatchingStations',
        security: [{ bearerAuth: [] }],
        params: zodSchema(campaignParams),
        querystring: zodSchema(fwMatchingStationsQuery),
        response: {
          200: paginatedResponse(fwMatchingStationItem),
          404: errorWith('Campaign not found', [ERROR_CODES.CAMPAIGN_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof campaignParams>;
      const query = request.query as z.infer<typeof fwMatchingStationsQuery>;
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
      // Show all stations matching the filter (online + offline). The campaign
      // start endpoint applies its own isOnline check separately.
      const conditions: ReturnType<typeof eq>[] = [];
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

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [data, countResult] = await Promise.all([
        db
          .select({
            id: chargingStations.id,
            stationId: chargingStations.stationId,
            model: chargingStations.model,
            firmwareVersion: chargingStations.firmwareVersion,
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

  // Start campaign
  app.post(
    '/firmware-campaigns/:id/start',
    {
      onRequest: [authorize('settings.firmware:write')],
      schema: {
        tags: ['Fleet Operations'],
        summary: 'Start a firmware campaign - dispatch UpdateFirmware to targets',
        description:
          'Resolves matching online stations via the campaign target filter, transitions the campaign to active, and dispatches UpdateFirmware to each station. Per-station progress is tracked in firmware_campaign_stations and firmware_updates and updated by the FirmwareStatusNotification projection. Returns 409 if the campaign is not in draft state or no stations match.',
        operationId: 'startFirmwareCampaign',
        security: [{ bearerAuth: [] }],
        params: zodSchema(campaignParams),
        response: {
          200: successResponse,
          404: errorWith('Campaign not found', [ERROR_CODES.CAMPAIGN_NOT_FOUND]),
          409: errorWith('No targets', [ERROR_CODES.NO_TARGETS]),
        },
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
      if (filter?.stationId) conditions.push(eq(chargingStations.id, filter.stationId));

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

      const actor = getAuditActor(request);
      await writeAudit(
        { table: firmwareCampaignAuditLog, idColumn: 'campaign_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'started',
          ...actor,
          notes: `Started against ${String(targets.length)} station(s)`,
        },
        db,
        request.log,
      );

      // Dispatch UpdateFirmware to each station. Pre-insert firmware_updates
      // with campaign_id so the Station -> Firmware History view can resolve
      // the campaign version via JOIN, and so the FirmwareStatusNotification
      // projection can scope the auto-complete check to the right campaign.
      //
      // The command.UpdateFirmware projection writes the same row via
      // INSERT ... ON CONFLICT (station_id, request_id) DO UPDATE (migration
      // 0015 adds the partial unique index), so the pre-insert and projection
      // converge on the same row without duplicating it. campaign_id is set
      // here and never overwritten by the projection.
      //
      // retrieveDateTime is hoisted outside the loop on purpose: every
      // station in the campaign should see the same operator-intended download
      // moment. initiatedAt is per-iteration so the per-station audit trail
      // reflects when the row was actually created.
      const pubsub = getPubSub();
      const retrieveDateTime = new Date();
      for (const target of targets) {
        const requestId = randomInt(1, 2_147_483_647);

        try {
          await db.insert(firmwareUpdates).values({
            stationId: target.id,
            requestId,
            firmwareUrl: campaign.firmwareUrl,
            retrieveDateTime,
            campaignId: id,
            initiatedAt: new Date(),
          });
        } catch (err) {
          // If the pre-insert fails the projection will still create a row,
          // but without campaign_id -- which breaks the version JOIN and
          // SSE auto-complete scoping. Log so we can diagnose; do not abort
          // dispatch since the firmware update itself is still useful.
          request.log.warn(
            { err, stationId: target.id, campaignId: id, requestId },
            'firmware-campaign: pre-insert of firmware_updates failed; campaign linkage will be missing for this station',
          );
        }

        const commandPayload = {
          commandId: randomUUID(),
          stationId: target.stationId,
          action: 'UpdateFirmware',
          payload: {
            requestId,
            firmware: {
              location: campaign.firmwareUrl,
              retrieveDateTime: retrieveDateTime.toISOString(),
            },
          },
        };

        try {
          await pubsub.publish('ocpp_commands', JSON.stringify(commandPayload));
        } catch (err) {
          request.log.warn(
            { err, stationId: target.id, campaignId: id },
            'firmware-campaign: failed to publish ocpp_commands',
          );
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
        tags: ['Fleet Operations'],
        summary: 'Cancel an active firmware campaign',
        description:
          'Marks the campaign as cancelled. Stations with in-flight UpdateFirmware operations continue to completion; the cancellation prevents further dispatches. Already-completed per-station rows remain unchanged.',
        operationId: 'cancelFirmwareCampaign',
        security: [{ bearerAuth: [] }],
        params: zodSchema(campaignParams),
        response: {
          200: successResponse,
          404: errorWith('Campaign not found', [ERROR_CODES.CAMPAIGN_NOT_FOUND]),
        },
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

      const actor = getAuditActor(request);
      await writeAudit(
        { table: firmwareCampaignAuditLog, idColumn: 'campaign_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'cancelled',
          ...actor,
        },
        db,
        request.log,
      );

      return { success: true };
    },
  );
}
