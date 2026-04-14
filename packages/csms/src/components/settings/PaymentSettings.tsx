// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useTab } from '@/hooks/use-tab';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { SaveButton } from '@/components/save-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';

interface PaymentSettingsProps {
  settings: Record<string, unknown> | undefined;
}

interface StripeSettings {
  publishableKey: string | null;
  currency: string;
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
  currency: string;
  preAuthAmountCents: number;
  platformFeePercent: string | null;
  isEnabled: boolean;
}

export function PaymentSettings({ settings }: PaymentSettingsProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [paymentSubTab, setPaymentSubTab] = useTab('stripe', 'sub');

  const [stripeSecretKey, setStripeSecretKey] = useState('');
  const [stripePublishableKey, setStripePublishableKey] = useState('');
  const [stripeCurrency, setStripeCurrency] = useState('USD');
  const [stripePreAuthCents, setStripePreAuthCents] = useState('5000');
  const [stripePlatformFee, setStripePlatformFee] = useState('0');
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);

  const [siteConnectedAccountId, setSiteConnectedAccountId] = useState('');
  const [siteCurrency, setSiteCurrency] = useState('USD');
  const [sitePreAuthCents, setSitePreAuthCents] = useState('5000');
  const [sitePlatformFee, setSitePlatformFee] = useState('');

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
      setSiteCurrency(selectedSiteConfig.currency);
      setSitePreAuthCents(String(selectedSiteConfig.preAuthAmountCents));
      setSitePlatformFee(
        selectedSiteConfig.platformFeePercent != null ? selectedSiteConfig.platformFeePercent : '',
      );
    } else if (selectedSiteId != null) {
      setSiteConnectedAccountId('');
      setSiteCurrency('USD');
      setSitePreAuthCents('5000');
      setSitePlatformFee('');
    }
  }, [selectedSiteConfig, selectedSiteId]);

  useEffect(() => {
    if (stripeSettings == null) return;
    setStripePublishableKey(
      typeof stripeSettings.publishableKey === 'string' ? stripeSettings.publishableKey : '',
    );
    setStripeCurrency(stripeSettings.currency);
    setStripePreAuthCents(String(stripeSettings.preAuthAmountCents));
    setStripePlatformFee(String(stripeSettings.platformFeePercent));
  }, [stripeSettings]);

  const stripeSaveMutation = useMutation({
    mutationFn: (vals: {
      secretKey?: string;
      publishableKey?: string;
      currency?: string;
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
      currency: string;
      preAuthAmountCents: number;
      platformFeePercent: number | null;
      isEnabled: boolean;
    }) =>
      api.put(`/v1/sites/${vals.siteId}/payment-config`, {
        stripeConnectedAccountId: vals.stripeConnectedAccountId,
        currency: vals.currency,
        preAuthAmountCents: vals.preAuthAmountCents,
        platformFeePercent: vals.platformFeePercent,
        isEnabled: vals.isEnabled,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['all-payment-configs'] });
      void refetchSiteConfig();
    },
  });

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
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('settings.stripeDescription')}</p>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="stripe-secret-key">{t('settings.stripeSecretKey')}</Label>
                <PasswordInput
                  id="stripe-secret-key"
                  value={stripeSecretKey}
                  onChange={(e) => {
                    setStripeSecretKey(e.target.value);
                  }}
                  placeholder={
                    settings != null &&
                    typeof settings['stripe.secretKeyEnc'] === 'string' &&
                    settings['stripe.secretKeyEnc'] !== ''
                      ? '********'
                      : ''
                  }
                />
                <p className="text-xs text-muted-foreground">{t('settings.stripeSecretKeyHint')}</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="stripe-publishable-key">{t('settings.stripePublishableKey')}</Label>
                <Input
                  id="stripe-publishable-key"
                  value={stripePublishableKey}
                  onChange={(e) => {
                    setStripePublishableKey(e.target.value);
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="stripe-currency">{t('settings.stripeCurrency')}</Label>
                <Input
                  id="stripe-currency"
                  value={stripeCurrency}
                  onChange={(e) => {
                    setStripeCurrency(e.target.value.toUpperCase());
                  }}
                  maxLength={3}
                  placeholder="USD"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="stripe-pre-auth">{t('settings.stripePreAuthAmount')}</Label>
                <Input
                  id="stripe-pre-auth"
                  type="number"
                  value={stripePreAuthCents}
                  onChange={(e) => {
                    setStripePreAuthCents(e.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">{t('settings.stripePreAuthHint')}</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="stripe-platform-fee">{t('settings.stripePlatformFee')}</Label>
                <Input
                  id="stripe-platform-fee"
                  type="number"
                  step="0.1"
                  min="0"
                  max="100"
                  value={stripePlatformFee}
                  onChange={(e) => {
                    setStripePlatformFee(e.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.stripePlatformFeeHint')}
                </p>
              </div>
            </div>

            <div className="flex gap-2">
              <SaveButton
                isPending={stripeSaveMutation.isPending}
                type="button"
                onClick={() => {
                  const vals: Record<string, unknown> = {};
                  if (stripeSecretKey !== '') vals['secretKey'] = stripeSecretKey;
                  if (stripePublishableKey !== '') vals['publishableKey'] = stripePublishableKey;
                  if (stripeCurrency !== '') vals['currency'] = stripeCurrency;
                  vals['preAuthAmountCents'] = Number(stripePreAuthCents);
                  vals['platformFeePercent'] = Number(stripePlatformFee);
                  stripeSaveMutation.mutate(
                    vals as Parameters<typeof stripeSaveMutation.mutate>[0],
                  );
                }}
              />
              <Button
                variant="outline"
                onClick={() => {
                  stripeTestMutation.mutate();
                }}
                disabled={stripeTestMutation.isPending}
              >
                {stripeTestMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('settings.stripeTestConnection')}
              </Button>
            </div>
            {stripeSaveMutation.isSuccess && (
              <p className="text-sm text-green-600">{t('settings.stripeSaved')}</p>
            )}
            {stripeSaveMutation.isError && (
              <p className="text-sm text-destructive">{t('settings.stripeSaveFailed')}</p>
            )}
            {stripeTestMutation.isSuccess && (
              <p className="text-sm text-green-600">{t('settings.stripeTestSuccess')}</p>
            )}
            {stripeTestMutation.isError && (
              <p className="text-sm text-destructive">{t('settings.stripeTestFailed')}</p>
            )}
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
                        <button
                          type="button"
                          role="switch"
                          aria-checked={enabled}
                          onClick={(e) => {
                            e.stopPropagation();
                            sitePaymentToggleMutation.mutate({
                              siteId: site.id,
                              isEnabled: !enabled,
                            });
                          }}
                          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${enabled ? 'bg-primary' : 'bg-muted'}`}
                        >
                          <span
                            className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0'}`}
                          />
                        </button>
                      </div>
                    );
                  })
                ) : (
                  <p className="px-2 py-4 text-sm text-muted-foreground">
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
                <CardContent className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    {t('settings.siteConfigsDescription')}
                  </p>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="site-connected-account">
                        {t('payments.connectedAccountId')}
                      </Label>
                      <Input
                        id="site-connected-account"
                        value={siteConnectedAccountId}
                        onChange={(e) => {
                          setSiteConnectedAccountId(e.target.value);
                        }}
                        placeholder="acct_..."
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="site-currency">{t('payments.currency')}</Label>
                      <Input
                        id="site-currency"
                        value={siteCurrency}
                        onChange={(e) => {
                          setSiteCurrency(e.target.value.toUpperCase());
                        }}
                        maxLength={3}
                        placeholder="USD"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="site-pre-auth">{t('payments.preAuthAmount')}</Label>
                      <Input
                        id="site-pre-auth"
                        type="number"
                        value={sitePreAuthCents}
                        onChange={(e) => {
                          setSitePreAuthCents(e.target.value);
                        }}
                      />
                      <p className="text-xs text-muted-foreground">{t('payments.amountInCents')}</p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="site-platform-fee">
                        {t('settings.sitePlatformFeeOverride')}
                      </Label>
                      <Input
                        id="site-platform-fee"
                        type="number"
                        step="0.1"
                        min="0"
                        max="100"
                        value={sitePlatformFee}
                        onChange={(e) => {
                          setSitePlatformFee(e.target.value);
                        }}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t('settings.sitePlatformFeeHint')}
                      </p>
                    </div>
                  </div>

                  <SaveButton
                    isPending={sitePaymentSaveMutation.isPending}
                    type="button"
                    onClick={() => {
                      sitePaymentSaveMutation.mutate({
                        siteId: selectedSiteId,
                        stripeConnectedAccountId:
                          siteConnectedAccountId !== '' ? siteConnectedAccountId : undefined,
                        currency: siteCurrency,
                        preAuthAmountCents: Number(sitePreAuthCents),
                        platformFeePercent: sitePlatformFee !== '' ? Number(sitePlatformFee) : null,
                        isEnabled: paymentConfigMap.get(selectedSiteId)?.isEnabled ?? true,
                      });
                    }}
                  />
                  {sitePaymentSaveMutation.isSuccess && (
                    <p className="text-sm text-green-600">{t('settings.stripeSaved')}</p>
                  )}
                  {sitePaymentSaveMutation.isError && (
                    <p className="text-sm text-destructive">{t('settings.stripeSaveFailed')}</p>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </TabsContent>
    </Tabs>
  );
}
