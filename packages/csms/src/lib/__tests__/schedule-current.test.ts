// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { scheduleCurrentLabel } from '../schedule-current';

const t = ((key: string, opts?: { kind?: string }) =>
  opts?.kind != null ? `${key}:${opts.kind}` : key) as unknown as TFunction;

describe('scheduleCurrentLabel', () => {
  it('shows nothing for a tariff that is not current', () => {
    expect(scheduleCurrentLabel({ isCurrent: false, currentFor: [] }, t)).toBeNull();
  });

  it('names the one kind a tariff is current for', () => {
    expect(scheduleCurrentLabel({ isCurrent: true, currentFor: ['dc'] }, t)).toBe(
      'pricing.isCurrentForKind:pricing.chargingTypeDc',
    );
  });

  it('says currently active for every kind, or while the kind is unknown', () => {
    expect(scheduleCurrentLabel({ isCurrent: true, currentFor: ['ac', 'dc'] }, t)).toBe(
      'pricing.isCurrent',
    );
    expect(scheduleCurrentLabel({ isCurrent: true }, t)).toBe('pricing.isCurrent');
  });
});
