// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { putMock } = vi.hoisted(() => ({ putMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { put: putMock },
}));

import { ApiError } from '@/lib/api';
import { InvoiceSettings } from '../settings/InvoiceSettings';

function renderSettings(settings: Record<string, unknown> | undefined): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <InvoiceSettings settings={settings} />
    </QueryClientProvider>,
  );
}

function daysInput(): HTMLInputElement {
  const input = screen.getByLabelText('settings.invoicePaymentTermsDays');
  if (!(input instanceof HTMLInputElement)) throw new Error('not an input');
  return input;
}

function runDayInput(): HTMLInputElement {
  const input = screen.getByLabelText('settings.fleetInvoiceRunDay');
  if (!(input instanceof HTMLInputElement)) throw new Error('not an input');
  return input;
}

function save(): void {
  fireEvent.click(screen.getByRole('button', { name: /save/i }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InvoiceSettings', () => {
  it('shows the stored payment terms', () => {
    renderSettings({ 'invoice.paymentTermsDays': 14 });
    expect(daysInput().value).toBe('14');
  });

  it('shows 30 days when none are stored', () => {
    renderSettings(undefined);
    expect(daysInput().value).toBe('30');
  });

  it('saves the days through the generic settings route', async () => {
    putMock.mockResolvedValue({});
    renderSettings({ 'invoice.paymentTermsDays': 30 });
    fireEvent.change(daysInput(), { target: { value: '0' } });
    save();
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/invoice.paymentTermsDays', { value: 0 });
    });
    expect(await screen.findByText('settings.invoiceSettingsSaved')).toBeTruthy();
  });

  it.each(['-1', '1.5', '366', ''])('refuses %j without saving', (value) => {
    renderSettings({ 'invoice.paymentTermsDays': 30 });
    fireEvent.change(daysInput(), { target: { value } });
    save();
    expect(screen.getByText('settings.invoicePaymentTermsDaysInvalid')).toBeTruthy();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('shows the API error when the save fails', async () => {
    // The mocked t has no translation for the code, so the API message shows.
    putMock.mockRejectedValue(new ApiError(400, { error: 'Bad terms', code: 'VALIDATION_ERROR' }));
    renderSettings({ 'invoice.paymentTermsDays': 30 });
    save();
    expect(await screen.findByText('Bad terms')).toBeTruthy();
  });

  it('shows the stored run day, and day 1 when none is stored', () => {
    renderSettings({ 'fleet.invoiceRunDay': 5 });
    expect(runDayInput().value).toBe('5');
    cleanup();
    renderSettings(undefined);
    expect(runDayInput().value).toBe('1');
  });

  it('saves the run day through the generic settings route', async () => {
    putMock.mockResolvedValue({});
    renderSettings({ 'invoice.paymentTermsDays': 30, 'fleet.invoiceRunDay': 1 });
    fireEvent.change(runDayInput(), { target: { value: '28' } });
    save();
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/fleet.invoiceRunDay', {
        value: 28,
      });
    });
    expect(putMock).toHaveBeenCalledWith('/v1/settings/invoice.paymentTermsDays', { value: 30 });
  });

  it.each(['0', '29', '2.5', ''])('refuses run day %j without saving', (value) => {
    renderSettings({ 'invoice.paymentTermsDays': 30 });
    fireEvent.change(runDayInput(), { target: { value } });
    save();
    expect(screen.getByText('settings.fleetInvoiceRunDayInvalid')).toBeTruthy();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('falls back to the save failed text for a network error', async () => {
    putMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderSettings({ 'invoice.paymentTermsDays': 30 });
    save();
    expect(await screen.findByText('settings.invoiceSettingsSaveFailed')).toBeTruthy();
  });
});
