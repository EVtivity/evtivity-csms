// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));

import { reportTypeFormats, useReportTypes } from '../use-report-types';

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const TYPES = [
  { type: 'sessions', formats: ['csv', 'xlsx'], generateFromUi: true },
  { type: 'nevi', formats: ['xlsx'], generateFromUi: false },
];

describe('useReportTypes', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('lists every type and the offered ones', async () => {
    getMock.mockResolvedValue(TYPES);
    const { result } = renderHook(() => useReportTypes(), { wrapper });
    await waitFor(() => {
      expect(result.current.all).toHaveLength(2);
    });
    expect(result.current.offered.map((t) => t.type)).toEqual(['sessions']);
    expect(result.current.isError).toBe(false);
  });

  it('reports a load error and loads again on refetch', async () => {
    getMock.mockRejectedValueOnce(new Error('down'));
    const { result } = renderHook(() => useReportTypes(), { wrapper });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.all).toEqual([]);

    getMock.mockResolvedValue(TYPES);
    act(() => {
      result.current.refetch();
    });
    await waitFor(() => {
      expect(result.current.isError).toBe(false);
    });
    expect(result.current.offered).toHaveLength(1);
  });
});

describe('reportTypeFormats', () => {
  it('returns the formats of a type and none for an unknown one', () => {
    expect(reportTypeFormats(TYPES, 'sessions')).toEqual(['csv', 'xlsx']);
    expect(reportTypeFormats(TYPES, 'missing')).toEqual([]);
  });
});
