// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  chargingProfileForOcpp201,
  ocpp201ChargingProfileRefusal,
} from '../ocpp201-charging-profile.js';
import * as lib from '../index.js';

type Obj = Record<string, unknown>;

const profile = (period: Obj = { startPeriod: 0, limit: 11000 }, extra: Obj = {}): Obj => ({
  id: 1,
  stackLevel: 0,
  chargingProfilePurpose: 'TxDefaultProfile',
  chargingProfileKind: 'Absolute',
  chargingSchedule: [{ id: 1, chargingRateUnit: 'W', chargingSchedulePeriod: [period] }],
  ...extra,
});

const refuse = (reason: string): never => {
  throw new Error(reason);
};

describe('ocpp201ChargingProfileRefusal', () => {
  it('accepts a plain charging profile', () => {
    expect(ocpp201ChargingProfileRefusal(profile())).toBeNull();
  });

  it.each([
    [
      'PriorityCharging purpose',
      profile(undefined, { chargingProfilePurpose: 'PriorityCharging' }),
      'chargingProfilePurpose PriorityCharging',
    ],
    [
      'LocalGeneration purpose',
      profile(undefined, { chargingProfilePurpose: 'LocalGeneration' }),
      'chargingProfilePurpose LocalGeneration',
    ],
    [
      'Dynamic kind',
      profile(undefined, { chargingProfileKind: 'Dynamic' }),
      'chargingProfileKind Dynamic',
    ],
    ['negative limit', profile({ startPeriod: 0, limit: -5000 }), 'is a discharge limit'],
    ['period without a limit', profile({ startPeriod: 0 }), 'limit is required'],
    ['setpoint', profile({ startPeriod: 0, limit: 1, setpoint: 5 }), 'setpoint is not defined'],
    [
      'discharge limit field',
      profile({ startPeriod: 0, limit: 1, dischargeLimit: -5 }),
      'dischargeLimit is not defined',
    ],
    [
      'per-phase limit that differs',
      profile({ startPeriod: 0, limit: 16, limit_L2: 10 }),
      'limit_L2 is not defined',
    ],
    [
      'operationMode other than ChargingOnly',
      profile({ startPeriod: 0, limit: 16, operationMode: 'CentralSetpoint' }),
      'operationMode is not defined',
    ],
    [
      'maxOfflineDuration',
      profile(undefined, { maxOfflineDuration: 60 }),
      'maxOfflineDuration is not defined',
    ],
    [
      'invalidAfterOfflineDuration true',
      profile(undefined, { invalidAfterOfflineDuration: true }),
      'invalidAfterOfflineDuration is not defined',
    ],
  ])('refuses a %s', (_name, value, reason) => {
    expect(ocpp201ChargingProfileRefusal(value)).toContain(reason);
  });

  it('names the path it is given', () => {
    expect(
      ocpp201ChargingProfileRefusal(profile({ startPeriod: 0, limit: -1 }), 'csChargingProfiles'),
    ).toBe(
      'csChargingProfiles.chargingSchedule[0].chargingSchedulePeriod[0].limit -1 is a discharge limit, OCPP 2.0.1 has no discharging',
    );
  });

  it('is exported from the package index', () => {
    expect(lib.ocpp201ChargingProfileRefusal).toBe(ocpp201ChargingProfileRefusal);
    expect(lib.chargingProfileForOcpp201).toBe(chargingProfileForOcpp201);
  });
});

describe('chargingProfileForOcpp201', () => {
  it('drops 2.1 fields equal to the 2.0.1 behaviour and keeps the input', () => {
    const input = profile(
      {
        startPeriod: 0,
        limit: 16,
        limit_L2: 16,
        limit_L3: 16,
        operationMode: 'ChargingOnly',
        evseSleep: false,
        preconditioningRequest: false,
      },
      { invalidAfterOfflineDuration: false, dynUpdateTime: '2026-10-17T10:00:00Z' },
    );
    const before = JSON.stringify(input);
    expect(chargingProfileForOcpp201(input, refuse)).toEqual(
      profile({ startPeriod: 0, limit: 16 }),
    );
    expect(JSON.stringify(input)).toBe(before);
  });

  it('drops schedule defaults useLocalTime false and randomizedDelay 0', () => {
    const input = profile();
    const schedules = input['chargingSchedule'] as Obj[];
    const withDefaults = {
      ...input,
      chargingSchedule: [{ ...schedules[0], useLocalTime: false, randomizedDelay: 0 }],
    };
    expect(chargingProfileForOcpp201(withDefaults, refuse)).toEqual(input);
  });

  it('returns a value that is not an object as is', () => {
    expect(chargingProfileForOcpp201(null, refuse)).toBeNull();
  });
});
