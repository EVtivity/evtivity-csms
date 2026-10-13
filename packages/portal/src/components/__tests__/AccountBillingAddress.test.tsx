// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, patchMock } = vi.hoisted(() => ({ getMock: vi.fn(), patchMock: vi.fn() }));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return {
    api: { get: getMock, patch: patchMock },
    ApiError,
    getApiErrorCode: (err: unknown) =>
      err instanceof ApiError ? ((err.body as { code?: string } | null)?.code ?? null) : null,
  };
});

vi.mock('@/lib/auth', () => ({
  useAuth: (select: (s: unknown) => unknown) =>
    select({ driver: { firstName: 'Erika', lastName: 'Muster' } }),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

import { AccountBillingAddress } from '../account/AccountBillingAddress';

const EMPTY = {
  billingName: null,
  billingStreet: null,
  billingCity: null,
  billingState: null,
  billingZip: null,
  billingCountry: null,
};

function renderSection(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AccountBillingAddress />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  patchMock.mockReset();
});

describe('AccountBillingAddress', () => {
  it('fills the form from the profile', async () => {
    getMock.mockResolvedValue({ billingAddress: { ...EMPTY, billingCity: 'Berlin' } });
    renderSection();
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('billingAddress.city').value).toBe('Berlin');
    });
    expect(getMock).toHaveBeenCalledWith('/v1/portal/auth/me');
    expect(screen.queryByText('billingAddress.nudge')).toBeNull();
  });

  it('asks a member-billed driver without an address to add one', async () => {
    getMock.mockResolvedValue({ billing: { invoicedTo: 'member' }, billingAddress: EMPTY });
    renderSection();
    expect(await screen.findByText('billingAddress.nudge')).toBeTruthy();
  });

  it('saves the trimmed form, blank fields as null', async () => {
    getMock.mockResolvedValue({ billingAddress: EMPTY });
    patchMock.mockResolvedValue({ ...EMPTY, billingStreet: 'Hauptstrasse 1' });
    renderSection();
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('billingAddress.street').disabled).toBe(false);
    });
    fireEvent.change(screen.getByLabelText('billingAddress.street'), {
      target: { value: ' Hauptstrasse 1 ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/portal/driver/billing-address', {
        ...EMPTY,
        billingStreet: 'Hauptstrasse 1',
      });
    });
    expect(await screen.findByText('billingAddress.updated')).toBeTruthy();
  });
});
