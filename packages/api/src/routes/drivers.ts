// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, ne, and, or, ilike, sql, desc, asc } from 'drizzle-orm';
import { db } from '@evtivity/database';
import {
  drivers,
  driverTokens,
  vehicles,
  vehicleEfficiencyLookup,
  chargingSessions,
  chargingStations,
  sites,
  pricingGroupDrivers,
  pricingGroups,
  reservations,
  writeAudit,
  driverAuditLog,
  vehicleAuditLog,
  pricingAssignmentAuditLog,
} from '@evtivity/database';
import { getAuditActor } from '../lib/audit-actor.js';
import { publishPricingChanged } from '../lib/pricing-events.js';
import { pricingGroupExists } from '../lib/pricing-group-lookup.js';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { authorize } from '../middleware/rbac.js';
import * as tokenService from '../services/token.service.js';
import { OCPP_TOKEN_TYPES } from './tokens.js';
import type { JwtPayload } from '../plugins/auth.js';
import { isValidTimezone } from '@evtivity/lib';
import {
  paginatedResponse,
  itemResponse,
  arrayResponse,
  errorWith,
} from '../lib/response-schemas.js';

import { ERROR_CODES } from '../lib/error-codes.generated.js';
const driverItem = z
  .object({
    id: z.string().describe('Driver identifier'),
    firstName: z.string().max(100).nullable().describe('Driver first name'),
    lastName: z.string().max(100).nullable().describe('Driver last name'),
    email: z.string().email().max(255).nullable().describe('Driver email address'),
    phone: z.string().max(50).nullable().describe('Driver phone number in E.164 format'),
    isActive: z.boolean().describe('Whether the driver account is enabled'),
    createdAt: z.coerce.date().describe('Timestamp when the driver was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the driver was last updated'),
  })
  .passthrough();

const driverTokenItem = z
  .object({
    id: z.string().describe('Token identifier'),
    driverId: z.string().describe('Owning driver identifier'),
    idToken: z.string().max(255).describe('Token value (e.g. RFID card UID, eMAID)'),
    tokenType: z
      .string()
      .max(20)
      .describe('OCPP IdToken type (e.g. ISO14443, ISO15693, Central, eMAID)'),
    isActive: z.boolean().describe('Whether the token is currently usable for authorization'),
    createdAt: z.coerce.date().describe('Timestamp when the token was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the token was last updated'),
  })
  .passthrough();

const driverPricingGroupItem = z
  .object({
    id: z.string().describe('Pricing group identifier'),
    name: z.string().max(255).describe('Pricing group display name'),
    description: z.string().max(1000).nullable().describe('Pricing group description'),
    isDefault: z.boolean().describe('Whether this is the system default pricing group'),
    tariffCount: z.number().int().min(0).describe('Number of tariffs in this pricing group'),
  })
  .passthrough();

const driverPricingGroupRecordItem = z
  .object({
    driverId: z.string().describe('Driver identifier'),
    pricingGroupId: z.string().describe('Pricing group identifier'),
  })
  .passthrough();

const addDriverPricingGroupBody = z.object({
  pricingGroupId: ID_PARAMS.pricingGroupId.describe('Pricing group ID to assign to the driver'),
});

const driverPricingGroupParams = z.object({
  id: ID_PARAMS.driverId.describe('Driver ID'),
  pricingGroupId: ID_PARAMS.pricingGroupId.describe('Pricing group ID'),
});

const driverParams = z.object({
  id: ID_PARAMS.driverId.describe('Driver ID'),
});

const driverReservationItem = z
  .object({
    id: z.string().describe('Internal reservation row id'),
    reservationId: z.number().describe('OCPP integer reservation id'),
    stationId: z.string().describe('Station UUID'),
    stationOcppId: z.string().describe('Station OCPP id (display label)'),
    siteName: z.string().nullable().describe('Site name'),
    status: z.string().describe('Reservation status'),
    startsAt: z.coerce.date().nullable().describe('Reservation start (null = at-creation)'),
    expiresAt: z.coerce.date().describe('Reservation expiry'),
    createdAt: z.coerce.date().describe('Timestamp when the reservation was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the reservation was last updated'),
    cancelledBy: z
      .enum(['driver', 'operator', 'system'])
      .nullable()
      .describe('Actor who cancelled (driver/operator/system)'),
    cancelReason: z
      .enum([
        'driver_initiated',
        'operator_manual',
        'expired_no_show',
        'station_rejected_occupied',
        'station_rejected_other',
        'station_offline_at_activation',
        'system_cleanup',
      ])
      .nullable()
      .describe('Typed cancel reason enum value'),
    cancelNote: z.string().max(500).nullable().describe('Operator-provided free-text note'),
    cancellationFeeCents: z
      .number()
      .int()
      .min(0)
      .describe('Fee actually charged (cents, 0 when waived)'),
  })
  .passthrough();

const createDriverBody = z.object({
  firstName: z.string().max(100),
  lastName: z.string().max(100),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
});

const updateDriverBody = z.object({
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  isActive: z.boolean().optional().describe('Whether the driver account is active'),
  timezone: z.string().max(50).optional().describe('IANA timezone (e.g. America/New_York)'),
});

const createTokenBody = z.object({
  idToken: z.string().max(255).describe('Token identifier (e.g. RFID card UID)'),
  tokenType: z
    .enum(OCPP_TOKEN_TYPES)
    .describe('OCPP IdToken type (one of the OCPP 2.1 IdTokenEnumType values)'),
});

const driverSessionItem = z
  .object({
    id: z.string().describe('Charging session identifier'),
    stationId: z.string().describe('Station identifier where the session occurred'),
    stationName: z.string().max(255).nullable().describe('Station OCPP id (display label)'),
    siteName: z.string().max(255).nullable().describe('Site name where the station is located'),
    driverId: z.string().nullable().describe('Driver identifier, null for guest sessions'),
    driverName: z.string().max(255).nullable().describe('Driver full name'),
    transactionId: z.string().nullable().describe('OCPP transaction identifier'),
    status: z
      .string()
      .max(50)
      .describe('Session status (active, completed, failed, faulted, etc.)'),
    startedAt: z.coerce.date().describe('Timestamp when the session started'),
    endedAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp when the session ended, null if active'),
    energyDeliveredWh: z.coerce
      .number()
      .min(0)
      .nullable()
      .describe('Total energy delivered in watt-hours'),
    currentCostCents: z
      .number()
      .int()
      .min(0)
      .nullable()
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

const vehicleItem = z
  .object({
    id: z.string().describe('Vehicle identifier'),
    driverId: z.string().describe('Owning driver identifier'),
    make: z.string().max(100).nullable().describe('Vehicle make (e.g. Tesla, BMW)'),
    model: z.string().max(100).nullable().describe('Vehicle model (e.g. Model 3, i4)'),
    year: z
      .string()
      .regex(/^\d{4}$/)
      .nullable()
      .describe('Model year (4-digit)'),
    vin: z.string().max(17).nullable().describe('Vehicle identification number (17 chars)'),
    licensePlate: z.string().max(20).nullable().describe('Vehicle license plate'),
    createdAt: z.coerce.date().describe('Timestamp when the vehicle was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the vehicle was last updated'),
  })
  .passthrough();

const createVehicleBody = z.object({
  make: z.string().min(1).max(100).describe('Vehicle make (e.g. Tesla, BMW)'),
  model: z.string().min(1).max(100).describe('Vehicle model (e.g. Model 3, i4)'),
  year: z
    .string()
    .regex(/^\d{4}$/)
    .optional()
    .describe('Model year (4-digit)'),
  vin: z.string().max(17).optional().describe('Vehicle Identification Number'),
  licensePlate: z.string().max(20).optional().describe('License plate number'),
});

const updateVehicleBody = z.object({
  make: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(100).optional(),
  year: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
  vin: z.string().max(17).optional(),
  licensePlate: z.string().max(20).optional(),
});

const vehicleParams = z.object({
  id: ID_PARAMS.driverId.describe('Driver ID'),
  vehicleId: ID_PARAMS.vehicleId.describe('Vehicle ID'),
});

const sessionsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

const driverListQuery = paginationQuery.extend({
  status: z.enum(['active', 'inactive']).optional().describe('Filter by driver status'),
});

// Safe column projection used by every operator-facing read of `drivers`.
// Excludes `passwordHash` and `totpSecretEnc` so neither leaves the database
// in an API response (the response Zod schema uses .passthrough() so an
// unfiltered select() would expose both fields to anyone with drivers:read).
const driverSafeSelect = {
  id: drivers.id,
  firstName: drivers.firstName,
  lastName: drivers.lastName,
  email: drivers.email,
  phone: drivers.phone,
  registrationSource: drivers.registrationSource,
  language: drivers.language,
  timezone: drivers.timezone,
  themePreference: drivers.themePreference,
  distanceUnit: drivers.distanceUnit,
  mfaEnabled: drivers.mfaEnabled,
  mfaMethod: drivers.mfaMethod,
  isActive: drivers.isActive,
  emailVerified: drivers.emailVerified,
  lastNotificationReadAt: drivers.lastNotificationReadAt,
  createdAt: drivers.createdAt,
  updatedAt: drivers.updatedAt,
} as const;

export function driverRoutes(app: FastifyInstance): void {
  app.get(
    '/drivers',
    {
      onRequest: [authorize('drivers:read')],
      schema: {
        tags: ['Drivers'],
        summary: 'List all drivers with pagination',
        operationId: 'listDrivers',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(driverListQuery),
        response: { 200: paginatedResponse(driverItem) },
      },
    },
    async (request) => {
      const { page, limit, search, status } = request.query as z.infer<typeof driverListQuery>;
      const offset = (page - 1) * limit;

      const conditions = [];
      if (search) {
        const pattern = `%${search}%`;
        conditions.push(
          or(
            ilike(drivers.id, pattern),
            ilike(drivers.firstName, pattern),
            ilike(drivers.lastName, pattern),
            ilike(drivers.email, pattern),
            ilike(drivers.phone, pattern),
          ),
        );
      }
      if (status != null) {
        conditions.push(eq(drivers.isActive, status === 'active'));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [data, countRows] = await Promise.all([
        db
          .select(driverSafeSelect)
          .from(drivers)
          .where(where)
          // Stable ordering so pagination doesn't shuffle rows between pages.
          .orderBy(desc(drivers.createdAt), asc(drivers.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(drivers)
          .where(where),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  app.get(
    '/drivers/:id',
    {
      onRequest: [authorize('drivers:read')],
      schema: {
        tags: ['Drivers'],
        summary: 'Get a driver by ID',
        operationId: 'getDriver',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        response: {
          200: itemResponse(driverItem),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof driverParams>;
      const [driver] = await db.select(driverSafeSelect).from(drivers).where(eq(drivers.id, id));
      if (driver == null) {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }
      return driver;
    },
  );

  app.post(
    '/drivers',
    {
      onRequest: [authorize('drivers:write')],
      schema: {
        tags: ['Drivers'],
        summary: 'Create a new driver',
        operationId: 'createDriver',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createDriverBody),
        response: {
          201: itemResponse(driverItem),
          409: errorWith('Duplicate email', [ERROR_CODES.DUPLICATE_EMAIL]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createDriverBody>;

      if (body.email !== undefined) {
        body.email = body.email.toLowerCase();
        const [existing] = await db
          .select({ id: drivers.id })
          .from(drivers)
          .where(eq(drivers.email, body.email));
        if (existing != null) {
          await reply.status(409).send({ error: 'Email already in use', code: 'DUPLICATE_EMAIL' });
          return;
        }
      }

      let driver;
      try {
        [driver] = await db.insert(drivers).values(body).returning(driverSafeSelect);
      } catch (err) {
        // The pre-check above is non-transactional, so two concurrent POSTs with the
        // same lowercased email can both pass it and race here. The partial unique
        // index uq_drivers_email_lower (migration 0052) raises 23505 on the loser.
        if (
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: string }).code === '23505'
        ) {
          await reply.status(409).send({ error: 'Email already in use', code: 'DUPLICATE_EMAIL' });
          return;
        }
        throw err;
      }
      if (driver != null) {
        const actor = getAuditActor(request);
        await writeAudit(
          { table: driverAuditLog, idColumn: 'driver_id' },
          {
            entityId: driver.id,
            entityIdSnapshot: driver.id,
            action: 'created',
            ...actor,
            after: driver,
          },
          db,
          request.log,
        );
      }
      await reply.status(201).send(driver);
    },
  );

  app.patch(
    '/drivers/:id',
    {
      onRequest: [authorize('drivers:write')],
      schema: {
        tags: ['Drivers'],
        summary: 'Update a driver by ID',
        operationId: 'updateDriver',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        body: zodSchema(updateDriverBody),
        response: {
          200: itemResponse(driverItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
          409: errorWith('Email already in use', [ERROR_CODES.DUPLICATE_EMAIL]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof driverParams>;
      const body = request.body as z.infer<typeof updateDriverBody>;

      if (body.timezone !== undefined && !isValidTimezone(body.timezone)) {
        await reply.status(400).send({ error: 'Invalid IANA timezone', code: 'VALIDATION_ERROR' });
        return;
      }

      if (body.email !== undefined) {
        body.email = body.email.toLowerCase();
        const [collision] = await db
          .select({ id: drivers.id })
          .from(drivers)
          .where(and(eq(drivers.email, body.email), ne(drivers.id, id)));
        if (collision != null) {
          await reply.status(409).send({ error: 'Email already in use', code: 'DUPLICATE_EMAIL' });
          return;
        }
      }

      const fields: Record<string, unknown> = { updatedAt: new Date() };
      if (body.firstName !== undefined) fields['firstName'] = body.firstName;
      if (body.lastName !== undefined) fields['lastName'] = body.lastName;
      if (body.email !== undefined) fields['email'] = body.email;
      if (body.phone !== undefined) fields['phone'] = body.phone;
      if (body.isActive !== undefined) fields['isActive'] = body.isActive;
      if (body.timezone !== undefined) fields['timezone'] = body.timezone;

      // before is used only for the audit row — writeAudit's redactor masks
      // sensitive fields, so it's safe to fetch the full row here. The
      // returned `updated` row goes back to the operator, so we project it
      // through driverSafeSelect to keep passwordHash/totpSecretEnc internal.
      const [before] = await db.select().from(drivers).where(eq(drivers.id, id));
      let updated;
      try {
        [updated] = await db
          .update(drivers)
          .set(fields)
          .where(eq(drivers.id, id))
          .returning(driverSafeSelect);
      } catch (err) {
        // Same race as POST: the eq() collision pre-check is non-transactional,
        // so a concurrent INSERT/UPDATE with the same lowercased email can
        // happen between the check and this UPDATE.
        if (
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: string }).code === '23505'
        ) {
          await reply.status(409).send({ error: 'Email already in use', code: 'DUPLICATE_EMAIL' });
          return;
        }
        throw err;
      }

      if (updated == null) {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }

      const actor = getAuditActor(request);
      let action: string = 'updated';
      if (before != null && body.isActive !== undefined && body.isActive !== before.isActive) {
        action = body.isActive ? 'activated' : 'deactivated';
      }
      // Reactivation does NOT auto-reactivate the driver's tokens. The DELETE
      // cascade flipped them off, but some may have been deliberately revoked
      // (stolen card, lost fob); blindly flipping them back would override that
      // intent. The operator reactivates individual tokens via the Tokens page.
      await writeAudit(
        { table: driverAuditLog, idColumn: 'driver_id' },
        {
          entityId: updated.id,
          entityIdSnapshot: updated.id,
          action,
          ...actor,
          before: before ?? null,
          after: updated,
        },
        db,
        request.log,
      );

      return updated;
    },
  );

  app.get(
    '/drivers/:id/tokens',
    {
      onRequest: [authorize('drivers:read')],
      schema: {
        tags: ['Drivers'],
        summary: 'List tokens for a driver',
        operationId: 'listDriverTokens',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        response: { 200: arrayResponse(driverTokenItem) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof driverParams>;
      return db
        .select()
        .from(driverTokens)
        .where(eq(driverTokens.driverId, id))
        .orderBy(desc(driverTokens.createdAt), asc(driverTokens.id));
    },
  );

  app.post(
    '/drivers/:id/tokens',
    {
      onRequest: [authorize('drivers:write')],
      schema: {
        tags: ['Drivers'],
        summary: 'Create a token for a driver',
        operationId: 'createDriverToken',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        body: zodSchema(createTokenBody),
        response: {
          201: itemResponse(driverTokenItem),
          409: errorWith('Duplicate token', [ERROR_CODES.TOKEN_DUPLICATE]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const { id } = request.params as z.infer<typeof driverParams>;
      const body = request.body as z.infer<typeof createTokenBody>;
      try {
        const token = await tokenService.createToken(
          { driverId: id, idToken: body.idToken, tokenType: body.tokenType },
          { type: 'operator', userId },
        );
        await reply.status(201).send(token);
      } catch (err) {
        if (err instanceof tokenService.DuplicateTokenError) {
          await reply
            .status(409)
            .send({ error: 'Token already registered', code: 'TOKEN_DUPLICATE' });
          return;
        }
        throw err;
      }
    },
  );

  // --- Vehicles ---

  app.get(
    '/drivers/:id/vehicles',
    {
      onRequest: [authorize('drivers:read')],
      schema: {
        tags: ['Drivers'],
        summary: 'List vehicles for a driver',
        operationId: 'listDriverVehicles',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        response: { 200: arrayResponse(vehicleItem) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof driverParams>;
      return db
        .select()
        .from(vehicles)
        .where(eq(vehicles.driverId, id))
        .orderBy(desc(vehicles.createdAt), asc(vehicles.id));
    },
  );

  app.get(
    '/drivers/:id/vehicles/:vehicleId',
    {
      onRequest: [authorize('drivers:read')],
      schema: {
        tags: ['Drivers'],
        summary: 'Get a single vehicle for a driver',
        operationId: 'getDriverVehicle',
        security: [{ bearerAuth: [] }],
        params: zodSchema(vehicleParams),
        response: {
          200: itemResponse(vehicleItem),
          404: errorWith('Vehicle not found', [ERROR_CODES.VEHICLE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, vehicleId } = request.params as z.infer<typeof vehicleParams>;
      const [vehicle] = await db
        .select()
        .from(vehicles)
        .where(and(eq(vehicles.id, vehicleId), eq(vehicles.driverId, id)));
      if (vehicle == null) {
        await reply.status(404).send({ error: 'Vehicle not found', code: 'VEHICLE_NOT_FOUND' });
        return;
      }
      return vehicle;
    },
  );

  app.post(
    '/drivers/:id/vehicles',
    {
      onRequest: [authorize('drivers:write')],
      schema: {
        tags: ['Drivers'],
        summary: 'Create a vehicle for a driver',
        operationId: 'createDriverVehicle',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        body: zodSchema(createVehicleBody),
        response: {
          201: itemResponse(vehicleItem),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof driverParams>;
      const body = request.body as z.infer<typeof createVehicleBody>;
      const [driverRow] = await db
        .select({ id: drivers.id })
        .from(drivers)
        .where(eq(drivers.id, id));
      if (driverRow == null) {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }
      let vehicle;
      try {
        [vehicle] = await db
          .insert(vehicles)
          .values({ driverId: id, ...body })
          .returning();
      } catch (err) {
        // Pre-check is non-transactional, so the driver can be deleted
        // between the check and this INSERT. Map the FK violation back
        // to the same 404 the pre-check would have produced.
        if (
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: string }).code === '23503'
        ) {
          await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
          return;
        }
        throw err;
      }
      if (vehicle != null) {
        const actor = getAuditActor(request);
        await writeAudit(
          { table: vehicleAuditLog, idColumn: 'vehicle_id' },
          {
            entityId: vehicle.id,
            entityIdSnapshot: vehicle.id,
            action: 'created',
            ...actor,
            after: vehicle,
          },
          db,
          request.log,
        );
      }
      await reply.status(201).send(vehicle);
    },
  );

  app.patch(
    '/drivers/:id/vehicles/:vehicleId',
    {
      onRequest: [authorize('drivers:write')],
      schema: {
        tags: ['Drivers'],
        summary: 'Update a vehicle',
        operationId: 'updateDriverVehicle',
        security: [{ bearerAuth: [] }],
        params: zodSchema(vehicleParams),
        body: zodSchema(updateVehicleBody),
        response: {
          200: itemResponse(vehicleItem),
          404: errorWith('Vehicle not found', [ERROR_CODES.VEHICLE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, vehicleId } = request.params as z.infer<typeof vehicleParams>;
      const body = request.body as z.infer<typeof updateVehicleBody>;

      const fields: Record<string, unknown> = { updatedAt: new Date() };
      if (body.make !== undefined) fields['make'] = body.make;
      if (body.model !== undefined) fields['model'] = body.model;
      if (body.year !== undefined) fields['year'] = body.year;
      if (body.vin !== undefined) fields['vin'] = body.vin;
      if (body.licensePlate !== undefined) fields['licensePlate'] = body.licensePlate;

      const [before] = await db
        .select()
        .from(vehicles)
        .where(and(eq(vehicles.id, vehicleId), eq(vehicles.driverId, id)));
      const [updated] = await db
        .update(vehicles)
        .set(fields)
        .where(and(eq(vehicles.id, vehicleId), eq(vehicles.driverId, id)))
        .returning();

      if (updated == null) {
        await reply.status(404).send({ error: 'Vehicle not found', code: 'VEHICLE_NOT_FOUND' });
        return;
      }

      const actor = getAuditActor(request);
      await writeAudit(
        { table: vehicleAuditLog, idColumn: 'vehicle_id' },
        {
          entityId: updated.id,
          entityIdSnapshot: updated.id,
          action: 'updated',
          ...actor,
          before: before ?? null,
          after: updated,
        },
        db,
        request.log,
      );

      return updated;
    },
  );

  app.delete(
    '/drivers/:id/vehicles/:vehicleId',
    {
      onRequest: [authorize('drivers:write')],
      schema: {
        tags: ['Drivers'],
        summary: 'Delete a vehicle',
        operationId: 'deleteDriverVehicle',
        security: [{ bearerAuth: [] }],
        params: zodSchema(vehicleParams),
        response: {
          204: { type: 'null' as const },
          404: errorWith('Vehicle not found', [ERROR_CODES.VEHICLE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, vehicleId } = request.params as z.infer<typeof vehicleParams>;

      const [deleted] = await db
        .delete(vehicles)
        .where(and(eq(vehicles.id, vehicleId), eq(vehicles.driverId, id)))
        .returning();

      if (deleted == null) {
        await reply.status(404).send({ error: 'Vehicle not found', code: 'VEHICLE_NOT_FOUND' });
        return;
      }

      const actor = getAuditActor(request);
      await writeAudit(
        { table: vehicleAuditLog, idColumn: 'vehicle_id' },
        {
          entityId: null,
          entityIdSnapshot: deleted.id,
          action: 'deleted',
          ...actor,
          before: deleted,
        },
        db,
        request.log,
      );

      await reply.status(204).send();
    },
  );

  // --- Vehicle lookup catalog (typeahead source) ---

  const vehicleLookupQuery = z.object({
    make: z.string().optional().describe('Filter models by make (case-insensitive)'),
  });
  const vehicleLookupResponse = z
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

  app.get(
    '/vehicles/lookup',
    {
      onRequest: [authorize('drivers:read')],
      schema: {
        tags: ['Drivers'],
        summary: 'List known vehicle makes and models for autocomplete',
        operationId: 'lookupVehicles',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(vehicleLookupQuery),
        response: { 200: itemResponse(vehicleLookupResponse) },
      },
    },
    async (request) => {
      const { make } = request.query as z.infer<typeof vehicleLookupQuery>;

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

  app.delete(
    '/drivers/:id',
    {
      onRequest: [authorize('drivers:write')],
      schema: {
        tags: ['Drivers'],
        summary: 'Deactivate a driver by ID',
        operationId: 'deleteDriver',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        response: {
          204: { type: 'null' as const },
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof driverParams>;
      const { userId } = request.user as JwtPayload;

      const [driver] = await db.select().from(drivers).where(eq(drivers.id, id));
      if (driver == null) {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }

      await db
        .update(drivers)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(drivers.id, id));

      // Cascade: OCPP authorize handlers only check driverTokens.isActive,
      // not drivers.isActive. Deactivate every token the driver owns so the
      // soft-delete actually blocks future RFID taps and portal idTags.
      const driverTokenRows = await db
        .select({ id: driverTokens.id })
        .from(driverTokens)
        .where(eq(driverTokens.driverId, id));
      if (driverTokenRows.length > 0) {
        await tokenService.bulkSetActive(
          driverTokenRows.map((t) => t.id),
          false,
          { type: 'operator', userId },
        );
      }

      const actor = getAuditActor(request);
      await writeAudit(
        { table: driverAuditLog, idColumn: 'driver_id' },
        {
          entityId: driver.id,
          entityIdSnapshot: driver.id,
          action: 'deleted',
          ...actor,
          before: driver,
        },
        db,
        request.log,
      );

      await reply.status(204).send();
    },
  );

  app.get(
    '/drivers/:id/sessions',
    {
      onRequest: [authorize('drivers:read')],
      schema: {
        tags: ['Drivers'],
        summary: 'List charging sessions for a driver',
        operationId: 'listDriverSessions',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        querystring: zodSchema(sessionsQuery),
        response: {
          200: paginatedResponse(driverSessionItem),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof driverParams>;
      const { page, limit } = request.query as z.infer<typeof sessionsQuery>;
      const offset = (page - 1) * limit;

      const where = eq(chargingSessions.driverId, id);

      // Run the existence check in parallel with the data + count queries.
      // The existence check selects only id (not the full row, which would
      // pull passwordHash and totpSecretEnc unnecessarily).
      const [driverRows, data, countRows] = await Promise.all([
        db.select({ id: drivers.id }).from(drivers).where(eq(drivers.id, id)),
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

      if (driverRows[0] == null) {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // --- Reservations ---

  app.get(
    '/drivers/:id/reservations',
    {
      onRequest: [authorize('drivers:read')],
      schema: {
        tags: ['Drivers'],
        summary: 'List reservations for a driver, with cancel metadata',
        operationId: 'listDriverReservations',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        querystring: zodSchema(paginationQuery),
        response: {
          200: paginatedResponse(driverReservationItem),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof driverParams>;
      const { page, limit } = request.query as z.infer<typeof paginationQuery>;
      const offset = (page - 1) * limit;

      const where = eq(reservations.driverId, id);
      // Existence check runs in parallel with data + count.
      const [driverRows, data, countRows] = await Promise.all([
        db.select({ id: drivers.id }).from(drivers).where(eq(drivers.id, id)),
        db
          .select({
            id: reservations.id,
            reservationId: reservations.reservationId,
            stationId: reservations.stationId,
            stationOcppId: chargingStations.stationId,
            siteName: sites.name,
            status: reservations.status,
            startsAt: reservations.startsAt,
            expiresAt: reservations.expiresAt,
            createdAt: reservations.createdAt,
            updatedAt: reservations.updatedAt,
            cancelledBy: reservations.cancelledBy,
            cancelReason: reservations.cancelReason,
            cancelNote: reservations.cancelNote,
            cancellationFeeCents: reservations.cancellationFeeCents,
          })
          .from(reservations)
          .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
          .leftJoin(sites, eq(chargingStations.siteId, sites.id))
          .where(where)
          .orderBy(desc(reservations.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(reservations)
          .where(where),
      ]);

      if (driverRows[0] == null) {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // --- Pricing Groups ---

  app.get(
    '/drivers/:id/pricing-groups',
    {
      onRequest: [authorize('drivers:read')],
      schema: {
        tags: ['Drivers'],
        summary: 'Get the pricing group for a driver',
        operationId: 'getDriverPricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        response: { 200: itemResponse(driverPricingGroupItem.nullable()) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof driverParams>;
      const rows = await db
        .select({
          id: pricingGroups.id,
          name: pricingGroups.name,
          description: pricingGroups.description,
          isDefault: pricingGroups.isDefault,
          tariffCount: sql<number>`(select count(*)::int from tariffs where tariffs.pricing_group_id = ${pricingGroups.id})`,
        })
        .from(pricingGroupDrivers)
        .innerJoin(pricingGroups, eq(pricingGroupDrivers.pricingGroupId, pricingGroups.id))
        .where(eq(pricingGroupDrivers.driverId, id))
        .limit(1);
      return rows[0] ?? null;
    },
  );

  app.post(
    '/drivers/:id/pricing-groups',
    {
      onRequest: [authorize('drivers:write')],
      schema: {
        tags: ['Drivers'],
        summary: 'Assign a pricing group to a driver',
        operationId: 'addDriverPricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        body: zodSchema(addDriverPricingGroupBody),
        response: {
          201: itemResponse(driverPricingGroupRecordItem),
          404: errorWith('Pricing group not found', [ERROR_CODES.PRICING_GROUP_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof driverParams>;
      const { userId } = request.user as JwtPayload;
      const body = request.body as z.infer<typeof addDriverPricingGroupBody>;
      // Pre-check pricing group existence so a typo'd id returns a clean
      // 404 instead of a 500 from the FK violation. Run the previous-row
      // lookup in parallel — the typo case is rare so wasting one query
      // there is cheaper than the round-trip it saves on the success path.
      const [pgExists, previousRows] = await Promise.all([
        pricingGroupExists(body.pricingGroupId),
        db.select().from(pricingGroupDrivers).where(eq(pricingGroupDrivers.driverId, id)),
      ]);
      if (!pgExists) {
        await reply
          .status(404)
          .send({ error: 'Pricing group not found', code: 'PRICING_GROUP_NOT_FOUND' });
        return;
      }
      const previous = previousRows[0];
      let record;
      try {
        [record] = await db
          .insert(pricingGroupDrivers)
          .values({ driverId: id, pricingGroupId: body.pricingGroupId })
          .onConflictDoUpdate({
            target: [pricingGroupDrivers.driverId],
            set: { pricingGroupId: body.pricingGroupId, createdAt: new Date() },
          })
          .returning();
      } catch (err) {
        // The pre-check is non-transactional, so the pricing group can be
        // deleted between the lookup and this INSERT. Map the FK violation
        // back to 404 — same pattern as sites/stations/fleets.
        if (
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: string }).code === '23503'
        ) {
          await reply
            .status(404)
            .send({ error: 'Pricing group not found', code: 'PRICING_GROUP_NOT_FOUND' });
          return;
        }
        throw err;
      }
      const actor = getAuditActor(request);
      // Two independent audit rows for two different tables — write in
      // parallel. Both calls swallow errors internally so the response is
      // never blocked by an audit failure.
      await Promise.all([
        writeAudit(
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
                : { scope: 'driver', driverId: id, pricingGroupId: previous.pricingGroupId },
            after: { scope: 'driver', driverId: id, pricingGroupId: body.pricingGroupId },
          },
          db,
          request.log,
        ),
        writeAudit(
          { table: driverAuditLog, idColumn: 'driver_id' },
          {
            entityId: id,
            entityIdSnapshot: id,
            action: 'pricing_assignment_changed',
            ...actor,
            before: previous == null ? null : { pricingGroupId: previous.pricingGroupId },
            after: { pricingGroupId: body.pricingGroupId },
          },
          db,
          request.log,
        ),
      ]);
      await publishPricingChanged({
        pricingGroupId: body.pricingGroupId,
        action: 'assignment.changed',
        driverId: id,
      });
      await reply.status(201).send(record);
    },
  );

  app.delete(
    '/drivers/:id/pricing-groups/:pricingGroupId',
    {
      onRequest: [authorize('drivers:write')],
      schema: {
        tags: ['Drivers'],
        summary: 'Remove a pricing group from a driver',
        operationId: 'removeDriverPricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverPricingGroupParams),
        response: {
          200: itemResponse(driverPricingGroupRecordItem),
          404: errorWith('Pricing assignment not found', [
            ERROR_CODES.PRICING_ASSIGNMENT_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id, pricingGroupId } = request.params as z.infer<typeof driverPricingGroupParams>;
      const { userId } = request.user as JwtPayload;
      const [record] = await db
        .delete(pricingGroupDrivers)
        .where(
          and(
            eq(pricingGroupDrivers.driverId, id),
            eq(pricingGroupDrivers.pricingGroupId, pricingGroupId),
          ),
        )
        .returning();
      if (record == null) {
        await reply.status(404).send({
          error: 'Pricing group not found for driver',
          code: 'PRICING_ASSIGNMENT_NOT_FOUND',
        });
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
          before: { scope: 'driver', driverId: id, pricingGroupId },
        },
        db,
        request.log,
      );
      const actor = getAuditActor(request);
      await writeAudit(
        { table: driverAuditLog, idColumn: 'driver_id' },
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
      await publishPricingChanged({
        pricingGroupId,
        action: 'assignment.changed',
        driverId: id,
      });
      return record;
    },
  );
}
