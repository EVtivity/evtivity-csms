// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));

import { useQrIcon } from '../use-qr-icon';
import { useGoogleMapsSettings } from '../use-google-maps-settings';
import { useFeatureFlags } from '../use-feature-flags';

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  getMock.mockReset();
});

describe('useQrIcon', () => {
  it('reads the icon from the public branding endpoint', async () => {
    getMock.mockResolvedValue({ name: 'Acme', qrCodeIcon: '<svg/>' });
    const { result } = renderHook(() => useQrIcon(), { wrapper });
    await waitFor(() => {
      expect(result.current.svgDataUri).toBe(`data:image/svg+xml;base64,${btoa('<svg/>')}`);
    });
    expect(getMock).toHaveBeenCalledWith('/v1/portal/branding');
    expect(getMock).not.toHaveBeenCalledWith('/v1/settings');
  });

  it('returns null when no icon is set', async () => {
    getMock.mockResolvedValue({ name: 'Acme' });
    const { result } = renderHook(() => useQrIcon(), { wrapper });
    await waitFor(() => {
      expect(getMock).toHaveBeenCalled();
    });
    expect(result.current.svgDataUri).toBeNull();
  });
});

describe('useGoogleMapsSettings', () => {
  it('reads the key and default view from the public map config endpoint', async () => {
    const config = {
      apiKey: 'browser-key',
      defaultLat: 39.8283,
      defaultLng: -98.5795,
      defaultZoom: 4,
    };
    getMock.mockResolvedValue(config);
    const { result } = renderHook(() => useGoogleMapsSettings(), { wrapper });
    await waitFor(() => {
      expect(result.current.data).toEqual(config);
    });
    expect(getMock).toHaveBeenCalledWith('/v1/portal/chargers/map-config');
    expect(getMock).not.toHaveBeenCalledWith('/v1/settings');
  });
});

describe('useFeatureFlags', () => {
  it('reads every flag from the public features endpoint', async () => {
    const flags = {
      roamingEnabled: true,
      pncEnabled: true,
      reservationEnabled: false,
      supportEnabled: false,
      fleetEnabled: false,
      guestChargingEnabled: false,
      chatbotAiEnabled: true,
    };
    getMock.mockResolvedValue(flags);
    const { result } = renderHook(() => useFeatureFlags(), { wrapper });
    await waitFor(() => {
      expect(result.current.isLoaded).toBe(true);
    });
    expect(result.current.flags).toEqual(flags);
    expect(getMock).toHaveBeenCalledWith('/v1/portal/features');
    expect(getMock).not.toHaveBeenCalledWith('/v1/settings');
  });

  it('uses the defaults until the endpoint answers or when it fails', async () => {
    getMock.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useFeatureFlags(), { wrapper });
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.isLoaded).toBe(false);
    expect(result.current.flags).toEqual({
      roamingEnabled: false,
      pncEnabled: false,
      reservationEnabled: true,
      supportEnabled: true,
      fleetEnabled: true,
      guestChargingEnabled: true,
      chatbotAiEnabled: false,
    });
  });
});
