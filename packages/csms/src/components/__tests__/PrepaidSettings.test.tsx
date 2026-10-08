// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { putMock } = vi.hoisted(() => ({ putMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => ({ api: { put: putMock } }));
vi.mock('@/hooks/use-company-currency', () => ({
  useCompanyCurrency: () => ({ currency: 'EUR', isError: false, refetch: vi.fn() }),
}));

import { PrepaidSettings } from '../settings/PrepaidSettings';

function renderSettings(settings: Record<string, unknown> | undefined): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PrepaidSettings settings={settings} />
    </QueryClientProvider>,
  );
}

function thresholdInput(): HTMLInputElement {
  const input = screen.getByLabelText('settings.prepaidLowCreditThreshold');
  if (!(input instanceof HTMLInputElement)) throw new Error('not an input');
  return input;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PrepaidSettings', () => {
  it('shows the stored threshold in major units', () => {
    renderSettings({ 'prepaid.lowCreditThresholdCents': 1250 });
    expect(thresholdInput().value).toBe('12.50');
  });

  it('shows the default threshold when none is stored', () => {
    renderSettings(undefined);
    expect(thresholdInput().value).toBe('5.00');
  });

  it('saves the threshold in cents through the generic settings route', async () => {
    putMock.mockResolvedValue({});
    renderSettings({ 'prepaid.lowCreditThresholdCents': 500 });
    fireEvent.change(thresholdInput(), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/prepaid.lowCreditThresholdCents', {
        value: 0,
      });
    });
    expect(await screen.findByText('settings.prepaidSettingsSaved')).toBeTruthy();
  });

  it('refuses a negative amount without saving', () => {
    renderSettings({ 'prepaid.lowCreditThresholdCents': 500 });
    fireEvent.change(thresholdInput(), { target: { value: '-1' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(screen.getByText('settings.prepaidLowCreditThresholdInvalid')).toBeTruthy();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('refuses an amount above the maximum without saving', () => {
    renderSettings({ 'prepaid.lowCreditThresholdCents': 500 });
    fireEvent.change(thresholdInput(), { target: { value: '1000000.01' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(screen.getByText('settings.prepaidLowCreditThresholdTooHigh')).toBeTruthy();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('saves the maximum amount', async () => {
    putMock.mockResolvedValue({});
    renderSettings({ 'prepaid.lowCreditThresholdCents': 500 });
    fireEvent.change(thresholdInput(), { target: { value: '1000000.00' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/prepaid.lowCreditThresholdCents', {
        value: 100_000_000,
      });
    });
  });

  it('shows an error when the save fails', async () => {
    putMock.mockRejectedValue(new Error('403'));
    renderSettings({ 'prepaid.lowCreditThresholdCents': 500 });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText('settings.prepaidSettingsSaveFailed')).toBeTruthy();
  });
});
