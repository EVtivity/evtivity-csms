// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { Button } from '@/components/ui/button';
import { getErrorMessage } from '@/lib/error-message';
import { formatCents } from '@/lib/utils';
import type { GuestPaymentProps } from '../types';
import { cardElementOptions, getStripe, stringField } from './load';

const KNOWN_CARD_ERRORS: Record<string, string> = {
  card_declined: 'guest.cardDeclined',
  expired_card: 'guest.cardExpired',
  incorrect_cvc: 'guest.incorrectCvc',
  insufficient_funds: 'guest.insufficientFunds',
  processing_error: 'guest.processingError',
};

function GuestPaymentForm({
  amountCents,
  currency,
  disabled,
  pay,
}: Omit<GuestPaymentProps, 'config' | 'payDetails'>): React.JSX.Element {
  const { t } = useTranslation();
  const stripe = useStripe();
  const elements = useElements();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.SyntheticEvent): Promise<void> {
    e.preventDefault();
    if (stripe == null || elements == null || loading || disabled) return;
    const cardElement = elements.getElement(CardElement);
    if (cardElement == null) return;

    setError('');
    setLoading(true);
    try {
      const { paymentMethod, error: pmError } = await stripe.createPaymentMethod({
        type: 'card',
        card: cardElement,
      });
      if (pmError != null) {
        const key = KNOWN_CARD_ERRORS[pmError.decline_code ?? pmError.code ?? ''];
        setError(key != null ? t(key) : (pmError.message ?? t('guest.cardError')));
        return;
      }
      // Stripe payload on the guest start: the PaymentMethod id.
      await pay(paymentMethod.id);
    } catch (err: unknown) {
      setError(getErrorMessage(err, t, 'guest.paymentFailed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      {error !== '' && <p className="text-sm text-destructive">{error}</p>}
      <div className="space-y-2">
        <span className="block text-sm font-medium leading-6">{t('guest.card')}</span>
        <div className="rounded-lg border border-input p-3">
          <CardElement options={cardElementOptions()} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('guest.preAuthHold', { amount: formatCents(amountCents, currency) })}
      </p>
      <Button
        type="submit"
        className="w-full"
        size="lg"
        disabled={stripe == null || loading || disabled}
      >
        {loading ? t('guest.processing') : t('guest.startCharging')}
      </Button>
    </form>
  );
}

export function StripeGuestPayment({
  config,
  amountCents,
  currency,
  disabled,
  pay,
}: GuestPaymentProps): React.JSX.Element {
  const { t } = useTranslation();
  const publishableKey = stringField(config, 'publishableKey');
  if (publishableKey == null) {
    return <p className="text-sm text-destructive">{t('guest.paymentNotConfigured')}</p>;
  }
  return (
    <Elements stripe={getStripe(publishableKey)}>
      <GuestPaymentForm
        amountCents={amountCents}
        currency={currency}
        disabled={disabled}
        pay={pay}
      />
    </Elements>
  );
}
