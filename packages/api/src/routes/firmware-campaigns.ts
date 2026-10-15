// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  publishOcppCommand,
  buildCampaignUpdateFirmware,
  FIRMWARE_RETRIES_MAX,
  FIRMWARE_RETRY_INTERVAL_MAX_SECONDS,
} from '@evtivity/lib';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, count, isNotNull, asc, inArray, type SQL } from 'drizzle-orm';
import {
  db,
  client,
  applyFirmwareCampaignStationStatus,
  rejectFirmwareUpdate,
  dropQueuedCampaignFirmwareUpdates,
  newFirmwareRequestId,
  firmwareCampaigns,
  firmwareCampaignStations,
  firmwareCampaignStatusEnum,
  firmwareUpdates,
  chargingStations,
  sites,
  vendors,
  writeAudit,
  firmwareCampaignAuditLog,
  isOperatorStation,
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
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { getUserSiteIds } from '../lib/site-access.js';
import {
  findScopedFirmwareCampaign,
  firmwareCampaignInScopeSql,
  targetFilterNotFound,
  targetFilterOutOfScope,
  isRestrictedCompanyWideWrite,
} from '../lib/fleet-operation-scope.js';

const CAMPAIGN_NOT_FOUND = { error: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' };
import { authorize } from '../middleware/rbac.js';
import {
  assertFirmwareSignature,
  firmwareSignatureField,
  firmwareSigningCertificateField,
} from '../lib/firmware-signature.js';

const campaignItem = z
  .object({
    id: z.string().describe('Campaign ID'),
    name: z.string().describe('Campaign name'),
    firmwareUrl: z.string().describe('Firmware download URL'),
    version: z.string().nullable().describe('Firmware version'),
    signingCertificate: z
      .string()
      .nullable()
      .describe('PEM Firmware Signing certificate sent with UpdateFirmware, null when unsigned'),
    signature: z
      .string()
      .nullable()
      .describe('Base64 firmware signature sent with UpdateFirmware, null when unsigned'),
    retries: z
      .number()
      .int()
      .nullable()
      .describe('Download retries sent with UpdateFirmware, null leaves it to the station'),
    retryInterval: z
      .number()
      .int()
      .nullable()
      .describe('Seconds between download retries, null leaves it to the station'),
    installDateTime: z
      .string()
      .nullable()
      .describe(
        'Install time sent as firmware.installDateTime, null installs when the station can',
      ),
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

const retriesField = z
  .number()
  .int()
  .min(0)
  .max(FIRMWARE_RETRIES_MAX)
  .describe(`Download retries (0 to ${String(FIRMWARE_RETRIES_MAX)}, 0 means none)`);
const retryIntervalField = z
  .number()
  .int()
  .min(1)
  .max(FIRMWARE_RETRY_INTERVAL_MAX_SECONDS)
  .describe(
    `Seconds between download retries (1 to ${String(FIRMWARE_RETRY_INTERVAL_MAX_SECONDS)})`,
  );
const installDateTimeField = z
  .string()
  .datetime({ offset: true })
  .describe('Install time (ISO 8601); the station downloads first and installs at this time');

const createCampaignBody = z.object({
  name: z.string().min(1).describe('Campaign name'),
  firmwareUrl: z.string().url().describe('Firmware download URL'),
  version: z.string().optional().describe('Firmware version'),
  retries: retriesField.optional(),
  retryInterval: retryIntervalField.optional(),
  installDateTime: installDateTimeField.optional(),
  signingCertificate: firmwareSigningCertificateField.optional(),
  signature: firmwareSignatureField.optional(),
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
  retries: retriesField.nullable().optional(),
  retryInterval: retryIntervalField.nullable().optional(),
  installDateTime: installDateTimeField.nullable().optional(),
  signingCertificate: firmwareSigningCertificateField
    .nullable()
    .optional()
    .describe('PEM Firmware Signing certificate; null clears it (with signature)'),
  signature: firmwareSignatureField
    .nullable()
    .optional()
    .describe('Base64 firmware signature; null clears it (with signingCertificate)'),
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

type CampaignTargetFilter = z.infer<typeof createCampaignBody>['targetFilter'];

/**
 * The station conditions of a campaign target filter. The matching stations
 * preview and the start use the same conditions, so the preview shows what a
 * start targets (the start adds the online check).
 */
function targetFilterConditions(filter: CampaignTargetFilter | null): SQL[] {
  // Conformance test stations are never a campaign target.
  const conditions: SQL[] = [isOperatorStation()];
  if (filter?.siteId) conditions.push(eq(chargingStations.siteId, filter.siteId));
  if (filter?.vendorId) conditions.push(eq(chargingStations.vendorId, filter.vendorId));
  if (filter?.model) conditions.push(eq(chargingStations.model, filter.model));
  if (filter?.stationId) conditions.push(eq(chargingStations.id, filter.stationId));
  if (filter?.firmwareVersion) {
    conditions.push(eq(chargingStations.firmwareVersion, filter.firmwareVersion));
  }
  return conditions;
}

function emptyToNull(value: string | null | undefined): string | null {
  return value == null || value.trim() === '' ? null : value.trim();
}

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
          .where(
            accessibleSiteIds != null
              ? and(
                  isNotNull(chargingStations.model),
                  isOperatorStation(),
                  inArray(chargingStations.siteId, accessibleSiteIds),
                )
              : and(isNotNull(chargingStations.model), isOperatorStation()),
          )
          .orderBy(asc(chargingStations.model)),
      ]);

      const stationConds = [isOperatorStation()];
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
              .where(and(...stationConds))
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

      // A restricted user sees only the campaigns that cover its sites alone.
      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      const scope =
        accessibleSiteIds != null
          ? firmwareCampaignInScopeSql(accessibleSiteIds, userId)
          : undefined;

      const [data, countResult] = await Promise.all([
        db
          .select()
          .from(firmwareCampaigns)
          .where(scope)
          .orderBy(desc(firmwareCampaigns.createdAt), desc(firmwareCampaigns.id))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(firmwareCampaigns).where(scope),
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

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      const campaign = await findScopedFirmwareCampaign(id, accessibleSiteIds, userId);
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
          .orderBy(asc(chargingStations.stationId), asc(firmwareCampaignStations.id))
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
        response: {
          201: itemResponse(campaignItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Target not found', [
            ERROR_CODES.SITE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
            ERROR_CODES.CAMPAIGN_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createCampaignBody>;
      const userId = (request.user as { userId: string }).userId;
      assertFirmwareSignature(body.signingCertificate, body.signature);
      const createSiteIds = await getUserSiteIds(userId);
      // A campaign without a site or station targets every site: creating
      // one needs access to every site (owner decision 2026-10-09).
      if (isRestrictedCompanyWideWrite(createSiteIds, body.targetFilter)) {
        await reply.status(404).send(CAMPAIGN_NOT_FOUND);
        return;
      }
      const outOfScope = await targetFilterOutOfScope(body.targetFilter, createSiteIds);
      if (outOfScope != null) {
        await reply.status(404).send(targetFilterNotFound(outOfScope));
        return;
      }

      const [campaign] = await db
        .insert(firmwareCampaigns)
        .values({
          name: body.name,
          firmwareUrl: body.firmwareUrl,
          version: body.version ?? null,
          retries: body.retries ?? null,
          retryInterval: body.retryInterval ?? null,
          installDateTime: body.installDateTime != null ? new Date(body.installDateTime) : null,
          signingCertificate: emptyToNull(body.signingCertificate),
          signature: emptyToNull(body.signature),
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
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Campaign, site or station not found', [
            ERROR_CODES.CAMPAIGN_NOT_FOUND,
            ERROR_CODES.SITE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof campaignParams>;
      const { signingCertificate, signature, installDateTime, ...fields } = request.body as z.infer<
        typeof updateCampaignBody
      >;

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      const campaign = await findScopedFirmwareCampaign(id, accessibleSiteIds, userId);
      // Editing a campaign that targets every site, or widening one to every
      // site, needs access to every site: otherwise a restricted user could
      // turn another operator's draft into an all-site rollout.
      if (
        campaign == null ||
        isRestrictedCompanyWideWrite(accessibleSiteIds, campaign.targetFilter) ||
        (fields.targetFilter !== undefined &&
          isRestrictedCompanyWideWrite(accessibleSiteIds, fields.targetFilter))
      ) {
        await reply.status(404).send({ error: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' });
        return;
      }
      if (campaign.status !== 'draft') {
        await reply
          .status(409)
          .send({ error: 'Only draft campaigns can be updated', code: 'NOT_DRAFT' });
        return;
      }
      const outOfScope = await targetFilterOutOfScope(fields.targetFilter, accessibleSiteIds);
      if (outOfScope != null) {
        await reply.status(404).send(targetFilterNotFound(outOfScope));
        return;
      }

      // The signing fields are checked as the campaign will hold them.
      const nextSigningCertificate =
        signingCertificate !== undefined
          ? emptyToNull(signingCertificate)
          : campaign.signingCertificate;
      const nextSignature = signature !== undefined ? emptyToNull(signature) : campaign.signature;
      assertFirmwareSignature(nextSigningCertificate, nextSignature);

      const [updated] = await db
        .update(firmwareCampaigns)
        .set({
          ...fields,
          ...(installDateTime !== undefined
            ? { installDateTime: installDateTime != null ? new Date(installDateTime) : null }
            : {}),
          signingCertificate: nextSigningCertificate,
          signature: nextSignature,
          updatedAt: new Date(),
        })
        // Draft re-checked in the write: a Start that committed after the read
        // above must not get its URL, filter or schedule rewritten while its
        // updates are out (offline stations would get a different firmware).
        .where(and(eq(firmwareCampaigns.id, id), eq(firmwareCampaigns.status, 'draft')))
        .returning();
      if (updated == null) {
        await reply
          .status(409)
          .send({ error: 'Only draft campaigns can be updated', code: 'NOT_DRAFT' });
        return;
      }

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

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      const campaign = await findScopedFirmwareCampaign(id, accessibleSiteIds, userId);
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

      const deleted = await db
        .delete(firmwareCampaigns)
        .where(and(eq(firmwareCampaigns.id, id), eq(firmwareCampaigns.status, 'draft')))
        .returning({ id: firmwareCampaigns.id });
      if (deleted.length === 0) {
        await reply
          .status(409)
          .send({ error: 'Only draft campaigns can be deleted', code: 'NOT_DRAFT' });
        return;
      }

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

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      const campaign = await findScopedFirmwareCampaign(id, accessibleSiteIds, userId);
      if (campaign == null) {
        await reply.status(404).send({ error: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' });
        return;
      }

      // Show all stations matching the filter (online + offline), as the start
      // targets them: online ones get the update at once, offline ones when
      // they connect.
      const conditions = targetFilterConditions(campaign.targetFilter as CampaignTargetFilter);
      if (query.status === 'online') conditions.push(eq(chargingStations.isOnline, true));
      if (query.status === 'offline') conditions.push(eq(chargingStations.isOnline, false));

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
          'Resolves the stations matching the campaign target filter, transitions the campaign to active, and dispatches UpdateFirmware (with the campaign retries, retry interval and install time) to each online station. An offline station gets the update when it next connects. Per-station progress is tracked in firmware_campaign_stations and firmware_updates and updated by the FirmwareStatusNotification projection. Returns 409 if the campaign is not in draft state or no stations match.',
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

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      const campaign = await findScopedFirmwareCampaign(id, accessibleSiteIds, userId);
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

      // Resolve target stations from filter. Online stations get the update
      // now, offline ones when they connect (station.Ready projection).
      const conditions = targetFilterConditions(campaign.targetFilter as CampaignTargetFilter);

      if (accessibleSiteIds != null && accessibleSiteIds.length === 0) {
        await reply.status(409).send({ error: 'No matching stations found', code: 'NO_TARGETS' });
        return;
      }
      if (accessibleSiteIds != null)
        conditions.push(inArray(chargingStations.siteId, accessibleSiteIds));

      const targets = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          isOnline: chargingStations.isOnline,
        })
        .from(chargingStations)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      if (targets.length === 0) {
        await reply.status(409).send({ error: 'No matching stations found', code: 'NO_TARGETS' });
        return;
      }

      // Atomic transition draft -> active. Two operators clicking Start at
      // the same moment both pass the SELECT-then-check pre-guard; without
      // this CAS both would dispatch UpdateFirmware twice. CAS makes the
      // second caller's UPDATE return zero rows; we surface that as the same
      // 409 NOT_DRAFT the pre-check would have raised.
      //
      // The campaign station rows are inserted in the same transaction, after
      // the CAS, so only the winning operator's targets are recorded and a
      // failed insert leaves the campaign a draft instead of an active
      // campaign without stations, which would never complete.
      // dispatchedAt marks the stations sent now; an offline station's row
      // waits for its connect-time dispatch, which claims it once.
      const now = new Date();
      const claimed = await db.transaction(async (tx) => {
        const won = await tx
          .update(firmwareCampaigns)
          .set({ status: 'active', updatedAt: now })
          .where(and(eq(firmwareCampaigns.id, id), eq(firmwareCampaigns.status, 'draft')))
          .returning({ id: firmwareCampaigns.id });
        if (won.length === 0) return false;
        await tx.insert(firmwareCampaignStations).values(
          targets.map((t) => ({
            campaignId: id,
            stationId: t.id,
            dispatchedAt: t.isOnline ? now : null,
          })),
        );
        return true;
      });
      if (!claimed) {
        await reply
          .status(409)
          .send({ error: 'Campaign is not in draft state', code: 'NOT_DRAFT' });
        return;
      }
      const online = targets.filter((t) => t.isOnline);

      const actor = getAuditActor(request);
      await writeAudit(
        { table: firmwareCampaignAuditLog, idColumn: 'campaign_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'started',
          ...actor,
          notes: `Started against ${String(targets.length)} station(s), ${String(online.length)} online`,
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
      // moment. initiatedAt is shared too so the audit timestamps are
      // consistent across the batch.
      //
      // The pre-insert is batched into one round-trip and the pub/sub
      // publishes run with Promise.allSettled so a 100-station campaign no
      // longer pays 200 sequential awaits in the request path.
      const pubsub = getPubSub();
      const retrieveDateTime = new Date();
      const initiatedAt = new Date();
      const dispatches = online.map((target) => ({
        target,
        requestId: newFirmwareRequestId(),
      }));

      try {
        if (dispatches.length > 0)
          await db.insert(firmwareUpdates).values(
            dispatches.map(({ target, requestId }) => ({
              stationId: target.id,
              requestId,
              firmwareUrl: campaign.firmwareUrl,
              retrieveDateTime,
              campaignId: id,
              initiatedAt,
            })),
          );
      } catch (err) {
        // If the batch pre-insert fails the projection will still create rows
        // when status notifications arrive, but without campaign_id -- which
        // breaks the version JOIN and SSE auto-complete scoping. Log and
        // continue: the firmware update itself is still useful.
        request.log.warn(
          { err, campaignId: id, stationCount: dispatches.length },
          'firmware-campaign: batch pre-insert of firmware_updates failed; campaign linkage will be missing for this campaign',
        );
      }

      const publishResults = await Promise.allSettled(
        dispatches.map(({ target, requestId }) =>
          publishOcppCommand(pubsub, {
            stationId: target.stationId,
            action: 'UpdateFirmware',
            // The OCPP server sends a signed update to a 1.6 station as
            // SignedUpdateFirmware.
            payload: buildCampaignUpdateFirmware(campaign, requestId, retrieveDateTime),
          }),
        ),
      );
      // A command that was never published never reaches the station, so no
      // status report follows: fail its station now (P4), so the campaign still
      // completes when every other station finishes.
      for (const [idx, result] of publishResults.entries()) {
        if (result.status !== 'rejected') continue;
        const dispatch = dispatches[idx];
        if (dispatch == null) continue;
        request.log.warn(
          { err: result.reason, stationId: dispatch.target.id, campaignId: id },
          'firmware-campaign: failed to publish ocpp_commands',
        );
        try {
          const audit = { actor: 'system' as const, actorLabel: 'Firmware campaign dispatch' };
          const rejected = await rejectFirmwareUpdate(client, {
            stationUuid: dispatch.target.id,
            requestId: dispatch.requestId,
            reasonCode: 'CommandFailed',
            additionalInfo: 'The command could not be published',
            ...audit,
          });
          if (rejected == null) {
            await applyFirmwareCampaignStationStatus(client, {
              campaignId: id,
              stationUuid: dispatch.target.id,
              status: 'failed',
              errorInfo: 'CommandFailed',
              ...audit,
            });
          }
        } catch (err) {
          request.log.warn(
            { err, stationId: dispatch.target.id, campaignId: id },
            'firmware-campaign: failed to record the undelivered command',
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
          409: errorWith('Campaign is not active', [ERROR_CODES.CAMPAIGN_NOT_ACTIVE]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof campaignParams>;

      const { userId } = request.user as { userId: string };
      const accessibleSiteIds = await getUserSiteIds(userId);
      const campaign = await findScopedFirmwareCampaign(id, accessibleSiteIds, userId);
      if (campaign == null) {
        await reply.status(404).send(CAMPAIGN_NOT_FOUND);
        return;
      }

      // Only an active campaign is cancelled: a completed or cancelled one is
      // terminal, and a draft is deleted instead. The status guard in the
      // UPDATE also loses cleanly to a concurrent completion.
      const cancelled = await db
        .update(firmwareCampaigns)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(and(eq(firmwareCampaigns.id, id), eq(firmwareCampaigns.status, 'active')))
        .returning({ id: firmwareCampaigns.id });
      if (cancelled.length === 0) {
        await reply
          .status(409)
          .send({ error: 'Only active campaigns can be cancelled', code: 'CAMPAIGN_NOT_ACTIVE' });
        return;
      }

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

      // Updates still queued for offline stations never reached them: drop them
      // so a station does not install the firmware after the cancel.
      try {
        const dropped = await dropQueuedCampaignFirmwareUpdates(client, id);
        if (dropped > 0) request.log.info({ campaignId: id, dropped }, 'Queued updates dropped');
      } catch (err) {
        // fail-open: the campaign is cancelled; a queued update still expires
        // with the offline queue.
        request.log.warn({ err, campaignId: id }, 'Dropping queued campaign updates failed');
      }

      return { success: true };
    },
  );
}
