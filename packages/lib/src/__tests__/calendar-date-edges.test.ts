// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDays,
  addMonthsToDay,
  firstDayOfWeek,
  localeDayOrder,
  parseTypedDay,
  weekdayOf,
} from '../calendar-date.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('calendar date edges', () => {
  it('returns a value that is no day unchanged, and Sunday as its weekday', () => {
    expect(addDays('soon', 3)).toBe('soon');
    expect(addMonthsToDay('2026-13', 1)).toBe('2026-13');
    expect(weekdayOf('x')).toBe(0);
  });

  it('starts the week on Monday for an unsupported locale and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(firstDayOfWeek('not a locale!')).toBe(1);
    expect(warn).toHaveBeenCalled();
  });

  it('reads the week start from the region when the locale has no week info', () => {
    const Original = Intl.Locale;
    vi.spyOn(Intl, 'Locale').mockImplementation(function (this: unknown, tag: string) {
      const loc = new Original(tag);
      return { language: loc.language, region: loc.region, maximize: () => ({}) } as never;
    } as never);
    expect(firstDayOfWeek('en-US')).toBe(0);
    expect(firstDayOfWeek('de-DE')).toBe(1);
    // No region at all: the language default (en: US, so Sunday).
    expect(firstDayOfWeek('en')).toBe(0);
    expect(firstDayOfWeek('fr')).toBe(1);
  });

  it('falls back to year, month, day when the locale cannot format', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(localeDayOrder('not a locale!')).toEqual(['y', 'm', 'd']);
    expect(warn).toHaveBeenCalled();
  });

  it('reads a typed day in the locale order and refuses impossible ones', () => {
    expect(parseTypedDay('22.11.2026', 'de-DE')).toBe('2026-11-22');
    expect(parseTypedDay('11/22/2026', 'en-US')).toBe('2026-11-22');
    expect(parseTypedDay('2026-02-30', 'en-US')).toBeNull();
    expect(parseTypedDay('1/2/26', 'en-US')).toBeNull();
  });
});
