// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { Button } from '@/components/ui/button';
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
  const [error, setError] = useState('');

  async function handleSubmit(e: React.SyntheticEvent): Promise<void> {
    e.preventDefault();
    if (stripe == null || elements == null || loading) return;
    const cardElement = elements.getElement(CardElement);
    if (cardElement == null) return;

    setError('');
    setLoading(true);
    try {
      // Stripe runs 3DS inside confirmCardSetup, so the saved method needs no further action.
      const { setupIntent, error: stripeError } = await stripe.confirmCardSetup(clientSecret, {
        payment_method: { card: cardElement },
      });
      if (stripeError != null) {
        setError(stripeError.message ?? t('payments.cardSetupFailed'));
        return;
      }
      const pm = setupIntent.payment_method;
      if (pm == null) {
        setError(t('payments.cardSetupFailed'));
        return;
      }
      const paymentMethodId = typeof pm === 'string' ? pm : pm.id;
      const result = await submit({ paymentMethodId });
      if (result.status === 'saved') {
        onSaved();
        return;
      }
      setError(t('payments.cardSetupFailed'));
    } catch (err: unknown) {
      setError(getErrorMessage(err, t, 'payments.failedSave'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      {error !== '' && <p className="text-sm text-destructive">{error}</p>}
      <div className="rounded-lg border border-input p-3">
        <CardElement options={cardElementOptions()} />
      </div>
      <div className="flex gap-2">
        <Button type="submit" className="flex-1" disabled={stripe == null || loading}>
          {loading ? t('common.saving') : t('payments.saveCard')}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>
          {t('common.cancel')}
        </Button>
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
    return <p className="text-sm text-destructive">{t('payments.cardSetupFailed')}</p>;
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
