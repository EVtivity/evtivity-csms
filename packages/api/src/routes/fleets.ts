// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as fleetService from '../services/fleet.service.js';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import { authorize } from '../middleware/rbac.js';
import {
  errorResponse,
  paginatedResponse,
  itemResponse,
  arrayResponse,
} from '../lib/response-schemas.js';

const fleetListItem = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    driverCount: z.number(),
    stationCount: z.number(),
  })
  .passthrough();

const fleetItem = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .passthrough();

const fleetDriverItem = z
  .object({
    id: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    isActive: z.boolean(),
    createdAt: z.coerce.date(),
  })
  .passthrough();

const fleetDriverRecordItem = z.object({ fleetId: z.string(), driverId: z.string() }).passthrough();

const fleetStationItem = z
  .object({
    id: z.string(),
    stationId: z.string(),
    siteId: z.string().nullable(),
    model: z.string().nullable(),
    securityProfile: z.number().nullable(),
    ocppProtocol: z.string().nullable(),
    status: z.string(),
    connectorCount: z.number(),
    connectorTypes: z.array(z.string()).nullable(),
    isOnline: z.boolean(),
    lastHeartbeat: z.coerce.date().nullable(),
  })
  .passthrough();

const fleetStationRecordItem = z
  .object({ fleetId: z.string(), stationId: z.string() })
  .passthrough();

const fleetVehicleItem = z
  .object({
    id: z.string(),
    driverId: z.string(),
    driverName: z.string(),
    make: z.string().nullable(),
    model: z.string().nullable(),
    year: z.string().nullable(),
    vin: z.string().nullable(),
    licensePlate: z.string().nullable(),
  })
  .passthrough();

const fleetSessionItem = z
  .object({
    id: z.string(),
    stationId: z.string(),
    stationName: z.string().nullable(),
    siteName: z.string().nullable(),
    transactionId: z.string().nullable(),
    status: z.string(),
    startedAt: z.coerce.date().nullable(),
    endedAt: z.coerce.date().nullable(),
    idleStartedAt: z.coerce.date().nullable(),
    energyDeliveredWh: z.number(),
    currentCostCents: z.number(),
    finalCostCents: z.number().nullable(),
    currency: z.string().nullable(),
  })
  .passthrough();

const fleetMetricsItem = z
  .object({
    totalSessions: z.number(),
    completedSessions: z.number(),
    faultedSessions: z.number(),
    sessionSuccessPercent: z.number(),
    totalEnergyWh: z.number(),
    avgSessionDurationMinutes: z.number(),
    activeDrivers: z.number(),
    totalDrivers: z.number(),
    totalVehicles: z.number(),
    periodMonths: z.number(),
  })
  .passthrough();

const energyHistoryItem = z.object({ date: z.string(), energyWh: z.number() }).passthrough();

const fleetPricingGroupItem = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    isDefault: z.boolean(),
    tariffCount: z.number(),
  })
  .passthrough();

const fleetPricingGroupRecordItem = z
  .object({ fleetId: z.string(), pricingGroupId: z.string() })
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
  limit: z.coerce.number().int().min(1).max(50).default(10).describe('Items per page'),
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
        response: { 200: itemResponse(fleetItem), 404: errorResponse },
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
        response: { 200: itemResponse(fleetItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { name, description } = request.body as z.infer<typeof updateFleetBody>;
      const fleet = await fleetService.updateFleet(id, {
        ...(name != null ? { name } : {}),
        ...(description != null ? { description } : {}),
      });
      if (fleet == null) {
        await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
        return;
      }
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
        response: { 200: itemResponse(fleetItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const fleet = await fleetService.deleteFleet(id);
      if (fleet == null) {
        await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
        return;
      }
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
        response: { 200: itemResponse(fleetDriverRecordItem), 404: errorResponse },
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
        response: { 200: itemResponse(fleetStationRecordItem), 404: errorResponse },
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
            limit: z.coerce.number().int().min(1).max(50).default(10),
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
      const body = request.body as z.infer<typeof addPricingGroupBody>;
      const record = await fleetService.addPricingGroupToFleet(id, body.pricingGroupId);
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
        response: { 200: itemResponse(fleetPricingGroupRecordItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id, pricingGroupId } = request.params as z.infer<typeof pricingGroupParams>;
      const record = await fleetService.removePricingGroupFromFleet(id, pricingGroupId);
      if (record == null) {
        await reply
          .status(404)
          .send({ error: 'Pricing group not found for fleet', code: 'NOT_FOUND' });
        return;
      }
      return record;
    },
  );
}
