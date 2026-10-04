// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/cancel-button';
import { getErrorMessage } from '@/lib/error-message';
import type { CardSetupProps } from '../types';
import { cardElementOptions, getStripe, stringField } from './load';

function CardSetupForm({
  clientSecret,
  submit,
  onSaved,
  onCancel,
}: Omit<CardSetupProps, 'session' | 'submitDetails'> & {
  clientSecret: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const stripe = useStripe();
  const elements = useElements();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.SyntheticEvent): Promise<void> {
    e.preventDefault();
    if (stripe == null || elements == null || loading) return;
    const cardElement = elements.getElement(CardElement);
    if (cardElement == null) return;

    setError(null);
    setLoading(true);
    try {
      // Stripe runs 3DS inside confirmCardSetup, so the saved method needs no further action.
      const { setupIntent, error: stripeError } = await stripe.confirmCardSetup(clientSecret, {
        payment_method: { card: cardElement },
      });
      if (stripeError != null) {
        setError(stripeError.message ?? t('payments.setupFailed'));
        return;
      }
      const pm = setupIntent.payment_method;
      if (pm == null) {
        setError(t('payments.setupFailed'));
        return;
      }
      const paymentMethodId = typeof pm === 'string' ? pm : pm.id;
      const result = await submit({ paymentMethodId });
      if (result.status === 'saved') {
        onSaved();
        return;
      }
      setError(t('payments.setupFailed'));
    } catch (err: unknown) {
      setError(getErrorMessage(err, t, 'payments.setupFailed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      <div className="rounded-md border bg-background p-3">
        <CardElement options={cardElementOptions()} />
      </div>
      {error != null && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={stripe == null || loading}>
          {loading ? t('common.saving') : t('payments.addCard')}
        </Button>
        <CancelButton onClick={onCancel} />
      </div>
    </form>
  );
}

export function StripeCardSetup({
  session,
  submit,
  onSaved,
  onCancel,
}: CardSetupProps): React.JSX.Element {
  const { t } = useTranslation();
  const publishableKey = stringField(session, 'publishableKey');
  const clientSecret = stringField(session, 'clientSecret');

  // The API validates both before answering; a broken session must not mount a blank form.
  if (publishableKey == null || clientSecret == null) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">{t('payments.setupFailed')}</p>
        <div className="flex justify-end">
          <CancelButton onClick={onCancel} />
        </div>
      </div>
    );
  }

  return (
    <Elements stripe={getStripe(publishableKey)}>
      <CardSetupForm
        clientSecret={clientSecret}
        submit={submit}
        onSaved={onSaved}
        onCancel={onCancel}
      />
    </Elements>
  );
}
