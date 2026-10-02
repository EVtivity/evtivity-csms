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

const { useAuth } = await import('@/lib/auth');
const { usePriceDisplay } = await import('../use-price-display');

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function signIn(priceDisplay: 'gross' | 'net' | null): void {
  useAuth.setState({
    isAuthenticated: true,
    driver: {
      id: 'drv_1',
      firstName: 'A',
      lastName: 'B',
      email: null,
      phone: null,
      language: 'de',
      timezone: 'Europe/Berlin',
      themePreference: 'light',
      distanceUnit: 'km',
      priceDisplay,
      isActive: true,
      emailVerified: true,
    },
  });
}

describe('usePriceDisplay', () => {
  beforeEach(() => {
    mockGet.mockResolvedValue({ priceDisplay: 'gross' });
    useAuth.setState({ isAuthenticated: false, driver: null });
  });

  it('follows the company setting when the driver has not chosen', async () => {
    signIn(null);
    const { result } = renderHook(() => usePriceDisplay(), { wrapper });
    await waitFor(() => {
      expect(result.current).toBe('gross');
    });
  });

  it('prefers the driver choice', async () => {
    signIn('net');
    const { result } = renderHook(() => usePriceDisplay(), { wrapper });
    await waitFor(() => {
      expect(mockGet).toHaveBeenCalled();
    });
    expect(result.current).toBe('net');
  });

  it('shows guests prices including tax', async () => {
    mockGet.mockResolvedValue({ priceDisplay: 'net' });
    const { result } = renderHook(() => usePriceDisplay(), { wrapper });
    await waitFor(() => {
      expect(mockGet).toHaveBeenCalled();
    });
    expect(result.current).toBe('gross');
  });
});
