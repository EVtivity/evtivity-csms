// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Edge cases of the plan TxProfile builder, its hash and the plan measurement:
// an empty plan, a bad power value, the default unit, preconditioning periods,
// a schedule without periods, and the measurement states a partial previous
// state or an unsettled profile leave.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({ db: {} }));

const { buildChargingPlanProfile, planProfileHash } = await import('../charging-plan-profile.js');
const { evaluatePlanMeasurement, MEASURE_WINDOW_MS } =
  await import('../charging-plan-measurement.js');

const NOW = new Date('2026-11-02T01:07:00Z');
const T0 = Date.UTC(2026, 10, 2, 1, 0, 0);
const SLOT = 15 * 60_000;

const slots = [
  { startMs: T0, endMs: T0 + SLOT, hours: 0.25 },
  { startMs: T0 + SLOT, endMs: T0 + 2 * SLOT, hours: 0.25 },
  { startMs: T0 + 2 * SLOT, endMs: T0 + 3 * SLOT, hours: 0.25 },
];

function profile(overrides: Partial<Parameters<typeof buildChargingPlanProfile>[0]> = {}) {
  return buildChargingPlanProfile({
    stationOcppId: 'DEPOT-01',
    evseId: 2,
    transactionId: 'tx-9',
    slots,
    powerKw: [10, 10, 10],
    rate: undefined,
    maxPeriods: 24,
    now: NOW,
    ...overrides,
  });
}

describe('buildChargingPlanProfile edges', () => {
  it('sends one zero period from now when the plan has no slots', () => {
    const payload = profile({ slots: [], powerKw: [], numberPhases: 1 });
    const schedule = payload.chargingProfile.chargingSchedule[0];
    expect(schedule?.startSchedule).toBe('2026-11-02T01:06:00.000Z');
    expect(schedule?.chargingSchedulePeriod).toEqual([
      { startPeriod: 0, limit: 0, numberPhases: 1 },
    ]);
  });

  it('defaults to watts, reads a non-finite or missing power as 0 and keeps one period at least', () => {
    const payload = profile({ powerKw: [Number.NaN, 7.5], maxPeriods: 0 });
    const schedule = payload.chargingProfile.chargingSchedule[0];
    expect(schedule?.chargingRateUnit).toBe('W');
    // NaN and the missing third slot are 0 W; the bound of 0 still sends one period.
    expect(schedule?.chargingSchedulePeriod).toEqual([{ startPeriod: 0, limit: 0 }]);
  });

  it('sends preconditioning on every period and splits a period where the flag changes', () => {
    const payload = profile({ preconditioning: [false, true, true] });
    // The schedule starts at the slot start (T0 is before now) minus a minute.
    expect(payload.chargingProfile.chargingSchedule[0]?.chargingSchedulePeriod).toEqual([
      { startPeriod: 0, limit: 10000, preconditioningRequest: false },
      { startPeriod: 960, limit: 10000, preconditioningRequest: true },
    ]);
  });

  it('sends no preconditioning field when no slot asks for it', () => {
    const payload = profile({ preconditioning: [false, false, false] });
    expect(payload.chargingProfile.chargingSchedule[0]?.chargingSchedulePeriod).toEqual([
      { startPeriod: 0, limit: 10000 },
    ]);
  });
});

describe('planProfileHash', () => {
  it('hashes a profile without a schedule like one with an empty schedule', () => {
    const bare = planProfileHash({ evseId: 1, chargingProfile: { id: 5, stackLevel: 1 } });
    const empty = planProfileHash({
      evseId: 1,
      chargingProfile: { id: 5, stackLevel: 1, chargingSchedule: [{}] },
    });
    expect(bare).toMatch(/^[0-9a-f]{64}$/);
    expect(empty).toBe(bare);
    const other = planProfileHash({
      evseId: 1,
      chargingProfile: {
        id: 5,
        stackLevel: 1,
        chargingSchedule: [{ chargingRateUnit: 'W', chargingSchedulePeriod: [] }],
      },
    });
    expect(other).not.toBe(bare);
  });
});

describe('evaluatePlanMeasurement edges', () => {
  const reading = (over: Partial<Parameters<typeof evaluatePlanMeasurement>[1]> = {}) => ({
    limitKw: 20,
    drawKw: 20,
    energyWh: 0,
    slotStartMs: T0,
    minKw: 0,
    profileSettled: true,
    ...over,
  });

  it('counts a missing expected energy as 0 when the slot ends', () => {
    const out = evaluatePlanMeasurement(
      { limitKw: 20, slotStartMs: T0, slotFromWh: 0, segmentFromMs: T0 },
      reading({ slotStartMs: T0 + SLOT, energyWh: 1000 }),
      T0 + SLOT,
    );
    // 20 kW for 15 minutes is 5 kWh planned; 1 kWh delivered is behind.
    expect(out.events).toContain('behind_plan');
    expect(out.state.slotExpectedWh).toBe(0);
    expect(out.state.slotFromWh).toBe(1000);
  });

  it('adds the planned energy of a segment without a start as 0 when the limit changes', () => {
    const out = evaluatePlanMeasurement(
      { limitKw: 20, slotStartMs: T0 },
      reading({ limitKw: 10 }),
      T0 + 60_000,
    );
    expect(out.state.limitKw).toBe(10);
    expect(out.state.slotExpectedWh).toBe(0);
    expect(out.state.segmentFromMs).toBe(T0 + 60_000);
    expect(out.changed).toBe(true);
  });

  it('keeps no taper cap that would not lower the limit or a lower cap already held', () => {
    // A minimum of 19 kW holds the cap at 19, which is below the 20 kW limit:
    // with a cap of 15 already, 19 is not lower, so nothing changes.
    const out = evaluatePlanMeasurement(
      { limitKw: 20, slotStartMs: T0, lowSinceMs: T0, taperCapKw: 15 },
      reading({ drawKw: 5, minKw: 19 }),
      T0 + MEASURE_WINDOW_MS,
    );
    expect(out.events).not.toContain('taper');
    expect(out.state.taperCapKw).toBe(15);
    expect(out.state.lowSinceMs).toBeUndefined();
  });

  it('ends a taper cap once the draw reaches it again', () => {
    const out = evaluatePlanMeasurement(
      { limitKw: 20, slotStartMs: T0, taperCapKw: 16 },
      reading({ drawKw: 17 }),
      T0 + 10_000,
    );
    expect(out.events).toEqual(['taper_ended']);
    expect(out.state.taperCapKw).toBeUndefined();
  });

  it('keeps a taper cap while the draw stays under it', () => {
    const out = evaluatePlanMeasurement(
      { limitKw: 20, slotStartMs: T0, taperCapKw: 18 },
      reading({ drawKw: 17 }),
      T0 + 10_000,
    );
    expect(out.events).toEqual([]);
    expect(out.state.taperCapKw).toBe(18);
  });

  it('clears a not-following flag without a settled profile once the draw is within the limit', () => {
    const out = evaluatePlanMeasurement(
      { limitKw: 20, slotStartMs: T0, notFollowingKw: 30, highSinceMs: T0 },
      reading({ drawKw: 20.1, profileSettled: false }),
      T0 + 10_000,
    );
    expect(out.events).toEqual(['charger_following']);
    expect(out.state.notFollowingKw).toBeUndefined();
    expect(out.state.highSinceMs).toBeUndefined();
  });

  it('keeps the flag without a settled profile while the draw is still above the limit', () => {
    const out = evaluatePlanMeasurement(
      { limitKw: 20, slotStartMs: T0, notFollowingKw: 30 },
      reading({ drawKw: 30, profileSettled: false }),
      T0 + 10_000,
    );
    expect(out.events).toEqual([]);
    expect(out.state.notFollowingKw).toBe(30);
  });
});
