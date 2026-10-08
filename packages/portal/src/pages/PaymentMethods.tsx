// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CreditCard, Trash2, Star } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { InfoNote } from '@/components/ui/info-note';
import { useDriverBilling } from '@/lib/fleet-billing';
import { api, getApiErrorCode } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { ProviderHost } from '@/payments/ProviderHost';
import { startSetup } from '@/payments/api';
import { createCardSetupSteps, type CardSetupSteps } from '@/payments/setup-attempt';
import type { PaymentMethodItem, SetupSession } from '@/payments/types';

function formatBrand(brand: string | null): string {
  if (brand == null || brand.length === 0) return '';
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

export function PaymentMethods(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [setupError, setSetupError] = useState('');
  const [starting, setStarting] = useState(false);
  // The opened card form: its provider session and one attempt id (createCardSetupSteps).
  const [setup, setSetup] = useState<{ session: SetupSession; steps: CardSetupSteps } | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const billing = useDriverBilling();

  const { data: methods, isLoading } = useQuery({
    queryKey: ['portal-payment-methods'],
    queryFn: () => api.get<PaymentMethodItem[]>('/v1/portal/payment-methods'),
  });

  function toastApiError(err: unknown, fallbackKey: string): void {
    toast({ variant: 'destructive', title: getErrorMessage(err, t, fallbackKey) });
  }

  const deleteMutation = useMutation({
    mutationFn: (pmId: string) =>
      api.delete(`/v1/portal/payment-methods/${encodeURIComponent(pmId)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['portal-payment-methods'] }),
    onError: (err: unknown) => {
      toastApiError(err, 'payments.removeFailed');
      setPendingDeleteId(null);
    },
  });

  const setDefaultMutation = useMutation({
    mutationFn: (pmId: string) =>
      api.patch(`/v1/portal/payment-methods/${encodeURIComponent(pmId)}/default`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['portal-payment-methods'] }),
    onError: (err: unknown) => {
      toastApiError(err, 'payments.setDefaultFailed');
    },
  });

  async function handleShowAdd(): Promise<void> {
    if (starting) return;
    setSetupError('');
    setStarting(true);
    try {
      const session = await startSetup();
      setSetup({ session, steps: createCardSetupSteps(session.provider) });
    } catch (err: unknown) {
      setSetupError(
        getApiErrorCode(err) === 'PAYMENT_PROVIDER_NOT_CONFIGURED'
          ? t('payments.providerNotConfigured')
          : getErrorMessage(err, t, 'payments.cardSetupFailed'),
      );
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title={t('payments.title')} />

      {billing?.mode === 'account' && billing.fleetName != null && (
        <InfoNote>{t('fleetBilling.paymentMethodsNote', { fleet: billing.fleetName })}</InfoNote>
      )}

      {setupError !== '' && <p className="text-sm text-destructive">{setupError}</p>}

      {/* Add entry point sits at the top, matching the mobile app. While the
          card form is open it replaces the button to avoid two entry points. */}
      {setup != null ? (
        <Card>
          <CardContent className="pt-6">
            <ProviderHost
              provider={setup.session.provider}
              component="CardSetup"
              props={{
                session: setup.session,
                submit: setup.steps.submit,
                submitDetails: setup.steps.submitDetails,
                onSaved: () => {
                  setSetup(null);
                  void queryClient.invalidateQueries({ queryKey: ['portal-payment-methods'] });
                },
                onCancel: () => {
                  setSetup(null);
                },
              }}
            />
          </CardContent>
        </Card>
      ) : (
        <Button className="w-full" disabled={starting} onClick={() => void handleShowAdd()}>
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

      {methods != null && methods.length === 0 && setup == null && (
        <p className="text-center text-sm text-muted-foreground">
          {billing?.mode === 'account' ? t('fleetBilling.noMethods') : t('payments.noMethods')}
        </p>
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
