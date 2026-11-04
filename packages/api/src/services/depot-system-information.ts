// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The snapshot of a bus depot system's sites that its charging information
// (VDV 463 ProvideChargingInformation) is built from: stations, EVSEs and
// their connector states, the latest meter readings, active sessions, the
// departures the depot system requested and the stored site plans. A bounded
// set of queries per call (no per-station loop), so a cycle of 30 seconds per
// connected system stays cheap. Reads only.

import { client, operatorStationSql } from '@evtivity/database';
import {
  predictSocTimeline,
  type DepotSnapshot,
  type OcppProcessState,
  type PointSnapshot,
  type PredictionSnapshot,
  type ProcessSnapshot,
  type ScheduledSnapshot,
  type StationSnapshot,
} from '@evtivity/lib/vdv463';

/** Readings older than this are not current (a station sends every 10 to 60 s). */
const READING_FRESH_MINUTES = 10;
/** The newest 1.6 StatusNotification error codes looked at. */
const ERROR_LOOKBACK_DAYS = 7;
const SOC_FRESH_MS = 10 * 60_000;

const MEASURANDS = [
  'Energy.Active.Import.Register',
  'Power.Active.Import',
  'Power.Reactive.Import',
  'Current.Import',
  'Voltage',
  'Temperature',
] as const;

interface SiteRow {
  id: string;
  name: string;
}
interface StationRow {
  id: string;
  station_id: string;
  site_id: string;
  is_online: boolean;
  last_heartbeat: Date | null;
  ocpp_protocol: string | null;
}
interface EvseRow {
  id: string;
  station_id: string;
  evse_id: number;
  statuses: string[] | null;
}
interface ReadingRow {
  evse_id: string;
  measurand: string;
  phase: string | null;
  value: string;
  unit: string | null;
}
interface SessionRow {
  id: string;
  evse_id: string | null;
  started_at: Date;
  energy_delivered_wh: string | null;
  last_soc_percent: string | null;
  last_soc_at: Date | null;
  preconditioning_status: string | null;
  vin: string | null;
  evccid: string | null;
  vehicle_id: string | null;
}
interface DepartureRow {
  id: string;
  session_id: string | null;
  status: string;
  depot_system_id: string | null;
  external_request_id: string | null;
  departure_at: Date | null;
  target_kind: string;
  target_soc_percent: number | null;
  target_soc_max_percent: number | null;
  expected_arrival_at: Date | null;
  expected_arrival_soc_percent: number | null;
  requested_evse_id: string | null;
  predicted_ready_at: Date | null;
  predicted_max_ready_at: Date | null;
  battery_capacity_kwh: string | null;
  vin: string | null;
  hvac_start_at: Date | null;
}
interface PlanRow {
  site_id: string;
  slot_starts: unknown;
  plan: unknown;
}
interface AllocationRow {
  site_id: string;
  allocations: unknown;
}
interface ErrorRow {
  station_id: string;
  connector_id: number | null;
  error_code: string | null;
  info: string | null;
  at: Date;
}

/**
 * The raw database client returns timestamps as text (the drizzle driver
 * replaces the postgres-js date parsers), so the timestamp columns of each
 * row become Dates here, in place.
 */
function readDates<T extends object>(rows: T[], keys: ReadonlyArray<keyof T>): T[] {
  for (const row of rows) {
    const record = row as Record<keyof T, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (value != null && !(value instanceof Date)) record[key] = new Date(String(value));
    }
  }
  return rows;
}

const STATE_BY_STATUS: Record<string, OcppProcessState> = {
  charging: 'Charging',
  suspended_ev: 'SuspendedEV',
  suspended_evse: 'SuspendedEVSE',
  finishing: 'Finishing',
  preparing: 'Preparing',
  ev_connected: 'Preparing',
  occupied: 'Preparing',
};

/** The VDV 463 status name of a stored connector status. */
export function vdvConnectorStatus(status: string): string {
  switch (status) {
    case 'available':
      return 'Available';
    case 'reserved':
      return 'Reserved';
    case 'unavailable':
      return 'Unavailable';
    case 'faulted':
      return 'Faulted';
    default:
      return 'Occupied';
  }
}

function num(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** kW from a reading in W or kW (OCPP sends W unless the unit says kW). */
function kw(row: ReadingRow): number | null {
  const v = num(row.value);
  if (v == null) return null;
  const unit = (row.unit ?? 'W').toLowerCase();
  return unit === 'kw' || unit === 'kvar' ? v : v / 1000;
}

/** Wh from an energy reading in Wh or kWh. */
function wh(row: ReadingRow): number | null {
  const v = num(row.value);
  if (v == null) return null;
  return (row.unit ?? 'Wh').toLowerCase() === 'kwh' ? v * 1000 : v;
}

interface Readings {
  meterWh: number | null;
  powerKw: number | null;
  reactiveKvar: number | null;
  currentA: number | null;
  voltageV: number | null;
  temperatureC: number | null;
}

/** One value per measurand: the total, else the sum (power, current) or mean (voltage) of the phases. */
function readingsOf(rows: ReadingRow[]): Readings {
  const pick = (
    measurand: string,
    combine: 'sum' | 'mean',
    read: (r: ReadingRow) => number | null,
  ): number | null => {
    const mine = rows.filter((r) => r.measurand === measurand);
    const total = mine.find((r) => r.phase == null || r.phase === '');
    if (total != null) return read(total);
    const values = mine.map(read).filter((v): v is number => v != null);
    if (values.length === 0) return null;
    const sum = values.reduce((a, b) => a + b, 0);
    return combine === 'sum' ? sum : sum / values.length;
  };
  return {
    meterWh: pick('Energy.Active.Import.Register', 'sum', wh),
    powerKw: pick('Power.Active.Import', 'sum', kw),
    reactiveKvar: pick('Power.Reactive.Import', 'sum', kw),
    currentA: pick('Current.Import', 'sum', (r) => num(r.value)),
    voltageV: pick('Voltage', 'mean', (r) => num(r.value)),
    temperatureC: pick('Temperature', 'mean', (r) => num(r.value)),
  };
}

interface StoredEntry {
  departureId: string;
  sessionId: string;
  powerKw: number[];
  auxKw: number[];
  rejected: boolean;
}

function storedEntries(plan: unknown): StoredEntry[] {
  if (!Array.isArray(plan)) return [];
  const out: StoredEntry[] = [];
  for (const item of plan as unknown[]) {
    if (item == null || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (e['left'] === true) continue;
    if (typeof e['departureId'] !== 'string' || typeof e['sessionId'] !== 'string') continue;
    const numbers = (v: unknown): number[] =>
      Array.isArray(v)
        ? (v as unknown[]).map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0))
        : [];
    const profile = e['profile'] as Record<string, unknown> | undefined;
    out.push({
      departureId: e['departureId'],
      sessionId: e['sessionId'],
      powerKw: numbers(e['powerKw']),
      auxKw: numbers(e['auxKw']),
      rejected: profile?.['state'] === 'rejected',
    });
  }
  return out;
}

function slotsOf(slotStarts: unknown): Array<{ startMs: number; endMs: number }> {
  if (!Array.isArray(slotStarts)) return [];
  const starts = (slotStarts as unknown[])
    .map((v) => (typeof v === 'string' ? Date.parse(v) : Number.NaN))
    .filter((v) => Number.isFinite(v));
  return starts.map((startMs, i) => ({
    startMs,
    endMs: starts[i + 1] ?? (Math.floor(startMs / 900_000) + 1) * 900_000,
  }));
}

function allocatedKwByStation(allocations: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(allocations)) return out;
  for (const a of allocations as unknown[]) {
    if (a == null || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    const kwValue = num(r['allocatedKw'] as number | string | null);
    if (typeof r['stationDbId'] === 'string' && kwValue != null) out.set(r['stationDbId'], kwValue);
  }
  return out;
}

function predictionFor(
  d: DepartureRow,
  session: SessionRow | null,
  entry: StoredEntry | null,
  slots: Array<{ startMs: number; endMs: number }>,
  nowMs: number,
): PredictionSnapshot {
  const empty: PredictionSnapshot = {
    minSocPercent: d.target_soc_percent,
    minReachedAt: d.predicted_ready_at,
    finalSocPercent: null,
    finalReachedAt: null,
    departureAt: d.departure_at,
    socAtDeparture: null,
  };
  if (d.target_kind !== 'soc' || d.target_soc_percent == null) {
    return { ...empty, minSocPercent: null, minReachedAt: null };
  }
  const capacity = num(d.battery_capacity_kwh);
  const lastSoc = num(session?.last_soc_percent);
  const freshSoc =
    lastSoc != null &&
    session?.last_soc_at != null &&
    nowMs - session.last_soc_at.getTime() <= SOC_FRESH_MS
      ? lastSoc
      : null;
  let soc = freshSoc;
  if (soc == null && d.expected_arrival_soc_percent != null && capacity != null && capacity > 0) {
    const deliveredKwh = (num(session?.energy_delivered_wh) ?? 0) / 1000;
    soc = Math.min(100, d.expected_arrival_soc_percent + (deliveredKwh / capacity) * 100);
  }
  if (entry != null && slots.length > 0 && soc != null) {
    const predicted = predictSocTimeline({
      nowMs,
      socPercent: soc,
      capacityKwh: capacity,
      slots,
      powerKw: entry.powerKw,
      minSocPercent: d.target_soc_percent,
      maxSocPercent: d.target_soc_max_percent ?? d.target_soc_percent,
      departureMs: d.departure_at?.getTime() ?? null,
    });
    return predicted;
  }
  // Not plugged in (or no plan yet): the planner's predicted times.
  const max = d.target_soc_max_percent;
  return {
    ...empty,
    finalSocPercent:
      max != null && d.predicted_max_ready_at != null
        ? max
        : d.predicted_ready_at != null
          ? d.target_soc_percent
          : null,
    finalReachedAt:
      max != null && d.predicted_max_ready_at != null
        ? d.predicted_max_ready_at
        : d.predicted_ready_at,
  };
}

/**
 * The snapshot of the depot system's sites, in site name order. `presystemId`
 * is the depot system's VDV id: only its own requests carry their ids.
 */
export async function readDepotSnapshot(
  depotSystemId: string,
  presystemId: string,
  now: Date,
): Promise<DepotSnapshot[]> {
  const sites = await client<SiteRow[]>`
    SELECT s.id, s.name FROM depot_system_sites ds JOIN sites s ON s.id = ds.site_id
    WHERE ds.depot_system_id = ${depotSystemId}
    ORDER BY s.name, s.id`;
  if (sites.length === 0) return [];
  const siteIds = sites.map((s) => s.id);
  const stations = await client<StationRow[]>`
    SELECT cs.id, cs.station_id, cs.site_id, cs.is_online, cs.last_heartbeat, cs.ocpp_protocol
    FROM charging_stations cs
    WHERE cs.site_id = ANY(${siteIds}) AND ${client.unsafe(operatorStationSql('cs'))}
    ORDER BY cs.station_id`;
  readDates(stations, ['last_heartbeat']);
  const stationIds = stations.map((s) => s.id);
  if (stationIds.length === 0) {
    return sites.map((s) => ({ siteId: s.id, name: s.name, stations: [] }));
  }
  const since = new Date(now.getTime() - READING_FRESH_MINUTES * 60_000);
  const [evseRows, readings, sessions, departures, plans, allocations, errors] = await Promise.all([
    client<EvseRow[]>`
      SELECT e.id, e.station_id, e.evse_id,
        (SELECT array_agg(c.status::text ORDER BY c.connector_id) FROM connectors c WHERE c.evse_id = e.id) AS statuses
      FROM evses e
      WHERE e.station_id = ANY(${stationIds}) AND e.retired_at IS NULL
      ORDER BY e.station_id, e.evse_id`,
    client<ReadingRow[]>`
      SELECT DISTINCT ON (mv.evse_id, mv.measurand, COALESCE(mv.phase, ''))
        mv.evse_id, mv.measurand, mv.phase, mv.value::text AS value, mv.unit
      FROM meter_values mv
      WHERE mv.station_id = ANY(${stationIds}) AND mv.evse_id IS NOT NULL
        AND mv.timestamp > ${since} AND mv.measurand = ANY(${[...MEASURANDS]})
        AND (mv.location IS NULL OR mv.location = 'Outlet' OR mv.measurand = 'Temperature')
      ORDER BY mv.evse_id, mv.measurand, COALESCE(mv.phase, ''), mv.timestamp DESC`,
    client<SessionRow[]>`
      SELECT s.id, s.evse_id, s.started_at, s.energy_delivered_wh::text AS energy_delivered_wh,
        s.last_soc_percent::text AS last_soc_percent, s.last_soc_at, s.preconditioning_status,
        CASE WHEN f.in_scope THEN v.vin END AS vin,
        CASE WHEN f.in_scope THEN v.evccid END AS evccid,
        CASE WHEN f.in_scope THEN s.vehicle_id END AS vehicle_id
      FROM charging_sessions s
      LEFT JOIN vehicles v ON v.id = s.vehicle_id
      -- Only the system's own buses are named: a vehicle of a fleet holding a
      -- station of its depots (security review I1); another one charges as an
      -- unidentified vehicle.
      LEFT JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1 FROM fleet_drivers fd
          JOIN fleet_stations fs ON fs.fleet_id = fd.fleet_id
          JOIN charging_stations fcs ON fcs.id = fs.station_id
          WHERE fd.driver_id = v.driver_id AND fcs.site_id = ANY(${siteIds})
        ) AS in_scope
      ) f ON true
      WHERE s.station_id = ANY(${stationIds}) AND s.status = 'active'`,
    client<DepartureRow[]>`
      SELECT d.id, d.session_id, d.status, d.depot_system_id, d.external_request_id, d.departure_at,
        d.target_kind, d.target_soc_percent, d.target_soc_max_percent, d.expected_arrival_at,
        d.expected_arrival_soc_percent, d.requested_evse_id, d.predicted_ready_at,
        d.predicted_max_ready_at, v.battery_capacity_kwh::text AS battery_capacity_kwh, v.vin,
        p.hvac_start_at
      FROM vehicle_departures d
      JOIN vehicles v ON v.id = d.vehicle_id
      LEFT JOIN vehicle_departure_preconditioning p ON p.departure_id = d.id
      -- Only the system's own requests: the departures of operators and other
      -- systems stay private (security review I1).
      WHERE d.site_id = ANY(${siteIds}) AND d.depot_system_id = ${depotSystemId}
        AND (d.status = 'scheduled'
          OR (d.status = 'cancelled' AND d.cancel_reason = 'terminated_by_depot_system'
            AND d.session_id IS NOT NULL))
      ORDER BY d.departure_at NULLS FIRST, d.id`,
    client<PlanRow[]>`
      SELECT site_id, slot_starts, plan FROM site_charging_plans WHERE site_id = ANY(${siteIds})`,
    client<AllocationRow[]>`
      SELECT DISTINCT ON (site_id) site_id, allocations FROM load_allocation_log
      WHERE site_id = ANY(${siteIds}) AND created_at > ${new Date(now.getTime() - 2 * 60_000)}
      ORDER BY site_id, created_at DESC`,
    client<ErrorRow[]>`
      SELECT DISTINCT ON (l.station_id, (l.payload->>'connectorId'))
        l.station_id, (l.payload->>'connectorId')::int AS connector_id,
        l.payload->>'errorCode' AS error_code, l.payload->>'info' AS info, l.created_at AS at
      FROM ocpp_message_logs l
      JOIN charging_stations cs ON cs.id = l.station_id AND cs.ocpp_protocol = 'ocpp1.6'
      WHERE l.station_id = ANY(${stationIds}) AND l.action = 'StatusNotification'
        AND l.direction = 'inbound' AND l.message_type = 2
        AND l.created_at > ${new Date(now.getTime() - ERROR_LOOKBACK_DAYS * 86_400_000)}
      ORDER BY l.station_id, (l.payload->>'connectorId'), l.created_at DESC`,
  ]);
  readDates(sessions, ['started_at', 'last_soc_at']);
  readDates(departures, [
    'departure_at',
    'expected_arrival_at',
    'predicted_ready_at',
    'predicted_max_ready_at',
    'hvac_start_at',
  ]);
  readDates(errors, ['at']);

  const nowMs = now.getTime();
  const readingsByEvse = new Map<string, ReadingRow[]>();
  for (const r of readings)
    readingsByEvse.set(r.evse_id, [...(readingsByEvse.get(r.evse_id) ?? []), r]);
  const sessionByEvse = new Map<string, SessionRow>();
  for (const s of sessions) if (s.evse_id != null) sessionByEvse.set(s.evse_id, s);
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const departureBySession = new Map<string, DepartureRow>();
  for (const d of departures) {
    if (
      d.session_id != null &&
      sessionById.has(d.session_id) &&
      !departureBySession.has(d.session_id)
    ) {
      departureBySession.set(d.session_id, d);
    }
  }
  const planBySite = new Map(plans.map((p) => [p.site_id, p]));
  const entryBySession = new Map<string, { entry: StoredEntry; site: string }>();
  for (const p of plans) {
    for (const entry of storedEntries(p.plan))
      entryBySession.set(entry.sessionId, { entry, site: p.site_id });
  }
  const allocatedBySite = new Map(
    allocations.map((a) => [a.site_id, allocatedKwByStation(a.allocations)]),
  );
  const errorsByStation = new Map<string, ErrorRow[]>();
  for (const e of errors)
    errorsByStation.set(e.station_id, [...(errorsByStation.get(e.station_id) ?? []), e]);
  const evsesByStation = new Map<string, EvseRow[]>();
  for (const e of evseRows)
    evsesByStation.set(e.station_id, [...(evsesByStation.get(e.station_id) ?? []), e]);

  const stationSnapshot = (st: StationRow): StationSnapshot => {
    const plan = planBySite.get(st.site_id);
    const slots = slotsOf(plan?.slot_starts);
    const currentSlot = slots.findIndex((s) => nowMs >= s.startMs && nowMs < s.endMs);
    const stationErrors = errorsByStation.get(st.id) ?? [];
    const stationError = stationErrors.find(
      (e) => e.connector_id === 0 && e.error_code != null && e.error_code !== 'NoError',
    );
    const evses = evsesByStation.get(st.id) ?? [];
    const allocated = allocatedBySite.get(st.site_id)?.get(st.id) ?? null;
    const points: PointSnapshot[] = evses.map((e) => {
      const reading = readingsOf(readingsByEvse.get(e.id) ?? []);
      const statuses = (e.statuses ?? []).map(vdvConnectorStatus);
      const session = sessionByEvse.get(e.id) ?? null;
      const pointError = stationErrors.find(
        (x) =>
          x.connector_id != null &&
          x.connector_id > 0 &&
          x.connector_id === e.evse_id &&
          x.error_code != null &&
          x.error_code !== 'NoError',
      );
      let allowedKw: number | null = null;
      let process: ProcessSnapshot | null = null;
      if (session != null) {
        const departure = departureBySession.get(session.id) ?? null;
        const planned = entryBySession.get(session.id)?.entry ?? null;
        if (planned != null && currentSlot >= 0) {
          allowedKw = (planned.powerKw[currentSlot] ?? 0) + (planned.auxKw[currentSlot] ?? 0);
        } else if (allocated != null && evses.filter((x) => sessionByEvse.has(x.id)).length === 1) {
          allowedKw = allocated;
        }
        const own = departure != null && departure.depot_system_id === depotSystemId;
        const state: OcppProcessState =
          (e.statuses ?? []).map((s) => STATE_BY_STATUS[s]).find((s) => s != null) ?? 'Preparing';
        const queued =
          planned != null &&
          currentSlot >= 0 &&
          (planned.powerKw[currentSlot] ?? 0) <= 0 &&
          planned.powerKw.slice(currentSlot + 1).some((kwValue) => kwValue > 0);
        process = {
          processId: departure?.id ?? session.id,
          presystemId: own ? presystemId : null,
          requestId: own ? departure.external_request_id : null,
          startedAt: session.started_at,
          state,
          queued,
          rejected: planned?.rejected === true,
          deliveredWh: num(session.energy_delivered_wh),
          powerKw: reading.powerKw,
          currentA: reading.currentA,
          voltageV: reading.voltageV,
          reactiveKvar: reading.reactiveKvar,
          vehicle:
            session.vin != null
              ? {
                  vin: session.vin,
                  evccId: session.evccid,
                  socPercent:
                    session.last_soc_at != null &&
                    nowMs - session.last_soc_at.getTime() <= SOC_FRESH_MS
                      ? num(session.last_soc_percent)
                      : null,
                  preconditioningStatus: session.preconditioning_status,
                  hvacPreconditioningActive:
                    departure?.hvac_start_at != null && departure.hvac_start_at.getTime() <= nowMs,
                }
              : null,
          prediction:
            departure != null
              ? predictionFor(
                  departure,
                  session,
                  planned,
                  slots.slice(Math.max(0, currentSlot)),
                  nowMs,
                )
              : {
                  minSocPercent: null,
                  minReachedAt: null,
                  finalSocPercent: null,
                  finalReachedAt: null,
                  departureAt: null,
                  socAtDeparture: null,
                },
        };
      }
      const scheduled: ScheduledSnapshot[] = departures
        .filter(
          (d) =>
            d.status === 'scheduled' &&
            d.depot_system_id === depotSystemId &&
            d.requested_evse_id === e.id &&
            (d.session_id == null || !sessionById.has(d.session_id)) &&
            d.vin != null &&
            d.external_request_id != null,
        )
        .flatMap((d) =>
          d.external_request_id != null && d.vin != null
            ? [
                {
                  presystemId,
                  requestId: d.external_request_id,
                  processId: d.id,
                  vin: d.vin,
                  startAt: d.expected_arrival_at,
                  prediction: predictionFor(d, null, null, [], nowMs),
                },
              ]
            : [],
        );
      return {
        evseId: e.evse_id,
        connectorStatuses: statuses,
        errorCode: pointError?.error_code ?? null,
        errorAt: pointError?.at ?? null,
        errorText: pointError?.info ?? null,
        allowedKw,
        meterWh: reading.meterWh,
        powerKw: reading.powerKw,
        temperatureC: reading.temperatureC,
        process,
        scheduled,
      };
    });
    return {
      ocppId: st.station_id,
      isOnline: st.is_online,
      offlineSince: st.is_online ? null : st.last_heartbeat,
      stationErrorCode: stationError?.error_code ?? null,
      stationErrorAt: stationError?.at ?? null,
      points,
    };
  };

  return sites.map((site) => ({
    siteId: site.id,
    name: site.name,
    stations: stations.filter((st) => st.site_id === site.id).map(stationSnapshot),
  }));
}
