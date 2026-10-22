// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Info } from 'lucide-react';
import {
  SIM_FETCH_DAYS,
  SIM_OCPP16_SIGNAL_KEYS_LIMITS,
  SIM_RETENTION_DAYS,
  SIM_SIGNAL_DBM,
  isHologramOrgId,
  parseOcpp16SignalKeys,
} from '@evtivity/lib/sim-settings';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Toggle } from '@/components/ui/toggle';
import { SaveButton } from '@/components/save-button';
import { LoadingLogo } from '@/components/loading-logo';
import { simErrorMessage } from '@/components/station/sim-connectivity';
import { api } from '@/lib/api';
import { useHasAllSiteAccess, useHasCompanyWidePermission, useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatNumber } from '@/lib/formatting';
import { useLoadedValues } from '@/hooks/use-loaded-values';
import { StoredSecretInput } from './StoredSecretInput';
import { secretChange, type StoredSecret } from './stored-secret';

export const SIM_PROVIDER_SETTINGS_KEY = ['sim-provider-settings'] as const;

/** `GET /v1/settings/sim-providers`. */
export interface SimProviderSettingsResponse {
  hologram: {
    enabled: boolean;
    orgId: string;
    /** Returned only to users who also hold `settings.system:read`. */
    apiKey: string | null;
    apiKeyConfigured: boolean;
  };
  retentionDays: number;
  fetchDays: number;
  stationSignalEnabled: boolean;
  signalAlertBelowDbm: number | null;
  ocpp16SignalKeys: string[];
  signalGoodDbm: number;
  signalFairDbm: number;
}

interface TestConnectionResult {
  provider: string;
  deviceCount: number;
  otherOrganizations: Array<{ id: string; name: string; deviceCount: number }>;
}

/** An integer typed into a field, or null when the text is not one. */
function parseInteger(text: string): number | null {
  const value = text.trim();
  if (!/^-?\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function inRange(text: string, range: { min: number; max: number }): number | null {
  const n = parseInteger(text);
  return n != null && n >= range.min && n <= range.max ? n : null;
}

/** The settings mutation every card shares; it also reloads the station Connectivity tab state. */
function useSaveSimSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put('/v1/settings/sim-providers', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SIM_PROVIDER_SETTINGS_KEY });
      void queryClient.invalidateQueries({ queryKey: ['station-sim'] });
      // The SIM switches show or hide the station Connectivity tab through the feature flags.
      void queryClient.invalidateQueries({ queryKey: ['settings', 'features'] });
    },
  });
}

function SaveRow({
  dirty,
  isPending,
  isSuccess,
  error,
  children,
}: {
  dirty: boolean;
  isPending: boolean;
  isSuccess: boolean;
  error: unknown;
  children?: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {dirty && <p className="text-sm text-muted-foreground">{t('settings.unsavedChanges')}</p>}
        <SaveButton isPending={isPending} disabled={!dirty || isPending} />
        {children}
      </div>
      {isSuccess && !dirty && <p className="text-sm text-success">{t('settings.sim.saved')}</p>}
      {error != null && (
        <p className="text-sm text-destructive">
          {getErrorMessage(error, t, 'settings.sim.saveFailed')}
        </p>
      )}
    </>
  );
}

function HologramCard({
  data,
  canWrite,
}: {
  data: SimProviderSettingsResponse;
  canWrite: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const save = useSaveSimSettings();
  // The settings GET returns a stored key only to users who also hold this permission.
  const canReadSecrets = useHasPermission('settings.system:read');
  const test = useMutation({
    mutationFn: () =>
      api.post<TestConnectionResult>('/v1/settings/sim-providers/hologram/test', {}),
  });
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [removing, setRemoving] = useState(false);
  const loaded = {
    enabled: data.hologram.enabled,
    orgId: data.hologram.orgId,
    apiKey: data.hologram.apiKey ?? '',
  };
  const [form, setForm] = useLoadedValues(loaded, () => {
    setHasSubmitted(false);
    setRemoving(false);
  });
  const secret: StoredSecret = {
    value: data.hologram.apiKey,
    configured: data.hologram.apiKeyConfigured,
  };
  const dirty = JSON.stringify(form) !== JSON.stringify(loaded) || removing;

  function update(patch: Partial<typeof form>): void {
    setForm((current) => ({ ...current, ...patch }));
    save.reset();
    test.reset();
  }

  const errors: Record<string, string> = {};
  const orgId = form.orgId.trim();
  if (orgId !== '' && !isHologramOrgId(orgId)) {
    errors.orgId = t('settings.sim.hologramOrgIdInvalid');
  } else if (form.enabled && orgId === '') {
    errors.orgId = t('validation.required');
  }

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const hologram: Record<string, unknown> = { enabled: form.enabled, orgId };
    const apiKey = secretChange(form.apiKey, secret, removing);
    if (apiKey !== undefined) hologram.apiKey = apiKey;
    save.mutate(
      { hologram },
      {
        onSuccess: () => {
          // The reload returns the key only to users who may read secrets: match what it will hold.
          setRemoving(false);
          setForm((current) => ({
            ...current,
            orgId,
            apiKey: canReadSecrets && !removing ? current.apiKey.trim() : '',
          }));
        },
      },
    );
  }

  const others = (test.data?.otherOrganizations ?? []).filter((o) => o.deviceCount > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.sim.hologramTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit}
          noValidate
          className="space-y-4"
          data-testid="sim-hologram-form"
        >
          <p className="text-sm text-muted-foreground">{t('settings.sim.hologramDescription')}</p>
          <div className="flex items-center gap-3">
            <Toggle
              id="sim-hologram-enabled"
              checked={form.enabled}
              disabled={!canWrite}
              aria-label={t('settings.sim.hologramEnabled')}
              onCheckedChange={(checked) => {
                update({ enabled: checked });
              }}
            />
            <Label htmlFor="sim-hologram-enabled">{t('settings.sim.hologramEnabled')}</Label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="sim-hologram-org-id" className="leading-6">
                {t('settings.sim.hologramOrgId')}
              </Label>
              <Input
                id="sim-hologram-org-id"
                value={form.orgId}
                inputMode="numeric"
                autoComplete="off"
                disabled={!canWrite}
                className={hasSubmitted && errors.orgId != null ? 'border-destructive' : ''}
                onChange={(e) => {
                  update({ orgId: e.target.value });
                }}
              />
              {hasSubmitted && errors.orgId != null && (
                <p className="text-sm text-destructive">{errors.orgId}</p>
              )}
              <p className="text-xs text-muted-foreground">{t('settings.sim.hologramOrgIdHint')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sim-hologram-api-key" className="leading-6">
                {t('settings.sim.hologramApiKey')}
              </Label>
              <StoredSecretInput
                id="sim-hologram-api-key"
                value={form.apiKey}
                onChange={(value) => {
                  update({ apiKey: value });
                }}
                secret={secret}
                removing={removing}
                onRemovingChange={(value) => {
                  setRemoving(value);
                  save.reset();
                  test.reset();
                }}
                canWrite={canWrite}
                hint={t('settings.sim.hologramApiKeyHint')}
              />
            </div>
          </div>

          {canWrite && (
            <SaveRow
              dirty={dirty}
              isPending={save.isPending}
              isSuccess={save.isSuccess}
              error={save.error}
            >
              <Button
                type="button"
                variant="outline"
                className="relative"
                disabled={test.isPending || dirty || !data.hologram.enabled}
                onClick={() => {
                  test.mutate();
                }}
              >
                {test.isPending && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  </div>
                )}
                <span className={test.isPending ? 'invisible' : ''}>
                  {t('settings.sim.testConnection')}
                </span>
              </Button>
            </SaveRow>
          )}
          {canWrite && dirty && (
            <p className="text-xs text-muted-foreground">{t('settings.sim.testSaveFirst')}</p>
          )}
          {canWrite && !dirty && !data.hologram.enabled && (
            <p className="text-xs text-muted-foreground">{t('settings.sim.testEnableFirst')}</p>
          )}
          {test.isError && (
            <p className="text-sm text-destructive">
              {simErrorMessage(test.error, t, 'settings.sim.testFailed')}
            </p>
          )}
          {test.data != null && (
            <div className="space-y-2">
              <p className="text-sm text-success">
                {t('settings.sim.testSuccess', { count: test.data.deviceCount })}
              </p>
              {test.data.deviceCount === 0 && others.length > 0 && (
                <Alert variant="warning">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    <p>{t('settings.sim.testOtherOrganizations')}</p>
                    <ul className="mt-1 list-disc pl-5">
                      {others.map((o) => (
                        <li
                          key={o.id}
                        >{`${o.name} (${o.id}): ${formatNumber(o.deviceCount, 0)}`}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function SessionHistoryCard({
  data,
  canWrite,
}: {
  data: SimProviderSettingsResponse;
  canWrite: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const save = useSaveSimSettings();
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const loaded = {
    fetchDays: String(data.fetchDays),
    retentionDays: String(data.retentionDays),
  };
  const [form, setForm] = useLoadedValues(loaded, () => {
    setHasSubmitted(false);
  });
  const dirty = JSON.stringify(form) !== JSON.stringify(loaded);

  function update(patch: Partial<typeof form>): void {
    setForm((current) => ({ ...current, ...patch }));
    save.reset();
  }

  const fetchDays = inRange(form.fetchDays, SIM_FETCH_DAYS);
  const retentionDays = inRange(form.retentionDays, SIM_RETENTION_DAYS);
  const errors: Record<string, string> = {};
  if (fetchDays == null) {
    errors.fetchDays = t('settings.sim.rangeError', {
      min: SIM_FETCH_DAYS.min,
      max: SIM_FETCH_DAYS.max,
    });
  }
  if (retentionDays == null) {
    errors.retentionDays = t('settings.sim.rangeError', {
      min: SIM_RETENTION_DAYS.min,
      max: SIM_RETENTION_DAYS.max,
    });
  }

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (fetchDays == null || retentionDays == null) return;
    save.mutate({ fetchDays, retentionDays });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.sim.sessionHistoryTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit}
          noValidate
          className="space-y-4"
          data-testid="sim-history-form"
        >
          <Alert variant="info">
            <Info className="h-4 w-4" />
            <AlertDescription>{t('settings.sim.sessionHistoryNote')}</AlertDescription>
          </Alert>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="sim-fetch-days" className="leading-6">
                {t('settings.sim.fetchDays')}
              </Label>
              <Input
                id="sim-fetch-days"
                value={form.fetchDays}
                inputMode="numeric"
                disabled={!canWrite}
                className={hasSubmitted && errors.fetchDays != null ? 'border-destructive' : ''}
                onChange={(e) => {
                  update({ fetchDays: e.target.value });
                }}
              />
              {hasSubmitted && errors.fetchDays != null && (
                <p className="text-sm text-destructive">{errors.fetchDays}</p>
              )}
              <p className="text-xs text-muted-foreground">{t('settings.sim.fetchDaysHint')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sim-retention-days" className="leading-6">
                {t('settings.sim.retentionDays')}
              </Label>
              <Input
                id="sim-retention-days"
                value={form.retentionDays}
                inputMode="numeric"
                disabled={!canWrite}
                className={hasSubmitted && errors.retentionDays != null ? 'border-destructive' : ''}
                onChange={(e) => {
                  update({ retentionDays: e.target.value });
                }}
              />
              {hasSubmitted && errors.retentionDays != null && (
                <p className="text-sm text-destructive">{errors.retentionDays}</p>
              )}
              <p className="text-xs text-muted-foreground">{t('settings.sim.retentionDaysHint')}</p>
            </div>
          </div>
          {canWrite && (
            <SaveRow
              dirty={dirty}
              isPending={save.isPending}
              isSuccess={save.isSuccess}
              error={save.error}
            />
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function StationSignalCard({
  data,
  canWrite,
}: {
  data: SimProviderSettingsResponse;
  canWrite: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const save = useSaveSimSettings();
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const loaded = {
    enabled: data.stationSignalEnabled,
    alertBelowDbm: data.signalAlertBelowDbm == null ? '' : String(data.signalAlertBelowDbm),
    keys: data.ocpp16SignalKeys.join('\n'),
    goodDbm: String(data.signalGoodDbm),
    fairDbm: String(data.signalFairDbm),
  };
  const [form, setForm] = useLoadedValues(loaded, () => {
    setHasSubmitted(false);
  });
  const dirty = JSON.stringify(form) !== JSON.stringify(loaded);

  function update(patch: Partial<typeof form>): void {
    setForm((current) => ({ ...current, ...patch }));
    save.reset();
  }

  const dbmError = t('settings.sim.rangeError', {
    min: SIM_SIGNAL_DBM.min,
    max: SIM_SIGNAL_DBM.max,
  });
  const alertBelowDbm =
    form.alertBelowDbm.trim() === '' ? null : inRange(form.alertBelowDbm, SIM_SIGNAL_DBM);
  const goodDbm = inRange(form.goodDbm, SIM_SIGNAL_DBM);
  const fairDbm = inRange(form.fairDbm, SIM_SIGNAL_DBM);
  const keys = parseOcpp16SignalKeys(form.keys.split('\n'));
  const errors: Record<string, string> = {};
  if (form.alertBelowDbm.trim() !== '' && alertBelowDbm == null) errors.alertBelowDbm = dbmError;
  if (goodDbm == null) errors.goodDbm = dbmError;
  if (fairDbm == null) errors.fairDbm = dbmError;
  if (goodDbm != null && fairDbm != null && goodDbm <= fairDbm) {
    errors.goodDbm = t('settings.sim.signalOrderError');
  }
  if (keys == null) {
    errors.keys = t('settings.sim.ocpp16SignalKeysError', {
      maxKeys: SIM_OCPP16_SIGNAL_KEYS_LIMITS.maxKeys,
      maxLength: SIM_OCPP16_SIGNAL_KEYS_LIMITS.maxLength,
    });
  }

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    save.mutate({
      stationSignalEnabled: form.enabled,
      signalAlertBelowDbm: alertBelowDbm,
      ocpp16SignalKeys: keys,
      signalGoodDbm: goodDbm,
      signalFairDbm: fairDbm,
    });
  }

  function field(
    id: string,
    name: 'alertBelowDbm' | 'goodDbm' | 'fairDbm',
    label: string,
    hint: string,
  ): React.JSX.Element {
    const error = hasSubmitted ? errors[name] : undefined;
    return (
      <div className="space-y-2">
        <Label htmlFor={id} className="leading-6">
          {label}
        </Label>
        <Input
          id={id}
          value={form[name]}
          inputMode="numeric"
          disabled={!canWrite}
          className={error != null ? 'border-destructive' : ''}
          onChange={(e) => {
            update({ [name]: e.target.value });
          }}
        />
        {error != null && <p className="text-sm text-destructive">{error}</p>}
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.sim.stationSignalTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit}
          noValidate
          className="space-y-4"
          data-testid="sim-signal-form"
        >
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <Toggle
                id="sim-station-signal-enabled"
                checked={form.enabled}
                disabled={!canWrite}
                aria-label={t('settings.sim.stationSignalEnabled')}
                onCheckedChange={(checked) => {
                  update({ enabled: checked });
                }}
              />
              <Label htmlFor="sim-station-signal-enabled">
                {t('settings.sim.stationSignalEnabled')}
              </Label>
            </div>
            <p className="text-xs text-muted-foreground">{t('settings.sim.stationSignalHint')}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {field(
              'sim-signal-alert-below',
              'alertBelowDbm',
              t('settings.sim.signalAlertBelowDbm'),
              t('settings.sim.signalAlertBelowDbmHint'),
            )}
            <div className="space-y-2">
              <Label htmlFor="sim-ocpp16-signal-keys" className="leading-6">
                {t('settings.sim.ocpp16SignalKeys')}
              </Label>
              <Textarea
                id="sim-ocpp16-signal-keys"
                value={form.keys}
                rows={3}
                disabled={!canWrite}
                className={hasSubmitted && errors.keys != null ? 'border-destructive' : ''}
                onChange={(e) => {
                  update({ keys: e.target.value });
                }}
              />
              {hasSubmitted && errors.keys != null && (
                <p className="text-sm text-destructive">{errors.keys}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {t('settings.sim.ocpp16SignalKeysHint')}
              </p>
            </div>
            {field(
              'sim-signal-good',
              'goodDbm',
              t('settings.sim.signalGoodDbm'),
              t('settings.sim.signalGoodDbmHint'),
            )}
            {field(
              'sim-signal-fair',
              'fairDbm',
              t('settings.sim.signalFairDbm'),
              t('settings.sim.signalFairDbmHint'),
            )}
          </div>
          {canWrite && (
            <SaveRow
              dirty={dirty}
              isPending={save.isPending}
              isSuccess={save.isSuccess}
              error={save.error}
            />
          )}
        </form>
      </CardContent>
    </Card>
  );
}

/** Settings > Integrations > SIM Providers: one card per provider, the session history and the station signal. */
export function SimProvidersSettings(): React.JSX.Element {
  const { t } = useTranslation();
  const allSites = useHasAllSiteAccess();
  const canWrite = useHasCompanyWidePermission('settings.integrations:write');
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: SIM_PROVIDER_SETTINGS_KEY,
    queryFn: () => api.get<SimProviderSettingsResponse>('/v1/settings/sim-providers'),
    enabled: allSites,
    staleTime: 30_000,
  });

  if (!allSites) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-center text-sm text-muted-foreground">
            {t('settings.sim.allSitesOnly')}
          </p>
        </CardContent>
      </Card>
    );
  }
  if (isLoading) return <LoadingLogo size="inline" />;
  if (isError || data == null) {
    return (
      <div className="space-y-2 text-center">
        <p className="text-sm text-destructive">{t('common.loadError')}</p>
        <Button
          variant="outline"
          onClick={() => {
            void refetch();
          }}
        >
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t('settings.sim.description')}</p>
      <HologramCard data={data} canWrite={canWrite} />
      <SessionHistoryCard data={data} canWrite={canWrite} />
      <StationSignalCard data={data} canWrite={canWrite} />
    </div>
  );
}
