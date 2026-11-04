// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { TFunction } from 'i18next';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import {
  VehicleBatteryFields,
  batteryBodyValue,
  batteryInputValue,
  formatBatteryValue,
  vehicleBatteryErrors,
} from '../VehicleBatteryFields';

const t = ((key: string) => key) as unknown as TFunction;

afterEach(() => {
  cleanup();
});

describe('VehicleBatteryFields', () => {
  it('labels both inputs and reports typed values', () => {
    const onChange = vi.fn();
    render(
      <VehicleBatteryFields
        idPrefix="v"
        value={{ batteryCapacityKwh: '', maxChargePowerKw: '' }}
        onChange={onChange}
      />,
    );
    const capacity = screen.getByLabelText<HTMLInputElement>('vehicles.batteryCapacityKwh');
    fireEvent.change(capacity, { target: { value: '75.5' } });
    expect(onChange).toHaveBeenCalledWith({ batteryCapacityKwh: '75.5', maxChargePowerKw: '' });
    expect(screen.getByLabelText('vehicles.maxChargePowerKw')).toBeTruthy();
  });

  it('shows the range errors it is given', () => {
    render(
      <VehicleBatteryFields
        idPrefix="v"
        value={{ batteryCapacityKwh: '0', maxChargePowerKw: '5000' }}
        onChange={() => undefined}
        errors={{
          batteryCapacityKwh: 'vehicles.batteryCapacityRange',
          maxChargePowerKw: 'vehicles.maxChargePowerRange',
        }}
      />,
    );
    expect(screen.getByText('vehicles.batteryCapacityRange')).toBeTruthy();
    expect(screen.getByText('vehicles.maxChargePowerRange')).toBeTruthy();
  });
});

describe('vehicle battery helpers', () => {
  it('checks the ranges and allows empty fields', () => {
    expect(vehicleBatteryErrors({ batteryCapacityKwh: '', maxChargePowerKw: '' }, t)).toEqual({});
    expect(vehicleBatteryErrors({ batteryCapacityKwh: '2000', maxChargePowerKw: '1' }, t)).toEqual(
      {},
    );
    expect(
      vehicleBatteryErrors({ batteryCapacityKwh: '0.5', maxChargePowerKw: '3750.5' }, t),
    ).toEqual({
      batteryCapacityKwh: 'vehicles.batteryCapacityRange',
      maxChargePowerKw: 'vehicles.maxChargePowerRange',
    });
  });

  it('converts between the API values and the form values', () => {
    expect(batteryInputValue(null)).toBe('');
    expect(batteryInputValue(75.5)).toBe('75.5');
    expect(batteryInputValue('150.00')).toBe('150');
    expect(batteryBodyValue('')).toBeNull();
    expect(batteryBodyValue(' 82.25 ')).toBe(82.25);
  });

  it('formats a stored value with its unit', () => {
    expect(formatBatteryValue(null, 'kWh')).toBeNull();
    expect(formatBatteryValue(75.5, 'kWh')).toBe('75.5 kWh');
    expect(formatBatteryValue(350, 'kW')).toBe('350 kW');
  });
});
