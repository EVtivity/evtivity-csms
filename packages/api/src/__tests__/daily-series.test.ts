// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { enumerateLocalDays, zeroFillDays } from '../lib/daily-series.js';

describe('enumerateLocalDays', () => {
  it('lists every local day in the range inclusive', () => {
    const since = new Date('2026-06-01T04:00:00Z');
    const until = new Date('2026-06-04T04:00:00Z');
    expect(enumerateLocalDays(since, until, 'UTC')).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
    ]);
  });

  it('uses the target timezone for day boundaries', () => {
    // 03:00 UTC is still the previous day in New York (UTC-4 in June).
    const since = new Date('2026-06-02T03:00:00Z');
    const until = new Date('2026-06-02T03:00:00Z');
    expect(enumerateLocalDays(since, until, 'America/New_York')).toEqual(['2026-06-01']);
  });

  it('includes the end day when the final 24h step overshoots', () => {
    const since = new Date('2026-06-01T20:00:00Z');
    const until = new Date('2026-06-03T02:00:00Z');
    expect(enumerateLocalDays(since, until, 'UTC')).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
    ]);
  });

  it('does not duplicate days across the DST fall-back transition', () => {
    // US DST ends 2026-11-01; the 25-hour local day must appear once.
    const since = new Date('2026-10-31T12:00:00Z');
    const until = new Date('2026-11-03T12:00:00Z');
    const days = enumerateLocalDays(since, until, 'America/New_York');
    expect(days).toEqual([...new Set(days)]);
    expect(days).toContain('2026-11-01');
    expect(days).toContain('2026-11-02');
  });
});

describe('zeroFillDays', () => {
  it('substitutes zero rows for missing days and keeps data rows', () => {
    const days = ['2026-06-01', '2026-06-02', '2026-06-03'];
    const rows = [{ date: '2026-06-02', revenueCents: 500 }];
    expect(zeroFillDays(days, rows, (date) => ({ date, revenueCents: 0 }))).toEqual([
      { date: '2026-06-01', revenueCents: 0 },
      { date: '2026-06-02', revenueCents: 500 },
      { date: '2026-06-03', revenueCents: 0 },
    ]);
  });

  it('drops rows outside the enumerated range', () => {
    const days = ['2026-06-02'];
    const rows = [
      { date: '2026-05-30', revenueCents: 100 },
      { date: '2026-06-02', revenueCents: 200 },
    ];
    expect(zeroFillDays(days, rows, (date) => ({ date, revenueCents: 0 }))).toEqual([
      { date: '2026-06-02', revenueCents: 200 },
    ]);
  });
});
