// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { CardSetupProps, GuestPaymentProps } from '../types';

const { stripeMock, loadStripeMock } = vi.hoisted(() => ({
  stripeMock: { confirmCardSetup: vi.fn(), createPaymentMethod: vi.fn() },
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
import { StripeGuestPayment } from '../stripe/StripeGuestPayment';
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

function guestProps(overrides: Partial<GuestPaymentProps> = {}): GuestPaymentProps {
  return {
    config: { provider: 'stripe', publishableKey: 'pk_test_1' },
    amountCents: 5000,
    currency: 'USD',
    disabled: false,
    pay: vi.fn().mockResolvedValue({ status: 'done' }),
    payDetails: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  stripeMock.confirmCardSetup.mockReset();
  stripeMock.createPaymentMethod.mockReset();
});

describe('Stripe module', () => {
  it('loads Stripe once per publishable key', () => {
    loadStripeMock.mockClear();
    const a = getStripe('pk_test_once');
    expect(getStripe('pk_test_once')).toBe(a);
    void getStripe('pk_test_other');
    expect(loadStripeMock).toHaveBeenCalledTimes(2);
  });

  describe('StripeCardSetup', () => {
    it('confirms the SetupIntent and submits the PaymentMethod id', async () => {
      stripeMock.confirmCardSetup.mockResolvedValue({
        setupIntent: { payment_method: 'pm_123' },
      });
      const props = cardProps();
      render(<StripeCardSetup {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'payments.saveCard' }));
      await waitFor(() => {
        expect(props.onSaved).toHaveBeenCalled();
      });
      expect(stripeMock.confirmCardSetup).toHaveBeenCalledWith('seti_1_secret_x', {
        payment_method: { card: {} },
      });
      expect(props.submit).toHaveBeenCalledWith({ paymentMethodId: 'pm_123' });
    });

    it('accepts an expanded PaymentMethod object', async () => {
      stripeMock.confirmCardSetup.mockResolvedValue({
        setupIntent: { payment_method: { id: 'pm_obj' } },
      });
      const props = cardProps();
      render(<StripeCardSetup {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'payments.saveCard' }));
      await waitFor(() => {
        expect(props.submit).toHaveBeenCalledWith({ paymentMethodId: 'pm_obj' });
      });
    });

    it('shows the Stripe error and does not submit', async () => {
      stripeMock.confirmCardSetup.mockResolvedValue({ error: { message: 'Card was declined' } });
      const props = cardProps();
      render(<StripeCardSetup {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'payments.saveCard' }));
      expect(await screen.findByText('Card was declined')).toBeTruthy();
      expect(props.submit).not.toHaveBeenCalled();
    });

    it('shows a failure when the API refuses the card', async () => {
      stripeMock.confirmCardSetup.mockResolvedValue({ setupIntent: { payment_method: 'pm_1' } });
      const props = cardProps({
        submit: vi.fn().mockResolvedValue({ status: 'refused', reason: 'card_declined' }),
      });
      render(<StripeCardSetup {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'payments.saveCard' }));
      expect(await screen.findByText('payments.cardSetupFailed')).toBeTruthy();
      expect(props.onSaved).not.toHaveBeenCalled();
    });

    it('shows the translated API error when submit throws', async () => {
      stripeMock.confirmCardSetup.mockResolvedValue({ setupIntent: { payment_method: 'pm_1' } });
      const props = cardProps({
        submit: vi
          .fn()
          .mockRejectedValue(new ApiError(400, { code: 'PAYMENT_PROVIDER_NOT_CONFIGURED' })),
      });
      render(<StripeCardSetup {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'payments.saveCard' }));
      expect(
        await screen.findByText('translated:errors.PAYMENT_PROVIDER_NOT_CONFIGURED'),
      ).toBeTruthy();
    });

    it('calls onCancel', () => {
      const props = cardProps();
      render(<StripeCardSetup {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
      expect(props.onCancel).toHaveBeenCalled();
    });

    it('does not mount the form for a session without a client secret', () => {
      render(
        <StripeCardSetup
          {...cardProps({ session: { provider: 'stripe', customerId: 'cus_1' } })}
        />,
      );
      expect(screen.getByText('payments.cardSetupFailed')).toBeTruthy();
      expect(screen.queryByTestId('card-element')).toBeNull();
    });
  });

  describe('StripeGuestPayment', () => {
    it('creates a PaymentMethod and pays with its id', async () => {
      stripeMock.createPaymentMethod.mockResolvedValue({ paymentMethod: { id: 'pm_guest' } });
      const props = guestProps();
      render(<StripeGuestPayment {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'guest.startCharging' }));
      await waitFor(() => {
        expect(props.pay).toHaveBeenCalledWith('pm_guest');
      });
      expect(stripeMock.createPaymentMethod).toHaveBeenCalledWith({ type: 'card', card: {} });
    });

    it('maps a known decline code', async () => {
      stripeMock.createPaymentMethod.mockResolvedValue({
        error: { code: 'card_declined', message: 'Your card was declined.' },
      });
      const props = guestProps();
      render(<StripeGuestPayment {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'guest.startCharging' }));
      expect(await screen.findByText('guest.cardDeclined')).toBeTruthy();
      expect(props.pay).not.toHaveBeenCalled();
    });

    it('shows the error when pay rejects', async () => {
      stripeMock.createPaymentMethod.mockResolvedValue({ paymentMethod: { id: 'pm_guest' } });
      const props = guestProps({
        pay: vi.fn().mockRejectedValue(new ApiError(400, { code: 'PAYMENT_FAILED' })),
      });
      render(<StripeGuestPayment {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'guest.startCharging' }));
      expect(await screen.findByText('translated:errors.PAYMENT_FAILED')).toBeTruthy();
    });

    it('does not pay while disabled', () => {
      const props = guestProps({ disabled: true });
      render(<StripeGuestPayment {...props} />);
      const button = screen.getByRole('button', { name: 'guest.startCharging' });
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });

    it('shows not configured without a publishable key', () => {
      render(<StripeGuestPayment {...guestProps({ config: { provider: 'stripe' } })} />);
      expect(screen.getByText('guest.paymentNotConfigured')).toBeTruthy();
    });
  });
});
