// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Edge cases of the depot planner helpers: held depot requests, the planned
// cut check, preconditioning windows and their slot draw, and the stored slot
// lookups.

import { describe, expect, it, vi } from 'vitest';
import type { PlanDepartureRow, PlanSessionRow } from '@evtivity/database';

vi.mock('@evtivity/database', () => ({
  db: {},
  isOperatorStation: vi.fn(),
}));

const {
  automaticPreconditioningWindow,
  batteryPreconditioningWindow,
  bindDepartures,
  plannedSessionDrawKw,
  plannedStationCut,
  preconditioningAuxKw,
  storedSlotIndex,
  storedSlots,
  withRejectedProfiles,
} = await import('../charging-plan.service.js');

const NOW = Date.UTC(2026, 10, 2, 1, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

function departure(overrides: Partial<PlanDepartureRow> & { id: string }): PlanDepartureRow {
  return {
    vehicleId: 'veh_1',
    departureAt: new Date(NOW + 6 * HOUR),
    targetKind: 'energy',
    targetEnergyKwh: 40,
    targetSocPercent: null,
    priority: 5,
    sessionId: null,
    batteryCapacityKwh: null,
    maxChargePowerKw: null,
    ...overrides,
  };
}

function session(overrides: Partial<PlanSessionRow> & { id: string }): PlanSessionRow {
  return {
    stationDbId: 'sta_a',
    evseDbId: 'evs_a1',
    vehicleId: 'veh_1',
    transactionId: 'tx-1',
    energyDeliveredWh: 0,
    lastSocPercent: null,
    lastSocAt: null,
    evseMaxKw: 22,
    acCharging: false,
    evseNumber: 1,
    ...overrides,
  };
}

const noPreconditioning = {
  climate: null,
  startAt: null,
  finishAt: null,
  hvacStartAt: null,
  hvacKw: null,
  systemStartAt: null,
  systemKw: null,
};

describe('bindDepartures with a held request', () => {
  it('keeps the held session whatever its vehicle and writes no binding', () => {
    const held = departure({ id: 'dep_h', sessionId: 'ses_1', held: true, vehicleId: 'veh_x' });
    const out = bindDepartures([held], [session({ id: 'ses_1' })], NOW);
    expect(out.sessions.get('dep_h')?.id).toBe('ses_1');
    expect(out.writes).toEqual([]);
  });

  it('does not bind a held request whose session ended or another took', () => {
    const first = departure({ id: 'dep_a', sessionId: 'ses_1', held: true });
    const second = departure({ id: 'dep_b', sessionId: 'ses_1', held: true });
    const gone = departure({ id: 'dep_c', sessionId: 'ses_gone', held: true });
    const out = bindDepartures([first, second, gone], [session({ id: 'ses_1' })], NOW);
    expect([...out.sessions.keys()]).toEqual(['dep_a']);
    expect(out.writes).toEqual([]);
  });

  it('never binds a free session to a held request', () => {
    const held = departure({ id: 'dep_h', sessionId: null, held: true });
    const out = bindDepartures([held], [session({ id: 'ses_1' })], NOW);
    expect(out.sessions.size).toBe(0);
  });

  it('unbinds a departure whose session another departure already took', () => {
    const a = departure({ id: 'dep_a', sessionId: 'ses_1' });
    const b = departure({ id: 'dep_b', sessionId: 'ses_1' });
    const out = bindDepartures([a, b], [session({ id: 'ses_1' })], NOW);
    expect(out.sessions.get('dep_a')?.id).toBe('ses_1');
    expect(out.writes).toEqual([{ departureId: 'dep_b', sessionId: null }]);
  });
});

describe('plannedStationCut', () => {
  it('is true only when an allocation falls below the planned power', () => {
    const planned = new Map([
      ['sta_a', 50],
      ['sta_b', 20],
    ]);
    const near = [
      { stationDbId: 'sta_a', allocatedKw: 49.99 },
      { stationDbId: 'sta_b', allocatedKw: 20 },
    ];
    expect(plannedStationCut(near as never, planned)).toBe(false);
    const cut = [{ stationDbId: 'sta_a', allocatedKw: 30 }];
    expect(plannedStationCut(cut as never, planned)).toBe(true);
    expect(plannedStationCut([], planned)).toBe(false);
  });
});

describe('automaticPreconditioningWindow', () => {
  it('is null without preconditioning or without a climate request', () => {
    expect(automaticPreconditioningWindow(departure({ id: 'd' }), NOW)).toBeNull();
    expect(
      automaticPreconditioningWindow(
        departure({ id: 'd', preconditioning: noPreconditioning }),
        NOW,
      ),
    ).toBeNull();
  });

  it('runs the vehicle minutes (30 by default) before the departure', () => {
    const d = departure({
      id: 'd',
      preconditioning: { ...noPreconditioning, climate: 'heat' },
    });
    const at = NOW + 6 * HOUR;
    expect(automaticPreconditioningWindow(d, NOW)).toEqual({ fromMs: at - 30 * MIN, toMs: at });
    expect(automaticPreconditioningWindow({ ...d, preconditioningMinutes: 45 }, NOW)).toEqual({
      fromMs: at - 45 * MIN,
      toMs: at,
    });
  });

  it('uses the requested start and finish, and is null when they do not form a window', () => {
    const startAt = new Date(NOW + HOUR);
    const finishAt = new Date(NOW + 2 * HOUR);
    const d = departure({
      id: 'd',
      preconditioning: { ...noPreconditioning, climate: 'cool', startAt, finishAt },
    });
    expect(automaticPreconditioningWindow(d, NOW)).toEqual({
      fromMs: startAt.getTime(),
      toMs: finishAt.getTime(),
    });
    const backwards = departure({
      id: 'd',
      preconditioning: {
        ...noPreconditioning,
        climate: 'cool',
        startAt: finishAt,
        finishAt: startAt,
      },
    });
    expect(automaticPreconditioningWindow(backwards, NOW)).toBeNull();
  });

  it('plans an ad hoc departure to the ad hoc horizon', () => {
    const d = departure({
      id: 'd',
      departureAt: null,
      preconditioning: { ...noPreconditioning, climate: 'heat' },
    });
    const end = NOW + 24 * HOUR;
    expect(automaticPreconditioningWindow(d, NOW)).toEqual({ fromMs: end - 30 * MIN, toMs: end });
  });
});

describe('batteryPreconditioningWindow', () => {
  it('is null for a held request and without any preconditioning', () => {
    expect(
      batteryPreconditioningWindow(
        departure({
          id: 'd',
          held: true,
          preconditioning: { ...noPreconditioning, climate: 'heat' },
        }),
        NOW,
      ),
    ).toBeNull();
    expect(batteryPreconditioningWindow(departure({ id: 'd' }), NOW)).toBeNull();
  });

  it('falls back to the manual system start, and is null for a start after the departure', () => {
    const systemStartAt = new Date(NOW + 5 * HOUR);
    const d = departure({ id: 'd', preconditioning: { ...noPreconditioning, systemStartAt } });
    expect(batteryPreconditioningWindow(d, NOW)).toEqual({
      fromMs: systemStartAt.getTime(),
      toMs: NOW + 6 * HOUR,
    });
    const late = departure({
      id: 'd',
      preconditioning: { ...noPreconditioning, systemStartAt: new Date(NOW + 7 * HOUR) },
    });
    expect(batteryPreconditioningWindow(late, NOW)).toBeNull();
  });
});

describe('preconditioningAuxKw', () => {
  const slots = [
    { startMs: NOW + 5 * HOUR, endMs: NOW + 5.5 * HOUR },
    { startMs: NOW + 5.5 * HOUR, endMs: NOW + 6 * HOUR },
    { startMs: NOW + 6 * HOUR, endMs: NOW + 6 * HOUR },
  ];

  it('is undefined without preconditioning or with no window that draws', () => {
    expect(preconditioningAuxKw(departure({ id: 'd' }), slots as never, NOW)).toBeUndefined();
    const zero = departure({
      id: 'd',
      preconditioning: {
        ...noPreconditioning,
        hvacStartAt: new Date(NOW),
        hvacKw: 0,
        systemStartAt: new Date(NOW),
        systemKw: null,
      },
    });
    expect(preconditioningAuxKw(zero, slots as never, NOW)).toBeUndefined();
  });

  it('averages each window over the slot it overlaps', () => {
    const d = departure({
      id: 'd',
      preconditioningPowerKw: 4,
      preconditioning: {
        ...noPreconditioning,
        climate: 'heat',
        hvacStartAt: new Date(NOW + 5.25 * HOUR),
        hvacKw: 6,
        systemStartAt: new Date(NOW + 5.5 * HOUR),
        systemKw: 2,
      },
    });
    // Slot 1: HVAC half the slot (3 kW). Slot 2: HVAC 6, system 2, automatic 4 for its 30 minutes.
    // The zero-length slot draws nothing.
    expect(preconditioningAuxKw(d, slots as never, NOW)).toEqual([3, 12, 0]);
  });

  it('leaves the automatic window out without a vehicle preconditioning power', () => {
    const d = departure({
      id: 'd',
      preconditioning: { ...noPreconditioning, climate: 'heat' },
    });
    expect(preconditioningAuxKw(d, slots as never, NOW)).toBeUndefined();
  });
});

describe('stored slots', () => {
  it('finds no slot for a missing, empty or ended plan', () => {
    expect(storedSlotIndex(null, NOW)).toBe(-1);
    expect(storedSlotIndex([], NOW)).toBe(-1);
    const starts = [new Date(NOW).toISOString(), new Date(NOW + 15 * MIN).toISOString()];
    expect(storedSlotIndex(starts, NOW - MIN)).toBe(-1);
    expect(storedSlotIndex(starts, NOW + 20 * MIN)).toBe(1);
    expect(storedSlotIndex(starts, NOW + 31 * MIN)).toBe(-1);
    expect(storedSlotIndex([new Date(NOW).toISOString(), 42], NOW + 20 * MIN)).toBe(0);
  });

  it('reads the slots from an index on', () => {
    const starts = [
      new Date(NOW).toISOString(),
      new Date(NOW + 15 * MIN).toISOString(),
      new Date(NOW + 30 * MIN).toISOString(),
    ];
    const slots = storedSlots(starts, 1);
    expect(slots.map((s) => s.startMs)).toEqual([NOW + 15 * MIN, NOW + 30 * MIN]);
    expect(slots[0]!.endMs).toBe(NOW + 30 * MIN);
  });
});

describe('plannedSessionDrawKw', () => {
  const station = {
    id: 'sta_a',
    currentDrawKw: 18,
    drawMeasured: true,
    evseDrawKw: { evs_a1: 11 },
  };

  it('reads the EVSE draw first, then the station draw for the only session', () => {
    expect(plannedSessionDrawKw(station as never, session({ id: 's' }), 2)).toBe(11);
    const other = session({ id: 's', evseDbId: 'evs_a2' });
    expect(plannedSessionDrawKw(station as never, other, 1)).toBe(18);
    expect(plannedSessionDrawKw(station as never, other, 2)).toBeNull();
    expect(plannedSessionDrawKw({ ...station, drawMeasured: false } as never, other, 1)).toBeNull();
    expect(plannedSessionDrawKw(station as never, session({ id: 's', evseDbId: null }), 1)).toBe(
      18,
    );
  });
});

describe('withRejectedProfiles', () => {
  const write = (departureId: string, readinessReason: string | null) => ({
    departureId,
    readiness: 'on_track' as const,
    readinessReason,
    plannedKwh: 10,
    deliveredKwh: null,
    shortfallKwh: 0,
    predictedReadyAt: null,
    predictedMaxReadyAt: null,
  });

  it('keeps an offline or not-following reason of a rejected profile', () => {
    const entries = ['dep_off', 'dep_nf', 'dep_x'].map((departureId) => ({
      departureId,
      vehicleId: 'veh',
      sessionId: `ses_${departureId}`,
      stationDbId: 'sta',
      evseDbId: null,
      minKw: 0,
      powerKw: [1],
      profile: {
        id: 1,
        hash: 'h',
        slotStartMs: NOW,
        state: 'rejected' as const,
        sentAt: new Date(NOW).toISOString(),
      },
    }));
    const out = withRejectedProfiles(
      [
        write('dep_off', 'station_offline'),
        write('dep_nf', 'charger_not_following'),
        write('dep_x', null),
        write('dep_other', null),
      ] as never,
      entries,
    );
    expect(out.map((w) => [w.departureId, w.readiness, w.readinessReason])).toEqual([
      ['dep_off', 'on_track', 'station_offline'],
      ['dep_nf', 'on_track', 'charger_not_following'],
      ['dep_x', 'at_risk', 'profile_rejected'],
      ['dep_other', 'on_track', null],
    ]);
  });
});
