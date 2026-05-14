// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, or, ilike, sql, gte, and, desc, count, inArray, isNotNull } from 'drizzle-orm';
import { db, writeAudit, siteAuditLog, configTemplateAuditLog } from '@evtivity/database';
import { getAuditActor } from '../lib/audit-actor.js';
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
  pricingAssignmentAuditLog,
} from '@evtivity/database';
import { isValidTimezone } from '@evtivity/lib';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import {
  successResponse,
  paginatedResponse,
  itemResponse,
  arrayResponse,
  errorWith,
} from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
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
  siteName: z.string().min(1).max(255),
  stationId: z.string().max(255).optional(),
  stationModel: z.string().max(100).optional(),
  stationSerialNumber: z.string().max(100).optional(),
  evseId: z.number().int().min(1).optional(),
  connectorId: z.number().int().min(1).optional(),
  connectorType: z.string().max(50).optional(),
  maxPowerKw: z.number().min(0).max(10000).optional(),
  stationVendor: z.string().max(100).optional(),
});

const importSiteBody = z.object({
  rows: z.array(importSiteRow).max(10000),
  updateExisting: z
    .boolean()
    .describe('When true, updates existing sites/stations matched by name/stationId'),
});

const siteParams = z.object({
  id: ID_PARAMS.siteId.describe('Site ID'),
});

const sitePricingGroupItem = z
  .object({
    id: z.string().describe('Pricing group identifier'),
    name: z.string().max(255).describe('Display name of the pricing group'),
    description: z.string().nullable().describe('Description of the pricing group'),
    isDefault: z.boolean().describe('Whether this is the system default pricing group'),
    tariffCount: z.number().int().min(0).describe('Number of tariffs in this pricing group'),
  })
  .passthrough();

const sitePricingGroupRecordItem = z
  .object({
    siteId: z.string().describe('Site identifier'),
    pricingGroupId: z.string().describe('Pricing group identifier assigned to the site'),
  })
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
    id: z.string().describe('Site identifier'),
    name: z.string().describe('Display name of the site'),
    address: z.string().nullable().describe('Street address'),
    city: z.string().nullable().describe('City name'),
    state: z.string().nullable().describe('State, province, or region'),
    postalCode: z.string().nullable().describe('Postal or ZIP code'),
    country: z.string().nullable().describe('Country name or ISO code'),
    latitude: z.string().nullable().describe('Latitude in decimal degrees as string for precision'),
    longitude: z
      .string()
      .nullable()
      .describe('Longitude in decimal degrees as string for precision'),
    timezone: z.string().nullable().describe('IANA timezone name (e.g. America/Los_Angeles)'),
    contactName: z.string().nullable().describe('Site contact person name'),
    contactEmail: z.string().nullable().describe('Site contact email address'),
    contactPhone: z.string().nullable().describe('Site contact phone number'),
    contactIsPublic: z
      .boolean()
      .describe('Whether contact information is visible to drivers in the portal'),
    hoursOfOperation: z.string().nullable().describe('Free-form description of operating hours'),
    metadata: z.record(z.unknown()).nullable().describe('Arbitrary site metadata as JSON object'),
    createdAt: z.coerce.date().describe('Timestamp when the site was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the site was last updated'),
    stationCount: z.number().describe('Number of charging stations at this site'),
    loadManagementEnabled: z.boolean().describe('Whether site-level load management is enabled'),
    maxPowerKw: z.number().nullable().describe('Maximum power available at the site in kilowatts'),
    totalDrawKw: z.number().describe('Current total power draw across all stations in kilowatts'),
  })
  .passthrough();

const siteBase = z
  .object({
    id: z.string().describe('Site identifier'),
    name: z.string().describe('Display name of the site'),
    address: z.string().nullable().describe('Street address'),
    city: z.string().nullable().describe('City name'),
    state: z.string().nullable().describe('State, province, or region'),
    postalCode: z.string().nullable().describe('Postal or ZIP code'),
    country: z.string().nullable().describe('Country name or ISO code'),
    latitude: z.string().nullable().describe('Latitude in decimal degrees as string for precision'),
    longitude: z
      .string()
      .nullable()
      .describe('Longitude in decimal degrees as string for precision'),
    timezone: z.string().nullable().describe('IANA timezone name (e.g. America/Los_Angeles)'),
    hoursOfOperation: z.string().nullable().describe('Free-form description of operating hours'),
    metadata: z.record(z.unknown()).nullable().describe('Arbitrary site metadata as JSON object'),
    createdAt: z.coerce.date().describe('Timestamp when the site was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the site was last updated'),
  })
  .passthrough();

const importResultResponse = z
  .object({
    sitesCreated: z.number().describe('Number of new sites created from the import'),
    sitesUpdated: z.number().describe('Number of existing sites updated by the import'),
    stationsCreated: z.number().describe('Number of new charging stations created'),
    stationsUpdated: z.number().describe('Number of existing charging stations updated'),
    evsesCreated: z.number().describe('Number of new EVSEs created'),
    evsesUpdated: z.number().describe('Number of existing EVSEs updated'),
    connectorsCreated: z.number().describe('Number of new connectors created'),
    connectorsUpdated: z.number().describe('Number of existing connectors updated'),
    errors: z
      .array(z.string())
      .describe('List of error messages encountered during import, one per failing row'),
  })
  .passthrough();

const siteMetricsResponse = z
  .object({
    uptimePercent: z
      .number()
      .describe('Average port uptime percentage over the reporting period (0-100)'),
    portCount: z.number().describe('Total number of charging ports at the site'),
    utilizationPercent: z
      .number()
      .describe('Percentage of total port-hours occupied by sessions over the reporting period'),
    totalSessions: z.number().describe('Total number of charging sessions in the reporting period'),
    completedSessions: z.number().describe('Number of sessions that completed successfully'),
    faultedSessions: z.number().describe('Number of sessions that ended in a fault state'),
    sessionSuccessPercent: z
      .number()
      .describe('Percentage of sessions that completed successfully (0-100)'),
    totalEnergyWh: z.number().describe('Total energy delivered in watt-hours'),
    avgSessionDurationMinutes: z
      .number()
      .describe('Average session duration in minutes for completed sessions'),
    disconnectCount: z
      .number()
      .describe('Number of station disconnect events in the reporting period'),
    avgDowntimeMinutes: z.number().describe('Average duration of disconnect outages in minutes'),
    maxDowntimeMinutes: z.number().describe('Longest single disconnect outage duration in minutes'),
    totalRevenueCents: z
      .number()
      .int()
      .min(0)
      .describe('Total revenue collected in cents (smallest currency unit)'),
    avgRevenueCentsPerSession: z.number().describe('Average revenue per billable session in cents'),
    totalTransactions: z
      .number()
      .describe('Number of billable transactions (sessions with cost data)'),
    periodMonths: z.number().describe('Number of months covered by this metrics report'),
  })
  .passthrough();

const siteStationItem = z
  .object({
    id: z.string().describe('Internal station identifier (UUID)'),
    stationId: z.string().describe('OCPP station identifier used by the charging station'),
    siteId: z.string().nullable().describe('Identifier of the site this station belongs to'),
    model: z.string().nullable().describe('Hardware model name reported by the station'),
    serialNumber: z.string().nullable().describe('Hardware serial number reported by the station'),
    availability: z
      .string()
      .describe('Station-level availability state (available, unavailable, faulted)'),
    securityProfile: z
      .number()
      .describe('OCPP security profile level (0=none, 1=basic auth, 2=basic auth + TLS, 3=mTLS)'),
    lastHeartbeat: z.coerce
      .date()
      .nullable()
      .describe('Timestamp of the most recent heartbeat received from the station'),
    isOnline: z.boolean().describe('Whether the station is currently connected to the CSMS'),
    createdAt: z.coerce.date().describe('Timestamp when the station was registered'),
    updatedAt: z.coerce.date().describe('Timestamp when the station record was last updated'),
    status: z
      .string()
      .describe(
        'Derived station status from connector states (charging, reserved, faulted, available, unavailable, unknown)',
      ),
    connectorCount: z.number().describe('Number of connectors installed on this station'),
    connectorTypes: z
      .array(z.string())
      .nullable()
      .describe('Distinct connector types present on this station (e.g. CCS2, CHAdeMO, Type2)'),
  })
  .passthrough();

const energyHistoryItem = z
  .object({
    date: z.string().describe('Calendar date in YYYY-MM-DD format (in site timezone)'),
    energyWh: z.number().describe('Total energy delivered on this date in watt-hours'),
  })
  .passthrough();

const revenueHistoryItem = z
  .object({
    date: z.string().describe('Calendar date in YYYY-MM-DD format (in site timezone)'),
    revenueCents: z
      .number()
      .int()
      .min(0)
      .describe('Total revenue collected on this date in cents (smallest currency unit)'),
    sessionCount: z.number().describe('Number of billable sessions on this date'),
  })
  .passthrough();

const meterValueGroup = z
  .object({
    measurand: z
      .string()
      .describe('OCPP measurand name (e.g. Energy.Active.Import.Register, Power.Active.Import)'),
    unit: z.string().nullable().describe('Unit of measure for the values (e.g. Wh, kW, V, A)'),
    values: z
      .array(
        z
          .object({
            timestamp: z.coerce.date().describe('Timestamp when this meter sample was taken'),
            value: z.string().describe('Meter reading value as a string for numeric precision'),
          })
          .passthrough(),
      )
      .describe('Chronologically ordered list of meter readings for this measurand'),
  })
  .passthrough();

const siteSessionItem = z
  .object({
    id: z.string().describe('Session identifier'),
    stationId: z.string().describe('Internal station identifier (UUID)'),
    stationName: z.string().nullable().describe('OCPP station identifier of the charging station'),
    siteName: z.string().nullable().describe('Display name of the site'),
    driverId: z.string().nullable().describe('Identifier of the driver, if known'),
    driverName: z.string().nullable().describe('Full name of the driver (first + last)'),
    transactionId: z
      .string()
      .nullable()
      .describe('OCPP transaction identifier reported by the station'),
    status: z.string().describe('Session status (active, completed, faulted, failed, idling)'),
    energyDeliveredWh: z.coerce
      .number()
      .nullable()
      .describe('Total energy delivered during the session in watt-hours'),
    currentCostCents: z
      .number()
      .nullable()
      .describe('Current accrued cost in cents while the session is active'),
    finalCostCents: z
      .number()
      .nullable()
      .describe('Final billed cost in cents after the session ended'),
    currency: z.string().nullable().describe('ISO 4217 currency code for the cost values'),
    startedAt: z.coerce.date().describe('Timestamp when the charging session started'),
    endedAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp when the session ended, or null if still active'),
    freeVend: z
      .boolean()
      .describe('Whether the session was a free-vend session (no driver authorization or payment)'),
  })
  .passthrough();

const layoutConnector = z
  .object({
    connectorId: z.number().describe('OCPP connector ID within the EVSE'),
    connectorType: z
      .string()
      .nullable()
      .describe('Connector type (e.g. CCS2, CHAdeMO, Type2, Type1, NACS)'),
    maxPowerKw: z.number().nullable().describe('Maximum power rating in kilowatts'),
    status: z.string().describe('Current connector status'),
    isPluggedIn: z
      .boolean()
      .describe('Whether a vehicle is currently plugged in (active session present)'),
    energyDeliveredWh: z
      .number()
      .nullable()
      .describe('Energy delivered during the active session in watt-hours, or null if idle'),
  })
  .passthrough();

const layoutEvse = z
  .object({
    evseId: z.number().describe('OCPP EVSE ID within the station'),
    connectors: z.array(layoutConnector).describe('Connectors belonging to this EVSE'),
  })
  .passthrough();

const layoutStation = z
  .object({
    id: z.string().describe('Internal station identifier (UUID)'),
    stationId: z.string().describe('OCPP station identifier'),
    model: z.string().nullable().describe('Hardware model name'),
    status: z.string().nullable().describe('Station availability state'),
    isOnline: z.boolean().describe('Whether the station is currently connected to the CSMS'),
    securityProfile: z.number().describe('OCPP security profile level (0-3)'),
    positionX: z.number().describe('X coordinate on the site layout canvas'),
    positionY: z.number().describe('Y coordinate on the site layout canvas'),
    displayMessage: z
      .string()
      .nullable()
      .describe('Most recent accepted display message text shown on the station, if any'),
    evses: z.array(layoutEvse).describe('EVSEs installed on this station'),
  })
  .passthrough();

const sitesListQuery = paginationQuery.extend({
  city: z.string().optional().describe('Filter by city'),
  state: z.string().optional().describe('Filter by state'),
  loadManagement: z.enum(['true', 'false']).optional().describe('Filter by load management status'),
});

const locationOption = z
  .object({
    city: z.string().describe('City name'),
    state: z.string().describe('State, province, or region'),
  })
  .passthrough();
const filterOptionsResponse = z
  .object({
    locations: z
      .array(locationOption)
      .describe('Distinct city and state combinations across the user-accessible sites'),
  })
  .passthrough();

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
        response: {
          200: itemResponse(siteItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
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
      if (site != null) {
        const actor = getAuditActor(request);
        await writeAudit(
          { table: siteAuditLog, idColumn: 'site_id' },
          {
            entityId: site.id,
            entityIdSnapshot: site.id,
            action: 'created',
            ...actor,
            after: site,
          },
          db,
          request.log,
        );
      }
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
        response: {
          200: itemResponse(siteBase),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
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
      const body = request.body as z.infer<typeof updateSiteBody>;
      const [before] = await db.select().from(sites).where(eq(sites.id, id));
      const [site] = await db
        .update(sites)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(sites.id, id))
        .returning();
      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const actor = getAuditActor(request);
      await writeAudit(
        { table: siteAuditLog, idColumn: 'site_id' },
        {
          entityId: site.id,
          entityIdSnapshot: site.id,
          action: 'updated',
          ...actor,
          before: before ?? null,
          after: site,
        },
        db,
        request.log,
      );
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
        response: {
          200: itemResponse(siteBase),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
          409: errorWith('Site has stations', [ERROR_CODES.SITE_HAS_STATIONS]),
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
      const actor = getAuditActor(request);
      await writeAudit(
        { table: siteAuditLog, idColumn: 'site_id' },
        {
          entityId: null,
          entityIdSnapshot: site.id,
          action: 'deleted',
          ...actor,
          before: site,
        },
        db,
        request.log,
      );
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
        response: {
          200: zodSchema(siteMetricsResponse),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
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
        response: {
          200: paginatedResponse(siteStationItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
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
        response: {
          200: arrayResponse(energyHistoryItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
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
        response: {
          200: arrayResponse(revenueHistoryItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
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
    .object({
      dow: z.number().describe('Day of week (0=Sunday through 6=Saturday) in site timezone'),
      hour: z.number().describe('Hour of day (0-23) in site timezone'),
      avgSessions: z
        .number()
        .describe('Average number of sessions started in this day-of-week and hour bucket'),
    })
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
        response: {
          200: arrayResponse(popularTimesItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
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
        response: {
          200: arrayResponse(meterValueGroup),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
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
    limit: z.coerce.number().int().min(1).max(100).default(10),
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
        response: {
          200: paginatedResponse(siteSessionItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
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
        response: {
          200: arrayResponse(layoutStation),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
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
          200: zodSchema(
            z
              .object({
                ok: z.boolean().describe('True when the layout positions were saved successfully'),
              })
              .passthrough(),
          ),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
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
        response: {
          200: itemResponse(sitePricingGroupItem.nullable()),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
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
        response: {
          201: itemResponse(sitePricingGroupRecordItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
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
      const body = request.body as z.infer<typeof addSitePricingGroupBody>;
      const [previous] = await db
        .select()
        .from(pricingGroupSites)
        .where(eq(pricingGroupSites.siteId, id));
      const [record] = await db
        .insert(pricingGroupSites)
        .values({ siteId: id, pricingGroupId: body.pricingGroupId })
        .onConflictDoUpdate({
          target: [pricingGroupSites.siteId],
          set: { pricingGroupId: body.pricingGroupId, createdAt: new Date() },
        })
        .returning();
      await writeAudit(
        { table: pricingAssignmentAuditLog, idColumn: 'pricing_assignment_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: previous == null ? 'created' : 'updated',
          actor: 'operator',
          actorUserId: userId,
          before:
            previous == null
              ? null
              : { scope: 'site', siteId: id, pricingGroupId: previous.pricingGroupId },
          after: { scope: 'site', siteId: id, pricingGroupId: body.pricingGroupId },
        },
        db,
        request.log,
      );
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
        response: {
          200: itemResponse(sitePricingGroupRecordItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
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
      await writeAudit(
        { table: pricingAssignmentAuditLog, idColumn: 'pricing_assignment_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'deleted',
          actor: 'operator',
          actorUserId: userId,
          before: { scope: 'site', siteId: id, pricingGroupId },
        },
        db,
        request.log,
      );
      return record;
    },
  );

  // Free vend toggle
  const freeVendBody = z.object({
    enabled: z.boolean().describe('Enable or disable free vend mode for this site'),
  });

  const freeVendResponse = z
    .object({
      success: z.boolean().describe('True when the free vend toggle was applied successfully'),
      pushId21: z
        .string()
        .optional()
        .describe(
          'Identifier of the OCPP 2.1 config push triggered for stations at the site, if any',
        ),
      pushId16: z
        .string()
        .optional()
        .describe(
          'Identifier of the OCPP 1.6 config push triggered for stations at the site, if any',
        ),
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
        response: {
          200: itemResponse(freeVendResponse),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
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

      const actor = getAuditActor(request);

      if (!enabled) {
        const [updated] = await db
          .update(sites)
          .set({ freeVendEnabled: false, updatedAt: new Date() })
          .where(eq(sites.id, id))
          .returning();
        await writeAudit(
          { table: siteAuditLog, idColumn: 'site_id' },
          {
            entityId: site.id,
            entityIdSnapshot: site.id,
            action: 'updated',
            ...actor,
            before: site,
            after: updated ?? site,
            notes: 'free-vend disabled',
          },
          db,
          request.log,
        );
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
        if (template != null) {
          await writeAudit(
            { table: configTemplateAuditLog, idColumn: 'template_id' },
            {
              entityId: template.id,
              entityIdSnapshot: template.id,
              action: 'created',
              ...actor,
              after: template,
              notes: `auto-created for free-vend on site ${site.id}`,
            },
            db,
            request.log,
          );
        }
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
        if (template != null) {
          await writeAudit(
            { table: configTemplateAuditLog, idColumn: 'template_id' },
            {
              entityId: template.id,
              entityIdSnapshot: template.id,
              action: 'created',
              ...actor,
              after: template,
              notes: `auto-created for free-vend on site ${site.id}`,
            },
            db,
            request.log,
          );
        }
      }

      // Update site with template IDs and enable free vend
      const [updated] = await db
        .update(sites)
        .set({
          freeVendEnabled: true,
          freeVendTemplateId21: templateId21,
          freeVendTemplateId16: templateId16,
          updatedAt: new Date(),
        })
        .where(eq(sites.id, id))
        .returning();

      await writeAudit(
        { table: siteAuditLog, idColumn: 'site_id' },
        {
          entityId: site.id,
          entityIdSnapshot: site.id,
          action: 'updated',
          ...actor,
          before: site,
          after: updated ?? site,
          notes: 'free-vend enabled',
        },
        db,
        request.log,
      );

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
      regionCode: z
        .string()
        .nullable()
        .describe('Carbon intensity region code assigned to the site, or null if unset'),
      regionName: z
        .string()
        .nullable()
        .describe('Human-readable name of the carbon intensity region'),
      carbonIntensityKgPerKwh: z
        .string()
        .nullable()
        .describe(
          'Carbon intensity for this region in kilograms of CO2 per kilowatt-hour, as string for precision',
        ),
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
        response: {
          200: itemResponse(carbonRegionResponse),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
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
        response: {
          200: successResponse,
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
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
      const [site] = await db.select().from(sites).where(eq(sites.id, id)).limit(1);
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
      const [updated] = await db
        .update(sites)
        .set({ carbonRegionCode: regionCode, updatedAt: new Date() })
        .where(eq(sites.id, id))
        .returning();
      const actor = getAuditActor(request);
      await writeAudit(
        { table: siteAuditLog, idColumn: 'site_id' },
        {
          entityId: site.id,
          entityIdSnapshot: site.id,
          action: 'updated',
          ...actor,
          before: site,
          after: updated ?? site,
          notes: 'carbon-region updated',
        },
        db,
        request.log,
      );
      return { success: true };
    },
  );
}
