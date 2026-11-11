// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const mockGet = vi.fn<(path: string) => Promise<unknown>>();
vi.mock('@/lib/api', () => ({
  api: { get: (path: string) => mockGet(path) },
  ApiError: class ApiError extends Error {},
}));

const { usePortalFeatures, PORTAL_FEATURES_QUERY_KEY, PORTAL_FEATURES_STALE_TIME_MS } =
  await import('../use-portal-features');

function makeWrapper(client: QueryClient): (props: { children: ReactNode }) => React.JSX.Element {
  return function Wrapper({ children }: { children: ReactNode }): React.JSX.Element {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('usePortalFeatures', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockResolvedValue({ reservationEnabled: false, rfidSelfServiceEnabled: true });
  });

  it('reads /v1/portal/features under the shared key with a 60 s stale time', async () => {
    const client = newClient();
    const { result } = renderHook(() => usePortalFeatures(), { wrapper: makeWrapper(client) });
    await waitFor(() => {
      expect(result.current.data).toEqual({
        reservationEnabled: false,
        rfidSelfServiceEnabled: true,
      });
    });
    expect(mockGet).toHaveBeenCalledWith('/v1/portal/features');
    expect(PORTAL_FEATURES_QUERY_KEY).toEqual(['portal-features']);
    expect(PORTAL_FEATURES_STALE_TIME_MS).toBe(60_000);
    const query = client.getQueryCache().find({ queryKey: PORTAL_FEATURES_QUERY_KEY });
    expect(query).toBeDefined();
  });

  it('serves every reader from one request', async () => {
    const client = newClient();
    const wrapper = makeWrapper(client);
    const first = renderHook(() => usePortalFeatures(), { wrapper });
    const second = renderHook(() => usePortalFeatures(), { wrapper });
    await waitFor(() => {
      expect(first.result.current.isSuccess).toBe(true);
      expect(second.result.current.isSuccess).toBe(true);
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('reads nothing while disabled', async () => {
    const client = newClient();
    const { result } = renderHook(() => usePortalFeatures({ enabled: false }), {
      wrapper: makeWrapper(client),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.data).toBeUndefined();
    expect(mockGet).not.toHaveBeenCalled();
  });
});
