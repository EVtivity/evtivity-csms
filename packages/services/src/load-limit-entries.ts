// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  creditTransition,
  limitMayBeWatts,
  limitMightKw,
  limitTransition,
  parseLimitRecord,
  profiledLimit,
  UNKNOWN_LIMIT,
  type LimitEvent,
  type LimitRecord,
} from '@evtivity/lib/load-limit-state';
import {
  ENERGY_ASSET_FUTURE_SKEW_MS,
  ENERGY_ASSET_READING_TTL_RANGE,
} from '@evtivity/lib/energy-supply';
import {
  parseAppliedEvseDefaults,
  parseAppliedEvseLimits,
  type AppliedEvseDefault,
  type AppliedEvseLimit,
} from './evse-limit-profiles.js';
import type { ChargingRateUnit, PhaseLoad, StationPowerInfo } from './load-management-model.js';

// The load management state of each station as stored in
// `site_load_management.applied_allocations`, and the one rule that reads it
// (the safety spec of the v0.1.53 plan). Only this module, the transitions of
// `@evtivity/lib/load-limit-state` and the database reply writers read or
// write the limit records; everything else asks `mightEnforceKw`.

const EPSILON_KW = 1e-6;

/**
 * The credit profile (stack level 2) the station may hold until `until`, with
 * its own limit record: what it may enforce above the stack level 1 limit.
 */
export interface AppliedCredit {
  limit: LimitRecord;
  until: string;
}

/** The record of a station that holds no credit profile: it adds nothing. */
export const NO_CREDIT_LIMIT: LimitRecord = profiledLimit(0);

/** A credit profile the station may hold that nothing records: unlimited until a send replaces it. */
export const UNKNOWN_CREDIT: AppliedCredit = {
  limit: UNKNOWN_LIMIT,
  until: '9999-12-31T23:59:59.000Z',
};

/**
 * How long the profile that replaces an unknown credit profile lasts: longer
 * than any credit profile the CSMS sends (a reading's measurement time, at most
 * 30 s ahead, plus its lifetime, at most 600 s), so the station counts the
 * replacement, never the old profile, once it accepts it.
 */
export const UNKNOWN_CREDIT_REPLACEMENT_MS =
  ENERGY_ASSET_READING_TTL_RANGE.max * 1000 + ENERGY_ASSET_FUTURE_SKEW_MS + 30_000;

/**
 * How long a credit profile may still hold past its end at the station: a
 * station clock can run behind the CSMS clock (the limits start a minute back
 * for the same reason, K01.FR.40).
 */
export const CREDIT_CLOCK_MARGIN_MS = 60_000;

/** True while a credit profile ending at `until` may still hold at the station. */
export function creditMayHold(until: string, nowMs: number): boolean {
  return Date.parse(until) + CREDIT_CLOCK_MARGIN_MS > nowMs;
}

/** True when nothing bounds what a credit profile may hold (unknown, or a send in flight from unknown). */
export function creditBoundUnknown(credit: AppliedCredit): boolean {
  return limitMightKw(credit.limit) == null;
}

/**
 * The end of the replacement sent for a credit profile of no known bound, or
 * null when none is sent (a known bound, or a replacement whose end is within
 * `minLeftMs`). A first replacement lasts `UNKNOWN_CREDIT_REPLACEMENT_MS`,
 * longer than any credit profile sent before; a resend keeps that end, so a
 * refused replacement still ends (review M2).
 */
export function creditReplacementEnd(
  credit: AppliedCredit,
  nowMs: number,
  minLeftMs: number,
): Date | null {
  if (!creditBoundUnknown(credit)) return null;
  if (credit.limit.state === 'unknown') return new Date(nowMs + UNKNOWN_CREDIT_REPLACEMENT_MS);
  const endMs = Date.parse(credit.until);
  return endMs - nowMs > minLeftMs ? new Date(endMs) : null;
}

/** One station's entry in `site_load_management.applied_allocations`. */
export interface AppliedAllocation {
  stationId: string;
  stationDbId: string;
  /** The allocation of the last cycle, for change detection and the views only. */
  allocatedKw: number;
  /** The stack level 1 part of a credit allocation (no safety input). */
  allocatedBaseKw?: number;
  /** The allocation counted the station at a reservation (a fixed load). */
  reserved?: boolean;
  /** Units the station refused for its load management profile. */
  rejectedUnits?: ChargingRateUnit[];
  /** Units the station accepted a load management profile in; A keeps it on A limits. */
  acceptedUnits?: ChargingRateUnit[];
  /** The station limit at stack level 1. */
  limit: LimitRecord;
  credit?: AppliedCredit;
  /** The per-EVSE limits (TxProfiles), each with its own record. */
  evses?: AppliedEvseLimit[];
  /** The TxDefaultProfiles of its unit box EVSEs, one per EVSE number, each with its own record. */
  evseDefaults?: AppliedEvseDefault[];
  /** The station's share of the limit per phase when split per phase. */
  phaseWeights?: PhaseLoad;
}

export function parseAppliedAllocations(value: unknown): AppliedAllocation[] | null {
  if (!Array.isArray(value)) return null;
  const result: AppliedAllocation[] = [];
  for (const item of value as unknown[]) {
    if (item == null || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (
      typeof row['stationId'] !== 'string' ||
      typeof row['stationDbId'] !== 'string' ||
      typeof row['allocatedKw'] !== 'number' ||
      !Number.isFinite(row['allocatedKw'])
    ) {
      continue;
    }
    const unitsOf = (raw: unknown): ChargingRateUnit[] =>
      Array.isArray(raw) ? (['A', 'W'] as const).filter((u) => (raw as unknown[]).includes(u)) : [];
    const rejectedUnits = unitsOf(row['rejectedUnits']);
    const acceptedUnits = unitsOf(row['acceptedUnits']);
    const evses = parseAppliedEvseLimits(row['evses']);
    const evseDefaults = parseAppliedEvseDefaults(row['evseDefaults']);
    const credit = parseCredit(row['credit']);
    result.push({
      stationId: row['stationId'],
      stationDbId: row['stationDbId'],
      allocatedKw: row['allocatedKw'],
      ...(typeof row['allocatedBaseKw'] === 'number' && Number.isFinite(row['allocatedBaseKw'])
        ? { allocatedBaseKw: row['allocatedBaseKw'] }
        : {}),
      ...(row['reserved'] === true ? { reserved: true } : {}),
      ...(rejectedUnits.length > 0 ? { rejectedUnits } : {}),
      ...(acceptedUnits.length > 0 ? { acceptedUnits } : {}),
      // An entry without a record (written by an earlier release) is unknown.
      limit: parseLimitRecord(row['limit']),
      ...(credit != null ? { credit } : {}),
      ...(evses.length > 0 ? { evses } : {}),
      ...(evseDefaults.length > 0 ? { evseDefaults } : {}),
      ...parsePhaseWeights(row['phaseWeights']),
    });
  }
  return result;
}

function parseCredit(value: unknown): AppliedCredit | null {
  if (value == null || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  const until = c['until'];
  if (typeof until !== 'string' || !Number.isFinite(Date.parse(until))) return null;
  // A record that does not parse is unknown: the station may be unlimited.
  return { limit: parseLimitRecord(c['limit']), until };
}

function parsePhaseWeights(value: unknown): { phaseWeights?: PhaseLoad } {
  if (value == null || typeof value !== 'object') return {};
  const w = value as Record<string, unknown>;
  const read = (key: string): number | null => {
    const n = w[key];
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
  };
  const L1 = read('L1');
  const L2 = read('L2');
  const L3 = read('L3');
  return L1 != null && L2 != null && L3 != null ? { phaseWeights: { L1, L2, L3 } } : {};
}

/**
 * What a station without an entry holds by its stored accepted profiles: the
 * stack level 1 limit (profiled) and a credit profile that may still hold, as
 * the records a first entry starts from, so the normal credit path replaces
 * or ends that credit profile.
 */
export interface StoredLimit {
  limit: LimitRecord;
  credit?: AppliedCredit;
}

export interface MightOptions {
  nowMs: number;
  /** The stored accepted profiles, used only for a station without an entry. */
  storedLimit?: StoredLimit | null;
}

/** The record of a station: its entry's, else its stored profile's, else unknown. */
export function stationLimitRecord(
  entry: AppliedAllocation | undefined,
  storedLimit?: StoredLimit | null,
): LimitRecord {
  if (entry != null) return entry.limit;
  return storedLimit?.limit ?? UNKNOWN_LIMIT;
}

/**
 * The credit profile record of a station: its entry's, else its stored credit
 * profile's. A station without an entry whose stack level 1 limit is unknown
 * (no record, no stored profile) may still hold one, so its credit is unknown
 * too until a send replaces it.
 */
export function stationCredit(
  entry: AppliedAllocation | undefined,
  storedLimit?: StoredLimit | null,
): AppliedCredit | undefined {
  const credit = entry != null ? entry.credit : (storedLimit?.credit ?? undefined);
  if (credit != null) return credit;
  // An entry without a credit records that none may hold (a cycle drops a
  // credit only once it can no longer hold), also after a boot.
  if (entry != null) return undefined;
  return stationLimitRecord(entry, storedLimit).state === 'unknown' ? UNKNOWN_CREDIT : undefined;
}

/** The highest stack level 1 limit the station might enforce; null: unlimited. */
export function baseMightKw(
  entry: AppliedAllocation | undefined,
  storedLimit?: StoredLimit | null,
): number | null {
  return limitMightKw(stationLimitRecord(entry, storedLimit));
}

/**
 * The highest limit the station might enforce, in kW; null when it may be
 * unlimited. The one input of every safety decision about the station:
 * ordering, reservations, start allowances, the claim, the views and the depot
 * interface. A credit profile that may still hold counts above the base.
 */
export function mightEnforceKw(
  entry: AppliedAllocation | undefined,
  options: MightOptions,
): number | null {
  const base = baseMightKw(entry, options.storedLimit);
  const credit = stationCredit(entry, options.storedLimit);
  if (base == null || credit == null || !creditMayHold(credit.until, options.nowMs)) return base;
  const creditKw = limitMightKw(credit.limit);
  return creditKw == null ? null : Math.max(base, creditKw);
}

/**
 * True while what `mightEnforceKw` counts may be a W limit (`limitMayBeWatts`
 * of the base record or of a credit profile that may still hold): a W limit
 * bounds the total only, so it counts in full on every phase the station may
 * use, whatever unit the next limit goes out in.
 */
export function mightEnforceInWatts(
  entry: AppliedAllocation | undefined,
  options: MightOptions,
): boolean {
  if (limitMayBeWatts(stationLimitRecord(entry, options.storedLimit))) return true;
  const credit = stationCredit(entry, options.storedLimit);
  return (
    credit != null && creditMayHold(credit.until, options.nowMs) && limitMayBeWatts(credit.limit)
  );
}

/** The highest limit an EVSE's TxProfile might hold; null: none known (the station limit holds). */
export function evseMightKw(evse: AppliedEvseLimit): number | null {
  return evse.limit == null ? null : limitMightKw(evse.limit);
}

/** The highest limit an EVSE's TxDefaultProfile might hold; null: none known (never sent, unknown, refused). */
export function evseDefaultMightKw(evseDefault: AppliedEvseDefault): number | null {
  return evseDefault.limit == null ? null : limitMightKw(evseDefault.limit);
}

/**
 * The most the station can draw: its rated maximum, else (no rating, common
 * on 1.6) the capacity of its circuit, the most its path lets it draw.
 */
export function stationMaximumKw(
  station: Pick<StationPowerInfo, 'maxPowerKw' | 'circuitCapacityKw'>,
): number {
  if (station.maxPowerKw > 0) return station.maxPowerKw;
  return Math.max(station.circuitCapacityKw ?? 0, 0);
}

/** What the station may draw: the limit it might enforce, else its maximum. */
export function drawBoundKw(
  station: Pick<StationPowerInfo, 'maxPowerKw' | 'currentDrawKw' | 'circuitCapacityKw'>,
  entry: AppliedAllocation | undefined,
  options: MightOptions,
): number {
  const might = mightEnforceKw(entry, options);
  return Math.max(might ?? stationMaximumKw(station), station.currentDrawKw, 0);
}

/** True when the record is not in force as sent: lost, refused, unknown, or in flight with no known bound. */
function recordNotInForce(record: LimitRecord): boolean {
  if (record.state === 'awaiting') return limitMightKw(record) == null;
  return record.state === 'lost' || record.state === 'refused' || record.state === 'unknown';
}

/**
 * True when the station is a fixed load at its draw bound: offline (it keeps
 * what it holds and may start a session), or its base limit or a credit
 * profile that may still hold is not in force as sent (lost, refused,
 * unknown: a boot, a cleared profile, a station with no entry and no stored
 * profile; a send in flight to a station that held no limit).
 */
export function isLimitReserved(
  station: Pick<StationPowerInfo, 'isOnline'>,
  entry: AppliedAllocation | undefined,
  nowMs: number,
  storedLimit: StoredLimit | null = null,
): boolean {
  if (!station.isOnline) return true;
  if (entry == null && (storedLimit == null || limitMightKw(storedLimit.limit) == null)) {
    return true;
  }
  if (recordNotInForce(stationLimitRecord(entry, storedLimit))) return true;
  const credit = stationCredit(entry, storedLimit);
  return credit != null && creditMayHold(credit.until, nowMs) && recordNotInForce(credit.limit);
}

/** The fixed load of every reserved station (`isLimitReserved`), at its draw bound. */
export function limitReservations(
  stations: readonly StationPowerInfo[],
  previous: readonly AppliedAllocation[] | null,
  options: { nowMs: number; storedLimits?: ReadonlyMap<string, StoredLimit> },
): Map<string, number> {
  const byId = new Map((previous ?? []).map((a) => [a.stationDbId, a]));
  const reserved = new Map<string, number>();
  for (const station of stations) {
    const entry = byId.get(station.id);
    const storedLimit = options.storedLimits?.get(station.id) ?? null;
    if (!isLimitReserved(station, entry, options.nowMs, storedLimit)) continue;
    const kw =
      entry?.limit.state === 'refused'
        ? Math.max(stationMaximumKw(station), station.currentDrawKw, 0)
        : drawBoundKw(station, entry, { nowMs: options.nowMs, storedLimit });
    reserved.set(station.id, kw);
  }
  return reserved;
}

/**
 * The entries with every record that still awaits a reply moved to lost, once
 * the confirmation wait of the last send has passed ("Confirmation wait (5 s)
 * expires: Awaiting to Lost"), so the station is reserved and retried.
 */
export function withExpiredConfirmationWaits(
  entries: readonly AppliedAllocation[],
  waitPassed: boolean,
): AppliedAllocation[] {
  if (!waitPassed) return [...entries];
  const expire = (record: LimitRecord, credit = false): LimitRecord => {
    if (record.state !== 'awaiting' || record.commandId == null) return record;
    const event: LimitEvent = { type: 'timeout', commandId: record.commandId };
    return credit ? creditTransition(record, event) : limitTransition(record, event);
  };
  return entries.map((entry) => ({
    ...entry,
    limit: expire(entry.limit),
    ...(entry.credit != null
      ? { credit: { ...entry.credit, limit: expire(entry.credit.limit, true) } }
      : {}),
    ...(entry.evses != null
      ? { evses: entry.evses.map((e) => (e.limit != null ? { ...e, limit: expire(e.limit) } : e)) }
      : {}),
    ...(entry.evseDefaults != null
      ? {
          evseDefaults: entry.evseDefaults.map((d) =>
            d.limit != null ? { ...d, limit: expire(d.limit) } : d,
          ),
        }
      : {}),
  }));
}

/**
 * True while any limit of the entry is sent and not confirmed (awaiting a
 * reply, or lost): the station limit, the credit, an EVSE limit or a box default.
 */
export function hasUnconfirmedLimit(entry: AppliedAllocation | undefined): boolean {
  if (entry == null) return false;
  const records = [
    entry.limit,
    entry.credit?.limit,
    ...(entry.evses ?? []).map((e) => e.limit),
    ...(entry.evseDefaults ?? []).map((d) => d.limit),
  ];
  return records.some((r) => r?.state === 'awaiting' || r?.state === 'lost');
}

/**
 * True while the station's limit is settled only by its next replies: no
 * entry yet (unknown), or the limit sent and awaiting its answer. A refused or
 * lost limit lasts until the next cycle resends it.
 */
export function limitSettlesOnReplies(entry: AppliedAllocation | undefined): boolean {
  if (entry == null) return true;
  return entry.limit.state === 'unknown' || entry.limit.state === 'awaiting';
}

/** The online stations that are reserved: each is sent a retry limit fitted with the others. */
export function retryStationIds(
  stations: readonly StationPowerInfo[],
  previous: readonly AppliedAllocation[] | null,
  nowMs: number,
  storedLimits: ReadonlyMap<string, StoredLimit> = new Map(),
): string[] {
  const byId = new Map((previous ?? []).map((a) => [a.stationDbId, a]));
  return stations
    .filter(
      (s) =>
        s.isOnline && isLimitReserved(s, byId.get(s.id), nowMs, storedLimits.get(s.id) ?? null),
    )
    .map((s) => s.id);
}

/**
 * Splits the commands of a send into cuts and raises: one whose limit (`kw`)
 * is above the limit it replaces (`previousKw`) is a raise and goes after
 * every cut; one that replaces no known limit is a cut.
 */
export function cutsBeforeRaises<T extends { previousKw?: number }>(
  commands: readonly T[],
  kw: (command: T) => number,
): { cuts: T[]; raises: T[] } {
  const cuts: T[] = [];
  const raises: T[] = [];
  for (const command of commands) {
    if (command.previousKw != null && kw(command) > command.previousKw + 1e-9) {
      raises.push(command);
    } else {
      cuts.push(command);
    }
  }
  return { cuts, raises };
}

/** One limit of a send, as the state model sees it. */
export interface LimitSendCommand {
  stationDbId: string;
  commandId: string;
  /** What the station enforces once it applies the command (the record's `sentKw`). */
  kw: number;
  /** `station` the stack level 1 limit, `credit` the stack level 2 profile, `evse` a TxProfile, `evseDefault` a TxDefaultProfile. */
  target: 'station' | 'credit' | 'evse' | 'evseDefault';
  transactionId?: string;
  /** The EVSE of an `evseDefault`. */
  evseNumber?: number;
  /** The credit profile's end. */
  validTo?: string;
  /** The limit goes out in W. */
  watts?: boolean;
  /** A reserved station's retry: fitted jointly, so the claim does not check it as a cut. */
  retry?: true;
}

/** The claim found a cut that the stored state now makes a raise: nothing was written. */
export class SendClassificationChanged extends Error {
  constructor(readonly stationDbId: string) {
    super(`Load management send of ${stationDbId} is no longer a cut`);
  }
}

/** What the allocation counted a station at: the limit it might enforce, and whether it was reserved. */
export interface CountedLimit {
  countedKw: number | null;
  reserved: boolean;
  /**
   * The allocation sent the station above a unit box budget because its box
   * defaults held the box: false once the stored records no longer do.
   */
  boxesHold?: (entry: AppliedAllocation) => boolean;
}

/** The second claim found a station counted lower than it might now enforce: no raise goes out. */
export class RaiseBasisChanged extends Error {
  constructor(
    readonly stationDbId: string,
    readonly reason: 'missing' | 'might_rose' | 'reserved' | 'box_bound',
  ) {
    super(`Load management raises held: station ${stationDbId} ${reason}`);
  }
}

function applyToEvse(
  evses: AppliedEvseLimit[] | undefined,
  transactionId: string | undefined,
  apply: (record: LimitRecord) => LimitRecord,
): AppliedEvseLimit[] | undefined {
  if (evses == null || transactionId == null) return evses;
  return evses.map((e) =>
    e.transactionId === transactionId ? { ...e, limit: apply(e.limit ?? UNKNOWN_LIMIT) } : e,
  );
}

function sendOne(
  entry: AppliedAllocation,
  command: LimitSendCommand,
  options: { nowMs: number; checkCut: boolean },
): AppliedAllocation {
  const event: LimitEvent = {
    type: 'send',
    commandId: command.commandId,
    kw: command.kw,
    ...(command.watts === true ? { watts: true } : {}),
  };
  if (command.target === 'station') {
    if (options.checkCut && command.retry !== true) {
      // The same bound the send classified the cut against: a credit that may
      // still hold counts above the base.
      const might = mightEnforceKw(entry, { nowMs: options.nowMs });
      if (might != null && command.kw > might + EPSILON_KW) {
        throw new SendClassificationChanged(entry.stationDbId);
      }
    }
    return { ...entry, limit: limitTransition(entry.limit, event) };
  }
  if (command.target === 'credit') {
    if (options.checkCut && command.retry !== true) {
      const might = mightEnforceKw(entry, { nowMs: options.nowMs });
      if (might != null && command.kw > might + EPSILON_KW) {
        throw new SendClassificationChanged(entry.stationDbId);
      }
    }
    const until = command.validTo ?? entry.credit?.until;
    if (until == null) return entry;
    // The profile the station may hold now: an ended one adds nothing.
    const held =
      entry.credit != null && creditMayHold(entry.credit.until, options.nowMs)
        ? entry.credit
        : null;
    // Until the reply the station may hold either, so the later end counts. An
    // unknown profile has no end of its own: the replacement outlasts it.
    const keepUntil =
      held != null && held.limit.state !== 'unknown' && Date.parse(held.until) > Date.parse(until)
        ? held.until
        : until;
    return {
      ...entry,
      credit: { limit: creditTransition(held?.limit ?? NO_CREDIT_LIMIT, event), until: keepUntil },
    };
  }
  if (command.target === 'evseDefault') {
    const evseDefaults = entry.evseDefaults?.map((d) => {
      if (d.evseNumber !== command.evseNumber) return d;
      const record = d.limit ?? UNKNOWN_LIMIT;
      if (options.checkCut) {
        const might = limitMightKw(record);
        if (might != null && command.kw > might + EPSILON_KW) {
          throw new SendClassificationChanged(entry.stationDbId);
        }
      }
      return { ...d, limit: limitTransition(record, event) };
    });
    return evseDefaults != null ? { ...entry, evseDefaults } : entry;
  }
  const evses = entry.evses?.map((e) => {
    if (e.transactionId !== command.transactionId) return e;
    const record = e.limit ?? UNKNOWN_LIMIT;
    if (options.checkCut) {
      const might = limitMightKw(record);
      if (might != null && command.kw > might + EPSILON_KW) {
        throw new SendClassificationChanged(entry.stationDbId);
      }
    }
    return { ...e, limit: limitTransition(record, event) };
  });
  return evses != null ? { ...entry, evses } : entry;
}

/**
 * The entries a send's first claim stores: the cycle's entries with the
 * station state of the locked row (replies stored since the read win), and
 * the cuts of the send recorded as sends. A cut that the locked state makes a
 * raise throws `SendClassificationChanged`, so nothing is written and the
 * next cycle orders again. EVSE records of transactions and defaults the send
 * releases are kept until their clear goes out.
 */
export function entriesForCuts(
  applied: readonly AppliedAllocation[],
  locked: unknown,
  cuts: readonly LimitSendCommand[],
  releasing: ReadonlySet<string>,
  nowMs: number,
): AppliedAllocation[] {
  const lockedById = new Map(
    (parseAppliedAllocations(locked) ?? []).map((a) => [a.stationDbId, a]),
  );
  const byStation = new Map<string, LimitSendCommand[]>();
  for (const c of cuts) byStation.set(c.stationDbId, [...(byStation.get(c.stationDbId) ?? []), c]);
  return applied.map((entry) => {
    const current = lockedById.get(entry.stationDbId);
    let next: AppliedAllocation = entry;
    if (current != null) {
      const heldEvses = new Map((current.evses ?? []).map((e) => [e.transactionId, e]));
      const evses = (entry.evses ?? []).map((e) => {
        const held = heldEvses.get(e.transactionId);
        return held?.limit != null ? { ...e, limit: held.limit } : e;
      });
      const inNew = new Set(evses.map((e) => e.transactionId));
      const pendingRelease = (current.evses ?? []).filter(
        (e) =>
          releasing.has(`${entry.stationDbId}:${e.transactionId}`) && !inNew.has(e.transactionId),
      );
      const allEvses = [...evses, ...pendingRelease];
      const heldDefaults = new Map((current.evseDefaults ?? []).map((d) => [d.evseNumber, d]));
      const defaults = (entry.evseDefaults ?? []).map((d) => {
        const held = heldDefaults.get(d.evseNumber);
        return held?.limit != null ? { ...d, limit: held.limit } : d;
      });
      const inNewDefaults = new Set(defaults.map((d) => d.evseNumber));
      const allDefaults = [
        ...defaults,
        ...(current.evseDefaults ?? []).filter(
          (d) =>
            releasing.has(defaultReleaseKey(entry.stationDbId, d.evseNumber)) &&
            !inNewDefaults.has(d.evseNumber),
        ),
      ];
      next = {
        ...entry,
        limit: current.limit,
        ...(current.rejectedUnits != null ? { rejectedUnits: current.rejectedUnits } : {}),
        ...(current.acceptedUnits != null ? { acceptedUnits: current.acceptedUnits } : {}),
        ...(allEvses.length > 0 ? { evses: allEvses } : {}),
        ...(allDefaults.length > 0 ? { evseDefaults: allDefaults } : {}),
      };
      if (current.credit != null) next = { ...next, credit: current.credit };
      else delete next.credit;
      if (allEvses.length === 0) delete next.evses;
      if (allDefaults.length === 0) delete next.evseDefaults;
    }
    const commands = byStation.get(entry.stationDbId) ?? [];
    // A credit send to a station that may hold a credit profile nothing records
    // replaces that unknown profile: the record starts from it, not from none.
    if (next.credit == null && commands.some((c) => c.target === 'credit')) {
      const credit = stationCredit(next);
      if (credit != null) next = { ...next, credit };
    }
    for (const command of commands) {
      next = sendOne(next, command, { nowMs, checkCut: true });
    }
    return next;
  });
}

/** The locked entries with the raises of the send recorded as sends and the released EVSE records dropped. */
export function entriesForRaises(
  locked: unknown,
  raises: readonly LimitSendCommand[],
  released: ReadonlySet<string>,
  nowMs: number,
  counted: ReadonlyMap<string, CountedLimit> = new Map(),
): AppliedAllocation[] {
  const entries = parseAppliedAllocations(locked) ?? [];
  const byId = new Map(entries.map((e) => [e.stationDbId, e]));
  // Every raise is recorded before it goes out: one without its station's entry
  // (the row was rewritten since the first claim) is held.
  for (const command of raises) {
    if (!byId.has(command.stationDbId)) {
      throw new RaiseBasisChanged(command.stationDbId, 'missing');
    }
  }
  // The raises fit what the allocation counted every other station at: a
  // station that might enforce more now (a reboot, a refusal, a clear, a reply
  // between the claims) or that became a reservation holds them back (review 9).
  for (const entry of entries) {
    const basis = counted.get(entry.stationDbId);
    if (basis == null) continue;
    const might = mightEnforceKw(entry, { nowMs });
    if (basis.countedKw != null && (might == null || might > basis.countedKw + EPSILON_KW)) {
      throw new RaiseBasisChanged(entry.stationDbId, 'might_rose');
    }
    if (!basis.reserved && isLimitReserved({ isOnline: true }, entry, nowMs)) {
      throw new RaiseBasisChanged(entry.stationDbId, 'reserved');
    }
    if (basis.boxesHold != null && !basis.boxesHold(entry)) {
      throw new RaiseBasisChanged(entry.stationDbId, 'box_bound');
    }
  }
  return entries.map((entry) => {
    let next: AppliedAllocation = entry;
    if (next.evses != null && released.size > 0) {
      const kept = next.evses.filter(
        (e) => !released.has(`${entry.stationDbId}:${e.transactionId}`),
      );
      next = kept.length > 0 ? { ...next, evses: kept } : withoutEvses(next);
    }
    if (next.evseDefaults != null && released.size > 0) {
      const kept = next.evseDefaults.filter(
        (d) => !released.has(defaultReleaseKey(entry.stationDbId, d.evseNumber)),
      );
      if (kept.length > 0) next = { ...next, evseDefaults: kept };
      else {
        next = { ...next };
        delete next.evseDefaults;
      }
    }
    for (const command of raises) {
      if (command.stationDbId === entry.stationDbId) {
        next = sendOne(next, command, { nowMs, checkCut: false });
      }
    }
    return next;
  });
}

/** The release key of an EVSE's default (`entriesForCuts`, `entriesForRaises`). */
export function defaultReleaseKey(stationDbId: string, evseNumber: number): string {
  return `${stationDbId}:default:${String(evseNumber)}`;
}

function withoutEvses(entry: AppliedAllocation): AppliedAllocation {
  const copy = { ...entry };
  delete copy.evses;
  return copy;
}

/** A command of a send the station never decided on: its reply wait ended, or it was not published. */
export interface LimitSendFailure {
  stationDbId: string;
  commandId: string;
  target: 'station' | 'credit' | 'evse' | 'evseDefault';
  transactionId?: string;
  evseNumber?: number;
  kind: 'timeout' | 'unpublished';
}

/**
 * The locked entries after a send's failures: each command's record moves to
 * lost. A station whose raise was held keeps as its allocation what it may
 * still enforce, so the next cycle sees the raise as a change and sends it.
 */
export function entriesAfterFailures(
  locked: unknown,
  failures: readonly LimitSendFailure[],
  heldRaises: ReadonlySet<string> = new Set(),
  nowMs: number = Date.now(),
): AppliedAllocation[] {
  const entries = parseAppliedAllocations(locked) ?? [];
  return entries.map((entry) => {
    let next = entry;
    if (heldRaises.has(entry.stationDbId)) {
      next = { ...next, allocatedKw: mightEnforceKw(entry, { nowMs }) ?? 0 };
      delete next.allocatedBaseKw;
    }
    for (const failure of failures) {
      if (failure.stationDbId !== entry.stationDbId) continue;
      const event: LimitEvent = { type: failure.kind, commandId: failure.commandId };
      if (failure.target === 'station') {
        next = { ...next, limit: limitTransition(next.limit, event) };
      } else if (failure.target === 'credit') {
        if (next.credit != null) {
          next = {
            ...next,
            credit: { ...next.credit, limit: creditTransition(next.credit.limit, event) },
          };
        }
      } else if (failure.target === 'evseDefault') {
        if (next.evseDefaults != null) {
          next = {
            ...next,
            evseDefaults: next.evseDefaults.map((d) =>
              d.evseNumber === failure.evseNumber
                ? { ...d, limit: limitTransition(d.limit ?? UNKNOWN_LIMIT, event) }
                : d,
            ),
          };
        }
      } else {
        const evses = applyToEvse(next.evses, failure.transactionId, (r) =>
          limitTransition(r, event),
        );
        if (evses != null) next = { ...next, evses };
      }
    }
    return next;
  });
}

/**
 * The records after an operator saves the site's load management config
 * (safety spec, "Operator saves load management config"): each station keeps
 * its limit, credit and EVSE records (what it may hold does not change with a
 * save) and loses only its allocation, so the next cycle allocates and sends
 * again. A save that turns load management off sends clears that remove the
 * limits and defaults: every record becomes unknown, so a site turned on again counts each
 * station unlimited until it accepts a limit.
 */
export function entriesAfterConfigSave(
  locked: unknown,
  options: { turnsOff: boolean },
): AppliedAllocation[] | null {
  const entries = parseAppliedAllocations(locked);
  if (entries == null) return null;
  return entries.map((entry) => {
    const kept: AppliedAllocation = {
      stationId: entry.stationId,
      stationDbId: entry.stationDbId,
      allocatedKw: 0,
      limit: options.turnsOff ? UNKNOWN_LIMIT : entry.limit,
      ...(entry.rejectedUnits != null ? { rejectedUnits: entry.rejectedUnits } : {}),
      ...(entry.acceptedUnits != null ? { acceptedUnits: entry.acceptedUnits } : {}),
      ...(!options.turnsOff && entry.credit != null ? { credit: entry.credit } : {}),
    };
    const evses = entry.evses?.map((e) => (options.turnsOff ? { ...e, limit: UNKNOWN_LIMIT } : e));
    const evseDefaults = entry.evseDefaults?.map((d) =>
      options.turnsOff ? { ...d, limit: UNKNOWN_LIMIT } : d,
    );
    return {
      ...kept,
      ...(evses != null && evses.length > 0 ? { evses } : {}),
      ...(evseDefaults != null && evseDefaults.length > 0 ? { evseDefaults } : {}),
    };
  });
}
