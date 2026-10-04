// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { CardSetupProps } from '../types';

const { stripeMock, loadStripeMock } = vi.hoisted(() => ({
  stripeMock: { confirmCardSetup: vi.fn() },
  loadStripeMock: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@stripe/stripe-js/pure', () => ({ loadStripe: loadStripeMock }));

vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CardElement: () => <div data-testid="card-element" />,
  useStripe: () => stripeMock,
  useElements: () => ({ getElement: () => ({}) }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key.startsWith('errors.') ? `translated:${key}` : key),
  }),
}));

import { ApiError } from '@/lib/api';
import { StripeCardSetup } from '../stripe/StripeCardSetup';
import { getStripe } from '../stripe/load';

function cardProps(overrides: Partial<CardSetupProps> = {}): CardSetupProps {
  return {
    session: {
      provider: 'stripe',
      customerId: 'cus_1',
      clientSecret: 'seti_1_secret_x',
      publishableKey: 'pk_test_1',
    },
    submit: vi.fn().mockResolvedValue({ status: 'saved' }),
    submitDetails: vi.fn(),
    onSaved: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  stripeMock.confirmCardSetup.mockReset();
});

describe('Stripe module', () => {
  it('loads Stripe once per publishable key', () => {
    loadStripeMock.mockClear();
    const a = getStripe('pk_test_once');
    expect(getStripe('pk_test_once')).toBe(a);
    void getStripe('pk_test_other');
    expect(loadStripeMock).toHaveBeenCalledTimes(2);
  });

  it('confirms the SetupIntent and submits the PaymentMethod id', async () => {
    stripeMock.confirmCardSetup.mockResolvedValue({ setupIntent: { payment_method: 'pm_123' } });
    const props = cardProps();
    render(<StripeCardSetup {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'payments.addCard' }));
    await waitFor(() => {
      expect(props.onSaved).toHaveBeenCalled();
    });
    expect(stripeMock.confirmCardSetup).toHaveBeenCalledWith('seti_1_secret_x', {
      payment_method: { card: {} },
    });
    expect(props.submit).toHaveBeenCalledWith({ paymentMethodId: 'pm_123' });
  });

  it('shows the Stripe error and does not submit', async () => {
    stripeMock.confirmCardSetup.mockResolvedValue({ error: { message: 'Card was declined' } });
    const props = cardProps();
    render(<StripeCardSetup {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'payments.addCard' }));
    expect(await screen.findByText('Card was declined')).toBeTruthy();
    expect(props.submit).not.toHaveBeenCalled();
  });

  it('shows a failure when the API refuses the card', async () => {
    stripeMock.confirmCardSetup.mockResolvedValue({ setupIntent: { payment_method: 'pm_1' } });
    const props = cardProps({
      submit: vi.fn().mockResolvedValue({ status: 'refused', reason: 'card_declined' }),
    });
    render(<StripeCardSetup {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'payments.addCard' }));
    expect(await screen.findByText('payments.setupFailed')).toBeTruthy();
    expect(props.onSaved).not.toHaveBeenCalled();
  });

  it('shows the translated API error when submit throws', async () => {
    stripeMock.confirmCardSetup.mockResolvedValue({ setupIntent: { payment_method: 'pm_1' } });
    const props = cardProps({
      submit: vi.fn().mockRejectedValue(new ApiError(403, { code: 'FORBIDDEN' })),
    });
    render(<StripeCardSetup {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'payments.addCard' }));
    expect(await screen.findByText('translated:errors.FORBIDDEN')).toBeTruthy();
  });

  it('calls onCancel', () => {
    const props = cardProps();
    render(<StripeCardSetup {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(props.onCancel).toHaveBeenCalled();
  });

  it('does not mount the form for a session without a publishable key', () => {
    const props = cardProps({ session: { provider: 'stripe', customerId: 'cus_1' } });
    render(<StripeCardSetup {...props} />);
    expect(screen.getByText('payments.setupFailed')).toBeTruthy();
    expect(screen.queryByTestId('card-element')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(props.onCancel).toHaveBeenCalled();
  });
});
