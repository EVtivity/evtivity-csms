// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), put: vi.fn() },
  toastMock: vi.fn(),
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { StationUnitsSettings } from '../StationUnitsSettings';

function setup(settings: Record<string, unknown> | undefined): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StationUnitsSettings settings={settings} />
    </QueryClientProvider>,
  );
}

function toggle(): HTMLElement {
  return screen.getByRole('switch', { name: 'settings.station.unitsEnabled' });
}

beforeEach(() => {
  apiMock.put.mockResolvedValue({ key: 'stationUnits.enabled', value: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Station settings: Enable Station Units', () => {
  it('reads a missing setting as off and shows the help text', () => {
    setup({});
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('settings.station.unitsEnabledDesc')).toBeTruthy();
  });

  it('turns it on at once', async () => {
    setup({ 'stationUnits.enabled': false });
    fireEvent.click(toggle());
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/stationUnits.enabled', {
        value: true,
      });
    });
  });

  it('asks before turning it off, then saves false', async () => {
    setup({ 'stationUnits.enabled': true });
    fireEvent.click(toggle());
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('confirm-toggle-off-effect').textContent).toBe(
      'settings.station.unitsOffEffect',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.toggleOff.confirm' }));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/stationUnits.enabled', {
        value: false,
      });
    });
  });

  it('puts the switch back on and names the reason when stations still use units', async () => {
    apiMock.put.mockRejectedValue(
      new ApiError(409, { error: 'in use', code: 'STATION_UNITS_FEATURE_IN_USE' }),
    );
    setup({ 'stationUnits.enabled': true });
    fireEvent.click(toggle());
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.toggleOff.confirm' }));
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'destructive',
          // The test t() has no translation, so the API message shows.
          title: 'in use',
        }),
      );
    });
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });
});
