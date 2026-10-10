// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import {
  AI_LIMIT_SETTINGS,
  AI_PROVIDER_IDS,
  aiProviderApiKeySettingKey,
  aiProviderBaseUrlSettingKey,
  parseAiLimitValue,
} from '@evtivity/lib/ai-config';
import type { AiLimitSettingKey } from '@evtivity/lib/ai-config';
import { SaveButton } from '@/components/save-button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { Toggle } from '@/components/ui/toggle';
import {
  AiProviderSelect,
  AiEffortSelect,
  AiToneSelect,
  PROVIDER_LABELS,
} from '@/components/ai/AiConfigFields';
import { AI_STATUS_KEY } from '@/components/ai/use-ai-status';
import { AiModelField } from '@/components/ai/AiModelField';
import { AiSystemPromptField } from '@/components/ai/AiSystemPromptField';
import { isCustomModel, isDefaultPrompt, useAiDefaults } from '@/components/ai/use-ai-defaults';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatNumber } from '@/lib/formatting';

type Values = Record<string, string>;

const LIMIT_KEYS = Object.keys(AI_LIMIT_SETTINGS) as AiLimitSettingKey[];

type LimitLabelKey =
  | 'settings.aiLimits.userPerMinute'
  | 'settings.aiLimits.sitePerMinute'
  | 'settings.aiLimits.userDailyTokens'
  | 'settings.aiLimits.maxToolCallsPerTurn'
  | 'settings.aiLimits.conversationRetentionDays'
  | 'settings.aiLimits.attachmentsMaxBytes'
  | 'settings.aiLimits.attachmentsMaxPerMessage';

const LIMIT_LABELS: Record<AiLimitSettingKey, LimitLabelKey> = {
  'ai.rateLimit.userPerMinute': 'settings.aiLimits.userPerMinute',
  'ai.rateLimit.sitePerMinute': 'settings.aiLimits.sitePerMinute',
  'ai.budget.userDailyTokens': 'settings.aiLimits.userDailyTokens',
  'ai.maxToolCallsPerTurn': 'settings.aiLimits.maxToolCallsPerTurn',
  'ai.conversationRetentionDays': 'settings.aiLimits.conversationRetentionDays',
  'ai.attachments.maxBytes': 'settings.aiLimits.attachmentsMaxBytes',
  'ai.attachments.maxPerMessage': 'settings.aiLimits.attachmentsMaxPerMessage',
};

const PROVIDER_KEYS = AI_PROVIDER_IDS.flatMap((p) => [
  aiProviderApiKeySettingKey(p),
  aiProviderBaseUrlSettingKey(p),
]);
const CHATBOT_KEYS = [
  'chatbotAi.provider',
  'chatbotAi.model',
  'chatbotAi.effort',
  'chatbotAi.systemPrompt',
];
const SUPPORT_KEYS = [
  'supportAi.provider',
  'supportAi.model',
  'supportAi.effort',
  'supportAi.tone',
  'supportAi.systemPrompt',
];

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function loadValues(settings: Record<string, unknown> | undefined): Values {
  const out: Values = {};
  for (const key of [...PROVIDER_KEYS, ...CHATBOT_KEYS, ...SUPPORT_KEYS]) {
    out[key] = asString(settings?.[key]);
  }
  out['chatbotAi.effort'] =
    out['chatbotAi.effort'] !== '' ? (out['chatbotAi.effort'] ?? '') : 'medium';
  out['supportAi.effort'] =
    out['supportAi.effort'] !== '' ? (out['supportAi.effort'] ?? '') : 'medium';
  out['supportAi.tone'] =
    out['supportAi.tone'] !== '' ? (out['supportAi.tone'] ?? '') : 'professional';
  for (const key of LIMIT_KEYS) {
    const stored = parseAiLimitValue(key, settings?.[key]);
    out[key] = String(stored ?? AI_LIMIT_SETTINGS[key].defaultValue);
  }
  return out;
}

/** Writes only the keys whose value changed, through the generic settings PUT. */
function useSaveKeys(
  keys: readonly string[],
  loaded: Values,
  toValue: (key: string, v: string) => unknown,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (values: Values) => {
      const changed = keys.filter(
        (k) => toValue(k, values[k] ?? '') !== toValue(k, loaded[k] ?? ''),
      );
      for (const key of changed) {
        await api.put(`/v1/settings/${key}`, { value: toValue(key, values[key] ?? '') });
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['security-public'] });
      void queryClient.invalidateQueries({ queryKey: AI_STATUS_KEY });
    },
  });
}

interface AiSettingsProps {
  settings: Record<string, unknown> | undefined;
}

/**
 * Settings > AI: one key and base URL per provider (`ai.<provider>.*`), the
 * assistant (`chatbotAi.*`) and support AI (`supportAi.*`) surfaces, and the
 * AI limits (`ai.*`).
 */
export function AiSettings({ settings }: AiSettingsProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('settings.ai:write');
  const aiDefaults = useAiDefaults('settings');
  const loaded = useMemo(() => loadValues(settings), [settings]);
  const [values, setValues] = useState<Values>(loaded);
  const [chatbotEnabled, setChatbotEnabled] = useState(false);
  const [supportEnabled, setSupportEnabled] = useState(false);

  useEffect(() => {
    setValues(loaded);
    setChatbotEnabled(settings?.['chatbotAi.enabled'] === true);
    setSupportEnabled(settings?.['supportAi.enabled'] === true);
  }, [loaded, settings]);

  const set = (key: string) => (value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  // An unchanged built-in prompt is saved empty, so later defaults still apply.
  const surfaceValue = (key: string, v: string): unknown => {
    if (key === 'chatbotAi.systemPrompt' && isDefaultPrompt(v, aiDefaults?.chatbot)) return '';
    if (key === 'supportAi.systemPrompt' && isDefaultPrompt(v, aiDefaults?.support)) return '';
    return v;
  };
  const saveProviders = useSaveKeys(PROVIDER_KEYS, loaded, (_k, v) => v.trim());
  const saveChatbot = useSaveKeys(CHATBOT_KEYS, loaded, surfaceValue);
  const saveSupport = useSaveKeys(SUPPORT_KEYS, loaded, surfaceValue);

  const resetPrompt = useMutation({
    mutationFn: (key: 'chatbotAi.systemPrompt' | 'supportAi.systemPrompt') =>
      api.put(`/v1/settings/${key}`, { value: '' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
  const saveLimits = useSaveKeys(LIMIT_KEYS, loaded, (k, v) =>
    parseAiLimitValue(k as AiLimitSettingKey, v),
  );

  const toggle = useMutation({
    mutationFn: (vals: { key: 'chatbotAi.enabled' | 'supportAi.enabled'; enabled: boolean }) =>
      api.put(`/v1/settings/${vals.key}`, { value: vals.enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['security-public'] });
      void queryClient.invalidateQueries({ queryKey: AI_STATUS_KEY });
    },
  });

  const invalidLimits = LIMIT_KEYS.filter((k) => parseAiLimitValue(k, values[k]) == null);

  function status(
    m: { isSuccess: boolean; isError: boolean; error: unknown },
    savedKey: 'settings.aiSaved',
  ): React.JSX.Element | null {
    if (m.isError) {
      return (
        <p className="text-sm text-destructive">
          {getErrorMessage(m.error, t, 'settings.aiSaveFailed')}
        </p>
      );
    }
    if (m.isSuccess) return <p className="text-sm text-success">{t(savedKey)}</p>;
    return null;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.aiProvidersTitle')}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('settings.aiProvidersDescription')}</p>
        </CardHeader>
        <CardContent className="space-y-6">
          <Alert variant="warning">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{t('settings.aiDataLeavesWarning')}</AlertDescription>
          </Alert>
          {AI_PROVIDER_IDS.map((p) => {
            const keyKey = aiProviderApiKeySettingKey(p);
            const urlKey = aiProviderBaseUrlSettingKey(p);
            return (
              <fieldset
                key={p}
                className="grid grid-cols-1 gap-4 rounded-lg border p-4 md:grid-cols-2"
              >
                <legend className="px-1 text-sm font-medium">{PROVIDER_LABELS[p]}</legend>
                <div className="space-y-2">
                  <Label htmlFor={`ai-${p}-key`} className="leading-6">
                    {t('settings.aiApiKey')}
                  </Label>
                  <PasswordInput
                    id={`ai-${p}-key`}
                    autoComplete="off"
                    disabled={!canWrite}
                    value={values[keyKey] ?? ''}
                    onChange={(e) => {
                      set(keyKey)(e.target.value);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`ai-${p}-base-url`} className="leading-6">
                    {t('settings.aiBaseUrl')}
                  </Label>
                  <Input
                    id={`ai-${p}-base-url`}
                    type="url"
                    inputMode="url"
                    placeholder="https://"
                    disabled={!canWrite}
                    value={values[urlKey] ?? ''}
                    onChange={(e) => {
                      set(urlKey)(e.target.value);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">{t('settings.aiBaseUrlHint')}</p>
                </div>
              </fieldset>
            );
          })}
          {canWrite && (
            <div className="flex items-center justify-end gap-4">
              {status(saveProviders, 'settings.aiSaved')}
              <SaveButton
                isPending={saveProviders.isPending}
                onClick={() => {
                  saveProviders.mutate(values);
                }}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {(['chatbot', 'support'] as const).map((surface) => {
        const prefix = surface === 'chatbot' ? 'chatbotAi' : 'supportAi';
        const enabled = surface === 'chatbot' ? chatbotEnabled : supportEnabled;
        const setEnabled = surface === 'chatbot' ? setChatbotEnabled : setSupportEnabled;
        const save = surface === 'chatbot' ? saveChatbot : saveSupport;
        const providerValue = values[`${prefix}.provider`] ?? '';
        const providerHasKey =
          providerValue === '' ||
          (values[`ai.${providerValue}.apiKeyEnc`] ?? '') !== '' ||
          (loaded[`ai.${providerValue}.apiKeyEnc`] ?? '') !== '';
        return (
          <Card key={surface}>
            <CardHeader>
              <CardTitle>{t(`settings.aiSurface.${surface}.title`)}</CardTitle>
              <p className="text-sm text-muted-foreground">
                {t(`settings.aiSurface.${surface}.description`)}
              </p>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
                <Label htmlFor={`${prefix}-enabled`} className="leading-6">
                  {t(`settings.aiSurface.${surface}.enabled`)}
                </Label>
                <Toggle
                  id={`${prefix}-enabled`}
                  checked={enabled}
                  disabled={!canWrite || toggle.isPending}
                  onCheckedChange={(checked) => {
                    setEnabled(checked);
                    toggle.mutate({ key: `${prefix}.enabled`, enabled: checked });
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
                  <Label htmlFor={`${prefix}-provider`} className="leading-6">
                    {t('settings.aiProvider')}
                  </Label>
                  <AiProviderSelect
                    id={`${prefix}-provider`}
                    allowNone
                    disabled={!canWrite}
                    value={providerValue}
                    onChange={(next) => {
                      // A listed model belongs to the old provider: back to the default.
                      const model = values[`${prefix}.model`] ?? '';
                      if (!isCustomModel(aiDefaults, providerValue, model)) {
                        set(`${prefix}.model`)('');
                      }
                      set(`${prefix}.provider`)(next);
                    }}
                  />
                  {!providerHasKey && (
                    <p className="text-xs text-warning">{t('settings.aiProviderNoKey')}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${prefix}-model`} className="leading-6">
                    {t('settings.aiModel')}
                  </Label>
                  <AiModelField
                    key={providerValue}
                    id={`${prefix}-model`}
                    provider={providerValue}
                    defaults={aiDefaults}
                    disabled={!canWrite}
                    value={values[`${prefix}.model`] ?? ''}
                    onChange={set(`${prefix}.model`)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${prefix}-effort`} className="leading-6">
                    {t('settings.aiEffort')}
                  </Label>
                  <AiEffortSelect
                    id={`${prefix}-effort`}
                    disabled={!canWrite}
                    value={values[`${prefix}.effort`] ?? 'medium'}
                    onChange={set(`${prefix}.effort`)}
                  />
                  <p className="text-xs text-muted-foreground">{t('settings.aiEffortHint')}</p>
                </div>
                {surface === 'support' && (
                  <div className="space-y-2">
                    <Label htmlFor="supportAi-tone" className="leading-6">
                      {t('settings.aiTone')}
                    </Label>
                    <AiToneSelect
                      id="supportAi-tone"
                      disabled={!canWrite}
                      value={values['supportAi.tone'] ?? 'professional'}
                      onChange={set('supportAi.tone')}
                    />
                  </div>
                )}
              </div>
              <AiSystemPromptField
                id={`${prefix}-system-prompt`}
                defaults={aiDefaults?.[surface]}
                disabled={!canWrite}
                value={values[`${prefix}.systemPrompt`] ?? ''}
                savedValue={loaded[`${prefix}.systemPrompt`] ?? ''}
                onChange={set(`${prefix}.systemPrompt`)}
                resetPending={
                  resetPrompt.isPending && resetPrompt.variables === `${prefix}.systemPrompt`
                }
                onReset={() => {
                  resetPrompt.mutate(`${prefix}.systemPrompt`);
                }}
              />
              {resetPrompt.isError && resetPrompt.variables === `${prefix}.systemPrompt` && (
                <p className="text-sm text-destructive">
                  {getErrorMessage(resetPrompt.error, t, 'settings.aiSaveFailed')}
                </p>
              )}
              {canWrite && (
                <div className="flex items-center justify-end gap-4">
                  {status(save, 'settings.aiSaved')}
                  <SaveButton
                    isPending={save.isPending}
                    onClick={() => {
                      save.mutate(values);
                    }}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.aiLimitsTitle')}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('settings.aiLimitsDescription')}</p>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {LIMIT_KEYS.map((key) => {
              const { min, max } = AI_LIMIT_SETTINGS[key];
              const invalid = invalidLimits.includes(key);
              const id = `ai-limit-${key.replace(/\./g, '-')}`;
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
                    {key === 'ai.budget.userDailyTokens' && ` ${t('settings.aiLimitZeroNoBudget')}`}
                  </p>
                </div>
              );
            })}
          </div>
          {canWrite && (
            <div className="flex items-center justify-end gap-4">
              {status(saveLimits, 'settings.aiSaved')}
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
