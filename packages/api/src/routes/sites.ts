// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, or, ilike, sql, gte, and, desc, count, inArray, isNotNull } from 'drizzle-orm';
import { db } from '@evtivity/database';
import {
  sites,
  chargingStations,
  chargingSessions,
  drivers,
  meterValues,
  stationLayoutPositions,
  evses,
  connectors,
  siteLoadManagement,
  displayMessages,
  pricingGroupSites,
  pricingGroups,
  configTemplates,
  carbonIntensityFactors,
} from '@evtivity/database';
import { isValidTimezone } from '@evtivity/lib';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import {
  errorResponse,
  successResponse,
  paginatedResponse,
  itemResponse,
  arrayResponse,
} from '../lib/response-schemas.js';
import {
  exportSitesCsv,
  exportSitesTemplateCsv,
  importSitesCsv,
} from '../services/site-import.service.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { pushTemplateToSiteStations } from '../lib/config-push.js';
import type { JwtPayload } from '../plugins/auth.js';
import { authorize } from '../middleware/rbac.js';

const importSiteRow = z.object({
  siteName: z.string().min(1),
  stationId: z.string().optional(),
  stationModel: z.string().optional(),
  stationSerialNumber: z.string().optional(),
  evseId: z.number().optional(),
  connectorId: z.number().optional(),
  connectorType: z.string().optional(),
  maxPowerKw: z.number().optional(),
  stationVendor: z.string().optional(),
});

const importSiteBody = z.object({
  rows: z.array(importSiteRow),
  updateExisting: z
    .boolean()
    .describe('When true, updates existing sites/stations matched by name/stationId'),
});

const siteParams = z.object({
  id: ID_PARAMS.siteId.describe('Site ID'),
});

const sitePricingGroupItem = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    isDefault: z.boolean(),
    tariffCount: z.number(),
  })
  .passthrough();

const sitePricingGroupRecordItem = z
  .object({ siteId: z.string(), pricingGroupId: z.string() })
  .passthrough();

const addSitePricingGroupBody = z.object({
  pricingGroupId: ID_PARAMS.pricingGroupId.describe('Pricing group ID to assign to the site'),
});

const sitePricingGroupParams = z.object({
  id: ID_PARAMS.siteId.describe('Site ID'),
  pricingGroupId: ID_PARAMS.pricingGroupId.describe('Pricing group ID'),
});

const createSiteBody = z.object({
  name: z.string().min(1).max(255),
  address: z.string().max(500).optional(),
  city: z.string().max(255).optional(),
  state: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  country: z.string().max(100).optional(),
  latitude: z.string().max(20).optional(),
  longitude: z.string().max(20).optional(),
  timezone: z
    .string()
    .max(100)
    .refine(isValidTimezone, { message: 'Invalid IANA timezone' })
    .optional(),
  contactName: z.string().max(255).optional(),
  contactEmail: z.string().email().max(255).optional(),
  contactPhone: z.string().max(50).optional(),
  contactIsPublic: z.boolean().optional(),
  hoursOfOperation: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateSiteBody = z.object({
  name: z.string().min(1).max(255).optional(),
  address: z.string().max(500).optional(),
  city: z.string().max(255).optional(),
  state: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  country: z.string().max(100).optional(),
  latitude: z.string().max(20).optional(),
  longitude: z.string().max(20).optional(),
  timezone: z
    .string()
    .max(100)
    .refine(isValidTimezone, { message: 'Invalid IANA timezone' })
    .optional(),
  contactName: z.string().max(255).optional(),
  contactEmail: z.string().email().max(255).optional(),
  contactPhone: z.string().max(50).optional(),
  contactIsPublic: z.boolean().optional(),
  hoursOfOperation: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
  reservationsEnabled: z
    .boolean()
    .optional()
    .describe('Whether reservations are allowed at this site'),
});

const siteSelect = {
  id: sites.id,
  name: sites.name,
  address: sites.address,
  city: sites.city,
  state: sites.state,
  postalCode: sites.postalCode,
  country: sites.country,
  latitude: sites.latitude,
  longitude: sites.longitude,
  timezone: sites.timezone,
  contactName: sites.contactName,
  contactEmail: sites.contactEmail,
  contactPhone: sites.contactPhone,
  contactIsPublic: sites.contactIsPublic,
  hoursOfOperation: sites.hoursOfOperation,
  metadata: sites.metadata,
  createdAt: sites.createdAt,
  updatedAt: sites.updatedAt,
  stationCount: sql<number>`count(${chargingStations.id})::int`,
  loadManagementEnabled: sql<boolean>`coalesce(${siteLoadManagement.isEnabled}, false)`,
  reservationsEnabled: sites.reservationsEnabled,
  freeVendEnabled: sites.freeVendEnabled,
  freeVendTemplateId21: sites.freeVendTemplateId21,
  freeVendTemplateId16: sites.freeVendTemplateId16,
  maxPowerKw: sql<number | null>`null::numeric`,
  totalDrawKw: sql<number>`coalesce((
    SELECT sum(latest.kw)
    FROM (
      SELECT DISTINCT ON (mv.station_id)
        CASE WHEN mv.unit = 'kW' THEN mv.value::numeric ELSE mv.value::numeric / 1000 END AS kw
      FROM meter_values mv
      INNER JOIN charging_stations cs ON cs.id = mv.station_id
      WHERE cs.site_id = ${sites.id}
        AND mv.measurand = 'Power.Active.Import'
        AND mv.timestamp >= now() - interval '60 seconds'
      ORDER BY mv.station_id, mv.timestamp DESC
    ) latest
  ), 0)`,
};

const siteItem = z
  .object({
    id: z.string(),
    name: z.string(),
    address: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    postalCode: z.string().nullable(),
    country: z.string().nullable(),
    latitude: z.string().nullable(),
    longitude: z.string().nullable(),
    timezone: z.string().nullable(),
    contactName: z.string().nullable(),
    contactEmail: z.string().nullable(),
    contactPhone: z.string().nullable(),
    contactIsPublic: z.boolean(),
    hoursOfOperation: z.string().nullable(),
    metadata: z.record(z.unknown()).nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    stationCount: z.number(),
    loadManagementEnabled: z.boolean(),
    maxPowerKw: z.number().nullable(),
    totalDrawKw: z.number(),
  })
  .passthrough();

const siteBase = z
  .object({
    id: z.string(),
    name: z.string(),
    address: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    postalCode: z.string().nullable(),
    country: z.string().nullable(),
    latitude: z.string().nullable(),
    longitude: z.string().nullable(),
    timezone: z.string().nullable(),
    hoursOfOperation: z.string().nullable(),
    metadata: z.record(z.unknown()).nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .passthrough();

const importResultResponse = z
  .object({
    sitesCreated: z.number(),
    sitesUpdated: z.number(),
    stationsCreated: z.number(),
    stationsUpdated: z.number(),
    evsesCreated: z.number(),
    evsesUpdated: z.number(),
    connectorsCreated: z.number(),
    connectorsUpdated: z.number(),
    errors: z.array(z.string()),
  })
  .passthrough();

const siteMetricsResponse = z
  .object({
    uptimePercent: z.number(),
    portCount: z.number(),
    utilizationPercent: z.number(),
    totalSessions: z.number(),
    completedSessions: z.number(),
    faultedSessions: z.number(),
    sessionSuccessPercent: z.number(),
    totalEnergyWh: z.number(),
    avgSessionDurationMinutes: z.number(),
    disconnectCount: z.number(),
    avgDowntimeMinutes: z.number(),
    maxDowntimeMinutes: z.number(),
    totalRevenueCents: z.number(),
    avgRevenueCentsPerSession: z.number(),
    totalTransactions: z.number(),
    periodMonths: z.number(),
  })
  .passthrough();

const siteStationItem = z
  .object({
    id: z.string(),
    stationId: z.string(),
    siteId: z.string().nullable(),
    model: z.string().nullable(),
    serialNumber: z.string().nullable(),
    availability: z.string(),
    securityProfile: z.number(),
    lastHeartbeat: z.coerce.date().nullable(),
    isOnline: z.boolean(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    status: z.string(),
    connectorCount: z.number(),
    connectorTypes: z.array(z.string()).nullable(),
  })
  .passthrough();

const energyHistoryItem = z.object({ date: z.string(), energyWh: z.number() }).passthrough();

const revenueHistoryItem = z
  .object({ date: z.string(), revenueCents: z.number(), sessionCount: z.number() })
  .passthrough();

const meterValueGroup = z
  .object({
    measurand: z.string(),
    unit: z.string().nullable(),
    values: z.array(z.object({ timestamp: z.coerce.date(), value: z.string() }).passthrough()),
  })
  .passthrough();

const siteSessionItem = z
  .object({
    id: z.string(),
    stationId: z.string(),
    stationName: z.string().nullable(),
    siteName: z.string().nullable(),
    driverId: z.string().nullable(),
    driverName: z.string().nullable(),
    transactionId: z.string().nullable(),
    status: z.string(),
    energyDeliveredWh: z.coerce.number().nullable(),
    currentCostCents: z.number().nullable(),
    finalCostCents: z.number().nullable(),
    currency: z.string().nullable(),
    startedAt: z.coerce.date(),
    endedAt: z.coerce.date().nullable(),
    freeVend: z.boolean(),
  })
  .passthrough();

const layoutConnector = z
  .object({
    connectorId: z.number(),
    connectorType: z.string().nullable(),
    maxPowerKw: z.number().nullable(),
    status: z.string(),
    isPluggedIn: z.boolean(),
    energyDeliveredWh: z.number().nullable(),
  })
  .passthrough();

const layoutEvse = z
  .object({
    evseId: z.number(),
    connectors: z.array(layoutConnector),
  })
  .passthrough();

const layoutStation = z
  .object({
    id: z.string(),
    stationId: z.string(),
    model: z.string().nullable(),
    status: z.string().nullable(),
    isOnline: z.boolean(),
    securityProfile: z.number(),
    positionX: z.number(),
    positionY: z.number(),
    displayMessage: z.string().nullable(),
    evses: z.array(layoutEvse),
  })
  .passthrough();

const sitesListQuery = paginationQuery.extend({
  city: z.string().optional().describe('Filter by city'),
  state: z.string().optional().describe('Filter by state'),
  loadManagement: z.enum(['true', 'false']).optional().describe('Filter by load management status'),
});

const locationOption = z.object({ city: z.string(), state: z.string() }).passthrough();
const filterOptionsResponse = z.object({ locations: z.array(locationOption) }).passthrough();

export function siteRoutes(app: FastifyInstance): void {
  app.get(
    '/sites',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'List all sites',
        operationId: 'listSites',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(sitesListQuery),
        response: { 200: paginatedResponse(siteItem) },
      },
    },
    async (request) => {
      const { page, limit, search, city, state, loadManagement } = request.query as z.infer<
        typeof sitesListQuery
      >;
      const offset = (page - 1) * limit;

      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) {
        return { data: [], total: 0 } satisfies PaginatedResponse<never>;
      }

      const conditions = [];

      if (siteIds != null) {
        conditions.push(inArray(sites.id, siteIds));
      }

      if (search) {
        const pattern = `%${search}%`;
        conditions.push(
          or(
            ilike(sites.id, pattern),
            ilike(sites.name, pattern),
            ilike(sites.city, pattern),
            ilike(sites.state, pattern),
          ),
        );
      }
      if (city) {
        conditions.push(ilike(sites.city, city));
      }
      if (state) {
        conditions.push(ilike(sites.state, state));
      }
      if (loadManagement != null) {
        conditions.push(
          loadManagement === 'true'
            ? sql`coalesce(${siteLoadManagement.isEnabled}, false) = true`
            : sql`coalesce(${siteLoadManagement.isEnabled}, false) = false`,
        );
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [data, countRows] = await Promise.all([
        db
          .select(siteSelect)
          .from(sites)
          .leftJoin(chargingStations, eq(chargingStations.siteId, sites.id))
          .leftJoin(siteLoadManagement, eq(siteLoadManagement.siteId, sites.id))
          .where(where)
          .groupBy(sites.id, siteLoadManagement.isEnabled)
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(sites)
          .leftJoin(siteLoadManagement, eq(siteLoadManagement.siteId, sites.id))
          .where(where),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  app.get(
    '/sites/filter-options',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Get distinct filter values for sites',
        operationId: 'getSiteFilterOptions',
        security: [{ bearerAuth: [] }],
        response: { 200: zodSchema(filterOptionsResponse) },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);

      const conditions = [isNotNull(sites.city), isNotNull(sites.state)];
      if (siteIds != null) {
        if (siteIds.length === 0) return { locations: [] };
        conditions.push(inArray(sites.id, siteIds));
      }

      const rows = await db
        .selectDistinct({ city: sites.city, state: sites.state })
        .from(sites)
        .where(and(...conditions))
        .orderBy(sites.city, sites.state);

      return {
        locations: rows.map((r) => ({ city: r.city as string, state: r.state as string })),
      };
    },
  );

  app.get(
    '/sites/export',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Export sites as CSV',
        operationId: 'exportSites',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(paginationQuery),
      },
    },
    async (request, reply) => {
      const { search } = request.query as z.infer<typeof paginationQuery>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      const csv = await exportSitesCsv(search, siteIds ?? undefined);
      await reply
        .header('Content-Type', 'text/csv')
        .header('Content-Disposition', 'attachment; filename=sites.csv')
        .send(csv);
    },
  );

  app.get(
    '/sites/export/template',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Download site import CSV template',
        operationId: 'exportSiteTemplate',
        security: [{ bearerAuth: [] }],
      },
    },
    async (_request, reply) => {
      const csv = exportSitesTemplateCsv();
      await reply
        .header('Content-Type', 'text/csv')
        .header('Content-Disposition', 'attachment; filename=sites-template.csv')
        .send(csv);
    },
  );

  app.post(
    '/sites/import',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Import sites from parsed CSV rows',
        operationId: 'importSites',
        security: [{ bearerAuth: [] }],
        body: zodSchema(importSiteBody),
        response: { 200: zodSchema(importResultResponse) },
      },
    },
    async (request) => {
      const { rows, updateExisting } = request.body as z.infer<typeof importSiteBody>;
      return importSitesCsv(rows, updateExisting);
    },
  );

  app.get(
    '/sites/:id',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Get a site by ID',
        operationId: 'getSite',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        response: { 200: itemResponse(siteItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const [row] = await db
        .select(siteSelect)
        .from(sites)
        .leftJoin(chargingStations, eq(chargingStations.siteId, sites.id))
        .leftJoin(siteLoadManagement, eq(siteLoadManagement.siteId, sites.id))
        .where(eq(sites.id, id))
        .groupBy(sites.id, siteLoadManagement.isEnabled);
      if (row == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      return row;
    },
  );

  app.post(
    '/sites',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Create a new site',
        operationId: 'createSite',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createSiteBody),
        response: { 201: itemResponse(siteBase) },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createSiteBody>;
      const [site] = await db.insert(sites).values(body).returning();
      await reply.status(201).send(site);
    },
  );

  app.patch(
    '/sites/:id',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Update a site',
        operationId: 'updateSite',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        body: zodSchema(updateSiteBody),
        response: { 200: itemResponse(siteBase), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const body = request.body as z.infer<typeof updateSiteBody>;
      const [site] = await db
        .update(sites)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(sites.id, id))
        .returning();
      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      return site;
    },
  );

  app.delete(
    '/sites/:id',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Delete a site',
        operationId: 'deleteSite',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        response: { 200: itemResponse(siteBase), 404: errorResponse, 409: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const stationRows = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.siteId, id))
        .limit(1);

      if (stationRows.length > 0) {
        await reply.status(409).send({
          error: 'Cannot delete site with stations. Remove or reassign stations first.',
          code: 'SITE_HAS_STATIONS',
        });
        return;
      }

      const [site] = await db.delete(sites).where(eq(sites.id, id)).returning();
      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      return site;
    },
  );

  const siteMetricsQuery = z.object({
    months: z.coerce
      .number()
      .int()
      .min(1)
      .max(24)
      .default(12)
      .describe('Number of months to look back for metrics'),
  });

  app.get(
    '/sites/:id/metrics',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Get performance metrics for a site',
        operationId: 'getSiteMetrics',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        querystring: zodSchema(siteMetricsQuery),
        response: { 200: zodSchema(siteMetricsResponse), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const { months } = request.query as z.infer<typeof siteMetricsQuery>;
      const since = new Date();
      since.setMonth(since.getMonth() - months);

      const periodMinutes = Math.floor((Date.now() - since.getTime()) / 60000);
      const periodMinutesLiteral = sql.raw(String(periodMinutes));
      const sinceIso = since.toISOString();

      const uptimeRows = await db.execute(sql`
        WITH site_stations AS (
          SELECT id AS station_uuid FROM charging_stations WHERE site_id = ${id}
        ),
        site_ports AS (
          SELECT DISTINCT e.station_id, e.evse_id
          FROM evses e
          INNER JOIN site_stations ss ON ss.station_uuid = e.station_id
        ),
        pre_period_status AS (
          SELECT DISTINCT ON (psl.station_id, psl.evse_id)
            psl.station_id,
            psl.evse_id,
            psl.new_status,
            ${sinceIso}::timestamptz AS timestamp
          FROM port_status_log psl
          INNER JOIN site_ports sp ON sp.station_id = psl.station_id AND sp.evse_id = psl.evse_id
          WHERE psl.timestamp < ${sinceIso}::timestamptz
          ORDER BY psl.station_id, psl.evse_id, psl.timestamp DESC
        ),
        seeded_log AS (
          SELECT station_id, evse_id, new_status, timestamp FROM pre_period_status
          UNION ALL
          SELECT psl.station_id, psl.evse_id, psl.new_status, psl.timestamp
          FROM port_status_log psl
          INNER JOIN site_ports sp ON sp.station_id = psl.station_id AND sp.evse_id = psl.evse_id
          WHERE psl.timestamp >= ${sinceIso}::timestamptz
        ),
        port_transitions AS (
          SELECT
            station_id,
            evse_id,
            new_status,
            timestamp,
            LEAD(timestamp) OVER (PARTITION BY station_id, evse_id ORDER BY timestamp) AS next_timestamp
          FROM seeded_log
        ),
        outage_minutes AS (
          SELECT
            station_id,
            evse_id,
            SUM(
              EXTRACT(EPOCH FROM (COALESCE(next_timestamp, now()) - timestamp)) / 60
            ) AS down_minutes
          FROM port_transitions
          WHERE new_status IN ('faulted', 'unavailable')
          GROUP BY station_id, evse_id
        )
        SELECT
          COALESCE(AVG(
            CASE WHEN ${periodMinutesLiteral} > 0
              THEN GREATEST(0, ((${periodMinutesLiteral} - COALESCE(down_minutes, 0)) / ${periodMinutesLiteral}) * 100)
              ELSE 100
            END
          ), 100) AS uptime_percent,
          COUNT(*) AS port_count
        FROM site_ports sp
        LEFT JOIN outage_minutes om ON om.station_id = sp.station_id AND om.evse_id = sp.evse_id
      `);

      const [sessionStats] = await db
        .select({
          totalSessions: count(),
          completedSessions: sql<number>`count(*) filter (where ${chargingSessions.status} = 'completed')`,
          faultedSessions: sql<number>`count(*) filter (where ${chargingSessions.status} = 'faulted')`,
          totalEnergyWh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric), 0)`,
          avgDurationMinutes: sql<number>`coalesce(avg(extract(epoch from (${chargingSessions.endedAt} - ${chargingSessions.startedAt})) / 60) filter (where ${chargingSessions.endedAt} is not null), 0)`,
        })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .where(and(eq(chargingStations.siteId, id), gte(chargingSessions.startedAt, since)));

      const [utilizationStats] = await db
        .select({
          sessionHours: sql<number>`coalesce(sum(extract(epoch from (coalesce(${chargingSessions.endedAt}, now()) - ${chargingSessions.startedAt})) / 3600), 0)`,
          portCount: sql<number>`(select count(*) from evses e inner join charging_stations cs on cs.id = e.station_id where cs.site_id = ${id})`,
        })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .where(and(eq(chargingStations.siteId, id), gte(chargingSessions.startedAt, since)));

      const totalPortHours = (utilizationStats?.portCount ?? 1) * (periodMinutes / 60);
      const utilization =
        totalPortHours > 0
          ? Math.round(((utilizationStats?.sessionHours ?? 0) / totalPortHours) * 100)
          : 0;

      const [financialStats] = await db
        .select({
          totalRevenueCents: sql<number>`coalesce(sum(coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents})), 0)`,
          avgRevenueCentsPerSession: sql<number>`coalesce(avg(coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents})), 0)`,
          totalTransactions: sql<number>`count(*) filter (where coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents}) is not null)`,
        })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .where(and(eq(chargingStations.siteId, id), gte(chargingSessions.startedAt, since)));

      const total = sessionStats?.totalSessions ?? 0;
      const completed = sessionStats?.completedSessions ?? 0;

      const uptimeRow = uptimeRows[0] as { uptime_percent: string; port_count: string } | undefined;

      const disconnectRows = await db.execute(sql`
        WITH ordered_events AS (
          SELECT
            cl.event,
            cl.created_at,
            LEAD(cl.created_at) OVER (PARTITION BY cl.station_id ORDER BY cl.created_at) AS next_at,
            LEAD(cl.event) OVER (PARTITION BY cl.station_id ORDER BY cl.created_at) AS next_event
          FROM connection_logs cl
          INNER JOIN charging_stations cs ON cs.id = cl.station_id
          WHERE cs.site_id = ${id} AND cl.created_at >= ${sinceIso}::timestamptz
        )
        SELECT
          count(*) AS disconnect_count,
          coalesce(avg(EXTRACT(EPOCH FROM (next_at - created_at)) / 60) FILTER (WHERE next_event = 'connected'), 0) AS avg_downtime_minutes,
          coalesce(max(EXTRACT(EPOCH FROM (next_at - created_at)) / 60) FILTER (WHERE next_event = 'connected'), 0) AS max_downtime_minutes
        FROM ordered_events
        WHERE event = 'disconnected'
      `);

      const disconnectRow = disconnectRows[0] as
        | { disconnect_count: string; avg_downtime_minutes: string; max_downtime_minutes: string }
        | undefined;

      return {
        uptimePercent: Math.round(Number(uptimeRow?.uptime_percent ?? 100) * 100) / 100,
        portCount: Number(uptimeRow?.port_count ?? 0),
        utilizationPercent: utilization,
        totalSessions: total,
        completedSessions: completed,
        faultedSessions: sessionStats?.faultedSessions ?? 0,
        sessionSuccessPercent: total > 0 ? Math.round((completed / total) * 100) : 100,
        totalEnergyWh: sessionStats?.totalEnergyWh ?? 0,
        avgSessionDurationMinutes: Math.round(sessionStats?.avgDurationMinutes ?? 0),
        disconnectCount: Number(disconnectRow?.disconnect_count ?? 0),
        avgDowntimeMinutes: Math.round(Number(disconnectRow?.avg_downtime_minutes ?? 0)),
        maxDowntimeMinutes: Math.round(Number(disconnectRow?.max_downtime_minutes ?? 0)),
        totalRevenueCents: financialStats?.totalRevenueCents ?? 0,
        avgRevenueCentsPerSession: Math.round(financialStats?.avgRevenueCentsPerSession ?? 0),
        totalTransactions: financialStats?.totalTransactions ?? 0,
        periodMonths: months,
      };
    },
  );

  const stationsQuery = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(10),
  });

  app.get(
    '/sites/:id/stations',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'List stations at a site',
        operationId: 'listSiteStations',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        querystring: zodSchema(stationsQuery),
        response: { 200: paginatedResponse(siteStationItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const { page, limit } = request.query as z.infer<typeof stationsQuery>;
      const offset = (page - 1) * limit;

      const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, id));
      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const where = eq(chargingStations.siteId, id);
      const derivedStatus = sql<string>`CASE
        WHEN COUNT(${connectors.id}) FILTER (WHERE ${connectors.status} = 'occupied') > 0 THEN 'charging'
        WHEN COUNT(${connectors.id}) FILTER (WHERE ${connectors.status} = 'reserved') > 0 THEN 'reserved'
        WHEN COUNT(${connectors.id}) FILTER (WHERE ${connectors.status} = 'faulted') > 0 THEN 'faulted'
        WHEN COUNT(${connectors.id}) = 0 THEN 'unknown'
        WHEN COUNT(${connectors.id}) FILTER (WHERE ${connectors.status} = 'available') = COUNT(${connectors.id}) THEN 'available'
        ELSE 'unavailable'
      END`;
      const [data, countRows] = await Promise.all([
        db
          .select({
            id: chargingStations.id,
            stationId: chargingStations.stationId,
            siteId: chargingStations.siteId,
            model: chargingStations.model,
            serialNumber: chargingStations.serialNumber,
            availability: chargingStations.availability,
            securityProfile: chargingStations.securityProfile,
            lastHeartbeat: chargingStations.lastHeartbeat,
            isOnline: chargingStations.isOnline,
            createdAt: chargingStations.createdAt,
            updatedAt: chargingStations.updatedAt,
            status: derivedStatus,
            connectorCount: sql<number>`COUNT(${connectors.id})::int`,
            connectorTypes: sql<
              string[]
            >`array_agg(DISTINCT ${connectors.connectorType}) FILTER (WHERE ${connectors.connectorType} IS NOT NULL)`,
          })
          .from(chargingStations)
          .leftJoin(evses, eq(evses.stationId, chargingStations.id))
          .leftJoin(connectors, eq(connectors.evseId, evses.id))
          .where(where)
          .groupBy(chargingStations.id)
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(chargingStations)
          .where(where),
      ]);

      return { data, total: countRows[0]?.count ?? 0 };
    },
  );

  const energyHistoryQuery = z.object({
    days: z.coerce.number().int().min(1).max(90).default(7).describe('Number of days to look back'),
  });

  app.get(
    '/sites/:id/energy-history',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Get daily energy delivery history for a site',
        operationId: 'getSiteEnergyHistory',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        querystring: zodSchema(energyHistoryQuery),
        response: { 200: arrayResponse(energyHistoryItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const { days } = request.query as z.infer<typeof energyHistoryQuery>;
      const since = new Date();
      since.setDate(since.getDate() - days);

      const [siteRow] = await db
        .select({ timezone: sites.timezone })
        .from(sites)
        .where(eq(sites.id, id));
      const tz = siteRow?.timezone ?? 'America/New_York';

      const rows = await db
        .select({
          date: sql<string>`date_trunc('day', ${chargingSessions.startedAt} AT TIME ZONE ${tz})::date::text`,
          energyWh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric), 0)`,
        })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .where(and(eq(chargingStations.siteId, id), gte(chargingSessions.startedAt, since)))
        .groupBy(sql`1`)
        .orderBy(sql`1`);

      return rows.map((r) => ({ date: r.date, energyWh: r.energyWh }));
    },
  );

  const revenueHistoryQuery = z.object({
    days: z.coerce.number().int().min(1).max(90).default(7).describe('Number of days to look back'),
  });

  app.get(
    '/sites/:id/revenue-history',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Get daily revenue history for a site',
        operationId: 'getSiteRevenueHistory',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        querystring: zodSchema(revenueHistoryQuery),
        response: { 200: arrayResponse(revenueHistoryItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const { days } = request.query as z.infer<typeof revenueHistoryQuery>;
      const since = new Date();
      since.setDate(since.getDate() - days);

      const [siteRow] = await db
        .select({ timezone: sites.timezone })
        .from(sites)
        .where(eq(sites.id, id));
      const tz = siteRow?.timezone ?? 'America/New_York';

      const rows = await db
        .select({
          date: sql<string>`date_trunc('day', ${chargingSessions.startedAt} AT TIME ZONE ${tz})::date::text`,
          revenueCents: sql<number>`coalesce(sum(coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents})), 0)`,
          sessionCount: count(),
        })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .where(
          and(
            eq(chargingStations.siteId, id),
            gte(chargingSessions.startedAt, since),
            sql`coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents}) is not null`,
          ),
        )
        .groupBy(sql`1`)
        .orderBy(sql`1`);

      return rows.map((r) => ({
        date: r.date,
        revenueCents: r.revenueCents,
        sessionCount: r.sessionCount,
      }));
    },
  );

  const popularTimesQuery = z.object({
    weeks: z.coerce
      .number()
      .int()
      .min(1)
      .max(12)
      .default(4)
      .describe('Number of weeks to look back'),
  });

  const popularTimesItem = z
    .object({ dow: z.number(), hour: z.number(), avgSessions: z.number() })
    .passthrough();

  app.get(
    '/sites/:id/popular-times',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Get average session count by day-of-week and hour for a site',
        operationId: 'getSitePopularTimes',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        querystring: zodSchema(popularTimesQuery),
        response: { 200: arrayResponse(popularTimesItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const { weeks } = request.query as z.infer<typeof popularTimesQuery>;
      const since = new Date();
      since.setDate(since.getDate() - weeks * 7);

      const [siteRow] = await db
        .select({ timezone: sites.timezone })
        .from(sites)
        .where(eq(sites.id, id));
      const tz = siteRow?.timezone ?? 'America/New_York';

      const rows = await db
        .select({
          dow: sql<number>`extract(dow from ${chargingSessions.startedAt} at time zone ${tz})::int`,
          hour: sql<number>`extract(hour from ${chargingSessions.startedAt} at time zone ${tz})::int`,
          totalSessions: count(),
        })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
        .where(and(eq(chargingStations.siteId, id), gte(chargingSessions.startedAt, since)))
        .groupBy(sql`1`, sql`2`)
        .orderBy(sql`1`, sql`2`);

      return rows.map((r) => ({
        dow: r.dow,
        hour: r.hour,
        avgSessions: Math.round((r.totalSessions / weeks) * 10) / 10,
      }));
    },
  );

  const meterValuesQuery = z.object({
    hours: z.coerce
      .number()
      .int()
      .min(1)
      .max(168)
      .default(24)
      .describe('Number of hours to look back'),
  });

  app.get(
    '/sites/:id/meter-values',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Get meter value time series for a site',
        operationId: 'getSiteMeterValues',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        querystring: zodSchema(meterValuesQuery),
        response: { 200: arrayResponse(meterValueGroup), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const { hours } = request.query as z.infer<typeof meterValuesQuery>;
      const since = new Date(Date.now() - hours * 3600 * 1000);

      const rows = await db
        .select({
          measurand: meterValues.measurand,
          unit: meterValues.unit,
          timestamp: meterValues.timestamp,
          value: meterValues.value,
        })
        .from(meterValues)
        .innerJoin(chargingStations, eq(meterValues.stationId, chargingStations.id))
        .where(and(eq(chargingStations.siteId, id), gte(meterValues.timestamp, since)))
        .orderBy(meterValues.measurand, meterValues.timestamp);

      const grouped = new Map<
        string,
        { measurand: string; unit: string | null; values: { timestamp: Date; value: string }[] }
      >();

      for (const row of rows) {
        const key = row.measurand ?? 'unknown';
        if (!grouped.has(key)) {
          grouped.set(key, { measurand: key, unit: row.unit, values: [] });
        }
        const group = grouped.get(key);
        if (group != null) {
          group.values.push({ timestamp: row.timestamp, value: row.value });
        }
      }

      return [...grouped.values()];
    },
  );

  const sessionsQuery = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(10),
    status: z
      .enum(['active', 'completed', 'faulted', 'idling'])
      .optional()
      .describe('Filter by session status'),
    stationId: z.string().optional().describe('Filter by station ID'),
  });

  app.get(
    '/sites/:id/sessions',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'List charging sessions at a site',
        operationId: 'listSiteSessions',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        querystring: zodSchema(sessionsQuery),
        response: { 200: paginatedResponse(siteSessionItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const { page, limit, status, stationId } = request.query as z.infer<typeof sessionsQuery>;
      const offset = (page - 1) * limit;
      const conditions = [eq(chargingStations.siteId, id)];
      if (stationId != null) {
        conditions.push(eq(chargingSessions.stationId, stationId));
      }
      if (status != null) {
        if (status === 'idling') {
          conditions.push(eq(chargingSessions.status, 'active'));
          conditions.push(isNotNull(chargingSessions.idleStartedAt));
        } else {
          conditions.push(eq(chargingSessions.status, status));
        }
      }
      const where = and(...conditions);

      const [rows, countRows] = await Promise.all([
        db
          .select({
            id: chargingSessions.id,
            stationId: chargingSessions.stationId,
            stationName: chargingStations.stationId,
            siteName: sites.name,
            driverId: chargingSessions.driverId,
            driverName: sql<
              string | null
            >`CASE WHEN ${drivers.firstName} IS NOT NULL THEN ${drivers.firstName} || ' ' || ${drivers.lastName} ELSE NULL END`,
            transactionId: chargingSessions.transactionId,
            status: chargingSessions.status,
            energyDeliveredWh: chargingSessions.energyDeliveredWh,
            currentCostCents: chargingSessions.currentCostCents,
            finalCostCents: chargingSessions.finalCostCents,
            currency: chargingSessions.currency,
            startedAt: chargingSessions.startedAt,
            endedAt: chargingSessions.endedAt,
            freeVend: chargingSessions.freeVend,
          })
          .from(chargingSessions)
          .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
          .leftJoin(sites, eq(chargingStations.siteId, sites.id))
          .leftJoin(drivers, eq(chargingSessions.driverId, drivers.id))
          .where(where)
          .orderBy(desc(chargingSessions.startedAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(chargingSessions)
          .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
          .where(where),
      ]);

      return { data: rows, total: countRows[0]?.count ?? 0 };
    },
  );

  app.get(
    '/sites/:id/layout',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Get station layout positions for a site',
        operationId: 'getSiteLayout',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        response: { 200: arrayResponse(layoutStation), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, id));
      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const stationRows = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          model: chargingStations.model,
          availability: chargingStations.availability,
          isOnline: chargingStations.isOnline,
          securityProfile: chargingStations.securityProfile,
          positionX: stationLayoutPositions.positionX,
          positionY: stationLayoutPositions.positionY,
        })
        .from(chargingStations)
        .leftJoin(stationLayoutPositions, eq(stationLayoutPositions.stationId, chargingStations.id))
        .where(eq(chargingStations.siteId, id));

      if (stationRows.length === 0) return [];

      const stationUuids = stationRows.map((s) => s.id);

      const [evseRows, connectorRows, sessionRows, displayMessageRows] = await Promise.all([
        db
          .select({
            id: evses.id,
            stationId: evses.stationId,
            evseId: evses.evseId,
          })
          .from(evses)
          .where(inArray(evses.stationId, stationUuids)),
        db
          .select({
            id: connectors.id,
            evseId: connectors.evseId,
            connectorId: connectors.connectorId,
            connectorType: connectors.connectorType,
            maxPowerKw: connectors.maxPowerKw,
            status: connectors.status,
          })
          .from(connectors)
          .innerJoin(evses, eq(connectors.evseId, evses.id))
          .where(inArray(evses.stationId, stationUuids)),
        db
          .select({
            stationId: chargingSessions.stationId,
            connectorId: chargingSessions.connectorId,
            energyDeliveredWh: chargingSessions.energyDeliveredWh,
          })
          .from(chargingSessions)
          .where(
            and(
              inArray(chargingSessions.stationId, stationUuids),
              eq(chargingSessions.status, 'active'),
            ),
          ),
        db
          .select({
            stationId: displayMessages.stationId,
            content: displayMessages.content,
            priority: displayMessages.priority,
          })
          .from(displayMessages)
          .where(
            and(
              inArray(displayMessages.stationId, stationUuids),
              eq(displayMessages.status, 'accepted'),
            ),
          )
          .orderBy(desc(displayMessages.createdAt)),
      ]);

      const evsesByStation = new Map<string, typeof evseRows>();
      for (const evse of evseRows) {
        const list = evsesByStation.get(evse.stationId) ?? [];
        list.push(evse);
        evsesByStation.set(evse.stationId, list);
      }

      const connectorsByEvse = new Map<string, typeof connectorRows>();
      for (const conn of connectorRows) {
        const list = connectorsByEvse.get(conn.evseId) ?? [];
        list.push(conn);
        connectorsByEvse.set(conn.evseId, list);
      }

      const activeSessionsByConnector = new Map<string, { energyDeliveredWh: string | null }>();
      for (const session of sessionRows) {
        if (session.connectorId != null) {
          activeSessionsByConnector.set(session.connectorId, {
            energyDeliveredWh: session.energyDeliveredWh,
          });
        }
      }

      // First accepted message per station (ordered by createdAt desc)
      const displayMessageByStation = new Map<string, string>();
      for (const msg of displayMessageRows) {
        if (!displayMessageByStation.has(msg.stationId)) {
          displayMessageByStation.set(msg.stationId, msg.content);
        }
      }

      return stationRows.map((station) => {
        const stationEvses = evsesByStation.get(station.id) ?? [];
        return {
          id: station.id,
          stationId: station.stationId,
          model: station.model,
          status: station.availability,
          isOnline: station.isOnline,
          securityProfile: station.securityProfile,
          positionX: Number(station.positionX ?? '0'),
          positionY: Number(station.positionY ?? '0'),
          displayMessage: displayMessageByStation.get(station.id) ?? null,
          evses: stationEvses.map((evse) => {
            const evseConnectors = connectorsByEvse.get(evse.id) ?? [];
            return {
              evseId: evse.evseId,
              connectors: evseConnectors.map((conn) => {
                const session = activeSessionsByConnector.get(conn.id);
                return {
                  connectorId: conn.connectorId,
                  connectorType: conn.connectorType,
                  maxPowerKw: conn.maxPowerKw,
                  status: conn.status,
                  isPluggedIn: session != null,
                  energyDeliveredWh:
                    session != null ? Number(session.energyDeliveredWh ?? '0') : null,
                };
              }),
            };
          }),
        };
      });
    },
  );

  const layoutBody = z.object({
    positions: z.array(
      z.object({
        stationId: ID_PARAMS.stationId.describe('Station ID'),
        positionX: z.number(),
        positionY: z.number(),
      }),
    ),
  });

  app.put(
    '/sites/:id/layout',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Update station layout positions for a site',
        operationId: 'updateSiteLayout',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        body: zodSchema(layoutBody),
        response: {
          200: zodSchema(z.object({ ok: z.boolean() }).passthrough()),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const { positions } = request.body as z.infer<typeof layoutBody>;

      const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, id));
      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      for (const pos of positions) {
        await db
          .insert(stationLayoutPositions)
          .values({
            siteId: id,
            stationId: pos.stationId,
            positionX: String(pos.positionX),
            positionY: String(pos.positionY),
          })
          .onConflictDoUpdate({
            target: stationLayoutPositions.stationId,
            set: {
              positionX: String(pos.positionX),
              positionY: String(pos.positionY),
              updatedAt: new Date(),
            },
          });
      }

      return { ok: true };
    },
  );

  // --- Pricing Groups ---

  app.get(
    '/sites/:id/pricing-groups',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Get the pricing group for a site',
        operationId: 'getSitePricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        response: { 200: itemResponse(sitePricingGroupItem.nullable()), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const rows = await db
        .select({
          id: pricingGroups.id,
          name: pricingGroups.name,
          description: pricingGroups.description,
          isDefault: pricingGroups.isDefault,
          tariffCount: sql<number>`(select count(*)::int from tariffs where tariffs.pricing_group_id = ${pricingGroups.id})`,
        })
        .from(pricingGroupSites)
        .innerJoin(pricingGroups, eq(pricingGroupSites.pricingGroupId, pricingGroups.id))
        .where(eq(pricingGroupSites.siteId, id))
        .limit(1);
      return rows[0] ?? null;
    },
  );

  app.post(
    '/sites/:id/pricing-groups',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Assign a pricing group to a site',
        operationId: 'addSitePricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        body: zodSchema(addSitePricingGroupBody),
        response: { 201: itemResponse(sitePricingGroupRecordItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const body = request.body as z.infer<typeof addSitePricingGroupBody>;
      const [record] = await db
        .insert(pricingGroupSites)
        .values({ siteId: id, pricingGroupId: body.pricingGroupId })
        .onConflictDoUpdate({
          target: [pricingGroupSites.siteId],
          set: { pricingGroupId: body.pricingGroupId, createdAt: new Date() },
        })
        .returning();
      await reply.status(201).send(record);
    },
  );

  app.delete(
    '/sites/:id/pricing-groups/:pricingGroupId',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Remove a pricing group from a site',
        operationId: 'removeSitePricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sitePricingGroupParams),
        response: { 200: itemResponse(sitePricingGroupRecordItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id, pricingGroupId } = request.params as z.infer<typeof sitePricingGroupParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const [record] = await db
        .delete(pricingGroupSites)
        .where(
          and(
            eq(pricingGroupSites.siteId, id),
            eq(pricingGroupSites.pricingGroupId, pricingGroupId),
          ),
        )
        .returning();
      if (record == null) {
        await reply
          .status(404)
          .send({ error: 'Pricing group not found for site', code: 'NOT_FOUND' });
        return;
      }
      return record;
    },
  );

  // Free vend toggle
  const freeVendBody = z.object({
    enabled: z.boolean().describe('Enable or disable free vend mode for this site'),
  });

  const freeVendResponse = z
    .object({
      success: z.boolean(),
      pushId21: z.string().optional(),
      pushId16: z.string().optional(),
    })
    .passthrough();

  app.post(
    '/sites/:id/free-vend',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Toggle free vend mode for a site',
        operationId: 'toggleSiteFreeVend',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        body: zodSchema(freeVendBody),
        response: { 200: itemResponse(freeVendResponse), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { enabled } = request.body as z.infer<typeof freeVendBody>;
      const { userId } = request.user as JwtPayload;

      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const [site] = await db.select().from(sites).where(eq(sites.id, id));
      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      if (!enabled) {
        await db
          .update(sites)
          .set({ freeVendEnabled: false, updatedAt: new Date() })
          .where(eq(sites.id, id));
        return { success: true };
      }

      // Create OCPP 2.1 template if not yet created
      let templateId21 = site.freeVendTemplateId21;
      if (templateId21 == null) {
        const [template] = await db
          .insert(configTemplates)
          .values({
            name: `Free Vend - ${site.name} (OCPP 2.1)`,
            ocppVersion: '2.1',
            variables: [
              { component: 'AuthCtrlr', variable: 'Enabled', value: 'false' },
              { component: 'TxCtrlr', variable: 'TxStartPoint', value: 'EVConnected' },
            ],
            targetFilter: { siteId: site.id },
          })
          .returning();
        templateId21 = template?.id ?? null;
      }

      // Create OCPP 1.6 template if not yet created
      let templateId16 = site.freeVendTemplateId16;
      if (templateId16 == null) {
        const [template] = await db
          .insert(configTemplates)
          .values({
            name: `Free Vend - ${site.name} (OCPP 1.6)`,
            ocppVersion: '1.6',
            variables: [
              {
                component: 'AllowOfflineTxForUnknownId',
                variable: 'AllowOfflineTxForUnknownId',
                value: 'true',
              },
              {
                component: 'LocalPreAuthorize',
                variable: 'LocalPreAuthorize',
                value: 'true',
              },
              {
                component: 'LocalAuthorizeOffline',
                variable: 'LocalAuthorizeOffline',
                value: 'true',
              },
            ],
            targetFilter: { siteId: site.id },
          })
          .returning();
        templateId16 = template?.id ?? null;
      }

      // Update site with template IDs and enable free vend
      await db
        .update(sites)
        .set({
          freeVendEnabled: true,
          freeVendTemplateId21: templateId21,
          freeVendTemplateId16: templateId16,
          updatedAt: new Date(),
        })
        .where(eq(sites.id, id));

      // Push templates to online stations at this site
      const pushId21 =
        templateId21 != null ? await pushTemplateToSiteStations(templateId21, id) : '';
      const pushId16 =
        templateId16 != null ? await pushTemplateToSiteStations(templateId16, id) : '';

      return { success: true, pushId21, pushId16 };
    },
  );

  // --- Carbon Region ---

  const carbonRegionResponse = z
    .object({
      regionCode: z.string().nullable(),
      regionName: z.string().nullable(),
      carbonIntensityKgPerKwh: z.string().nullable(),
    })
    .passthrough();

  const carbonRegionBody = z.object({
    regionCode: z.string().nullable().describe('Carbon intensity region code, or null to clear'),
  });

  app.get(
    '/sites/:id/carbon-region',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Get carbon region for a site',
        operationId: 'getSiteCarbonRegion',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        response: { 200: itemResponse(carbonRegionResponse), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const userSiteIds = await getUserSiteIds(userId);
      if (userSiteIds != null && !userSiteIds.includes(id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const [site] = await db
        .select({ carbonRegionCode: sites.carbonRegionCode })
        .from(sites)
        .where(eq(sites.id, id))
        .limit(1);
      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      if (site.carbonRegionCode == null) {
        return { regionCode: null, regionName: null, carbonIntensityKgPerKwh: null };
      }
      const [factor] = await db
        .select()
        .from(carbonIntensityFactors)
        .where(eq(carbonIntensityFactors.regionCode, site.carbonRegionCode))
        .limit(1);
      return {
        regionCode: site.carbonRegionCode,
        regionName: factor?.regionName ?? null,
        carbonIntensityKgPerKwh: factor?.carbonIntensityKgPerKwh ?? null,
      };
    },
  );

  app.put(
    '/sites/:id/carbon-region',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Set carbon region for a site',
        operationId: 'updateSiteCarbonRegion',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        body: zodSchema(carbonRegionBody),
        response: { 200: successResponse, 400: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { regionCode } = request.body as z.infer<typeof carbonRegionBody>;
      const { userId } = request.user as JwtPayload;
      const userSiteIds = await getUserSiteIds(userId);
      if (userSiteIds != null && !userSiteIds.includes(id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, id)).limit(1);
      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      if (regionCode != null) {
        const [factor] = await db
          .select({ id: carbonIntensityFactors.id })
          .from(carbonIntensityFactors)
          .where(eq(carbonIntensityFactors.regionCode, regionCode))
          .limit(1);
        if (factor == null) {
          await reply
            .status(400)
            .send({ error: 'Invalid region code', code: 'INVALID_REGION_CODE' });
          return;
        }
      }
      await db
        .update(sites)
        .set({ carbonRegionCode: regionCode, updatedAt: new Date() })
        .where(eq(sites.id, id));
      return { success: true };
    },
  );
}
