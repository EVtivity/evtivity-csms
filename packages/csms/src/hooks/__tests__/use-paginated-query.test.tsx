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
});
