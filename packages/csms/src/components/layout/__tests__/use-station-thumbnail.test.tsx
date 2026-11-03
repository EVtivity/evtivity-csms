// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook, waitFor, cleanup } from '@testing-library/react';
import { useStationThumbnail } from '../use-station-thumbnail';
import { useDarkTheme } from '@/hooks/use-dark-theme';
import {
  StationThumbnailCache,
  thumbnailKey,
  type ThumbnailRequest,
} from '../site-layout-station-thumbnail';

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});

function fakeCache(): { cache: StationThumbnailCache; render: ReturnType<typeof vi.fn> } {
  const render = vi.fn((r: ThumbnailRequest) => `data:${thumbnailKey(r)}`);
  return {
    cache: new StationThumbnailCache(() => Promise.resolve({ render, dispose: vi.fn() })),
    render,
  };
}

describe('useStationThumbnail', () => {
  it('answers undefined while rendering, then the image of the model, color and theme', async () => {
    const { cache } = fakeCache();
    const { result } = renderHook(() => useStationThumbnail('dc-dispenser', '#ea7a1a', cache));
    expect(result.current).toBeUndefined();
    await waitFor(() => {
      expect(result.current).toBe('data:dc-dispenser:#ea7a1a:light');
    });
  });

  it('renders the dark theme picture when the page turns dark', async () => {
    const { cache, render } = fakeCache();
    const { result } = renderHook(() => useStationThumbnail('wall-box', '#2563eb', cache));
    await waitFor(() => {
      expect(result.current).toBe('data:wall-box:#2563eb:light');
    });
    act(() => {
      document.documentElement.classList.add('dark');
    });
    await waitFor(() => {
      expect(result.current).toBe('data:wall-box:#2563eb:dark');
    });
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('answers null without WebGL', async () => {
    const cache = new StationThumbnailCache(() => Promise.resolve(null));
    const { result } = renderHook(() => useStationThumbnail('curb-post', '#2563eb', cache));
    await waitFor(() => {
      expect(result.current).toBeNull();
    });
  });
});

describe('useDarkTheme', () => {
  it('follows the dark class on the root', async () => {
    const { result } = renderHook(() => useDarkTheme());
    expect(result.current).toBe(false);
    act(() => {
      document.documentElement.classList.add('dark');
    });
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });
});
