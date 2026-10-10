// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  buildRestrictions,
  deriveRestrictionType,
  formatRestrictionSummary,
  isRestrictionType,
  type RestrictionFields,
  type RestrictionLabels,
} from '../tariff-restrictions';

const labels: RestrictionLabels = {
  none: 'None',
  holiday: 'Holiday',
  allDay: 'All day',
  notAvailable: 'n/a',
  dayNames: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  energyAbove: (kwh) => `Above ${String(kwh)} kWh`,
};

const fields: RestrictionFields = {
  startTime: '22:00',
  endTime: '06:00',
  allDay: false,
  days: [5, 6],
  startDate: '12-01',
  endDate: '02-29',
  thresholdKwh: '50',
};

describe('formatRestrictionSummary', () => {
  it('shows the no-restrictions label for a default tariff', () => {
    expect(formatRestrictionSummary(null, labels)).toBe('None');
  });

  it('shows days with their time range', () => {
    expect(
      formatRestrictionSummary(
        { daysOfWeek: [5, 1], timeRange: { startTime: '22:00', endTime: '06:00' } },
        labels,
      ),
    ).toBe('Mon, Fri 22:00 - 06:00');
  });

  it('shows days without a time range as all day', () => {
    expect(formatRestrictionSummary({ daysOfWeek: [0, 6] }, labels)).toBe('Sun, Sat All day');
  });

  it('shows a time range alone', () => {
    expect(
      formatRestrictionSummary({ timeRange: { startTime: '18:00', endTime: '00:00' } }, labels),
    ).toBe('18:00 - 00:00');
  });

  it('shows date ranges, holidays and energy thresholds', () => {
    expect(
      formatRestrictionSummary({ dateRange: { startDate: '12-01', endDate: '02-29' } }, labels),
    ).toBe('12-01 - 02-29');
    expect(formatRestrictionSummary({ holidays: true }, labels)).toBe('Holiday');
    expect(formatRestrictionSummary({ energyThresholdKwh: 50 }, labels)).toBe('Above 50 kWh');
  });

  it('falls back to n/a for an empty restrictions object', () => {
    expect(formatRestrictionSummary({}, labels)).toBe('n/a');
  });
});

describe('buildRestrictions', () => {
  it('sends null for a default tariff', () => {
    expect(buildRestrictions('default', fields)).toBeNull();
  });

  it('sends days without a time range when all day is set', () => {
    expect(buildRestrictions('dayTime', { ...fields, allDay: true })).toEqual({
      daysOfWeek: [5, 6],
    });
  });

  it('sends days with the time range otherwise', () => {
    expect(buildRestrictions('dayTime', fields)).toEqual({
      daysOfWeek: [5, 6],
      timeRange: { startTime: '22:00', endTime: '06:00' },
    });
  });

  it('builds the other restriction types', () => {
    expect(buildRestrictions('time', fields)).toEqual({
      timeRange: { startTime: '22:00', endTime: '06:00' },
    });
    expect(buildRestrictions('seasonal', fields)).toEqual({
      dateRange: { startDate: '12-01', endDate: '02-29' },
    });
    expect(buildRestrictions('holiday', fields)).toEqual({ holidays: true });
    expect(buildRestrictions('energy', fields)).toEqual({ energyThresholdKwh: 50 });
  });
});

describe('deriveRestrictionType', () => {
  it('maps restrictions to the editor type', () => {
    expect(deriveRestrictionType(null)).toBe('default');
    expect(deriveRestrictionType({ daysOfWeek: [1] })).toBe('dayTime');
    expect(deriveRestrictionType({ timeRange: { startTime: '08:00', endTime: '17:00' } })).toBe(
      'time',
    );
    expect(deriveRestrictionType({ dateRange: { startDate: '06-01', endDate: '08-31' } })).toBe(
      'seasonal',
    );
    expect(deriveRestrictionType({ holidays: true })).toBe('holiday');
    expect(deriveRestrictionType({ energyThresholdKwh: 20 })).toBe('energy');
  });
});

describe('isRestrictionType', () => {
  it('accepts only known types', () => {
    expect(isRestrictionType('dayTime')).toBe(true);
    expect(isRestrictionType('weekly')).toBe(false);
  });
});
