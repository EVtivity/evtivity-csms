// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { loadStripe } from '@stripe/stripe-js/pure';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { CreditCard, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';

interface PaymentMethod {
  id: number;
  stripeCustomerId: string;
  stripePaymentMethodId: string;
  cardBrand: string | null;
  cardLast4: string | null;
  isDefault: boolean;
}

interface SetupIntentResponse {
  clientSecret: string;
  customerId: string;
  publishableKey: string;
}

function AddCardForm({
  onSuccess,
  clientSecret: initialClientSecret,
  customerId: initialCustomerId,
}: {
  onSuccess: () => void;
  clientSecret: string;
  customerId: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const stripe = useStripe();
  const elements = useElements();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const customerId = initialCustomerId;
  const clientSecret = initialClientSecret;

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (stripe == null || elements == null) return;

    setError('');
    setLoading(true);
    try {
      const cardElement = elements.getElement(CardElement);
      if (cardElement == null) return;

      const { setupIntent, error: stripeError } = await stripe.confirmCardSetup(clientSecret, {
        payment_method: { card: cardElement },
      });

      if (stripeError != null) {
        setError(stripeError.message ?? t('payments.cardSetupFailed'));
        return;
      }

      if (setupIntent.payment_method == null) {
        setError(t('payments.cardSetupFailed'));
        return;
      }

      const pmId =
        typeof setupIntent.payment_method === 'string'
          ? setupIntent.payment_method
          : setupIntent.payment_method.id;

      // The SetupIntent contains the payment method details
      const pmDetails =
        typeof setupIntent.payment_method === 'string' ? null : setupIntent.payment_method;

      await api.post('/v1/portal/payment-methods', {
        stripePaymentMethodId: pmId,
        stripeCustomerId: customerId,
        cardBrand: pmDetails?.card?.brand,
        cardLast4: pmDetails?.card?.last4,
      });

      await queryClient.invalidateQueries({ queryKey: ['portal-payment-methods'] });
      onSuccess();
    } catch {
      setError(t('payments.failedSave'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      {error !== '' && <p className="text-sm text-destructive">{error}</p>}
      <div className="rounded-lg border border-input p-3">
        <CardElement
          options={{
            style: {
              base: { fontSize: '16px', color: '#020817' },
            },
          }}
        />
      </div>
      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? t('common.saving') : t('payments.saveCard')}
      </Button>
    </form>
  );
}

export function PaymentMethods(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [stripeError, setStripeError] = useState('');
  const [stripePromise, setStripePromise] = useState<ReturnType<typeof loadStripe> | null>(null);
  const [setupClientSecret, setSetupClientSecret] = useState('');
  const [setupCustomerId, setSetupCustomerId] = useState('');

  const { data: methods, isLoading } = useQuery({
    queryKey: ['portal-payment-methods'],
    queryFn: () => api.get<PaymentMethod[]>('/v1/portal/payment-methods'),
  });

  const deleteMutation = useMutation({
    mutationFn: (pmId: number) => api.delete(`/v1/portal/payment-methods/${String(pmId)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['portal-payment-methods'] }),
  });

  const setDefaultMutation = useMutation({
    mutationFn: (pmId: number) =>
      api.patch(`/v1/portal/payment-methods/${String(pmId)}/default`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['portal-payment-methods'] }),
  });

  async function handleShowAdd(): Promise<void> {
    setStripeError('');
    try {
      const data = await api.post<SetupIntentResponse>(
        '/v1/portal/payment-methods/setup-intent',
        {},
      );
      setSetupClientSecret(data.clientSecret);
      setSetupCustomerId(data.customerId);
      if (stripePromise == null) {
        setStripePromise(loadStripe(data.publishableKey));
      }
      setShowAdd(true);
    } catch {
      setStripeError(t('payments.stripeNotConfigured'));
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title={t('payments.title')}>
        <Button onClick={() => void handleShowAdd()}>{t('payments.addCard')}</Button>
      </PageHeader>

      {stripeError !== '' && <p className="text-sm text-destructive">{stripeError}</p>}

      {isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {methods != null && methods.length === 0 && !showAdd && (
        <p className="text-sm text-muted-foreground">{t('payments.noMethods')}</p>
      )}

      <div className="space-y-2">
        {methods?.map((pm) => (
          <Card key={pm.id}>
            <CardContent className="flex items-center justify-between p-3">
              <div className="flex items-center gap-3">
                <CreditCard className="h-5 w-5 text-muted-foreground" />
                <p className="text-sm font-medium">
                  {t('payments.cardEnding', {
                    brand: pm.cardBrand ?? 'Card',
                    last4: pm.cardLast4 ?? '****',
                  })}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {pm.isDefault ? (
                  <Badge variant="secondary">{t('common.default')}</Badge>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-12"
                    onClick={() => {
                      setDefaultMutation.mutate(pm.id);
                    }}
                  >
                    {t('payments.setAsDefault')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-12 w-12"
                  onClick={() => {
                    deleteMutation.mutate(pm.id);
                  }}
                  title={t('payments.remove')}
                  aria-label={t('payments.remove')}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {showAdd && stripePromise != null && (
        <Card>
          <CardContent className="pt-6">
            <Elements stripe={stripePromise}>
              <AddCardForm
                clientSecret={setupClientSecret}
                customerId={setupCustomerId}
                onSuccess={() => {
                  setShowAdd(false);
                }}
              />
            </Elements>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
