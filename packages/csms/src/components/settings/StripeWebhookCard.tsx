// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { LoadingLogo } from '@/components/loading-logo';
import { api, getApiErrorCode } from '@/lib/api';
import {
  OtherWebhookEndpoints,
  PaymentWebhookSetup,
  WebhookEndpointsTable,
  defaultWebhookUrl,
  useWebhookUrl,
  webhookSetupPath,
  type WebhookEndpoint,
} from './PaymentWebhookSetup';
import { providerErrorMessage } from './payment-provider-errors';

export const STRIPE_WEBHOOK_PATH = '/v1/webhooks/payments/stripe';

/** `GET /v1/settings/stripe/webhook`. */
export interface StripeWebhookSetup {
  /** Endpoints at this deployment's webhook URL. */
  endpoints: WebhookEndpoint[];
  /** EVtivity endpoints of other deployments sharing the Stripe account. */
  otherEndpoints?: WebhookEndpoint[];
  platformSecretConfigured: boolean;
  connectSecretConfigured: boolean;
  events: { platform: string[]; connect: string[] };
  apiVersion: string;
}

function SecretState({
  label,
  configured,
}: {
  label: string;
  configured: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 text-sm">
      <span>{label}</span>
      <Badge variant={configured ? 'success' : 'outline'}>
        {configured ? t('settings.secretConfigured') : t('settings.secretNotConfigured')}
      </Badge>
    </div>
  );
}

export function StripeWebhookCard({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [manualOpen, setManualOpen] = useState(false);

  const urlState = useWebhookUrl(STRIPE_WEBHOOK_PATH);

  const setup = useQuery({
    queryKey: ['stripe-webhook', urlState.queryUrl],
    queryFn: () =>
      api.get<StripeWebhookSetup>(
        webhookSetupPath('/v1/settings/stripe/webhook', urlState.queryUrl),
      ),
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
  });

  const notConfigured = getApiErrorCode(setup.error) === 'PAYMENT_PROVIDER_NOT_CONFIGURED';
  const listenUrl = defaultWebhookUrl(STRIPE_WEBHOOK_PATH);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.stripeWebhookTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-sm text-muted-foreground">{t('settings.stripeWebhookDescription')}</p>

        <PaymentWebhookSetup<{ endpoints: WebhookEndpoint[] }>
          idPrefix="stripe"
          urlState={urlState}
          path={STRIPE_WEBHOOK_PATH}
          urlLabel={t('settings.stripeWebhookUrl')}
          urlHint={t('settings.stripeWebhookUrlHint')}
          createLabel={t('settings.stripeWebhookCreate')}
          replaceTitle={t('settings.stripeWebhookReplaceTitle')}
          replaceBody={t('settings.stripeWebhookReplaceBody')}
          replaceConfirmLabel={t('settings.webhookReplaceConfirm')}
          canWrite={canWrite}
          create={(body) =>
            api.post<{ endpoints: WebhookEndpoint[] }>('/v1/settings/stripe/webhook', body)
          }
          onCreated={() => {
            toast({ title: t('settings.stripeWebhookCreated'), variant: 'success' });
            void queryClient.invalidateQueries({ queryKey: ['stripe-webhook'] });
            void queryClient.invalidateQueries({ queryKey: ['stripe-settings'] });
          }}
        />

        <div className="space-y-3">
          <h3 className="text-sm font-medium">{t('settings.stripeWebhookEndpoints')}</h3>
          {setup.isLoading ? (
            <LoadingLogo size="inline" />
          ) : notConfigured ? (
            <p className="text-sm text-muted-foreground">
              {t('settings.stripeWebhookNotConfigured')}
            </p>
          ) : setup.isError ? (
            <p className="text-sm text-destructive">
              {t('settings.stripeWebhookLoadFailed')} {providerErrorMessage(setup.error, t)}
            </p>
          ) : setup.data != null ? (
            <>
              <div className="flex flex-wrap gap-4">
                <SecretState
                  label={t('settings.stripeWebhookPlatformSecret')}
                  configured={setup.data.platformSecretConfigured}
                />
                <SecretState
                  label={t('settings.stripeWebhookConnectSecret')}
                  configured={setup.data.connectSecretConfigured}
                />
              </div>
              <WebhookEndpointsTable
                endpoints={setup.data.endpoints}
                emptyText={t('settings.stripeWebhookNoEndpoints')}
              />
              <OtherWebhookEndpoints endpoints={setup.data.otherEndpoints} />
            </>
          ) : null}
        </div>

        <div className="space-y-3">
          <Button
            type="button"
            variant="ghost"
            className="-ml-3 gap-1"
            aria-expanded={manualOpen}
            onClick={() => {
              setManualOpen((open) => !open);
            }}
          >
            {manualOpen ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            {t('settings.stripeWebhookManual')}
          </Button>
          {manualOpen && setup.data != null && (
            <div className="space-y-3 text-sm" data-testid="stripe-webhook-manual">
              <p className="text-muted-foreground">
                {t('settings.stripeWebhookManualBody', { apiVersion: setup.data.apiVersion })}
              </p>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  {t('settings.stripeWebhookManualPlatform', {
                    events: setup.data.events.platform.join(', '),
                  })}
                </li>
                <li>
                  {t('settings.stripeWebhookManualConnect', {
                    events: setup.data.events.connect.join(', '),
                  })}
                </li>
              </ul>
              <p className="text-muted-foreground">{t('settings.stripeWebhookListenHint')}</p>
              <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
                {`stripe listen --forward-to ${listenUrl} --forward-connect-to ${listenUrl}`}
              </pre>
            </div>
          )}
          {manualOpen && setup.data == null && (
            <p className="text-sm text-muted-foreground">
              {t('settings.stripeWebhookNotConfigured')}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
