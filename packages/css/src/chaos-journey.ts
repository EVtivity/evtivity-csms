// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

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
