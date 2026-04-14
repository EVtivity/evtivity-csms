// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hash } from 'argon2';
import { eq, or, ilike, and, sql, gte, desc, count, inArray, isNotNull, isNull } from 'drizzle-orm';
import { db } from '@evtivity/database';
import {
  chargingStations,
  evses,
  connectors,
  chargingSessions,
  drivers,
  meterValues,
  sites,
  vendors,
  ocppMessageLogs,
  connectionLogs,
  stationCertificates,
  pricingGroupStations,
  pricingGroups,
  securityEvents,
  stationEvents,
  stationConfigurations,
  firmwareUpdates,
  chargingProfiles,
  evChargingNeeds,
  variableMonitoringRules,
  eventAlerts,
  chargingProfileTemplates,
  configTemplates,
} from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { getPubSub } from '../lib/pubsub.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import {
  errorResponse,
  successResponse,
  paginatedResponse,
  itemResponse,
  arrayResponse,
} from '../lib/response-schemas.js';
import { getUserSiteIds, checkStationSiteAccess } from '../lib/site-access.js';
import { sendOcppCommandAndWait } from '../lib/ocpp-command.js';
import { authorize } from '../middleware/rbac.js';
import type { JwtPayload } from '../plugins/auth.js';

const stationParams = z.object({
  id: ID_PARAMS.stationId.describe('Station ID'),
});

const stationPricingGroupItem = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    isDefault: z.boolean(),
    tariffCount: z.number(),
  })
  .passthrough();

const stationPricingGroupRecordItem = z
  .object({ stationId: z.string(), pricingGroupId: z.string() })
  .passthrough();

const addStationPricingGroupBody = z.object({
  pricingGroupId: ID_PARAMS.pricingGroupId.describe('Pricing group ID to assign to the station'),
});

const stationPricingGroupParams = z.object({
  id: ID_PARAMS.stationId.describe('Station ID'),
  pricingGroupId: ID_PARAMS.pricingGroupId.describe('Pricing group ID'),
});

const stationMeterValueItem = z
  .object({
    id: z.number(),
    timestamp: z.coerce.date(),
    measurand: z.string().nullable(),
    value: z.string(),
    unit: z.string().nullable(),
    phase: z.string().nullable(),
    location: z.string().nullable(),
    context: z.string().nullable(),
  })
  .passthrough();

const stationMeterValueQuery = paginationQuery.extend({
  measurand: z.string().optional().describe('Filter by measurand name'),
});

const stationListQuery = paginationQuery.merge(
  z.object({
    siteId: ID_PARAMS.siteId.optional().describe('Filter by site ID'),
    status: z
      .enum(['charging', 'reserved', 'faulted', 'available', 'unavailable', 'unknown'])
      .optional()
      .describe('Filter by derived station status'),
    onboardingStatus: z
      .enum(['pending', 'accepted', 'blocked'])
      .optional()
      .describe('Filter by onboarding status'),
    isOnline: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional()
      .describe('Filter by online/offline state'),
    isSimulator: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional()
      .describe('Filter by simulator flag'),
  }),
);

const createStationBody = z.object({
  stationId: z.string().min(1).max(255).describe('OCPP station identifier'),
  model: z.string().max(255).optional(),
  serialNumber: z.string().max(255).optional(),
  vendorId: ID_PARAMS.vendorId.optional().describe('Vendor ID'),
  siteId: ID_PARAMS.siteId.optional().describe('Site ID to assign the station to'),
  securityProfile: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .describe('OCPP security profile (0=none, 1=basic auth, 2=TLS+basic auth, 3=mTLS)'),
  password: z.string().min(8).max(128).optional().describe('Basic auth password for SP1/SP2'),
  isSimulator: z.boolean().optional().describe('Whether this station is a simulator'),
  latitude: z.string().max(20).optional().describe('Station latitude'),
  longitude: z.string().max(20).optional().describe('Station longitude'),
});

const updateStationBody = z.object({
  model: z.string().max(255).optional(),
  serialNumber: z.string().max(255).optional(),
  availability: z
    .enum(['available', 'unavailable', 'faulted'])
    .optional()
    .describe('Station availability status'),
  siteId: ID_PARAMS.siteId.nullable().optional().describe('Site ID to assign the station to'),
  securityProfile: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .describe('OCPP security profile (0=none, 1=basic auth, 2=TLS+basic auth, 3=mTLS)'),
  password: z.string().min(8).max(128).optional().describe('Basic auth password for SP1/SP2'),
  isSimulator: z.boolean().optional().describe('Whether this station is a simulator'),
  latitude: z.string().max(20).optional().describe('Station latitude'),
  longitude: z.string().max(20).optional().describe('Station longitude'),
  reservationsEnabled: z
    .boolean()
    .optional()
    .describe('Whether reservations are allowed at this station'),
});

const setCredentialsBody = z.object({
  password: z.string().min(8).max(128),
});

const stationItem = z
  .object({
    id: z.string(),
    stationId: z.string(),
    siteId: z.string().nullable(),
    vendorId: z.string().nullable(),
    model: z.string().nullable(),
    serialNumber: z.string().nullable(),
    firmwareVersion: z.string().nullable(),
    iccid: z.string().nullable(),
    imsi: z.string().nullable(),
    availability: z.string(),
    onboardingStatus: z.string(),
    lastHeartbeat: z.coerce.date().nullable(),
    isOnline: z.boolean(),
    isSimulator: z.boolean(),
    loadPriority: z.number(),
    securityProfile: z.number(),
    ocppProtocol: z.string().nullable(),
    hasPassword: z.boolean(),
    metadata: z.record(z.unknown()).nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    status: z.string(),
    connectorCount: z.number(),
    connectorTypes: z.array(z.string()).nullable(),
    siteFreeVendEnabled: z.boolean(),
  })
  .passthrough();

const stationDetail = z
  .object({
    id: z.string(),
    stationId: z.string(),
    siteId: z.string().nullable(),
    vendorId: z.string().nullable(),
    vendorName: z.string().nullable(),
    model: z.string().nullable(),
    serialNumber: z.string().nullable(),
    firmwareVersion: z.string().nullable(),
    iccid: z.string().nullable(),
    imsi: z.string().nullable(),
    availability: z.string(),
    onboardingStatus: z.string(),
    lastHeartbeat: z.coerce.date().nullable(),
    isOnline: z.boolean(),
    isSimulator: z.boolean(),
    loadPriority: z.number(),
    securityProfile: z.number(),
    ocppProtocol: z.string().nullable(),
    hasPassword: z.boolean(),
    metadata: z.record(z.unknown()).nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    status: z.string(),
    siteHoursOfOperation: z.string().nullable(),
    siteFreeVendEnabled: z.boolean(),
  })
  .passthrough();

const stationCreated = z
  .object({
    id: z.string(),
    stationId: z.string(),
    siteId: z.string().nullable(),
    vendorId: z.string().nullable(),
    model: z.string().nullable(),
    serialNumber: z.string().nullable(),
    firmwareVersion: z.string().nullable(),
    availability: z.string(),
    onboardingStatus: z.string(),
    isOnline: z.boolean(),
    isSimulator: z.boolean(),
    loadPriority: z.number(),
    securityProfile: z.number(),
    hasPassword: z.boolean(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .passthrough();

const connectorDetail = z
  .object({
    connectorId: z.number(),
    connectorType: z.string().nullable(),
    maxPowerKw: z.number().nullable(),
    maxCurrentAmps: z.number().nullable(),
    status: z.string(),
    autoCreated: z.boolean(),
    isIdling: z.boolean(),
  })
  .passthrough();

const evseDetail = z
  .object({
    evseId: z.number(),
    autoCreated: z.boolean(),
    connectors: z.array(connectorDetail),
  })
  .passthrough();

const evseResponse = z
  .object({
    evseId: z.number(),
    connectors: z.array(
      z
        .object({
          connectorId: z.number(),
          connectorType: z.string().nullable(),
          maxPowerKw: z.number().nullable(),
          maxCurrentAmps: z.number().nullable(),
          status: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const connectorResponse = z
  .object({
    connectorId: z.number(),
    connectorType: z.string().nullable(),
    maxPowerKw: z.number().nullable(),
    maxCurrentAmps: z.number().nullable(),
    status: z.string(),
  })
  .passthrough();

const deleteResponse = z.object({ status: z.string() }).passthrough();

const meterValueGroup = z
  .object({
    measurand: z.string(),
    unit: z.string().nullable(),
    values: z.array(z.object({ timestamp: z.coerce.date(), value: z.string() }).passthrough()),
  })
  .passthrough();

const energyHistoryItem = z.object({ date: z.string(), energyWh: z.number() }).passthrough();

const revenueHistoryItem = z
  .object({ date: z.string(), revenueCents: z.number(), sessionCount: z.number() })
  .passthrough();

const stationMetricsResponse = z
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

const sessionItem = z
  .object({
    id: z.string(),
    stationId: z.string(),
    stationName: z.string().nullable(),
    siteName: z.string().nullable(),
    driverId: z.string().nullable(),
    driverName: z.string().nullable(),
    transactionId: z.string().nullable(),
    status: z.string(),
    startedAt: z.coerce.date(),
    endedAt: z.coerce.date().nullable(),
    energyDeliveredWh: z.coerce.number().nullable(),
    currentCostCents: z.number().nullable(),
    finalCostCents: z.number().nullable(),
    currency: z.string().nullable(),
  })
  .passthrough();

const ocppLogItem = z
  .object({
    id: z.string(),
    stationId: z.string(),
    action: z.string().nullable(),
    direction: z.string(),
    messageId: z.string().nullable(),
    payload: z.unknown(),
    createdAt: z.coerce.date(),
  })
  .passthrough();

const ocppLogsResponse = z
  .object({
    data: z.array(ocppLogItem),
    total: z.number(),
    actions: z.array(z.string()),
  })
  .passthrough();

const securityLogItem = z
  .object({
    id: z.string(),
    event: z.string(),
    remoteAddress: z.string().nullable(),
    metadata: z.record(z.unknown()).nullable(),
    createdAt: z.coerce.date(),
  })
  .passthrough();

const certificateItem = z
  .object({
    id: z.string(),
    stationId: z.string(),
    certificateType: z.string(),
    status: z.string(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .passthrough();

export function stationRoutes(app: FastifyInstance): void {
  app.get(
    '/stations',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List all stations',
        operationId: 'listStations',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(stationListQuery),
        response: { 200: paginatedResponse(stationItem) },
      },
    },
    async (request) => {
      const query = request.query as z.infer<typeof stationListQuery>;
      const { page, limit, search, siteId, isOnline, isSimulator, onboardingStatus } = query;
      const statusFilter = query.status;
      const offset = (page - 1) * limit;

      const { userId } = request.user as JwtPayload;
      const accessibleSiteIds = await getUserSiteIds(userId);
      if (accessibleSiteIds != null && accessibleSiteIds.length === 0) {
        return { data: [], total: 0 };
      }

      const conditions = [];
      if (accessibleSiteIds != null) {
        conditions.push(
          or(isNull(chargingStations.siteId), inArray(chargingStations.siteId, accessibleSiteIds)),
        );
      }
      if (siteId != null) {
        conditions.push(eq(chargingStations.siteId, siteId));
      }
      if (search) {
        const pattern = `%${search}%`;
        conditions.push(
          or(
            ilike(chargingStations.id, pattern),
            ilike(chargingStations.stationId, pattern),
            ilike(chargingStations.model, pattern),
          ),
        );
      }
      if (isOnline != null) {
        conditions.push(eq(chargingStations.isOnline, isOnline));
      }
      if (isSimulator != null) {
        conditions.push(eq(chargingStations.isSimulator, isSimulator));
      }
      if (onboardingStatus != null) {
        conditions.push(eq(chargingStations.onboardingStatus, onboardingStatus));
      }

      // Subquery-based derived status avoids multiplicative JOIN expansion
      const derivedStatusSubquery = sql<string>`(
        SELECT CASE
          WHEN COUNT(c2.id) FILTER (WHERE c2.status IN ('occupied', 'charging', 'preparing', 'ev_connected', 'suspended_ev', 'suspended_evse')) > 0 THEN 'charging'
          WHEN COUNT(c2.id) FILTER (WHERE c2.status = 'reserved') > 0 THEN 'reserved'
          WHEN COUNT(c2.id) FILTER (WHERE c2.status = 'faulted') > 0 THEN 'faulted'
          WHEN COUNT(c2.id) = 0 THEN 'unknown'
          WHEN COUNT(c2.id) FILTER (WHERE c2.status = 'available') = COUNT(c2.id) THEN 'available'
          ELSE 'unavailable'
        END
        FROM ${evses} e2
        JOIN ${connectors} c2 ON c2.evse_id = e2.id
        WHERE e2.station_id = ${chargingStations.id}
      )`;

      if (statusFilter != null) {
        conditions.push(sql`${derivedStatusSubquery} = ${statusFilter}`);
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const baseQuery = db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          vendorId: chargingStations.vendorId,
          model: chargingStations.model,
          serialNumber: chargingStations.serialNumber,
          firmwareVersion: chargingStations.firmwareVersion,
          iccid: chargingStations.iccid,
          imsi: chargingStations.imsi,
          availability: chargingStations.availability,
          onboardingStatus: chargingStations.onboardingStatus,
          lastHeartbeat: chargingStations.lastHeartbeat,
          isOnline: chargingStations.isOnline,
          isSimulator: chargingStations.isSimulator,
          loadPriority: chargingStations.loadPriority,
          securityProfile: chargingStations.securityProfile,
          ocppProtocol: chargingStations.ocppProtocol,
          hasPassword: sql<boolean>`${chargingStations.basicAuthPasswordHash} IS NOT NULL`,
          metadata: chargingStations.metadata,
          createdAt: chargingStations.createdAt,
          updatedAt: chargingStations.updatedAt,
          status: derivedStatusSubquery,
          connectorCount: sql<number>`(
            SELECT COUNT(c3.id)::int
            FROM ${evses} e3
            JOIN ${connectors} c3 ON c3.evse_id = e3.id
            WHERE e3.station_id = ${chargingStations.id}
          )`,
          connectorTypes: sql<string[]>`(
            SELECT array_agg(DISTINCT c4.connector_type)
            FROM ${evses} e4
            JOIN ${connectors} c4 ON c4.evse_id = e4.id
            WHERE e4.station_id = ${chargingStations.id}
            AND c4.connector_type IS NOT NULL
          )`,
          siteFreeVendEnabled: sql<boolean>`coalesce(${sites.freeVendEnabled}, false)`,
        })
        .from(chargingStations)
        .leftJoin(sites, eq(sites.id, chargingStations.siteId))
        .where(where);

      const data = await baseQuery.limit(limit).offset(offset);

      const countResult = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(chargingStations)
        .where(where);

      return { data, total: countResult[0]?.count ?? 0 };
    },
  );

  app.get(
    '/stations/:id',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get a station by ID',
        operationId: 'getStation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: { 200: itemResponse(stationDetail), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const derivedStatus = sql<string>`CASE
        WHEN COUNT(${connectors.id}) FILTER (WHERE ${connectors.status} IN ('occupied', 'charging', 'preparing', 'ev_connected', 'suspended_ev', 'suspended_evse')) > 0 THEN 'charging'
        WHEN COUNT(${connectors.id}) FILTER (WHERE ${connectors.status} = 'reserved') > 0 THEN 'reserved'
        WHEN COUNT(${connectors.id}) FILTER (WHERE ${connectors.status} = 'faulted') > 0 THEN 'faulted'
        WHEN COUNT(${connectors.id}) = 0 THEN 'unknown'
        WHEN COUNT(${connectors.id}) FILTER (WHERE ${connectors.status} = 'available') = COUNT(${connectors.id}) THEN 'available'
        ELSE 'unavailable'
      END`;
      const [station] = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          vendorId: chargingStations.vendorId,
          vendorName: vendors.name,
          model: chargingStations.model,
          serialNumber: chargingStations.serialNumber,
          firmwareVersion: chargingStations.firmwareVersion,
          iccid: chargingStations.iccid,
          imsi: chargingStations.imsi,
          availability: chargingStations.availability,
          onboardingStatus: chargingStations.onboardingStatus,
          lastHeartbeat: chargingStations.lastHeartbeat,
          isOnline: chargingStations.isOnline,
          isSimulator: chargingStations.isSimulator,
          loadPriority: chargingStations.loadPriority,
          securityProfile: chargingStations.securityProfile,
          ocppProtocol: chargingStations.ocppProtocol,
          hasPassword: sql<boolean>`${chargingStations.basicAuthPasswordHash} IS NOT NULL`,
          metadata: chargingStations.metadata,
          createdAt: chargingStations.createdAt,
          updatedAt: chargingStations.updatedAt,
          status: derivedStatus,
          siteHoursOfOperation: sites.hoursOfOperation,
          siteFreeVendEnabled: sql<boolean>`coalesce(${sites.freeVendEnabled}, false)`,
          latitude: chargingStations.latitude,
          longitude: chargingStations.longitude,
          reservationsEnabled: chargingStations.reservationsEnabled,
        })
        .from(chargingStations)
        .leftJoin(vendors, eq(vendors.id, chargingStations.vendorId))
        .leftJoin(sites, eq(sites.id, chargingStations.siteId))
        .leftJoin(evses, eq(evses.stationId, chargingStations.id))
        .leftJoin(connectors, eq(connectors.evseId, evses.id))
        .where(eq(chargingStations.id, id))
        .groupBy(chargingStations.id, vendors.name, sites.hoursOfOperation, sites.freeVendEnabled);
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && station.siteId != null && !siteIds.includes(station.siteId)) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      return station;
    },
  );

  // Refresh station configurations via OCPP
  app.post(
    '/stations/:id/configurations/refresh',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Refresh station configurations from the station via OCPP',
        operationId: 'refreshStationConfigurations',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: {
          200: successResponse,
          400: errorResponse,
          404: errorResponse,
          502: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const [station] = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          isOnline: chargingStations.isOnline,
          ocppProtocol: chargingStations.ocppProtocol,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (!station.isOnline) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      let result;
      if (station.ocppProtocol === 'ocpp1.6') {
        result = await sendOcppCommandAndWait(station.stationId, 'GetConfiguration', {}, '1.6');
      } else {
        result = await sendOcppCommandAndWait(
          station.stationId,
          'GetBaseReport',
          {
            requestId: Math.floor(Math.random() * 2147483647),
            reportBase: 'FullInventory',
          },
          '2.1',
        );
      }

      if (result.error != null) {
        await reply.status(502).send({ error: result.error, code: 'OCPP_COMMAND_FAILED' });
        return;
      }

      return { success: true };
    },
  );

  app.post(
    '/stations',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Create a new station',
        operationId: 'createStation',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createStationBody),
        response: { 201: itemResponse(stationCreated), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createStationBody>;
      if (body.siteId != null) {
        const { userId } = request.user as JwtPayload;
        const siteIds = await getUserSiteIds(userId);
        if (siteIds != null && !siteIds.includes(body.siteId)) {
          await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
          return;
        }
      }
      const { password, ...insertFields } = body;
      const basicAuthPasswordHash = password != null ? await hash(password) : undefined;
      const [station] = await db
        .insert(chargingStations)
        .values({
          ...insertFields,
          ...(basicAuthPasswordHash != null ? { basicAuthPasswordHash } : {}),
        })
        .returning({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          vendorId: chargingStations.vendorId,
          model: chargingStations.model,
          serialNumber: chargingStations.serialNumber,
          firmwareVersion: chargingStations.firmwareVersion,
          availability: chargingStations.availability,
          onboardingStatus: chargingStations.onboardingStatus,
          isOnline: chargingStations.isOnline,
          isSimulator: chargingStations.isSimulator,
          loadPriority: chargingStations.loadPriority,
          securityProfile: chargingStations.securityProfile,
          createdAt: chargingStations.createdAt,
          updatedAt: chargingStations.updatedAt,
        });
      await reply.status(201).send({ ...station, hasPassword: basicAuthPasswordHash != null });
    },
  );

  app.patch(
    '/stations/:id',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Update a station',
        operationId: 'updateStation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(updateStationBody),
        response: { 200: itemResponse(stationCreated), 400: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null) {
        const [current] = await db
          .select({ siteId: chargingStations.siteId })
          .from(chargingStations)
          .where(eq(chargingStations.id, id));
        if (current == null) {
          await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
          return;
        }
        if (current.siteId != null && !siteIds.includes(current.siteId)) {
          await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
          return;
        }
      }
      const { password, ...body } = request.body as z.infer<typeof updateStationBody>;
      // Check access to the new siteId if being reassigned
      if (body.siteId != null && siteIds != null && !siteIds.includes(body.siteId)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      // Upgrading to SP1/SP2 requires a password if none is configured (SP3 uses client certs)
      if (
        body.securityProfile != null &&
        body.securityProfile >= 1 &&
        body.securityProfile < 3 &&
        password == null
      ) {
        const [existing] = await db
          .select({
            hasPassword: sql<boolean>`${chargingStations.basicAuthPasswordHash} IS NOT NULL`,
          })
          .from(chargingStations)
          .where(eq(chargingStations.id, id));
        if (existing != null && !existing.hasPassword) {
          await reply.status(400).send({
            error: 'Password required when upgrading to SP1 or SP2',
            code: 'PASSWORD_REQUIRED',
          });
          return;
        }
      }

      const updates: Record<string, unknown> = { ...body, updatedAt: new Date() };
      if (password != null) {
        updates.basicAuthPasswordHash = await hash(password);
      } else if (body.securityProfile === 0 || body.securityProfile === 3) {
        updates.basicAuthPasswordHash = null;
      }

      const [station] = await db
        .update(chargingStations)
        .set(updates)
        .where(eq(chargingStations.id, id))
        .returning({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          vendorId: chargingStations.vendorId,
          model: chargingStations.model,
          serialNumber: chargingStations.serialNumber,
          firmwareVersion: chargingStations.firmwareVersion,
          availability: chargingStations.availability,
          onboardingStatus: chargingStations.onboardingStatus,
          isOnline: chargingStations.isOnline,
          isSimulator: chargingStations.isSimulator,
          loadPriority: chargingStations.loadPriority,
          securityProfile: chargingStations.securityProfile,
          hasPassword: sql<boolean>`${chargingStations.basicAuthPasswordHash} IS NOT NULL`,
          createdAt: chargingStations.createdAt,
          updatedAt: chargingStations.updatedAt,
        });
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Push security profile change to station via OCPP SetVariables (if online and profile changed)
      if (body.securityProfile != null && station.isOnline) {
        const setVariableData: Array<{
          component: { name: string };
          variable: { name: string };
          attributeValue: string;
        }> = [
          {
            component: { name: 'SecurityCtrlr' },
            variable: { name: 'SecurityProfile' },
            attributeValue: String(body.securityProfile),
          },
        ];

        if (password != null) {
          setVariableData.push({
            component: { name: 'SecurityCtrlr' },
            variable: { name: 'BasicAuthPassword' },
            attributeValue: password,
          });
        }

        const commandPayload = {
          commandId: randomUUID(),
          stationId: station.stationId,
          action: 'SetVariables',
          payload: { setVariableData },
        };

        await getPubSub().publish('ocpp_commands', JSON.stringify(commandPayload));

        // Reset the station so it reconnects with the new security profile
        const resetPayload = {
          commandId: randomUUID(),
          stationId: station.stationId,
          action: 'Reset',
          payload: { type: 'OnIdle' },
        };
        await getPubSub().publish('ocpp_commands', JSON.stringify(resetPayload));
      }

      return station;
    },
  );

  app.delete(
    '/stations/:id',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Delete a station (marks as removed)',
        operationId: 'deleteStation',
        security: [{ bearerAuth: [] }],
        response: { 200: zodSchema(stationCreated), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null) {
        const [current] = await db
          .select({ siteId: chargingStations.siteId })
          .from(chargingStations)
          .where(eq(chargingStations.id, id));
        if (current == null) {
          await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
          return;
        }
        if (current.siteId != null && !siteIds.includes(current.siteId)) {
          await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
          return;
        }
      }
      const [station] = await db
        .update(chargingStations)
        .set({ onboardingStatus: 'blocked', updatedAt: new Date() })
        .where(eq(chargingStations.id, id))
        .returning();
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      return {
        ...station,
        hasPassword: station.basicAuthPasswordHash != null,
      };
    },
  );

  app.get(
    '/stations/:id/connectors',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List EVSEs and connectors for a station',
        operationId: 'listStationConnectors',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: { 200: arrayResponse(evseDetail), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const rows = await db
        .select({
          evseId: evses.evseId,
          evseAutoCreated: evses.autoCreated,
          connectorId: connectors.connectorId,
          connectorType: connectors.connectorType,
          maxPowerKw: connectors.maxPowerKw,
          maxCurrentAmps: connectors.maxCurrentAmps,
          connectorStatus: connectors.status,
          connectorAutoCreated: connectors.autoCreated,
          isIdling: sql<boolean>`EXISTS (
            SELECT 1 FROM charging_sessions cs
            WHERE cs.connector_id = ${connectors.id}
              AND cs.status = 'active'
              AND cs.idle_started_at IS NOT NULL
          )`,
        })
        .from(evses)
        .leftJoin(connectors, eq(connectors.evseId, evses.id))
        .where(eq(evses.stationId, id))
        .orderBy(evses.evseId, connectors.connectorId);

      const grouped = new Map<
        number,
        {
          evseId: number;
          autoCreated: boolean;
          connectors: {
            connectorId: number;
            connectorType: string | null;
            maxPowerKw: string | null;
            maxCurrentAmps: number | null;
            status: string;
            autoCreated: boolean;
            isIdling: boolean;
          }[];
        }
      >();

      for (const row of rows) {
        if (!grouped.has(row.evseId)) {
          grouped.set(row.evseId, {
            evseId: row.evseId,
            autoCreated: row.evseAutoCreated,
            connectors: [],
          });
        }
        const evse = grouped.get(row.evseId);
        if (row.connectorId != null && evse != null) {
          evse.connectors.push({
            connectorId: row.connectorId,
            connectorType: row.connectorType,
            maxPowerKw: row.maxPowerKw,
            maxCurrentAmps: row.maxCurrentAmps,
            status: row.connectorStatus ?? 'unavailable',
            autoCreated: row.connectorAutoCreated ?? false,
            isIdling: row.isIdling,
          });
        }
      }

      return [...grouped.values()];
    },
  );

  const evseParams = z.object({
    id: ID_PARAMS.stationId.describe('Station ID'),
    evseId: z.coerce.number().int().min(1).describe('OCPP EVSE ID (integer)'),
  });

  const connectorParams = z.object({
    id: ID_PARAMS.stationId.describe('Station ID'),
    evseId: z.coerce.number().int().min(1).describe('OCPP EVSE ID (integer)'),
    connectorId: z.coerce.number().int().min(1).describe('OCPP connector ID (integer)'),
  });

  const connectorTypes = ['CCS2', 'CHAdeMO', 'Type2', 'Type1', 'GBT', 'Tesla', 'NACS'] as const;

  const createEvseBody = z.object({
    evseId: z.number().int().min(1).describe('OCPP EVSE ID (integer)'),
    connectors: z
      .array(
        z.object({
          connectorId: z.number().int().min(1).describe('OCPP connector ID (integer)'),
          connectorType: z.enum(connectorTypes).describe('Connector plug type'),
          maxPowerKw: z.number().int().min(1).describe('Maximum power output in kW'),
          maxCurrentAmps: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('Maximum current output in amps'),
        }),
      )
      .min(1),
  });

  // POST /stations/:id/evses - Add an EVSE with connectors
  app.post(
    '/stations/:id/evses',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Add an EVSE with connectors to a station',
        operationId: 'addStationEvse',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(createEvseBody),
        response: {
          201: itemResponse(evseResponse),
          404: errorResponse,
          409: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const body = request.body as z.infer<typeof createEvseBody>;

      // Verify station exists
      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Check for duplicate evseId
      const [existing] = await db
        .select({ id: evses.id })
        .from(evses)
        .where(and(eq(evses.stationId, id), eq(evses.evseId, body.evseId)));
      if (existing != null) {
        await reply.status(409).send({
          error: `EVSE ID ${String(body.evseId)} already exists on this station`,
          code: 'DUPLICATE_EVSE_ID',
        });
        return;
      }

      // Insert EVSE
      const [evse] = await db
        .insert(evses)
        .values({ stationId: id, evseId: body.evseId })
        .returning();
      if (evse == null) {
        await reply.status(500).send({ error: 'Failed to create EVSE', code: 'INTERNAL_ERROR' });
        return;
      }

      // Insert connectors
      const connectorRows = await db
        .insert(connectors)
        .values(
          body.connectors.map((c) => ({
            evseId: evse.id,
            connectorId: c.connectorId,
            connectorType: c.connectorType,
            maxPowerKw: String(c.maxPowerKw),
            maxCurrentAmps: c.maxCurrentAmps,
            status: 'unavailable' as const,
          })),
        )
        .returning();

      await reply.status(201).send({
        evseId: evse.evseId,
        connectors: connectorRows.map((c) => ({
          connectorId: c.connectorId,
          connectorType: c.connectorType,
          maxPowerKw: c.maxPowerKw,
          maxCurrentAmps: c.maxCurrentAmps,
          status: c.status,
        })),
      });
    },
  );

  const updateEvseBody = z.object({
    connectors: z.array(
      z.object({
        connectorId: z.number().int().min(1).describe('OCPP connector ID (integer)'),
        connectorType: z.enum(connectorTypes).optional().describe('Connector plug type'),
        maxPowerKw: z.number().int().min(1).optional().describe('Maximum power output in kW'),
        maxCurrentAmps: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Maximum current output in amps'),
      }),
    ),
  });

  // PATCH /stations/:id/evses/:evseId - Update connectors on an EVSE
  app.patch(
    '/stations/:id/evses/:evseId',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Update connectors on an EVSE',
        operationId: 'updateStationEvse',
        security: [{ bearerAuth: [] }],
        params: zodSchema(evseParams),
        body: zodSchema(updateEvseBody),
        response: { 200: itemResponse(evseResponse), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id, evseId: ocppEvseId } = request.params as z.infer<typeof evseParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const body = request.body as z.infer<typeof updateEvseBody>;

      // Look up EVSE by station UUID + OCPP evseId
      const [evse] = await db
        .select({ id: evses.id, evseId: evses.evseId })
        .from(evses)
        .where(and(eq(evses.stationId, id), eq(evses.evseId, ocppEvseId)));
      if (evse == null) {
        await reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
        return;
      }

      // Update each connector
      for (const c of body.connectors) {
        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (c.connectorType != null) updates['connectorType'] = c.connectorType;
        if (c.maxPowerKw != null) updates['maxPowerKw'] = String(c.maxPowerKw);
        if (c.maxCurrentAmps != null) updates['maxCurrentAmps'] = c.maxCurrentAmps;

        await db
          .update(connectors)
          .set(updates)
          .where(and(eq(connectors.evseId, evse.id), eq(connectors.connectorId, c.connectorId)));
      }

      // Return updated EVSE with connectors
      const updatedConnectors = await db
        .select({
          connectorId: connectors.connectorId,
          connectorType: connectors.connectorType,
          maxPowerKw: connectors.maxPowerKw,
          maxCurrentAmps: connectors.maxCurrentAmps,
          status: connectors.status,
        })
        .from(connectors)
        .where(eq(connectors.evseId, evse.id))
        .orderBy(connectors.connectorId);

      return {
        evseId: evse.evseId,
        connectors: updatedConnectors,
      };
    },
  );

  const addConnectorBody = z.object({
    connectorId: z.number().int().min(1).describe('OCPP connector ID (integer)'),
    connectorType: z.enum(connectorTypes).describe('Connector plug type'),
    maxPowerKw: z.number().int().min(1).describe('Maximum power output in kW'),
    maxCurrentAmps: z.number().int().min(1).optional().describe('Maximum current output in amps'),
  });

  // POST /stations/:id/evses/:evseId/connectors - Add a connector to an EVSE
  app.post(
    '/stations/:id/evses/:evseId/connectors',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Add a connector to an EVSE',
        operationId: 'addStationConnector',
        security: [{ bearerAuth: [] }],
        params: zodSchema(evseParams),
        body: zodSchema(addConnectorBody),
        response: {
          201: itemResponse(connectorResponse),
          404: errorResponse,
          409: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id, evseId: ocppEvseId } = request.params as z.infer<typeof evseParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const body = request.body as z.infer<typeof addConnectorBody>;

      // Look up EVSE
      const [evse] = await db
        .select({ id: evses.id })
        .from(evses)
        .where(and(eq(evses.stationId, id), eq(evses.evseId, ocppEvseId)));
      if (evse == null) {
        await reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
        return;
      }

      // Check for duplicate connectorId
      const [existing] = await db
        .select({ id: connectors.id })
        .from(connectors)
        .where(and(eq(connectors.evseId, evse.id), eq(connectors.connectorId, body.connectorId)));
      if (existing != null) {
        await reply.status(409).send({
          error: `Connector ID ${String(body.connectorId)} already exists on this EVSE`,
          code: 'DUPLICATE_CONNECTOR_ID',
        });
        return;
      }

      const [connector] = await db
        .insert(connectors)
        .values({
          evseId: evse.id,
          connectorId: body.connectorId,
          connectorType: body.connectorType,
          maxPowerKw: String(body.maxPowerKw),
          maxCurrentAmps: body.maxCurrentAmps,
          status: 'unavailable',
        })
        .returning();
      if (connector == null) {
        await reply
          .status(500)
          .send({ error: 'Failed to create connector', code: 'INTERNAL_ERROR' });
        return;
      }

      await reply.status(201).send({
        connectorId: connector.connectorId,
        connectorType: connector.connectorType,
        maxPowerKw: connector.maxPowerKw,
        maxCurrentAmps: connector.maxCurrentAmps,
        status: connector.status,
      });
    },
  );

  // DELETE /stations/:id/evses/:evseId - Remove an EVSE and all its connectors
  app.delete(
    '/stations/:id/evses/:evseId',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Delete an EVSE and all its connectors',
        operationId: 'deleteStationEvse',
        security: [{ bearerAuth: [] }],
        params: zodSchema(evseParams),
        response: {
          200: zodSchema(deleteResponse),
          404: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id, evseId: ocppEvseId } = request.params as z.infer<typeof evseParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Look up EVSE
      const [evse] = await db
        .select({ id: evses.id })
        .from(evses)
        .where(and(eq(evses.stationId, id), eq(evses.evseId, ocppEvseId)));
      if (evse == null) {
        await reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
        return;
      }

      // Reject if any connector is in use
      const activeStatuses = [
        'occupied',
        'charging',
        'preparing',
        'ev_connected',
        'suspended_ev',
        'suspended_evse',
      ];
      const [inUse] = await db
        .select({ id: connectors.id })
        .from(connectors)
        .where(
          and(
            eq(connectors.evseId, evse.id),
            sql`${connectors.status} IN (${sql.join(
              activeStatuses.map((s) => sql`${s}`),
              sql`, `,
            )})`,
          ),
        );
      if (inUse != null) {
        await reply.status(409).send({
          error: 'Cannot delete EVSE with occupied connectors',
          code: 'CONNECTOR_OCCUPIED',
        });
        return;
      }

      await db.delete(evses).where(eq(evses.id, evse.id));
      return { status: 'deleted' };
    },
  );

  // DELETE /stations/:id/evses/:evseId/connectors/:connectorId - Remove a connector
  app.delete(
    '/stations/:id/evses/:evseId/connectors/:connectorId',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Delete a connector from an EVSE',
        operationId: 'deleteStationConnector',
        security: [{ bearerAuth: [] }],
        params: zodSchema(connectorParams),
        response: {
          200: zodSchema(deleteResponse),
          404: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const {
        id,
        evseId: ocppEvseId,
        connectorId: ocppConnectorId,
      } = request.params as z.infer<typeof connectorParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Look up EVSE
      const [evse] = await db
        .select({ id: evses.id })
        .from(evses)
        .where(and(eq(evses.stationId, id), eq(evses.evseId, ocppEvseId)));
      if (evse == null) {
        await reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
        return;
      }

      // Find the connector
      const [connector] = await db
        .select({ id: connectors.id, status: connectors.status })
        .from(connectors)
        .where(and(eq(connectors.evseId, evse.id), eq(connectors.connectorId, ocppConnectorId)));
      if (connector == null) {
        await reply.status(404).send({ error: 'Connector not found', code: 'CONNECTOR_NOT_FOUND' });
        return;
      }

      // Reject if in use
      const inUseStatuses = [
        'occupied',
        'charging',
        'preparing',
        'ev_connected',
        'suspended_ev',
        'suspended_evse',
        'idle',
        'discharging',
      ];
      if (inUseStatuses.includes(connector.status)) {
        await reply.status(409).send({
          error: 'Cannot delete occupied connector',
          code: 'CONNECTOR_OCCUPIED',
        });
        return;
      }

      await db.delete(connectors).where(eq(connectors.id, connector.id));
      return { status: 'deleted' };
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
    '/stations/:id/meter-values',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get meter value time series for a station',
        operationId: 'getStationMeterValues',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(meterValuesQuery),
        response: { 200: arrayResponse(meterValueGroup), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
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
        .where(and(eq(meterValues.stationId, id), gte(meterValues.timestamp, since)))
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

  const energyHistoryQuery = z.object({
    days: z.coerce.number().int().min(1).max(90).default(7).describe('Number of days to look back'),
  });

  app.get(
    '/stations/:id/energy-history',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get daily energy delivery history for a station',
        operationId: 'getStationEnergyHistory',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(energyHistoryQuery),
        response: { 200: arrayResponse(energyHistoryItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const { days } = request.query as z.infer<typeof energyHistoryQuery>;
      const since = new Date();
      since.setDate(since.getDate() - days);

      const [stationRow] = await db
        .select({ siteTimezone: sites.timezone })
        .from(chargingStations)
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(eq(chargingStations.id, id));
      const tz = stationRow?.siteTimezone ?? 'America/New_York';

      const rows = await db
        .select({
          date: sql<string>`date_trunc('day', ${chargingSessions.startedAt} AT TIME ZONE ${tz})::date::text`,
          energyWh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric), 0)`,
        })
        .from(chargingSessions)
        .where(and(eq(chargingSessions.stationId, id), gte(chargingSessions.startedAt, since)))
        .groupBy(sql`1`)
        .orderBy(sql`1`);

      return rows.map((r) => ({ date: r.date, energyWh: r.energyWh }));
    },
  );

  const revenueHistoryQuery = z.object({
    days: z.coerce.number().int().min(1).max(90).default(7).describe('Number of days to look back'),
  });

  app.get(
    '/stations/:id/revenue-history',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get daily revenue history for a station',
        operationId: 'getStationRevenueHistory',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(revenueHistoryQuery),
        response: { 200: arrayResponse(revenueHistoryItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const { days } = request.query as z.infer<typeof revenueHistoryQuery>;
      const since = new Date();
      since.setDate(since.getDate() - days);

      const [stationRow] = await db
        .select({ siteTimezone: sites.timezone })
        .from(chargingStations)
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(eq(chargingStations.id, id));
      const tz = stationRow?.siteTimezone ?? 'America/New_York';

      const rows = await db
        .select({
          date: sql<string>`date_trunc('day', ${chargingSessions.startedAt} AT TIME ZONE ${tz})::date::text`,
          revenueCents: sql<number>`coalesce(sum(coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents})), 0)`,
          sessionCount: count(),
        })
        .from(chargingSessions)
        .where(
          and(
            eq(chargingSessions.stationId, id),
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

  const uptimeHistoryQuery = z.object({
    days: z.coerce
      .number()
      .int()
      .min(1)
      .max(90)
      .default(30)
      .describe('Number of days to look back'),
  });

  const uptimeHistoryItem = z.object({ date: z.string(), uptimePercent: z.number() }).passthrough();

  app.get(
    '/stations/:id/uptime-history',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get daily uptime percentage history for a station',
        operationId: 'getStationUptimeHistory',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(uptimeHistoryQuery),
        response: { 200: arrayResponse(uptimeHistoryItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const { days } = request.query as z.infer<typeof uptimeHistoryQuery>;
      const since = new Date();
      since.setDate(since.getDate() - days);

      const [stationRow] = await db
        .select({ siteTimezone: sites.timezone })
        .from(chargingStations)
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(eq(chargingStations.id, id));
      const tz = stationRow?.siteTimezone ?? 'America/New_York';
      const sinceIso = since.toISOString();

      const rows = await db.execute(sql`
        WITH date_series AS (
          SELECT generate_series(
            date_trunc('day', ${sinceIso}::timestamptz AT TIME ZONE ${tz}),
            date_trunc('day', now() AT TIME ZONE ${tz}),
            '1 day'::interval
          )::date AS day
        ),
        ports AS (
          SELECT DISTINCT evse_id FROM evses WHERE station_id = ${id}
        ),
        pre_period_status AS (
          SELECT DISTINCT ON (psl.evse_id)
            psl.evse_id,
            psl.new_status,
            ${sinceIso}::timestamptz AS timestamp
          FROM port_status_log psl
          INNER JOIN ports p ON p.evse_id = psl.evse_id
          WHERE psl.station_id = ${id} AND psl.timestamp < ${sinceIso}::timestamptz
          ORDER BY psl.evse_id, psl.timestamp DESC
        ),
        seeded_log AS (
          SELECT evse_id, new_status, timestamp FROM pre_period_status
          UNION ALL
          SELECT psl.evse_id, psl.new_status, psl.timestamp
          FROM port_status_log psl
          INNER JOIN ports p ON p.evse_id = psl.evse_id
          WHERE psl.station_id = ${id} AND psl.timestamp >= ${sinceIso}::timestamptz
        ),
        port_transitions AS (
          SELECT
            evse_id,
            new_status,
            timestamp AT TIME ZONE ${tz} AS local_ts,
            LEAD(timestamp AT TIME ZONE ${tz}) OVER (PARTITION BY evse_id ORDER BY timestamp) AS next_local_ts
          FROM seeded_log
        ),
        daily_outages AS (
          SELECT
            ds.day,
            pt.evse_id,
            SUM(
              EXTRACT(EPOCH FROM (
                LEAST(COALESCE(pt.next_local_ts, now() AT TIME ZONE ${tz}), (ds.day + '1 day'::interval))
                - GREATEST(pt.local_ts, ds.day::timestamp)
              )) / 60
            ) AS down_minutes
          FROM date_series ds
          INNER JOIN port_transitions pt
            ON pt.new_status IN ('faulted', 'unavailable')
            AND pt.local_ts < (ds.day + '1 day'::interval)
            AND COALESCE(pt.next_local_ts, now() AT TIME ZONE ${tz}) > ds.day::timestamp
          GROUP BY ds.day, pt.evse_id
        ),
        daily_uptime AS (
          SELECT
            ds.day,
            COALESCE(AVG(
              GREATEST(0, (1440 - COALESCE(do2.down_minutes, 0)) / 1440) * 100
            ), 100) AS uptime_percent
          FROM date_series ds
          CROSS JOIN ports p
          LEFT JOIN daily_outages do2 ON do2.day = ds.day AND do2.evse_id = p.evse_id
          GROUP BY ds.day
        )
        SELECT day::text AS date, uptime_percent
        FROM daily_uptime
        ORDER BY day
      `);

      return (rows as unknown as { date: string; uptime_percent: number | string }[]).map((r) => ({
        date: r.date,
        uptimePercent: Math.round(Number(r.uptime_percent) * 100) / 100,
      }));
    },
  );

  const popularTimesQuery = z.object({
    weeks: z.coerce
      .number()
      .int()
      .min(1)
      .max(52)
      .default(4)
      .describe('Number of weeks to average over'),
  });

  const popularTimesItem = z
    .object({ dow: z.number(), hour: z.number(), avgSessions: z.number() })
    .passthrough();

  app.get(
    '/stations/:id/popular-times',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get average session count by day-of-week and hour for a station',
        operationId: 'getStationPopularTimes',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(popularTimesQuery),
        response: { 200: arrayResponse(popularTimesItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const { weeks } = request.query as z.infer<typeof popularTimesQuery>;
      const since = new Date();
      since.setDate(since.getDate() - weeks * 7);

      const [stationRow] = await db
        .select({ siteTimezone: sites.timezone })
        .from(chargingStations)
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(eq(chargingStations.id, id));
      const tz = stationRow?.siteTimezone ?? 'America/New_York';

      const rows = await db
        .select({
          dow: sql<number>`extract(dow from ${chargingSessions.startedAt} at time zone ${tz})::int`,
          hour: sql<number>`extract(hour from ${chargingSessions.startedAt} at time zone ${tz})::int`,
          totalSessions: count(),
        })
        .from(chargingSessions)
        .where(and(eq(chargingSessions.stationId, id), gte(chargingSessions.startedAt, since)))
        .groupBy(sql`1`, sql`2`)
        .orderBy(sql`1`, sql`2`);

      return rows.map((r) => ({
        dow: r.dow,
        hour: r.hour,
        avgSessions: Math.round((r.totalSessions / weeks) * 10) / 10,
      }));
    },
  );

  const metricsQuery = z.object({
    months: z.coerce
      .number()
      .int()
      .min(1)
      .max(24)
      .default(12)
      .describe('Number of months to look back for metrics'),
  });

  app.get(
    '/stations/:id/metrics',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get performance metrics for a station',
        operationId: 'getStationMetrics',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(metricsQuery),
        response: { 200: zodSchema(stationMetricsResponse), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const { months } = request.query as z.infer<typeof metricsQuery>;
      const since = new Date();
      since.setMonth(since.getMonth() - months);

      const periodMinutes = Math.floor((Date.now() - since.getTime()) / 60000);
      const periodMinutesLiteral = sql.raw(String(periodMinutes));
      const sinceIso = since.toISOString();

      const uptimeRows = await db.execute(sql`
        WITH ports AS (
          SELECT DISTINCT evse_id FROM evses WHERE station_id = ${id}
        ),
        pre_period_status AS (
          SELECT DISTINCT ON (psl.evse_id)
            psl.evse_id,
            psl.new_status,
            ${sinceIso}::timestamptz AS timestamp
          FROM port_status_log psl
          INNER JOIN ports p ON p.evse_id = psl.evse_id
          WHERE psl.station_id = ${id} AND psl.timestamp < ${sinceIso}::timestamptz
          ORDER BY psl.evse_id, psl.timestamp DESC
        ),
        seeded_log AS (
          SELECT evse_id, new_status, timestamp FROM pre_period_status
          UNION ALL
          SELECT psl.evse_id, psl.new_status, psl.timestamp
          FROM port_status_log psl
          INNER JOIN ports p ON p.evse_id = psl.evse_id
          WHERE psl.station_id = ${id} AND psl.timestamp >= ${sinceIso}::timestamptz
        ),
        port_transitions AS (
          SELECT
            evse_id,
            new_status,
            timestamp,
            LEAD(timestamp) OVER (PARTITION BY evse_id ORDER BY timestamp) AS next_timestamp
          FROM seeded_log
        ),
        outage_minutes AS (
          SELECT
            evse_id,
            SUM(
              EXTRACT(EPOCH FROM (COALESCE(next_timestamp, now()) - timestamp)) / 60
            ) AS down_minutes
          FROM port_transitions
          WHERE new_status IN ('faulted', 'unavailable')
          GROUP BY evse_id
        )
        SELECT
          COALESCE(AVG(
            CASE WHEN ${periodMinutesLiteral} > 0
              THEN GREATEST(0, ((${periodMinutesLiteral} - COALESCE(down_minutes, 0)) / ${periodMinutesLiteral}) * 100)
              ELSE 100
            END
          ), 100) AS uptime_percent,
          COUNT(DISTINCT ports.evse_id) AS port_count
        FROM ports
        LEFT JOIN outage_minutes USING (evse_id)
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
        .where(and(eq(chargingSessions.stationId, id), gte(chargingSessions.startedAt, since)));

      const [utilizationStats] = await db
        .select({
          sessionHours: sql<number>`coalesce(sum(extract(epoch from (coalesce(${chargingSessions.endedAt}, now()) - ${chargingSessions.startedAt})) / 3600), 0)`,
          portCount: sql<number>`(select count(*) from evses where station_id = ${id})`,
        })
        .from(chargingSessions)
        .where(and(eq(chargingSessions.stationId, id), gte(chargingSessions.startedAt, since)));

      const [financialStats] = await db
        .select({
          totalRevenueCents: sql<number>`coalesce(sum(coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents})), 0)`,
          avgRevenueCentsPerSession: sql<number>`coalesce(avg(coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents})), 0)`,
          totalTransactions: sql<number>`count(*) filter (where coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents}) is not null)`,
        })
        .from(chargingSessions)
        .where(and(eq(chargingSessions.stationId, id), gte(chargingSessions.startedAt, since)));

      const totalPortHours = (utilizationStats?.portCount ?? 1) * (periodMinutes / 60);
      const utilization =
        totalPortHours > 0
          ? Math.round(((utilizationStats?.sessionHours ?? 0) / totalPortHours) * 100)
          : 0;

      const total = sessionStats?.totalSessions ?? 0;
      const completed = sessionStats?.completedSessions ?? 0;

      const uptimeRow = uptimeRows[0] as { uptime_percent: string; port_count: string } | undefined;

      const disconnectRows = await db.execute(sql`
        WITH ordered_events AS (
          SELECT
            event,
            created_at,
            LEAD(created_at) OVER (ORDER BY created_at) AS next_at,
            LEAD(event) OVER (ORDER BY created_at) AS next_event
          FROM connection_logs
          WHERE station_id = ${id} AND created_at >= ${sinceIso}::timestamptz
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

  const sessionsQuery = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(10),
    status: z
      .enum(['active', 'completed', 'faulted', 'idling'])
      .optional()
      .describe('Filter by session status'),
  });

  app.get(
    '/stations/:id/sessions',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List charging sessions for a station',
        operationId: 'listStationSessions',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(sessionsQuery),
        response: { 200: paginatedResponse(sessionItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const { page, limit, status } = request.query as z.infer<typeof sessionsQuery>;
      const offset = (page - 1) * limit;
      const conditions = [eq(chargingSessions.stationId, id)];
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
            startedAt: chargingSessions.startedAt,
            endedAt: chargingSessions.endedAt,
            energyDeliveredWh: chargingSessions.energyDeliveredWh,
            currentCostCents: chargingSessions.currentCostCents,
            finalCostCents: chargingSessions.finalCostCents,
            currency: chargingSessions.currency,
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
          .where(where),
      ]);

      return { data: rows, total: countRows[0]?.count ?? 0 };
    },
  );

  const ocppLogsQuery = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    action: z.string().optional().describe('Filter by OCPP action name'),
    direction: z.enum(['inbound', 'outbound']).optional().describe('Filter by message direction'),
  });

  app.get(
    '/stations/:id/ocpp-logs',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get OCPP message logs for a station',
        operationId: 'getStationOcppLogs',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(ocppLogsQuery),
        response: { 200: zodSchema(ocppLogsResponse), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const query = request.query as z.infer<typeof ocppLogsQuery>;
      const offset = (query.page - 1) * query.limit;

      const conditions = [eq(ocppMessageLogs.stationId, id)];
      if (query.action != null && query.action !== '') {
        conditions.push(eq(ocppMessageLogs.action, query.action));
      }
      if (query.direction != null) {
        conditions.push(eq(ocppMessageLogs.direction, query.direction));
      }
      const where = and(...conditions);

      const [rows, countRows] = await Promise.all([
        db
          .select()
          .from(ocppMessageLogs)
          .where(where)
          .orderBy(desc(ocppMessageLogs.createdAt))
          .limit(query.limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(ocppMessageLogs)
          .where(where),
      ]);

      // Get distinct actions for filter dropdown
      const actionRows = await db
        .selectDistinct({ action: ocppMessageLogs.action })
        .from(ocppMessageLogs)
        .where(eq(ocppMessageLogs.stationId, id))
        .orderBy(ocppMessageLogs.action);

      return {
        data: rows,
        total: countRows[0]?.count ?? 0,
        actions: actionRows.map((r) => r.action).filter((a): a is string => a != null),
      };
    },
  );

  // Set or update station password
  app.post(
    '/stations/:id/credentials',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Set or update station Basic Auth password',
        operationId: 'setStationCredentials',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(setCredentialsBody),
        response: { 200: successResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const { password } = request.body as z.infer<typeof setCredentialsBody>;

      const passwordHash = await hash(password);
      const [station] = await db
        .update(chargingStations)
        .set({ basicAuthPasswordHash: passwordHash, updatedAt: new Date() })
        .where(eq(chargingStations.id, id))
        .returning({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          isOnline: chargingStations.isOnline,
        });

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      await db.insert(connectionLogs).values({
        stationId: id,
        event: 'password_changed',
        metadata: { changedBy: 'operator' },
      });

      // Push password to station via OCPP SetVariables (if online)
      if (station.isOnline) {
        const commandPayload = {
          commandId: randomUUID(),
          stationId: station.stationId,
          action: 'SetVariables',
          payload: {
            setVariableData: [
              {
                component: { name: 'SecurityCtrlr' },
                variable: { name: 'BasicAuthPassword' },
                attributeValue: password,
              },
            ],
          },
        };
        await getPubSub().publish('ocpp_commands', JSON.stringify(commandPayload));

        // Reset the station so it reconnects with the new password
        const resetPayload = {
          commandId: randomUUID(),
          stationId: station.stationId,
          action: 'Reset',
          payload: { type: 'OnIdle' },
        };
        await getPubSub().publish('ocpp_commands', JSON.stringify(resetPayload));
      }

      return { success: true };
    },
  );

  // Rotate station credentials via OCPP SetVariables
  app.post(
    '/stations/:id/rotate-credentials',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Rotate station Basic Auth password via OCPP',
        operationId: 'rotateStationCredentials',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: {
          200: successResponse,
          404: errorResponse,
          409: errorResponse,
          502: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Verify station exists and is online
      const [station] = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          isOnline: chargingStations.isOnline,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (!station.isOnline) {
        await reply.status(409).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      // Generate new password
      const newPassword = randomBytes(15).toString('base64url').slice(0, 20);

      // Send SetVariables command via pg_notify
      const commandId = randomUUID();
      const commandPayload = {
        commandId,
        stationId: station.stationId,
        action: 'SetVariables',
        payload: {
          setVariableData: [
            {
              component: { name: 'SecurityCtrlr' },
              variable: { name: 'BasicAuthPassword' },
              attributeValue: newPassword,
            },
          ],
        },
      };

      await getPubSub().publish('ocpp_commands', JSON.stringify(commandPayload));

      // Wait for result on ocpp_command_results channel
      const pubsub = getPubSub();
      const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ success: false, error: 'Command timed out' });
        }, 35_000);

        void pubsub
          .subscribe('ocpp_command_results', (payload: string) => {
            try {
              const parsed = JSON.parse(payload) as {
                commandId: string;
                success: boolean;
                error?: string;
              };
              if (parsed.commandId !== commandId) return;

              clearTimeout(timeout);
              resolve(
                parsed.error != null
                  ? { success: parsed.success, error: parsed.error }
                  : { success: parsed.success },
              );
            } catch {
              // Ignore parse errors from other messages
            }
          })
          .catch(() => {
            clearTimeout(timeout);
            resolve({ success: false, error: 'Failed to listen for result' });
          });
      });

      if (!result.success) {
        await reply
          .status(502)
          .send({ error: result.error ?? 'Credential rotation failed', code: 'ROTATION_FAILED' });
        return;
      }

      // On success, hash and store the new password
      const passwordHash = await hash(newPassword);
      await db
        .update(chargingStations)
        .set({ basicAuthPasswordHash: passwordHash, updatedAt: new Date() })
        .where(eq(chargingStations.id, id));

      // Log the event
      await db.insert(connectionLogs).values({
        stationId: id,
        event: 'credentials_rotated',
        metadata: { rotatedBy: 'operator' },
      });

      // Reset the station so it reconnects with the new password
      const resetPayload = {
        commandId: randomUUID(),
        stationId: station.stationId,
        action: 'Reset',
        payload: { type: 'OnIdle' },
      };
      await getPubSub().publish('ocpp_commands', JSON.stringify(resetPayload));

      return { success: true };
    },
  );

  // Security event logs
  const securityLogsQuery = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  });

  app.get(
    '/stations/:id/security-logs',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get security event logs for a station',
        operationId: 'getStationSecurityLogs',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(securityLogsQuery),
        response: { 200: paginatedResponse(securityLogItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const query = request.query as z.infer<typeof securityLogsQuery>;
      const offset = (query.page - 1) * query.limit;

      const securityEvents = [
        'auth_failed',
        'password_changed',
        'credentials_rotated',
        'connected',
        'disconnected',
      ];

      const where = and(
        eq(connectionLogs.stationId, id),
        inArray(connectionLogs.event, securityEvents),
      );

      const [rows, countRows] = await Promise.all([
        db
          .select({
            id: connectionLogs.id,
            event: connectionLogs.event,
            remoteAddress: connectionLogs.remoteAddress,
            metadata: connectionLogs.metadata,
            createdAt: connectionLogs.createdAt,
          })
          .from(connectionLogs)
          .where(where)
          .orderBy(desc(connectionLogs.createdAt))
          .limit(query.limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(connectionLogs)
          .where(where),
      ]);

      return { data: rows, total: countRows[0]?.count ?? 0 };
    },
  );

  // --- Station Certificates ---

  const stationCertQuery = paginationQuery.extend({
    status: z
      .enum(['active', 'expired', 'revoked'])
      .optional()
      .describe('Filter by certificate status'),
  });

  const installCertBody = z.object({
    certificateType: z.string().min(1),
    certificate: z.string().min(1),
  });

  const deleteCertBody = z.object({
    certificateHashData: z.object({
      hashAlgorithm: z.string(),
      issuerNameHash: z.string(),
      issuerKeyHash: z.string(),
      serialNumber: z.string(),
    }),
  });

  const getInstalledCertsBody = z.object({
    certificateType: z.array(z.string()).optional(),
  });

  app.get(
    '/stations/:id/certificates',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List certificates for a station',
        operationId: 'listStationCertificates',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(stationCertQuery),
        response: { 200: paginatedResponse(certificateItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const query = request.query as z.infer<typeof stationCertQuery>;
      const offset = (query.page - 1) * query.limit;

      const conditions = [eq(stationCertificates.stationId, id)];
      if (query.status != null) {
        conditions.push(eq(stationCertificates.status, query.status));
      }

      const where = and(...conditions);

      const [rows, [countResult]] = await Promise.all([
        db
          .select()
          .from(stationCertificates)
          .where(where)
          .orderBy(desc(stationCertificates.createdAt))
          .limit(query.limit)
          .offset(offset),
        db.select({ count: count() }).from(stationCertificates).where(where),
      ]);

      return { data: rows, total: countResult?.count ?? 0 } satisfies PaginatedResponse<
        (typeof rows)[number]
      >;
    },
  );

  app.post(
    '/stations/:id/certificates/install',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Install a certificate on a station',
        operationId: 'installStationCertificate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(installCertBody),
        response: { 200: successResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const body = request.body as z.infer<typeof installCertBody>;

      const stationRows = await db.execute(
        sql`SELECT station_id FROM charging_stations WHERE id = ${id}`,
      );
      const stationRow = stationRows[0];
      if (stationRow == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const commandPayload = JSON.stringify({
        commandId: randomUUID(),
        stationId: stationRow.station_id as string,
        action: 'InstallCertificate',
        payload: {
          certificateType: body.certificateType,
          certificate: body.certificate,
        },
      });

      await getPubSub().publish('ocpp_commands', commandPayload);
      return { success: true };
    },
  );

  app.post(
    '/stations/:id/certificates/delete',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Delete a certificate from a station',
        operationId: 'deleteStationCertificate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(deleteCertBody),
        response: { 200: successResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const body = request.body as z.infer<typeof deleteCertBody>;

      const stationRows = await db.execute(
        sql`SELECT station_id FROM charging_stations WHERE id = ${id}`,
      );
      const stationRow = stationRows[0];
      if (stationRow == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const commandPayload = JSON.stringify({
        commandId: randomUUID(),
        stationId: stationRow.station_id as string,
        action: 'DeleteCertificate',
        payload: {
          certificateHashData: body.certificateHashData,
        },
      });

      await getPubSub().publish('ocpp_commands', commandPayload);
      return { success: true };
    },
  );

  app.post(
    '/stations/:id/certificates/query',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Query installed certificate IDs from a station',
        operationId: 'queryStationCertificates',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(getInstalledCertsBody),
        response: { 200: successResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const body = request.body as z.infer<typeof getInstalledCertsBody>;

      const stationRows = await db.execute(
        sql`SELECT station_id FROM charging_stations WHERE id = ${id}`,
      );
      const stationRow = stationRows[0];
      if (stationRow == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const commandPayload = JSON.stringify({
        commandId: randomUUID(),
        stationId: stationRow.station_id as string,
        action: 'GetInstalledCertificateIds',
        payload: {
          certificateType: body.certificateType,
        },
      });

      await getPubSub().publish('ocpp_commands', commandPayload);
      return { success: true };
    },
  );

  // --- Pricing Groups ---

  app.get(
    '/stations/:id/pricing-groups',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get the pricing group for a station',
        operationId: 'getStationPricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: { 200: itemResponse(stationPricingGroupItem.nullable()), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
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
        .from(pricingGroupStations)
        .innerJoin(pricingGroups, eq(pricingGroupStations.pricingGroupId, pricingGroups.id))
        .where(eq(pricingGroupStations.stationId, id))
        .limit(1);
      return rows[0] ?? null;
    },
  );

  app.post(
    '/stations/:id/pricing-groups',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Assign a pricing group to a station',
        operationId: 'addStationPricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(addStationPricingGroupBody),
        response: { 201: itemResponse(stationPricingGroupRecordItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const body = request.body as z.infer<typeof addStationPricingGroupBody>;
      const [record] = await db
        .insert(pricingGroupStations)
        .values({ stationId: id, pricingGroupId: body.pricingGroupId })
        .onConflictDoUpdate({
          target: [pricingGroupStations.stationId],
          set: { pricingGroupId: body.pricingGroupId, createdAt: new Date() },
        })
        .returning();
      await reply.status(201).send(record);
    },
  );

  app.delete(
    '/stations/:id/pricing-groups/:pricingGroupId',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Remove a pricing group from a station',
        operationId: 'removeStationPricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationPricingGroupParams),
        response: { 200: itemResponse(stationPricingGroupRecordItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id, pricingGroupId } = request.params as z.infer<typeof stationPricingGroupParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const [record] = await db
        .delete(pricingGroupStations)
        .where(
          and(
            eq(pricingGroupStations.stationId, id),
            eq(pricingGroupStations.pricingGroupId, pricingGroupId),
          ),
        )
        .returning();
      if (record == null) {
        await reply
          .status(404)
          .send({ error: 'Pricing group not found for station', code: 'NOT_FOUND' });
        return;
      }
      return record;
    },
  );

  // --- Station approval / rejection ---

  app.post(
    '/stations/:id/approve',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Approve a pending station',
        operationId: 'approveStation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: { 200: successResponse, 404: errorResponse, 409: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const [station] = await db
        .select({ onboardingStatus: chargingStations.onboardingStatus })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (station.onboardingStatus !== 'pending') {
        await reply
          .status(409)
          .send({ error: 'Station is not pending approval', code: 'NOT_PENDING' });
        return;
      }

      await db
        .update(chargingStations)
        .set({ onboardingStatus: 'accepted', updatedAt: new Date() })
        .where(eq(chargingStations.id, id));

      const pubsub = getPubSub();
      await pubsub.publish(
        'csms_events',
        JSON.stringify({ eventType: 'station.status', stationId: id }),
      );

      return { success: true };
    },
  );

  app.post(
    '/stations/:id/unblock',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Unblock a station (sets status to pending)',
        operationId: 'unblockStation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: { 200: successResponse, 404: errorResponse, 409: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;

      const [station] = await db
        .select({ onboardingStatus: chargingStations.onboardingStatus })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (station.onboardingStatus !== 'blocked') {
        await reply.status(409).send({ error: 'Station is not blocked', code: 'NOT_BLOCKED' });
        return;
      }

      await db
        .update(chargingStations)
        .set({ onboardingStatus: 'pending', updatedAt: new Date() })
        .where(eq(chargingStations.id, id));

      const pubsub = getPubSub();
      await pubsub.publish(
        'csms_events',
        JSON.stringify({ eventType: 'station.status', stationId: id }),
      );

      return { success: true };
    },
  );

  app.post(
    '/stations/:id/reject',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Reject a pending station',
        operationId: 'rejectStation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: { 200: successResponse, 404: errorResponse, 409: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const [station] = await db
        .select({ onboardingStatus: chargingStations.onboardingStatus })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (station.onboardingStatus !== 'pending') {
        await reply
          .status(409)
          .send({ error: 'Station is not pending approval', code: 'NOT_PENDING' });
        return;
      }

      await db
        .update(chargingStations)
        .set({ onboardingStatus: 'blocked', updatedAt: new Date() })
        .where(eq(chargingStations.id, id));

      const pubsub = getPubSub();
      await pubsub.publish(
        'csms_events',
        JSON.stringify({ eventType: 'station.status', stationId: id }),
      );

      return { success: true };
    },
  );

  // --- Security events ---

  const securityEventItem = z
    .object({
      id: z.number(),
      stationId: z.string(),
      type: z.string(),
      severity: z.string(),
      timestamp: z.coerce.date(),
      techInfo: z.string().nullable(),
      createdAt: z.coerce.date(),
    })
    .passthrough();

  const securityEventsQuery = paginationQuery.merge(
    z.object({
      severity: z
        .enum(['critical', 'high', 'medium', 'low', 'info'])
        .optional()
        .describe('Filter by severity level'),
    }),
  );

  app.get(
    '/stations/:id/security-events',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List security events for a station',
        operationId: 'listStationSecurityEvents',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(securityEventsQuery),
        response: { 200: paginatedResponse(securityEventItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const query = request.query as z.infer<typeof securityEventsQuery>;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const conditions = [eq(securityEvents.stationId, id)];
      if (query.severity != null) {
        conditions.push(eq(securityEvents.severity, query.severity));
      }
      if (query.search != null && query.search.length > 0) {
        conditions.push(ilike(securityEvents.type, `%${query.search}%`));
      }

      const where = and(...conditions);
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [data, countResult] = await Promise.all([
        db
          .select()
          .from(securityEvents)
          .where(where)
          .orderBy(desc(securityEvents.timestamp))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(securityEvents).where(where),
      ]);

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        typeof data extends (infer U)[] ? U : never
      >;
    },
  );

  // --- Station events ---

  const stationEventItem = z.object({}).passthrough();

  app.get(
    '/stations/:id/events',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List OCPP events for a station',
        operationId: 'listStationEvents',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(stationEventItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const query = request.query as z.infer<typeof paginationQuery>;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const where = eq(stationEvents.stationId, id);
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [data, countResult] = await Promise.all([
        db
          .select()
          .from(stationEvents)
          .where(where)
          .orderBy(desc(stationEvents.generatedAt))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(stationEvents).where(where),
      ]);

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        typeof data extends (infer U)[] ? U : never
      >;
    },
  );

  // --- Station variables ---

  const stationVariableItem = z.object({}).passthrough();

  app.get(
    '/stations/:id/variables',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List reported variables for a station',
        operationId: 'listStationVariables',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(stationVariableItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const query = request.query as z.infer<typeof paginationQuery>;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const conditions = [eq(stationConfigurations.stationId, id)];
      if (query.search != null && query.search.length > 0) {
        const searchCondition = or(
          ilike(stationConfigurations.component, `%${query.search}%`),
          ilike(stationConfigurations.variable, `%${query.search}%`),
        );
        if (searchCondition != null) conditions.push(searchCondition);
      }

      const where = and(...conditions);
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [data, countResult] = await Promise.all([
        db
          .select()
          .from(stationConfigurations)
          .where(where)
          .orderBy(stationConfigurations.component, stationConfigurations.variable)
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(stationConfigurations).where(where),
      ]);

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        typeof data extends (infer U)[] ? U : never
      >;
    },
  );

  // --- Firmware history ---

  const firmwareHistoryItem = z.object({}).passthrough();

  app.get(
    '/stations/:id/firmware-history',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List firmware update history for a station',
        operationId: 'listStationFirmwareHistory',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(firmwareHistoryItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const query = request.query as z.infer<typeof paginationQuery>;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const where = eq(firmwareUpdates.stationId, id);
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [data, countResult] = await Promise.all([
        db
          .select()
          .from(firmwareUpdates)
          .where(where)
          .orderBy(desc(firmwareUpdates.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(firmwareUpdates).where(where),
      ]);

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        typeof data extends (infer U)[] ? U : never
      >;
    },
  );

  // --- Charging profiles ---

  const chargingProfileItem = z.object({}).passthrough();

  app.get(
    '/stations/:id/charging-profiles',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List charging profiles for a station',
        operationId: 'listStationChargingProfiles',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(chargingProfileItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const query = request.query as z.infer<typeof paginationQuery>;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const where = eq(chargingProfiles.stationId, id);
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [data, countResult] = await Promise.all([
        db
          .select()
          .from(chargingProfiles)
          .where(where)
          .orderBy(desc(chargingProfiles.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(chargingProfiles).where(where),
      ]);

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        typeof data extends (infer U)[] ? U : never
      >;
    },
  );

  // POST /stations/:id/charging-profiles/refresh
  app.post(
    '/stations/:id/charging-profiles/refresh',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Refresh charging profiles from the station via OCPP GetChargingProfiles',
        operationId: 'refreshStationChargingProfiles',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: {
          200: successResponse,
          400: errorResponse,
          404: errorResponse,
          502: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const [station] = await db
        .select({
          stationId: chargingStations.stationId,
          isOnline: chargingStations.isOnline,
          ocppProtocol: chargingStations.ocppProtocol,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (!station.isOnline) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      if (station.ocppProtocol === 'ocpp1.6') {
        await reply
          .status(400)
          .send({ error: 'Not supported for OCPP 1.6', code: 'NOT_SUPPORTED' });
        return;
      }

      const payload = {
        requestId: Math.floor(Math.random() * 2147483647),
        chargingProfile: {},
      };
      const result = await sendOcppCommandAndWait(
        station.stationId,
        'GetChargingProfiles',
        payload,
        '2.1',
      );

      if (result.error != null) {
        await reply.status(502).send({ error: result.error, code: 'OCPP_COMMAND_FAILED' });
        return;
      }

      return { success: true };
    },
  );

  // POST /stations/:id/charging-profiles/composite
  const compositeBody = z.object({
    evseId: z.number().int().optional().describe('EVSE ID (defaults to 0)'),
    duration: z.number().int().optional().describe('Duration in seconds (defaults to 86400)'),
    chargingRateUnit: z.string().optional().describe('Charging rate unit (W or A)'),
  });

  app.post(
    '/stations/:id/charging-profiles/composite',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Get composite charging schedule from the station',
        operationId: 'getStationCompositeSchedule',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(compositeBody),
        response: {
          200: itemResponse(z.object({}).passthrough()),
          400: errorResponse,
          404: errorResponse,
          502: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const body = request.body as z.infer<typeof compositeBody>;

      const [station] = await db
        .select({
          stationId: chargingStations.stationId,
          isOnline: chargingStations.isOnline,
          ocppProtocol: chargingStations.ocppProtocol,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (!station.isOnline) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      const version = station.ocppProtocol === 'ocpp1.6' ? '1.6' : '2.1';
      const payload = {
        evseId: body.evseId ?? 0,
        duration: body.duration ?? 86400,
        chargingRateUnit: body.chargingRateUnit,
      };

      const result = await sendOcppCommandAndWait(
        station.stationId,
        'GetCompositeSchedule',
        payload,
        version,
      );

      if (result.error != null) {
        await reply.status(502).send({ error: result.error, code: 'OCPP_COMMAND_FAILED' });
        return;
      }

      return result.response ?? {};
    },
  );

  // POST /stations/:id/charging-profiles/clear
  const clearProfileBody = z.object({
    chargingProfileId: z
      .number()
      .int()
      .optional()
      .describe('Specific charging profile ID to clear'),
    chargingProfilePurpose: z.string().optional().describe('Clear all profiles with this purpose'),
    stackLevel: z.number().int().optional().describe('Stack level to clear'),
    evseId: z.number().int().optional().describe('EVSE ID to clear profiles for'),
  });

  app.post(
    '/stations/:id/charging-profiles/clear',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Clear charging profiles from the station',
        operationId: 'clearStationChargingProfiles',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(clearProfileBody),
        response: {
          200: itemResponse(z.object({}).passthrough()),
          400: errorResponse,
          404: errorResponse,
          502: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const body = request.body as z.infer<typeof clearProfileBody>;

      const [station] = await db
        .select({
          stationId: chargingStations.stationId,
          isOnline: chargingStations.isOnline,
          ocppProtocol: chargingStations.ocppProtocol,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (!station.isOnline) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      const version = station.ocppProtocol === 'ocpp1.6' ? '1.6' : '2.1';
      const result = await sendOcppCommandAndWait(
        station.stationId,
        'ClearChargingProfile',
        body,
        version,
      );

      if (result.error != null) {
        await reply.status(502).send({ error: result.error, code: 'OCPP_COMMAND_FAILED' });
        return;
      }

      return result.response ?? { success: true };
    },
  );

  // POST /stations/:id/charging-profiles/push
  const pushChargingProfileBody = z.object({
    templateId: z.string().min(1).describe('Charging profile template ID'),
  });

  app.post(
    '/stations/:id/charging-profiles/push',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Push a charging profile template to this station',
        operationId: 'pushStationChargingProfile',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(pushChargingProfileBody),
        response: {
          200: itemResponse(
            z
              .object({
                success: z.boolean(),
                status: z.string(),
                errorInfo: z.string().optional(),
              })
              .passthrough(),
          ),
          400: errorResponse,
          404: errorResponse,
          502: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const body = request.body as z.infer<typeof pushChargingProfileBody>;

      const [station] = await db
        .select({
          stationId: chargingStations.stationId,
          isOnline: chargingStations.isOnline,
          ocppProtocol: chargingStations.ocppProtocol,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (!station.isOnline) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      const [template] = await db
        .select()
        .from(chargingProfileTemplates)
        .where(eq(chargingProfileTemplates.id, body.templateId));

      if (template == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      const version = station.ocppProtocol === 'ocpp1.6' ? '1.6' : '2.1';

      // Best-effort clear existing profile with same purpose/stackLevel/evseId
      try {
        await sendOcppCommandAndWait(
          station.stationId,
          'ClearChargingProfile',
          {
            chargingProfilePurpose: template.profilePurpose,
            stackLevel: template.stackLevel,
            evseId: template.evseId,
          },
          version,
        );
      } catch {
        // Non-critical: clear failure should not block set
      }

      // Build SetChargingProfile payload
      const payload = {
        evseId: template.evseId,
        chargingProfile: {
          id: template.profileId,
          stackLevel: template.stackLevel,
          chargingProfilePurpose: template.profilePurpose,
          chargingProfileKind: template.profileKind,
          recurrencyKind: template.recurrencyKind || undefined,
          validFrom: template.validFrom?.toISOString() || undefined,
          validTo: template.validTo?.toISOString() || undefined,
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: template.chargingRateUnit,
              startSchedule: template.startSchedule?.toISOString() || undefined,
              duration: template.duration || undefined,
              chargingSchedulePeriod: template.schedulePeriods,
            },
          ],
        },
      };

      const result = await sendOcppCommandAndWait(
        station.stationId,
        'SetChargingProfile',
        payload,
        version,
      );

      if (result.error != null) {
        return { success: false, status: 'Failed', errorInfo: result.error };
      }

      const response = result.response as { status?: string } | undefined;
      const status = response?.status ?? 'Unknown';
      return {
        success: status === 'Accepted',
        status,
        errorInfo: status !== 'Accepted' ? status : undefined,
      };
    },
  );

  // POST /stations/:id/configurations/push
  const pushConfigBody = z.object({
    templateId: z.string().min(1).describe('Configuration template ID'),
  });

  app.post(
    '/stations/:id/configurations/push',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Push a configuration template to this station',
        operationId: 'pushStationConfiguration',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(pushConfigBody),
        response: {
          200: itemResponse(
            z
              .object({
                success: z.boolean(),
                results: z.array(
                  z.object({ variable: z.string(), status: z.string() }).passthrough(),
                ),
              })
              .passthrough(),
          ),
          400: errorResponse,
          404: errorResponse,
          502: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const body = request.body as z.infer<typeof pushConfigBody>;

      const [station] = await db
        .select({
          stationId: chargingStations.stationId,
          isOnline: chargingStations.isOnline,
          ocppProtocol: chargingStations.ocppProtocol,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (!station.isOnline) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      const [template] = await db
        .select()
        .from(configTemplates)
        .where(eq(configTemplates.id, body.templateId));

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
        return { success: true, results: [] };
      }

      const ocppVersion = station.ocppProtocol === 'ocpp1.6' ? '1.6' : '2.1';
      const results: Array<{ variable: string; status: string }> = [];
      let hasFailure = false;

      if (ocppVersion === '1.6') {
        // OCPP 1.6: one SetVariables per variable
        for (const v of variables) {
          const result = await sendOcppCommandAndWait(
            station.stationId,
            'SetVariables',
            {
              setVariableData: [
                {
                  component: { name: v.component },
                  variable: { name: v.variable },
                  attributeValue: v.value,
                },
              ],
            },
            ocppVersion,
          );

          if (result.error != null) {
            results.push({ variable: `${v.component}.${v.variable}`, status: result.error });
            hasFailure = true;
          } else {
            const setResult = result.response as {
              setVariableResult?: Array<{ attributeStatus?: string }>;
              status?: string;
            };
            const status =
              setResult.setVariableResult?.[0]?.attributeStatus ?? setResult.status ?? 'Unknown';
            results.push({ variable: `${v.component}.${v.variable}`, status });
            if (status !== 'Accepted') hasFailure = true;
          }
        }
      } else {
        // OCPP 2.1: bulk SetVariables
        const result = await sendOcppCommandAndWait(
          station.stationId,
          'SetVariables',
          {
            setVariableData: variables.map((v) => ({
              component: { name: v.component },
              variable: { name: v.variable },
              attributeValue: v.value,
            })),
          },
          ocppVersion,
        );

        if (result.error != null) {
          for (const v of variables) {
            results.push({ variable: `${v.component}.${v.variable}`, status: result.error });
          }
          hasFailure = true;
        } else {
          const response = result.response as {
            setVariableResult?: Array<{
              attributeStatus?: string;
              component?: { name?: string };
              variable?: { name?: string };
            }>;
          };
          const setResults = response.setVariableResult ?? [];
          for (const r of setResults) {
            const varName = `${r.component?.name ?? ''}.${r.variable?.name ?? ''}`;
            const status = r.attributeStatus ?? 'Unknown';
            results.push({ variable: varName, status });
            if (status !== 'Accepted') hasFailure = true;
          }
        }
      }

      // After push, refresh station configurations
      try {
        if (ocppVersion === '1.6') {
          await sendOcppCommandAndWait(station.stationId, 'GetConfiguration', {}, ocppVersion);
        } else {
          await sendOcppCommandAndWait(
            station.stationId,
            'GetBaseReport',
            {
              requestId: Math.floor(Math.random() * 2147483647),
              reportBase: 'FullInventory',
            },
            ocppVersion,
          );
        }
      } catch {
        // Non-critical
      }

      return { success: !hasFailure, results };
    },
  );

  // --- EV Charging Needs ---

  const evChargingNeedsItem = z.object({}).passthrough();

  app.get(
    '/stations/:id/ev-charging-needs',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List EV charging needs for a station',
        operationId: 'listStationEvChargingNeeds',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: { 200: arrayResponse(evChargingNeedsItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const data = await db
        .select()
        .from(evChargingNeeds)
        .where(eq(evChargingNeeds.stationId, id))
        .orderBy(desc(evChargingNeeds.updatedAt));

      return data;
    },
  );

  // --- Variable Monitoring Rules ---

  const monitoringRuleItem = z.object({}).passthrough();

  const createMonitoringRuleBody = z.object({
    component: z.string().min(1).describe('OCPP component name'),
    variable: z.string().min(1).describe('OCPP variable name'),
    type: z
      .string()
      .min(1)
      .describe('Monitor type (e.g., UpperThreshold, LowerThreshold, Delta, Periodic)'),
    value: z.number().describe('Threshold value or interval'),
    severity: z.number().int().min(0).max(9).default(0).describe('OCPP severity level 0-9'),
  });

  app.get(
    '/stations/:id/monitoring-rules',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List variable monitoring rules for a station',
        operationId: 'listStationMonitoringRules',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(monitoringRuleItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const query = request.query as z.infer<typeof paginationQuery>;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const where = eq(variableMonitoringRules.stationId, id);
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [data, countResult] = await Promise.all([
        db
          .select()
          .from(variableMonitoringRules)
          .where(where)
          .orderBy(desc(variableMonitoringRules.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(variableMonitoringRules).where(where),
      ]);

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        typeof data extends (infer U)[] ? U : never
      >;
    },
  );

  app.post(
    '/stations/:id/monitoring-rules',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Create a variable monitoring rule and dispatch SetVariableMonitoring',
        operationId: 'createStationMonitoringRule',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(createMonitoringRuleBody),
        response: {
          201: itemResponse(monitoringRuleItem),
          404: errorResponse,
          502: errorResponse,
          504: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const body = request.body as z.infer<typeof createMonitoringRuleBody>;

      const [station] = await db
        .select({ id: chargingStations.id, stationId: chargingStations.stationId })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Insert the rule in pending state
      const [rule] = await db
        .insert(variableMonitoringRules)
        .values({
          stationId: id,
          component: body.component,
          variable: body.variable,
          type: body.type,
          value: String(body.value),
          severity: body.severity,
          status: 'pending',
        })
        .returning();

      // Dispatch SetVariableMonitoring OCPP command
      const commandPayload = {
        commandId: randomUUID(),
        stationId: station.stationId,
        action: 'SetVariableMonitoring',
        payload: {
          setMonitoringData: [
            {
              component: { name: body.component },
              variable: { name: body.variable },
              type: body.type,
              value: body.value,
              severity: body.severity,
            },
          ],
        },
      };

      try {
        const pubsub = (await import('../lib/pubsub.js')).getPubSub();
        await pubsub.publish('ocpp_commands', JSON.stringify(commandPayload));
      } catch {
        // Command dispatch is best-effort; rule is still created
      }

      return reply.status(201).send(rule);
    },
  );

  const monitoringRuleIdParams = z.object({
    id: z.string().describe('Station ID'),
    ruleId: z.coerce.number().int().describe('Monitoring rule ID'),
  });

  app.delete(
    '/stations/:id/monitoring-rules/:ruleId',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Delete a variable monitoring rule and dispatch ClearVariableMonitoring',
        operationId: 'deleteStationMonitoringRule',
        security: [{ bearerAuth: [] }],
        params: zodSchema(monitoringRuleIdParams),
        response: { 204: { type: 'null' as const }, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id, ruleId } = request.params as z.infer<typeof monitoringRuleIdParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const [rule] = await db
        .select()
        .from(variableMonitoringRules)
        .where(
          and(eq(variableMonitoringRules.id, ruleId), eq(variableMonitoringRules.stationId, id)),
        );
      if (rule == null) {
        await reply
          .status(404)
          .send({ error: 'Monitoring rule not found', code: 'RULE_NOT_FOUND' });
        return;
      }

      // If the rule has a monitoringId from the station, dispatch ClearVariableMonitoring
      if (rule.monitoringId != null) {
        const [station] = await db
          .select({ stationId: chargingStations.stationId })
          .from(chargingStations)
          .where(eq(chargingStations.id, id));

        if (station != null) {
          const commandPayload = {
            commandId: randomUUID(),
            stationId: station.stationId,
            action: 'ClearVariableMonitoring',
            payload: { id: [rule.monitoringId] },
          };

          try {
            const pubsub = (await import('../lib/pubsub.js')).getPubSub();
            await pubsub.publish('ocpp_commands', JSON.stringify(commandPayload));
          } catch {
            // Best-effort
          }
        }
      }

      // Mark as cleared
      await db
        .update(variableMonitoringRules)
        .set({ status: 'cleared', updatedAt: new Date() })
        .where(eq(variableMonitoringRules.id, ruleId));

      return reply.status(204).send();
    },
  );

  // --- Event Alerts ---

  const eventAlertItem = z.object({}).passthrough();

  const eventAlertsQuery = paginationQuery.extend({
    severity: z.coerce.number().int().min(0).max(9).optional().describe('Filter by max severity'),
    acknowledged: z.enum(['true', 'false']).optional().describe('Filter by acknowledged status'),
  });

  app.get(
    '/stations/:id/event-alerts',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List event alerts for a station',
        operationId: 'listStationEventAlerts',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(eventAlertsQuery),
        response: { 200: paginatedResponse(eventAlertItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const query = request.query as z.infer<typeof eventAlertsQuery>;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const conditions = [eq(eventAlerts.stationId, id)];
      if (query.severity != null) {
        conditions.push(sql`${eventAlerts.severity} <= ${query.severity}`);
      }
      if (query.acknowledged === 'true') {
        conditions.push(isNotNull(eventAlerts.acknowledgedAt));
      } else if (query.acknowledged === 'false') {
        conditions.push(sql`${eventAlerts.acknowledgedAt} IS NULL`);
      }

      const where = and(...conditions);
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [data, countResult] = await Promise.all([
        db
          .select()
          .from(eventAlerts)
          .where(where)
          .orderBy(desc(eventAlerts.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(eventAlerts).where(where),
      ]);

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        typeof data extends (infer U)[] ? U : never
      >;
    },
  );

  const alertIdParams = z.object({
    id: ID_PARAMS.stationId.describe('Station ID'),
    alertId: z.coerce.number().int().describe('Alert ID'),
  });

  app.post(
    '/stations/:id/event-alerts/:alertId/acknowledge',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Acknowledge an event alert',
        operationId: 'acknowledgeEventAlert',
        security: [{ bearerAuth: [] }],
        params: zodSchema(alertIdParams),
        response: { 200: successResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id, alertId } = request.params as z.infer<typeof alertIdParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const [updated] = await db
        .update(eventAlerts)
        .set({
          acknowledgedAt: new Date(),
          acknowledgedBy: userId,
        })
        .where(and(eq(eventAlerts.id, alertId), eq(eventAlerts.stationId, id)))
        .returning({ id: eventAlerts.id });

      if (updated == null) {
        await reply.status(404).send({ error: 'Alert not found', code: 'ALERT_NOT_FOUND' });
        return;
      }

      return { success: true as const };
    },
  );

  // Standalone meter values (not linked to a session)
  app.get(
    '/stations/:id/standalone-meter-values',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List standalone meter values for a station',
        operationId: 'listStationMeterValues',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(stationMeterValueQuery),
        response: { 200: paginatedResponse(stationMeterValueItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const { page, limit, measurand } = request.query as z.infer<typeof stationMeterValueQuery>;
      const offset = (page - 1) * limit;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, id))
        .limit(1);

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const conditions = [eq(meterValues.stationId, id), isNull(meterValues.sessionId)];
      if (measurand != null) {
        conditions.push(eq(meterValues.measurand, measurand));
      }
      const where = and(...conditions);

      const [data, countRows] = await Promise.all([
        db
          .select({
            id: meterValues.id,
            timestamp: meterValues.timestamp,
            measurand: meterValues.measurand,
            value: meterValues.value,
            unit: meterValues.unit,
            phase: meterValues.phase,
            location: meterValues.location,
            context: meterValues.context,
          })
          .from(meterValues)
          .where(where)
          .orderBy(desc(meterValues.timestamp))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(meterValues)
          .where(where),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );
}
