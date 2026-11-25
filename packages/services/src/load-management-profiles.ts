// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { conductorFactor } from '@evtivity/lib';
import type { StationPowerInfo, ChargingRateUnit } from './load-management-model.js';

// The profile load management owns on each managed station. OCPP 2.1 K01.FR.22
// forbids a CSMS to send ChargingStationExternalConstraints (a station clears
// none of those either, K10), and OCPP 1.6 has no such purpose: the limit of
// the whole station is a ChargingStationMaxProfile on EVSE 0 (1.6
// ChargePointMaxProfile on connector 0). A fixed, high id so the profile
// replaces only itself (a profile with the same id is replaced, K01.FR.05) and
// stays above a station's MaxExternalConstraintsId (K01.FR.80). Stack level 1,
// above the stack level 0 default of the smart charging templates: within one
// purpose the highest stack level wins, and the breaker limit must win.
export const LOAD_MANAGEMENT_PROFILE_ID = 1_000_000_000;

/**
 * The load management profile id of a station: LOAD_MANAGEMENT_PROFILE_ID, or
 * one above the station's MaxExternalConstraintsId when that is not lower
 * (K01.FR.80), within the 32-bit id range.
 */
export function loadManagementProfileId(
  maxExternalConstraintsId: string | null | undefined,
): number {
  const max = Number(maxExternalConstraintsId);
  if (
    maxExternalConstraintsId == null ||
    !Number.isInteger(max) ||
    max < LOAD_MANAGEMENT_PROFILE_ID
  ) {
    return LOAD_MANAGEMENT_PROFILE_ID;
  }
  // One below the int32 maximum, so the credit profile id (one above) fits.
  return Math.min(max + 1, 2_147_483_646);
}

export const LOAD_MANAGEMENT_STACK_LEVEL = 1;

// The credit profile (security case 334): a limit that rests on a battery or
// solar reading (its credit, or a battery load the reading lowered) goes to
// the station as a second ChargingStationMaxProfile one stack level above the
// limit without readings, valid until the reading goes stale (validTo). Within
// one purpose the valid profile with the highest stack level overrules
// (2.1 and 2.0.1 K01.FR.17, 1.6 section 3.13.2) and a profile is valid only
// while the current time is before validTo (K01.FR.37, 1.6 ChargingProfile
// validTo), so a station that gets no new limit (the worker stopped) falls back
// to the stack level 1 limit by itself. Its own id (one above the station's
// load management id): two ChargingStationMaxProfiles on EVSE 0 at different
// stack levels with different ids (K01.FR.06), both above the station's
// MaxExternalConstraintsId (K01.FR.80) and below the TxProfile ids of the depot
// plan (`chargingNeedsProfileId`, from 2^30).
export const LOAD_MANAGEMENT_CREDIT_STACK_LEVEL = 2;

/**
 * True when a ClearChargingProfile with these criteria can remove the station
 * limit (`profileId`) or its credit profile (K10): by one of their ids, or
 * with no id by criteria a station max profile at stack level 1 or 2 on EVSE 0
 * meets (a 1.6 clear with no field clears every profile). Any other id, an
 * EVSE limit TxProfile id included, matches neither.
 */
export function clearRemovesLoadManagementProfile(
  criteria: {
    chargingProfileId: number | null;
    chargingProfilePurpose: string | null;
    stackLevel: number | null;
    evseId: number | null;
  },
  profileId: number,
): boolean {
  if (criteria.chargingProfileId != null) {
    return (
      criteria.chargingProfileId === profileId ||
      criteria.chargingProfileId === loadManagementCreditProfileId(profileId)
    );
  }
  return (
    (criteria.chargingProfilePurpose == null ||
      criteria.chargingProfilePurpose === 'ChargingStationMaxProfile' ||
      criteria.chargingProfilePurpose === 'ChargePointMaxProfile') &&
    (criteria.stackLevel == null ||
      criteria.stackLevel === LOAD_MANAGEMENT_STACK_LEVEL ||
      criteria.stackLevel === LOAD_MANAGEMENT_CREDIT_STACK_LEVEL) &&
    (criteria.evseId == null || criteria.evseId === 0)
  );
}

/** The credit profile id of a station whose load management profile id is `profileId`. */
export function loadManagementCreditProfileId(profileId: number): number {
  return profileId + 1;
}

/**
 * The EVSE numbers of the unit box defaults (`loadManagementDefaultProfileId`)
 * a ClearChargingProfile with these criteria can remove: by a default's id,
 * or with no id by criteria a TxDefaultProfile at stack level 1 on an EVSE
 * meets (`all`: every EVSE). An empty list: none.
 */
export function clearRemovesDefaultProfiles(
  criteria: {
    chargingProfileId: number | null;
    chargingProfilePurpose: string | null;
    stackLevel: number | null;
    evseId: number | null;
  },
  profileId: number,
): number[] | 'all' {
  if (criteria.chargingProfileId != null) {
    const evseNumber = criteria.chargingProfileId - profileId - 1;
    return evseNumber >= 1 ? [evseNumber] : [];
  }
  const matches =
    (criteria.chargingProfilePurpose == null ||
      criteria.chargingProfilePurpose === 'TxDefaultProfile') &&
    (criteria.stackLevel == null || criteria.stackLevel === LOAD_MANAGEMENT_STACK_LEVEL);
  if (!matches || criteria.evseId === 0) return [];
  return criteria.evseId == null ? 'all' : [criteria.evseId];
}

// A credit profile is sent again, with the end of the newer reading, once the
// one the station holds ends within this time: about two 10 second cycles, so
// readings that keep arriving keep the credit without a gap, and the station
// keeps no credit longer than the reading it rests on.
export const LOAD_MANAGEMENT_CREDIT_RESEND_MS = 25_000;

/** True when the station may take a credit profile (it reports a stack level of 2 or more, or none). */
export function takesCreditProfile(station: Pick<StationPowerInfo, 'maxStackLevel'>): boolean {
  return (
    station.maxStackLevel == null || station.maxStackLevel >= LOAD_MANAGEMENT_CREDIT_STACK_LEVEL
  );
}

/**
 * True for a profile that is a load management profile: a
 * ChargingStationMaxProfile (1.6 ChargePointMaxProfile) at the load management
 * stack level with an id from LOAD_MANAGEMENT_PROFILE_ID up. Other senders
 * cannot use such a profile on a managed station (the API refuses it), so a
 * reply to one is the reply to load management. Reads the 2.1 and 1.6 forms.
 */
/** The credit profile of load management (stack level 2, station max purpose). */
export function isLoadManagementCreditProfile(profile: unknown): boolean {
  if (profile == null || typeof profile !== 'object') return false;
  const p = profile as Record<string, unknown>;
  const id = p['id'] ?? p['chargingProfileId'];
  const purpose = p['chargingProfilePurpose'];
  return (
    typeof id === 'number' &&
    id > LOAD_MANAGEMENT_PROFILE_ID &&
    p['stackLevel'] === LOAD_MANAGEMENT_CREDIT_STACK_LEVEL &&
    (purpose === 'ChargingStationMaxProfile' || purpose === 'ChargePointMaxProfile')
  );
}

export function isLoadManagementProfile(profile: unknown): boolean {
  if (profile == null || typeof profile !== 'object') return false;
  const p = profile as Record<string, unknown>;
  const id = p['id'] ?? p['chargingProfileId'];
  const purpose = p['chargingProfilePurpose'];
  return (
    typeof id === 'number' &&
    id >= LOAD_MANAGEMENT_PROFILE_ID &&
    p['stackLevel'] === LOAD_MANAGEMENT_STACK_LEVEL &&
    (purpose === 'ChargingStationMaxProfile' || purpose === 'ChargePointMaxProfile')
  );
}

/** The rate unit of a load management profile's schedule (2.1 array or 1.6 object). */
export function profileRateUnit(profile: unknown): ChargingRateUnit | null {
  if (profile == null || typeof profile !== 'object') return null;
  const raw = (profile as Record<string, unknown>)['chargingSchedule'];
  const schedule = (Array.isArray(raw) ? (raw[0] as unknown) : raw) as
    | Record<string, unknown>
    | null
    | undefined;
  const unit = schedule?.['chargingRateUnit'];
  return unit === 'A' || unit === 'W' ? unit : null;
}

/** The first period's limit of a profile's schedule, as sent; null when it cannot be read. */
export function profileFirstLimit(profile: unknown): number | null {
  if (profile == null || typeof profile !== 'object') return null;
  const raw = (profile as Record<string, unknown>)['chargingSchedule'];
  const schedule = (Array.isArray(raw) ? (raw[0] as unknown) : raw) as
    | Record<string, unknown>
    | null
    | undefined;
  const periods = schedule?.['chargingSchedulePeriod'];
  const first = Array.isArray(periods) ? (periods[0] as Record<string, unknown> | undefined) : null;
  const limit = first?.['limit'];
  return typeof limit === 'number' && Number.isFinite(limit) && limit >= 0 ? limit : null;
}

/**
 * The limit in kW of an accepted load management profile: its first period's
 * limit, from A with the station's circuit (`rate`). Null when it cannot be
 * read.
 */
export function profileLimitKw(profile: unknown, rate: StationRate | undefined): number | null {
  const limit = profileFirstLimit(profile);
  if (limit == null) return null;
  const unit = profileRateUnit(profile);
  if (unit === 'W') return limit / 1000;
  if (unit === 'A' && rate != null) {
    return (limit * rate.voltageV * conductorFactor(rate.phases)) / 1000;
  }
  return null;
}

// Unchanged allocations are sent again after this interval, so a lost
// publish, a rejected profile or a station that lost its profiles converges.
export const LOAD_MANAGEMENT_REFRESH_MS = 5 * 60_000;

/** How a station's limit is expressed: in W, or in A per phase on its circuit. */
export interface StationRate {
  rateUnit: ChargingRateUnit;
  /** Phase to neutral voltage of the circuit's panel (single-phase: its voltage). */
  voltageV: number;
  /** Conductor phases of the circuit (1 to 3). */
  phases: number;
  /** Id of the station's load management profile. */
  profileId?: number;
}

/**
 * The limit for `allocatedWatts` in the station's unit: W as is, A as the
 * phase current on its circuit (W / (V x 1, sqrt(3) or 3)), rounded down to
 * 0.1 A so the station never exceeds the allocation.
 */
export function limitInUnit(allocatedWatts: number, rate: StationRate | undefined): number {
  if (rate == null || rate.rateUnit === 'W') return allocatedWatts;
  const amps = allocatedWatts / (rate.voltageV * conductorFactor(rate.phases));
  return Math.floor(amps * 10) / 10;
}

/**
 * The SetChargingProfile of a station limit. Without `validTo`: the load
 * management profile (stack level 1, no end). With it: the credit profile
 * (stack level 2, its own id, valid until `validTo`, security case 334).
 */
export function buildLoadManagementProfile(
  allocatedWatts: number,
  now: Date,
  rate?: StationRate,
  validTo?: Date,
): Record<string, unknown> {
  // Absolute needs a startSchedule (K01.FR.40). A minute in the past so a
  // station clock that runs a little behind applies the limit at once.
  const startSchedule = new Date(Math.floor(now.getTime() / 1000) * 1000 - 60_000);
  const profileId = rate?.profileId ?? LOAD_MANAGEMENT_PROFILE_ID;
  return {
    evseId: 0,
    chargingProfile: {
      id: validTo != null ? loadManagementCreditProfileId(profileId) : profileId,
      stackLevel:
        validTo != null ? LOAD_MANAGEMENT_CREDIT_STACK_LEVEL : LOAD_MANAGEMENT_STACK_LEVEL,
      chargingProfilePurpose: 'ChargingStationMaxProfile',
      chargingProfileKind: 'Absolute',
      ...(validTo != null ? { validTo: validTo.toISOString() } : {}),
      chargingSchedule: [
        {
          id: 1,
          startSchedule: startSchedule.toISOString(),
          chargingRateUnit: rate?.rateUnit ?? 'W',
          chargingSchedulePeriod: [
            {
              startPeriod: 0,
              limit: limitInUnit(allocatedWatts, rate),
            },
          ],
        },
      ],
    },
  };
}
