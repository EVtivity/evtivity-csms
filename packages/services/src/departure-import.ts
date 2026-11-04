// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Departure import from CSV text (route-aware charging). Each row names a
// vehicle of the fleet (plate, VIN or id), a site of the caller (id or name), a
// departure time (ISO with an offset, or `YYYY-MM-DD HH:MM` local time of the
// site) and an energy or state of charge target. Rows go through the departure
// service one by one; a row the service refuses is reported by row number and
// field only, never with the value it held. Cell text is never evaluated: a
// value that starts with `=`, `+`, `-` or `@` is compared as plain text.

import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db, fleetDrivers, sites, vehicleDepartures, vehicles } from '@evtivity/database';
import { AppError, ValidationError } from '@evtivity/lib';
import type { DepartureTarget } from '@evtivity/lib/charging-plan';
import { scheduleOccurrences } from '@evtivity/lib/departure-schedule';
import {
  auditDeparturesImported,
  createDeparture,
  updateDeparture,
  type DepartureCtx,
  type DepartureImportSiteSummary,
  type DepartureInput,
  type DepartureUpdate,
} from './departure.service.js';

/** Data rows one import takes at most. */
export const DEPARTURE_IMPORT_MAX_ROWS = 2000;
/** Size of the CSV text one import takes at most, in bytes. */
export const DEPARTURE_IMPORT_MAX_BYTES = 512 * 1024;
/** A row updates a manual or imported departure of its vehicle this close in time. */
export const DEPARTURE_IMPORT_MATCH_MS = 10 * 60_000;

export type DepartureImportField =
  | 'vehicle'
  | 'site'
  | 'departure'
  | 'energy_kwh'
  | 'soc_percent'
  | 'priority'
  | 'arrival'
  | 'arrival_soc_percent';
export type DepartureImportReason = 'missing' | 'not_found' | 'ambiguous' | 'invalid';

/** One refused row: its line number in the file (the header is line 1) and the field. */
export interface DepartureImportRefusal {
  row: number;
  field: DepartureImportField;
  reason: DepartureImportReason;
}

export interface DepartureImportResult {
  created: number;
  updated: number;
  /** Rows that matched a departure already holding the same values. */
  unchanged: number;
  refused: DepartureImportRefusal[];
}

export interface ImportVehicle {
  id: string;
  licensePlate: string | null;
  vin: string | null;
}

/** A departure a row updates; the service leaves `updatedAt` as it was when nothing changed. */
export interface MatchedDeparture {
  id: string;
  updatedAt: Date;
}

export interface ImportSite {
  id: string;
  name: string;
  timezone: string;
}

/** The reads and writes of an import; the defaults use the database and the departure service. */
export interface DepartureImportDeps {
  fleetVehicles: (fleetId: string) => Promise<ImportVehicle[]>;
  scopedSites: (siteScope: string[] | null) => Promise<ImportSite[]>;
  findMatchingDeparture: (
    vehicleId: string,
    siteId: string,
    at: Date,
  ) => Promise<MatchedDeparture | null>;
  createDeparture: (input: DepartureInput, ctx: DepartureCtx) => Promise<{ siteId: string }>;
  updateDeparture: (
    id: string,
    update: DepartureUpdate,
    ctx: DepartureCtx,
  ) => Promise<{ siteId: string; updatedAt: Date }>;
  auditDeparturesImported: (
    fleetId: string,
    summaries: DepartureImportSiteSummary[],
    ctx: DepartureCtx,
  ) => Promise<void>;
}

const HEADER_ALIASES: Record<string, DepartureImportField> = {
  vehicle: 'vehicle',
  vehicle_id: 'vehicle',
  plate: 'vehicle',
  license_plate: 'vehicle',
  vin: 'vehicle',
  site: 'site',
  site_id: 'site',
  site_name: 'site',
  depot: 'site',
  departure: 'departure',
  departure_at: 'departure',
  departure_time: 'departure',
  energy_kwh: 'energy_kwh',
  energy: 'energy_kwh',
  kwh: 'energy_kwh',
  target_kwh: 'energy_kwh',
  target_energy_kwh: 'energy_kwh',
  soc_percent: 'soc_percent',
  soc: 'soc_percent',
  target_soc: 'soc_percent',
  target_soc_percent: 'soc_percent',
  priority: 'priority',
  arrival: 'arrival',
  arrival_at: 'arrival',
  expected_arrival: 'arrival',
  expected_arrival_at: 'arrival',
  arrival_soc: 'arrival_soc_percent',
  arrival_soc_percent: 'arrival_soc_percent',
  expected_arrival_soc_percent: 'arrival_soc_percent',
};

const NUMBER_PATTERN = /^\d+(\.\d+)?$/;
const INTEGER_PATTERN = /^\d+$/;
const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):?(\d{2}))$/i;
const LOCAL_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/;
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

/** RFC 4180 CSV: quoted fields, `""` inside quotes, line breaks inside quotes, a BOM, CRLF. */
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input.charAt(i);
    if (inQuotes) {
      if (char === '"' && input.charAt(i + 1) === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input.charAt(i + 1) === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function headerKey(cell: string): string {
  return cell
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/** A plate compared without case, spaces, dots or hyphens. */
function plateKey(plate: string): string {
  return plate.replace(/[\s.-]+/g, '').toUpperCase();
}

class RowRefusal extends Error {
  constructor(
    readonly field: DepartureImportField,
    readonly reason: DepartureImportReason,
  ) {
    super(`${field}: ${reason}`);
  }
}

interface ParsedRow {
  vehicleId: string;
  site: ImportSite;
  departureAt: Date;
  target: DepartureTarget;
  priority: number | null;
  /** Undefined: the file has no such column, or the cell is empty. */
  expectedArrivalAt: Date | undefined;
  expectedArrivalSocPercent: number | undefined;
}

/** The service field a refusal names, as the CSV column. */
function columnOfServiceField(field: unknown): DepartureImportField {
  switch (field) {
    case 'targetKwh':
      return 'energy_kwh';
    case 'targetSoc':
      return 'soc_percent';
    case 'priority':
      return 'priority';
    case 'expectedArrivalAt':
      return 'arrival';
    case 'expectedArrivalSocPercent':
      return 'arrival_soc_percent';
    default:
      return 'departure';
  }
}

function serviceRefusal(err: unknown): RowRefusal | null {
  if (err instanceof ValidationError) {
    const details = err.details as { field?: unknown } | undefined;
    return new RowRefusal(columnOfServiceField(details?.field), 'invalid');
  }
  if (err instanceof AppError) {
    if (err.code === 'VEHICLE_NOT_IN_FLEET') return new RowRefusal('vehicle', 'not_found');
    if (err.code === 'SITE_NOT_FOUND') return new RowRefusal('site', 'not_found');
    if (err.code === 'DEPARTURE_NOT_FOUND' || err.code === 'DEPARTURE_NOT_SCHEDULED') {
      return new RowRefusal('departure', 'invalid');
    }
  }
  return null;
}

/** Reads every vehicle of the fleet's drivers. */
async function readFleetVehicles(fleetId: string): Promise<ImportVehicle[]> {
  return db
    .select({ id: vehicles.id, licensePlate: vehicles.licensePlate, vin: vehicles.vin })
    .from(vehicles)
    .innerJoin(fleetDrivers, eq(fleetDrivers.driverId, vehicles.driverId))
    .where(eq(fleetDrivers.fleetId, fleetId));
}

/** Reads the sites the caller may act on (every site for null). */
async function readScopedSites(siteScope: string[] | null): Promise<ImportSite[]> {
  if (siteScope != null && siteScope.length === 0) return [];
  return db
    .select({ id: sites.id, name: sites.name, timezone: sites.timezone })
    .from(sites)
    .where(siteScope == null ? undefined : inArray(sites.id, siteScope));
}

/**
 * The nearest scheduled manual or imported departure of a vehicle at the row's
 * site within the match window. The site is one of the caller's sites, so a row
 * never reaches a departure at a site the caller may not act on.
 */
async function readMatchingDeparture(
  vehicleId: string,
  siteId: string,
  at: Date,
): Promise<MatchedDeparture | null> {
  const [row] = await db
    .select({ id: vehicleDepartures.id, updatedAt: vehicleDepartures.updatedAt })
    .from(vehicleDepartures)
    .where(
      and(
        eq(vehicleDepartures.vehicleId, vehicleId),
        eq(vehicleDepartures.siteId, siteId),
        eq(vehicleDepartures.status, 'scheduled'),
        inArray(vehicleDepartures.source, ['manual', 'import']),
        gte(vehicleDepartures.departureAt, new Date(at.getTime() - DEPARTURE_IMPORT_MATCH_MS)),
        lte(vehicleDepartures.departureAt, new Date(at.getTime() + DEPARTURE_IMPORT_MATCH_MS)),
      ),
    )
    .orderBy(
      sql`abs(extract(epoch from (${vehicleDepartures.departureAt} - ${at.toISOString()}::timestamptz)))`,
      asc(vehicleDepartures.id),
    )
    .limit(1);
  return row ?? null;
}

export const defaultDepartureImportDeps: DepartureImportDeps = {
  fleetVehicles: readFleetVehicles,
  scopedSites: readScopedSites,
  findMatchingDeparture: readMatchingDeparture,
  createDeparture,
  updateDeparture,
  auditDeparturesImported,
};

/** Resolves a vehicle cell against the fleet: an id, then a VIN, then a plate. */
function vehicleResolver(list: ImportVehicle[]): (cell: string) => string {
  const byId = new Map(list.map((v) => [v.id, v.id]));
  const byVin = new Map<string, string[]>();
  const byPlate = new Map<string, string[]>();
  for (const v of list) {
    if (v.vin != null)
      byVin.set(v.vin.toUpperCase(), [...(byVin.get(v.vin.toUpperCase()) ?? []), v.id]);
    if (v.licensePlate != null && v.licensePlate.trim() !== '') {
      const key = plateKey(v.licensePlate);
      byPlate.set(key, [...(byPlate.get(key) ?? []), v.id]);
    }
  }
  return (cell) => {
    const id = byId.get(cell);
    if (id != null) return id;
    const matches = byVin.get(cell.toUpperCase()) ?? byPlate.get(plateKey(cell)) ?? [];
    const unique = [...new Set(matches)];
    if (unique.length === 0) throw new RowRefusal('vehicle', 'not_found');
    if (unique.length > 1) throw new RowRefusal('vehicle', 'ambiguous');
    return unique[0] as string;
  };
}

/** Resolves a site cell against the caller's sites: an id, then a name (any case). */
function siteResolver(list: ImportSite[]): (cell: string) => ImportSite {
  const byId = new Map(list.map((s) => [s.id, s]));
  const byName = new Map<string, ImportSite[]>();
  for (const s of list) {
    const key = s.name.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), s]);
  }
  return (cell) => {
    const site = byId.get(cell);
    if (site != null) return site;
    const matches = byName.get(cell.toLowerCase()) ?? [];
    if (matches.length === 0) throw new RowRefusal('site', 'not_found');
    if (matches.length > 1) throw new RowRefusal('site', 'ambiguous');
    return matches[0] as ImportSite;
  };
}

/**
 * The instant of an ISO 8601 time with an offset (`Z`, `+02:00` or `+0200`), or
 * null for a date or time that does not exist (30 February, 24:00, an offset
 * past 14 hours). The parts are checked one by one instead of trusting
 * Date.parse, which rolls an impossible date over to the next month.
 */
function isoWithOffsetMs(parts: RegExpExecArray): number | null {
  const [year, month, day, hour, minute] = [1, 2, 3, 4, 5].map((i) => Number(parts[i]));
  const second = parts[6] == null ? 0 : Number(parts[6]);
  const fraction = parts[7] == null ? 0 : Number(`0.${parts[7]}`) * 1000;
  if (
    year == null ||
    month == null ||
    day == null ||
    hour == null ||
    minute == null ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  let offsetMinutes = 0;
  if (parts[9] != null) {
    const offsetHours = Number(parts[10]);
    const offsetMins = Number(parts[11]);
    if (offsetHours > 14 || offsetMins > 59) return null;
    offsetMinutes = (parts[9] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }
  return (
    Date.UTC(year, month - 1, day, hour, minute, second) +
    Math.floor(fraction) -
    offsetMinutes * 60_000
  );
}

function parseDepartureTime(
  cell: string,
  timeZone: string,
  field: DepartureImportField = 'departure',
): Date {
  const iso = ISO_WITH_OFFSET.exec(cell);
  if (iso != null) {
    const ms = isoWithOffsetMs(iso);
    if (ms == null) throw new RowRefusal(field, 'invalid');
    return new Date(ms);
  }
  const local = LOCAL_TIME.exec(cell);
  if (local != null) {
    const [occurrence] = scheduleOccurrences(
      { daysOfWeek: ALL_DAYS, departureTime: local[2] as string },
      timeZone,
      local[1] as string,
      1,
    );
    if (occurrence != null) return new Date(occurrence.departureAtMs);
  }
  throw new RowRefusal(field, 'invalid');
}

/** An optional expected arrival time: the departure formats, empty for none. */
function parseArrival(cell: string, timeZone: string): Date | undefined {
  return cell === '' ? undefined : parseDepartureTime(cell, timeZone, 'arrival');
}

function parseArrivalSoc(cell: string): number | undefined {
  if (cell === '') return undefined;
  const value = Number(cell);
  if (!INTEGER_PATTERN.test(cell) || value > 100) {
    throw new RowRefusal('arrival_soc_percent', 'invalid');
  }
  return value;
}

function parseTarget(energyCell: string, socCell: string): DepartureTarget {
  if (energyCell === '' && socCell === '') throw new RowRefusal('energy_kwh', 'missing');
  if (energyCell !== '' && socCell !== '') throw new RowRefusal('soc_percent', 'invalid');
  if (energyCell !== '') {
    if (!NUMBER_PATTERN.test(energyCell)) throw new RowRefusal('energy_kwh', 'invalid');
    return { kind: 'energy', targetKwh: Number(energyCell) };
  }
  if (!INTEGER_PATTERN.test(socCell)) throw new RowRefusal('soc_percent', 'invalid');
  return { kind: 'soc', targetSoc: Number(socCell) };
}

function parsePriority(cell: string): number | null {
  if (cell === '') return null;
  const value = Number(cell);
  if (!INTEGER_PATTERN.test(cell) || value < 1 || value > 10) {
    throw new RowRefusal('priority', 'invalid');
  }
  return value;
}

/**
 * Imports departures for a fleet from CSV text. The whole file is refused
 * (400 VALIDATION_ERROR, nothing written) when it is larger than the size cap,
 * holds more than 2000 data rows or lacks the vehicle, site, departure and a
 * target column; otherwise each row is created, updates a manual or imported
 * departure of its vehicle at the same site within 10 minutes (a re-import changes nothing), or
 * is refused with its line number and field.
 */
export async function importDepartures(
  fleetId: string,
  csv: string,
  ctx: DepartureCtx,
  deps: DepartureImportDeps = defaultDepartureImportDeps,
): Promise<DepartureImportResult> {
  if (Buffer.byteLength(csv, 'utf8') > DEPARTURE_IMPORT_MAX_BYTES) {
    throw new ValidationError('The CSV file is larger than 512 KB', { field: 'csv' });
  }
  const lines = parseCsv(csv);
  const header = lines[0];
  if (header == null) throw new ValidationError('The CSV file is empty', { field: 'csv' });
  const columns = new Map<DepartureImportField, number>();
  header.forEach((cell, index) => {
    const field = HEADER_ALIASES[headerKey(cell)];
    if (field != null && !columns.has(field)) columns.set(field, index);
  });
  for (const required of ['vehicle', 'site', 'departure'] as const) {
    if (!columns.has(required)) {
      throw new ValidationError(`The CSV file has no ${required} column`, { field: 'csv' });
    }
  }
  if (!columns.has('energy_kwh') && !columns.has('soc_percent')) {
    throw new ValidationError('The CSV file has no energy_kwh or soc_percent column', {
      field: 'csv',
    });
  }
  const dataRows = lines
    .map((cells, index) => ({ cells, line: index + 1 }))
    .slice(1)
    .filter(({ cells }) => cells.some((c) => c.trim() !== ''));
  if (dataRows.length > DEPARTURE_IMPORT_MAX_ROWS) {
    throw new ValidationError('A CSV import takes at most 2000 rows', { field: 'csv' });
  }

  const [fleetVehicles, scopedSites] = await Promise.all([
    deps.fleetVehicles(fleetId),
    deps.scopedSites(ctx.siteScope),
  ]);
  const resolveVehicle = vehicleResolver(fleetVehicles);
  const resolveSite = siteResolver(scopedSites);
  const cellOf = (cells: string[], field: DepartureImportField): string => {
    const index = columns.get(field);
    return index == null ? '' : (cells[index] ?? '').trim();
  };

  const result: DepartureImportResult = { created: 0, updated: 0, unchanged: 0, refused: [] };
  const summaries = new Map<string, DepartureImportSiteSummary>();
  const count = (siteId: string, kind: 'created' | 'updated'): void => {
    const summary = summaries.get(siteId) ?? { siteId, created: 0, updated: 0 };
    summary[kind] += 1;
    summaries.set(siteId, summary);
    result[kind] += 1;
  };

  // Each row skips the stale mark and the change event; the summary below
  // marks each site once.
  const rowCtx: DepartureCtx = { ...ctx, deferChangeEffects: true };
  try {
    for (const { cells, line } of dataRows) {
      try {
        const vehicleCell = cellOf(cells, 'vehicle');
        if (vehicleCell === '') throw new RowRefusal('vehicle', 'missing');
        const vehicleId = resolveVehicle(vehicleCell);
        const siteCell = cellOf(cells, 'site');
        if (siteCell === '') throw new RowRefusal('site', 'missing');
        const site = resolveSite(siteCell);
        const departureCell = cellOf(cells, 'departure');
        if (departureCell === '') throw new RowRefusal('departure', 'missing');
        const row: ParsedRow = {
          vehicleId,
          site,
          departureAt: parseDepartureTime(departureCell, site.timezone),
          target: parseTarget(cellOf(cells, 'energy_kwh'), cellOf(cells, 'soc_percent')),
          priority: parsePriority(cellOf(cells, 'priority')),
          expectedArrivalAt: parseArrival(cellOf(cells, 'arrival'), site.timezone),
          expectedArrivalSocPercent: parseArrivalSoc(cellOf(cells, 'arrival_soc_percent')),
        };
        try {
          const match = await deps.findMatchingDeparture(
            row.vehicleId,
            row.site.id,
            row.departureAt,
          );
          if (match != null) {
            const update: DepartureUpdate = { departureAt: row.departureAt, target: row.target };
            if (row.priority != null) update.priority = row.priority;
            if (row.expectedArrivalAt !== undefined) {
              update.expectedArrivalAt = row.expectedArrivalAt;
            }
            if (row.expectedArrivalSocPercent !== undefined) {
              update.expectedArrivalSocPercent = row.expectedArrivalSocPercent;
            }
            const departure = await deps.updateDeparture(match.id, update, rowCtx);
            if (departure.updatedAt.getTime() !== match.updatedAt.getTime()) {
              count(departure.siteId, 'updated');
            } else result.unchanged += 1;
          } else {
            const input: DepartureInput = {
              fleetId,
              vehicleId: row.vehicleId,
              siteId: row.site.id,
              departureAt: row.departureAt,
              target: row.target,
              source: 'import',
            };
            if (row.priority != null) input.priority = row.priority;
            if (row.expectedArrivalAt !== undefined)
              input.expectedArrivalAt = row.expectedArrivalAt;
            if (row.expectedArrivalSocPercent !== undefined) {
              input.expectedArrivalSocPercent = row.expectedArrivalSocPercent;
            }
            const departure = await deps.createDeparture(input, rowCtx);
            count(departure.siteId, 'created');
          }
        } catch (err: unknown) {
          const refusal = serviceRefusal(err);
          if (refusal == null) throw err;
          throw refusal;
        }
      } catch (err: unknown) {
        if (!(err instanceof RowRefusal)) throw err;
        result.refused.push({ row: line, field: err.field, reason: err.reason });
      }
    }
  } finally {
    // Rows written before a failure are audited and their sites marked.
    if (summaries.size > 0) {
      await deps.auditDeparturesImported(fleetId, [...summaries.values()], ctx);
    }
  }
  return result;
}
