// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TariffRestrictions } from './tariff-restrictions.js';
import { timeToMinutes } from './tariff-restrictions.js';
import type { TariffScope } from './tariff-scope.js';
import { isUnscopedTariff, tariffScopesConflict } from './tariff-scope.js';

interface TariffForOverlap extends TariffScope {
  id: string;
  restrictions: TariffRestrictions | null;
  priority: number;
}

interface OverlapResult {
  valid: boolean;
  conflictingTariffId?: string;
  message?: string;
}

function timeRangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const a0 = timeToMinutes(aStart);
  const a1 = timeToMinutes(aEnd);
  const b0 = timeToMinutes(bStart);
  const b1 = timeToMinutes(bEnd);

  // Decompose midnight-crossing ranges into segments
  const aSegments: Array<[number, number]> =
    a0 < a1
      ? [[a0, a1]]
      : [
          [a0, 1440],
          [0, a1],
        ];
  const bSegments: Array<[number, number]> =
    b0 < b1
      ? [[b0, b1]]
      : [
          [b0, 1440],
          [0, b1],
        ];

  for (const [as, ae] of aSegments) {
    for (const [bs, be] of bSegments) {
      if (as < be && bs < ae) return true;
    }
  }
  return false;
}

/** The whole day, for days of the week without a time window. */
const FULL_DAY = { startTime: '00:00', endTime: '00:00' };

function daysOverlap(a: number[], b: number[]): boolean {
  const setB = new Set(b);
  return a.some((d) => setB.has(d));
}

function dateRangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  // Decompose wrapping ranges into segments
  const aSegments: Array<[string, string]> =
    aStart <= aEnd
      ? [[aStart, aEnd]]
      : [
          [aStart, '12-31'],
          ['01-01', aEnd],
        ];
  const bSegments: Array<[string, string]> =
    bStart <= bEnd
      ? [[bStart, bEnd]]
      : [
          [bStart, '12-31'],
          ['01-01', bEnd],
        ];

  for (const [as, ae] of aSegments) {
    for (const [bs, be] of bSegments) {
      if (as <= be && bs <= ae) return true;
    }
  }
  return false;
}

export function validateNoOverlap(
  existingTariffs: TariffForOverlap[],
  newRestrictions: TariffRestrictions | null,
  newPriority: number,
  excludeTariffId?: string,
  /**
   * The new tariff's charging type and sites. Two tariffs of one priority
   * are compared only when their scopes conflict (overlap and neither is more
   * specific, owner decision D-A): AC never meets DC, and an AC or Selected
   * Sites tariff wins over a Both or All Sites one instead of conflicting.
   */
  newScope: TariffScope = {},
): OverlapResult {
  const candidates = existingTariffs.filter(
    (t) =>
      t.id !== excludeTariffId && t.priority === newPriority && tariffScopesConflict(t, newScope),
  );

  // Priority 0 (default): only one allowed
  if (newPriority === 0) {
    const conflict = candidates[0];
    if (conflict != null) {
      return {
        valid: false,
        conflictingTariffId: conflict.id,
        message: isUnscopedTariff(newScope)
          ? 'Only one default tariff allowed per group'
          : 'An unrestricted tariff with an overlapping charging type and sites already exists',
      };
    }
    return { valid: true };
  }

  // Priority 40 (holiday): only one allowed
  if (newPriority === 40) {
    const conflict = candidates[0];
    if (conflict != null) {
      return {
        valid: false,
        conflictingTariffId: conflict.id,
        message: isUnscopedTariff(newScope)
          ? 'Only one holiday tariff allowed per group'
          : 'A holiday tariff with an overlapping charging type and sites already exists',
      };
    }
    return { valid: true };
  }

  // Priority 50 (energy): several thresholds per group, each threshold once.
  // The highest threshold the session reached wins (compareTariffs), so two
  // tariffs at the same threshold would tie.
  if (newPriority === 50) {
    const threshold = newRestrictions?.energyThresholdKwh;
    const conflict = candidates.find(
      (t) => threshold != null && t.restrictions?.energyThresholdKwh === threshold,
    );
    if (conflict != null) {
      return {
        valid: false,
        conflictingTariffId: conflict.id,
        message: 'An energy threshold tariff with the same threshold already exists',
      };
    }
    return { valid: true };
  }

  // Priority 10 (time-only): check time range overlap
  if (newPriority === 10 && newRestrictions?.timeRange != null) {
    for (const existing of candidates) {
      if (existing.restrictions?.timeRange != null) {
        if (
          timeRangesOverlap(
            newRestrictions.timeRange.startTime,
            newRestrictions.timeRange.endTime,
            existing.restrictions.timeRange.startTime,
            existing.restrictions.timeRange.endTime,
          )
        ) {
          return {
            valid: false,
            conflictingTariffId: existing.id,
            message: 'Time ranges overlap with an existing tariff',
          };
        }
      }
    }
    return { valid: true };
  }

  // Priority 20 (day+time): check day intersection AND time overlap. Days
  // without a time window cover the whole day.
  if (newPriority === 20 && newRestrictions?.daysOfWeek != null) {
    const newRange = newRestrictions.timeRange ?? FULL_DAY;
    for (const existing of candidates) {
      if (existing.restrictions?.daysOfWeek != null) {
        const existingRange = existing.restrictions.timeRange ?? FULL_DAY;
        if (
          daysOverlap(newRestrictions.daysOfWeek, existing.restrictions.daysOfWeek) &&
          (newRange === FULL_DAY ||
            existingRange === FULL_DAY ||
            timeRangesOverlap(
              newRange.startTime,
              newRange.endTime,
              existingRange.startTime,
              existingRange.endTime,
            ))
        ) {
          return {
            valid: false,
            conflictingTariffId: existing.id,
            message: 'Day and time range overlap with an existing tariff',
          };
        }
      }
    }
    return { valid: true };
  }

  // Priority 30 (date-range): check date range overlap
  if (newPriority === 30 && newRestrictions?.dateRange != null) {
    for (const existing of candidates) {
      if (existing.restrictions?.dateRange != null) {
        if (
          dateRangesOverlap(
            newRestrictions.dateRange.startDate,
            newRestrictions.dateRange.endDate,
            existing.restrictions.dateRange.startDate,
            existing.restrictions.dateRange.endDate,
          )
        ) {
          return {
            valid: false,
            conflictingTariffId: existing.id,
            message: 'Date ranges overlap with an existing tariff',
          };
        }
      }
    }
    return { valid: true };
  }

  return { valid: true };
}
