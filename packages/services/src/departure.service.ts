// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Departures and weekly departure schedules of fleet vehicles (route-aware
// charging). Every change goes through here: the rules, the audit row in
// vehicle_departure_audit_log, the stale mark of the site plan and the change
// hook (the routes publish it as a server-sent event). The writer is
// @evtivity/database lib/vehicle-departures.ts. Callers pass the sites the
// caller may act on (null for every site); a site outside them is not found.

import {
  cancelScheduledDepartures,
  db,
  getDepotSystem,
  deleteDepartureSchedule as removeDepartureSchedule,
  deleteUnusedScheduleOccurrences,
  futureScheduleOccurrences,
  getDeparture,
  getDepartureSchedule,
  getDepartureSite,
  getDepartureVehicle,
  getVehicleBatteryCapacity,
  insertDeparture,
  insertDepartureSchedule,
  insertScheduleOccurrences,
  markSitePlanStale,
  updateDepartureSchedule as writeDepartureSchedule,
  updateScheduledDeparture,
  vehicleDayDepartureCounts,
  vehicleDepartureAuditLog,
  writeAudit,
  type DepartureChanges,
  type DepartureDb,
  type NewVehicleDeparture,
  type ScheduleChanges,
  type SimAuditActor,
  type VehicleDeparture,
  type VehicleDepartureSchedule,
} from '@evtivity/database';
import { AppError, ValidationError } from '@evtivity/lib';
import type { ServiceLogger } from '@evtivity/lib';
import type { DepartureTarget } from '@evtivity/lib/charging-plan';
import { localDateInZone, scheduleOccurrences } from '@evtivity/lib/departure-schedule';

/** Local dates a schedule expands ahead, today included (today plus 7 days). */
export const DEPARTURE_EXPANSION_DAYS = 8;
/** A one-off departure is at least this far ahead. */
export const DEPARTURE_MIN_LEAD_MS = 5 * 60_000;
/** A one-off departure is at most this far ahead. */
export const DEPARTURE_MAX_AHEAD_MS = 30 * 86_400_000;
export const DEPARTURE_PRIORITY_DEFAULT = 5;

/**
 * Where a departure that is not a schedule occurrence came from. Bus depot
 * system requests go through depot-system-requests.ts.
 */
export type DepartureEntrySource = 'manual' | 'import' | 'vehicle';

export class DepartureNotFoundError extends AppError {
  constructor() {
    super('Departure not found', 404, 'DEPARTURE_NOT_FOUND');
    this.name = 'DepartureNotFoundError';
  }
}

export class DepartureNotScheduledError extends AppError {
  constructor() {
    super('Only a scheduled departure can change', 409, 'DEPARTURE_NOT_SCHEDULED');
    this.name = 'DepartureNotScheduledError';
  }
}

export class DepartureScheduleNotFoundError extends AppError {
  constructor() {
    super('Departure schedule not found', 404, 'DEPARTURE_SCHEDULE_NOT_FOUND');
    this.name = 'DepartureScheduleNotFoundError';
  }
}

export class VehicleNotInFleetError extends AppError {
  constructor() {
    super('The vehicle does not belong to a driver of this fleet', 400, 'VEHICLE_NOT_IN_FLEET');
    this.name = 'VehicleNotInFleetError';
  }
}

export class DepartureSiteNotFoundError extends AppError {
  constructor() {
    super('Site not found', 404, 'SITE_NOT_FOUND');
    this.name = 'DepartureSiteNotFoundError';
  }
}

/** What changed, for the change hook (the routes publish it per site). */
export interface DepartureChange {
  kind: 'schedule' | 'departure' | 'import';
  id: string;
  siteIds: string[];
}

export interface DepartureCtx {
  actor: SimAuditActor;
  /** The sites the caller may act on; null for every site. */
  siteScope: string[] | null;
  log?: ServiceLogger;
  /** Called after each committed change. Failures are logged, never thrown. */
  onChange?: (change: DepartureChange) => void | Promise<void>;
  now?: () => Date;
  /**
   * The caller marks the site plans stale itself and sends the change event once
   * (the CSV import does both per site at the end), so each write skips them.
   */
  deferChangeEffects?: boolean;
}

export interface ScheduleInput {
  fleetId: string;
  vehicleId: string;
  siteId: string;
  daysOfWeek: number[];
  departureTime: string;
  target: DepartureTarget;
  priority?: number;
  validFrom?: string | null;
  validTo?: string | null;
  isActive?: boolean;
  notes?: string | null;
}

export interface ScheduleUpdate {
  siteId?: string;
  daysOfWeek?: number[];
  departureTime?: string;
  target?: DepartureTarget;
  priority?: number;
  validFrom?: string | null;
  validTo?: string | null;
  isActive?: boolean;
  notes?: string | null;
}

/**
 * A departure from any source: an operator, an import, or later the vehicle or
 * a depot management system (vehicle id, departure time, target SoC).
 */
export interface DepartureInput {
  fleetId: string;
  vehicleId: string;
  siteId: string;
  departureAt: Date;
  target: DepartureTarget;
  priority?: number;
  source: DepartureEntrySource;
  /** When the vehicle is expected to plug in, before the departure. */
  expectedArrivalAt?: Date | null;
  /** State of charge expected at arrival (0 to 100), used until the vehicle reports one. */
  expectedArrivalSocPercent?: number | null;
}

export interface DepartureUpdate {
  departureAt?: Date;
  target?: DepartureTarget;
  priority?: number;
  /** Null removes it. */
  expectedArrivalAt?: Date | null;
  /** Null removes it. */
  expectedArrivalSocPercent?: number | null;
}

export interface OccurrenceCounts {
  occurrencesCreated: number;
  occurrencesUpdated: number;
  /** Removed: nothing referred to them yet. */
  occurrencesRemoved: number;
  /** Cancelled: they had a session or a sent notice. */
  occurrencesCancelled: number;
}

export interface ScheduleWriteResult extends OccurrenceCounts {
  schedule: VehicleDepartureSchedule;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ---------- validation ----------

type TargetColumns = Pick<
  NewVehicleDeparture,
  'targetKind' | 'targetEnergyKwh' | 'targetSocPercent' | 'targetSocMaxPercent'
>;

function targetColumns(target: DepartureTarget): TargetColumns {
  if (target.kind === 'energy') {
    const kwh = target.targetKwh;
    if (!Number.isFinite(kwh) || kwh < 0.1 || kwh > 2000) {
      throw new ValidationError('The target energy is 0.1 to 2000 kWh', { field: 'targetKwh' });
    }
    return {
      targetKind: 'energy',
      targetEnergyKwh: kwh.toFixed(2),
      targetSocPercent: null,
      targetSocMaxPercent: null,
    };
  }
  const soc = target.targetSoc;
  if (!Number.isInteger(soc) || soc < 1 || soc > 100) {
    throw new ValidationError('The target state of charge is 1 to 100 percent', {
      field: 'targetSoc',
    });
  }
  const max = target.maxSoc ?? null;
  if (max != null && (!Number.isInteger(max) || max < soc || max > 100)) {
    throw new ValidationError(
      'The maximum state of charge is a whole percent from the target to 100',
      { field: 'targetSocMax' },
    );
  }
  return {
    targetKind: 'soc',
    targetEnergyKwh: null,
    targetSocPercent: soc,
    targetSocMaxPercent: max != null && max > soc ? max : null,
  };
}

function checkPriority(priority: number): number {
  if (!Number.isInteger(priority) || priority < 1 || priority > 10) {
    throw new ValidationError('The priority is 1 to 10', { field: 'priority' });
  }
  return priority;
}

function checkDays(days: number[]): number[] {
  const unique = [...new Set(days)].sort((a, b) => a - b);
  if (unique.length === 0 || unique.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    throw new ValidationError('The days of the week are 1 (Monday) to 7 (Sunday)', {
      field: 'daysOfWeek',
    });
  }
  return unique;
}

function checkTime(time: string): string {
  if (!TIME_PATTERN.test(time)) {
    throw new ValidationError('The departure time is HH:MM', { field: 'departureTime' });
  }
  return time;
}

function checkDate(value: string | null | undefined, field: string): string | null {
  if (value == null) return null;
  if (!DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ValidationError('The date is YYYY-MM-DD', { field });
  }
  return value;
}

function checkNotes(notes: string | null | undefined): string | null {
  if (notes == null) return null;
  if (notes.length > 500) {
    throw new ValidationError('The notes are at most 500 characters', { field: 'notes' });
  }
  return notes;
}

/**
 * The expected arrival of a departure: a valid time before the departure and
 * at most 30 days ahead, and a whole state of charge of 0 to 100. Undefined
 * leaves a value, null removes it.
 */
export function checkExpectedArrival(
  arrivalAt: Date | null | undefined,
  socPercent: number | null | undefined,
  departureAt: Date | null,
  now: Date,
): void {
  if (arrivalAt != null) {
    const at = arrivalAt.getTime();
    if (!Number.isFinite(at) || at > now.getTime() + DEPARTURE_MAX_AHEAD_MS) {
      throw new ValidationError('The expected arrival is not a valid time', {
        field: 'expectedArrivalAt',
      });
    }
    if (departureAt != null && at >= departureAt.getTime()) {
      throw new ValidationError('The expected arrival is before the departure', {
        field: 'expectedArrivalAt',
      });
    }
  }
  if (socPercent != null && (!Number.isInteger(socPercent) || socPercent < 0 || socPercent > 100)) {
    throw new ValidationError('The state of charge at arrival is 0 to 100', {
      field: 'expectedArrivalSocPercent',
    });
  }
}

function checkDepartureTime(departureAt: Date, now: Date): Date {
  const at = departureAt.getTime();
  if (!Number.isFinite(at)) {
    throw new ValidationError('The departure time is not a valid time', { field: 'departureAt' });
  }
  if (at < now.getTime() + DEPARTURE_MIN_LEAD_MS || at > now.getTime() + DEPARTURE_MAX_AHEAD_MS) {
    throw new ValidationError('A departure is 5 minutes to 30 days ahead', {
      field: 'departureAt',
    });
  }
  return departureAt;
}

/** A SoC target needs the vehicle's battery capacity to turn into energy. */
function checkSocCapacity(target: DepartureTarget, capacityKwh: number | null): void {
  if (target.kind === 'soc' && (capacityKwh == null || capacityKwh <= 0)) {
    throw new ValidationError("A state of charge target needs the vehicle's battery capacity", {
      field: 'targetSoc',
    });
  }
}

function inScope(siteId: string, scope: string[] | null): boolean {
  return scope == null || scope.includes(siteId);
}

/** The most scheduled departures one vehicle may hold on one local day of the site. */
export const DEPARTURES_PER_VEHICLE_DAY_MAX = 20;

/** Refuses a departure on a local day that already holds the most a vehicle may have. */
async function checkVehicleDay(
  vehicleId: string,
  departureAt: Date,
  timeZone: string,
  tx: DepartureDb,
  excludeId?: string,
): Promise<void> {
  const counts = await vehicleDayDepartureCounts(vehicleId, timeZone, tx, excludeId);
  const day = localDateInZone(departureAt.getTime(), timeZone);
  if ((counts.get(day) ?? 0) >= DEPARTURES_PER_VEHICLE_DAY_MAX) {
    throw new ValidationError(
      `A vehicle can have at most ${String(DEPARTURES_PER_VEHICLE_DAY_MAX)} scheduled departures on one day`,
      { field: 'departureAt' },
    );
  }
}

async function checkSite(
  siteId: string,
  ctx: DepartureCtx,
  tx: DepartureDb,
): Promise<{ id: string; timezone: string }> {
  if (!inScope(siteId, ctx.siteScope)) throw new DepartureSiteNotFoundError();
  const site = await getDepartureSite(siteId, tx);
  if (site == null) throw new DepartureSiteNotFoundError();
  return site;
}

async function checkFleetVehicle(
  vehicleId: string,
  fleetId: string,
  tx: DepartureDb,
): Promise<number | null> {
  const vehicle = await getDepartureVehicle(vehicleId, fleetId, tx);
  if (vehicle == null || !vehicle.inFleet) throw new VehicleNotInFleetError();
  return vehicle.batteryCapacityKwh;
}

function targetOf(row: {
  targetKind: 'energy' | 'soc';
  targetEnergyKwh: string | null;
  targetSocPercent: number | null;
  targetSocMaxPercent: number | null;
}): DepartureTarget {
  return row.targetKind === 'energy'
    ? { kind: 'energy', targetKwh: Number(row.targetEnergyKwh) }
    : { kind: 'soc', targetSoc: Number(row.targetSocPercent), maxSoc: row.targetSocMaxPercent };
}

/**
 * A departure a bus depot system requested is read-only while that system is
 * enabled: the depot system decides dispatch (decision D10). Disabling or
 * deleting the system hands it back.
 */
export class DepartureManagedByDepotSystemError extends AppError {
  constructor() {
    super(
      'This departure is managed by a bus depot system; change it there, or disable the depot system',
      409,
      'DEPARTURE_MANAGED_BY_DEPOT_SYSTEM',
    );
    this.name = 'DepartureManagedByDepotSystemError';
  }
}

async function checkNotManaged(departure: VehicleDeparture, tx: DepartureDb): Promise<void> {
  if (departure.depotSystemId == null) return;
  const system = await getDepotSystem(departure.depotSystemId, tx);
  if (system?.isEnabled === true) throw new DepartureManagedByDepotSystemError();
}

// ---------- audit ----------

/** The audit view of a schedule (no ids of other records beyond its vehicle and site). */
export function scheduleAuditView(s: VehicleDepartureSchedule): Record<string, unknown> {
  return {
    entityKind: 'schedule',
    vehicleId: s.vehicleId,
    siteId: s.siteId,
    daysOfWeek: s.daysOfWeek,
    departureTime: s.departureTime,
    targetKind: s.targetKind,
    targetEnergyKwh: s.targetEnergyKwh,
    targetSocPercent: s.targetSocPercent,
    targetSocMaxPercent: s.targetSocMaxPercent,
    priority: s.priority,
    validFrom: s.validFrom,
    validTo: s.validTo,
    isActive: s.isActive,
    notes: s.notes,
  };
}

export function departureAuditView(d: VehicleDeparture): Record<string, unknown> {
  return {
    entityKind: 'departure',
    vehicleId: d.vehicleId,
    siteId: d.siteId,
    scheduleId: d.scheduleId,
    departureAt: d.departureAt?.toISOString() ?? null,
    adHoc: d.adHoc,
    targetKind: d.targetKind,
    targetEnergyKwh: d.targetEnergyKwh,
    targetSocPercent: d.targetSocPercent,
    targetSocMaxPercent: d.targetSocMaxPercent,
    expectedArrivalAt: d.expectedArrivalAt?.toISOString() ?? null,
    expectedArrivalSocPercent: d.expectedArrivalSocPercent,
    requestedEvseId: d.requestedEvseId,
    priority: d.priority,
    source: d.source,
    depotSystemId: d.depotSystemId,
    externalRequestId: d.externalRequestId,
    overridden: d.overridden,
    status: d.status,
    cancelReason: d.cancelReason,
  };
}

/**
 * Every site a departure audit row names: the site it was written at and the
 * `siteId` of its before and after views, without duplicates or nulls.
 */
export function departureAuditSiteIds(
  writtenAt: string,
  before: unknown,
  after: unknown,
): string[] {
  const named = [writtenAt];
  for (const view of [before, after]) {
    if (view != null && typeof view === 'object') {
      const site = (view as Record<string, unknown>)['siteId'];
      if (typeof site === 'string') named.push(site);
    }
  }
  return [...new Set(named)];
}

export type DepartureAuditAction =
  | 'schedule_created'
  | 'schedule_updated'
  | 'schedule_deleted'
  | 'departure_created'
  | 'departure_updated'
  | 'departure_cancelled'
  | 'departures_imported';

/**
 * Writes one audit row. Each row carries the site it belongs to at write time
 * (`auditSiteId`, the row's site after the change) and every site it names
 * (`auditSiteIds`): the audit routes scope by them, never by the live row, so
 * a schedule moved to another depot leaves its history at the old one, and a
 * row naming two sites shows only to a user of both.
 */
export async function writeDepartureAudit(
  entityId: string,
  action: DepartureAuditAction,
  siteId: string,
  before: unknown,
  after: unknown,
  ctx: DepartureCtx,
  options: { notes?: string | null; entityGone?: boolean } = {},
): Promise<void> {
  await audit(entityId, action, siteId, before, after, ctx, options);
}

async function audit(
  entityId: string,
  action: DepartureAuditAction,
  siteId: string,
  before: unknown,
  after: unknown,
  ctx: DepartureCtx,
  options: { notes?: string | null; entityGone?: boolean } = {},
): Promise<void> {
  const auditSiteIds = departureAuditSiteIds(siteId, before, after);
  const stamp = (view: unknown): unknown =>
    view != null && typeof view === 'object'
      ? { ...(view as Record<string, unknown>), auditSiteId: siteId, auditSiteIds }
      : view;
  await writeAudit(
    { table: vehicleDepartureAuditLog, idColumn: 'vehicle_departure_id' },
    {
      entityId: options.entityGone === true ? null : entityId,
      entityIdSnapshot: entityId,
      action,
      ...ctx.actor,
      before: stamp(before),
      after: stamp(after),
      notes: options.notes ?? null,
    },
    db,
    ctx.log,
  );
}

/** Marks each site's plan stale and calls the change hook; both fail open. */
async function afterChange(
  change: DepartureChange,
  trigger: string,
  ctx: DepartureCtx,
): Promise<void> {
  if (ctx.deferChangeEffects === true) return;
  for (const siteId of change.siteIds) await markSitePlanStale(siteId, trigger, ctx.log);
  if (ctx.onChange == null) return;
  try {
    await ctx.onChange(change);
  } catch (err: unknown) {
    ctx.log?.warn({ err, change }, 'Departure change event not sent, the next refresh shows it');
  }
}

function nowOf(ctx: DepartureCtx): Date {
  return ctx.now?.() ?? new Date();
}

// ---------- schedules ----------

/**
 * Creates the missing occurrences of a schedule for the next local dates (today
 * plus 7 days), in the site timezone. Occurrences already stored, in any status,
 * stay as they are, so this can run twice (the expand cron calls it too). The
 * schedule and its site are read again inside a transaction with the schedule
 * row shared-locked, so a run that races a schedule edit waits for the edit and
 * never inserts the old time.
 */
export async function expandScheduleOccurrences(
  scheduleId: string,
  now: Date,
  tx: DepartureDb = db,
): Promise<VehicleDeparture[]> {
  return tx.transaction(async (t) => {
    const schedule = await getDepartureSchedule(scheduleId, t, { forShare: true });
    if (schedule == null) return [];
    const site = await getDepartureSite(schedule.siteId, t);
    if (site == null) return [];
    return insertOccurrences(schedule, site.timezone, now, t);
  });
}

async function insertOccurrences(
  schedule: VehicleDepartureSchedule,
  timeZone: string,
  now: Date,
  tx: DepartureDb,
): Promise<VehicleDeparture[]> {
  if (!schedule.isActive) return [];
  // A day that already holds the most departures a vehicle may have gets none.
  const dayCounts = await vehicleDayDepartureCounts(schedule.vehicleId, timeZone, tx);
  const occurrences = scheduleOccurrences(
    schedule,
    timeZone,
    localDateInZone(now.getTime(), timeZone),
    DEPARTURE_EXPANSION_DAYS,
  ).filter(
    (o) =>
      o.departureAtMs > now.getTime() &&
      (dayCounts.get(o.occurrenceDate) ?? 0) < DEPARTURES_PER_VEHICLE_DAY_MAX,
  );
  return insertScheduleOccurrences(
    occurrences.map((o) => ({
      vehicleId: schedule.vehicleId,
      siteId: schedule.siteId,
      scheduleId: schedule.id,
      occurrenceDate: o.occurrenceDate,
      departureAt: new Date(o.departureAtMs),
      targetKind: schedule.targetKind,
      targetEnergyKwh: schedule.targetEnergyKwh,
      targetSocPercent: schedule.targetSocPercent,
      targetSocMaxPercent: schedule.targetSocMaxPercent,
      priority: schedule.priority,
      source: 'schedule' as const,
    })),
    tx,
  );
}

export async function createDepartureSchedule(
  input: ScheduleInput,
  ctx: DepartureCtx,
): Promise<ScheduleWriteResult> {
  const now = nowOf(ctx);
  const values = {
    vehicleId: input.vehicleId,
    siteId: input.siteId,
    daysOfWeek: checkDays(input.daysOfWeek),
    departureTime: checkTime(input.departureTime),
    ...targetColumns(input.target),
    priority: checkPriority(input.priority ?? DEPARTURE_PRIORITY_DEFAULT),
    validFrom: checkDate(input.validFrom, 'validFrom'),
    validTo: checkDate(input.validTo, 'validTo'),
    isActive: input.isActive ?? true,
    notes: checkNotes(input.notes),
  };
  if (values.validFrom != null && values.validTo != null && values.validFrom > values.validTo) {
    throw new ValidationError('The schedule ends before it starts', { field: 'validTo' });
  }
  const result = await db.transaction(async (tx) => {
    const site = await checkSite(input.siteId, ctx, tx);
    checkSocCapacity(input.target, await checkFleetVehicle(input.vehicleId, input.fleetId, tx));
    const schedule = await insertDepartureSchedule(values, tx);
    const created = await insertOccurrences(schedule, site.timezone, now, tx);
    return {
      schedule,
      occurrencesCreated: created.length,
      occurrencesUpdated: 0,
      occurrencesRemoved: 0,
      occurrencesCancelled: 0,
    };
  });
  await audit(
    result.schedule.id,
    'schedule_created',
    result.schedule.siteId,
    null,
    scheduleAuditView(result.schedule),
    ctx,
  );
  await afterChange(
    { kind: 'schedule', id: result.schedule.id, siteIds: [result.schedule.siteId] },
    'schedule_created',
    ctx,
  );
  return result;
}

async function scheduleInScope(
  id: string,
  ctx: DepartureCtx,
  tx: DepartureDb,
): Promise<VehicleDepartureSchedule> {
  const schedule = await getDepartureSchedule(id, tx, { forUpdate: true });
  if (schedule == null || !inScope(schedule.siteId, ctx.siteScope)) {
    throw new DepartureScheduleNotFoundError();
  }
  return schedule;
}

/**
 * Edits a schedule and its future occurrences that no person overrode: an
 * occurrence on a date the schedule still covers takes the new time, target,
 * priority and site; one on a date it no longer covers (or when the schedule
 * is turned off) is cancelled; missing dates are created.
 */
export async function updateDepartureSchedule(
  id: string,
  update: ScheduleUpdate,
  ctx: DepartureCtx,
): Promise<ScheduleWriteResult> {
  const now = nowOf(ctx);
  const changes: ScheduleChanges = {};
  if (update.daysOfWeek !== undefined) changes.daysOfWeek = checkDays(update.daysOfWeek);
  if (update.departureTime !== undefined) {
    changes.departureTime = checkTime(update.departureTime);
  }
  if (update.target !== undefined) Object.assign(changes, targetColumns(update.target));
  if (update.priority !== undefined) changes.priority = checkPriority(update.priority);
  if (update.validFrom !== undefined) changes.validFrom = checkDate(update.validFrom, 'validFrom');
  if (update.validTo !== undefined) changes.validTo = checkDate(update.validTo, 'validTo');
  if (update.isActive !== undefined) changes.isActive = update.isActive;
  if (update.notes !== undefined) changes.notes = checkNotes(update.notes);
  if (update.siteId !== undefined) changes.siteId = update.siteId;

  const result = await db.transaction(async (tx) => {
    const before = await scheduleInScope(id, ctx, tx);
    const validFrom = changes.validFrom !== undefined ? changes.validFrom : before.validFrom;
    const validTo = changes.validTo !== undefined ? changes.validTo : before.validTo;
    if (validFrom != null && validTo != null && validFrom > validTo) {
      throw new ValidationError('The schedule ends before it starts', { field: 'validTo' });
    }
    const site = await checkSite(changes.siteId ?? before.siteId, ctx, tx);
    const target = update.target ?? targetOf(before);
    if (target.kind === 'soc') {
      checkSocCapacity(target, await getVehicleBatteryCapacity(before.vehicleId, tx));
    }
    const real = changedFields(before, changes);
    if (Object.keys(real).length === 0) {
      return { before, schedule: before, changed: false, ...NO_OCCURRENCE_CHANGES };
    }
    const schedule = await writeDepartureSchedule(id, real, tx);
    if (schedule == null) throw new DepartureScheduleNotFoundError();
    const onlyNotes = Object.keys(real).every((key) => key === 'notes');
    const counts = onlyNotes
      ? NO_OCCURRENCE_CHANGES
      : await syncFutureOccurrences(schedule, site.timezone, now, tx);
    return { before, schedule, changed: true, ...counts };
  });

  if (!result.changed) {
    return { schedule: result.schedule, ...NO_OCCURRENCE_CHANGES };
  }
  const siteIds = [...new Set([result.before.siteId, result.schedule.siteId])];
  await audit(
    id,
    'schedule_updated',
    result.schedule.siteId,
    scheduleAuditView(result.before),
    scheduleAuditView(result.schedule),
    ctx,
    { notes: occurrenceNote(result) },
  );
  await afterChange({ kind: 'schedule', id, siteIds }, 'schedule_updated', ctx);
  return {
    schedule: result.schedule,
    occurrencesCreated: result.occurrencesCreated,
    occurrencesUpdated: result.occurrencesUpdated,
    occurrencesRemoved: result.occurrencesRemoved,
    occurrencesCancelled: result.occurrencesCancelled,
  };
}

const NO_OCCURRENCE_CHANGES: OccurrenceCounts = {
  occurrencesCreated: 0,
  occurrencesUpdated: 0,
  occurrencesRemoved: 0,
  occurrencesCancelled: 0,
};

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    const sorted = (list: unknown[]): string => JSON.stringify(list.map(String).sort());
    return sorted(a as unknown[]) === sorted(b as unknown[]);
  }
  return (a ?? null) === (b ?? null);
}

/** The asked changes that differ from the stored row: an edit without one writes nothing. */
function changedFields<C extends object>(row: object, changes: C): Partial<C> {
  const stored = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (!sameValue(stored[key], value)) out[key] = value;
  }
  return out as Partial<C>;
}

function occurrenceNote(counts: OccurrenceCounts): string | null {
  const parts: string[] = [];
  if (counts.occurrencesUpdated > 0) {
    parts.push(`${String(counts.occurrencesUpdated)} upcoming departures updated`);
  }
  if (counts.occurrencesRemoved > 0) {
    parts.push(`${String(counts.occurrencesRemoved)} upcoming departures removed`);
  }
  if (counts.occurrencesCancelled > 0) {
    parts.push(`${String(counts.occurrencesCancelled)} upcoming departures cancelled`);
  }
  if (counts.occurrencesCreated > 0) {
    parts.push(`${String(counts.occurrencesCreated)} upcoming departures added`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

async function syncFutureOccurrences(
  schedule: VehicleDepartureSchedule,
  timeZone: string,
  now: Date,
  tx: DepartureDb,
): Promise<OccurrenceCounts> {
  const future = await futureScheduleOccurrences(schedule.id, now, tx);
  const today = localDateInZone(now.getTime(), timeZone);
  const lastDate = future.reduce(
    (last, o) => (o.occurrenceDate != null && o.occurrenceDate > last ? o.occurrenceDate : last),
    today,
  );
  const span =
    Math.round(
      (Date.parse(`${lastDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
    ) + 1;
  const wanted = new Map(
    schedule.isActive
      ? scheduleOccurrences(schedule, timeZone, today, Math.max(DEPARTURE_EXPANSION_DAYS, span))
          .filter((o) => o.departureAtMs > now.getTime())
          .map((o) => [o.occurrenceDate, o.departureAtMs])
      : [],
  );
  const cancel: string[] = [];
  let updated = 0;
  for (const occurrence of future) {
    const at =
      occurrence.occurrenceDate == null ? undefined : wanted.get(occurrence.occurrenceDate);
    if (at == null) {
      cancel.push(occurrence.id);
      continue;
    }
    const real = changedFields(occurrence, {
      siteId: schedule.siteId,
      departureAt: new Date(at),
      targetKind: schedule.targetKind,
      targetEnergyKwh: schedule.targetEnergyKwh,
      targetSocPercent: schedule.targetSocPercent,
      targetSocMaxPercent: schedule.targetSocMaxPercent,
      priority: schedule.priority,
    });
    if (Object.keys(real).length === 0) continue;
    const row = await updateScheduledDeparture(occurrence.id, real, tx);
    if (row != null) updated += 1;
  }
  // Occurrences nothing refers to yet are removed, so a day added back later
  // gets a fresh one; one with a session or a sent notice is cancelled instead.
  const removed = await deleteUnusedScheduleOccurrences(cancel, now, tx);
  const removedIds = new Set(removed.map((r) => r.id));
  const cancelled = await cancelScheduledDepartures(
    cancel.filter((id) => !removedIds.has(id)),
    tx,
  );
  const created = await insertOccurrences(schedule, timeZone, now, tx);
  return {
    occurrencesCreated: created.length,
    occurrencesUpdated: updated,
    occurrencesRemoved: removed.length,
    occurrencesCancelled: cancelled.length,
  };
}

/** Deletes a schedule and cancels its future occurrences that no person overrode. */
export async function deleteDepartureSchedule(
  id: string,
  ctx: DepartureCtx,
): Promise<{ schedule: VehicleDepartureSchedule; occurrencesCancelled: number }> {
  const now = nowOf(ctx);
  const result = await db.transaction(async (tx) => {
    const schedule = await scheduleInScope(id, ctx, tx);
    const future = await futureScheduleOccurrences(id, now, tx);
    const cancelled = await cancelScheduledDepartures(
      future.map((o) => o.id),
      tx,
    );
    await removeDepartureSchedule(id, tx);
    return { schedule, occurrencesCancelled: cancelled.length };
  });
  await audit(
    id,
    'schedule_deleted',
    result.schedule.siteId,
    scheduleAuditView(result.schedule),
    null,
    ctx,
    {
      entityGone: true,
      notes:
        result.occurrencesCancelled > 0
          ? `${String(result.occurrencesCancelled)} upcoming departures cancelled`
          : null,
    },
  );
  await afterChange(
    { kind: 'schedule', id, siteIds: [result.schedule.siteId] },
    'schedule_deleted',
    ctx,
  );
  return result;
}

// ---------- departures ----------

async function departureInScope(
  id: string,
  ctx: DepartureCtx,
  tx: DepartureDb,
): Promise<VehicleDeparture> {
  const departure = await getDeparture(id, tx, { forUpdate: true });
  if (departure == null || !inScope(departure.siteId, ctx.siteScope)) {
    throw new DepartureNotFoundError();
  }
  return departure;
}

/**
 * Creates a departure that is not a schedule occurrence: an operator entry, an
 * import row, or later a vehicle or depot management system report. It is 5
 * minutes to 30 days ahead, its vehicle belongs to a driver of the fleet and
 * its site is one of the caller's sites.
 *
 * Two departures of one vehicle at the same time are allowed (a manual entry
 * next to a schedule occurrence, say): the planner charges for the earliest
 * one the session binds to. Fleet membership is checked here only; edits and
 * cancels do not check it again, since a vehicle that left the fleet keeps its
 * departures until someone cancels them.
 */
export async function createDeparture(
  input: DepartureInput,
  ctx: DepartureCtx,
): Promise<VehicleDeparture> {
  const now = nowOf(ctx);
  const departureAt = checkDepartureTime(input.departureAt, now);
  const values: NewVehicleDeparture = {
    vehicleId: input.vehicleId,
    siteId: input.siteId,
    departureAt,
    ...targetColumns(input.target),
    priority: checkPriority(input.priority ?? DEPARTURE_PRIORITY_DEFAULT),
    source: input.source,
    expectedArrivalAt: input.expectedArrivalAt ?? null,
    expectedArrivalSocPercent: input.expectedArrivalSocPercent ?? null,
  };
  checkExpectedArrival(input.expectedArrivalAt, input.expectedArrivalSocPercent, departureAt, now);
  const departure = await db.transaction(async (tx) => {
    const site = await checkSite(input.siteId, ctx, tx);
    checkSocCapacity(input.target, await checkFleetVehicle(input.vehicleId, input.fleetId, tx));
    await checkVehicleDay(input.vehicleId, departureAt, site.timezone, tx);
    return insertDeparture(values, tx);
  });
  await audit(
    departure.id,
    'departure_created',
    departure.siteId,
    null,
    departureAuditView(departure),
    ctx,
  );
  await afterChange(
    { kind: 'departure', id: departure.id, siteIds: [departure.siteId] },
    'departure_created',
    ctx,
  );
  return departure;
}

/**
 * Changes the time, target or priority of a scheduled departure and marks it
 * overridden, so a later schedule edit leaves it alone. A cancelled or
 * completed departure answers DEPARTURE_NOT_SCHEDULED.
 */
export async function updateDeparture(
  id: string,
  update: DepartureUpdate,
  ctx: DepartureCtx,
): Promise<VehicleDeparture> {
  const now = nowOf(ctx);
  const changes: DepartureChanges = {};
  if (update.departureAt !== undefined) {
    changes.departureAt = checkDepartureTime(update.departureAt, now);
  }
  if (update.target !== undefined) Object.assign(changes, targetColumns(update.target));
  if (update.priority !== undefined) changes.priority = checkPriority(update.priority);
  if (update.expectedArrivalAt !== undefined) changes.expectedArrivalAt = update.expectedArrivalAt;
  if (update.expectedArrivalSocPercent !== undefined) {
    changes.expectedArrivalSocPercent = update.expectedArrivalSocPercent;
  }

  const result = await db.transaction(async (tx) => {
    const before = await departureInScope(id, ctx, tx);
    if (before.status !== 'scheduled') throw new DepartureNotScheduledError();
    // The arrival is checked against the departure the row has after the change.
    checkExpectedArrival(
      update.expectedArrivalAt !== undefined ? update.expectedArrivalAt : before.expectedArrivalAt,
      update.expectedArrivalSocPercent,
      changes.departureAt ?? before.departureAt,
      now,
    );
    await checkNotManaged(before, tx);
    if (before.adHoc && update.departureAt !== undefined) {
      throw new ValidationError('An ad hoc departure has no departure time', {
        field: 'departureAt',
      });
    }
    if (update.target?.kind === 'soc') {
      checkSocCapacity(update.target, await getVehicleBatteryCapacity(before.vehicleId, tx));
    }
    const real = changedFields(before, changes);
    if (Object.keys(real).length === 0) return { before, after: before, changed: false };
    if (real.departureAt != null) {
      const site = await getDepartureSite(before.siteId, tx);
      if (site != null) {
        await checkVehicleDay(before.vehicleId, real.departureAt, site.timezone, tx, id);
      }
    }
    const after = await updateScheduledDeparture(id, { ...real, overridden: true }, tx);
    if (after == null) throw new DepartureNotScheduledError();
    return { before, after, changed: true };
  });
  if (!result.changed) return result.after;
  await audit(
    id,
    'departure_updated',
    result.after.siteId,
    departureAuditView(result.before),
    departureAuditView(result.after),
    ctx,
  );
  await afterChange(
    { kind: 'departure', id, siteIds: [result.after.siteId] },
    'departure_updated',
    ctx,
  );
  return result.after;
}

/**
 * Cancels a scheduled departure. Cancelled is terminal: a second cancel
 * changes nothing and writes no audit row; a completed departure answers
 * DEPARTURE_NOT_SCHEDULED.
 */
export async function cancelDeparture(
  id: string,
  ctx: DepartureCtx,
): Promise<{ departure: VehicleDeparture; changed: boolean }> {
  const result = await db.transaction(async (tx) => {
    const before = await departureInScope(id, ctx, tx);
    if (before.status === 'cancelled') return { before, after: before, changed: false };
    if (before.status !== 'scheduled') throw new DepartureNotScheduledError();
    await checkNotManaged(before, tx);
    const [after] = await cancelScheduledDepartures([id], tx);
    if (after == null) throw new DepartureNotScheduledError();
    return { before, after, changed: true };
  });
  if (!result.changed) return { departure: result.after, changed: false };
  await audit(
    id,
    'departure_cancelled',
    result.after.siteId,
    departureAuditView(result.before),
    departureAuditView(result.after),
    ctx,
  );
  await afterChange(
    { kind: 'departure', id, siteIds: [result.after.siteId] },
    'departure_cancelled',
    ctx,
  );
  return { departure: result.after, changed: true };
}

/** What one import did at one site. */
export interface DepartureImportSiteSummary {
  siteId: string;
  created: number;
  updated: number;
}

/**
 * Audits an import: one `departures_imported` row per site it wrote to, so a
 * user of one depot never sees the counts of another. The entity is the fleet.
 */
export async function auditDeparturesImported(
  fleetId: string,
  summaries: DepartureImportSiteSummary[],
  ctx: DepartureCtx,
): Promise<void> {
  for (const summary of summaries) {
    await audit(
      fleetId,
      'departures_imported',
      summary.siteId,
      null,
      {
        entityKind: 'import',
        siteId: summary.siteId,
        created: summary.created,
        updated: summary.updated,
      },
      ctx,
    );
  }
  const siteIds = summaries.map((s) => s.siteId);
  if (siteIds.length > 0) {
    await afterChange({ kind: 'import', id: fleetId, siteIds }, 'departures_imported', ctx);
  }
}
