// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CreateButton } from '@/components/create-button';
import { RefreshButton } from '@/components/refresh-button';
import { useToast } from '@/components/ui/toast';
import { LoadingLogo } from '@/components/loading-logo';
import { api, getApiErrorCode } from '@/lib/api';
import { providerErrorMessage } from './payment-provider-errors';

const PATH = '/v1/settings/stripe/payment-method-domain';
const QUERY_KEY = ['stripe-payment-method-domain'];

interface WalletDomainStatus {
  status: 'active' | 'inactive';
  errorMessage: string | null;
}

/** `GET /v1/settings/stripe/payment-method-domain`. */
export interface StripePaymentMethodDomain {
  portalUrl: string;
  /** Null when PORTAL_URL is not a public https URL Stripe can verify. */
  domain: string | null;
  registration: {
    id: string;
    domain: string;
    enabled: boolean;
    applePay: WalletDomainStatus;
    googlePay: WalletDomainStatus;
  } | null;
}

function WalletState({
  label,
  wallet,
}: {
  label: string;
  wallet: WalletDomainStatus;
}): React.JSX.Element {
  const { t } = useTranslation();
  const active = wallet.status === 'active';
  return (
    <div className="space-y-1 text-sm">
      <div className="flex items-center gap-2">
        <span>{label}</span>
        <Badge variant={active ? 'success' : 'warning'}>
          {active ? t('settings.stripeWalletActive') : t('settings.stripeWalletInactive')}
        </Badge>
      </div>
      {!active && wallet.errorMessage != null && (
        <p className="text-xs text-muted-foreground">{wallet.errorMessage}</p>
      )}
    </div>
  );
}

/** Registers the portal domain for Apple Pay and Google Pay on the guest checkout. */
export function StripePaymentMethodDomainCard({
  canWrite,
  secretKeyConfigured,
}: {
  canWrite: boolean;
  /** From GET /v1/settings/stripe; undefined while it loads. */
  secretKeyConfigured: boolean | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const status = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.get<StripePaymentMethodDomain>(PATH),
    // Without a secret key the API answers 400 PAYMENT_PROVIDER_NOT_CONFIGURED.
    enabled: secretKeyConfigured === true,
    staleTime: 30_000,
    retry: false,
  });

  const register = useMutation({
    mutationFn: () => api.post<StripePaymentMethodDomain>(PATH, {}),
    onSuccess: (result) => {
      queryClient.setQueryData(QUERY_KEY, result);
      toast({ title: t('settings.stripeWalletDomainRegistered'), variant: 'success' });
    },
  });

  const notConfigured =
    secretKeyConfigured === false ||
    getApiErrorCode(status.error) === 'PAYMENT_PROVIDER_NOT_CONFIGURED';
  const data = status.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.stripeWalletDomainTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t('settings.stripeWalletDomainDescription')}
        </p>
        {secretKeyConfigured === undefined || status.isLoading ? (
          <LoadingLogo size="inline" />
        ) : notConfigured ? (
          <p className="text-sm text-muted-foreground">
            {t('settings.stripeWalletDomainNotConfigured')}
          </p>
        ) : status.isError ? (
          <p className="text-sm text-destructive">
            {t('settings.stripeWalletDomainLoadFailed')} {providerErrorMessage(status.error, t)}
          </p>
        ) : data == null ? null : data.domain == null ? (
          <p className="text-sm text-muted-foreground">
            {t('settings.stripeWalletDomainUnusable', { portalUrl: data.portalUrl })}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono">{data.domain}</span>
              {data.registration == null && (
                <Badge variant="outline">{t('settings.stripeWalletDomainNotRegistered')}</Badge>
              )}
            </div>
            {data.registration != null && (
              <div className="flex flex-wrap gap-6">
                <WalletState label="Apple Pay" wallet={data.registration.applePay} />
                <WalletState label="Google Pay" wallet={data.registration.googlePay} />
              </div>
            )}
            {canWrite &&
              (data.registration == null ? (
                <CreateButton
                  label={t('settings.stripeWalletDomainRegister')}
                  pending={register.isPending}
                  onClick={() => {
                    register.mutate();
                  }}
                />
              ) : (
                <RefreshButton
                  label={t('settings.stripeWalletDomainCheck')}
                  isPending={register.isPending}
                  onClick={() => {
                    register.mutate();
                  }}
                />
              ))}
            {register.isError && (
              <p className="text-sm text-destructive">{providerErrorMessage(register.error, t)}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
