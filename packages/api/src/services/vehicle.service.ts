// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The only writer of `vehicles` (operator routes, portal routes, the session
 * vehicle id claim), except the driver erasure, which deletes a driver's
 * vehicles in its own transaction. Every change writes a `vehicle_audit_log`
 * row. Vehicle ids (VIN, EVCCID) are stored normalized
 * (@evtivity/lib/vehicle-id), and Autocharge has these invariants:
 *
 * - On only with a VIN or an EVCCID (check `vehicles_autocharge_id_check`).
 * - One vehicle with Autocharge on per VIN and per EVCCID (partial unique
 *   indexes), so a start resolves to one driver: 409 `VEHICLE_ID_IN_USE`.
 * - A driver cannot turn it on for a vehicle an operator blocked: 403
 *   `VEHICLE_BLOCKED_BY_OPERATOR`. Only an operator blocks and unblocks.
 * - A captured id is claimed only by the session's own driver.
 */

import { and, eq } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  drivers,
  vehicles,
  vehicleAuditLog,
  sessionAuditLog,
  writeAudit,
  pgErrorCode,
  pgConstraintName,
  PG_UNIQUE_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
} from '@evtivity/database';
import {
  isVehicleIdType,
  normalizeEvccid,
  normalizeVin,
  vehicleIdColumn,
} from '@evtivity/lib/vehicle-id';
import type { AuditActorInfo } from '../lib/audit-actor.js';

const PG_CHECK_VIOLATION = '23514';

type Vehicle = typeof vehicles.$inferSelect;

interface AuditLog {
  warn: (obj: unknown, msg?: string) => void;
}

export class VehicleNotFoundError extends Error {
  constructor() {
    super('Vehicle not found');
  }
}
export class VehicleDriverNotFoundError extends Error {
  constructor() {
    super('Driver not found');
  }
}
export class VehicleIdInUseError extends Error {
  constructor() {
    super('Another vehicle uses this vehicle id for Autocharge');
  }
}
export class VehicleIdRequiredError extends Error {
  constructor() {
    super('Autocharge needs a VIN or an EVCCID on the vehicle');
  }
}
export class VehicleIdInvalidError extends Error {
  constructor(readonly field: 'vin' | 'evccid') {
    super(field === 'vin' ? 'Not a valid VIN' : 'Not a valid EVCCID or MAC address');
  }
}
export class VehicleBlockedError extends Error {
  constructor() {
    super('The operator blocked Autocharge for this vehicle');
  }
}
export class SessionNotFoundError extends Error {
  constructor() {
    super('Session not found');
  }
}
export class SessionNoVehicleIdError extends Error {
  constructor() {
    super('The charger sent no vehicle id for this session');
  }
}

export interface VehicleFields {
  make?: string | undefined;
  model?: string | undefined;
  year?: string | null | undefined;
  vin?: string | null | undefined;
  licensePlate?: string | null | undefined;
  evccid?: string | null | undefined;
  autochargeEnabled?: boolean | undefined;
}

/** The normalized form of the id fields; throws VehicleIdInvalidError on a bad value. */
function normalizeFields(fields: VehicleFields): VehicleFields {
  const out: VehicleFields = { ...fields };
  if (fields.vin != null) {
    const trimmed = fields.vin.trim();
    if (trimmed === '') {
      out.vin = null;
    } else {
      const vin = normalizeVin(trimmed);
      if (vin == null) throw new VehicleIdInvalidError('vin');
      out.vin = vin;
    }
  }
  if (fields.evccid != null) {
    const trimmed = fields.evccid.trim();
    if (trimmed === '') {
      out.evccid = null;
    } else {
      const evccid = normalizeEvccid(trimmed);
      if (evccid == null) throw new VehicleIdInvalidError('evccid');
      out.evccid = evccid;
    }
  }
  return out;
}

/** Maps the Autocharge constraint violations to the service errors. */
function mapConstraintError(err: unknown): unknown {
  const code = pgErrorCode(err);
  if (code === PG_UNIQUE_VIOLATION) {
    const name = pgConstraintName(err);
    if (name === 'uq_vehicles_autocharge_evccid' || name === 'uq_vehicles_autocharge_vin') {
      return new VehicleIdInUseError();
    }
  }
  if (code === PG_CHECK_VIOLATION && pgConstraintName(err) === 'vehicles_autocharge_id_check') {
    return new VehicleIdRequiredError();
  }
  if (code === PG_FOREIGN_KEY_VIOLATION) return new VehicleDriverNotFoundError();
  return err;
}

function auditAction(
  before: Vehicle,
  after: Vehicle,
): 'updated' | 'autocharge_enabled' | 'autocharge_disabled' {
  if (!before.autochargeEnabled && after.autochargeEnabled) return 'autocharge_enabled';
  if (before.autochargeEnabled && !after.autochargeEnabled) return 'autocharge_disabled';
  return 'updated';
}

async function audit(
  action:
    | 'created'
    | 'updated'
    | 'deleted'
    | 'autocharge_enabled'
    | 'autocharge_disabled'
    | 'autocharge_blocked'
    | 'autocharge_unblocked'
    | 'vehicle_id_claimed',
  vehicle: Vehicle,
  actor: AuditActorInfo,
  log: AuditLog,
  before: Vehicle | null,
  after: Vehicle | null,
): Promise<void> {
  await writeAudit(
    { table: vehicleAuditLog, idColumn: 'vehicle_id' },
    {
      entityId: action === 'deleted' ? null : vehicle.id,
      entityIdSnapshot: vehicle.id,
      action,
      ...actor,
      before,
      after,
    },
    db,
    log,
  );
}

/** Creates a vehicle for a driver. The caller checks the driver exists and is not erased. */
export async function createVehicle(
  driverId: string,
  fields: VehicleFields & { make: string; model: string },
  actor: AuditActorInfo,
  log: AuditLog,
): Promise<Vehicle> {
  const values = normalizeFields(fields);
  if (values.autochargeEnabled === true && values.vin == null && values.evccid == null) {
    throw new VehicleIdRequiredError();
  }
  let vehicle: Vehicle | undefined;
  try {
    [vehicle] = await db
      .insert(vehicles)
      .values({
        driverId,
        make: values.make ?? null,
        model: values.model ?? null,
        year: values.year ?? null,
        vin: values.vin ?? null,
        licensePlate: values.licensePlate ?? null,
        evccid: values.evccid ?? null,
        autochargeEnabled: values.autochargeEnabled ?? false,
      })
      .returning();
  } catch (err) {
    throw mapConstraintError(err);
  }
  if (vehicle == null) throw new Error('Vehicle insert returned no row');
  await audit('created', vehicle, actor, log, null, vehicle);
  return vehicle;
}

/**
 * Updates a driver's vehicle. A driver actor cannot turn Autocharge on while
 * the vehicle is blocked. A vehicle of another driver answers like a missing
 * one.
 */
export async function updateVehicle(
  driverId: string,
  vehicleId: string,
  fields: VehicleFields,
  actor: AuditActorInfo,
  log: AuditLog,
): Promise<Vehicle> {
  const values = normalizeFields(fields);
  let result: { before: Vehicle; after: Vehicle };
  try {
    result = await db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(vehicles)
        .where(and(eq(vehicles.id, vehicleId), eq(vehicles.driverId, driverId)))
        .for('update');
      if (before == null) throw new VehicleNotFoundError();
      if (
        values.autochargeEnabled === true &&
        !before.autochargeEnabled &&
        before.autochargeBlockedAt != null &&
        actor.actor === 'driver'
      ) {
        throw new VehicleBlockedError();
      }
      const set: Partial<typeof vehicles.$inferInsert> = { updatedAt: new Date() };
      if (values.make !== undefined) set.make = values.make;
      if (values.model !== undefined) set.model = values.model;
      if (values.year !== undefined) set.year = values.year;
      if (values.vin !== undefined) set.vin = values.vin;
      if (values.licensePlate !== undefined) set.licensePlate = values.licensePlate;
      if (values.evccid !== undefined) set.evccid = values.evccid;
      if (values.autochargeEnabled !== undefined) set.autochargeEnabled = values.autochargeEnabled;
      const vin = set.vin !== undefined ? set.vin : before.vin;
      const evccid = set.evccid !== undefined ? set.evccid : before.evccid;
      const enabled = set.autochargeEnabled ?? before.autochargeEnabled;
      if (enabled && vin == null && evccid == null) throw new VehicleIdRequiredError();
      const [after] = await tx
        .update(vehicles)
        .set(set)
        .where(eq(vehicles.id, vehicleId))
        .returning();
      if (after == null) throw new VehicleNotFoundError();
      return { before, after };
    });
  } catch (err) {
    throw mapConstraintError(err);
  }
  await audit(
    auditAction(result.before, result.after),
    result.after,
    actor,
    log,
    result.before,
    result.after,
  );
  return result.after;
}

/** Deletes a driver's vehicle. A vehicle of another driver answers like a missing one. */
export async function deleteVehicle(
  driverId: string,
  vehicleId: string,
  actor: AuditActorInfo,
  log: AuditLog,
): Promise<void> {
  // One statement, so a concurrent delete cannot audit twice.
  const [deleted] = await db
    .delete(vehicles)
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.driverId, driverId)))
    .returning();
  if (deleted == null) throw new VehicleNotFoundError();
  await audit('deleted', deleted, actor, log, deleted, null);
}

/**
 * Operator block: the vehicle's ids are refused at every start (Autocharge on
 * or off) and the driver cannot turn Autocharge back on. Unblocking leaves
 * Autocharge as it was. A request that changes nothing writes no audit row.
 */
export async function setVehicleBlocked(
  driverId: string,
  vehicleId: string,
  blocked: boolean,
  actor: AuditActorInfo,
  log: AuditLog,
): Promise<Vehicle> {
  const result = await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(vehicles)
      .where(and(eq(vehicles.id, vehicleId), eq(vehicles.driverId, driverId)))
      .for('update');
    if (before == null) throw new VehicleNotFoundError();
    if ((before.autochargeBlockedAt != null) === blocked) return { before, after: before };
    const [after] = await tx
      .update(vehicles)
      .set({ autochargeBlockedAt: blocked ? new Date() : null, updatedAt: new Date() })
      .where(eq(vehicles.id, vehicleId))
      .returning();
    if (after == null) throw new VehicleNotFoundError();
    return { before, after };
  });
  if (result.after !== result.before) {
    await audit(
      blocked ? 'autocharge_blocked' : 'autocharge_unblocked',
      result.after,
      actor,
      log,
      result.before,
      result.after,
    );
  }
  return result.after;
}

export type ClaimTarget =
  | { vehicleId: string }
  | { vehicle: { make: string; model: string; year?: string | null | undefined } };

/**
 * "Use This Vehicle for Plug-In Charging": stores the vehicle id the charger
 * sent for a session on a new or existing vehicle of the session's driver
 * (the VIN, or the EVCCID for an EVCCID or MAC address), optionally turns
 * Autocharge on, and links the session to the vehicle. Only the session's
 * driver can be the owner: `driverId` is the caller's driver (portal) or the
 * session's driver (operator), and a session of another driver answers like
 * a missing one.
 */
export async function claimSessionVehicleId(
  args: {
    sessionId: string;
    driverId: string;
    target: ClaimTarget;
    enableAutocharge: boolean;
  },
  actor: AuditActorInfo,
  log: AuditLog,
): Promise<{ vehicle: Vehicle; created: boolean; previousSessionVehicleId: string | null }> {
  let result: {
    before: Vehicle | null;
    vehicle: Vehicle;
    previousSessionVehicleId: string | null;
  };
  try {
    result = await db.transaction(async (tx) => {
      const [session] = await tx
        .select({
          driverId: chargingSessions.driverId,
          vehicleId: chargingSessions.vehicleId,
          value: chargingSessions.vehicleIdValue,
          type: chargingSessions.vehicleIdType,
        })
        .from(chargingSessions)
        .where(eq(chargingSessions.id, args.sessionId))
        .for('update');
      if (session == null || session.driverId !== args.driverId) {
        throw new SessionNotFoundError();
      }
      if (session.value == null || !isVehicleIdType(session.type)) {
        throw new SessionNoVehicleIdError();
      }
      const column = vehicleIdColumn(session.type);
      let before: Vehicle | null = null;
      let vehicle: Vehicle | undefined;
      if ('vehicleId' in args.target) {
        const [existing] = await tx
          .select()
          .from(vehicles)
          .where(and(eq(vehicles.id, args.target.vehicleId), eq(vehicles.driverId, args.driverId)))
          .for('update');
        if (existing == null) throw new VehicleNotFoundError();
        if (
          args.enableAutocharge &&
          !existing.autochargeEnabled &&
          existing.autochargeBlockedAt != null &&
          actor.actor === 'driver'
        ) {
          throw new VehicleBlockedError();
        }
        before = existing;
        [vehicle] = await tx
          .update(vehicles)
          .set({
            ...(column === 'vin' ? { vin: session.value } : { evccid: session.value }),
            ...(args.enableAutocharge ? { autochargeEnabled: true } : {}),
            updatedAt: new Date(),
          })
          .where(eq(vehicles.id, existing.id))
          .returning();
      } else {
        const [driver] = await tx
          .select({ id: drivers.id, erasedAt: drivers.erasedAt })
          .from(drivers)
          .where(eq(drivers.id, args.driverId));
        if (driver == null || driver.erasedAt != null) throw new VehicleDriverNotFoundError();
        [vehicle] = await tx
          .insert(vehicles)
          .values({
            driverId: args.driverId,
            make: args.target.vehicle.make,
            model: args.target.vehicle.model,
            year: args.target.vehicle.year ?? null,
            ...(column === 'vin' ? { vin: session.value } : { evccid: session.value }),
            autochargeEnabled: args.enableAutocharge,
          })
          .returning();
      }
      if (vehicle == null) throw new VehicleNotFoundError();
      await tx
        .update(chargingSessions)
        .set({ vehicleId: vehicle.id, updatedAt: new Date() })
        .where(eq(chargingSessions.id, args.sessionId));
      return { before, vehicle, previousSessionVehicleId: session.vehicleId };
    });
  } catch (err) {
    throw mapConstraintError(err);
  }

  if (result.before == null) {
    await audit('created', result.vehicle, actor, log, null, result.vehicle);
  }
  await audit('vehicle_id_claimed', result.vehicle, actor, log, result.before, result.vehicle);
  if (result.previousSessionVehicleId !== result.vehicle.id) {
    await writeAudit(
      { table: sessionAuditLog, idColumn: 'session_id' },
      {
        entityId: args.sessionId,
        entityIdSnapshot: args.sessionId,
        action: 'vehicle_changed',
        ...actor,
        before: { vehicleId: result.previousSessionVehicleId },
        after: { vehicleId: result.vehicle.id },
      },
      db,
      log,
    );
  }
  return {
    vehicle: result.vehicle,
    created: result.before == null,
    previousSessionVehicleId: result.previousSessionVehicleId,
  };
}
