// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { checkGroupDefault, isUnrestrictedTariff } from '../tariff-default.js';
import type { GroupDefaultTariff } from '../tariff-default.js';

function t(id: string, over: Partial<Omit<GroupDefaultTariff, 'id'>> = {}): GroupDefaultTariff {
  return { id, restrictions: null, isDefault: false, isActive: true, ...over };
}

const peak = { timeRange: { startTime: '09:00', endTime: '17:00' } };

describe('checkGroupDefault (B2, TC-T3-01..04)', () => {
  it('accepts a group without active tariffs', () => {
    expect(checkGroupDefault([])).toEqual({ valid: true });
    expect(checkGroupDefault([t('a', { restrictions: peak, isActive: false })])).toEqual({
      valid: true,
    });
  });

  it('accepts one active unrestricted default with restricted tariffs', () => {
    expect(
      checkGroupDefault([t('base', { isDefault: true }), t('peak', { restrictions: peak })]),
    ).toEqual({ valid: true });
  });

  it('refuses active tariffs without a default', () => {
    expect(checkGroupDefault([t('peak', { restrictions: peak })])).toEqual({
      valid: false,
      reason: 'no_default',
    });
    // An inactive default does not count.
    expect(
      checkGroupDefault([
        t('base', { isDefault: true, isActive: false }),
        t('peak', { restrictions: peak }),
      ]).valid,
    ).toBe(false);
  });

  it('refuses a restricted default', () => {
    expect(checkGroupDefault([t('peak', { restrictions: peak, isDefault: true })])).toEqual({
      valid: false,
      reason: 'restricted_default',
      tariffId: 'peak',
    });
  });

  it('refuses two defaults', () => {
    expect(checkGroupDefault([t('a', { isDefault: true }), t('b', { isDefault: true })])).toEqual({
      valid: false,
      reason: 'multiple_defaults',
      tariffId: 'b',
    });
  });

  it('treats empty restrictions as unrestricted', () => {
    expect(isUnrestrictedTariff(null)).toBe(true);
    expect(isUnrestrictedTariff({})).toBe(true);
    expect(isUnrestrictedTariff(peak)).toBe(false);
    expect(isUnrestrictedTariff({ daysOfWeek: [0] })).toBe(false);
  });
});
