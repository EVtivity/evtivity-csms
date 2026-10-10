// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { compareTariffs, resolveActiveTariff } from '../tariff-resolver.js';
import type { TariffWithRestrictions } from '../tariff-resolver.js';

function makeTariff(
  id: string,
  priority: number,
  isDefault: boolean,
  restrictions: TariffWithRestrictions['restrictions'] = null,
): TariffWithRestrictions {
  return {
    id,
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

describe('energy thresholds (B9)', () => {
  const e20 = makeTariff('trf_e20', 50, false, { energyThresholdKwh: 20 });
  const e50 = makeTariff('trf_e50', 50, false, { energyThresholdKwh: 50 });
  const base = makeTariff('trf_base', 0, true);

  it('picks the highest threshold reached whatever the input order (TC-T3-10)', () => {
    const now = new Date();
    expect(resolveActiveTariff([e20, e50, base], now, [], 60)?.id).toBe('trf_e50');
    expect(resolveActiveTariff([e50, e20, base], now, [], 60)?.id).toBe('trf_e50');
    expect(resolveActiveTariff([e50, e20, base], now, [], 30)?.id).toBe('trf_e20');
    expect(resolveActiveTariff([e50, e20, base], now, [], 10)?.id).toBe('trf_base');
  });

  it('orders by priority, then threshold, then id', () => {
    const a = makeTariff('trf_a', 10, false, {
      timeRange: { startTime: '09:00', endTime: '10:00' },
    });
    const b = makeTariff('trf_b', 10, false, {
      timeRange: { startTime: '11:00', endTime: '12:00' },
    });
    expect([b, base, e20, a, e50].sort(compareTariffs).map((t) => t.id)).toEqual([
      'trf_e50',
      'trf_e20',
      'trf_a',
      'trf_b',
      'trf_base',
    ]);
  });
});

describe('default fallback (B2)', () => {
  it('ignores a restricted tariff flagged default (TC-T3-03)', () => {
    const peakOnly = makeTariff('trf_peak', 10, true, {
      timeRange: { startTime: '09:00', endTime: '17:00' },
    });
    // 20:00 PT: the peak tariff does not match and is no fallback.
    const at = new Date('2026-10-09T03:00:00Z');
    expect(resolveActiveTariff([peakOnly], at, [], 0, 'America/Los_Angeles')).toBeNull();
  });
});
