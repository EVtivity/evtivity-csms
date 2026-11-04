// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  ChaosJourneys,
  DEPOT_LATE_ARRIVAL_SHARE,
  DEPOT_LOW_SOC_SHARE,
  DepotJourneys,
  JOURNEY_RETRY_MS,
  JOURNEY_WAIT_MS,
  depotArrivalSoc,
  depotDepartureAt,
  depotVehicleKey,
  nextDepotArrival,
  type DepotVehicle,
} from '../chaos-journey.js';

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

// Random answers in order; 0.5 once the queue is empty.
function randoms(...values: number[]): () => number {
  const queue = [...values];
  return () => queue.shift() ?? 0.5;
}

const NY = 'America/New_York';
const at = (iso: string): number => Date.parse(iso);

describe('Depot arrival and departure times (site timezone)', () => {
  it('arrives between 19:00 and 23:00 site time on the coming evening', () => {
    // 15:00 in New York (EST, UTC-5): not late, halfway into the window, 21:00.
    expect(nextDepotArrival(at('2026-11-02T20:00:00Z'), NY, randoms(0.5, 0.5))).toBe(
      at('2026-11-03T02:00:00Z'),
    );
    expect(nextDepotArrival(at('2026-11-02T20:00:00Z'), NY, randoms(0.5, 0))).toBe(
      at('2026-11-03T00:00:00Z'),
    );
  });

  it('lets a few vehicles arrive late, between 23:00 and 01:00', () => {
    const late = nextDepotArrival(
      at('2026-11-02T20:00:00Z'),
      NY,
      randoms(DEPOT_LATE_ARRIVAL_SHARE / 2, 0.5),
    );
    expect(late).toBe(at('2026-11-03T05:00:00Z'));
  });

  it('never arrives in the past while the window is open', () => {
    // 21:30 local: a picked 19:00 moves to a time between now and 23:00.
    const now = at('2026-11-03T02:30:00Z');
    expect(nextDepotArrival(now, NY, randoms(0.5, 0, 0.5))).toBe(at('2026-11-03T03:15:00Z'));
  });

  it('waits for the next evening once the late window has passed', () => {
    // 03:00 local: the vehicles left, the next arrivals are tonight.
    expect(nextDepotArrival(at('2026-11-03T08:00:00Z'), NY, randoms(0.5, 0))).toBe(
      at('2026-11-04T00:00:00Z'),
    );
  });

  it('follows the site timezone on a daylight saving change day', () => {
    // Berlin falls back on 2026-10-25: 19:00 that evening is CET, 18:00 UTC.
    expect(nextDepotArrival(at('2026-10-25T10:00:00Z'), 'Europe/Berlin', randoms(0.5, 0))).toBe(
      at('2026-10-25T18:00:00Z'),
    );
  });

  it('departs at the scheduled departure, else at 06:00 site time', () => {
    const arrival = at('2026-11-03T02:00:00Z'); // 21:00 local
    expect(depotDepartureAt(arrival, NY, at('2026-11-03T10:30:00Z'))).toBe(
      at('2026-11-03T10:30:00Z'),
    );
    expect(depotDepartureAt(arrival, NY, null)).toBe(at('2026-11-03T11:00:00Z'));
    // A departure before the arrival is the previous one: the default applies.
    expect(depotDepartureAt(arrival, NY, at('2026-11-02T10:30:00Z'))).toBe(
      at('2026-11-03T11:00:00Z'),
    );
  });

  it('gives a few vehicles a low state of charge', () => {
    expect(depotArrivalSoc(randoms(DEPOT_LOW_SOC_SHARE / 2, 0.5))).toBe(10);
    expect(depotArrivalSoc(randoms(0.5, 0.5))).toBe(45);
  });
});

describe('DepotJourneys', () => {
  const bus: DepotVehicle = {
    idToken: 'BUS-1',
    tokenType: 'ISO14443',
    vehicleId: 'veh_1',
    bodyType: 'bus',
    batteryKwh: 450,
    nextDepartureMs: at('2026-11-03T10:30:00Z'),
  };

  it('plugs a vehicle in at its arrival, charges it until its departure and unplugs it', () => {
    const journeys = new DepotJourneys(randoms(0.5, 0.5));
    const now = at('2026-11-02T20:00:00Z');
    journeys.ensure('CS-D', NY, now);
    const arrival = at('2026-11-03T02:00:00Z');
    expect(journeys.nextDue(arrival - 1)).toBeNull();
    expect(journeys.nextDue(arrival)).toEqual({ stationId: 'CS-D', action: 'plugIn' });

    const departureAt = journeys.arrive('CS-D', bus, arrival);
    expect(departureAt).toBe(bus.nextDepartureMs);
    expect(journeys.vehicleAt('CS-D')).toEqual(bus);
    expect(journeys.heldTokens()).toEqual(new Set(['BUS-1']));

    const start = arrival + JOURNEY_WAIT_MS.plugged[1];
    expect(journeys.nextDue(start)).toEqual({ stationId: 'CS-D', action: 'startCharging' });
    journeys.record('CS-D', 'startCharging', start);
    expect(journeys.nextDue(departureAt - 1)).toBeNull();
    expect(journeys.nextDue(departureAt)).toEqual({ stationId: 'CS-D', action: 'stopCharging' });

    journeys.record('CS-D', 'stopCharging', departureAt);
    const unplugAt = departureAt + JOURNEY_WAIT_MS.finishing[1];
    expect(journeys.nextDue(unplugAt)).toEqual({ stationId: 'CS-D', action: 'unplug' });
    journeys.record('CS-D', 'unplug', unplugAt);
    expect(journeys.heldTokens().size).toBe(0);
    // The bus is out on its route; the next one arrives this evening.
    expect(journeys.nextDue(at('2026-11-03T23:59:00Z'))).toBeNull();
    expect(journeys.nextDue(at('2026-11-04T04:00:00Z'))).toEqual({
      stationId: 'CS-D',
      action: 'plugIn',
    });
  });

  it('schedules each station once and drops stations that are gone', () => {
    const journeys = new DepotJourneys(randoms());
    journeys.ensure('CS-D', NY, at('2026-11-02T20:00:00Z'));
    journeys.ensure('CS-D', NY, at('2026-11-03T01:00:00Z'));
    journeys.ensure('CS-E', NY, at('2026-11-02T20:00:00Z'));
    expect(journeys.size).toBe(2);
    journeys.retain(new Set(['CS-E']));
    expect(journeys.size).toBe(1);
    journeys.drop('CS-E');
    expect(journeys.size).toBe(0);
  });

  it('retries a plug-in, a stop or an unplug that is not possible yet', () => {
    const journeys = new DepotJourneys(randoms(0.5, 0.5));
    const now = at('2026-11-03T02:00:00Z');
    journeys.ensure('CS-D', NY, at('2026-11-02T20:00:00Z'));
    // The bay is taken or faulted: the bus waits.
    journeys.skipDue('CS-D', 'plugIn', false, now);
    expect(journeys.nextDue(now + JOURNEY_RETRY_MS[0] - 1)).toBeNull();
    expect(journeys.nextDue(now + JOURNEY_RETRY_MS[1])?.action).toBe('plugIn');

    journeys.arrive('CS-D', bus, now);
    journeys.record('CS-D', 'startCharging', now);
    const dep = bus.nextDepartureMs as number;
    journeys.skipDue('CS-D', 'stopCharging', true, dep);
    expect(journeys.nextDue(dep + JOURNEY_RETRY_MS[1])?.action).toBe('stopCharging');
    // The transaction ended some other way: the driver still unplugs.
    journeys.skipDue('CS-D', 'stopCharging', false, dep);
    expect(journeys.nextDue(dep)?.action).toBe('unplug');
  });

  it('goes on to the departure when the station started the transaction itself', () => {
    const journeys = new DepotJourneys(randoms(0.5, 0.5));
    const now = at('2026-11-03T02:00:00Z');
    journeys.ensure('CS-D', NY, at('2026-11-02T20:00:00Z'));
    journeys.arrive('CS-D', bus, now);
    journeys.skipDue('CS-D', 'startCharging', true, now + 5_000);
    expect(journeys.nextDue(bus.nextDepartureMs as number)?.action).toBe('stopCharging');
  });

  it('sends a vehicle away when its plug-in left the session path', () => {
    const journeys = new DepotJourneys(randoms(0.5, 0.5));
    const now = at('2026-11-03T02:00:00Z');
    journeys.ensure('CS-D', NY, at('2026-11-02T20:00:00Z'));
    journeys.arrive('CS-D', bus, now);
    // Unplugged by someone else before the start: the bus leaves, the token is free.
    journeys.skipDue('CS-D', 'startCharging', false, now + 5_000);
    expect(journeys.heldTokens().size).toBe(0);
    expect(journeys.nextDue(now + 60_000)).toBeNull();
  });

  it('ends at 06:00 site time a transaction chaos did not start', () => {
    // A remote start or a simulator restart left a session on the station.
    const journeys = new DepotJourneys(randoms(0.5, 0.5));
    const now = at('2026-11-03T02:00:00Z');
    journeys.ensure('CS-D', NY, at('2026-11-02T20:00:00Z'));
    journeys.skipDue('CS-D', 'plugIn', true, now);
    expect(journeys.nextDue(at('2026-11-03T11:00:00Z') - 1)).toBeNull();
    expect(journeys.nextDue(at('2026-11-03T11:00:00Z'))).toEqual({
      stationId: 'CS-D',
      action: 'stopCharging',
    });
  });

  it('stops waiting for a blocked bay once the late period has passed', () => {
    const journeys = new DepotJourneys(randoms(0.5, 0.5));
    journeys.ensure('CS-D', NY, at('2026-11-02T20:00:00Z'));
    // 00:59:50 site time: a retry would fall after 01:00, so the vehicle comes back tomorrow.
    journeys.skipDue('CS-D', 'plugIn', false, at('2026-11-03T05:59:50Z'));
    expect(journeys.nextDue(at('2026-11-03T23:00:00Z'))).toBeNull();
    expect(journeys.nextDue(at('2026-11-04T04:00:00Z'))).toEqual({
      stationId: 'CS-D',
      action: 'plugIn',
    });
  });

  it('holds a vehicle by its id, so another card of it cannot plug in elsewhere', () => {
    const journeys = new DepotJourneys(randoms());
    journeys.ensure('CS-D', NY, at('2026-11-02T20:00:00Z'));
    journeys.arrive('CS-D', bus, at('2026-11-03T02:00:00Z'));
    expect(journeys.heldVehicles()).toEqual(new Set([depotVehicleKey(bus)]));
    expect(depotVehicleKey({ ...bus, idToken: 'BUS-1-SPARE' })).toBe(depotVehicleKey(bus));
    expect(depotVehicleKey({ ...bus, vehicleId: null })).toBe('token:BUS-1');
  });
});
