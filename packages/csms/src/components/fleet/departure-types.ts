// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Shapes of the departure and schedule routes, the readiness badge colors and
// the query keys shared by the fleet Departures tab and the depot Fleet
// Readiness tab.

import type { TFunction } from 'i18next';
import type { BadgeProps } from '@/components/ui/badge';
import { formatNumber } from '@/lib/formatting';
import { formatDepotDateTime } from '@/lib/depot-time';

export type DepartureTargetKind = 'energy' | 'soc';

export type DepartureReadiness =
  | 'ready'
  | 'on_track'
  | 'at_risk'
  | 'cannot_meet'
  | 'waiting_for_vehicle';

export type DepartureReadinessReason =
  | 'site_capacity'
  | 'not_plugged_in'
  | 'late_arrival'
  | 'charger_not_following'
  | 'profile_rejected'
  | 'station_offline'
  | 'vehicle_power'
  | 'unknown_soc';

export const READINESS_STATES: readonly DepartureReadiness[] = [
  'ready',
  'on_track',
  'at_risk',
  'cannot_meet',
  'waiting_for_vehicle',
];

export interface DepartureVehicle {
  id: string;
  driverId: string;
  make: string | null;
  model: string | null;
  licensePlate: string | null;
  bodyType?: string | null;
}

export interface DepartureTargetFields {
  targetKind: DepartureTargetKind;
  targetEnergyKwh: number | null;
  /** The minimum state of charge of a soc target. */
  targetSocPercent: number | null;
  /** Charge further up to this state of charge from spare capacity (soc targets), null for none. */
  targetSocMaxPercent?: number | null;
  priority: number;
}

export type DepartureStatus = 'scheduled' | 'cancelled' | 'completed';
export const DEPARTURE_STATUS_FILTERS: readonly DepartureStatus[] = [
  'scheduled',
  'cancelled',
  'completed',
];

/** Where a departure came from (`vehicle_departures.source`). */
export type DepartureSource = 'manual' | 'schedule' | 'import' | 'vehicle' | 'depot_system';
export const DEPARTURE_SOURCES: readonly DepartureSource[] = [
  'manual',
  'schedule',
  'import',
  'vehicle',
  'depot_system',
];

/** Why a bus depot system cancelled a departure (null: a person cancelled it). */
export type DepartureCancelReason =
  | 'removed_by_depot_system'
  | 'terminated_by_depot_system'
  | 'superseded_by_depot_system';

export const DEPARTURE_CANCEL_REASONS: readonly DepartureCancelReason[] = [
  'removed_by_depot_system',
  'terminated_by_depot_system',
  'superseded_by_depot_system',
];

export interface DepartureSchedule extends DepartureTargetFields {
  id: string;
  vehicleId: string;
  siteId: string;
  siteName?: string;
  /** IANA time zone of the depot (list replies); departureTime is local to it. */
  siteTimezone?: string;
  vehicle?: DepartureVehicle;
  daysOfWeek: number[];
  departureTime: string;
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
  notes: string | null;
}

export interface Departure extends DepartureTargetFields {
  id: string;
  vehicleId: string;
  siteId: string;
  siteName?: string;
  /** IANA time zone of the depot (list replies): departure times show in it. */
  siteTimezone?: string;
  vehicle?: DepartureVehicle;
  scheduleId: string | null;
  /** When the vehicle must be ready; null for an ad hoc request of a bus depot system. */
  departureAt: string | null;
  /** An ad hoc request of a bus depot system: charge as soon as the bus plugs in. */
  adHoc?: boolean;
  /** When the vehicle is expected to plug in (bus depot system requests). */
  expectedArrivalAt?: string | null;
  /** State of charge expected at arrival. */
  expectedArrivalSocPercent?: number | null;
  /** The EVSE record a bus depot system assigned. */
  requestedEvseId?: string | null;
  /** The same EVSE as the bus depot system names it (`<OCPP station id>/<EVSE id>`). */
  requestedChargingPointId?: string | null;
  source: string;
  /** The bus depot system that requested it (source depot_system). */
  depotSystemId?: string | null;
  /** Read-only: a bus depot system that is enabled requested it (every reader). */
  managedByDepotSystem?: boolean;
  /** The bus depot system's name, only for readers who may list the systems. */
  depotSystemName?: string | null;
  /** The charging request id of the bus depot system. */
  externalRequestId?: string | null;
  cancelReason?: DepartureCancelReason | null;
  /** When the plan reaches the maximum state of charge. */
  predictedMaxReadyAt?: string | null;
  overridden: boolean;
  status: DepartureStatus;
  readiness: DepartureReadiness | null;
  readinessReason: DepartureReadinessReason | null;
  /** The session charging for it; the API leaves it out without sessions:read. */
  sessionId?: string | null;
  plannedKwh: number | null;
  deliveredKwh: number | null;
  shortfallKwh: number | null;
  predictedReadyAt: string | null;
  /** The station and EVSE of the bound session (charging plan view only). */
  station?: { id: string; stationId: string; evseId: number | null } | null;
}

/** A site the departure dialogs offer (from `GET /v1/sites`). */
export interface DepotSite {
  id: string;
  name: string;
  timezone: string | null;
}

/** A fleet vehicle the departure dialogs offer (from `GET /v1/fleets/:id/vehicles`). */
export interface FleetVehicleOption {
  id: string;
  make: string | null;
  model: string | null;
  licensePlate: string | null;
}

export const fleetDepartureKeys = {
  all: (fleetId: string) => ['fleet-departures', fleetId] as const,
  schedules: (fleetId: string, page: number) =>
    ['fleet-departures', fleetId, 'schedules', page] as const,
  departures: (fleetId: string, page: number) =>
    ['fleet-departures', fleetId, 'departures', page] as const,
};

export const siteChargingPlanKey = (siteId: string) => ['site-charging-plan', siteId] as const;

export function readinessVariant(state: DepartureReadiness | null): BadgeProps['variant'] {
  switch (state) {
    case 'ready':
    case 'on_track':
      return 'success';
    case 'at_risk':
      return 'warning';
    case 'cannot_meet':
      return 'destructive';
    case 'waiting_for_vehicle':
      return 'info';
    default:
      return 'outline';
  }
}

/** "Bus 12 (AB-123)", or the plate, or make and model, or the id. */
export function vehicleLabel(vehicle: Partial<FleetVehicleOption> | undefined | null): string {
  if (vehicle == null) return '';
  const name = [vehicle.make, vehicle.model].filter((v) => v != null && v !== '').join(' ');
  if (name !== '' && vehicle.licensePlate != null && vehicle.licensePlate !== '') {
    return `${name} (${vehicle.licensePlate})`;
  }
  return vehicle.licensePlate ?? (name !== '' ? name : (vehicle.id ?? ''));
}

/** "120 kWh" or "80%" for a departure target. */
export function targetLabel(target: DepartureTargetFields): string {
  if (target.targetKind === 'soc') return `${formatNumber(target.targetSocPercent ?? 0, 0)}%`;
  return `${formatNumber(target.targetEnergyKwh ?? 0, 1)} kWh`;
}

/** "80% Up To 95%" for a soc target with a maximum, else the target alone. */
export function targetWithMaxLabel(t: TFunction, target: DepartureTargetFields): string {
  const base = targetLabel(target);
  if (target.targetKind !== 'soc' || target.targetSocMaxPercent == null) return base;
  return t('fleets.departures.targetUpTo', {
    target: base,
    max: `${formatNumber(target.targetSocMaxPercent, 0)}%`,
  });
}

/** The departure time at the depot, or As Soon As Possible for an ad hoc request. */
export function departureTimeLabel(
  t: TFunction,
  d: Pick<Departure, 'departureAt'>,
  timeZone: string | null | undefined,
): string {
  return d.departureAt == null
    ? t('fleets.departures.asSoonAsPossible')
    : formatDepotDateTime(d.departureAt, timeZone);
}

/** Departures in time order; ad hoc requests (no time) first, as the planner charges them first. */
export function compareDepartures(
  a: Pick<Departure, 'id' | 'departureAt'>,
  b: Pick<Departure, 'id' | 'departureAt'>,
): number {
  const at = a.departureAt == null ? -Infinity : new Date(a.departureAt).getTime();
  const bt = b.departureAt == null ? -Infinity : new Date(b.departureAt).getTime();
  if (at !== bt) return at < bt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Why a cancelled departure was cancelled, in plain words. */
export function cancelReasonLabel(t: TFunction, reason: DepartureCancelReason | null): string {
  return reason == null
    ? t('fleets.departures.cancelledByPerson')
    : t(`fleets.departures.cancelReasons.${reason}`);
}

/** The label of a departure source; a bus depot system's name when the reader may see it. */
export function departureSourceLabel(
  t: TFunction,
  d: Pick<Departure, 'source' | 'depotSystemName'>,
): string {
  if (d.source === 'depot_system') {
    return d.depotSystemName != null && d.depotSystemName !== ''
      ? t('fleets.departures.depotSystemBadgeNamed', { name: d.depotSystemName })
      : t('fleets.departures.depotSystemBadge');
  }
  return (DEPARTURE_SOURCES as readonly string[]).includes(d.source)
    ? t(`fleets.departures.sources.${d.source as Exclude<DepartureSource, 'depot_system'>}`)
    : d.source;
}

/** A person may edit or cancel it: still scheduled and no enabled bus depot system owns it. */
export function isDepartureEditable(
  d: Pick<Departure, 'status' | 'managedByDepotSystem'>,
): boolean {
  return d.status === 'scheduled' && d.managedByDepotSystem !== true;
}

/** "45.0 of 120 kWh" (delivered of target); the delivered part alone for a SoC target. */
export function deliveredOfTarget(t: TFunction, d: Departure): string {
  const delivered = formatNumber(d.deliveredKwh ?? 0, 1);
  if (d.targetKind === 'energy' && d.targetEnergyKwh != null) {
    return t('fleets.departures.deliveredOf', {
      delivered,
      target: formatNumber(d.targetEnergyKwh, 1),
    });
  }
  return `${delivered} kWh`;
}
