// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { OCPP21_ONLY_PROFILE_PURPOSES } from './ocpp-version.js';

/**
 * The one set of rules for sending an OCPP 2.1 charging profile to an OCPP
 * 2.0.1 station. The OCPP server maps every SetChargingProfile and
 * RequestStartTransaction profile with it before the 2.0.1 check, and the API
 * asks it whether a charging profile template reaches 2.0.1 stations, so a
 * template the target check accepts never fails at send time.
 */

type Obj = Record<string, unknown>;

/** Called with the reason a profile cannot be sent to OCPP 2.0.1; never returns. */
export type Ocpp201Refuse = (reason: string) => never;

/** Profile fields 2.1 adds that change what a profile does: refused when set. */
export const OCPP21_ONLY_PROFILE_FIELDS: readonly string[] = [
  'maxOfflineDuration',
  'dynUpdateInterval',
  'priceScheduleSignature',
];

/** Schedule fields 2.1 adds: refused when set. */
export const OCPP21_ONLY_SCHEDULE_FIELDS: readonly string[] = [
  'limitAtSoC',
  'powerTolerance',
  'signatureId',
  'digestValue',
  'absolutePriceSchedule',
  'priceLevelSchedule',
];

/** Schedule period fields 2.1 adds (setpoints, discharging, V2X): refused when set. */
export const OCPP21_ONLY_PERIOD_FIELDS: readonly string[] = [
  'setpoint',
  'setpoint_L2',
  'setpoint_L3',
  'setpointReactive',
  'setpointReactive_L2',
  'setpointReactive_L3',
  'dischargeLimit',
  'dischargeLimit_L2',
  'dischargeLimit_L3',
  'v2xBaseline',
  'v2xFreqWattCurve',
  'v2xSignalWattCurve',
];

function isObj(value: unknown): value is Obj {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function fieldPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function without(obj: Obj, key: string): Obj {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}

/** A 2.1 field whose value equals what 2.0.1 does anyway is dropped; any other value is refused. */
function dropDefault(
  obj: Obj,
  key: string,
  isDefault: (value: unknown) => boolean,
  path: string,
  refuse: Ocpp201Refuse,
): Obj {
  if (!Object.hasOwn(obj, key)) return obj;
  if (!isDefault(obj[key])) refuse(`${fieldPath(path, key)} is not defined in OCPP 2.0.1`);
  return without(obj, key);
}

function refuseFields(
  obj: Obj,
  keys: readonly string[],
  path: string,
  refuse: Ocpp201Refuse,
): void {
  for (const key of keys) {
    if (obj[key] != null) refuse(`${fieldPath(path, key)} is not defined in OCPP 2.0.1`);
  }
}

function periodFor201(period: Obj, path: string, refuse: Ocpp201Refuse): Obj {
  refuseFields(period, OCPP21_ONLY_PERIOD_FIELDS, path, refuse);
  const limit = period['limit'];
  if (typeof limit !== 'number') {
    refuse(`${path}.limit is required in OCPP 2.0.1`);
  }
  // A negative limit is a 2.1 discharge limit; OCPP 2.0.1 has no discharging.
  if (limit < 0) {
    refuse(`${path}.limit ${String(limit)} is a discharge limit, OCPP 2.0.1 has no discharging`);
  }
  let mapped = period;
  // 2.0.1 applies limit to every phase, so a per-phase limit equal to it says nothing more.
  mapped = dropDefault(mapped, 'limit_L2', (v) => v === limit, path, refuse);
  mapped = dropDefault(mapped, 'limit_L3', (v) => v === limit, path, refuse);
  mapped = dropDefault(mapped, 'operationMode', (v) => v === 'ChargingOnly', path, refuse);
  mapped = dropDefault(mapped, 'evseSleep', (v) => v === false, path, refuse);
  mapped = dropDefault(mapped, 'preconditioningRequest', (v) => v === false, path, refuse);
  return mapped;
}

function scheduleFor201(schedule: Obj, path: string, refuse: Ocpp201Refuse): Obj {
  refuseFields(schedule, OCPP21_ONLY_SCHEDULE_FIELDS, path, refuse);
  let mapped = dropDefault(schedule, 'useLocalTime', (v) => v === false, path, refuse);
  mapped = dropDefault(mapped, 'randomizedDelay', (v) => v === 0, path, refuse);
  const periods = mapped['chargingSchedulePeriod'];
  if (Array.isArray(periods)) {
    mapped = {
      ...mapped,
      chargingSchedulePeriod: periods.map((period: unknown, i) =>
        isObj(period)
          ? periodFor201(period, `${path}.chargingSchedulePeriod[${String(i)}]`, refuse)
          : period,
      ),
    };
  }
  return mapped;
}

/**
 * Maps a 2.1 charging profile to OCPP 2.0.1: a purpose (PriorityCharging,
 * LocalGeneration), kind (Dynamic), field or negative limit 2.0.1 does not
 * define calls `refuse` with the reason; a 2.1 field equal to the 2.0.1
 * behaviour is dropped. A value that is not an object is returned as is. The
 * input is not changed.
 */
export function chargingProfileForOcpp201(
  profile: unknown,
  refuse: Ocpp201Refuse,
  path = 'chargingProfile',
): unknown {
  if (!isObj(profile)) return profile;
  if (profile['chargingProfileKind'] === 'Dynamic') {
    refuse(`${path}.chargingProfileKind Dynamic is not defined in OCPP 2.0.1`);
  }
  const purpose = profile['chargingProfilePurpose'];
  if (typeof purpose === 'string' && OCPP21_ONLY_PROFILE_PURPOSES.includes(purpose)) {
    refuse(`${path}.chargingProfilePurpose ${purpose} is not defined in OCPP 2.0.1`);
  }
  refuseFields(profile, OCPP21_ONLY_PROFILE_FIELDS, path, refuse);
  let mapped = dropDefault(
    profile,
    'invalidAfterOfflineDuration',
    (v) => v === false,
    path,
    refuse,
  );
  // Only describes when a dynamic profile was last updated; Dynamic is refused above.
  if (Object.hasOwn(mapped, 'dynUpdateTime')) {
    mapped = without(mapped, 'dynUpdateTime');
  }
  const schedules = mapped['chargingSchedule'];
  if (Array.isArray(schedules)) {
    mapped = {
      ...mapped,
      chargingSchedule: schedules.map((schedule: unknown, i) =>
        isObj(schedule)
          ? scheduleFor201(schedule, `${path}.chargingSchedule[${String(i)}]`, refuse)
          : schedule,
      ),
    };
  }
  return mapped;
}

class Refusal extends Error {}

/** Why an OCPP 2.0.1 station cannot take this 2.1 charging profile, or null when it can. */
export function ocpp201ChargingProfileRefusal(profile: unknown, path?: string): string | null {
  try {
    chargingProfileForOcpp201(
      profile,
      (reason) => {
        throw new Refusal(reason);
      },
      path,
    );
    return null;
  } catch (err) {
    if (err instanceof Refusal) return err.message;
    throw err;
  }
}
