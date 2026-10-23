// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import {
  DATA_RETENTION_GROUPS,
  DATA_RETENTION_KEYS,
  DATA_RETENTION_SETTINGS,
  shortensSecurityHistory,
  type DataRetentionDefinition,
  type DataRetentionGroup,
  type DataRetentionSettingKey,
} from '@evtivity/lib/data-retention';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SaveButton } from '@/components/save-button';
import {
  FactorProofField,
  proofRejection,
  type FactorProof,
  type ProofRejection,
} from '@/components/FactorProofField';
import { useMfaStatus } from '@/components/profile/mfa-status';
import { LoadingLogo } from '@/components/loading-logo';
import { useLoadedValues, useSavedBaseline } from '@/hooks/use-loaded-values';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { formatNumber } from '@/lib/formatting';

export const DATA_RETENTION_QUERY_KEY = ['data-retention-settings'] as const;
export const DATA_RETENTION_TAB_PATH = '/settings?tab=dataRetention';

type RetentionValues = Record<DataRetentionSettingKey, number>;
type FormValues = Record<DataRetentionSettingKey, string>;

/** The i18n id of each setting: i18next keys cannot hold the dots of the setting names. */
const ROW_IDS = {
  'logs.ocppMessage.retentionDays': 'ocppMessage',
  'logs.meterValues.retentionDays': 'meterValues',
  'logs.domainEvents.retentionDays': 'domainEvents',
  'logs.access.retentionDays': 'access',
  'logs.workerJob.retentionDays': 'workerJob',
  'logs.portStatus.retentionDays': 'portStatus',
  'logs.connection.retentionDays': 'connection',
  'logs.notifications.retentionDays': 'notifications',
  'logs.loadAllocation.retentionDays': 'loadAllocation',
  'audit.retentionDays': 'audit',
  'logs.loginAudit.retentionDays': 'loginAudit',
  'logs.securityEvents.retentionDays': 'securityEvents',
  'refreshTokens.retentionDays': 'refreshTokens',
  'ai.conversationRetentionDays': 'aiConversations',
  'aiInsights.retentionDays': 'aiInsights',
  'sim.sessions.retentionDays': 'simSessions',
} as const satisfies Record<DataRetentionSettingKey, string>;

/** One line under a moved input: retention is set in Settings > Data Retention. */
export function DataRetentionLink(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <p className="text-sm text-muted-foreground" data-testid="data-retention-link">
      {t('settings.dataRetention.movedNote')}{' '}
      <Link to={DATA_RETENTION_TAB_PATH} className="text-link hover:underline">
        {t('settings.dataRetention.movedLink')}
      </Link>
    </p>
  );
}

function toForm(values: RetentionValues): FormValues {
  return Object.fromEntries(
    DATA_RETENTION_KEYS.map((key) => [key, String(values[key])]),
  ) as FormValues;
}

function rangeError(key: DataRetentionSettingKey, text: string, t: TFunction): string | undefined {
  const { min, max, keptMin }: DataRetentionDefinition = DATA_RETENTION_SETTINGS[key];
  if (text.trim() === '') return t('validation.required');
  const n = Number(text);
  if (!Number.isInteger(n)) return t('validation.invalidNumber');
  if (n < min) return t('validation.min', { min });
  if (n > max) return t('validation.max', { max });
  // The security history: 0 keeps it forever, else at least 30 days.
  if (keptMin != null && n !== 0 && n < keptMin) return t('validation.min', { min: keptMin });
  return undefined;
}

function RetentionGroupCard({
  group,
  values,
  errors,
  canWrite,
  onChange,
}: {
  group: DataRetentionGroup;
  values: FormValues;
  errors: Partial<Record<DataRetentionSettingKey, string>>;
  canWrite: boolean;
  onChange: (key: DataRetentionSettingKey, text: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const keys = DATA_RETENTION_KEYS.filter((key) => DATA_RETENTION_SETTINGS[key].group === group);
  return (
    <Card data-testid={`data-retention-${group}`}>
      <CardHeader>
        <CardTitle>{t(`settings.dataRetention.groups.${group}`)}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {keys.map((key) => {
            const def: DataRetentionDefinition = DATA_RETENTION_SETTINGS[key];
            const rowId = ROW_IDS[key];
            const id = `data-retention-${rowId}`;
            const error = errors[key];
            return (
              <div key={key} className="space-y-2">
                <Label htmlFor={id} className="leading-6">
                  {t(`settings.dataRetention.rows.${rowId}.label`)}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t(`settings.dataRetention.rows.${rowId}.description`)}
                </p>
                <Input
                  id={id}
                  type="number"
                  inputMode="numeric"
                  min={def.min}
                  max={def.max}
                  step={1}
                  disabled={!canWrite}
                  value={values[key]}
                  onChange={(e) => {
                    onChange(key, e.target.value);
                  }}
                  aria-invalid={error != null}
                  aria-describedby={`${id}-hint`}
                  className={error != null ? 'border-destructive' : ''}
                />
                <p id={`${id}-hint`} className="text-xs text-muted-foreground">
                  {t('settings.dataRetention.range', {
                    min: formatNumber(def.keptMin ?? def.min, 0),
                    max: formatNumber(def.max, 0),
                    default: formatNumber(def.defaultDays, 0),
                  })}
                  {def.keepForever && ` ${t('settings.dataRetention.keepForever')}`}
                </p>
                {error != null && <p className="text-sm text-destructive">{error}</p>}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function DataRetentionForm({
  data,
  canWrite,
}: {
  data: RetentionValues;
  canWrite: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const loaded = toForm(data);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [values, setValues] = useLoadedValues<FormValues>(loaded, () => {
    setHasSubmitted(false);
  });
  const [baseline, markSaved] = useSavedBaseline(loaded);
  const changedKeys = DATA_RETENTION_KEYS.filter((key) => values[key] !== baseline[key]);

  // Shortening the audit, sign-in or security event history takes a fresh proof.
  const { data: mfaStatus } = useMfaStatus();
  const proofKinds = mfaStatus?.factorProofKinds ?? [];
  const [proof, setProof] = useState<FactorProof | null>(null);
  const [proofFailure, setProofFailure] = useState<ProofRejection | null>(null);
  const [proofAsked, setProofAsked] = useState(false);
  const [proofRound, setProofRound] = useState(0);
  const needsProof =
    proofKinds.length > 0 &&
    changedKeys.some((key) =>
      shortensSecurityHistory(key, Number(baseline[key]), Number(values[key])),
    );

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.put<RetentionValues>('/v1/settings/data-retention', body),
    onError: (err: unknown) => {
      setProofFailure(proofRejection(err));
    },
    onSuccess: () => {
      setProof(null);
      setProofAsked(false);
      setProofFailure(null);
      setProofRound((n) => n + 1);
      void queryClient.invalidateQueries({ queryKey: DATA_RETENTION_QUERY_KEY });
      // The SIM pages and the station Connectivity tab bound their periods by the SIM retention.
      void queryClient.invalidateQueries({ queryKey: ['sim-provider-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['station-sim'] });
      void queryClient.invalidateQueries({ queryKey: ['sims'] });
    },
  });

  // Only changed values are checked: a stored value outside the range (written
  // before the range existed) never blocks saving another setting.
  const errors: Partial<Record<DataRetentionSettingKey, string>> = {};
  for (const key of changedKeys) {
    const error = rangeError(key, values[key], t);
    if (error != null) errors[key] = error;
  }
  const shownErrors = hasSubmitted ? errors : {};

  function handleChange(key: DataRetentionSettingKey, text: string): void {
    setValues((prev) => ({ ...prev, [key]: text }));
    mutation.reset();
  }

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0 || changedKeys.length === 0) return;
    if (needsProof && proof == null) {
      setProofAsked(true);
      return;
    }
    const body: Record<string, unknown> = Object.fromEntries(
      changedKeys.map((key) => [key, Number(values[key])]),
    );
    if (needsProof && proof != null) body['proof'] = proof;
    mutation.mutate(body, {
      onSuccess: () => {
        setHasSubmitted(false);
        markSaved(values);
      },
    });
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      {DATA_RETENTION_GROUPS.map((group) => (
        <RetentionGroupCard
          key={group}
          group={group}
          values={values}
          errors={shownErrors}
          canWrite={canWrite}
          onChange={handleChange}
        />
      ))}
      {canWrite && needsProof && (
        <FactorProofField
          key={`retention-${String(proofRound)}`}
          idPrefix="retention-proof"
          kinds={proofKinds}
          codeMethod={mfaStatus?.mfaMethod ?? null}
          description={t('settings.dataRetention.proofHint')}
          onChange={setProof}
          rejection={proofFailure}
          showMissing={proofAsked}
        />
      )}
      {mutation.isError && (
        <p className="text-sm text-destructive">
          {getErrorMessage(mutation.error, t, 'settings.dataRetention.saveFailed')}
        </p>
      )}
      {canWrite && (
        <div className="flex items-center justify-end gap-4">
          {mutation.isSuccess && changedKeys.length === 0 && (
            <p className="text-sm text-success">{t('common.saved')}</p>
          )}
          {changedKeys.length > 0 && (
            <p className="text-sm text-muted-foreground">{t('settings.unsavedChanges')}</p>
          )}
          <SaveButton
            isPending={mutation.isPending}
            disabled={mutation.isPending || changedKeys.length === 0}
          />
        </div>
      )}
    </form>
  );
}

/** Settings > Data Retention: how many days each kind of stored data is kept. */
export function DataRetentionSettings({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: DATA_RETENTION_QUERY_KEY,
    queryFn: () => api.get<RetentionValues>('/v1/settings/data-retention'),
    staleTime: 60_000,
  });

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t('settings.dataRetention.description')}</p>
      <Alert variant="warning" data-testid="data-retention-storage-warning">
        <AlertTriangle className="h-4 w-4" />
        <div>
          <AlertTitle>{t('settings.dataRetention.storageTitle')}</AlertTitle>
          <AlertDescription>{t('settings.dataRetention.storageNote')}</AlertDescription>
        </div>
      </Alert>
      {isLoading ? (
        <LoadingLogo size="inline" />
      ) : isError || data == null ? (
        <Card data-testid="data-retention-load-error">
          <CardContent className="flex flex-col items-center gap-3 pt-6">
            <p className="text-center text-sm text-destructive">{t('common.loadError')}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <DataRetentionForm data={data} canWrite={canWrite} />
      )}
    </div>
  );
}
