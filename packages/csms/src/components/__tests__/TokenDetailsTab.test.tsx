// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { patchMock } = vi.hoisted(() => ({ patchMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/lib/api', () => ({ api: { patch: patchMock, delete: vi.fn() } }));
vi.mock('@/hooks/use-company-currency', () => ({
  useCompanyCurrency: () => ({ currency: 'USD', isError: false, refetch: vi.fn() }),
}));
vi.mock('@/components/driver-combobox', () => ({ DriverCombobox: () => null }));
vi.mock('@/lib/timezone', () => ({ formatDateTime: (value: string) => value }));

import { TokenDetailsTab } from '../token/TokenDetailsTab';

const TOKEN = {
  id: 'dtk_1',
  driverId: null,
  idToken: 'CARD-1',
  tokenType: 'ISO14443',
  isActive: true,
  prepaidBalanceCents: null as number | null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  driverFirstName: null,
  driverLastName: null,
  driverEmail: null,
};

function submitForm(label: string): void {
  const form = screen.getByLabelText(label).closest('form');
  if (form == null) throw new Error('form not found');
  fireEvent.submit(form);
}

function renderTab(prepaidBalanceCents: number | null): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TokenDetailsTab token={{ ...TOKEN, prepaidBalanceCents }} timezone="UTC" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  patchMock.mockReset();
});

describe('TokenDetailsTab prepaid balance', () => {
  it('shows the prepaid balance in the company currency', () => {
    renderTab(2500);
    expect(screen.getByText('$25.00')).toBeTruthy();
  });

  it('shows a postpaid token as not prepaid', () => {
    renderTab(null);
    expect(screen.getByText('tokens.notPrepaid')).toBeTruthy();
  });

  it('saves a prepaid balance in cents', async () => {
    patchMock.mockResolvedValue({});
    renderTab(null);

    fireEvent.click(screen.getByText('common.edit'));
    fireEvent.click(screen.getByLabelText('tokens.prepaid'));
    fireEvent.change(screen.getByLabelText('tokens.prepaidBalance (USD)'), {
      target: { value: '12.34' },
    });
    submitForm('tokens.prepaidBalance (USD)');

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith(
        '/v1/tokens/dtk_1',
        expect.objectContaining({ prepaidBalanceCents: 1234 }),
      );
    });
  });

  it('requires a balance for a prepaid token', () => {
    renderTab(null);

    fireEvent.click(screen.getByText('common.edit'));
    fireEvent.click(screen.getByLabelText('tokens.prepaid'));
    submitForm('tokens.prepaidBalance (USD)');

    expect(screen.getByText('validation.required')).toBeTruthy();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('makes a prepaid token postpaid again', async () => {
    patchMock.mockResolvedValue({});
    renderTab(500);

    fireEvent.click(screen.getByText('common.edit'));
    fireEvent.click(screen.getByLabelText('tokens.prepaid'));
    submitForm('tokens.prepaid');

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith(
        '/v1/tokens/dtk_1',
        expect.objectContaining({ prepaidBalanceCents: null }),
      );
    });
  });
});
