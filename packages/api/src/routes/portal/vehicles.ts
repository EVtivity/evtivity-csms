// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql, asc } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { vehicles, vehicleEfficiencyLookup } from '@evtivity/database';
import { zodSchema } from '../../lib/zod-schema.js';
import { ID_PARAMS } from '../../lib/id-validation.js';
import { arrayResponse, itemResponse, errorWith } from '../../lib/response-schemas.js';
import { ERROR_CODES } from '../../lib/error-codes.generated.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';

const vehicleItem = z
  .object({
    id: z.string().describe('Vehicle ID (nanoid prefixed with veh_)'),
    driverId: z.string().describe('Owning driver ID'),
    make: z.string().max(100).nullable().describe('Vehicle make (e.g. Tesla, Ford)'),
    model: z.string().max(100).nullable().describe('Vehicle model (e.g. Model 3, F-150 Lightning)'),
    year: z
      .string()
      .regex(/^\d{4}$/)
      .nullable()
      .describe('Vehicle year (4-digit)'),
    createdAt: z.coerce.date().describe('Timestamp when the vehicle was added'),
  })
  .passthrough();

const createVehicleBody = z.object({
  make: z.string().min(1).max(100).describe('Vehicle manufacturer'),
  model: z.string().min(1).max(100).describe('Vehicle model'),
  year: z
    .string()
    .regex(/^\d{4}$/)
    .optional()
    .describe('Model year (4-digit)'),
});

const vehicleParams = z.object({
  id: ID_PARAMS.vehicleId.describe('Vehicle ID'),
});

const efficiencyResponse = z
  .object({
    efficiencyMiPerKwh: z.number().min(0).max(20).describe('Energy efficiency in miles per kWh'),
  })
  .passthrough();

const lookupQuery = z.object({
  make: z.string().optional().describe('Filter models by make (case-insensitive)'),
});

const lookupResponse = z
  .object({
    makes: z.array(z.string()).describe('Distinct vehicle makes seeded in the lookup table'),
    models: z
      .array(
        z
          .object({
            make: z.string().describe('Vehicle make'),
            model: z.string().describe('Vehicle model'),
          })
          .passthrough(),
      )
      .describe('Make/model pairs, optionally filtered by ?make='),
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
        response: {
          201: itemResponse(vehicleItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
        },
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
        response: {
          204: { type: 'null' as const },
          403: errorWith('Forbidden', [ERROR_CODES.FORBIDDEN]),
          404: errorWith('Vehicle not found', [ERROR_CODES.VEHICLE_NOT_FOUND]),
        },
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

  app.get(
    '/portal/vehicles/lookup',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Vehicles'],
        summary: 'List known vehicle makes and models for autocomplete',
        operationId: 'portalLookupVehicles',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(lookupQuery),
        response: { 200: itemResponse(lookupResponse) },
      },
    },
    async (request) => {
      const { make } = request.query as z.infer<typeof lookupQuery>;

      const makeRows = await db
        .selectDistinct({ make: vehicleEfficiencyLookup.make })
        .from(vehicleEfficiencyLookup)
        .orderBy(asc(vehicleEfficiencyLookup.make));

      const modelRows =
        make != null && make.trim() !== ''
          ? await db
              .selectDistinct({
                make: vehicleEfficiencyLookup.make,
                model: vehicleEfficiencyLookup.model,
              })
              .from(vehicleEfficiencyLookup)
              .where(sql`LOWER(${vehicleEfficiencyLookup.make}) = LOWER(${make})`)
              .orderBy(asc(vehicleEfficiencyLookup.model))
          : await db
              .selectDistinct({
                make: vehicleEfficiencyLookup.make,
                model: vehicleEfficiencyLookup.model,
              })
              .from(vehicleEfficiencyLookup)
              .orderBy(asc(vehicleEfficiencyLookup.make), asc(vehicleEfficiencyLookup.model));

      return {
        makes: makeRows.map((r) => r.make),
        models: modelRows,
      };
    },
  );
}
