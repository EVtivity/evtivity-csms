// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { AppError, ValidationError } from '@evtivity/lib';
import { displayLabelProblem } from '@evtivity/lib/display-label';
import { canonicalIpAddress } from '@evtivity/lib/ip-address';
import {
  STATION_UNIT_NAME_MAX,
  STATION_UNIT_SERIAL_MAX,
  STATION_UNITS_MAX,
  chargingStations,
  createStationUnit,
  db,
  deleteStationUnit,
  evses,
  readStationUnits,
  refitStationRun,
  setEvseUnit,
  siteAuditLog,
  stationAuditLog,
  updateStationUnit,
  writeAudit,
  type StationUnitView,
  type UnitDetailsInput,
  type UnitSnapshot,
  type UnitWriteResult,
} from '@evtivity/database';
import type { AuditActorInfo } from '../lib/audit-actor.js';
import { publishStationStatusChanged } from '../lib/station-status-events.js';

// The rules, history and announcements of station units. The writer in
// @evtivity/database (station-units.ts) is the only one that touches the
// tables; this service checks the name, maps the writer's refusals to API
// errors, writes one station history row per change in the caller's name and
// tells the dashboards, roaming partners and watching drivers. History and
// announcements are fail-open: the change is already stored.

export interface UnitContext {
  actor: AuditActorInfo;
  log: FastifyBaseLogger;
}

function checkName(name: string): void {
  const problem = displayLabelProblem(name, STATION_UNIT_NAME_MAX);
  if (problem === 'empty') {
    throw new ValidationError('The unit name must not be empty', { field: 'name' });
  }
  if (problem === 'too_long') {
    throw new ValidationError(
      `The unit name holds at most ${String(STATION_UNIT_NAME_MAX)} characters`,
      { field: 'name' },
    );
  }
  if (problem === 'invalid_characters') {
    throw new ValidationError(
      'The unit name must not contain control or invisible format characters',
      { field: 'name' },
    );
  }
}

/**
 * The admin metadata as the writer takes it. Left out stays left out (an
 * update keeps the stored value); an empty or blank value clears it (null).
 * The serial number follows the display label rule (1 to 64 characters after
 * trimming, no control or invisible format characters); the IP address must
 * be one plain IPv4 or IPv6 address and is stored in canonical form.
 */
export function checkUnitDetails(input: {
  serialNumber?: string | null | undefined;
  ipAddress?: string | null | undefined;
}): UnitDetailsInput {
  const out: UnitDetailsInput = {};
  if (input.serialNumber !== undefined) {
    const serial = input.serialNumber?.trim() ?? '';
    if (serial === '') {
      out.serialNumber = null;
    } else {
      const problem = displayLabelProblem(serial, STATION_UNIT_SERIAL_MAX);
      if (problem === 'too_long') {
        throw new ValidationError(
          `The serial number holds at most ${String(STATION_UNIT_SERIAL_MAX)} characters`,
          { field: 'serialNumber' },
        );
      }
      if (problem != null) {
        throw new ValidationError(
          'The serial number must not contain control or invisible format characters',
          { field: 'serialNumber' },
        );
      }
      out.serialNumber = serial;
    }
  }
  if (input.ipAddress !== undefined) {
    const text = input.ipAddress?.trim() ?? '';
    if (text === '') {
      out.ipAddress = null;
    } else {
      const ip = canonicalIpAddress(text);
      if (ip == null) {
        throw new ValidationError(
          'The IP address must be one IPv4 or IPv6 address, without a port, prefix length or host name',
          { field: 'ipAddress' },
        );
      }
      out.ipAddress = ip;
    }
  }
  return out;
}

function unwrap<T>(result: UnitWriteResult<T>): Extract<UnitWriteResult<T>, { ok: true }> {
  if (result.ok) return result;
  switch (result.reason) {
    case 'station_not_found':
      throw new AppError('Station not found', 404, 'STATION_NOT_FOUND');
    case 'not_found':
      throw new AppError('Unit not found', 404, 'STATION_UNIT_NOT_FOUND');
    case 'evse_not_found':
      throw new AppError('EVSE not found', 404, 'EVSE_NOT_FOUND');
    case 'name_in_use':
      throw new AppError(
        'Another unit of this station has this name',
        409,
        'STATION_UNIT_NAME_IN_USE',
      );
    case 'limit':
      throw new AppError(
        `A station holds at most ${String(STATION_UNITS_MAX)} units`,
        400,
        'STATION_UNIT_LIMIT_REACHED',
      );
    case 'other_station':
      throw new ValidationError('The EVSE and the unit must belong to the same station', {
        field: 'unitId',
      });
  }
}

async function stationSite(stationUuid: string): Promise<string | null> {
  const [row] = await db
    .select({ siteId: chargingStations.siteId })
    .from(chargingStations)
    .where(eq(chargingStations.id, stationUuid));
  return row?.siteId ?? null;
}

/**
 * The station's run of spots on its site layout follows its units (each
 * unit is its own charger, `refitStationRun`): a run that no longer fits its
 * row or reaches another station's spots moves to a free slot, audited on the
 * site. Fail-open: the unit change is stored; the next layout read places the
 * station as stored.
 */
async function refitLayout(stationUuid: string, ctx: UnitContext): Promise<void> {
  try {
    const moved = await db.transaction(async (tx) => refitStationRun(tx, stationUuid));
    if (moved == null) return;
    await writeAudit(
      { table: siteAuditLog, idColumn: 'site_id' },
      {
        entityId: moved.siteId,
        entityIdSnapshot: moved.siteId,
        action: 'updated',
        ...ctx.actor,
        before: { layoutPositions: [moved.before] },
        after: { layoutPositions: [moved.after] },
        notes: 'station layout moved for its units',
      },
      db,
      ctx.log,
    );
  } catch (err: unknown) {
    ctx.log.warn({ err, stationId: stationUuid }, 'Layout refit after a unit change failed');
  }
}

async function afterChange(
  stationUuid: string,
  change: { before: UnitSnapshot | null; after: UnitSnapshot | null; notes: string },
  ctx: UnitContext,
): Promise<void> {
  await writeAudit(
    { table: stationAuditLog, idColumn: 'station_id' },
    {
      entityId: stationUuid,
      entityIdSnapshot: stationUuid,
      action: 'unit_changed',
      ...ctx.actor,
      before: change.before == null ? null : { unit: change.before },
      after: change.after == null ? null : { unit: change.after },
      notes: change.notes,
    },
    db,
    ctx.log,
  );
  await refitLayout(stationUuid, ctx);
  let siteId: string | null = null;
  try {
    siteId = await stationSite(stationUuid);
  } catch (err: unknown) {
    ctx.log.warn({ err, stationId: stationUuid }, 'Station site read after a unit change failed');
  }
  await publishStationStatusChanged({ id: stationUuid, siteId }, ctx.log);
}

export async function listUnits(stationUuid: string): Promise<StationUnitView[]> {
  return readStationUnits(stationUuid);
}

async function evseRowIds(stationUuid: string, evseNumbers: number[]): Promise<string[]> {
  if (evseNumbers.length === 0) return [];
  const rows = await db
    .select({ id: evses.id, evseId: evses.evseId })
    .from(evses)
    .where(eq(evses.stationId, stationUuid));
  const byNumber = new Map(rows.map((r) => [r.evseId, r.id]));
  return [...new Set(evseNumbers)].map((n) => {
    const id = byNumber.get(n);
    if (id == null) throw new AppError('EVSE not found', 404, 'EVSE_NOT_FOUND');
    return id;
  });
}

async function readUnit(stationUuid: string, unitId: string): Promise<StationUnitView> {
  const unit = (await readStationUnits(stationUuid)).find((u) => u.id === unitId);
  if (unit == null) throw new AppError('Unit not found', 404, 'STATION_UNIT_NOT_FOUND');
  return unit;
}

/** Creates a unit; `evseIds` are the OCPP EVSE numbers that move into it. */
export async function createUnit(
  stationUuid: string,
  input: {
    name: string;
    evseIds?: number[];
    serialNumber?: string | null;
    ipAddress?: string | null;
  },
  ctx: UnitContext,
): Promise<StationUnitView> {
  checkName(input.name);
  const details = checkUnitDetails(input);
  const rowIds = await evseRowIds(stationUuid, input.evseIds ?? []);
  const result = unwrap(
    await createStationUnit(stationUuid, { name: input.name, evseIds: rowIds, ...details }),
  );
  await afterChange(stationUuid, { before: null, after: result.after, notes: 'Unit created' }, ctx);
  return readUnit(stationUuid, result.value.id);
}

/** Renames a unit, changes its serial number or IP address, or moves it in the order. */
export async function updateUnit(
  stationUuid: string,
  unitId: string,
  input: {
    name?: string;
    sortOrder?: number;
    serialNumber?: string | null;
    ipAddress?: string | null;
  },
  ctx: UnitContext,
): Promise<StationUnitView> {
  if (input.name != null) checkName(input.name);
  const details = checkUnitDetails(input);
  const result = unwrap(
    await updateStationUnit(stationUuid, unitId, {
      ...(input.name != null ? { name: input.name } : {}),
      ...(input.sortOrder != null ? { sortOrder: input.sortOrder } : {}),
      ...details,
    }),
  );
  if (result.changed) {
    const renamed = result.before?.name !== result.after?.name;
    const detailsChanged =
      result.before?.serialNumber !== result.after?.serialNumber ||
      result.before?.ipAddress !== result.after?.ipAddress;
    await afterChange(
      stationUuid,
      {
        before: result.before,
        after: result.after,
        notes: renamed
          ? 'Unit renamed'
          : detailsChanged
            ? 'Unit details changed'
            : 'Unit moved in the order',
      },
      ctx,
    );
  }
  return readUnit(stationUuid, unitId);
}

/** Deletes a unit; its EVSEs stay on the station without a unit. */
export async function deleteUnit(
  stationUuid: string,
  unitId: string,
  ctx: UnitContext,
): Promise<void> {
  const result = unwrap(await deleteStationUnit(stationUuid, unitId));
  await afterChange(
    stationUuid,
    { before: result.before, after: null, notes: 'Unit deleted' },
    ctx,
  );
}

/**
 * Moves the EVSE with OCPP number `evseNumber` into a unit of its station, or
 * out of every unit (null). Returns whether anything changed.
 */
export async function assignEvseUnit(
  stationUuid: string,
  evseNumber: number,
  unitId: string | null,
  ctx: UnitContext,
): Promise<{ changed: boolean }> {
  const [evse] = await db
    .select({ id: evses.id })
    .from(evses)
    .where(and(eq(evses.stationId, stationUuid), eq(evses.evseId, evseNumber)));
  if (evse == null) throw new AppError('EVSE not found', 404, 'EVSE_NOT_FOUND');
  const result = unwrap(await setEvseUnit(stationUuid, evse.id, unitId));
  if (result.changed) {
    await afterChange(
      stationUuid,
      {
        before: result.before,
        after: result.after,
        notes:
          unitId == null
            ? `EVSE ${String(evseNumber)} removed from its unit`
            : `EVSE ${String(evseNumber)} moved to a unit`,
      },
      ctx,
    );
  }
  return { changed: result.changed };
}
