// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Copy, Mail, Plus, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/toast';
import { LoadingLogo } from '@/components/loading-logo';
import { api, getApiErrorFieldDetails } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { providerErrorMessage } from './payment-provider-errors';

type PayoutState = 'onboarding' | 'action_required' | 'pending' | 'active' | 'disabled';
type CapabilityState = 'active' | 'inactive' | 'pending' | 'unrequested';

/** `GET /v1/sites/:id/payout-account`. */
export interface SitePayoutAccount {
  accountId: string | null;
  status: PayoutState | null;
  details: {
    capabilities: Record<string, CapabilityState>;
    detailsSubmitted: boolean;
    requirementsDue: string[];
    disabledReason: string | null;
  } | null;
  checkedAt: string | null;
  invite: { expiresAt: string; sentTo: string | null; lastUsedAt: string | null } | null;
}

interface PayoutInvite {
  url: string;
  expiresAt: string;
  sentTo: string | null;
}

const STATUS_VARIANT = {
  onboarding: 'info',
  action_required: 'warning',
  pending: 'warning',
  active: 'success',
  disabled: 'destructive',
  unknown: 'outline',
} as const;

const CAPABILITY_VARIANT = {
  active: 'success',
  inactive: 'outline',
  pending: 'warning',
  unrequested: 'outline',
} as const;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SitePayoutAccountCardProps {
  siteId: string;
  /** Payments are enabled on the site's payment config. */
  paymentsEnabled: boolean;
}

/** Copies through the Clipboard API, which non-secure origins do not have. */
async function copyText(text: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (navigator.clipboard == null) throw new Error('Clipboard unavailable');
  await navigator.clipboard.writeText(text);
}

/**
 * The site host's Stripe Connect payout account (plan P3.5 Part D3): status
 * as last read from Stripe, account creation, the 7-day onboarding link to
 * copy or email, and a refresh from Stripe.
 */
export function SitePayoutAccountCard({
  siteId,
  paymentsEnabled,
}: SitePayoutAccountCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const timezone = useUserTimezone();
  const canWrite = useHasPermission('payments:write');

  const [createOpen, setCreateOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [contactEmail, setContactEmail] = useState('');
  const [country, setCountry] = useState('');
  const [createSubmitted, setCreateSubmitted] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [manualLink, setManualLink] = useState<string | null>(null);

  const accountKey = ['sites', siteId, 'payout-account'];

  const account = useQuery({
    queryKey: accountKey,
    queryFn: () => api.get<SitePayoutAccount>(`/v1/sites/${siteId}/payout-account`),
    staleTime: 30_000,
  });

  const site = useQuery({
    queryKey: ['sites', siteId],
    queryFn: () => api.get<{ id: string; contactEmail: string | null }>(`/v1/sites/${siteId}`),
    staleTime: 30_000,
  });
  const siteContactEmail =
    site.data?.contactEmail != null && site.data.contactEmail !== ''
      ? site.data.contactEmail
      : null;

  function onAccountChanged(view: SitePayoutAccount): void {
    queryClient.setQueryData(accountKey, view);
    void queryClient.invalidateQueries({ queryKey: ['all-payment-configs'] });
    void queryClient.invalidateQueries({ queryKey: ['sites', siteId, 'payment-config'] });
  }

  function showError(title: string, err: unknown): void {
    toast({ title, description: providerErrorMessage(err, t), variant: 'destructive' });
  }

  const createMutation = useMutation({
    mutationFn: (body: { contactEmail: string; country?: string }) =>
      api.post<SitePayoutAccount>(`/v1/sites/${siteId}/payout-account`, body),
    onSuccess: (view) => {
      onAccountChanged(view);
      setCreateOpen(false);
      toast({ title: t('payments.payoutAccountCreated'), variant: 'success' });
    },
    onError: (err) => {
      const details = getApiErrorFieldDetails(err);
      if (details['country'] != null) {
        setCreateError(t('payments.payoutAccountCountryRequired'));
        return;
      }
      if (details['contactEmail'] != null) {
        setCreateError(t('validation.email'));
        return;
      }
      setCreateOpen(false);
      showError(t('payments.payoutAccountCreateFailed'), err);
      void account.refetch();
    },
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.post<SitePayoutAccount>(`/v1/sites/${siteId}/payout-account/refresh`, {}),
    onSuccess: (view) => {
      onAccountChanged(view);
      toast({ title: t('payments.payoutAccountRefreshed'), variant: 'success' });
    },
    onError: (err) => {
      showError(t('payments.payoutAccountRefreshFailed'), err);
    },
  });

  const copyMutation = useMutation({
    mutationFn: () =>
      api.post<PayoutInvite>(`/v1/sites/${siteId}/payout-account/invite`, { send: 'none' }),
    onSuccess: async (invite) => {
      void account.refetch();
      try {
        await copyText(invite.url);
        setManualLink(null);
        toast({ title: t('payments.payoutAccountLinkCopied'), variant: 'success' });
      } catch (err) {
        // No clipboard access (non-secure origin, or the browser refused a
        // write after the request): show the link to copy by hand.
        console.warn('Copy payout invite link failed, showing it to copy by hand', err);
        setManualLink(invite.url);
      }
    },
    onError: (err) => {
      void account.refetch();
      showError(t('payments.payoutAccountLinkFailed'), err);
    },
  });

  const emailMutation = useMutation({
    mutationFn: () =>
      api.post<PayoutInvite>(`/v1/sites/${siteId}/payout-account/invite`, { send: 'email' }),
    onSuccess: (invite) => {
      setEmailOpen(false);
      void account.refetch();
      toast({
        title: t('payments.payoutAccountEmailSent', { email: invite.sentTo ?? '' }),
        variant: 'success',
      });
    },
    onError: (err) => {
      setEmailOpen(false);
      showError(t('payments.payoutAccountLinkFailed'), err);
    },
  });

  const emailError = !EMAIL_PATTERN.test(contactEmail.trim())
    ? contactEmail.trim() === ''
      ? t('validation.required')
      : t('validation.email')
    : null;
  const countryError =
    country.trim() !== '' && !/^[A-Za-z]{2}$/.test(country.trim())
      ? t('payments.payoutAccountCountryInvalid')
      : null;

  function openCreate(): void {
    setContactEmail(siteContactEmail ?? '');
    setCountry('');
    setCreateSubmitted(false);
    setCreateError(null);
    setCreateOpen(true);
  }

  function submitCreate(): boolean {
    setCreateSubmitted(true);
    setCreateError(null);
    if (emailError != null || countryError != null) return false;
    const body: { contactEmail: string; country?: string } = { contactEmail: contactEmail.trim() };
    if (country.trim() !== '') body.country = country.trim().toUpperCase();
    createMutation.mutate(body);
    return false;
  }

  const view = account.data;
  const stateKey = view?.status ?? 'unknown';
  const requirements = view?.details?.requirementsDue ?? [];

  const emailButton = (
    <Button
      variant="outline"
      disabled={siteContactEmail == null}
      onClick={() => {
        setEmailOpen(true);
      }}
    >
      <Mail className="h-4 w-4" />
      {t('payments.payoutAccountEmailContact')}
    </Button>
  );

  return (
    <Card data-testid="site-payout-account">
      <CardHeader>
        <CardTitle className="text-base">{t('payments.payoutAccountTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">{t('payments.payoutAccountDescription')}</p>

        {account.isLoading ? (
          <LoadingLogo size="inline" />
        ) : account.isError || view == null ? (
          <p className="text-destructive">{t('payments.payoutAccountLoadFailed')}</p>
        ) : view.accountId == null ? (
          <div className="space-y-3">
            <p className="text-muted-foreground">{t('payments.payoutAccountNone')}</p>
            {canWrite && (
              <Button onClick={openCreate}>
                <Plus className="h-4 w-4" />
                {t('payments.payoutAccountCreate')}
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {paymentsEnabled && view.status !== 'active' && (
              <Alert variant="warning">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{t('payments.payoutAccountNotActiveWarning')}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{view.accountId}</span>
              <Badge variant={STATUS_VARIANT[stateKey]}>
                {t(`payments.payoutAccountStatus.${stateKey}`)}
              </Badge>
              {view.status === 'action_required' && (
                <span className="text-muted-foreground">
                  {t('payments.payoutAccountRequirementsDue', { count: requirements.length })}
                </span>
              )}
            </div>
            <p className="text-muted-foreground">
              {t(`payments.payoutAccountStatusHelp.${stateKey}`)}
            </p>
            {view.status === 'disabled' && view.details?.disabledReason != null && (
              <p className="text-muted-foreground">
                {t('payments.payoutAccountDisabledReason', {
                  reason: view.details.disabledReason,
                })}
              </p>
            )}
            {view.status !== 'active' && requirements.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5 font-mono text-xs text-muted-foreground">
                {requirements.map((requirement) => (
                  <li key={requirement}>{requirement}</li>
                ))}
              </ul>
            )}

            {view.details != null && (
              <div className="space-y-1">
                <p className="font-medium">{t('payments.payoutAccountCapabilities')}</p>
                <div className="flex flex-wrap gap-3">
                  {Object.entries(view.details.capabilities).map(([name, state]) => (
                    <span key={name} className="flex items-center gap-1.5">
                      <span className="font-mono text-xs">{name}</span>
                      <Badge variant={CAPABILITY_VARIANT[state]}>
                        {t(`payments.payoutCapability.${state}`)}
                      </Badge>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {view.checkedAt != null && (
              <p className="text-muted-foreground">
                {t('payments.payoutAccountLastChecked', {
                  date: formatDateTime(view.checkedAt, timezone),
                })}
              </p>
            )}

            {view.invite != null && view.status !== 'active' && (
              <div className="space-y-0.5 text-muted-foreground">
                <p>
                  {t('payments.payoutAccountInviteOpen', {
                    date: formatDateTime(view.invite.expiresAt, timezone),
                  })}
                </p>
                {view.invite.sentTo != null && (
                  <p>{t('payments.payoutAccountInviteSentTo', { email: view.invite.sentTo })}</p>
                )}
                {view.invite.lastUsedAt != null && (
                  <p>
                    {t('payments.payoutAccountInviteLastUsed', {
                      date: formatDateTime(view.invite.lastUsedAt, timezone),
                    })}
                  </p>
                )}
              </div>
            )}

            {manualLink != null && (
              <div className="space-y-2">
                <Label htmlFor="payout-onboarding-link">
                  {t('payments.payoutAccountManualCopy')}
                </Label>
                <Input
                  id="payout-onboarding-link"
                  readOnly
                  value={manualLink}
                  onFocus={(e) => {
                    e.target.select();
                  }}
                />
              </div>
            )}

            {canWrite && (
              <div className="flex flex-wrap gap-2">
                {view.status !== 'active' && (
                  <>
                    <Button
                      variant="outline"
                      disabled={copyMutation.isPending}
                      onClick={() => {
                        copyMutation.mutate();
                      }}
                    >
                      <Copy className="h-4 w-4" />
                      {t('payments.payoutAccountCopyLink')}
                    </Button>
                    {siteContactEmail == null ? (
                      <Tooltip content={t('payments.payoutAccountNoContactEmail')}>
                        {emailButton}
                      </Tooltip>
                    ) : (
                      emailButton
                    )}
                  </>
                )}
                <Button
                  variant="outline"
                  className="relative"
                  disabled={refreshMutation.isPending}
                  onClick={() => {
                    refreshMutation.mutate();
                  }}
                >
                  {refreshMutation.isPending && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    </div>
                  )}
                  <span
                    className={`flex items-center gap-2 ${refreshMutation.isPending ? 'invisible' : ''}`}
                  >
                    <RefreshCw className="h-4 w-4" />
                    {t('payments.payoutAccountRefresh')}
                  </span>
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={t('payments.payoutAccountCreate')}
        description={t('payments.payoutAccountCreateBody')}
        confirmLabel={t('payments.payoutAccountCreate')}
        variant="default"
        isPending={createMutation.isPending}
        onConfirm={submitCreate}
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="payout-contact-email">{t('payments.payoutAccountContactEmail')}</Label>
            <Input
              id="payout-contact-email"
              type="email"
              value={contactEmail}
              onChange={(e) => {
                setContactEmail(e.target.value);
                setCreateError(null);
              }}
              className={createSubmitted && emailError != null ? 'border-destructive' : ''}
            />
            {createSubmitted && emailError != null && (
              <p className="text-sm text-destructive">{emailError}</p>
            )}
            <p className="text-xs text-muted-foreground">
              {t('payments.payoutAccountContactEmailHint')}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="payout-country">{t('payments.payoutAccountCountry')}</Label>
            <Input
              id="payout-country"
              value={country}
              onChange={(e) => {
                setCountry(e.target.value);
                setCreateError(null);
              }}
              className={createSubmitted && countryError != null ? 'border-destructive' : ''}
            />
            {createSubmitted && countryError != null && (
              <p className="text-sm text-destructive">{countryError}</p>
            )}
            <p className="text-xs text-muted-foreground">
              {t('payments.payoutAccountCountryHint')}
            </p>
          </div>
          {createError != null && <p className="text-sm text-destructive">{createError}</p>}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={emailOpen}
        onOpenChange={setEmailOpen}
        title={t('payments.payoutAccountEmailContact')}
        description={t('payments.payoutAccountEmailBody', { email: siteContactEmail ?? '' })}
        confirmLabel={t('payments.payoutAccountEmailSend')}
        variant="default"
        isPending={emailMutation.isPending}
        onConfirm={() => {
          emailMutation.mutate();
          return false;
        }}
      />
    </Card>
  );
}
