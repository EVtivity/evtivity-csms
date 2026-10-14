// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql, asc, desc } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { vehicles, vehicleEfficiencyLookup } from '@evtivity/database';
import { getAuditActor } from '../../lib/audit-actor.js';
import * as vehicleService from '../../services/vehicle.service.js';
import {
  replyVehicleServiceError,
  vehicleAutochargeFields,
  vehicleLastSeen,
} from '../../lib/vehicle-response.js';
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
    ...vehicleAutochargeFields,
    autochargeBlocked: z
      .boolean()
      .describe('The operator blocked Autocharge for this vehicle; the driver cannot turn it on'),
    createdAt: z.coerce.date().describe('Timestamp when the vehicle was added'),
  })
  .passthrough();

const vehicleIdFields = {
  vin: z
    .string()
    .max(17)
    .nullable()
    .optional()
    .describe('VIN (17 characters, no I, O or Q). Null or empty removes it.'),
  evccid: z
    .string()
    .max(255)
    .nullable()
    .optional()
    .describe('EVCCID or MAC address of the EV charging controller. Null or empty removes it.'),
};

const updateVehicleBody = z.object({
  make: z.string().min(1).max(100).optional().describe('Vehicle manufacturer'),
  model: z.string().min(1).max(100).optional().describe('Vehicle model'),
  year: z
    .string()
    .regex(/^\d{4}$/)
    .nullable()
    .optional()
    .describe('Model year (4-digit). Null removes it.'),
  ...vehicleIdFields,
  autochargeEnabled: z
    .boolean()
    .optional()
    .describe('Autocharge (charge by plugging in); needs a VIN or an EVCCID'),
});

type VehicleRow = typeof vehicles.$inferSelect;

/** The portal shape of a vehicle: no operator fields, the block as a flag. */
function portalVehicle(
  v: VehicleRow,
  lastSeen: { stationId: string; siteName: string | null; at: Date } | null,
): Record<string, unknown> {
  return {
    id: v.id,
    driverId: v.driverId,
    make: v.make,
    model: v.model,
    year: v.year,
    vin: v.vin,
    evccid: v.evccid,
    autochargeEnabled: v.autochargeEnabled,
    autochargeBlocked: v.autochargeBlockedAt != null,
    lastSeen,
    createdAt: v.createdAt,
  };
}

const createVehicleBody = z.object({
  make: z.string().min(1).max(100).describe('Vehicle manufacturer'),
  model: z.string().min(1).max(100).describe('Vehicle model'),
  year: z
    .string()
    .regex(/^\d{4}$/)
    .optional()
    .describe('Model year (4-digit)'),
  ...vehicleIdFields,
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
      const rows = await db
        .select()
        .from(vehicles)
        .where(eq(vehicles.driverId, driverId))
        .orderBy(desc(vehicles.createdAt), desc(vehicles.id));
      const lastSeen = await vehicleLastSeen(
        rows.map((r) => r.id),
        null,
      );
      return rows.map((r) => portalVehicle(r, lastSeen.get(r.id) ?? null));
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
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof createVehicleBody>;

      try {
        const vehicle = await vehicleService.createVehicle(
          driverId,
          body,
          getAuditActor(request),
          request.log,
        );
        return await reply.status(201).send(portalVehicle(vehicle, null));
      } catch (err) {
        if (await replyVehicleServiceError(reply, err)) return;
        throw err;
      }
    },
  );

  app.patch(
    '/portal/vehicles/:id',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Vehicles'],
        summary: 'Update a vehicle, its VIN or EVCCID, or turn Autocharge on or off',
        operationId: 'portalUpdateVehicle',
        security: [{ bearerAuth: [] }],
        params: zodSchema(vehicleParams),
        body: zodSchema(updateVehicleBody),
        response: {
          200: itemResponse(vehicleItem),
          400: errorWith('Validation error', [
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.VEHICLE_ID_REQUIRED,
          ]),
          403: errorWith('Blocked by the operator', [ERROR_CODES.VEHICLE_BLOCKED_BY_OPERATOR]),
          404: errorWith('Vehicle not found', [ERROR_CODES.VEHICLE_NOT_FOUND]),
          409: errorWith('Vehicle id in use', [ERROR_CODES.VEHICLE_ID_IN_USE]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof vehicleParams>;
      const body = request.body as z.infer<typeof updateVehicleBody>;
      try {
        const vehicle = await vehicleService.updateVehicle(
          driverId,
          id,
          body,
          getAuditActor(request),
          request.log,
        );
        const lastSeen = await vehicleLastSeen([vehicle.id], null);
        return portalVehicle(vehicle, lastSeen.get(vehicle.id) ?? null);
      } catch (err) {
        if (await replyVehicleServiceError(reply, err)) return;
        throw err;
      }
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
          404: errorWith('Vehicle not found', [ERROR_CODES.VEHICLE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof vehicleParams>;

      // Another driver's vehicle answers like a missing one, so vehicle ids
      // cannot be probed.
      try {
        await vehicleService.deleteVehicle(driverId, id, getAuditActor(request), request.log);
      } catch (err) {
        if (await replyVehicleServiceError(reply, err)) return;
        throw err;
      }
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

      // Pick the most-recently-added vehicle as a proxy for "current car".
      // The portal Activity miles estimate uses one driver-wide efficiency
      // value, so for multi-vehicle drivers we need a deterministic choice;
      // recency is the closest signal we have without a dedicated "primary
      // vehicle" flag.
      const [firstVehicle] = await db
        .select({ make: vehicles.make, model: vehicles.model, year: vehicles.year })
        .from(vehicles)
        .where(eq(vehicles.driverId, driverId))
        .orderBy(desc(vehicles.createdAt), desc(vehicles.id))
        .limit(1);

      if (firstVehicle == null || firstVehicle.make == null || firstVehicle.model == null) {
        return { efficiencyMiPerKwh: DEFAULT_EFFICIENCY };
      }

      // Prefer a year-specific match, then fall back to the year-null row
      // for the make/model. The seed mixes both shapes (see
      // idx_vel_make_model_year unique on LOWER(make)+LOWER(model)+
      // COALESCE(year, '')), so ordering by year IS NOT NULL DESC pulls the
      // tighter match first whenever the driver's vehicle has a year.
      const [match] = await db
        .select({ efficiencyMiPerKwh: vehicleEfficiencyLookup.efficiencyMiPerKwh })
        .from(vehicleEfficiencyLookup)
        .where(
          and(
            sql`LOWER(${vehicleEfficiencyLookup.make}) = LOWER(${firstVehicle.make})`,
            sql`LOWER(${vehicleEfficiencyLookup.model}) = LOWER(${firstVehicle.model})`,
            firstVehicle.year != null
              ? sql`(${vehicleEfficiencyLookup.year} = ${firstVehicle.year} OR ${vehicleEfficiencyLookup.year} IS NULL)`
              : sql`${vehicleEfficiencyLookup.year} IS NULL`,
          ),
        )
        .orderBy(sql`${vehicleEfficiencyLookup.year} IS NOT NULL DESC`)
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
