// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  sites,
  isOperatorStation,
} from '@evtivity/database';
import { VEHICLE_ID_SOURCES, VEHICLE_ID_TYPES } from '@evtivity/lib/vehicle-id';
import { ID_PARAMS } from './id-validation.js';
import { sessionsAtSites } from './session-site-scope.js';
import {
  SessionNoVehicleIdError,
  SessionNotFoundError,
  VehicleBlockedError,
  VehicleDriverNotFoundError,
  VehicleIdInUseError,
  VehicleIdInvalidError,
  VehicleIdRequiredError,
  VehicleNotFoundError,
} from '../services/vehicle.service.js';

/** Where and when a charger last sent one of the vehicle's ids. */
export const vehicleLastSeenItem = z
  .object({
    stationId: z.string().describe('OCPP identity of the station'),
    siteName: z.string().nullable().describe('Site of the station'),
    at: z.coerce.date().describe('Start of the session in which the charger sent the id'),
  })
  .passthrough()
  .nullable()
  .describe(
    'The last session in which a charger sent one of the vehicle ids, null when none (operators see sessions at their sites only)',
  );

/** The vehicle fields of Autocharge, shared by the operator and portal vehicle items. */
export const vehicleAutochargeFields = {
  vin: z
    .string()
    .max(17)
    .nullable()
    .describe('Vehicle identification number (17 characters, uppercase)'),
  evccid: z
    .string()
    .max(255)
    .nullable()
    .describe(
      'EV charging controller id (ISO 15118 EVCCID): a MAC address as 12 uppercase hex digits, or an ISO 15118-20 identifier',
    ),
  autochargeEnabled: z
    .boolean()
    .describe(
      'Autocharge (charge by plugging in): a start with this vehicle id is authorized as the driver',
    ),
  lastSeen: vehicleLastSeenItem,
};

/** The captured vehicle id of a session. */
export const sessionVehicleCaptureItem = z
  .object({
    value: z
      .string()
      .describe('Normalized id: a MAC address as 12 uppercase hex digits, a VIN uppercase'),
    type: z.enum(VEHICLE_ID_TYPES).describe('OCPP IdToken type of the id'),
    source: z
      .enum(VEHICLE_ID_SOURCES)
      .describe(
        'id_token: the 2.1 idToken itself; additional_info: an additionalInfo entry of the 2.1 idToken; id_tag: a 1.6 idTag',
      ),
  })
  .passthrough()
  .nullable()
  .describe('The vehicle id the charger sent at the start, null when none');

/** Body of the session vehicle id claim (portal and operator). */
export const vehicleClaimBody = z
  .object({
    vehicleId: ID_PARAMS.vehicleId
      .optional()
      .describe('Existing vehicle of the session driver to store the id on'),
    vehicle: z
      .object({
        make: z.string().min(1).max(100).describe('Vehicle make'),
        model: z.string().min(1).max(100).describe('Vehicle model'),
        year: z
          .string()
          .regex(/^\d{4}$/)
          .optional()
          .describe('Model year (4-digit)'),
      })
      .optional()
      .describe('New vehicle to create with the id'),
    enableAutocharge: z
      .boolean()
      .default(true)
      .describe('Turn Autocharge on for the vehicle (default true)'),
  })
  .refine((b) => (b.vehicleId != null) !== (b.vehicle != null), {
    message: 'Send either vehicleId or vehicle',
  });

/**
 * The last session per vehicle in which a charger sent a vehicle id, scoped to
 * the operator's sites (null: every site).
 */
export async function vehicleLastSeen(
  vehicleIds: string[],
  siteIds: string[] | null,
): Promise<Map<string, { stationId: string; siteName: string | null; at: Date }>> {
  const out = new Map<string, { stationId: string; siteName: string | null; at: Date }>();
  if (vehicleIds.length === 0) return out;
  const rows = await db
    .selectDistinctOn([chargingSessions.vehicleId], {
      vehicleId: chargingSessions.vehicleId,
      stationId: chargingStations.stationId,
      siteName: sites.name,
      at: chargingSessions.startedAt,
    })
    .from(chargingSessions)
    .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
    .leftJoin(sites, eq(chargingSessions.siteId, sites.id))
    .where(
      and(
        inArray(chargingSessions.vehicleId, vehicleIds),
        isNotNull(chargingSessions.vehicleIdValue),
        siteIds != null ? sessionsAtSites(siteIds) : undefined,
        // A session at a conformance test station is not where a vehicle was seen.
        isOperatorStation(),
      ),
    )
    .orderBy(
      chargingSessions.vehicleId,
      desc(sql`coalesce(${chargingSessions.startedAt}, ${chargingSessions.createdAt})`),
    );
  for (const row of rows) {
    if (row.vehicleId == null) continue;
    out.set(row.vehicleId, {
      stationId: row.stationId,
      siteName: row.siteName ?? null,
      at: row.at ?? new Date(0),
    });
  }
  return out;
}

/**
 * Answers a vehicle service error with its code; false for any other error,
 * which the caller rethrows.
 */
export async function replyVehicleServiceError(
  reply: FastifyReply,
  err: unknown,
): Promise<boolean> {
  if (err instanceof VehicleNotFoundError) {
    await reply.status(404).send({ error: 'Vehicle not found', code: 'VEHICLE_NOT_FOUND' });
  } else if (err instanceof VehicleDriverNotFoundError) {
    await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
  } else if (err instanceof SessionNotFoundError) {
    await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
  } else if (err instanceof VehicleIdInUseError) {
    await reply.status(409).send({ error: err.message, code: 'VEHICLE_ID_IN_USE' });
  } else if (err instanceof SessionNoVehicleIdError) {
    await reply.status(409).send({ error: err.message, code: 'SESSION_NO_VEHICLE_ID' });
  } else if (err instanceof VehicleIdRequiredError) {
    await reply.status(400).send({ error: err.message, code: 'VEHICLE_ID_REQUIRED' });
  } else if (err instanceof VehicleIdInvalidError) {
    await reply
      .status(400)
      .send({ error: err.message, code: 'VALIDATION_ERROR', details: { field: err.field } });
  } else if (err instanceof VehicleBlockedError) {
    await reply.status(403).send({ error: err.message, code: 'VEHICLE_BLOCKED_BY_OPERATOR' });
  } else {
    return false;
  }
  return true;
}
