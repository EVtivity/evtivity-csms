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
 * - A driver turns it on, or changes an id while it is on, only when every id
 *   of the vehicle was sent by a charger in one of the driver's own sessions
 *   (the session vehicle id claim): 409 `AUTOCHARGE_CLAIM_REQUIRED`.
 *   An operator may turn it on for any vehicle.
 * - A captured id is claimed only by the session's own driver.
 */

import { and, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  drivers,
  vehicles,
  vehicleAuditLog,
  sessionAuditLog,
  writeAudit,
  markSitePlanStale,
  isFleetChargingEnabled,
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
import type { VehicleBodyType, VehicleColor } from '@evtivity/lib/vehicle-appearance';
import { ValidationError } from '@evtivity/lib';
import type { AuditActorInfo } from '../lib/audit-actor.js';
import { tokenVehicleIdKeySql } from '../lib/token-vehicle-id-sql.js';

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
export class AutochargeClaimRequiredError extends Error {
  constructor() {
    super(
      'Autocharge works only with vehicle ids a charger sent in one of your sessions. Use the vehicle id from a session first.',
    );
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
export class SessionNotActiveError extends Error {
  constructor() {
    super('The session is not active');
  }
}
export class SessionVehicleOperatorAssignedError extends Error {
  constructor() {
    super(
      'An operator assigned the vehicle of this session for the depot charging plan; only an operator can change it',
    );
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
  color?: VehicleColor | null | undefined;
  bodyType?: VehicleBodyType | null | undefined;
  evccid?: string | null | undefined;
  autochargeEnabled?: boolean | undefined;
  /** Usable battery size in kWh (1 to 2000); needed for state of charge departure targets. */
  batteryCapacityKwh?: number | null | undefined;
  /** The power the vehicle accepts in kW (1 to 3750); null means the charger maximum. */
  maxChargePowerKw?: number | null | undefined;
  /** Power the vehicle draws while it preconditions in kW (0.5 to 500); null reserves nothing. */
  preconditioningPowerKw?: number | null | undefined;
  /** Length of a preconditioning window that names no start, in minutes (5 to 240). */
  preconditioningMinutes?: number | undefined;
}

export const VEHICLE_BATTERY_CAPACITY_KWH = { min: 1, max: 2000 } as const;
export const VEHICLE_MAX_CHARGE_POWER_KW = { min: 1, max: 3750 } as const;
export const VEHICLE_PRECONDITIONING_POWER_KW = { min: 0.5, max: 500 } as const;
export const VEHICLE_PRECONDITIONING_MINUTES = { min: 5, max: 240 } as const;

/** The preconditioning window length: undefined leaves it, a whole number in range is stored. */
export function preconditioningMinutesValue(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const { min, max } = VEHICLE_PRECONDITIONING_MINUTES;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`preconditioningMinutes is ${String(min)} to ${String(max)}`, {
      field: 'preconditioningMinutes',
    });
  }
  return value;
}

/**
 * The numeric column value of a battery field: undefined leaves it, null clears
 * it, a number is checked against its range and stored with two decimals.
 */
export function batteryColumn(
  value: number | null | undefined,
  range: { min: number; max: number },
  field: string,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (!Number.isFinite(value) || value < range.min || value > range.max) {
    throw new ValidationError(`${field} is ${String(range.min)} to ${String(range.max)}`, {
      field,
    });
  }
  return value.toFixed(2);
}

/** The normalized form of the id fields; throws VehicleIdInvalidError on a bad value. */
function normalizeFields(fields: VehicleFields): VehicleFields {
  const out: VehicleFields = { ...fields };
  batteryColumn(fields.batteryCapacityKwh, VEHICLE_BATTERY_CAPACITY_KWH, 'batteryCapacityKwh');
  batteryColumn(fields.maxChargePowerKw, VEHICLE_MAX_CHARGE_POWER_KW, 'maxChargePowerKw');
  batteryColumn(
    fields.preconditioningPowerKw,
    VEHICLE_PRECONDITIONING_POWER_KW,
    'preconditioningPowerKw',
  );
  preconditioningMinutesValue(fields.preconditioningMinutes);
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

type Conn = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A card of another driver (or of no driver) whose value is one of the
 * vehicle's ids in any spelling: answered 409 VEHICLE_ID_IN_USE when a
 * vehicle id is set or Autocharge is turned on, for drivers and operators. A
 * card wins over a vehicle on an untyped 1.6 Authorize, so the card's holder
 * would take over the car's starts (the card registered
 * before the vehicle id). Values compare as `tokenVehicleIdKeySql`, the SQL
 * mirror of `tokenVehicleIdCandidates` (@evtivity/lib/vehicle-id). Vehicle ids
 * are stored normalized. Stored card values keep their spelling, so this scans
 * the cards; vehicle id changes are rare.
 */
async function assertNoOtherDriversCard(
  conn: Conn,
  driverId: string,
  ids: { vin: string | null; evccid: string | null },
): Promise<void> {
  const wanted = [ids.vin, ids.evccid].filter((v): v is string => v != null);
  if (wanted.length === 0) return;
  const rows = await conn.execute<{ hit: number }>(sql`
    SELECT 1 AS hit FROM driver_tokens
    WHERE driver_id IS DISTINCT FROM ${driverId}
      AND ${tokenVehicleIdKeySql(sql`id_token`)} IN (${sql.join(
        wanted.map((v) => sql`${v}`),
        sql`, `,
      )})
    LIMIT 1
  `);
  if (rows.length > 0) throw new VehicleIdInUseError();
}

/**
 * The checks before a driver's vehicle ends with Autocharge on after a change
 * of the switch or an id: no other vehicle uses an id for Autocharge (409
 * VEHICLE_ID_IN_USE, as the unique indexes would answer), and every id of the
 * vehicle was sent by a charger in a session of this driver (409
 * AUTOCHARGE_CLAIM_REQUIRED). Without the second check a driver could put
 * another car's VIN or EVCCID on an own vehicle and take over its starts
 * while its owner has Autocharge off.
 */
async function assertDriverMayEnableAutocharge(
  conn: Conn,
  driverId: string,
  vehicleId: string | null,
  ids: { vin: string | null; evccid: string | null },
): Promise<void> {
  const matches: SQL[] = [];
  if (ids.vin != null) matches.push(eq(vehicles.vin, ids.vin));
  if (ids.evccid != null) matches.push(eq(vehicles.evccid, ids.evccid));
  if (matches.length === 0) throw new VehicleIdRequiredError();
  const [inUse] = await conn
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(
      and(
        eq(vehicles.autochargeEnabled, true),
        or(...matches),
        vehicleId != null ? ne(vehicles.id, vehicleId) : undefined,
      ),
    )
    .limit(1);
  if (inUse != null) throw new VehicleIdInUseError();
  const wanted = [ids.vin, ids.evccid].filter((v): v is string => v != null);
  const seen = await conn
    .selectDistinct({ value: chargingSessions.vehicleIdValue })
    .from(chargingSessions)
    .where(
      and(
        eq(chargingSessions.driverId, driverId),
        inArray(chargingSessions.vehicleIdValue, wanted),
      ),
    );
  const seenValues = new Set(seen.map((r) => r.value));
  if (wanted.some((v) => !seenValues.has(v))) throw new AutochargeClaimRequiredError();
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
  await assertNoOtherDriversCard(db, driverId, {
    vin: values.vin ?? null,
    evccid: values.evccid ?? null,
  });
  if (values.autochargeEnabled === true && actor.actor === 'driver') {
    await assertDriverMayEnableAutocharge(db, driverId, null, {
      vin: values.vin ?? null,
      evccid: values.evccid ?? null,
    });
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
        color: values.color ?? null,
        bodyType: values.bodyType ?? null,
        evccid: values.evccid ?? null,
        autochargeEnabled: values.autochargeEnabled ?? false,
        batteryCapacityKwh:
          batteryColumn(
            values.batteryCapacityKwh,
            VEHICLE_BATTERY_CAPACITY_KWH,
            'batteryCapacityKwh',
          ) ?? null,
        maxChargePowerKw:
          batteryColumn(values.maxChargePowerKw, VEHICLE_MAX_CHARGE_POWER_KW, 'maxChargePowerKw') ??
          null,
        preconditioningPowerKw:
          batteryColumn(
            values.preconditioningPowerKw,
            VEHICLE_PRECONDITIONING_POWER_KW,
            'preconditioningPowerKw',
          ) ?? null,
        ...(values.preconditioningMinutes !== undefined
          ? { preconditioningMinutes: values.preconditioningMinutes }
          : {}),
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
      if (values.color !== undefined) set.color = values.color;
      if (values.bodyType !== undefined) set.bodyType = values.bodyType;
      if (values.evccid !== undefined) set.evccid = values.evccid;
      if (values.autochargeEnabled !== undefined) set.autochargeEnabled = values.autochargeEnabled;
      const capacity = batteryColumn(
        values.batteryCapacityKwh,
        VEHICLE_BATTERY_CAPACITY_KWH,
        'batteryCapacityKwh',
      );
      if (capacity !== undefined) set.batteryCapacityKwh = capacity;
      const maxPower = batteryColumn(
        values.maxChargePowerKw,
        VEHICLE_MAX_CHARGE_POWER_KW,
        'maxChargePowerKw',
      );
      if (maxPower !== undefined) set.maxChargePowerKw = maxPower;
      const preconditioningPower = batteryColumn(
        values.preconditioningPowerKw,
        VEHICLE_PRECONDITIONING_POWER_KW,
        'preconditioningPowerKw',
      );
      if (preconditioningPower !== undefined) set.preconditioningPowerKw = preconditioningPower;
      if (values.preconditioningMinutes !== undefined) {
        set.preconditioningMinutes = values.preconditioningMinutes;
      }
      const vin = set.vin !== undefined ? set.vin : before.vin;
      const evccid = set.evccid !== undefined ? set.evccid : before.evccid;
      const enabled = set.autochargeEnabled ?? before.autochargeEnabled;
      if (enabled && vin == null && evccid == null) throw new VehicleIdRequiredError();
      const idsChanged = vin !== before.vin || evccid !== before.evccid;
      if (idsChanged || (enabled && !before.autochargeEnabled)) {
        await assertNoOtherDriversCard(tx, driverId, { vin, evccid });
      }
      if (enabled && actor.actor === 'driver' && (!before.autochargeEnabled || idsChanged)) {
        await assertDriverMayEnableAutocharge(tx, driverId, vehicleId, { vin, evccid });
      }
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
        const ids = {
          vin: column === 'vin' ? session.value : existing.vin,
          evccid: column === 'vin' ? existing.evccid : session.value,
        };
        await assertNoOtherDriversCard(tx, args.driverId, ids);
        if (actor.actor === 'driver' && (args.enableAutocharge || existing.autochargeEnabled)) {
          await assertDriverMayEnableAutocharge(tx, args.driverId, existing.id, ids);
        }
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
        await assertNoOtherDriversCard(
          tx,
          args.driverId,
          column === 'vin'
            ? { vin: session.value, evccid: null }
            : { vin: null, evccid: session.value },
        );
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

/**
 * The vehicles an operator may assign to a session: a session with a driver
 * takes the driver's own vehicle or a vehicle of a driver in a fleet the
 * session's driver belongs to; only a session without a driver takes a vehicle
 * of a driver in any fleet that holds the session's station.
 */
export function assignableSessionVehicle(
  vehicleId: string,
  session: { driverId: string | null; stationId: string },
): SQL | undefined {
  return and(
    eq(vehicles.id, vehicleId),
    session.driverId != null
      ? or(
          eq(vehicles.driverId, session.driverId),
          sql`EXISTS (
            SELECT 1 FROM fleet_drivers owner_fd
            JOIN fleet_drivers session_fd ON session_fd.fleet_id = owner_fd.fleet_id
            WHERE owner_fd.driver_id = ${vehicles.driverId}
              AND session_fd.driver_id = ${session.driverId}
          )`,
        )
      : sql`EXISTS (
          SELECT 1 FROM fleet_drivers fd
          JOIN fleet_stations fs ON fs.fleet_id = fd.fleet_id
          WHERE fd.driver_id = ${vehicles.driverId} AND fs.station_id = ${session.stationId}
        )`,
  );
}

/**
 * Sets the vehicle of an active session by hand (route-aware charging: a bus
 * that plugged in without a card of its own). The vehicle belongs to the
 * session's driver or to a driver of a fleet the session's driver belongs to;
 * a session without a driver takes a vehicle of a driver of a fleet that holds
 * the session's station. Any other vehicle answers like a missing one. Only the vehicle
 * changes: the session keeps its driver, token and billing. A session outside
 * the caller's sites answers like a missing one. Audited on the session and
 * the vehicle; the site's depot plan is marked stale.
 */
export async function assignSessionVehicle(
  args: { sessionId: string; vehicleId: string; siteScope: string[] | null },
  actor: AuditActorInfo,
  log: AuditLog,
): Promise<{
  sessionId: string;
  vehicleId: string;
  previousVehicleId: string | null;
  changed: boolean;
}> {
  const result = await db.transaction(async (tx) => {
    const [session] = await tx
      .select({
        driverId: chargingSessions.driverId,
        stationId: chargingSessions.stationId,
        siteId: chargingSessions.siteId,
        status: chargingSessions.status,
        vehicleId: chargingSessions.vehicleId,
      })
      .from(chargingSessions)
      .where(eq(chargingSessions.id, args.sessionId))
      .for('update');
    if (
      session == null ||
      (args.siteScope != null &&
        (session.siteId == null || !args.siteScope.includes(session.siteId)))
    ) {
      throw new SessionNotFoundError();
    }
    if (session.status !== 'active') throw new SessionNotActiveError();
    const [allowed] = await tx
      .select({ id: vehicles.id })
      .from(vehicles)
      .where(assignableSessionVehicle(args.vehicleId, session));
    if (allowed == null) throw new VehicleNotFoundError();
    if (session.vehicleId === args.vehicleId) {
      return { siteId: session.siteId, previousVehicleId: session.vehicleId, changed: false };
    }
    await tx
      .update(chargingSessions)
      .set({ vehicleId: args.vehicleId, vehicleAssignedByOperator: true, updatedAt: new Date() })
      .where(eq(chargingSessions.id, args.sessionId));
    return { siteId: session.siteId, previousVehicleId: session.vehicleId, changed: true };
  });

  if (result.changed) {
    await writeAudit(
      { table: sessionAuditLog, idColumn: 'session_id' },
      {
        entityId: args.sessionId,
        entityIdSnapshot: args.sessionId,
        action: 'vehicle_changed',
        ...actor,
        before: { vehicleId: result.previousVehicleId },
        after: { vehicleId: args.vehicleId },
        notes: 'Vehicle assigned by an operator',
      },
      db,
      log,
    );
    await writeAudit(
      { table: vehicleAuditLog, idColumn: 'vehicle_id' },
      {
        entityId: args.vehicleId,
        entityIdSnapshot: args.vehicleId,
        action: 'updated',
        ...actor,
        before: null,
        after: null,
        notes: 'Assigned to a charging session by an operator',
      },
      db,
      log,
    );
    if (result.siteId != null) {
      // The writer logs a failed mark with its own logger (fail-open).
      await markSitePlanStale(result.siteId, 'session_vehicle_assigned', undefined, {
        departureAwareOnly: true,
      });
    }
  }
  return {
    sessionId: args.sessionId,
    vehicleId: args.vehicleId,
    previousVehicleId: result.previousVehicleId,
    changed: result.changed,
  };
}

/**
 * True while the depot plan charges the session: an active session at a site
 * with load management on, the Departure Aware strategy and Fleet Charging on.
 */
async function departurePlanCharges(
  tx: Pick<typeof db, 'execute'>,
  siteId: string | null,
): Promise<boolean> {
  if (siteId == null || !(await isFleetChargingEnabled())) return false;
  const rows = (await tx.execute(sql`SELECT 1 AS planned FROM site_load_management
    WHERE site_id = ${siteId} AND is_enabled AND strategy = 'departure_aware'`)) as unknown as unknown[];
  return rows.length > 0;
}

/**
 * Sets or clears the vehicle of the driver's own session (the portal). The
 * vehicle is the driver's own; another driver's session or vehicle answers
 * like a missing one. While the depot plan charges an active session, a
 * vehicle an operator assigned stays: replacing or clearing it answers
 * SessionVehicleOperatorAssignedError (security case 314). Audited on the
 * session; any change marks the site's depot plan stale.
 */
export async function setDriverSessionVehicle(
  args: { sessionId: string; driverId: string; vehicleId: string | null },
  actor: AuditActorInfo,
  log: AuditLog,
): Promise<{ vehicleId: string | null; changed: boolean }> {
  const result = await db.transaction(async (tx) => {
    const [session] = await tx
      .select({
        siteId: chargingSessions.siteId,
        status: chargingSessions.status,
        vehicleId: chargingSessions.vehicleId,
        assignedByOperator: chargingSessions.vehicleAssignedByOperator,
      })
      .from(chargingSessions)
      .where(
        and(eq(chargingSessions.id, args.sessionId), eq(chargingSessions.driverId, args.driverId)),
      )
      .for('update');
    if (session == null) throw new SessionNotFoundError();
    if (args.vehicleId != null) {
      const [vehicle] = await tx
        .select({ driverId: vehicles.driverId })
        .from(vehicles)
        .where(eq(vehicles.id, args.vehicleId));
      if (vehicle?.driverId !== args.driverId) throw new VehicleNotFoundError();
    }
    const previousVehicleId = session.vehicleId ?? null;
    if (previousVehicleId === args.vehicleId) {
      return { siteId: session.siteId, previousVehicleId, changed: false };
    }
    if (
      session.assignedByOperator &&
      previousVehicleId != null &&
      session.status === 'active' &&
      (await departurePlanCharges(tx, session.siteId))
    ) {
      throw new SessionVehicleOperatorAssignedError();
    }
    await tx
      .update(chargingSessions)
      .set({ vehicleId: args.vehicleId, vehicleAssignedByOperator: false, updatedAt: new Date() })
      .where(eq(chargingSessions.id, args.sessionId));
    return { siteId: session.siteId, previousVehicleId, changed: true };
  });

  if (result.changed) {
    await writeAudit(
      { table: sessionAuditLog, idColumn: 'session_id' },
      {
        entityId: args.sessionId,
        entityIdSnapshot: args.sessionId,
        action: 'vehicle_changed',
        ...actor,
        before: { vehicleId: result.previousVehicleId },
        after: { vehicleId: args.vehicleId },
      },
      db,
      log,
    );
    if (result.siteId != null) {
      // The writer logs a failed mark with its own logger (fail-open).
      await markSitePlanStale(result.siteId, 'session_vehicle_changed', undefined, {
        departureAwareOnly: true,
      });
    }
  }
  return { vehicleId: args.vehicleId, changed: result.changed };
}
