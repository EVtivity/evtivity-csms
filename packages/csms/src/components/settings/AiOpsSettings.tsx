// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { ParseKeys } from 'i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AI_FLAG_SETTINGS,
  AI_SETTING_DEFAULTS,
  AI_THRESHOLD_SETTINGS,
  DEFAULT_OPS_AI_EFFORT,
  isAiEffort,
  parseAiLimitValue,
  parseAiMcpAllowedOrigins,
} from '@evtivity/lib/ai-config';
import type { AiFlagSettingKey, AiThresholdSettingKey } from '@evtivity/lib/ai-config';
import { AI_INSIGHT_SETTING_KEYS, OPS_AI_SETTING_KEYS } from '@evtivity/lib/ai-insights';
import {
  AI_MCP_DEFAULT_TOOLSETS,
  AI_MCP_SETTING_KEYS,
  AI_WORKER_SETTING_KEYS,
} from '@evtivity/lib/ai-proposals';
import { isUiLanguage } from '@evtivity/lib/languages';
import { AiEffortSelect, AiProviderSelect } from '@/components/ai/AiConfigFields';
import { AiModelField } from '@/components/ai/AiModelField';
import type { AiDefaults } from '@/components/ai/use-ai-defaults';
import { isCustomModel, isDefaultPrompt } from '@/components/ai/use-ai-defaults';
import { AiSystemPromptField } from '@/components/ai/AiSystemPromptField';
import { InsightQualityCard } from '@/components/ai/insights/InsightQualityCard';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LanguageSelect } from '@/components/ui/language-select';
import { Textarea } from '@/components/ui/textarea';
import { Toggle } from '@/components/ui/toggle';
import { useFeatureFlags } from '@/hooks/use-feature-flags';
import { api } from '@/lib/api';
import { API_BASE_URL } from '@/lib/config';
import { getErrorMessage } from '@/lib/error-message';
import { formatNumber } from '@/lib/formatting';
import { AiAdvancedOptions, AiPromptSummary } from './AiAdvancedOptions';
import { useLoadedValues } from './ai-settings-save';

/**
 * Settings > AI panels: the system-initiated surface (`opsAi.*`), automatic insights (`aiInsights.*`),
 * background workers (`aiWorkers.*`) and the MCP server (`ai.mcp.*`). Key
 * names come from the R0 contracts and defaults from `AI_SETTING_DEFAULTS`;
 * every value is checked with the same parsers the API uses.
 */

type FieldValue = string | boolean;
type FieldValues = Record<string, FieldValue>;

type FieldSpec =
  | { kind: 'flag'; key: AiFlagSettingKey; label: ParseKeys; help?: ParseKeys }
  | { kind: 'number'; key: AiThresholdSettingKey; label: ParseKeys }
  | { kind: 'language'; key: string; label: ParseKeys }
  | { kind: 'origins'; key: string; label: ParseKeys; help: ParseKeys; advanced: true };

function storedValue(settings: Record<string, unknown> | undefined, key: string): unknown {
  return settings?.[key] ?? AI_SETTING_DEFAULTS[key];
}

function loadField(settings: Record<string, unknown> | undefined, f: FieldSpec): FieldValue {
  const v = storedValue(settings, f.key);
  switch (f.kind) {
    case 'flag':
      return typeof v === 'boolean' ? v : AI_FLAG_SETTINGS[f.key];
    case 'number':
      return String(parseAiLimitValue(f.key, v) ?? AI_THRESHOLD_SETTINGS[f.key].defaultValue);
    case 'language':
      return isUiLanguage(v) ? v : 'en';
    case 'origins':
      return (parseAiMcpAllowedOrigins(v) ?? []).join('\n');
  }
}

/** The value the settings PUT takes, or undefined when the field is invalid. */
function fieldValue(f: FieldSpec, v: FieldValue): unknown {
  switch (f.kind) {
    case 'flag':
      return v === true;
    case 'number':
      return parseAiLimitValue(f.key, v) ?? undefined;
    case 'language':
      return isUiLanguage(v) ? v : undefined;
    case 'origins': {
      const lines = String(v)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '');
      return parseAiMcpAllowedOrigins(lines) ?? undefined;
    }
  }
}

interface KeysCardProps {
  settings: Record<string, unknown> | undefined;
  canWrite: boolean;
  title: ParseKeys;
  description?: ParseKeys;
  fields: readonly FieldSpec[];
  testId: string;
  /** Shown above the fields. */
  intro?: React.ReactNode;
}

/** A card of AI settings saved together; only the changed keys are written. */
function AiKeysCard({
  settings,
  canWrite,
  title,
  description,
  fields,
  testId,
  intro,
}: KeysCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const loaded = useMemo(
    () => Object.fromEntries(fields.map((f) => [f.key, loadField(settings, f)])),
    [settings, fields],
  );
  const [values, setValues] = useLoadedValues<FieldValues>(loaded);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const save = useMutation({
    mutationFn: async (next: FieldValues) => {
      for (const f of fields) {
        const value = fieldValue(f, next[f.key] ?? '');
        if (JSON.stringify(value) === JSON.stringify(fieldValue(f, loaded[f.key] ?? ''))) continue;
        await api.put(`/v1/settings/${f.key}`, { value });
      }
    },
    // Settled: a partial failure still saved the keys before it.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onSuccess: () => {
      setHasSubmitted(false);
    },
  });

  const invalid = new Set(
    fields.filter((f) => fieldValue(f, values[f.key] ?? '') === undefined).map((f) => f.key),
  );
  const dirty = fields.some((f) => values[f.key] !== loaded[f.key]);
  const basicFields = fields.filter(
    (f): f is Exclude<FieldSpec, { kind: 'origins' }> => f.kind !== 'origins',
  );
  const advancedFields = fields.filter(
    (f): f is Extract<FieldSpec, { kind: 'origins' }> => f.kind === 'origins',
  );
  const advancedError = hasSubmitted && advancedFields.some((f) => invalid.has(f.key));
  const set = (key: string, v: FieldValue): void => {
    setValues((prev) => ({ ...prev, [key]: v }));
    save.reset();
  };

  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle>{t(title)}</CardTitle>
        {description != null && <p className="text-sm text-muted-foreground">{t(description)}</p>}
      </CardHeader>
      <CardContent className="space-y-6">
        {intro}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {basicFields.map((f) => {
            const id = `ai-setting-${f.key.replace(/\./g, '-')}`;
            const showError = hasSubmitted && invalid.has(f.key);
            if (f.kind === 'flag') {
              return (
                <div
                  key={f.key}
                  className="flex items-start justify-between gap-4 rounded-lg border p-4 md:col-span-2"
                >
                  <div className="space-y-1">
                    <Label htmlFor={id} className="leading-6">
                      {t(f.label)}
                    </Label>
                    {f.help != null && <p className="text-xs text-muted-foreground">{t(f.help)}</p>}
                  </div>
                  <Toggle
                    id={id}
                    checked={values[f.key] === true}
                    disabled={!canWrite}
                    onCheckedChange={(checked) => {
                      set(f.key, checked);
                    }}
                  />
                </div>
              );
            }
            if (f.kind === 'language') {
              return (
                <div key={f.key} className="space-y-2">
                  <Label htmlFor={id} className="leading-6">
                    {t(f.label)}
                  </Label>
                  <LanguageSelect
                    id={id}
                    disabled={!canWrite}
                    value={String(values[f.key] ?? 'en')}
                    onChange={(v) => {
                      set(f.key, v);
                    }}
                  />
                </div>
              );
            }
            const { min, max } = AI_THRESHOLD_SETTINGS[f.key];
            return (
              <div key={f.key} className="space-y-2">
                <Label htmlFor={id} className="leading-6">
                  {t(f.label)}
                </Label>
                <Input
                  id={id}
                  type="number"
                  inputMode="numeric"
                  min={min}
                  max={max}
                  step={1}
                  disabled={!canWrite}
                  aria-invalid={showError}
                  className={showError ? 'border-destructive' : undefined}
                  value={String(values[f.key] ?? '')}
                  onChange={(e) => {
                    set(f.key, e.target.value);
                  }}
                />
                <p
                  className={
                    showError ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'
                  }
                >
                  {t('settings.aiLimitRange', {
                    min: formatNumber(min, 0),
                    max: formatNumber(max, 0),
                  })}
                </p>
              </div>
            );
          })}
        </div>
        {advancedFields.length > 0 && (
          // A refused value stays visible in the summary while the disclosure is closed.
          <AiAdvancedOptions
            summary={
              advancedError ? (
                <span className="text-destructive">
                  {t('settings.aiMcp.allowedOriginsInvalid')}
                </span>
              ) : undefined
            }
            data-testid={`${testId}-advanced`}
          >
            <div className="space-y-4">
              {advancedFields.map((f) => {
                const id = `ai-setting-${f.key.replace(/\./g, '-')}`;
                const showError = hasSubmitted && invalid.has(f.key);
                return (
                  <div key={f.key} className="space-y-2">
                    <Label htmlFor={id} className="leading-6">
                      {t(f.label)}
                    </Label>
                    <Textarea
                      id={id}
                      rows={3}
                      disabled={!canWrite}
                      aria-invalid={showError}
                      className={showError ? 'border-destructive font-mono' : 'font-mono'}
                      value={String(values[f.key] ?? '')}
                      onChange={(e) => {
                        set(f.key, e.target.value);
                      }}
                    />
                    <p
                      className={
                        showError ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'
                      }
                    >
                      {showError ? t('settings.aiMcp.allowedOriginsInvalid') : t(f.help)}
                    </p>
                  </div>
                );
              })}
            </div>
          </AiAdvancedOptions>
        )}
        {save.isError && (
          <p className="text-sm text-destructive">
            {getErrorMessage(save.error, t, 'settings.aiSaveFailed')}
          </p>
        )}
        {canWrite && (
          <div className="flex items-center justify-end gap-4">
            {save.isSuccess && !dirty && (
              <p className="text-sm text-success">{t('settings.aiSaved')}</p>
            )}
            {dirty && (
              <p className="text-sm text-muted-foreground">{t('settings.unsavedChanges')}</p>
            )}
            <SaveButton
              isPending={save.isPending}
              disabled={!dirty}
              onClick={() => {
                setHasSubmitted(true);
                if (invalid.size > 0) return;
                save.mutate(values);
              }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const INSIGHT_FIELDS: readonly FieldSpec[] = [
  {
    kind: 'flag',
    key: AI_INSIGHT_SETTING_KEYS.stationEnabled,
    label: 'settings.aiInsightsSettings.station',
  },
  {
    kind: 'flag',
    key: AI_INSIGHT_SETTING_KEYS.sessionEnabled,
    label: 'settings.aiInsightsSettings.session',
  },
  {
    kind: 'flag',
    key: AI_INSIGHT_SETTING_KEYS.authorizationEnabled,
    label: 'settings.aiInsightsSettings.authorization',
  },
  {
    kind: 'flag',
    key: AI_INSIGHT_SETTING_KEYS.reservationEnabled,
    label: 'settings.aiInsightsSettings.reservation',
  },
  {
    kind: 'language',
    key: AI_INSIGHT_SETTING_KEYS.primaryLanguage,
    label: 'settings.aiInsightsSettings.primaryLanguage',
  },
  {
    kind: 'number',
    key: AI_INSIGHT_SETTING_KEYS.debounceSeconds,
    label: 'settings.aiInsightsSettings.debounceSeconds',
  },
  {
    kind: 'number',
    key: AI_INSIGHT_SETTING_KEYS.cooldownMinutes,
    label: 'settings.aiInsightsSettings.cooldownMinutes',
  },
  {
    kind: 'number',
    key: AI_INSIGHT_SETTING_KEYS.siteIncidentThreshold,
    label: 'settings.aiInsightsSettings.siteIncidentThreshold',
  },
  {
    kind: 'number',
    key: AI_INSIGHT_SETTING_KEYS.maxPerSitePerDay,
    label: 'settings.aiInsightsSettings.maxPerSitePerDay',
  },
  {
    kind: 'number',
    key: AI_INSIGHT_SETTING_KEYS.retentionDays,
    label: 'settings.aiInsightsSettings.retentionDays',
  },
];

const WORKER_FIELDS: readonly FieldSpec[] = [
  {
    kind: 'flag',
    key: AI_WORKER_SETTING_KEYS.networkSummaryEnabled,
    label: 'aiWorkers.networkSummary.title',
    help: 'aiWorkers.networkSummary.description',
  },
  {
    kind: 'flag',
    key: AI_WORKER_SETTING_KEYS.stuckSessionsEnabled,
    label: 'aiWorkers.stuckSessions.title',
    help: 'aiWorkers.stuckSessions.description',
  },
  {
    kind: 'flag',
    key: AI_WORKER_SETTING_KEYS.stuckSessionsUseModel,
    label: 'aiWorkers.stuckSessions.useModel',
  },
  {
    kind: 'flag',
    key: AI_WORKER_SETTING_KEYS.tariffAnomaliesEnabled,
    label: 'aiWorkers.tariffAnomalies.title',
    help: 'aiWorkers.tariffAnomalies.description',
  },
  {
    kind: 'number',
    key: AI_WORKER_SETTING_KEYS.stuckSessionsIdleMinutes,
    label: 'aiWorkers.stuckSessions.idleMinutes',
  },
  {
    kind: 'number',
    key: AI_WORKER_SETTING_KEYS.proposalTtlHours,
    label: 'aiWorkers.proposalTtlHours',
  },
];

const MCP_FIELDS: readonly FieldSpec[] = [
  { kind: 'flag', key: AI_MCP_SETTING_KEYS.enabled, label: 'settings.aiMcp.enabled' },
  {
    kind: 'flag',
    key: AI_MCP_SETTING_KEYS.allowWrites,
    label: 'settings.aiMcp.allowWrites',
    help: 'settings.aiMcp.allowWritesHint',
  },
  {
    kind: 'number',
    key: AI_MCP_SETTING_KEYS.rateLimitPerMinute,
    label: 'settings.aiMcp.rateLimitPerMinute',
  },
  {
    kind: 'number',
    key: AI_MCP_SETTING_KEYS.dailyCallsPerKey,
    label: 'settings.aiMcp.dailyCallsPerKey',
  },
  {
    kind: 'origins',
    key: AI_MCP_SETTING_KEYS.allowedOrigins,
    label: 'settings.aiMcp.allowedOrigins',
    help: 'settings.aiMcp.allowedOriginsHint',
    advanced: true,
  },
];

const OPS_KEYS = [
  OPS_AI_SETTING_KEYS.provider,
  OPS_AI_SETTING_KEYS.model,
  OPS_AI_SETTING_KEYS.effort,
  OPS_AI_SETTING_KEYS.systemPrompt,
] as const;

function loadOps(settings: Record<string, unknown> | undefined): Record<string, string> {
  return Object.fromEntries(
    OPS_KEYS.map((k) => {
      const v = storedValue(settings, k);
      if (k === OPS_AI_SETTING_KEYS.effort) return [k, isAiEffort(v) ? v : DEFAULT_OPS_AI_EFFORT];
      return [k, typeof v === 'string' ? v : ''];
    }),
  );
}

/**
 * The `opsAi` surface: the model insights and workers use, with the company
 * provider key only (no caller, so no personal key). Off by default (D4); the
 * warning says what leaves the deployment when it is on.
 */
function AiOpsSurfaceCard({
  settings,
  canWrite,
  aiDefaults,
}: {
  settings: Record<string, unknown> | undefined;
  canWrite: boolean;
  aiDefaults: AiDefaults | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const loaded = useMemo(() => loadOps(settings), [settings]);
  const [values, setValues] = useLoadedValues<Record<string, string>>(loaded);
  const enabledStored = storedValue(settings, OPS_AI_SETTING_KEYS.enabled) === true;
  const [enabled, setEnabled] = useState(enabledStored);
  useEffect(() => {
    setEnabled(enabledStored);
  }, [enabledStored]);

  const toggle = useMutation({
    mutationFn: (on: boolean) =>
      api.put(`/v1/settings/${OPS_AI_SETTING_KEYS.enabled}`, { value: on }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    // The switch moved before the request: put it back when the write failed.
    onError: () => {
      setEnabled(enabledStored);
    },
  });
  const save = useMutation({
    mutationFn: async (next: Record<string, string>) => {
      for (const k of OPS_KEYS) {
        if (opsValue(k, next[k] ?? '') === opsValue(k, loaded[k] ?? '')) continue;
        await api.put(`/v1/settings/${k}`, { value: opsValue(k, next[k] ?? '') });
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
  const set = (k: string) => (v: string) => {
    setValues((prev) => ({ ...prev, [k]: v }));
    save.reset();
  };
  // An unchanged built-in prompt is saved empty, so later defaults still apply.
  const opsValue = (k: string, v: string): string =>
    k === OPS_AI_SETTING_KEYS.systemPrompt && isDefaultPrompt(v, aiDefaults?.ops) ? '' : v;
  const resetPrompt = useMutation({
    mutationFn: () => api.put(`/v1/settings/${OPS_AI_SETTING_KEYS.systemPrompt}`, { value: '' }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
  const provider = values[OPS_AI_SETTING_KEYS.provider] ?? '';
  const providerHasKey =
    provider === '' ||
    (typeof settings?.[`ai.${provider}.apiKeyEnc`] === 'string' &&
      settings[`ai.${provider}.apiKeyEnc`] !== '');
  const dirty = OPS_KEYS.some((k) => opsValue(k, values[k] ?? '') !== opsValue(k, loaded[k] ?? ''));

  return (
    <Card data-testid="ai-ops-settings">
      <CardHeader>
        <CardTitle>{t('settings.aiSurface.ops.title')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('settings.aiSurface.ops.description')}</p>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
          <Label htmlFor="opsAi-enabled" className="leading-6">
            {t('settings.aiSurface.ops.enabled')}
          </Label>
          <Toggle
            id="opsAi-enabled"
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
            <Label htmlFor="opsAi-provider" className="leading-6">
              {t('settings.aiProvider')}
            </Label>
            <AiProviderSelect
              id="opsAi-provider"
              disabled={!canWrite}
              value={provider}
              onChange={(next) => {
                const model = values[OPS_AI_SETTING_KEYS.model] ?? '';
                if (!isCustomModel(aiDefaults, provider, model)) set(OPS_AI_SETTING_KEYS.model)('');
                set(OPS_AI_SETTING_KEYS.provider)(next);
              }}
            />
            {!providerHasKey && (
              <p className="text-xs text-warning">{t('settings.aiProviderNoKey')}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="opsAi-model" className="leading-6">
              {t('settings.aiModel')}
            </Label>
            <AiModelField
              key={provider}
              id="opsAi-model"
              provider={provider}
              defaults={aiDefaults}
              disabled={!canWrite}
              value={values[OPS_AI_SETTING_KEYS.model] ?? ''}
              onChange={set(OPS_AI_SETTING_KEYS.model)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="opsAi-effort" className="leading-6">
              {t('settings.aiEffort')}
            </Label>
            <AiEffortSelect
              id="opsAi-effort"
              disabled={!canWrite}
              value={values[OPS_AI_SETTING_KEYS.effort] ?? DEFAULT_OPS_AI_EFFORT}
              onChange={set(OPS_AI_SETTING_KEYS.effort)}
            />
          </div>
        </div>
        <AiAdvancedOptions
          summary={
            <AiPromptSummary custom={(values[OPS_AI_SETTING_KEYS.systemPrompt] ?? '') !== ''} />
          }
          data-testid="opsAi-advanced"
        >
          <AiSystemPromptField
            id="opsAi-system-prompt"
            defaults={aiDefaults?.ops}
            disabled={!canWrite}
            value={values[OPS_AI_SETTING_KEYS.systemPrompt] ?? ''}
            savedValue={loaded[OPS_AI_SETTING_KEYS.systemPrompt] ?? ''}
            onChange={set(OPS_AI_SETTING_KEYS.systemPrompt)}
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
        {save.isError && (
          <p className="text-sm text-destructive">
            {getErrorMessage(save.error, t, 'settings.aiSaveFailed')}
          </p>
        )}
        {canWrite && (
          <div className="flex items-center justify-end gap-4">
            {save.isSuccess && !dirty && (
              <p className="text-sm text-success">{t('settings.aiSaved')}</p>
            )}
            <SaveButton
              isPending={save.isPending}
              disabled={!dirty}
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

/** The MCP server address: the API's own URL plus `/v1/mcp`. */
export function mcpEndpointUrl(apiBaseUrl: string, origin: string): string {
  return new URL('/v1/mcp', apiBaseUrl !== '' ? apiBaseUrl : origin).toString();
}

/**
 * How to connect an MCP client: the endpoint, key scopes
 * and toolsets.
 */
function McpConnectionInfo(): React.JSX.Element {
  const { t } = useTranslation();
  const endpoint = mcpEndpointUrl(API_BASE_URL, window.location.origin);
  return (
    <div className="space-y-3 rounded-lg border p-4 text-sm" data-testid="ai-mcp-info">
      <div className="space-y-1">
        <Label htmlFor="ai-mcp-endpoint" className="leading-6">
          {t('settings.aiMcp.endpoint')}
        </Label>
        <Input id="ai-mcp-endpoint" readOnly className="font-mono" value={endpoint} />
        <p className="text-xs text-muted-foreground">{t('settings.aiMcp.endpointHint')}</p>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        <li>{t('settings.aiMcp.writeScopeHint')}</li>
        <li>{t('settings.aiMcp.writesHint')}</li>
        <li>
          <span className="font-medium text-foreground">{t('settings.aiMcp.toolsets')}: </span>
          {t('settings.aiMcp.toolsetsHint', { toolsets: AI_MCP_DEFAULT_TOOLSETS.join(', ') })}
        </li>
        <li>{t('settings.aiMcp.protocolNote')}</li>
      </ul>
    </div>
  );
}

interface OpsTabProps {
  settings: Record<string, unknown> | undefined;
  canWrite: boolean;
}

/**
 * Settings > AI > Automatic insights: the system-initiated surface, which
 * insights and background workers share, then the insight settings, the
 * background workers (their suggestions are insights with an action to
 * confirm) and the quality summary (helpful rate by kind, last 30 days).
 */
export function AiInsightsSettings({
  settings,
  canWrite,
  aiDefaults,
}: OpsTabProps & { aiDefaults: AiDefaults | undefined }): React.JSX.Element {
  const { t } = useTranslation();
  // Reservation insights exist only while reservations are on (owner rule
  // v0.1.45): the switch shows then, else a line that links to the setting.
  const { flags, isLoaded } = useFeatureFlags();
  const reservationsOff = isLoaded && !flags.reservationEnabled;
  // The switch waits for the answer, so it never flashes before disappearing.
  const showReservationSwitch = isLoaded && flags.reservationEnabled;
  const fields = useMemo(
    () =>
      showReservationSwitch
        ? INSIGHT_FIELDS
        : INSIGHT_FIELDS.filter((f) => f.key !== AI_INSIGHT_SETTING_KEYS.reservationEnabled),
    [showReservationSwitch],
  );
  return (
    <>
      <AiOpsSurfaceCard settings={settings} canWrite={canWrite} aiDefaults={aiDefaults} />
      <AiKeysCard
        settings={settings}
        canWrite={canWrite}
        title="settings.aiInsightsSettings.title"
        fields={fields}
        testId="ai-insights-settings"
        intro={
          reservationsOff ? (
            <p className="text-sm text-muted-foreground" data-testid="ai-reservation-insights-off">
              {t('settings.aiInsightsSettings.reservationOff')}{' '}
              <Link
                to="/settings?tab=integrations&sub=reservation"
                className="text-link hover:underline"
              >
                {t('settings.aiInsightsSettings.reservationOffLink')}
              </Link>
            </p>
          ) : undefined
        }
      />
      <AiWorkersSettings settings={settings} canWrite={canWrite} />
      <InsightQualityCard />
    </>
  );
}

/**
 * The background workers card of Settings > AI > Automatic insights. They run
 * on the same surface; their suggestions appear as insights with an action.
 */
export function AiWorkersSettings({ settings, canWrite }: OpsTabProps): React.JSX.Element {
  return (
    <AiKeysCard
      settings={settings}
      canWrite={canWrite}
      title="aiWorkers.title"
      description="aiWorkers.description"
      fields={WORKER_FIELDS}
      testId="ai-workers-settings"
    />
  );
}

/** Settings > AI > MCP: the server settings and how to connect a client. */
export function AiMcpSettings({ settings, canWrite }: OpsTabProps): React.JSX.Element {
  return (
    <AiKeysCard
      settings={settings}
      canWrite={canWrite}
      title="settings.aiMcp.title"
      description="settings.aiMcp.description"
      fields={MCP_FIELDS}
      testId="ai-mcp-settings"
      intro={<McpConnectionInfo />}
    />
  );
}
