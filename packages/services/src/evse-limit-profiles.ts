// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  chargingNeedsProfileId,
  loadManagementDefaultProfileId,
} from '@evtivity/lib/charging-profile-ids';
import { parseLimitRecord, type LimitRecord } from '@evtivity/lib/load-limit-state';
import { evseDefaultMightKw, evseMightKw } from './load-limit-entries.js';
import type { EvseLimitResult } from './evse-limits.js';
import { LOAD_MANAGEMENT_STACK_LEVEL } from './load-management-profiles.js';
import type { ChargingRateUnit, StationPowerInfo } from './load-management-model.js';

/** One per-EVSE limit as stored with its station in `applied_allocations`. */
export interface AppliedEvseLimit {
  sessionId: string;
  transactionId: string;
  evseNumber: number;
  kind: 'ac' | 'dc';
  limitKw: number;
  /** A per phase for an AC limit; null for DC. */
  limitA: number | null;
  phases: number | null;
  rateUnit: ChargingRateUnit;
  /** The EVSE phase the single-phase car was sent to use (phaseToUse). */
  phaseToUse?: number;
  /** When that phase was first sent for the session, ms. */
  phaseToUseSinceMs?: number;
  /** The station refused or did not follow a phase choice: none is sent again for the session. */
  phaseToUseRefused?: boolean;
  /** What the station may hold for this TxProfile (absent: never sent). */
  limit?: LimitRecord;
}

/** One TxProfile of a send: the limit of one charging EVSE. */
export interface EvseLimitCommand {
  stationId: string;
  stationDbId: string;
  limit: EvseLimitResult;
  rateUnit: ChargingRateUnit;
  /** The kW limit this profile replaces at the station; absent: none known. */
  previousKw?: number;
}

/**
 * The unit of an EVSE limit: an AC limit in A unless the station reports W
 * only (then W with numberPhases, K01.FR.50), a DC limit in W.
 */
export function evseLimitRateUnit(
  station: Pick<StationPowerInfo, 'supportedRateUnits'>,
  kind: 'ac' | 'dc',
): ChargingRateUnit {
  if (kind === 'dc') return 'W';
  const supported = station.supportedRateUnits ?? [];
  return supported.length === 0 || supported.includes('A') ? 'A' : 'W';
}

/**
 * The SetChargingProfile of one charging EVSE's limit: a TxProfile for its
 * transaction (K01.FR.03, evseId > 0 per K01.FR.16), so it ends with the
 * transaction and an idle EVSE never keeps a 0 A limit.
 */
export function buildEvseLimitProfile(
  stationOcppId: string,
  limit: EvseLimitResult,
  rateUnit: ChargingRateUnit,
  now: Date,
): Record<string, unknown> {
  // Absolute needs a startSchedule (K01.FR.40), a minute back for a station clock behind.
  const startSchedule = new Date(Math.floor(now.getTime() / 1000) * 1000 - 60_000);
  const value =
    rateUnit === 'A'
      ? Math.floor((limit.limitA ?? 0) * 10 + 1e-6) / 10
      : Math.floor(limit.limitKw * 1000);
  return {
    evseId: limit.evseNumber,
    chargingProfile: {
      // The transaction's one TxProfile id (also the ISO 15118 and depot plan
      // profile), so a new limit replaces the old one (K01.FR.05).
      id: chargingNeedsProfileId(stationOcppId, limit.transactionId),
      stackLevel: LOAD_MANAGEMENT_STACK_LEVEL,
      chargingProfilePurpose: 'TxProfile',
      chargingProfileKind: 'Absolute',
      transactionId: limit.transactionId,
      chargingSchedule: [
        {
          id: 1,
          startSchedule: startSchedule.toISOString(),
          chargingRateUnit: rateUnit,
          chargingSchedulePeriod: [
            {
              startPeriod: 0,
              limit: Math.max(0, value),
              // AC only: a DC EVSE may refuse numberPhases (K01.FR.44).
              ...(limit.kind === 'ac' && limit.phases != null
                ? { numberPhases: limit.phases }
                : {}),
              // Only with numberPhases 1 to an EVSE that switches phases (K01.FR.19, K01.FR.20).
              ...(limit.kind === 'ac' && limit.phases === 1 && limit.phaseToUse != null
                ? { phaseToUse: limit.phaseToUse }
                : {}),
            },
          ],
        },
      ],
    },
  };
}

/** The stored form of a limit sent in `rateUnit`. */
export function appliedEvseLimit(
  limit: EvseLimitResult,
  rateUnit: ChargingRateUnit,
): AppliedEvseLimit {
  return {
    sessionId: limit.sessionId,
    transactionId: limit.transactionId,
    evseNumber: limit.evseNumber,
    kind: limit.kind,
    limitKw: limit.limitKw,
    limitA: limit.limitA,
    phases: limit.phases,
    rateUnit,
    ...(limit.phaseToUse != null ? { phaseToUse: limit.phaseToUse } : {}),
    ...(limit.phaseToUse != null && limit.phaseToUseSinceMs != null
      ? { phaseToUseSinceMs: limit.phaseToUseSinceMs }
      : {}),
    ...(limit.phaseToUseRefused === true ? { phaseToUseRefused: true } : {}),
  };
}

export function parseAppliedEvseLimits(value: unknown): AppliedEvseLimit[] {
  if (!Array.isArray(value)) return [];
  const result: AppliedEvseLimit[] = [];
  for (const item of value as unknown[]) {
    if (item == null || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (
      typeof e['sessionId'] !== 'string' ||
      typeof e['transactionId'] !== 'string' ||
      typeof e['evseNumber'] !== 'number' ||
      typeof e['limitKw'] !== 'number' ||
      !Number.isFinite(e['limitKw']) ||
      (e['kind'] !== 'ac' && e['kind'] !== 'dc') ||
      (e['rateUnit'] !== 'A' && e['rateUnit'] !== 'W')
    ) {
      continue;
    }
    result.push({
      sessionId: e['sessionId'],
      transactionId: e['transactionId'],
      evseNumber: e['evseNumber'],
      kind: e['kind'],
      limitKw: e['limitKw'],
      limitA: typeof e['limitA'] === 'number' && Number.isFinite(e['limitA']) ? e['limitA'] : null,
      phases: typeof e['phases'] === 'number' ? e['phases'] : null,
      rateUnit: e['rateUnit'],
      ...(typeof e['phaseToUse'] === 'number' && [1, 2, 3].includes(e['phaseToUse'])
        ? { phaseToUse: e['phaseToUse'] }
        : {}),
      ...(typeof e['phaseToUseSinceMs'] === 'number' && Number.isFinite(e['phaseToUseSinceMs'])
        ? { phaseToUseSinceMs: e['phaseToUseSinceMs'] }
        : {}),
      ...(e['phaseToUseRefused'] === true ? { phaseToUseRefused: true } : {}),
      ...(e['limit'] != null ? { limit: parseLimitRecord(e['limit']) } : {}),
    });
  }
  return result;
}

/**
 * The TxProfiles of a send: one per limit, against the kW the same
 * transaction was last sent (`previous`), except the sessions in `skip` (a
 * depot plan sends their TxProfile).
 */
export function evseLimitCommands(
  evseLimits: ReadonlyMap<string, readonly EvseLimitResult[]>,
  stations: ReadonlyMap<string, StationPowerInfo>,
  previous: ReadonlyMap<string, readonly AppliedEvseLimit[]>,
  skip: ReadonlySet<string> = new Set(),
): EvseLimitCommand[] {
  const commands: EvseLimitCommand[] = [];
  for (const [stationDbId, limits] of evseLimits) {
    const station = stations.get(stationDbId);
    if (station == null) continue;
    // What each TxProfile may hold now (none known: a new limit is a cut).
    const held = new Map(
      (previous.get(stationDbId) ?? []).map((e) => [e.transactionId, evseMightKw(e)] as const),
    );
    for (const limit of limits) {
      if (skip.has(limit.sessionId)) continue;
      const before = held.get(limit.transactionId);
      commands.push({
        stationId: station.stationId,
        stationDbId,
        limit,
        rateUnit: evseLimitRateUnit(station, limit.kind),
        ...(before != null ? { previousKw: before } : {}),
      });
    }
  }
  return commands;
}

/** A per-EVSE TxProfile the station may still hold whose transaction gets none this send. */
export interface EvseLimitRelease {
  stationId: string;
  /** The station's database id (left out by callers that build a release by hand). */
  stationDbId?: string;
  transactionId: string;
}

/**
 * The EVSE limits sent before whose sessions are still charging on the same
 * online station but get no EVSE limit now (the station went back to one
 * station limit): their TxProfile is cleared, so a stale limit does not hold
 * the session. Sessions in `skip` (a depot plan profile has the same id) and
 * ended sessions (the TxProfile ended with them) are left.
 */
export function evseLimitReleases(
  previous: ReadonlyMap<string, readonly AppliedEvseLimit[]>,
  commands: readonly EvseLimitCommand[],
  stations: ReadonlyMap<string, StationPowerInfo>,
  skip: ReadonlySet<string> = new Set(),
): EvseLimitRelease[] {
  const sent = new Set(commands.map((c) => `${c.stationDbId}:${c.limit.transactionId}`));
  const releases: EvseLimitRelease[] = [];
  for (const [stationDbId, limits] of previous) {
    const station = stations.get(stationDbId);
    if (station == null || !station.isOnline) continue;
    const active = new Set((station.sessions ?? []).map((s) => s.transactionId));
    for (const limit of limits) {
      if (skip.has(limit.sessionId) || !active.has(limit.transactionId)) continue;
      if (sent.has(`${stationDbId}:${limit.transactionId}`)) continue;
      releases.push({
        stationId: station.stationId,
        stationDbId,
        transactionId: limit.transactionId,
      });
    }
  }
  return releases;
}

/**
 * The TxDefaultProfile value of one EVSE of a unit box: what a transaction
 * that starts on the EVSE may draw until the next cycle sends its TxProfile.
 */
export interface EvseDefaultValue {
  evseNumber: number;
  unitId: string;
  kind: 'ac' | 'dc';
  /** A per phase for an AC box; null for DC. */
  limitA: number | null;
  /** AC: `limitA` x circuit voltage (one phase, what a W limit sends); DC: the kW. */
  limitKw: number;
  rateUnit: ChargingRateUnit;
}

/** One TxDefaultProfile as stored with its station in `applied_allocations`, keyed by EVSE number. */
export interface AppliedEvseDefault extends EvseDefaultValue {
  /** What the station may hold for this default (absent: never sent). */
  limit?: LimitRecord;
}

/** One TxDefaultProfile of a send. */
export interface EvseDefaultCommand {
  stationId: string;
  stationDbId: string;
  value: EvseDefaultValue;
  profileId: number;
  /** The kW limit this profile replaces at the station; absent: none known. */
  previousKw?: number;
}

/**
 * The SetChargingProfile of one EVSE's default: a TxDefaultProfile at the load
 * management stack level on that EVSE, so a transaction that starts there is
 * bounded until its TxProfile arrives, which overrules it.
 */
export function buildEvseDefaultProfile(
  profileId: number,
  value: EvseDefaultValue,
  now: Date,
): Record<string, unknown> {
  const startSchedule = new Date(Math.floor(now.getTime() / 1000) * 1000 - 60_000);
  const limit =
    value.rateUnit === 'A'
      ? Math.floor((value.limitA ?? 0) * 10 + 1e-6) / 10
      : Math.floor(value.limitKw * 1000);
  return {
    evseId: value.evseNumber,
    chargingProfile: {
      id: profileId,
      stackLevel: LOAD_MANAGEMENT_STACK_LEVEL,
      chargingProfilePurpose: 'TxDefaultProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: [
        {
          id: 1,
          startSchedule: startSchedule.toISOString(),
          chargingRateUnit: value.rateUnit,
          chargingSchedulePeriod: [{ startPeriod: 0, limit: Math.max(0, limit) }],
        },
      ],
    },
  };
}

export function parseAppliedEvseDefaults(value: unknown): AppliedEvseDefault[] {
  if (!Array.isArray(value)) return [];
  const result: AppliedEvseDefault[] = [];
  const seen = new Set<number>();
  for (const item of value as unknown[]) {
    if (item == null || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const evseNumber = e['evseNumber'];
    if (
      typeof evseNumber !== 'number' ||
      !Number.isInteger(evseNumber) ||
      evseNumber < 1 ||
      seen.has(evseNumber) ||
      typeof e['unitId'] !== 'string' ||
      typeof e['limitKw'] !== 'number' ||
      !Number.isFinite(e['limitKw']) ||
      (e['kind'] !== 'ac' && e['kind'] !== 'dc') ||
      (e['rateUnit'] !== 'A' && e['rateUnit'] !== 'W')
    ) {
      continue;
    }
    seen.add(evseNumber);
    result.push({
      evseNumber,
      unitId: e['unitId'],
      kind: e['kind'],
      limitA: typeof e['limitA'] === 'number' && Number.isFinite(e['limitA']) ? e['limitA'] : null,
      limitKw: e['limitKw'],
      rateUnit: e['rateUnit'],
      ...(e['limit'] != null ? { limit: parseLimitRecord(e['limit']) } : {}),
    });
  }
  return result;
}

/**
 * The TxDefaultProfiles of a send, each against what the EVSE's default may
 * hold now (none known: a new default is a cut). A default whose id would
 * leave the int32 range is not sent (its EVSE counts at its rating).
 */
export function evseDefaultCommands(
  values: ReadonlyMap<string, readonly EvseDefaultValue[]>,
  stations: ReadonlyMap<string, StationPowerInfo>,
  previous: ReadonlyMap<string, readonly AppliedEvseDefault[]>,
): EvseDefaultCommand[] {
  const commands: EvseDefaultCommand[] = [];
  for (const [stationDbId, list] of values) {
    const station = stations.get(stationDbId);
    if (station == null) continue;
    const held = new Map(
      (previous.get(stationDbId) ?? []).map((d) => [d.evseNumber, evseDefaultMightKw(d)] as const),
    );
    for (const value of list) {
      const profileId = loadManagementDefaultProfileId(station.profileId, value.evseNumber);
      if (profileId == null) continue;
      const before = held.get(value.evseNumber);
      commands.push({
        stationId: station.stationId,
        stationDbId,
        value,
        profileId,
        ...(before != null ? { previousKw: before } : {}),
      });
    }
  }
  return commands;
}

/** A default the station may still hold that it no longer needs: cleared by its id. */
export interface EvseDefaultRelease {
  stationId: string;
  stationDbId: string;
  evseNumber: number;
  chargingProfileId: number;
}

/**
 * The defaults stored before that an online station of `stations` no longer
 * gets (it left per-EVSE mode, a budget or unit changed). A station not in
 * `stations` (reserved, or no longer managed) is left: a reserved one keeps
 * its defaults, an unmanaged one is cleared with its limits.
 */
export function evseDefaultReleases(
  previous: ReadonlyMap<string, readonly AppliedEvseDefault[]>,
  commands: readonly EvseDefaultCommand[],
  stations: ReadonlyMap<string, StationPowerInfo>,
): EvseDefaultRelease[] {
  const sent = new Set(commands.map((c) => `${c.stationDbId}:${String(c.value.evseNumber)}`));
  const releases: EvseDefaultRelease[] = [];
  for (const [stationDbId, defaults] of previous) {
    const station = stations.get(stationDbId);
    if (station == null || !station.isOnline) continue;
    for (const d of defaults) {
      if (sent.has(`${stationDbId}:${String(d.evseNumber)}`)) continue;
      const chargingProfileId = loadManagementDefaultProfileId(station.profileId, d.evseNumber);
      if (chargingProfileId == null) continue;
      releases.push({
        stationId: station.stationId,
        stationDbId,
        evseNumber: d.evseNumber,
        chargingProfileId,
      });
    }
  }
  return releases;
}
