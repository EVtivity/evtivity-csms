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

describe('load management credit profile (security case 334)', () => {
  // The CSMS sends the station limit without battery or solar readings at
  // stack level 1 and the credited limit at stack level 2 until the reading
  // goes stale: the higher stack level overrules while it is valid (K01.FR.17)
  // and is valid only before validTo (K01.FR.37).
  const stationMax = (id: number, stackLevel: number, limitW: number, validTo?: string) => ({
    id,
    stackLevel,
    chargingProfilePurpose: 'ChargingStationMaxProfile',
    chargingProfileKind: 'Absolute',
    ...(validTo != null ? { validTo } : {}),
    _evseId: 0,
    _setAt: now.toISOString(),
    chargingSchedule: [
      {
        id: 1,
        startSchedule: at(-60),
        chargingRateUnit: 'W',
        chargingSchedulePeriod: [{ startPeriod: 0, limit: limitW }],
      },
    ],
  });

  it('falls back to the stack level 1 limit when the credit profile ends', () => {
    const periods = computeCompositeSchedule(
      input([stationMax(1_000_000_000, 1, 20_000), stationMax(1_000_000_001, 2, 40_000, at(30))], {
        evseId: 0,
        unit: 'W',
        localLimit: 100_000,
        durationS: 120,
      }),
    );
    expect(periods.map((p) => [p.startPeriod, p.limit])).toEqual([
      [0, 40_000],
      [30, 20_000],
    ]);
  });
});

describe('computeCompositeSchedule edges', () => {
  it('repeats a daily recurring profile from its start and ends each occurrence at its duration', () => {
    const start = new Date(now.getTime() - 86_400_000 + 100_000).toISOString();
    const recurring = profile(
      {
        chargingProfileKind: 'Recurring',
        recurrencyKind: 'Daily',
        schedule: { startSchedule: start, duration: 200 },
      },
      10,
    );
    // Today's occurrence starts 100 s after now and lasts 200 s.
    expect(computeCompositeSchedule(input([recurring]))).toEqual([
      { startPeriod: 0, limit: 32, numberPhases: 3 },
      { startPeriod: 100, limit: 10, numberPhases: 3 },
      { startPeriod: 300, limit: 32, numberPhases: 3 },
    ]);
  });

  it('takes a day for a recurring profile of an unknown recurrency kind', () => {
    const start = new Date(now.getTime() - 86_400_000).toISOString();
    const recurring = profile(
      {
        chargingProfileKind: 'Recurring',
        recurrencyKind: 'Monthly',
        schedule: { startSchedule: start },
      },
      12,
    );
    expect(computeCompositeSchedule(input([recurring]))[0]).toEqual({
      startPeriod: 0,
      limit: 12,
      numberPhases: 3,
    });
  });

  it('ignores a profile not started yet, one without a schedule and other transaction profiles', () => {
    const later = profile({ schedule: { startSchedule: at(1000) } }, 5);
    const noSchedule = { ...profile({}, 5), chargingSchedule: undefined };
    const otherTx = profile({ chargingProfilePurpose: 'TxProfile', transactionId: 'tx-2' }, 4);
    const noTx = profile({ chargingProfilePurpose: 'TxProfile' }, 3);
    expect(
      computeCompositeSchedule(input([later, noSchedule, otherTx], { transactionId: 'tx-1' })),
    ).toEqual([{ startPeriod: 0, limit: 32, numberPhases: 3 }]);
    expect(computeCompositeSchedule(input([noTx]))).toEqual([
      { startPeriod: 0, limit: 32, numberPhases: 3 },
    ]);
  });

  it('answers the local limit before the first period of a schedule', () => {
    const late = {
      ...profile({}, 5),
      chargingSchedule: [
        { id: 1, chargingRateUnit: 'A', chargingSchedulePeriod: [{ startPeriod: 60, limit: 5 }] },
      ],
    };
    expect(computeCompositeSchedule(input([late]))).toEqual([
      { startPeriod: 0, limit: 32, numberPhases: 3 },
      { startPeriod: 60, limit: 5, numberPhases: 3 },
    ]);
  });

  it('prefers the EVSE profile over a station-wide one of the same stack level', () => {
    const wide = profile({ _evseId: 0 }, 20);
    const own = profile({}, 8);
    expect(computeCompositeSchedule(input([wide, own]))[0]?.limit).toBe(8);
    expect(computeCompositeSchedule(input([own, wide]))[0]?.limit).toBe(8);
  });
});
