// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));

import { usePaginatedQuery } from '../use-paginated-query';

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** One client shared by several hooks, as the pages of one app share it. */
function sharedWrapper(client: QueryClient) {
  return function SharedWrapper({ children }: { children: ReactNode }): React.JSX.Element {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('usePaginatedQuery', () => {
  beforeEach(() => {
    getMock.mockReset();
    getMock.mockResolvedValue({ data: [], total: 0 });
  });

  it('sends no search by default', async () => {
    const { result } = renderHook(() => usePaginatedQuery('sessions', '/v1/sessions'), {
      wrapper,
    });
    await waitFor(() => {
      expect(getMock).toHaveBeenCalled();
    });
    expect(result.current.search).toBe('');
    expect(getMock.mock.calls[0]?.[0]).toBe('/v1/sessions?page=1&limit=10');
  });

  it('starts with the initial search, which the user can then change', async () => {
    const { result } = renderHook(
      () => usePaginatedQuery('sessions', '/v1/sessions', undefined, 'vid:0a1b2c3d4e5f'),
      { wrapper },
    );
    expect(result.current.search).toBe('vid:0a1b2c3d4e5f');
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith(
        '/v1/sessions?page=1&limit=10&search=vid%3A0a1b2c3d4e5f',
      );
    });
    act(() => {
      result.current.setSearch('RFID-1');
    });
    await waitFor(() => {
      expect(getMock).toHaveBeenLastCalledWith('/v1/sessions?page=1&limit=10&search=RFID-1');
    });
  });

  it('never shares a cache entry between two URLs with the same key prefix', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getMock.mockImplementation((url: string) => Promise.resolve({ data: [{ url }], total: 1 }));
    const first = renderHook(
      () => usePaginatedQuery<{ url: string }>('session-events', '/v1/sessions/ses_1/events'),
      { wrapper: sharedWrapper(client) },
    );
    await waitFor(() => {
      expect(first.result.current.data?.[0]?.url).toBe('/v1/sessions/ses_1/events?page=1&limit=10');
    });
    const second = renderHook(
      () => usePaginatedQuery<{ url: string }>('session-events', '/v1/sessions/ses_2/events'),
      { wrapper: sharedWrapper(client) },
    );
    // Without the URL in the key the second session showed the first one's rows.
    expect(second.result.current.data).toBeUndefined();
    await waitFor(() => {
      expect(second.result.current.data?.[0]?.url).toBe(
        '/v1/sessions/ses_2/events?page=1&limit=10',
      );
    });
  });

  it('separates filters that share a value under different names', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getMock.mockImplementation((url: string) => Promise.resolve({ data: [{ url }], total: 1 }));
    const bySite = renderHook(
      () => usePaginatedQuery<{ url: string }>('sessions', '/v1/sessions', { siteId: 'x' }),
      { wrapper: sharedWrapper(client) },
    );
    await waitFor(() => {
      expect(bySite.result.current.data).toBeDefined();
    });
    const byStation = renderHook(
      () => usePaginatedQuery<{ url: string }>('sessions', '/v1/sessions', { stationId: 'x' }),
      { wrapper: sharedWrapper(client) },
    );
    expect(byStation.result.current.data).toBeUndefined();
  });

  it('keeps an array key as the prefix, so invalidating the prefix refetches the list', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(
      () => usePaginatedQuery(['sessions', 'ses_1', 'meter-values'], '/v1/sessions/ses_1/mv'),
      { wrapper: sharedWrapper(client) },
    );
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['sessions'] });
    });
    expect(getMock).toHaveBeenCalledTimes(2);
  });
});
