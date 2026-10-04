// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FlaskConical } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DecimalInput } from '@/components/ui/decimal-input';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { SaveButton } from '@/components/save-button';
import { LoadingLogo } from '@/components/loading-logo';
import { ApiError, api, getApiErrorCode, getApiErrorFieldDetails } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { useCompanyCurrency } from '@/hooks/use-company-currency';
import { centsToMajorInput, parseMajorInputToCents } from '@evtivity/lib/currency';
import { percentError, preAuthAmountError, rangeError } from './payment-amount-validation';

/** Why the provider-switch guard refuses a provider (catalog entry and 409 `details`). */
export interface ProviderUpgradePending {
  legacyConnections: number;
  hosts: string[];
  lastLegacySeenAt: string | null;
  watchCheckedAt: string | null;
}

/** A provider of `GET /v1/settings/payments`. */
export interface PaymentProviderEntry {
  id: string;
  configured: boolean;
  selectable: boolean;
  reason: 'not_configured' | 'requires_upgrade' | null;
  upgradePending: ProviderUpgradePending | null;
  capabilities: {
    savedMethods: boolean;
    clientActions: boolean;
    nativeMobileSheet: boolean;
    marketplaceSplit: string;
  };
}

/** `GET /v1/settings/payments`. */
export interface PaymentSettingsResponse {
  provider: string;
  preAuthAmountCents: number;
  platformFeePercent: number;
  simulated: {
    resultMode: 'sync' | 'async';
    asyncDelaySeconds: number;
    randomFailureRate: number;
  };
  providers: PaymentProviderEntry[];
}

/** `PUT /v1/settings/payments`: only changed fields are sent. */
export interface PaymentSettingsBody {
  provider?: string;
  preAuthAmountCents?: number;
  platformFeePercent?: number;
  simulated?: {
    resultMode?: 'sync' | 'async';
    asyncDelaySeconds?: number;
    randomFailureRate?: number;
  };
}

const NO_PROVIDER = 'none';
const SIMULATED = 'simulated';
const PRE_AUTH_LIMITS = { minCents: 1, maxCents: 1_000_000 };
const DELAY_RANGE = { min: 0, max: 3600, integer: true };
const RATE_RANGE = { min: 0, max: 1, integer: false };

/** Display name of a provider id; plugin ids show as they are. */
export function providerName(id: string, t: TFunction): string {
  switch (id) {
    case 'stripe':
      return t('paymentProviders.names.stripe');
    case 'adyen':
      return t('paymentProviders.names.adyen');
    case SIMULATED:
      return t('paymentProviders.names.simulated');
    default:
      return id;
  }
}

function reasonText(entry: PaymentProviderEntry, t: TFunction): string | null {
  if (entry.reason === 'not_configured') return t('paymentProviders.reason.not_configured');
  if (entry.reason === 'requires_upgrade') return t('paymentProviders.reason.requires_upgrade');
  return null;
}

function upgradePendingFromError(err: unknown): ProviderUpgradePending | null {
  if (!(err instanceof ApiError)) return null;
  if (getApiErrorCode(err) !== 'PAYMENT_PROVIDER_UPGRADE_PENDING') return null;
  const body = err.body as { details?: Partial<ProviderUpgradePending> } | null;
  const details = body?.details;
  if (details == null) return null;
  return {
    legacyConnections:
      typeof details.legacyConnections === 'number' ? details.legacyConnections : 0,
    hosts: Array.isArray(details.hosts) ? details.hosts : [],
    lastLegacySeenAt: details.lastLegacySeenAt ?? null,
    watchCheckedAt: details.watchCheckedAt ?? null,
  };
}

/** What the provider-switch guard found, so the operator knows what to finish. */
export function UpgradePendingDetails({
  providerId,
  details,
}: {
  providerId: string;
  details: ProviderUpgradePending;
}): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const provider = providerName(providerId, t);
  return (
    <div className="space-y-1 text-sm" data-testid={`upgrade-pending-${providerId}`}>
      <p className="font-medium">{t('paymentProviders.upgradePending.title', { provider })}</p>
      <p>{t('paymentProviders.upgradePending.description', { provider })}</p>
      <ul className="list-disc space-y-0.5 pl-5">
        <li>
          {t('paymentProviders.upgradePending.connections', { count: details.legacyConnections })}
        </li>
        {details.hosts.length > 0 && (
          <li>{t('paymentProviders.upgradePending.hosts', { hosts: details.hosts.join(', ') })}</li>
        )}
        {details.lastLegacySeenAt != null && (
          <li>
            {t('paymentProviders.upgradePending.lastSeen', {
              date: formatDateTime(details.lastLegacySeenAt, timezone),
            })}
          </li>
        )}
        <li>
          {details.watchCheckedAt != null
            ? t('paymentProviders.upgradePending.checkedAt', {
                date: formatDateTime(details.watchCheckedAt, timezone),
              })
            : t('paymentProviders.upgradePending.notChecked')}
        </li>
      </ul>
    </div>
  );
}

function ProviderStatusBadge({
  entry,
  selected,
}: {
  entry: PaymentProviderEntry;
  selected: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  if (entry.reason === 'not_configured') {
    return <Badge variant="outline">{t('paymentProviders.status.not_configured')}</Badge>;
  }
  if (entry.reason === 'requires_upgrade') {
    return <Badge variant="warning">{t('paymentProviders.status.requires_upgrade')}</Badge>;
  }
  if (selected) return <Badge variant="success">{t('paymentProviders.status.selected')}</Badge>;
  return <Badge variant="secondary">{t('paymentProviders.status.ready')}</Badge>;
}

interface FormState {
  provider: string;
  preAuthAmount: string;
  platformFee: string;
  resultMode: 'sync' | 'async';
  asyncDelaySeconds: string;
  randomFailureRate: string;
}

function formFrom(data: PaymentSettingsResponse): FormState {
  return {
    provider: data.provider,
    preAuthAmount: centsToMajorInput(data.preAuthAmountCents),
    platformFee: String(data.platformFeePercent),
    resultMode: data.simulated.resultMode,
    asyncDelaySeconds: String(data.simulated.asyncDelaySeconds),
    randomFailureRate: String(data.simulated.randomFailureRate),
  };
}

/** The fields that differ from the stored settings. */
function changedFields(
  form: FormState,
  data: PaymentSettingsResponse,
  simulatedListed: boolean,
): PaymentSettingsBody {
  const body: PaymentSettingsBody = {};
  if (form.provider !== data.provider) body.provider = form.provider;
  const preAuth = parseMajorInputToCents(form.preAuthAmount);
  if (preAuth != null && preAuth !== data.preAuthAmountCents) body.preAuthAmountCents = preAuth;
  const fee = Number(form.platformFee);
  if (fee !== data.platformFeePercent) body.platformFeePercent = fee;
  if (simulatedListed) {
    const simulated: NonNullable<PaymentSettingsBody['simulated']> = {};
    if (form.resultMode !== data.simulated.resultMode) simulated.resultMode = form.resultMode;
    const delay = Number(form.asyncDelaySeconds);
    if (delay !== data.simulated.asyncDelaySeconds) simulated.asyncDelaySeconds = delay;
    const rate = Number(form.randomFailureRate);
    if (rate !== data.simulated.randomFailureRate) simulated.randomFailureRate = rate;
    if (Object.keys(simulated).length > 0) body.simulated = simulated;
  }
  return body;
}

function PaymentProviderForm({ data }: { data: PaymentSettingsResponse }): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('payments:write');
  const { currency } = useCompanyCurrency();
  const [form, setForm] = useState<FormState>(() => formFrom(data));
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const simulatedEntry = data.providers.find((p) => p.id === SIMULATED);

  const saveMutation = useMutation({
    mutationFn: (body: PaymentSettingsBody) => api.put('/v1/settings/payments', body),
    onSuccess: () => {
      setHasUnsavedChanges(false);
      for (const queryKey of [
        ['payment-settings'],
        ['payment-provider'],
        ['stripe-settings'],
        ['settings'],
        ['system-info'],
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });

  useEffect(() => {
    setForm(formFrom(data));
    setHasSubmitted(false);
    setHasUnsavedChanges(false);
  }, [data]);

  function update(patch: Partial<FormState>): void {
    setForm((prev) => ({ ...prev, ...patch }));
    setHasUnsavedChanges(true);
    saveMutation.reset();
  }

  const errors: Partial<Record<keyof FormState, string>> = {};
  const preAuthError = preAuthAmountError(form.preAuthAmount, t, PRE_AUTH_LIMITS);
  if (preAuthError != null) errors.preAuthAmount = preAuthError;
  const feeError = percentError(form.platformFee, t, true);
  if (feeError != null) errors.platformFee = feeError;
  if (simulatedEntry != null) {
    const delayError = rangeError(form.asyncDelaySeconds, t, DELAY_RANGE);
    if (delayError != null) errors.asyncDelaySeconds = delayError;
    const rateError = rangeError(form.randomFailureRate, t, RATE_RANGE);
    if (rateError != null) errors.randomFailureRate = rateError;
  }

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    saveMutation.mutate(changedFields(form, data, simulatedEntry != null));
  }

  const upgradeError = upgradePendingFromError(saveMutation.error);
  const attemptedProvider = saveMutation.variables?.provider ?? form.provider;
  const providerFieldError =
    saveMutation.isError && getApiErrorFieldDetails(saveMutation.error).provider != null
      ? t('paymentProviders.select.refused')
      : null;
  const storedListed =
    data.provider === NO_PROVIDER || data.providers.some((p) => p.id === data.provider);
  // A 409 shows the guard details next to the save button; the catalog panel would repeat them.
  const pendingEntries = data.providers.filter(
    (p) => p.upgradePending != null && !(upgradeError != null && p.id === attemptedProvider),
  );

  function fieldClass(field: keyof FormState): string {
    return hasSubmitted && errors[field] != null ? 'border-destructive' : '';
  }

  function fieldError(field: keyof FormState): React.JSX.Element | null {
    const message = errors[field];
    if (!hasSubmitted || message == null) return null;
    return <p className="text-sm text-destructive">{message}</p>;
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('paymentProviders.general.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('paymentProviders.general.description')}
          </p>

          {data.provider === NO_PROVIDER && (
            <Alert variant="warning">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{t('paymentProviders.general.noneWarning')}</AlertDescription>
            </Alert>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="payment-provider" className="leading-6">
                {t('paymentProviders.select.label')}
              </Label>
              <Select
                id="payment-provider"
                value={form.provider}
                disabled={!canWrite}
                className={providerFieldError != null ? 'border-destructive' : ''}
                onChange={(e) => {
                  update({ provider: e.target.value });
                }}
              >
                <option value={NO_PROVIDER}>{t('paymentProviders.select.none')}</option>
                {data.providers.map((entry) => {
                  const reason = reasonText(entry, t);
                  const name = providerName(entry.id, t);
                  return (
                    <option key={entry.id} value={entry.id} disabled={!entry.selectable}>
                      {reason == null
                        ? name
                        : t('paymentProviders.select.optionWithReason', { provider: name, reason })}
                    </option>
                  );
                })}
                {!storedListed && (
                  <option value={data.provider} disabled>
                    {t('paymentProviders.select.unavailable', {
                      provider: providerName(data.provider, t),
                    })}
                  </option>
                )}
              </Select>
              {providerFieldError != null && (
                <p className="text-sm text-destructive">{providerFieldError}</p>
              )}
              <p className="text-xs text-muted-foreground">{t('paymentProviders.select.hint')}</p>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium leading-6">{t('paymentProviders.status.title')}</p>
              <ul className="space-y-1" aria-label={t('paymentProviders.status.title')}>
                {data.providers.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between gap-2 text-sm"
                    data-testid={`provider-status-${entry.id}`}
                  >
                    <span>{providerName(entry.id, t)}</span>
                    <ProviderStatusBadge entry={entry} selected={entry.id === data.provider} />
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {pendingEntries.map((entry) =>
            entry.upgradePending == null ? null : (
              <Alert key={entry.id} variant="warning" className="items-start">
                <AlertTriangle className="mt-0.5 h-4 w-4" />
                <AlertDescription>
                  <UpgradePendingDetails providerId={entry.id} details={entry.upgradePending} />
                </AlertDescription>
              </Alert>
            ),
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="payments-pre-auth" className="leading-6">
                {t('paymentProviders.general.preAuthAmount', { currency: currency ?? '...' })}
              </Label>
              <Input
                id="payments-pre-auth"
                disabled={!canWrite}
                type="number"
                min={0.01}
                step="0.01"
                value={form.preAuthAmount}
                onChange={(e) => {
                  update({ preAuthAmount: e.target.value });
                }}
                className={fieldClass('preAuthAmount')}
              />
              {fieldError('preAuthAmount')}
              <p className="text-xs text-muted-foreground">
                {t('paymentProviders.general.preAuthHint')}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="payments-platform-fee" className="leading-6">
                {t('paymentProviders.general.platformFee')}
              </Label>
              <DecimalInput
                id="payments-platform-fee"
                disabled={!canWrite}
                value={form.platformFee}
                onChange={(value) => {
                  update({ platformFee: value });
                }}
                className={fieldClass('platformFee')}
              />
              {fieldError('platformFee')}
              <p className="text-xs text-muted-foreground">
                {t('paymentProviders.general.platformFeeHint')}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {simulatedEntry != null && (
        <Card>
          <CardHeader>
            <CardTitle>{t('paymentProviders.simulated.title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert variant="info">
              <FlaskConical className="h-4 w-4" />
              <AlertDescription>{t('paymentProviders.simulated.testMode')}</AlertDescription>
            </Alert>
            <p className="text-sm text-muted-foreground">
              {t('paymentProviders.simulated.description')}
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="simulated-result-mode" className="leading-6">
                  {t('paymentProviders.simulated.resultMode')}
                </Label>
                <Select
                  id="simulated-result-mode"
                  value={form.resultMode}
                  disabled={!canWrite}
                  onChange={(e) => {
                    update({ resultMode: e.target.value === 'async' ? 'async' : 'sync' });
                  }}
                >
                  <option value="sync">{t('paymentProviders.simulated.resultModeSync')}</option>
                  <option value="async">{t('paymentProviders.simulated.resultModeAsync')}</option>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {form.resultMode === 'async'
                    ? t('paymentProviders.simulated.resultModeAsyncHint')
                    : t('paymentProviders.simulated.resultModeHint')}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="simulated-async-delay" className="leading-6">
                  {t('paymentProviders.simulated.asyncDelay')}
                </Label>
                <Input
                  id="simulated-async-delay"
                  type="number"
                  min={0}
                  max={3600}
                  step={1}
                  disabled={!canWrite}
                  value={form.asyncDelaySeconds}
                  onChange={(e) => {
                    update({ asyncDelaySeconds: e.target.value });
                  }}
                  className={fieldClass('asyncDelaySeconds')}
                />
                {fieldError('asyncDelaySeconds')}
                <p className="text-xs text-muted-foreground">
                  {t('paymentProviders.simulated.asyncDelayHint')}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="simulated-failure-rate" className="leading-6">
                  {t('paymentProviders.simulated.failureRate')}
                </Label>
                <DecimalInput
                  id="simulated-failure-rate"
                  disabled={!canWrite}
                  value={form.randomFailureRate}
                  onChange={(value) => {
                    update({ randomFailureRate: value });
                  }}
                  className={fieldClass('randomFailureRate')}
                />
                {fieldError('randomFailureRate')}
                <p className="text-xs text-muted-foreground">
                  {t('paymentProviders.simulated.failureRateHint')}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {upgradeError != null && (
        <Alert variant="destructive" className="items-start">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <AlertDescription className="space-y-2">
            <p>{getErrorMessage(saveMutation.error, t)}</p>
            <UpgradePendingDetails providerId={attemptedProvider} details={upgradeError} />
          </AlertDescription>
        </Alert>
      )}

      {canWrite && (
        <div className="flex items-center justify-end gap-2">
          {hasUnsavedChanges && (
            <p className="text-sm text-muted-foreground">{t('settings.unsavedChanges')}</p>
          )}
          <SaveButton
            isPending={saveMutation.isPending}
            disabled={!hasUnsavedChanges || saveMutation.isPending}
          />
        </div>
      )}
      {saveMutation.isSuccess && !hasUnsavedChanges && (
        <p className="text-sm text-success">{t('paymentProviders.general.saved')}</p>
      )}
      {saveMutation.isError && upgradeError == null && (
        <p className="text-sm text-destructive">{getErrorMessage(saveMutation.error, t)}</p>
      )}
    </form>
  );
}

/** Settings > Payment > General: provider select, defaults and the test provider. */
export function PaymentProviderSettings(): React.JSX.Element {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ['payment-settings'],
    queryFn: () => api.get<PaymentSettingsResponse>('/v1/settings/payments'),
    staleTime: 60_000,
  });

  if (query.isLoading) return <LoadingLogo size="inline" />;
  if (query.data == null) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription className="flex flex-wrap items-center gap-2">
          <span>{t('paymentProviders.general.loadFailed')}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void query.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return <PaymentProviderForm data={query.data} />;
}
