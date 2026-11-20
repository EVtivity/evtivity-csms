// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Elements,
  CardElement,
  ExpressCheckoutElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';
import type {
  StripeElementsOptions,
  StripeError,
  StripeExpressCheckoutElementConfirmEvent,
  StripeExpressCheckoutElementOptions,
} from '@stripe/stripe-js';
import { Button } from '@/components/ui/button';
import { getErrorMessage } from '@/lib/error-message';
import { formatCents } from '@/lib/utils';
import type { GuestPaymentProps } from '../types';
import { cardElementOptions, getStripe, stringField } from './load';
import { GuestAccountPrompt } from '@/components/GuestAccountPrompt';

const KNOWN_CARD_ERRORS: Record<string, string> = {
  card_declined: 'guest.cardDeclined',
  expired_card: 'guest.cardExpired',
  incorrect_cvc: 'guest.incorrectCvc',
  insufficient_funds: 'guest.insufficientFunds',
  processing_error: 'guest.processingError',
};

// Apple Pay and Google Pay only: the guest hold takes a card PaymentMethod.
const EXPRESS_CHECKOUT_OPTIONS: StripeExpressCheckoutElementOptions = {
  paymentMethods: {
    applePay: 'auto',
    googlePay: 'auto',
    link: 'never',
    paypal: 'never',
    amazonPay: 'never',
    klarna: 'never',
  },
  buttonType: { applePay: 'plain', googlePay: 'plain' },
};

function GuestPaymentForm({
  amountCents,
  currency,
  disabled,
  pay,
  canPay,
}: Omit<GuestPaymentProps, 'config' | 'payDetails'>): React.JSX.Element {
  const { t } = useTranslation();
  const stripe = useStripe();
  const elements = useElements();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [walletAvailable, setWalletAvailable] = useState(false);

  function stripeErrorMessage(err: StripeError): string {
    const key = KNOWN_CARD_ERRORS[err.decline_code ?? err.code ?? ''];
    return key != null ? t(key) : (err.message ?? t('guest.cardError'));
  }

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
        setError(stripeErrorMessage(pmError));
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

  // The wallet sheet only yields the PaymentMethod; the start (cable check, station
  // wait) runs on the page like the card's, outside the sheet's timeout.
  async function handleWalletConfirm(
    event: StripeExpressCheckoutElementConfirmEvent,
  ): Promise<void> {
    if (stripe == null || elements == null) return;
    setError('');
    const { error: submitError } = await elements.submit();
    if (submitError != null) {
      event.paymentFailed({ reason: 'fail' });
      setError(stripeErrorMessage(submitError));
      return;
    }
    const { paymentMethod, error: pmError } = await stripe.createPaymentMethod({ elements });
    if (pmError != null) {
      event.paymentFailed({ reason: 'fail' });
      setError(stripeErrorMessage(pmError));
      return;
    }
    setLoading(true);
    try {
      await pay(paymentMethod.id);
    } catch (err: unknown) {
      setError(getErrorMessage(err, t, 'guest.paymentFailed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      {error !== '' && <p className="text-sm text-destructive">{error}</p>}
      <ExpressCheckoutElement
        options={EXPRESS_CHECKOUT_OPTIONS}
        onReady={({ availablePaymentMethods }) => {
          setWalletAvailable(
            availablePaymentMethods != null && Object.values(availablePaymentMethods).some(Boolean),
          );
        }}
        onClick={(event) => {
          // No resolve: the sheet stays closed and the host shows its field error.
          if (loading || disabled || canPay?.() === false) return;
          event.resolve({ lineItems: [{ name: t('guest.walletHoldLabel'), amount: amountCents }] });
        }}
        onConfirm={(event) => void handleWalletConfirm(event)}
      />
      {walletAvailable && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          {t('guest.orPayByCard')}
          <span className="h-px flex-1 bg-border" />
        </div>
      )}
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
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
    </div>
  );
}

export function StripeGuestPayment({
  config,
  amountCents,
  currency,
  disabled,
  pay,
  canPay,
}: GuestPaymentProps): React.JSX.Element {
  const publishableKey = stringField(config, 'publishableKey');
  if (publishableKey == null) {
    // Guest payment is not offered here: the guest charges with an account.
    return <GuestAccountPrompt />;
  }
  // Deferred intent: Express Checkout needs the hold's amount and capture mode, and the
  // payout account when the hold is a destination charge (on_behalf_of).
  const onBehalfOf = stringField(config, 'onBehalfOf');
  const options: StripeElementsOptions = {
    mode: 'payment',
    amount: amountCents,
    currency: currency.toLowerCase(),
    captureMethod: 'manual',
    paymentMethodCreation: 'manual',
    ...(onBehalfOf != null ? { onBehalfOf } : {}),
  };
  return (
    <Elements stripe={getStripe(publishableKey)} options={options}>
      <GuestPaymentForm
        amountCents={amountCents}
        currency={currency}
        disabled={disabled}
        pay={pay}
        {...(canPay != null ? { canPay } : {})}
      />
    </Elements>
  );
}
