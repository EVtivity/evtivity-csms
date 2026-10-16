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

import { InvoicePaymentSettings } from '../InvoicePaymentSettings';

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
      <InvoicePaymentSettings settings={settings} />
    </QueryClientProvider>,
  );
}

function save(): void {
  fireEvent.click(screen.getByRole('button', { name: /save/i }));
}

describe('InvoicePaymentSettings', () => {
  it('shows the stored bank details with the IBAN in groups of four', () => {
    renderWith({
      'company.bankAccountHolder': 'Acme GmbH',
      'company.iban': 'DE89370400440532013000',
      'company.bic': 'COBADEFFXXX',
      'company.bankName': 'Commerzbank',
      'invoice.epcQrEnabled': false,
    });
    expect(screen.getByLabelText('settings.invoicePaymentIban')).toHaveProperty(
      'value',
      'DE89 3704 0044 0532 0130 00',
    );
    expect(screen.getByLabelText('settings.invoicePaymentHolder')).toHaveProperty(
      'value',
      'Acme GmbH',
    );
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('saves the normalized IBAN and BIC and the QR switch', async () => {
    renderWith({});
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
    fireEvent.change(screen.getByLabelText('settings.invoicePaymentIban'), {
      target: { value: 'de89 3704 0044 0532 0130 00' },
    });
    fireEvent.change(screen.getByLabelText('settings.invoicePaymentBic'), {
      target: { value: 'cobadeff' },
    });
    save();
    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(5);
    });
    expect(put).toHaveBeenCalledWith('/v1/settings/company.iban', {
      value: 'DE89370400440532013000',
    });
    expect(put).toHaveBeenCalledWith('/v1/settings/company.bic', { value: 'COBADEFF' });
    expect(put).toHaveBeenCalledWith('/v1/settings/company.bankAccountHolder', { value: '' });
    expect(put).toHaveBeenCalledWith('/v1/settings/invoice.epcQrEnabled', { value: true });
  });

  it('refuses an IBAN with a bad checksum and saves nothing', () => {
    renderWith({});
    fireEvent.change(screen.getByLabelText('settings.invoicePaymentIban'), {
      target: { value: 'DE89370400440532013001' },
    });
    save();
    expect(screen.getByText('settings.invoicePaymentIbanInvalid')).toBeTruthy();
    expect(put).not.toHaveBeenCalled();
  });

  it('shows the values read-only without write access', () => {
    canWrite.value = false;
    renderWith({ 'company.iban': 'DE89370400440532013000' });
    expect(screen.getByLabelText('settings.invoicePaymentIban')).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });
});
