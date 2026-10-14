// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * OCPP 2.1 purposes a ClearChargingProfile never removes (K10.FR.04, K10.FR.08,
 * K10.FR.09) and the CSMS must not name in one (K10.FR.06).
 */
export const UNCLEARABLE_PROFILE_PURPOSES = [
  'ChargingStationExternalConstraints',
  'LocalGeneration',
] as const;

/** Purposes the CSMS may clear on an OCPP 2.1 station. */
export const CLEARABLE_PROFILE_PURPOSES = [
  'ChargingStationMaxProfile',
  'TxDefaultProfile',
  'TxProfile',
  'PriorityCharging',
] as const;

// The station-wide purpose has a 1.6 and a 2.1 name, and a stored profile can
// hold either (a profile set through the 1.6 command route keeps its 1.6 form).
const PURPOSE_ALIAS: Record<string, string> = {
  ChargingStationMaxProfile: 'ChargePointMaxProfile',
  ChargePointMaxProfile: 'ChargingStationMaxProfile',
};

/** The criteria of an accepted ClearChargingProfile, normalized from either version. */
export interface ChargingProfileClearCriteria {
  chargingProfileId: number | null;
  chargingProfilePurpose: string | null;
  stackLevel: number | null;
  evseId: number | null;
}

/** A jsonpath filter over a stored profile_data value and its variables. */
export interface ChargingProfileClearFilter {
  path: string;
  vars: Record<string, string | number>;
  evseId: number | null;
}

const int = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) ? value : null;
const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/**
 * Reads a ClearChargingProfile request in the 2.1 form (`chargingProfileId`,
 * `chargingProfileCriteria.{evseId, chargingProfilePurpose, stackLevel}`) or
 * the native 1.6 form (`id`, `connectorId`, `chargingProfilePurpose`,
 * `stackLevel`).
 */
export function chargingProfileClearCriteria(
  request: Record<string, unknown>,
): ChargingProfileClearCriteria {
  const nested = request['chargingProfileCriteria'];
  const criteria =
    nested != null && typeof nested === 'object' ? (nested as Record<string, unknown>) : request;
  return {
    chargingProfileId: int(request['chargingProfileId']) ?? int(request['id']),
    chargingProfilePurpose: text(criteria['chargingProfilePurpose']),
    stackLevel: int(criteria['stackLevel']),
    evseId: int(criteria['evseId']) ?? int(criteria['connectorId']),
  };
}

/**
 * The filter matching the stored profiles a station removed when it accepted a
 * clear with these criteria. profile_data holds one profile object (csms_set)
 * or an array of them (station_reported); `lax $[*]` reads both. All criteria
 * must hold for the same profile, values go in as variables (never into the
 * path text), and profiles the station keeps on any clear (external
 * constraints, local generation) never match.
 */
export function chargingProfileClearFilter(
  criteria: ChargingProfileClearCriteria,
): ChargingProfileClearFilter {
  const kept = UNCLEARABLE_PROFILE_PURPOSES.map((_, i) => `@ == $kept${String(i)}`).join(' || ');
  const filters: string[] = [`!exists(@.chargingProfilePurpose ? (${kept}))`];
  const vars: Record<string, string | number> = Object.fromEntries(
    UNCLEARABLE_PROFILE_PURPOSES.map((purpose, i) => [`kept${String(i)}`, purpose]),
  );
  if (criteria.chargingProfileId != null) {
    filters.push('(@.id == $id || @.chargingProfileId == $id)');
    vars['id'] = criteria.chargingProfileId;
  }
  if (criteria.chargingProfilePurpose != null) {
    filters.push('(@.chargingProfilePurpose == $purpose || @.chargingProfilePurpose == $alias)');
    vars['purpose'] = criteria.chargingProfilePurpose;
    vars['alias'] =
      PURPOSE_ALIAS[criteria.chargingProfilePurpose] ?? criteria.chargingProfilePurpose;
  }
  if (criteria.stackLevel != null) {
    filters.push('@.stackLevel == $stackLevel');
    vars['stackLevel'] = criteria.stackLevel;
  }
  return { path: `lax $[*] ? (${filters.join(' && ')})`, vars, evseId: criteria.evseId };
}
