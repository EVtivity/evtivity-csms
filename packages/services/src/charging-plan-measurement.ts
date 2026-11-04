// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** How long a draw must stay low or high, from the first reading that showed it, before it counts. */
export const MEASURE_WINDOW_MS = 60_000;
/** After the station accepted its profile, the EV gets this long to follow it before it is measured. */
export const PROFILE_SETTLE_MS = 30_000;
/** A session drawing under this share of its limit is tapering. */
export const TAPER_DRAW_SHARE = 0.8;
/** The taper cap is the measured draw plus 10 %. */
export const TAPER_CAP_MARGIN = 1.1;
/** A taper cap is never below this, so a paused EV is not planned at 0 for good. */
export const TAPER_CAP_MIN_KW = 1;
/** A session drawing more than its limit plus this share is not following it. */
export const NOT_FOLLOWING_SHARE = 0.05;
/** ...and more than this many kW above it, so meter noise at a low limit does not count. */
export const NOT_FOLLOWING_MIN_KW = 0.2;
/** A slot behind plan by more than the larger of this and 10 % of its planned energy. */
export const BEHIND_PLAN_MIN_KWH = 0.5;
export const BEHIND_PLAN_SHARE = 0.1;

/** The measurement state of one planned session, stored in its plan entry. */
export interface PlanMeasureState {
  /** The limit the windows were measured against; a new limit starts them again. */
  limitKw: number;
  /** First reading of the current run under 80 % of the limit. */
  lowSinceMs?: number;
  /** First reading of the current run above the limit plus 5 %. */
  highSinceMs?: number;
  /** The planner caps the session at this while its battery tapers. */
  taperCapKw?: number;
  /** The draw of a session that does not follow its limit; the planner holds it as fixed load. */
  notFollowingKw?: number;
  /** The slot whose energy is tracked and the session energy at its first reading. */
  slotStartMs?: number;
  slotFromWh?: number;
  /** Planned energy of the slot up to `segmentFromMs`, when `limitKw` last changed. */
  slotExpectedWh?: number;
  segmentFromMs?: number;
}

export interface PlanMeasureReading {
  /** The session's planned power in the current slot (after the minimum snap). */
  limitKw: number;
  /** The latest measured draw of the session, null when there is none to trust. */
  drawKw: number | null;
  /** Energy delivered so far (`charging_sessions.energy_delivered_wh`). */
  energyWh: number;
  /** Start of the plan slot that holds now. */
  slotStartMs: number;
  /** The session minimum, a floor for the taper cap. */
  minKw: number;
  /**
   * The station accepted the session's profile at least `PROFILE_SETTLE_MS`
   * ago, so the draw answers that limit. Taper and charger not following are
   * measured only then; behind plan always.
   */
  profileSettled: boolean;
}

export type PlanMeasureEvent =
  | 'charger_not_following'
  | 'charger_following'
  | 'behind_plan'
  | 'taper'
  | 'taper_ended';

export interface PlanMeasureOutcome {
  state: PlanMeasureState;
  /** True when the state differs from the stored one. */
  changed: boolean;
  /** What happened this cycle, most important first; any event makes the planner run again. */
  events: PlanMeasureEvent[];
}

const EVENT_ORDER: readonly PlanMeasureEvent[] = [
  'charger_not_following',
  'charger_following',
  'behind_plan',
  'taper',
  'taper_ended',
];

function kwhAt(kw: number, ms: number): number {
  return (kw * Math.max(0, ms)) / 3_600_000;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function sameState(a: PlanMeasureState | undefined, b: PlanMeasureState): boolean {
  return a != null && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * One cycle of measurement for a planned session: behind plan at each slot end,
 * a taper cap after a minute under 80 % of its limit, and a charger not
 * following after a minute above its limit plus 5 %, each minute counted from
 * the first reading that showed it. Pure: the caller stores the state and
 * plans again on an event.
 */
export function evaluatePlanMeasurement(
  previous: PlanMeasureState | undefined,
  reading: PlanMeasureReading,
  nowMs: number,
): PlanMeasureOutcome {
  const events = new Set<PlanMeasureEvent>();
  const s: PlanMeasureState = previous != null ? { ...previous } : { limitKw: reading.limitKw };

  // Behind plan: the slot that just ended against the energy its limits planned.
  if (
    s.slotStartMs != null &&
    s.slotStartMs < reading.slotStartMs &&
    s.slotFromWh != null &&
    s.segmentFromMs != null
  ) {
    const expectedKwh =
      (s.slotExpectedWh ?? 0) / 1000 + kwhAt(s.limitKw, reading.slotStartMs - s.segmentFromMs);
    const deliveredKwh = (reading.energyWh - s.slotFromWh) / 1000;
    const tolerance = Math.max(BEHIND_PLAN_MIN_KWH, BEHIND_PLAN_SHARE * expectedKwh);
    if (expectedKwh > 0 && deliveredKwh - expectedKwh < -tolerance) events.add('behind_plan');
  }
  if (s.slotStartMs !== reading.slotStartMs) {
    s.slotStartMs = reading.slotStartMs;
    s.slotFromWh = reading.energyWh;
    s.slotExpectedWh = 0;
    s.segmentFromMs = nowMs;
    s.limitKw = round3(reading.limitKw);
  }

  if (Math.abs(s.limitKw - reading.limitKw) > 0.001) {
    s.slotExpectedWh = Math.round(
      (s.slotExpectedWh ?? 0) + kwhAt(s.limitKw, nowMs - (s.segmentFromMs ?? nowMs)) * 1000,
    );
    s.segmentFromMs = nowMs;
    s.limitKw = round3(reading.limitKw);
    delete s.lowSinceMs;
    delete s.highSinceMs;
  }

  const draw = reading.drawKw;
  if (draw == null || !Number.isFinite(draw) || !reading.profileSettled) {
    delete s.lowSinceMs;
    delete s.highSinceMs;
  } else {
    const limit = reading.limitKw;
    if (draw - limit > Math.max(NOT_FOLLOWING_SHARE * limit, NOT_FOLLOWING_MIN_KW)) {
      s.highSinceMs ??= nowMs;
      if (nowMs - s.highSinceMs >= MEASURE_WINDOW_MS && s.notFollowingKw == null) {
        s.notFollowingKw = round3(draw);
        events.add('charger_not_following');
      }
    } else {
      delete s.highSinceMs;
      if (s.notFollowingKw != null) {
        delete s.notFollowingKw;
        events.add('charger_following');
      }
    }

    if (limit > 0 && draw < TAPER_DRAW_SHARE * limit) {
      s.lowSinceMs ??= nowMs;
      if (nowMs - s.lowSinceMs >= MEASURE_WINDOW_MS) {
        delete s.lowSinceMs;
        const cap = round3(Math.max(draw * TAPER_CAP_MARGIN, reading.minKw, TAPER_CAP_MIN_KW));
        if (cap < limit && (s.taperCapKw == null || cap < s.taperCapKw)) {
          s.taperCapKw = cap;
          events.add('taper');
        }
      }
    } else {
      delete s.lowSinceMs;
      if (s.taperCapKw != null && draw >= s.taperCapKw) {
        delete s.taperCapKw;
        events.add('taper_ended');
      }
    }
  }
  // A cleared flag needs no settled profile: the draw is back within the limit.
  if (
    draw != null &&
    Number.isFinite(draw) &&
    !reading.profileSettled &&
    s.notFollowingKw != null &&
    draw - reading.limitKw <= Math.max(NOT_FOLLOWING_SHARE * reading.limitKw, NOT_FOLLOWING_MIN_KW)
  ) {
    delete s.notFollowingKw;
    events.add('charger_following');
  }

  return {
    state: s,
    changed: !sameState(previous, s),
    events: EVENT_ORDER.filter((e) => events.has(e)),
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The stored measurement state of a plan entry, or undefined when it is missing or malformed. */
export function parseMeasureState(value: unknown): PlanMeasureState | undefined {
  if (value == null || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const limitKw = finiteNumber(v['limitKw']);
  if (limitKw == null) return undefined;
  const state: PlanMeasureState = { limitKw };
  for (const key of [
    'lowSinceMs',
    'highSinceMs',
    'taperCapKw',
    'notFollowingKw',
    'slotStartMs',
    'slotFromWh',
    'slotExpectedWh',
    'segmentFromMs',
  ] as const) {
    const n = finiteNumber(v[key]);
    if (n != null) state[key] = n;
  }
  return state;
}
