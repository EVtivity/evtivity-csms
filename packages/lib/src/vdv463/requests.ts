// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Charging requests of a depot system, checked and turned into what a
// departure stores. Checks that need the database (vehicle, charging point,
// charging process) are done by the service; this module is pure.

import type { Vdv463PreconditioningRequest } from './constants.js';
import type { Vdv463ChargingRequest } from './schemas.js';

/** Why a charging request was not applied (depot_system_refused_requests.reason). */
export const VDV463_REFUSAL_REASONS = [
  'unknown_vehicle',
  'vehicle_not_bus',
  'unknown_charging_point',
  'unknown_charging_process',
  'soc_out_of_range',
  'min_above_max',
  'no_departure_time',
  'departure_in_past',
  'departure_too_far',
  'arrival_after_departure',
  'vehicle_owned_by_other_system',
  'no_battery_capacity',
  'precondition_window_invalid',
  'duplicate_request_id',
  'identifier_too_long',
  'list_too_long',
] as const;

/**
 * The longest identifier EVtivity stores (request, process and charging point
 * ids, vehicle ids). VDV 463 sets no limit; a longer one refuses only its
 * request (security review L4).
 */
export const VDV463_MAX_IDENTIFIER_LENGTH = 255;
export type Vdv463RefusalReason = (typeof VDV463_REFUSAL_REASONS)[number];

/** Our names for the preconditioning climate types (vehicle_departure_preconditioning.climate). */
export const PRECONDITIONING_CLIMATES = [
  'warm_water_ventilation',
  'hot_water_heating',
  'no_heating_cooling_ventilation',
  'none',
] as const;
export type PreconditioningClimate = (typeof PRECONDITIONING_CLIMATES)[number];

const CLIMATE_BY_REQUEST: Record<Vdv463PreconditioningRequest, PreconditioningClimate> = {
  WarmWaterAndVentilation: 'warm_water_ventilation',
  HotWaterAndHeating: 'hot_water_heating',
  NoWaterCoolingOrVentilation: 'no_heating_cooling_ventilation',
  NoClimaticPreconditioningOrSNA: 'none',
};

export function climateOfRequest(request: Vdv463PreconditioningRequest): PreconditioningClimate {
  return CLIMATE_BY_REQUEST[request];
}

/** Departures at most this far ahead (the planner reads seven days). */
export const VDV463_DEPARTURE_MAX_AHEAD_MS = 7 * 86_400_000;
/** A departure up to five minutes in the past is clock skew, not a refusal. */
export const VDV463_DEPARTURE_PAST_SKEW_MS = 5 * 60_000;
/** Highest preconditioning power a request may reserve. */
export const VDV463_PRECONDITIONING_KW_MAX = 500;

/** VDV: smaller is more important, no range. Ours: 1 lowest to 10 highest (decision D4). */
export function priorityFromVdv(priority: number | undefined): number {
  if (priority == null || !Number.isFinite(priority)) return 5;
  return Math.min(10, Math.max(1, 11 - Math.trunc(priority)));
}

export interface DeparturePreconditioningInput {
  climate: PreconditioningClimate | null;
  ambientTemperatureC: number | null;
  startAt: Date | null;
  finishAt: Date | null;
  hvacStartAt: Date | null;
  hvacKw: number | null;
  systemStartAt: Date | null;
  systemKw: number | null;
}

/** A checked request, before the database checks. */
export interface CheckedChargingRequest {
  externalRequestId: string;
  vehicleRef: string;
  chargingPointRef: string | null;
  chargingProcessRef: string | null;
  terminate: boolean;
  priority: number;
  externalPriority: number | null;
  minSocPercent: number;
  maxSocPercent: number;
  adHoc: boolean;
  departureAt: Date | null;
  expectedArrivalAt: Date | null;
  expectedArrivalSocPercent: number | null;
  preconditioning: DeparturePreconditioningInput | null;
}

export type RequestCheck =
  | { ok: true; request: CheckedChargingRequest }
  | { ok: false; reason: Vdv463RefusalReason };

function date(value: string | undefined): Date | null {
  return value != null ? new Date(value) : null;
}

function inSocRange(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

function kw(value: number | undefined): number | null | 'invalid' {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0 || value > VDV463_PRECONDITIONING_KW_MAX) {
    return 'invalid';
  }
  return value;
}

/** Checks one charging request at `now`. */
export function checkChargingRequest(request: Vdv463ChargingRequest, now: Date): RequestCheck {
  const ids = [
    request.chargingRequestId,
    request.vehicleId,
    request.chargingPointId,
    request.chargingProcessId,
  ];
  if (ids.some((id) => id != null && id.length > VDV463_MAX_IDENTIFIER_LENGTH)) {
    return { ok: false, reason: 'identifier_too_long' };
  }
  const data = request.chargingRequestData;
  if (!inSocRange(data.minTargetSoc) || !inSocRange(data.maxTargetSoc)) {
    return { ok: false, reason: 'soc_out_of_range' };
  }
  if (data.expectedSocAtArrival != null && !inSocRange(data.expectedSocAtArrival)) {
    return { ok: false, reason: 'soc_out_of_range' };
  }
  // The minimum is a promise, so it rounds up; the maximum rounds down.
  const minSoc = Math.ceil(data.minTargetSoc);
  const maxSoc = Math.floor(data.maxTargetSoc);
  if (minSoc > maxSoc) return { ok: false, reason: 'min_above_max' };

  const adHoc = data.adHocCharging === true;
  const departureAt = adHoc ? null : date(data.requestedTimeForDeparture);
  if (!adHoc && departureAt == null) return { ok: false, reason: 'no_departure_time' };
  const nowMs = now.getTime();
  if (departureAt != null) {
    if (departureAt.getTime() < nowMs - VDV463_DEPARTURE_PAST_SKEW_MS) {
      return { ok: false, reason: 'departure_in_past' };
    }
    if (departureAt.getTime() > nowMs + VDV463_DEPARTURE_MAX_AHEAD_MS) {
      return { ok: false, reason: 'departure_too_far' };
    }
  }
  const expectedArrivalAt = date(data.expectedArrivalTimeAtChargingPoint);
  if (
    expectedArrivalAt != null &&
    departureAt != null &&
    expectedArrivalAt.getTime() >= departureAt.getTime()
  ) {
    return { ok: false, reason: 'arrival_after_departure' };
  }

  let preconditioning: DeparturePreconditioningInput | null = null;
  const auto = request.automaticPreconditioning;
  const manual = request.manualPreconditioning;
  if (auto != null || manual != null) {
    const startAt = date(auto?.requestedStartTime);
    let finishAt = date(auto?.requestedFinishTime) ?? (auto != null ? departureAt : null);
    if (finishAt != null && departureAt != null && finishAt.getTime() > departureAt.getTime()) {
      finishAt = departureAt;
    }
    if (startAt != null && finishAt != null && startAt.getTime() >= finishAt.getTime()) {
      return { ok: false, reason: 'precondition_window_invalid' };
    }
    if (auto != null && adHoc && finishAt == null) {
      return { ok: false, reason: 'precondition_window_invalid' };
    }
    const hvacStartAt = date(manual?.hvacPreconditioningStartTime);
    const systemStartAt = date(manual?.systemPreconditioningStartTime);
    for (const start of [hvacStartAt, systemStartAt]) {
      if (start != null && departureAt != null && start.getTime() >= departureAt.getTime()) {
        return { ok: false, reason: 'precondition_window_invalid' };
      }
    }
    if (manual != null && adHoc) return { ok: false, reason: 'precondition_window_invalid' };
    const hvacKw = kw(manual?.hvacAuxiliaryConsumerPower);
    const systemKw = kw(manual?.systemAuxiliaryConsumerPower);
    if (hvacKw === 'invalid' || systemKw === 'invalid') {
      return { ok: false, reason: 'precondition_window_invalid' };
    }
    const ambient = auto?.ambientTemperature;
    preconditioning = {
      climate: auto != null ? climateOfRequest(auto.preconditioningRequest) : null,
      ambientTemperatureC:
        ambient != null && Number.isFinite(ambient)
          ? Math.min(70, Math.max(-50, Math.round(ambient)))
          : null,
      startAt,
      finishAt,
      hvacStartAt,
      hvacKw,
      systemStartAt,
      systemKw,
    };
  }

  return {
    ok: true,
    request: {
      externalRequestId: request.chargingRequestId,
      vehicleRef: request.vehicleId,
      chargingPointRef: request.chargingPointId ?? null,
      chargingProcessRef: request.chargingProcessId?.trim() ?? null,
      terminate: request.chargingInstruction === 'Terminate',
      priority: priorityFromVdv(request.priority),
      externalPriority: request.priority ?? null,
      minSocPercent: minSoc,
      maxSocPercent: maxSoc,
      adHoc,
      departureAt,
      expectedArrivalAt,
      expectedArrivalSocPercent:
        data.expectedSocAtArrival != null ? Math.round(data.expectedSocAtArrival) : null,
      preconditioning,
    },
  };
}

/** `<station OCPP id>/<evse id>` (decision D2). */
export function chargingPointId(stationOcppId: string, evseId: number): string {
  return `${stationOcppId}/${String(evseId)}`;
}

/** Splits a charging point id at its last slash; null when it is not ours. */
export function parseChargingPointId(
  value: string,
): { stationOcppId: string; evseId: number } | null {
  const at = value.lastIndexOf('/');
  if (at <= 0) return null;
  const evse = value.slice(at + 1);
  if (!/^[1-9]\d{0,3}$/.test(evse)) return null;
  return { stationOcppId: value.slice(0, at), evseId: Number(evse) };
}
