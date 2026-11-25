// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Departure-aware allocation of a depot site: builds the planner input from the
// site's panel and circuit tree, binds departures to the sessions charging for
// them, plans when the stored plan is stale, writes the plan and the readiness
// of every departure (writeSitePlan), and turns the current slot of the plan
// into fixed allocations for the load management cycle.

import { type PlanSessionRow, type StoredSitePlan } from '@evtivity/database';
import { type ChargingRateUnit, type AllocationResult } from './load-management-model.js';
import { parseMeasureState, type PlanMeasureState } from './charging-plan-measurement.js';
import { SLOT_MS, CUT_TOLERANCE_KW } from './charging-plan-nodes.js';

/** The start of the slot `nowMs` falls in. */
export function currentSlotStartMs(nowMs: number): number {
  return Math.floor(nowMs / SLOT_MS) * SLOT_MS;
}

/**
 * The stored plan is missing, marked stale, or planned before the current
 * slot. The plan's first slot starts at the worker time it planned at, so the
 * comparison never mixes the database clock with the worker clock; a plan
 * without slots falls back to its computed time.
 */
export function planNeedsRun(stored: StoredSitePlan | null, nowMs: number): boolean {
  if (stored == null || stored.plan == null || stored.staleAt != null) return true;
  const first = Array.isArray(stored.slotStarts) ? (stored.slotStarts as unknown[])[0] : undefined;
  const plannedAtMs = typeof first === 'string' ? Date.parse(first) : Number.NaN;
  const at = Number.isFinite(plannedAtMs) ? plannedAtMs : stored.computedAt.getTime();
  return at < currentSlotStartMs(nowMs);
}

/** One planned departure as stored in `site_charging_plans.plan`. */
export interface StoredPlanEntry {
  departureId: string;
  vehicleId: string;
  sessionId: string;
  stationDbId: string;
  evseDbId: string | null;
  /** The lowest power the session holds without pausing (0: any power). */
  minKw: number;
  powerKw: number[];
  /** Preconditioning load per slot in kW, added to the profile limit (absent: none). */
  auxKw?: number[];
  /** Slots of the battery preconditioning window (OCPP 2.1 preconditioningRequest). */
  preconditioning?: boolean[];
  /** The TxProfile last sent for the session and the station's answer. */
  profile?: PlanProfileState;
  /** Measured draw against the plan: taper cap, charger not following, slot energy. */
  measure?: PlanMeasureState;
  /**
   * The session left the plan while the station may still hold its TxProfile:
   * kept only until the dispatcher has cleared that profile, never planned.
   */
  left?: boolean;
}

/** The entries the plan charges (not the ones kept only to clear a profile). */
export function plannedEntries(entries: readonly StoredPlanEntry[]): StoredPlanEntry[] {
  return entries.filter((entry) => entry.left !== true);
}

/** The plan TxProfile last sent for a session, as stored in its plan entry. */
export interface PlanProfileState {
  /** The TxProfile id (`chargingNeedsProfileId`). */
  id: number;
  hash: string;
  /** Start of the plan slot it was sent in: at most one send per slot. */
  slotStartMs: number;
  /**
   * `not_sent`: no answer or a send failure, sent again at the next slot.
   * `cleared`: a ClearChargingProfile went out after the session left the plan.
   */
  state: PlanProfileStateName;
  sentAt: string;
  repliedAt?: string;
  rejectedAt?: string;
  /** Units the station refused for this session's profile: the next send uses the other one. */
  rejectedUnits?: ChargingRateUnit[];
  clearedAt?: string;
}

export type PlanProfileStateName = 'sent' | 'accepted' | 'rejected' | 'not_sent' | 'cleared';

const PLAN_PROFILE_STATES: readonly PlanProfileStateName[] = [
  'sent',
  'accepted',
  'rejected',
  'not_sent',
  'cleared',
];

function parseProfileState(value: unknown): PlanProfileState | undefined {
  if (value == null || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const state = v['state'];
  if (
    typeof v['id'] !== 'number' ||
    typeof v['hash'] !== 'string' ||
    typeof v['slotStartMs'] !== 'number' ||
    typeof v['sentAt'] !== 'string' ||
    !PLAN_PROFILE_STATES.includes(state as PlanProfileStateName)
  ) {
    return undefined;
  }
  const units = Array.isArray(v['rejectedUnits'])
    ? (v['rejectedUnits'] as unknown[]).filter((u): u is ChargingRateUnit => u === 'A' || u === 'W')
    : [];
  return {
    id: v['id'],
    hash: v['hash'],
    slotStartMs: v['slotStartMs'],
    state: state as PlanProfileStateName,
    sentAt: v['sentAt'],
    ...(typeof v['repliedAt'] === 'string' ? { repliedAt: v['repliedAt'] } : {}),
    ...(typeof v['rejectedAt'] === 'string' ? { rejectedAt: v['rejectedAt'] } : {}),
    ...(units.length > 0 ? { rejectedUnits: units } : {}),
    ...(typeof v['clearedAt'] === 'string' ? { clearedAt: v['clearedAt'] } : {}),
  };
}

export function parseStoredEntries(value: unknown): StoredPlanEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: StoredPlanEntry[] = [];
  for (const item of value as unknown[]) {
    if (item == null || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (
      typeof e['departureId'] !== 'string' ||
      typeof e['sessionId'] !== 'string' ||
      typeof e['stationDbId'] !== 'string' ||
      !Array.isArray(e['powerKw'])
    ) {
      continue;
    }
    entries.push({
      departureId: e['departureId'],
      vehicleId: typeof e['vehicleId'] === 'string' ? e['vehicleId'] : '',
      sessionId: e['sessionId'],
      stationDbId: e['stationDbId'],
      evseDbId: typeof e['evseDbId'] === 'string' ? e['evseDbId'] : null,
      minKw:
        typeof e['minKw'] === 'number' && Number.isFinite(e['minKw']) ? Math.max(0, e['minKw']) : 0,
      powerKw: (e['powerKw'] as unknown[]).map((v) =>
        typeof v === 'number' && Number.isFinite(v) ? v : 0,
      ),
    });
    const profile = parseProfileState(e['profile']);
    const measure = parseMeasureState(e['measure']);
    const last = entries[entries.length - 1];
    if (Array.isArray(e['auxKw']) && last != null) {
      last.auxKw = (e['auxKw'] as unknown[]).map((v) =>
        typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0,
      );
    }
    if (Array.isArray(e['preconditioning']) && last != null) {
      last.preconditioning = (e['preconditioning'] as unknown[]).map((v) => v === true);
    }
    if (profile != null && last != null) last.profile = profile;
    if (measure != null && last != null) last.measure = measure;
    if (e['left'] === true && last != null) last.left = true;
  }
  return entries;
}

/** Index of the stored slot `nowMs` falls in, or -1 when the plan does not cover it. */
export function storedSlotIndex(slotStarts: unknown, nowMs: number): number {
  if (!Array.isArray(slotStarts) || slotStarts.length === 0) return -1;
  const starts = (slotStarts as unknown[]).map((v) =>
    typeof v === 'string' ? Date.parse(v) : Number.NaN,
  );
  let index = -1;
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i] ?? Number.NaN;
    if (!Number.isFinite(start) || start > nowMs) break;
    index = i;
  }
  // The last slot ends at the next quarter hour at the latest.
  if (index === starts.length - 1 && nowMs >= currentSlotStartMs(starts[index] ?? 0) + SLOT_MS) {
    return -1;
  }
  return index;
}

export interface PlannedStations {
  /** Planned kW of the current slot per station database id. */
  plannedKw: Map<string, number>;
  /** Planned stations that also hold an unplanned session. */
  sharing: Set<string>;
  /** The minimum of the planned sessions that get power, per station. */
  minKw: Map<string, number>;
}

/** A slot power between 0 and the session minimum is not one a charger holds: 0 or the minimum. */
export function snapToMinimum(kw: number, minKw: number): number {
  if (!(kw > 0)) return 0;
  if (minKw <= 0 || kw >= minKw) return kw;
  return kw >= minKw / 2 ? minKw : 0;
}

/** The current slot of a set of planned entries, summed per station, for sessions still active. */
export function plannedStations(
  entries: readonly StoredPlanEntry[],
  slotIndex: number,
  sessions: readonly PlanSessionRow[],
): PlannedStations {
  const active = new Map(sessions.map((s) => [s.id, s]));
  const plannedKw = new Map<string, number>();
  const minKw = new Map<string, number>();
  const plannedSessions = new Set<string>();
  for (const entry of plannedEntries(entries)) {
    const session = active.get(entry.sessionId);
    if (session == null || session.stationDbId !== entry.stationDbId) continue;
    const kw = snapToMinimum(slotIndex >= 0 ? (entry.powerKw[slotIndex] ?? 0) : 0, entry.minKw);
    plannedKw.set(entry.stationDbId, (plannedKw.get(entry.stationDbId) ?? 0) + kw);
    if (kw > 0) minKw.set(entry.stationDbId, (minKw.get(entry.stationDbId) ?? 0) + entry.minKw);
    plannedSessions.add(session.id);
  }
  const sharing = new Set<string>();
  for (const session of sessions) {
    if (plannedKw.has(session.stationDbId) && !plannedSessions.has(session.id)) {
      sharing.add(session.stationDbId);
    }
  }
  return { plannedKw, sharing, minKw };
}

/** A planned station that the panel or phase limits cut below its planned power. */
export function plannedStationCut(
  allocations: readonly AllocationResult[],
  plannedKw: ReadonlyMap<string, number>,
): boolean {
  const byId = new Map(allocations.map((a) => [a.stationDbId, a.allocatedKw]));
  for (const [stationDbId, kw] of plannedKw) {
    const allocated = byId.get(stationDbId);
    if (allocated != null && allocated < kw - CUT_TOLERANCE_KW) return true;
  }
  return false;
}
