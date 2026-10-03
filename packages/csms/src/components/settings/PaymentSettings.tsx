// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useTab } from '@/hooks/use-tab';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SaveButton } from '@/components/save-button';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DecimalInput } from '@/components/ui/decimal-input';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { API_BASE_URL } from '@/lib/config';
import { useCompanyCurrency } from '@/hooks/use-company-currency';
import { centsToMajorInput, parseMajorInputToCents } from '@evtivity/lib/currency';

interface PaymentSettingsProps {
  settings: Record<string, unknown> | undefined;
}

interface StripeSettings {
  publishableKey: string | null;
  secretKey: string | null;
  webhookSecret: string | null;
  preAuthAmountCents: number;
  platformFeePercent: number;
}

interface SiteListItem {
  id: string;
  name: string;
}

interface SitePaymentConfig {
  id: number;
  siteId: string;
  stripeConnectedAccountId: string | null;
  preAuthAmountCents: number;
  platformFeePercent: string | null;
  isEnabled: boolean;
}

/** Pre-auth amounts are typed in the currency (major units) and stored in cents. */
function preAuthAmountError(value: string, t: TFunction): string | undefined {
  if (value.trim() === '') return t('validation.required');
  if (Number(value) < 0) return t('validation.min', { min: 0 });
  if (parseMajorInputToCents(value) == null) return t('validation.invalidNumber');
  return undefined;
}

function percentError(value: string, t: TFunction, required: boolean): string | undefined {
  if (value.trim() === '') return required ? t('validation.required') : undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return t('validation.invalidNumber');
  if (n < 0) return t('validation.min', { min: 0 });
  if (n > 100) return t('validation.max', { max: 100 });
  return undefined;
}

export function PaymentSettings({ settings }: PaymentSettingsProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [paymentSubTab, setPaymentSubTab] = useTab('stripe', 'sub');
  // The endpoint operators register in the Stripe dashboard.
  const stripeWebhookUrl = `${API_BASE_URL || window.location.origin}/v1/webhooks/stripe`;

  const [stripeSecretKey, setStripeSecretKey] = useState('');
  const [stripePublishableKey, setStripePublishableKey] = useState('');
  const [stripeWebhookSecret, setStripeWebhookSecret] = useState('');
  const { currency } = useCompanyCurrency();
  const [stripePreAuthAmount, setStripePreAuthAmount] = useState(centsToMajorInput(5000));
  const [stripePlatformFee, setStripePlatformFee] = useState('0');
  const [stripeHasSubmitted, setStripeHasSubmitted] = useState(false);
  const [stripeHasUnsavedChanges, setStripeHasUnsavedChanges] = useState(false);
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);

  const [siteConnectedAccountId, setSiteConnectedAccountId] = useState('');
  const [sitePreAuthAmount, setSitePreAuthAmount] = useState(centsToMajorInput(5000));
  const [sitePlatformFee, setSitePlatformFee] = useState('');
  const [siteHasSubmitted, setSiteHasSubmitted] = useState(false);
  const [siteHasUnsavedChanges, setSiteHasUnsavedChanges] = useState(false);

  const { data: stripeSettings } = useQuery({
    queryKey: ['stripe-settings'],
    queryFn: () => api.get<StripeSettings>('/v1/settings/stripe'),
  });

  const { data: siteList } = useQuery({
    queryKey: ['sites-list-for-payment'],
    queryFn: async () => {
      const first = await api.get<{ data: SiteListItem[]; total: number }>('/v1/sites?limit=100');
      if (first.total <= 100) return first;
      const remaining = Math.ceil((first.total - 100) / 100);
      const pages = await Promise.all(
        Array.from({ length: remaining }, (_, i) =>
          api.get<{ data: SiteListItem[]; total: number }>(
            `/v1/sites?limit=100&page=${String(i + 2)}`,
          ),
        ),
      );
      return {
        data: [...first.data, ...pages.flatMap((p) => p.data)],
        total: first.total,
      };
    },
  });

  const { data: allPaymentConfigs } = useQuery({
    queryKey: ['all-payment-configs'],
    queryFn: () => api.get<SitePaymentConfig[]>('/v1/sites/payment-configs'),
  });

  const paymentConfigMap = useMemo(() => {
    const map = new Map<string, SitePaymentConfig>();
    if (allPaymentConfigs != null) {
      for (const c of allPaymentConfigs) {
        map.set(c.siteId, c);
      }
    }
    return map;
  }, [allPaymentConfigs]);

  const { data: selectedSiteConfig, refetch: refetchSiteConfig } = useQuery({
    queryKey: ['sites', selectedSiteId, 'payment-config'],
    queryFn: () =>
      api
        .get<SitePaymentConfig>(`/v1/sites/${selectedSiteId ?? ''}/payment-config`)
        .catch(() => null),
    enabled: selectedSiteId != null,
  });

  useEffect(() => {
    if (selectedSiteConfig != null) {
      setSiteConnectedAccountId(selectedSiteConfig.stripeConnectedAccountId ?? '');
      setSitePreAuthAmount(centsToMajorInput(selectedSiteConfig.preAuthAmountCents));
      setSitePlatformFee(
        selectedSiteConfig.platformFeePercent != null ? selectedSiteConfig.platformFeePercent : '',
      );
    } else if (selectedSiteId != null) {
      setSiteConnectedAccountId('');
      setSitePreAuthAmount(centsToMajorInput(5000));
      setSitePlatformFee('');
    }
    setSiteHasSubmitted(false);
    setSiteHasUnsavedChanges(false);
  }, [selectedSiteConfig, selectedSiteId]);

  useEffect(() => {
    if (stripeSettings == null) return;
    setStripePublishableKey(
      typeof stripeSettings.publishableKey === 'string' ? stripeSettings.publishableKey : '',
    );
    setStripeSecretKey(
      typeof stripeSettings.secretKey === 'string' ? stripeSettings.secretKey : '',
    );
    setStripeWebhookSecret(
      typeof stripeSettings.webhookSecret === 'string' ? stripeSettings.webhookSecret : '',
    );
    setStripePreAuthAmount(centsToMajorInput(stripeSettings.preAuthAmountCents));
    setStripePlatformFee(String(stripeSettings.platformFeePercent));
    setStripeHasSubmitted(false);
    setStripeHasUnsavedChanges(false);
  }, [stripeSettings]);

  const stripeSaveMutation = useMutation({
    mutationFn: (vals: {
      secretKey?: string;
      publishableKey?: string;
      webhookSecret?: string;
      preAuthAmountCents?: number;
      platformFeePercent?: number;
    }) => api.put('/v1/settings/stripe', vals),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['stripe-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const stripeTestMutation = useMutation({
    mutationFn: () => api.post('/v1/settings/stripe/test', {}),
  });

  const sitePaymentSaveMutation = useMutation({
    mutationFn: (vals: {
      siteId: string;
      stripeConnectedAccountId?: string | undefined;
      preAuthAmountCents: number;
      platformFeePercent: number | null;
      isEnabled: boolean;
    }) =>
      api.put(`/v1/sites/${vals.siteId}/payment-config`, {
        stripeConnectedAccountId: vals.stripeConnectedAccountId,
        preAuthAmountCents: vals.preAuthAmountCents,
        platformFeePercent: vals.platformFeePercent,
        isEnabled: vals.isEnabled,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['all-payment-configs'] });
      void refetchSiteConfig();
    },
  });

  function markStripeChanged(): void {
    setStripeHasUnsavedChanges(true);
    stripeSaveMutation.reset();
    stripeTestMutation.reset();
  }

  function markSiteChanged(): void {
    setSiteHasUnsavedChanges(true);
    sitePaymentSaveMutation.reset();
  }

  function getStripeValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    const preAuth = preAuthAmountError(stripePreAuthAmount, t);
    if (preAuth != null) errors.preAuthAmountCents = preAuth;
    const fee = percentError(stripePlatformFee, t, true);
    if (fee != null) errors.platformFeePercent = fee;
    return errors;
  }

  function getSiteValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    const preAuth = preAuthAmountError(sitePreAuthAmount, t);
    if (preAuth != null) errors.preAuthAmountCents = preAuth;
    const fee = percentError(sitePlatformFee, t, false);
    if (fee != null) errors.platformFeePercent = fee;
    return errors;
  }

  const stripeErrors = getStripeValidationErrors();
  const siteErrors = getSiteValidationErrors();

  function handleStripeSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setStripeHasSubmitted(true);
    if (Object.keys(stripeErrors).length > 0) return;
    const vals: {
      secretKey?: string;
      publishableKey?: string;
      webhookSecret?: string;
      preAuthAmountCents: number;
      platformFeePercent: number;
    } = {
      preAuthAmountCents: parseMajorInputToCents(stripePreAuthAmount) ?? 0,
      platformFeePercent: Number(stripePlatformFee),
    };
    if (stripeSecretKey !== '') vals.secretKey = stripeSecretKey;
    if (stripePublishableKey !== '') vals.publishableKey = stripePublishableKey;
    if (stripeWebhookSecret !== '') vals.webhookSecret = stripeWebhookSecret;
    stripeSaveMutation.mutate(vals);
  }

  function handleSiteSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    if (selectedSiteId == null) return;
    setSiteHasSubmitted(true);
    if (Object.keys(siteErrors).length > 0) return;
    sitePaymentSaveMutation.mutate({
      siteId: selectedSiteId,
      stripeConnectedAccountId: siteConnectedAccountId !== '' ? siteConnectedAccountId : undefined,
      preAuthAmountCents: parseMajorInputToCents(sitePreAuthAmount) ?? 0,
      platformFeePercent: sitePlatformFee !== '' ? Number(sitePlatformFee) : null,
      isEnabled: paymentConfigMap.get(selectedSiteId)?.isEnabled ?? true,
    });
  }

  const sitePaymentToggleMutation = useMutation({
    mutationFn: (vals: { siteId: string; isEnabled: boolean }) =>
      api.put(`/v1/sites/${vals.siteId}/payment-config`, { isEnabled: vals.isEnabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['all-payment-configs'] });
      void refetchSiteConfig();
    },
  });

  return (
    <Tabs value={paymentSubTab} onValueChange={setPaymentSubTab}>
      <TabsList>
        <TabsTrigger value="stripe">{t('settings.paymentSubTabStripe')}</TabsTrigger>
        <TabsTrigger value="siteConfigs">{t('settings.paymentSubTabSiteConfigs')}</TabsTrigger>
      </TabsList>
      <TabsContent value="stripe" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.paymentSubTabStripe')}</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleStripeSubmit} noValidate className="space-y-4">
              <p className="text-sm text-muted-foreground">{t('settings.stripeDescription')}</p>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="stripe-secret-key" className="leading-6">
                    {t('settings.stripeSecretKey')}
                  </Label>
                  <PasswordInput
                    id="stripe-secret-key"
                    value={stripeSecretKey}
                    onChange={(e) => {
                      setStripeSecretKey(e.target.value);
                      markStripeChanged();
                    }}
                    placeholder={
                      settings != null &&
                      typeof settings['stripe.secretKeyEnc'] === 'string' &&
                      settings['stripe.secretKeyEnc'] !== ''
                        ? '********'
                        : ''
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('settings.stripeSecretKeyHint')}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="stripe-publishable-key" className="leading-6">
                    {t('settings.stripePublishableKey')}
                  </Label>
                  <Input
                    id="stripe-publishable-key"
                    value={stripePublishableKey}
                    onChange={(e) => {
                      setStripePublishableKey(e.target.value);
                      markStripeChanged();
                    }}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="stripe-webhook-secret" className="leading-6">
                    {t('settings.stripeWebhookSecret')}
                  </Label>
                  <PasswordInput
                    id="stripe-webhook-secret"
                    value={stripeWebhookSecret}
                    onChange={(e) => {
                      setStripeWebhookSecret(e.target.value);
                      markStripeChanged();
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('settings.stripeWebhookSecretHint')}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="stripe-webhook-url" className="leading-6">
                    {t('settings.stripeWebhookUrl')}
                  </Label>
                  <Input id="stripe-webhook-url" value={stripeWebhookUrl} readOnly />
                  <p className="text-xs text-muted-foreground">
                    {t('settings.stripeWebhookUrlHint')}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="stripe-pre-auth" className="leading-6">
                    {t('settings.stripePreAuthAmount', { currency: currency ?? '...' })}
                  </Label>
                  <Input
                    id="stripe-pre-auth"
                    type="number"
                    min={0}
                    step="0.01"
                    value={stripePreAuthAmount}
                    onChange={(e) => {
                      setStripePreAuthAmount(e.target.value);
                      markStripeChanged();
                    }}
                    className={
                      stripeHasSubmitted && stripeErrors.preAuthAmountCents
                        ? 'border-destructive'
                        : ''
                    }
                  />
                  {stripeHasSubmitted && stripeErrors.preAuthAmountCents && (
                    <p className="text-sm text-destructive">{stripeErrors.preAuthAmountCents}</p>
                  )}
                  <p className="text-xs text-muted-foreground">{t('settings.stripePreAuthHint')}</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="stripe-platform-fee" className="leading-6">
                    {t('settings.stripePlatformFee')}
                  </Label>
                  <DecimalInput
                    id="stripe-platform-fee"
                    value={stripePlatformFee}
                    onChange={(value) => {
                      setStripePlatformFee(value);
                      markStripeChanged();
                    }}
                    className={
                      stripeHasSubmitted && stripeErrors.platformFeePercent
                        ? 'border-destructive'
                        : ''
                    }
                  />
                  {stripeHasSubmitted && stripeErrors.platformFeePercent && (
                    <p className="text-sm text-destructive">{stripeErrors.platformFeePercent}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {t('settings.stripePlatformFeeHint')}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                {stripeHasUnsavedChanges && (
                  <p className="text-sm text-muted-foreground">{t('settings.unsavedChanges')}</p>
                )}
                <SaveButton
                  isPending={stripeSaveMutation.isPending}
                  disabled={!stripeHasUnsavedChanges || stripeSaveMutation.isPending}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="relative"
                  onClick={() => {
                    stripeTestMutation.mutate();
                  }}
                  disabled={stripeTestMutation.isPending}
                >
                  {stripeTestMutation.isPending && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Spinner className="h-4 w-4" />
                    </div>
                  )}
                  <span className={stripeTestMutation.isPending ? 'invisible' : ''}>
                    {t('settings.stripeTestConnection')}
                  </span>
                </Button>
              </div>
              {stripeSaveMutation.isSuccess && !stripeHasUnsavedChanges && (
                <p className="text-sm text-success">{t('settings.stripeSaved')}</p>
              )}
              {stripeSaveMutation.isError && (
                <p className="text-sm text-destructive">{t('settings.stripeSaveFailed')}</p>
              )}
              {stripeTestMutation.isSuccess && (
                <p className="text-sm text-success">{t('settings.stripeTestSuccess')}</p>
              )}
              {stripeTestMutation.isError && (
                <p className="text-sm text-destructive">{t('settings.stripeTestFailed')}</p>
              )}
            </form>
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="siteConfigs" className="mt-4">
        <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('settings.paymentSubTabSiteConfigs')}</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="max-h-[400px] md:max-h-[600px] space-y-1 overflow-y-auto px-4 pb-4">
                {siteList?.data != null && siteList.data.length > 0 ? (
                  siteList.data.map((site) => {
                    const config = paymentConfigMap.get(site.id);
                    const enabled = config?.isEnabled ?? false;
                    const isSelected = selectedSiteId === site.id;
                    return (
                      <div
                        key={site.id}
                        className={`flex cursor-pointer items-center justify-between rounded p-2 ${
                          isSelected ? 'bg-accent' : 'hover:bg-muted'
                        }`}
                        onClick={() => {
                          setSelectedSiteId(site.id);
                        }}
                      >
                        <span className="mr-2 truncate text-sm">{site.name}</span>
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                          }}
                        >
                          <Toggle
                            checked={enabled}
                            aria-label={t('settings.sitePaymentsEnabled', { site: site.name })}
                            onCheckedChange={(checked) => {
                              sitePaymentToggleMutation.mutate({
                                siteId: site.id,
                                isEnabled: checked,
                              });
                            }}
                          />
                        </span>
                      </div>
                    );
                  })
                ) : (
                  <p className="px-2 py-4 text-center text-sm text-muted-foreground">
                    {t('settings.siteConfigsNoSites')}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <div>
            {selectedSiteId == null ? (
              <Card>
                <CardContent className="p-6 text-center text-muted-foreground">
                  {t('settings.siteConfigsEmpty')}
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    {siteList?.data.find((s) => s.id === selectedSiteId)?.name ?? ''}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <form onSubmit={handleSiteSubmit} noValidate className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                      {t('settings.siteConfigsDescription')}
                    </p>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="site-connected-account" className="leading-6">
                          {t('payments.connectedAccountId')}
                        </Label>
                        <Input
                          id="site-connected-account"
                          value={siteConnectedAccountId}
                          onChange={(e) => {
                            setSiteConnectedAccountId(e.target.value);
                            markSiteChanged();
                          }}
                          placeholder="acct_..."
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="site-pre-auth" className="leading-6">
                          {t('settings.stripePreAuthAmount', { currency: currency ?? '...' })}
                        </Label>
                        <Input
                          id="site-pre-auth"
                          type="number"
                          min={0}
                          step="0.01"
                          value={sitePreAuthAmount}
                          onChange={(e) => {
                            setSitePreAuthAmount(e.target.value);
                            markSiteChanged();
                          }}
                          className={
                            siteHasSubmitted && siteErrors.preAuthAmountCents
                              ? 'border-destructive'
                              : ''
                          }
                        />
                        {siteHasSubmitted && siteErrors.preAuthAmountCents && (
                          <p className="text-sm text-destructive">
                            {siteErrors.preAuthAmountCents}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {t('settings.stripePreAuthHint')}
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="site-platform-fee" className="leading-6">
                          {t('settings.sitePlatformFeeOverride')}
                        </Label>
                        <DecimalInput
                          id="site-platform-fee"
                          value={sitePlatformFee}
                          onChange={(value) => {
                            setSitePlatformFee(value);
                            markSiteChanged();
                          }}
                          className={
                            siteHasSubmitted && siteErrors.platformFeePercent
                              ? 'border-destructive'
                              : ''
                          }
                        />
                        {siteHasSubmitted && siteErrors.platformFeePercent && (
                          <p className="text-sm text-destructive">
                            {siteErrors.platformFeePercent}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {t('settings.sitePlatformFeeHint')}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <SaveButton
                        isPending={sitePaymentSaveMutation.isPending}
                        disabled={!siteHasUnsavedChanges || sitePaymentSaveMutation.isPending}
                      />
                      {siteHasUnsavedChanges && (
                        <p className="text-sm text-muted-foreground">
                          {t('settings.unsavedChanges')}
                        </p>
                      )}
                    </div>
                    {sitePaymentSaveMutation.isSuccess && !siteHasUnsavedChanges && (
                      <p className="text-sm text-success">{t('settings.stripeSaved')}</p>
                    )}
                    {sitePaymentSaveMutation.isError && (
                      <p className="text-sm text-destructive">{t('settings.stripeSaveFailed')}</p>
                    )}
                  </form>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </TabsContent>
    </Tabs>
  );
}
