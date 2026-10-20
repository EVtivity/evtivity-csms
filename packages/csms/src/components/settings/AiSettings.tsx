// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { AiAlertsBanner } from '@/components/ai/alerts/AiAlertsBanner';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AI_LIMIT_SETTINGS,
  AI_PROVIDER_IDS,
  aiProviderApiKeySettingKey,
  aiProviderBaseUrlSettingKey,
  parseAiLimitValue,
} from '@evtivity/lib/ai-config';
import type { AiLimitSettingKey } from '@evtivity/lib/ai-config';
import { SaveButton } from '@/components/save-button';
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
import { AiDataNotice } from '@/components/ai/AiDataNotice';
import { AI_STATUS_KEY } from '@/components/ai/use-ai-status';
import { useLoadedValues } from '@/hooks/use-loaded-values';
import { useSaveKeys } from './ai-settings-save';
import type { Values } from './ai-settings-save';
import { AiAdvancedOptions, AiPromptSummary } from './AiAdvancedOptions';
import { AiInsightsSettings, AiMcpSettings } from './AiOpsSettings';
import { DriverAiSettings } from './ai/DriverAiSettings';
import { AiUsageTab } from '@/components/ai/usage/AiUsageTab';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTab } from '@/hooks/use-tab';
import {
  AI_SETTINGS_TABS,
  DEFAULT_AI_SETTINGS_TAB,
  resolveAiSettingsTab,
} from './ai-settings-tabs';
import type { AiSettingsTab } from './ai-settings-tabs';
import { AiModelField } from '@/components/ai/AiModelField';
import { AiSystemPromptField } from '@/components/ai/AiSystemPromptField';
import type { AiDefaults } from '@/components/ai/use-ai-defaults';
import { isCustomModel, isDefaultPrompt, useAiDefaults } from '@/components/ai/use-ai-defaults';
import { api } from '@/lib/api';
import { useHasAllSiteAccess, useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatNumber } from '@/lib/formatting';

const LIMIT_KEYS = Object.keys(AI_LIMIT_SETTINGS) as AiLimitSettingKey[];

type LimitLabelKey =
  | 'settings.aiLimits.userPerMinute'
  | 'settings.aiLimits.sitePerMinute'
  | 'settings.aiLimits.userDailyTokens'
  | 'settings.aiLimits.maxToolCallsPerTurn'
  | 'settings.aiLimits.conversationRetentionDays'
  | 'settings.aiLimits.attachmentsMaxBytes'
  | 'settings.aiLimits.attachmentsMaxPerMessage'
  | 'settings.aiLimits.companyMonthlyTokens'
  | 'settings.aiLimits.siteMonthlyTokens'
  | 'settings.aiLimits.siteDailyTokens'
  | 'settings.aiLimits.warnPercent';

// Budgets where 0 means no limit (the daily user budget has its own hint).
const ZERO_NO_LIMIT_KEYS: ReadonlySet<AiLimitSettingKey> = new Set([
  'ai.budget.companyMonthlyTokens',
  'ai.budget.siteMonthlyTokens',
  'ai.budget.siteDailyTokens',
]);

const LIMIT_LABELS: Record<AiLimitSettingKey, LimitLabelKey> = {
  'ai.rateLimit.userPerMinute': 'settings.aiLimits.userPerMinute',
  'ai.rateLimit.sitePerMinute': 'settings.aiLimits.sitePerMinute',
  'ai.budget.userDailyTokens': 'settings.aiLimits.userDailyTokens',
  'ai.maxToolCallsPerTurn': 'settings.aiLimits.maxToolCallsPerTurn',
  'ai.conversationRetentionDays': 'settings.aiLimits.conversationRetentionDays',
  'ai.attachments.maxBytes': 'settings.aiLimits.attachmentsMaxBytes',
  'ai.attachments.maxPerMessage': 'settings.aiLimits.attachmentsMaxPerMessage',
  'ai.budget.companyMonthlyTokens': 'settings.aiLimits.companyMonthlyTokens',
  'ai.budget.siteMonthlyTokens': 'settings.aiLimits.siteMonthlyTokens',
  'ai.budget.siteDailyTokens': 'settings.aiLimits.siteDailyTokens',
  'ai.budget.warnPercent': 'settings.aiLimits.warnPercent',
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

interface AiSettingsProps {
  settings: Record<string, unknown> | undefined;
}

interface CardProps extends AiSettingsProps {
  canWrite: boolean;
}

/**
 * Settings > AI, one tab per function: providers and keys (`ai.<provider>.*`),
 * the assistant (`chatbotAi.*`), support drafts (`supportAi.*`), driver
 * support (`driverAi.*`), automatic insights (the `opsAi.*` surface,
 * `aiInsights.*` and the background workers `aiWorkers.*`), MCP (`ai.mcp.*`), and
 * usage and limits (the `ai.*` limits, then the usage dashboard for users with
 * `aiUsage:read` and access to every site). An unknown `sub` opens the default
 * tab, so old `sub=config` links still work.
 */
export function AiSettings({ settings }: AiSettingsProps): React.JSX.Element {
  const { t } = useTranslation();
  const canWrite = useHasPermission('settings.ai:write');
  const canReadUsage = useHasPermission('aiUsage:read');
  const allSites = useHasAllSiteAccess();
  const showUsage = canReadUsage && allSites;
  const aiDefaults = useAiDefaults('settings');
  const [sub, setSub] = useTab(DEFAULT_AI_SETTINGS_TAB, 'sub');
  const active = resolveAiSettingsTab(sub);
  // Opened tabs stay mounted (hidden), so unsaved edits survive a tab switch;
  // unopened tabs load nothing.
  const [visited, setVisited] = useState<ReadonlySet<AiSettingsTab>>(() => new Set([active]));
  useEffect(() => {
    setVisited((prev) => (prev.has(active) ? prev : new Set([...prev, active])));
  }, [active]);
  const warnPercent =
    parseAiLimitValue('ai.budget.warnPercent', settings?.['ai.budget.warnPercent']) ??
    AI_LIMIT_SETTINGS['ai.budget.warnPercent'].defaultValue;
  const cardProps = { settings, canWrite };
  return (
    <Tabs value={active} onValueChange={setSub}>
      <AiAlertsBanner placement="settings" className="mb-4" />
      <TabsList>
        {AI_SETTINGS_TABS.map((id) => (
          <TabsTrigger key={id} value={id}>
            {t(`settings.aiTabs.${id}`)}
          </TabsTrigger>
        ))}
      </TabsList>
      <AiTab id="providers" visited={visited} notice>
        <AiProvidersCard {...cardProps} />
      </AiTab>
      <AiTab id="assistant" visited={visited} notice>
        <AiSurfaceCard {...cardProps} surface="chatbot" aiDefaults={aiDefaults} />
      </AiTab>
      <AiTab id="support" visited={visited} notice>
        <AiSurfaceCard {...cardProps} surface="support" aiDefaults={aiDefaults} />
      </AiTab>
      <AiTab id="driver" visited={visited} notice>
        <DriverAiSettings settings={settings} />
      </AiTab>
      <AiTab id="insights" visited={visited} notice>
        <AiInsightsSettings {...cardProps} aiDefaults={aiDefaults} />
      </AiTab>
      <AiTab id="mcp" visited={visited} notice>
        <AiMcpSettings {...cardProps} />
      </AiTab>
      <AiTab id="usage" visited={visited}>
        <AiLimitsCard {...cardProps} />
        {showUsage && <AiUsageTab warnPercent={warnPercent} />}
      </AiTab>
    </Tabs>
  );
}

/** One tab: its short description, the AI data note on surface tabs, then its cards. */
function AiTab({
  id,
  visited,
  notice = false,
  children,
}: {
  id: AiSettingsTab;
  visited: ReadonlySet<AiSettingsTab>;
  notice?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <TabsContent
      value={id}
      keepMounted={visited.has(id)}
      className="mt-4 space-y-6"
      data-testid={`ai-tab-${id}`}
    >
      <p className="text-sm text-muted-foreground">{t(`settings.aiTabs.${id}Description`)}</p>
      {notice && <AiDataNotice />}
      {children}
    </TabsContent>
  );
}

function SaveStatus({
  m,
}: {
  m: { isSuccess: boolean; isError: boolean; error: unknown };
}): React.JSX.Element | null {
  const { t } = useTranslation();
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

function useFormValues(settings: Record<string, unknown> | undefined): {
  loaded: Values;
  values: Values;
  set: (key: string) => (value: string) => void;
} {
  const loaded = useMemo(() => loadValues(settings), [settings]);
  // A refetch (a toggle, another card's save, window focus) keeps edits in progress.
  const [values, setValues] = useLoadedValues<Values>(loaded);
  const set = (key: string) => (value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };
  return { loaded, values, set };
}

/** Providers and keys: one API key per provider, the base URL behind a disclosure. */
function AiProvidersCard({ settings, canWrite }: CardProps): React.JSX.Element {
  const { t } = useTranslation();
  const { loaded, values, set } = useFormValues(settings);
  const save = useSaveKeys(PROVIDER_KEYS, loaded, (_k, v) => v.trim());
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.aiProvidersTitle')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('settings.aiProvidersDescription')}</p>
      </CardHeader>
      <CardContent className="space-y-6">
        {AI_PROVIDER_IDS.map((p) => {
          const keyKey = aiProviderApiKeySettingKey(p);
          const urlKey = aiProviderBaseUrlSettingKey(p);
          const baseUrl = values[urlKey] ?? '';
          return (
            <fieldset key={p} className="space-y-4 rounded-lg border p-4">
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
              <AiAdvancedOptions
                summary={baseUrl !== '' ? baseUrl : t('settings.aiBaseUrlDefaultSummary')}
                data-testid={`ai-${p}-advanced`}
              >
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
                    value={baseUrl}
                    onChange={(e) => {
                      set(urlKey)(e.target.value);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">{t('settings.aiBaseUrlHint')}</p>
                </div>
              </AiAdvancedOptions>
            </fieldset>
          );
        })}
        {canWrite && (
          <div className="flex items-center justify-end gap-4">
            <SaveStatus m={save} />
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
}

/** The assistant or support drafts surface: switch, provider, model, effort, prompt. */
function AiSurfaceCard({
  settings,
  canWrite,
  surface,
  aiDefaults,
}: CardProps & {
  surface: 'chatbot' | 'support';
  aiDefaults: AiDefaults | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const prefix = surface === 'chatbot' ? 'chatbotAi' : 'supportAi';
  const { loaded, values, set } = useFormValues(settings);
  const enabledStored = settings?.[`${prefix}.enabled`] === true;
  const [enabled, setEnabled] = useState(enabledStored);
  useEffect(() => {
    setEnabled(enabledStored);
  }, [enabledStored]);

  // An unchanged built-in prompt is saved empty, so later defaults still apply.
  const surfaceValue = (key: string, v: string): unknown =>
    key === `${prefix}.systemPrompt` && isDefaultPrompt(v, aiDefaults?.[surface]) ? '' : v;
  const save = useSaveKeys(
    surface === 'chatbot' ? CHATBOT_KEYS : SUPPORT_KEYS,
    loaded,
    surfaceValue,
  );
  const resetPrompt = useMutation({
    mutationFn: () => api.put(`/v1/settings/${prefix}.systemPrompt`, { value: '' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
  const toggle = useMutation({
    mutationFn: (on: boolean) => api.put(`/v1/settings/${prefix}.enabled`, { value: on }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['security-public'] });
      void queryClient.invalidateQueries({ queryKey: AI_STATUS_KEY });
    },
  });

  const providerValue = values[`${prefix}.provider`] ?? '';
  const keyValue = settings?.[`ai.${providerValue}.apiKeyEnc`];
  const providerHasKey = providerValue === '' || (typeof keyValue === 'string' && keyValue !== '');
  const prompt = values[`${prefix}.systemPrompt`] ?? '';
  return (
    <Card>
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
        <AiAdvancedOptions
          summary={<AiPromptSummary custom={prompt !== ''} />}
          data-testid={`${prefix}-advanced`}
        >
          <AiSystemPromptField
            id={`${prefix}-system-prompt`}
            defaults={aiDefaults?.[surface]}
            disabled={!canWrite}
            value={prompt}
            savedValue={loaded[`${prefix}.systemPrompt`] ?? ''}
            onChange={set(`${prefix}.systemPrompt`)}
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
            <SaveStatus m={save} />
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
}

/** Rate limits and token budgets (`ai.*`). */
function AiLimitsCard({ settings, canWrite }: CardProps): React.JSX.Element {
  const { t } = useTranslation();
  const { loaded, values, set } = useFormValues(settings);
  const save = useSaveKeys(LIMIT_KEYS, loaded, (k, v) =>
    parseAiLimitValue(k as AiLimitSettingKey, v),
  );
  const invalidLimits = LIMIT_KEYS.filter((k) => parseAiLimitValue(k, values[k]) == null);
  return (
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
                  className={invalid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
                >
                  {t('settings.aiLimitRange', {
                    min: formatNumber(min, 0),
                    max: formatNumber(max, 0),
                  })}
                  {key === 'ai.budget.userDailyTokens' && ` ${t('settings.aiLimitZeroNoBudget')}`}
                  {ZERO_NO_LIMIT_KEYS.has(key) && ` ${t('settings.aiLimitZeroNoLimit')}`}
                </p>
              </div>
            );
          })}
        </div>
        {canWrite && (
          <div className="flex items-center justify-end gap-4">
            <SaveStatus m={save} />
            <SaveButton
              isPending={save.isPending}
              disabled={invalidLimits.length > 0}
              onClick={() => {
                save.mutate(values);
              }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
