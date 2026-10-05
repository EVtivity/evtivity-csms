// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { ChaosJourneys, JOURNEY_WAIT_MS } from '../chaos-journey.js';

describe('ChaosJourneys', () => {
  it('takes a plugged-in station through start, stop and unplug', () => {
    const journeys = new ChaosJourneys(() => 0);
    journeys.record('CS-1', 'plugIn', 0);
    expect(journeys.nextDue(JOURNEY_WAIT_MS.plugged[0] - 1)).toBeNull();

    let now = JOURNEY_WAIT_MS.plugged[0];
    expect(journeys.nextDue(now)).toEqual({ stationId: 'CS-1', action: 'startCharging' });

    journeys.record('CS-1', 'startCharging', now);
    now += JOURNEY_WAIT_MS.charging[0];
    expect(journeys.nextDue(now)).toEqual({ stationId: 'CS-1', action: 'stopCharging' });

    journeys.record('CS-1', 'stopCharging', now);
    now += JOURNEY_WAIT_MS.finishing[0];
    expect(journeys.nextDue(now)).toEqual({ stationId: 'CS-1', action: 'unplug' });

    journeys.record('CS-1', 'unplug', now);
    expect(journeys.size).toBe(0);
  });

  it('waits up to the maximum of the range', () => {
    const journeys = new ChaosJourneys(() => 0.999999);
    journeys.record('CS-1', 'startCharging', 0);
    expect(journeys.nextDue(JOURNEY_WAIT_MS.charging[1] - 2)).toBeNull();
    expect(journeys.nextDue(JOURNEY_WAIT_MS.charging[1])).toEqual({
      stationId: 'CS-1',
      action: 'stopCharging',
    });
  });

  it('starts a journey from a random startCharging too', () => {
    const journeys = new ChaosJourneys(() => 0);
    journeys.record('CS-1', 'startCharging', 0);
    expect(journeys.nextDue(JOURNEY_WAIT_MS.charging[0])?.action).toBe('stopCharging');
  });

  it('ends the journey on a fault or outage', () => {
    const journeys = new ChaosJourneys(() => 0);
    journeys.record('CS-1', 'plugIn', 0);
    journeys.record('CS-2', 'plugIn', 0);
    journeys.record('CS-1', 'injectFault', 1);
    journeys.record('CS-2', 'goOffline', 1);
    expect(journeys.size).toBe(0);
  });

  it('ignores actions that are not session steps', () => {
    const journeys = new ChaosJourneys(() => 0);
    journeys.record('CS-1', 'sendHeartbeat', 0);
    expect(journeys.size).toBe(0);
    journeys.record('CS-1', 'plugIn', 0);
    journeys.record('CS-1', 'sendMeterValues', 1);
    expect(journeys.nextDue(JOURNEY_WAIT_MS.plugged[0])?.action).toBe('startCharging');
  });

  it('drops stations that are gone and keeps the rest', () => {
    const journeys = new ChaosJourneys(() => 0);
    journeys.record('CS-1', 'plugIn', 0);
    journeys.record('CS-2', 'plugIn', 0);
    journeys.retain(new Set(['CS-2']));
    expect(journeys.size).toBe(1);
    journeys.drop('CS-2');
    expect(journeys.nextDue(Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});
