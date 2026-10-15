// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      key === 'dashboard.deltaRange'
        ? `${values?.current ?? ''} vs ${values?.previous ?? ''}`
        : key,
  }),
}));

import { computeDelta, useDayDeltaContext } from '../use-day-delta-context';

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function day(date: string, hasData: boolean, daySessions: number) {
  return { date, hasData, daySessions, totalRevenueCents: null };
}

describe('useDayDeltaContext', () => {
  beforeEach(() => {
    getMock.mockReset();
    // Just after midnight UTC on Oct 14 is still Oct 13 in Los Angeles: the
    // browser clock and zone must not decide which days are compared.
    vi.stubEnv('TZ', 'America/Los_Angeles');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T00:30:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('compares the days the API picks and labels them with those dates', async () => {
    getMock.mockResolvedValue({
      current: day('2026-10-12', true, 12),
      previous: day('2026-10-11', true, 8),
    });
    const { result } = renderHook(() => useDayDeltaContext(), { wrapper });
    await waitFor(() => {
      expect(result.current.yd).toBeDefined();
    });
    expect(getMock).toHaveBeenCalledWith('/v1/dashboard/snapshots/day-over-day');
    expect(result.current.deltaLabel).toBe('Oct 12 vs Oct 11');
    expect(
      result.current.dayDelta(result.current.yd?.daySessions, result.current.db?.daySessions),
    ).toBe(50);
  });

  it('shows no arrow when either day has no snapshot', async () => {
    getMock.mockResolvedValue({
      current: day('2026-10-13', true, 5),
      previous: day('2026-10-12', false, 0),
    });
    const { result } = renderHook(() => useDayDeltaContext(), { wrapper });
    await waitFor(() => {
      expect(result.current.db).toBeDefined();
    });
    expect(result.current.dayDelta(5, 0)).toBeNull();
  });

  it('has no label before the answer', () => {
    getMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useDayDeltaContext(), { wrapper });
    expect(result.current.deltaLabel).toBe('');
    expect(result.current.dayDelta(1, 2)).toBeNull();
  });
});

describe('computeDelta', () => {
  it('gives the percent change, and null for a hidden value', () => {
    expect(computeDelta(110, 100)).toBe(10);
    expect(computeDelta(5, 0)).toBe(100);
    expect(computeDelta(0, 0)).toBe(0);
    expect(computeDelta(null, 100)).toBeNull();
  });
});
