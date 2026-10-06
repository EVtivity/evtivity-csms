// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { ChaosJourneys, JOURNEY_RETRY_MS, JOURNEY_WAIT_MS } from '../chaos-journey.js';

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

  it('ends a journey that has not started charging on a fault or outage', () => {
    const journeys = new ChaosJourneys(() => 0);
    journeys.record('CS-1', 'plugIn', 0);
    journeys.record('CS-2', 'plugIn', 0);
    journeys.record('CS-1', 'injectFault', 1);
    journeys.record('CS-2', 'goOffline', 1);
    expect(journeys.size).toBe(0);
  });

  it('keeps a charging or finishing journey and its due time through a fault or outage', () => {
    // The simulator keeps the transaction through both (it replays queued
    // TransactionEvents after an outage), so the stop and unplug must still come.
    const journeys = new ChaosJourneys(() => 0);
    journeys.record('CS-1', 'startCharging', 0);
    journeys.record('CS-2', 'startCharging', 0);
    journeys.record('CS-2', 'stopCharging', 0);
    journeys.record('CS-1', 'goOffline', 1);
    journeys.record('CS-1', 'injectFault', 2);
    journeys.record('CS-2', 'injectFault', 1);
    journeys.record('CS-2', 'goOffline', 2);
    expect(journeys.size).toBe(2);
    expect(journeys.nextDue(JOURNEY_WAIT_MS.finishing[0])).toEqual({
      stationId: 'CS-2',
      action: 'unplug',
    });
    expect(journeys.nextDue(JOURNEY_WAIT_MS.charging[0])).toEqual({
      stationId: 'CS-1',
      action: 'stopCharging',
    });
  });

  it('postpones a due stop or unplug that is not possible while a transaction is active', () => {
    const journeys = new ChaosJourneys(() => 0);
    journeys.record('CS-1', 'startCharging', 0);
    journeys.record('CS-2', 'stopCharging', 0);
    const now = JOURNEY_WAIT_MS.charging[0];
    journeys.skipDue('CS-1', 'stopCharging', true, now);
    journeys.skipDue('CS-2', 'unplug', true, now);
    expect(journeys.size).toBe(2);
    expect(journeys.nextDue(now + JOURNEY_RETRY_MS[0] - 1)).toBeNull();
    expect(journeys.nextDue(now + JOURNEY_RETRY_MS[0])).toEqual({
      stationId: 'CS-1',
      action: 'stopCharging',
    });
    journeys.drop('CS-1');
    expect(journeys.nextDue(now + JOURNEY_RETRY_MS[0])).toEqual({
      stationId: 'CS-2',
      action: 'unplug',
    });
  });

  it('goes on to the stop when the station started the transaction itself', () => {
    // An authorize before the plug-in: the plug-in starts the transaction, so
    // startCharging is filtered out when it is due. The session must still end.
    const journeys = new ChaosJourneys(() => 0);
    journeys.record('CS-1', 'plugIn', 0);
    const due = JOURNEY_WAIT_MS.plugged[0];
    expect(journeys.nextDue(due)?.action).toBe('startCharging');

    journeys.skipDue('CS-1', 'startCharging', true, due);
    expect(journeys.nextDue(due + JOURNEY_WAIT_MS.charging[0] - 1)).toBeNull();
    expect(journeys.nextDue(due + JOURNEY_WAIT_MS.charging[0])).toEqual({
      stationId: 'CS-1',
      action: 'stopCharging',
    });
  });

  it('ends the journey when the due step is not possible otherwise', () => {
    const journeys = new ChaosJourneys(() => 0);
    journeys.record('CS-1', 'plugIn', 0);
    journeys.record('CS-2', 'startCharging', 0);
    // A start due on a station without a transaction (unplugged meanwhile).
    journeys.skipDue('CS-1', 'startCharging', false, JOURNEY_WAIT_MS.plugged[0]);
    // A stop due on a station whose transaction an operator already stopped.
    journeys.skipDue('CS-2', 'stopCharging', false, JOURNEY_WAIT_MS.charging[0]);
    expect(journeys.size).toBe(0);
    // An unplug due on a station with no transaction left.
    journeys.record('CS-3', 'stopCharging', 0);
    journeys.skipDue('CS-3', 'unplug', false, JOURNEY_WAIT_MS.finishing[0]);
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
