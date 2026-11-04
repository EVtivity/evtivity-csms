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

import { and, eq, inArray, sql } from 'drizzle-orm';
import { AppError, chargingProfileClearCriteria } from '@evtivity/lib';
import { chargingNeedsProfileId } from '@evtivity/lib/charging-profile-ids';
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
  loadManagementCreditProfileId,
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
  if (profile.profileId == null) return false;
  // The load management profile and its credit profile (security case 334).
  const profileId = loadManagementProfileId(maxExternalId != null ? String(maxExternalId) : null);
  return (
    profile.profileId === profileId ||
    profile.profileId === loadManagementCreditProfileId(profileId)
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

// ---- The depot plan owns the TxProfile of a planned session ----
//
// A session the depot plan charges for a departure (route-aware charging)
// gets its TxProfile from the load management cycle, with the transaction's
// TxProfile id. A manual TxProfile for that transaction would replace the plan
// profile (K01.FR.05) or be refused next to it (K01.FR.39), so the generic
// SetChargingProfile commands refuse it with 400 CHARGING_PROFILE_LOAD_MANAGED
// (`routes/ocpp-commands.ts`).

/** The transaction a SetChargingProfile request names for a TxProfile (2.1 or 1.6), else null. */
export function txProfileTransactionId(payload: Record<string, unknown>): string | null {
  const raw = payload['chargingProfile'] ?? payload['csChargingProfiles'];
  if (raw == null || typeof raw !== 'object') return null;
  const profile = raw as Record<string, unknown>;
  if (profile['chargingProfilePurpose'] !== 'TxProfile') return null;
  const transactionId = profile['transactionId'];
  if (typeof transactionId === 'string' && transactionId !== '') return transactionId;
  if (typeof transactionId === 'number' && Number.isFinite(transactionId)) {
    return String(transactionId);
  }
  return null;
}

/** True when the station's active session with that transaction is in its site's depot plan. */
export async function isPlannedTransaction(
  stationIdentity: string,
  transactionId: string,
): Promise<boolean> {
  const rows = (await db.execute(sql`SELECT 1 AS planned
    FROM charging_sessions cs
    JOIN charging_stations st ON st.id = cs.station_id
    JOIN site_charging_plans p ON p.site_id = st.site_id
    WHERE st.station_id = ${stationIdentity}
      AND cs.transaction_id = ${transactionId}
      AND cs.status = 'active'
      AND jsonb_typeof(p.plan) = 'array'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(p.plan) e
        WHERE e->>'sessionId' = cs.id AND NOT COALESCE((e->>'left')::boolean, false)
      )
    LIMIT 1`)) as unknown as unknown[];
  return rows.length > 0;
}

/**
 * The connector of a 1.6 TxProfile sent without a transactionId: the station
 * applies it to the transaction running on that connector (1.6 section 5.16),
 * so it would replace the plan profile there too. Null for anything else.
 */
export function txProfileConnectorWithoutTransaction(
  payload: Record<string, unknown>,
): number | null {
  const raw = payload['csChargingProfiles'];
  if (raw == null || typeof raw !== 'object') return null;
  const profile = raw as Record<string, unknown>;
  if (profile['chargingProfilePurpose'] !== 'TxProfile') return null;
  if (profile['transactionId'] != null) return null;
  const connectorId = payload['connectorId'];
  return typeof connectorId === 'number' && Number.isInteger(connectorId) && connectorId > 0
    ? connectorId
    : null;
}

/** True when the active session on that connector (1.6: EVSE number) of the station is planned. */
export async function isPlannedConnectorSession(
  stationIdentity: string,
  connectorId: number,
): Promise<boolean> {
  const rows = (await db.execute(sql`SELECT 1 AS planned
    FROM charging_sessions cs
    JOIN charging_stations st ON st.id = cs.station_id
    JOIN evses e ON e.id = cs.evse_id
    JOIN site_charging_plans p ON p.site_id = st.site_id
    WHERE st.station_id = ${stationIdentity}
      AND e.evse_id = ${connectorId}
      AND cs.status = 'active'
      AND jsonb_typeof(p.plan) = 'array'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(p.plan) el
        WHERE el->>'sessionId' = cs.id AND NOT COALESCE((el->>'left')::boolean, false)
      )
    LIMIT 1`)) as unknown as unknown[];
  return rows.length > 0;
}

export function plannedConnectorMessage(connectorId: number): string {
  return `The session on connector ${String(connectorId)} follows the depot charging plan, which sends its TxProfile; a manual TxProfile would replace the plan`;
}

export function plannedSessionMessage(transactionId: string): string {
  return `Transaction ${transactionId} follows the depot charging plan, which sends its TxProfile; a manual TxProfile would replace the plan`;
}

// ---- A manual clear never removes the TxProfile of a planned session ----
//
// The depot plan stores the state of each TxProfile it sent and resends only on
// a change, so a manual ClearChargingProfile that removed one would leave the
// session without its plan profile until the next slot. The generic clear
// commands and the station clear route refuse such a clear with 400
// CHARGING_PROFILE_LOAD_MANAGED, as the SetChargingProfile guard does.

/**
 * The transaction of a planned session at the station whose plan TxProfile a
 * ClearChargingProfile (2.1 or 1.6 form) could remove, else null: the clear
 * names that profile's id, or no id and a TxProfile purpose (or none) for the
 * session's EVSE (1.6: connector) or for every EVSE. EVSE 0 (the station) holds
 * no TxProfile. A stack level in the criteria is not compared, so a TxProfile
 * clear at another stack level on that EVSE is refused too.
 */
export async function plannedClearConflict(
  stationIdentity: string,
  payload: Record<string, unknown>,
): Promise<string | null> {
  const criteria = chargingProfileClearCriteria(payload);
  if (criteria.chargingProfilePurpose != null && criteria.chargingProfilePurpose !== 'TxProfile') {
    return null;
  }
  if (criteria.evseId === 0) return null;
  const rows = await plannedSessionTransactions(stationIdentity);
  for (const row of rows) {
    if (
      criteria.chargingProfileId != null &&
      criteria.chargingProfileId !== chargingNeedsProfileId(stationIdentity, row.transaction_id)
    ) {
      continue;
    }
    if (
      criteria.chargingProfileId == null &&
      criteria.evseId != null &&
      row.evse_id !== criteria.evseId
    ) {
      continue;
    }
    return row.transaction_id;
  }
  return null;
}

/** The lowest TxProfile id `chargingNeedsProfileId` gives (the upper half of int32). */
export const PLAN_TX_PROFILE_ID_MIN = 0x40000000;

/**
 * The transaction of a planned session at the station whose plan TxProfile has
 * this profile id, else null. A profile with the same id replaces the plan
 * profile whatever its purpose (K01.FR.05, 1.6 section 3.13.2), so a manual
 * profile (generic command, station push, template push) with that id is
 * refused with 400 CHARGING_PROFILE_LOAD_MANAGED (security review OCPP-L1).
 * Reads the database only for an id in the plan's range.
 */
export async function plannedProfileIdConflict(
  stationIdentity: string,
  profileId: number | null,
): Promise<string | null> {
  if (profileId == null || profileId < PLAN_TX_PROFILE_ID_MIN) return null;
  for (const row of await plannedSessionTransactions(stationIdentity)) {
    if (chargingNeedsProfileId(stationIdentity, row.transaction_id) === profileId) {
      return row.transaction_id;
    }
  }
  return null;
}

export function plannedProfileIdMessage(profileId: number, transactionId: string): string {
  return `Charging profile id ${String(profileId)} is the TxProfile id of transaction ${transactionId}, which follows the depot charging plan; a manual profile with that id would replace the plan profile`;
}

/** Throws 400 CHARGING_PROFILE_LOAD_MANAGED when the id is a planned session's TxProfile id. */
export async function assertNotPlanProfileId(
  stationIdentity: string,
  profileId: number | null,
): Promise<void> {
  const transactionId = await plannedProfileIdConflict(stationIdentity, profileId);
  if (transactionId != null && profileId != null) {
    throw new AppError(
      plannedProfileIdMessage(profileId, transactionId),
      400,
      ERROR_CODES.CHARGING_PROFILE_LOAD_MANAGED,
    );
  }
}

/** The active sessions with a transaction at the station that its site's depot plan charges. */
async function plannedSessionTransactions(
  stationIdentity: string,
): Promise<Array<{ transaction_id: string; evse_id: number | null }>> {
  return (await db.execute(sql`SELECT cs.transaction_id, e.evse_id
    FROM charging_sessions cs
    JOIN charging_stations st ON st.id = cs.station_id
    LEFT JOIN evses e ON e.id = cs.evse_id
    JOIN site_charging_plans p ON p.site_id = st.site_id
    WHERE st.station_id = ${stationIdentity}
      AND cs.status = 'active'
      AND cs.transaction_id IS NOT NULL
      AND jsonb_typeof(p.plan) = 'array'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(p.plan) el
        WHERE el->>'sessionId' = cs.id AND NOT COALESCE((el->>'left')::boolean, false)
      )`)) as unknown as Array<{ transaction_id: string; evse_id: number | null }>;
}

export function plannedClearMessage(transactionId: string): string {
  return `Transaction ${transactionId} follows the depot charging plan, which sends its TxProfile; a manual clear would remove the plan profile`;
}
