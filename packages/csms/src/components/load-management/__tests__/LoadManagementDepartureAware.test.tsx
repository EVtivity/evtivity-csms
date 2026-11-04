// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, putMock, flags } = vi.hoisted(() => {
  // The tab reads the color scheme through matchMedia, which jsdom lacks.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  return {
    getMock: vi.fn(),
    putMock: vi.fn(),
    flags: { fleetChargingEnabled: true },
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => {
  class ApiError extends Error {}
  return { api: { get: getMock, put: putMock, patch: vi.fn() }, ApiError };
});
vi.mock('@/hooks/use-feature-flags', () => ({
  useFeatureFlags: () => ({ flags, isLoading: false, isLoaded: true }),
}));
vi.mock('@/lib/timezone', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/timezone')>()),
  useUserTimezone: () => 'UTC',
}));
vi.mock('../PanelTree', () => ({ PanelTree: () => <div /> }));
vi.mock('../PanelForm', () => ({ PanelForm: () => null }));

import { LoadManagement, finishBufferError } from '../LoadManagement';

function wrap(strategy: string, departureBufferMinutes = 30): void {
  getMock.mockResolvedValue({
    config: { strategy, isEnabled: true, departureBufferMinutes },
    hierarchy: [],
    stations: [],
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <LoadManagement siteId="sit_1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  flags.fleetChargingEnabled = true;
});

describe('LoadManagement Departure Aware strategy', () => {
  it('offers Departure Aware only while fleet charging is on', async () => {
    flags.fleetChargingEnabled = false;
    wrap('equal_share');
    const select = await screen.findByLabelText('loadManagement.allocationStrategy');
    expect(select.querySelector('option[value="departure_aware"]')).toBeNull();
    cleanup();
    flags.fleetChargingEnabled = true;
    wrap('equal_share');
    const shown = await screen.findByLabelText('loadManagement.allocationStrategy');
    expect(shown.querySelector('option[value="departure_aware"]')).not.toBeNull();
  });

  it('keeps a saved Departure Aware strategy selectable after the setting is turned off', async () => {
    flags.fleetChargingEnabled = false;
    wrap('departure_aware');
    const select = await screen.findByLabelText('loadManagement.allocationStrategy');
    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe('departure_aware');
    });
  });

  it('saves the Finish Buffer with the strategy and refuses a value out of range', async () => {
    putMock.mockResolvedValue({});
    wrap('departure_aware', 45);
    const buffer = await screen.findByLabelText('loadManagement.finishBuffer');
    await waitFor(() => {
      expect((buffer as HTMLInputElement).value).toBe('45');
    });
    fireEvent.change(buffer, { target: { value: '200' } });
    fireEvent.submit(buffer.closest('form') as HTMLFormElement);
    expect(await screen.findByText('loadManagement.finishBufferRange')).toBeTruthy();
    expect(putMock).not.toHaveBeenCalled();
    fireEvent.change(buffer, { target: { value: '60' } });
    fireEvent.submit(buffer.closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/sites/sit_1/load-management', {
        strategy: 'departure_aware',
        isEnabled: true,
        departureBufferMinutes: 60,
      });
    });
  });

  it('shows no Finish Buffer for another strategy', async () => {
    wrap('priority_based');
    await screen.findByLabelText('loadManagement.allocationStrategy');
    expect(screen.queryByLabelText('loadManagement.finishBuffer')).toBeNull();
  });

  it('checks the buffer value', () => {
    expect(finishBufferError('')).toBe('required');
    expect(finishBufferError('-1')).toBe('range');
    expect(finishBufferError('12.5')).toBe('range');
    expect(finishBufferError('181')).toBe('range');
    expect(finishBufferError('0')).toBeNull();
    expect(finishBufferError('180')).toBeNull();
  });
});
