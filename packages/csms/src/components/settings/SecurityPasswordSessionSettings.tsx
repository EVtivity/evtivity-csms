// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import type { PasswordPolicy } from '@evtivity/lib/password-policy';
import type { SessionLifetimes } from '@evtivity/lib/session-lifetimes';
import {
  PASSWORD_MIN_LENGTH_CEILING,
  PASSWORD_MIN_LENGTH_FLOOR,
  normalizePasswordPolicy,
} from '@evtivity/lib/password-policy';
import {
  SESSION_LIFETIME_LIMITS,
  normalizeSessionLifetimes,
} from '@evtivity/lib/session-lifetimes';
import { SaveButton } from '@/components/save-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { useLoadedValues } from '@/hooks/use-loaded-values';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

interface CardProps {
  settings: Record<string, unknown> | undefined;
  canWrite: boolean;
}

interface Props extends CardProps {
  loadFailed?: boolean;
  onRetry?: () => void;
}

type RequireRule = 'requireUppercase' | 'requireLowercase' | 'requireNumber' | 'requireSymbol';
const REQUIRE_RULES: readonly RequireRule[] = [
  'requireUppercase',
  'requireLowercase',
  'requireNumber',
  'requireSymbol',
];

type LifetimeField = keyof SessionLifetimes;
const LIFETIME_FIELDS: readonly { field: LifetimeField; unit: 'minutes' | 'days' }[] = [
  { field: 'operatorAccessMinutes', unit: 'minutes' },
  { field: 'operatorRefreshDays', unit: 'days' },
  { field: 'driverAccessMinutes', unit: 'minutes' },
  { field: 'driverRefreshDays', unit: 'days' },
];

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** An empty number input is NaN, so validation reports it as required. */
function parseNumber(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text);
}

function rangeError(value: number, min: number, max: number, t: TFunction): string | undefined {
  if (Number.isNaN(value)) return t('validation.required');
  if (!Number.isInteger(value)) return t('validation.invalidNumber');
  if (value < min) return t('validation.min', { min });
  if (value > max) return t('validation.max', { max });
  return undefined;
}

/** The values to compare edits with: the last saved values until the next load replaces them. */
function useSavedBaseline<T>(loaded: T): [T, (saved: T) => void] {
  const [saved, setSaved] = useState<{ loadedKey: string; value: T } | null>(null);
  const loadedKey = JSON.stringify(loaded);
  const baseline = saved != null && saved.loadedKey === loadedKey ? saved.value : loaded;
  return [
    baseline,
    (value: T) => {
      setSaved({ loadedKey, value });
    },
  ];
}

function useSecuritySave<T>(path: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: T) => api.put<{ success: boolean }>(path, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['security-settings'] });
      // Open password forms and their rule checklists read the public policy.
      void queryClient.invalidateQueries({ queryKey: ['security-public'] });
    },
  });
}

function PasswordPolicyCard({ settings, canWrite }: CardProps): React.JSX.Element {
  const { t } = useTranslation();
  const loaded = useMemo(
    () => normalizePasswordPolicy(asRecord(settings?.['passwordPolicy'])),
    [settings],
  );
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [values, setValues] = useLoadedValues<PasswordPolicy>(loaded, () => {
    setHasSubmitted(false);
  });
  const mutation = useSecuritySave<PasswordPolicy>('/v1/security/password-policy');

  const [baseline, markSaved] = useSavedBaseline(loaded);
  const hasUnsavedChanges = JSON.stringify(values) !== JSON.stringify(baseline);

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    const minLength = rangeError(
      values.minLength,
      PASSWORD_MIN_LENGTH_FLOOR,
      PASSWORD_MIN_LENGTH_CEILING,
      t,
    );
    if (minLength != null) errors['minLength'] = minLength;
    return errors;
  }
  const errors = getValidationErrors();

  function markChanged(next: Partial<PasswordPolicy>): void {
    setValues((prev) => ({ ...prev, ...next }));
    mutation.reset();
  }

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    mutation.mutate(values, {
      onSuccess: () => {
        setHasSubmitted(false);
        markSaved(values);
      },
    });
  }

  const minLengthError = hasSubmitted ? errors['minLength'] : undefined;

  return (
    <Card data-testid="password-policy-card">
      <CardHeader>
        <CardTitle>{t('settings.passwordSessions.passwordsTitle')}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {t('settings.passwordSessions.passwordsNote')}
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="password-min-length">{t('settings.passwordSessions.minLength')}</Label>
            <Input
              id="password-min-length"
              type="number"
              inputMode="numeric"
              disabled={!canWrite}
              value={Number.isNaN(values.minLength) ? '' : String(values.minLength)}
              onChange={(e) => {
                markChanged({ minLength: parseNumber(e.target.value) });
              }}
              aria-invalid={minLengthError != null}
              aria-describedby="password-min-length-hint"
              className={minLengthError != null ? 'border-destructive' : ''}
            />
            <p id="password-min-length-hint" className="text-xs text-muted-foreground">
              {t('settings.passwordSessions.minLengthHint', {
                min: PASSWORD_MIN_LENGTH_FLOOR,
                max: PASSWORD_MIN_LENGTH_CEILING,
              })}
            </p>
            {minLengthError != null && <p className="text-sm text-destructive">{minLengthError}</p>}
          </div>

          {REQUIRE_RULES.map((rule) => (
            <div
              key={rule}
              className="flex items-center justify-between gap-4 rounded-lg border p-4"
            >
              <div className="space-y-0.5">
                <Label htmlFor={`password-${rule}`} className="leading-6">
                  {t(`settings.passwordSessions.${rule}`)}
                </Label>
                {rule === 'requireSymbol' && (
                  <p className="text-xs text-muted-foreground">
                    {t('settings.passwordSessions.requireSymbolHint')}
                  </p>
                )}
              </div>
              <Toggle
                id={`password-${rule}`}
                aria-label={t(`settings.passwordSessions.${rule}`)}
                size="lg"
                disabled={!canWrite}
                checked={values[rule]}
                onCheckedChange={(checked) => {
                  markChanged({ [rule]: checked });
                }}
              />
            </div>
          ))}

          {mutation.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(mutation.error, t, 'settings.passwordSessions.saveFailed')}
            </p>
          )}
          {canWrite && (
            <div className="flex items-center justify-end gap-4">
              {mutation.isSuccess && !hasUnsavedChanges && (
                <p className="text-sm text-success">{t('common.saved')}</p>
              )}
              {hasUnsavedChanges && (
                <p className="text-sm text-muted-foreground">{t('settings.unsavedChanges')}</p>
              )}
              <SaveButton
                isPending={mutation.isPending}
                disabled={mutation.isPending || settings == null || !hasUnsavedChanges}
              />
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function SessionLifetimesCard({ settings, canWrite }: CardProps): React.JSX.Element {
  const { t } = useTranslation();
  const loaded = useMemo(
    () => normalizeSessionLifetimes(asRecord(settings?.['sessionLifetimes'])),
    [settings],
  );
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [values, setValues] = useLoadedValues<SessionLifetimes>(loaded, () => {
    setHasSubmitted(false);
  });
  const mutation = useSecuritySave<SessionLifetimes>('/v1/security/sessions');

  const [baseline, markSaved] = useSavedBaseline(loaded);
  const hasUnsavedChanges = JSON.stringify(values) !== JSON.stringify(baseline);

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    for (const { field } of LIFETIME_FIELDS) {
      const { min, max } = SESSION_LIFETIME_LIMITS[field];
      const error = rangeError(values[field], min, max, t);
      if (error != null) errors[field] = error;
    }
    return errors;
  }
  const errors = getValidationErrors();

  function markChanged(field: LifetimeField, value: number): void {
    setValues((prev) => ({ ...prev, [field]: value }));
    mutation.reset();
  }

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    mutation.mutate(values, {
      onSuccess: () => {
        setHasSubmitted(false);
        markSaved(values);
      },
    });
  }

  return (
    <Card data-testid="session-lifetimes-card">
      <CardHeader>
        <CardTitle>{t('settings.passwordSessions.sessionsTitle')}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {t('settings.passwordSessions.sessionsNote')}
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {LIFETIME_FIELDS.map(({ field, unit }) => {
              const { min, max } = SESSION_LIFETIME_LIMITS[field];
              const id = `session-${field}`;
              const error = hasSubmitted ? errors[field] : undefined;
              return (
                <div key={field} className="space-y-2">
                  <Label htmlFor={id}>{t(`settings.passwordSessions.${field}`)}</Label>
                  <Input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    disabled={!canWrite}
                    value={Number.isNaN(values[field]) ? '' : String(values[field])}
                    onChange={(e) => {
                      markChanged(field, parseNumber(e.target.value));
                    }}
                    aria-invalid={error != null}
                    aria-describedby={`${id}-hint`}
                    className={error != null ? 'border-destructive' : ''}
                  />
                  <p id={`${id}-hint`} className="text-xs text-muted-foreground">
                    {unit === 'minutes'
                      ? t('settings.passwordSessions.accessHint', { min, max })
                      : t('settings.passwordSessions.refreshHint', { min, max })}
                  </p>
                  {error != null && <p className="text-sm text-destructive">{error}</p>}
                </div>
              );
            })}
          </div>

          {mutation.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(mutation.error, t, 'settings.passwordSessions.saveFailed')}
            </p>
          )}
          {canWrite && (
            <div className="flex items-center justify-end gap-4">
              {mutation.isSuccess && !hasUnsavedChanges && (
                <p className="text-sm text-success">{t('common.saved')}</p>
              )}
              {hasUnsavedChanges && (
                <p className="text-sm text-muted-foreground">{t('settings.unsavedChanges')}</p>
              )}
              <SaveButton
                isPending={mutation.isPending}
                disabled={mutation.isPending || settings == null || !hasUnsavedChanges}
              />
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

export function SecurityPasswordSessionSettings({
  settings,
  canWrite,
  loadFailed = false,
  onRetry,
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t('settings.passwordSessions.description')}</p>
      {loadFailed && settings == null ? (
        <Card data-testid="password-session-load-error">
          <CardContent className="flex flex-col items-center gap-3 pt-6">
            <p className="text-center text-sm text-destructive">{t('common.loadError')}</p>
            {onRetry != null && (
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                {t('common.retry')}
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <PasswordPolicyCard settings={settings} canWrite={canWrite} />
          <SessionLifetimesCard settings={settings} canWrite={canWrite} />
        </>
      )}
    </div>
  );
}
