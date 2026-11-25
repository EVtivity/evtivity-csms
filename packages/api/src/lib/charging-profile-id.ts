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
import { AppError, chargingProfileClearCriteria, evseChargingKind } from '@evtivity/lib';
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
  clearRemovesDefaultProfiles,
  clearRemovesLoadManagementProfile,
  loadManagementProfileId,
  loadManagementCreditProfileId,
} from '@evtivity/services/load-management-profiles';
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

/**
 * Purposes that sit above the station limit's slot (OCPP 2.1 K08.FR.04, K21,
 * K27): PriorityCharging overrules TxProfile and TxDefault, LocalGeneration
 * adds its power on top of every limit. On a managed station only load
 * management may set either.
 */
const ABOVE_LIMIT_PURPOSES = new Set(['PriorityCharging', 'LocalGeneration']);

function isAboveLimitPurpose(purpose: string | null): boolean {
  return purpose != null && ABOVE_LIMIT_PURPOSES.has(purpose);
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
    isAboveLimitPurpose(profile.purpose) ||
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
  if (isStationMaxAtLoadManagementLevel(profile) || isAboveLimitPurpose(profile.purpose)) {
    return true;
  }
  if (profile.profileId == null) return false;
  // The load management profile and its credit profile (security case 334).
  const profileId = loadManagementProfileId(maxExternalId != null ? String(maxExternalId) : null);
  return (
    profile.profileId === profileId ||
    profile.profileId === loadManagementCreditProfileId(profileId)
  );
}

export function loadManagedMessage(profile: ProfileIdentity): string {
  return `Charging profile ${String(profile.profileId ?? '')} would override the load management limit of the station. On a station load management manages, a ChargingStationMaxProfile needs a stack level below ${String(LOAD_MANAGEMENT_STACK_LEVEL)}, PriorityCharging and LocalGeneration profiles are not allowed, and no profile may use the load management profile id`;
}

/** The criteria of a ClearChargingProfile the load management rule reads. */
export type ClearIdentity = ReturnType<typeof chargingProfileClearCriteria>;

/**
 * True when a ClearChargingProfile could remove the station limit or the
 * credit profile of a managed station whose MaxExternalConstraintsId is
 * `maxExternalId` (K10: by id, or by criteria that station max profile at
 * stack level 1 or 2 on EVSE 0 meets; a 1.6 clear with no field clears every
 * profile). Removing it leaves the station without its limit until the next
 * send, so only load management clears it.
 */
export function clearRemovesLoadManagement(
  criteria: ClearIdentity,
  maxExternalId: number | null | undefined,
): boolean {
  return clearRemovesLoadManagementProfile(
    criteria,
    loadManagementProfileId(maxExternalId != null ? String(maxExternalId) : null),
  );
}

/**
 * True when the ClearChargingProfile (2.1 or 1.6 form) could remove the load
 * management limit of the station and load management manages it. Reads the
 * database only for a clear that could.
 */
export async function loadManagedClearConflict(
  stationIdentity: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const criteria = chargingProfileClearCriteria(payload);
  // Decided first without the station's id offset: any id of the load
  // management range, or criteria a station max profile meets.
  if (
    criteria.chargingProfileId != null &&
    criteria.chargingProfileId < LOAD_MANAGEMENT_PROFILE_ID
  ) {
    return false;
  }
  if (criteria.chargingProfileId == null && !clearRemovesLoadManagement(criteria, null))
    return false;
  if (!(await isLoadManagedStationIdentity(stationIdentity))) return false;
  if (criteria.chargingProfileId == null) return true;
  const maxExternalId = await maxExternalConstraintsIdByIdentity(stationIdentity);
  return clearRemovesLoadManagement(criteria, maxExternalId);
}

// ---- Load management owns the unit box defaults ----
//
// On a managed station with unit budgets, load management sends a
// TxDefaultProfile at its stack level on every EVSE of a box with a budget
// (`loadManagementDefaultProfileId`): a transaction that starts there is held
// to the box until its TxProfile arrives. Another TxDefaultProfile at that
// stack level or above on EVSE 0 or a box EVSE, a profile with a default id,
// or a clear that can remove a default would lift that bound.

/** The EVSE numbers of the station's unit boxes with a budget, while load management manages it. */
async function managedUnitBoxEvses(stationIdentity: string): Promise<Set<number>> {
  // Managed as `loadManagedStationIds` decides: on a circuit of a panel of its
  // own site, with load management on at that site.
  const rows = (await db.execute(sql`SELECT e.evse_id
    FROM evses e
    JOIN charging_stations st ON st.id = e.station_id
    JOIN station_unit_load_budgets b ON b.unit_id = e.unit_id AND b.station_id = e.station_id
    JOIN circuits c ON c.id = st.circuit_id
    JOIN panels p ON p.id = c.panel_id AND p.site_id = st.site_id
    JOIN site_load_management slm ON slm.site_id = st.site_id AND slm.is_enabled = true
    WHERE st.station_id = ${stationIdentity}`)) as unknown as Array<{ evse_id: number | string }>;
  return new Set(rows.map((r) => Number(r.evse_id)));
}

/** The EVSE whose unit box default a SetChargingProfile would lift or replace, else null. */
export async function unitBoxDefaultConflict(
  stationIdentity: string,
  payload: Record<string, unknown>,
): Promise<number | null> {
  const profile = profileIdentityFromRequest(payload);
  const rawEvse = payload['evseId'] ?? payload['connectorId'];
  const evse = typeof rawEvse === 'number' && Number.isInteger(rawEvse) ? rawEvse : null;
  const asDefault =
    profile.purpose === 'TxDefaultProfile' &&
    profile.stackLevel != null &&
    profile.stackLevel >= LOAD_MANAGEMENT_STACK_LEVEL &&
    evse != null;
  const byId = profile.profileId != null && profile.profileId > LOAD_MANAGEMENT_PROFILE_ID;
  if (!asDefault && !byId) return null;
  const boxEvses = await managedUnitBoxEvses(stationIdentity);
  if (boxEvses.size === 0) return null;
  if (asDefault && (evse === 0 || boxEvses.has(evse))) return evse;
  if (byId) {
    const profileId = loadManagementProfileId(
      (await maxExternalConstraintsIdByIdentity(stationIdentity))?.toString() ?? null,
    );
    const evseNumber = (profile.profileId ?? 0) - profileId - 1;
    if (boxEvses.has(evseNumber)) return evseNumber;
  }
  return null;
}

/** True when a ClearChargingProfile (2.1 or 1.6 form) could remove a unit box default. */
export async function unitBoxDefaultClearConflict(
  stationIdentity: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const criteria = chargingProfileClearCriteria(payload);
  if (
    criteria.chargingProfileId != null &&
    criteria.chargingProfileId <= LOAD_MANAGEMENT_PROFILE_ID
  ) {
    return false;
  }
  if (
    criteria.chargingProfileId == null &&
    clearRemovesDefaultProfiles(criteria, LOAD_MANAGEMENT_PROFILE_ID).length === 0
  ) {
    return false;
  }
  const boxEvses = await managedUnitBoxEvses(stationIdentity);
  if (boxEvses.size === 0) return false;
  const profileId = loadManagementProfileId(
    (await maxExternalConstraintsIdByIdentity(stationIdentity))?.toString() ?? null,
  );
  const removed = clearRemovesDefaultProfiles(criteria, profileId);
  return removed === 'all' || removed.some((n) => boxEvses.has(n));
}

export function unitBoxDefaultMessage(evseNumber: number): string {
  return `The profile would lift or replace the load management default limit of EVSE ${String(evseNumber)}, which holds its unit box to its budget`;
}

export function unitBoxDefaultClearMessage(): string {
  return 'The clear could remove a load management default limit that holds a unit box to its budget; only load management clears it';
}

export function loadManagedClearMessage(): string {
  return 'The clear could remove the load management limit of the station; on a station load management manages, only load management clears it';
}

/**
 * The transaction of an active session the station's load management limits
 * per EVSE whose TxProfile id is `profileId`, else null. A profile with that
 * id replaces the EVSE limit whatever its purpose (K01.FR.05).
 */
export async function evseManagedProfileIdConflict(
  stationIdentity: string,
  profileId: number | null,
): Promise<string | null> {
  if (profileId == null || profileId < PLAN_TX_PROFILE_ID_MIN) return null;
  const rows = (await db.execute(sql`SELECT cs.transaction_id
    FROM charging_sessions cs
    JOIN charging_stations st ON st.id = cs.station_id
    WHERE st.station_id = ${stationIdentity}
      AND cs.status = 'active'
      AND cs.transaction_id IS NOT NULL`)) as unknown as Array<{ transaction_id: string }>;
  for (const row of rows) {
    if (chargingNeedsProfileId(stationIdentity, row.transaction_id) !== profileId) continue;
    if (await isEvseManagedTransaction(stationIdentity, row.transaction_id)) {
      return row.transaction_id;
    }
  }
  return null;
}

export function usePriorityChargingMessage(): string {
  return 'Priority charging would lift the load management limit of a station load management manages';
}

export function evseManagedProfileIdMessage(profileId: number, transactionId: string): string {
  return `Charging profile id ${String(profileId)} is the TxProfile id of transaction ${transactionId}, which load management limits per EVSE; a manual profile with that id would replace that limit`;
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
  // The 1.6 form, or the 2.1 form the OCPP server translates for a 1.6 station
  // (its evseId becomes the connectorId).
  const legacy = payload['csChargingProfiles'];
  const raw = legacy ?? payload['chargingProfile'];
  if (raw == null || typeof raw !== 'object') return null;
  const profile = raw as Record<string, unknown>;
  if (profile['chargingProfilePurpose'] !== 'TxProfile') return null;
  if (profile['transactionId'] != null) return null;
  const connectorId = legacy != null ? payload['connectorId'] : payload['evseId'];
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

// ---- Load management owns the TxProfile of a session it limits per EVSE ----
//
// On a managed station whose effective balancing mode is per EVSE (the
// operator chose it, or an AC session has a tariff current limit, and the
// station never refused an EVSE limit), the load management cycle sends each
// charging EVSE a TxProfile with the transaction's TxProfile id. A manual
// TxProfile for such a session would replace it and lift the tariff limit, so
// the generic SetChargingProfile commands refuse it with 400
// CHARGING_PROFILE_LOAD_MANAGED.

interface EvseManagedStationRow {
  id: string;
  mode: string;
}

interface CappedSessionRow {
  charging_kind: string | null;
  connector_type: string | null;
  max_power_kw: string | null;
}

async function evseManagedStation(
  stationIdentity: string,
  session: { transactionId: string } | { connectorId: number },
): Promise<boolean> {
  const sessionMatch =
    'transactionId' in session
      ? sql`cs.transaction_id = ${session.transactionId}`
      : sql`e.evse_id = ${session.connectorId}`;
  const stations = (await db.execute(sql`SELECT st.id, st.load_balancing_mode AS mode
    FROM charging_stations st
    JOIN circuits c ON c.id = st.circuit_id
    JOIN panels p ON p.id = c.panel_id AND p.site_id = st.site_id
    JOIN site_load_management slm ON slm.site_id = st.site_id AND slm.is_enabled = true
    WHERE st.station_id = ${stationIdentity}
      AND st.evse_limits_refused_at IS NULL
      AND EXISTS (
        SELECT 1 FROM charging_sessions cs
        LEFT JOIN evses e ON e.id = cs.evse_id
        WHERE cs.station_id = st.id AND cs.status = 'active' AND ${sessionMatch}
      )
    LIMIT 1`)) as unknown as EvseManagedStationRow[];
  const station = stations[0];
  if (station == null) return false;
  if (station.mode === 'evse') return true;
  // An AC session with a tariff current limit in force (the open segment's,
  // else the session's) makes the station per EVSE, as the cycle decides it.
  const capped = (await db.execute(sql`SELECT cs.id AS session_id, cs.charging_kind,
      con.connector_type, con.max_power_kw
    FROM charging_sessions cs
    LEFT JOIN session_tariff_segments seg ON seg.session_id = cs.id AND seg.ended_at IS NULL
    LEFT JOIN connectors con ON con.evse_id = cs.evse_id
    WHERE cs.station_id = ${station.id}
      AND cs.status = 'active'
      AND (CASE WHEN seg.id IS NOT NULL THEN seg.max_current_a ELSE cs.tariff_max_current_a END)
        IS NOT NULL`)) as unknown as Array<CappedSessionRow & { session_id: string }>;
  const bySession = new Map<string, CappedSessionRow[]>();
  for (const row of capped) {
    const list = bySession.get(row.session_id) ?? [];
    list.push(row);
    bySession.set(row.session_id, list);
  }
  for (const rows of bySession.values()) {
    const stored = rows[0]?.charging_kind;
    const kind =
      stored === 'ac' || stored === 'dc'
        ? stored
        : evseChargingKind(
              rows.map((r) => ({ connectorType: r.connector_type, maxPowerKw: r.max_power_kw })),
            ) === 'dc'
          ? 'dc'
          : 'ac';
    if (kind === 'ac') return true;
  }
  return false;
}

/** True when load management limits the station's active session with that transaction per EVSE. */
export async function isEvseManagedTransaction(
  stationIdentity: string,
  transactionId: string,
): Promise<boolean> {
  return evseManagedStation(stationIdentity, { transactionId });
}

/** True when load management limits the active session on that connector (1.6: EVSE number) per EVSE. */
export async function isEvseManagedConnectorSession(
  stationIdentity: string,
  connectorId: number,
): Promise<boolean> {
  return evseManagedStation(stationIdentity, { connectorId });
}

export function evseManagedSessionMessage(transactionId: string): string {
  return `Load management limits transaction ${transactionId} per EVSE (its tariff current limit or the station's balancing mode); a manual TxProfile would replace that limit`;
}

export function evseManagedConnectorMessage(connectorId: number): string {
  return `Load management limits the session on connector ${String(connectorId)} per EVSE (its tariff current limit or the station's balancing mode); a manual TxProfile would replace that limit`;
}

/**
 * The transaction of an active session the station's load management limits
 * per EVSE whose EVSE limit TxProfile a ClearChargingProfile (2.1 or 1.6 form)
 * could remove, else null. Matched like `plannedClearConflict`: the clear
 * names that profile's id, or no id and a TxProfile purpose (or none) for the
 * session's EVSE (1.6: connector) or for every EVSE. Removing it would lift
 * the EVSE limit, and with it the tariff limit, until the next send.
 */
export async function evseManagedClearConflict(
  stationIdentity: string,
  payload: Record<string, unknown>,
): Promise<string | null> {
  const criteria = chargingProfileClearCriteria(payload);
  if (criteria.chargingProfilePurpose != null && criteria.chargingProfilePurpose !== 'TxProfile') {
    return null;
  }
  if (criteria.evseId === 0) return null;
  const rows = (await db.execute(sql`SELECT cs.transaction_id, e.evse_id
    FROM charging_sessions cs
    JOIN charging_stations st ON st.id = cs.station_id
    LEFT JOIN evses e ON e.id = cs.evse_id
    WHERE st.station_id = ${stationIdentity}
      AND cs.status = 'active'
      AND cs.transaction_id IS NOT NULL`)) as unknown as Array<{
    transaction_id: string;
    evse_id: number | null;
  }>;
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
    if (await isEvseManagedTransaction(stationIdentity, row.transaction_id)) {
      return row.transaction_id;
    }
  }
  return null;
}

export function evseManagedClearMessage(transactionId: string): string {
  return `Load management limits transaction ${transactionId} per EVSE (its tariff current limit or the station's balancing mode); a manual clear would remove that limit`;
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
