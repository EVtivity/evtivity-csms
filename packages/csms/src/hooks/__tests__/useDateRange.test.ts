// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDateRange } from '../useDateRange';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 5, 10, 12, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDateRange', () => {
  it('starts on the preset number of days, its range ending today', () => {
    const { result } = renderHook(() => useDateRange(30));
    expect(result.current.days).toBe(30);
    expect(result.current.dateQuery).toBe('days=30');
    expect(result.current.effectiveFrom).toBe('2026-05-11');
    expect(result.current.effectiveTo).toBe('2026-06-10');
  });

  it('queries a custom range by its dates, and a preset clears it again', () => {
    const { result } = renderHook(() => useDateRange());
    expect(result.current.days).toBe(7);
    act(() => {
      result.current.handleCustom('2026-01-01', '2026-01-31');
    });
    expect(result.current.dateQuery).toBe('from=2026-01-01&to=2026-01-31');
    expect(result.current.effectiveFrom).toBe('2026-01-01');
    expect(result.current.effectiveTo).toBe('2026-01-31');
    act(() => {
      result.current.handlePreset(90);
    });
    expect(result.current.customFrom).toBeNull();
    expect(result.current.customTo).toBeNull();
    expect(result.current.dateQuery).toBe('days=90');
    expect(result.current.effectiveFrom).toBe('2026-03-12');
  });
});
