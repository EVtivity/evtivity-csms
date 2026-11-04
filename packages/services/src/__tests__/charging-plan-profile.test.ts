// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({ db: {} }));

import { buildPlanSlots } from '@evtivity/lib/charging-plan';
import { chargingNeedsProfileId } from '@evtivity/lib/charging-profile-ids';
import { buildChargingPlanProfile, planProfileHash } from '../charging-plan-profile.js';

const now = new Date('2026-11-02T01:07:00Z');
const slots = buildPlanSlots(now.getTime(), Date.parse('2026-11-02T02:00:00Z'));

function build(overrides: Partial<Parameters<typeof buildChargingPlanProfile>[0]> = {}) {
  return buildChargingPlanProfile({
    stationOcppId: 'DEPOT-01',
    evseId: 1,
    transactionId: 'tx-1',
    slots,
    powerKw: [50, 50, 120, 0],
    rate: { rateUnit: 'W', voltageV: 230, phases: 3 },
    maxPeriods: 24,
    now,
    ...overrides,
  });
}

describe('buildChargingPlanProfile', () => {
  it('merges equal slots into one period and starts a minute in the past', () => {
    const payload = build();
    const schedule = payload.chargingProfile.chargingSchedule[0];
    expect(payload.evseId).toBe(1);
    expect(payload.chargingProfile).toMatchObject({
      id: chargingNeedsProfileId('DEPOT-01', 'tx-1'),
      stackLevel: 1,
      chargingProfilePurpose: 'TxProfile',
      chargingProfileKind: 'Absolute',
      transactionId: 'tx-1',
    });
    expect(schedule?.startSchedule).toBe('2026-11-02T01:06:00.000Z');
    expect(schedule?.chargingRateUnit).toBe('W');
    expect(schedule?.chargingSchedulePeriod).toEqual([
      { startPeriod: 0, limit: 50000 },
      { startPeriod: 1440, limit: 120000 },
      { startPeriod: 2340, limit: 0 },
    ]);
  });

  it('sends amps rounded down to 0.1 A on the circuit voltage and phases', () => {
    const payload = build({
      rate: { rateUnit: 'A', voltageV: 230, phases: 3 },
      powerKw: [11, 11, 7, 7],
    });
    const periods = payload.chargingProfile.chargingSchedule[0]?.chargingSchedulePeriod;
    // 11 kW / (230 V x 3) = 15.94 A, 7 kW = 10.14 A.
    expect(periods).toEqual([
      { startPeriod: 0, limit: 15.9 },
      { startPeriod: 1440, limit: 10.1 },
    ]);
    expect(payload.chargingProfile.chargingSchedule[0]?.chargingRateUnit).toBe('A');
  });

  it('names the EV phases on every period when given', () => {
    const payload = build({
      rate: { rateUnit: 'A', voltageV: 230, phases: 1 },
      numberPhases: 1,
      powerKw: [7.36, 7.36, 3.68, 0],
    });
    expect(payload.chargingProfile.chargingSchedule[0]?.chargingSchedulePeriod).toEqual([
      { startPeriod: 0, limit: 32, numberPhases: 1 },
      expect.objectContaining({ limit: 16, numberPhases: 1 }),
      expect.objectContaining({ limit: 0, numberPhases: 1 }),
    ]);
    expect(
      build().chargingProfile.chargingSchedule[0]?.chargingSchedulePeriod[0],
    ).not.toHaveProperty('numberPhases');
  });

  it('drops the periods past the station bound', () => {
    const payload = build({ powerKw: [10, 20, 30, 40], maxPeriods: 2 });
    expect(payload.chargingProfile.chargingSchedule[0]?.chargingSchedulePeriod).toEqual([
      { startPeriod: 0, limit: 10000 },
      { startPeriod: 540, limit: 20000 },
    ]);
  });

  it('rounds watts down to whole watts', () => {
    const payload = build({ powerKw: [7.3456, 7.3456, 7.3456, 7.3456] });
    expect(payload.chargingProfile.chargingSchedule[0]?.chargingSchedulePeriod).toEqual([
      { startPeriod: 0, limit: 7345 },
    ]);
  });
});

describe('planProfileHash', () => {
  it('ignores the schedule start and changes with the limits', () => {
    const first = build();
    const later = structuredClone(first);
    later.chargingProfile.chargingSchedule[0]!.startSchedule = '2026-11-02T01:07:10.000Z';
    expect(planProfileHash(later)).toBe(planProfileHash(first));
    expect(planProfileHash(build({ powerKw: [50, 50, 110, 0] }))).not.toBe(planProfileHash(first));
    expect(planProfileHash(build({ rate: { rateUnit: 'A', voltageV: 230, phases: 3 } }))).not.toBe(
      planProfileHash(first),
    );
  });
});
