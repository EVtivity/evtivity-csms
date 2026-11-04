// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Charging requests of a bus depot system (VDV 463 ProvideChargingRequests),
// applied to departures. The list holds every request the depot system knows:
// a known request id is an update, a missing unstarted request is cancelled,
// a started one stays until Terminate. Requests for vehicles other than buses
// are refused (owner decision 2026-11-03): the bus depot interface is for
// buses; other fleets plan through the CSMS. Writes go through the departure
// writer (@evtivity/database lib/vehicle-departures.ts), audited here.

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  cancelScheduledDepartures,
  chargingSessions,
  chargingStations,
  db,
  depotSystemAuditLog,
  depotSystemSiteIds,
  evses,
  fleetDrivers,
  fleetStations,
  insertDeparture,
  isOperatorStation,
  lockDepotSystemDepartures,
  lockDepotSystemVehicleHolds,
  markSitePlanStale,
  otherSystemVehicleIds,
  lastDepotSystemRefusalNoticeAt,
  replaceDepotSystemRefusals,
  setDeparturePreconditioning,
  supersedableDepartures,
  updateScheduledDeparture,
  vehicles,
  writeAudit,
  type DepartureChanges,
  type DeparturePreconditioningValues,
  type DepotSystem,
  type VehicleDeparture,
} from '@evtivity/database';
import type { ServiceLogger } from '@evtivity/lib';
import {
  VDV463_MAX_CHARGING_REQUESTS,
  VDV463_MAX_IDENTIFIER_LENGTH,
  checkChargingRequest,
  parseChargingPointId,
  type CheckedChargingRequest,
  type Vdv463ChargingRequest,
  type Vdv463RefusalReason,
} from '@evtivity/lib/vdv463';
import {
  departureAuditView,
  writeDepartureAudit,
  type DepartureCtx,
} from '@evtivity/services/departure.service';
import {
  DEPOT_REQUESTS_REFUSED_EVENT,
  depotSystemsUrl,
  notifyDepotUsers,
  publishDepartureChanged,
} from '@evtivity/services/departure-notice.service';
import { assignSessionVehicle } from './vehicle.service.js';

/** A schedule or manual departure this close to a request is replaced by it. */
export const DEPOT_REQUEST_SUPERSEDE_MS = 60 * 60_000;
/** Refusal notices of one depot system are sent at most once in this time. */
export const DEPOT_REFUSAL_NOTICE_INTERVAL_MS = 60 * 60_000;

export interface Refusal {
  externalRequestId: string;
  vehicleRef: string | null;
  reason: Vdv463RefusalReason;
}

export interface ApplyResult {
  created: number;
  updated: number;
  /** Cancelled because they left the list. */
  removed: number;
  terminated: number;
  superseded: number;
  refused: Refusal[];
  siteIds: string[];
}

interface Target {
  request: CheckedChargingRequest;
  vehicleId: string;
  siteId: string;
  evseDbId: string | null;
  sessionId: string | null;
}

const NO_CHANGES: Omit<ApplyResult, 'refused' | 'siteIds'> = {
  created: 0,
  updated: 0,
  removed: 0,
  terminated: 0,
  superseded: 0,
};

function vinKey(value: string): string {
  return value.trim().toUpperCase();
}

interface VehicleCandidate {
  id: string;
  vin: string;
  bodyType: string | null;
  batteryCapacityKwh: string | null;
  driverId: string;
  siteIds: Set<string>;
}

/** Vehicles by VIN whose drivers belong to a fleet holding a station at one of the sites. */
async function vehiclesByVin(
  vins: string[],
  siteIds: string[],
): Promise<Map<string, VehicleCandidate[]>> {
  const out = new Map<string, VehicleCandidate[]>();
  if (vins.length === 0 || siteIds.length === 0) return out;
  const rows = await db
    .selectDistinct({
      id: vehicles.id,
      vin: vehicles.vin,
      bodyType: vehicles.bodyType,
      batteryCapacityKwh: vehicles.batteryCapacityKwh,
      driverId: vehicles.driverId,
      siteId: chargingStations.siteId,
    })
    .from(vehicles)
    .innerJoin(fleetDrivers, eq(fleetDrivers.driverId, vehicles.driverId))
    .innerJoin(fleetStations, eq(fleetStations.fleetId, fleetDrivers.fleetId))
    .innerJoin(chargingStations, eq(chargingStations.id, fleetStations.stationId))
    .where(
      and(
        inArray(sql`upper(trim(${vehicles.vin}))`, vins),
        inArray(chargingStations.siteId, siteIds),
        isOperatorStation(),
      ),
    );
  const byId = new Map<string, VehicleCandidate>();
  for (const row of rows) {
    if (row.vin == null || row.siteId == null) continue;
    let candidate = byId.get(row.id);
    if (candidate == null) {
      candidate = {
        id: row.id,
        vin: row.vin,
        bodyType: row.bodyType,
        batteryCapacityKwh: row.batteryCapacityKwh,
        driverId: row.driverId,
        siteIds: new Set(),
      };
      byId.set(row.id, candidate);
      const key = vinKey(row.vin);
      out.set(key, [...(out.get(key) ?? []), candidate]);
    }
    candidate.siteIds.add(row.siteId);
  }
  return out;
}

interface PointRow {
  evseDbId: string;
  stationDbId: string;
  siteId: string;
}

/** Charging points (`<OCPP id>/<evse id>`) of stations at the sites. */
async function chargingPoints(refs: string[], siteIds: string[]): Promise<Map<string, PointRow>> {
  const parsed = refs
    .map((ref) => ({ ref, point: parseChargingPointId(ref) }))
    .filter(
      (p): p is { ref: string; point: { stationOcppId: string; evseId: number } } =>
        p.point != null,
    );
  const out = new Map<string, PointRow>();
  if (parsed.length === 0 || siteIds.length === 0) return out;
  const rows = await db
    .select({
      evseDbId: evses.id,
      evseId: evses.evseId,
      stationDbId: chargingStations.id,
      ocppId: chargingStations.stationId,
      siteId: chargingStations.siteId,
    })
    .from(evses)
    .innerJoin(chargingStations, eq(chargingStations.id, evses.stationId))
    .where(
      and(
        inArray(chargingStations.stationId, [...new Set(parsed.map((p) => p.point.stationOcppId))]),
        inArray(chargingStations.siteId, siteIds),
        isOperatorStation(),
        sql`${evses.retiredAt} IS NULL`,
      ),
    );
  for (const row of rows) {
    if (row.siteId == null) continue;
    out.set(`${row.ocppId}/${String(row.evseId)}`, {
      evseDbId: row.evseDbId,
      stationDbId: row.stationDbId,
      siteId: row.siteId,
    });
  }
  return out;
}

interface ProcessRow {
  sessionId: string;
  siteId: string;
  vehicleId: string | null;
}

/** Active sessions at the sites, by session id (a charging process EVtivity reported). */
async function activeSessions(ids: string[], siteIds: string[]): Promise<Map<string, ProcessRow>> {
  const out = new Map<string, ProcessRow>();
  if (ids.length === 0 || siteIds.length === 0) return out;
  const rows = await db
    .select({
      sessionId: chargingSessions.id,
      siteId: chargingSessions.siteId,
      vehicleId: chargingSessions.vehicleId,
    })
    .from(chargingSessions)
    .where(
      and(
        inArray(chargingSessions.id, ids),
        eq(chargingSessions.status, 'active'),
        inArray(chargingSessions.siteId, siteIds),
      ),
    );
  for (const row of rows) {
    if (row.siteId != null) out.set(row.sessionId, { ...row, siteId: row.siteId });
  }
  return out;
}

function targetColumns(r: CheckedChargingRequest): {
  targetKind: 'soc';
  targetEnergyKwh: null;
  targetSocPercent: number;
  targetSocMaxPercent: number | null;
} {
  return {
    targetKind: 'soc',
    targetEnergyKwh: null,
    targetSocPercent: r.minSocPercent,
    targetSocMaxPercent: r.maxSocPercent > r.minSocPercent ? r.maxSocPercent : null,
  };
}

function preconditioningValues(r: CheckedChargingRequest): DeparturePreconditioningValues | null {
  const p = r.preconditioning;
  if (p == null) return null;
  return {
    climate: p.climate,
    ambientTemperatureC: p.ambientTemperatureC,
    startAt: p.startAt,
    finishAt: p.finishAt,
    hvacStartAt: p.hvacStartAt,
    hvacKw: p.hvacKw != null ? p.hvacKw.toFixed(2) : null,
    systemStartAt: p.systemStartAt,
    systemKw: p.systemKw != null ? p.systemKw.toFixed(2) : null,
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return (a ?? null) === (b ?? null);
}

function changesOf(row: VehicleDeparture, t: Target): DepartureChanges {
  const wanted: DepartureChanges = {
    siteId: t.siteId,
    departureAt: t.request.departureAt,
    adHoc: t.request.adHoc,
    ...targetColumns(t.request),
    expectedArrivalAt: t.request.expectedArrivalAt,
    expectedArrivalSocPercent: t.request.expectedArrivalSocPercent,
    requestedEvseId: t.evseDbId,
    priority: t.request.priority,
    externalPriority: t.request.externalPriority,
    ...(t.sessionId != null ? { sessionId: t.sessionId } : {}),
  };
  const stored = row as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wanted)) {
    if (!sameValue(stored[key], value)) out[key] = value;
  }
  return out;
}

export interface ApplyDeps {
  log: ServiceLogger;
  now?: Date;
  /** Labels the audit rows (`Depot system: <name>`). */
  onChange?: (siteIds: string[]) => void | Promise<void>;
}

/**
 * Applies one charging request list of a depot system. Never throws for a
 * refused request: each one is stored in the refusal table with its reason
 * and the rest still applies. Throws only on a database failure, which the
 * caller logs (the list is acknowledged already; the next list repairs it).
 */
export async function applyChargingRequests(
  system: DepotSystem,
  list: readonly Vdv463ChargingRequest[],
  deps: ApplyDeps,
): Promise<ApplyResult> {
  const now = deps.now ?? new Date();
  const siteIds = await depotSystemSiteIds(system.id);
  const refused: Refusal[] = [];
  const refuse = (r: Vdv463ChargingRequest, reason: Vdv463RefusalReason): void => {
    // Stored ids fit the columns; a longer one is refused as identifier_too_long.
    refused.push({
      externalRequestId: r.chargingRequestId.slice(0, VDV463_MAX_IDENTIFIER_LENGTH),
      vehicleRef: r.vehicleId.slice(0, VDV463_MAX_IDENTIFIER_LENGTH),
      reason,
    });
  };

  if (list.length > VDV463_MAX_CHARGING_REQUESTS) {
    for (const r of list.slice(0, VDV463_MAX_CHARGING_REQUESTS)) refuse(r, 'list_too_long');
    await storeRefusals(system, refused, siteIds, deps);
    return { ...NO_CHANGES, refused, siteIds: [] };
  }

  // Checks without the database; a request id twice keeps the first.
  const seen = new Set<string>();
  const checked: Array<{ raw: Vdv463ChargingRequest; request: CheckedChargingRequest }> = [];
  for (const raw of list) {
    if (seen.has(raw.chargingRequestId)) {
      refuse(raw, 'duplicate_request_id');
      continue;
    }
    seen.add(raw.chargingRequestId);
    const result = checkChargingRequest(raw, now);
    if (!result.ok) {
      refuse(raw, result.reason);
      continue;
    }
    checked.push({ raw, request: result.request });
  }

  const [byVin, points, sessions] = await Promise.all([
    vehiclesByVin([...new Set(checked.map((c) => vinKey(c.request.vehicleRef)))], siteIds),
    chargingPoints(
      checked.map((c) => c.request.chargingPointRef).filter((v): v is string => v != null),
      siteIds,
    ),
    activeSessions(
      checked.map((c) => c.request.chargingProcessRef).filter((v): v is string => v != null),
      siteIds,
    ),
  ]);
  const held = await otherSystemVehicleIds(
    system.id,
    [...byVin.values()].flat().map((v) => v.id),
  );

  const targets: Target[] = [];
  const keptIds = new Set<string>();
  for (const { raw, request } of checked) {
    keptIds.add(request.externalRequestId);
    const candidates = byVin.get(vinKey(request.vehicleRef)) ?? [];
    // Unknown and not served by this system look the same (no existence leak).
    if (candidates.length !== 1) {
      refuse(raw, 'unknown_vehicle');
      continue;
    }
    const [vehicle] = candidates;
    if (vehicle == null) continue;
    if (vehicle.bodyType !== 'bus') {
      refuse(raw, 'vehicle_not_bus');
      continue;
    }
    let siteId: string | null = null;
    let evseDbId: string | null = null;
    if (request.chargingPointRef != null) {
      const point = points.get(request.chargingPointRef);
      if (point == null) {
        refuse(raw, 'unknown_charging_point');
        continue;
      }
      siteId = point.siteId;
      evseDbId = point.evseDbId;
    }
    let sessionId: string | null = null;
    if (request.chargingProcessRef != null) {
      const session = sessions.get(request.chargingProcessRef);
      if (session != null) {
        if (session.vehicleId != null && session.vehicleId !== vehicle.id) {
          refuse(raw, 'unknown_charging_process');
          continue;
        }
        if (siteId != null && siteId !== session.siteId) {
          refuse(raw, 'unknown_charging_process');
          continue;
        }
        siteId = session.siteId;
        sessionId = session.sessionId;
      }
      // Otherwise the process id is the departure id EVtivity reported for this
      // request, or a process that ended: nothing to bind.
    }
    if (siteId == null) {
      // Without a charging point the depot is the one of the vehicle's fleet
      // stations, when there is exactly one.
      siteId = vehicle.siteIds.size === 1 ? ([...vehicle.siteIds][0] ?? null) : null;
      if (siteId == null) {
        refuse(raw, 'unknown_charging_point');
        continue;
      }
    }
    if (!vehicle.siteIds.has(siteId)) {
      refuse(raw, 'unknown_vehicle');
      continue;
    }
    if (vehicle.batteryCapacityKwh == null || !(Number(vehicle.batteryCapacityKwh) > 0)) {
      refuse(raw, 'no_battery_capacity');
      continue;
    }
    if (held.has(vehicle.id)) {
      refuse(raw, 'vehicle_owned_by_other_system');
      continue;
    }
    if (sessionId != null) {
      const session = sessions.get(sessionId);
      if (session?.vehicleId == null) {
        // An unplanned session the depot system takes over gets its vehicle.
        try {
          await assignSessionVehicle(
            { sessionId, vehicleId: vehicle.id, siteScope: siteIds },
            depotActor(system),
            deps.log,
          );
        } catch {
          // fail-open: the session cannot take this vehicle, so the request is refused
          refuse(raw, 'unknown_charging_process');
          continue;
        }
      }
    }
    targets.push({ request, vehicleId: vehicle.id, siteId, evseDbId, sessionId });
  }

  const counts = { ...NO_CHANGES };
  const changedSites = new Set<string>();
  const audits: Array<{
    id: string;
    action: 'departure_created' | 'departure_updated' | 'departure_cancelled';
    siteId: string;
    before: VehicleDeparture | null;
    after: VehicleDeparture;
    notes: string | null;
  }> = [];

  await db.transaction(async (tx) => {
    // Every system's lists apply one at a time from here, and the holders are
    // read again: a vehicle another system took meanwhile is refused (D9).
    await lockDepotSystemVehicleHolds(tx);
    const heldNow = await otherSystemVehicleIds(
      system.id,
      targets.map((t) => t.vehicleId),
      tx,
    );
    const existing = await lockDepotSystemDepartures(system.id, tx);
    const byRequest = new Map(existing.map((d) => [d.externalRequestId ?? '', d]));

    for (const t of targets) {
      if (heldNow.has(t.vehicleId)) {
        refused.push({
          externalRequestId: t.request.externalRequestId,
          vehicleRef: t.request.vehicleRef,
          reason: 'vehicle_owned_by_other_system',
        });
        continue;
      }
      let row = byRequest.get(t.request.externalRequestId);
      if (row != null && row.vehicleId !== t.vehicleId) {
        // A request id moved to another bus: the old bus's departure ends and
        // the new bus gets its own, so no row mixes two vehicles.
        const [ended] = await cancelScheduledDepartures([row.id], tx, 'removed_by_depot_system');
        if (ended != null) {
          counts.removed += 1;
          changedSites.add(ended.siteId);
          audits.push({
            id: ended.id,
            action: 'departure_cancelled',
            siteId: ended.siteId,
            before: row,
            after: ended,
            notes: 'The depot system moved the request to another vehicle',
          });
        }
        row = undefined;
      }
      if (t.request.terminate) {
        if (row == null) continue;
        const [after] = await cancelScheduledDepartures([row.id], tx, 'terminated_by_depot_system');
        if (after != null) {
          counts.terminated += 1;
          changedSites.add(after.siteId);
          audits.push({
            id: after.id,
            action: 'departure_cancelled',
            siteId: after.siteId,
            before: row,
            after,
            notes: 'Terminated by the depot system',
          });
        }
        continue;
      }
      if (row != null) {
        const changes = changesOf(row, t);
        if (Object.keys(changes).length > 0) {
          const after = await updateScheduledDeparture(row.id, changes, tx);
          if (after != null) {
            counts.updated += 1;
            changedSites.add(row.siteId);
            changedSites.add(after.siteId);
            audits.push({
              id: after.id,
              action: 'departure_updated',
              siteId: after.siteId,
              before: row,
              after,
              notes: null,
            });
          }
        }
        await setDeparturePreconditioning(row.id, preconditioningValues(t.request), tx);
        continue;
      }
      if (t.request.departureAt != null) {
        const others = await supersedableDepartures(
          t.vehicleId,
          t.siteId,
          t.request.departureAt,
          DEPOT_REQUEST_SUPERSEDE_MS,
          tx,
        );
        const cancelled = await cancelScheduledDepartures(
          others.map((o) => o.id),
          tx,
          'superseded_by_depot_system',
        );
        for (const after of cancelled) {
          counts.superseded += 1;
          const before = others.find((o) => o.id === after.id) ?? null;
          audits.push({
            id: after.id,
            action: 'departure_cancelled',
            siteId: after.siteId,
            before,
            after,
            notes: 'Replaced by a depot system request',
          });
        }
      }
      const created = await insertDeparture(
        {
          vehicleId: t.vehicleId,
          siteId: t.siteId,
          departureAt: t.request.departureAt,
          adHoc: t.request.adHoc,
          ...targetColumns(t.request),
          expectedArrivalAt: t.request.expectedArrivalAt,
          expectedArrivalSocPercent: t.request.expectedArrivalSocPercent,
          requestedEvseId: t.evseDbId,
          priority: t.request.priority,
          externalPriority: t.request.externalPriority,
          source: 'depot_system',
          depotSystemId: system.id,
          externalRequestId: t.request.externalRequestId,
          sessionId: t.sessionId,
        },
        tx,
      );
      await setDeparturePreconditioning(created.id, preconditioningValues(t.request), tx);
      counts.created += 1;
      changedSites.add(created.siteId);
      audits.push({
        id: created.id,
        action: 'departure_created',
        siteId: created.siteId,
        before: null,
        after: created,
        notes: null,
      });
    }

    // A request missing from the list is cancelled unless its vehicle charges.
    const missing = existing.filter((d) => !keptIds.has(d.externalRequestId ?? ''));
    const unstarted: VehicleDeparture[] = [];
    if (missing.length > 0) {
      const bound = missing.flatMap((d) => (d.sessionId != null ? [d.sessionId] : []));
      const charging = new Set<string>();
      if (bound.length > 0) {
        const rows = await tx
          .select({ id: chargingSessions.id })
          .from(chargingSessions)
          .where(and(inArray(chargingSessions.id, bound), eq(chargingSessions.status, 'active')));
        for (const r of rows) charging.add(r.id);
      }
      for (const d of missing) {
        if (d.sessionId == null || !charging.has(d.sessionId)) unstarted.push(d);
      }
    }
    const removed = await cancelScheduledDepartures(
      unstarted.map((d) => d.id),
      tx,
      'removed_by_depot_system',
    );
    for (const after of removed) {
      counts.removed += 1;
      changedSites.add(after.siteId);
      const before = unstarted.find((d) => d.id === after.id) ?? null;
      audits.push({
        id: after.id,
        action: 'departure_cancelled',
        siteId: after.siteId,
        before,
        after,
        notes: 'Left the depot system request list',
      });
    }
  });

  const ctx: DepartureCtx = {
    actor: depotActor(system),
    siteScope: null,
    log: deps.log,
  };
  for (const a of audits) {
    await writeDepartureAudit(
      a.id,
      a.action,
      a.siteId,
      a.before != null ? departureAuditView(a.before) : null,
      departureAuditView(a.after),
      ctx,
      { notes: a.notes },
    );
  }
  const total =
    counts.created + counts.updated + counts.removed + counts.terminated + counts.superseded;
  if (total > 0 || refused.length > 0) {
    await writeAudit(
      { table: depotSystemAuditLog, idColumn: 'depot_system_id' },
      {
        entityId: system.id,
        entityIdSnapshot: system.id,
        action: 'requests_applied',
        ...depotActor(system),
        before: null,
        after: { ...counts, refused: refused.length, requests: list.length },
      },
      db,
      deps.log,
    );
  }
  for (const siteId of changedSites) {
    await markSitePlanStale(siteId, 'depot_system', deps.log);
  }
  if (changedSites.size > 0) {
    await publishDepartureChanged(changedSites, deps.log);
    await deps.onChange?.([...changedSites]);
  }
  await storeRefusals(system, refused, siteIds, deps);
  return { ...counts, refused, siteIds: [...changedSites] };
}

/** The audit actor of a depot system's writes. */
export function depotActor(system: Pick<DepotSystem, 'name'>): {
  actor: 'system';
  actorUserId: null;
  actorDriverId: null;
  actorApiKeyId: null;
  actorLabel: string;
} {
  return {
    actor: 'system',
    actorUserId: null,
    actorDriverId: null,
    actorApiKeyId: null,
    actorLabel: `Depot system: ${system.name}`.slice(0, 100),
  };
}

/**
 * Audits a sign-in lock of a depot system: `address` when one client address
 * reached its failure limit (the key names the address or IPv6 /64), `system`
 * when the failures of every address reached the system-wide ceiling.
 */
export async function auditDepotSystemAuthLock(
  system: Pick<DepotSystem, 'id' | 'name'>,
  lock: { scope: 'address' | 'system'; addressKey: string; failures: number },
  log: ServiceLogger,
): Promise<void> {
  await writeAudit(
    { table: depotSystemAuditLog, idColumn: 'depot_system_id' },
    {
      entityId: system.id,
      entityIdSnapshot: system.id,
      action: 'auth_locked',
      ...depotActor(system),
      before: null,
      after: lock,
    },
    db,
    log,
  );
}

/** Stores the refusals and tells the depot users about new ones, once each. */
async function storeRefusals(
  system: DepotSystem,
  refused: Refusal[],
  siteIds: string[],
  deps: ApplyDeps,
): Promise<void> {
  try {
    // One refusal per request id (the first reason), as the table keys them.
    const unique = new Map<string, Refusal>();
    for (const r of refused)
      if (!unique.has(r.externalRequestId)) unique.set(r.externalRequestId, r);
    // At most one refusal notice an hour per depot system (security review
    // L5): a list with new ids every minute would mail the depot users each
    // time. The page lists every refusal; the later ones are marked as told.
    const lastNotice = await lastDepotSystemRefusalNoticeAt(system.id);
    const fresh = await replaceDepotSystemRefusals(system.id, [...unique.values()]);
    if (fresh.length === 0) return;
    // Both times are database times (notified_at is set by now()).
    if (
      lastNotice != null &&
      Date.now() - lastNotice.getTime() < DEPOT_REFUSAL_NOTICE_INTERVAL_MS
    ) {
      return;
    }
    // A refusal may name no depot, so a system of several depots tells the
    // users of every site only; a single-depot system tells that depot's users.
    const siteId = siteIds.length === 1 ? (siteIds[0] ?? null) : null;
    await notifyDepotUsers(
      DEPOT_REQUESTS_REFUSED_EVENT,
      siteId,
      {
        depotSystemName: system.name,
        refusedCount: String(fresh.length),
        requestIds: fresh
          .slice(0, 10)
          .map((r) => r.externalRequestId)
          .join(', '),
        depotSystemUrl: depotSystemsUrl({ log: deps.log }),
      },
      { log: deps.log },
    );
  } catch (err: unknown) {
    deps.log.warn({ err, depotSystemId: system.id }, 'Depot system refusals not stored');
  }
}
