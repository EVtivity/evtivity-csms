// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ValidationError } from '@evtivity/lib';
import {
  assignableSessionVehicle,
  VEHICLE_BATTERY_CAPACITY_KWH,
  VEHICLE_MAX_CHARGE_POWER_KW,
  VEHICLE_PRECONDITIONING_POWER_KW,
  batteryColumn,
  preconditioningMinutesValue,
} from '../services/vehicle.service.js';

describe('vehicle battery fields', () => {
  it('leaves an absent value and clears a null one', () => {
    expect(batteryColumn(undefined, VEHICLE_BATTERY_CAPACITY_KWH, 'batteryCapacityKwh')).toBe(
      undefined,
    );
    expect(batteryColumn(null, VEHICLE_BATTERY_CAPACITY_KWH, 'batteryCapacityKwh')).toBeNull();
  });

  it('stores a value with two decimals', () => {
    expect(batteryColumn(75.5, VEHICLE_BATTERY_CAPACITY_KWH, 'batteryCapacityKwh')).toBe('75.50');
    expect(batteryColumn(3750, VEHICLE_MAX_CHARGE_POWER_KW, 'maxChargePowerKw')).toBe('3750.00');
    expect(batteryColumn(1, VEHICLE_MAX_CHARGE_POWER_KW, 'maxChargePowerKw')).toBe('1.00');
  });

  it('refuses a value outside its range or not a number', () => {
    for (const value of [0.99, 2000.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        batteryColumn(value, VEHICLE_BATTERY_CAPACITY_KWH, 'batteryCapacityKwh'),
      ).toThrow(ValidationError);
    }
    expect(() => batteryColumn(3751, VEHICLE_MAX_CHARGE_POWER_KW, 'maxChargePowerKw')).toThrow(
      /maxChargePowerKw is 1 to 3750/,
    );
  });
});

describe('vehicle preconditioning fields', () => {
  it('stores the power with two decimals inside 0.5 to 500 kW', () => {
    expect(batteryColumn(0.5, VEHICLE_PRECONDITIONING_POWER_KW, 'preconditioningPowerKw')).toBe(
      '0.50',
    );
    expect(() =>
      batteryColumn(0.4, VEHICLE_PRECONDITIONING_POWER_KW, 'preconditioningPowerKw'),
    ).toThrow(ValidationError);
    expect(() =>
      batteryColumn(500.01, VEHICLE_PRECONDITIONING_POWER_KW, 'preconditioningPowerKw'),
    ).toThrow(/preconditioningPowerKw is 0.5 to 500/);
  });

  it('takes whole minutes from 5 to 240', () => {
    expect(preconditioningMinutesValue(undefined)).toBeUndefined();
    expect(preconditioningMinutesValue(5)).toBe(5);
    expect(preconditioningMinutesValue(240)).toBe(240);
    for (const bad of [4, 241, 30.5, Number.NaN]) {
      expect(() => preconditioningMinutesValue(bad)).toThrow(ValidationError);
    }
  });
});

describe('assignableSessionVehicle', () => {
  const render = (session: { driverId: string | null; stationId: string }) => {
    const condition = assignableSessionVehicle('veh_1', session);
    if (condition == null) throw new Error('no condition');
    return new PgDialect().sqlToQuery(condition);
  };

  it("takes the session driver's vehicle or one of a fleet of that driver, never a fleet of the station alone", () => {
    const q = render({ driverId: 'drv_1', stationId: 'sta_1' });
    expect(q.sql).toContain('session_fd.fleet_id = owner_fd.fleet_id');
    expect(q.sql).not.toContain('fleet_stations');
    expect(q.params).toEqual(['veh_1', 'drv_1', 'drv_1']);
  });

  it('takes a vehicle of a fleet holding the station only for a session without a driver', () => {
    const q = render({ driverId: null, stationId: 'sta_1' });
    expect(q.sql).toContain('fleet_stations');
    expect(q.sql).not.toContain('session_fd');
    expect(q.params).toEqual(['veh_1', 'sta_1']);
  });
});
