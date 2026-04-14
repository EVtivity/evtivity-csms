// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { resolveActiveTariff } from '../tariff-resolver.js';
import type { TariffWithRestrictions } from '../tariff-resolver.js';

function makeTariff(
  id: string,
  priority: number,
  isDefault: boolean,
  restrictions: TariffWithRestrictions['restrictions'] = null,
): TariffWithRestrictions {
  return {
    id,
    currency: 'USD',
    pricePerKwh: '0.25',
    pricePerMinute: null,
    pricePerSession: null,
    idleFeePricePerMinute: null,
    reservationFeePerMinute: null,
    taxRate: null,
    restrictions,
    priority,
    isDefault,
  };
}

describe('resolveActiveTariff', () => {
  it('returns the default tariff when no restricted tariffs match', () => {
    const tariffs = [
      makeTariff('default', 0, true),
      makeTariff('peak', 10, false, {
        timeRange: { startTime: '09:00', endTime: '17:00' },
      }),
    ];
    // 20:00 - outside peak hours
    const now = new Date(2026, 0, 15, 20, 0, 0);
    const result = resolveActiveTariff(tariffs, now, [], 0);
    expect(result?.id).toBe('default');
  });

  it('returns the matching restricted tariff when it matches', () => {
    const tariffs = [
      makeTariff('default', 0, true),
      makeTariff('peak', 10, false, {
        timeRange: { startTime: '09:00', endTime: '17:00' },
      }),
    ];
    // 12:00 - within peak hours
    const now = new Date(2026, 0, 15, 12, 0, 0);
    const result = resolveActiveTariff(tariffs, now, [], 0);
    expect(result?.id).toBe('peak');
  });

  it('higher priority wins over lower priority', () => {
    const tariffs = [
      makeTariff('default', 0, true),
      makeTariff('time-only', 10, false, {
        timeRange: { startTime: '09:00', endTime: '17:00' },
      }),
      makeTariff('holiday', 40, false, { holidays: true }),
    ];
    // A holiday during peak hours - holiday (priority 40) should win
    const now = new Date(2026, 0, 1, 12, 0, 0);
    const holidays = [new Date(2026, 0, 1)];
    const result = resolveActiveTariff(tariffs, now, holidays, 0);
    expect(result?.id).toBe('holiday');
  });

  it('returns null when no tariffs exist', () => {
    const result = resolveActiveTariff([], new Date(), [], 0);
    expect(result).toBeNull();
  });

  it('returns null when only restricted tariffs exist and none match', () => {
    const tariffs = [
      makeTariff('peak', 10, false, {
        timeRange: { startTime: '09:00', endTime: '17:00' },
      }),
    ];
    const now = new Date(2026, 0, 15, 20, 0, 0);
    const result = resolveActiveTariff(tariffs, now, [], 0);
    expect(result).toBeNull();
  });

  it('resolves energy threshold tariff when energy exceeds threshold', () => {
    const tariffs = [
      makeTariff('default', 0, true),
      makeTariff('high-energy', 50, false, { energyThresholdKwh: 50 }),
    ];
    const result = resolveActiveTariff(tariffs, new Date(), [], 60);
    expect(result?.id).toBe('high-energy');
  });

  it('falls back to default when energy is below threshold', () => {
    const tariffs = [
      makeTariff('default', 0, true),
      makeTariff('high-energy', 50, false, { energyThresholdKwh: 50 }),
    ];
    const result = resolveActiveTariff(tariffs, new Date(), [], 30);
    expect(result?.id).toBe('default');
  });

  it('picks highest matching priority when multiple match', () => {
    const tariffs = [
      makeTariff('default', 0, true),
      makeTariff('peak', 10, false, {
        timeRange: { startTime: '09:00', endTime: '17:00' },
      }),
      makeTariff('weekday-peak', 20, false, {
        daysOfWeek: [1, 2, 3, 4, 5],
        timeRange: { startTime: '09:00', endTime: '17:00' },
      }),
    ];
    // Wednesday 12:00 - both peak and weekday-peak match, weekday-peak should win
    const now = new Date(2026, 0, 14, 12, 0, 0);
    const result = resolveActiveTariff(tariffs, now, [], 0);
    expect(result?.id).toBe('weekday-peak');
  });

  it('handles seasonal tariff resolution', () => {
    const tariffs = [
      makeTariff('default', 0, true),
      makeTariff('summer', 30, false, {
        dateRange: { startDate: '06-01', endDate: '09-30' },
      }),
    ];
    // July 15
    const now = new Date(2026, 6, 15, 12, 0, 0);
    const result = resolveActiveTariff(tariffs, now, [], 0);
    expect(result?.id).toBe('summer');
  });
});
