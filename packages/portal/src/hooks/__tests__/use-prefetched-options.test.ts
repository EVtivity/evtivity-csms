// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { PREFETCHED_OPTIONS_MAX_AGE_MS, usePrefetchedOptions } from '../use-prefetched-options';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('usePrefetchedOptions', () => {
  it('has the options ready before the click, each set for one prompt', async () => {
    let n = 0;
    const fetcher = vi.fn(() => {
      n += 1;
      return Promise.resolve({ challenge: `c${String(n)}` });
    });
    const { result } = renderHook(() => usePrefetchedOptions(fetcher, true));
    await flush();
    let first: unknown;
    act(() => {
      first = result.current.take();
    });
    expect(first).toEqual({ challenge: 'c1' });
    // Taking a set fetches the next one.
    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
    await flush();
    let second: unknown;
    act(() => {
      second = result.current.take();
    });
    expect(second).toEqual({ challenge: 'c2' });
  });

  it('fetches nothing while disabled and answers null', () => {
    const fetcher = vi.fn(() => Promise.resolve({ challenge: 'c' }));
    const { result } = renderHook(() => usePrefetchedOptions(fetcher, false));
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.take()).toBeNull();
  });

  it('fetches again before the challenge expires and never hands out an old set', async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetcher = vi.fn(() => {
      n += 1;
      return Promise.resolve({ challenge: `c${String(n)}` });
    });
    const { result } = renderHook(() => usePrefetchedOptions(fetcher, true));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREFETCHED_OPTIONS_MAX_AGE_MS);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    let taken: unknown;
    act(() => {
      taken = result.current.take();
    });
    expect(taken).toEqual({ challenge: 'c2' });
  });

  it('answers null for a set older than the limit', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const fetcher = vi.fn(() => Promise.resolve({ challenge: 'c' }));
    const { result } = renderHook(() => usePrefetchedOptions(fetcher, true));
    await flush();
    now.mockReturnValue(1_000 + PREFETCHED_OPTIONS_MAX_AGE_MS);
    let taken: unknown = 'unset';
    act(() => {
      taken = result.current.take();
    });
    expect(taken).toBeNull();
  });

  it('logs a failed prefetch and leaves the click to fetch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetcher = vi
      .fn<() => Promise<{ challenge: string }>>()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue({ challenge: 'later' });
    const { result } = renderHook(() => usePrefetchedOptions(fetcher, true));
    await flush();
    expect(warn).toHaveBeenCalledWith(
      'Passkey options prefetch failed, fetching them on click',
      expect.any(Error),
    );
    expect(result.current.take()).toBeNull();
    await expect(result.current.load()).resolves.toEqual({ challenge: 'later' });
  });
});
