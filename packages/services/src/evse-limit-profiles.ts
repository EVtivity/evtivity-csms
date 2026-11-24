// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { chargingNeedsProfileId } from '@evtivity/lib/charging-profile-ids';
import type { EvseLimitResult } from './evse-limits.js';
import { LOAD_MANAGEMENT_STACK_LEVEL } from './load-management.service.js';
import type { ChargingRateUnit, StationPowerInfo } from './load-management.service.js';

const EPSILON_KW = 1e-9;

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
    const held = new Map(
      (previous.get(stationDbId) ?? []).map((e) => [e.transactionId, e.limitKw] as const),
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

/** A limit that raises the one it replaces goes after the cuts; a new limit is a cut. */
export function orderEvseLimitCommands(commands: readonly EvseLimitCommand[]): {
  cuts: EvseLimitCommand[];
  raises: EvseLimitCommand[];
} {
  const cuts: EvseLimitCommand[] = [];
  const raises: EvseLimitCommand[] = [];
  for (const command of commands) {
    if (command.previousKw != null && command.limit.limitKw > command.previousKw + EPSILON_KW) {
      raises.push(command);
    } else {
      cuts.push(command);
    }
  }
  return { cuts, raises };
}

/** A per-EVSE TxProfile the station may still hold whose transaction gets none this send. */
export interface EvseLimitRelease {
  stationId: string;
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
      releases.push({ stationId: station.stationId, transactionId: limit.transactionId });
    }
  }
  return releases;
}
