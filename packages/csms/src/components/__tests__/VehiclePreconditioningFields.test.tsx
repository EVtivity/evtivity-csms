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
  VehiclePreconditioningFields,
  formatPreconditioningPower,
  preconditioningInputValues,
  preconditioningMinutesBody,
  preconditioningPowerBody,
  vehiclePreconditioningErrors,
} from '../VehiclePreconditioningFields';
import en from '../../i18n/locales/en.json';
import de from '../../i18n/locales/de.json';
import es from '../../i18n/locales/es.json';
import ko from '../../i18n/locales/ko.json';
import zh from '../../i18n/locales/zh.json';
import zhTW from '../../i18n/locales/zh-TW.json';

const t = ((key: string) => key) as unknown as TFunction;

afterEach(() => {
  cleanup();
});

describe('VehiclePreconditioningFields', () => {
  it('labels both inputs, explains the reserved power and reports typed values', () => {
    const onChange = vi.fn();
    render(
      <VehiclePreconditioningFields
        idPrefix="v"
        value={{ preconditioningPowerKw: '', preconditioningMinutes: '30' }}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('vehicles.preconditioningMinutes'), {
      target: { value: '45' },
    });
    expect(onChange).toHaveBeenCalledWith({
      preconditioningPowerKw: '',
      preconditioningMinutes: '45',
    });
    expect(screen.getByLabelText('vehicles.preconditioningPowerKw')).toBeTruthy();
    expect(screen.getByText('vehicles.preconditioningPowerHelp')).toBeTruthy();
  });

  it('starts from the stored values, the default window when none', () => {
    expect(preconditioningInputValues()).toEqual({
      preconditioningPowerKw: '',
      preconditioningMinutes: '30',
    });
    expect(
      preconditioningInputValues({ preconditioningPowerKw: 12.5, preconditioningMinutes: 60 }),
    ).toEqual({ preconditioningPowerKw: '12.5', preconditioningMinutes: '60' });
  });

  it('sends null for an empty power (clears it) and the default for an empty window', () => {
    const empty = { preconditioningPowerKw: ' ', preconditioningMinutes: '' };
    expect(preconditioningPowerBody(empty)).toBeNull();
    expect(preconditioningMinutesBody(empty)).toBe(30);
    expect(preconditioningPowerBody({ ...empty, preconditioningPowerKw: '8' })).toBe(8);
  });

  it('checks the API ranges: 0.5 to 500 kW and 5 to 240 whole minutes', () => {
    expect(
      vehiclePreconditioningErrors(
        { preconditioningPowerKw: '0.4', preconditioningMinutes: '4' },
        t,
      ),
    ).toEqual({
      preconditioningPowerKw: 'vehicles.preconditioningPowerRange',
      preconditioningMinutes: 'vehicles.preconditioningMinutesRange',
    });
    expect(
      vehiclePreconditioningErrors(
        { preconditioningPowerKw: '500', preconditioningMinutes: '240' },
        t,
      ),
    ).toEqual({});
    expect(
      vehiclePreconditioningErrors(
        { preconditioningPowerKw: '', preconditioningMinutes: '7.5' },
        t,
      ),
    ).toEqual({ preconditioningMinutes: 'vehicles.preconditioningMinutesRange' });
    expect(formatPreconditioningPower(null)).toBeNull();
    expect(formatPreconditioningPower(12.5)).toBe('12.5 kW');
  });

  it('has its labels in every locale', () => {
    const keys = [
      'preconditioningPowerKw',
      'preconditioningPowerHelp',
      'preconditioningPowerRange',
      'preconditioningMinutes',
      'preconditioningMinutesHelp',
      'preconditioningMinutesRange',
      'preconditioningMinutesValue',
    ];
    const locales = { en, de, es, ko, zh, 'zh-TW': zhTW } as Record<string, unknown>;
    for (const [lang, locale] of Object.entries(locales)) {
      const vehicles = (locale as { vehicles: Record<string, unknown> }).vehicles;
      expect(
        keys.filter((k) => typeof vehicles[k] !== 'string'),
        lang,
      ).toEqual([]);
    }
  });
});
