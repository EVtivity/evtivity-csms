// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { vehicles, vehicleEfficiencyLookup } from '@evtivity/database';
import { zodSchema } from '../../lib/zod-schema.js';
import { ID_PARAMS } from '../../lib/id-validation.js';
import { errorResponse, arrayResponse, itemResponse } from '../../lib/response-schemas.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';

const vehicleItem = z
  .object({
    id: z.string(),
    driverId: z.string(),
    make: z.string().nullable(),
    model: z.string().nullable(),
    year: z.string().nullable(),
    createdAt: z.coerce.date(),
  })
  .passthrough();

const createVehicleBody = z.object({
  make: z.string().min(1).max(100).describe('Vehicle manufacturer'),
  model: z.string().min(1).max(100).describe('Vehicle model'),
  year: z.string().max(4).optional().describe('Model year'),
});

const vehicleParams = z.object({
  id: ID_PARAMS.vehicleId.describe('Vehicle ID'),
});

const efficiencyResponse = z
  .object({
    efficiencyMiPerKwh: z.number(),
  })
  .passthrough();

export function portalVehicleRoutes(app: FastifyInstance): void {
  app.get(
    '/portal/vehicles',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Vehicles'],
        summary: 'List driver vehicles',
        operationId: 'portalListVehicles',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(vehicleItem) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      return db
        .select({
          id: vehicles.id,
          driverId: vehicles.driverId,
          make: vehicles.make,
          model: vehicles.model,
          year: vehicles.year,
          createdAt: vehicles.createdAt,
        })
        .from(vehicles)
        .where(eq(vehicles.driverId, driverId));
    },
  );

  app.post(
    '/portal/vehicles',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Vehicles'],
        summary: 'Add a vehicle',
        operationId: 'portalCreateVehicle',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createVehicleBody),
        response: { 201: itemResponse(vehicleItem), 400: errorResponse },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof createVehicleBody>;

      const [vehicle] = await db
        .insert(vehicles)
        .values({
          driverId,
          make: body.make,
          model: body.model,
          year: body.year ?? null,
        })
        .returning();

      return reply.status(201).send(vehicle);
    },
  );

  app.delete(
    '/portal/vehicles/:id',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Vehicles'],
        summary: 'Delete a vehicle',
        operationId: 'portalDeleteVehicle',
        security: [{ bearerAuth: [] }],
        params: zodSchema(vehicleParams),
        response: { 204: { type: 'null' as const }, 403: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof vehicleParams>;

      const [vehicle] = await db
        .select({ id: vehicles.id, driverId: vehicles.driverId })
        .from(vehicles)
        .where(eq(vehicles.id, id));

      if (vehicle == null) {
        await reply.status(404).send({ error: 'Vehicle not found', code: 'VEHICLE_NOT_FOUND' });
        return;
      }

      if (vehicle.driverId !== driverId) {
        await reply.status(403).send({ error: 'Forbidden', code: 'FORBIDDEN' });
        return;
      }

      await db.delete(vehicles).where(eq(vehicles.id, id));
      return reply.status(204).send();
    },
  );

  app.get(
    '/portal/vehicles/efficiency',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Vehicles'],
        summary: 'Get vehicle efficiency for miles estimation',
        operationId: 'portalGetVehicleEfficiency',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(efficiencyResponse) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      const DEFAULT_EFFICIENCY = 3.5;

      const [firstVehicle] = await db
        .select({ make: vehicles.make, model: vehicles.model })
        .from(vehicles)
        .where(eq(vehicles.driverId, driverId))
        .limit(1);

      if (firstVehicle == null || firstVehicle.make == null || firstVehicle.model == null) {
        return { efficiencyMiPerKwh: DEFAULT_EFFICIENCY };
      }

      const [match] = await db
        .select({ efficiencyMiPerKwh: vehicleEfficiencyLookup.efficiencyMiPerKwh })
        .from(vehicleEfficiencyLookup)
        .where(
          and(
            sql`LOWER(${vehicleEfficiencyLookup.make}) = LOWER(${firstVehicle.make})`,
            sql`LOWER(${vehicleEfficiencyLookup.model}) = LOWER(${firstVehicle.model})`,
          ),
        )
        .limit(1);

      return {
        efficiencyMiPerKwh: match != null ? Number(match.efficiencyMiPerKwh) : DEFAULT_EFFICIENCY,
      };
    },
  );
}
