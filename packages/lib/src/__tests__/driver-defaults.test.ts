// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { isDistanceUnit, newDriverPreferences, readDriverDefaults } from '../driver-defaults.js';

describe('readDriverDefaults', () => {
  it('reads the three settings', () => {
    expect(
      readDriverDefaults({
        'system.timezone': 'Europe/Berlin',
        'system.distanceUnit': 'km',
        'system.driverLanguage': 'zh-TW',
      }),
    ).toEqual({ timezone: 'Europe/Berlin', distanceUnit: 'km', language: 'zh-TW' });
  });

  it('falls back to America/New_York, miles and en for unset or invalid values', () => {
    const fallback = { timezone: 'America/New_York', distanceUnit: 'miles', language: 'en' };
    expect(readDriverDefaults({})).toEqual(fallback);
    expect(
      readDriverDefaults({
        'system.timezone': '',
        'system.distanceUnit': 'KM',
        'system.driverLanguage': 'fr',
      }),
    ).toEqual(fallback);
    expect(readDriverDefaults({ 'system.timezone': 'Mars/Olympus' }).timezone).toBe(
      'America/New_York',
    );
  });
});

describe('newDriverPreferences', () => {
  const defaults = { timezone: 'Europe/Berlin', distanceUnit: 'km', language: 'de' } as const;

  it('takes the defaults for every value the request leaves out', () => {
    expect(newDriverPreferences({}, defaults)).toEqual(defaults);
  });

  it('keeps every value the request sends', () => {
    expect(
      newDriverPreferences(
        { timezone: 'Asia/Seoul', distanceUnit: 'miles', language: 'ko' },
        defaults,
      ),
    ).toEqual({ timezone: 'Asia/Seoul', distanceUnit: 'miles', language: 'ko' });
    expect(newDriverPreferences({ language: 'es' }, defaults)).toEqual({
      ...defaults,
      language: 'es',
    });
  });
});

describe('isDistanceUnit', () => {
  it('accepts miles and km only', () => {
    expect(isDistanceUnit('miles')).toBe(true);
    expect(isDistanceUnit('km')).toBe(true);
    expect(isDistanceUnit('mi')).toBe(false);
    expect(isDistanceUnit(null)).toBe(false);
  });
});
