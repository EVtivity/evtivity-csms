// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, patchMock } = vi.hoisted(() => ({ getMock: vi.fn(), patchMock: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock, patch: patchMock, delete: vi.fn(), post: vi.fn() } };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: null }), useHasPermission: () => true }));

vi.mock('@/components/ui/tabs', () => ({
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { DriverPaymentMethodsTab } from '../driver/DriverPaymentMethodsTab';

function method(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'pm_row_1',
    driverId: 'drv_1',
    provider: 'stripe',
    providerCustomerId: 'cus_1',
    providerPaymentMethodId: 'pm_1',
    cardBrand: 'visa',
    cardLast4: '4242',
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderTab(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DriverPaymentMethodsTab driverId="drv_1" timezone="UTC" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  patchMock.mockReset();
});

describe('DriverPaymentMethodsTab', () => {
  it('shows the provider of each saved card', async () => {
    getMock.mockResolvedValue([
      method({}),
      method({ id: 'pm_row_2', provider: 'simulated', isDefault: false, cardLast4: '4444' }),
    ]);
    renderTab();
    expect(await screen.findByText('paymentProviders.names.stripe')).toBeTruthy();
    expect(screen.getByText('paymentProviders.names.simulated')).toBeTruthy();
    expect(screen.getByText('payments.provider')).toBeTruthy();
  });

  it('sets a card as default by its string id', async () => {
    getMock.mockResolvedValue([method({ id: 'pm row/2', isDefault: false })]);
    patchMock.mockResolvedValue({});
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'payments.setAsDefault' }));
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith(
        '/v1/drivers/drv_1/payment-methods/pm%20row%2F2/default',
        {},
      );
    });
  });
});
