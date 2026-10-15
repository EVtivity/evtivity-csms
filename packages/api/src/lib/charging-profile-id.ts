// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * OCPP 2.1 K01.FR.80/81: profile ids up to a station's
 * SmartChargingCtrlr.MaxExternalConstraintsId belong to the station's own
 * external constraints profiles; the station rejects a SetChargingProfile
 * with such an id. Operator-entered ids (the station charging profile push,
 * template pushes, the generic SetChargingProfile command) must be above the
 * value the station reported. A station with no recorded value (OCPP 1.6, or
 * no report yet) is not checked.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { AppError } from '@evtivity/lib';
import {
  db,
  chargingStations,
  stationConfigurations,
  circuits,
  panels,
  siteLoadManagement,
} from '@evtivity/database';
import {
  LOAD_MANAGEMENT_PROFILE_ID,
  LOAD_MANAGEMENT_STACK_LEVEL,
  loadManagementProfileId,
} from '@evtivity/services/load-management.service';
import { ERROR_CODES } from './error-codes.generated.js';

const MAX_EXTERNAL_CONSTRAINTS_ID = 'MaxExternalConstraintsId';

function parseMax(value: string | null): number | null {
  if (value == null) return null;
  const max = Number(value);
  return Number.isInteger(max) ? max : null;
}

/** MaxExternalConstraintsId recorded for each station, by station database id. */
export async function maxExternalConstraintsIds(
  stationDbIds: readonly string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (stationDbIds.length === 0) return result;
  const rows = await db
    .select({ stationId: stationConfigurations.stationId, value: stationConfigurations.value })
    .from(stationConfigurations)
    .where(
      and(
        inArray(stationConfigurations.stationId, [...stationDbIds]),
        eq(stationConfigurations.component, 'SmartChargingCtrlr'),
        eq(stationConfigurations.variable, MAX_EXTERNAL_CONSTRAINTS_ID),
        eq(stationConfigurations.attributeType, 'Actual'),
      ),
    );
  for (const row of rows) {
    const max = parseMax(row.value);
    if (max != null) result.set(row.stationId, max);
  }
  return result;
}

/** MaxExternalConstraintsId recorded for a station, by its OCPP identity. */
export async function maxExternalConstraintsIdByIdentity(
  stationIdentity: string,
): Promise<number | null> {
  const [row] = await db
    .select({ value: stationConfigurations.value })
    .from(stationConfigurations)
    .innerJoin(chargingStations, eq(stationConfigurations.stationId, chargingStations.id))
    .where(
      and(
        eq(chargingStations.stationId, stationIdentity),
        eq(stationConfigurations.component, 'SmartChargingCtrlr'),
        eq(stationConfigurations.variable, MAX_EXTERNAL_CONSTRAINTS_ID),
        eq(stationConfigurations.attributeType, 'Actual'),
      ),
    );
  return parseMax(row?.value ?? null);
}

export function reservedProfileIdMessage(profileId: number, maxExternalId: number): string {
  return `Charging profile id ${String(profileId)} must be above the station's MaxExternalConstraintsId ${String(maxExternalId)} (OCPP 2.1 K01.FR.81)`;
}

/** True when the station would reject `profileId` (at or below its recorded value). */
export function isReservedProfileId(
  profileId: number,
  maxExternalId: number | null | undefined,
): boolean {
  return maxExternalId != null && profileId <= maxExternalId;
}

/** Throws 400 CHARGING_PROFILE_ID_RESERVED for an id the station would reject. */
export function assertProfileIdAllowed(
  profileId: number,
  maxExternalId: number | null | undefined,
): void {
  if (maxExternalId != null && isReservedProfileId(profileId, maxExternalId)) {
    throw new AppError(
      reservedProfileIdMessage(profileId, maxExternalId),
      400,
      ERROR_CODES.CHARGING_PROFILE_ID_RESERVED,
    );
  }
}

// ---- Load management owns the station limit ----
//
// On a station that load management manages (on a circuit of a panel of its
// site, load management on for the site), the limit of the whole station is
// the load management profile: a ChargingStationMaxProfile (1.6
// ChargePointMaxProfile) at LOAD_MANAGEMENT_STACK_LEVEL with the station's
// load management profile id. Another ChargingStationMaxProfile at that stack
// level or above wins over it (the highest stack level wins within a
// purpose), and a profile with its id replaces it (K01.FR.05): either lifts
// the breaker limit. Every operator path (template push, station push, the
// generic SetChargingProfile commands) refuses both with 400
// CHARGING_PROFILE_LOAD_MANAGED.

/** The fields of a profile the rule reads (2.1 or 1.6 names). */
export interface ProfileIdentity {
  profileId: number | null;
  purpose: string | null;
  stackLevel: number | null;
}

/** Reads a SetChargingProfile request: 2.1 `chargingProfile` or 1.6 `csChargingProfiles`. */
export function profileIdentityFromRequest(payload: Record<string, unknown>): ProfileIdentity {
  const raw = payload['chargingProfile'] ?? payload['csChargingProfiles'];
  const profile = raw != null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const id = profile['id'] ?? profile['chargingProfileId'];
  const purpose = profile['chargingProfilePurpose'];
  const stackLevel = profile['stackLevel'];
  return {
    profileId: typeof id === 'number' && Number.isInteger(id) ? id : null,
    purpose: typeof purpose === 'string' ? purpose : null,
    stackLevel: typeof stackLevel === 'number' && Number.isInteger(stackLevel) ? stackLevel : null,
  };
}

function isStationMaxPurpose(purpose: string | null): boolean {
  return purpose === 'ChargingStationMaxProfile' || purpose === 'ChargePointMaxProfile';
}

function isStationMaxAtLoadManagementLevel(profile: ProfileIdentity): boolean {
  return (
    isStationMaxPurpose(profile.purpose) &&
    profile.stackLevel != null &&
    profile.stackLevel >= LOAD_MANAGEMENT_STACK_LEVEL
  );
}

/**
 * True when the profile could override load management on some station:
 * checked before the database is read, so other profiles cost no query.
 */
export function mayOverrideLoadManagement(profile: ProfileIdentity): boolean {
  return (
    isStationMaxAtLoadManagementLevel(profile) ||
    (profile.profileId != null && profile.profileId >= LOAD_MANAGEMENT_PROFILE_ID)
  );
}

/**
 * True when the profile would override the load management limit of a
 * managed station whose MaxExternalConstraintsId is `maxExternalId`.
 */
export function overridesLoadManagement(
  profile: ProfileIdentity,
  maxExternalId: number | null | undefined,
): boolean {
  if (isStationMaxAtLoadManagementLevel(profile)) return true;
  return (
    profile.profileId != null &&
    profile.profileId ===
      loadManagementProfileId(maxExternalId != null ? String(maxExternalId) : null)
  );
}

export function loadManagedMessage(profile: ProfileIdentity): string {
  return `Charging profile ${String(profile.profileId ?? '')} would override the load management limit of the station. On a station load management manages, a ChargingStationMaxProfile needs a stack level below ${String(LOAD_MANAGEMENT_STACK_LEVEL)}, and no profile may use the load management profile id`;
}

/**
 * The stations (database ids) load management manages: on a circuit of a
 * panel of their own site, with load management on at that site.
 */
export async function loadManagedStationIds(stationDbIds: readonly string[]): Promise<Set<string>> {
  if (stationDbIds.length === 0) return new Set();
  const rows = await db
    .select({ id: chargingStations.id })
    .from(chargingStations)
    .innerJoin(circuits, eq(chargingStations.circuitId, circuits.id))
    .innerJoin(
      panels,
      and(eq(circuits.panelId, panels.id), eq(panels.siteId, chargingStations.siteId)),
    )
    .innerJoin(siteLoadManagement, eq(siteLoadManagement.siteId, chargingStations.siteId))
    .where(
      and(inArray(chargingStations.id, [...stationDbIds]), eq(siteLoadManagement.isEnabled, true)),
    );
  return new Set(rows.map((r) => r.id));
}

/** True when load management manages the station, by its OCPP identity. */
export async function isLoadManagedStationIdentity(stationIdentity: string): Promise<boolean> {
  const [row] = await db
    .select({ id: chargingStations.id })
    .from(chargingStations)
    .where(eq(chargingStations.stationId, stationIdentity));
  if (row == null) return false;
  return (await loadManagedStationIds([row.id])).has(row.id);
}

/**
 * Throws 400 CHARGING_PROFILE_LOAD_MANAGED when the profile would override
 * the load management limit of the station (by database id or OCPP identity).
 * Reads the database only for a profile that could.
 */
export async function assertNotLoadManaged(
  station: { dbId: string } | { identity: string },
  profile: ProfileIdentity,
  maxExternalId: number | null | undefined,
): Promise<void> {
  if (!mayOverrideLoadManagement(profile)) return;
  if (!overridesLoadManagement(profile, maxExternalId)) return;
  const managed =
    'dbId' in station
      ? (await loadManagedStationIds([station.dbId])).has(station.dbId)
      : await isLoadManagedStationIdentity(station.identity);
  if (managed) {
    throw new AppError(loadManagedMessage(profile), 400, ERROR_CODES.CHARGING_PROFILE_LOAD_MANAGED);
  }
}
