// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({
  db: {},
  evChargingNeeds: {},
  stationConfigurations: {},
  isOperatorStation: vi.fn(),
}));

import {
  MEASURE_WINDOW_MS,
  PROFILE_SETTLE_MS,
  evaluatePlanMeasurement,
  parseMeasureState,
  type PlanMeasureReading,
  type PlanMeasureState,
} from '../charging-plan-measurement.js';
import {
  measurePlannedSessions,
  plannedSessionDrawKw,
  profileSettled,
  withNotFollowingDraws,
  type StoredPlanEntry,
} from '../charging-plan.service.js';
import type { StationPowerInfo } from '../load-management.service.js';
import type { PlanSessionRow } from '@evtivity/database';

const SLOT = 15 * 60_000;
const T0 = Date.UTC(2026, 10, 2, 1, 0, 0);
const CYCLE = 10_000;
/** Readings 10 s apart that span the one-minute window (the first and the last included). */
const WINDOW_READINGS = MEASURE_WINDOW_MS / CYCLE + 1;

function reading(overrides: Partial<PlanMeasureReading> = {}): PlanMeasureReading {
  return {
    limitKw: 20,
    drawKw: 20,
    energyWh: 0,
    slotStartMs: T0,
    minKw: 0,
    profileSettled: true,
    ...overrides,
  };
}

/** Runs one reading per cycle and returns the last state and every event. */
function run(
  readings: PlanMeasureReading[],
  start?: PlanMeasureState,
  fromMs = T0,
): { state: PlanMeasureState | undefined; events: string[][] } {
  let state = start;
  const events: string[][] = [];
  readings.forEach((r, i) => {
    const out = evaluatePlanMeasurement(state, r, fromMs + i * CYCLE);
    state = out.state;
    events.push(out.events);
  });
  return { state, events };
}

describe('evaluatePlanMeasurement: taper', () => {
  it('caps the session at its draw plus 10 % after a minute under 80 % of its limit', () => {
    const { state, events } = run(
      Array.from({ length: WINDOW_READINGS }, () => reading({ drawKw: 12 })),
    );
    expect(events.slice(0, WINDOW_READINGS - 1).flat()).toEqual([]);
    expect(events[WINDOW_READINGS - 1]).toEqual(['taper']);
    expect(state?.taperCapKw).toBeCloseTo(13.2);
  });

  it('counts the minute from the first low reading, whatever the cycle count', () => {
    // Two readings a minute apart (a cycle that ran late) are enough.
    const first = evaluatePlanMeasurement(undefined, reading({ drawKw: 12 }), T0);
    expect(first.state.lowSinceMs).toBe(T0);
    const late = evaluatePlanMeasurement(
      first.state,
      reading({ drawKw: 12 }),
      T0 + MEASURE_WINDOW_MS,
    );
    expect(late.events).toEqual(['taper']);
  });

  it('starts the minute again when the draw recovers in between', () => {
    const low = reading({ drawKw: 12 });
    const { state, events } = run([low, low, low, low, low, reading({ drawKw: 19 }), low, low]);
    expect(events.flat()).toEqual([]);
    expect(state?.lowSinceMs).toBe(T0 + 6 * CYCLE);
    expect(state?.taperCapKw).toBeUndefined();
  });

  it('starts the minute again when the limit changes', () => {
    const { state } = run([
      reading({ drawKw: 12 }),
      reading({ drawKw: 12 }),
      reading({ drawKw: 12, limitKw: 22 }),
    ]);
    expect(state?.lowSinceMs).toBe(T0 + 2 * CYCLE);
  });

  it('measures nothing until the station accepted the profile and it settled', () => {
    const unsettled = run(
      Array.from({ length: WINDOW_READINGS + 2 }, () =>
        reading({ drawKw: 12, profileSettled: false }),
      ),
    );
    expect(unsettled.events.flat()).toEqual([]);
    expect(unsettled.state?.lowSinceMs).toBeUndefined();
  });

  it('removes the cap once the draw reaches it again', () => {
    const capped: PlanMeasureState = {
      limitKw: 13.2,
      taperCapKw: 13.2,
      slotStartMs: T0,
      slotFromWh: 0,
      slotExpectedWh: 0,
      segmentFromMs: T0,
    };
    const below = evaluatePlanMeasurement(capped, reading({ limitKw: 13.2, drawKw: 12 }), T0);
    expect(below.events).toEqual([]);
    const reached = evaluatePlanMeasurement(capped, reading({ limitKw: 13.2, drawKw: 13.3 }), T0);
    expect(reached.events).toEqual(['taper_ended']);
    expect(reached.state.taperCapKw).toBeUndefined();
  });

  it('never caps below the session minimum or 1 kW, so a paused EV is not planned at 0', () => {
    const paused = run(Array.from({ length: WINDOW_READINGS }, () => reading({ drawKw: 0 })));
    expect(paused.state?.taperCapKw).toBe(1);
    const ac = run(
      Array.from({ length: WINDOW_READINGS }, () => reading({ drawKw: 0, minKw: 4.14 })),
    );
    expect(ac.state?.taperCapKw).toBe(4.14);
  });

  it('counts nothing at a limit of 0 or without a reading', () => {
    const zero = run(Array.from({ length: 8 }, () => reading({ limitKw: 0, drawKw: 0 })));
    expect(zero.events.flat()).toEqual([]);
    const none = run(Array.from({ length: 8 }, () => reading({ drawKw: null })));
    expect(none.events.flat()).toEqual([]);
    expect(none.state?.lowSinceMs).toBeUndefined();
  });
});

describe('evaluatePlanMeasurement: charger not following', () => {
  it('flags a draw above the limit plus 5 % for a minute, once', () => {
    const over = reading({ drawKw: 22 });
    const { state, events } = run(Array.from({ length: WINDOW_READINGS + 2 }, () => over));
    expect(events.flat()).toEqual(['charger_not_following']);
    expect(events[WINDOW_READINGS - 1]).toEqual(['charger_not_following']);
    expect(state?.notFollowingKw).toBe(22);
  });

  it('allows the limit plus 5 %, and a small absolute margin at a low limit', () => {
    expect(run(Array.from({ length: 8 }, () => reading({ drawKw: 20.9 }))).events.flat()).toEqual(
      [],
    );
    expect(
      run(Array.from({ length: 8 }, () => reading({ limitKw: 1, drawKw: 1.15 }))).events.flat(),
    ).toEqual([]);
  });

  it('clears the flag as soon as the draw is back within the limit', () => {
    const flagged = run(
      Array.from({ length: WINDOW_READINGS }, () => reading({ drawKw: 25 })),
    ).state;
    const out = evaluatePlanMeasurement(flagged, reading({ drawKw: 19 }), T0 + 60 * CYCLE);
    expect(out.events).toEqual(['charger_following']);
    expect(out.state.notFollowingKw).toBeUndefined();
  });
});

describe('evaluatePlanMeasurement: behind plan', () => {
  it('flags a slot that delivered more than 0.5 kWh less than planned', () => {
    const first = evaluatePlanMeasurement(undefined, reading({ energyWh: 1000 }), T0);
    // 20 kW for a quarter hour plans 5 kWh; 4 kWh were delivered.
    const end = evaluatePlanMeasurement(
      first.state,
      reading({ energyWh: 5000, slotStartMs: T0 + SLOT }),
      T0 + SLOT + CYCLE,
    );
    expect(end.events).toEqual(['behind_plan']);
    expect(end.state.slotFromWh).toBe(5000);
    expect(end.state.slotStartMs).toBe(T0 + SLOT);
  });

  it('accepts a shortfall within the larger of 0.5 kWh and 10 %', () => {
    const first = evaluatePlanMeasurement(undefined, reading({ energyWh: 0 }), T0);
    const end = evaluatePlanMeasurement(
      first.state,
      reading({ energyWh: 4600, slotStartMs: T0 + SLOT }),
      T0 + SLOT,
    );
    expect(end.events).toEqual([]);
  });

  it('counts the planned energy of each limit for the time it held', () => {
    // 20 kW for 5 minutes, then 8 kW for 10 minutes: 1.667 + 1.333 = 3 kWh planned.
    let s = evaluatePlanMeasurement(undefined, reading({ energyWh: 0 }), T0).state;
    s = evaluatePlanMeasurement(
      s,
      reading({ limitKw: 8, drawKw: 8, energyWh: 1700 }),
      T0 + 300_000,
    ).state;
    const end = evaluatePlanMeasurement(
      s,
      reading({ limitKw: 8, drawKw: 8, energyWh: 2800, slotStartMs: T0 + SLOT }),
      T0 + SLOT,
    );
    expect(end.events).toEqual([]);
    const short = evaluatePlanMeasurement(
      s,
      reading({ limitKw: 8, drawKw: 8, energyWh: 2300, slotStartMs: T0 + SLOT }),
      T0 + SLOT,
    );
    expect(short.events).toEqual(['behind_plan']);
  });

  it('reports no change for a reading that changes nothing', () => {
    const first = evaluatePlanMeasurement(undefined, reading(), T0);
    expect(first.changed).toBe(true);
    expect(evaluatePlanMeasurement(first.state, reading(), T0 + CYCLE).changed).toBe(false);
  });
});

describe('parseMeasureState', () => {
  it('reads a stored state and drops a malformed one', () => {
    expect(parseMeasureState({ limitKw: 5, lowSinceMs: 9, taperCapKw: 4, lowCycles: 1 })).toEqual({
      limitKw: 5,
      lowSinceMs: 9,
      taperCapKw: 4,
    });
    expect(parseMeasureState({ limitKw: '5' })).toBeUndefined();
    expect(parseMeasureState(null)).toBeUndefined();
  });
});

const station: StationPowerInfo = {
  id: 'sta_a',
  stationId: 'DEPOT-01',
  circuitId: 'cir_a',
  currentDrawKw: 30,
  phasePowerKw: null,
  maxPowerKw: 50,
  loadPriority: 5,
  isOnline: true,
  hasActiveSession: true,
  departureTime: null,
  minPowerKw: 0,
  rateUnit: 'W',
  profileId: 1_000_000_000,
  evseDrawKw: { evs_1: 12 },
  drawMeasured: true,
};

const session: PlanSessionRow = {
  id: 'ses_1',
  stationDbId: 'sta_a',
  evseDbId: 'evs_1',
  vehicleId: 'veh_1',
  transactionId: 'tx-1',
  energyDeliveredWh: 0,
  lastSocPercent: null,
  lastSocAt: null,
  evseMaxKw: 50,
  acCharging: false,
  evseNumber: 1,
};

const entry: StoredPlanEntry = {
  departureId: 'vdp_1',
  vehicleId: 'veh_1',
  sessionId: 'ses_1',
  stationDbId: 'sta_a',
  evseDbId: 'evs_1',
  minKw: 0,
  powerKw: [20, 20],
  profile: {
    id: 1,
    hash: 'h',
    slotStartMs: T0,
    state: 'accepted',
    sentAt: new Date(T0 - 120_000).toISOString(),
    repliedAt: new Date(T0 - PROFILE_SETTLE_MS - 1000).toISOString(),
  },
};

describe('profileSettled', () => {
  it('holds once the station accepted the profile and the settle time passed', () => {
    expect(profileSettled(entry.profile, T0)).toBe(true);
    const fresh = { ...entry.profile!, repliedAt: new Date(T0 - 1000).toISOString() };
    expect(profileSettled(fresh, T0)).toBe(false);
    expect(profileSettled({ ...entry.profile!, state: 'sent' }, T0)).toBe(false);
    expect(profileSettled({ ...entry.profile!, state: 'rejected' }, T0)).toBe(false);
    expect(profileSettled(undefined, T0)).toBe(false);
  });
});

describe('plannedSessionDrawKw', () => {
  it('reads the EVSE, else the station when the session is alone there', () => {
    expect(plannedSessionDrawKw(station, session, 2)).toBe(12);
    const noEvse = { ...station, evseDrawKw: {} };
    expect(plannedSessionDrawKw(noEvse, session, 1)).toBe(30);
    expect(plannedSessionDrawKw(noEvse, session, 2)).toBeNull();
    expect(plannedSessionDrawKw({ ...noEvse, drawMeasured: false }, session, 1)).toBeNull();
  });
});

describe('measurePlannedSessions', () => {
  const input = {
    entries: [entry],
    slotIndex: 0,
    sessions: [session],
    stations: [station],
    reservedKw: new Map<string, number>(),
    nowMs: T0,
  };

  it('measures each planned session against its slot power', () => {
    const out = measurePlannedSessions(input);
    expect(out.measures.get('ses_1')).toMatchObject({ limitKw: 20, lowSinceMs: T0 });
    expect(out.changed).toHaveLength(1);
  });

  it('starts no window before the station accepted the profile', () => {
    const withoutProfile: StoredPlanEntry = { ...entry };
    delete withoutProfile.profile;
    const out = measurePlannedSessions({ ...input, entries: [withoutProfile] });
    expect(out.measures.get('ses_1')?.lowSinceMs).toBeUndefined();
  });

  it('never measures an entry kept only to clear its profile', () => {
    const out = measurePlannedSessions({ ...input, entries: [{ ...entry, left: true }] });
    expect(out.measures.size).toBe(0);
  });

  it('measures no offline or reserved station, ended session or uncovered slot', () => {
    expect(
      measurePlannedSessions({ ...input, stations: [{ ...station, isOnline: false }] }).measures
        .size,
    ).toBe(0);
    expect(
      measurePlannedSessions({ ...input, reservedKw: new Map([['sta_a', 50]]) }).measures.size,
    ).toBe(0);
    expect(measurePlannedSessions({ ...input, sessions: [] }).measures.size).toBe(0);
    expect(measurePlannedSessions({ ...input, slotIndex: -1 }).measures.size).toBe(0);
  });

  it('names the session, station and event that changed the plan', () => {
    let entries = [entry];
    let events: unknown[] = [];
    for (let i = 0; i < WINDOW_READINGS; i += 1) {
      const out = measurePlannedSessions({ ...input, entries, nowMs: T0 + i * CYCLE });
      const measure = out.measures.get('ses_1');
      entries = [measure != null ? { ...entry, measure } : entry];
      events = out.events;
    }
    expect(events).toEqual([
      { sessionId: 'ses_1', stationDbId: 'sta_a', event: 'taper', drawKw: 12, limitKw: 20 },
    ]);
  });
});

describe('withNotFollowingDraws', () => {
  it('holds the measured draw of a session that does not follow as fixed load', () => {
    const measure: PlanMeasureState = { limitKw: 20, notFollowingKw: 26 };
    const reserved = withNotFollowingDraws(
      new Map([['sta_b', 7]]),
      [entry],
      new Map([['ses_1', measure]]),
    );
    expect(reserved).toEqual(
      new Map([
        ['sta_b', 7],
        ['sta_a', 26],
      ]),
    );
    expect(withNotFollowingDraws(new Map(), [entry], new Map()).size).toBe(0);
  });
});
