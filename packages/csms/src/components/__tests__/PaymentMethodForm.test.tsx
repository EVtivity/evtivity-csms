// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { post: postMock } };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key.startsWith('errors.') ? `translated:${key}` : key),
  }),
}));

import { ApiError } from '@/lib/api';
import { PaymentMethodForm } from '../PaymentMethodForm';

const simulatedSession = {
  provider: 'simulated',
  customerId: 'cus_sim_1',
  resultMode: 'sync',
  testCards: [{ number: '4242424242424242', label: 'Approve (Visa)', scenario: 'approve' }],
};

afterEach(() => {
  cleanup();
  postMock.mockReset();
});

describe('PaymentMethodForm', () => {
  it('starts the setup and saves a test card through the operator setup route', async () => {
    postMock.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith('/setup-intent')
          ? { provider: 'simulated', session: simulatedSession }
          : { status: 'saved', method: { id: '1' } },
      ),
    );
    const onSuccess = vi.fn();
    render(<PaymentMethodForm driverId="drv 1" onSuccess={onSuccess} onCancel={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'payments.addCard' }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
    expect(postMock).toHaveBeenCalledWith('/v1/drivers/drv%201/payment-methods/setup-intent', {});
    expect(postMock).toHaveBeenCalledWith('/v1/drivers/drv%201/payment-methods/setup/submit', {
      provider: 'simulated',
      attemptId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      payload: { testCard: '4242424242424242' },
    });
  });

  it('shows provider not configured with a retry', async () => {
    postMock
      .mockRejectedValueOnce(new ApiError(400, { code: 'PAYMENT_PROVIDER_NOT_CONFIGURED' }))
      .mockResolvedValue({ provider: 'simulated', session: simulatedSession });
    render(<PaymentMethodForm driverId="drv_1" onSuccess={vi.fn()} onCancel={vi.fn()} />);

    expect(await screen.findByText('payments.providerNotConfigured')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    expect(await screen.findByText('paymentProviders.simulated.testMode')).toBeTruthy();
  });

  it('shows the API error of another failure', async () => {
    postMock.mockRejectedValue(new ApiError(404, { code: 'DRIVER_NOT_FOUND' }));
    render(<PaymentMethodForm driverId="drv_1" onSuccess={vi.fn()} onCancel={vi.fn()} />);
    expect(await screen.findByText('translated:errors.DRIVER_NOT_FOUND')).toBeTruthy();
  });

  it('shows not supported for a provider the dashboard has no module for', async () => {
    postMock.mockResolvedValue({
      provider: 'acme',
      session: { provider: 'acme', customerId: 'cus_acme' },
    });
    render(<PaymentMethodForm driverId="drv_1" onSuccess={vi.fn()} onCancel={vi.fn()} />);
    expect(await screen.findByText('paymentProviders.providerNotSupported')).toBeTruthy();
  });

  it('cancels from the provider form', async () => {
    postMock.mockResolvedValue({ provider: 'simulated', session: simulatedSession });
    const onCancel = vi.fn();
    render(<PaymentMethodForm driverId="drv_1" onSuccess={vi.fn()} onCancel={onCancel} />);
    await screen.findByText('paymentProviders.simulated.testMode');
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
