// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { loadStripe } from '@stripe/stripe-js/pure';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CancelButton } from '@/components/cancel-button';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';

interface SetupIntentResponse {
  clientSecret: string;
  customerId: string;
  publishableKey: string;
}

interface PaymentMethodFormProps {
  driverId: string;
  onSuccess: () => void;
  onCancel: () => void;
}

function CardForm({
  driverId,
  clientSecret,
  customerId,
  onSuccess,
  onCancel,
}: {
  driverId: string;
  clientSecret: string;
  customerId: string;
  onSuccess: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation();

  const saveMutation = useMutation({
    mutationFn: (body: {
      stripePaymentMethodId: string;
      stripeCustomerId: string;
      cardBrand?: string;
      cardLast4?: string;
    }) => api.post(`/v1/drivers/${driverId}/payment-methods`, body),
    onSuccess,
  });

  async function handleSubmit(e: React.SyntheticEvent): Promise<void> {
    e.preventDefault();
    if (stripe == null || elements == null) return;

    setError(null);

    const cardElement = elements.getElement(CardElement);
    if (cardElement == null) return;

    const { error: stripeError, setupIntent } = await stripe.confirmCardSetup(clientSecret, {
      payment_method: { card: cardElement },
    });

    if (stripeError != null) {
      setError(stripeError.message ?? t('payments.setupFailed'));
      return;
    }

    if (setupIntent.payment_method == null) {
      setError(t('payments.setupFailed'));
      return;
    }

    const pmId =
      typeof setupIntent.payment_method === 'string'
        ? setupIntent.payment_method
        : setupIntent.payment_method.id;

    // Retrieve card details from the payment method
    const pm = typeof setupIntent.payment_method === 'string' ? null : setupIntent.payment_method;

    const body: {
      stripePaymentMethodId: string;
      stripeCustomerId: string;
      cardBrand?: string;
      cardLast4?: string;
    } = {
      stripePaymentMethodId: pmId,
      stripeCustomerId: customerId,
    };
    if (pm?.card?.brand != null) body.cardBrand = pm.card.brand;
    if (pm?.card?.last4 != null) body.cardLast4 = pm.card.last4;
    saveMutation.mutate(body);
  }

  return (
    <form
      onSubmit={(e) => {
        void handleSubmit(e);
      }}
      className="space-y-4"
    >
      <div className="p-3 border rounded-md bg-background">
        <CardElement
          options={{
            style: {
              base: {
                fontSize: '16px',
                color: '#020817',
                '::placeholder': { color: '#64748b' },
              },
            },
          }}
        />
      </div>
      {error != null && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={stripe == null || saveMutation.isPending}>
          {t('payments.addCard')}
        </Button>
        <CancelButton onClick={onCancel} />
      </div>
    </form>
  );
}

export function PaymentMethodForm({
  driverId,
  onSuccess,
  onCancel,
}: PaymentMethodFormProps): React.JSX.Element {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [setupData, setSetupData] = useState<SetupIntentResponse | null>(null);
  const [stripePromise, setStripePromise] = useState<ReturnType<typeof loadStripe> | null>(null);
  async function initSetup(): Promise<void> {
    setError(null);
    try {
      const data = await api.post<SetupIntentResponse>(
        `/v1/drivers/${driverId}/payment-methods/setup-intent`,
        {},
      );
      setSetupData(data);
      setStripePromise(loadStripe(data.publishableKey));
    } catch (err) {
      const message =
        err instanceof ApiError &&
        err.body != null &&
        typeof (err.body as Record<string, unknown>).error === 'string'
          ? ((err.body as Record<string, unknown>).error as string)
          : t('payments.setupFailed');
      setError(message);
    }
  }

  useEffect(() => {
    void initSetup();
  }, []);

  if (error != null) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">{error}</p>
        <div className="flex gap-2">
          <Button
            onClick={() => {
              void initSetup();
            }}
          >
            {t('common.retry')}
          </Button>
          <CancelButton onClick={onCancel} />
        </div>
      </div>
    );
  }

  if (setupData == null || stripePromise == null) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        <CancelButton onClick={onCancel} />
      </div>
    );
  }

  return (
    <Elements stripe={stripePromise}>
      <CardForm
        driverId={driverId}
        clientSecret={setupData.clientSecret}
        customerId={setupData.customerId}
        onSuccess={onSuccess}
        onCancel={onCancel}
      />
    </Elements>
  );
}
