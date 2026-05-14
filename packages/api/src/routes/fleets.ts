// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as fleetService from '../services/fleet.service.js';
import { db, writeAudit, fleetAuditLog, pricingAssignmentAuditLog } from '@evtivity/database';
import { getAuditActor } from '../lib/audit-actor.js';
import type { JwtPayload } from '../plugins/auth.js';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import { authorize } from '../middleware/rbac.js';
import {
  paginatedResponse,
  itemResponse,
  arrayResponse,
  errorWith,
} from '../lib/response-schemas.js';

import { ERROR_CODES } from '../lib/error-codes.generated.js';
const fleetListItem = z
  .object({
    id: z.string().describe('Fleet identifier'),
    name: z.string().max(255).describe('Fleet display name'),
    description: z.string().max(1000).nullable().describe('Fleet description'),
    createdAt: z.coerce.date().describe('Timestamp when the fleet was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the fleet was last updated'),
    driverCount: z.number().int().min(0).describe('Number of drivers in this fleet'),
    stationCount: z.number().int().min(0).describe('Number of stations assigned to this fleet'),
  })
  .passthrough();

const fleetItem = z
  .object({
    id: z.string().describe('Fleet identifier'),
    name: z.string().max(255).describe('Fleet display name'),
    description: z.string().max(1000).nullable().describe('Fleet description'),
    createdAt: z.coerce.date().describe('Timestamp when the fleet was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the fleet was last updated'),
  })
  .passthrough();

const fleetDriverItem = z
  .object({
    id: z.string().describe('Driver identifier'),
    firstName: z.string().max(100).nullable().describe('Driver first name'),
    lastName: z.string().max(100).nullable().describe('Driver last name'),
    email: z.string().email().max(255).nullable().describe('Driver email address'),
    phone: z.string().max(50).nullable().describe('Driver phone number in E.164 format'),
    isActive: z.boolean().describe('Whether the driver account is enabled'),
    createdAt: z.coerce.date().describe('Timestamp when the driver was created'),
  })
  .passthrough();

const fleetDriverRecordItem = z
  .object({
    fleetId: z.string().describe('Fleet identifier'),
    driverId: z.string().describe('Driver identifier'),
  })
  .passthrough();

const fleetStationItem = z
  .object({
    id: z.string().describe('Station identifier'),
    stationId: z.string().max(255).describe('Station OCPP id (display label)'),
    siteId: z.string().nullable().describe('Site identifier the station belongs to'),
    model: z.string().max(100).nullable().describe('Station hardware model'),
    securityProfile: z
      .number()
      .int()
      .min(0)
      .max(3)
      .nullable()
      .describe('OCPP security profile (0=none, 1=basic, 2=basic+TLS, 3=mTLS)'),
    ocppProtocol: z
      .enum(['ocpp1.6', 'ocpp2.1'])
      .nullable()
      .describe('OCPP protocol version negotiated with the station'),
    status: z.string().max(50).describe('Station availability status'),
    connectorCount: z.number().int().min(0).describe('Total number of connectors on the station'),
    connectorTypes: z
      .array(z.string().max(50))
      .max(20)
      .nullable()
      .describe('Unique connector types present on the station (e.g. CCS2, Type2)'),
    isOnline: z.boolean().describe('Whether the station currently has an active OCPP connection'),
    lastHeartbeat: z.coerce
      .date()
      .nullable()
      .describe('Timestamp of the most recent OCPP heartbeat'),
  })
  .passthrough();

const fleetStationRecordItem = z
  .object({
    fleetId: z.string().describe('Fleet identifier'),
    stationId: z.string().describe('Station identifier'),
  })
  .passthrough();

const fleetVehicleItem = z
  .object({
    id: z.string().describe('Vehicle identifier'),
    driverId: z.string().describe('Owning driver identifier'),
    driverName: z.string().max(255).describe('Owning driver full name'),
    make: z.string().max(100).nullable().describe('Vehicle make (e.g. Tesla, BMW)'),
    model: z.string().max(100).nullable().describe('Vehicle model (e.g. Model 3, i4)'),
    year: z
      .string()
      .regex(/^\d{4}$/)
      .nullable()
      .describe('Model year (4-digit)'),
    vin: z.string().max(17).nullable().describe('Vehicle identification number (17 chars)'),
    licensePlate: z.string().max(20).nullable().describe('Vehicle license plate'),
  })
  .passthrough();

const fleetSessionItem = z
  .object({
    id: z.string().describe('Charging session identifier'),
    stationId: z.string().describe('Station identifier where the session occurred'),
    stationName: z.string().max(255).nullable().describe('Station OCPP id (display label)'),
    siteName: z.string().max(255).nullable().describe('Site name where the station is located'),
    transactionId: z.string().nullable().describe('OCPP transaction identifier'),
    status: z
      .string()
      .max(50)
      .describe('Session status (active, completed, failed, faulted, etc.)'),
    startedAt: z.coerce.date().nullable().describe('Timestamp when the session started'),
    endedAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp when the session ended, null if active'),
    idleStartedAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp when the connector went idle during the session'),
    energyDeliveredWh: z.number().min(0).describe('Total energy delivered in watt-hours'),
    currentCostCents: z
      .number()
      .int()
      .min(0)
      .describe('Running cost in cents during active session'),
    finalCostCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Final billed cost in cents after session completes'),
    currency: z.string().length(3).nullable().describe('ISO 4217 currency code (USD, EUR, etc.)'),
  })
  .passthrough();

const fleetMetricsItem = z
  .object({
    totalSessions: z
      .number()
      .int()
      .min(0)
      .describe('Total number of charging sessions in the reporting period'),
    completedSessions: z
      .number()
      .int()
      .min(0)
      .describe('Number of sessions that completed successfully'),
    faultedSessions: z
      .number()
      .int()
      .min(0)
      .describe('Number of sessions that ended in a fault state'),
    sessionSuccessPercent: z
      .number()
      .min(0)
      .max(100)
      .describe('Percentage of sessions that completed successfully (0-100)'),
    totalEnergyWh: z.number().min(0).describe('Total energy delivered in watt-hours'),
    avgSessionDurationMinutes: z.number().min(0).describe('Average session duration in minutes'),
    activeDrivers: z
      .number()
      .int()
      .min(0)
      .describe('Number of drivers with at least one session in the period'),
    totalDrivers: z.number().int().min(0).describe('Total number of drivers in this fleet'),
    totalVehicles: z.number().describe('Total number of vehicles owned by fleet drivers'),
    periodMonths: z.number().describe('Number of months included in the metrics window'),
  })
  .passthrough();

const energyHistoryItem = z
  .object({
    date: z.string().describe('Day in ISO date format (YYYY-MM-DD)'),
    energyWh: z.number().describe('Total energy delivered on this day in watt-hours'),
  })
  .passthrough();

const fleetPricingGroupItem = z
  .object({
    id: z.string().describe('Pricing group identifier'),
    name: z.string().describe('Pricing group display name'),
    description: z.string().nullable().describe('Pricing group description'),
    isDefault: z.boolean().describe('Whether this is the system default pricing group'),
    tariffCount: z.number().describe('Number of tariffs in this pricing group'),
  })
  .passthrough();

const fleetPricingGroupRecordItem = z
  .object({
    fleetId: z.string().describe('Fleet identifier'),
    pricingGroupId: z.string().describe('Pricing group identifier'),
  })
  .passthrough();

const fleetParams = z.object({
  id: ID_PARAMS.fleetId.describe('Fleet ID'),
});

const createFleetBody = z.object({
  name: z.string().max(255),
  description: z.string().max(500).optional(),
});

const updateFleetBody = z.object({
  name: z.string().max(255).optional(),
  description: z.string().max(500).optional(),
});

const addDriverBody = z.object({
  driverId: ID_PARAMS.driverId.describe('Driver ID to add to the fleet'),
});

const driverParams = z.object({
  id: ID_PARAMS.fleetId.describe('Fleet ID'),
  driverId: ID_PARAMS.driverId.describe('Driver ID'),
});

const addStationBody = z.object({
  stationId: ID_PARAMS.stationId.describe('Station ID to add to the fleet'),
});

const stationParams = z.object({
  id: ID_PARAMS.fleetId.describe('Fleet ID'),
  stationId: ID_PARAMS.stationId.describe('Station ID'),
});

const addPricingGroupBody = z.object({
  pricingGroupId: ID_PARAMS.pricingGroupId.describe('Pricing group ID to add to the fleet'),
});

const pricingGroupParams = z.object({
  id: ID_PARAMS.fleetId.describe('Fleet ID'),
  pricingGroupId: ID_PARAMS.pricingGroupId.describe('Pricing group ID'),
});

const sessionsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1).describe('Page number'),
  limit: z.coerce.number().int().min(1).max(100).default(10).describe('Items per page'),
});

const metricsQuery = z.object({
  months: z.coerce
    .number()
    .int()
    .min(1)
    .max(24)
    .default(12)
    .describe('Number of months to include in metrics'),
});

const energyHistoryQuery = z.object({
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(90)
    .default(7)
    .describe('Number of days of energy history'),
});

export function fleetRoutes(app: FastifyInstance): void {
  app.get(
    '/fleets',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'List fleets',
        operationId: 'listFleets',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(fleetListItem) },
      },
    },
    async (request) => {
      const params = request.query as z.infer<typeof paginationQuery>;
      return fleetService.listFleets(params);
    },
  );

  app.get(
    '/fleets/:id',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'Get a fleet by ID',
        operationId: 'getFleet',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        response: {
          200: itemResponse(fleetItem),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const fleet = await fleetService.getFleet(id);
      if (fleet == null) {
        await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
        return;
      }
      return fleet;
    },
  );

  app.post(
    '/fleets',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Create a fleet',
        operationId: 'createFleet',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createFleetBody),
        response: { 201: itemResponse(fleetItem) },
      },
    },
    async (request, reply) => {
      const { name, description } = request.body as z.infer<typeof createFleetBody>;
      const fleet = await fleetService.createFleet({
        name,
        ...(description != null ? { description } : {}),
      });
      if (fleet != null) {
        const actor = getAuditActor(request);
        await writeAudit(
          { table: fleetAuditLog, idColumn: 'fleet_id' },
          {
            entityId: fleet.id,
            entityIdSnapshot: fleet.id,
            action: 'created',
            ...actor,
            after: fleet,
          },
          db,
          request.log,
        );
      }
      await reply.status(201).send(fleet);
    },
  );

  app.patch(
    '/fleets/:id',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Update a fleet',
        operationId: 'updateFleet',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        body: zodSchema(updateFleetBody),
        response: {
          200: itemResponse(fleetItem),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { name, description } = request.body as z.infer<typeof updateFleetBody>;
      const before = await fleetService.getFleet(id);
      const fleet = await fleetService.updateFleet(id, {
        ...(name != null ? { name } : {}),
        ...(description != null ? { description } : {}),
      });
      if (fleet == null) {
        await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
        return;
      }
      const actor = getAuditActor(request);
      await writeAudit(
        { table: fleetAuditLog, idColumn: 'fleet_id' },
        {
          entityId: fleet.id,
          entityIdSnapshot: fleet.id,
          action: 'updated',
          ...actor,
          before: before ?? null,
          after: fleet,
        },
        db,
        request.log,
      );
      return fleet;
    },
  );

  app.delete(
    '/fleets/:id',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Delete a fleet',
        operationId: 'deleteFleet',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        response: {
          200: itemResponse(fleetItem),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const fleet = await fleetService.deleteFleet(id);
      if (fleet == null) {
        await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
        return;
      }
      const actor = getAuditActor(request);
      await writeAudit(
        { table: fleetAuditLog, idColumn: 'fleet_id' },
        {
          entityId: null,
          entityIdSnapshot: fleet.id,
          action: 'deleted',
          ...actor,
          before: fleet,
        },
        db,
        request.log,
      );
      return fleet;
    },
  );

  // --- Drivers ---

  app.get(
    '/fleets/:id/drivers',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'List drivers in a fleet',
        operationId: 'listFleetDrivers',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(sessionsQuery),
        response: { 200: paginatedResponse(fleetDriverItem) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { page, limit } = request.query as z.infer<typeof sessionsQuery>;
      return fleetService.getFleetDrivers(id, page, limit);
    },
  );

  app.post(
    '/fleets/:id/drivers',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Add a driver to a fleet',
        operationId: 'addFleetDriver',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        body: zodSchema(addDriverBody),
        response: { 201: itemResponse(fleetDriverRecordItem) },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const body = request.body as z.infer<typeof addDriverBody>;
      const record = await fleetService.addDriverToFleet(id, body.driverId);
      const actor = getAuditActor(request);
      await writeAudit(
        { table: fleetAuditLog, idColumn: 'fleet_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'member_added',
          ...actor,
          after: { driverId: body.driverId },
        },
        db,
        request.log,
      );
      await reply.status(201).send(record);
    },
  );

  app.delete(
    '/fleets/:id/drivers/:driverId',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Remove a driver from a fleet',
        operationId: 'removeFleetDriver',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        response: {
          200: itemResponse(fleetDriverRecordItem),
          404: errorWith('Resource not found', [ERROR_CODES.NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, driverId } = request.params as z.infer<typeof driverParams>;
      const record = await fleetService.removeDriverFromFleet(id, driverId);
      if (record == null) {
        await reply
          .status(404)
          .send({ error: 'Driver not found in fleet', code: 'DRIVER_NOT_FOUND' });
        return;
      }
      const actor = getAuditActor(request);
      await writeAudit(
        { table: fleetAuditLog, idColumn: 'fleet_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'member_removed',
          ...actor,
          before: { driverId },
        },
        db,
        request.log,
      );
      return record;
    },
  );

  // --- Stations ---

  app.get(
    '/fleets/:id/stations',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'List stations in a fleet',
        operationId: 'listFleetStations',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        response: { 200: arrayResponse(fleetStationItem) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      return fleetService.getFleetStations(id);
    },
  );

  app.post(
    '/fleets/:id/stations',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Add a station to a fleet',
        operationId: 'addFleetStation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        body: zodSchema(addStationBody),
        response: { 201: itemResponse(fleetStationRecordItem) },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const body = request.body as z.infer<typeof addStationBody>;
      const record = await fleetService.addStationToFleet(id, body.stationId);
      const actor = getAuditActor(request);
      await writeAudit(
        { table: fleetAuditLog, idColumn: 'fleet_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'station_added',
          ...actor,
          after: { stationId: body.stationId },
        },
        db,
        request.log,
      );
      await reply.status(201).send(record);
    },
  );

  app.delete(
    '/fleets/:id/stations/:stationId',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Remove a station from a fleet',
        operationId: 'removeFleetStation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: {
          200: itemResponse(fleetStationRecordItem),
          404: errorWith('Resource not found', [ERROR_CODES.NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, stationId } = request.params as z.infer<typeof stationParams>;
      const record = await fleetService.removeStationFromFleet(id, stationId);
      if (record == null) {
        await reply
          .status(404)
          .send({ error: 'Station not found in fleet', code: 'STATION_NOT_FOUND' });
        return;
      }
      const actor = getAuditActor(request);
      await writeAudit(
        { table: fleetAuditLog, idColumn: 'fleet_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'station_removed',
          ...actor,
          before: { stationId },
        },
        db,
        request.log,
      );
      return record;
    },
  );

  // --- Vehicles ---

  app.get(
    '/fleets/:id/vehicles',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'List vehicles in a fleet',
        operationId: 'listFleetVehicles',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(sessionsQuery),
        response: { 200: paginatedResponse(fleetVehicleItem) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { page, limit } = request.query as z.infer<typeof sessionsQuery>;
      return fleetService.getFleetVehicles(id, page, limit);
    },
  );

  app.get(
    '/fleets/:id/vehicles/available',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'Search vehicles not in fleet',
        operationId: 'listAvailableFleetVehicles',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(
          z.object({
            search: z.string().default(''),
            limit: z.coerce.number().int().min(1).max(100).default(10),
          }),
        ),
        response: { 200: arrayResponse(fleetVehicleItem) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { search, limit } = request.query as { search: string; limit: number };
      return fleetService.searchAvailableVehicles(id, search, limit);
    },
  );

  // --- Sessions ---

  app.get(
    '/fleets/:id/sessions',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'List charging sessions for a fleet',
        operationId: 'listFleetSessions',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(sessionsQuery),
        response: { 200: paginatedResponse(fleetSessionItem) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { page, limit } = request.query as z.infer<typeof sessionsQuery>;
      return fleetService.getFleetSessions(id, page, limit);
    },
  );

  // --- Metrics ---

  app.get(
    '/fleets/:id/metrics',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'Get fleet metrics',
        operationId: 'getFleetMetrics',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(metricsQuery),
        response: { 200: itemResponse(fleetMetricsItem) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { months } = request.query as z.infer<typeof metricsQuery>;
      return fleetService.getFleetMetrics(id, months);
    },
  );

  // --- Energy History ---

  app.get(
    '/fleets/:id/energy-history',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'Get fleet energy delivery history',
        operationId: 'getFleetEnergyHistory',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(energyHistoryQuery),
        response: { 200: arrayResponse(energyHistoryItem) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { days } = request.query as z.infer<typeof energyHistoryQuery>;
      return fleetService.getFleetEnergyHistory(id, days);
    },
  );

  // --- Pricing Groups ---

  app.get(
    '/fleets/:id/pricing-groups',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'Get the pricing group for a fleet',
        operationId: 'getFleetPricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        response: { 200: itemResponse(fleetPricingGroupItem.nullable()) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      return fleetService.getFleetPricingGroup(id);
    },
  );

  app.post(
    '/fleets/:id/pricing-groups',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Add a pricing group to a fleet',
        operationId: 'addFleetPricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        body: zodSchema(addPricingGroupBody),
        response: { 201: itemResponse(fleetPricingGroupRecordItem) },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { userId } = request.user as JwtPayload;
      const body = request.body as z.infer<typeof addPricingGroupBody>;
      const previous = await fleetService.getFleetPricingGroup(id);
      const record = await fleetService.addPricingGroupToFleet(id, body.pricingGroupId);
      await writeAudit(
        { table: pricingAssignmentAuditLog, idColumn: 'pricing_assignment_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: previous == null ? 'created' : 'updated',
          actor: 'operator',
          actorUserId: userId,
          before:
            previous == null ? null : { scope: 'fleet', fleetId: id, pricingGroupId: previous.id },
          after: { scope: 'fleet', fleetId: id, pricingGroupId: body.pricingGroupId },
        },
        db,
        request.log,
      );
      const actor = getAuditActor(request);
      await writeAudit(
        { table: fleetAuditLog, idColumn: 'fleet_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'pricing_assignment_changed',
          ...actor,
          before: previous == null ? null : { pricingGroupId: previous.id },
          after: { pricingGroupId: body.pricingGroupId },
        },
        db,
        request.log,
      );
      await reply.status(201).send(record);
    },
  );

  app.delete(
    '/fleets/:id/pricing-groups/:pricingGroupId',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Remove a pricing group from a fleet',
        operationId: 'removeFleetPricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(pricingGroupParams),
        response: {
          200: itemResponse(fleetPricingGroupRecordItem),
          404: errorWith('Resource not found', [ERROR_CODES.NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, pricingGroupId } = request.params as z.infer<typeof pricingGroupParams>;
      const { userId } = request.user as JwtPayload;
      const record = await fleetService.removePricingGroupFromFleet(id, pricingGroupId);
      if (record == null) {
        await reply
          .status(404)
          .send({ error: 'Pricing group not found for fleet', code: 'NOT_FOUND' });
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
          before: { scope: 'fleet', fleetId: id, pricingGroupId },
        },
        db,
        request.log,
      );
      const actor = getAuditActor(request);
      await writeAudit(
        { table: fleetAuditLog, idColumn: 'fleet_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'pricing_assignment_changed',
          ...actor,
          before: { pricingGroupId },
        },
        db,
        request.log,
      );
      return record;
    },
  );
}
