// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { putMock } = vi.hoisted(() => ({ putMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { basis?: string }) =>
      options?.basis != null ? `${key}:${options.basis}` : key,
  }),
}));

vi.mock('@/lib/api', () => ({
  api: { put: putMock, delete: vi.fn() },
}));

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { CompanySettings } from '../settings/CompanySettings';

function renderSettings(settings: Record<string, unknown>): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CompanySettings settings={settings} svgDataUri={null} hasIcon={false} />
    </QueryClientProvider>,
  );
}

const SETTINGS = {
  'company.name': 'EVtivity',
  'company.currency': 'EUR',
  'company.priceDisplay': 'gross',
  'company.taxBasis': 'net',
};

function taxBasisSelect(): HTMLSelectElement {
  return document.getElementById('company-tax-basis') as HTMLSelectElement;
}

function submit(): void {
  const form = taxBasisSelect().closest('form');
  if (form == null) throw new Error('form not found');
  fireEvent.submit(form);
}

function taxBasisPut(): unknown[] | undefined {
  return putMock.mock.calls.find((c) => c[0] === '/v1/settings/company.taxBasis') as
    | unknown[]
    | undefined;
}

afterEach(() => {
  cleanup();
  putMock.mockReset();
});

describe('CompanySettings tax basis', () => {
  it('shows the saved tax basis with its description', () => {
    renderSettings({ ...SETTINGS, 'company.taxBasis': 'gross' });
    expect(taxBasisSelect().value).toBe('gross');
    expect(screen.getByText('settings.companyTaxBasisHelper')).toBeTruthy();
  });

  it('saves without confirmation when the tax basis is unchanged', async () => {
    putMock.mockResolvedValue({});
    renderSettings(SETTINGS);
    submit();
    await waitFor(() => {
      expect(taxBasisPut()).toEqual(['/v1/settings/company.taxBasis', { value: 'net' }]);
    });
    expect(screen.queryByText('settings.companyTaxBasisConfirmTitle')).toBeNull();
  });

  it('asks for confirmation before saving a changed tax basis', async () => {
    putMock.mockResolvedValue({});
    renderSettings(SETTINGS);
    fireEvent.change(taxBasisSelect(), { target: { value: 'gross' } });
    submit();

    expect(screen.getByText('settings.companyTaxBasisConfirmTitle')).toBeTruthy();
    expect(
      screen.getByText('settings.companyTaxBasisConfirmDescription:settings.companyTaxBasisGross'),
    ).toBeTruthy();
    expect(putMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /settings\.companyTaxBasisConfirm$/ }));
    await waitFor(() => {
      expect(taxBasisPut()).toEqual(['/v1/settings/company.taxBasis', { value: 'gross' }]);
    });
  });

  it('saves nothing when the confirmation is cancelled', () => {
    renderSettings(SETTINGS);
    fireEvent.change(taxBasisSelect(), { target: { value: 'gross' } });
    submit();
    fireEvent.click(screen.getByRole('button', { name: /common\.cancel/ }));
    expect(putMock).not.toHaveBeenCalled();
  });
});
