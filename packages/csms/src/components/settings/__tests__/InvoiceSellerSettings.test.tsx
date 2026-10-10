// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { put, canWrite } = vi.hoisted(() => ({
  put: vi.fn(() => Promise.resolve({})),
  canWrite: { value: true },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/lib/api', () => ({ api: { put } }));

vi.mock('@/lib/auth', () => ({
  useHasCompanyWidePermission: () => canWrite.value,
}));

import { InvoiceSellerSettings } from '../InvoiceSellerSettings';

beforeEach(() => {
  canWrite.value = true;
  put.mockClear();
});

afterEach(() => {
  cleanup();
});

function renderWith(settings: Record<string, unknown> | undefined): void {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <InvoiceSellerSettings settings={settings} />
    </QueryClientProvider>,
  );
}

function save(): void {
  fireEvent.click(screen.getByRole('button', { name: /save/i }));
}

describe('InvoiceSellerSettings', () => {
  it('shows the stored seller details', () => {
    renderWith({
      'company.taxId': 'DE123456789',
      'company.taxIdLabel': 'USt-IdNr.',
      'company.registrationNumber': 'HRB 12345',
      'company.invoiceEmail': 'billing@acme.example',
      'company.invoicePhone': '+49 30 1234567',
    });
    expect(screen.getByLabelText('settings.invoiceSellerTaxId')).toHaveProperty(
      'value',
      'DE123456789',
    );
    expect(screen.getByLabelText('settings.invoiceSellerTaxIdLabel')).toHaveProperty(
      'value',
      'USt-IdNr.',
    );
    expect(screen.getByLabelText('settings.invoiceSellerRegistrationNumber')).toHaveProperty(
      'value',
      'HRB 12345',
    );
    expect(screen.getByLabelText('settings.invoiceSellerEmail')).toHaveProperty(
      'value',
      'billing@acme.example',
    );
    expect(screen.getByLabelText('settings.invoiceSellerPhone')).toHaveProperty(
      'value',
      '+49 30 1234567',
    );
  });

  it('saves every field trimmed, empty ones included', async () => {
    renderWith({});
    fireEvent.change(screen.getByLabelText('settings.invoiceSellerTaxId'), {
      target: { value: '  DE123456789 ' },
    });
    save();
    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(5);
    });
    expect(put).toHaveBeenCalledWith('/v1/settings/company.taxId', { value: 'DE123456789' });
    expect(put).toHaveBeenCalledWith('/v1/settings/company.taxIdLabel', { value: '' });
    expect(put).toHaveBeenCalledWith('/v1/settings/company.invoiceEmail', { value: '' });
    expect(await screen.findByText('settings.invoiceSellerSaved')).toBeTruthy();
  });

  it('refuses an invalid email and saves nothing', async () => {
    renderWith({});
    fireEvent.change(screen.getByLabelText('settings.invoiceSellerEmail'), {
      target: { value: 'billing' },
    });
    save();
    expect(await screen.findByText('settings.invoiceSellerEmailInvalid')).toBeTruthy();
    expect(put).not.toHaveBeenCalled();
  });

  it('disables the fields and hides Save without company-wide write access', () => {
    canWrite.value = false;
    renderWith({ 'company.taxId': 'DE123456789' });
    expect(screen.getByLabelText('settings.invoiceSellerTaxId')).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });
});
