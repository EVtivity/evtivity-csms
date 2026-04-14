// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { validateNoOverlap } from '../tariff-overlap.js';
import type { TariffRestrictions } from '../tariff-restrictions.js';

function makeTariff(id: string, priority: number, restrictions: TariffRestrictions | null = null) {
  return { id, priority, restrictions };
}

describe('validateNoOverlap', () => {
  describe('priority 0 (default)', () => {
    it('allows first default tariff', () => {
      const result = validateNoOverlap([], null, 0);
      expect(result.valid).toBe(true);
    });

    it('rejects second default tariff', () => {
      const existing = [makeTariff('trf_1', 0)];
      const result = validateNoOverlap(existing, null, 0);
      expect(result.valid).toBe(false);
      expect(result.conflictingTariffId).toBe('trf_1');
    });

    it('allows replacing own default tariff via excludeTariffId', () => {
      const existing = [makeTariff('trf_1', 0)];
      const result = validateNoOverlap(existing, null, 0, 'trf_1');
      expect(result.valid).toBe(true);
    });
  });

  describe('priority 10 (time-only)', () => {
    it('allows non-overlapping time ranges', () => {
      const existing = [
        makeTariff('trf_1', 10, { timeRange: { startTime: '09:00', endTime: '12:00' } }),
      ];
      const result = validateNoOverlap(
        existing,
        { timeRange: { startTime: '13:00', endTime: '17:00' } },
        10,
      );
      expect(result.valid).toBe(true);
    });

    it('rejects overlapping time ranges', () => {
      const existing = [
        makeTariff('trf_1', 10, { timeRange: { startTime: '09:00', endTime: '14:00' } }),
      ];
      const result = validateNoOverlap(
        existing,
        { timeRange: { startTime: '13:00', endTime: '17:00' } },
        10,
      );
      expect(result.valid).toBe(false);
      expect(result.conflictingTariffId).toBe('trf_1');
    });

    it('handles midnight-crossing overlaps', () => {
      const existing = [
        makeTariff('trf_1', 10, { timeRange: { startTime: '22:00', endTime: '06:00' } }),
      ];
      const result = validateNoOverlap(
        existing,
        { timeRange: { startTime: '05:00', endTime: '08:00' } },
        10,
      );
      expect(result.valid).toBe(false);
    });

    it('allows non-overlapping midnight-crossing ranges', () => {
      const existing = [
        makeTariff('trf_1', 10, { timeRange: { startTime: '22:00', endTime: '06:00' } }),
      ];
      const result = validateNoOverlap(
        existing,
        { timeRange: { startTime: '08:00', endTime: '20:00' } },
        10,
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('priority 20 (day+time)', () => {
    it('allows same time on different days', () => {
      const existing = [
        makeTariff('trf_1', 20, {
          daysOfWeek: [1, 2, 3],
          timeRange: { startTime: '09:00', endTime: '17:00' },
        }),
      ];
      const result = validateNoOverlap(
        existing,
        {
          daysOfWeek: [4, 5],
          timeRange: { startTime: '09:00', endTime: '17:00' },
        },
        20,
      );
      expect(result.valid).toBe(true);
    });

    it('rejects overlapping days and time', () => {
      const existing = [
        makeTariff('trf_1', 20, {
          daysOfWeek: [1, 2, 3],
          timeRange: { startTime: '09:00', endTime: '17:00' },
        }),
      ];
      const result = validateNoOverlap(
        existing,
        {
          daysOfWeek: [3, 4, 5],
          timeRange: { startTime: '12:00', endTime: '20:00' },
        },
        20,
      );
      expect(result.valid).toBe(false);
    });

    it('allows overlapping days with non-overlapping time', () => {
      const existing = [
        makeTariff('trf_1', 20, {
          daysOfWeek: [1, 2, 3],
          timeRange: { startTime: '09:00', endTime: '12:00' },
        }),
      ];
      const result = validateNoOverlap(
        existing,
        {
          daysOfWeek: [1, 2, 3],
          timeRange: { startTime: '13:00', endTime: '17:00' },
        },
        20,
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('priority 30 (date range)', () => {
    it('allows non-overlapping date ranges', () => {
      const existing = [
        makeTariff('trf_1', 30, {
          dateRange: { startDate: '01-01', endDate: '03-31' },
        }),
      ];
      const result = validateNoOverlap(
        existing,
        { dateRange: { startDate: '06-01', endDate: '09-30' } },
        30,
      );
      expect(result.valid).toBe(true);
    });

    it('rejects overlapping date ranges', () => {
      const existing = [
        makeTariff('trf_1', 30, {
          dateRange: { startDate: '01-01', endDate: '06-30' },
        }),
      ];
      const result = validateNoOverlap(
        existing,
        { dateRange: { startDate: '04-01', endDate: '09-30' } },
        30,
      );
      expect(result.valid).toBe(false);
    });

    it('handles wrapping date range overlap', () => {
      const existing = [
        makeTariff('trf_1', 30, {
          dateRange: { startDate: '11-01', endDate: '03-31' },
        }),
      ];
      const result = validateNoOverlap(
        existing,
        { dateRange: { startDate: '02-01', endDate: '05-31' } },
        30,
      );
      expect(result.valid).toBe(false);
    });
  });

  describe('priority 40 (holiday)', () => {
    it('allows first holiday tariff', () => {
      const result = validateNoOverlap([], { holidays: true }, 40);
      expect(result.valid).toBe(true);
    });

    it('rejects second holiday tariff', () => {
      const existing = [makeTariff('trf_1', 40, { holidays: true })];
      const result = validateNoOverlap(existing, { holidays: true }, 40);
      expect(result.valid).toBe(false);
    });
  });

  describe('priority 50 (energy threshold)', () => {
    it('allows multiple energy thresholds', () => {
      const existing = [
        makeTariff('trf_1', 50, { energyThresholdKwh: 50 }),
        makeTariff('trf_2', 50, { energyThresholdKwh: 100 }),
      ];
      const result = validateNoOverlap(existing, { energyThresholdKwh: 150 }, 50);
      expect(result.valid).toBe(true);
    });
  });

  describe('cross-priority', () => {
    it('does not flag tariffs at different priority levels', () => {
      const existing = [
        makeTariff('trf_1', 10, { timeRange: { startTime: '09:00', endTime: '17:00' } }),
      ];
      // Adding a default (priority 0) should not conflict with time (priority 10)
      const result = validateNoOverlap(existing, null, 0);
      expect(result.valid).toBe(true);
    });
  });
});
