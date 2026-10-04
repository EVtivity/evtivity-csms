// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { Select } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import { useToast } from '@/components/ui/toast';
import { SaveButton } from '@/components/save-button';
import { LoadingLogo } from '@/components/loading-logo';
import { api, getApiErrorCode } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import {
  OtherWebhookEndpoints,
  PaymentWebhookSetup,
  WebhookEndpointsTable,
  useWebhookUrl,
  webhookSetupPath,
  type WebhookEndpoint,
} from './PaymentWebhookSetup';
import { providerErrorMessage } from './payment-provider-errors';

export const ADYEN_WEBHOOK_PATH = '/v1/webhooks/payments/adyen';

const LIVE_REGIONS = ['eu', 'us', 'au', 'nea', 'in'] as const;
type LiveRegion = (typeof LIVE_REGIONS)[number];
const LIVE_URL_PREFIX = /^[a-z0-9]+-[A-Za-z0-9]+$/;
const HEX = /^[0-9A-Fa-f]+$/;

/** `GET /v1/settings/adyen`: secrets are returned decrypted, like the generic settings GET. */
export interface AdyenSettingsResponse {
  merchantAccount: string | null;
  environment: 'test' | 'live';
  liveUrlPrefix: string | null;
  liveRegion: LiveRegion;
  clientKey: string | null;
  webhookUsername: string | null;
  authorisationAdjustment: boolean;
  apiKey: string | null;
  hmacKey: string | null;
  hmacKeyPreviousConfigured: boolean;
  webhookPassword: string | null;
  webhookUrlPath: string;
}

interface AdyenWebhookResponse {
  /** The webhook at this deployment's webhook URL. */
  endpoints: WebhookEndpoint[];
  /** EVtivity webhooks of other deployments sharing the merchant account. */
  otherEndpoints?: WebhookEndpoint[];
  hmacKeyConfigured: boolean;
  webhookPasswordConfigured: boolean;
  events: string[];
}

interface AdyenWebhookCreated {
  endpoints: WebhookEndpoint[];
  test: { status: string; responseCode: string | null };
}

interface AdyenTestResult {
  success: true;
  roles: string[];
  webhookRoleGranted: boolean;
}

/** The provider entry of `GET /v1/settings/payments`, which decides whether Adyen is selectable. */
interface PaymentProviderEntry {
  id: string;
  configured: boolean;
  selectable: boolean;
  reason: 'not_configured' | 'requires_upgrade' | null;
}

interface AdyenForm {
  merchantAccount: string;
  environment: 'test' | 'live';
  liveUrlPrefix: string;
  liveRegion: LiveRegion;
  clientKey: string;
  webhookUsername: string;
  authorisationAdjustment: boolean;
  apiKey: string;
  hmacKey: string;
  webhookPassword: string;
}

/** The secret fields of the form, sent only when changed (an emptied field clears). */
const SECRET_FIELDS = ['apiKey', 'hmacKey', 'webhookPassword'] as const;

function formFrom(data: AdyenSettingsResponse): AdyenForm {
  return {
    merchantAccount: data.merchantAccount ?? '',
    environment: data.environment,
    liveUrlPrefix: data.liveUrlPrefix ?? '',
    liveRegion: data.liveRegion,
    clientKey: data.clientKey ?? '',
    webhookUsername: data.webhookUsername ?? '',
    authorisationAdjustment: data.authorisationAdjustment,
    apiKey: data.apiKey ?? '',
    hmacKey: data.hmacKey ?? '',
    webhookPassword: data.webhookPassword ?? '',
  };
}

/** The line under the Adyen title, driven by the provider catalog of the API. */
function AdyenAvailability(): React.JSX.Element | null {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ['payment-settings'],
    queryFn: () => api.get<{ providers: PaymentProviderEntry[] }>('/v1/settings/payments'),
    staleTime: 60_000,
  });
  const adyen = data?.providers.find((p) => p.id === 'adyen');
  if (adyen == null || adyen.selectable) return null;
  return (
    <Alert variant="info">
      <Info className="h-4 w-4" />
      <AlertDescription>
        {adyen.reason === 'not_configured'
          ? t('settings.adyenNotConfiguredForPayments')
          : t('settings.adyenNotSelectable')}
      </AlertDescription>
    </Alert>
  );
}

function AdyenWebhookCard({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [lastTest, setLastTest] = useState<AdyenWebhookCreated['test'] | null>(null);

  const urlState = useWebhookUrl(ADYEN_WEBHOOK_PATH);

  const webhook = useQuery({
    queryKey: ['adyen-webhook', urlState.queryUrl],
    queryFn: () =>
      api.get<AdyenWebhookResponse>(
        webhookSetupPath('/v1/settings/adyen/webhook', urlState.queryUrl),
      ),
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const notConfigured = getApiErrorCode(webhook.error) === 'PAYMENT_PROVIDER_NOT_CONFIGURED';

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.adyenWebhookTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-sm text-muted-foreground">{t('settings.adyenWebhookDescription')}</p>
        <PaymentWebhookSetup<AdyenWebhookCreated>
          idPrefix="adyen"
          urlState={urlState}
          path={ADYEN_WEBHOOK_PATH}
          urlLabel={t('settings.adyenWebhookUrl')}
          urlHint={t('settings.adyenWebhookUrlHint')}
          createLabel={t('settings.stripeWebhookCreate')}
          replaceTitle={t('settings.adyenWebhookReplaceTitle')}
          replaceBody={t('settings.adyenWebhookReplaceBody')}
          replaceConfirmLabel={t('settings.adyenWebhookUpdate')}
          canWrite={canWrite}
          create={(body) => api.post<AdyenWebhookCreated>('/v1/settings/adyen/webhook', body)}
          onCreated={(result) => {
            setLastTest(result.test);
            toast({ title: t('settings.adyenWebhookCreated'), variant: 'success' });
            void queryClient.invalidateQueries({ queryKey: ['adyen-webhook'] });
            void queryClient.invalidateQueries({ queryKey: ['adyen-settings'] });
          }}
        />
        {lastTest != null &&
          (lastTest.status === 'success' ? (
            <p className="text-sm text-success">
              {t('settings.adyenWebhookTestSuccess', { code: lastTest.responseCode ?? '-' })}
            </p>
          ) : (
            <p className="text-sm text-destructive">
              {t('settings.adyenWebhookTestFailed', { code: lastTest.responseCode ?? '-' })}
            </p>
          ))}
        <div className="space-y-3">
          {webhook.isLoading ? (
            <LoadingLogo size="inline" />
          ) : notConfigured ? (
            <p className="text-sm text-muted-foreground">
              {t('settings.adyenWebhookNotConfigured')}
            </p>
          ) : webhook.isError ? (
            <p className="text-sm text-destructive">
              {t('settings.adyenWebhookLoadFailed')} {providerErrorMessage(webhook.error, t)}
            </p>
          ) : webhook.data != null ? (
            <>
              <WebhookEndpointsTable
                endpoints={webhook.data.endpoints}
                emptyText={t('settings.adyenWebhookNoEndpoints')}
              />
              <OtherWebhookEndpoints endpoints={webhook.data.otherEndpoints} />
            </>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function AdyenSettings(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('payments:write');

  const { data, isLoading } = useQuery({
    queryKey: ['adyen-settings'],
    queryFn: () => api.get<AdyenSettingsResponse>('/v1/settings/adyen'),
    staleTime: 30_000,
  });

  const [form, setForm] = useState<AdyenForm | null>(null);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  useEffect(() => {
    if (data == null) return;
    setForm(formFrom(data));
    setHasSubmitted(false);
    setHasUnsavedChanges(false);
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put('/v1/settings/adyen', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['adyen-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['adyen-webhook'] });
      void queryClient.invalidateQueries({ queryKey: ['payment-settings'] });
    },
  });

  const testMutation = useMutation({
    mutationFn: () => api.post<AdyenTestResult>('/v1/settings/adyen/test', {}),
  });

  function markChanged(): void {
    setHasUnsavedChanges(true);
    saveMutation.reset();
    testMutation.reset();
  }

  function update(patch: Partial<AdyenForm>): void {
    setForm((current) => (current == null ? current : { ...current, ...patch }));
    markChanged();
  }

  if (isLoading || form == null || data == null) return <LoadingLogo size="inline" />;

  function getValidationErrors(values: AdyenForm): Record<string, string> {
    const errors: Record<string, string> = {};
    if (values.environment === 'live') {
      if (values.liveUrlPrefix.trim() === '') errors.liveUrlPrefix = t('validation.required');
      else if (!LIVE_URL_PREFIX.test(values.liveUrlPrefix.trim())) {
        errors.liveUrlPrefix = t('settings.adyenLiveUrlPrefixInvalid');
      }
    } else if (
      values.liveUrlPrefix.trim() !== '' &&
      !LIVE_URL_PREFIX.test(values.liveUrlPrefix.trim())
    ) {
      errors.liveUrlPrefix = t('settings.adyenLiveUrlPrefixInvalid');
    }
    if (values.hmacKey.trim() !== '' && !HEX.test(values.hmacKey.trim())) {
      errors.hmacKey = t('settings.adyenHmacKeyInvalid');
    }
    return errors;
  }

  const errors = getValidationErrors(form);
  const current = form;

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const body: Record<string, unknown> = {
      environment: current.environment,
      liveRegion: current.liveRegion,
      liveUrlPrefix: current.liveUrlPrefix.trim(),
      clientKey: current.clientKey.trim(),
      webhookUsername: current.webhookUsername.trim(),
      authorisationAdjustment: current.authorisationAdjustment,
    };
    if (current.merchantAccount.trim() !== '')
      body.merchantAccount = current.merchantAccount.trim();
    // Send only the secrets that changed, so an unchanged secret is not
    // re-encrypted and audited.
    for (const key of SECRET_FIELDS) {
      const value = current[key].trim();
      if (value !== (data?.[key] ?? '')) body[key] = value;
    }
    saveMutation.mutate(body);
  }

  const dirty = hasUnsavedChanges;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.paymentSubTabAdyen')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('settings.adyenDescription')}</p>
            <AdyenAvailability />

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="adyen-merchant-account" className="leading-6">
                  {t('settings.adyenMerchantAccount')}
                </Label>
                <Input
                  id="adyen-merchant-account"
                  value={current.merchantAccount}
                  disabled={!canWrite}
                  onChange={(e) => {
                    update({ merchantAccount: e.target.value });
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="adyen-environment" className="leading-6">
                  {t('settings.adyenEnvironment')}
                </Label>
                <Select
                  id="adyen-environment"
                  value={current.environment}
                  disabled={!canWrite}
                  onChange={(e) => {
                    update({ environment: e.target.value === 'live' ? 'live' : 'test' });
                  }}
                >
                  <option value="test">{t('settings.adyenEnvironmentTest')}</option>
                  <option value="live">{t('settings.adyenEnvironmentLive')}</option>
                </Select>
              </div>

              {current.environment === 'live' && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="adyen-live-url-prefix" className="leading-6">
                      {t('settings.adyenLiveUrlPrefix')}
                    </Label>
                    <Input
                      id="adyen-live-url-prefix"
                      value={current.liveUrlPrefix}
                      disabled={!canWrite}
                      onChange={(e) => {
                        update({ liveUrlPrefix: e.target.value });
                      }}
                      className={
                        hasSubmitted && errors.liveUrlPrefix != null ? 'border-destructive' : ''
                      }
                    />
                    {hasSubmitted && errors.liveUrlPrefix != null && (
                      <p className="text-sm text-destructive">{errors.liveUrlPrefix}</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {t('settings.adyenLiveUrlPrefixHint')}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="adyen-live-region" className="leading-6">
                      {t('settings.adyenLiveRegion')}
                    </Label>
                    <Select
                      id="adyen-live-region"
                      value={current.liveRegion}
                      disabled={!canWrite}
                      onChange={(e) => {
                        const region = LIVE_REGIONS.find((r) => r === e.target.value);
                        if (region != null) update({ liveRegion: region });
                      }}
                    >
                      {LIVE_REGIONS.map((region) => (
                        <option key={region} value={region}>
                          {region.toUpperCase()}
                        </option>
                      ))}
                    </Select>
                  </div>
                </>
              )}

              <div className="space-y-2">
                <Label htmlFor="adyen-client-key" className="leading-6">
                  {t('settings.adyenClientKey')}
                </Label>
                <Input
                  id="adyen-client-key"
                  value={current.clientKey}
                  disabled={!canWrite}
                  onChange={(e) => {
                    update({ clientKey: e.target.value });
                  }}
                />
                <p className="text-xs text-muted-foreground">{t('settings.adyenClientKeyHint')}</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="adyen-api-key" className="leading-6">
                  {t('settings.adyenApiKey')}
                </Label>
                <PasswordInput
                  id="adyen-api-key"
                  value={current.apiKey}
                  disabled={!canWrite}
                  autoComplete="off"
                  onChange={(e) => {
                    update({ apiKey: e.target.value });
                  }}
                />
                <p className="text-xs text-muted-foreground">{t('settings.adyenApiKeyHint')}</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="adyen-hmac-key" className="leading-6">
                  {t('settings.adyenHmacKey')}
                </Label>
                <PasswordInput
                  id="adyen-hmac-key"
                  value={current.hmacKey}
                  disabled={!canWrite}
                  autoComplete="off"
                  className={hasSubmitted && errors.hmacKey != null ? 'border-destructive' : ''}
                  onChange={(e) => {
                    update({ hmacKey: e.target.value });
                  }}
                />
                {hasSubmitted && errors.hmacKey != null && (
                  <p className="text-sm text-destructive">{errors.hmacKey}</p>
                )}
                <p className="text-xs text-muted-foreground">{t('settings.adyenHmacKeyHint')}</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="adyen-webhook-username" className="leading-6">
                  {t('settings.adyenWebhookUsername')}
                </Label>
                <Input
                  id="adyen-webhook-username"
                  value={current.webhookUsername}
                  autoComplete="off"
                  disabled={!canWrite}
                  onChange={(e) => {
                    update({ webhookUsername: e.target.value });
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.adyenWebhookCredentialHint')}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="adyen-webhook-password" className="leading-6">
                  {t('settings.adyenWebhookPassword')}
                </Label>
                <PasswordInput
                  id="adyen-webhook-password"
                  value={current.webhookPassword}
                  disabled={!canWrite}
                  autoComplete="off"
                  onChange={(e) => {
                    update({ webhookPassword: e.target.value });
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.adyenWebhookCredentialHint')}
                </p>
              </div>

              <div className="space-y-2 sm:col-span-2">
                <div className="flex items-center gap-3">
                  <Toggle
                    id="adyen-authorisation-adjustment"
                    checked={current.authorisationAdjustment}
                    disabled={!canWrite}
                    aria-label={t('settings.adyenAuthorisationAdjustment')}
                    onCheckedChange={(checked) => {
                      update({ authorisationAdjustment: checked });
                    }}
                  />
                  <Label htmlFor="adyen-authorisation-adjustment">
                    {t('settings.adyenAuthorisationAdjustment')}
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('settings.adyenAuthorisationAdjustmentHint')}
                </p>
              </div>
            </div>

            {canWrite && (
              <div className="flex items-center justify-end gap-2">
                {dirty && (
                  <p className="text-sm text-muted-foreground">{t('settings.unsavedChanges')}</p>
                )}
                <SaveButton
                  isPending={saveMutation.isPending}
                  disabled={!dirty || saveMutation.isPending}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="relative"
                  disabled={testMutation.isPending}
                  onClick={() => {
                    testMutation.mutate();
                  }}
                >
                  {testMutation.isPending && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    </div>
                  )}
                  <span className={testMutation.isPending ? 'invisible' : ''}>
                    {t('settings.adyenTestConnection')}
                  </span>
                </Button>
              </div>
            )}
            {saveMutation.isSuccess && !dirty && (
              <p className="text-sm text-success">{t('settings.adyenSaved')}</p>
            )}
            {saveMutation.isError && (
              <p className="text-sm text-destructive">
                {t('settings.adyenSaveFailed')} {providerErrorMessage(saveMutation.error, t)}
              </p>
            )}
            {testMutation.isError && (
              <p className="text-sm text-destructive">
                {providerErrorMessage(testMutation.error, t)}
              </p>
            )}
            {testMutation.data != null && (
              <div className="space-y-2">
                <p className="text-sm text-success">{t('settings.adyenTestSuccess')}</p>
                <p className="text-sm text-muted-foreground">
                  {t('settings.adyenRoles', { roles: testMutation.data.roles.join(', ') })}
                </p>
                {!testMutation.data.webhookRoleGranted && (
                  <Alert variant="warning">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>{t('settings.adyenWebhookRoleMissing')}</AlertDescription>
                  </Alert>
                )}
              </div>
            )}
          </form>
        </CardContent>
      </Card>

      <AdyenWebhookCard canWrite={canWrite} />
    </div>
  );
}
