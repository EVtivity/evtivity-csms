// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * OCPP 2.1 composite schedule (K08) of the simulator: combines the stored
 * charging profiles that apply to an EVSE with the EVSE's local limit.
 *
 * At every point in time the valid profile with the highest stackLevel of each
 * purpose sets that purpose's limit (an EVSE-specific profile wins over one on
 * EVSE 0 at the same stackLevel). A TxProfile replaces the TxDefaultProfile of
 * its transaction. The composite limit is the minimum of the local limit,
 * ChargingStationMaxProfile, ChargingStationExternalConstraints, and the
 * transaction limit. Profiles marked `_invalidated` (offline longer than their
 * maxOfflineDuration with invalidAfterOfflineDuration) do not apply.
 */

export interface CompositePeriod {
  startPeriod: number;
  limit: number;
  numberPhases?: number;
}

/** A stored ChargingProfileType plus the simulator stamps `_evseId`, `_setAt`, `_invalidated`. */
export type StoredProfile = Record<string, unknown>;

export interface CompositeInput {
  profiles: StoredProfile[];
  /** 0 = the Charging Station as a whole. */
  evseId: number;
  now: Date;
  durationS: number;
  /** Local (hardware) limit in the requested unit. */
  localLimit: number;
  /** Requested charging rate unit; profile limits in the other unit are converted. */
  unit: 'A' | 'W';
  /** Nominal voltage per phase, for A <-> W conversion. */
  voltage: number;
  numberPhases: number;
  /** Transaction running on the EVSE, if any. */
  transactionId: string | null;
  transactionStart: Date | null;
}

const RECURRENCY_MS: Record<string, number> = { Daily: 86_400_000, Weekly: 604_800_000 };

interface SchedulePeriod {
  startPeriod: number;
  limit: number;
  numberPhases?: number;
}

interface Schedule {
  chargingRateUnit?: string;
  startSchedule?: string;
  duration?: number;
  chargingSchedulePeriod?: SchedulePeriod[];
}

function scheduleOf(profile: StoredProfile): Schedule | undefined {
  const raw = profile['chargingSchedule'];
  return (Array.isArray(raw) ? (raw as Schedule[])[0] : (raw as Schedule | undefined)) ?? undefined;
}

const parseTime = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/** Start (epoch ms) of the profile's schedule occurrence that covers time t. */
function scheduleStartAt(profile: StoredProfile, input: CompositeInput, t: number): number {
  const schedule = scheduleOf(profile);
  const kind = profile['chargingProfileKind'] as string | undefined;
  if (kind === 'Relative') {
    return input.transactionStart?.getTime() ?? input.now.getTime();
  }
  const base =
    parseTime(schedule?.startSchedule) ?? parseTime(profile['_setAt']) ?? input.now.getTime();
  if (kind === 'Recurring') {
    const period = RECURRENCY_MS[profile['recurrencyKind'] as string] ?? 86_400_000;
    return base + Math.floor((t - base) / period) * period;
  }
  return base;
}

function isValidAt(profile: StoredProfile, t: number): boolean {
  const from = parseTime(profile['validFrom']);
  const to = parseTime(profile['validTo']);
  if (from != null && t < from) return false;
  if (to != null && t >= to) return false;
  return true;
}

/** A limit in the requested unit (W = A x voltage x phases). */
function inUnit(
  limit: number,
  from: string | undefined,
  phases: number,
  input: CompositeInput,
): number {
  if (from == null || from === input.unit) return limit;
  const factor = input.voltage * Math.max(1, phases);
  return input.unit === 'W' ? limit * factor : Math.round((limit / factor) * 10) / 10;
}

/** The schedule period of a profile active at time t (limit in the requested unit), or null. */
function activePeriod(
  profile: StoredProfile,
  input: CompositeInput,
  t: number,
): SchedulePeriod | null {
  if (!isValidAt(profile, t)) return null;
  const schedule = scheduleOf(profile);
  if (schedule == null) return null;
  const offset = (t - scheduleStartAt(profile, input, t)) / 1000;
  if (offset < 0) return null;
  if (schedule.duration != null && offset >= schedule.duration) return null;
  let found: SchedulePeriod | null = null;
  for (const p of schedule.chargingSchedulePeriod ?? []) {
    if (p.startPeriod <= offset) found = p;
  }
  if (found == null) return null;
  const limit = inUnit(
    found.limit,
    schedule.chargingRateUnit,
    found.numberPhases ?? input.numberPhases,
    input,
  );
  return { ...found, limit };
}

function appliesTo(profile: StoredProfile, input: CompositeInput): boolean {
  if (profile['_invalidated'] === true) return false;
  const profileEvse = (profile['_evseId'] as number | undefined) ?? 0;
  if (input.evseId === 0) return profileEvse === 0;
  if (profileEvse !== 0 && profileEvse !== input.evseId) return false;
  if (profile['chargingProfilePurpose'] === 'TxProfile') {
    if (input.transactionId == null) return false;
    const tx = profile['transactionId'] as string | undefined;
    return tx == null || tx === input.transactionId;
  }
  return true;
}

/** Limit of one purpose at time t: highest stackLevel, EVSE-specific before EVSE 0. */
function purposeLimit(
  profiles: StoredProfile[],
  input: CompositeInput,
  t: number,
): SchedulePeriod | null {
  let best: { stack: number; specific: boolean; period: SchedulePeriod } | null = null;
  for (const profile of profiles) {
    const period = activePeriod(profile, input, t);
    if (period == null) continue;
    const stack = (profile['stackLevel'] as number | undefined) ?? 0;
    const specific = ((profile['_evseId'] as number | undefined) ?? 0) !== 0;
    if (
      best == null ||
      stack > best.stack ||
      (stack === best.stack && specific && !best.specific)
    ) {
      best = { stack, specific, period };
    }
  }
  return best?.period ?? null;
}

/** Times (epoch ms) in the window where a profile may change its limit. */
function breakpoints(profiles: StoredProfile[], input: CompositeInput): number[] {
  const t0 = input.now.getTime();
  const end = t0 + input.durationS * 1000;
  const points = new Set<number>([t0]);
  const add = (t: number | null): void => {
    if (t != null && t > t0 && t < end) points.add(t);
  };
  for (const profile of profiles) {
    add(parseTime(profile['validFrom']));
    add(parseTime(profile['validTo']));
    const schedule = scheduleOf(profile);
    if (schedule == null) continue;
    const first = scheduleStartAt(profile, input, t0);
    const starts: number[] = [first];
    if (profile['chargingProfileKind'] === 'Recurring') {
      const period = RECURRENCY_MS[profile['recurrencyKind'] as string] ?? 86_400_000;
      for (let s = first + period; s < end; s += period) starts.push(s);
    }
    for (const s of starts) {
      for (const p of schedule.chargingSchedulePeriod ?? []) add(s + p.startPeriod * 1000);
      if (schedule.duration != null) add(s + schedule.duration * 1000);
    }
  }
  return Array.from(points).sort((a, b) => a - b);
}

export function computeCompositeSchedule(input: CompositeInput): CompositePeriod[] {
  const relevant = input.profiles.filter((p) => appliesTo(p, input));
  const byPurpose = (purpose: string): StoredProfile[] =>
    relevant.filter((p) => p['chargingProfilePurpose'] === purpose);
  const max = byPurpose('ChargingStationMaxProfile');
  const external = byPurpose('ChargingStationExternalConstraints');
  const txDefault = byPurpose('TxDefaultProfile');
  const tx = byPurpose('TxProfile');
  const t0 = input.now.getTime();

  const periods: CompositePeriod[] = [];
  for (const t of breakpoints(relevant, input)) {
    let limit = input.localLimit;
    let numberPhases = input.numberPhases;
    for (const group of [max, external]) {
      const p = purposeLimit(group, input, t);
      if (p != null && p.limit < limit) limit = p.limit;
    }
    const txPeriod = purposeLimit(tx, input, t) ?? purposeLimit(txDefault, input, t);
    if (txPeriod != null) {
      if (txPeriod.limit < limit) limit = txPeriod.limit;
      if (txPeriod.numberPhases != null) numberPhases = txPeriod.numberPhases;
    }
    const last = periods[periods.length - 1];
    if (last != null && last.limit === limit && last.numberPhases === numberPhases) continue;
    periods.push({ startPeriod: Math.round((t - t0) / 1000), limit, numberPhases });
  }
  return periods;
}
