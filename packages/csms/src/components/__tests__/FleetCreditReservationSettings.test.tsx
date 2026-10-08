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

import { FleetCreditReservationSettings } from '../settings/FleetCreditReservationSettings';

function renderSettings(settings: Record<string, unknown> | undefined): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <FleetCreditReservationSettings settings={settings} />
    </QueryClientProvider>,
  );
}

function amountInput(): HTMLInputElement {
  const input = screen.getByLabelText('settings.fleetCreditReservation');
  if (!(input instanceof HTMLInputElement)) throw new Error('not an input');
  return input;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FleetCreditReservationSettings', () => {
  it('shows the stored slice in major units', () => {
    renderSettings({ 'fleet.creditReservationCents': 7550 });
    expect(amountInput().value).toBe('75.50');
  });

  it('shows the default slice when none is stored', () => {
    renderSettings(undefined);
    expect(amountInput().value).toBe('50.00');
  });

  it('saves the slice in cents through the generic settings route', async () => {
    putMock.mockResolvedValue({});
    renderSettings({ 'fleet.creditReservationCents': 5000 });
    fireEvent.change(amountInput(), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/fleet.creditReservationCents', {
        value: 12000,
      });
    });
  });

  it('refuses a slice of zero without saving', () => {
    renderSettings(undefined);
    fireEvent.change(amountInput(), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(screen.getByText('settings.fleetCreditReservationInvalid')).toBeTruthy();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('refuses a slice above the maximum without saving', () => {
    renderSettings(undefined);
    fireEvent.change(amountInput(), { target: { value: '1000000.01' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(screen.getByText('settings.fleetCreditReservationTooHigh')).toBeTruthy();
    expect(putMock).not.toHaveBeenCalled();
  });
});
