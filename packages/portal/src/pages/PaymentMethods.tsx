// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { loadStripe } from '@stripe/stripe-js/pure';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { CreditCard, Trash2, Star } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';

interface PaymentMethod {
  id: number;
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

      // The server fetches cardBrand/cardLast4 from Stripe authoritatively;
      // SetupIntent.payment_method here is just the ID string by default.
      await api.post('/v1/portal/payment-methods', {
        stripePaymentMethodId: pmId,
        stripeCustomerId: customerId,
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
              base: {
                fontSize: '16px',
                color: document.documentElement.classList.contains('dark') ? '#f8fafc' : '#020817',
                '::placeholder': {
                  color: document.documentElement.classList.contains('dark')
                    ? '#94a3b8'
                    : '#64748b',
                },
              },
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

function formatBrand(brand: string | null): string {
  if (brand == null || brand.length === 0) return '';
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

export function PaymentMethods(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showAdd, setShowAdd] = useState(false);
  const [stripeError, setStripeError] = useState('');
  const [stripePromise, setStripePromise] = useState<ReturnType<typeof loadStripe> | null>(null);
  const [setupClientSecret, setSetupClientSecret] = useState('');
  const [setupCustomerId, setSetupCustomerId] = useState('');
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);

  const { data: methods, isLoading } = useQuery({
    queryKey: ['portal-payment-methods'],
    queryFn: () => api.get<PaymentMethod[]>('/v1/portal/payment-methods'),
  });

  function toastApiError(err: unknown, fallbackKey: string): void {
    const message =
      err != null && typeof err === 'object' && 'body' in err
        ? ((err as { body: { error?: string } }).body.error ?? t(fallbackKey))
        : t(fallbackKey);
    toast({ variant: 'destructive', title: message });
  }

  const deleteMutation = useMutation({
    mutationFn: (pmId: number) => api.delete(`/v1/portal/payment-methods/${String(pmId)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['portal-payment-methods'] }),
    onError: (err: unknown) => {
      toastApiError(err, 'payments.removeFailed');
      setPendingDeleteId(null);
    },
  });

  const setDefaultMutation = useMutation({
    mutationFn: (pmId: number) =>
      api.patch(`/v1/portal/payment-methods/${String(pmId)}/default`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['portal-payment-methods'] }),
    onError: (err: unknown) => {
      toastApiError(err, 'payments.setDefaultFailed');
    },
  });

  async function handleShowAdd(): Promise<void> {
    setStripeError('');
    try {
      const data = await api.post<SetupIntentResponse>(
        '/v1/portal/payment-methods/setup-intent',
        {},
      );
      // Defensive: backend validates both are non-empty before returning 200,
      // but if the contract is ever violated we'd otherwise mount Elements
      // with an empty key and the user sees a blank card form.
      if (!data.publishableKey || !data.clientSecret) {
        setStripeError(t('payments.stripeNotConfigured'));
        return;
      }
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
      <PageHeader title={t('payments.title')} />

      {stripeError !== '' && <p className="text-sm text-destructive">{stripeError}</p>}

      {/* Add entry point sits at the top, matching the mobile app. While the
          inline Stripe form is open it replaces the button to avoid two
          simultaneous entry points. */}
      {showAdd && stripePromise != null ? (
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
      ) : (
        <Button className="w-full" onClick={() => void handleShowAdd()}>
          {t('payments.addCard')}
        </Button>
      )}

      {isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {methods != null && methods.length === 0 && !showAdd && (
        <p className="text-center text-sm text-muted-foreground">{t('payments.noMethods')}</p>
      )}

      <div className="space-y-2">
        {methods?.map((pm) => (
          <Card key={pm.id}>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <CreditCard className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <p className="truncate text-sm font-medium">
                    {`${formatBrand(pm.cardBrand)} •••• ${pm.cardLast4 ?? '----'}`.trim()}
                  </p>
                </div>
                {pm.isDefault && (
                  <Badge variant="success" className="shrink-0">
                    {t('common.default')}
                  </Badge>
                )}
              </div>
              <div className="flex gap-2">
                {!pm.isDefault && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => {
                      setDefaultMutation.mutate(pm.id);
                    }}
                  >
                    <Star className="mr-1.5 h-4 w-4" />
                    {t('payments.setAsDefault')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => {
                    setPendingDeleteId(pm.id);
                  }}
                >
                  <Trash2 className="mr-1.5 h-4 w-4 text-destructive" />
                  {t('payments.remove')}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <ConfirmDialog
        open={pendingDeleteId != null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null);
        }}
        title={t('payments.confirmRemoveTitle')}
        description={t('payments.confirmRemoveDescription')}
        confirmLabel={t('payments.remove')}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (pendingDeleteId != null) {
            deleteMutation.mutate(pendingDeleteId, {
              onSuccess: () => {
                setPendingDeleteId(null);
              },
            });
          }
        }}
      />
    </div>
  );
}
