// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { localDateInZone, scheduleOccurrences } from '@evtivity/lib/departure-schedule';

export type JourneyStep = 'plugged' | 'charging' | 'finishing';

// Wait before each next step, in milliseconds: [min, max].
export const JOURNEY_WAIT_MS: Readonly<Record<JourneyStep, readonly [number, number]>> = {
  plugged: [5_000, 30_000],
  charging: [2 * 60_000, 15 * 60_000],
  finishing: [10_000, 60_000],
};

// Wait before retrying a due stop or unplug that is not possible yet while the
// station still has a transaction, in milliseconds: [min, max].
export const JOURNEY_RETRY_MS: readonly [number, number] = [30_000, 60_000];

const NEXT_ACTION: Readonly<Record<JourneyStep, string>> = {
  plugged: 'startCharging',
  charging: 'stopCharging',
  finishing: 'unplug',
};

const STEP_AFTER_ACTION: Readonly<Record<string, JourneyStep>> = {
  plugIn: 'plugged',
  startCharging: 'charging',
  stopCharging: 'finishing',
};

// The unplug ends the session path, so the journey ends.
const ENDS_JOURNEY: ReadonlySet<string> = new Set(['unplug']);

// A fault or outage ends a journey that has not started charging. The
// simulator keeps a transaction through both (it queues and replays its
// TransactionEvents after an outage), so a charging or finishing journey goes
// on: its stop and unplug still have to come, or the session never ends and
// its driver token stays held.
const INTERRUPTS_JOURNEY: ReadonlySet<string> = new Set(['injectFault', 'goOffline']);

/**
 * Tracks stations chaos plugged in, so a later tick takes them through a whole
 * session (start, stop, unplug) instead of leaving them to random picks.
 */
export class ChaosJourneys {
  private readonly journeys = new Map<string, { step: JourneyStep; dueAt: number }>();

  constructor(private readonly random: () => number = Math.random) {}

  get size(): number {
    return this.journeys.size;
  }

  // Updates the station's journey after chaos sent it an action.
  record(stationId: string, action: string, now: number): void {
    if (ENDS_JOURNEY.has(action)) {
      this.journeys.delete(stationId);
      return;
    }
    if (INTERRUPTS_JOURNEY.has(action)) {
      if (this.journeys.get(stationId)?.step === 'plugged') this.journeys.delete(stationId);
      return;
    }
    const step = STEP_AFTER_ACTION[action];
    if (step == null) return;
    this.journeys.set(stationId, { step, dueAt: this.waitUntil(now, JOURNEY_WAIT_MS[step]) });
  }

  private waitUntil(now: number, [min, max]: readonly [number, number]): number {
    return now + min + Math.floor(this.random() * (max - min));
  }

  // The first station whose next step is due, with that step's action.
  nextDue(now: number): { stationId: string; action: string } | null {
    for (const [stationId, journey] of this.journeys) {
      if (journey.dueAt <= now) return { stationId, action: NEXT_ACTION[journey.step] };
    }
    return null;
  }

  /**
   * The due step's action is not possible in the station's current state. A
   * station already in a transaction when its start is due started it itself
   * (a driver authorized before the plug-in, so the plug-in started it): the
   * journey goes on to the stop. A due stop or unplug on a station that still
   * has a transaction (a fault, a connector state that refuses it for now) is
   * retried later, so the session still ends. A station without a transaction
   * left the session path (an unplug, a stop by an operator), so its journey
   * ends.
   */
  skipDue(stationId: string, action: string, inTransaction: boolean, now: number): void {
    if (inTransaction) {
      if (action === 'startCharging') {
        this.record(stationId, 'startCharging', now);
        return;
      }
      const journey = this.journeys.get(stationId);
      if (journey != null) {
        journey.dueAt = this.waitUntil(now, JOURNEY_RETRY_MS);
        return;
      }
    }
    this.journeys.delete(stationId);
  }

  drop(stationId: string): void {
    this.journeys.delete(stationId);
  }

  retain(liveIds: ReadonlySet<string>): void {
    for (const stationId of [...this.journeys.keys()]) {
      if (!liveIds.has(stationId)) this.journeys.delete(stationId);
    }
  }
}

// ---------------------------------------------------------------------------
// Overnight depot journeys: on a Depot site the fleet's vehicles come back in
// the evening, charge overnight and leave at their departure.
// ---------------------------------------------------------------------------

/** Site-time window (`HH:MM`) in which depot vehicles come back. */
export const DEPOT_ARRIVAL_WINDOW = { from: '19:00', to: '23:00' } as const;
/** Share of arrivals that come late, in the minutes after the window closes. */
export const DEPOT_LATE_ARRIVAL_SHARE = 0.15;
export const DEPOT_LATE_ARRIVAL_MINUTES = 120;
/** Share of vehicles that come back with a low state of charge. */
export const DEPOT_LOW_SOC_SHARE = 0.15;
export const DEPOT_LOW_SOC_PERCENT: readonly [number, number] = [5, 15];
export const DEPOT_SOC_PERCENT: readonly [number, number] = [30, 60];
/** Site-time departure of a vehicle without a scheduled departure. */
export const DEPOT_DEFAULT_DEPARTURE = '06:00';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

/** The instants of a site-time `HH:MM` on the local days around `nearMs`, in order. */
function localTimes(nearMs: number, timeZone: string, time: string): number[] {
  const from = localDateInZone(nearMs - DAY_MS, timeZone);
  return scheduleOccurrences({ daysOfWeek: EVERY_DAY, departureTime: time }, timeZone, from, 4).map(
    (o) => o.departureAtMs,
  );
}

/**
 * When the next depot vehicle comes back: a random time between 19:00 and
 * 23:00 site time on the coming evening, or for a few vehicles in the two
 * hours after 23:00. Never before `nowMs`.
 */
export function nextDepotArrival(
  nowMs: number,
  timeZone: string,
  random: () => number = Math.random,
): number {
  const starts = localTimes(nowMs, timeZone, DEPOT_ARRIVAL_WINDOW.from);
  const ends = localTimes(nowMs, timeZone, DEPOT_ARRIVAL_WINDOW.to);
  const lateMs = DEPOT_LATE_ARRIVAL_MINUTES * MINUTE_MS;
  const late = random() < DEPOT_LATE_ARRIVAL_SHARE;
  const windows = starts.map((start, i): [number, number] => {
    const end = ends[i] ?? start;
    return late ? [end, end + lateMs] : [start, end];
  });
  const [from, to] = windows.find(([, end]) => end > nowMs) ?? [nowMs, nowMs];
  const picked = from + Math.floor(random() * (to - from));
  if (picked >= nowMs) return picked;
  // The window is already open: spread the arrival over what is left of it.
  return nowMs + Math.floor(random() * Math.max(0, to - nowMs));
}

/** The end of the late period after the arrival window an arrival at `arrivalMs` belongs to. */
export function depotArrivalDeadline(arrivalMs: number, timeZone: string): number {
  const lateMs = DEPOT_LATE_ARRIVAL_MINUTES * MINUTE_MS;
  const end = localTimes(arrivalMs, timeZone, DEPOT_ARRIVAL_WINDOW.to).find(
    (t) => t + lateMs >= arrivalMs,
  );
  return (end ?? arrivalMs) + lateMs;
}

/** The key of one vehicle: its id, else its card (a card without a known vehicle). */
export function depotVehicleKey(vehicle: DepotVehicle): string {
  return vehicle.vehicleId ?? `token:${vehicle.idToken}`;
}

/** When a vehicle that arrived at `arrivalMs` leaves: its scheduled departure, else 06:00 site time. */
export function depotDepartureAt(
  arrivalMs: number,
  timeZone: string,
  scheduledMs: number | null,
): number {
  if (scheduledMs != null && scheduledMs > arrivalMs) return scheduledMs;
  return (
    localTimes(arrivalMs, timeZone, DEPOT_DEFAULT_DEPARTURE).find((t) => t > arrivalMs) ??
    arrivalMs + DAY_MS
  );
}

/** State of charge (whole percent) a depot vehicle comes back with. */
export function depotArrivalSoc(random: () => number = Math.random): number {
  const [min, max] = random() < DEPOT_LOW_SOC_SHARE ? DEPOT_LOW_SOC_PERCENT : DEPOT_SOC_PERCENT;
  return Math.round(min + random() * (max - min));
}

/** A fleet vehicle that charges at a depot station, with the card it starts with. */
export interface DepotVehicle {
  idToken: string;
  tokenType: string;
  vehicleId: string | null;
  bodyType: string | null;
  batteryKwh: number | null;
  /** Its next scheduled departure from the depot, if any. */
  nextDepartureMs: number | null;
}

type DepotStep = 'away' | 'plugged' | 'charging' | 'finishing';

const DEPOT_NEXT_ACTION: Readonly<Record<DepotStep, string>> = {
  away: 'plugIn',
  plugged: 'startCharging',
  charging: 'stopCharging',
  finishing: 'unplug',
};

interface DepotJourney {
  step: DepotStep;
  dueAt: number;
  /** While away: after this the vehicle no longer waits for a blocked bay. */
  arrivalDeadline: number | null;
  timeZone: string;
  vehicle: DepotVehicle | null;
  departureAt: number | null;
}

/**
 * Tracks each depot station through the night: a vehicle arrives and plugs in
 * between 19:00 and 23:00 site time (a few late, a few with a low state of
 * charge), starts charging, stays until its departure, then stops and unplugs;
 * the next vehicle comes back the next evening.
 */
export class DepotJourneys {
  private readonly journeys = new Map<string, DepotJourney>();

  constructor(private readonly random: () => number = Math.random) {}

  get size(): number {
    return this.journeys.size;
  }

  /** Starts tracking a depot station: its first vehicle comes back this evening. */
  ensure(stationId: string, timeZone: string, now: number): void {
    const journey = this.journeys.get(stationId);
    if (journey != null) {
      journey.timeZone = timeZone;
      return;
    }
    this.journeys.set(stationId, this.away(now, timeZone));
  }

  nextDue(now: number): { stationId: string; action: string } | null {
    for (const [stationId, journey] of this.journeys) {
      if (journey.dueAt <= now) return { stationId, action: DEPOT_NEXT_ACTION[journey.step] };
    }
    return null;
  }

  /** The vehicle plugged in at the station, if any. */
  vehicleAt(stationId: string): DepotVehicle | null {
    return this.journeys.get(stationId)?.vehicle ?? null;
  }

  /** The cards of the vehicles at a depot station now, so no other station uses them. */
  heldTokens(): Set<string> {
    const held = new Set<string>();
    for (const journey of this.journeys.values()) {
      if (journey.vehicle != null) held.add(journey.vehicle.idToken);
    }
    return held;
  }

  /** The vehicles at a depot station now (`depotVehicleKey`), so none plugs in at two stations. */
  heldVehicles(): Set<string> {
    const held = new Set<string>();
    for (const journey of this.journeys.values()) {
      if (journey.vehicle != null) held.add(depotVehicleKey(journey.vehicle));
    }
    return held;
  }

  /** A vehicle plugged in: it charges until its departure, which this returns. */
  arrive(stationId: string, vehicle: DepotVehicle, now: number): number {
    const timeZone = this.journeys.get(stationId)?.timeZone ?? 'UTC';
    const departureAt = depotDepartureAt(now, timeZone, vehicle.nextDepartureMs);
    this.journeys.set(stationId, {
      step: 'plugged',
      dueAt: this.waitUntil(now, JOURNEY_WAIT_MS.plugged),
      arrivalDeadline: null,
      timeZone,
      vehicle,
      departureAt,
    });
    return departureAt;
  }

  /** Moves the station on after chaos sent it a start, stop or unplug. */
  record(stationId: string, action: string, now: number): void {
    const journey = this.journeys.get(stationId);
    if (journey == null) return;
    if (action === 'startCharging') {
      journey.step = 'charging';
      journey.dueAt = Math.max(now, journey.departureAt ?? now);
    } else if (action === 'stopCharging') {
      journey.step = 'finishing';
      journey.dueAt = this.waitUntil(now, JOURNEY_WAIT_MS.finishing);
    } else if (action === 'unplug') {
      this.leave(stationId, journey, now);
    }
  }

  /**
   * The due step is not possible in the station's current state. A plug-in on
   * a station already in a transaction (one chaos did not start: a remote
   * start, a simulator restart) charges that session until 06:00 site time; a
   * plug-in on a blocked bay waits until the late period ends, then the next
   * vehicle comes back the next evening. A start the station already made goes
   * on to the departure, and a stop or unplug still running a transaction is
   * retried. A vehicle whose session left the path some other way leaves: a
   * stop without a transaction goes on to the unplug, an unplug or start
   * without one sends the vehicle away until the next evening.
   */
  skipDue(stationId: string, action: string, inTransaction: boolean, now: number): void {
    const journey = this.journeys.get(stationId);
    if (journey == null) return;
    if (action === 'plugIn' && inTransaction) {
      const departureAt = depotDepartureAt(now, journey.timeZone, null);
      this.journeys.set(stationId, {
        step: 'charging',
        dueAt: departureAt,
        arrivalDeadline: null,
        timeZone: journey.timeZone,
        vehicle: null,
        departureAt,
      });
      return;
    }
    if (action === 'plugIn') {
      const retryAt = this.waitUntil(now, JOURNEY_RETRY_MS);
      if (journey.arrivalDeadline != null && retryAt > journey.arrivalDeadline) {
        this.journeys.set(stationId, this.away(now, journey.timeZone));
      } else {
        journey.dueAt = retryAt;
      }
      return;
    }
    if (inTransaction && action !== 'startCharging') {
      journey.dueAt = this.waitUntil(now, JOURNEY_RETRY_MS);
      return;
    }
    if (action === 'startCharging' && inTransaction) {
      this.record(stationId, 'startCharging', now);
      return;
    }
    if (action === 'stopCharging') {
      journey.step = 'finishing';
      journey.dueAt = now;
      return;
    }
    this.leave(stationId, journey, now);
  }

  drop(stationId: string): void {
    this.journeys.delete(stationId);
  }

  retain(liveIds: ReadonlySet<string>): void {
    for (const stationId of [...this.journeys.keys()]) {
      if (!liveIds.has(stationId)) this.journeys.delete(stationId);
    }
  }

  private leave(stationId: string, journey: DepotJourney, now: number): void {
    this.journeys.set(stationId, this.away(now, journey.timeZone));
  }

  private away(now: number, timeZone: string): DepotJourney {
    const dueAt = nextDepotArrival(now, timeZone, this.random);
    return {
      step: 'away',
      dueAt,
      arrivalDeadline: depotArrivalDeadline(dueAt, timeZone),
      timeZone,
      vehicle: null,
      departureAt: null,
    };
  }

  private waitUntil(now: number, [min, max]: readonly [number, number]): number {
    return now + min + Math.floor(this.random() * (max - min));
  }
}
