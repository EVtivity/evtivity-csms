// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { defaultDashboardLayout, type DashboardLayout } from '@evtivity/lib/dashboard-layout';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: { get: mocks.get, put: mocks.put, delete: mocks.delete },
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { useDashboardLayout } from '../use-dashboard-layout';

function wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function moved(): DashboardLayout {
  const layout = defaultDashboardLayout();
  layout.charts.reverse();
  return layout;
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.put.mockReset();
  mocks.delete.mockReset();
  mocks.toast.mockReset();
});

describe('useDashboardLayout', () => {
  it('is null while loading, then the saved layout', async () => {
    mocks.get.mockResolvedValue({ layout: moved(), customized: true });
    const { result } = renderHook(() => useDashboardLayout(), { wrapper });
    expect(result.current.layout).toBeNull();
    await waitFor(() => {
      expect(result.current.layout).toEqual(moved());
    });
    expect(result.current.customized).toBe(true);
    expect(mocks.get).toHaveBeenCalledWith('/v1/users/me/dashboard-layout');
  });

  it('falls back to the default layout when the load fails', async () => {
    mocks.get.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useDashboardLayout(), { wrapper });
    await waitFor(() => {
      expect(result.current.layout).toEqual(defaultDashboardLayout());
    });
  });

  it('shows a save at once and keeps it when the server accepts it', async () => {
    mocks.get.mockResolvedValue({ layout: defaultDashboardLayout(), customized: false });
    let resolvePut: (value: unknown) => void = () => undefined;
    mocks.put.mockReturnValue(
      new Promise((r) => {
        resolvePut = r;
      }),
    );
    const { result } = renderHook(() => useDashboardLayout(), { wrapper });
    await waitFor(() => {
      expect(result.current.layout).not.toBeNull();
    });
    act(() => {
      result.current.save(moved());
    });
    await waitFor(() => {
      expect(result.current.layout).toEqual(moved());
    });
    expect(mocks.put).toHaveBeenCalledWith('/v1/users/me/dashboard-layout', moved());
    resolvePut({ layout: moved(), customized: true });
    await waitFor(() => {
      expect(result.current.customized).toBe(true);
    });
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('rolls a failed save back and says so', async () => {
    mocks.get.mockResolvedValue({ layout: defaultDashboardLayout(), customized: false });
    mocks.put.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useDashboardLayout(), { wrapper });
    await waitFor(() => {
      expect(result.current.layout).not.toBeNull();
    });
    act(() => {
      result.current.save(moved());
    });
    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledWith({
        title: 'dashboard.layoutSaveFailed',
        variant: 'destructive',
      });
    });
    expect(result.current.layout).toEqual(defaultDashboardLayout());
    expect(result.current.customized).toBe(false);
  });

  it('resets to the default layout', async () => {
    mocks.get.mockResolvedValue({ layout: moved(), customized: true });
    mocks.delete.mockResolvedValue({ layout: defaultDashboardLayout(), customized: false });
    const { result } = renderHook(() => useDashboardLayout(), { wrapper });
    await waitFor(() => {
      expect(result.current.customized).toBe(true);
    });
    act(() => {
      result.current.reset();
    });
    await waitFor(() => {
      expect(result.current.layout).toEqual(defaultDashboardLayout());
    });
    expect(result.current.customized).toBe(false);
    expect(mocks.delete).toHaveBeenCalledWith('/v1/users/me/dashboard-layout');
  });
});
