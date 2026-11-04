// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { buildPlanSlots } from '../charging-plan.js';

describe('buildPlanSlots', () => {
  it('starts at now and ends the first slot at the next quarter hour', () => {
    const now = Date.parse('2026-11-02T01:07:00Z');
    const slots = buildPlanSlots(now, Date.parse('2026-11-02T02:00:00Z'));
    expect(slots.map((s) => new Date(s.startMs).toISOString())).toEqual([
      '2026-11-02T01:07:00.000Z',
      '2026-11-02T01:15:00.000Z',
      '2026-11-02T01:30:00.000Z',
      '2026-11-02T01:45:00.000Z',
    ]);
    expect(slots[0]!.hours).toBeCloseTo(8 / 60);
    expect(slots[3]!.endMs).toBe(Date.parse('2026-11-02T02:00:00Z'));
  });

  it('caps the horizon at 48 hours', () => {
    const now = Date.parse('2026-11-02T00:00:00Z');
    const slots = buildPlanSlots(now, now + 72 * 3_600_000);
    expect(slots).toHaveLength(192);
  });

  it('returns no slots when the last departure is not after now', () => {
    const now = Date.parse('2026-11-02T00:00:00Z');
    expect(buildPlanSlots(now, now)).toEqual([]);
    expect(buildPlanSlots(now, now - 60_000)).toEqual([]);
  });
});
