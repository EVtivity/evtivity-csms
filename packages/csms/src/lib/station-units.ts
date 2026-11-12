// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** A unit (physical charger box) of a station, as `GET /v1/stations/:id/units` returns it. */
export interface StationUnit {
  id: string;
  stationId: string;
  name: string;
  sortOrder: number;
  evseIds: string[];
  evseNumbers: number[];
}

export interface UnitGroup<E> {
  unit: StationUnit;
  evses: E[];
}

/**
 * The EVSEs of a station by unit, in the station's unit order, then the EVSEs
 * without a unit. A station without units has no unit group: every EVSE is in
 * `unassigned`, so callers keep the station's plain EVSE list.
 */
export function groupEvsesByUnit<E extends { evseId: number; unitId?: string | null }>(
  evses: readonly E[],
  units: readonly StationUnit[],
): { units: UnitGroup<E>[]; unassigned: E[] } {
  const ordered = [...units].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
  const known = new Set(ordered.map((u) => u.id));
  return {
    units: ordered.map((unit) => ({
      unit,
      evses: evses.filter((e) => e.unitId === unit.id),
    })),
    unassigned: evses.filter((e) => e.unitId == null || !known.has(e.unitId)),
  };
}

// Station-level reasons apply to every unit: one OCPP connection serves them all.
const STATION_LEVEL_REASONS = new Set([
  'operator_disabled',
  'security_disabled',
  'firmware_failed',
  'station_faulted',
  'firmware_installing',
  'station_unavailable',
]);

// Connector statuses that show a charger as charging (a plug in use), as the
// station's derived status does.
const IN_USE = new Set([
  'occupied',
  'charging',
  'preparing',
  'ev_connected',
  'suspended_ev',
  'suspended_evse',
  'idle',
  'discharging',
]);

/**
 * The status a unit shows: the station's own status while a station-level
 * state holds (a disable, a firmware install, a station fault), else the plug
 * summary of the unit's in-service connectors with the station rule: charging,
 * reserved, faulted, unknown (no connectors), available, unavailable.
 */
export function unitStatus(
  connectorStatuses: readonly string[],
  station: { status: string; statusReason?: string | null },
): string {
  if (station.statusReason != null && STATION_LEVEL_REASONS.has(station.statusReason)) {
    return station.status;
  }
  if (connectorStatuses.some((s) => IN_USE.has(s))) return 'charging';
  if (connectorStatuses.includes('reserved')) return 'reserved';
  if (connectorStatuses.includes('faulted')) return 'faulted';
  if (connectorStatuses.length === 0) return 'unknown';
  if (connectorStatuses.every((s) => s === 'available')) return 'available';
  return 'unavailable';
}
