// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export type JourneyStep = 'plugged' | 'charging' | 'finishing';

// Wait before each next step, in milliseconds: [min, max].
export const JOURNEY_WAIT_MS: Readonly<Record<JourneyStep, readonly [number, number]>> = {
  plugged: [5_000, 30_000],
  charging: [2 * 60_000, 15 * 60_000],
  finishing: [10_000, 60_000],
};

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

// Actions that take the station off its charging path, so its journey ends.
const ENDS_JOURNEY: ReadonlySet<string> = new Set(['unplug', 'injectFault', 'goOffline']);

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
    const step = STEP_AFTER_ACTION[action];
    if (step == null) return;
    const [min, max] = JOURNEY_WAIT_MS[step];
    this.journeys.set(stationId, {
      step,
      dueAt: now + min + Math.floor(this.random() * (max - min)),
    });
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
   * journey goes on to the stop. Any other station left the session path (a
   * fault, an unplug, a stop by an operator), so its journey ends.
   */
  skipDue(stationId: string, action: string, inTransaction: boolean, now: number): void {
    if (action === 'startCharging' && inTransaction) {
      this.record(stationId, 'startCharging', now);
      return;
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
