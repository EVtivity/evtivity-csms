// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AI_DRIVER_NUMBER_SETTINGS,
  DEFAULT_DRIVER_AI_EFFORT,
  aiProviderApiKeySettingKey,
  isAiProviderId,
  parseAiLimitValue,
} from '@evtivity/lib/ai-config';
import type { AiDriverNumberSettingKey } from '@evtivity/lib/ai-config';
import { DRIVER_AI_SETTING_KEYS } from '@evtivity/lib/driver-ai';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { AiEffortSelect, AiProviderSelect } from '@/components/ai/AiConfigFields';
import { AiModelField } from '@/components/ai/AiModelField';
import { AiSystemPromptField } from '@/components/ai/AiSystemPromptField';
import { AI_STATUS_KEY } from '@/components/ai/use-ai-status';
import { isCustomModel, isDefaultPrompt, useAiDefaults } from '@/components/ai/use-ai-defaults';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatNumber } from '@/lib/formatting';
import { AiAdvancedOptions, AiPromptSummary } from '../AiAdvancedOptions';
import { useSaveKeys } from '../ai-settings-save';
import type { Values } from '../ai-settings-save';

const K = DRIVER_AI_SETTING_KEYS;
const SURFACE_KEYS = [K.provider, K.model, K.effort, K.systemPrompt];
const LIMIT_KEYS = Object.keys(AI_DRIVER_NUMBER_SETTINGS) as AiDriverNumberSettingKey[];

type DriverLimitLabelKey =
  | 'settings.aiDriverSettings.maxCasesPerDriverPerDay'
  | 'settings.aiDriverSettings.feedbackTimeoutHours'
  | 'settings.aiDriverSettings.driverDailyTokens'
  | 'settings.aiDriverSettings.driverPerMinute';

const LIMIT_LABELS: Record<AiDriverNumberSettingKey, DriverLimitLabelKey> = {
  [K.maxCasesPerDriverPerDay]: 'settings.aiDriverSettings.maxCasesPerDriverPerDay',
  [K.feedbackTimeoutHours]: 'settings.aiDriverSettings.feedbackTimeoutHours',
  [K.driverDailyTokens]: 'settings.aiDriverSettings.driverDailyTokens',
  [K.driverPerMinute]: 'settings.aiDriverSettings.driverPerMinute',
};

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

export function loadDriverAiValues(settings: Record<string, unknown> | undefined): Values {
  const out: Values = {};
  for (const key of SURFACE_KEYS) out[key] = asString(settings?.[key]);
  if (out[K.effort] === '') out[K.effort] = DEFAULT_DRIVER_AI_EFFORT;
  for (const key of LIMIT_KEYS) {
    const stored = parseAiLimitValue(key, settings?.[key]);
    out[key] = String(stored ?? AI_DRIVER_NUMBER_SETTINGS[key].defaultValue);
  }
  return out;
}

interface DriverAiSettingsProps {
  settings: Record<string, unknown> | undefined;
}

/**
 * Settings > AI > Driver support (plan v0.1.45, 2.12): the `driverAi.*`
 * surface (switch, provider, model, effort, prompt override) with the data
 * warning, and the per-driver limits. Off by default; the portal and the app
 * offer the AI analysis only while it is on and the provider has a key.
 */
export function DriverAiSettings({ settings }: DriverAiSettingsProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('settings.ai:write');
  const aiDefaults = useAiDefaults('settings');
  const loaded = useMemo(() => loadDriverAiValues(settings), [settings]);
  const [values, setValues] = useState<Values>(loaded);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setValues(loaded);
    setEnabled(settings?.[K.enabled] === true);
  }, [loaded, settings]);

  const set = (key: string) => (value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  // An unchanged built-in prompt is saved empty, so later defaults still apply.
  const saveSurface = useSaveKeys(SURFACE_KEYS, loaded, (key, v) =>
    key === K.systemPrompt && isDefaultPrompt(v, aiDefaults?.driver) ? '' : v,
  );
  const saveLimits = useSaveKeys(LIMIT_KEYS, loaded, (key, v) =>
    parseAiLimitValue(key as AiDriverNumberSettingKey, v),
  );

  const toggle = useMutation({
    mutationFn: (next: boolean) => api.put(`/v1/settings/${K.enabled}`, { value: next }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: AI_STATUS_KEY });
    },
  });
  const resetPrompt = useMutation({
    mutationFn: () => api.put(`/v1/settings/${K.systemPrompt}`, { value: '' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const provider = values[K.provider] ?? '';
  const providerHasKey =
    provider === '' ||
    !isAiProviderId(provider) ||
    asString(settings?.[aiProviderApiKeySettingKey(provider)]) !== '';
  const invalidLimits = LIMIT_KEYS.filter((k) => parseAiLimitValue(k, values[k]) == null);

  function status(m: { isSuccess: boolean; isError: boolean; error: unknown }): React.ReactNode {
    if (m.isError) {
      return (
        <p className="text-sm text-destructive">
          {getErrorMessage(m.error, t, 'settings.aiSaveFailed')}
        </p>
      );
    }
    if (m.isSuccess) return <p className="text-sm text-success">{t('settings.aiSaved')}</p>;
    return null;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.aiSurface.driver.title')}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {t('settings.aiSurface.driver.description')}
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
            <Label htmlFor="driverAi-enabled" className="leading-6">
              {t('settings.aiSurface.driver.enabled')}
            </Label>
            <Toggle
              id="driverAi-enabled"
              checked={enabled}
              disabled={!canWrite || toggle.isPending}
              onCheckedChange={(checked) => {
                setEnabled(checked);
                toggle.mutate(checked);
              }}
            />
          </div>
          {toggle.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(toggle.error, t, 'settings.aiSaveFailed')}
            </p>
          )}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="driverAi-provider" className="leading-6">
                {t('settings.aiProvider')}
              </Label>
              <AiProviderSelect
                id="driverAi-provider"
                allowNone
                disabled={!canWrite}
                value={provider}
                onChange={(next) => {
                  // A listed model belongs to the old provider: back to the default.
                  if (!isCustomModel(aiDefaults, provider, values[K.model] ?? '')) {
                    set(K.model)('');
                  }
                  set(K.provider)(next);
                }}
              />
              {!providerHasKey && (
                <p className="text-xs text-warning">{t('settings.aiProviderNoKey')}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="driverAi-model" className="leading-6">
                {t('settings.aiModel')}
              </Label>
              <AiModelField
                key={provider}
                id="driverAi-model"
                provider={provider}
                defaults={aiDefaults}
                disabled={!canWrite}
                value={values[K.model] ?? ''}
                onChange={set(K.model)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="driverAi-effort" className="leading-6">
                {t('settings.aiEffort')}
              </Label>
              <AiEffortSelect
                id="driverAi-effort"
                disabled={!canWrite}
                value={values[K.effort] ?? DEFAULT_DRIVER_AI_EFFORT}
                onChange={set(K.effort)}
              />
              <p className="text-xs text-muted-foreground">{t('settings.aiEffortHint')}</p>
            </div>
          </div>
          <AiAdvancedOptions
            summary={<AiPromptSummary custom={(values[K.systemPrompt] ?? '') !== ''} />}
            data-testid="driverAi-advanced"
          >
            <AiSystemPromptField
              id="driverAi-system-prompt"
              defaults={aiDefaults?.driver}
              disabled={!canWrite}
              value={values[K.systemPrompt] ?? ''}
              savedValue={loaded[K.systemPrompt] ?? ''}
              onChange={set(K.systemPrompt)}
              resetPending={resetPrompt.isPending}
              onReset={() => {
                resetPrompt.mutate();
              }}
            />
          </AiAdvancedOptions>
          {resetPrompt.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(resetPrompt.error, t, 'settings.aiSaveFailed')}
            </p>
          )}
          {canWrite && (
            <div className="flex items-center justify-end gap-4">
              {status(saveSurface)}
              <SaveButton
                isPending={saveSurface.isPending}
                onClick={() => {
                  saveSurface.mutate(values);
                }}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.aiDriverSettings.title')}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {t('settings.aiDriverSettings.overLimitHelp')}
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {LIMIT_KEYS.map((key) => {
              const { min, max } = AI_DRIVER_NUMBER_SETTINGS[key];
              const invalid = invalidLimits.includes(key);
              const id = `ai-driver-${key.replace(/\./g, '-')}`;
              return (
                <div key={key} className="space-y-2">
                  <Label htmlFor={id} className="leading-6">
                    {t(LIMIT_LABELS[key])}
                  </Label>
                  <Input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    min={min}
                    max={max}
                    step={1}
                    disabled={!canWrite}
                    aria-invalid={invalid}
                    className={invalid ? 'border-destructive' : undefined}
                    value={values[key] ?? ''}
                    onChange={(e) => {
                      set(key)(e.target.value);
                    }}
                  />
                  <p
                    className={
                      invalid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'
                    }
                  >
                    {t('settings.aiLimitRange', {
                      min: formatNumber(min, 0),
                      max: formatNumber(max, 0),
                    })}
                    {key === K.driverDailyTokens && ` ${t('settings.aiLimitZeroNoLimit')}`}
                    {key === K.feedbackTimeoutHours &&
                      ` ${t('settings.aiDriverSettings.feedbackTimeoutHelp')}`}
                  </p>
                </div>
              );
            })}
          </div>
          {canWrite && (
            <div className="flex items-center justify-end gap-4">
              {status(saveLimits)}
              <SaveButton
                isPending={saveLimits.isPending}
                disabled={invalidLimits.length > 0}
                onClick={() => {
                  saveLimits.mutate(values);
                }}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
