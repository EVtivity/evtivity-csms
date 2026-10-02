// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { computeCompositeSchedule, type CompositeInput } from '../composite-schedule.js';

const now = new Date('2026-10-02T10:00:00.000Z');
const at = (offsetS: number): string => new Date(now.getTime() + offsetS * 1000).toISOString();

function input(profiles: Array<Record<string, unknown>>, extra: Partial<CompositeInput> = {}) {
  return {
    profiles,
    evseId: 1,
    now,
    durationS: 400,
    localLimit: 32,
    unit: 'A' as const,
    voltage: 230,
    numberPhases: 3,
    transactionId: null,
    transactionStart: null,
    ...extra,
  };
}

const profile = (fields: Record<string, unknown>, limit: number, unit = 'A') => ({
  id: 1,
  stackLevel: 0,
  chargingProfilePurpose: 'TxDefaultProfile',
  chargingProfileKind: 'Absolute',
  _evseId: 1,
  _setAt: now.toISOString(),
  ...fields,
  chargingSchedule: [
    {
      id: 1,
      chargingRateUnit: unit,
      ...((fields['schedule'] as Record<string, unknown> | undefined) ?? {}),
      chargingSchedulePeriod: [{ startPeriod: 0, limit, numberPhases: 3 }],
    },
  ],
});

describe('computeCompositeSchedule', () => {
  it('is the local limit without profiles', () => {
    expect(computeCompositeSchedule(input([]))).toEqual([
      { startPeriod: 0, limit: 32, numberPhases: 3 },
    ]);
  });

  it('starts a profile at validFrom', () => {
    const periods = computeCompositeSchedule(
      input([profile({ chargingProfileKind: 'Relative', validFrom: at(300) }, 6)]),
    );
    expect(periods).toEqual([
      { startPeriod: 0, limit: 32, numberPhases: 3 },
      { startPeriod: 300, limit: 6, numberPhases: 3 },
    ]);
  });

  it('ends a profile at validTo', () => {
    const periods = computeCompositeSchedule(
      input([profile({ validTo: at(300), schedule: { startSchedule: at(-1) } }, 6)]),
    );
    expect(periods).toEqual([
      { startPeriod: 0, limit: 6, numberPhases: 3 },
      { startPeriod: 300, limit: 32, numberPhases: 3 },
    ]);
  });

  it('starts an absolute schedule at startSchedule', () => {
    const periods = computeCompositeSchedule(
      input([profile({ schedule: { startSchedule: at(60) } }, 6)], { durationS: 300 }),
    );
    expect(periods[1]).toEqual({ startPeriod: 60, limit: 6, numberPhases: 3 });
  });

  it('takes the highest stack level and the lowest of max and tx limits', () => {
    const periods = computeCompositeSchedule(
      input([
        profile({ id: 1, stackLevel: 0 }, 10),
        profile({ id: 2, stackLevel: 1 }, 7),
        profile({ id: 3, chargingProfilePurpose: 'ChargingStationMaxProfile', _evseId: 0 }, 20),
      ]),
    );
    expect(periods[0]?.limit).toBe(7);
  });

  it('skips invalidated profiles and converts W to A', () => {
    const periods = computeCompositeSchedule(
      input([
        profile({ id: 1, stackLevel: 1, _invalidated: true }, 7),
        profile({ id: 2 }, 4140, 'W'),
      ]),
    );
    expect(periods[0]?.limit).toBe(6);
  });
});
