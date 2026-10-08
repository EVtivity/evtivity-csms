// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock, post: postMock, delete: vi.fn(), patch: vi.fn() } };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { ApiError } from '@/lib/api';
import { PaymentMethods } from '../PaymentMethods';

const simulatedSession = {
  provider: 'simulated',
  customerId: 'cus_sim_1',
  resultMode: 'sync',
  testCards: [
    { number: '4242424242424242', label: 'Approve (Visa)', scenario: 'approve' },
    { number: '4000002500003155', label: 'Requires authentication', scenario: 'action' },
  ],
};

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <PaymentMethods />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  postMock.mockReset();
});

describe('PaymentMethods', () => {
  it('tells a driver billed on account that no payment method is needed', async () => {
    getMock.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/v1/portal/auth/me' ? { billing: { mode: 'account', fleetName: 'Acme' } } : [],
      ),
    );
    renderPage();
    expect(await screen.findByText('fleetBilling.paymentMethodsNote')).toBeTruthy();
    // No card is needed: the empty state does not ask for one.
    expect(await screen.findByText('fleetBilling.noMethods')).toBeTruthy();
    expect(screen.queryByText('payments.noMethods')).toBeNull();
  });

  it('shows no fleet note to a driver who pays by card', async () => {
    getMock.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/v1/portal/auth/me' ? { billing: { mode: 'card', fleetName: null } } : [],
      ),
    );
    renderPage();
    expect(await screen.findByText('payments.noMethods')).toBeTruthy();
    expect(screen.queryByText('fleetBilling.paymentMethodsNote')).toBeNull();
  });

  it('adds a test card through the provider module and the generic setup route', async () => {
    getMock.mockResolvedValue([]);
    postMock.mockImplementation((path: string) => {
      if (path.endsWith('/setup-intent')) {
        return Promise.resolve({ provider: 'simulated', session: simulatedSession });
      }
      return Promise.resolve({
        status: 'saved',
        method: {
          id: '1',
          driverId: 'd1',
          cardBrand: 'visa',
          cardLast4: '4242',
          isDefault: true,
        },
      });
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'payments.addCard' }));
    expect(await screen.findByText('paymentProviders.simulated.testMode')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'payments.saveCard' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'payments.addCard' })).toBeTruthy();
    });
    const submit = postMock.mock.calls.find(
      ([path]) => path === '/v1/portal/payment-methods/setup/submit',
    );
    expect(submit?.[1]).toEqual({
      provider: 'simulated',
      attemptId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      payload: { testCard: '4242424242424242' },
    });
    // The list is fetched again after the save.
    expect(getMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('runs the simulated challenge with the same attempt id', async () => {
    getMock.mockResolvedValue([]);
    postMock.mockImplementation((path: string) => {
      if (path.endsWith('/setup-intent')) {
        return Promise.resolve({ provider: 'simulated', session: simulatedSession });
      }
      if (path.endsWith('/setup/submit')) {
        return Promise.resolve({
          status: 'action_required',
          action: {
            provider: 'simulated',
            data: { challenge: 'method_setup', methodId: 'pm_sim_action' },
          },
        });
      }
      return Promise.resolve({ status: 'saved', method: { id: '2' } });
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'payments.addCard' }));
    fireEvent.change(await screen.findByLabelText('paymentProviders.simulated.testCard'), {
      target: { value: '4000002500003155' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'payments.saveCard' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'paymentProviders.simulated.challengeApprove' }),
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'payments.addCard' })).toBeTruthy();
    });
    const submitBody = postMock.mock.calls.find(([p]) =>
      String(p).endsWith('/setup/submit'),
    )?.[1] as {
      attemptId: string;
    };
    const detailsBody = postMock.mock.calls.find(([p]) =>
      String(p).endsWith('/setup/details'),
    )?.[1] as { attemptId: string; details: unknown };
    expect(detailsBody.attemptId).toBe(submitBody.attemptId);
    expect(detailsBody.details).toEqual({ methodId: 'pm_sim_action', outcome: 'approve' });
  });

  it('shows provider not configured when no provider is active', async () => {
    getMock.mockResolvedValue([]);
    postMock.mockRejectedValue(new ApiError(400, { code: 'PAYMENT_PROVIDER_NOT_CONFIGURED' }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'payments.addCard' }));
    expect(await screen.findByText('payments.providerNotConfigured')).toBeTruthy();
  });

  it('shows not supported for a provider this portal has no module for', async () => {
    getMock.mockResolvedValue([]);
    postMock.mockResolvedValue({
      provider: 'acme',
      session: { provider: 'acme', customerId: 'cus_acme' },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'payments.addCard' }));
    expect(await screen.findByText('paymentProviders.providerNotSupported')).toBeTruthy();
  });

  it('closes the form on cancel', async () => {
    getMock.mockResolvedValue([]);
    postMock.mockResolvedValue({ provider: 'simulated', session: simulatedSession });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'payments.addCard' }));
    fireEvent.click(await screen.findByRole('button', { name: 'common.cancel' }));
    expect(await screen.findByRole('button', { name: 'payments.addCard' })).toBeTruthy();
  });
});
